// User accounts, sessions, tenant membership and the global audit log. These
// are the only things shared by every tenant (docs/MULTI-TENANT-DESIGN.md,
// decisions 3, 7, 8, 16), so they live in the global database.
//
// Every tenant database keeps a MIRROR row in its own users table for each of
// its members: same id, same username, no password. That is what lets the
// per-tenant tables (user_groups, role_grants, user_dashboards, ...) and the
// RBAC queries keep working unchanged. The global row is the account; the
// mirror is a membership marker with a name on it.
const crypto = require('crypto');
const registry = require('./tenantRegistry');
const { runAsTenant, currentTenantId } = require('./tenantContext');

const g = registry.globalDb;

g.exec(`
  CREATE TABLE IF NOT EXISTS global_users (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    username        TEXT NOT NULL UNIQUE COLLATE NOCASE,
    password_hash   TEXT NOT NULL,
    display_name    TEXT,
    auth_provider   TEXT NOT NULL DEFAULT 'local',
    is_active       INTEGER NOT NULL DEFAULT 1,
    is_global_admin INTEGER NOT NULL DEFAULT 0,
    external_id     TEXT,
    created_at      TEXT NOT NULL,
    updated_at      TEXT NOT NULL,
    last_login_at   TEXT
  );
  CREATE TABLE IF NOT EXISTS global_sessions (
    id              TEXT PRIMARY KEY,
    user_id         INTEGER NOT NULL REFERENCES global_users(id) ON DELETE CASCADE,
    csrf_token      TEXT NOT NULL,
    created_at      TEXT NOT NULL,
    expires_at      TEXT NOT NULL,
    last_seen_at    TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS tenant_members (
    tenant_id       TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    user_id         INTEGER NOT NULL REFERENCES global_users(id) ON DELETE CASCADE,
    added_at        TEXT NOT NULL,
    added_by        TEXT,
    PRIMARY KEY (tenant_id, user_id)
  );
  CREATE TABLE IF NOT EXISTS global_audit (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    at              TEXT NOT NULL,
    actor_id        INTEGER,
    actor           TEXT,
    action          TEXT NOT NULL,
    tenant_id       TEXT,
    detail          TEXT
  );
  CREATE INDEX IF NOT EXISTS idx_global_audit_at ON global_audit(at);
`);

const now = () => new Date().toISOString();

// --- users -----------------------------------------------------------------

function getUser(id) {
  return g.prepare('SELECT * FROM global_users WHERE id = ?').get(id) || null;
}

function findUserByUsername(username) {
  return g.prepare('SELECT * FROM global_users WHERE username = ?').get(String(username)) || null;
}

function findUserByExternalId(externalId) {
  return g.prepare('SELECT * FROM global_users WHERE external_id = ?').get(externalId) || null;
}

function userCount() {
  return g.prepare('SELECT COUNT(*) AS c FROM global_users').get().c;
}

