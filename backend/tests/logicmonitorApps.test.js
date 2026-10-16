/**
 * LogicMonitor round 11, WP-X: application and appliance families (blind).
 * Catalog matches on plausible LM names, the three app-* issue types, the
 * Applications routes (list, csv, 360). Every DataSource and datapoint name is
 * UNVERIFIED against a live portal; rows are seeded by hand.
 */
import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import { createRequire } from 'module';
import request from 'supertest';

const require = createRequire(import.meta.url);
const express = require('express');
const db = require('../db/database');
const { runMigrations } = require('../core/migrations');
const lmMigrations = require('../db/migrations/logicmonitor');
const { encrypt } = require('../services/encryption');
const lmIssues = require('../services/logicmonitorIssues');
const catalog = require('../services/logicmonitorCatalog');
const apps = require('../services/logicmonitorApps');

const API = '/api/logicmonitor';
const TABLES = ['lm_alerts', 'lm_issue_history', 'lm_ds_metrics_history', 'lm_ds_metrics', 'lm_ds_instances', 'lm_device_datasources', 'lm_devices', 'lm_sources'];

let app;
let sid;
let hdsSeq;

beforeAll(() => {
  runMigrations(db, 'logicmonitor', lmMigrations);
  const router = require('../routes/logicmonitor');
  const errorHandler = require('../middleware/errorHandler');
  app = express();
  app.use(express.json());
  app.use(API, router);
  app.use(errorHandler);
});

beforeEach(() => {
  for (const t of TABLES) db.prepare(`DELETE FROM ${t}`).run();
  db.prepare("DELETE FROM app_settings WHERE key LIKE 'lm_%'").run();
  sid = db.prepare('INSERT INTO lm_sources (name, company, auth_mode, encrypted_credentials) VALUES (?, ?, ?, ?)')
    .run('Acme', 'acme', 'lmv1', encrypt(JSON.stringify({ accessId: 'a', accessKey: 'b' }))).lastInsertRowid;
  hdsSeq = 2000;
});

function dev(id, name, over = {}) {
  db.prepare(`INSERT INTO lm_devices (source_id, lm_device_id, name, display_name, hostname, device_type, host_status, sdt_status, vendor, role, is_network, site_key, ips_json, stale)
    VALUES (?, ?, ?, ?, ?, 0, 'normal', ?, ?, ?, 0, 'phoenix', '[]', 0)`)
    .run(sid, id, name, name, name, over.sdt || 'none-none-none', over.vendor || 'Microsoft', over.role || 'server');
}

function m(devId, ds, instance, metric, value) {
  const hds = (db.prepare('SELECT hds_id FROM lm_ds_instances WHERE source_id = ? AND lm_device_id = ? AND datasource_name = ? LIMIT 1').get(sid, devId, ds) || {}).hds_id || (hdsSeq += 1);
  db.prepare(`INSERT OR IGNORE INTO lm_ds_instances (source_id, lm_device_id, hds_id, datasource_name, family, instance_key, instance_name, stale)
    VALUES (?, ?, ?, ?, 'apps', ?, ?, 0)`).run(sid, devId, hds, ds, instance, instance);
  db.prepare(`INSERT OR REPLACE INTO lm_ds_metrics (source_id, lm_device_id, hds_id, datasource_name, family, instance_key, metric, datapoint, value, sampled_at_epoch)
    VALUES (?, ?, ?, ?, 'apps', ?, ?, ?, ?, ?)`).run(sid, devId, hds, ds, instance, metric, metric, value, Math.floor(Date.now() / 1000) - 60);
  return hds;
}

const issuesOf = (type) => lmIssues.computeIssues().filter((i) => i.type === type);

