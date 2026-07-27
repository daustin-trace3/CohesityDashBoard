// NetApp ONTAP scope: netapp_* tables + the one inline migration that used to
// live directly in db/database.js (4 AIQUM discovery columns on netapp_arrays).
module.exports = [
  {
    version: 1,
    up(db) {
      db.exec(`
        CREATE TABLE IF NOT EXISTS netapp_arrays (
          id                       INTEGER PRIMARY KEY AUTOINCREMENT,
          name                     TEXT NOT NULL UNIQUE,
          mgmt_host                TEXT NOT NULL,
          username                 TEXT NOT NULL,
          encrypted_credentials    TEXT NOT NULL,
          polling_interval_minutes INTEGER NOT NULL DEFAULT 15,
          ssl_verify               INTEGER NOT NULL DEFAULT 0,
          cluster_uuid             TEXT,
          management_ip            TEXT,
          version                  TEXT,
          source                   TEXT NOT NULL DEFAULT 'direct',
          created_at               DATETIME DEFAULT CURRENT_TIMESTAMP,
          updated_at               DATETIME DEFAULT CURRENT_TIMESTAMP
        );

        CREATE TABLE IF NOT EXISTS netapp_metrics_history (
          id                    INTEGER PRIMARY KEY AUTOINCREMENT,
          array_id              INTEGER NOT NULL REFERENCES netapp_arrays(id) ON DELETE CASCADE,
          captured_at           DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
          total_bytes           INTEGER,
          used_bytes            INTEGER,
          available_bytes       INTEGER,
          physical_used_bytes   INTEGER,
          logical_used_bytes    INTEGER,
          efficiency_ratio      REAL,
          volume_count          INTEGER,
          aggregate_count       INTEGER,
          read_iops             REAL,
          write_iops            REAL,
          read_throughput_bytes INTEGER,
          write_throughput_bytes INTEGER,
          read_latency_us       REAL,
          write_latency_us      REAL,
          ontap_version         TEXT
        );
        CREATE INDEX IF NOT EXISTS idx_netapp_metrics_array_time ON netapp_metrics_history(array_id, captured_at);

        CREATE TABLE IF NOT EXISTS netapp_aggregates (
          id                    INTEGER PRIMARY KEY AUTOINCREMENT,
          array_id              INTEGER NOT NULL REFERENCES netapp_arrays(id) ON DELETE CASCADE,
          uuid                  TEXT,
          name                  TEXT,
          node_name             TEXT,
          state                 TEXT,
          size_bytes            INTEGER,
          used_bytes            INTEGER,
          available_bytes       INTEGER,
          used_percent          REAL,
          physical_used_bytes   INTEGER,
          efficiency_ratio      REAL,
          captured_at           DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
        );

        CREATE TABLE IF NOT EXISTS netapp_volumes (
          id                    INTEGER PRIMARY KEY AUTOINCREMENT,
          array_id              INTEGER NOT NULL REFERENCES netapp_arrays(id) ON DELETE CASCADE,
          uuid                  TEXT,
          name                  TEXT,
          svm_name              TEXT,
          aggregate_name        TEXT,
          state                 TEXT,
          size_bytes            INTEGER,
          used_bytes            INTEGER,
          available_bytes       INTEGER,
          used_percent          REAL,
          physical_used_bytes   INTEGER,
          captured_at           DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
        );

        CREATE TABLE IF NOT EXISTS netapp_svms (
          id                    INTEGER PRIMARY KEY AUTOINCREMENT,
          array_id              INTEGER NOT NULL REFERENCES netapp_arrays(id) ON DELETE CASCADE,
          uuid                  TEXT,
          name                  TEXT,
          state                 TEXT,
          captured_at           DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
        );

        CREATE TABLE IF NOT EXISTS netapp_nodes (
          id                    INTEGER PRIMARY KEY AUTOINCREMENT,
          array_id              INTEGER NOT NULL REFERENCES netapp_arrays(id) ON DELETE CASCADE,
          uuid                  TEXT,
          name                  TEXT,
          model                 TEXT,
          serial_number         TEXT,
          state                 TEXT,
          version               TEXT,
          captured_at           DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
        );

        CREATE TABLE IF NOT EXISTS netapp_disks (
          id                    INTEGER PRIMARY KEY AUTOINCREMENT,
          array_id              INTEGER NOT NULL REFERENCES netapp_arrays(id) ON DELETE CASCADE,
          name                  TEXT,
          model                 TEXT,
          vendor                TEXT,
          type                  TEXT,
          state                 TEXT,
          size_bytes            INTEGER,
          captured_at           DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
        );

        CREATE TABLE IF NOT EXISTS netapp_alerts (
          id                    INTEGER PRIMARY KEY AUTOINCREMENT,
          array_id              INTEGER NOT NULL REFERENCES netapp_arrays(id) ON DELETE CASCADE,
          alert_key             TEXT,
          severity              TEXT,
          node_name             TEXT,
          source                TEXT,
          message               TEXT,
          captured_at           DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
        );

        CREATE TABLE IF NOT EXISTS netapp_snapmirror (
          id                    INTEGER PRIMARY KEY AUTOINCREMENT,
          array_id              INTEGER NOT NULL REFERENCES netapp_arrays(id) ON DELETE CASCADE,
          uuid                  TEXT,
          source_path           TEXT,
          source_cluster        TEXT,
          destination_path      TEXT,
          destination_cluster   TEXT,
          state                 TEXT,
          healthy               INTEGER,
          lag_seconds           INTEGER,
          transfer_state        TEXT,
          last_transfer_bytes   INTEGER,
          last_transfer_end     TEXT,
          captured_at           DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
        );

        CREATE TABLE IF NOT EXISTS netapp_lifs (
          id                    INTEGER PRIMARY KEY AUTOINCREMENT,
          array_id              INTEGER NOT NULL REFERENCES netapp_arrays(id) ON DELETE CASCADE,
          uuid                  TEXT,
          name                  TEXT,
          svm_name              TEXT,
          address               TEXT,
          netmask               TEXT,
          enabled               INTEGER,
          state                 TEXT,
          services              TEXT,
          node_name             TEXT,
          port_name             TEXT,
          is_home               INTEGER,
          failover              TEXT,
          captured_at           DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
        );

        CREATE TABLE IF NOT EXISTS netapp_quotas (
          id                    INTEGER PRIMARY KEY AUTOINCREMENT,
          array_id              INTEGER NOT NULL REFERENCES netapp_arrays(id) ON DELETE CASCADE,
          svm_name              TEXT,
          volume_name           TEXT,
          qtree_name            TEXT,
          type                  TEXT,
          space_used_bytes      INTEGER,
          space_hard_limit_bytes INTEGER,
          files_used            INTEGER,
          captured_at           DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
        );

        CREATE TABLE IF NOT EXISTS netapp_nfs_clients (
          id                    INTEGER PRIMARY KEY AUTOINCREMENT,
          array_id              INTEGER NOT NULL REFERENCES netapp_arrays(id) ON DELETE CASCADE,
          client_ip             TEXT,
          server_ip             TEXT,
          svm_name              TEXT,
          node_name             TEXT,
          volume_name           TEXT,
          protocol              TEXT,
          captured_at           DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
        );

        CREATE TABLE IF NOT EXISTS netapp_export_rules (
          id                    INTEGER PRIMARY KEY AUTOINCREMENT,
          array_id              INTEGER NOT NULL REFERENCES netapp_arrays(id) ON DELETE CASCADE,
          policy_name           TEXT,
          svm_name              TEXT,
          rule_index            INTEGER,
          clients               TEXT,
          protocols             TEXT,
          ro_rule               TEXT,
          rw_rule               TEXT,
          superuser             TEXT,
          captured_at           DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
        );

        CREATE TABLE IF NOT EXISTS netapp_cifs_sessions (
          id                    INTEGER PRIMARY KEY AUTOINCREMENT,
          array_id              INTEGER NOT NULL REFERENCES netapp_arrays(id) ON DELETE CASCADE,
          client_ip             TEXT,
          server_ip             TEXT,
          svm_name              TEXT,
          node_name             TEXT,
          volume_name           TEXT,
          smb_user              TEXT,
          mapped_unix_user      TEXT,
          protocol              TEXT,
          authentication        TEXT,
          smb_encryption        TEXT,
          smb_signing           INTEGER,
          open_shares           INTEGER,
          open_files            INTEGER,
          connected_duration    TEXT,
          idle_duration         TEXT,
          captured_at           DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
        );

        CREATE TABLE IF NOT EXISTS netapp_cifs_shares (
          id                    INTEGER PRIMARY KEY AUTOINCREMENT,
          array_id              INTEGER NOT NULL REFERENCES netapp_arrays(id) ON DELETE CASCADE,
          share_name            TEXT,
          path                  TEXT,
          svm_name              TEXT,
          volume_name           TEXT,
          captured_at           DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
        );
      `);
    },
  },

  // Migration: netapp_arrays gained AIQUM discovery columns. Guarded.
  {
    version: 2,
    up(db) {
      try { db.exec('ALTER TABLE netapp_arrays ADD COLUMN cluster_uuid TEXT'); } catch { /* exists */ }
      try { db.exec('ALTER TABLE netapp_arrays ADD COLUMN management_ip TEXT'); } catch { /* exists */ }
      try { db.exec('ALTER TABLE netapp_arrays ADD COLUMN version TEXT'); } catch { /* exists */ }
      try { db.exec("ALTER TABLE netapp_arrays ADD COLUMN source TEXT NOT NULL DEFAULT 'direct'"); } catch { /* exists */ }
    },
  },

  // Migration: cached AI Advisor report content, one row per report key.
  {
    version: 3,
    up(db) {
      db.exec(`
        CREATE TABLE IF NOT EXISTS netapp_ai_reports (
          report_key    TEXT PRIMARY KEY,
          model         TEXT,
          content       TEXT NOT NULL,
          generated_at  DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
        );
      `);
    },
  },
  {
    version: 4,
    up(db) {
      // Extended volume detail (identity/NAS/capacity depth/protection/ops).
      // All nullable — availability varies by ONTAP version and the fetcher
      // falls back to the basic field list on older clusters.
      db.exec(`
        ALTER TABLE netapp_volumes ADD COLUMN type TEXT;
        ALTER TABLE netapp_volumes ADD COLUMN style TEXT;
        ALTER TABLE netapp_volumes ADD COLUMN comment TEXT;
        ALTER TABLE netapp_volumes ADD COLUMN create_time TEXT;
        ALTER TABLE netapp_volumes ADD COLUMN is_svm_root INTEGER;
        ALTER TABLE netapp_volumes ADD COLUMN junction_path TEXT;
        ALTER TABLE netapp_volumes ADD COLUMN security_style TEXT;
        ALTER TABLE netapp_volumes ADD COLUMN export_policy TEXT;
        ALTER TABLE netapp_volumes ADD COLUMN snapshot_policy TEXT;
        ALTER TABLE netapp_volumes ADD COLUMN guarantee_type TEXT;
        ALTER TABLE netapp_volumes ADD COLUMN autosize_mode TEXT;
        ALTER TABLE netapp_volumes ADD COLUMN autosize_max_bytes INTEGER;
        ALTER TABLE netapp_volumes ADD COLUMN files_used INTEGER;
        ALTER TABLE netapp_volumes ADD COLUMN files_maximum INTEGER;
        ALTER TABLE netapp_volumes ADD COLUMN snapshot_used_bytes INTEGER;
        ALTER TABLE netapp_volumes ADD COLUMN snapshot_reserve_percent REAL;
        ALTER TABLE netapp_volumes ADD COLUMN logical_used_bytes INTEGER;
        ALTER TABLE netapp_volumes ADD COLUMN snaplock_type TEXT;
        ALTER TABLE netapp_volumes ADD COLUMN encryption_enabled INTEGER;
        ALTER TABLE netapp_volumes ADD COLUMN anti_ransomware_state TEXT;
        ALTER TABLE netapp_volumes ADD COLUMN qos_policy TEXT;
        ALTER TABLE netapp_volumes ADD COLUMN tiering_policy TEXT;
        ALTER TABLE netapp_volumes ADD COLUMN quota_state TEXT;
        ALTER TABLE netapp_volumes ADD COLUMN is_inconsistent INTEGER;
        ALTER TABLE netapp_volumes ADD COLUMN metric_iops REAL;
        ALTER TABLE netapp_volumes ADD COLUMN metric_throughput_bps REAL;
        ALTER TABLE netapp_volumes ADD COLUMN metric_latency_us REAL;
      `);
    },
  },
];
