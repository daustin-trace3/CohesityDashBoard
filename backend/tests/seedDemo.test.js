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
      "SELECT key, value FROM app_settings WHERE key IN ('platform_pure_enabled', 'platform_netapp_enabled', 'platform_zerto_enabled', 'platform_vcenter_enabled', 'platform_dell_enabled')"
    ).all();
    expect(rows).toHaveLength(5);
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

  it('seeds the dell platform with devices, failing parts, warranty runway and firmware drift', () => {
    expect(db.prepare('SELECT COUNT(*) c FROM dell_ome_instances').get().c).toBe(2);
    expect(db.prepare('SELECT COUNT(*) c FROM dell_devices').get().c).toBeGreaterThan(100);
    expect(db.prepare("SELECT COUNT(*) c FROM dell_components WHERE kind = 'disk'").get().c).toBeGreaterThan(300);
    // Governance feeds: at least one failing component, expiring + expired warranties, firmware drift.
    expect(db.prepare("SELECT COUNT(*) c FROM dell_components WHERE status IN ('critical','warning')").get().c).toBeGreaterThan(0);
    expect(db.prepare('SELECT COUNT(*) c FROM dell_warranties WHERE days_remaining <= 0').get().c).toBeGreaterThan(0);
    expect(db.prepare('SELECT COUNT(*) c FROM dell_warranties WHERE days_remaining > 0 AND days_remaining <= 90').get().c).toBeGreaterThan(0);
    expect(db.prepare("SELECT COUNT(*) c FROM dell_firmware_compliance WHERE status = 'noncompliant'").get().c).toBeGreaterThan(0);
    expect(db.prepare('SELECT COUNT(*) c FROM dell_alerts').get().c).toBeGreaterThan(50);
    // Power Manager metrics on DC1 only — DC2 shows the plugin-absent experience.
    const pm = db.prepare(`SELECT o.name, COUNT(d.power_w) n FROM dell_devices d JOIN dell_ome_instances o ON o.id = d.ome_id GROUP BY o.name`).all();
    expect(pm.find((r) => r.name === 'DC1 OME').n).toBeGreaterThan(0);
    expect(pm.find((r) => r.name === 'DC2 OME').n).toBe(0);
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
});
