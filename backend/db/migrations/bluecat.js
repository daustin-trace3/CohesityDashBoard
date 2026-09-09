// BlueCat Address Manager scope: bluecat_* tables (contract section 3,
// version 1 only). Inventory tables are replaced per source per poll inside
// a transaction (DELETE WHERE source_id=? then INSERT) except
// bluecat_addresses (replaced per network by the enumerate poller),
// bluecat_network_overrides, bluecat_metrics_history, and
// bluecat_issue_history, which are upserted/appended.
module.exports = [
  {
    version: 1,
    up(db) {
      db.exec(`
        CREATE TABLE IF NOT EXISTS bluecat_sources (
          id                          INTEGER PRIMARY KEY AUTOINCREMENT,
          name                        TEXT NOT NULL UNIQUE,
          host                        TEXT NOT NULL,
          port                        INTEGER DEFAULT 443,
          encrypted_credentials       TEXT,
          ssl_verify                  INTEGER DEFAULT 0,
          polling_interval_minutes    INTEGER DEFAULT 30,
          enumerate_interval_minutes  INTEGER DEFAULT 60,
          bam_version                 TEXT,
          configurations_json         TEXT,
          last_poll_status            TEXT,
          last_poll_error             TEXT,
          last_poll_at                TEXT,
          last_enumerate_at           TEXT,
          last_enumerate_error        TEXT,
          created_at                  TEXT DEFAULT CURRENT_TIMESTAMP
        );

        CREATE TABLE IF NOT EXISTS bluecat_views (
          id                  INTEGER PRIMARY KEY AUTOINCREMENT,
          source_id           INTEGER NOT NULL REFERENCES bluecat_sources(id) ON DELETE CASCADE,
          view_id             INTEGER NOT NULL,
          configuration_id    INTEGER,
          configuration_name  TEXT,
          name                TEXT,
          zone_count          INTEGER DEFAULT 0,
          record_count        INTEGER DEFAULT 0,
          UNIQUE(source_id, view_id)
        );
        CREATE INDEX IF NOT EXISTS idx_bluecat_views_source ON bluecat_views(source_id);

        CREATE TABLE IF NOT EXISTS bluecat_zones (
          id                       INTEGER PRIMARY KEY AUTOINCREMENT,
          source_id                INTEGER NOT NULL REFERENCES bluecat_sources(id) ON DELETE CASCADE,
          zone_id                  INTEGER NOT NULL,
          view_id                  INTEGER,
          parent_zone_id           INTEGER,
          name                     TEXT,
          absolute_name            TEXT,
          zone_type                TEXT,
          deployment_enabled       INTEGER,
          dynamic_update_enabled   INTEGER,
          signed                   INTEGER,
          record_count             INTEGER DEFAULT 0,
          raw_json                 TEXT,
          UNIQUE(source_id, zone_id)
        );
        CREATE INDEX IF NOT EXISTS idx_bluecat_zones_source_view ON bluecat_zones(source_id, view_id);

        CREATE TABLE IF NOT EXISTS bluecat_records (
          id              INTEGER PRIMARY KEY AUTOINCREMENT,
          source_id       INTEGER NOT NULL REFERENCES bluecat_sources(id) ON DELETE CASCADE,
          record_id       INTEGER NOT NULL,
          zone_id         INTEGER,
          view_id         INTEGER,
          name            TEXT,
          absolute_name   TEXT,
          record_type     TEXT,
          rr_type         TEXT,
          rdata           TEXT,
          ttl             INTEGER,
          addresses_json  TEXT,
          comment         TEXT,
          UNIQUE(source_id, record_id)
        );
        CREATE INDEX IF NOT EXISTS idx_bluecat_records_abs ON bluecat_records(source_id, absolute_name);
        CREATE INDEX IF NOT EXISTS idx_bluecat_records_name ON bluecat_records(source_id, name);
        CREATE INDEX IF NOT EXISTS idx_bluecat_records_rdata ON bluecat_records(source_id, rdata);

        CREATE TABLE IF NOT EXISTS bluecat_blocks (
          id                INTEGER PRIMARY KEY AUTOINCREMENT,
          source_id         INTEGER NOT NULL REFERENCES bluecat_sources(id) ON DELETE CASCADE,
          block_id          INTEGER NOT NULL,
          parent_block_id   INTEGER,
          configuration_id  INTEGER,
          name              TEXT,
          range             TEXT,
          prefix            INTEGER,
          ip_version        INTEGER,
          location_name     TEXT,
          usage_json        TEXT,
          UNIQUE(source_id, block_id)
        );
        CREATE INDEX IF NOT EXISTS idx_bluecat_blocks_source ON bluecat_blocks(source_id);

        CREATE TABLE IF NOT EXISTS bluecat_networks (
          id                 INTEGER PRIMARY KEY AUTOINCREMENT,
          source_id          INTEGER NOT NULL REFERENCES bluecat_sources(id) ON DELETE CASCADE,
          network_id         INTEGER NOT NULL,
          block_id           INTEGER,
          configuration_id   INTEGER,
          name               TEXT,
          range              TEXT,
          prefix             INTEGER,
          ip_version         INTEGER,
          capacity           INTEGER,
          gateway            TEXT,
          gateway_source     TEXT,
          default_view_id    INTEGER,
          location_name      TEXT,
          ping_before_assign INTEGER,
          low_water_mark     INTEGER,
          high_water_mark    INTEGER,
          used_static        INTEGER,
          dhcp_pool          INTEGER,
          dhcp_used          INTEGER,
          free_static        INTEGER,
          free_pct           REAL,
          counts_source      TEXT,
          enumerated_at      TEXT,
          usage_json         TEXT,
          raw_json           TEXT,
          UNIQUE(source_id, network_id)
        );
        CREATE INDEX IF NOT EXISTS idx_bluecat_networks_source ON bluecat_networks(source_id);
        CREATE INDEX IF NOT EXISTS idx_bluecat_networks_free ON bluecat_networks(source_id, free_static);

        CREATE TABLE IF NOT EXISTS bluecat_ranges (
          id           INTEGER PRIMARY KEY AUTOINCREMENT,
          source_id    INTEGER NOT NULL REFERENCES bluecat_sources(id) ON DELETE CASCADE,
          range_id     INTEGER NOT NULL,
          network_id   INTEGER NOT NULL,
          name         TEXT,
          range_type   TEXT,
          start_ip     TEXT,
          end_ip       TEXT,
          size         INTEGER,
          dhcp_used    INTEGER,
          free_dhcp    INTEGER,
          raw_json     TEXT,
          UNIQUE(source_id, range_id)
        );
        CREATE INDEX IF NOT EXISTS idx_bluecat_ranges_network ON bluecat_ranges(source_id, network_id);

        CREATE TABLE IF NOT EXISTS bluecat_addresses (
          id           INTEGER PRIMARY KEY AUTOINCREMENT,
          source_id    INTEGER NOT NULL REFERENCES bluecat_sources(id) ON DELETE CASCADE,
          address_id   INTEGER NOT NULL,
          network_id   INTEGER NOT NULL,
          address      TEXT NOT NULL,
          state        TEXT,
          name         TEXT,
          mac          TEXT,
          in_range_id  INTEGER,
          device_id    INTEGER,
          UNIQUE(source_id, address_id)
        );
        CREATE INDEX IF NOT EXISTS idx_bluecat_addresses_addr ON bluecat_addresses(source_id, address);
        CREATE INDEX IF NOT EXISTS idx_bluecat_addresses_network ON bluecat_addresses(source_id, network_id);

        CREATE TABLE IF NOT EXISTS bluecat_devices (
          id                INTEGER PRIMARY KEY AUTOINCREMENT,
          source_id         INTEGER NOT NULL REFERENCES bluecat_sources(id) ON DELETE CASCADE,
          device_id         INTEGER NOT NULL,
          configuration_id  INTEGER,
          name              TEXT,
          device_type       TEXT,
          device_subtype    TEXT,
          description       TEXT,
          addresses_json    TEXT,
          raw_json          TEXT,
          UNIQUE(source_id, device_id)
        );
        CREATE INDEX IF NOT EXISTS idx_bluecat_devices_source ON bluecat_devices(source_id);

        CREATE TABLE IF NOT EXISTS bluecat_servers (
          id                  INTEGER PRIMARY KEY AUTOINCREMENT,
          source_id           INTEGER NOT NULL REFERENCES bluecat_sources(id) ON DELETE CASCADE,
          server_id           INTEGER NOT NULL,
          configuration_id    INTEGER,
          name                TEXT,
          address             TEXT,
          profile             TEXT,
          version             TEXT,
          connected           INTEGER,
          state               TEXT,
          interfaces_json     TEXT,
          roles_json          TEXT,
          last_deploy_status  TEXT,
          last_deploy_at      TEXT,
          raw_json            TEXT,
          UNIQUE(source_id, server_id)
        );
        CREATE INDEX IF NOT EXISTS idx_bluecat_servers_source ON bluecat_servers(source_id);

        CREATE TABLE IF NOT EXISTS bluecat_network_overrides (
          id                  INTEGER PRIMARY KEY AUTOINCREMENT,
          source_id           INTEGER NOT NULL REFERENCES bluecat_sources(id) ON DELETE CASCADE,
          network_id          INTEGER NOT NULL,
          range               TEXT,
          gateway             TEXT,
          exclude_low_space   INTEGER DEFAULT 0,
          note                TEXT,
          updated_by          TEXT,
          updated_at          TEXT DEFAULT CURRENT_TIMESTAMP,
          UNIQUE(source_id, network_id)
        );

        CREATE TABLE IF NOT EXISTS bluecat_metrics_history (
          id                    INTEGER PRIMARY KEY AUTOINCREMENT,
          source_id             INTEGER NOT NULL REFERENCES bluecat_sources(id) ON DELETE CASCADE,
          captured_at           TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
          views                 INTEGER,
          zones                 INTEGER,
          records               INTEGER,
          networks              INTEGER,
          networks_low_space    INTEGER,
          ranges_low_space      INTEGER,
          devices               INTEGER,
          servers               INTEGER,
          servers_down          INTEGER
        );
        CREATE INDEX IF NOT EXISTS idx_bluecat_metrics_history_source ON bluecat_metrics_history(source_id, captured_at);

        CREATE TABLE IF NOT EXISTS bluecat_issue_history (
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
        CREATE INDEX IF NOT EXISTS idx_bluecat_issue_hist_key ON bluecat_issue_history(issue_key, status);
        CREATE INDEX IF NOT EXISTS idx_bluecat_issue_hist_seen ON bluecat_issue_history(last_seen);
      `);
    },
  },
];
