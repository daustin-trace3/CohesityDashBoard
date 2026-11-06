/**
 * F5 derived platform (backend). A fake coreApi whose feeds.query returns fixtures drives the
 * manifest hooks and the router; only the search category SQL and the notifier-key parity check
 * run against a scratch db seeded through the logicmonitor migrations.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { createRequire } from 'module';
import express from 'express';
import request from 'supertest';

const require = createRequire(import.meta.url);

const db = require('../db/database');
const { runMigrations } = require('../core/migrations');
const lmMigrations = require('../db/migrations/logicmonitor');
const f5 = require('../platforms/f5');
const lmManifest = require('../platforms/logicmonitor');
const { DEFAULTS, historyMetricFor } = require('../services/agentProfiles/defaults');
const platformAdvisor = require('../services/platformAdvisor');
const { createF5Advisor, REPORT_KEYS } = require('../services/advisors/f5Advisor');

const DEV = (o) => ({ id: 1, sourceId: 1, sourceName: 'CGSandBox', name: '10.0.0.1', displayName: 'lb-a', vendor: 'F5', role: 'load-balancer', model: 'BIG-IP i5800', version: '17.1', hostStatus: 'normal', openAlerts: 0, siteKey: 'phx', siteName: 'Phoenix', vendorKey: 'f5', vendorKind: 'bigip', vendorReason: 'sysoid:3375', state: 'ok', reasons: [], ...o });
const DEVICES = [
  DEV({ id: 1, displayName: 'lb-a', state: 'ok' }),
  DEV({ id: 2, displayName: 'lb-b', state: 'degraded', reasons: ['1 warning issue'], openAlerts: 2 }),
  DEV({ id: 3, displayName: 'gtm-a', vendorKind: 'gtm', state: 'failed', reasons: ['host dead'], openAlerts: 5 }),
  DEV({ id: 4, displayName: 'rs-1', vendorKind: 'f5os', state: 'ok', model: 'r5900' }),
];
const LB = (o) => ({ deviceId: 1, sourceId: 1, deviceName: 'lb-a', siteKey: 'phx', siteName: 'Phoenix', vendor: 'F5', model: 'BIG-IP', version: '17.1', hostStatus: 'normal', failoverText: 'active', syncState: 'in sync', cpuPct: 10, memPct: 20, clientConnections: 100, serverConnections: 90, pools: 3, poolsDegraded: 0, membersTotal: 9, membersDown: 0, wideIps: 0, wideIpsDown: 0, vips: 4, vipsDown: 0, daemonsDown: 0, certsExpiring: 0, state: 'ok', sampledAt: null, ...o });
const LBS = [
  LB({ deviceId: 1, deviceName: 'lb-a', failoverText: 'active' }),
  LB({ deviceId: 2, deviceName: 'lb-b', failoverText: 'standby', poolsDegraded: 2, pools: 5, membersDown: 3, daemonsDown: 1, certsExpiring: 1, state: 'warning' }),
  LB({ deviceId: 3, deviceName: 'gtm-a', failoverText: 'offline', pools: 0, state: 'critical' }),
  LB({ deviceId: 4, deviceName: 'rs-1', failoverText: null, pools: 0 }),
];
const ISSUES = [
  { severity: 'warning', type: 'lb-pool-degraded', source: 'CGSandBox', target: 'lb-b pool-web', message: 'pool down', issueKey: 'lb-pool-degraded|CGSandBox|lb-b pool-web', firstSeen: '2026-11-05T10:00:00Z', lastSeen: '2026-11-05T11:00:00Z' },
  { severity: 'critical', type: 'device-dead', source: 'CGSandBox', target: 'gtm-a', message: 'gtm-a is dead', issueKey: 'device-dead|CGSandBox|gtm-a', firstSeen: '2026-11-05T09:00:00Z', lastSeen: '2026-11-05T11:05:00Z' },
  { severity: 'critical', type: 'device-dead', source: 'CGSandBox', target: 'old-a', message: 'old-a is dead (shadowed by sw-1)', issueKey: 'device-dead|CGSandBox|old-a', firstSeen: '2026-11-05T09:00:00Z', lastSeen: '2026-11-05T11:05:00Z' },
];
const ALERT = (o) => ({ id: 'a1', sourceId: 1, type: 'alert', severity: 4, severityNorm: 'critical', deviceId: 3, monitorObjectName: 'gtm-a', datasource: 'F5_GTM_WideIP', instanceName: 'wip1', dataPointName: 'Avail', alertValue: '3', threshold: '> 2', startedAt: '2026-11-05T08:00:00.000Z', acked: false, sdted: false, cleared: false, conditionKey: 'ck-1', shadowedBy: null, duplicateOf: null, ...o });
const ALERTS = [
  ALERT({}),
  ALERT({ id: 'a2', severity: 3, severityNorm: 'warning', deviceId: 2, monitorObjectName: 'lb-b', datasource: 'F5_BigIP_PoolMemberStats', conditionKey: 'ck-2', acked: true, startedAt: '2026-11-05T07:00:00.000Z' }),
  ALERT({ id: 'a3', severity: 2, severityNorm: 'info', deviceId: 1, monitorObjectName: 'lb-a', conditionKey: 'ck-3' }),
  ALERT({ id: 'a4', severity: 4, severityNorm: 'critical', deviceId: 1, monitorObjectName: 'lb-a', conditionKey: 'ck-4', duplicateOf: 'duplicate:vcenter' }),
  ALERT({ id: 'a5', severity: 4, severityNorm: 'critical', deviceId: 1, monitorObjectName: 'lb-a', conditionKey: 'ck-5', sdted: true, startedAt: '2026-11-05T06:00:00.000Z' }),
];
const DETAIL = {
  3: { certs: [], pools: [] },
  1: { certs: [{ name: 'c-wild', daysLeft: 12.4 }, { name: 'c-api', daysLeft: 70 }, { name: 'c-ok', daysLeft: 300 }], pools: [{ pool: 'pool-web', up: 2, down: 0, members: [{ member: 'm1', connections: 50, avail: 'up' }] }] },
  2: { certs: [{ name: 'c-x', daysLeft: -3 }], pools: [{ pool: 'pool-web', up: 1, down: 2, members: [{ member: 'm2', connections: 5, avail: 'down' }, { member: 'm3', connections: 0, avail: 'up' }] }] },
};

let calls;
function fakeCoreApi({ presence = 4, devices = DEVICES, extraFeeds = {} } = {}) {
  calls = [];
  const feeds = {
    hasFeed: (c, name) => c === 'logicmonitor' && (name in extraFeeds || ['devices', 'device', 'alerts', 'issues', 'metrics', 'datasources', 'health', 'loadBalancers', 'loadBalancer', 'sources', 'presence'].includes(name)),
    query(connector, name, params) {
      calls.push({ connector, name, params });
      if (connector !== 'logicmonitor') throw Object.assign(new Error('unknown connector'), { code: 'FEED_UNKNOWN' });
      if (name in extraFeeds) return extraFeeds[name](params);
      switch (name) {
        case 'presence': return presence;
        case 'devices': return devices;
        case 'device': return devices.find((d) => d.id === params.deviceId) || null;
        case 'loadBalancers': return LBS;
        case 'loadBalancer': return DETAIL[params.deviceId] || null;
        case 'alerts': return ALERTS.filter((a) => !params.deviceIds || params.deviceIds.includes(a.deviceId));
        case 'issues': return { issues: ISSUES, asOf: '2026-11-05T11:05:00Z' };
        case 'sources': return [{ id: 1, name: 'CGSandBox', company: 'cg', lastPollAt: '2026-11-05T11:00:00Z', lastPollStatus: 'success', devices: 4 }];
        case 'health': return { hostStatus: 'normal', deadSince: null, alertStatus: '0', collectorDown: false, sdt: false };
        case 'metrics': return [{ metric: 'cpu_pct', value: 11 }];
        case 'datasources': return [{ name: 'F5_BigIP_Memory' }];
        default: throw Object.assign(new Error(`unknown feed ${name}`), { code: 'FEED_UNKNOWN' });
      }
    },
  };
  return { feeds, db, advisor: platformAdvisor };
}

function appFor(coreApi) {
  const app = express();
  app.use(express.json());
  app.use('/api/f5', f5.createRouter(coreApi));
  app.use((err, req, res, next) => res.status(500).json({ error: err.message })); // eslint-disable-line no-unused-vars
  return app;
}

describe('F5 manifest', () => {
  it('declares a derived platform with no poller or migrations', () => {
    expect(f5.id).toBe('f5');
    expect(f5.derivedFrom).toBe('logicmonitor');
    expect(f5.vendorKeys).toEqual(['f5']);
    expect(f5.apiVersion).toBe(1);
    expect(f5.color).toBe('#E4002B');
    expect(typeof f5.createRouter).toBe('function');
    expect(f5.createPoller).toBeUndefined();
    expect(f5.migrations).toBeUndefined();
  });

  it('presence reads the presence feed and is 0 on a feed failure', () => {
    expect(f5.presence(fakeCoreApi({ presence: 22 }))).toBe(22);
    expect(calls[0]).toEqual({ connector: 'logicmonitor', name: 'presence', params: { vendorKey: 'f5' } });
    expect(f5.presence(fakeCoreApi({ presence: 0 }))).toBe(0);
    const broken = { feeds: { query() { throw new Error('boom'); } } };
    expect(f5.presence(broken)).toBe(0);
  });

  it('reads only through feeds (no lm_* SQL outside the search category)', () => {
    const fs = require('fs');
    const path = require('path');
    const src = fs.readFileSync(path.join(__dirname, '..', 'platforms', 'f5', 'index.js'), 'utf8');
    const advisorSrc = fs.readFileSync(path.join(__dirname, '..', 'services', 'advisors', 'f5Advisor.js'), 'utf8');
    const sqlLines = src.split('\n').filter((l) => /\blm_[a-z_]+/.test(l) && !/^\s*\/\//.test(l));
    // the only code lines naming an lm_ table are the search SQL (and its table-qualified fragments)
    for (const l of sqlLines) expect(l).toMatch(/lm_devices|d\.|vendor_key|stale|WHERE|ORDER BY/);
    expect(advisorSrc).not.toMatch(/\.prepare\(/);
    expect(advisorSrc.replace(/\/\/.*$/gm, '')).not.toMatch(/\blm_[a-z_]+/);
  });
});

describe('overview', () => {
  it('builds every figure from the feed rows', () => {
    const o = f5._test.buildOverview(fakeCoreApi());
    expect(o.devices).toEqual({ total: 4, bigip: 2, gtm: 1, f5os: 1, failed: 1, degraded: 1, ok: 2 });
    expect(o.pools).toEqual({ total: 8, degraded: 2 });
    expect(o.failover).toEqual({ active: 1, standby: 1, degraded: 1 });
    expect(o.daemons).toEqual({ down: 1 });
    expect(o.alerts).toEqual({ critical: 2, warning: 1 });
    expect(o.issues).toEqual({ critical: 2, warning: 1 });
    expect(o.sources).toHaveLength(1);
    expect(o.topIssues).toHaveLength(3);
    expect(o.topIssues[0].severity).toBe('critical');
    // 12.4 and -3 are inside 30 days; 70 is only inside 90. F5OS rs-1 is skipped for certs.
    expect(o.certs).toEqual({ expiring30: 2, expiring90: 3 });
    expect(o.devicesWorstFirst.map((d) => d.displayName)).toEqual(['gtm-a', 'lb-b', 'lb-a', 'rs-1']);
    expect(calls.filter((c) => c.name === 'loadBalancer').map((c) => c.params.deviceId).sort()).toEqual([1, 2, 3]);
  });

  it('serves GET /overview', async () => {
    const res = await request(appFor(fakeCoreApi())).get('/api/f5/overview');
    expect(res.status).toBe(200);
    expect(Object.keys(res.body).sort()).toEqual(['alerts', 'certs', 'daemons', 'devices', 'devicesWorstFirst', 'failover', 'generatedAt', 'issues', 'pools', 'sources', 'topIssues']);
  });

  it('answers 503 connector_unavailable when the feed is missing', async () => {
    const coreApi = fakeCoreApi();
    coreApi.feeds.query = () => { throw Object.assign(new Error('no feed'), { code: 'FEED_UNKNOWN' }); };
    const res = await request(appFor(coreApi)).get('/api/f5/overview');
    expect(res.status).toBe(503);
    expect(res.body.error).toBe('connector_unavailable');
  });
});

describe('device routes', () => {
  it('filters devices by kind and state and passes vendorKey f5 to the feed', async () => {
    const app = appFor(fakeCoreApi());
    const gtm = await request(app).get('/api/f5/devices?kind=gtm');
    expect(gtm.body.map((d) => d.displayName)).toEqual(['gtm-a']);
    expect(calls.find((c) => c.name === 'devices').params).toMatchObject({ vendorKey: 'f5', vendorKind: 'gtm' });
    const failed = await request(app).get('/api/f5/devices?state=failed');
    expect(failed.body.map((d) => d.displayName)).toEqual(['gtm-a']);
    const all = await request(app).get('/api/f5/devices');
    expect(all.body).toHaveLength(4);
    expect((await request(app).get('/api/f5/devices?kind=bogus')).status).toBe(400);
  });

  it('exports devices as CSV', async () => {
    const res = await request(appFor(fakeCoreApi())).get('/api/f5/devices.csv');
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toMatch(/text\/csv/);
    expect(res.text.split('\r\n')[0]).toBe('displayName,vendorKind,state,reasons,siteName,model,version,openAlerts,sourceName');
    expect(res.text).toContain('gtm-a,gtm,failed,host dead');
  });

  it('returns one device 360 payload and 404s a non-F5 or missing device', async () => {
    const app = appFor(fakeCoreApi());
    const ok = await request(app).get('/api/f5/devices/3?sourceId=1');
    expect(ok.status).toBe(200);
    expect(Object.keys(ok.body).sort()).toEqual(['alerts', 'datasources', 'device', 'health', 'metrics']);
    expect(ok.body.device.displayName).toBe('gtm-a');
    expect(ok.body.alerts.map((a) => a.id)).toEqual(['a1']);
    expect((await request(app).get('/api/f5/devices/99')).status).toBe(404);
    const other = fakeCoreApi({ devices: [DEV({ id: 7, vendorKey: 'cisco' })] });
    expect((await request(appFor(other)).get('/api/f5/devices/7')).status).toBe(404);
  });

  it('serves load balancers, CSV and detail through the loadBalancers feeds with vendorKey f5', async () => {
    const app = appFor(fakeCoreApi());
    const list = await request(app).get('/api/f5/load-balancers');
    expect(list.body).toHaveLength(4);
    expect(calls.find((c) => c.name === 'loadBalancers').params).toMatchObject({ vendorKey: 'f5' });
    expect((await request(app).get('/api/f5/load-balancers?state=critical')).body.map((r) => r.deviceName)).toEqual(['gtm-a']);
    const csv = await request(app).get('/api/f5/load-balancers.csv');
    expect(csv.text.split('\r\n')[0]).toContain('deviceName,siteName,vendor');
    const one = await request(app).get('/api/f5/load-balancers/2?sourceId=1');
    expect(one.body.pools).toHaveLength(1);
    expect(calls.filter((c) => c.name === 'loadBalancer').pop().params).toMatchObject({ vendorKey: 'f5', deviceId: 2, sourceId: 1 });
    expect((await request(app).get('/api/f5/load-balancers/42')).status).toBe(404);
  });
});

describe('alerts and issues routes', () => {
  it('matches the LogicMonitor alerts list shape, hiding duplicates by default', async () => {
    const app = appFor(fakeCoreApi());
    const res = await request(app).get('/api/f5/alerts');
    expect(res.status).toBe(200);
    expect(Object.keys(res.body).sort()).toEqual(['counts', 'duplicates', 'items', 'limit', 'page', 'total']);
    expect(res.body.total).toBe(4);
    expect(res.body.items.map((a) => a.id)).not.toContain('a4');
    expect(res.body.counts).toEqual({ critical: 2, warning: 1, info: 1, acked: 1, sdted: 1 });
    expect(res.body.duplicates).toEqual({ total: 1, byPlatform: [{ platform: 'vcenter', count: 1 }] });
    const crit = await request(app).get('/api/f5/alerts?severity=critical&sort=startedAt&dir=asc');
    expect(crit.body.items.map((a) => a.id)).toEqual(['a5', 'a1']);
    expect((await request(app).get('/api/f5/alerts?duplicate=1')).body.items.map((a) => a.id)).toEqual(['a4']);
    expect((await request(app).get('/api/f5/alerts?q=pool')).body.total).toBe(1);
    expect((await request(app).get('/api/f5/alerts?acked=1')).body.items.map((a) => a.id)).toEqual(['a2']);
    expect((await request(app).get('/api/f5/alerts?severity=bad')).status).toBe(400);
  });

  it('serves issues with asOf in the LogicMonitor shape', async () => {
    const res = await request(appFor(fakeCoreApi())).get('/api/f5/issues');
    expect(res.body.asOf).toBe('2026-11-05T11:05:00Z');
    expect(res.body.issues).toHaveLength(3);
    expect(calls.find((c) => c.name === 'issues').params).toEqual({ vendorKey: 'f5' });
  });

  it('serves issue-history from the issueHistory feed and degrades to 503 when the feed is missing', async () => {
    const rows = [{ issue_key: 'k', type: 'lb-pool-degraded', issueKey: 'k' }];
    const res = await request(appFor(fakeCoreApi({ extraFeeds: { issueHistory: () => rows } }))).get('/api/f5/issue-history?days=7');
    expect(res.status).toBe(200);
    expect(res.body).toEqual(rows);
    expect(calls.find((c) => c.name === 'issueHistory').params).toEqual({ vendorKey: 'f5', days: 7 });
    const missing = await request(appFor(fakeCoreApi())).get('/api/f5/issue-history');
    expect(missing.status).toBe(503);
    expect(missing.body.error).toBe('connector_unavailable');
    expect((await request(appFor(fakeCoreApi())).get('/api/f5/issue-history?days=500')).status).toBe(400);
  });

  it('serves read-only settings', async () => {
    const res = await request(appFor(fakeCoreApi({ presence: 22 }))).get('/api/f5/settings');
    expect(res.body).toMatchObject({ matchedDevices: 22, derivedFrom: 'logicmonitor', logicmonitorSettingsPath: '/logicmonitor/settings?section=services' });
    expect(res.body.sources).toHaveLength(1);
  });
});

describe('opsSummary', () => {
  it('is null at presence 0 and does not read details', () => {
    expect(f5.opsSummary(fakeCoreApi({ presence: 0 }))).toBeNull();
  });

  it('summarises devices, pools and issues from rows only', () => {
    const s = f5.opsSummary(fakeCoreApi());
    expect(s.objects).toBe(4);
    expect(s.headline).toEqual([
      { label: 'Devices', value: '2/4' },
      { label: 'Pools Degraded', value: 2 },
      { label: 'Open Issues', value: 3 },
    ]);
    expect(s.exceptions.map((e) => `${e.severity}:${e.count}`)).toEqual(['critical:1', 'critical:2', 'warning:1', 'warning:2']);
    expect(calls.some((c) => c.name === 'loadBalancer')).toBe(false);
    expect(s.spark).toBeNull();
  });
});

describe('collectAlerts', () => {
  it('returns [] at presence 0', () => {
    expect(f5.collectAlerts(fakeCoreApi({ presence: 0 }))).toEqual([]);
  });

  it('emits issues and alerts in the notifier shape, skipping shadowed, sdted, info and duplicate rows', () => {
    const items = f5.collectAlerts(fakeCoreApi());
    expect(items.map((i) => i.sourceKey).sort()).toEqual(['ck-1', 'ck-2', 'device-dead|CGSandBox|gtm-a', 'lb-pool-degraded|CGSandBox|lb-b pool-web']);
    const a = items.find((i) => i.sourceKey === 'ck-1');
    expect(a).toMatchObject({ severity: 'critical', host: 'gtm-a', type: 'F5_GTM_WideIP', typeLabel: 'F5_GTM_WideIP', firstSeen: '2026-11-05T08:00:00.000Z' });
    expect(a.message).toBe('F5_GTM_WideIP wip1 Avail = 3 (threshold > 2)');
    const i = items.find((x) => x.sourceKey.startsWith('lb-pool'));
    expect(i).toMatchObject({ host: 'lb-b pool-web', type: 'lb-pool-degraded', severity: 'warning', message: 'pool down' });
  });

  describe('sourceKey parity with the LogicMonitor collector', () => {
    beforeAll(() => {
      runMigrations(db, 'logicmonitor', lmMigrations);
      for (const t of ['lm_alerts', 'lm_issue_history', 'lm_devices', 'lm_sources']) db.prepare(`DELETE FROM ${t}`).run();
    });

    it('uses the same keys, hosts and types for the same device', () => {
      db.prepare("INSERT INTO lm_sources (id, name, company, encrypted_credentials) VALUES (1, 'CGSandBox', 'cg', 'x')").run();
      db.prepare(`INSERT INTO lm_alerts (source_id, lm_alert_id, type, severity, severity_norm, lm_device_id, monitor_object_name, resource_template_name,
        instance_name, data_point_name, alert_value, threshold, start_epoch, cleared, condition_key) VALUES (1, 'x1', 'alert', 4, 'critical', 3, 'gtm-a', 'F5_GTM_WideIP', 'wip1', 'Avail', '3', '> 2', 1793000000, 0, 'ck-1')`).run();
      db.prepare("INSERT INTO lm_issue_history (issue_key, source, severity, type, target, message, status) VALUES ('device-dead|CGSandBox|gtm-a', 'CGSandBox', 'critical', 'device-dead', 'gtm-a', 'gtm-a is dead', 'open')").run();

      const lmItems = lmManifest.collectAlerts({ db });
      const lmByKey = new Map(lmItems.map((i) => [i.sourceKey, i]));

      const alertRow = ALERT({ startedAt: new Date(1793000000 * 1000).toISOString() });
      const issue = { severity: 'critical', type: 'device-dead', source: 'CGSandBox', target: 'gtm-a', message: 'gtm-a is dead', issueKey: 'device-dead|CGSandBox|gtm-a', firstSeen: null, lastSeen: null };
      const coreApi = fakeCoreApi({ extraFeeds: { alerts: () => [alertRow], issues: () => ({ issues: [issue], asOf: null }) } });
      const f5Items = f5.collectAlerts(coreApi);

      expect(new Set(f5Items.map((i) => i.sourceKey))).toEqual(new Set(lmByKey.keys()));
      for (const it of f5Items) {
        const lm = lmByKey.get(it.sourceKey);
        expect({ host: it.host, type: it.type, typeLabel: it.typeLabel, severity: it.severity }).toEqual({ host: lm.host, type: lm.type, typeLabel: lm.typeLabel, severity: lm.severity });
      }
      expect(f5Items.find((i) => i.sourceKey === 'ck-1').message).toBe(lmByKey.get('ck-1').message);
    });
  });
});

describe('search category', () => {
  beforeAll(() => {
    runMigrations(db, 'logicmonitor', lmMigrations);
    // Same ALTERs as migration v14, for a tree that does not have it yet.
    const cols = db.prepare("PRAGMA table_info('lm_devices')").all().map((c) => c.name);
    for (const c of ['vendor_key', 'vendor_kind', 'vendor_reason']) if (!cols.includes(c)) db.exec(`ALTER TABLE lm_devices ADD COLUMN ${c} TEXT`);
    for (const t of ['lm_alerts', 'lm_issue_history', 'lm_devices', 'lm_sources']) db.prepare(`DELETE FROM ${t}`).run();
    db.prepare("INSERT INTO lm_sources (id, name, company, encrypted_credentials) VALUES (1, 'CGSandBox', 'cg', 'x')").run();
    const ins = db.prepare('INSERT INTO lm_devices (source_id, lm_device_id, name, display_name, model, version, stale, vendor_key, vendor_kind) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)');
    ins.run(1, 1, '10.0.0.1', 'lb-search-a', 'BIG-IP', '17.1', 0, 'f5', 'bigip');
    ins.run(1, 2, '10.0.0.2', 'lb-search-stale', 'BIG-IP', '17.1', 1, 'f5', 'bigip');
    ins.run(1, 3, '10.0.0.3', 'lb-search-cisco', 'N9K', '10', 0, 'cisco', 'nexus');
    ins.run(1, 4, '10.0.0.4', 'lb-search-null', 'x', '1', 0, null, null);
  });

  it('is shaped for routes/search.js and returns only live F5 devices', () => {
    const [cat] = f5.searchCategories;
    expect(cat).toMatchObject({ key: 'f5-devices', label: 'F5 devices', platform: 'f5', base: '/f5/devices', params: 2 });
    expect(cat.perm).toBe('f5:devices:view');
    const rows = db.prepare(cat.sql).all('%lb-search%', '%lb-search%', 8);
    expect(rows.map((r) => r.title)).toEqual(['lb-search-a']);
    expect(rows[0].subtitle).toContain('bigip');
    expect(cat.route({ title: 'lb a' })).toBe('/f5/devices?q=lb%20a');
  });
});

describe('agent profile and incident evidence', () => {
  it('defaults.js carries the f5 entry within the focus limit and the cpu history mapping', () => {
    expect(DEFAULTS.f5.focus.length).toBeLessThanOrEqual(600);
    expect(DEFAULTS.f5.focus).toMatch(/BIG-IP/);
    expect(DEFAULTS.f5.ports.source.map((x) => x.port)).toEqual([443]);
    expect(DEFAULTS.f5.ports.host.map((x) => x.port)).toEqual([443, 22]);
    expect(DEFAULTS.f5.relations).toEqual(['identity_links']);
    expect(historyMetricFor.f5['device-cpu-high']).toBe('cpu_pct');
    expect(f5.agentProfile.focus).toBe(DEFAULTS.f5.focus);
  });

  it('builds evidence lines for an F5 host and returns null for others', () => {
    const ev = f5.incidentEvidence(fakeCoreApi(), { names: new Set(['LB-B.example.com']), ips: new Set() });
    expect(ev.title).toBe('F5');
    expect(ev.lines[0]).toContain('F5 lb-b: bigip, state degraded');
    expect(ev.lines.join('\n')).toContain('Failover standby');
    expect(ev.lines.join('\n')).toContain('pools degraded 2 of 5');
    expect(ev.lines.join('\n')).toContain('Open warning lb-pool-degraded: pool down');
    expect(f5.incidentEvidence(fakeCoreApi(), { names: new Set(['somebox']), ips: new Set() })).toBeNull();
    expect(f5.incidentEvidence(fakeCoreApi(), {})).toBeNull();
  });
});

describe('advisor', () => {
  it('lists the five presets and gathers from feeds only', () => {
    const feeds = fakeCoreApi().feeds;
    const adv = createF5Advisor({ feeds, advisor: platformAdvisor });
    expect(adv.REPORTS).toEqual(REPORT_KEYS);
    expect(REPORT_KEYS).toEqual(['f5_health', 'f5_capacity', 'f5_cert_audit', 'f5_pool_review', 'f5_change_review']);

    const health = adv.gatherFor('f5_health');
    expect(health.devices).toHaveLength(4);
    expect(health.openAlertCounts).toEqual({ critical: 3, warning: 1 });
    expect(health.failover.find((f) => f.device === 'lb-b').failover).toBe('standby');

    const cap = adv.gatherFor('f5_capacity');
    expect(cap.highestCpu).toHaveLength(4);
    expect(cap.poolMemberLoad.length).toBeGreaterThan(0);

    const certs = adv.gatherFor('f5_cert_audit');
    expect(certs.buckets).toEqual({ expired: 1, within30Days: 1, within60Days: 0, within90Days: 1, over90Days: 1 });
    expect(certs.soonest[0]).toMatchObject({ certificate: 'c-x', daysLeft: -3 });

    const pools = adv.gatherFor('f5_pool_review');
    expect(pools.devicesWithDegradedPools.map((d) => d.device)).toEqual(['lb-b']);
    expect(pools.degradedPools[0]).toMatchObject({ device: 'lb-b', pool: 'pool-web', membersDown: 2 });
    expect(pools.degradedPools[0].downMembers.map((m) => m.member)).toEqual(['m2']);
  });

  it('says plainly when the connector has no config change feed, and uses it when it does', () => {
    const none = createF5Advisor({ feeds: fakeCoreApi().feeds, advisor: platformAdvisor }).gatherFor('f5_change_review');
    expect(none.changes).toEqual([]);
    expect(none.note).toMatch(/does not expose a configuration change feed/);
    const feeds = fakeCoreApi({ extraFeeds: { configChanges: () => ({ changes: [{ device: 'lb-a', change: 'x' }] }) } }).feeds;
    const some = createF5Advisor({ feeds, advisor: platformAdvisor }).gatherFor('f5_change_review');
    expect(some.changes).toHaveLength(1);
    expect(calls.pop().params).toEqual({ vendorKey: 'f5', days: 30 });
  });

  it('serves cached reports through the routes, creating the cache table on first use', async () => {
    db.prepare('DROP TABLE IF EXISTS f5_ai_reports').run();
    const app = appFor(fakeCoreApi());
    const miss = await request(app).get('/api/f5/advisor/f5-health');
    expect(miss.status).toBe(200);
    expect(miss.body.report).toBeNull();
    expect(typeof miss.body.enabled).toBe('boolean');
    expect((await request(app).get('/api/f5/advisor/nope')).status).toBe(404);
    db.prepare("INSERT INTO f5_ai_reports (report_key, model, content, generated_at) VALUES ('f5_health', 'm', 'hello', ?)").run(new Date().toISOString());
    const hit = await request(app).get('/api/f5/advisor/f5_health');
    expect(hit.body.report).toMatchObject({ reportKey: 'f5_health', content: 'hello', stale: false });
    // no provider is configured in tests: generation answers 503, never reaches a model
    const gen = await request(app).post('/api/f5/advisor/f5-health');
    expect(gen.status).toBe(503);
  });
});
