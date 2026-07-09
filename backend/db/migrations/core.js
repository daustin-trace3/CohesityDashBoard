// Core scope: app_settings + the plugin registry's own bookkeeping table.
module.exports = [
  {
    version: 1,
    up(db) {
      db.exec(`
        CREATE TABLE IF NOT EXISTS app_settings (
          key                   TEXT PRIMARY KEY,
          value                 TEXT,
          updated_at            DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
        );
      `);
      db.exec(`
        CREATE TABLE IF NOT EXISTS plugins (
          id              TEXT PRIMARY KEY,
          version         TEXT,
          schema_version  INTEGER NOT NULL DEFAULT 0,
          enabled         INTEGER NOT NULL DEFAULT 1,
          status          TEXT NOT NULL DEFAULT 'active',
          error           TEXT,
          installed_at    TEXT,
          updated_at      TEXT
        );
      `);
    },
  },
];
