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
