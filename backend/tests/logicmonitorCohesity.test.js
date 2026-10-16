/**
 * LogicMonitor round 10, WP-B: Cohesity clusters seen through LogicMonitor.
 * Catalog family, the four issue types, the duplicate rule that now needs the
 * LM device to resolve to an ICC cluster, and the /lookup metrics shape.
 * Datapoint names and enums are UNVERIFIED against a live portal; rows are
 * seeded by hand.
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
const dup = require('../services/logicmonitorDuplicates');
const { isDownValue } = require('../services/logicmonitorCohesity');

const TABLES = ['lm_alerts', 'lm_issue_history', 'lm_ds_metrics_history', 'lm_ds_metrics', 'lm_ds_instances', 'lm_device_datasources', 'lm_devices', 'lm_sources'];

let app;
let sid;
let hdsSeq;
let seq = 0;

beforeAll(() => {
  runMigrations(db, 'logicmonitor', lmMigrations);
  const router = require('../routes/logicmonitor');
  const errorHandler = require('../middleware/errorHandler');
  app = express();
  app.use(express.json());
  app.use('/api/logicmonitor', router);
  app.use(errorHandler);
});

beforeEach(() => {
  for (const t of TABLES) db.prepare(`DELETE FROM ${t}`).run();
  db.prepare("DELETE FROM app_settings WHERE key LIKE 'lm_%'").run();
  try { db.prepare('DELETE FROM cohesity_nodes').run(); } catch { /* table absent */ }
  try { db.prepare('DELETE FROM clusters').run(); } catch { /* table absent */ }
  sid = db.prepare('INSERT INTO lm_sources (name, company, auth_mode, encrypted_credentials) VALUES (?, ?, ?, ?)')
    .run('Acme', 'acme', 'lmv1', encrypt(JSON.stringify({ accessId: 'a', accessKey: 'b' }))).lastInsertRowid;
  hdsSeq = 1000;
});

function dev(id, name, over = {}) {
  db.prepare(`INSERT INTO lm_devices (source_id, lm_device_id, name, display_name, hostname, device_type, host_status, sdt_status, vendor, role, is_network, site_key, ips_json, stale)
    VALUES (?, ?, ?, ?, ?, 0, 'normal', ?, 'Net-SNMP', 'server', 0, 'phoenix', ?, 0)`)
    .run(sid, id, name, name, over.hostname || name, over.sdt || 'none-none-none', JSON.stringify(over.ips || []));
}

function m(devId, ds, instance, metric, value, extra = {}) {
  const hds = (db.prepare('SELECT hds_id FROM lm_ds_instances WHERE source_id = ? AND lm_device_id = ? AND datasource_name = ? LIMIT 1').get(sid, devId, ds) || {}).hds_id || (hdsSeq += 1);
  db.prepare(`INSERT OR IGNORE INTO lm_ds_instances (source_id, lm_device_id, hds_id, datasource_name, family, instance_key, instance_name, stale)
    VALUES (?, ?, ?, ?, 'cohesity', ?, ?, 0)`).run(sid, devId, hds, ds, instance, extra.name || instance);
  db.prepare(`INSERT OR REPLACE INTO lm_ds_metrics (source_id, lm_device_id, hds_id, datasource_name, family, instance_key, metric, datapoint, value, sampled_at_epoch)
    VALUES (?, ?, ?, ?, 'cohesity', ?, ?, ?, ?, ?)`).run(sid, devId, hds, ds, instance, metric, metric, value, Math.floor(Date.now() / 1000) - 60);
}

const issuesOf = (type) => lmIssues.computeIssues().filter((i) => i.type === type);

describe('catalog family', () => {
  it('registers the cohesity family and matches the DataSource names', () => {
    expect(catalog.FAMILIES).toContain('cohesity');
    expect(catalog.FAMILY_LABELS.cohesity).toBe('Cohesity (via LogicMonitor)');
    expect(catalog.CATALOG_VERSION).toBe(3);
    for (const name of ['Cohesity_DataPlatform_ClusterStatus', 'Cohesity_DataPlatform_BasicStorage', 'Cohesity_DataPlatform_NodeStatus',
      'Cohesity_DataPlatform_Fans', 'Cohesity_DataPlatform_PowerSupplies', 'ntm_cohesity_node_services',
      'Cohesity_DataPlatform_ProtectionJobs', 'ntm_cohesity_alerts', 'Cohesity_DataPlatform_Troubleshooter']) {
      expect(catalog.catalogFor(name)?.family, name).toBe('cohesity');
    }
    expect(catalog.catalogFor('ntm_cohesity_node_services').maxInstances).toBe(500);
  });

  it('claims used percent before used bytes and total before available', () => {
    const { parseDsBody } = require('../services/logicmonitorMetrics');
    const entry = catalog.catalogFor('Cohesity_DataPlatform_BasicStorage');
    const body = { dataPoints: ['UsedPct', 'UsedBytes', 'TotalBytes', 'AvailBytes', 'DedupRatio'], instances: {} };
    const res = parseDsBody(body, entry);
    expect(res.learned).toMatchObject({ cap_used_pct: 'UsedPct', cap_used_bytes: 'UsedBytes', cap_total_bytes: 'TotalBytes', cap_avail_bytes: 'AvailBytes', dedupe_ratio: 'DedupRatio' });
  });
});

