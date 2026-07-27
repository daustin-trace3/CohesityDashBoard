// Pure Storage scope: pure_* tables + the three inline migrations that used
// to live directly in db/database.js (auth_method, netmask/gateway, the
// pure_alerts dedup + unique index).
module.exports = [
  {
    version: 1,
    up(db) {
      db.exec(`
        CREATE TABLE IF NOT EXISTS pure_arrays (
          id                       INTEGER PRIMARY KEY AUTOINCREMENT,
          name                     TEXT NOT NULL UNIQUE,
          mgmt_host                TEXT NOT NULL,
          client_id                TEXT NOT NULL,
          key_id                   TEXT NOT NULL,
          username                 TEXT NOT NULL,
          issuer                   TEXT,
          encrypted_credentials    TEXT NOT NULL,
          polling_interval_minutes INTEGER NOT NULL DEFAULT 15,
          ssl_verify               INTEGER NOT NULL DEFAULT 0,
          auth_method              TEXT NOT NULL DEFAULT 'client',
          created_at               DATETIME DEFAULT CURRENT_TIMESTAMP,
          updated_at               DATETIME DEFAULT CURRENT_TIMESTAMP
        );

        CREATE TABLE IF NOT EXISTS pure_metrics_history (
          id                    INTEGER PRIMARY KEY AUTOINCREMENT,
          array_id              INTEGER NOT NULL REFERENCES pure_arrays(id) ON DELETE CASCADE,
          captured_at           DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
          capacity_bytes        INTEGER,
          used_bytes            INTEGER,
          data_reduction        REAL,
          total_reduction       REAL,
          shared_bytes          INTEGER,
          snapshots_bytes       INTEGER,
          system_bytes          INTEGER,
          volume_count          INTEGER,
          read_iops             REAL,
          write_iops            REAL,
          read_bw_bytes         INTEGER,
          write_bw_bytes        INTEGER,
          read_latency_us       REAL,
          write_latency_us      REAL,
          queue_depth           REAL,
          purity_version        TEXT
        );
        CREATE INDEX IF NOT EXISTS idx_pure_metrics_array_time ON pure_metrics_history(array_id, captured_at);

        CREATE TABLE IF NOT EXISTS pure_volumes (
          id                    INTEGER PRIMARY KEY AUTOINCREMENT,
          array_id              INTEGER NOT NULL REFERENCES pure_arrays(id) ON DELETE CASCADE,
          name                  TEXT,
          provisioned_bytes     INTEGER,
          used_bytes            INTEGER,
          data_reduction        REAL,
          snapshots_bytes       INTEGER,
          destroyed             INTEGER NOT NULL DEFAULT 0,
          captured_at           DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
        );

        CREATE TABLE IF NOT EXISTS pure_alerts (
          id                    INTEGER PRIMARY KEY AUTOINCREMENT,
          array_id              INTEGER NOT NULL REFERENCES pure_arrays(id) ON DELETE CASCADE,
          pure_alert_id         TEXT NOT NULL,
          severity              TEXT,
          category              TEXT,
          component_type        TEXT,
          component_name        TEXT,
          summary               TEXT,
          state                 TEXT,
          flagged               INTEGER NOT NULL DEFAULT 0,
          created_at_ms         INTEGER,
          updated_at_ms         INTEGER,
          captured_at           DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
        );

        CREATE TABLE IF NOT EXISTS pure_hosts (
          id                    INTEGER PRIMARY KEY AUTOINCREMENT,
          array_id              INTEGER NOT NULL REFERENCES pure_arrays(id) ON DELETE CASCADE,
          name                  TEXT,
          connection_count      INTEGER,
          personality           TEXT,
          protocol              TEXT,
          captured_at           DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
        );

        CREATE TABLE IF NOT EXISTS pure_volume_history (
          id                    INTEGER PRIMARY KEY AUTOINCREMENT,
          array_id              INTEGER NOT NULL REFERENCES pure_arrays(id) ON DELETE CASCADE,
          volume_name           TEXT NOT NULL,
          captured_at           DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
          provisioned_bytes     INTEGER,
          used_bytes            INTEGER,
          data_reduction        REAL,
          snapshots_bytes       INTEGER,
          read_iops             REAL,
          write_iops            REAL,
          read_latency_us       REAL,
          write_latency_us      REAL,
          read_bw_bytes         INTEGER,
          write_bw_bytes        INTEGER
        );
        CREATE INDEX IF NOT EXISTS idx_pure_vol_hist_array_time ON pure_volume_history(array_id, captured_at);
        CREATE INDEX IF NOT EXISTS idx_pure_vol_hist_name ON pure_volume_history(array_id, volume_name, captured_at);

        CREATE TABLE IF NOT EXISTS pure_array_connections (
          id                    INTEGER PRIMARY KEY AUTOINCREMENT,
          array_id              INTEGER NOT NULL REFERENCES pure_arrays(id) ON DELETE CASCADE,
          remote_name           TEXT,
          status                TEXT,
          type                  TEXT,
          version               TEXT,
          transport             TEXT,
          mgmt_address          TEXT,
          replication_addresses TEXT,
          captured_at           DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
        );

        CREATE TABLE IF NOT EXISTS pure_protection_groups (
          id                        INTEGER PRIMARY KEY AUTOINCREMENT,
          array_id                  INTEGER NOT NULL REFERENCES pure_arrays(id) ON DELETE CASCADE,
          name                      TEXT NOT NULL,
          source_name               TEXT,
          is_local                  INTEGER NOT NULL DEFAULT 1,
          volume_count              INTEGER,
          host_count                INTEGER,
          target_count              INTEGER,
          snapshot_enabled          INTEGER,
          snapshot_frequency_ms     INTEGER,
          replication_enabled       INTEGER,
          replication_frequency_ms  INTEGER,
          source_retention_days     INTEGER,
          target_retention_days     INTEGER,
          snapshots_bytes           INTEGER,
          destroyed                 INTEGER NOT NULL DEFAULT 0,
          captured_at               DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
        );

        CREATE TABLE IF NOT EXISTS pure_hardware (
          id                    INTEGER PRIMARY KEY AUTOINCREMENT,
          array_id              INTEGER NOT NULL REFERENCES pure_arrays(id) ON DELETE CASCADE,
          name                  TEXT,
          type                  TEXT,
          model                 TEXT,
          status                TEXT,
          serial                TEXT,
          slot                  INTEGER,
          speed                 INTEGER,
          temperature           REAL,
          voltage               REAL,
          captured_at           DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
        );

        CREATE TABLE IF NOT EXISTS pure_drives (
          id                    INTEGER PRIMARY KEY AUTOINCREMENT,
          array_id              INTEGER NOT NULL REFERENCES pure_arrays(id) ON DELETE CASCADE,
          name                  TEXT,
          type                  TEXT,
          protocol              TEXT,
          status                TEXT,
          capacity_bytes        INTEGER,
          captured_at           DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
        );

        CREATE TABLE IF NOT EXISTS pure_controllers (
          id                    INTEGER PRIMARY KEY AUTOINCREMENT,
          array_id              INTEGER NOT NULL REFERENCES pure_arrays(id) ON DELETE CASCADE,
          name                  TEXT,
          model                 TEXT,
          status                TEXT,
          mode                  TEXT,
          version               TEXT,
          captured_at           DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
        );

        CREATE TABLE IF NOT EXISTS pure_certificates (
          id                    INTEGER PRIMARY KEY AUTOINCREMENT,
          array_id              INTEGER NOT NULL REFERENCES pure_arrays(id) ON DELETE CASCADE,
          name                  TEXT,
          status                TEXT,
          common_name           TEXT,
          issued_to             TEXT,
          issued_by             TEXT,
          key_size              INTEGER,
          valid_from_ms         INTEGER,
          valid_to_ms           INTEGER,
          captured_at           DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
        );

        CREATE TABLE IF NOT EXISTS pure_network_interfaces (
          id                    INTEGER PRIMARY KEY AUTOINCREMENT,
          array_id              INTEGER NOT NULL REFERENCES pure_arrays(id) ON DELETE CASCADE,
          name                  TEXT,
          interface_type        TEXT,
          enabled               INTEGER,
          speed_bps             INTEGER,
          services              TEXT,
          address               TEXT,
          netmask               TEXT,
          gateway               TEXT,
          mac_address           TEXT,
          vlan                  INTEGER,
          wwn                   TEXT,
          captured_at           DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
        );

        CREATE TABLE IF NOT EXISTS pure_ports (
          id                    INTEGER PRIMARY KEY AUTOINCREMENT,
          array_id              INTEGER NOT NULL REFERENCES pure_arrays(id) ON DELETE CASCADE,
          name                  TEXT,
          wwn                   TEXT,
          iqn                   TEXT,
          nqn                   TEXT,
          captured_at           DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
        );

        CREATE TABLE IF NOT EXISTS pure_connections (
          id                    INTEGER PRIMARY KEY AUTOINCREMENT,
          array_id              INTEGER NOT NULL REFERENCES pure_arrays(id) ON DELETE CASCADE,
          host_name             TEXT,
          host_group_name       TEXT,
          volume_name           TEXT,
          lun                   INTEGER,
          captured_at           DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
        );

        CREATE TABLE IF NOT EXISTS pure_pods (
          id                    INTEGER PRIMARY KEY AUTOINCREMENT,
          array_id              INTEGER NOT NULL REFERENCES pure_arrays(id) ON DELETE CASCADE,
          name                  TEXT,
          promotion_status      TEXT,
          mediator              TEXT,
          array_count           INTEGER,
          link_source_count     INTEGER,
          link_target_count     INTEGER,
          member_arrays         TEXT,
          total_physical_bytes  INTEGER,
          data_reduction        REAL,
          captured_at           DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
        );
      `);
    },
  },

  // Migration: older Pure installs may predate the `auth_method` column on
  // pure_arrays. Additive + guarded.
  {
    version: 2,
    up(db) {
      try {
        db.exec("ALTER TABLE pure_arrays ADD COLUMN auth_method TEXT NOT NULL DEFAULT 'client'");
      } catch {
        // Column already exists (or table not present yet) — ignore.
      }
    },
  },

  // Migration: pure_network_interfaces gained netmask/gateway columns. Guarded.
  {
    version: 3,
    up(db) {
      try { db.exec('ALTER TABLE pure_network_interfaces ADD COLUMN netmask TEXT'); } catch { /* exists */ }
      try { db.exec('ALTER TABLE pure_network_interfaces ADD COLUMN gateway TEXT'); } catch { /* exists */ }
    },
  },

  // Migration: ensure the (array_id, pure_alert_id) uniqueness the alert
  // upsert (INSERT ... ON CONFLICT) depends on. Dedup any rows collected
  // before the index existed, then create it. Guarded so it runs at most
  // once and never crashes startup on a populated instance.
  {
    version: 4,
    up(db) {
      try {
        const hasAlertTable = db
          .prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'pure_alerts'")
          .get();
        const hasAlertIndex = db
          .prepare("SELECT 1 FROM sqlite_master WHERE type = 'index' AND name = 'idx_pure_alerts_unique'")
          .get();
        if (hasAlertTable && !hasAlertIndex) {
          db.exec(
            'DELETE FROM pure_alerts WHERE id NOT IN (SELECT MAX(id) FROM pure_alerts GROUP BY array_id, pure_alert_id)'
          );
          db.exec('CREATE UNIQUE INDEX IF NOT EXISTS idx_pure_alerts_unique ON pure_alerts(array_id, pure_alert_id)');
        }
      } catch (err) {
        console.error('[migration] pure_alerts unique index migration failed:', err.message);
      }
    },
  },

  // Migration: Pure1 SaaS fleet tables. Pure1 array ids are Pure1 UUIDs
  // (strings), not the INTEGER pure_arrays.id used by the direct-array path
  // above, hence a separate, parallel set of tables (poller-populated, no
  // per-source FKs — this is one account-wide fleet).
  {
    version: 5,
    up(db) {
      db.exec(`
        CREATE TABLE IF NOT EXISTS pure1_arrays (
          pure1_id              TEXT PRIMARY KEY,
          name                  TEXT NOT NULL,
          fqdn                  TEXT,
          model                 TEXT,
          os                    TEXT,
          version               TEXT,
          capacity_bytes        INTEGER,
          used_bytes            INTEGER,
          data_reduction        REAL,
          effective_used_bytes  INTEGER,
          volume_bytes          INTEGER,
          shared_bytes          INTEGER,
          snapshots_bytes       INTEGER,
          provisioned_bytes     INTEGER,
          health                TEXT,
          health_detail         TEXT,
          chassis_serial        TEXT,
          controller_serials    TEXT,
          tags                  TEXT,
          captured_at           DATETIME DEFAULT CURRENT_TIMESTAMP
        );

        CREATE TABLE IF NOT EXISTS pure1_alerts (
          id                    INTEGER PRIMARY KEY AUTOINCREMENT,
          pure1_alert_id        TEXT UNIQUE,
          array_name            TEXT,
          array_fqdn            TEXT,
          severity              TEXT,
          category              TEXT,
          component_type        TEXT,
          component_name        TEXT,
          summary               TEXT,
          code                  INTEGER,
          state                 TEXT,
          flagged               INTEGER NOT NULL DEFAULT 0,
          created_at_ms         INTEGER,
          updated_at_ms         INTEGER,
          knowledge_base_url    TEXT,
          captured_at           DATETIME DEFAULT CURRENT_TIMESTAMP
        );

        CREATE TABLE IF NOT EXISTS pure1_pods (
          id                    INTEGER PRIMARY KEY AUTOINCREMENT,
          pure1_pod_id          TEXT,
          name                  TEXT,
          mediator              TEXT,
          arrays                TEXT,
          captured_at           DATETIME DEFAULT CURRENT_TIMESTAMP
        );

        CREATE TABLE IF NOT EXISTS pure1_metrics_history (
          id                    INTEGER PRIMARY KEY AUTOINCREMENT,
          captured_at           DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
          array_count           INTEGER,
          arrays_warn           INTEGER,
          arrays_crit           INTEGER,
          total_capacity_bytes  INTEGER,
          total_used_bytes      INTEGER,
          open_alerts           INTEGER
        );
        CREATE INDEX IF NOT EXISTS idx_pure1_metrics_captured ON pure1_metrics_history(captured_at);
      `);
    },
  },

  // Migration: cached AI Advisor report content, one row per report key.
  {
    version: 6,
    up(db) {
      db.exec(`
        CREATE TABLE IF NOT EXISTS pure_ai_reports (
          report_key    TEXT PRIMARY KEY,
          model         TEXT,
          content       TEXT NOT NULL,
          generated_at  DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
        );
      `);
    },
  },

  // Migration: latest Pure1 per-array performance snapshot (fed by
  // fetchLatestPerformance each poll) so the performance advisor works in
  // Pure1-SaaS-only deployments where the direct-array history tables stay empty.
  {
    version: 7,
    up(db) {
      db.exec(`
        ALTER TABLE pure1_arrays ADD COLUMN read_iops REAL;
        ALTER TABLE pure1_arrays ADD COLUMN write_iops REAL;
        ALTER TABLE pure1_arrays ADD COLUMN read_latency_us REAL;
        ALTER TABLE pure1_arrays ADD COLUMN write_latency_us REAL;
        ALTER TABLE pure1_arrays ADD COLUMN read_bw_bytes REAL;
        ALTER TABLE pure1_arrays ADD COLUMN write_bw_bytes REAL;
        ALTER TABLE pure1_arrays ADD COLUMN perf_captured_at TEXT;
      `);
    },
  },
];
