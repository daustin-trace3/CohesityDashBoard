// Just-in-time and synced user provisioning for identity providers (OIDC, SAML,
// Okta Management API). Mirrors services/directorySync.js: accounts live in
// the local users table, and memberships written here carry
// source = 'idp' so local and AD rows are never
// touched. An IdP user is never linked to an existing local or AD account.
const db = require('../db/adminDb');

const SSO_PASSWORD_PLACEHOLDER = '!sso';

const lower = (v) => String(v == null ? '' : v).trim().toLowerCase();

function issuerKey(provider) {
  return (provider.type === 'saml' ? provider.idp_entity_id : provider.issuer) || '';
}

function externalIdFor(provider, identity) {
  return `idp:${issuerKey(provider)}:${identity.subject}`;
}

function linkedGroups(providerId) {
  return db.prepare("SELECT * FROM groups WHERE provider = 'idp' AND idp_provider_id = ? ORDER BY name").all(Number(providerId));
}

/** Lookup order: external_id, then (same provider) case-insensitive email. */
function findUser(provider, identity) {
  if (!identity || identity.subject == null || identity.subject === '') return null;
  const byExt = db.prepare('SELECT * FROM users WHERE external_id = ?').get(externalIdFor(provider, identity));
  if (byExt) return byExt;
  if (identity.email) {
    return db.prepare('SELECT * FROM users WHERE idp_provider_id = ? AND lower(email) = lower(?)').get(provider.id, String(identity.email)) || null;
  }
  return null;
}

/** Linked group ids the identity belongs to (by group name, or Okta group id). */
function matchGroups(provider, identity) {
  const names = new Set((identity.groups || []).map(lower));
  const ids = new Set((identity.groupIds || []).map((x) => String(x)));
  return linkedGroups(provider.id)
    .filter((g) => (g.external_name && names.has(lower(g.external_name))) || (g.external_id && ids.has(String(g.external_id))))
    .map((g) => g.id);
}

