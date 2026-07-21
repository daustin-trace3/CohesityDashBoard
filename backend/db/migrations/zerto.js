// Zerto scope: zerto_* tables. Data comes from the Zerto Analytics SaaS API
// (analytics.api.zerto.com) — one account-wide credential, so there is no
// per-array registration table; zerto_sites is discovered inventory.
// Current-state tables (sites, vpgs, alerts, vms) are replaced wholesale each
// poll; zerto_metrics_history accumulates account-level snapshots for trends.
module.exports = [
  {
    version: 1,
    up(db) {
      db.exec(`
        CREATE TABLE IF NOT EXISTS zerto_sites (
          id                      INTEGER PRIMARY KEY AUTOINCREMENT,
          site_identifier         TEXT NOT NULL UNIQUE,
          name                    TEXT,
          site_type               TEXT,
          version                 TEXT,
          zvm_ip                  TEXT,
          connection_status       TEXT,
          last_connection_time    TEXT,
          is_transmission_enabled INTEGER,
          zorgs                   TEXT,
          updated_at              DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
        );

        CREATE TABLE IF NOT EXISTS zerto_vpgs (
          id                        INTEGER PRIMARY KEY AUTOINCREMENT,
          vpg_identifier            TEXT NOT NULL UNIQUE,
          name                      TEXT,
          vms_count                 INTEGER,
          protected_site            TEXT,
          protected_site_type       TEXT,
          recovery_site             TEXT,
          recovery_site_type        TEXT,
          actual_rpo                INTEGER,
          configured_rpo            INTEGER,
          health                    TEXT,
          status                    TEXT,
          sub_status                TEXT,
          actual_journal_history    INTEGER,
          configured_journal_history INTEGER,
          zorg_name                 TEXT,
          captured_at               DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
        );

        CREATE TABLE IF NOT EXISTS zerto_alerts (
          id               INTEGER PRIMARY KEY AUTOINCREMENT,
          alert_identifier TEXT NOT NULL UNIQUE,
          alert_type       TEXT,
          severity         TEXT,
          description      TEXT,
          site_name        TEXT,
          entity_type      TEXT,
          collection_time  TEXT,
          captured_at      DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
        );

        CREATE TABLE IF NOT EXISTS zerto_vms (
          id                     INTEGER PRIMARY KEY AUTOINCREMENT,
          vm_identifier          TEXT NOT NULL,
          name                   TEXT,
          provisioned_storage_mb INTEGER,
          used_storage_mb        INTEGER,
          vpg_names              TEXT,
          vpg_statuses           TEXT,
          protected_site         TEXT,
          recovery_site          TEXT,
          zorg_name              TEXT,
          captured_at            DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
        );
        CREATE INDEX IF NOT EXISTS idx_zerto_vms_identifier ON zerto_vms(vm_identifier);

        CREATE TABLE IF NOT EXISTS zerto_metrics_history (
          id                     INTEGER PRIMARY KEY AUTOINCREMENT,
          captured_at            DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
          sites_count            INTEGER,
          connected_sites_count  INTEGER,
          vpgs_count             INTEGER,
          healthy_vpgs           INTEGER,
          warned_vpgs            INTEGER,
          erroneous_vpgs         INTEGER,
          vms_count              INTEGER,
          alerts_count           INTEGER,
          avg_actual_rpo         REAL,
          provisioned_storage_mb INTEGER,
          used_storage_mb        INTEGER
        );
        CREATE INDEX IF NOT EXISTS idx_zerto_metrics_time ON zerto_metrics_history(captured_at);
      `);
    },
  },
];
