// Identity provider registry (OIDC + SAML 2.0, Okta): provider rows, secrets,
// the public URLs an admin pastes into the IdP, and the short-lived sign-in
// state. Pure data layer; the protocol work lives in idpOidc.js / idpSaml.js.
const crypto = require('crypto');
const db = require('../db/adminDb');
const { encrypt, decrypt } = require('./encryption');
const { publicBase, apiPrefix } = require('../utils/publicUrl');

const SLUG_RE = /^[a-z0-9-]{2,32}$/;
const STATE_TTL_MS = 10 * 60 * 1000;
const SECRET_COLS = { clientSecret: 'client_secret', mgmtToken: 'mgmt_token', spKeyPem: 'sp_key_pem' };

const fail = (field, error, status = 400) => Object.assign(new Error(error), { status, error, field });

function getProvider(id) {
  return db.prepare('SELECT * FROM idp_providers WHERE id = ?').get(Number(id)) || null;
}
function getProviderBySlug(slug) {
  return db.prepare('SELECT * FROM idp_providers WHERE slug = ?').get(String(slug || '')) || null;
}

function getSecret(row, col) {
  if (!row || !row[col]) return '';
  try { return decrypt(row[col]); } catch { return ''; }
}

function publicUrls(req, row) {
  const { base, fromRequest } = publicBase(req);
  const prefix = `${base}${apiPrefix()}/auth/sso/${row.slug}`;
  const metadataUrl = `${prefix}/metadata`;
  return {
    redirectUri: `${prefix}/callback`,
    acsUrl: `${prefix}/acs`,
    metadataUrl,
    spEntityId: row.sp_entity_id || metadataUrl,
    urlsFromRequest: fromRequest,
  };
}

function toPublic(row, req) {
  if (!row) return null;
  const out = {
    id: row.id, name: row.name, slug: row.slug, type: row.type, enabled: !!row.enabled,
    testedAt: row.tested_at, testError: row.test_error,
    issuer: row.issuer, clientId: row.client_id, clientSecretSet: !!row.client_secret, scopes: row.scopes,
    idpEntityId: row.idp_entity_id, idpSsoUrl: row.idp_sso_url, idpCertPem: row.idp_cert_pem,
    idpMetadataUrl: row.idp_metadata_url, spEntityId: row.sp_entity_id, spCertPem: row.sp_cert_pem,
    spKeySet: !!row.sp_key_pem,
    wantAssertionsSigned: !!row.want_assertions_signed, allowIdpInitiated: !!row.allow_idp_initiated,
    claimSubject: row.claim_subject, claimEmail: row.claim_email, claimName: row.claim_name,
    claimGroups: row.claim_groups, jitEnabled: !!row.jit_enabled,
    mgmtKind: row.mgmt_kind, mgmtBaseUrl: row.mgmt_base_url, mgmtTokenSet: !!row.mgmt_token,
    mgmtSyncMinutes: row.mgmt_sync_minutes, mgmtDeactivateRemoved: !!row.mgmt_deactivate_removed,
    mgmtLastSyncAt: row.mgmt_last_sync_at, mgmtLastStatus: row.mgmt_last_status, mgmtLastError: row.mgmt_last_error,
    linkedGroups: db.prepare("SELECT COUNT(*) c FROM groups WHERE provider = 'idp' AND idp_provider_id = ?").get(row.id).c,
    users: db.prepare('SELECT COUNT(*) c FROM users WHERE idp_provider_id = ?').get(row.id).c,
    createdAt: row.created_at, updatedAt: row.updated_at,
  };
  if (req) out.urls = publicUrls(req, row);
  return out;
}

function listProviders(req) {
  return db.prepare('SELECT * FROM idp_providers ORDER BY name').all().map((r) => toPublic(r, req));
}

function listEnabledPublic() {
  try {
    return db.prepare('SELECT slug, name, type FROM idp_providers WHERE enabled = 1 ORDER BY name').all();
  } catch { return []; }
}

/* ----------------------------------------------------------------------- */
/* Create / update / delete                                                */
/* ----------------------------------------------------------------------- */

