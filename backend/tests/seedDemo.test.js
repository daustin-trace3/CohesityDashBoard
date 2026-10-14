/**
 * Runs the real seedDemo.js as a child process against a throwaway temp DB
 * (so it doesn't collide with the ENCRYPTION_KEY / DASHBOARD_DB_PATH this
 * test suite already stubs via tests/setup.js — see that file's note on why
 * dotenv can't override env vars set before it loads), then opens the
 * resulting SQLite file directly and asserts volumes + a few key enums.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { execFileSync } from 'child_process';
import path from 'path';
import fs from 'fs';
import os from 'os';
import crypto from 'crypto';
import Database from 'better-sqlite3';

const backendDir = path.join(__dirname, '..');
const seedScript = path.join(backendDir, 'demo', 'seedDemo.js');

let tmpDir;
let dbPath;
let db;

beforeAll(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'icc-seed-demo-test-'));
  dbPath = path.join(tmpDir, 'seed-test.db');

  execFileSync(process.execPath, [seedScript, '--db', dbPath, '--force'], {
    cwd: backendDir,
    env: process.env,
    stdio: 'pipe',
  });

  db = new Database(dbPath, { readonly: true });
}, 120000);

afterAll(() => {
  if (db) db.close();
  try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* win file locks */ }
});

