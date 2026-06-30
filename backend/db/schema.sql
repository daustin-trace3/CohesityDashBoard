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

-- Governance snapshots: replaced wholesale per cluster on each poll (current
-- state, not history).
CREATE TABLE IF NOT EXISTS policies (
  id                    INTEGER PRIMARY KEY AUTOINCREMENT,
  cluster_id            INTEGER NOT NULL REFERENCES clusters(id) ON DELETE CASCADE,
  policy_id             TEXT,
  name                  TEXT,
  retention_days        INTEGER,
  replication_targets   TEXT,   -- JSON array of target cluster names
  archival_targets      TEXT,   -- JSON array of archival target names
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

-- Pre-computed dashboard payload, rebuilt after each poll so the dashboard
-- renders the last pull instantly instead of fanning out per-cluster requests.
CREATE TABLE IF NOT EXISTS snapshot_cache (
  cache_key             TEXT PRIMARY KEY,
  payload_json          TEXT NOT NULL,
  updated_at            DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- On-demand LLM-generated per-cluster analysis (GitHub Models). One cached
-- result per cluster per mode ('alerts' = alert-focused, 'system' = capacity/
-- sources/job health). Re-running a mode replaces its row.
CREATE TABLE IF NOT EXISTS llm_insights (
  cluster_id            INTEGER NOT NULL REFERENCES clusters(id) ON DELETE CASCADE,
  mode                  TEXT NOT NULL DEFAULT 'system',
  model                 TEXT,
  analysis              TEXT NOT NULL,
  generated_at          DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (cluster_id, mode)
);

-- Simple key/value app settings (e.g. operator AI context). Editable at runtime
-- from the UI, no restart required.
CREATE TABLE IF NOT EXISTS app_settings (
  key                   TEXT PRIMARY KEY,
  value                 TEXT,
  updated_at            DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);
