// Nutanix scope: nutanix_* tables. Dual-connection model (Prism Central v3 +
// groups, or Prism Element v2.0 + v1) registered like vCenter/NetBackup, plus
// separate Move appliance connections. Inventory tables are replaced per source
// each poll (failed sections keep prior rows — see nutanixPoller.js); metrics/
// events/history tables append and self-retain. Single version — no live estate
// yet, so the whole schema ships in v1.
module.exports = [
  {
    version: 1,
    up(db) {
      db.exec(`
        CREATE TABLE IF NOT EXISTS nutanix_sources (
          id                        INTEGER PRIMARY KEY AUTOINCREMENT,
          name                      TEXT NOT NULL UNIQUE,
          source_type               TEXT NOT NULL CHECK(source_type IN ('prism_central','prism_element')),
          host                      TEXT NOT NULL,
          port                      INTEGER DEFAULT 9440,
          username                  TEXT,
          encrypted_credentials     TEXT,
          ssl_verify                INTEGER DEFAULT 0,
          polling_interval_minutes  INTEGER DEFAULT 15,
          is_ce                     INTEGER DEFAULT 0,
          api_flavor                TEXT,
          product_version           TEXT,
          last_poll_status          TEXT,
          last_poll_error           TEXT,
          last_poll_at              TEXT,
          created_at                TEXT DEFAULT CURRENT_TIMESTAMP,
          updated_at                TEXT DEFAULT CURRENT_TIMESTAMP
        );

        CREATE TABLE IF NOT EXISTS nutanix_clusters (
          id                          INTEGER PRIMARY KEY AUTOINCREMENT,
          source_id                   INTEGER NOT NULL REFERENCES nutanix_sources(id) ON DELETE CASCADE,
          uuid                        TEXT NOT NULL,
          name                        TEXT,
          aos_version                 TEXT,
          hypervisor_types            TEXT,
          num_nodes                   INTEGER,
          redundancy_factor           INTEGER,
          operation_mode              TEXT,
          external_ip                 TEXT,
          storage_capacity_bytes      INTEGER,
          storage_usage_bytes         INTEGER,
          reduction_ratio_ppm         INTEGER,
          overall_reduction_ratio_ppm INTEGER,
          cpu_usage_ppm               INTEGER,
          memory_usage_ppm            INTEGER,
          controller_iops             INTEGER,
          controller_latency_usecs    INTEGER,
          io_bandwidth_kbps           INTEGER,
          runway_days                 INTEGER,
          ft_failures_tolerable       INTEGER,
          ft_details                  TEXT,
          ncc_pass                    INTEGER,
          ncc_warn                    INTEGER,
          ncc_fail                    INTEGER,
          unprotected_vm_count        INTEGER,
          updated_at                  TEXT DEFAULT CURRENT_TIMESTAMP,
          UNIQUE(source_id, uuid)
        );
        CREATE INDEX IF NOT EXISTS idx_nutanix_clusters_source ON nutanix_clusters(source_id);

        CREATE TABLE IF NOT EXISTS nutanix_hosts (
          id                    INTEGER PRIMARY KEY AUTOINCREMENT,
          source_id             INTEGER NOT NULL REFERENCES nutanix_sources(id) ON DELETE CASCADE,
          cluster_uuid          TEXT,
          uuid                  TEXT,
          name                  TEXT,
          serial                TEXT,
          block_model           TEXT,
          block_serial          TEXT,
          position              TEXT,
          cpu_model             TEXT,
          num_cpu_sockets       INTEGER,
          num_cpu_cores         INTEGER,
          cpu_capacity_hz       INTEGER,
          memory_capacity_bytes INTEGER,
          hypervisor_type       TEXT,
          hypervisor_version    TEXT,
          hypervisor_ip         TEXT,
          cvm_ip                TEXT,
          ipmi_ip               TEXT,
          bios_version          TEXT,
          bmc_version           TEXT,
          num_vms               INTEGER,
          state                 TEXT,
          maintenance_mode      INTEGER DEFAULT 0,
          is_degraded           INTEGER DEFAULT 0,
          boot_time_usecs       INTEGER,
          cpu_usage_ppm         INTEGER,
          memory_usage_ppm      INTEGER,
          disks_json            TEXT,
          updated_at            TEXT DEFAULT CURRENT_TIMESTAMP
        );
        CREATE INDEX IF NOT EXISTS idx_nutanix_hosts_source ON nutanix_hosts(source_id);

        CREATE TABLE IF NOT EXISTS nutanix_vms (
          id               INTEGER PRIMARY KEY AUTOINCREMENT,
          source_id        INTEGER NOT NULL REFERENCES nutanix_sources(id) ON DELETE CASCADE,
          cluster_uuid     TEXT,
          cluster_name     TEXT,
          uuid             TEXT,
          name             TEXT,
          power_state      TEXT,
          num_vcpus        INTEGER,
          memory_mb        INTEGER,
          host_uuid        TEXT,
          host_name        TEXT,
          ip_addresses     TEXT,
          ngt_status       TEXT,
          guest_os         TEXT,
          disk_count       INTEGER,
          disk_bytes       INTEGER,
          categories       TEXT,
          cpu_usage_ppm    INTEGER,
          memory_usage_ppm INTEGER,
          controller_iops  INTEGER,
          latency_usecs    INTEGER,
          updated_at       TEXT DEFAULT CURRENT_TIMESTAMP
        );
        CREATE INDEX IF NOT EXISTS idx_nutanix_vms_source ON nutanix_vms(source_id);

        CREATE TABLE IF NOT EXISTS nutanix_containers (
          id                  INTEGER PRIMARY KEY AUTOINCREMENT,
          source_id           INTEGER NOT NULL REFERENCES nutanix_sources(id) ON DELETE CASCADE,
          cluster_uuid        TEXT,
          cluster_name        TEXT,
          uuid                TEXT,
          name                TEXT,
          replication_factor  INTEGER,
          compression_enabled INTEGER,
          dedup_enabled       INTEGER,
          erasure_code        TEXT,
          capacity_bytes      INTEGER,
          usage_bytes         INTEGER,
          free_bytes          INTEGER,
          reduction_ratio_ppm INTEGER,
          updated_at          TEXT DEFAULT CURRENT_TIMESTAMP
        );
        CREATE INDEX IF NOT EXISTS idx_nutanix_containers_source ON nutanix_containers(source_id);

        CREATE TABLE IF NOT EXISTS nutanix_disks (
          id           INTEGER PRIMARY KEY AUTOINCREMENT,
          source_id    INTEGER NOT NULL REFERENCES nutanix_sources(id) ON DELETE CASCADE,
          cluster_uuid TEXT,
          disk_uuid    TEXT,
          serial       TEXT,
          model        TEXT,
          vendor       TEXT,
          tier         TEXT,
          size_bytes   INTEGER,
          usage_bytes  INTEGER,
          online       INTEGER,
          status       TEXT,
          bad          INTEGER DEFAULT 0,
          host_name    TEXT,
          firmware     TEXT,
          updated_at   TEXT DEFAULT CURRENT_TIMESTAMP
        );
        CREATE INDEX IF NOT EXISTS idx_nutanix_disks_source ON nutanix_disks(source_id);

        CREATE TABLE IF NOT EXISTS nutanix_alerts (
          id            INTEGER PRIMARY KEY AUTOINCREMENT,
          source_id     INTEGER NOT NULL REFERENCES nutanix_sources(id) ON DELETE CASCADE,
          cluster_uuid  TEXT,
          cluster_name  TEXT,
          alert_uuid    TEXT,
          severity      TEXT,
          title         TEXT,
          message       TEXT,
          entity_type   TEXT,
          entity_name   TEXT,
          acknowledged  INTEGER DEFAULT 0,
          resolved      INTEGER DEFAULT 0,
          created_usecs INTEGER,
          created_at    TEXT
        );
        CREATE INDEX IF NOT EXISTS idx_nutanix_alerts_source ON nutanix_alerts(source_id);

        CREATE TABLE IF NOT EXISTS nutanix_events (
          id            INTEGER PRIMARY KEY AUTOINCREMENT,
          source_id     INTEGER NOT NULL REFERENCES nutanix_sources(id) ON DELETE CASCADE,
          cluster_uuid  TEXT,
          message       TEXT,
          entity_type   TEXT,
          entity_name   TEXT,
          created_usecs INTEGER,
          created_at    TEXT
        );
        CREATE UNIQUE INDEX IF NOT EXISTS idx_nutanix_events_key ON nutanix_events(source_id, created_usecs, message);
        CREATE INDEX IF NOT EXISTS idx_nutanix_events_source ON nutanix_events(source_id);

        CREATE TABLE IF NOT EXISTS nutanix_pds (
          id                       INTEGER PRIMARY KEY AUTOINCREMENT,
          source_id                INTEGER NOT NULL REFERENCES nutanix_sources(id) ON DELETE CASCADE,
          name                     TEXT,
          active                   INTEGER,
          vm_count                 INTEGER,
          remote_sites             TEXT,
          next_snapshot_usecs      INTEGER,
          pending_replications     INTEGER,
          ongoing_replications     INTEGER,
          tx_bandwidth_kbps        INTEGER,
          exclusive_snapshot_bytes INTEGER,
          schedules_json           TEXT,
          updated_at               TEXT DEFAULT CURRENT_TIMESTAMP
        );
        CREATE INDEX IF NOT EXISTS idx_nutanix_pds_source ON nutanix_pds(source_id);

        CREATE TABLE IF NOT EXISTS nutanix_replications (
          id                    INTEGER PRIMARY KEY AUTOINCREMENT,
          source_id             INTEGER NOT NULL REFERENCES nutanix_sources(id) ON DELETE CASCADE,
          replication_id        TEXT,
          pd_name               TEXT,
          remote_site           TEXT,
          snapshot_id           TEXT,
          completed_percentage  REAL,
          completed_bytes       INTEGER,
          eta_secs              INTEGER,
          start_usecs           INTEGER,
          paused                INTEGER DEFAULT 0,
          updated_at            TEXT DEFAULT CURRENT_TIMESTAMP
        );
        CREATE INDEX IF NOT EXISTS idx_nutanix_replications_source ON nutanix_replications(source_id);

        CREATE TABLE IF NOT EXISTS nutanix_remote_sites (
          id                INTEGER PRIMARY KEY AUTOINCREMENT,
          source_id         INTEGER NOT NULL REFERENCES nutanix_sources(id) ON DELETE CASCADE,
          name              TEXT,
          status            TEXT,
          latency_usecs     INTEGER,
          capabilities      TEXT,
          tx_bandwidth_kbps INTEGER,
          updated_at        TEXT DEFAULT CURRENT_TIMESTAMP
        );
        CREATE INDEX IF NOT EXISTS idx_nutanix_remote_sites_source ON nutanix_remote_sites(source_id);

        CREATE TABLE IF NOT EXISTS nutanix_protection_policies (
          id                 INTEGER PRIMARY KEY AUTOINCREMENT,
          source_id          INTEGER NOT NULL REFERENCES nutanix_sources(id) ON DELETE CASCADE,
          uuid               TEXT,
          name               TEXT,
          rpo_secs           INTEGER,
          remote_targets_json TEXT,
          categories_json    TEXT,
          updated_at         TEXT DEFAULT CURRENT_TIMESTAMP
        );
        CREATE INDEX IF NOT EXISTS idx_nutanix_protection_policies_source ON nutanix_protection_policies(source_id);

        CREATE TABLE IF NOT EXISTS nutanix_recovery_points (
          id             INTEGER PRIMARY KEY AUTOINCREMENT,
          source_id      INTEGER NOT NULL REFERENCES nutanix_sources(id) ON DELETE CASCADE,
          kind           TEXT,
          pd_name        TEXT,
          vm_uuid        TEXT,
          vm_name        TEXT,
          created_at_ts  TEXT,
          expires_at_ts  TEXT,
          location       TEXT,
          size_bytes     INTEGER,
          updated_at     TEXT DEFAULT CURRENT_TIMESTAMP
        );
        CREATE INDEX IF NOT EXISTS idx_nutanix_recovery_points_source ON nutanix_recovery_points(source_id);

        CREATE TABLE IF NOT EXISTS nutanix_metrics_history (
          id                       INTEGER PRIMARY KEY AUTOINCREMENT,
          cluster_id               INTEGER NOT NULL REFERENCES nutanix_clusters(id) ON DELETE CASCADE,
          captured_at              TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
          storage_capacity_bytes   INTEGER,
          storage_usage_bytes      INTEGER,
          cpu_usage_ppm            INTEGER,
          memory_usage_ppm         INTEGER,
          controller_iops          INTEGER,
          controller_latency_usecs INTEGER,
          replication_tx_kbps      INTEGER
        );
        CREATE INDEX IF NOT EXISTS idx_nutanix_metrics_history_cluster ON nutanix_metrics_history(cluster_id, captured_at);

        CREATE TABLE IF NOT EXISTS nutanix_issue_history (
          id          INTEGER PRIMARY KEY AUTOINCREMENT,
          issue_key   TEXT NOT NULL,
          source      TEXT,
          severity    TEXT,
          type        TEXT,
          target      TEXT,
          message     TEXT,
          status      TEXT NOT NULL DEFAULT 'open',
          first_seen  TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
          last_seen   TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
          resolved_at TEXT
        );
        CREATE INDEX IF NOT EXISTS idx_nutanix_issue_hist_key ON nutanix_issue_history(issue_key, status);
        CREATE INDEX IF NOT EXISTS idx_nutanix_issue_hist_seen ON nutanix_issue_history(last_seen);

        CREATE TABLE IF NOT EXISTS nutanix_ai_reports (
          report_key    TEXT PRIMARY KEY,
          model         TEXT,
          content       TEXT NOT NULL,
          generated_at  DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
        );

        CREATE TABLE IF NOT EXISTS nutanix_move_conns (
          id                    INTEGER PRIMARY KEY AUTOINCREMENT,
          name                  TEXT NOT NULL UNIQUE,
          host                  TEXT NOT NULL,
          username              TEXT,
          encrypted_credentials TEXT,
          ssl_verify            INTEGER DEFAULT 0,
          appliance_version     TEXT,
          last_poll_status      TEXT,
          last_poll_error       TEXT,
          last_poll_at          TEXT,
          created_at            TEXT DEFAULT CURRENT_TIMESTAMP,
          updated_at            TEXT DEFAULT CURRENT_TIMESTAMP
        );

        CREATE TABLE IF NOT EXISTS nutanix_move_plans (
          id                INTEGER PRIMARY KEY AUTOINCREMENT,
          conn_id           INTEGER NOT NULL REFERENCES nutanix_move_conns(id) ON DELETE CASCADE,
          plan_uuid         TEXT,
          name              TEXT,
          state             TEXT,
          migration_status  TEXT,
          progress          REAL,
          source_provider   TEXT,
          target_provider   TEXT,
          vm_count          INTEGER,
          updated_at        TEXT DEFAULT CURRENT_TIMESTAMP
        );
        CREATE INDEX IF NOT EXISTS idx_nutanix_move_plans_conn ON nutanix_move_plans(conn_id);

        CREATE TABLE IF NOT EXISTS nutanix_move_workloads (
          id          INTEGER PRIMARY KEY AUTOINCREMENT,
          conn_id     INTEGER NOT NULL REFERENCES nutanix_move_conns(id) ON DELETE CASCADE,
          plan_uuid   TEXT,
          plan_name   TEXT,
          vm_uuid     TEXT,
          vm_name     TEXT,
          state_code  INTEGER,
          state_label TEXT,
          progress    REAL,
          updated_at  TEXT DEFAULT CURRENT_TIMESTAMP
        );
        CREATE INDEX IF NOT EXISTS idx_nutanix_move_workloads_conn ON nutanix_move_workloads(conn_id);

        CREATE TABLE IF NOT EXISTS nutanix_move_events (
          id             INTEGER PRIMARY KEY AUTOINCREMENT,
          conn_id        INTEGER NOT NULL REFERENCES nutanix_move_conns(id) ON DELETE CASCADE,
          event_id       TEXT,
          event_name     TEXT,
          vm_name        TEXT,
          plan_name      TEXT,
          status         TEXT,
          failure_notes  TEXT,
          created_usecs  INTEGER,
          created_at     TEXT
        );
        CREATE INDEX IF NOT EXISTS idx_nutanix_move_events_conn ON nutanix_move_events(conn_id);
      `);
    },
  },
];