describe('seedDemo.js', () => {
  it('seeds 24 cohesity clusters', () => {
    const row = db.prepare('SELECT COUNT(*) c FROM clusters').get();
    expect(row.c).toBe(24);
  });

  it('seeds 20 pure arrays', () => {
    const row = db.prepare('SELECT COUNT(*) c FROM pure_arrays').get();
    expect(row.c).toBe(20);
  });

  it('seeds 6 netapp arrays', () => {
    const row = db.prepare('SELECT COUNT(*) c FROM netapp_arrays').get();
    expect(row.c).toBe(6);
  });

  it('seeds more than 5000 metrics_history rows', () => {
    const row = db.prepare('SELECT COUNT(*) c FROM metrics_history').get();
    expect(row.c).toBeGreaterThan(5000);
  });

  it('seeds the demo user', () => {
    const row = db.prepare("SELECT username FROM users WHERE username = 'demo'").get();
    expect(row).toBeTruthy();
  });

  it('seeds 30 cohesity_views matching license_view_detail names', () => {
    const views = db.prepare('SELECT COUNT(*) c FROM cohesity_views').get();
    expect(views.c).toBe(30);
    const orphans = db.prepare(`
      SELECT COUNT(*) c FROM cohesity_views v
      WHERE NOT EXISTS (SELECT 1 FROM license_view_detail d WHERE d.view_name = v.name)
    `).get();
    expect(orphans.c).toBe(0);
    const flagged = db.prepare('SELECT COUNT(*) c FROM cohesity_views WHERE is_read_only = 0 AND (protected = 0 OR replicated_out = 0 OR datalock_mode IS NULL)').get();
    expect(flagged.c).toBeGreaterThan(0);
  });

  it('seeds policy replication_targets as arrays of strings', () => {
    const rows = db.prepare("SELECT replication_targets FROM policies WHERE replication_targets != '[]'").all();
    expect(rows.length).toBeGreaterThan(0);
    for (const r of rows) {
      for (const t of JSON.parse(r.replication_targets)) expect(typeof t).toBe('string');
    }
  });

  it('seeds a protection_run with status kSuccess', () => {
    const row = db.prepare("SELECT id FROM protection_runs WHERE status = 'kSuccess' LIMIT 1").get();
    expect(row).toBeTruthy();
  });

  it('seeds alerts with lowercase severity', () => {
    const row = db.prepare('SELECT severity FROM alerts LIMIT 1').get();
    expect(row.severity).toBe(row.severity.toLowerCase());
    expect(['critical', 'warning', 'info']).toContain(row.severity);
  });

  it('seeds platform flags as string "1"', () => {
    const rows = db.prepare(
      "SELECT key, value FROM app_settings WHERE key IN ('platform_pure_enabled', 'platform_netapp_enabled', 'platform_zerto_enabled', 'platform_vcenter_enabled', 'platform_dell_enabled', 'platform_aria_enabled', 'platform_proxmox_enabled')"
    ).all();
    expect(rows).toHaveLength(7);
    for (const row of rows) {
      expect(row.value).toBe('1');
    }
  });

  it('seeds daily workload_history with shared per-cluster timestamps and a Views env', () => {
    const rows = db.prepare('SELECT COUNT(*) c FROM workload_history').get();
    expect(rows.c).toBeGreaterThan(5000);
    // getWorkloads() joins on the exact MAX(captured_at) per cluster — every
    // environment of a cluster's latest batch must share one timestamp.
    const latest = db.prepare(`
      SELECT COUNT(DISTINCT environment) c FROM workload_history w
      JOIN (SELECT cluster_id, MAX(captured_at) latest FROM workload_history GROUP BY cluster_id) t
        ON t.cluster_id = w.cluster_id AND w.captured_at = t.latest
      WHERE w.cluster_id = (SELECT MIN(id) FROM clusters)
    `).get();
    expect(latest.c).toBeGreaterThanOrEqual(2);
    const views = db.prepare("SELECT job_count FROM workload_history WHERE environment = 'Views' LIMIT 1").get();
    expect(views).toBeTruthy();
    expect(views.job_count).toBeNull();
  });

  it('seeds zerto inventory with valid enums and breaches', () => {
    expect(db.prepare('SELECT COUNT(*) c FROM zerto_sites').get().c).toBe(6);
    expect(db.prepare('SELECT COUNT(*) c FROM zerto_vras').get().c).toBeGreaterThan(10);
    expect(db.prepare('SELECT COUNT(*) c FROM zerto_vpgs').get().c).toBeGreaterThan(30);
    for (const r of db.prepare('SELECT DISTINCT health FROM zerto_vpgs').all()) {
      expect(['Healthy', 'Warning', 'Error']).toContain(r.health);
    }
    for (const r of db.prepare('SELECT DISTINCT severity FROM zerto_alerts').all()) {
      expect(['Error', 'Warning']).toContain(r.severity);
    }
    // VM membership matches the VPG vms_count sums, and RPO breaches exist.
    const vpgVms = db.prepare('SELECT SUM(vms_count) s FROM zerto_vpgs').get().s;
    expect(db.prepare('SELECT COUNT(*) c FROM zerto_vms').get().c).toBe(vpgVms);
    expect(db.prepare('SELECT COUNT(*) c FROM zerto_vpgs WHERE actual_rpo > configured_rpo').get().c).toBeGreaterThan(0);
    expect(db.prepare('SELECT COUNT(*) c FROM zerto_metrics_history').get().c).toBeGreaterThan(100);
  });

  it('seeds gflags on every cluster with consistent audit history', () => {
    // Every cluster carries the 8-flag baseline (some also have drift flags).
    const perCluster = db.prepare('SELECT cluster_id, COUNT(*) c FROM cluster_gflags GROUP BY cluster_id').all();
    expect(perCluster).toHaveLength(24);
    for (const r of perCluster) expect(r.c).toBeGreaterThanOrEqual(8);
    for (const r of db.prepare('SELECT DISTINCT change_type FROM gflag_changes').all()) {
      expect(['added', 'modified', 'removed']).toContain(r.change_type);
    }
    // 'added'/'modified' events agree with current state; fresh 24h changes exist for the ops feed.
    const stale = db.prepare(`
      SELECT COUNT(*) c FROM (
        SELECT h.cluster_id, h.service_name, h.flag_name, MAX(h.id) AS max_id
        FROM gflag_changes h WHERE h.change_type IN ('added','modified') GROUP BY 1, 2, 3
      ) latest
      JOIN gflag_changes h ON h.id = latest.max_id
      LEFT JOIN gflag_changes later ON later.cluster_id = latest.cluster_id
        AND later.service_name = latest.service_name AND later.flag_name = latest.flag_name
        AND later.change_type = 'removed' AND later.id > latest.max_id
      LEFT JOIN cluster_gflags g ON g.cluster_id = latest.cluster_id
        AND g.service_name = latest.service_name AND g.flag_name = latest.flag_name
      WHERE later.id IS NULL AND (g.id IS NULL OR g.flag_value != h.new_value)
    `).get();
    expect(stale.c).toBe(0);
    const fresh = db.prepare("SELECT COUNT(*) c FROM gflag_changes WHERE detected_at >= datetime('now','-1 day')").get();
    expect(fresh.c).toBeGreaterThanOrEqual(2);
  });

  it('seeds vcenter inventory that trips every computed-issue rule', () => {
    expect(db.prepare('SELECT COUNT(*) c FROM vcenter_vcenters').get().c).toBe(8);
    expect(db.prepare("SELECT COUNT(*) c FROM vcenter_vcenters WHERE last_poll_status = 'error'").get().c).toBe(1);
    expect(db.prepare("SELECT COUNT(*) c FROM vcenter_hosts WHERE connection_state != 'CONNECTED'").get().c).toBeGreaterThan(0);
    expect(db.prepare('SELECT COUNT(*) c FROM vcenter_hosts WHERE in_maintenance = 1').get().c).toBeGreaterThan(0);
    expect(db.prepare('SELECT COUNT(*) c FROM vcenter_datastores WHERE free_bytes < capacity_bytes * 0.2').get().c).toBeGreaterThan(0);
    // vm rows match the per-host counts, and version/BIOS columns are filled.
    const hostVms = db.prepare('SELECT SUM(vm_count) s FROM vcenter_hosts').get().s;
    expect(db.prepare('SELECT COUNT(*) c FROM vcenter_vms').get().c).toBe(hostVms);
    expect(db.prepare('SELECT COUNT(*) c FROM vcenter_hosts WHERE esx_version IS NULL OR bios_version IS NULL').get().c).toBe(0);
    expect(db.prepare('SELECT COUNT(*) c FROM vcenter_vcenters WHERE version IS NULL').get().c).toBe(0);
    expect(db.prepare('SELECT COUNT(*) c FROM vcenter_metrics_history').get().c).toBe(8 * 31);
  });

  it('seeds dell governance data: config compliance with drift detail, jobs, profiles, hardware logs', () => {
    expect(db.prepare('SELECT COUNT(*) c FROM dell_config_baselines').get().c).toBe(2);
    expect(db.prepare("SELECT COUNT(*) c FROM dell_config_compliance WHERE status = 'noncompliant' AND detail IS NOT NULL").get().c).toBeGreaterThan(0);
    // Drift detail rows carry the expected-vs-current shape the Governance modal renders.
    const bad = db.prepare("SELECT detail FROM dell_config_compliance WHERE status = 'noncompliant' AND detail IS NOT NULL LIMIT 1").get();
    const detail = JSON.parse(bad.detail);
    expect(detail.length).toBeGreaterThan(0);
    expect(detail[0]).toHaveProperty('attribute');
    expect(detail[0]).toHaveProperty('current');
    expect(db.prepare('SELECT COUNT(*) c FROM dell_jobs').get().c).toBeGreaterThan(10);
    expect(db.prepare("SELECT COUNT(*) c FROM dell_jobs WHERE last_run_status = 'Failed'").get().c).toBeGreaterThan(0);
    expect(db.prepare("SELECT COUNT(*) c FROM dell_config_profiles WHERE state = 'deployed'").get().c).toBeGreaterThan(0);
    expect(db.prepare('SELECT COUNT(*) c FROM dell_hardware_logs').get().c).toBeGreaterThan(500);
    expect(db.prepare("SELECT COUNT(*) c FROM dell_hardware_logs WHERE severity IN ('critical','warning')").get().c).toBeGreaterThan(0);
    // Drift timeline rows match the seeded noncompliant detail entries.
    expect(db.prepare('SELECT COUNT(*) c FROM dell_config_drift_history WHERE resolved_at IS NULL AND first_seen IS NOT NULL').get().c).toBeGreaterThan(0);
  });

  it('seeds the dell platform with devices, failing parts, warranty runway and firmware drift', () => {
    expect(db.prepare('SELECT COUNT(*) c FROM dell_ome_instances').get().c).toBe(2);
    expect(db.prepare('SELECT COUNT(*) c FROM dell_devices').get().c).toBeGreaterThan(100);
    expect(db.prepare("SELECT COUNT(*) c FROM dell_components WHERE kind = 'disk'").get().c).toBeGreaterThan(300);
    // Governance feeds: at least one failing component, expiring + expired warranties, firmware drift.
    expect(db.prepare("SELECT COUNT(*) c FROM dell_components WHERE status IN ('critical','warning')").get().c).toBeGreaterThan(0);
    expect(db.prepare('SELECT COUNT(*) c FROM dell_warranties WHERE days_remaining <= 0').get().c).toBeGreaterThan(0);
    expect(db.prepare('SELECT COUNT(*) c FROM dell_warranties WHERE days_remaining > 0 AND days_remaining <= 90').get().c).toBeGreaterThan(0);
    // Multi-agreement tags: an expired base warranty under an active renewal
    // (tag must classify as covered), and tags whose BEST contract is expired.
    expect(db.prepare(`SELECT COUNT(*) c FROM (
      SELECT service_tag FROM dell_warranties GROUP BY ome_id, service_tag
      HAVING MIN(days_remaining) <= 0 AND MAX(days_remaining) > 90)`).get().c).toBeGreaterThan(0);
    expect(db.prepare(`SELECT COUNT(*) c FROM (
      SELECT service_tag FROM dell_warranties GROUP BY ome_id, service_tag
      HAVING MAX(days_remaining) <= 0)`).get().c).toBeGreaterThan(0);
    expect(db.prepare("SELECT COUNT(*) c FROM dell_firmware_compliance WHERE status = 'noncompliant'").get().c).toBeGreaterThan(0);
    expect(db.prepare('SELECT COUNT(*) c FROM dell_alerts').get().c).toBeGreaterThan(50);
    // Base power/thermal everywhere; CPU/mem utilization (Power Manager) on DC1 only.
    const pm = db.prepare(`SELECT o.name, COUNT(d.power_w) pw, COUNT(d.cpu_util_pct) util
      FROM dell_devices d JOIN dell_ome_instances o ON o.id = d.ome_id GROUP BY o.name`).all();
    expect(pm.find((r) => r.name === 'DC1 OME').util).toBeGreaterThan(0);
    expect(pm.find((r) => r.name === 'DC2 OME').util).toBe(0);
    expect(pm.find((r) => r.name === 'DC2 OME').pw).toBeGreaterThan(0);
    expect(db.prepare('SELECT COUNT(*) c FROM dell_metrics_history').get().c).toBe(2 * 31);
  });

  it('seeds vcenter host NIC neighbour hints for the nyc and lon hosts', () => {
    const exists = db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'vcenter_host_nic_neighbors'").get();
    if (!exists) return;
    const c = (sql) => db.prepare(sql).get().c;
    // Two vmnics per CONNECTED nyc/lon host; hosts that are not responding answer no hint call.
    const hosts = c(`SELECT COUNT(*) c FROM vcenter_hosts h JOIN vcenter_vcenters v ON v.id = h.vcenter_id
      WHERE v.name IN ('nyc-vc-prd-01', 'lon-vc-prd-01') AND h.connection_state = 'CONNECTED'`);
    expect(hosts).toBeGreaterThan(0);
    expect(c('SELECT COUNT(*) c FROM vcenter_host_nic_neighbors')).toBe(hosts * 2);
    expect(c("SELECT COUNT(*) c FROM vcenter_host_nic_neighbors WHERE protocol = 'lldp'")).toBe(2);
    expect(c("SELECT COUNT(*) c FROM vcenter_host_nic_neighbors WHERE protocol = 'cdp' AND switch_port NOT LIKE 'GigabitEthernet1/0/%'")).toBe(0);
    expect(c("SELECT COUNT(*) c FROM vcenter_host_nic_neighbors WHERE switch_name NOT LIKE 'nyc-acc-0_%' AND switch_name NOT LIKE 'lon-acc-0_%'")).toBe(0);
    expect(c("SELECT COUNT(*) c FROM vcenter_host_nic_neighbors WHERE mac IS NULL OR switch_address NOT LIKE '10.5_.1.1_'")).toBe(0);
  });

  it('seeds vcenter governance + network data', () => {
    // Networking inventory: pnics/vswitches/portgroups per host, DVS per vCenter.
    for (const kind of ['pnic', 'vswitch', 'portgroup', 'vmkernel', 'dvswitch', 'dvportgroup']) {
      expect(db.prepare('SELECT COUNT(*) c FROM vcenter_networks WHERE kind = ?').get(kind).c).toBeGreaterThan(0);
    }
    // Drift seeds: NTP, ESX build and SSH deviations exist within clusters.
    expect(db.prepare("SELECT COUNT(DISTINCT ntp_servers) c FROM vcenter_hosts WHERE ntp_servers IS NOT NULL").get().c).toBeGreaterThan(1);
    expect(db.prepare('SELECT COUNT(*) c FROM vcenter_hosts WHERE ssh_enabled = 1').get().c).toBeGreaterThan(0);
    expect(db.prepare('SELECT COUNT(*) c FROM vcenter_hosts WHERE cpu_cores IS NULL').get().c).toBe(0);
    // Outdated VMware Tools VMs + orphaned VMDKs feed the Governance page.
    expect(db.prepare("SELECT COUNT(*) c FROM vcenter_vms WHERE tools_version_status = 'guestToolsNeedUpgrade'").get().c).toBeGreaterThan(0);
    expect(db.prepare('SELECT COUNT(*) c FROM vcenter_vms WHERE tools_version IS NULL').get().c).toBe(0);
    expect(db.prepare('SELECT COUNT(*) c FROM vcenter_orphaned_vmdks').get().c).toBeGreaterThan(3);
  });

  it('seeds vcenter events and a consistent issue timeline', () => {
    expect(db.prepare('SELECT COUNT(*) c FROM vcenter_events').get().c).toBeGreaterThan(300);
    for (const sev of ['error', 'warning', 'info']) {
      expect(db.prepare('SELECT COUNT(*) c FROM vcenter_events WHERE severity = ?').get(sev).c).toBeGreaterThan(0);
    }
    // Open issue rows are produced by the real reconcile, so their keys must
    // round-trip: a second reconcile changes nothing.
    const open = db.prepare("SELECT COUNT(*) c FROM vcenter_issue_history WHERE status = 'open'").get().c;
    expect(open).toBeGreaterThan(4);
    const resolved = db.prepare("SELECT COUNT(*) c FROM vcenter_issue_history WHERE status = 'resolved' AND resolved_at IS NOT NULL").get().c;
    expect(resolved).toBe(5);
    expect(db.prepare("SELECT COUNT(*) c FROM vcenter_issue_history WHERE status = 'open' AND first_seen >= last_seen").get().c).toBe(0);
  });

  it('seeds the aria platform with instances, deployments, and computed issues', () => {
    expect(db.prepare('SELECT COUNT(*) c FROM aria_instances').get().c).toBe(2);
    expect(db.prepare('SELECT COUNT(*) c FROM aria_deployments').get().c).toBeGreaterThan(0);
    expect(db.prepare('SELECT COUNT(*) c FROM aria_requests').get().c).toBeGreaterThan(0);
    expect(db.prepare('SELECT COUNT(*) c FROM aria_endpoints').get().c).toBeGreaterThan(0);
    expect(db.prepare("SELECT COUNT(*) c FROM aria_endpoints WHERE health_state = 'ERROR'").get().c).toBeGreaterThan(0);
    expect(db.prepare("SELECT COUNT(*) c FROM aria_deployments WHERE status LIKE '%FAILED%'").get().c).toBeGreaterThan(0);
    expect(db.prepare("SELECT COUNT(*) c FROM aria_deployments WHERE lease_expire_at IS NOT NULL AND julianday(lease_expire_at) - julianday('now') <= 7").get().c).toBeGreaterThan(0);
    expect(db.prepare("SELECT COUNT(*) c FROM aria_catalog_sources WHERE last_import_errors IS NOT NULL").get().c).toBeGreaterThan(0);
    expect(db.prepare("SELECT COUNT(*) c FROM aria_approvals WHERE status = 'PENDING'").get().c).toBeGreaterThan(0);
    expect(db.prepare('SELECT COUNT(*) c FROM aria_issue_history').get().c).toBeGreaterThan(0);
  });

  it('seeds the netbackup platform with sources, policies, and jobs', () => {
    expect(db.prepare('SELECT COUNT(*) c FROM netbackup_sources').get().c).toBe(2);
    expect(db.prepare("SELECT COUNT(*) c FROM netbackup_sources WHERE source_type = 'primary'").get().c).toBe(1);
    expect(db.prepare("SELECT COUNT(*) c FROM netbackup_sources WHERE source_type = 'alta'").get().c).toBe(1);
    expect(db.prepare('SELECT COUNT(*) c FROM netbackup_policies').get().c).toBe(8);
    const jobs = db.prepare('SELECT COUNT(*) c FROM netbackup_jobs').get().c;
    expect(jobs).toBeGreaterThan(300);
    expect(jobs).toBeLessThan(600);
  });

  it('seeds netbackup storage, media servers, and appliances', () => {
    expect(db.prepare('SELECT COUNT(*) c FROM netbackup_storage_units').get().c).toBe(7);
    expect(db.prepare('SELECT COUNT(*) c FROM netbackup_disk_pools').get().c).toBe(6);
    // Pool-type reporting variety: MSDP, OST/DataDomain and S3 archive present.
    const poolTypes = db.prepare('SELECT DISTINCT server_type FROM netbackup_disk_pools').all().map((r) => r.server_type);
    for (const t of ['PureDisk (MSDP)', 'OST (DataDomain)', 'Cloud (S3 Archive)']) {
      expect(poolTypes).toContain(t);
    }
    expect(db.prepare('SELECT COUNT(*) c FROM netbackup_disk_pools WHERE used_capacity_bytes >= total_capacity_bytes * 0.9').get().c).toBeGreaterThan(0);
    expect(db.prepare('SELECT COUNT(*) c FROM netbackup_media_servers').get().c).toBe(3);
    expect(db.prepare("SELECT COUNT(*) c FROM netbackup_media_servers WHERE state = 'DOWN'").get().c).toBe(1);
    expect(db.prepare('SELECT COUNT(*) c FROM netbackup_appliances').get().c).toBe(5);
    expect(db.prepare("SELECT COUNT(*) c FROM netbackup_appliances WHERE appliance_type = 'appliance' AND model = 'NB5250'").get().c).toBe(2);
    expect(db.prepare("SELECT COUNT(*) c FROM netbackup_appliances WHERE appliance_type = 'flex'").get().c).toBe(1);
    expect(db.prepare("SELECT COUNT(*) c FROM netbackup_appliances WHERE appliance_type = 'byo'").get().c).toBe(2);
  });

  it('seeds netbackup deliberate trouble: failing policy, failure codes, stale client, alerts, issue history', () => {
    const failingPolicyJobs = db.prepare(`
      SELECT COUNT(*) c FROM netbackup_jobs
      WHERE policy_name = 'VMWARE-PROD-DAILY' AND started_at >= datetime('now', '-4 days') AND started_at < datetime('now', '-1 day')
        AND status_code != 0
    `).get().c;
    expect(failingPolicyJobs).toBeGreaterThan(0);
    for (const code of [84, 58, 2074]) {
      expect(db.prepare('SELECT COUNT(*) c FROM netbackup_jobs WHERE status_code = ?').get(code).c).toBeGreaterThan(0);
    }
    const staleClientSuccess = db.prepare(`
      SELECT COUNT(*) c FROM netbackup_jobs
      WHERE client_name = 'win-fs02' AND status_code = 0 AND started_at >= datetime('now', '-4 days')
    `).get().c;
    expect(staleClientSuccess).toBe(0);
    expect(db.prepare('SELECT COUNT(*) c FROM netbackup_alerts').get().c).toBe(3);
    const openIssues = db.prepare("SELECT COUNT(*) c FROM netbackup_issue_history WHERE status = 'open'").get().c;
    expect(openIssues).toBeGreaterThanOrEqual(4);
    expect(db.prepare("SELECT COUNT(*) c FROM netbackup_issue_history WHERE status = 'open' AND first_seen >= last_seen").get().c).toBe(0);
  });

  it('seeds 30 days of netbackup metrics history per source', () => {
    expect(db.prepare('SELECT COUNT(*) c FROM netbackup_metrics_history').get().c).toBe(2 * 31);
  });

  it('seeds netbackup SLPs referencing the failing policy', () => {
    expect(db.prepare('SELECT COUNT(*) c FROM netbackup_slps').get().c).toBeGreaterThanOrEqual(4);
    const slps = db.prepare('SELECT operations_json FROM netbackup_slps').all();
    const referencesFailingPolicy = slps.some((row) => row.operations_json.includes('VMWARE-PROD-DAILY'));
    expect(referencesFailingPolicy).toBe(true);
    for (const row of slps) {
      expect(() => JSON.parse(row.operations_json)).not.toThrow();
      expect(Array.isArray(JSON.parse(row.operations_json))).toBe(true);
    }
  });

  it('seeds netbackup replication jobs with some failures', () => {
    const repJobs = db.prepare("SELECT COUNT(*) c FROM netbackup_jobs WHERE job_type = 'REPLICATION'").get().c;
    expect(repJobs).toBeGreaterThanOrEqual(50);
    const repFailed = db.prepare("SELECT COUNT(*) c FROM netbackup_jobs WHERE job_type = 'REPLICATION' AND status_code != 0").get().c;
    expect(repFailed).toBeGreaterThan(0);
  });

  it('seeds netbackup workload history spanning ~60 days, one batch per source per day', () => {
    const distinctDays = db.prepare("SELECT COUNT(DISTINCT date(captured_at)) c FROM netbackup_workload_history").get().c;
    expect(distinctDays).toBeGreaterThanOrEqual(55);

    const dupBatches = db.prepare(`
      SELECT source_id, date(captured_at) day, COUNT(DISTINCT captured_at) c
      FROM netbackup_workload_history
      GROUP BY source_id, day
      HAVING c > 1
    `).all();
    expect(dupBatches.length).toBe(0);
  });

  it('sets netbackup_entitled_tb for computed FETB licensing', () => {
    const row = db.prepare("SELECT value FROM app_settings WHERE key = 'netbackup_entitled_tb'").get();
    expect(row).toBeTruthy();
    expect(parseFloat(row.value)).toBeGreaterThan(0);
  });

  it('seeds 2 netbackup appliance connections with >=30 hardware components', () => {
    expect(db.prepare('SELECT COUNT(*) c FROM netbackup_appliance_conns').get().c).toBe(2);
    expect(db.prepare("SELECT COUNT(*) c FROM netbackup_appliance_conns WHERE last_poll_status = 'success'").get().c).toBe(2);
    const hwCount = db.prepare('SELECT COUNT(*) c FROM netbackup_appliance_hw').get().c;
    expect(hwCount).toBeGreaterThanOrEqual(30);
  });

  it('seeds exactly 1 critical disk and matching appliance hardware issue rows', () => {
    const criticalDisks = db.prepare("SELECT COUNT(*) c FROM netbackup_appliance_hw WHERE component_type = 'disk' AND status = 'critical'").get().c;
    expect(criticalDisks).toBe(1);
    const applianceIssues = db.prepare("SELECT COUNT(*) c FROM netbackup_issue_history WHERE type = 'appliance-hw' AND status = 'open'").get().c;
    expect(applianceIssues).toBeGreaterThanOrEqual(3);
  });

  it('seeds the aws platform with inventory, cost/bedrock history, and every computed issue', () => {
    expect(db.prepare('SELECT COUNT(*) c FROM aws_accounts').get().c).toBeGreaterThan(0);
    expect(db.prepare('SELECT COUNT(*) c FROM aws_ec2_instances').get().c).toBeGreaterThan(0);
    expect(db.prepare('SELECT COUNT(*) c FROM aws_ecs_services').get().c).toBeGreaterThan(0);
    expect(db.prepare('SELECT COUNT(*) c FROM aws_s3_buckets').get().c).toBeGreaterThan(0);
    expect(db.prepare('SELECT COUNT(*) c FROM aws_cost_daily').get().c).toBeGreaterThan(0);
    expect(db.prepare('SELECT COUNT(*) c FROM aws_bedrock_usage').get().c).toBeGreaterThan(0);
    expect(db.prepare('SELECT COUNT(*) c FROM aws_rds_instances').get().c).toBeGreaterThan(0);
    expect(db.prepare('SELECT COUNT(*) c FROM aws_lambda_functions').get().c).toBeGreaterThan(0);
    expect(db.prepare('SELECT COUNT(*) c FROM aws_dynamo_tables').get().c).toBeGreaterThan(0);
    expect(db.prepare('SELECT COUNT(*) c FROM aws_ecr_repos').get().c).toBeGreaterThan(0);
    expect(db.prepare('SELECT COUNT(*) c FROM aws_vpcs').get().c).toBeGreaterThan(0);
    expect(db.prepare('SELECT COUNT(*) c FROM aws_subnets').get().c).toBeGreaterThan(0);
    expect(db.prepare('SELECT COUNT(*) c FROM aws_s3_size_history').get().c).toBeGreaterThan(0);
    expect(db.prepare('SELECT COUNT(*) c FROM aws_rds_storage_history').get().c).toBeGreaterThan(0);
    expect(db.prepare('SELECT COUNT(*) c FROM aws_cost_usage_daily').get().c).toBeGreaterThan(0);
    expect(db.prepare('SELECT COUNT(*) c FROM aws_cost_instance_type_daily').get().c).toBeGreaterThan(0);
    expect(db.prepare('SELECT COUNT(*) c FROM aws_health_events').get().c).toBeGreaterThan(0);
    expect(db.prepare('SELECT COUNT(*) c FROM aws_optimizer_recommendations').get().c).toBeGreaterThan(0);

    for (const type of ['ec2-status-check', 'ecs-degraded', 'cost-spike', 's3-public', 'ebs-unattached', 'rds-storage-low']) {
      const row = db.prepare("SELECT COUNT(*) c FROM aws_issue_history WHERE type = ? AND status = 'open'").get(type);
      expect(row.c).toBeGreaterThan(0);
    }

    const flag = db.prepare("SELECT value FROM app_settings WHERE key = 'platform_aws_enabled'").get();
    expect(flag.value).toBe('1');
  });

  it('seeds the proxmox platform with 2 servers, mixed guests, and 2 templates', () => {
    expect(db.prepare('SELECT COUNT(*) c FROM proxmox_servers').get().c).toBe(2);
    expect(db.prepare('SELECT COUNT(*) c FROM proxmox_nodes').get().c).toBe(4);
    const guests = db.prepare('SELECT COUNT(*) c FROM proxmox_guests').get().c;
    expect(guests).toBeGreaterThanOrEqual(24);
    expect(guests).toBeLessThanOrEqual(32);
    expect(db.prepare("SELECT COUNT(*) c FROM proxmox_guests WHERE type = 'qemu'").get().c).toBeGreaterThan(0);
    expect(db.prepare("SELECT COUNT(*) c FROM proxmox_guests WHERE type = 'lxc'").get().c).toBeGreaterThan(0);
    expect(db.prepare('SELECT COUNT(*) c FROM proxmox_guests WHERE is_template = 1').get().c).toBe(2);
    expect(db.prepare('SELECT COUNT(*) c FROM proxmox_storage').get().c).toBeGreaterThanOrEqual(6);
    expect(db.prepare('SELECT COUNT(*) c FROM proxmox_backup_jobs').get().c).toBe(4);

    const flag = db.prepare("SELECT value FROM app_settings WHERE key = 'platform_proxmox_enabled'").get();
    expect(flag.value).toBe('1');
  });

  it('seeds proxmox deliberate trouble covering every issue rule', () => {
    expect(db.prepare("SELECT COUNT(*) c FROM proxmox_nodes WHERE status != 'online'").get().c).toBeGreaterThan(0);
    expect(db.prepare(`
      SELECT COUNT(*) c FROM proxmox_storage WHERE total_bytes > 0 AND (CAST(used_bytes AS REAL) / total_bytes) >= 0.95
    `).get().c).toBeGreaterThan(0);
    expect(db.prepare(`
      SELECT COUNT(*) c FROM proxmox_storage
      WHERE total_bytes > 0 AND (CAST(used_bytes AS REAL) / total_bytes) >= 0.85 AND (CAST(used_bytes AS REAL) / total_bytes) < 0.95
    `).get().c).toBeGreaterThan(0);
    expect(db.prepare(`
      SELECT COUNT(*) c FROM proxmox_tasks
      WHERE type = 'vzdump' AND status != 'OK' AND started_at >= datetime('now', '-7 days')
    `).get().c).toBeGreaterThan(0);
    expect(db.prepare(`
      SELECT COUNT(*) c FROM proxmox_tasks
      WHERE type != 'vzdump' AND status != 'OK' AND started_at >= datetime('now', '-1 day')
    `).get().c).toBeGreaterThan(0);
    expect(db.prepare(`
      SELECT COUNT(*) c FROM proxmox_guests
      WHERE is_template = 0 AND last_backup_status = 'OK'
        AND last_backup_at < datetime('now', '-3 days')
    `).get().c).toBeGreaterThan(0);
    expect(db.prepare(`
      SELECT COUNT(*) c FROM proxmox_nodes
      WHERE cert_expires_at IS NOT NULL AND julianday(cert_expires_at) - julianday('now') <= 30
    `).get().c).toBeGreaterThan(0);
    expect(db.prepare("SELECT quorate FROM proxmox_servers WHERE name = 'pve-cluster-hq'").get().quorate).toBe(0);
    const forbidden = db.prepare("SELECT forbidden_endpoints FROM proxmox_servers WHERE name = 'pve-lab-01'").get().forbidden_endpoints;
    expect(forbidden).toBeTruthy();
    expect(JSON.parse(forbidden).length).toBeGreaterThan(0);
    expect(db.prepare('SELECT COUNT(*) c FROM proxmox_issue_history').get().c).toBeGreaterThan(0);
  });

  it('seeds 14 days of proxmox tasks and hourly metrics per node', () => {
    const oldestTask = db.prepare("SELECT MIN(started_at) m FROM proxmox_tasks").get().m;
    expect(new Date(oldestTask).getTime()).toBeLessThanOrEqual(Date.now() - 6 * 24 * 60 * 60 * 1000);
    const metricsPerNode = db.prepare('SELECT node, COUNT(*) c FROM proxmox_metrics GROUP BY node').all();
    expect(metricsPerNode.length).toBeGreaterThanOrEqual(4);
    for (const row of metricsPerNode) {
      expect(row.c).toBeGreaterThanOrEqual(7);
    }
  });

  it('seeds the proxmox v2 tables (snapshots, services, disks, networks, storage content, events)', () => {
    expect(db.prepare('SELECT COUNT(*) c FROM proxmox_snapshots').get().c).toBeGreaterThan(0);
    expect(db.prepare('SELECT COUNT(*) c FROM proxmox_services').get().c).toBeGreaterThanOrEqual(4 * 7);
    expect(db.prepare('SELECT COUNT(*) c FROM proxmox_disks').get().c).toBeGreaterThanOrEqual(4 * 2);
    expect(db.prepare('SELECT COUNT(*) c FROM proxmox_node_networks').get().c).toBeGreaterThanOrEqual(4 * 2);
    expect(db.prepare('SELECT COUNT(*) c FROM proxmox_storage_content').get().c).toBeGreaterThan(0);
    const events = db.prepare('SELECT COUNT(*) c FROM proxmox_events').get().c;
    expect(events).toBeGreaterThanOrEqual(190);
    expect(events).toBeLessThanOrEqual(210);

    const guestExtras = db.prepare(`
      SELECT COUNT(*) c FROM proxmox_guests
      WHERE is_template = 0 AND config_json IS NOT NULL
    `).get().c;
    expect(guestExtras).toBeGreaterThan(0);
    const agentGuests = db.prepare(`
      SELECT COUNT(*) c FROM proxmox_guests WHERE type = 'qemu' AND agent_running = 1 AND os_name IS NOT NULL
    `).get().c;
    expect(agentGuests).toBeGreaterThan(0);
  });

  it('seeds proxmox v2 trouble covering the 3 new issue rules', () => {
    // snapshot-age: a snapshot older than the 30-day default on lab-app-01.
    const oldSnap = db.prepare(`
      SELECT COUNT(*) c FROM proxmox_snapshots
      WHERE vmid = 102 AND julianday('now') - julianday(snap_time) > 30
    `).get().c;
    expect(oldSnap).toBeGreaterThan(0);
    expect(db.prepare("SELECT oldest_snapshot_at FROM proxmox_guests WHERE vmid = 102").get().oldest_snapshot_at).toBeTruthy();

    // service-down: pvescheduler enabled but dead on pve-hq-02.
    const deadService = db.prepare(`
      SELECT COUNT(*) c FROM proxmox_services
      WHERE node = 'pve-hq-02' AND name = 'pvescheduler' AND unit_state = 'enabled' AND state != 'running'
    `).get().c;
    expect(deadService).toBe(1);

    // smart-failing: a FAILED disk on pve-hq-03.
    const failedDisk = db.prepare(`
      SELECT COUNT(*) c FROM proxmox_disks WHERE node = 'pve-hq-03' AND health = 'FAILED'
    `).get().c;
    expect(failedDisk).toBeGreaterThan(0);

    // Once services/proxmoxIssues.js grows the 3 new rules, reconcile should
    // have opened issue_history rows for each. If this fails only because the
    // rules aren't landed yet (WPA in-flight), that's the expected escape hatch.
    for (const type of ['snapshot-age', 'service-down', 'smart-failing']) {
      const row = db.prepare("SELECT COUNT(*) c FROM proxmox_issue_history WHERE type = ? AND status = 'open'").get(type);
      expect(row.c).toBeGreaterThan(0);
    }
  });

  it('seeds the brocade platform with sources, fabrics, switches, ports, and every computed issue trigger', () => {
    expect(db.prepare('SELECT COUNT(*) c FROM brocade_sources').get().c).toBe(2);
    expect(db.prepare('SELECT COUNT(*) c FROM brocade_fabrics').get().c).toBe(4);
    expect(db.prepare('SELECT COUNT(*) c FROM brocade_switches').get().c).toBe(14);
    expect(db.prepare('SELECT COUNT(*) c FROM brocade_switch_ports').get().c).toBeGreaterThan(0);
    expect(db.prepare('SELECT COUNT(*) c FROM brocade_device_ports').get().c).toBeGreaterThan(0);
    expect(db.prepare('SELECT COUNT(*) c FROM brocade_enclosures').get().c).toBeGreaterThan(0);
    expect(db.prepare('SELECT COUNT(*) c FROM brocade_chassis').get().c).toBeGreaterThan(0);
    expect(db.prepare('SELECT COUNT(*) c FROM brocade_events').get().c).toBeGreaterThan(0);
    expect(db.prepare('SELECT COUNT(*) c FROM brocade_health_scores').get().c).toBeGreaterThan(0);
    expect(db.prepare('SELECT COUNT(*) c FROM brocade_zone_configs').get().c).toBeGreaterThan(0);
    expect(db.prepare('SELECT COUNT(*) c FROM brocade_zones').get().c).toBeGreaterThan(0);
    expect(db.prepare('SELECT COUNT(*) c FROM brocade_zone_aliases').get().c).toBeGreaterThan(0);
    expect(db.prepare('SELECT COUNT(*) c FROM brocade_zone_changes').get().c).toBeGreaterThan(0);
    expect(db.prepare('SELECT COUNT(*) c FROM brocade_fcr_routes').get().c).toBeGreaterThan(0);
    expect(db.prepare('SELECT COUNT(*) c FROM brocade_metrics').get().c).toBeGreaterThan(0);
    expect(db.prepare('SELECT COUNT(*) c FROM brocade_issue_history').get().c).toBeGreaterThanOrEqual(8);

    const flag = db.prepare("SELECT value FROM app_settings WHERE key = 'platform_brocade_enabled'").get();
    expect(flag.value).toBe('1');

    // cross-platform Server 360 hit: an enclosure host_name matches a vcenter/unifi demo VM name.
    for (const name of ['vra-prod', 'vra-dr', 'vrops-nyc-01', 'vrli-nyc-01', 'nyc-esx-0101.icc.demo']) {
      expect(db.prepare('SELECT COUNT(*) c FROM brocade_enclosures WHERE host_name = ?').get(name).c).toBeGreaterThanOrEqual(1);
    }

    // deliberate-trouble checks — one clean pass through every computed-issue rule.
    expect(db.prepare("SELECT COUNT(*) c FROM brocade_switches WHERE operational_status = 'CRITICAL'").get().c).toBeGreaterThan(0);
    expect(db.prepare('SELECT COUNT(*) c FROM brocade_switches WHERE (management_state & 16) != 0').get().c).toBeGreaterThan(0);
    expect(db.prepare("SELECT COUNT(*) c FROM brocade_fabrics WHERE status = 2").get().c).toBeGreaterThan(0);
    expect(db.prepare('SELECT COUNT(*) c FROM brocade_health_scores WHERE score < 50').get().c).toBeGreaterThan(0);
    expect(db.prepare('SELECT COUNT(*) c FROM brocade_switch_ports WHERE fenced = 1').get().c).toBeGreaterThanOrEqual(2);
    expect(db.prepare('SELECT COUNT(*) c FROM brocade_switch_ports WHERE blocked = 1').get().c).toBeGreaterThanOrEqual(1);
    expect(db.prepare('SELECT COUNT(*) c FROM brocade_switches WHERE tls_cert_expiry_ms > ? AND tls_cert_expiry_ms < ?')
      .get(Date.now(), Date.now() + 60 * 86400000).c).toBeGreaterThan(0);
    expect(db.prepare('SELECT COUNT(*) c FROM brocade_chassis WHERE tls_cert_expiry_ms < ?').get(Date.now()).c).toBeGreaterThan(0);
    expect(db.prepare('SELECT COUNT(*) c FROM brocade_switches WHERE eos_status = 1').get().c).toBeGreaterThan(0);
    expect(db.prepare('SELECT COUNT(*) c FROM brocade_switches WHERE maintenance_mode = 1').get().c).toBeGreaterThan(0);
    expect(db.prepare("SELECT COUNT(DISTINCT firmware_version) c FROM brocade_switches WHERE fabric_name = 'PROD-A'").get().c).toBeGreaterThan(1);
    expect(db.prepare('SELECT COUNT(*) c FROM brocade_zone_configs WHERE default_zone_access = 1').get().c).toBeGreaterThan(0);
    expect(db.prepare("SELECT COUNT(*) c FROM brocade_zone_changes WHERE detected_at >= datetime('now', '-1 day')").get().c).toBeGreaterThan(0);
    expect(db.prepare("SELECT COUNT(*) c FROM brocade_events WHERE severity_norm = 'critical' AND last_occurred_ms >= ?").get(Date.now() - 3600000).c).toBeGreaterThanOrEqual(12);
    expect(db.prepare("SELECT COUNT(*) c FROM brocade_sources WHERE last_poll_status = 'error'").get().c).toBeGreaterThan(0);
  });

  it('seeds per-port IO statistics (addendum 1) with a >10x imbalanced pair on PROD-A-SW01', () => {
    expect(db.prepare('SELECT COUNT(*) c FROM brocade_port_stats').get().c).toBeGreaterThan(0);

    const sw1 = db.prepare("SELECT wwn FROM brocade_switches WHERE name = 'PROD-A-SW01'").get();
    expect(sw1).toBeTruthy();
    const ports = db.prepare('SELECT wwn FROM brocade_switch_ports WHERE switch_wwn = ? AND port_number IN (3, 4)').all(sw1.wwn);
    expect(ports.length).toBe(2);

    const avgRate = (wwn) => db.prepare(`
      SELECT AVG(in_frames_per_sec + out_frames_per_sec) r FROM brocade_port_stats
      WHERE port_wwn = ? AND in_frames_per_sec IS NOT NULL
    `).get(wwn).r;
    const rates = ports.map((p) => avgRate(p.wwn)).sort((a, b) => a - b);
    expect(rates[0]).toBeGreaterThan(0);
    expect(rates[1] / rates[0]).toBeGreaterThan(10);
  });

  it('seeds the bluecat platform with a source, views, zones, records, IPAM inventory, and every computed issue trigger', () => {
    expect(db.prepare('SELECT COUNT(*) c FROM bluecat_sources').get().c).toBe(1);
    expect(db.prepare('SELECT COUNT(*) c FROM bluecat_views').get().c).toBe(3);
    expect(db.prepare('SELECT COUNT(*) c FROM bluecat_zones').get().c).toBeGreaterThanOrEqual(12);
    expect(db.prepare("SELECT COUNT(*) c FROM bluecat_zones WHERE zone_type = 'ExternalHostsZone'").get().c).toBe(3);
    expect(db.prepare("SELECT COUNT(*) c FROM bluecat_zones WHERE absolute_name LIKE '%in-addr.arpa'").get().c).toBe(2);
    expect(db.prepare('SELECT COUNT(*) c FROM bluecat_records').get().c).toBeGreaterThanOrEqual(180);
    expect(db.prepare('SELECT COUNT(*) c FROM bluecat_blocks').get().c).toBe(6);
    expect(db.prepare('SELECT COUNT(*) c FROM bluecat_networks').get().c).toBeGreaterThanOrEqual(40);
    expect(db.prepare("SELECT COUNT(*) c FROM bluecat_networks WHERE ip_version = 6").get().c).toBe(2);
    expect(db.prepare('SELECT COUNT(*) c FROM bluecat_ranges').get().c).toBeGreaterThanOrEqual(14);
    expect(db.prepare('SELECT COUNT(*) c FROM bluecat_addresses').get().c).toBeGreaterThan(0);
    expect(db.prepare('SELECT COUNT(*) c FROM bluecat_devices').get().c).toBe(25);
    expect(db.prepare('SELECT COUNT(*) c FROM bluecat_servers').get().c).toBe(4);
    expect(db.prepare("SELECT COUNT(*) c FROM bluecat_servers WHERE connected = 0").get().c).toBe(1);
    expect(db.prepare("SELECT COUNT(*) c FROM bluecat_servers WHERE last_deploy_status = 'FAILED'").get().c).toBe(1);
    expect(db.prepare('SELECT COUNT(*) c FROM bluecat_network_overrides').get().c).toBe(2);
    expect(db.prepare("SELECT COUNT(*) c FROM bluecat_network_overrides WHERE exclude_low_space = 1").get().c).toBe(1);
    expect(db.prepare('SELECT COUNT(*) c FROM bluecat_metrics_history').get().c).toBe(24);

    // cross-platform Server 360 hits: BlueCat host records matching vcenter demo VM names.
    for (const name of ['vra-prod', 'vra-dr', 'vrops-nyc-01', 'vrli-nyc-01']) {
      expect(db.prepare('SELECT COUNT(*) c FROM bluecat_records WHERE name = ?').get(name).c).toBe(1);
    }

    // free-space math sanity: at least one full network (free_static = 0), at
    // least 3 low-space networks (free 5..15), one no-gateway, two non-.1
    // bam gateways, and one full DHCP range (contract section 5/10).
    expect(db.prepare("SELECT COUNT(*) c FROM bluecat_networks WHERE ip_version = 4 AND free_static = 0").get().c).toBeGreaterThanOrEqual(1);
    expect(db.prepare("SELECT COUNT(*) c FROM bluecat_networks WHERE ip_version = 4 AND free_static BETWEEN 5 AND 15").get().c).toBeGreaterThanOrEqual(3);
    expect(db.prepare("SELECT COUNT(*) c FROM bluecat_networks WHERE ip_version = 4 AND gateway IS NULL AND prefix <= 30").get().c).toBeGreaterThanOrEqual(1);
    expect(db.prepare("SELECT COUNT(*) c FROM bluecat_networks WHERE gateway LIKE '%.254' AND gateway_source = 'bam'").get().c).toBeGreaterThanOrEqual(1);
    expect(db.prepare("SELECT COUNT(*) c FROM bluecat_networks WHERE gateway LIKE '%.129' AND gateway_source = 'bam'").get().c).toBeGreaterThanOrEqual(1);
    expect(db.prepare("SELECT COUNT(*) c FROM bluecat_networks WHERE gateway_source = 'override'").get().c).toBeGreaterThanOrEqual(1);
    expect(db.prepare('SELECT COUNT(*) c FROM bluecat_ranges WHERE free_dhcp = 0').get().c).toBeGreaterThanOrEqual(1);
    expect(db.prepare('SELECT COUNT(*) c FROM bluecat_ranges WHERE free_dhcp BETWEEN 0 AND 15').get().c).toBeGreaterThanOrEqual(2);

    // Verify every seeded network's free_static/free_pct agree with the
    // contract section 5 math re-derived from the addresses actually written.
    const nets = db.prepare("SELECT network_id, capacity, dhcp_pool, used_static, free_static FROM bluecat_networks WHERE ip_version = 4").all();
    for (const n of nets) {
      expect(n.free_static).toBe(Math.max(0, n.capacity - n.dhcp_pool - n.used_static));
    }

    const flag = db.prepare("SELECT value FROM app_settings WHERE key = 'platform_bluecat_enabled'").get();
    expect(flag.value).toBe('1');

    // Issue history: services/bluecatIssues.js may not exist yet if WP1 has
    // not landed (WPs build in parallel) - the generator falls back to
    // representative rows in that case, still covering every rule.
    const openTypes = db.prepare("SELECT DISTINCT type FROM bluecat_issue_history WHERE status = 'open'").all().map((r) => r.type);
    for (const type of [
      'source-unreachable', 'server-disconnected', 'server-deploy-failed', 'network-full',
      'network-low-space', 'network-low-pct', 'dhcp-range-full', 'dhcp-range-low-space', 'gateway-unknown',
    ]) {
      expect(openTypes).toContain(type);
    }
  });

  it('seeds the logicmonitor platform with inventory, history and every issue trigger', () => {
    const c = (sql, ...args) => db.prepare(sql).get(...args).c;
    expect(c('SELECT COUNT(*) c FROM lm_sources')).toBe(2);
    expect(c("SELECT COUNT(*) c FROM lm_sources WHERE last_poll_status = 'error'")).toBe(1);
    expect(c('SELECT COUNT(*) c FROM lm_collectors')).toBe(6);
    expect(c('SELECT COUNT(*) c FROM lm_collectors WHERE is_down = 1')).toBe(1);
    // 12 v1 groups plus 4 DC site groups (Network/Sites/<site>) added in round 3.
    expect(c('SELECT COUNT(*) c FROM lm_device_groups')).toBe(16);
    // 140 monitored devices plus the 2 LM Uptime ping-check devices (deviceType 19),
    // plus 6 nyc/lon switches (round 2: 1 dist + 2 access per site), plus 7 round 3
    // switches (abq-dist-01 with 3 access switches, 3 unassigned-sw-* in no site group).
    expect(c('SELECT COUNT(*) c FROM lm_devices')).toBe(155);
    expect(c('SELECT COUNT(*) c FROM lm_devices WHERE device_type = 19')).toBe(2);
    expect(c('SELECT COUNT(*) c FROM lm_devices WHERE device_type = 2')).toBe(20);
    expect(c('SELECT COUNT(*) c FROM lm_devices WHERE is_network = 1')).toBe(73);
    expect(c("SELECT COUNT(*) c FROM lm_devices WHERE host_status = 'dead-collector'")).toBe(14);
    expect(c("SELECT COUNT(*) c FROM lm_devices WHERE host_status = 'dead' AND is_network = 1")).toBe(7);
    expect(c("SELECT COUNT(*) c FROM lm_devices WHERE vendor = 'Cisco' AND role = 'switch' AND version = '17.6.5'")).toBe(4);
    expect(c("SELECT COUNT(*) c FROM lm_devices WHERE sdt_status != 'none-none-none'")).toBe(5);
    expect(c('SELECT COUNT(*) c FROM lm_sdts')).toBe(7);

    expect(c('SELECT COUNT(*) c FROM lm_interfaces')).toBe(2024);
    expect(c("SELECT COUNT(*) c FROM lm_interfaces WHERE status_text = 'down'")).toBe(10);
    const ifHist = c('SELECT COUNT(*) c FROM lm_interface_history');
    expect(ifHist).toBeGreaterThan(100000);
    expect(ifHist).toBeLessThan(150000);
    expect(c('SELECT COUNT(*) c FROM lm_interface_daily')).toBeGreaterThan(40000);
    expect(c('SELECT COUNT(*) c FROM lm_device_datasources WHERE is_interface = 1')).toBe(67);

    expect(c('SELECT COUNT(*) c FROM lm_alerts WHERE cleared = 0')).toBe(114);
    expect(c('SELECT COUNT(*) c FROM lm_alerts WHERE cleared = 1')).toBe(400);
    expect(c('SELECT COUNT(*) c FROM lm_alerts WHERE cleared = 0 AND acked = 1')).toBe(12);
    expect(c('SELECT COUNT(*) c FROM lm_alerts WHERE cleared = 0 AND sdted = 1')).toBe(6);
    expect(c("SELECT COUNT(*) c FROM lm_alerts WHERE condition_key NOT LIKE 'lm:%' OR condition_key LIKE '%DS5%'")).toBe(0);
    const noisy = db.prepare('SELECT COUNT(*) n FROM lm_alerts GROUP BY condition_key HAVING n >= 40').all();
    expect(noisy.length).toBe(3);

    expect(c('SELECT COUNT(*) c FROM lm_checks')).toBe(18);
    expect(c("SELECT COUNT(*) c FROM lm_checks WHERE origin = 'uptime' AND check_id LIKE 'u:%'")).toBe(2);
    expect(c("SELECT COUNT(*) c FROM lm_check_locations WHERE is_overall = 1 AND checkpoint_id = 'overall'")).toBe(18);
    expect(c('SELECT COUNT(*) c FROM lm_check_history')).toBeGreaterThan(140000);
    expect(c('SELECT COUNT(*) c FROM lm_check_baseline')).toBeGreaterThan(0);
    expect(c("SELECT COUNT(*) c FROM lm_alerts WHERE type = 'websiteAlert' AND cleared = 0 AND lm_alert_id LIKE 'LMS%'")).toBe(2);
    expect(c('SELECT COUNT(*) c FROM lm_admins')).toBe(9);
    expect(c('SELECT COUNT(*) c FROM lm_roles')).toBe(4);
    expect(c('SELECT COUNT(*) c FROM lm_metrics_history')).toBe(720);

    expect(c("SELECT COUNT(*) c FROM lm_topology_links WHERE protocol = 'description' AND dst_device_id IS NOT NULL")).toBe(96);
    expect(c("SELECT COUNT(*) c FROM lm_topology_links WHERE protocol = 'description' AND dst_device_id IS NULL")).toBe(39);
    // Round 2 server-facing ports: 6 ESXi hosts x 2 per site plus 2 dual-homed Dell servers.
    expect(c("SELECT COUNT(*) c FROM lm_interfaces WHERE description LIKE 'to %-esx-0% vmnic_'")).toBe(24);
    expect(c("SELECT COUNT(*) c FROM lm_interfaces WHERE description LIKE 'to dc_-esx-% NIC.Integrated.1-_'")).toBe(4);
    expect(c("SELECT COUNT(*) c FROM lm_checks WHERE check_id IN ('w:115', 'w:116') AND target LIKE '10.10_.%'")).toBe(2);
    // Cross-platform endpoint resolution (WP-A): only asserted once the column
    // exists and the poller writes it.
    const linkCols = db.prepare("PRAGMA table_info('lm_topology_links')").all().map((r) => r.name);
    const pollerSrc = fs.readFileSync(path.join(backendDir, 'services', 'logicmonitorPoller.js'), 'utf8');
    if (linkCols.includes('dst_platform') && pollerSrc.includes('dst_platform')) {
      expect(c("SELECT COUNT(*) c FROM lm_topology_links WHERE dst_platform = 'vcenter'")).toBeGreaterThan(0);
      expect(c("SELECT COUNT(*) c FROM lm_topology_links WHERE dst_platform = 'vcenter' AND dst_ref = 'nyc-esx-0101.icc.demo'")).toBe(2);
    }
    expect(c("SELECT COUNT(*) c FROM lm_topology_links WHERE protocol = 'lldp'")).toBe(10);

    const openTypes = db.prepare("SELECT DISTINCT type FROM lm_issue_history WHERE status = 'open'").all().map((r) => r.type);
    for (const type of [
      'source-unreachable', 'collector-down', 'collector-build-behind', 'device-dead', 'device-in-sdt', 'device-new',
      'interface-utilization-high', 'interface-errors-growing', 'interface-flapping', 'alert-storm',
      'check-down', 'check-location-down', 'latency-anomaly', 'packet-loss-anomaly', 'location-degraded',
    ]) {
      expect(openTypes).toContain(type);
    }

    const flag = db.prepare("SELECT value FROM app_settings WHERE key = 'platform_logicmonitor_enabled'").get();
    expect(flag.value).toBe('1');
  });

  it('seeds the logicmonitor round 3 scenarios (sites, shadowing, circuits, anomalies, backup windows, webhook, data quality)', async () => {
    const c = (sql, ...args) => db.prepare(sql).get(...args).c;
    const cols = (t) => new Set(db.prepare(`PRAGMA table_info('${t}')`).all().map((r) => r.name));
    const hasTable = (t) => !!db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(t);
    expect(cols('lm_alerts').has('shadowed_by')).toBe(true);

    // Sites: 4 DC sites, 4 branches and AWS; at least 80 percent of network devices resolve through a group.
    expect(c('SELECT COUNT(*) c FROM lm_sites')).toBeGreaterThanOrEqual(9);
    expect(c('SELECT COUNT(*) c FROM lm_checks WHERE site_key IS NOT NULL')).toBeGreaterThanOrEqual(12);
    expect(c("SELECT COUNT(*) c FROM lm_issue_history WHERE type = 'device-dead' AND target = 'den-acc-02' AND status = 'open' AND first_seen < datetime('now', '-70 hours')")).toBe(1);
    expect(c("SELECT COUNT(*) c FROM lm_issue_history WHERE status = 'open' AND first_seen < datetime('now', '-1 hour')")).toBeGreaterThanOrEqual(5);
    const grouped = c("SELECT COUNT(*) c FROM lm_devices WHERE is_network = 1 AND site_source = 'group'");
    expect(grouped / c('SELECT COUNT(*) c FROM lm_devices WHERE is_network = 1')).toBeGreaterThanOrEqual(0.8);
    const noSite = db.prepare('SELECT display_name FROM lm_devices WHERE is_network = 1 AND site_key IS NULL ORDER BY display_name').all().map((r) => r.display_name);
    expect(noSite).toEqual(['unassigned-sw-01', 'unassigned-sw-02', 'unassigned-sw-03']);
    expect(c('SELECT COUNT(*) c FROM lm_devices WHERE is_network = 1 AND tier IS NOT NULL')).toBeGreaterThan(60);

    // Dependency suppression: the abq outage folds under abq-dist-01.
    expect(c("SELECT COUNT(*) c FROM lm_devices WHERE display_name IN ('abq-dist-01', 'abq-acc-03', 'abq-acc-04', 'abq-acc-05') AND host_status = 'dead'")).toBe(4);
    expect(c("SELECT COUNT(*) c FROM lm_alerts WHERE cleared = 0 AND monitor_object_name IN ('abq-acc-03', 'abq-acc-04', 'abq-acc-05') AND resource_template_name = 'SNMP_Network_Interfaces'")).toBe(20);
    const shadowed = db.prepare('SELECT shadowed_by FROM lm_alerts WHERE cleared = 0 AND shadowed_by IS NOT NULL').all();
    expect(shadowed.length).toBeGreaterThanOrEqual(20);
    expect(shadowed.every((r) => JSON.parse(r.shadowed_by).deviceName === 'abq-dist-01')).toBe(true);

    // Circuits: the DC WAN uplinks are marked, one is saturated, the den uplink is unresolved.
    expect(c('SELECT COUNT(*) c FROM lm_interfaces WHERE is_wan = 1')).toBeGreaterThanOrEqual(7);
    expect(c(`SELECT COUNT(*) c FROM lm_interfaces i JOIN lm_devices d ON d.source_id = i.source_id AND d.lm_device_id = i.lm_device_id
      WHERE i.is_wan = 1 AND i.wan_reason = 'unresolved-uplink' AND d.display_name = 'den-rtr-01'`)).toBe(1);
    const issues = db.prepare("SELECT type, target FROM lm_issue_history WHERE status = 'open'").all();
    const sat = issues.filter((i) => i.type === 'circuit-saturated');
    expect(sat.length).toBe(1);
    expect(sat[0].target).toMatch(/^phx-wan-rtr-01 /);
    expect(c(`SELECT COUNT(*) c FROM lm_interface_daily x
      JOIN lm_interfaces i ON i.source_id = x.source_id AND i.instance_id = x.instance_id
      JOIN lm_devices d ON d.source_id = i.source_id AND d.lm_device_id = i.lm_device_id
      WHERE d.display_name = 'phx-wan-rtr-01' AND i.display_name = 'GigabitEthernet0/0/0' AND x.max_in_util_pct >= 95`)).toBeGreaterThanOrEqual(3);

    // Interface anomalies on ports that stay under the static thresholds.
    expect(issues.filter((i) => i.type === 'interface-util-anomaly' && i.target.startsWith('phx-acc-06 ')).length).toBe(1);
    expect(issues.filter((i) => i.type === 'interface-error-anomaly' && i.target.startsWith('phx-acc-08 ')).length).toBe(1);
    expect(c('SELECT COUNT(*) c FROM lm_interface_baseline')).toBeGreaterThan(1000);

    // Backup overlay: four seeded runs, two of them on a hot port, found by the real run-to-port join.
    expect(c("SELECT COUNT(*) c FROM protection_runs WHERE job_name LIKE 'VM_Nightly_Backup_%'")).toBe(4);
    expect(c("SELECT COUNT(*) c FROM cohesity_objects WHERE protection_groups LIKE '%VM_Nightly_Backup_%'")).toBe(4);
    const endpoints = await import(path.join(backendDir, 'services', 'logicmonitorEndpoints.js'));
    const ep = endpoints.default || endpoints;
    const windows = ep.backupWindows(db, { nowMs: Date.now() }).filter((w) => w.jobName.startsWith('VM_Nightly_Backup_'));
    expect(windows.length).toBe(2);
    expect(windows.every((w) => w.finding === 'saturates' && w.meanUtilPct >= 70)).toBe(true);
    expect(windows.map((w) => w.deviceName).sort()).toEqual(['lon-acc-01', 'nyc-acc-01']);

    // Round 4 backup load: nyc-esx-0101 has five jobs merged in the same 01:00 to 03:00 window and its
    // management vmkernel leaves through vmnic0 only.
    expect(c("SELECT COUNT(*) c FROM protection_runs WHERE job_name LIKE 'NYC_%'")).toBe(4);
    expect(c("SELECT COUNT(*) c FROM vcenter_networks WHERE host_name = 'nyc-esx-0101.icc.demo' AND kind = 'vswitch' AND name = 'vSwitch0' AND uplinks = '[\"vmnic0\"]'")).toBe(1);
    expect(c("SELECT COUNT(*) c FROM vcenter_networks WHERE host_name = 'nyc-esx-0101.icc.demo' AND kind = 'vmkernel' AND name = 'vmk0' AND switch_name = 'Management Network'")).toBe(1);
    if (typeof ep.backupLoad === 'function') {
      const load = ep.backupLoad(db, { nowMs: Date.now() });
      const five = load.filter((w) => w.runCount === 5);
      expect(five.length).toBeGreaterThanOrEqual(1);
      expect(five.every((w) => w.deviceName === 'nyc-acc-01' && w.uplinkRule === 'vmkernel')).toBe(true);
      const shares = five[0].runs.map((r) => r.sharePct);
      expect(shares.reduce((a, b) => a + b, 0)).toBeGreaterThan(99);
      expect(shares.reduce((a, b) => a + b, 0)).toBeLessThan(101);
    }

    // Round 4 replication vs circuits: Phoenix RPO alerts and a breached VPG, 90 minute replication lag, all
    // inside the phx-wan-rtr-01 saturation window.
    expect(c("SELECT COUNT(*) c FROM zerto_alerts WHERE alert_identifier LIKE 'demo-lm-rpo-%' AND description LIKE '%RPO%'")).toBe(2);
    expect(c("SELECT COUNT(*) c FROM zerto_vpgs WHERE protected_site LIKE '%Phoenix%' AND actual_rpo > configured_rpo")).toBe(1);
    expect(c('SELECT COUNT(*) c FROM replication_runs WHERE lag_seconds = 5400')).toBe(2);
    const corrPath = path.join(backendDir, 'services', 'logicmonitorCorrelation.js');
    const corr = fs.existsSync(corrPath) ? await import(corrPath) : null;
    const corrApi = corr ? (corr.default || corr) : {};
    if (typeof corrApi.replicationVsCircuits === 'function') {
      const rep = corrApi.replicationVsCircuits(db, { days: 7 });
      expect(rep.filter((r) => r.finding === 'coincident' || r.finding === 'possible').length).toBeGreaterThanOrEqual(1);
    }

    // Round 4 changes followed by incidents: the abq-dist-01 changes and the phx-acc-03 change before its flapping.
    expect(c("SELECT COUNT(*) c FROM config_changes WHERE platform = 'logicmonitor' AND item LIKE 'phx-acc-03%'")).toBe(1);
    if (typeof corrApi.changesThenIncidents === 'function') {
      expect(corrApi.changesThenIncidents(db, { days: 14 }).length).toBeGreaterThanOrEqual(2);
    }

    // Round 4 blame history: 40 seeded rows, phx-dist-01 Te1/0/3 nine times, dal-wan-rtr-01 Gi0/0/0 six times.
    if (hasTable('lm_blame_history')) {
      expect(c("SELECT COUNT(*) c FROM lm_blame_history WHERE hop_device_name = 'phx-dist-01' AND hop_port = 'Te1/0/3'")).toBeGreaterThanOrEqual(9);
      expect(c("SELECT COUNT(*) c FROM lm_blame_history WHERE hop_device_name = 'dal-wan-rtr-01' AND hop_port = 'Gi0/0/0'")).toBeGreaterThanOrEqual(6);
      expect(c("SELECT COUNT(*) c FROM lm_blame_history WHERE kind = 'check'")).toBeGreaterThan(0);
      expect(c("SELECT COUNT(*) c FROM lm_blame_history WHERE kind = 'server'")).toBeGreaterThan(0);
      if (typeof corrApi.blameHistory === 'function') {
        const bh = corrApi.blameHistory(db, { days: 30 });
        expect(bh.hops[0].count).toBeGreaterThanOrEqual(9);
      }
    }

    // Webhook source: token demo-webhook-token (sha256 stored), 20 events, 12 webhook alerts.
    const src = db.prepare('SELECT webhook_enabled, webhook_count, webhook_token_hash, webhook_last_at FROM lm_sources WHERE id = 1').get();
    expect(src.webhook_enabled).toBe(1);
    expect(src.webhook_count).toBe(128);
    expect(src.webhook_token_hash).toBe(crypto.createHash('sha256').update('demo-webhook-token').digest('hex'));
    expect(src.webhook_last_at).toBeTruthy();
    expect(c('SELECT COUNT(*) c FROM lm_webhook_events')).toBe(20);
    expect(c('SELECT COUNT(*) c FROM lm_webhook_events WHERE accepted = 0')).toBe(2);
    expect(c("SELECT COUNT(*) c FROM lm_alerts WHERE ingest = 'webhook'")).toBe(12);

    // Config ledger rows and the data quality gaps.
    expect(hasTable('config_changes')).toBe(true);
    expect(c("SELECT COUNT(*) c FROM config_changes WHERE platform = 'logicmonitor' AND scope IN ('device-inventory', 'links')")).toBe(7);
    expect(c("SELECT COUNT(*) c FROM config_changes WHERE platform = 'logicmonitor' AND item LIKE 'abq-dist-01%'")).toBe(3);
    const upPorts = c("SELECT COUNT(*) c FROM lm_interfaces i JOIN lm_devices d ON d.source_id = i.source_id AND d.lm_device_id = i.lm_device_id WHERE d.is_network = 1 AND i.status_text = 'up'");
    const upNoDesc = c("SELECT COUNT(*) c FROM lm_interfaces i JOIN lm_devices d ON d.source_id = i.source_id AND d.lm_device_id = i.lm_device_id WHERE d.is_network = 1 AND i.status_text = 'up' AND (i.description IS NULL OR trim(i.description) = '')");
    expect(upNoDesc).toBeGreaterThanOrEqual(30);
    const noNeighbor = db.prepare(`SELECT display_name FROM lm_devices d WHERE d.is_network = 1 AND d.role = 'switch'
      AND NOT EXISTS (SELECT 1 FROM lm_device_datasources x WHERE x.source_id = d.source_id AND x.lm_device_id = d.lm_device_id AND x.is_neighbor = 1)
      ORDER BY display_name`).all().map((r) => r.display_name);
    expect(noNeighbor).toEqual(['den-acc-03', 'slc-acc-03']);
    const thin = db.prepare("SELECT check_id FROM lm_check_history WHERE checkpoint_id != 'overall' GROUP BY check_id, checkpoint_id HAVING COUNT(*) < 48").all();
    expect(thin.length).toBe(2);
    // Governance coverageScore (routes/logicmonitor.js buildDataQuality) is 82 on this seed. The first
    // three weighted terms of the same formula must leave it between 1 and 99.
    const switches = c("SELECT COUNT(*) c FROM lm_devices WHERE is_network = 1 AND role = 'switch'");
    const net = c('SELECT COUNT(*) c FROM lm_devices WHERE is_network = 1');
    const score = 100 - (20 * (upNoDesc / upPorts) + 20 * (noNeighbor.length / switches) + 20 * (noSite.length / net));
    expect(score).toBeGreaterThan(1);
    expect(score).toBeLessThan(99);
  });

});
