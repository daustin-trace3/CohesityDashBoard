// Brocade SAN (SANnav) scope: brocade_* tables. Per-source direct-connection
// model (multiple SANnav Management Portal servers). Sync strategy per poll:
// upsert by natural key, mark rows not seen this cycle stale=1 (never
// delete — SANnav has its own `missing` flag; ours is a separate `stale`
// column to avoid confusion). Single version — ships whole (contract §3).
module.exports = [
  {
    version: 1,
    up(db) {
      db.exec(`
        CREATE TABLE IF NOT EXISTS brocade_sources (
          id                         INTEGER PRIMARY KEY AUTOINCREMENT,
          name                       TEXT NOT NULL UNIQUE,
          host                       TEXT NOT NULL,
          port                       INTEGER DEFAULT 443,
          username                   TEXT,
          password_enc               TEXT,
          verify_ssl                 INTEGER DEFAULT 0,
          enabled                    INTEGER DEFAULT 1,
          polling_interval_minutes   INTEGER DEFAULT 60,
          event_poll_minutes         INTEGER DEFAULT 5,
          fos_proxy_enabled          INTEGER DEFAULT 1,
          sannav_version             TEXT,
          oem_name                   TEXT,
          last_poll_at               TEXT,
          last_poll_status           TEXT,
          last_poll_error            TEXT,
          last_event_poll_at         TEXT,
          event_cursor_ms            INTEGER DEFAULT 0,
          section_errors             TEXT,
          password_policy_json       TEXT,
          users_json                 TEXT,
          roles_json                 TEXT,
          aors_json                  TEXT,
          created_at                 TEXT DEFAULT (datetime('now'))
        );

        CREATE TABLE IF NOT EXISTS brocade_fabrics (
          id                       INTEGER PRIMARY KEY AUTOINCREMENT,
          source_id                INTEGER NOT NULL REFERENCES brocade_sources(id) ON DELETE CASCADE,
          sannav_id                INTEGER,
          guid                     TEXT,
          name                     TEXT,
          principal_switch_wwn     TEXT,
          seed_switch_wwn          TEXT,
          seed_switch_ip           TEXT,
          seed_switch_name         TEXT,
          seed_switch_firmware     TEXT,
          status                   INTEGER,
          health                   TEXT,
          switch_count             INTEGER,
          active_zoneset_name      TEXT,
          managed                  INTEGER,
          virtual_fabric_id        INTEGER,
          management_state         INTEGER,
          last_fabric_changed      TEXT,
          stale                    INTEGER DEFAULT 0,
          raw_json                 TEXT,
          updated_at               TEXT DEFAULT (datetime('now')),
          UNIQUE(source_id, principal_switch_wwn)
        );
        CREATE INDEX IF NOT EXISTS idx_brocade_fabrics_source ON brocade_fabrics(source_id);

        CREATE TABLE IF NOT EXISTS brocade_switches (
          id                        INTEGER PRIMARY KEY AUTOINCREMENT,
          source_id                 INTEGER NOT NULL REFERENCES brocade_sources(id) ON DELETE CASCADE,
          sannav_id                 INTEGER,
          wwn                       TEXT,
          name                      TEXT,
          physical_switch_wwn       TEXT,
          ip_address                TEXT,
          model                     TEXT,
          model_number              TEXT,
          firmware_version          TEXT,
          serial_number             TEXT,
          fabric_name               TEXT,
          principal_switch_wwn      TEXT,
          domain_id                 INTEGER,
          role                      TEXT,
          state                     TEXT,
          status                    TEXT,
          operational_status        TEXT,
          health                    TEXT,
          status_reason             TEXT,
          is_missing                INTEGER DEFAULT 0,
          monitored                 INTEGER,
          discovered_port_count     INTEGER,
          max_port                  INTEGER,
          switch_mode                INTEGER,
          management_state          INTEGER,
          eos_status                INTEGER,
          maintenance_mode          INTEGER,
          tls_cert_expiry_ms        INTEGER,
          trufos_status             INTEGER,
          virtual_fabric_id         INTEGER,
          chassis_type              INTEGER,
          vendor                    TEXT,
          stale                     INTEGER DEFAULT 0,
          raw_json                  TEXT,
          updated_at                TEXT DEFAULT (datetime('now')),
          UNIQUE(source_id, wwn)
        );
        CREATE INDEX IF NOT EXISTS idx_brocade_switches_source ON brocade_switches(source_id);
        CREATE INDEX IF NOT EXISTS idx_brocade_switches_fabric ON brocade_switches(source_id, fabric_name);

        CREATE TABLE IF NOT EXISTS brocade_switch_ports (
          id                    INTEGER PRIMARY KEY AUTOINCREMENT,
          source_id             INTEGER NOT NULL REFERENCES brocade_sources(id) ON DELETE CASCADE,
          sannav_id             INTEGER,
          wwn                   TEXT,
          switch_wwn            TEXT,
          switch_name           TEXT,
          name                  TEXT,
          slot_number           INTEGER,
          port_number           INTEGER,
          port_index            INTEGER,
          port_id               TEXT,
          type                  TEXT,
          state                 TEXT,
          status                TEXT,
          health                TEXT,
          calculated_status     TEXT,
          status_message        TEXT,
          speed                 TEXT,
          speed_type            INTEGER,
          max_port_speed        INTEGER,
          remote_device         TEXT,
          remote_port_wwn       TEXT,
          remote_node_wwn       TEXT,
          connected_device_type TEXT,
          trunked               INTEGER,
          trunk_master          INTEGER,
          fenced                INTEGER,
          blocked               INTEGER,
          persistent_disable    INTEGER,
          is_missing            INTEGER DEFAULT 0,
          monitored             INTEGER,
          occupied              INTEGER,
          licensed              INTEGER,
          last_update_ms        INTEGER,
          active_zone_count     INTEGER,
          zone_alias            TEXT,
          fabric_name           TEXT,
          virtual_fabric_id     INTEGER,
          stale                 INTEGER DEFAULT 0,
          updated_at            TEXT DEFAULT (datetime('now')),
          UNIQUE(source_id, wwn)
        );
        CREATE INDEX IF NOT EXISTS idx_brocade_switch_ports_source ON brocade_switch_ports(source_id);
        CREATE INDEX IF NOT EXISTS idx_brocade_switch_ports_switch ON brocade_switch_ports(source_id, switch_wwn);

        CREATE TABLE IF NOT EXISTS brocade_device_ports (
          id                      INTEGER PRIMARY KEY AUTOINCREMENT,
          source_id               INTEGER NOT NULL REFERENCES brocade_sources(id) ON DELETE CASCADE,
          sannav_id                INTEGER,
          wwn                     TEXT,
          device_node_wwn         TEXT,
          symbolic_name           TEXT,
          device_symbolic_name    TEXT,
          vendor                  TEXT,
          port_role               TEXT,
          type                    TEXT,
          fabric_name             TEXT,
          switch_wwn              TEXT,
          switch_name             TEXT,
          switch_port_wwn         TEXT,
          switch_port_name        TEXT,
          slot_number             INTEGER,
          port_number             INTEGER,
          port_id                 TEXT,
          enclosure_id            INTEGER,
          enclosure_guid          TEXT,
          enclosure_name          TEXT,
          fdmi_host_name          TEXT,
          active_zones            TEXT,
          active_zone_count       INTEGER,
          active_zoneset_name     TEXT,
          zone_alias              TEXT,
          is_missing              INTEGER DEFAULT 0,
          speed                   TEXT,
          stale                   INTEGER DEFAULT 0,
          updated_at              TEXT DEFAULT (datetime('now')),
          UNIQUE(source_id, wwn)
        );
        CREATE INDEX IF NOT EXISTS idx_brocade_device_ports_source ON brocade_device_ports(source_id);
        CREATE INDEX IF NOT EXISTS idx_brocade_device_ports_encl ON brocade_device_ports(source_id, enclosure_guid);

        CREATE TABLE IF NOT EXISTS brocade_enclosures (
          id            INTEGER PRIMARY KEY AUTOINCREMENT,
          source_id     INTEGER NOT NULL REFERENCES brocade_sources(id) ON DELETE CASCADE,
          sannav_id     INTEGER,
          guid          TEXT,
          name          TEXT,
          type          TEXT,
          host_name     TEXT,
          ip_address    TEXT,
          vendor        TEXT,
          model         TEXT,
          health        TEXT,
          location      TEXT,
          contact       TEXT,
          tags          TEXT,
          stale         INTEGER DEFAULT 0,
          raw_json      TEXT,
          updated_at    TEXT DEFAULT (datetime('now')),
          UNIQUE(source_id, guid)
        );
        CREATE INDEX IF NOT EXISTS idx_brocade_enclosures_source ON brocade_enclosures(source_id);

        CREATE TABLE IF NOT EXISTS brocade_chassis (
          id                       INTEGER PRIMARY KEY AUTOINCREMENT,
          source_id                INTEGER NOT NULL REFERENCES brocade_sources(id) ON DELETE CASCADE,
          switch_id                INTEGER,
          wwn                      TEXT,
          name                     TEXT,
          ip_address               TEXT,
          model_number             TEXT,
          firmware                 TEXT,
          serial_number            TEXT,
          part_number              TEXT,
          vendor                   TEXT,
          max_port                 INTEGER,
          num_virtual_switches     INTEGER,
          max_virtual_switches     INTEGER,
          tls_cert_expiry_ms       INTEGER,
          stale                    INTEGER DEFAULT 0,
          raw_json                 TEXT,
          updated_at               TEXT DEFAULT (datetime('now')),
          UNIQUE(source_id, wwn)
        );
        CREATE INDEX IF NOT EXISTS idx_brocade_chassis_source ON brocade_chassis(source_id);

        CREATE TABLE IF NOT EXISTS brocade_events (
          id                    INTEGER PRIMARY KEY AUTOINCREMENT,
          source_id             INTEGER NOT NULL REFERENCES brocade_sources(id) ON DELETE CASCADE,
          event_id              TEXT,
          severity               TEXT,
          severity_norm          TEXT,
          event_category         TEXT,
          source_name            TEXT,
          source_address         TEXT,
          source_type            TEXT,
          source_wwn             TEXT,
          fabric_name            TEXT,
          message_id             TEXT,
          origin                 TEXT,
          module                 TEXT,
          description            TEXT,
          event_count            INTEGER,
          first_occurred_ms      INTEGER,
          last_occurred_ms       INTEGER,
          acknowledged           INTEGER DEFAULT 0,
          ack_by                 TEXT,
          ack_notes              TEXT,
          acked_time_ms          INTEGER,
          product_name           TEXT,
          product_address        TEXT,
          port_wwn               TEXT,
          created_at             TEXT DEFAULT (datetime('now')),
          UNIQUE(source_id, event_id)
        );
        CREATE INDEX IF NOT EXISTS idx_brocade_events_source_time ON brocade_events(source_id, last_occurred_ms DESC);
        CREATE INDEX IF NOT EXISTS idx_brocade_events_source_sev ON brocade_events(source_id, severity_norm);

        CREATE TABLE IF NOT EXISTS brocade_health_scores (
          id                  INTEGER PRIMARY KEY AUTOINCREMENT,
          source_id           INTEGER NOT NULL REFERENCES brocade_sources(id) ON DELETE CASCADE,
          entity_type         TEXT,
          entity_name         TEXT,
          entity_guid         TEXT,
          entity_wwn          TEXT,
          entity_ip           TEXT,
          fid                 INTEGER,
          fabric_name         TEXT,
          score               INTEGER,
          status              TEXT,
          computation_time    TEXT,
          computation_ms      INTEGER,
          contributors_json   TEXT,
          stale               INTEGER DEFAULT 0,
          updated_at          TEXT DEFAULT (datetime('now')),
          UNIQUE(source_id, entity_type, entity_guid)
        );
        CREATE INDEX IF NOT EXISTS idx_brocade_health_scores_source ON brocade_health_scores(source_id);

        CREATE TABLE IF NOT EXISTS brocade_zone_configs (
          id                     INTEGER PRIMARY KEY AUTOINCREMENT,
          source_id              INTEGER NOT NULL REFERENCES brocade_sources(id) ON DELETE CASCADE,
          fabric_name            TEXT,
          cfg_name               TEXT,
          is_effective           INTEGER DEFAULT 0,
          member_zones           TEXT,
          default_zone_access    INTEGER,
          checksum               TEXT,
          db_max                 INTEGER,
          db_avail               INTEGER,
          db_committed           INTEGER,
          stale                  INTEGER DEFAULT 0,
          updated_at             TEXT DEFAULT (datetime('now')),
          UNIQUE(source_id, fabric_name, cfg_name)
        );
        CREATE INDEX IF NOT EXISTS idx_brocade_zone_configs_source ON brocade_zone_configs(source_id);

        CREATE TABLE IF NOT EXISTS brocade_zones (
          id               INTEGER PRIMARY KEY AUTOINCREMENT,
          source_id        INTEGER NOT NULL REFERENCES brocade_sources(id) ON DELETE CASCADE,
          fabric_name      TEXT,
          zone_name        TEXT,
          zone_type        INTEGER,
          zone_type_string TEXT,
          members          TEXT,
          in_effective     INTEGER DEFAULT 0,
          stale            INTEGER DEFAULT 0,
          updated_at       TEXT DEFAULT (datetime('now')),
          UNIQUE(source_id, fabric_name, zone_name)
        );
        CREATE INDEX IF NOT EXISTS idx_brocade_zones_source ON brocade_zones(source_id);

        CREATE TABLE IF NOT EXISTS brocade_zone_aliases (
          id            INTEGER PRIMARY KEY AUTOINCREMENT,
          source_id     INTEGER NOT NULL REFERENCES brocade_sources(id) ON DELETE CASCADE,
          fabric_name   TEXT,
          alias_name    TEXT,
          members       TEXT,
          stale         INTEGER DEFAULT 0,
          updated_at    TEXT DEFAULT (datetime('now')),
          UNIQUE(source_id, fabric_name, alias_name)
        );
        CREATE INDEX IF NOT EXISTS idx_brocade_zone_aliases_source ON brocade_zone_aliases(source_id);

        CREATE TABLE IF NOT EXISTS brocade_zone_changes (
          id             INTEGER PRIMARY KEY AUTOINCREMENT,
          source_id      INTEGER NOT NULL REFERENCES brocade_sources(id) ON DELETE CASCADE,
          fabric_name    TEXT,
          change_type    TEXT,
          detail         TEXT,
          old_value      TEXT,
          new_value      TEXT,
          detected_at    TEXT DEFAULT (datetime('now'))
        );
        CREATE INDEX IF NOT EXISTS idx_brocade_zone_changes_source ON brocade_zone_changes(source_id, detected_at DESC);

        CREATE TABLE IF NOT EXISTS brocade_fcr_routes (
          id                    INTEGER PRIMARY KEY AUTOINCREMENT,
          source_id             INTEGER NOT NULL REFERENCES brocade_sources(id) ON DELETE CASCADE,
          backbone_fabric_id    INTEGER,
          backbone_wwn          TEXT,
          backbone_ip           TEXT,
          edge_fabrics          TEXT,
          stale                 INTEGER DEFAULT 0,
          updated_at            TEXT DEFAULT (datetime('now')),
          UNIQUE(source_id, backbone_wwn, backbone_fabric_id)
        );
        CREATE INDEX IF NOT EXISTS idx_brocade_fcr_routes_source ON brocade_fcr_routes(source_id);

        CREATE TABLE IF NOT EXISTS brocade_metrics (
          id                    INTEGER PRIMARY KEY AUTOINCREMENT,
          source_id             INTEGER NOT NULL REFERENCES brocade_sources(id) ON DELETE CASCADE,
          fabrics_total         INTEGER,
          fabrics_healthy       INTEGER,
          switches_total        INTEGER,
          switches_healthy      INTEGER,
          switches_marginal     INTEGER,
          switches_critical     INTEGER,
          switches_unreachable  INTEGER,
          ports_total           INTEGER,
          ports_online          INTEGER,
          ports_offline         INTEGER,
          ports_error           INTEGER,
          ports_occupied        INTEGER,
          device_ports_total    INTEGER,
          enclosures_total      INTEGER,
          hosts_total           INTEGER,
          storage_total         INTEGER,
          zones_total           INTEGER,
          aliases_total         INTEGER,
          avg_fabric_health     INTEGER,
          min_fabric_health     INTEGER,
          events_critical_24h   INTEGER,
          events_warning_24h    INTEGER,
          ts                    TEXT DEFAULT (datetime('now'))
        );
        CREATE INDEX IF NOT EXISTS idx_brocade_metrics_source_ts ON brocade_metrics(source_id, ts);

        CREATE TABLE IF NOT EXISTS brocade_issue_history (
          id            INTEGER PRIMARY KEY AUTOINCREMENT,
          source_id     INTEGER,
          source        TEXT,
          type          TEXT,
          target        TEXT,
          severity      TEXT,
          message       TEXT,
          first_seen    TEXT,
          last_seen     TEXT,
          resolved_at   TEXT
        );
        CREATE INDEX IF NOT EXISTS idx_brocade_issue_history_open ON brocade_issue_history(resolved_at);
      `);
    },
  },

  // Addendum 1 (2026-08-31): per-port IO statistics via the FOS proxy.
  // Additive only — brocade_sources gains an interval column (pragma-guarded
  // ALTER, never re-runs against an already-migrated column), and a new
  // brocade_port_stats table stores raw counters + poller-computed rates.
  {
    version: 2,
    up(db) {
      const cols = db.prepare('PRAGMA table_info(brocade_sources)').all().map((c) => c.name);
      if (!cols.includes('port_stats_interval_minutes')) {
        db.exec('ALTER TABLE brocade_sources ADD COLUMN port_stats_interval_minutes INTEGER DEFAULT 15');
      }

      db.exec(`
        CREATE TABLE IF NOT EXISTS brocade_port_stats (
          id                   INTEGER PRIMARY KEY AUTOINCREMENT,
          source_id            INTEGER NOT NULL REFERENCES brocade_sources(id) ON DELETE CASCADE,
          port_wwn             TEXT,
          switch_wwn           TEXT,
          ts                   TEXT DEFAULT (datetime('now')),
          in_frames            INTEGER,
          out_frames           INTEGER,
          in_octets            INTEGER,
          out_octets           INTEGER,
          crc_errors           INTEGER,
          invalid_words        INTEGER,
          in_frames_per_sec    REAL,
          out_frames_per_sec   REAL,
          in_mb_per_sec        REAL,
          out_mb_per_sec       REAL,
          crc_errors_delta     INTEGER,
          interval_secs        INTEGER
        );
        CREATE INDEX IF NOT EXISTS idx_brocade_port_stats_source_port_ts ON brocade_port_stats(source_id, port_wwn, ts);
      `);
    },
  },
];