// camelCase body key -> column. Plain (non-secret) fields only.
const FIELDS = {
  name: 'name', issuer: 'issuer', clientId: 'client_id', scopes: 'scopes',
  idpEntityId: 'idp_entity_id', idpSsoUrl: 'idp_sso_url', idpCertPem: 'idp_cert_pem', idpMetadataUrl: 'idp_metadata_url',
  spEntityId: 'sp_entity_id', spCertPem: 'sp_cert_pem',
  wantAssertionsSigned: 'want_assertions_signed', allowIdpInitiated: 'allow_idp_initiated',
  claimSubject: 'claim_subject', claimEmail: 'claim_email', claimName: 'claim_name', claimGroups: 'claim_groups',
  jitEnabled: 'jit_enabled', mgmtKind: 'mgmt_kind', mgmtBaseUrl: 'mgmt_base_url',
  mgmtSyncMinutes: 'mgmt_sync_minutes', mgmtDeactivateRemoved: 'mgmt_deactivate_removed', enabled: 'enabled',
};
const BOOL_COLS = new Set(['want_assertions_signed', 'allow_idp_initiated', 'jit_enabled', 'mgmt_deactivate_removed', 'enabled']);
// Changing any of these invalidates a previous successful test.
const CONNECTION_COLS = ['issuer', 'client_id', 'scopes', 'idp_entity_id', 'idp_sso_url', 'idp_cert_pem', 'sp_entity_id'];

function isLocalHttp(u) {
  return u.protocol === 'http:' && (u.hostname === '127.0.0.1' || u.hostname === 'localhost');
}
function checkUrl(value, field, label) {
  let u;
  try { u = new URL(value); } catch { throw fail(field, `${label} must be a valid URL.`); }
  if (u.protocol !== 'https:' && !isLocalHttp(u)) throw fail(field, `${label} must start with https://.`);
}

function normalizeValue(col, v) {
  if (BOOL_COLS.has(col)) return v ? 1 : 0;
  if (v === null || v === undefined) return null;
  if (col === 'mgmt_sync_minutes') return Number(v);
  return String(v).trim();
}

function defaultsFor(type) {
  return {
    claim_subject: type === 'saml' ? 'nameid' : 'sub',
    claim_email: 'email', claim_name: 'name', claim_groups: 'groups',
    scopes: 'openid profile email groups',
  };
}

function validateFinal(next) {
  const name = String(next.name || '');
  if (name.length < 1 || name.length > 64) throw fail('name', 'Name must be 1 to 64 characters.');
  if (!SLUG_RE.test(next.slug || '')) throw fail('slug', 'Slug must be 2 to 32 characters of a-z, 0-9 and hyphen.');
  if (next.type !== 'oidc' && next.type !== 'saml') throw fail('type', 'Type must be oidc or saml.');
  if (next.type === 'oidc') {
    if (next.issuer) checkUrl(next.issuer, 'issuer', 'Issuer');
    if (!String(next.scopes || '').split(/\s+/).includes('openid')) throw fail('scopes', 'Scopes must include openid.');
  } else if (next.idp_sso_url) {
    checkUrl(next.idp_sso_url, 'idpSsoUrl', 'Single sign-on URL');
  }
  if (next.mgmt_kind !== 'none' && next.mgmt_kind !== 'okta') throw fail('mgmtKind', 'Management kind must be none or okta.');
  if (next.mgmt_base_url) checkUrl(next.mgmt_base_url, 'mgmtBaseUrl', 'Management API URL');
  if (next.mgmt_kind === 'okta' && !next.mgmt_base_url) throw fail('mgmtBaseUrl', 'Management API URL is required for Okta.');
  const mins = Number(next.mgmt_sync_minutes);
  if (!Number.isInteger(mins) || mins < 5 || mins > 1440) throw fail('mgmtSyncMinutes', 'Sync interval must be 5 to 1440 minutes.');
  if (next.enabled) {
    if (!next.tested_at) throw fail('enabled', 'Test the provider successfully before enabling it.');
    if (next.type === 'oidc' && !(next.issuer && next.client_id && next.client_secret)) {
      throw fail('enabled', 'An OIDC provider needs an issuer, client ID and client secret before it can be enabled.');
    }
    if (next.type === 'saml' && !(next.idp_sso_url && next.idp_cert_pem)) {
      throw fail('enabled', 'A SAML provider needs a single sign-on URL and a certificate before it can be enabled.');
    }
  }
}