describe('catalog family apps', () => {
  it('registers the family and matches the standard DataSource names, never Cisco Unity', () => {
    expect(catalog.FAMILIES).toContain('apps');
    expect(catalog.FAMILY_LABELS.apps).toBe('Applications and appliances (via LogicMonitor)');
    for (const name of ['Microsoft_SQLServer_Databases', 'Microsoft_SQLServer_Performance', 'MSSQL_Jobs', 'Splunk_Indexer_Stats', 'Splunk_License',
      'Microsoft_HyperV_VMs', 'HyperV_Host', 'XenServer_Host', 'Citrix_Xen_VMs', 'Cisco_IronPort_System', 'Cisco_ESA_Queues',
      'EMC_Unity_Pool', 'EMC_VNX_Disks', 'Isilon_Cluster', 'PowerStore_Appliance', 'DataDomain_Capacity']) {
      expect(catalog.catalogFor(name)?.family, name).toBe('apps');
    }
    expect(catalog.catalogFor('Cisco_Unity_Connection_Ports')?.family).not.toBe('apps');
    expect(catalog.catalogFor('Cisco_CPU_SNMP')?.family).toBe('health');
  });

  it('claims plausible datapoint names for each family (UNVERIFIED names)', () => {
    const pick = (ds, metric, dp) => catalog.catalogFor(ds).metrics[metric].match.some((r) => r.test(dp));
    expect(pick('Microsoft_SQLServer_Performance', 'sql_connections', 'UserConnections')).toBe(true);
    expect(pick('Microsoft_SQLServer_Performance', 'sql_batch_rate', 'BatchRequestsPerSec')).toBe(true);
    expect(pick('Microsoft_SQLServer_Performance', 'sql_buffer_hit_pct', 'BufferCacheHitRatio')).toBe(true);
    expect(pick('Splunk_License', 'splunk_license_used_pct', 'LicenseQuotaUsedPct')).toBe(true);
    expect(pick('Splunk_Queues', 'splunk_queue_fill_pct', 'IndexQueueFillPct')).toBe(true);
    expect(pick('XenServer_Host', 'xen_host_state', 'HostEnabled')).toBe(true);
    expect(pick('Cisco_ESA_Queues', 'esa_queue', 'WorkQueueMessages')).toBe(true);
    expect(pick('EMC_Unity_Pool', 'emc_cap_used_pct', 'PercentUsed')).toBe(true);
    expect(pick('EMC_Unity_Pool', 'emc_health', 'HealthStatus')).toBe(true);
  });

  it('keeps history on SQL only and caps instance counts', () => {
    expect(catalog.catalogFor('Microsoft_SQLServer_Databases').history).toBe(true);
    expect(catalog.catalogFor('Splunk_License').history).toBe(false);
    expect(catalog.catalogFor('Microsoft_SQLServer_Databases').maxInstances).toBe(500);
  });
});

describe('metric key kinds', () => {
  it('maps a metric key to its application kind', () => {
    expect(apps.kindOfMetric('sql_state')).toBe('sql');
    expect(apps.kindOfMetric('hv_vm_state')).toBe('hyperv');
    expect(apps.kindOfMetric('esa_queue')).toBe('ironport');
    expect(apps.kindOfMetric('emc_health')).toBe('emc');
    expect(apps.kindOfMetric('cpu_pct')).toBeNull();
  });
});

