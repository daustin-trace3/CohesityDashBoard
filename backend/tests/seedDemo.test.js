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
      "SELECT key, value FROM app_settings WHERE key IN ('platform_pure_enabled', 'platform_netapp_enabled', 'platform_zerto_enabled', 'platform_vcenter_enabled', 'platform_dell_enabled', 'platform_aria_enabled', 'platform_unifi_enabled')"
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

  it('seeds the unifi platform with sources, devices, ports, and every computed issue trigger', () => {
    expect(db.prepare('SELECT COUNT(*) c FROM unifi_sources').get().c).toBe(2);
    expect(db.prepare('SELECT COUNT(*) c FROM unifi_devices').get().c).toBe(13);
    expect(db.prepare('SELECT COUNT(*) c FROM unifi_ports').get().c).toBeGreaterThan(0);
    expect(db.prepare('SELECT COUNT(*) c FROM unifi_clients').get().c).toBeGreaterThan(0);
    expect(db.prepare('SELECT COUNT(*) c FROM unifi_wlans').get().c).toBeGreaterThan(0);
    expect(db.prepare('SELECT COUNT(*) c FROM unifi_networks').get().c).toBe(6);
    expect(db.prepare('SELECT COUNT(*) c FROM unifi_rogue_aps').get().c).toBeGreaterThan(0);
    expect(db.prepare('SELECT COUNT(*) c FROM unifi_events').get().c).toBeGreaterThan(0);
    expect(db.prepare("SELECT COUNT(*) c FROM unifi_events WHERE category = 'SECURITY'").get().c).toBeGreaterThanOrEqual(12);

    // cross-platform Server 360 hits: wired clients matching vcenter demo VM names.
    for (const name of ['vra-prod', 'vra-dr', 'vrops-nyc-01', 'vrli-nyc-01']) {
      expect(db.prepare('SELECT COUNT(*) c FROM unifi_clients WHERE name = ?').get(name).c).toBe(1);
    }

    // port history exists for the error-ramp port and shows a trailing-24h delta.
    const errHist = db.prepare(`
      SELECT COUNT(*) c FROM unifi_port_history WHERE captured_at >= datetime('now', '-170 hours')
    `).get().c;
    expect(errHist).toBeGreaterThan(0);
    const errPort = db.prepare(`
      SELECT device_mac, port_idx FROM unifi_port_history GROUP BY device_mac, port_idx ORDER BY COUNT(*) DESC LIMIT 1
    `).get();
    const errDelta = db.prepare(`
      SELECT (SELECT rx_errors + tx_errors FROM unifi_port_history WHERE device_mac = ? AND port_idx = ? ORDER BY captured_at DESC LIMIT 1) -
             (SELECT rx_errors + tx_errors FROM unifi_port_history WHERE device_mac = ? AND port_idx = ? AND captured_at <= datetime('now', '-24 hours') ORDER BY captured_at DESC LIMIT 1) AS d
    `).get(errPort.device_mac, errPort.port_idx, errPort.device_mac, errPort.port_idx).d;
    expect(errDelta).toBeGreaterThanOrEqual(500);

    expect(db.prepare('SELECT COUNT(*) c FROM unifi_metrics_history').get().c).toBe(96 * 2);

    const openTypes = db.prepare("SELECT DISTINCT type FROM unifi_issue_history WHERE status = 'open'").all().map((r) => r.type);
    for (const type of ['poe-fault', 'port-errors', 'port-flapping', 'device-offline', 'device-load', 'device-overheating', 'wan-latency', 'wan-availability', 'rogue-ap', 'ips-disabled', 'firmware-upgrade']) {
      expect(openTypes).toContain(type);
    }
    expect(db.prepare("SELECT COUNT(*) c FROM unifi_issue_history WHERE status = 'resolved'").get().c).toBeGreaterThanOrEqual(2);

    const flag = db.prepare("SELECT value FROM app_settings WHERE key = 'platform_unifi_enabled'").get();
    expect(flag.value).toBe('1');
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

});
