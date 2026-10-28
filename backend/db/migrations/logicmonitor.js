// LogicMonitor (LM Envision) scope: lm_* tables. Blind build 2026-10-14 from
// the icc-logicmonitor-platform-plan research (v3 swagger, LM SDKs and the
// PowerShell module as ground truth; no live portal). Inventory tables are
// upserted by their LM id and marked stale = 1 when a poll no longer reports
// them (first_seen survives); history tables are appended and pruned by the
// poller per retention setting. 21 tables, plus four read-only views named
// logicmonitor_* that exist only because the dataset catalog requires a
// plugin dataset table to carry the '<platform id>_' prefix. Migration v3 adds
// three more tables (24 in all).
module.exports = [
  {
    version: 1,
    up(db) {
      db.exec(`
        CREATE TABLE IF NOT EXISTS lm_sources (
          id                         INTEGER PRIMARY KEY AUTOINCREMENT,
          name                       TEXT NOT NULL UNIQUE,
          company                    TEXT NOT NULL,
          auth_mode                  TEXT NOT NULL DEFAULT 'lmv1',
          encrypted_credentials      TEXT NOT NULL,
          verify_ssl                 INTEGER DEFAULT 1,
          enabled                    INTEGER DEFAULT 1,
          polling_interval_minutes   INTEGER DEFAULT 5,
          interface_poll_minutes     INTEGER DEFAULT 15,
          group_filter_json          TEXT,
          interface_categories_json  TEXT,
          features_json              TEXT,
          rate_limit_json            TEXT,
          last_poll_status           TEXT,
          last_poll_error            TEXT,
          last_poll_at               TEXT,
          last_interface_poll_at     TEXT,
          last_interface_poll_error  TEXT,
          section_errors             TEXT,
          last_hourly_at             TEXT,
          last_daily_at              TEXT,
          created_at                 TEXT DEFAULT (datetime('now'))
        );

        CREATE TABLE IF NOT EXISTS lm_devices (
          id                       INTEGER PRIMARY KEY AUTOINCREMENT,
          source_id                INTEGER NOT NULL REFERENCES lm_sources(id) ON DELETE CASCADE,
          lm_device_id             INTEGER NOT NULL,
          name                     TEXT,
          display_name             TEXT,
          description              TEXT,
          device_type              INTEGER,
          host_status              TEXT,
          alert_status             TEXT,
          alert_status_priority    INTEGER,
          sdt_status               TEXT,
          alert_disable_status     TEXT,
          disable_alerting         INTEGER,
          group_ids_json           TEXT,
          collector_id             INTEGER,
          preferred_collector_id   INTEGER,
          collector_description    TEXT,
          enable_netflow           INTEGER,
          uptime_seconds           INTEGER,
          created_epoch            INTEGER,
          updated_epoch            INTEGER,
          deleted_time_ms          INTEGER,
          sysinfo                  TEXT,
          sysoid                   TEXT,
          sysname                  TEXT,
          hostname                 TEXT,
          model                    TEXT,
          vendor                   TEXT,
          role                     TEXT,
          is_network               INTEGER DEFAULT 0,
          categories               TEXT,
          ips_json                 TEXT,
          version                  TEXT,
          serial                   TEXT,
          eri_json                 TEXT,
          ert                      TEXT,
          system_props_json        TEXT,
          auto_props_json          TEXT,
          custom_props_json        TEXT,
          if_count                 INTEGER DEFAULT 0,
          if_up                    INTEGER DEFAULT 0,
          dead_since               TEXT,
          first_seen               TEXT DEFAULT (datetime('now')),
          stale                    INTEGER DEFAULT 0,
          updated_at               TEXT DEFAULT (datetime('now')),
          UNIQUE(source_id, lm_device_id)
        );
        CREATE INDEX IF NOT EXISTS idx_lm_devices_display ON lm_devices(source_id, display_name);
        CREATE INDEX IF NOT EXISTS idx_lm_devices_name ON lm_devices(source_id, name);
        CREATE INDEX IF NOT EXISTS idx_lm_devices_collector ON lm_devices(source_id, collector_id);

        CREATE TABLE IF NOT EXISTS lm_device_groups (
          id                     INTEGER PRIMARY KEY AUTOINCREMENT,
          source_id              INTEGER NOT NULL REFERENCES lm_sources(id) ON DELETE CASCADE,
          lm_group_id            INTEGER NOT NULL,
          parent_id              INTEGER,
          name                   TEXT,
          full_path              TEXT,
          description            TEXT,
          group_type             TEXT,
          applies_to             TEXT,
          num_of_hosts           INTEGER,
          num_of_direct_devices  INTEGER,
          group_status           TEXT,
          disable_alerting       INTEGER,
          custom_props_json      TEXT,
          stale                  INTEGER DEFAULT 0,
          updated_at             TEXT DEFAULT (datetime('now')),
          UNIQUE(source_id, lm_group_id)
        );

        CREATE TABLE IF NOT EXISTS lm_device_datasources (
          id                         INTEGER PRIMARY KEY AUTOINCREMENT,
          source_id                  INTEGER NOT NULL REFERENCES lm_sources(id) ON DELETE CASCADE,
          lm_device_id               INTEGER NOT NULL,
          hds_id                     INTEGER NOT NULL,
          datasource_id              INTEGER,
          datasource_name            TEXT,
          datasource_display_name    TEXT,
          instance_count             INTEGER,
          monitoring_instance_count  INTEGER,
          alert_status               TEXT,
          sdt_status                 TEXT,
          stop_monitoring            INTEGER,
          is_interface               INTEGER DEFAULT 0,
          is_neighbor                INTEGER DEFAULT 0,
          refreshed_at               TEXT,
          UNIQUE(source_id, hds_id)
        );
        CREATE INDEX IF NOT EXISTS idx_lm_dds_device ON lm_device_datasources(source_id, lm_device_id);

        CREATE TABLE IF NOT EXISTS lm_interfaces (
          id                INTEGER PRIMARY KEY AUTOINCREMENT,
          source_id         INTEGER NOT NULL REFERENCES lm_sources(id) ON DELETE CASCADE,
          lm_device_id      INTEGER NOT NULL,
          hds_id            INTEGER,
          instance_id       INTEGER NOT NULL,
          instance_name     TEXT,
          display_name      TEXT,
          description       TEXT,
          if_index          INTEGER,
          status            INTEGER,
          status_text       TEXT,
          speed_bps         INTEGER,
          in_mbps           REAL,
          out_mbps          REAL,
          in_errors         REAL,
          out_errors        REAL,
          in_discards       REAL,
          out_discards      REAL,
          in_util_pct       REAL,
          out_util_pct      REAL,
          sampled_at_epoch  INTEGER,
          stop_monitoring   INTEGER,
          disable_alerting  INTEGER,
          alert_status      TEXT,
          sdt_status        TEXT,
          props_json        TEXT,
          stale             INTEGER DEFAULT 0,
          updated_at        TEXT DEFAULT (datetime('now')),
          UNIQUE(source_id, instance_id)
        );
        CREATE INDEX IF NOT EXISTS idx_lm_interfaces_device ON lm_interfaces(source_id, lm_device_id);

        CREATE TABLE IF NOT EXISTS lm_interface_history (
          id            INTEGER PRIMARY KEY AUTOINCREMENT,
          source_id     INTEGER NOT NULL REFERENCES lm_sources(id) ON DELETE CASCADE,
          instance_id   INTEGER NOT NULL,
          captured_at   TEXT DEFAULT (datetime('now')),
          status        INTEGER,
          in_mbps       REAL,
          out_mbps      REAL,
          in_errors     REAL,
          out_errors    REAL,
          in_discards   REAL,
          out_discards  REAL,
          in_util_pct   REAL,
          out_util_pct  REAL
        );
        CREATE INDEX IF NOT EXISTS idx_lm_if_hist_inst ON lm_interface_history(source_id, instance_id, captured_at);
        CREATE INDEX IF NOT EXISTS idx_lm_if_hist_at ON lm_interface_history(captured_at);

        CREATE TABLE IF NOT EXISTS lm_interface_daily (
          id                INTEGER PRIMARY KEY AUTOINCREMENT,
          source_id         INTEGER NOT NULL REFERENCES lm_sources(id) ON DELETE CASCADE,
          instance_id       INTEGER NOT NULL,
          day               TEXT NOT NULL,
          samples           INTEGER,
          down_samples      INTEGER,
          flaps             INTEGER,
          max_in_util_pct   REAL,
          max_out_util_pct  REAL,
          avg_in_util_pct   REAL,
          avg_out_util_pct  REAL,
          errors_sum        REAL,
          discards_sum      REAL,
          in_mbps_avg       REAL,
          out_mbps_avg      REAL,
          UNIQUE(source_id, instance_id, day)
        );
        CREATE INDEX IF NOT EXISTS idx_lm_if_daily_day ON lm_interface_daily(day);

        CREATE TABLE IF NOT EXISTS lm_alerts (
          id                      INTEGER PRIMARY KEY AUTOINCREMENT,
          source_id               INTEGER NOT NULL REFERENCES lm_sources(id) ON DELETE CASCADE,
          lm_alert_id             TEXT NOT NULL,
          internal_id             TEXT,
          type                    TEXT,
          severity                INTEGER,
          severity_norm           TEXT,
          lm_device_id            INTEGER,
          monitor_object_name     TEXT,
          monitor_object_type     TEXT,
          resource_template_name  TEXT,
          resource_template_type  TEXT,
          instance_id             INTEGER,
          instance_name           TEXT,
          instance_description    TEXT,
          data_point_name         TEXT,
          alert_value             TEXT,
          threshold               TEXT,
          clear_value             TEXT,
          start_epoch             INTEGER,
          end_epoch               INTEGER,
          acked                   INTEGER,
          acked_by                TEXT,
          ack_comment             TEXT,
          acked_epoch             INTEGER,
          sdted                   INTEGER,
          suppressor              TEXT,
          cleared                 INTEGER DEFAULT 0,
          closed_reason           TEXT,
          rule                    TEXT,
          rule_id                 INTEGER,
          chain                   TEXT,
          anomaly                 INTEGER,
          ad_alert                INTEGER,
          condition_key           TEXT NOT NULL,
          raw_json                TEXT,
          captured_at             TEXT DEFAULT (datetime('now')),
          updated_at              TEXT DEFAULT (datetime('now')),
          UNIQUE(source_id, lm_alert_id)
        );
        CREATE INDEX IF NOT EXISTS idx_lm_alerts_cleared ON lm_alerts(source_id, cleared);
        CREATE INDEX IF NOT EXISTS idx_lm_alerts_condition ON lm_alerts(source_id, condition_key);
        CREATE INDEX IF NOT EXISTS idx_lm_alerts_device ON lm_alerts(source_id, lm_device_id);
        CREATE INDEX IF NOT EXISTS idx_lm_alerts_start ON lm_alerts(source_id, start_epoch);

        CREATE TABLE IF NOT EXISTS lm_collectors (
          id                       INTEGER PRIMARY KEY AUTOINCREMENT,
          source_id                INTEGER NOT NULL REFERENCES lm_sources(id) ON DELETE CASCADE,
          collector_id             INTEGER NOT NULL,
          description              TEXT,
          hostname                 TEXT,
          group_id                 INTEGER,
          group_name               TEXT,
          status                   INTEGER,
          is_down                  INTEGER,
          acked                    INTEGER,
          in_sdt                   INTEGER,
          number_of_hosts          INTEGER,
          number_of_instances      INTEGER,
          build                    TEXT,
          platform                 TEXT,
          arch                     TEXT,
          size                     TEXT,
          uptime_seconds           INTEGER,
          updated_epoch            INTEGER,
          created_epoch            INTEGER,
          last_notification_epoch  INTEGER,
          backup_collector_id      INTEGER,
          collector_device_id      INTEGER,
          ea                       INTEGER,
          stale                    INTEGER DEFAULT 0,
          updated_at               TEXT DEFAULT (datetime('now')),
          UNIQUE(source_id, collector_id)
        );

        CREATE TABLE IF NOT EXISTS lm_sdts (
          id                   INTEGER PRIMARY KEY AUTOINCREMENT,
          source_id            INTEGER NOT NULL REFERENCES lm_sources(id) ON DELETE CASCADE,
          sdt_id               TEXT NOT NULL,
          sdt_type             TEXT,
          schedule_type        TEXT,
          is_effective         INTEGER,
          start_ms             INTEGER,
          end_ms               INTEGER,
          duration             INTEGER,
          admin                TEXT,
          comment              TEXT,
          lm_device_id         INTEGER,
          device_display_name  TEXT,
          group_id             INTEGER,
          group_full_path      TEXT,
          collector_id         INTEGER,
          datasource_name      TEXT,
          instance_id          INTEGER,
          website_id           INTEGER,
          raw_json             TEXT,
          stale                INTEGER DEFAULT 0,
          updated_at           TEXT DEFAULT (datetime('now')),
          UNIQUE(source_id, sdt_id)
        );

        CREATE TABLE IF NOT EXISTS lm_checks (
          id                   INTEGER PRIMARY KEY AUTOINCREMENT,
          source_id            INTEGER NOT NULL REFERENCES lm_sources(id) ON DELETE CASCADE,
          check_id             TEXT NOT NULL,
          kind                 TEXT,
          origin               TEXT,
          name                 TEXT,
          target               TEXT,
          description          TEXT,
          status               TEXT,
          alert_status         TEXT,
          sdt_status           TEXT,
          overall_alert_level  TEXT,
          polling_interval     INTEGER,
          transition           INTEGER,
          global_sm_alert_cond INTEGER,
          is_internal          INTEGER,
          stop_monitoring      INTEGER,
          disable_alerting     INTEGER,
          group_id             INTEGER,
          test_location_json   TEXT,
          collectors_json      TEXT,
          steps_json           TEXT,
          raw_json             TEXT,
          stale                INTEGER DEFAULT 0,
          updated_at           TEXT DEFAULT (datetime('now')),
          UNIQUE(source_id, check_id)
        );

        CREATE TABLE IF NOT EXISTS lm_check_locations (
          id                 INTEGER PRIMARY KEY AUTOINCREMENT,
          source_id          INTEGER NOT NULL REFERENCES lm_sources(id) ON DELETE CASCADE,
          check_id           TEXT NOT NULL,
          checkpoint_id      TEXT NOT NULL,
          lm_checkpoint_id   INTEGER,
          hds_id             INTEGER,
          instance_name      TEXT,
          label              TEXT,
          smg_id             INTEGER,
          collector_id       INTEGER,
          is_overall         INTEGER DEFAULT 0,
          last_status        TEXT,
          last_rtt_ms        REAL,
          last_loss_pct      REAL,
          last_response_ms   REAL,
          last_sample_epoch  INTEGER,
          stale              INTEGER DEFAULT 0,
          updated_at         TEXT DEFAULT (datetime('now')),
          UNIQUE(source_id, check_id, checkpoint_id)
        );

        CREATE TABLE IF NOT EXISTS lm_check_history (
          id             INTEGER PRIMARY KEY AUTOINCREMENT,
          source_id      INTEGER NOT NULL REFERENCES lm_sources(id) ON DELETE CASCADE,
          check_id       TEXT NOT NULL,
          checkpoint_id  TEXT NOT NULL,
          captured_at    TEXT DEFAULT (datetime('now')),
          sample_epoch   INTEGER,
          status         TEXT,
          rtt_avg_ms     REAL,
          rtt_min_ms     REAL,
          rtt_max_ms     REAL,
          loss_pct       REAL,
          response_ms    REAL,
          raw_json       TEXT
        );
        CREATE INDEX IF NOT EXISTS idx_lm_check_hist_cp ON lm_check_history(source_id, check_id, checkpoint_id, captured_at);
        CREATE INDEX IF NOT EXISTS idx_lm_check_hist_at ON lm_check_history(captured_at);
        CREATE INDEX IF NOT EXISTS idx_lm_check_hist_sample ON lm_check_history(source_id, check_id, checkpoint_id, sample_epoch);

        CREATE TABLE IF NOT EXISTS lm_check_baseline (
          id               INTEGER PRIMARY KEY AUTOINCREMENT,
          source_id        INTEGER NOT NULL REFERENCES lm_sources(id) ON DELETE CASCADE,
          check_id         TEXT NOT NULL,
          checkpoint_id    TEXT NOT NULL,
          hour_of_day      INTEGER NOT NULL,
          samples          INTEGER,
          rtt_median       REAL,
          rtt_mad          REAL,
          loss_median      REAL,
          loss_mad         REAL,
          response_median  REAL,
          response_mad     REAL,
          computed_at      TEXT,
          UNIQUE(source_id, check_id, checkpoint_id, hour_of_day)
        );

        CREATE TABLE IF NOT EXISTS lm_check_daily (
          id             INTEGER PRIMARY KEY AUTOINCREMENT,
          source_id      INTEGER NOT NULL REFERENCES lm_sources(id) ON DELETE CASCADE,
          check_id       TEXT NOT NULL,
          checkpoint_id  TEXT NOT NULL,
          day            TEXT NOT NULL,
          samples        INTEGER,
          down_samples   INTEGER,
          rtt_avg        REAL,
          rtt_p95        REAL,
          loss_avg       REAL,
          loss_max       REAL,
          response_avg   REAL,
          UNIQUE(source_id, check_id, checkpoint_id, day)
        );
        CREATE INDEX IF NOT EXISTS idx_lm_check_daily_day ON lm_check_daily(day);

        CREATE TABLE IF NOT EXISTS lm_topology_links (
          id               INTEGER PRIMARY KEY AUTOINCREMENT,
          source_id        INTEGER NOT NULL REFERENCES lm_sources(id) ON DELETE CASCADE,
          src_device_id    INTEGER,
          src_instance_id  INTEGER,
          src_port         TEXT,
          dst_device_id    INTEGER,
          dst_name         TEXT,
          dst_port         TEXT,
          protocol         TEXT,
          confidence       TEXT,
          first_seen       TEXT DEFAULT (datetime('now')),
          last_seen        TEXT,
          stale            INTEGER DEFAULT 0,
          UNIQUE(source_id, src_instance_id, protocol)
        );
        CREATE INDEX IF NOT EXISTS idx_lm_links_src ON lm_topology_links(source_id, src_device_id);
        CREATE INDEX IF NOT EXISTS idx_lm_links_dst ON lm_topology_links(source_id, dst_device_id);

        CREATE TABLE IF NOT EXISTS lm_admins (
          id                INTEGER PRIMARY KEY AUTOINCREMENT,
          source_id         INTEGER NOT NULL REFERENCES lm_sources(id) ON DELETE CASCADE,
          admin_id          INTEGER NOT NULL,
          username          TEXT,
          email             TEXT,
          status            TEXT,
          roles_json        TEXT,
          api_token_count   INTEGER,
          apionly           INTEGER,
          last_login_epoch  INTEGER,
          two_fa            INTEGER,
          created_by        TEXT,
          stale             INTEGER DEFAULT 0,
          updated_at        TEXT DEFAULT (datetime('now')),
          UNIQUE(source_id, admin_id)
        );

        CREATE TABLE IF NOT EXISTS lm_roles (
          id                INTEGER PRIMARY KEY AUTOINCREMENT,
          source_id         INTEGER NOT NULL REFERENCES lm_sources(id) ON DELETE CASCADE,
          role_id           INTEGER NOT NULL,
          name              TEXT,
          description       TEXT,
          user_count        INTEGER,
          two_fa_required   INTEGER,
          privileges_json   TEXT,
          stale             INTEGER DEFAULT 0,
          updated_at        TEXT DEFAULT (datetime('now')),
          UNIQUE(source_id, role_id)
        );

        CREATE TABLE IF NOT EXISTS lm_issue_history (
          id           INTEGER PRIMARY KEY AUTOINCREMENT,
          issue_key    TEXT NOT NULL,
          source       TEXT,
          severity     TEXT,
          type         TEXT,
          target       TEXT,
          message      TEXT,
          status       TEXT DEFAULT 'open',
          first_seen   TEXT DEFAULT (datetime('now')),
          last_seen    TEXT DEFAULT (datetime('now')),
          resolved_at  TEXT
        );
        CREATE INDEX IF NOT EXISTS idx_lm_issue_hist_key ON lm_issue_history(issue_key, status);
        CREATE INDEX IF NOT EXISTS idx_lm_issue_hist_seen ON lm_issue_history(last_seen);

        CREATE TABLE IF NOT EXISTS lm_metrics_history (
          id                      INTEGER PRIMARY KEY AUTOINCREMENT,
          source_id               INTEGER NOT NULL REFERENCES lm_sources(id) ON DELETE CASCADE,
          captured_at             TEXT DEFAULT (datetime('now')),
          devices_total           INTEGER,
          devices_normal          INTEGER,
          devices_dead            INTEGER,
          devices_dead_collector  INTEGER,
          devices_in_sdt          INTEGER,
          network_devices         INTEGER,
          interfaces_total        INTEGER,
          interfaces_up           INTEGER,
          interfaces_down         INTEGER,
          alerts_critical         INTEGER,
          alerts_error            INTEGER,
          alerts_warning          INTEGER,
          alerts_acked            INTEGER,
          collectors_total        INTEGER,
          collectors_down         INTEGER,
          checks_total            INTEGER,
          checks_down             INTEGER,
          checks_degraded         INTEGER
        );
        CREATE INDEX IF NOT EXISTS idx_lm_metrics_src ON lm_metrics_history(source_id, captured_at);
        CREATE INDEX IF NOT EXISTS idx_lm_metrics_at ON lm_metrics_history(captured_at);

        CREATE TABLE IF NOT EXISTS lm_ai_reports (
          report_key    TEXT PRIMARY KEY,
          model         TEXT,
          content       TEXT NOT NULL,
          generated_at  DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
        );

        CREATE VIEW IF NOT EXISTS logicmonitor_devices AS
          SELECT d.source_id, d.lm_device_id, d.display_name, d.name, d.vendor, d.role, d.model, d.version,
                 d.host_status, d.alert_status, d.is_network, d.collector_id, d.if_count, d.if_up,
                 d.uptime_seconds, d.first_seen
          FROM lm_devices d WHERE d.stale = 0;

        CREATE VIEW IF NOT EXISTS logicmonitor_interfaces AS
          SELECT i.source_id, i.lm_device_id, d.display_name AS device_name, i.instance_id,
                 i.display_name, i.description, i.status_text, i.speed_bps, i.in_mbps, i.out_mbps,
                 i.in_errors, i.out_errors, i.in_discards, i.out_discards, i.in_util_pct, i.out_util_pct
          FROM lm_interfaces i
          LEFT JOIN lm_devices d ON d.source_id = i.source_id AND d.lm_device_id = i.lm_device_id
          WHERE i.stale = 0;

        CREATE VIEW IF NOT EXISTS logicmonitor_alerts AS
          SELECT a.source_id, a.lm_alert_id, a.severity_norm, a.monitor_object_name, a.resource_template_name,
                 a.instance_name, a.data_point_name, a.alert_value, a.threshold, a.start_epoch, a.acked,
                 a.sdted, a.cleared, a.condition_key
          FROM lm_alerts a;

        CREATE VIEW IF NOT EXISTS logicmonitor_checks AS
          SELECT l.source_id, l.check_id, c.name AS check_name, c.kind, c.origin, c.target, l.checkpoint_id,
                 l.label, l.is_overall, l.last_status, l.last_rtt_ms, l.last_loss_pct, l.last_response_ms,
                 l.last_sample_epoch
          FROM lm_check_locations l
          JOIN lm_checks c ON c.source_id = l.source_id AND c.check_id = l.check_id
          WHERE l.stale = 0 AND c.stale = 0;
      `);
    },
  },

  // Migration v2: cross-platform endpoint resolution on topology links. A far
  // end that resolved to an LM device carries dst_platform 'logicmonitor'; one
  // that resolved to another ICC platform's host inventory carries that
  // platform id ('vcenter', 'dell', 'unifi', ...) and dst_ref, the matched ICC
  // name lower-cased. Guarded ALTERs so a re-run cannot fail on a duplicate
  // column.
  {
    version: 2,
    up(db) {
      const cols = db.prepare("PRAGMA table_info('lm_topology_links')").all().map((c) => c.name);
      if (!cols.includes('dst_platform')) db.exec('ALTER TABLE lm_topology_links ADD COLUMN dst_platform TEXT');
      if (!cols.includes('dst_ref')) db.exec('ALTER TABLE lm_topology_links ADD COLUMN dst_ref TEXT');
      db.exec(`
        UPDATE lm_topology_links SET dst_platform = 'logicmonitor'
        WHERE dst_device_id IS NOT NULL AND dst_platform IS NULL;
        CREATE INDEX IF NOT EXISTS idx_lm_links_dst_platform ON lm_topology_links(source_id, dst_platform);
      `);
    },
  },

  // Migration v3 (round 3): sites, dependency suppression, WAN circuits,
  // interface baselines and the alert webhook. Additive only. Guarded ALTERs
  // so a re-run (or a database that took some columns from a pack) cannot
  // fail on a duplicate column; every new table is IF NOT EXISTS.
  {
    version: 3,
    up(db) {
      const addCol = (table, col, ddl) => {
        const cols = db.prepare(`PRAGMA table_info('${table}')`).all().map((c) => c.name);
        if (!cols.includes(col)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${col} ${ddl}`);
      };
      addCol('lm_sources', 'site_rule_json', 'TEXT');
      addCol('lm_sources', 'webhook_token_hash', 'TEXT');
      addCol('lm_sources', 'webhook_enabled', 'INTEGER DEFAULT 0');
      addCol('lm_sources', 'webhook_last_at', 'TEXT');
      addCol('lm_sources', 'webhook_count', 'INTEGER DEFAULT 0');
      addCol('lm_sources', 'webhook_last_error', 'TEXT');
      addCol('lm_devices', 'site_key', 'TEXT');
      addCol('lm_devices', 'site_name', 'TEXT');
      addCol('lm_devices', 'site_source', 'TEXT');
      addCol('lm_devices', 'tier', 'INTEGER');
      addCol('lm_collectors', 'site_key', 'TEXT');
      addCol('lm_collectors', 'site_name', 'TEXT');
      addCol('lm_checks', 'site_key', 'TEXT');
      addCol('lm_checks', 'site_name', 'TEXT');
      addCol('lm_check_locations', 'site_key', 'TEXT');
      addCol('lm_alerts', 'shadowed_by', 'TEXT');
      addCol('lm_alerts', 'ingest', 'TEXT');
      addCol('lm_interfaces', 'is_wan', 'INTEGER DEFAULT 0');
      addCol('lm_interfaces', 'wan_reason', 'TEXT');
      addCol('lm_interfaces', 'wan_label', 'TEXT');
      db.exec(`
        CREATE TABLE IF NOT EXISTS lm_sites (
          id                  INTEGER PRIMARY KEY AUTOINCREMENT,
          source_id           INTEGER NOT NULL REFERENCES lm_sources(id) ON DELETE CASCADE,
          site_key            TEXT NOT NULL,
          site_name           TEXT,
          device_count        INTEGER DEFAULT 0,
          network_count       INTEGER DEFAULT 0,
          collector_ids_json  TEXT,
          updated_at          TEXT DEFAULT (datetime('now')),
          UNIQUE(source_id, site_key)
        );

        CREATE TABLE IF NOT EXISTS lm_interface_baseline (
          id           INTEGER PRIMARY KEY AUTOINCREMENT,
          source_id    INTEGER NOT NULL REFERENCES lm_sources(id) ON DELETE CASCADE,
          instance_id  INTEGER NOT NULL,
          hour_of_day  INTEGER NOT NULL,
          samples      INTEGER,
          util_median  REAL,
          util_mad     REAL,
          err_median   REAL,
          err_mad      REAL,
          computed_at  TEXT,
          UNIQUE(source_id, instance_id, hour_of_day)
        );

        CREATE TABLE IF NOT EXISTS lm_webhook_events (
          id           INTEGER PRIMARY KEY AUTOINCREMENT,
          source_id    INTEGER NOT NULL REFERENCES lm_sources(id) ON DELETE CASCADE,
          received_at  TEXT DEFAULT (datetime('now')),
          status       TEXT,
          lm_alert_id  TEXT,
          internal_id  TEXT,
          host         TEXT,
          accepted     INTEGER,
          error        TEXT,
          raw_json     TEXT
        );
        CREATE INDEX IF NOT EXISTS idx_lm_webhook_events_at ON lm_webhook_events(source_id, received_at);

        CREATE INDEX IF NOT EXISTS idx_lm_devices_site ON lm_devices(site_key);
        CREATE INDEX IF NOT EXISTS idx_lm_alerts_shadowed ON lm_alerts(shadowed_by);
        CREATE INDEX IF NOT EXISTS idx_lm_interfaces_wan ON lm_interfaces(is_wan);
        CREATE INDEX IF NOT EXISTS idx_lm_if_baseline_inst ON lm_interface_baseline(source_id, instance_id);
      `);
    },
  },
  // Migration v4 (round 4): blame history for the Correlation page. One row
  // per (issue, hop) when a check issue opens or its hop changes, plus
  // 'server' blames from the server-path view. Retention 90 days (poller prune).
  {
    version: 4,
    up(db) {
      db.exec(`
        CREATE TABLE IF NOT EXISTS lm_blame_history (
          id                INTEGER PRIMARY KEY AUTOINCREMENT,
          source_id         INTEGER NOT NULL REFERENCES lm_sources(id) ON DELETE CASCADE,
          at                TEXT DEFAULT (datetime('now')),
          kind              TEXT,
          subject           TEXT,
          subject_key       TEXT,
          checkpoint_label  TEXT,
          hop_device_id     INTEGER,
          hop_device_name   TEXT,
          hop_port          TEXT,
          hop_state         TEXT,
          hop_reason        TEXT,
          site_key          TEXT,
          issue_key         TEXT
        );
        CREATE INDEX IF NOT EXISTS idx_lm_blame_at ON lm_blame_history(source_id, at);
        CREATE INDEX IF NOT EXISTS idx_lm_blame_hop ON lm_blame_history(source_id, hop_device_id, hop_port);
      `);
    },
  },
  // Migration v5 (round 8): DataSource metric collector. lm_ds_instances is the
  // instance inventory per device DataSource, lm_ds_metrics the latest value per
  // instance and canonical metric, lm_ds_metrics_history the optional series.
  // Guarded ALTERs for the source and datasource bookkeeping columns.
  {
    version: 5,
    up(db) {
      const addCol = (table, col, ddl) => {
        const cols = db.prepare(`PRAGMA table_info('${table}')`).all().map((c) => c.name);
        if (!cols.includes(col)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${col} ${ddl}`);
      };
      addCol('lm_sources', 'metrics_poll_minutes', 'INTEGER DEFAULT 30');
      addCol('lm_sources', 'metrics_families_json', 'TEXT');
      addCol('lm_device_datasources', 'metrics_last_at', 'TEXT');
      addCol('lm_device_datasources', 'metrics_last_error', 'TEXT');
      db.exec(`
        CREATE TABLE IF NOT EXISTS lm_ds_instances (
          id              INTEGER PRIMARY KEY AUTOINCREMENT,
          source_id       INTEGER NOT NULL REFERENCES lm_sources(id) ON DELETE CASCADE,
          lm_device_id    INTEGER NOT NULL,
          hds_id          INTEGER NOT NULL,
          datasource_name TEXT NOT NULL,
          family          TEXT NOT NULL,
          instance_key    TEXT NOT NULL,
          instance_name   TEXT,
          stale           INTEGER DEFAULT 0,
          first_seen      TEXT DEFAULT (datetime('now')),
          updated_at      TEXT DEFAULT (datetime('now')),
          UNIQUE(source_id, lm_device_id, hds_id, instance_key)
        );
        CREATE TABLE IF NOT EXISTS lm_ds_metrics (
          id               INTEGER PRIMARY KEY AUTOINCREMENT,
          source_id        INTEGER NOT NULL REFERENCES lm_sources(id) ON DELETE CASCADE,
          lm_device_id     INTEGER NOT NULL,
          hds_id           INTEGER NOT NULL,
          datasource_name  TEXT NOT NULL,
          family           TEXT NOT NULL,
          instance_key     TEXT NOT NULL,
          metric           TEXT NOT NULL,
          datapoint        TEXT,
          value            REAL,
          sampled_at_epoch INTEGER,
          updated_at       TEXT DEFAULT (datetime('now')),
          UNIQUE(source_id, lm_device_id, hds_id, instance_key, metric)
        );
        CREATE INDEX IF NOT EXISTS idx_lm_ds_metrics_dev ON lm_ds_metrics(source_id, lm_device_id, family);
        CREATE INDEX IF NOT EXISTS idx_lm_ds_metrics_fam ON lm_ds_metrics(source_id, family, metric);
        CREATE TABLE IF NOT EXISTS lm_ds_metrics_history (
          id               INTEGER PRIMARY KEY AUTOINCREMENT,
          source_id        INTEGER NOT NULL REFERENCES lm_sources(id) ON DELETE CASCADE,
          lm_device_id     INTEGER NOT NULL,
          hds_id           INTEGER NOT NULL,
          instance_key     TEXT NOT NULL,
          metric           TEXT NOT NULL,
          value            REAL,
          sampled_at_epoch INTEGER NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_lm_ds_hist ON lm_ds_metrics_history(source_id, lm_device_id, hds_id, instance_key, metric, sampled_at_epoch);
      `);
    },
  },
  // Migration v6 (round 9): latency watch. lm_latency_episodes is one row per
  // episode of a check location (subject_kind 'check'; 'ipsla' is reserved for
  // the IP SLA watch). check_id and checkpoint_id are TEXT here because the
  // lm_check_* tables hold them as TEXT. lm_check_reference is the frozen
  // multi-week reference median per hour (drift). absent_polls is the
  // hysteresis counter on lm_issue_history.
  {
    version: 6,
    up(db) {
      const addCol = (table, col, ddl) => {
        const cols = db.prepare(`PRAGMA table_info('${table}')`).all().map((c) => c.name);
        if (!cols.includes(col)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${col} ${ddl}`);
      };
      db.exec(`
        CREATE TABLE IF NOT EXISTS lm_latency_episodes (
          id                  INTEGER PRIMARY KEY AUTOINCREMENT,
          source_id           INTEGER NOT NULL,
          subject_kind        TEXT NOT NULL,
          check_id            TEXT,
          checkpoint_id       TEXT,
          subject_key         TEXT NOT NULL,
          subject_label       TEXT,
          site_key            TEXT,
          kind                TEXT NOT NULL,
          state               TEXT NOT NULL,
          outcome             TEXT,
          opened_at           TEXT NOT NULL,
          promoted_at         TEXT,
          closed_at           TEXT,
          last_sample_epoch   INTEGER,
          samples             INTEGER DEFAULT 0,
          elevated_samples    INTEGER DEFAULT 0,
          consecutive_normal  INTEGER DEFAULT 0,
          baseline_median     REAL,
          baseline_mad        REAL,
          baseline_samples    INTEGER,
          peak_ms             REAL,
          peak_ratio          REAL,
          loss_max_pct        REAL,
          area_over_baseline  REAL DEFAULT 0,
          likely_hop          TEXT,
          likely_hop_device_id INTEGER,
          issue_key           TEXT,
          trend_json          TEXT,
          run_start_epoch     INTEGER,
          severe_run          INTEGER DEFAULT 0,
          severe_since_epoch  INTEGER,
          promote_reason      TEXT,
          last_elevated_epoch INTEGER
        );
        CREATE INDEX IF NOT EXISTS idx_lm_episodes_subject ON lm_latency_episodes(source_id, subject_key, opened_at);
        CREATE INDEX IF NOT EXISTS idx_lm_episodes_state ON lm_latency_episodes(state);
        CREATE TABLE IF NOT EXISTS lm_check_reference (
          source_id     INTEGER NOT NULL,
          check_id      TEXT NOT NULL,
          checkpoint_id TEXT NOT NULL,
          hour_of_day   INTEGER NOT NULL,
          samples       INTEGER,
          rtt_median    REAL,
          loss_median   REAL,
          computed_at   TEXT,
          PRIMARY KEY (source_id, check_id, checkpoint_id, hour_of_day)
        );
      `);
      addCol('lm_issue_history', 'absent_polls', 'INTEGER DEFAULT 0');
    },
  },
  // Migration v7 (round 9). WP6 part: lm_alerts.duplicate_of marks an open LM
  // alert that relays a feed ICC polls directly ('duplicate:<platform>').
  // shadowed_by is a JSON dependency culprit, so it cannot carry this.
  {
    version: 7,
    up(db) {
      const addCol = (table, col, ddl) => {
        const cols = db.prepare(`PRAGMA table_info('${table}')`).all().map((c) => c.name);
        if (!cols.includes(col)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${col} ${ddl}`);
      };
      addCol('lm_alerts', 'duplicate_of', 'TEXT');
      // WP7 part: hour-of-day baselines for history-bearing DataSource metrics (IP SLA).
      db.exec(`
        CREATE TABLE IF NOT EXISTS lm_ds_metric_baseline (
          source_id    INTEGER NOT NULL,
          lm_device_id INTEGER NOT NULL,
          hds_id       INTEGER NOT NULL,
          instance_key TEXT NOT NULL,
          metric       TEXT NOT NULL,
          hour_of_day  INTEGER NOT NULL,
          samples      INTEGER,
          median       REAL,
          mad          REAL,
          computed_at  TEXT,
          PRIMARY KEY (source_id, lm_device_id, hds_id, instance_key, metric, hour_of_day)
        );
      `);
    },
  },
  // Migration v8 (round 10, WP-A). Neighbours that CDP/LLDP show on LogicMonitor's own
  // discovery (predef.externalResourceID) but that no LM device or ICC host explains.
  {
    version: 8,
    up(db) {
      db.exec(`
        CREATE TABLE IF NOT EXISTS lm_unmonitored_neighbors (
          id                   INTEGER PRIMARY KEY AUTOINCREMENT,
          source_id            INTEGER NOT NULL REFERENCES lm_sources(id) ON DELETE CASCADE,
          neighbor_key         TEXT NOT NULL,
          neighbor_name        TEXT,
          kind                 TEXT,
          ports_seen           INTEGER DEFAULT 0,
          devices_seen         INTEGER DEFAULT 0,
          first_seen           TEXT DEFAULT (datetime('now')),
          last_seen            TEXT,
          sample_src_device_id INTEGER,
          sample_src_port      TEXT,
          stale                INTEGER DEFAULT 0,
          UNIQUE(source_id, neighbor_key)
        );
      `);
    },
  },
  // Migration v9 (round 11, WP-R). Raw DataSource ingestion: the latest value of every
  // datapoint of every instance of every DataSource with data, whether or not the catalog
  // names it, plus an estate-wide datapoint catalog so real names can be read back.
  {
    version: 9,
    up(db) {
      const addCol = (table, col, ddl) => {
        const cols = db.prepare(`PRAGMA table_info('${table}')`).all().map((c) => c.name);
        if (!cols.includes(col)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${col} ${ddl}`);
      };
      db.exec(`
        CREATE TABLE IF NOT EXISTS lm_ds_values (
          source_id INTEGER NOT NULL, lm_device_id INTEGER NOT NULL, hds_id INTEGER NOT NULL,
          datasource_name TEXT NOT NULL, instance_key TEXT NOT NULL, instance_name TEXT,
          datapoint TEXT NOT NULL, value REAL, value_text TEXT, sampled_at_epoch INTEGER, updated_at TEXT,
          PRIMARY KEY (source_id, lm_device_id, hds_id, instance_key, datapoint)
        );
        CREATE INDEX IF NOT EXISTS idx_lm_ds_values_device ON lm_ds_values(source_id, lm_device_id);
        CREATE INDEX IF NOT EXISTS idx_lm_ds_values_ds ON lm_ds_values(source_id, datasource_name);
        CREATE TABLE IF NOT EXISTS lm_ds_datapoints (
          source_id INTEGER NOT NULL, datasource_name TEXT NOT NULL, datapoint TEXT NOT NULL,
          devices INTEGER, instances INTEGER, numeric INTEGER, first_seen TEXT, last_seen TEXT, catalog_metric TEXT,
          PRIMARY KEY (source_id, datasource_name, datapoint)
        );
      `);
      addCol('lm_device_datasources', 'raw_last_at', 'TEXT');
      addCol('lm_device_datasources', 'raw_last_error', 'TEXT');
      addCol('lm_sources', 'raw_poll_enabled', 'INTEGER DEFAULT 1');
      addCol('lm_sources', 'raw_calls_per_tick', 'INTEGER DEFAULT 600');
      addCol('lm_sources', 'raw_history_json', 'TEXT');
    },
  },
  // Migration v10 (round 13, WP-A). Circuit role (wan / site-link / uplink), per-site WAN
  // state, and an event log of circuit transitions with operator notes.
  {
    version: 10,
    up(db) {
      const addCol = (table, col, ddl) => {
        const cols = db.prepare(`PRAGMA table_info('${table}')`).all().map((c) => c.name);
        if (!cols.includes(col)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${col} ${ddl}`);
      };
      addCol('lm_interfaces', 'circuit_role', 'TEXT');
      addCol('lm_interfaces', 'circuit_far_site_key', 'TEXT');
      addCol('lm_interfaces', 'circuit_role_reason', 'TEXT');
      addCol('lm_sites', 'wan_state', 'TEXT');
      addCol('lm_sites', 'wan_total', 'INTEGER');
      addCol('lm_sites', 'wan_down', 'INTEGER');
      addCol('lm_sites', 'wan_flapping', 'INTEGER');
      addCol('lm_sites', 'wan_updated_at', 'TEXT');
      db.exec(`
        CREATE TABLE IF NOT EXISTS lm_circuit_events (
          id             INTEGER PRIMARY KEY AUTOINCREMENT,
          source_id      INTEGER NOT NULL REFERENCES lm_sources(id) ON DELETE CASCADE,
          instance_id    INTEGER,
          device_name    TEXT,
          port           TEXT,
          site_key       TEXT,
          far_site_key   TEXT,
          role           TEXT,
          event          TEXT NOT NULL,
          at             TEXT NOT NULL,
          details_json   TEXT,
          note           TEXT,
          noted_by       TEXT,
          noted_at       TEXT,
          issue_key      TEXT
        );
        CREATE INDEX IF NOT EXISTS idx_lm_circuit_events_inst ON lm_circuit_events(source_id, instance_id, at);
        CREATE INDEX IF NOT EXISTS idx_lm_circuit_events_site ON lm_circuit_events(site_key, at);
      `);
    },
  },

  // Migration v11. Open-alert lookups ("WHERE cleared = 0" with no source_id)
  // scanned the whole table; every other index starts with source_id.
  {
    version: 11,
    up(db) {
      db.exec('CREATE INDEX IF NOT EXISTS idx_lm_alerts_open ON lm_alerts(cleared);');
    },
  },

  // Migration v12. Long-term daily history: one row per object per UTC day
  // (samples, min, sum, max, last), written incrementally at sample time.
  {
    version: 12,
    up(db) {
      db.exec(`
        CREATE TABLE IF NOT EXISTS lm_ds_daily (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          source_id INTEGER NOT NULL REFERENCES lm_sources(id) ON DELETE CASCADE,
          lm_device_id INTEGER NOT NULL, hds_id INTEGER NOT NULL,
          datasource_name TEXT, instance_key TEXT NOT NULL, metric TEXT NOT NULL,
          kind TEXT NOT NULL DEFAULT 'catalog',
          day TEXT NOT NULL,
          samples INTEGER NOT NULL DEFAULT 0,
          min_value REAL, sum_value REAL, max_value REAL, last_value REAL, last_epoch INTEGER,
          UNIQUE(source_id, lm_device_id, hds_id, instance_key, metric, day)
        );
        CREATE INDEX IF NOT EXISTS idx_lm_ds_daily_device ON lm_ds_daily(source_id, lm_device_id, day);

        CREATE TABLE IF NOT EXISTS lm_device_daily (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          source_id INTEGER NOT NULL REFERENCES lm_sources(id) ON DELETE CASCADE,
          lm_device_id INTEGER NOT NULL, day TEXT NOT NULL,
          samples INTEGER NOT NULL DEFAULT 0,
          dead_samples INTEGER NOT NULL DEFAULT 0, dead_collector_samples INTEGER NOT NULL DEFAULT 0,
          sdt_samples INTEGER NOT NULL DEFAULT 0,
          worst_host_status TEXT,
          alerts_opened INTEGER NOT NULL DEFAULT 0, alerts_critical INTEGER NOT NULL DEFAULT 0,
          alerts_warning INTEGER NOT NULL DEFAULT 0,
          UNIQUE(source_id, lm_device_id, day)
        );
        CREATE INDEX IF NOT EXISTS idx_lm_device_daily_day ON lm_device_daily(source_id, day);
      `);
    },
  },

  // Migration v13. dataSourceType per device DataSource row ("DS" DataSource, "CS"
  // ConfigSource). The metrics sweep asked the data endpoint for ConfigSource rows and
  // LogicMonitor answered HTTP 400 "ConfigureSource<id> is not supported" every tick
  // (CG box, PaloAlto_FW_RunningConfigXML, 2026-10-28).
  {
    version: 13,
    up(db) {
      const cols = db.prepare("PRAGMA table_info('lm_device_datasources')").all().map((c) => c.name);
      if (!cols.includes('datasource_type')) db.exec('ALTER TABLE lm_device_datasources ADD COLUMN datasource_type TEXT');
    },
  },
];