describe('isDownValue', () => {
  it('reads numeric zero and down words as down, not 10', () => {
    expect(isDownValue(0)).toBe(true);
    expect(isDownValue(1)).toBe(false);
    expect(isDownValue(10)).toBe(false);
    expect(isDownValue('Offline')).toBe(true);
    expect(isDownValue(null)).toBe(false);
  });
});

describe('cohesity issues', () => {
  it('threshold keys exist with the contract defaults', () => {
    expect(lmIssues.THRESHOLD_DEFS.lm_cohesity_cap_warn_pct).toMatchObject({ def: 80, min: 50, max: 100 });
    expect(lmIssues.THRESHOLD_DEFS.lm_cohesity_cap_crit_pct).toMatchObject({ def: 90, min: 50, max: 100 });
  });

  it('cohesity-node-down is critical, prints the raw value and targets "<cluster> <node>"', () => {
    dev(1, 'coh-a');
    m(1, 'Cohesity_DataPlatform_NodeStatus', 'coh-a-node-1', 'node_status', 1);
    m(1, 'Cohesity_DataPlatform_NodeStatus', 'coh-a-node-2', 'node_status', 0);
    const got = issuesOf('cohesity-node-down');
    expect(got).toHaveLength(1);
    expect(got[0]).toMatchObject({ severity: 'critical', target: 'coh-a coh-a-node-2' });
    expect(got[0].message).toContain('reads 0');
  });

  it('cohesity-service-down: one warning per service up to the fold, one folded issue above it', () => {
    dev(1, 'coh-few');
    dev(2, 'coh-many');
    for (let i = 1; i <= 3; i += 1) m(1, 'ntm_cohesity_node_services', `n1-svc${i}`, 'service_state', i <= 2 ? 0 : 1);
    for (let i = 1; i <= 7; i += 1) m(2, 'ntm_cohesity_node_services', `n1-svc${i}`, 'service_state', 0);
    const got = issuesOf('cohesity-service-down');
    expect(got.filter((i) => i.target.startsWith('coh-few'))).toHaveLength(2);
    const folded = got.filter((i) => i.target.startsWith('coh-many'));
    expect(folded).toHaveLength(1);
    expect(folded[0].message).toContain('7 of 7');
  });

  it('cohesity-hardware-fault covers fans and power supplies', () => {
    dev(1, 'coh-hw');
    m(1, 'Cohesity_DataPlatform_Fans', 'n1 Fan 1', 'fan_state', 1);
    m(1, 'Cohesity_DataPlatform_Fans', 'n1 Fan 2', 'fan_state', 0);
    m(1, 'Cohesity_DataPlatform_PowerSupplies', 'n1 PSU 2', 'psu_state', 0);
    const got = issuesOf('cohesity-hardware-fault');
    expect(got.map((i) => i.target).sort()).toEqual(['coh-hw n1 Fan 2', 'coh-hw n1 PSU 2']);
    expect(got.every((i) => i.severity === 'warning')).toBe(true);
  });

  it('cohesity-capacity-high is warning at 80, critical at 90, quiet below, and falls back to used over total', () => {
    dev(1, 'coh-ok'); dev(2, 'coh-warn'); dev(3, 'coh-crit'); dev(4, 'coh-bytes');
    m(1, 'Cohesity_DataPlatform_BasicStorage', 'storage', 'cap_used_pct', 71);
    m(2, 'Cohesity_DataPlatform_BasicStorage', 'storage', 'cap_used_pct', 86);
    m(3, 'Cohesity_DataPlatform_BasicStorage', 'storage', 'cap_used_pct', 93);
    m(4, 'Cohesity_DataPlatform_BasicStorage', 'storage', 'cap_used_bytes', 850);
    m(4, 'Cohesity_DataPlatform_BasicStorage', 'storage', 'cap_total_bytes', 1000);
    const got = issuesOf('cohesity-capacity-high');
    const by = Object.fromEntries(got.map((i) => [i.target.split(' ')[0], i.severity]));
    expect(by).toEqual({ 'coh-warn': 'warning', 'coh-crit': 'critical', 'coh-bytes': 'warning' });
  });

  it('a device in scheduled downtime raises nothing', () => {
    dev(1, 'coh-sdt', { sdt: 'none-SDT-none' });
    m(1, 'Cohesity_DataPlatform_NodeStatus', 'n1', 'node_status', 0);
    expect(issuesOf('cohesity-node-down')).toEqual([]);
  });
});

