// vCenter scope: vcenter_* tables. Direct-connection model — each vCenter is
// registered with credentials (AES-encrypted) like Pure arrays. Inventory
// tables (hosts, clusters, datastores, certs) are replaced per vCenter each
// poll; vcenter_metrics_history accumulates per-vCenter snapshots for trends.
module.exports = [
  {
    version: 1,
    up(db) {
      db.exec(`
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
          in_maintenance    INTEGER,          -- 1/0 from SOAP; NULL when SOAP enrichment unavailable
          vm_count          INTEGER,
          cpu_mhz_capacity  INTEGER,          -- SOAP quickstats (NULL without SOAP)
          cpu_mhz_used      INTEGER,
          mem_bytes_capacity INTEGER,
          mem_bytes_used    INTEGER,
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
      `);
    },
  },
  {
    version: 2,
    up(db) {
      // VM guest inventory (SOAP-sourced; REST fallback fills a subset) plus
      // version/BIOS enrichment: vCenter product version on the source row,
      // ESX version + BIOS + hardware identity per host.
      db.exec(`
        ALTER TABLE vcenter_vcenters ADD COLUMN version TEXT;
        ALTER TABLE vcenter_vcenters ADD COLUMN build TEXT;
        ALTER TABLE vcenter_vcenters ADD COLUMN product_name TEXT;
        ALTER TABLE vcenter_hosts ADD COLUMN esx_version TEXT;
        ALTER TABLE vcenter_hosts ADD COLUMN esx_build TEXT;
        ALTER TABLE vcenter_hosts ADD COLUMN bios_version TEXT;
        ALTER TABLE vcenter_hosts ADD COLUMN bios_release_date TEXT;
        ALTER TABLE vcenter_hosts ADD COLUMN vendor TEXT;
        ALTER TABLE vcenter_hosts ADD COLUMN model TEXT;

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
          captured_at   DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
        );
        CREATE INDEX IF NOT EXISTS idx_vcenter_vms_vc ON vcenter_vms(vcenter_id);
      `);
    },
  },
  {
    version: 3,
    up(db) {
      // Governance + network expansion: VMware Tools versioning on VMs, host
      // config used for drift detection (cores, NTP/DNS, SSH service, uptime),
      // host/dvs networking inventory (one typed-superset table), and the
      // orphaned-VMDK sweep results. All SOAP-sourced — NULL without SOAP.
      db.exec(`
        ALTER TABLE vcenter_vms ADD COLUMN tools_version TEXT;
        ALTER TABLE vcenter_vms ADD COLUMN tools_version_status TEXT;
        ALTER TABLE vcenter_hosts ADD COLUMN cpu_cores INTEGER;
        ALTER TABLE vcenter_hosts ADD COLUMN ntp_servers TEXT;
        ALTER TABLE vcenter_hosts ADD COLUMN dns_servers TEXT;
        ALTER TABLE vcenter_hosts ADD COLUMN ssh_enabled INTEGER;
        ALTER TABLE vcenter_hosts ADD COLUMN uptime_seconds INTEGER;

        CREATE TABLE IF NOT EXISTS vcenter_networks (
          id           INTEGER PRIMARY KEY AUTOINCREMENT,
          vcenter_id   INTEGER NOT NULL REFERENCES vcenter_vcenters(id) ON DELETE CASCADE,
          host_name    TEXT,              -- NULL for vCenter-scope rows (dvswitch/dvportgroup)
          kind         TEXT NOT NULL,     -- pnic | vswitch | portgroup | vmkernel | dvswitch | dvportgroup
          name         TEXT,
          switch_name  TEXT,              -- owning vswitch/dvs for portgroups/pnics
          vlan_id      INTEGER,
          speed_mbps   INTEGER,
          mac          TEXT,
          ip_address   TEXT,
          netmask      TEXT,
          mtu          INTEGER,
          uplinks      TEXT,              -- JSON array of uplink device names
          port_count   INTEGER,
          extra        TEXT,              -- JSON: driver, dhcp, vlan trunk ranges, ...
          captured_at  DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
        );
        CREATE INDEX IF NOT EXISTS idx_vcenter_networks_vc ON vcenter_networks(vcenter_id, kind);

        CREATE TABLE IF NOT EXISTS vcenter_orphaned_vmdks (
          id             INTEGER PRIMARY KEY AUTOINCREMENT,
          vcenter_id     INTEGER NOT NULL REFERENCES vcenter_vcenters(id) ON DELETE CASCADE,
          datastore_name TEXT,
          path           TEXT,            -- "[datastore] folder/disk.vmdk"
          size_bytes     INTEGER,
          modified_at    TEXT,
          captured_at    DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
        );
        CREATE INDEX IF NOT EXISTS idx_vcenter_orphans_vc ON vcenter_orphaned_vmdks(vcenter_id);
      `);
    },
  },
  {
    version: 4,
    up(db) {
      // Events page: native vSphere events (EventManager QueryEvents, appended
      // per poll and deduped on the vCenter event key) and the lifecycle
      // history of our computed issues (opened/resolved with durations).
      db.exec(`
        CREATE TABLE IF NOT EXISTS vcenter_events (
          id           INTEGER PRIMARY KEY AUTOINCREMENT,
          vcenter_id   INTEGER NOT NULL REFERENCES vcenter_vcenters(id) ON DELETE CASCADE,
          event_key    INTEGER NOT NULL,   -- vCenter's own event key (unique per vCenter)
          event_type   TEXT,               -- vim event class, e.g. VmMigratedEvent
          severity     TEXT,               -- error | warning | info (from the query category)
          message      TEXT,
          username     TEXT,
          entity_name  TEXT,               -- vm/host/cluster the event is about
          created_at   TEXT,               -- event time from vCenter
          captured_at  DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
        );
        CREATE UNIQUE INDEX IF NOT EXISTS idx_vcenter_events_key ON vcenter_events(vcenter_id, event_key);
        CREATE INDEX IF NOT EXISTS idx_vcenter_events_time ON vcenter_events(created_at);

        CREATE TABLE IF NOT EXISTS vcenter_issue_history (
          id          INTEGER PRIMARY KEY AUTOINCREMENT,
          issue_key   TEXT NOT NULL,       -- type|vcenter|target (stable across polls)
          vcenter     TEXT,
          severity    TEXT,
          type        TEXT,
          target      TEXT,
          message     TEXT,                -- latest message text
          status      TEXT NOT NULL DEFAULT 'open',  -- open | resolved
          first_seen  DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
          last_seen   DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
          resolved_at DATETIME
        );
        CREATE INDEX IF NOT EXISTS idx_vcenter_issue_hist_key ON vcenter_issue_history(issue_key, status);
        CREATE INDEX IF NOT EXISTS idx_vcenter_issue_hist_seen ON vcenter_issue_history(last_seen);
      `);
    },
  },
  {
    version: 5,
    up(db) {
      // Per-VM associations for the drill-downs: networks/datastores/tags as
      // JSON name arrays (queried with json_each for portgroup/datastore VM
      // counts), guest NIC detail, uptime, committed storage, notes.
      db.exec(`
        ALTER TABLE vcenter_vms ADD COLUMN networks TEXT;
        ALTER TABLE vcenter_vms ADD COLUMN datastores TEXT;
        ALTER TABLE vcenter_vms ADD COLUMN tags TEXT;
        ALTER TABLE vcenter_vms ADD COLUMN guest_nics TEXT;
        ALTER TABLE vcenter_vms ADD COLUMN uptime_seconds INTEGER;
        ALTER TABLE vcenter_vms ADD COLUMN storage_committed_bytes INTEGER;
        ALTER TABLE vcenter_vms ADD COLUMN annotation TEXT;
      `);
    },
  },

  // Migration: cached AI Advisor report content, one row per report key.
  {
    version: 6,
    up(db) {
      db.exec(`
        CREATE TABLE IF NOT EXISTS vcenter_ai_reports (
          report_key    TEXT PRIMARY KEY,
          model         TEXT,
          content       TEXT NOT NULL,
          generated_at  DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
        );
      `);
    },
  },
];
