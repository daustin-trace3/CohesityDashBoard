// Cohesity scope: cluster tables + the three inline migrations that used to
// live directly in db/database.js (clusters.tags, llm_insights mode column,
// replication_runs dedup+unique index). Steps are translated verbatim from
// db/schema.sql and the pre-refactor db/database.js so a fresh DB and an
// existing populated DB both converge on the identical final schema.
module.exports = [
  {
    version: 1,
    up(db) {
      db.exec(`
        CREATE TABLE IF NOT EXISTS clusters (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          name TEXT NOT NULL UNIQUE,
          connection_type TEXT NOT NULL CHECK(connection_type IN ('helios', 'direct')),
          vip TEXT,
          auth_type TEXT NOT NULL CHECK(auth_type IN ('userpass', 'apikey')),
          encrypted_credentials TEXT NOT NULL,
          polling_interval_minutes INTEGER NOT NULL DEFAULT 15,
          ssl_verify INTEGER NOT NULL DEFAULT 0,
          created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
          updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
        );

        CREATE TABLE IF NOT EXISTS metrics_history (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          cluster_id INTEGER NOT NULL REFERENCES clusters(id) ON DELETE CASCADE,
          captured_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
          total_capacity_bytes INTEGER,
          used_bytes INTEGER,
          logical_bytes INTEGER,
          data_reduction_ratio REAL,
          software_version TEXT,
          node_count INTEGER
        );

        CREATE TABLE IF NOT EXISTS alerts (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          cluster_id INTEGER NOT NULL REFERENCES clusters(id) ON DELETE CASCADE,
          cohesity_alert_id TEXT NOT NULL,
          severity TEXT NOT NULL,
          alert_type TEXT,
          description TEXT,
          resolved INTEGER NOT NULL DEFAULT 0,
          dismissed INTEGER NOT NULL DEFAULT 0,
          first_seen DATETIME NOT NULL,
          last_updated DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
        );

        CREATE UNIQUE INDEX IF NOT EXISTS idx_alerts_unique ON alerts(cluster_id, cohesity_alert_id);
        CREATE INDEX IF NOT EXISTS idx_metrics_cluster_time ON metrics_history(cluster_id, captured_at);

        CREATE TABLE IF NOT EXISTS alert_ai_reviews (
          alert_id      INTEGER PRIMARY KEY REFERENCES alerts(id) ON DELETE CASCADE,
          content_hash  TEXT NOT NULL,
          summary       TEXT,
          root_cause    TEXT,
          actions_json  TEXT,
          confidence    TEXT,
          model         TEXT,
          created_at    DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
        );

        CREATE TABLE IF NOT EXISTS protection_runs (
          id                    INTEGER PRIMARY KEY AUTOINCREMENT,
          cluster_id            INTEGER NOT NULL REFERENCES clusters(id) ON DELETE CASCADE,
          job_id                INTEGER,
          job_name              TEXT,
          run_type              TEXT,
          status                TEXT NOT NULL,
          start_time            DATETIME,
          end_time              DATETIME,
          error_code            TEXT,
          error_message         TEXT,
          logical_bytes         INTEGER,
          captured_at           DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
        );
        CREATE INDEX IF NOT EXISTS idx_prot_runs_cluster_time ON protection_runs(cluster_id, start_time);
        CREATE UNIQUE INDEX IF NOT EXISTS idx_prot_runs_unique ON protection_runs(cluster_id, job_id, start_time);

        CREATE TABLE IF NOT EXISTS replication_runs (
          id                    INTEGER PRIMARY KEY AUTOINCREMENT,
          protection_run_id     INTEGER NOT NULL REFERENCES protection_runs(id) ON DELETE CASCADE,
          cluster_id            INTEGER NOT NULL REFERENCES clusters(id) ON DELETE CASCADE,
          target_cluster_name   TEXT,
          target_cluster_id     INTEGER,
          status                TEXT,
          logical_bytes         INTEGER,
          start_time            DATETIME,
          end_time              DATETIME,
          lag_seconds           INTEGER,
          captured_at           DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
        );
        CREATE INDEX IF NOT EXISTS idx_repl_runs_cluster_time ON replication_runs(cluster_id, start_time);

        CREATE TABLE IF NOT EXISTS policies (
          id                    INTEGER PRIMARY KEY AUTOINCREMENT,
          cluster_id            INTEGER NOT NULL REFERENCES clusters(id) ON DELETE CASCADE,
          policy_id             TEXT,
          name                  TEXT,
          retention_days        INTEGER,
          replication_targets   TEXT,
          archival_targets      TEXT,
          datalock              INTEGER NOT NULL DEFAULT 0,
          captured_at           DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
        );
        CREATE INDEX IF NOT EXISTS idx_policies_cluster ON policies(cluster_id);

        CREATE TABLE IF NOT EXISTS source_registrations (
          id                    INTEGER PRIMARY KEY AUTOINCREMENT,
          cluster_id            INTEGER NOT NULL REFERENCES clusters(id) ON DELETE CASCADE,
          source_id             INTEGER,
          source_name           TEXT,
          environment           TEXT,
          protected_count       INTEGER,
          unprotected_count     INTEGER,
          protected_bytes       INTEGER,
          unprotected_bytes     INTEGER,
          captured_at           DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
        );
        CREATE INDEX IF NOT EXISTS idx_source_reg_cluster ON source_registrations(cluster_id);

        CREATE TABLE IF NOT EXISTS replication_status_cache (
          cache_key             TEXT PRIMARY KEY,
          cluster_name          TEXT NOT NULL,
          status_filter         TEXT NOT NULL,
          days                  INTEGER NOT NULL,
          num_runs_per_group    INTEGER NOT NULL,
          payload_json          TEXT NOT NULL,
          scanning              INTEGER NOT NULL DEFAULT 0,
          error                 TEXT,
          updated_at            DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
        );
        CREATE INDEX IF NOT EXISTS idx_repl_cache_cluster_filter ON replication_status_cache(cluster_name, status_filter);

        CREATE TABLE IF NOT EXISTS snapshot_cache (
          cache_key             TEXT PRIMARY KEY,
          payload_json          TEXT NOT NULL,
          updated_at            DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
        );

        CREATE TABLE IF NOT EXISTS llm_insights (
          cluster_id            INTEGER NOT NULL REFERENCES clusters(id) ON DELETE CASCADE,
          mode                  TEXT NOT NULL DEFAULT 'system',
          model                 TEXT,
          analysis              TEXT NOT NULL,
          generated_at          DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
          PRIMARY KEY (cluster_id, mode)
        );

        CREATE TABLE IF NOT EXISTS ai_reports (
          report_key            TEXT PRIMARY KEY,
          model                 TEXT,
          content               TEXT NOT NULL,
          generated_at          DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
        );

        CREATE TABLE IF NOT EXISTS license_usage (
          id                    INTEGER PRIMARY KEY AUTOINCREMENT,
          system_id             TEXT,
          system_name           TEXT,
          front_end_bytes       INTEGER,
          physical_bytes        INTEGER,
          capacity_bytes        INTEGER,
          usage_percent         REAL,
          data_reduction        REAL,
          captured_at           DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
        );

        CREATE TABLE IF NOT EXISTS license_type_usage (
          license_type          TEXT PRIMARY KEY,
          front_end_bytes       INTEGER NOT NULL DEFAULT 0,
          captured_at           DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
        );

        CREATE TABLE IF NOT EXISTS license_meter_usage (
          id                    INTEGER PRIMARY KEY AUTOINCREMENT,
          system_id             TEXT,
          system_name           TEXT,
          feature               TEXT NOT NULL,
          usage_gib             REAL NOT NULL DEFAULT 0,
          captured_at           DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
        );

        CREATE TABLE IF NOT EXISTS license_view_detail (
          id                    INTEGER PRIMARY KEY AUTOINCREMENT,
          system_id             TEXT,
          system_name           TEXT,
          view_name             TEXT NOT NULL,
          is_read_only          INTEGER NOT NULL DEFAULT 0,
          created_ms            INTEGER,
          physical_bytes        INTEGER,
          logical_bytes         INTEGER,
          data_written_bytes    INTEGER,
          captured_at           DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
        );
        CREATE INDEX IF NOT EXISTS idx_view_detail_system ON license_view_detail(system_id);

        CREATE TABLE IF NOT EXISTS consumption_breakdown (
          id                    INTEGER PRIMARY KEY AUTOINCREMENT,
          system_id             TEXT,
          system_name           TEXT,
          category              TEXT NOT NULL,
          consumers             INTEGER,
          physical_bytes        INTEGER,
          logical_bytes         INTEGER,
          captured_at           DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
        );
      `);
    },
  },

  // Migration: add tags column if not present.
  {
    version: 2,
    up(db) {
      try {
        db.exec("ALTER TABLE clusters ADD COLUMN tags TEXT NOT NULL DEFAULT ''");
      } catch {
        // Column already exists — ignore.
      }
    },
  },

  // Migration: llm_insights gained a `mode` column + composite primary key.
  // The cached LLM text is disposable, so an older single-mode table is just
  // dropped and recreated by the schema above.
  {
    version: 3,
    up(db) {
      try {
        const hasMode = db.prepare("PRAGMA table_info(llm_insights)").all().some(c => c.name === 'mode');
        if (!hasMode) {
          db.exec('DROP TABLE IF EXISTS llm_insights');
          db.exec(`
            CREATE TABLE llm_insights (
              cluster_id   INTEGER NOT NULL REFERENCES clusters(id) ON DELETE CASCADE,
              mode         TEXT NOT NULL DEFAULT 'system',
              model        TEXT,
              analysis     TEXT NOT NULL,
              generated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
              PRIMARY KEY (cluster_id, mode)
            )
          `);
        }
      } catch {
        // Table does not exist yet — schema above will create the current shape.
      }
    },
  },

  // Migration: replication_runs had no unique constraint, so every poll cycle
  // re-inserted the same copy runs. Rebuild the table keeping the newest row
  // per copy run, then enforce uniqueness. Runs once; gated on the index name.
  // Contains VACUUM + a PRAGMA foreign_keys toggle, neither of which is legal
  // inside a transaction, so this step opts out of the runner's transaction.
  {
    version: 4,
    noTransaction: true,
    up(db) {
      const hasReplUniqueIndex = db
        .prepare("SELECT 1 FROM sqlite_master WHERE type = 'index' AND name = 'idx_repl_runs_unique'")
        .get();
      if (hasReplUniqueIndex) return;

      const started = Date.now();
      const before = db.prepare('SELECT COUNT(*) c FROM replication_runs').get().c;
      console.log(`[migration] Deduplicating replication_runs (${before} rows) — this runs once and may take a minute…`);

      db.exec('PRAGMA foreign_keys = OFF');
      db.transaction(() => {
        db.exec(`
          CREATE TABLE replication_runs_dedup (
            id                    INTEGER PRIMARY KEY AUTOINCREMENT,
            protection_run_id     INTEGER NOT NULL REFERENCES protection_runs(id) ON DELETE CASCADE,
            cluster_id            INTEGER NOT NULL REFERENCES clusters(id) ON DELETE CASCADE,
            target_cluster_name   TEXT,
            target_cluster_id     INTEGER,
            status                TEXT,
            logical_bytes         INTEGER,
            start_time            DATETIME,
            end_time              DATETIME,
            lag_seconds           INTEGER,
            captured_at           DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
          )
        `);
        db.exec(`
          INSERT INTO replication_runs_dedup
          SELECT * FROM replication_runs
          WHERE id IN (
            SELECT MAX(id) FROM replication_runs
            GROUP BY protection_run_id,
                     IFNULL(target_cluster_id, -1),
                     IFNULL(target_cluster_name, ''),
                     IFNULL(start_time, '')
          )
        `);
        db.exec('DROP TABLE replication_runs');
        db.exec('ALTER TABLE replication_runs_dedup RENAME TO replication_runs');
        db.exec('CREATE INDEX IF NOT EXISTS idx_repl_runs_cluster_time ON replication_runs(cluster_id, start_time)');
        db.exec(`
          CREATE UNIQUE INDEX idx_repl_runs_unique ON replication_runs(
            protection_run_id,
            IFNULL(target_cluster_id, -1),
            IFNULL(target_cluster_name, ''),
            IFNULL(start_time, '')
          )
        `);
      })();
      db.exec('PRAGMA foreign_keys = ON');

      const after = db.prepare('SELECT COUNT(*) c FROM replication_runs').get().c;
      console.log(`[migration] replication_runs deduplicated: ${before} -> ${after} rows in ${((Date.now() - started) / 1000).toFixed(1)}s. Reclaiming disk space (VACUUM)…`);
      db.exec('VACUUM');
      console.log('[migration] VACUUM complete.');
    },
  },
];