function applySecrets(body, merged, prev) {
  for (const [key, col] of Object.entries(SECRET_COLS)) {
    const v = body[key];
    if (v === undefined || v === '') continue;
    merged[col] = v === null ? null : encrypt(String(v));
  }
  // Saved-secret-to-saved-address rule: a stored secret only goes where it was saved for.
  if (prev) {
    const noNewSecret = body.clientSecret === undefined || body.clientSecret === '';
    if ((merged.issuer || null) !== (prev.issuer || null) && noNewSecret) merged.client_secret = null;
    const noNewToken = body.mgmtToken === undefined || body.mgmtToken === '';
    if ((merged.mgmt_base_url || null) !== (prev.mgmt_base_url || null) && noNewToken) merged.mgmt_token = null;
  }
}

function createProvider(body = {}) {
  const type = String(body.type || '');
  if (type !== 'oidc' && type !== 'saml') throw fail('type', 'Type must be oidc or saml.');
  const merged = {
    type, enabled: 0, mgmt_kind: 'none', mgmt_sync_minutes: 60, want_assertions_signed: 1,
    allow_idp_initiated: 0, jit_enabled: 1, mgmt_deactivate_removed: 1, ...defaultsFor(type),
  };
  for (const [key, col] of Object.entries(FIELDS)) if (body[key] !== undefined) merged[col] = normalizeValue(col, body[key]);
  merged.slug = String(body.slug || '').trim().toLowerCase();
  merged.name = String(merged.name || '');
  applySecrets(body, merged, null);
  validateFinal({ ...merged, tested_at: null });
  if (merged.enabled) throw fail('enabled', 'Test the provider successfully before enabling it.');
  if (db.prepare('SELECT 1 FROM idp_providers WHERE slug = ?').get(merged.slug)) throw fail('slug', 'That slug is already in use.', 409);
  if (db.prepare('SELECT 1 FROM idp_providers WHERE name = ?').get(merged.name)) throw fail('name', 'That name is already in use.', 409);
  const now = new Date().toISOString();
  const cols = Object.keys(merged).concat(['created_at', 'updated_at']);
  const vals = Object.values(merged).concat([now, now]);
  const info = db.prepare(`INSERT INTO idp_providers (${cols.join(', ')}) VALUES (${cols.map(() => '?').join(', ')})`).run(...vals);
  return getProvider(info.lastInsertRowid);
}

function updateProvider(id, body = {}) {
  const prev = getProvider(id);
  if (!prev) throw fail('id', 'Provider not found.', 404);
  if (body.type !== undefined && body.type !== prev.type) throw fail('type', 'Type cannot be changed after the provider is created.');
  if (body.slug !== undefined && String(body.slug).trim().toLowerCase() !== prev.slug) throw fail('slug', 'Slug cannot be changed after the provider is created.');
  const merged = { ...prev };
  for (const [key, col] of Object.entries(FIELDS)) if (body[key] !== undefined) merged[col] = normalizeValue(col, body[key]);
  applySecrets(body, merged, prev);

  const connectionChanged = CONNECTION_COLS.some((c) => (merged[c] || null) !== (prev[c] || null))
    || merged.client_secret !== prev.client_secret;
  if (connectionChanged) {
    if (body.enabled === true) throw fail('enabled', 'Connection settings changed; save them, test the provider, then enable it.');
    merged.tested_at = null;
    merged.test_error = null;
    merged.enabled = 0;
  }
  if (merged.discovery_json && (merged.issuer || null) !== (prev.issuer || null)) {
    merged.discovery_json = null;
    merged.discovery_at = null;
  }
  validateFinal(merged);
  if (merged.name !== prev.name && db.prepare('SELECT 1 FROM idp_providers WHERE name = ? AND id != ?').get(merged.name, prev.id)) {
    throw fail('name', 'That name is already in use.', 409);
  }
  merged.updated_at = new Date().toISOString();
  const cols = Object.keys(merged).filter((c) => c !== 'id');
  db.prepare(`UPDATE idp_providers SET ${cols.map((c) => `${c} = ?`).join(', ')} WHERE id = ?`).run(...cols.map((c) => merged[c]), prev.id);
  return getProvider(prev.id);
}

