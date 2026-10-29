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
  {
    version: 7,
    up(db) {
      // Per-VM performance/health quickstats + guest hostname (Aria appliance
      // matching). All SOAP-sourced — NULL without SOAP.
      db.exec(`
        ALTER TABLE vcenter_vms ADD COLUMN cpu_usage_mhz INTEGER;
        ALTER TABLE vcenter_vms ADD COLUMN mem_usage_mb INTEGER;
        ALTER TABLE vcenter_vms ADD COLUMN overall_status TEXT;
        ALTER TABLE vcenter_vms ADD COLUMN guest_hostname TEXT;
      `);
    },
  },
  {
    version: 8,
    up(db) {
      // Dual-site capacity planning: site membership for clusters/datastores,
      // hourly capacity snapshots (cluster aggregate, per-datastore, per-VM),
      // site mapping for failover matrix and overview calculations.
      db.exec(`
        CREATE TABLE IF NOT EXISTS vcenter_sites (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          name TEXT NOT NULL UNIQUE,
          color TEXT,
          sort_order INTEGER NOT NULL DEFAULT 0,
          created_at DATETIME DEFAULT CURRENT_TIMESTAMP
        );
        CREATE TABLE IF NOT EXISTS vcenter_site_members (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          site_id INTEGER NOT NULL REFERENCES vcenter_sites(id) ON DELETE CASCADE,
          vcenter_id INTEGER NOT NULL REFERENCES vcenter_vcenters(id) ON DELETE CASCADE,
          member_type TEXT NOT NULL,
          member_name TEXT NOT NULL,
          replicated INTEGER NOT NULL DEFAULT 0,
          UNIQUE (vcenter_id, member_type, member_name)
        );
        CREATE TABLE IF NOT EXISTS vcenter_capacity_history (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          vcenter_id INTEGER NOT NULL REFERENCES vcenter_vcenters(id) ON DELETE CASCADE,
          captured_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
          cluster_name TEXT NOT NULL,
          host_count INTEGER, hosts_connected INTEGER,
          vm_count INTEGER, vms_on INTEGER,
          cpu_cores INTEGER, cpu_mhz_capacity INTEGER, cpu_mhz_used INTEGER,
          mem_bytes_capacity INTEGER, mem_bytes_used INTEGER,
          vcpu_allocated INTEGER, vmem_mb_allocated,
          largest_host_cpu_cores INTEGER, largest_host_cpu_mhz INTEGER, largest_host_mem_bytes INTEGER
        );
        CREATE INDEX IF NOT EXISTS idx_vcenter_caphist_vc ON vcenter_capacity_history(vcenter_id, cluster_name, captured_at);
        CREATE TABLE IF NOT EXISTS vcenter_datastore_history (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          vcenter_id INTEGER NOT NULL REFERENCES vcenter_vcenters(id) ON DELETE CASCADE,
          captured_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
          datastore_name TEXT NOT NULL,
          capacity_bytes INTEGER, free_bytes INTEGER
        );
        CREATE INDEX IF NOT EXISTS idx_vcenter_dshist_vc ON vcenter_datastore_history(vcenter_id, datastore_name, captured_at);
        CREATE TABLE IF NOT EXISTS vcenter_vm_capacity_history (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          vcenter_id INTEGER NOT NULL REFERENCES vcenter_vcenters(id) ON DELETE CASCADE,
          captured_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
          vm_name TEXT NOT NULL, cluster_name TEXT, power_state TEXT,
          cpu_count INTEGER, memory_mb INTEGER,
          cpu_usage_mhz INTEGER, mem_usage_mb INTEGER, storage_committed_bytes INTEGER
        );
        CREATE INDEX IF NOT EXISTS idx_vcenter_vmhist_vc ON vcenter_vm_capacity_history(vcenter_id, vm_name, captured_at);
      `);
    },
  },
  {
    version: 9,
    up(db) {
      // Optional failover pairs: two sites that back each other up. Drives the
      // "Failover Pairs" panel on Site Capacity (combined utilisation + fit in
      // each direction). Nothing is paired by default.
      db.exec(`
        CREATE TABLE IF NOT EXISTS vcenter_site_pairs (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          site_a_id INTEGER NOT NULL REFERENCES vcenter_sites(id) ON DELETE CASCADE,
          site_b_id INTEGER NOT NULL REFERENCES vcenter_sites(id) ON DELETE CASCADE,
          created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
          UNIQUE (site_a_id, site_b_id)
        );
      `);
    },
  },
  {
    version: 10,
    up(db) {
      // Guest storage: the virtual disks behind each VM (provisioned versus
      // consumed on the datastore, from config.hardware.device + layoutEx) and
      // the filesystems VMware Tools reports from inside the guest (C:, /var,
      // capacity and free). One history row per filesystem per day feeds the
      // growth and days-to-full figures. Owner tag category is per vCenter,
      // because the category name differs from site to site.
      db.exec(`
        CREATE TABLE IF NOT EXISTS vcenter_vm_disks (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          vcenter_id INTEGER NOT NULL REFERENCES vcenter_vcenters(id) ON DELETE CASCADE,
          vm_id TEXT NOT NULL,
          vm_name TEXT,
          disk_key INTEGER,
          label TEXT,
          capacity_bytes INTEGER,
          used_bytes INTEGER,
          thin INTEGER,
          datastore TEXT,
          file_name TEXT,
          captured_at DATETIME DEFAULT CURRENT_TIMESTAMP
        );
        CREATE INDEX IF NOT EXISTS idx_vcenter_vm_disks_vm ON vcenter_vm_disks(vcenter_id, vm_id);

        CREATE TABLE IF NOT EXISTS vcenter_vm_filesystems (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          vcenter_id INTEGER NOT NULL REFERENCES vcenter_vcenters(id) ON DELETE CASCADE,
          vm_id TEXT NOT NULL,
          vm_name TEXT,
          mount TEXT NOT NULL,
          fs_type TEXT,
          capacity_bytes INTEGER,
          free_bytes INTEGER,
          used_pct REAL,
          captured_at DATETIME DEFAULT CURRENT_TIMESTAMP
        );
        CREATE INDEX IF NOT EXISTS idx_vcenter_vm_fs_vm ON vcenter_vm_filesystems(vcenter_id, vm_id);
        CREATE INDEX IF NOT EXISTS idx_vcenter_vm_fs_pct ON vcenter_vm_filesystems(used_pct);

        CREATE TABLE IF NOT EXISTS vcenter_vm_filesystem_history (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          vcenter_id INTEGER NOT NULL REFERENCES vcenter_vcenters(id) ON DELETE CASCADE,
          vm_id TEXT NOT NULL,
          mount TEXT NOT NULL,
          day TEXT NOT NULL,
          capacity_bytes INTEGER,
          free_bytes INTEGER,
          UNIQUE (vcenter_id, vm_id, mount, day)
        );

        ALTER TABLE vcenter_vcenters ADD COLUMN owner_tag_category TEXT;
      `);
    },
  },
  // NOTE icc-phase1: v11 here is feat/multi-tenant vcenter v11 (same number).
  {
    version: 11,
    up(db) {
      // Physical NIC neighbour hints (HostNetworkSystem.QueryNetworkHint): the
      // switch and port each ESXi vmnic is plugged into, as CDP or LLDP
      // reports it. One row per host, nic and protocol; replaced per vCenter
      // each sweep that produced hints.
      db.exec(`
        CREATE TABLE IF NOT EXISTS vcenter_host_nic_neighbors (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          vcenter_id INTEGER NOT NULL REFERENCES vcenter_vcenters(id) ON DELETE CASCADE,
          host_name TEXT NOT NULL,
          nic TEXT NOT NULL,
          mac TEXT,
          protocol TEXT NOT NULL,
          switch_name TEXT,
          switch_port TEXT,
          switch_address TEXT,
          switch_platform TEXT,
          vlan INTEGER,
          raw_json TEXT,
          captured_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
          UNIQUE (vcenter_id, host_name, nic, protocol)
        );
        CREATE INDEX IF NOT EXISTS idx_vcenter_nic_nb_host ON vcenter_host_nic_neighbors(vcenter_id, host_name);
        CREATE INDEX IF NOT EXISTS idx_vcenter_nic_nb_switch ON vcenter_host_nic_neighbors(switch_name);
      `);
    },
  },
  {
    version: 12,
    up(db) {
      // Host hardware identity from hardware.systemInfo (UNVERIFIED against a
      // live vCenter). service_tag is the Dell service tag when present.
      const cols = db.prepare("PRAGMA table_info('vcenter_hosts')").all().map((c) => c.name);
      for (const c of ['serial', 'service_tag', 'uuid']) {
        if (!cols.includes(c)) db.exec(`ALTER TABLE vcenter_hosts ADD COLUMN ${c} TEXT`);
      }
    },
  },
  {
    version: 13,
    up(db) {
      // Long-term history: raw host samples plus incremental daily rollups
      // (one row per object per UTC day: samples, min, sum, max, last).
      db.exec(`
        CREATE TABLE IF NOT EXISTS vcenter_host_capacity_history (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          vcenter_id INTEGER NOT NULL REFERENCES vcenter_vcenters(id) ON DELETE CASCADE,
          captured_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
          host_name TEXT NOT NULL, cluster_name TEXT,
          connection_state TEXT, in_maintenance INTEGER, vm_count INTEGER,
          cpu_mhz_capacity INTEGER, cpu_mhz_used INTEGER,
          mem_bytes_capacity INTEGER, mem_bytes_used INTEGER, uptime_seconds INTEGER
        );
        CREATE INDEX IF NOT EXISTS idx_vcenter_hosthist_vc ON vcenter_host_capacity_history(vcenter_id, host_name, captured_at);

        CREATE TABLE IF NOT EXISTS vcenter_vm_daily (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          vcenter_id INTEGER NOT NULL REFERENCES vcenter_vcenters(id) ON DELETE CASCADE,
          vm_name TEXT NOT NULL, day TEXT NOT NULL, cluster_name TEXT,
          samples INTEGER NOT NULL DEFAULT 0, on_samples INTEGER NOT NULL DEFAULT 0,
          cpu_samples INTEGER NOT NULL DEFAULT 0, cpu_min_mhz INTEGER, cpu_sum_mhz INTEGER, cpu_max_mhz INTEGER, cpu_last_mhz INTEGER,
          mem_samples INTEGER NOT NULL DEFAULT 0, mem_min_mb INTEGER, mem_sum_mb INTEGER, mem_max_mb INTEGER, mem_last_mb INTEGER,
          cpu_count_last INTEGER, memory_mb_last INTEGER, storage_last_bytes INTEGER,
          UNIQUE(vcenter_id, vm_name, day)
        );
        CREATE INDEX IF NOT EXISTS idx_vcenter_vm_daily_day ON vcenter_vm_daily(vcenter_id, day);

        CREATE TABLE IF NOT EXISTS vcenter_host_daily (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          vcenter_id INTEGER NOT NULL REFERENCES vcenter_vcenters(id) ON DELETE CASCADE,
          host_name TEXT NOT NULL, day TEXT NOT NULL, cluster_name TEXT,
          samples INTEGER NOT NULL DEFAULT 0, disconnected_samples INTEGER NOT NULL DEFAULT 0, maintenance_samples INTEGER NOT NULL DEFAULT 0,
          cpu_samples INTEGER NOT NULL DEFAULT 0, cpu_min_mhz INTEGER, cpu_sum_mhz INTEGER, cpu_max_mhz INTEGER, cpu_last_mhz INTEGER, cpu_capacity_mhz_last INTEGER,
          mem_samples INTEGER NOT NULL DEFAULT 0, mem_min_bytes INTEGER, mem_sum_bytes INTEGER, mem_max_bytes INTEGER, mem_last_bytes INTEGER, mem_capacity_bytes_last INTEGER,
          vm_count_last INTEGER, uptime_last_seconds INTEGER,
          UNIQUE(vcenter_id, host_name, day)
        );
        CREATE INDEX IF NOT EXISTS idx_vcenter_host_daily_day ON vcenter_host_daily(vcenter_id, day);
      `);
    },
  },
  {
    version: 14,
    up(db) {
      // config.createDate from vCenter (ISO 8601, NULL when the property is
      // absent). The Ops Agent uses it to hold back new VMs from promotion.
      const cols = db.prepare("PRAGMA table_info('vcenter_vms')").all().map((c) => c.name);
      if (!cols.includes('created_at_src')) db.exec('ALTER TABLE vcenter_vms ADD COLUMN created_at_src TEXT');
    },
  },
];
