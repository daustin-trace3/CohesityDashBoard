// Dell OpenManage Enterprise scope: ome_* tables. Direct-connection model
// like vCenter — each OME appliance is registered with credentials
// (AES-encrypted), one poller task per instance. Inventory tables (devices,
// components, warranties, firmware) are replaced per instance each poll;
// alerts append incrementally; dell_metrics_history accumulates snapshots.
module.exports = [
  {
    version: 1,
    up(db) {
      db.exec(`
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
      `);
    },
  },
  {
    version: 2,
    up(db) {
      const cols = db.prepare('PRAGMA table_info(dell_alerts)').all().map((c) => c.name);
      if (!cols.includes('message_id')) db.exec('ALTER TABLE dell_alerts ADD COLUMN message_id TEXT');
    },
  },

  // Migration: cached AI Advisor report content, one row per report key.
  {
    version: 3,
    up(db) {
      db.exec(`
        CREATE TABLE IF NOT EXISTS dell_ai_reports (
          report_key    TEXT PRIMARY KEY,
          model         TEXT,
          content       TEXT NOT NULL,
          generated_at  DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
        );
      `);
    },
  },

  // Migration: configuration governance + auditability — config compliance
  // baselines (with per-device attribute drift detail), OME jobs, server
  // configuration profiles, and per-device iDRAC hardware (Lifecycle/SEL)
  // logs. Compliance/jobs/profiles are replaced per instance per poll;
  // hardware logs append incrementally (deduped on log_id) like alerts.
  {
    version: 4,
    up(db) {
      db.exec(`
        CREATE TABLE IF NOT EXISTS dell_config_baselines (
          id                INTEGER PRIMARY KEY AUTOINCREMENT,
          ome_id            INTEGER NOT NULL REFERENCES dell_ome_instances(id) ON DELETE CASCADE,
          baseline_id       INTEGER NOT NULL,
          name              TEXT,
          description       TEXT,
          template_id       INTEGER,
          template_name     TEXT,
          last_run          TEXT,
          compliance_status TEXT,                -- rollup: OK | WARNING | CRITICAL | NOT_INVENTORIED
          n_critical        INTEGER,
          n_warning         INTEGER,
          n_normal          INTEGER,
          n_incomplete      INTEGER,
          task_id           INTEGER,
          percent_complete  TEXT,
          captured_at       DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
        );
        CREATE INDEX IF NOT EXISTS idx_dell_cfg_baselines_ome ON dell_config_baselines(ome_id);

        CREATE TABLE IF NOT EXISTS dell_config_compliance (
          id             INTEGER PRIMARY KEY AUTOINCREMENT,
          ome_id         INTEGER NOT NULL REFERENCES dell_ome_instances(id) ON DELETE CASCADE,
          baseline_id    INTEGER NOT NULL,
          baseline_name  TEXT,
          device_id      INTEGER,                -- OME device Id (joins dell_devices.device_id)
          device_name    TEXT,
          service_tag    TEXT,
          model          TEXT,
          status         TEXT,                   -- compliant | noncompliant | not_inventoried | unknown
          inventory_time TEXT,
          detail         TEXT,                   -- JSON [{group, attribute, expected, current, reason}] for noncompliant
          captured_at    DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
        );
        CREATE INDEX IF NOT EXISTS idx_dell_cfg_compliance_ome ON dell_config_compliance(ome_id, baseline_id);

        CREATE TABLE IF NOT EXISTS dell_jobs (
          id                  INTEGER PRIMARY KEY AUTOINCREMENT,
          ome_id              INTEGER NOT NULL REFERENCES dell_ome_instances(id) ON DELETE CASCADE,
          job_id              INTEGER NOT NULL,
          name                TEXT,
          description         TEXT,
          job_type            TEXT,
          internal            INTEGER,            -- JobType.Internal
          state               TEXT,               -- Enabled | Disabled
          builtin             INTEGER,
          visible             INTEGER,
          last_run_status_id  INTEGER,            -- 2060 Completed / 2070 Failed / 2200 NotRun / ...
          last_run_status     TEXT,
          job_status          TEXT,
          last_run            TEXT,
          next_run            TEXT,
          start_time          TEXT,
          end_time            TEXT,
          schedule            TEXT,               -- cron string or 'startnow'
          created_by          TEXT,
          targets             TEXT,               -- comma-joined target names
          captured_at         DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
        );
        CREATE INDEX IF NOT EXISTS idx_dell_jobs_ome ON dell_jobs(ome_id);

        CREATE TABLE IF NOT EXISTS dell_config_profiles (
          id                  INTEGER PRIMARY KEY AUTOINCREMENT,
          ome_id              INTEGER NOT NULL REFERENCES dell_ome_instances(id) ON DELETE CASCADE,
          profile_id          INTEGER NOT NULL,
          name                TEXT,
          description         TEXT,
          template_id         INTEGER,
          template_name       TEXT,
          target_id           INTEGER,
          target_name         TEXT,
          chassis_name        TEXT,
          state               TEXT,               -- unassigned | assigned | deployed | ...
          last_run_status_id  INTEGER,
          last_run_status     TEXT,
          profile_modified    INTEGER,            -- 1 = drifted from its template
          created_by          TEXT,
          created_date        TEXT,
          last_deploy_date    TEXT,
          captured_at         DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
        );
        CREATE INDEX IF NOT EXISTS idx_dell_cfg_profiles_ome ON dell_config_profiles(ome_id);

        CREATE TABLE IF NOT EXISTS dell_hardware_logs (
          id          INTEGER PRIMARY KEY AUTOINCREMENT,
          ome_id      INTEGER NOT NULL REFERENCES dell_ome_instances(id) ON DELETE CASCADE,
          device_id   INTEGER NOT NULL,            -- OME device Id
          log_id      TEXT NOT NULL,               -- e.g. DCIM:LifeCycleLog:286450
          seq         INTEGER,                     -- LogSequenceNumber (monotonic per device)
          severity    TEXT,                        -- info | warning | critical | fatal
          category    TEXT,                        -- Audit | Configuration | System Health | Storage | Updates
          message_id  TEXT,                        -- iDRAC event code (USR0030, PDR16, ...)
          message     TEXT,
          comment     TEXT,
          created_at  TEXT,                        -- UTC, parsed from the CIM timestamp
          captured_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
        );
        CREATE UNIQUE INDEX IF NOT EXISTS idx_dell_hwlogs_key ON dell_hardware_logs(ome_id, device_id, log_id);
        CREATE INDEX IF NOT EXISTS idx_dell_hwlogs_time ON dell_hardware_logs(created_at);
      `);
    },
  },

  // Migration: per-attribute drift timeline. OME reports only that a setting
  // differs NOW — it carries no change timestamp — so the poller records when
  // each drifted attribute was first/last seen and when it came back into
  // compliance. Rows persist across polls (compliance snapshots are replaced,
  // this table is reconciled).
  {
    version: 5,
    up(db) {
      db.exec(`
        CREATE TABLE IF NOT EXISTS dell_config_drift_history (
          id           INTEGER PRIMARY KEY AUTOINCREMENT,
          ome_id       INTEGER NOT NULL REFERENCES dell_ome_instances(id) ON DELETE CASCADE,
          baseline_id  INTEGER NOT NULL,
          device_id    INTEGER NOT NULL,
          service_tag  TEXT,
          attr_group   TEXT,
          attribute    TEXT,
          expected     TEXT,
          current      TEXT,               -- value at last sighting
          first_seen   DATETIME NOT NULL,  -- when the poller first saw this drift episode
          last_seen    DATETIME NOT NULL,
          resolved_at  DATETIME            -- set when the attribute stops drifting
        );
        CREATE UNIQUE INDEX IF NOT EXISTS idx_dell_drift_key
          ON dell_config_drift_history(ome_id, baseline_id, device_id, attr_group, attribute);
        CREATE INDEX IF NOT EXISTS idx_dell_drift_dev ON dell_config_drift_history(ome_id, device_id);
      `);
    },
  },
];
