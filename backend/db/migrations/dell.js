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
];
