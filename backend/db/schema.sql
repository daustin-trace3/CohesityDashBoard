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

-- AI-generated reviews for alerts. Cached per alert so the LLM is only called
-- when the alert content changes (content_hash) or the user forces a refresh.
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

-- Fleet-wide (estate-level) AI Advisor reports, cached per report type
-- ('capacity', 'dr_readiness'). Re-running a report replaces its row.
CREATE TABLE IF NOT EXISTS ai_reports (
  report_key            TEXT PRIMARY KEY,
  model                 TEXT,
  content               TEXT NOT NULL,
  generated_at          DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- Cohesity licensing / capacity-consumption snapshot. Front-end TB under
-- management (the FETB licensing basis) pulled fleet-wide from the Helios
-- reporting service (storage-consumption-cluster), replaced wholesale on each
-- refresh — current state, not history.
CREATE TABLE IF NOT EXISTS license_usage (
  id                    INTEGER PRIMARY KEY AUTOINCREMENT,
  system_id             TEXT,
  system_name           TEXT,
  front_end_bytes       INTEGER,   -- dataIngestedRetainedBytes (FETB basis)
  physical_bytes        INTEGER,   -- scResiliencyBytes (physical stored)
  capacity_bytes        INTEGER,   -- totalCapacityBytes (raw cluster capacity)
  usage_percent         REAL,
  data_reduction        REAL,
  captured_at           DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- Consumed front-end (FETB) split by Cohesity license type, derived from the
-- Helios storage-consumption-group report: replica (targetRole != Primary),
-- SmartFiles (environment kView), DataProtect (everything else). Replaced
-- wholesale on each refresh.
CREATE TABLE IF NOT EXISTS license_type_usage (
  license_type          TEXT PRIMARY KEY,   -- 'dataProtect' | 'replica' | 'smartFiles'
  front_end_bytes       INTEGER NOT NULL DEFAULT 0,
  captured_at           DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- Per-system consumption split by what the data IS: locally backed-up data,
-- data replicated in from other clusters, data living in Views/shares, and
-- backups of Views. Pulled per cluster from the v1 stats/consumers API via
-- Helios passthrough. Replaced wholesale on each refresh.
-- Cohesity's own per-cluster license meters (public/licenseUsage API, GiB per
-- feature). This is the same accounting the Cohesity licensing portal reads,
-- so the license cards track official usage. Replaced wholesale each refresh.
CREATE TABLE IF NOT EXISTS license_meter_usage (
  id                    INTEGER PRIMARY KEY AUTOINCREMENT,
  system_id             TEXT,
  system_name           TEXT,
  feature               TEXT NOT NULL,      -- e.g. dataProtect, dataProtectReplica, externalViews
  usage_gib             REAL NOT NULL DEFAULT 0,
  captured_at           DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- Per-view detail behind the views split: which views on each system are
-- replicated in (read-only) vs actively receiving data (writable), with
-- creation date and sizes. Replaced wholesale on each refresh.
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
  category              TEXT NOT NULL,      -- 'backup' | 'replication' | 'views' | 'viewBackups'
  consumers             INTEGER,            -- number of jobs/views contributing
  physical_bytes        INTEGER,            -- storageConsumedBytes (on-disk)
  logical_bytes         INTEGER,            -- totalLogicalUsageBytes (front-end logical)
  captured_at           DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

/* ══════════════════════════════════════════════════════════════════════════
   Pure Storage FlashArray tables. Registered arrays + polled telemetry.
   Time-series tables (pure_metrics_history, pure_volume_history) accumulate;
   current-state tables are replaced wholesale each poll.
   ══════════════════════════════════════════════════════════════════════════ */

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
-- NOTE: the (array_id, pure_alert_id) UNIQUE index the alert upsert relies on is
-- created by a guarded, dedup-first migration in database.js so instances that
-- already collected alert rows don't fail on a duplicate during index creation.

CREATE TABLE IF NOT EXISTS pure_hosts (
  id                    INTEGER PRIMARY KEY AUTOINCREMENT,
  array_id              INTEGER NOT NULL REFERENCES pure_arrays(id) ON DELETE CASCADE,
  name                  TEXT,
  connection_count      INTEGER,
  personality           TEXT,
  protocol              TEXT,
  captured_at           DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- Per-volume time-series: space + performance sampled each poll. Powers hot-
-- volume and top-grower analytics. Pruned to 90 days.
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

-- Replication partners (array-connections). Current-state, replaced each poll.
CREATE TABLE IF NOT EXISTS pure_array_connections (
  id                    INTEGER PRIMARY KEY AUTOINCREMENT,
  array_id              INTEGER NOT NULL REFERENCES pure_arrays(id) ON DELETE CASCADE,
  remote_name           TEXT,
  status                TEXT,
  type                  TEXT,               -- sync-replication | async-replication
  version               TEXT,
  transport             TEXT,               -- ip | fc
  mgmt_address          TEXT,
  replication_addresses TEXT,               -- comma-joined
  captured_at           DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- Protection groups (snapshot/replication policy). Current-state, replaced each poll.
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

-- Hardware components. Current-state, replaced each poll.
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

-- Physical drives. Current-state, replaced each poll.
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

-- Controllers. Current-state, replaced each poll.
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

-- SSL certificates. Current-state, replaced each poll.
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

/* ══════════════════════════════════════════════════════════════════════════
   Pure1 cloud (SaaS) fleet telemetry. Unlike the direct FlashArray tables
   above (keyed by pure_arrays.id), Pure1 arrays are keyed by their Pure1 array
   UUID (a string). pure1_arrays holds the latest snapshot per array (upserted
   each poll) so the overview/dashboard can render instantly from the DB;
   pure1_capacity_history accumulates one capacity sample per Pure1 datapoint so
   long-term capacity trending survives restarts and spans arbitrary windows.
   ══════════════════════════════════════════════════════════════════════════ */

CREATE TABLE IF NOT EXISTS pure1_arrays (
  array_uuid        TEXT PRIMARY KEY,
  name              TEXT,
  fqdn              TEXT,
  model             TEXT,
  os                TEXT,
  version           TEXT,
  total_bytes       INTEGER,
  used_bytes        INTEGER,
  volume_space      INTEGER,
  shared_space      INTEGER,
  snapshot_space    INTEGER,
  system_space      INTEGER,
  replication_space INTEGER,
  data_reduction    REAL,
  tags_json         TEXT,
  captured_at_ms    INTEGER,               -- Pure1 datapoint timestamp (ms)
  updated_at        DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS pure1_capacity_history (
  id                INTEGER PRIMARY KEY AUTOINCREMENT,
  array_uuid        TEXT NOT NULL,
  captured_at_ms    INTEGER NOT NULL,      -- Pure1 datapoint timestamp (ms); dedupe key
  captured_at       DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  total_bytes       INTEGER,
  used_bytes        INTEGER,
  volume_space      INTEGER,
  shared_space      INTEGER,
  snapshot_space    INTEGER,
  system_space      INTEGER,
  replication_space INTEGER,
  data_reduction    REAL
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_pure1_cap_hist_uniq ON pure1_capacity_history(array_uuid, captured_at_ms);
CREATE INDEX IF NOT EXISTS idx_pure1_cap_hist_array_time ON pure1_capacity_history(array_uuid, captured_at_ms);

/* ══════════════════════════════════════════════════════════════════════════
   NetApp ONTAP tables. Registered clusters + polled telemetry, mirroring the
   Pure layout. Time-series accumulates (pruned 90 days); current-state tables
   are replaced wholesale each poll.
   ══════════════════════════════════════════════════════════════════════════ */

CREATE TABLE IF NOT EXISTS netapp_arrays (
  id                       INTEGER PRIMARY KEY AUTOINCREMENT,
  name                     TEXT NOT NULL UNIQUE,
  mgmt_host                TEXT NOT NULL,
  username                 TEXT NOT NULL,
  encrypted_credentials    TEXT NOT NULL,     -- AES-GCM JSON of { password }
  polling_interval_minutes INTEGER NOT NULL DEFAULT 15,
  ssl_verify               INTEGER NOT NULL DEFAULT 0,
  cluster_uuid             TEXT,              -- AIQUM gateway cluster uuid (source='aiqum')
  management_ip            TEXT,
  version                  TEXT,
  source                   TEXT NOT NULL DEFAULT 'direct',  -- 'aiqum' | 'direct'
  created_at               DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at               DATETIME DEFAULT CURRENT_TIMESTAMP
);

-- Cluster-level capacity + performance time-series.
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

-- Aggregates (current-state).
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

-- Volumes (current-state).
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

-- Storage VMs (current-state).
CREATE TABLE IF NOT EXISTS netapp_svms (
  id                    INTEGER PRIMARY KEY AUTOINCREMENT,
  array_id              INTEGER NOT NULL REFERENCES netapp_arrays(id) ON DELETE CASCADE,
  uuid                  TEXT,
  name                  TEXT,
  state                 TEXT,
  captured_at           DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- Nodes (current-state).
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

-- Disks (current-state).
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

-- Health/EMS alerts (current-state).
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

/* ── Connectivity / topology / DR (Pure + NetApp), current-state ─────────── */

-- Pure network interfaces (eth/fc virtual + physical).
CREATE TABLE IF NOT EXISTS pure_network_interfaces (
  id                    INTEGER PRIMARY KEY AUTOINCREMENT,
  array_id              INTEGER NOT NULL REFERENCES pure_arrays(id) ON DELETE CASCADE,
  name                  TEXT,
  interface_type        TEXT,
  enabled               INTEGER,
  speed_bps             INTEGER,
  services              TEXT,   -- comma-joined
  address               TEXT,
  netmask               TEXT,
  gateway               TEXT,
  mac_address           TEXT,
  vlan                  INTEGER,
  wwn                   TEXT,
  captured_at           DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- Pure physical ports (FC WWN / iSCSI IQN / NVMe NQN).
CREATE TABLE IF NOT EXISTS pure_ports (
  id                    INTEGER PRIMARY KEY AUTOINCREMENT,
  array_id              INTEGER NOT NULL REFERENCES pure_arrays(id) ON DELETE CASCADE,
  name                  TEXT,
  wwn                   TEXT,
  iqn                   TEXT,
  nqn                   TEXT,
  captured_at           DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- Pure volume-to-host LUN connections.
CREATE TABLE IF NOT EXISTS pure_connections (
  id                    INTEGER PRIMARY KEY AUTOINCREMENT,
  array_id              INTEGER NOT NULL REFERENCES pure_arrays(id) ON DELETE CASCADE,
  host_name             TEXT,
  host_group_name       TEXT,
  volume_name           TEXT,
  lun                   INTEGER,
  captured_at           DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- Pure pods (ActiveCluster stretched storage / DR).
CREATE TABLE IF NOT EXISTS pure_pods (
  id                    INTEGER PRIMARY KEY AUTOINCREMENT,
  array_id              INTEGER NOT NULL REFERENCES pure_arrays(id) ON DELETE CASCADE,
  name                  TEXT,
  promotion_status      TEXT,
  mediator              TEXT,
  array_count           INTEGER,
  link_source_count     INTEGER,
  link_target_count     INTEGER,
  member_arrays         TEXT,   -- "name(status)" joined
  total_physical_bytes  INTEGER,
  data_reduction        REAL,
  captured_at           DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- NetApp SnapMirror relationships (DR replication).
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

-- NetApp logical interfaces (LIFs).
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
  services              TEXT,   -- comma-joined
  node_name             TEXT,
  port_name             TEXT,
  is_home               INTEGER,
  failover              TEXT,
  captured_at           DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- NetApp quota reports (capacity governance).
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

-- NetApp NFS connected clients (live client-to-volume map).
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

-- NetApp NFS export-policy rules (flattened; which clients are permitted).
CREATE TABLE IF NOT EXISTS netapp_export_rules (
  id                    INTEGER PRIMARY KEY AUTOINCREMENT,
  array_id              INTEGER NOT NULL REFERENCES netapp_arrays(id) ON DELETE CASCADE,
  policy_name           TEXT,
  svm_name              TEXT,
  rule_index            INTEGER,
  clients               TEXT,   -- comma-joined match strings
  protocols             TEXT,   -- comma-joined
  ro_rule               TEXT,
  rw_rule               TEXT,
  superuser             TEXT,
  captured_at           DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- NetApp CIFS/SMB active sessions (live client-to-volume map). One row per
-- session/volume pair (a session can touch several volumes).
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
  protocol              TEXT,   -- e.g. smb3_1
  authentication        TEXT,   -- e.g. kerberos / ntlmv2
  smb_encryption        TEXT,
  smb_signing           INTEGER,
  open_shares           INTEGER,
  open_files            INTEGER,
  connected_duration    TEXT,   -- ISO8601 duration string
  idle_duration         TEXT,   -- ISO8601 duration string
  captured_at           DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- NetApp CIFS/SMB shares (share -> volume mapping).
CREATE TABLE IF NOT EXISTS netapp_cifs_shares (
  id                    INTEGER PRIMARY KEY AUTOINCREMENT,
  array_id              INTEGER NOT NULL REFERENCES netapp_arrays(id) ON DELETE CASCADE,
  share_name            TEXT,
  path                  TEXT,
  svm_name              TEXT,
  volume_name           TEXT,
  captured_at           DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- Cohesity Views inventory: per Helios cluster, replaced wholesale each
-- refresh (current state, not history). See services/views.js.
CREATE TABLE IF NOT EXISTS cohesity_views (
  id                  INTEGER PRIMARY KEY AUTOINCREMENT,
  system_id           TEXT NOT NULL,
  system_name         TEXT,
  view_id             INTEGER,
  name                TEXT NOT NULL,
  category            TEXT,
  storage_domain      TEXT,
  protocols           TEXT,
  is_read_only        INTEGER NOT NULL DEFAULT 0,
  protected           INTEGER NOT NULL DEFAULT 0,
  protection_groups   TEXT,
  replicated_out      INTEGER NOT NULL DEFAULT 0,
  last_backup_status  TEXT,
  last_backup_ms      INTEGER,
  datalock_mode       TEXT,
  datalock_retention_ms INTEGER,
  logical_bytes       INTEGER,
  consumed_bytes      INTEGER,
  data_in_bytes       INTEGER,
  data_written_bytes  INTEGER,
  file_count          INTEGER,
  created_ms          INTEGER,
  captured_at         DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_cohesity_views_system ON cohesity_views(system_id);

-- Analytics endpoints filter protection_runs by time window across ALL
-- clusters; (cluster_id, start_time) can't serve that — avoid full scans.
CREATE INDEX IF NOT EXISTS idx_prot_runs_start_time ON protection_runs(start_time);

-- Per-cluster, per-workload (environment) protection snapshot appended by the
-- poller: protected object counts + front-end protected bytes from
-- protectionSources/registrationInfo statsByEnv, and per-job logical /
-- physical consumption from stats/consumers joined to the jobs list.
-- One batch per cluster per day; pruned by the retention cron (730 days).
CREATE TABLE IF NOT EXISTS workload_history (
  id                INTEGER PRIMARY KEY AUTOINCREMENT,
  cluster_id        INTEGER NOT NULL REFERENCES clusters(id) ON DELETE CASCADE,
  environment       TEXT NOT NULL,
  protected_count   INTEGER,
  unprotected_count INTEGER,
  protected_bytes   INTEGER,
  job_count         INTEGER,
  logical_bytes     INTEGER,
  physical_bytes    INTEGER,
  captured_at       DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_workload_hist_cluster ON workload_history(cluster_id, environment, captured_at);
CREATE INDEX IF NOT EXISTS idx_workload_hist_time ON workload_history(captured_at);

/* ══════════════════════════════════════════════════════════════════════════
   Zerto tables. Data from the Zerto Analytics SaaS API (analytics.api.zerto.com)
   — one account-wide credential, so zerto_sites is discovered inventory.
   Current-state tables are replaced wholesale each poll; zerto_metrics_history
   accumulates account-level snapshots for trends (365-day retention).
   ══════════════════════════════════════════════════════════════════════════ */

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

-- VRA appliances per site, from /v2/monitoring/sites?format=topology.
-- Replaced wholesale each poll alongside the other current-state tables.
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

/* ══════════════════════════════════════════════════════════════════════════
   VMware vCenter tables. Registered vCenters (password AES-encrypted) +
   polled inventory (hosts, clusters, datastores, certs) replaced per vCenter
   each poll; vcenter_metrics_history accumulates snapshots (365-day prune
   inside the poller).
   ══════════════════════════════════════════════════════════════════════════ */

CREATE TABLE IF NOT EXISTS vcenter_vcenters (
  id                       INTEGER PRIMARY KEY AUTOINCREMENT,
  name                     TEXT NOT NULL UNIQUE,
  host                     TEXT NOT NULL,
  username                 TEXT NOT NULL,
  encrypted_credentials    TEXT NOT NULL,
  ssl_verify               INTEGER NOT NULL DEFAULT 0,
  polling_interval_minutes INTEGER NOT NULL DEFAULT 15,
  last_poll_status         TEXT,
  last_poll_error          TEXT,
  last_poll_at             DATETIME,
  version                  TEXT,
  build                    TEXT,
  product_name             TEXT,
  created_at               DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at               DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS vcenter_hosts (
  id                INTEGER PRIMARY KEY AUTOINCREMENT,
  vcenter_id        INTEGER NOT NULL REFERENCES vcenter_vcenters(id) ON DELETE CASCADE,
  host_id           TEXT NOT NULL,
  name              TEXT,
  cluster_name      TEXT,
  connection_state  TEXT,
  power_state       TEXT,
  in_maintenance    INTEGER,
  vm_count          INTEGER,
  cpu_mhz_capacity  INTEGER,
  cpu_mhz_used      INTEGER,
  mem_bytes_capacity INTEGER,
  mem_bytes_used    INTEGER,
  esx_version       TEXT,
  esx_build         TEXT,
  bios_version      TEXT,
  bios_release_date TEXT,
  vendor            TEXT,
  model             TEXT,
  cpu_cores         INTEGER,
  ntp_servers       TEXT,
  dns_servers       TEXT,
  ssh_enabled       INTEGER,
  uptime_seconds    INTEGER,
  captured_at       DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_vcenter_hosts_vc ON vcenter_hosts(vcenter_id);

CREATE TABLE IF NOT EXISTS vcenter_clusters (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  vcenter_id     INTEGER NOT NULL REFERENCES vcenter_vcenters(id) ON DELETE CASCADE,
  cluster_id     TEXT NOT NULL,
  name           TEXT,
  drs_enabled    INTEGER,
  ha_enabled     INTEGER,
  host_count     INTEGER,
  vm_count       INTEGER,
  cpu_mhz_capacity   INTEGER,
  cpu_mhz_used       INTEGER,
  mem_bytes_capacity INTEGER,
  mem_bytes_used     INTEGER,
  captured_at    DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_vcenter_clusters_vc ON vcenter_clusters(vcenter_id);

CREATE TABLE IF NOT EXISTS vcenter_datastores (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  vcenter_id     INTEGER NOT NULL REFERENCES vcenter_vcenters(id) ON DELETE CASCADE,
  datastore_id   TEXT NOT NULL,
  name           TEXT,
  ds_type        TEXT,
  capacity_bytes INTEGER,
  free_bytes     INTEGER,
  accessible     INTEGER,
  captured_at    DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_vcenter_datastores_vc ON vcenter_datastores(vcenter_id);

CREATE TABLE IF NOT EXISTS vcenter_certs (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  vcenter_id   INTEGER NOT NULL REFERENCES vcenter_vcenters(id) ON DELETE CASCADE,
  cert_type    TEXT,
  subject      TEXT,
  issuer       TEXT,
  valid_from   TEXT,
  valid_to     TEXT,
  captured_at  DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_vcenter_certs_vc ON vcenter_certs(vcenter_id);

CREATE TABLE IF NOT EXISTS vcenter_metrics_history (
  id                 INTEGER PRIMARY KEY AUTOINCREMENT,
  vcenter_id         INTEGER NOT NULL REFERENCES vcenter_vcenters(id) ON DELETE CASCADE,
  captured_at        DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  hosts_total        INTEGER,
  hosts_connected    INTEGER,
  hosts_maintenance  INTEGER,
  vms_total          INTEGER,
  datastore_capacity_bytes INTEGER,
  datastore_free_bytes     INTEGER
);
CREATE INDEX IF NOT EXISTS idx_vcenter_metrics_vc ON vcenter_metrics_history(vcenter_id, captured_at);

CREATE TABLE IF NOT EXISTS vcenter_vms (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  vcenter_id    INTEGER NOT NULL REFERENCES vcenter_vcenters(id) ON DELETE CASCADE,
  vm_id         TEXT,
  name          TEXT,
  host_name     TEXT,
  cluster_name  TEXT,
  power_state   TEXT,
  guest_os      TEXT,
  cpu_count     INTEGER,
  memory_mb     INTEGER,
  ip_address    TEXT,
  tools_status  TEXT,
  hw_version    TEXT,
  tools_version TEXT,
  tools_version_status TEXT,
  networks      TEXT,
  datastores    TEXT,
  tags          TEXT,
  guest_nics    TEXT,
  uptime_seconds INTEGER,
  storage_committed_bytes INTEGER,
  annotation    TEXT,
  captured_at   DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_vcenter_vms_vc ON vcenter_vms(vcenter_id);

CREATE TABLE IF NOT EXISTS vcenter_networks (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  vcenter_id   INTEGER NOT NULL REFERENCES vcenter_vcenters(id) ON DELETE CASCADE,
  host_name    TEXT,
  kind         TEXT NOT NULL,
  name         TEXT,
  switch_name  TEXT,
  vlan_id      INTEGER,
  speed_mbps   INTEGER,
  mac          TEXT,
  ip_address   TEXT,
  netmask      TEXT,
  mtu          INTEGER,
  uplinks      TEXT,
  port_count   INTEGER,
  extra        TEXT,
  captured_at  DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_vcenter_networks_vc ON vcenter_networks(vcenter_id, kind);

CREATE TABLE IF NOT EXISTS vcenter_orphaned_vmdks (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  vcenter_id     INTEGER NOT NULL REFERENCES vcenter_vcenters(id) ON DELETE CASCADE,
  datastore_name TEXT,
  path           TEXT,
  size_bytes     INTEGER,
  modified_at    TEXT,
  captured_at    DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_vcenter_orphans_vc ON vcenter_orphaned_vmdks(vcenter_id);

CREATE TABLE IF NOT EXISTS vcenter_events (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  vcenter_id   INTEGER NOT NULL REFERENCES vcenter_vcenters(id) ON DELETE CASCADE,
  event_key    INTEGER NOT NULL,
  event_type   TEXT,
  severity     TEXT,
  message      TEXT,
  username     TEXT,
  entity_name  TEXT,
  created_at   TEXT,
  captured_at  DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_vcenter_events_key ON vcenter_events(vcenter_id, event_key);
CREATE INDEX IF NOT EXISTS idx_vcenter_events_time ON vcenter_events(created_at);

CREATE TABLE IF NOT EXISTS vcenter_issue_history (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  issue_key   TEXT NOT NULL,
  vcenter     TEXT,
  severity    TEXT,
  type        TEXT,
  target      TEXT,
  message     TEXT,
  status      TEXT NOT NULL DEFAULT 'open',
  first_seen  DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  last_seen   DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  resolved_at DATETIME
);
CREATE INDEX IF NOT EXISTS idx_vcenter_issue_hist_key ON vcenter_issue_history(issue_key, status);
CREATE INDEX IF NOT EXISTS idx_vcenter_issue_hist_seen ON vcenter_issue_history(last_seen);

-- Dell OpenManage Enterprise platform (OME appliances are the connection
-- point). Inventory tables replaced per instance each poll; alerts append.
CREATE TABLE IF NOT EXISTS dell_ome_instances (
          id                       INTEGER PRIMARY KEY AUTOINCREMENT,
          name                     TEXT NOT NULL UNIQUE,
          host                     TEXT NOT NULL,
          username                 TEXT NOT NULL,
          encrypted_credentials    TEXT NOT NULL,
          ssl_verify               INTEGER NOT NULL DEFAULT 0,
          polling_interval_minutes INTEGER NOT NULL DEFAULT 15,
          version                  TEXT,
          last_poll_status         TEXT,
          last_poll_error          TEXT,
          last_poll_at             DATETIME,
          created_at               DATETIME DEFAULT CURRENT_TIMESTAMP,
          updated_at               DATETIME DEFAULT CURRENT_TIMESTAMP
        );

        CREATE TABLE IF NOT EXISTS dell_devices (
          id                  INTEGER PRIMARY KEY AUTOINCREMENT,
          ome_id              INTEGER NOT NULL REFERENCES dell_ome_instances(id) ON DELETE CASCADE,
          device_id           INTEGER NOT NULL,   -- OME's numeric device Id
          service_tag         TEXT,
          name                TEXT,
          model               TEXT,
          device_type         TEXT,               -- Server | Chassis | Network Device | ...
          chassis_service_tag TEXT,
          health              TEXT,               -- ok | warning | critical | unknown
          health_raw          INTEGER,            -- OME status id (1000/3000/4000/...)
          power_state         TEXT,               -- on | off | unknown
          connection_state    INTEGER,            -- 1/0
          managed_state       TEXT,
          asset_tag           TEXT,
          ip_address          TEXT,
          firmware_version    TEXT,               -- iDRAC/management firmware when known
          cpu_count           INTEGER,            -- filled from inventory (sockets)
          core_count          INTEGER,
          memory_bytes        INTEGER,
          disk_bytes          INTEGER,
          power_w             REAL,               -- Power Manager instant power (NULL without plugin)
          inlet_temp_c        REAL,
          cpu_util_pct        REAL,
          mem_util_pct        REAL,
          last_inventory_time TEXT,
          captured_at         DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
        );
        CREATE INDEX IF NOT EXISTS idx_dell_devices_ome ON dell_devices(ome_id);

        CREATE TABLE IF NOT EXISTS dell_components (
          id           INTEGER PRIMARY KEY AUTOINCREMENT,
          ome_id       INTEGER NOT NULL REFERENCES dell_ome_instances(id) ON DELETE CASCADE,
          device_id    INTEGER NOT NULL,           -- OME device Id (joins dell_devices.device_id)
          kind         TEXT NOT NULL,              -- processor | memory | disk | nic | psu | os
          name         TEXT,
          description  TEXT,
          status       TEXT,                       -- ok | warning | critical | unknown (NULL when N/A)
          model        TEXT,
          serial       TEXT,
          slot         TEXT,
          size_bytes   INTEGER,                    -- DIMM/disk capacity
          speed        TEXT,                       -- CPU GHz / DIMM MHz / link speed
          extra        TEXT,                       -- JSON: media type, bus, cores, firmware, ...
          captured_at  DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
        );
        CREATE INDEX IF NOT EXISTS idx_dell_components_dev ON dell_components(ome_id, device_id, kind);

        CREATE TABLE IF NOT EXISTS dell_alerts (
          id           INTEGER PRIMARY KEY AUTOINCREMENT,
          ome_id       INTEGER NOT NULL REFERENCES dell_ome_instances(id) ON DELETE CASCADE,
          alert_id     INTEGER NOT NULL,           -- OME's alert Id (unique per instance)
          severity     TEXT,                       -- info | normal | warning | critical | unknown
          status       TEXT,                       -- acknowledged | not-acknowledged
          category     TEXT,
          subcategory  TEXT,
          message_id   TEXT,
          message      TEXT,
          device_name  TEXT,
          service_tag  TEXT,
          created_at   TEXT,                       -- alert TimeStamp from OME
          captured_at  DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
        );
        CREATE UNIQUE INDEX IF NOT EXISTS idx_dell_alerts_key ON dell_alerts(ome_id, alert_id);
        CREATE INDEX IF NOT EXISTS idx_dell_alerts_time ON dell_alerts(created_at);

        CREATE TABLE IF NOT EXISTS dell_warranties (
          id             INTEGER PRIMARY KEY AUTOINCREMENT,
          ome_id         INTEGER NOT NULL REFERENCES dell_ome_instances(id) ON DELETE CASCADE,
          device_id      INTEGER,
          service_tag    TEXT,
          device_model   TEXT,
          device_type    TEXT,
          service_level  TEXT,
          start_date     TEXT,
          end_date       TEXT,
          days_remaining INTEGER,
          captured_at    DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
        );
        CREATE INDEX IF NOT EXISTS idx_dell_warranties_ome ON dell_warranties(ome_id);

        CREATE TABLE IF NOT EXISTS dell_firmware_compliance (
          id              INTEGER PRIMARY KEY AUTOINCREMENT,
          ome_id          INTEGER NOT NULL REFERENCES dell_ome_instances(id) ON DELETE CASCADE,
          baseline_id     INTEGER,
          baseline_name   TEXT,
          device_id       INTEGER,
          service_tag     TEXT,
          device_model    TEXT,
          status          TEXT,                    -- compliant | noncompliant | unknown
          noncompliant_components INTEGER,         -- count of components needing update
          captured_at     DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
        );
        CREATE INDEX IF NOT EXISTS idx_dell_fw_ome ON dell_firmware_compliance(ome_id);

        CREATE TABLE IF NOT EXISTS dell_metrics_history (
          id                 INTEGER PRIMARY KEY AUTOINCREMENT,
          ome_id             INTEGER NOT NULL REFERENCES dell_ome_instances(id) ON DELETE CASCADE,
          captured_at        DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
          devices_total      INTEGER,
          devices_ok         INTEGER,
          devices_warning    INTEGER,
          devices_critical   INTEGER,
          devices_powered_on INTEGER,
          servers_total      INTEGER,
          alerts_critical_7d INTEGER,
          power_w_total      REAL
        );
        CREATE INDEX IF NOT EXISTS idx_dell_metrics_ome ON dell_metrics_history(ome_id, captured_at);
