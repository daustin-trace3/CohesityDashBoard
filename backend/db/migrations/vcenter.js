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
];
