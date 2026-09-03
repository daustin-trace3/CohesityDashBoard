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
];
