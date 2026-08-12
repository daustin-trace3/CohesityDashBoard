// Unifi scope: unifi_* tables. Per-source direct-connection model (like
// vcenter/nutanix) — multiple UniFi controllers supported. Inventory tables
// (devices/ports/clients/wlans/networks/rogue_aps) are replaced per source
// (or per source+site where the table carries a site column) each poll; a
// failed section keeps prior rows (see unifiPoller.js trySection). History/
// events/issue tables append and self-retain. Single version — ships whole.
//
// Deviation flag (WP1, see contract §DB SCHEMA vs §ROUTES /overview): the
// contract's exact table list has no place to persist the live health
// subsystem snapshot (`health:[{subsystem,status,numSta}]`) that GET
// /overview must serve from the DB (never a live call on every request).
// Added one additive column, unifi_sources.health_json, to close that gap —
// no listed table/column was removed or renamed.
module.exports = [
  {
    version: 1,
    up(db) {
      db.exec(`
        CREATE TABLE IF NOT EXISTS unifi_sources (
          id                        INTEGER PRIMARY KEY AUTOINCREMENT,
          name                      TEXT NOT NULL UNIQUE,
          host                      TEXT NOT NULL,
          port                      INTEGER DEFAULT 443,
          encrypted_credentials     TEXT,
          ssl_verify                INTEGER DEFAULT 0,
          polling_interval_minutes  INTEGER DEFAULT 10,
          sites_json                TEXT,
          controller_version        TEXT,
          health_json               TEXT,
          last_poll_status          TEXT,
          last_poll_error           TEXT,
          last_poll_at              TEXT,
          created_at                TEXT DEFAULT CURRENT_TIMESTAMP
        );

        CREATE TABLE IF NOT EXISTS unifi_devices (
          id             INTEGER PRIMARY KEY AUTOINCREMENT,
          source_id      INTEGER NOT NULL REFERENCES unifi_sources(id) ON DELETE CASCADE,
          site           TEXT DEFAULT 'default',
          mac            TEXT NOT NULL,
          device_id      TEXT,
          name           TEXT,
          model          TEXT,
          shortname      TEXT,
          type           TEXT,
          ip             TEXT,
          version        TEXT,
          state          INTEGER,
          adopted        INTEGER,
          upgradable     INTEGER,
          overheating    INTEGER,
          serial         TEXT,
          uptime         INTEGER,
          cpu_pct        REAL,
          mem_pct        REAL,
          temps_json     TEXT,
          satisfaction   INTEGER,
          num_sta        INTEGER,
          tx_bytes       INTEGER,
          rx_bytes       INTEGER,
          uplink_mac     TEXT,
          uplink_port    INTEGER,
          uplink_type    TEXT,
          radios_json    TEXT,
          is_gateway     INTEGER DEFAULT 0,
          last_seen      INTEGER,
          UNIQUE(source_id, mac)
        );
        CREATE INDEX IF NOT EXISTS idx_unifi_devices_source ON unifi_devices(source_id);

        CREATE TABLE IF NOT EXISTS unifi_ports (
          id              INTEGER PRIMARY KEY AUTOINCREMENT,
          source_id       INTEGER NOT NULL REFERENCES unifi_sources(id) ON DELETE CASCADE,
          device_mac      TEXT NOT NULL,
          port_idx        INTEGER NOT NULL,
          name            TEXT,
          media           TEXT,
          up              INTEGER,
          speed           INTEGER,
          full_duplex     INTEGER,
          is_uplink       INTEGER,
          poe_capable     INTEGER,
          poe_enable      INTEGER,
          poe_good        INTEGER,
          poe_power       REAL,
          poe_current     REAL,
          poe_voltage     REAL,
          poe_class       TEXT,
          rx_bytes        INTEGER,
          tx_bytes        INTEGER,
          rx_errors       INTEGER,
          tx_errors       INTEGER,
          rx_dropped      INTEGER,
          tx_dropped      INTEGER,
          network_name    TEXT,
          speed_caps      INTEGER,
          aggregated_by   INTEGER,
          UNIQUE(source_id, device_mac, port_idx)
        );
        CREATE INDEX IF NOT EXISTS idx_unifi_ports_source ON unifi_ports(source_id);
        CREATE INDEX IF NOT EXISTS idx_unifi_ports_device ON unifi_ports(source_id, device_mac);

        CREATE TABLE IF NOT EXISTS unifi_port_history (
          id            INTEGER PRIMARY KEY AUTOINCREMENT,
          source_id     INTEGER NOT NULL REFERENCES unifi_sources(id) ON DELETE CASCADE,
          device_mac    TEXT NOT NULL,
          port_idx      INTEGER NOT NULL,
          captured_at   TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
          up            INTEGER,
          speed         INTEGER,
          poe_power     REAL,
          poe_voltage   REAL,
          rx_bytes      INTEGER,
          tx_bytes      INTEGER,
          rx_errors     INTEGER,
          tx_errors     INTEGER,
          rx_dropped    INTEGER,
          tx_dropped    INTEGER
        );
        CREATE INDEX IF NOT EXISTS idx_unifi_port_history_port ON unifi_port_history(source_id, device_mac, port_idx, captured_at);
        CREATE INDEX IF NOT EXISTS idx_unifi_port_history_captured ON unifi_port_history(captured_at);

        CREATE TABLE IF NOT EXISTS unifi_clients (
          id                INTEGER PRIMARY KEY AUTOINCREMENT,
          source_id         INTEGER NOT NULL REFERENCES unifi_sources(id) ON DELETE CASCADE,
          site              TEXT DEFAULT 'default',
          mac               TEXT NOT NULL,
          name              TEXT,
          hostname          TEXT,
          ip                TEXT,
          is_wired          INTEGER,
          is_guest          INTEGER,
          network           TEXT,
          essid             TEXT,
          ap_mac            TEXT,
          sw_mac            TEXT,
          sw_port           INTEGER,
          channel           INTEGER,
          radio             TEXT,
          rssi              INTEGER,
          signal            INTEGER,
          noise             INTEGER,
          satisfaction      INTEGER,
          tx_rate           INTEGER,
          rx_rate           INTEGER,
          wired_rate_mbps   INTEGER,
          uptime            INTEGER,
          tx_bytes          INTEGER,
          rx_bytes          INTEGER,
          oui               TEXT,
          UNIQUE(source_id, mac)
        );
        CREATE INDEX IF NOT EXISTS idx_unifi_clients_source ON unifi_clients(source_id);

        CREATE TABLE IF NOT EXISTS unifi_wlans (
          id           INTEGER PRIMARY KEY AUTOINCREMENT,
          source_id    INTEGER NOT NULL REFERENCES unifi_sources(id) ON DELETE CASCADE,
          wlan_id      TEXT,
          name         TEXT,
          enabled      INTEGER,
          security     TEXT,
          wpa_mode     TEXT,
          is_guest     INTEGER,
          hide_ssid    INTEGER,
          UNIQUE(source_id, wlan_id)
        );

        CREATE TABLE IF NOT EXISTS unifi_networks (
          id           INTEGER PRIMARY KEY AUTOINCREMENT,
          source_id    INTEGER NOT NULL REFERENCES unifi_sources(id) ON DELETE CASCADE,
          network_id   TEXT,
          name         TEXT,
          purpose      TEXT,
          vlan         INTEGER,
          subnet       TEXT,
          enabled      INTEGER,
          UNIQUE(source_id, network_id)
        );

        CREATE TABLE IF NOT EXISTS unifi_rogue_aps (
          id           INTEGER PRIMARY KEY AUTOINCREMENT,
          source_id    INTEGER NOT NULL REFERENCES unifi_sources(id) ON DELETE CASCADE,
          bssid        TEXT,
          essid        TEXT,
          channel      INTEGER,
          signal       INTEGER,
          security     TEXT,
          oui          TEXT,
          is_rogue     INTEGER,
          last_seen    INTEGER,
          UNIQUE(source_id, bssid)
        );
        CREATE INDEX IF NOT EXISTS idx_unifi_rogue_aps_source ON unifi_rogue_aps(source_id);

        CREATE TABLE IF NOT EXISTS unifi_events (
          id           INTEGER PRIMARY KEY AUTOINCREMENT,
          source_id    INTEGER NOT NULL REFERENCES unifi_sources(id) ON DELETE CASCADE,
          event_id     TEXT,
          category     TEXT,
          event_key    TEXT,
          event_type   TEXT,
          message      TEXT,
          raw_json     TEXT,
          occurred_at  TEXT,
          UNIQUE(source_id, event_id)
        );
        CREATE INDEX IF NOT EXISTS idx_unifi_events_source ON unifi_events(source_id);
        CREATE INDEX IF NOT EXISTS idx_unifi_events_category ON unifi_events(source_id, category);

        CREATE TABLE IF NOT EXISTS unifi_wan (
          id                  INTEGER PRIMARY KEY AUTOINCREMENT,
          source_id           INTEGER NOT NULL REFERENCES unifi_sources(id) ON DELETE CASCADE,
          wan_name            TEXT DEFAULT 'WAN',
          isp_name            TEXT,
          isp_organization    TEXT,
          asn                 INTEGER,
          wan_ip              TEXT,
          gateway_ip          TEXT,
          latency_ms          INTEGER,
          availability_pct    REAL,
          uptime_sec          INTEGER,
          drops               INTEGER,
          xput_down           REAL,
          xput_up             REAL,
          speedtest_ping      REAL,
          speedtest_down      REAL,
          speedtest_up        REAL,
          speedtest_at        INTEGER,
          uplink_media        TEXT,
          uplink_speed        INTEGER,
          uplink_max_speed    INTEGER,
          tx_rate             INTEGER,
          rx_rate             INTEGER,
          UNIQUE(source_id, wan_name)
        );

        CREATE TABLE IF NOT EXISTS unifi_topology (
          source_id            INTEGER PRIMARY KEY REFERENCES unifi_sources(id) ON DELETE CASCADE,
          captured_at          TEXT,
          vertices_json        TEXT,
          edges_json           TEXT,
          has_unknown_switch   INTEGER
        );

        CREATE TABLE IF NOT EXISTS unifi_metrics_history (
          id                    INTEGER PRIMARY KEY AUTOINCREMENT,
          source_id             INTEGER NOT NULL REFERENCES unifi_sources(id) ON DELETE CASCADE,
          captured_at           TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
          devices_total         INTEGER,
          devices_online        INTEGER,
          clients_total         INTEGER,
          clients_wired         INTEGER,
          clients_wireless      INTEGER,
          clients_guest         INTEGER,
          wan_latency_ms        INTEGER,
          wan_availability_pct  REAL,
          wan_tx_rate           INTEGER,
          wan_rx_rate           INTEGER,
          gw_cpu_pct            REAL,
          gw_mem_pct            REAL
        );
        CREATE INDEX IF NOT EXISTS idx_unifi_metrics_history_source ON unifi_metrics_history(source_id, captured_at);

        CREATE TABLE IF NOT EXISTS unifi_issue_history (
          id           INTEGER PRIMARY KEY AUTOINCREMENT,
          issue_key    TEXT NOT NULL,
          source       TEXT,
          severity     TEXT,
          type         TEXT,
          target       TEXT,
          message      TEXT,
          status       TEXT NOT NULL DEFAULT 'open',
          first_seen   TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
          last_seen    TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
          resolved_at  TEXT
        );
        CREATE INDEX IF NOT EXISTS idx_unifi_issue_hist_key ON unifi_issue_history(issue_key, status);
        CREATE INDEX IF NOT EXISTS idx_unifi_issue_hist_seen ON unifi_issue_history(last_seen);
      `);
    },
  },
  {
    version: 2,
    up(db) {
      db.exec(`
        CREATE TABLE IF NOT EXISTS unifi_cameras (
          id                  INTEGER PRIMARY KEY AUTOINCREMENT,
          source_id           INTEGER NOT NULL REFERENCES unifi_sources(id) ON DELETE CASCADE,
          camera_id           TEXT NOT NULL,
          model_key           TEXT,
          name                TEXT,
          mac                 TEXT,
          state               TEXT,
          is_mic_enabled      INTEGER,
          video_mode          TEXT,
          hdr_type            TEXT,
          smart_detect_json   TEXT,
          has_package_camera  INTEGER,
          UNIQUE(source_id, camera_id)
        );
        CREATE INDEX IF NOT EXISTS idx_unifi_cameras_source ON unifi_cameras(source_id);
      `);
    },
  },
  {
    version: 3,
    up(db) {
      // Persistent client membership — unifi_clients is replaced every poll,
      // so first-seen/new-device insights need their own upserted table.
      db.exec(`
        CREATE TABLE IF NOT EXISTS unifi_client_seen (
          id          INTEGER PRIMARY KEY AUTOINCREMENT,
          source_id   INTEGER NOT NULL REFERENCES unifi_sources(id) ON DELETE CASCADE,
          mac         TEXT NOT NULL,
          name        TEXT,
          first_seen  TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
          last_seen   TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
          UNIQUE(source_id, mac)
        );
        CREATE INDEX IF NOT EXISTS idx_unifi_client_seen_first ON unifi_client_seen(source_id, first_seen);
      `);
    },
  },
  {
    version: 4,
    up(db) {
      // Hottest device temperature per capture — powers the temperature-trend
      // insight ("running hotter than last week").
      const cols = db.prepare('PRAGMA table_info(unifi_metrics_history)').all().map((c) => c.name);
      if (!cols.includes('max_temp_c')) {
        db.exec('ALTER TABLE unifi_metrics_history ADD COLUMN max_temp_c REAL');
      }
    },
  },
  {
    version: 5,
    up(db) {
      // WiFi/Security round: WLAN security posture snapshot, rogue-AP
      // first-seen tracking (new-this-week), and firewall/traffic rules.
      const wlanCols = db.prepare('PRAGMA table_info(unifi_wlans)').all().map((c) => c.name);
      if (!wlanCols.includes('posture_json')) {
        db.exec('ALTER TABLE unifi_wlans ADD COLUMN posture_json TEXT');
      }
      const rogueCols = db.prepare('PRAGMA table_info(unifi_rogue_aps)').all().map((c) => c.name);
      if (!rogueCols.includes('first_seen_at')) {
        db.exec('ALTER TABLE unifi_rogue_aps ADD COLUMN first_seen_at TEXT');
      }
      db.exec(`
        CREATE TABLE IF NOT EXISTS unifi_firewall_rules (
          id           INTEGER PRIMARY KEY AUTOINCREMENT,
          source_id    INTEGER NOT NULL REFERENCES unifi_sources(id) ON DELETE CASCADE,
          rule_id      TEXT,
          kind         TEXT NOT NULL,
          ruleset      TEXT,
          rule_index   INTEGER,
          name         TEXT,
          action       TEXT,
          enabled      INTEGER,
          protocol     TEXT,
          src          TEXT,
          dst          TEXT,
          logging      INTEGER,
          raw_json     TEXT,
          UNIQUE(source_id, kind, rule_id)
        );
        CREATE INDEX IF NOT EXISTS idx_unifi_firewall_rules_source ON unifi_firewall_rules(source_id);
      `);
    },
  },
];
