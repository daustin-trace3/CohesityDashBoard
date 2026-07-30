// NetBackup scope: netbackup_* tables. Direct-connection model like vCenter —
// each primary server or Alta SaaS tenant is registered as a source with
// AES-encrypted credentials. Inventory tables (policies, storage units, disk
// pools, media servers, appliances, alerts) are replaced per source each
// poll; jobs are upserted (kept 30 days) and netbackup_metrics_history
// accumulates per-source snapshots for trends.
module.exports = [
  {
    version: 1,
    up(db) {
      db.exec(`
        CREATE TABLE IF NOT EXISTS netbackup_sources (
          id                       INTEGER PRIMARY KEY AUTOINCREMENT,
          name                     TEXT NOT NULL UNIQUE,
          source_type              TEXT NOT NULL DEFAULT 'primary',
          host                     TEXT NOT NULL,
          port                     INTEGER NOT NULL DEFAULT 1556,
          auth_mode                TEXT NOT NULL DEFAULT 'password',
          username                 TEXT,
          domain_name              TEXT,
          domain_type              TEXT,
          encrypted_credentials    TEXT NOT NULL,
          ssl_verify               INTEGER NOT NULL DEFAULT 0,
          polling_interval_minutes INTEGER NOT NULL DEFAULT 15,
          last_poll_status         TEXT,
          last_poll_error          TEXT,
          last_poll_at             DATETIME,
          created_at               DATETIME DEFAULT CURRENT_TIMESTAMP,
          updated_at               DATETIME DEFAULT CURRENT_TIMESTAMP
        );

        CREATE TABLE IF NOT EXISTS netbackup_jobs (
          id               INTEGER PRIMARY KEY AUTOINCREMENT,
          source_id        INTEGER NOT NULL REFERENCES netbackup_sources(id) ON DELETE CASCADE,
          job_id           INTEGER NOT NULL,
          parent_job_id    INTEGER,
          job_type         TEXT,
          state            TEXT,
          status_code      INTEGER,
          policy_name      TEXT,
          policy_type      TEXT,
          client_name      TEXT,
          schedule_type    TEXT,
          storage_unit     TEXT,
          kilobytes        INTEGER,
          files_count      INTEGER,
          elapsed_seconds  INTEGER,
          throughput_kbps  INTEGER,
          started_at       DATETIME,
          ended_at         DATETIME,
          captured_at      DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
          UNIQUE(source_id, job_id)
        );
        CREATE INDEX IF NOT EXISTS idx_netbackup_jobs_source ON netbackup_jobs(source_id);
        CREATE INDEX IF NOT EXISTS idx_netbackup_jobs_started ON netbackup_jobs(started_at);

        CREATE TABLE IF NOT EXISTS netbackup_policies (
          id               INTEGER PRIMARY KEY AUTOINCREMENT,
          source_id        INTEGER NOT NULL REFERENCES netbackup_sources(id) ON DELETE CASCADE,
          name             TEXT NOT NULL,
          policy_type      TEXT,
          active           INTEGER NOT NULL DEFAULT 1,
          client_count     INTEGER,
          schedule_count   INTEGER,
          selection_count  INTEGER,
          captured_at      DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
        );
        CREATE INDEX IF NOT EXISTS idx_netbackup_policies_source ON netbackup_policies(source_id);

        CREATE TABLE IF NOT EXISTS netbackup_storage_units (
          id                   INTEGER PRIMARY KEY AUTOINCREMENT,
          source_id            INTEGER NOT NULL REFERENCES netbackup_sources(id) ON DELETE CASCADE,
          name                 TEXT,
          storage_unit_type    TEXT,
          disk_pool            TEXT,
          media_server         TEXT,
          max_concurrent_jobs  INTEGER,
          capacity_bytes       INTEGER,
          free_bytes           INTEGER,
          used_bytes           INTEGER,
          captured_at          DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
        );
        CREATE INDEX IF NOT EXISTS idx_netbackup_storage_units_source ON netbackup_storage_units(source_id);

        CREATE TABLE IF NOT EXISTS netbackup_disk_pools (
          id                        INTEGER PRIMARY KEY AUTOINCREMENT,
          source_id                 INTEGER NOT NULL REFERENCES netbackup_sources(id) ON DELETE CASCADE,
          name                      TEXT,
          server_type               TEXT,
          status                    TEXT,
          total_capacity_bytes      INTEGER,
          used_capacity_bytes       INTEGER,
          available_capacity_bytes  INTEGER,
          volume_count              INTEGER,
          captured_at               DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
        );
        CREATE INDEX IF NOT EXISTS idx_netbackup_disk_pools_source ON netbackup_disk_pools(source_id);

        CREATE TABLE IF NOT EXISTS netbackup_media_servers (
          id           INTEGER PRIMARY KEY AUTOINCREMENT,
          source_id    INTEGER NOT NULL REFERENCES netbackup_sources(id) ON DELETE CASCADE,
          name         TEXT,
          state        TEXT,
          version      TEXT,
          captured_at  DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
        );
        CREATE INDEX IF NOT EXISTS idx_netbackup_media_servers_source ON netbackup_media_servers(source_id);

        CREATE TABLE IF NOT EXISTS netbackup_appliances (
          id                INTEGER PRIMARY KEY AUTOINCREMENT,
          source_id         INTEGER NOT NULL REFERENCES netbackup_sources(id) ON DELETE CASCADE,
          name              TEXT,
          host_type         TEXT,
          appliance_type    TEXT NOT NULL DEFAULT 'byo',
          model             TEXT,
          serial_number     TEXT,
          os_type           TEXT,
          os_version        TEXT,
          cpu_architecture  TEXT,
          nbu_version       TEXT,
          raw_json          TEXT,
          captured_at       DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
        );
        CREATE INDEX IF NOT EXISTS idx_netbackup_appliances_source ON netbackup_appliances(source_id);

        CREATE TABLE IF NOT EXISTS netbackup_alerts (
          id           INTEGER PRIMARY KEY AUTOINCREMENT,
          source_id    INTEGER NOT NULL REFERENCES netbackup_sources(id) ON DELETE CASCADE,
          alert_id     TEXT NOT NULL,
          severity     TEXT,
          category     TEXT,
          message      TEXT,
          occurred_at  DATETIME,
          captured_at  DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
          UNIQUE(source_id, alert_id)
        );
        CREATE INDEX IF NOT EXISTS idx_netbackup_alerts_source ON netbackup_alerts(source_id);

        -- source_id is intentionally nullable: the stale-backup issue rule can
        -- roll a long tail of per-client issues into one estate-wide summary
        -- row that isn't scoped to a single source.
        CREATE TABLE IF NOT EXISTS netbackup_issue_history (
          id           INTEGER PRIMARY KEY AUTOINCREMENT,
          source_id    INTEGER REFERENCES netbackup_sources(id) ON DELETE CASCADE,
          issue_key    TEXT NOT NULL,
          source       TEXT,
          type         TEXT,
          target       TEXT,
          severity     TEXT NOT NULL,
          message      TEXT NOT NULL,
          status       TEXT NOT NULL DEFAULT 'open',
          first_seen   DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
          last_seen    DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
          resolved_at  DATETIME,
          UNIQUE(source_id, issue_key)
        );
        CREATE INDEX IF NOT EXISTS idx_netbackup_issue_hist_key ON netbackup_issue_history(issue_key, status);
        CREATE INDEX IF NOT EXISTS idx_netbackup_issue_hist_source ON netbackup_issue_history(source_id);

        CREATE TABLE IF NOT EXISTS netbackup_metrics_history (
          id                       INTEGER PRIMARY KEY AUTOINCREMENT,
          source_id                INTEGER NOT NULL REFERENCES netbackup_sources(id) ON DELETE CASCADE,
          captured_at              DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
          jobs_24h                 INTEGER,
          failed_jobs_24h          INTEGER,
          success_rate             REAL,
          active_policies          INTEGER,
          protected_clients        INTEGER,
          storage_capacity_bytes   INTEGER,
          storage_used_bytes       INTEGER,
          media_server_count       INTEGER,
          appliance_count          INTEGER
        );
        CREATE INDEX IF NOT EXISTS idx_netbackup_metrics_source ON netbackup_metrics_history(source_id, captured_at);
      `);
    },
  },
  {
    version: 2,
    up(db) {
      db.exec(`
        CREATE TABLE IF NOT EXISTS netbackup_slps (
          id                  INTEGER PRIMARY KEY AUTOINCREMENT,
          source_id           INTEGER NOT NULL REFERENCES netbackup_sources(id) ON DELETE CASCADE,
          name                TEXT NOT NULL,
          version             INTEGER,
          data_classification TEXT,
          priority            INTEGER,
          operation_count     INTEGER,
          operations_json     TEXT,
          captured_at         DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
        );
        CREATE INDEX IF NOT EXISTS idx_netbackup_slps_source ON netbackup_slps(source_id);

        CREATE TABLE IF NOT EXISTS netbackup_workload_history (
          id                 INTEGER PRIMARY KEY AUTOINCREMENT,
          source_id          INTEGER NOT NULL REFERENCES netbackup_sources(id) ON DELETE CASCADE,
          workload           TEXT NOT NULL,
          protected_clients  INTEGER,
          job_count          INTEGER,
          success_count      INTEGER,
          failed_count       INTEGER,
          protected_bytes    INTEGER,
          captured_at        DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
        );
        CREATE INDEX IF NOT EXISTS idx_netbackup_workload_hist_lookup ON netbackup_workload_history(source_id, workload, captured_at);
        CREATE INDEX IF NOT EXISTS idx_netbackup_workload_hist_captured ON netbackup_workload_history(captured_at);

        CREATE TABLE IF NOT EXISTS netbackup_ai_reports (
          report_key   TEXT PRIMARY KEY,
          model        TEXT,
          content      TEXT NOT NULL,
          generated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
        );
      `);
    },
  },
  {
    version: 3,
    up(db) {
      db.exec(`
        CREATE TABLE IF NOT EXISTS netbackup_appliance_overrides (
          id             INTEGER PRIMARY KEY AUTOINCREMENT,
          source_id      INTEGER NOT NULL REFERENCES netbackup_sources(id) ON DELETE CASCADE,
          name           TEXT NOT NULL,
          model_override TEXT,
          updated_at     DATETIME DEFAULT CURRENT_TIMESTAMP,
          UNIQUE(source_id, name)
        );
        CREATE INDEX IF NOT EXISTS idx_netbackup_appliance_overrides_source ON netbackup_appliance_overrides(source_id);
      `);
    },
  },
  {
    version: 4,
    up(db) {
      const cols = db.prepare('PRAGMA table_info(netbackup_policies)').all().map((c) => c.name);
      if (!cols.includes('detail_json')) {
        db.exec('ALTER TABLE netbackup_policies ADD COLUMN detail_json TEXT');
      }
    },
  },
];