describe('app issues', () => {
  it('raises app-service-down critical for a down SQL service and prints the raw value', () => {
    dev(1, 'phx-sql-02');
    m(1, 'Microsoft_SQLServer_Service', 'MSSQLSERVER', 'sql_state', 0);
    dev(2, 'phx-sql-01');
    m(2, 'Microsoft_SQLServer_Service', 'MSSQLSERVER', 'sql_state', 1);
    const rows = issuesOf('app-service-down');
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ severity: 'critical', target: 'phx-sql-02 MSSQLSERVER', source: 'Acme' });
    expect(rows[0].message).toContain('reads 0');
  });

  it('covers Xen host and EMC health, and folds Hyper-V VMs above five', () => {
    dev(3, 'xen-01');
    m(3, 'XenServer_Host', 'host', 'xen_host_state', 0);
    dev(4, 'unity-01');
    m(4, 'EMC_Unity_Pool', 'pool1', 'emc_health', 0);
    dev(5, 'hv-01');
    for (let i = 1; i <= 7; i += 1) m(5, 'HyperV_VMs', `vm${i}`, 'hv_vm_state', 0);
    dev(6, 'hv-02');
    for (let i = 1; i <= 3; i += 1) m(6, 'HyperV_VMs', `vm${i}`, 'hv_vm_state', 0);
    const rows = issuesOf('app-service-down');
    expect(rows.filter((r) => r.target.startsWith('xen-01'))).toHaveLength(1);
    expect(rows.filter((r) => r.target.startsWith('unity-01'))).toHaveLength(1);
    const hv1 = rows.filter((r) => r.target.startsWith('hv-01'));
    expect(hv1).toHaveLength(1);
    expect(hv1[0].message).toContain('7 of 7 Hyper-V VMs down');
    expect(rows.filter((r) => r.target.startsWith('hv-02'))).toHaveLength(3);
  });

  it('raises app-capacity-high at 85 percent and not below', () => {
    dev(10, 'unity-02');
    m(10, 'EMC_Unity_Pool', 'pool1', 'emc_cap_used_pct', 88);
    m(10, 'EMC_Unity_Pool', 'pool2', 'emc_cap_used_pct', 84.9);
    dev(11, 'splunk-01');
    m(11, 'Splunk_License', 'enterprise', 'splunk_license_used_pct', 85);
    dev(12, 'esa-01');
    m(12, 'Cisco_ESA_System', 'system', 'esa_quarantine_pct', 40);
    const rows = issuesOf('app-capacity-high');
    expect(rows.map((r) => r.target).sort()).toEqual(['splunk-01 enterprise', 'unity-02 pool1']);
    expect(rows.every((r) => r.severity === 'warning')).toBe(true);
  });

  it('raises app-queue-high for Splunk over 80 percent and ESA over 500 messages', () => {
    dev(20, 'splunk-02');
    m(20, 'Splunk_Queues', 'indexqueue', 'splunk_queue_fill_pct', 80);
    m(20, 'Splunk_Queues', 'typingqueue', 'splunk_queue_fill_pct', 81);
    dev(21, 'esa-02');
    m(21, 'Cisco_ESA_System', 'system', 'esa_queue', 501);
    dev(22, 'esa-03');
    m(22, 'Cisco_ESA_System', 'system', 'esa_queue', 500);
    const rows = issuesOf('app-queue-high');
    expect(rows.map((r) => r.target).sort()).toEqual(['esa-02 system', 'splunk-02 typingqueue']);
  });

  it('raises nothing for a device in scheduled downtime', () => {
    dev(30, 'sql-sdt', { sdt: 'SDT-none-none' });
    m(30, 'Microsoft_SQLServer_Service', 'MSSQLSERVER', 'sql_state', 0);
    expect(issuesOf('app-service-down')).toHaveLength(0);
  });
});

