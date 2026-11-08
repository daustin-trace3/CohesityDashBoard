// Directory scope: Active Directory integration (2026-09-03). Its own scope so
// the version sequence never collides with core.js across branches.
//
// Additive columns on the auth tables (users/groups/user_groups own their
// rows in core) plus a sync log. ALTER TABLE ADD COLUMN is not idempotent in
// SQLite, so every column is guarded by a table_info check: a DB that already
// carries the column (a re-run, or a port between branches) is left alone.

function hasColumn(db, table, column) {
  return db.prepare(`PRAGMA table_info(${table})`).all().some((c) => c.name === column);
}

function addColumn(db, table, column, ddl) {
  if (!hasColumn(db, table, column)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${ddl}`);
}

module.exports = [
  {
    version: 1,
    up(db) {
      // Groups: a provider-managed group mirrors one AD group. external_id is
      // the objectGUID (stable across renames), external_dn is what the sync
      // queries members by, external_name is the AD sAMAccountName/cn.
      addColumn(db, 'groups', 'provider', "TEXT NOT NULL DEFAULT 'local'");
      addColumn(db, 'groups', 'external_id', 'TEXT');
      addColumn(db, 'groups', 'external_dn', 'TEXT');
      addColumn(db, 'groups', 'external_name', 'TEXT');
      addColumn(db, 'groups', 'synced_at', 'TEXT');

      // Users: auth_provider already exists ('local' | 'ad'). AD users carry
      // no usable password_hash (stored as '!ad'); login binds to the domain.
      addColumn(db, 'users', 'external_id', 'TEXT');
      addColumn(db, 'users', 'upn', 'TEXT');
      addColumn(db, 'users', 'email', 'TEXT');
      addColumn(db, 'users', 'synced_at', 'TEXT');

      // Membership provenance: rows the sync wrote ('ad') are reconciled on
      // every sync/login; rows an admin added by hand ('local') are never
      // touched by the sync, even on an AD user.
      addColumn(db, 'user_groups', 'source', "TEXT NOT NULL DEFAULT 'local'");

      db.exec(`
        CREATE TABLE IF NOT EXISTS directory_sync_log (
          id                 INTEGER PRIMARY KEY AUTOINCREMENT,
          started_at         TEXT NOT NULL,
          finished_at        TEXT,
          trigger            TEXT NOT NULL,
          status             TEXT NOT NULL,
          groups_synced      INTEGER NOT NULL DEFAULT 0,
          users_seen         INTEGER NOT NULL DEFAULT 0,
          users_created      INTEGER NOT NULL DEFAULT 0,
          users_updated      INTEGER NOT NULL DEFAULT 0,
          users_deactivated  INTEGER NOT NULL DEFAULT 0,
          message            TEXT
        );
        CREATE INDEX IF NOT EXISTS idx_directory_sync_log_started ON directory_sync_log(started_at);
        CREATE INDEX IF NOT EXISTS idx_groups_provider ON groups(provider);
        CREATE INDEX IF NOT EXISTS idx_users_external_id ON users(external_id);
      `);
    },
  },
  {
    version: 2,
    up(db) {
      // A directory user an admin added by name (not via a linked group):
      // may sign in without linked-group membership, is never deactivated
      // by the group sync, and gets access from the groups the admin ticks.
      addColumn(db, 'users', 'directory_pinned', 'INTEGER NOT NULL DEFAULT 0');
    },
  },
  {
    version: 3,
    up(db) {
      // Identity providers (OIDC + SAML 2.0, Okta): one row per provider, with
      // the short-lived sign-in state, replay guard and Management API sync log.
      db.exec(`
        CREATE TABLE IF NOT EXISTS idp_providers (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          name TEXT NOT NULL UNIQUE,
          slug TEXT NOT NULL UNIQUE,
          type TEXT NOT NULL CHECK (type IN ('oidc','saml')),
          enabled INTEGER NOT NULL DEFAULT 0,
          tested_at TEXT, test_error TEXT,
          issuer TEXT, client_id TEXT, client_secret TEXT,
          scopes TEXT NOT NULL DEFAULT 'openid profile email groups',
          discovery_json TEXT, discovery_at TEXT,
          idp_entity_id TEXT, idp_sso_url TEXT, idp_cert_pem TEXT, idp_metadata_url TEXT,
          sp_entity_id TEXT, sp_key_pem TEXT, sp_cert_pem TEXT,
          want_assertions_signed INTEGER NOT NULL DEFAULT 1,
          allow_idp_initiated INTEGER NOT NULL DEFAULT 0,
          claim_subject TEXT NOT NULL DEFAULT 'sub',
          claim_email TEXT NOT NULL DEFAULT 'email',
          claim_name TEXT NOT NULL DEFAULT 'name',
          claim_groups TEXT NOT NULL DEFAULT 'groups',
          jit_enabled INTEGER NOT NULL DEFAULT 1,
          mgmt_kind TEXT NOT NULL DEFAULT 'none' CHECK (mgmt_kind IN ('none','okta')),
          mgmt_base_url TEXT, mgmt_token TEXT,
          mgmt_sync_minutes INTEGER NOT NULL DEFAULT 60,
          mgmt_deactivate_removed INTEGER NOT NULL DEFAULT 1,
          mgmt_last_sync_at TEXT, mgmt_last_status TEXT, mgmt_last_error TEXT,
          created_at TEXT NOT NULL, updated_at TEXT NOT NULL
        );
        CREATE TABLE IF NOT EXISTS idp_auth_state (
          id TEXT PRIMARY KEY,
          provider_id INTEGER NOT NULL,
          kind TEXT NOT NULL,
          nonce TEXT, code_verifier TEXT, request_id TEXT,
          return_to TEXT NOT NULL DEFAULT '/',
          created_at TEXT NOT NULL, expires_at TEXT NOT NULL
        );
        CREATE TABLE IF NOT EXISTS idp_seen_assertions (
          assertion_id TEXT PRIMARY KEY, provider_id INTEGER NOT NULL, expires_at TEXT NOT NULL
        );
        CREATE TABLE IF NOT EXISTS idp_sync_log (
          id INTEGER PRIMARY KEY AUTOINCREMENT, provider_id INTEGER NOT NULL,
          started_at TEXT NOT NULL, finished_at TEXT, trigger TEXT NOT NULL, status TEXT NOT NULL,
          groups_synced INTEGER NOT NULL DEFAULT 0, users_seen INTEGER NOT NULL DEFAULT 0,
          users_created INTEGER NOT NULL DEFAULT 0, users_updated INTEGER NOT NULL DEFAULT 0,
          users_deactivated INTEGER NOT NULL DEFAULT 0, message TEXT
        );
        CREATE INDEX IF NOT EXISTS idx_idp_sync_log_started ON idp_sync_log(provider_id, started_at);
        CREATE INDEX IF NOT EXISTS idx_idp_auth_state_expires ON idp_auth_state(expires_at);
        CREATE INDEX IF NOT EXISTS idx_idp_auth_state_request ON idp_auth_state(request_id);
      `);
      addColumn(db, 'groups', 'idp_provider_id', 'INTEGER');
      addColumn(db, 'users', 'idp_provider_id', 'INTEGER');
    },
  },
];