/** Removes the provider and the groups linked to it (grants too). Users stay. */
function deleteProvider(id) {
  const row = getProvider(id);
  if (!row) throw fail('id', 'Provider not found.', 404);
  db.transaction(() => {
    const gids = db.prepare("SELECT id FROM groups WHERE provider = 'idp' AND idp_provider_id = ?").all(row.id).map((g) => g.id);
    for (const gid of gids) {
      db.prepare("DELETE FROM role_grants WHERE subject_type = 'group' AND subject_id = ?").run(gid);
      db.prepare('DELETE FROM groups WHERE id = ?').run(gid);
    }
    db.prepare('DELETE FROM idp_auth_state WHERE provider_id = ?').run(row.id);
    db.prepare('DELETE FROM idp_seen_assertions WHERE provider_id = ?').run(row.id);
    db.prepare('DELETE FROM idp_sync_log WHERE provider_id = ?').run(row.id);
    db.prepare('DELETE FROM idp_providers WHERE id = ?').run(row.id);
  })();
  return { ok: true };
}

function markTested(id, ok, error) {
  const now = new Date().toISOString();
  db.prepare('UPDATE idp_providers SET tested_at = ?, test_error = ?, updated_at = ? WHERE id = ?')
    .run(ok ? now : null, ok ? null : String(error || 'Test failed.').slice(0, 500), now, Number(id));
}

/* ----------------------------------------------------------------------- */
/* Sign-in state                                                           */
/* ----------------------------------------------------------------------- */

function sanitizeReturnTo(raw) {
  let s = String(raw == null ? '' : raw);
  if (s.length > 512) return '/';
  s = s.replace(/^\/t\/[^/?#]+(?=[/?#]|$)/, '') || '/';
  if (!s.startsWith('/')) return '/';
  if (s.includes('//') || s.includes('\\') || /[\u0000-\u001f]/.test(s)) return '/';
  if (/^\/[a-z][a-z0-9+.-]*:/i.test(s)) return '/';
  return s;
}

function createState({ providerId, kind, nonce = null, codeVerifier = null, requestId = null, returnTo = '/' }) {
  const id = crypto.randomBytes(32).toString('hex');
  const now = Date.now();
  db.prepare(`
    INSERT INTO idp_auth_state (id, provider_id, kind, nonce, code_verifier, request_id, return_to, created_at, expires_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(id, providerId, kind, nonce, codeVerifier, requestId, sanitizeReturnTo(returnTo), new Date(now).toISOString(), new Date(now + STATE_TTL_MS).toISOString());
  return id;
}

function setStateRequestId(stateId, requestId) {
  db.prepare('UPDATE idp_auth_state SET request_id = ? WHERE id = ?').run(requestId, stateId);
}

function getStateByRequestId(requestId) {
  if (!requestId) return null;
  return db.prepare('SELECT * FROM idp_auth_state WHERE request_id = ? AND expires_at > ?').get(String(requestId), new Date().toISOString()) || null;
}

/** Single use: the row is deleted as it is read. Expired rows come back null. */
function consumeState(id) {
  if (!id) return null;
  const row = db.prepare('SELECT * FROM idp_auth_state WHERE id = ?').get(String(id));
  if (!row) return null;
  db.prepare('DELETE FROM idp_auth_state WHERE id = ?').run(row.id);
  return row.expires_at > new Date().toISOString() ? row : null;
}

function pruneState() {
  const now = new Date().toISOString();
  db.prepare('DELETE FROM idp_auth_state WHERE expires_at <= ?').run(now);
  db.prepare('DELETE FROM idp_seen_assertions WHERE expires_at <= ?').run(now);
}

module.exports = {
  listProviders, listEnabledPublic, getProvider, getProviderBySlug, toPublic,
  createProvider, updateProvider, deleteProvider, getSecret, publicUrls, markTested,
  createState, setStateRequestId, getStateByRequestId, consumeState, pruneState, sanitizeReturnTo,
};