/** Insert or update one IdP user. Returns { id, created, updated, renamed } or { id: null, conflict }. */
const upsertUserTxn = db.transaction((provider, identity, now, opts = {}) => {
  const ext = externalIdFor(provider, identity);
  const isActive = identity.active === false ? 0 : 1;
  const display = identity.displayName || null;
  const email = identity.email || null;
  let row = findUser(provider, identity);

  if (!row) {
    let username = lower(identity.username || identity.email || identity.subject);
    if (!username) return { id: null, created: false, updated: false };
    let renamed = null;
    const taken = (u) => db.prepare('SELECT 1 FROM users WHERE username = ?').get(u);
    if (taken(username)) {
      username = `${username}#${provider.slug}`;
      renamed = username;
      if (taken(username)) return { id: null, created: false, updated: false, conflict: username };
    }
    const info = db.prepare(`
      INSERT INTO users (username, password_hash, display_name, auth_provider, external_id, idp_provider_id, is_active, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(username, SSO_PASSWORD_PLACEHOLDER, display || username, provider.type, ext, provider.id, isActive, now, now);
    const account = { id: Number(info.lastInsertRowid) };
    db.prepare('UPDATE users SET email = ?, synced_at = ?, directory_pinned = ? WHERE id = ?')
      .run(email, now, opts.pinned ? 1 : 0, account.id);
    return { id: account.id, created: true, updated: false, renamed };
  }

  const nextName = display || row.display_name || row.username;
  const changed = row.display_name !== nextName || row.is_active !== isActive || (row.email || null) !== email
    || row.idp_provider_id !== provider.id;
  db.prepare(`
    UPDATE users SET display_name = ?, is_active = ?, email = ?, synced_at = ?, idp_provider_id = ?,
      directory_pinned = CASE WHEN ? THEN 1 ELSE directory_pinned END,
      updated_at = CASE WHEN ? THEN ? ELSE updated_at END
    WHERE id = ?
  `).run(nextName, isActive, email || row.email || null, now, provider.id, opts.pinned ? 1 : 0, changed ? 1 : 0, now, row.id);
  return { id: row.id, created: false, updated: changed, renamed: null };
});

/** Make the user's idp-sourced memberships (for this provider's groups) exactly `groupIds`. */
const setIdpMembershipsTxn = db.transaction((userId, providerId, groupIds) => {
  const wanted = new Set((groupIds || []).map(Number));
  const current = db.prepare(`
    SELECT ug.group_id FROM user_groups ug JOIN groups g ON g.id = ug.group_id
    WHERE ug.user_id = ? AND ug.source = 'idp' AND g.idp_provider_id = ?
  `).all(userId, providerId).map((r) => r.group_id);
  const del = db.prepare("DELETE FROM user_groups WHERE user_id = ? AND group_id = ? AND source = 'idp'");
  for (const gid of current) if (!wanted.has(gid)) del.run(userId, gid);
  const ins = db.prepare("INSERT OR IGNORE INTO user_groups (user_id, group_id, source) VALUES (?, ?, 'idp')");
  for (const gid of wanted) ins.run(userId, gid);
});

/**
 * After a verified sign-in. Returns { user } (users row) or
 * { denied: 'no_access' | 'inactive' | 'jit_disabled' }; a denied identity
 * never creates a row.
 */
function provisionLogin(provider, identity) {
  const existing = findUser(provider, identity);
  if (identity.active === false || (existing && !existing.is_active)) return { denied: 'inactive' };
  if (!existing && !provider.jit_enabled) return { denied: 'jit_disabled' };
  const groupIds = matchGroups(provider, identity);
  const pinned = !!(existing && existing.directory_pinned);
  if (!groupIds.length && !pinned) return { denied: 'no_access' };
  const r = upsertUserTxn.immediate(provider, identity, new Date().toISOString(), { by: 'idp-login' });
  if (!r.id) return { denied: 'no_access' };
  setIdpMembershipsTxn.immediate(r.id, provider.id, groupIds);
  return { user: db.prepare('SELECT * FROM users WHERE id = ?').get(r.id) };
}

/** Add one IdP user by name (pinned) with the admin's local group picks. */
function importUser(provider, identity, localGroupIds = []) {
  const r = upsertUserTxn.immediate(provider, identity, new Date().toISOString(), { pinned: true, by: 'idp-import' });
  if (!r.id) {
    const e = new Error(r.conflict ? `An account named "${r.conflict}" already exists.` : 'Could not import that user.');
    e.status = 409;
    e.error = e.message;
    throw e;
  }
  db.transaction(() => {
    db.prepare('UPDATE users SET directory_pinned = 1 WHERE id = ?').run(r.id);
    db.prepare("DELETE FROM user_groups WHERE user_id = ? AND source = 'local'").run(r.id);
    const ins = db.prepare("INSERT OR IGNORE INTO user_groups (user_id, group_id, source) VALUES (?, ?, 'local')");
    for (const gid of localGroupIds || []) if (Number.isInteger(Number(gid))) ins.run(r.id, Number(gid));
  }).immediate();
  return db.prepare('SELECT * FROM users WHERE id = ?').get(r.id);
}

/** Users of this provider (not pinned) that a sync did not see: drop idp memberships, deactivate. */
function deactivateStrays(provider, seenUserIds, now) {
  const seen = new Set((seenUserIds || []).map(Number));
  const strays = db.prepare('SELECT id FROM users WHERE idp_provider_id = ? AND directory_pinned = 0').all(provider.id)
    .filter((r) => !seen.has(r.id));
  let count = 0;
  for (const s of strays) {
    setIdpMembershipsTxn.immediate(s.id, provider.id, []);
    const res = db.prepare('UPDATE users SET is_active = 0, updated_at = ? WHERE id = ? AND is_active = 1').run(now || new Date().toISOString(), s.id);
    if (res.changes) count += res.changes;
  }
  return count;
}

module.exports = {
  findUser, matchGroups, upsertUserTxn, setIdpMembershipsTxn, provisionLogin, importUser,
  linkedGroups, deactivateStrays, externalIdFor, SSO_PASSWORD_PLACEHOLDER,
};