describe('Applications routes', () => {
  beforeEach(() => {
    dev(1, 'phx-sql-01');
    m(1, 'Microsoft_SQLServer_Service', 'MSSQLSERVER', 'sql_state', 1);
    const h = m(1, 'Microsoft_SQLServer_Performance', 'MSSQLSERVER', 'sql_connections', 140);
    m(1, 'Microsoft_SQLServer_Performance', 'MSSQLSERVER', 'sql_batch_rate', 800);
    const now = Math.floor(Date.now() / 1000);
    for (const [age, v] of [[7200, 100], [3600, 120], [600, 140]]) {
      db.prepare('INSERT INTO lm_ds_metrics_history (source_id, lm_device_id, hds_id, instance_key, metric, value, sampled_at_epoch) VALUES (?, ?, ?, ?, ?, ?, ?)')
        .run(sid, 1, h, 'MSSQLSERVER', 'sql_connections', v, now - age);
    }
    dev(2, 'phx-sql-02');
    m(2, 'Microsoft_SQLServer_Service', 'MSSQLSERVER', 'sql_state', 0);
    dev(3, 'phx-emc-unity-01', { vendor: 'EMC', role: 'other' });
    m(3, 'EMC_Unity_Pool', 'Pool_1', 'emc_health', 1);
    m(3, 'EMC_Unity_Pool', 'Pool_1', 'emc_cap_used_pct', 88);
    dev(4, 'phx-core-01', { vendor: 'Cisco', role: 'switch' });
  });

  it('GET /applications lists one row per device with apps data, with kinds, figures and state', async () => {
    const res = await request(app).get(`${API}/applications`);
    expect(res.status).toBe(200);
    expect(res.body.map((r) => r.deviceName).sort()).toEqual(['phx-emc-unity-01', 'phx-sql-01', 'phx-sql-02']);
    const sql = res.body.find((r) => r.deviceName === 'phx-sql-01');
    expect(sql).toMatchObject({ kinds: ['sql'], kindLabels: ['SQL Server'], instances: 2, downCount: 0, state: 'ok', openIssues: 0 });
    expect(sql.metrics).toMatchObject({ sql_state: 1, sql_connections: 140, sql_batch_rate: 800 });
    expect(sql.headline).toContain('140 connections');
    const bad = res.body.find((r) => r.deviceName === 'phx-sql-02');
    expect(bad).toMatchObject({ state: 'critical', downCount: 1, openIssues: 1 });
    expect(res.body.find((r) => r.deviceName === 'phx-emc-unity-01')).toMatchObject({ kinds: ['emc'], state: 'warning' });
  });

  it('filters by kind, state and q, and rejects bad values', async () => {
    expect((await request(app).get(`${API}/applications?kind=emc`)).body.map((r) => r.deviceName)).toEqual(['phx-emc-unity-01']);
    expect((await request(app).get(`${API}/applications?kind=splunk`)).body).toEqual([]);
    expect((await request(app).get(`${API}/applications?state=critical`)).body.map((r) => r.deviceName)).toEqual(['phx-sql-02']);
    expect((await request(app).get(`${API}/applications?q=unity`)).body).toHaveLength(1);
    expect((await request(app).get(`${API}/applications?kind=nope`)).status).toBe(400);
  });

  it('GET /applications.csv answers csv with the documented header', async () => {
    const res = await request(app).get(`${API}/applications.csv`);
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toMatch(/text\/csv/);
    expect(res.text.split('\r\n')[0]).toBe('deviceName,siteName,vendor,model,kindLabels,instances,downCount,headline,openIssues,state,sampledAt');
    expect(res.text).toContain('phx-sql-02');
  });

  it('GET /applications/:deviceId returns the 360 with datasource groups, issues and history', async () => {
    const res = await request(app).get(`${API}/applications/1`);
    expect(res.status).toBe(200);
    expect(res.body.summary.deviceName).toBe('phx-sql-01');
    expect(res.body.datasources.map((d) => d.name).sort()).toEqual(['Microsoft_SQLServer_Performance', 'Microsoft_SQLServer_Service']);
    const perf = res.body.datasources.find((d) => d.name === 'Microsoft_SQLServer_Performance');
    expect(perf.label).toBe('Microsoft SQL Server');
    expect(perf.instances[0].metrics.sql_connections).toMatchObject({ value: 140, label: 'Connections' });
    expect(res.body.history.sql_connections.length).toBe(3);
    const down = await request(app).get(`${API}/applications/2`);
    expect(down.body.issues.map((i) => i.type)).toEqual(['app-service-down']);
  });

  it('404s for a device with no apps data and for an unknown device', async () => {
    expect((await request(app).get(`${API}/applications/4`)).status).toBe(404);
    expect((await request(app).get(`${API}/applications/999`)).status).toBe(404);
  });

  it('shows the raw store beside the catalog: the values route still answers for an apps DataSource', async () => {
    const hds = db.prepare("SELECT hds_id FROM lm_ds_instances WHERE lm_device_id = 1 AND datasource_name = 'Microsoft_SQLServer_Performance'").get().hds_id;
    const res = await request(app).get(`${API}/devices/1/datasources/${hds}/values`);
    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty('items');
  });
});