function createUser({ username, passwordHash, displayName = null, authProvider = 'local', isActive = 1, isGlobalAdmin = 0, externalId = null }) {
  const t = now();
  const info = g.prepare(`
    INSERT INTO global_users (username, password_hash, display_name, auth_provider, is_active, is_global_admin, external_id, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(username, passwordHash, displayName, authProvider, isActive ? 1 : 0, isGlobalAdmin ? 1 : 0, externalId, t, t);
  return getUser(info.lastInsertRowid);
}

/** Partial update; only the keys present are written. Mirrors follow. */
function updateUser(id, fields) {
  const cols = { display_name: 'displayName', is_active: 'isActive', password_hash: 'passwordHash', is_global_admin: 'isGlobalAdmin', username: 'username', external_id: 'externalId', auth_provider: 'authProvider', last_login_at: 'lastLoginAt' };
  const sets = [];
  const args = [];
  for (const [col, key] of Object.entries(cols)) {
    if (fields[key] === undefined) continue;
    sets.push(`${col} = ?`);
    const v = fields[key];
    args.push(typeof v === 'boolean' ? (v ? 1 : 0) : v);
  }
  if (!sets.length) return getUser(id);
  sets.push('updated_at = ?');
  args.push(now(), id);
  g.prepare(`UPDATE global_users SET ${sets.join(', ')} WHERE id = ?`).run(...args);
  const user = getUser(id);
  for (const tenantId of tenantsOf(id)) runAsTenant(tenantId, () => writeMirror(user));
  return user;
}

function listUsers() {
  return g.prepare('SELECT * FROM global_users ORDER BY username').all();
}

// --- sessions ----------------------------------------------------------------

function createSession(userId, ttlMs) {
  const id = crypto.randomBytes(32).toString('hex');
  const csrfToken = crypto.randomBytes(32).toString('hex');
  const t = Date.now();
  g.prepare(`
    INSERT INTO global_sessions (id, user_id, csrf_token, created_at, expires_at, last_seen_at)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(id, userId, csrfToken, new Date(t).toISOString(), new Date(t + ttlMs).toISOString(), new Date(t).toISOString());
  return { id, csrfToken };
}

function getSession(id) {
  return g.prepare('SELECT * FROM global_sessions WHERE id = ?').get(id) || null;
}

function touchSession(id, expiresAt) {
  if (expiresAt) g.prepare('UPDATE global_sessions SET expires_at = ?, last_seen_at = ? WHERE id = ?').run(expiresAt, now(), id);
  else g.prepare('UPDATE global_sessions SET last_seen_at = ? WHERE id = ?').run(now(), id);
}

function destroySession(id) {
  g.prepare('DELETE FROM global_sessions WHERE id = ?').run(id);
}

function pruneSessions() {
  g.prepare('DELETE FROM global_sessions WHERE expires_at <= ?').run(now());
}

// --- membership ----------------------------------------------------------------

function isMember(tenantId, userId) {
  return !!g.prepare('SELECT 1 FROM tenant_members WHERE tenant_id = ? AND user_id = ?').get(tenantId, userId);
}

function tenantsOf(userId) {
  return g.prepare('SELECT tenant_id FROM tenant_members WHERE user_id = ? ORDER BY tenant_id').all(userId).map((r) => r.tenant_id);
}

function membersOf(tenantId) {
  return g.prepare(`
    SELECT u.* FROM global_users u JOIN tenant_members m ON m.user_id = u.id
    WHERE m.tenant_id = ? ORDER BY u.username
  `).all(tenantId);
}

/** The mirror row inside the CURRENT tenant's database. Never deletes; the
 *  upsert is by id so user_groups and friends keep their references. */
function writeMirror(user) {
  const tdb = require('../db/database');
  tdb.prepare(`
    INSERT INTO users (id, username, password_hash, display_name, auth_provider, is_active, created_at, updated_at, last_login_at)
    VALUES (?, ?, '', ?, ?, ?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET
      username = excluded.username, display_name = excluded.display_name, auth_provider = excluded.auth_provider,
      is_active = excluded.is_active, updated_at = excluded.updated_at, last_login_at = excluded.last_login_at
  `).run(user.id, user.username, user.display_name, user.auth_provider, user.is_active ? 1 : 0, user.created_at, user.updated_at, user.last_login_at);
}

/** Adds a member and its mirror row; new members land in the tenant's Viewer
 *  group (decision 8) unless the caller assigns groups itself (directory
 *  sync does). Returns false when already a member. */
function addMember(tenantId, userId, addedBy = null, { defaultGroup = true } = {}) {
  if (!registry.getTenant(tenantId)) throw new Error(`Unknown tenant: ${tenantId}`);
  const user = getUser(userId);
  if (!user) throw new Error(`Unknown user: ${userId}`);
  const fresh = g.prepare('INSERT OR IGNORE INTO tenant_members (tenant_id, user_id, added_at, added_by) VALUES (?, ?, ?, ?)')
    .run(tenantId, userId, now(), addedBy).changes === 1;
  runAsTenant(tenantId, () => {
    writeMirror(user);
    if (fresh) tenantAudit('member.added', addedBy, { username: user.username });
    if (fresh && defaultGroup) {
      const tdb = require('../db/database');
      const viewer = tdb.prepare("SELECT id FROM groups WHERE name = 'Viewer'").get();
      if (viewer) tdb.prepare('INSERT OR IGNORE INTO user_groups (user_id, group_id) VALUES (?, ?)').run(userId, viewer.id);
    }
  });
  return fresh;
}

/** Removes the membership and the mirror row (which cascades the member's
 *  group links in that tenant). The account itself stays. */
function removeMember(tenantId, userId) {
  const gone = g.prepare('DELETE FROM tenant_members WHERE tenant_id = ? AND user_id = ?').run(tenantId, userId).changes === 1;
  runAsTenant(tenantId, () => {
    const tdb = require('../db/database');
    tdb.prepare("DELETE FROM role_grants WHERE subject_type = 'user' AND subject_id = ?").run(userId);
    tdb.prepare('DELETE FROM users WHERE id = ?').run(userId);
    if (gone) tenantAudit('member.removed', null, { userId });
  });
  return gone;
}

/** A global admin is an admin in every tenant without being added (decision
 *  7). Its mirror row is written on first entry so per-tenant tables that
 *  reference users(id) work for it too. */
function ensureMirrorHere(user) {
  writeMirror(user);
}

// --- audit ---------------------------------------------------------------------

/** The current tenant's own log; lazy so accounts.js stays loadable first. */
function tenantAudit(action, actor, detail) {
  try {
    require('./tenantLifecycle').auditTenant(action, { actor: typeof actor === 'string' ? { username: actor } : actor, detail });
  } catch { /* table not there yet on a very old database */ }
}

function audit(action, { actor = null, tenantId = null, detail = null } = {}) {
  g.prepare('INSERT INTO global_audit (at, actor_id, actor, action, tenant_id, detail) VALUES (?, ?, ?, ?, ?, ?)')
    .run(now(), actor ? actor.id : null, actor ? actor.username : null, action, tenantId || currentTenantId(), detail == null ? null : (typeof detail === 'string' ? detail : JSON.stringify(detail)));
}

function listAudit({ limit = 200, tenantId = null } = {}) {
  const cap = Math.min(Math.max(1, Number(limit) || 200), 1000);
  return tenantId
    ? g.prepare('SELECT * FROM global_audit WHERE tenant_id = ? ORDER BY id DESC LIMIT ?').all(tenantId, cap)
    : g.prepare('SELECT * FROM global_audit ORDER BY id DESC LIMIT ?').all(cap);
}

// --- one-time move from a single-tenant install --------------------------------

/** First boot on this code: the default tenant's users, sessions and grants
 *  become global rows with the same ids. A user holding *:*:* directly or
 *  through a group becomes a global admin (that is the install's admin). */
function migrateFromDefaultTenant() {
  if (userCount() > 0) return { moved: 0 };
  const handle = registry.getHandle(registry.DEFAULT_TENANT);
  const users = handle.prepare('SELECT * FROM users ORDER BY id').all();
  if (!users.length) return { moved: 0 };
  const adminIds = new Set(handle.prepare(`
    SELECT DISTINCT u.id FROM users u
    LEFT JOIN role_grants rg ON rg.subject_type = 'user' AND rg.subject_id = u.id
    LEFT JOIN user_groups ug ON ug.user_id = u.id
    LEFT JOIN role_grants gg ON gg.subject_type = 'group' AND gg.subject_id = ug.group_id
    WHERE rg.permission = '*:*:*' OR gg.permission = '*:*:*'
  `).all().map((r) => r.id));
  const move = g.transaction(() => {
    const ins = g.prepare(`
      INSERT INTO global_users (id, username, password_hash, display_name, auth_provider, is_active, is_global_admin, external_id, created_at, updated_at, last_login_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    const mem = g.prepare('INSERT INTO tenant_members (tenant_id, user_id, added_at, added_by) VALUES (?, ?, ?, ?)');
    for (const u of users) {
      ins.run(u.id, u.username, u.password_hash, u.display_name, u.auth_provider || 'local', u.is_active, adminIds.has(u.id) ? 1 : 0, u.external_id || null, u.created_at, u.updated_at, u.last_login_at);
      mem.run(registry.DEFAULT_TENANT, u.id, now(), 'migration');
    }
    const sess = g.prepare('INSERT OR IGNORE INTO global_sessions (id, user_id, csrf_token, created_at, expires_at, last_seen_at) VALUES (?, ?, ?, ?, ?, ?)');
    let sessions = [];
    try { sessions = handle.prepare('SELECT * FROM auth_sessions').all(); } catch { /* table absent */ }
    for (const s of sessions) sess.run(s.id, s.user_id, s.csrf_token, s.created_at, s.expires_at, s.last_seen_at);
    g.prepare("UPDATE sqlite_sequence SET seq = (SELECT MAX(id) FROM global_users) WHERE name = 'global_users'").run();
  });
  move();
  // The tenant rows keep their old hashes so the previous code still works if
  // this install is rolled back; the new code never reads them.
  audit('accounts.migrated', { tenantId: registry.DEFAULT_TENANT, detail: { users: users.length, globalAdmins: adminIds.size } });
  return { moved: users.length };
}

module.exports = {
  getUser, findUserByUsername, findUserByExternalId, userCount, createUser, updateUser, listUsers,
  createSession, getSession, touchSession, destroySession, pruneSessions,
  isMember, tenantsOf, membersOf, addMember, removeMember, ensureMirrorHere, writeMirror,
  audit, listAudit, migrateFromDefaultTenant,
};
