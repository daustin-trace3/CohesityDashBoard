// Proxmox VE scope: proxmox_* tables. Direct-connection model — each Proxmox
// server (node or cluster entry point) is registered with credentials
// (AES-encrypted API token secret) like vCenter. Inventory tables (nodes,
// guests, storage, backup jobs, tasks) are replaced per server each poll;
// proxmox_metrics accumulates per-node snapshots for trends.
module.exports = [
  {
    version: 1,
    up(db) {
      db.exec(`
        CREATE TABLE IF NOT EXISTS proxmox_servers (
          id                       INTEGER PRIMARY KEY AUTOINCREMENT,
          name                     TEXT NOT NULL UNIQUE,
          host                     TEXT NOT NULL,
          port                     INTEGER NOT NULL DEFAULT 8006,
          token_id                 TEXT NOT NULL,
          encrypted_credentials    TEXT,
          ssl_verify               INTEGER NOT NULL DEFAULT 0,
          polling_interval_minutes INTEGER NOT NULL DEFAULT 10,
          quorate                  INTEGER,
          forbidden_endpoints      TEXT,
          last_poll_status         TEXT,
          last_poll_error          TEXT,
          last_poll_at             DATETIME,
          created_at               DATETIME DEFAULT CURRENT_TIMESTAMP,
          updated_at               DATETIME DEFAULT CURRENT_TIMESTAMP
        );

        CREATE TABLE IF NOT EXISTS proxmox_nodes (
          id                 INTEGER PRIMARY KEY AUTOINCREMENT,
          server_id          INTEGER NOT NULL REFERENCES proxmox_servers(id) ON DELETE CASCADE,
          name               TEXT,
          status             TEXT,
          cpu_usage          REAL,
          cpu_total          INTEGER,
          mem_used           INTEGER,
          mem_total          INTEGER,
          disk_used          INTEGER,
          disk_total         INTEGER,
          uptime_seconds     INTEGER,
          load_avg           TEXT,
          pve_version        TEXT,
          kernel_version     TEXT,
          cert_expires_at    TEXT,
          subscription_status TEXT,
          updates_available  INTEGER,
          updated_at         DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
          UNIQUE(server_id, name)
        );
        CREATE INDEX IF NOT EXISTS idx_proxmox_nodes_server ON proxmox_nodes(server_id);

        CREATE TABLE IF NOT EXISTS proxmox_guests (
          id                 INTEGER PRIMARY KEY AUTOINCREMENT,
          server_id          INTEGER NOT NULL REFERENCES proxmox_servers(id) ON DELETE CASCADE,
          vmid               INTEGER,
          name               TEXT,
          type               TEXT,
          node               TEXT,
          status             TEXT,
          is_template        INTEGER NOT NULL DEFAULT 0,
          cpu_count          INTEGER,
          cpu_usage          REAL,
          mem_used           INTEGER,
          mem_total          INTEGER,
          disk_used          INTEGER,
          disk_total         INTEGER,
          uptime_seconds     INTEGER,
          net_in             INTEGER,
          net_out            INTEGER,
          pool               TEXT,
          tags               TEXT,
          last_backup_at     TEXT,
          last_backup_status TEXT,
          updated_at         DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
          UNIQUE(server_id, vmid)
        );
        CREATE INDEX IF NOT EXISTS idx_proxmox_guests_server ON proxmox_guests(server_id);

        CREATE TABLE IF NOT EXISTS proxmox_storage (
          id           INTEGER PRIMARY KEY AUTOINCREMENT,
          server_id    INTEGER NOT NULL REFERENCES proxmox_servers(id) ON DELETE CASCADE,
          node         TEXT,
          storage      TEXT,
          type         TEXT,
          content      TEXT,
          active       INTEGER,
          shared       INTEGER,
          used_bytes   INTEGER,
          total_bytes  INTEGER,
          avail_bytes  INTEGER,
          updated_at   DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
          UNIQUE(server_id, node, storage)
        );
        CREATE INDEX IF NOT EXISTS idx_proxmox_storage_server ON proxmox_storage(server_id);

        CREATE TABLE IF NOT EXISTS proxmox_backup_jobs (
          id          INTEGER PRIMARY KEY AUTOINCREMENT,
          server_id   INTEGER NOT NULL REFERENCES proxmox_servers(id) ON DELETE CASCADE,
          job_id      TEXT,
          enabled     INTEGER,
          schedule    TEXT,
          storage     TEXT,
          mode        TEXT,
          compress    TEXT,
          selection   TEXT,
          next_run    TEXT,
          updated_at  DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
          UNIQUE(server_id, job_id)
        );
        CREATE INDEX IF NOT EXISTS idx_proxmox_backup_jobs_server ON proxmox_backup_jobs(server_id);

        CREATE TABLE IF NOT EXISTS proxmox_tasks (
          id          INTEGER PRIMARY KEY AUTOINCREMENT,
          server_id   INTEGER NOT NULL REFERENCES proxmox_servers(id) ON DELETE CASCADE,
          upid        TEXT,
          node        TEXT,
          type        TEXT,
          target      TEXT,
          user        TEXT,
          status      TEXT,
          started_at  TEXT,
          ended_at    TEXT,
          updated_at  DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
          UNIQUE(server_id, upid)
        );
        CREATE INDEX IF NOT EXISTS idx_proxmox_tasks_server ON proxmox_tasks(server_id);
        CREATE INDEX IF NOT EXISTS idx_proxmox_tasks_started ON proxmox_tasks(started_at);

        CREATE TABLE IF NOT EXISTS proxmox_metrics (
          id             INTEGER PRIMARY KEY AUTOINCREMENT,
          server_id      INTEGER NOT NULL REFERENCES proxmox_servers(id) ON DELETE CASCADE,
          node           TEXT,
          captured_at    DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
          cpu_usage      REAL,
          mem_used       INTEGER,
          mem_total      INTEGER,
          storage_used   INTEGER,
          storage_total  INTEGER
        );
        CREATE INDEX IF NOT EXISTS idx_proxmox_metrics_server ON proxmox_metrics(server_id, captured_at);

        CREATE TABLE IF NOT EXISTS proxmox_issue_history (
          id          INTEGER PRIMARY KEY AUTOINCREMENT,
          issue_key   TEXT NOT NULL,
          source      TEXT,
          source_id   INTEGER,
          severity    TEXT,
          type        TEXT,
          target      TEXT,
          message     TEXT,
          status      TEXT NOT NULL DEFAULT 'open',
          first_seen  DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
          last_seen   DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
          resolved_at DATETIME
        );
        CREATE INDEX IF NOT EXISTS idx_proxmox_issue_hist_key ON proxmox_issue_history(issue_key, status);
        CREATE INDEX IF NOT EXISTS idx_proxmox_issue_hist_seen ON proxmox_issue_history(last_seen);
      `);
    },
  },
];