describe('duplicate rule needs an ICC cluster match', () => {
  function alert(ds, deviceId) {
    seq += 1;
    db.prepare(`INSERT INTO lm_alerts (source_id, lm_alert_id, severity, severity_norm, lm_device_id, monitor_object_name, resource_template_name,
        instance_name, data_point_name, alert_value, start_epoch, cleared, condition_key)
      VALUES (?, ?, 3, 'warning', ?, 'obj', ?, 'i', 'dp', '1', ?, 0, ?)`)
      .run(sid, `C${seq}`, deviceId, ds, Math.floor(Date.now() / 1000) - 600, `k${seq}`);
    return `C${seq}`;
  }
  const dupOf = (id) => db.prepare('SELECT duplicate_of d FROM lm_alerts WHERE lm_alert_id = ?').get(id).d;

  it('matches the spaced and DataPlatform names', () => {
    expect(dup.ownerForDatasource('Cohesity Protection Jobs').platform).toBe('cohesity');
    expect(dup.ownerForDatasource('Cohesity_DataPlatform_Alerts').platform).toBe('cohesity');
  });

  it('tags the alert only when the LM device resolves to an ICC cluster by name or node address', () => {
    db.prepare("INSERT INTO clusters (name, connection_type, vip, auth_type, encrypted_credentials) VALUES ('coh-icc', 'direct', '10.9.9.9', 'apikey', 'x')").run();
    const cid = db.prepare("SELECT id FROM clusters WHERE name = 'coh-icc'").get().id;
    dev(1, 'coh-icc');
    dev(2, 'coh-sandbox');
    dev(3, 'coh-by-ip', { ips: ['10.7.7.7'] });
    try {
      db.prepare("INSERT INTO cohesity_nodes (cluster_id, node_id, hostname, ip) VALUES (?, 1, 'coh-icc-node-1', '10.7.7.7')").run(cid);
    } catch { /* cohesity_nodes absent in this schema: the by-ip case is skipped below */ }
    const a1 = alert('Cohesity_DataPlatform_Alerts', 1);
    const a2 = alert('Cohesity Protection Jobs', 2);
    const a3 = alert('Cohesity_DataPlatform_Alerts', 3);
    const hasNodes = !!db.prepare("SELECT name FROM sqlite_master WHERE name = 'cohesity_nodes'").get();
    dup.markDuplicateAlerts(db);
    expect(dupOf(a1)).toBe('duplicate:cohesity');
    expect(dupOf(a2)).toBeNull();
    expect(dupOf(a3)).toBe(hasNodes ? 'duplicate:cohesity' : null);
  });

  it('leaves everything visible when ICC has no cluster at all', () => {
    dev(1, 'coh-icc');
    const a = alert('Cohesity_DataPlatform_Alerts', 1);
    expect(dup.markDuplicateAlerts(db).marked).toBe(0);
    expect(dupOf(a)).toBeNull();
  });
});

describe('GET /lookup metrics', () => {
  it('returns metrics and families for the resolved device, filtered by family', async () => {
    dev(1, 'coh-look');
    m(1, 'Cohesity_DataPlatform_BasicStorage', 'storage', 'cap_used_pct', 71);
    m(1, 'Cohesity_DataPlatform_BasicStorage', 'storage', 'cap_total_bytes', 1000);
    m(1, 'Cohesity_DataPlatform_NodeStatus', 'n1', 'node_status', 1);
    const res = await request(app).get('/api/logicmonitor/lookup?names=coh-look');
    expect(res.status).toBe(200);
    expect(res.body.families).toEqual(['cohesity']);
    expect(res.body.metrics).toHaveLength(3);
    const first = res.body.metrics[0];
    expect(Object.keys(first).sort()).toEqual(['datasource', 'datasourceLabel', 'family', 'instanceKey', 'instanceName', 'kind', 'label', 'metric', 'sampledAt', 'unit', 'value'].sort());
    expect(first).toMatchObject({ datasource: 'Cohesity_DataPlatform_BasicStorage', family: 'cohesity', instanceKey: 'storage', metric: 'cap_total_bytes', label: 'Total', unit: 'bytes', value: 1000 });
    expect(first.sampledAt).toMatch(/Z$/);
    const none = await request(app).get('/api/logicmonitor/lookup?names=coh-look&family=firewall');
    expect(none.body.metrics).toEqual([]);
  });

  it('answers empty metrics for an unknown device', async () => {
    const res = await request(app).get('/api/logicmonitor/lookup?names=nobody');
    expect(res.body).toMatchObject({ device: null, metrics: [], families: [] });
  });
});
