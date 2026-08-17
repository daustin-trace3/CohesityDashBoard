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
  {
    version: 2,
    up(db) {
      // VRA appliances per site, from /v2/monitoring/sites?format=topology.
      // Replaced wholesale each poll alongside the other current-state tables.
      db.exec(`
        CREATE TABLE IF NOT EXISTS zerto_vras (
          id              INTEGER PRIMARY KEY AUTOINCREMENT,
          site_identifier TEXT NOT NULL,
          site_name       TEXT,
          name            TEXT,
          version         TEXT,
          status          TEXT,
          progress        INTEGER,
          captured_at     DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
        );
        CREATE INDEX IF NOT EXISTS idx_zerto_vras_site ON zerto_vras(site_identifier);
      `);
    },
  },
  {
    version: 3,
    up(db) {
      // Zerto licenses from /v3/licenses (consumption = protected-VM count).
      // Replaced wholesale each poll; site_usage holds the per-site breakdown
      // JSON [{siteIdentifier, siteName, packageUsedVMsCount}].
      db.exec(`
        CREATE TABLE IF NOT EXISTS zerto_licenses (
          id               INTEGER PRIMARY KEY AUTOINCREMENT,
          license_key      TEXT NOT NULL UNIQUE,
          license_package  TEXT,
          available_vms    INTEGER,
          used_vms         INTEGER,
          is_shared        INTEGER,
          expiration_date  TEXT,
          alerts           TEXT,
          site_usage       TEXT,
          updated_at       DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
        );
      `);
    },
  },

  // Migration: cached AI Advisor report content, one row per report key.
  {
    version: 4,
    up(db) {
      db.exec(`
        CREATE TABLE IF NOT EXISTS zerto_ai_reports (
          report_key    TEXT PRIMARY KEY,
          model         TEXT,
          content       TEXT NOT NULL,
          generated_at  DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
        );
      `);
    },
  },

  // Per-alert-type SMTP notification toggles. Seeded from Zerto's official
  // alerts reference (db/reference/zertoAlertTypes.json, 229 codes); the poller stamps
  // first/last_seen when a code shows up live, and inserts codes the reference
  // doesn't know. enabled=0 mutes the code in the alertNotifier collector.
  {
    version: 5,
    up(db) {
      db.exec(`
        CREATE TABLE IF NOT EXISTS zerto_alert_catalog (
          alert_type  TEXT PRIMARY KEY,
          entity      TEXT,
          severity    TEXT,
          description TEXT,
          enabled     INTEGER NOT NULL DEFAULT 1,
          first_seen  DATETIME,
          last_seen   DATETIME
        );
      `);
      const seed = db.prepare(`
        INSERT OR IGNORE INTO zerto_alert_catalog (alert_type, entity, severity, description)
        VALUES (?, ?, ?, ?)
      `);
      for (const t of require('../reference/zertoAlertTypes.json')) {
        seed.run(t.code, t.entity || null, t.severity || null, t.description || null);
      }
      db.exec(`
        UPDATE zerto_alert_catalog SET first_seen = CURRENT_TIMESTAMP, last_seen = CURRENT_TIMESTAMP
        WHERE alert_type IN (SELECT DISTINCT alert_type FROM zerto_alerts WHERE alert_type IS NOT NULL);
        INSERT OR IGNORE INTO zerto_alert_catalog (alert_type, entity, severity, description, first_seen, last_seen)
        SELECT alert_type, entity_type, severity, MIN(description), CURRENT_TIMESTAMP, CURRENT_TIMESTAMP
        FROM zerto_alerts WHERE alert_type IS NOT NULL GROUP BY alert_type;
      `);
    },
  },
];
