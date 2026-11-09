/**
 * Cisco derived platform (backend). A fake coreApi whose feeds.query returns fixtures drives the
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
const cisco = require('../platforms/cisco');
const lmManifest = require('../platforms/logicmonitor');
const { DEFAULTS, historyMetricFor } = require('../services/agentProfiles/defaults');
const platformMeta = require('../services/platformMeta');
const platformAdvisor = require('../services/platformAdvisor');
const { createCiscoAdvisor, REPORT_KEYS } = require('../services/advisors/ciscoAdvisor');

const DEV = (o) => ({ id: 1, sourceId: 1, sourceName: 'CGSandBox', name: '10.0.0.1', displayName: 'sw-a', vendor: 'Cisco', role: 'switch', model: 'C9300', version: '17.9', hostStatus: 'normal', openAlerts: 0, siteKey: 'phx', siteName: 'Phoenix', vendorKey: 'cisco', vendorKind: 'switch', vendorReason: 'sysoid:9', state: 'ok', reasons: [], ...o });
const DEVICES = [
  DEV({ id: 1, displayName: 'sw-a', state: 'ok' }),
  DEV({ id: 2, displayName: 'nx-a', vendorKind: 'nexus', model: 'N9K', state: 'degraded', reasons: ['1 warning issue'], openAlerts: 2 }),
  DEV({ id: 3, displayName: 'asa-a', vendorKind: 'firewall', state: 'failed', reasons: ['host dead'], openAlerts: 5 }),
  DEV({ id: 4, displayName: 'mr-1', vendorKey: 'meraki', vendorKind: 'mr', model: 'MR46', state: 'ok' }),
  DEV({ id: 5, displayName: 'mx-1', vendorKey: 'meraki', vendorKind: 'mx', model: 'MX250', state: 'degraded', openAlerts: 1 }),
];
const KEY_OF = (id) => DEVICES.find((d) => d.id === id)?.vendorKey;
const FW = [
  { deviceId: 3, sourceId: 1, deviceName: 'asa-a', vendor: 'Cisco', model: 'ASA5545', haText: 'active / standby', state: 'critical', tunnelsUp: 4, tunnelsDown: 1 },
  { deviceId: 5, sourceId: 1, deviceName: 'mx-1', vendor: 'Meraki', model: 'MX250', haText: 'degraded / n/a', state: 'warning', tunnelsUp: 2, tunnelsDown: 0 },
  { deviceId: 9, sourceId: 1, deviceName: 'asa-b', vendor: 'Cisco', model: 'ASA5525', haText: 'off', state: 'ok', tunnelsUp: 0, tunnelsDown: 0 },
];
const WLC = [{ deviceId: 7, sourceId: 1, deviceName: 'wlc-1', model: 'C9800', state: 'warning', apsTotal: 40, apsDown: 2, clients: 300, hotRadios: 1 }];
const WL_OVERVIEW = {
  totals: { controllers: 1, controllersDegraded: 1, aps: 40, apsUp: 38, apsDown: 2, radios: 80, radiosDown: 0, hotRadios: 1, clients: 300, ssids: 3, radiusUnresponsive: 0 },
  controllers: WLC, analytics: { byBand: [{ band: '5', radios: 40 }], downAps: [{ ap: 'ap-1', controller: 'wlc-1', status: 'down' }], hottestRadios: [] }, clientTrend: [],
};
const ISE = [{ deviceId: 8, sourceId: 1, deviceName: 'ise-1', state: 'ok', sessions: 120, certDaysMin: 200 }, { deviceId: 18, sourceId: 1, deviceName: 'ise-2', state: 'critical', sessions: 0, certDaysMin: 4, nodesDown: 1 }];
const VOICE = [{ deviceId: 10, sourceId: 1, deviceName: 'cube-1', kind: 'cube', state: 'warning', cpuPct: 50 }, { deviceId: 11, sourceId: 1, deviceName: 'sbc-1', kind: 'sbc', state: 'ok', cpuPct: 20 }];
const ISSUES = {
  cisco: [
    { severity: 'warning', type: 'fan-fault', source: 'CGSandBox', target: 'nx-a Fan 2', message: 'fan failed', issueKey: 'fan-fault|CGSandBox|nx-a Fan 2', firstSeen: '2026-11-05T10:00:00Z', lastSeen: '2026-11-05T11:00:00Z' },
    { severity: 'critical', type: 'device-dead', source: 'CGSandBox', target: 'asa-a', message: 'asa-a is dead', issueKey: 'device-dead|CGSandBox|asa-a', firstSeen: '2026-11-05T09:00:00Z', lastSeen: '2026-11-05T11:05:00Z' },
    { severity: 'critical', type: 'device-dead', source: 'CGSandBox', target: 'old-a', message: 'old-a is dead (shadowed by sw-1)', issueKey: 'device-dead|CGSandBox|old-a', firstSeen: '2026-11-05T09:00:00Z', lastSeen: '2026-11-05T11:05:00Z' },
  ],
  meraki: [
    { severity: 'warning', type: 'device-dead', source: 'CGSandBox', target: 'mx-1', message: 'mx-1 uplink', issueKey: 'device-dead|CGSandBox|mx-1', firstSeen: '2026-11-05T09:30:00Z', lastSeen: '2026-11-05T11:06:00Z' },
  ],
};
const ALERT = (o) => ({ id: 'a1', sourceId: 1, type: 'alert', severity: 4, severityNorm: 'critical', deviceId: 3, monitorObjectName: 'asa-a', datasource: 'Cisco_ASA_Failover', instanceName: 'unit', dataPointName: 'State', alertValue: '3', threshold: '> 2', startedAt: '2026-11-05T08:00:00.000Z', acked: false, sdted: false, cleared: false, conditionKey: 'ck-1', shadowedBy: null, duplicateOf: null, ...o });
const ALERTS = [
  ALERT({}),
  ALERT({ id: 'a2', severity: 3, severityNorm: 'warning', deviceId: 5, monitorObjectName: 'mx-1', datasource: 'Meraki_Uplink', conditionKey: 'ck-2', acked: true, startedAt: '2026-11-05T07:00:00.000Z' }),
  ALERT({ id: 'a3', severity: 2, severityNorm: 'info', deviceId: 1, monitorObjectName: 'sw-a', conditionKey: 'ck-3' }),
  ALERT({ id: 'a4', severity: 4, severityNorm: 'critical', deviceId: 1, monitorObjectName: 'sw-a', conditionKey: 'ck-4', duplicateOf: 'duplicate:vcenter' }),
  ALERT({ id: 'a5', severity: 4, severityNorm: 'critical', deviceId: 2, monitorObjectName: 'nx-a', conditionKey: 'ck-5', sdted: true, startedAt: '2026-11-05T06:00:00.000Z' }),
];

let calls;
function fakeCoreApi({ presence = { cisco: 3, meraki: 2 }, devices = DEVICES, extraFeeds = {}, familyFeeds = true } = {}) {
  calls = [];
  const FAMILY = {
    firewalls: () => FW, firewall: (p) => FW.find((f) => f.deviceId === p.deviceId) && { summary: FW.find((f) => f.deviceId === p.deviceId) },
    wirelessOverview: () => WL_OVERVIEW, wirelessControllers: () => WLC, wirelessController: (p) => (p.deviceId === 7 ? { summary: WLC[0], aps: [] } : null),
    wirelessAps: () => [{ ap: 'ap-1', controller: 'wlc-1', status: 'down' }], wirelessAp: (p) => (p.apKey === 'ap-1' ? { ap: { apKey: 'ap-1' }, radios: [], ports: [], issues: [] } : null),
    wirelessRf: () => ({ thresholdPct: 70, bands: [], radios: [{ radio: 'r1', ap: 'ap-1', band: '5' }] }), wirelessSsids: () => ({ summary: [], rows: [], trend: { total: [], bySsid: [] } }),
    voice: () => VOICE, voiceDevice: (p) => (p.deviceId === 10 ? { summary: VOICE[0] } : null), ise: () => ISE, iseNode: (p) => (p.deviceId === 8 ? { summary: ISE[0] } : null),
  };
  const BASE = ['devices', 'device', 'alerts', 'issues', 'metrics', 'datasources', 'health', 'sources', 'presence'];
  const feeds = {
    hasFeed: (c, name) => c === 'logicmonitor' && (name in extraFeeds || BASE.includes(name) || (familyFeeds && name in FAMILY)),
    query(connector, name, params) {
      calls.push({ connector, name, params });
      if (connector !== 'logicmonitor') throw Object.assign(new Error('unknown connector'), { code: 'FEED_UNKNOWN' });
      if (name in extraFeeds) return extraFeeds[name](params);
      if (familyFeeds && name in FAMILY) return FAMILY[name](params);
      switch (name) {
        case 'presence': return presence[params.vendorKey] || 0;
        case 'devices': return devices.filter((d) => !params.vendorKey || d.vendorKey === params.vendorKey);
        case 'device': return devices.find((d) => d.id === params.deviceId) || null;
        case 'alerts': return ALERTS.filter((a) => (!params.vendorKey || KEY_OF(a.deviceId) === params.vendorKey) && (!params.deviceIds || params.deviceIds.includes(a.deviceId)));
        case 'issues': return { issues: ISSUES[params.vendorKey] || [], asOf: params.vendorKey === 'cisco' ? '2026-11-05T11:05:00Z' : '2026-11-05T11:06:00Z' };
        case 'sources': return [{ id: 1, name: 'CGSandBox', company: 'cg', lastPollAt: '2026-11-05T11:00:00Z', lastPollStatus: 'success', devices: 5 }];
        case 'health': return { hostStatus: 'normal', deadSince: null, alertStatus: '0', collectorDown: false, sdt: false };
        case 'metrics': return [{ metric: 'cpu_pct', value: 11 }, { metric: 'fan_state', value: 3 }];
        case 'datasources': return [{ name: 'Cisco_Fans' }];
        default: throw Object.assign(new Error(`unknown feed ${name}`), { code: 'FEED_UNKNOWN' });
      }
    },
  };
  return { feeds, db, advisor: platformAdvisor };
}

function appFor(coreApi) {
  const app = express();
  app.use(express.json());
  app.use('/api/cisco', cisco.createRouter(coreApi));
  app.use((err, req, res, next) => res.status(500).json({ error: err.message })); // eslint-disable-line no-unused-vars
  return app;
}

describe('Cisco manifest', () => {
  it('declares a derived platform over two vendor keys with no poller or migrations', () => {
    expect(cisco.id).toBe('cisco');
    expect(cisco.derivedFrom).toBe('logicmonitor');
    expect(cisco.vendorKeys).toEqual(['cisco', 'meraki']);
    expect(cisco.apiVersion).toBe(1);
    expect(cisco.color).toBe('#049FD9');
    expect(typeof cisco.createRouter).toBe('function');
    expect(cisco.createPoller).toBeUndefined();
    expect(cisco.migrations).toBeUndefined();
    expect(platformMeta.BUILTIN.cisco).toMatchObject({ label: 'Cisco', color: '#049FD9', route: '/cisco', alertsRoute: '/cisco/alerts' });
  });

  it('presence is the sum of the presence feed over both keys and 0 on a feed failure', () => {
    expect(cisco.presence(fakeCoreApi({ presence: { cisco: 126, meraki: 13 } }))).toBe(139);
    expect(calls.map((c) => c.params)).toEqual([{ vendorKey: 'cisco' }, { vendorKey: 'meraki' }]);
    expect(cisco.presence(fakeCoreApi({ presence: { cisco: 0, meraki: 4 } }))).toBe(4);
    expect(cisco.presence(fakeCoreApi({ presence: {} }))).toBe(0);
    expect(cisco.presence({ feeds: { query() { throw new Error('boom'); } } })).toBe(0);
  });

  it('reads only through feeds (no lm_* SQL outside the search category)', () => {
    const fs = require('fs');
    const path = require('path');
    const src = fs.readFileSync(path.join(__dirname, '..', 'platforms', 'cisco', 'index.js'), 'utf8');
    const advisorSrc = fs.readFileSync(path.join(__dirname, '..', 'services', 'advisors', 'ciscoAdvisor.js'), 'utf8');
    const sqlLines = src.split('\n').filter((l) => /\blm_[a-z_]+/.test(l) && !/^\s*\/\//.test(l));
    for (const l of sqlLines) expect(l).toMatch(/lm_devices|d\.|vendor_key|stale|WHERE|ORDER BY/);
    expect(advisorSrc).not.toMatch(/\.prepare\(/);
    expect(advisorSrc.replace(/\/\/.*$/gm, '')).not.toMatch(/\blm_[a-z_]+/);
  });
});

describe('overview', () => {
  it('builds every figure from the feed rows', () => {
    const o = cisco._test.buildOverview(fakeCoreApi());
    expect(o.devices).toEqual({ total: 5, byKind: { switch: 1, nexus: 1, firewall: 1, mr: 1, mx: 1 }, byFamily: { cisco: 3, meraki: 2 }, failed: 1, degraded: 2, ok: 2 });
    expect(o.firewalls).toEqual({ total: 3, degraded: 2, haDegraded: 1 });
    expect(o.wireless).toEqual({ controllers: 1, aps: 40, apsDown: 2, clients: 300 });
    expect(o.ise).toEqual({ nodes: 2, degraded: 1 });
    expect(o.voice).toEqual({ devices: 2, degraded: 1 });
    expect(o.alerts).toEqual({ critical: 2, warning: 1 });
    expect(o.issues).toEqual({ critical: 2, warning: 2 });
    expect(o.sources).toHaveLength(1);
    expect(o.topIssues).toHaveLength(4);
    expect(o.topIssues[0].severity).toBe('critical');
    expect(o.devicesWorstFirst.map((d) => d.displayName)).toEqual(['asa-a', 'nx-a', 'mx-1', 'mr-1', 'sw-a']);
    expect(o.devicesWorstFirst.find((d) => d.displayName === 'mx-1').family).toBe('Meraki');
    // the family feeds are asked for both keys
    expect(calls.filter((c) => c.name === 'firewalls').map((c) => c.params.vendorKeys)).toEqual([['cisco', 'meraki']]);
  });

  it('serves GET /overview with the contract keys', async () => {
    const res = await request(appFor(fakeCoreApi())).get('/api/cisco/overview');
    expect(res.status).toBe(200);
    expect(Object.keys(res.body).sort()).toEqual(['alerts', 'devices', 'devicesWorstFirst', 'firewalls', 'generatedAt', 'ise', 'issues', 'sources', 'tiles', 'topIssues', 'voice', 'wireless']);
  });

  it('still answers when the family feeds are not registered yet (zero figures)', async () => {
    const res = await request(appFor(fakeCoreApi({ familyFeeds: false }))).get('/api/cisco/overview');
    expect(res.status).toBe(200);
    expect(res.body.firewalls).toEqual({ total: 0, degraded: 0, haDegraded: 0 });
    expect(res.body.wireless).toEqual({ controllers: 0, aps: 0, apsDown: 0, clients: null });
    expect(res.body.devices.total).toBe(5);
  });

  it('answers 503 connector_unavailable when the devices feed is missing', async () => {
    const coreApi = fakeCoreApi();
    coreApi.feeds.query = () => { throw Object.assign(new Error('no feed'), { code: 'FEED_UNKNOWN' }); };
    const res = await request(appFor(coreApi)).get('/api/cisco/overview');
    expect(res.status).toBe(503);
    expect(res.body.error).toBe('connector_unavailable');
  });
});

describe('device routes', () => {
  it('filters by kind, family and state across both vendor keys', async () => {
    const app = appFor(fakeCoreApi());
    const all = await request(app).get('/api/cisco/devices');
    expect(all.body).toHaveLength(5);
    expect(all.body.find((d) => d.displayName === 'mr-1').family).toBe('Meraki');
    expect((await request(app).get('/api/cisco/devices?kind=nexus')).body.map((d) => d.displayName)).toEqual(['nx-a']);
    expect((await request(app).get('/api/cisco/devices?kind=mx')).body.map((d) => d.displayName)).toEqual(['mx-1']);
    expect((await request(app).get('/api/cisco/devices?family=meraki')).body.map((d) => d.displayName).sort()).toEqual(['mr-1', 'mx-1']);
    expect((await request(app).get('/api/cisco/devices?family=cisco')).body).toHaveLength(3);
    expect((await request(app).get('/api/cisco/devices?state=failed')).body.map((d) => d.displayName)).toEqual(['asa-a']);
    expect((await request(app).get('/api/cisco/devices?kind=bogus')).status).toBe(400);
    expect((await request(app).get('/api/cisco/devices?family=f5')).status).toBe(400);
    // a family filter asks the feed for that key only
    calls.length = 0;
    await request(app).get('/api/cisco/devices?family=meraki');
    expect(calls.filter((c) => c.name === 'devices').map((c) => c.params.vendorKey)).toEqual(['meraki']);
  });

  it('exports devices as CSV with a Family column', async () => {
    const res = await request(appFor(fakeCoreApi())).get('/api/cisco/devices.csv');
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toMatch(/text\/csv/);
    expect(res.text.split('\r\n')[0]).toBe('displayName,family,vendorKind,state,reasons,siteName,model,version,openAlerts,sourceName');
    expect(res.text).toContain('mx-1,Meraki,mx,degraded');
  });

  it('returns one device 360 payload and 404s a non-Cisco or missing device', async () => {
    const app = appFor(fakeCoreApi());
    const ok = await request(app).get('/api/cisco/devices/3?sourceId=1');
    expect(ok.status).toBe(200);
    expect(Object.keys(ok.body).sort()).toEqual(['alerts', 'datasources', 'device', 'health', 'metrics', 'resources']);
    expect(ok.body.device.displayName).toBe('asa-a');
    expect(ok.body.alerts.map((a) => a.id)).toEqual(['a1']);
    const meraki = await request(app).get('/api/cisco/devices/5');
    expect(meraki.status).toBe(200);
    expect(meraki.body.device.family).toBe('Meraki');
    expect((await request(app).get('/api/cisco/devices/99')).status).toBe(404);
    const other = fakeCoreApi({ devices: [DEV({ id: 7, vendorKey: 'f5' })] });
    expect((await request(appFor(other)).get('/api/cisco/devices/7')).status).toBe(404);
  });
});

describe('family routes (firewalls, wireless, voice, ise)', () => {
  it('serves firewalls with both vendor keys, CSV and detail', async () => {
    const app = appFor(fakeCoreApi());
    const list = await request(app).get('/api/cisco/firewalls');
    expect(list.body.map((f) => f.deviceName)).toEqual(['asa-a', 'mx-1', 'asa-b']);
    expect(calls.find((c) => c.name === 'firewalls').params.vendorKeys).toEqual(['cisco', 'meraki']);
    expect((await request(app).get('/api/cisco/firewalls?state=critical')).body.map((f) => f.deviceName)).toEqual(['asa-a']);
    const csv = await request(app).get('/api/cisco/firewalls.csv');
    expect(csv.text.split('\r\n')[0]).toContain('deviceName,siteName,vendor');
    expect(csv.text).toContain('mx-1');
    const one = await request(app).get('/api/cisco/firewalls/3?sourceId=1');
    expect(one.body.summary.deviceName).toBe('asa-a');
    expect(calls.filter((c) => c.name === 'firewall').pop().params).toMatchObject({ vendorKeys: ['cisco', 'meraki'], deviceId: 3, sourceId: 1 });
    expect((await request(app).get('/api/cisco/firewalls/42')).status).toBe(404);
  });

  it('serves every wireless route, including the singular AP route', async () => {
    const app = appFor(fakeCoreApi());
    expect((await request(app).get('/api/cisco/wireless/overview')).body.totals.aps).toBe(40);
    expect((await request(app).get('/api/cisco/wireless/controllers')).body).toHaveLength(1);
    expect((await request(app).get('/api/cisco/wireless/controllers.csv')).text.split('\r\n')[0]).toContain('deviceName,siteName,platform');
    expect((await request(app).get('/api/cisco/wireless/controllers/7')).body.summary.deviceName).toBe('wlc-1');
    expect((await request(app).get('/api/cisco/wireless/controllers/8')).status).toBe(404);
    expect((await request(app).get('/api/cisco/wireless/aps')).body).toHaveLength(1);
    expect((await request(app).get('/api/cisco/wireless/aps.csv')).text.split('\r\n')[0]).toBe(['ap', 'controller', 'siteName', 'status'].join(',') + ',operText,adminText,radiosUp,radiosTotal,clients,util24,util5,maxChannelUtilPct,uplinkState,uplinkRxBps,uplinkTxBps,uplinkErrors,sampledAt');
    // LmAp360 sends ?ap=
    const ap = await request(app).get('/api/cisco/wireless/ap?controllerId=7&sourceId=1&ap=ap-1');
    expect(ap.status).toBe(200);
    expect(calls.filter((c) => c.name === 'wirelessAp').pop().params).toMatchObject({ controllerId: 7, sourceId: 1, apKey: 'ap-1', vendorKeys: ['cisco', 'meraki'] });
    expect((await request(app).get('/api/cisco/wireless/ap?controllerId=7&apKey=ap-1')).status).toBe(200);
    expect((await request(app).get('/api/cisco/wireless/ap?controllerId=7&ap=nope')).status).toBe(404);
    expect((await request(app).get('/api/cisco/wireless/ap?controllerId=7')).status).toBe(400);
    expect((await request(app).get('/api/cisco/wireless/rf')).body.thresholdPct).toBe(70);
    expect((await request(app).get('/api/cisco/wireless/rf.csv')).text.split('\r\n')[0]).toContain('radio,ap,band');
    expect((await request(app).get('/api/cisco/wireless/ssids')).body).toHaveProperty('summary');
  });

  it('serves voice and ISE lists, CSV and detail', async () => {
    const app = appFor(fakeCoreApi());
    expect((await request(app).get('/api/cisco/voice')).body).toHaveLength(2);
    expect((await request(app).get('/api/cisco/voice?kind=sbc')).body.map((v) => v.deviceName)).toEqual(['sbc-1']);
    expect((await request(app).get('/api/cisco/voice?kind=bogus')).status).toBe(400);
    expect((await request(app).get('/api/cisco/voice.csv')).text).toContain('cube-1');
    expect((await request(app).get('/api/cisco/voice/10')).body.summary.deviceName).toBe('cube-1');
    expect((await request(app).get('/api/cisco/voice/11')).status).toBe(404);
    expect((await request(app).get('/api/cisco/ise')).body).toHaveLength(2);
    expect((await request(app).get('/api/cisco/ise?state=critical')).body.map((n) => n.deviceName)).toEqual(['ise-2']);
    expect((await request(app).get('/api/cisco/ise.csv')).text).toContain('ise-2');
    expect((await request(app).get('/api/cisco/ise/8')).body.summary.deviceName).toBe('ise-1');
    expect((await request(app).get('/api/cisco/ise/18')).status).toBe(404);
  });

  it('answers 503 when a family feed is missing', async () => {
    const res = await request(appFor(fakeCoreApi({ familyFeeds: false }))).get('/api/cisco/firewalls');
    expect(res.status).toBe(503);
    expect(res.body.error).toBe('connector_unavailable');
  });
});

describe('alerts, issues and settings routes', () => {
  it('matches the LogicMonitor alerts list shape over both keys, hiding duplicates by default', async () => {
    const app = appFor(fakeCoreApi());
    const res = await request(app).get('/api/cisco/alerts');
    expect(res.status).toBe(200);
    expect(Object.keys(res.body).sort()).toEqual(['counts', 'duplicates', 'items', 'limit', 'page', 'total']);
    expect(res.body.total).toBe(4);
    expect(res.body.items.map((a) => a.id)).not.toContain('a4');
    expect(res.body.counts).toEqual({ critical: 2, warning: 1, info: 1, acked: 1, sdted: 1 });
    expect(res.body.duplicates).toEqual({ total: 1, byPlatform: [{ platform: 'vcenter', count: 1 }] });
    expect((await request(app).get('/api/cisco/alerts?duplicate=1')).body.items.map((a) => a.id)).toEqual(['a4']);
    expect((await request(app).get('/api/cisco/alerts?q=meraki')).body.total).toBe(1);
    expect((await request(app).get('/api/cisco/alerts?severity=bad')).status).toBe(400);
  });

  it('serves issues from both keys with the newest asOf', async () => {
    const res = await request(appFor(fakeCoreApi())).get('/api/cisco/issues');
    expect(res.body.asOf).toBe('2026-11-05T11:06:00Z');
    expect(res.body.issues).toHaveLength(4);
    expect(calls.filter((c) => c.name === 'issues').map((c) => c.params)).toEqual([{ vendorKey: 'cisco' }, { vendorKey: 'meraki' }]);
  });

  it('serves issue-history per key and degrades to 503 when the feed is missing', async () => {
    const extraFeeds = { issueHistory: (p) => [{ issueKey: `k-${p.vendorKey}`, type: 'device-dead' }] };
    const res = await request(appFor(fakeCoreApi({ extraFeeds }))).get('/api/cisco/issue-history?days=7');
    expect(res.status).toBe(200);
    expect(res.body.map((r) => r.issueKey)).toEqual(['k-cisco', 'k-meraki']);
    expect(calls.filter((c) => c.name === 'issueHistory').map((c) => c.params)).toEqual([{ vendorKey: 'cisco', days: 7 }, { vendorKey: 'meraki', days: 7 }]);
    expect((await request(appFor(fakeCoreApi())).get('/api/cisco/issue-history')).status).toBe(503);
    expect((await request(appFor(fakeCoreApi())).get('/api/cisco/issue-history?days=500')).status).toBe(400);
  });

  it('serves read-only settings with the kind counts', async () => {
    const res = await request(appFor(fakeCoreApi({ presence: { cisco: 20, meraki: 2 } }))).get('/api/cisco/settings');
    expect(res.body).toMatchObject({ matchedDevices: 22, derivedFrom: 'logicmonitor', logicmonitorSettingsPath: '/logicmonitor/settings?section=services' });
    expect(res.body.kinds).toEqual({ switch: 1, nexus: 1, firewall: 1, mr: 1, mx: 1 });
    expect(res.body.sources).toHaveLength(1);
  });
});

describe('opsSummary', () => {
  it('is null at presence 0 and does not read details', () => {
    expect(cisco.opsSummary(fakeCoreApi({ presence: {} }))).toBeNull();
  });

  it('summarises devices and issues from rows only', () => {
    const s = cisco.opsSummary(fakeCoreApi());
    expect(s.objects).toBe(5);
    expect(s.headline).toEqual([
      { label: 'Devices', value: '2/5' },
      { label: 'Failed', value: 1 },
      { label: 'Open Issues', value: 4 },
    ]);
    expect(s.exceptions.map((e) => `${e.severity}:${e.count}`)).toEqual(['critical:1', 'critical:2', 'warning:2']);
    expect(calls.some((c) => c.name === 'device' || c.name === 'firewalls')).toBe(false);
    expect(s.spark).toBeNull();
  });
});

describe('collectAlerts', () => {
  it('returns [] at presence 0', () => {
    expect(cisco.collectAlerts(fakeCoreApi({ presence: {} }))).toEqual([]);
  });

  it('emits issues and alerts from BOTH keys in the notifier shape, skipping shadowed, sdted, info and duplicate rows', () => {
    const items = cisco.collectAlerts(fakeCoreApi());
    expect(items.map((i) => i.sourceKey).sort()).toEqual(['ck-1', 'ck-2', 'device-dead|CGSandBox|asa-a', 'device-dead|CGSandBox|mx-1', 'fan-fault|CGSandBox|nx-a Fan 2']);
    const a = items.find((i) => i.sourceKey === 'ck-1');
    expect(a).toMatchObject({ severity: 'critical', host: 'asa-a', type: 'Cisco_ASA_Failover', typeLabel: 'Cisco_ASA_Failover', firstSeen: '2026-11-05T08:00:00.000Z' });
    expect(a.message).toBe('Cisco_ASA_Failover unit State = 3 (threshold > 2)');
    expect(items.find((i) => i.sourceKey === 'ck-2')).toMatchObject({ host: 'mx-1', severity: 'warning' });
    expect(items.find((i) => i.sourceKey.startsWith('fan-fault'))).toMatchObject({ host: 'nx-a Fan 2', type: 'fan-fault', severity: 'warning', message: 'fan failed' });
  });

  describe('sourceKey parity with the LogicMonitor collector', () => {
    beforeAll(() => {
      runMigrations(db, 'logicmonitor', lmMigrations);
      for (const t of ['lm_alerts', 'lm_issue_history', 'lm_devices', 'lm_sources']) db.prepare(`DELETE FROM ${t}`).run();
    });

    it('uses the same keys, hosts and types for the same device', () => {
      db.prepare("INSERT INTO lm_sources (id, name, company, encrypted_credentials) VALUES (1, 'CGSandBox', 'cg', 'x')").run();
      db.prepare(`INSERT INTO lm_alerts (source_id, lm_alert_id, type, severity, severity_norm, lm_device_id, monitor_object_name, resource_template_name,
        instance_name, data_point_name, alert_value, threshold, start_epoch, cleared, condition_key) VALUES (1, 'x1', 'alert', 4, 'critical', 3, 'asa-a', 'Cisco_ASA_Failover', 'unit', 'State', '3', '> 2', 1793000000, 0, 'ck-1')`).run();
      db.prepare("INSERT INTO lm_issue_history (issue_key, source, severity, type, target, message, status) VALUES ('device-dead|CGSandBox|asa-a', 'CGSandBox', 'critical', 'device-dead', 'asa-a', 'asa-a is dead', 'open')").run();

      const lmItems = lmManifest.collectAlerts({ db });
      const lmByKey = new Map(lmItems.map((i) => [i.sourceKey, i]));

      const alertRow = ALERT({ startedAt: new Date(1793000000 * 1000).toISOString() });
      const issue = { severity: 'critical', type: 'device-dead', source: 'CGSandBox', target: 'asa-a', message: 'asa-a is dead', issueKey: 'device-dead|CGSandBox|asa-a', firstSeen: null, lastSeen: null };
      const coreApi = fakeCoreApi({
        extraFeeds: {
          alerts: (p) => (p.vendorKey === 'cisco' ? [alertRow] : []),
          issues: (p) => ({ issues: p.vendorKey === 'cisco' ? [issue] : [], asOf: null }),
        },
      });
      const items = cisco.collectAlerts(coreApi);

      expect(new Set(items.map((i) => i.sourceKey))).toEqual(new Set(lmByKey.keys()));
      for (const it of items) {
        const lm = lmByKey.get(it.sourceKey);
        expect({ host: it.host, type: it.type, typeLabel: it.typeLabel, severity: it.severity }).toEqual({ host: lm.host, type: lm.type, typeLabel: lm.typeLabel, severity: lm.severity });
      }
      expect(items.find((i) => i.sourceKey === 'ck-1').message).toBe(lmByKey.get('ck-1').message);
    });
  });
});

describe('search category', () => {
  beforeAll(() => {
    runMigrations(db, 'logicmonitor', lmMigrations);
    const cols = db.prepare("PRAGMA table_info('lm_devices')").all().map((c) => c.name);
    for (const c of ['vendor_key', 'vendor_kind', 'vendor_reason']) if (!cols.includes(c)) db.exec(`ALTER TABLE lm_devices ADD COLUMN ${c} TEXT`);
    for (const t of ['lm_alerts', 'lm_issue_history', 'lm_devices', 'lm_sources']) db.prepare(`DELETE FROM ${t}`).run();
    db.prepare("INSERT INTO lm_sources (id, name, company, encrypted_credentials) VALUES (1, 'CGSandBox', 'cg', 'x')").run();
    const ins = db.prepare('INSERT INTO lm_devices (source_id, lm_device_id, name, display_name, model, version, stale, vendor_key, vendor_kind) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)');
    ins.run(1, 1, '10.0.0.1', 'sw-search-cisco', 'C9300', '17', 0, 'cisco', 'switch');
    ins.run(1, 2, '10.0.0.2', 'sw-search-stale', 'C9300', '17', 1, 'cisco', 'switch');
    ins.run(1, 3, '10.0.0.3', 'sw-search-meraki', 'MX250', '18', 0, 'meraki', 'mx');
    ins.run(1, 4, '10.0.0.4', 'sw-search-f5', 'BIG-IP', '17', 0, 'f5', 'bigip');
    ins.run(1, 5, '10.0.0.5', 'sw-search-null', 'x', '1', 0, null, null);
  });

  it('is shaped for routes/search.js and returns live Cisco and Meraki devices only', () => {
    const [cat] = cisco.searchCategories;
    expect(cat).toMatchObject({ key: 'cisco-devices', label: 'Cisco devices', platform: 'cisco', base: '/cisco/devices', params: 2 });
    expect(cat.perm).toBe('cisco:devices:view');
    const rows = db.prepare(cat.sql).all('%sw-search%', '%sw-search%', 8);
    expect(rows.map((r) => r.title)).toEqual(['sw-search-cisco', 'sw-search-meraki']);
    expect(rows[1].subtitle).toContain('mx');
    expect(cat.route({ title: 'sw a' })).toBe('/cisco/devices?q=sw%20a');
  });
});

describe('agent profile and incident evidence', () => {
  it('defaults.js carries the cisco entry within the focus limit and the history mapping', () => {
    expect(DEFAULTS.cisco.focus.length).toBeLessThanOrEqual(600);
    expect(DEFAULTS.cisco.focus).toMatch(/Catalyst/);
    expect(DEFAULTS.cisco.ports.source.map((x) => x.port)).toEqual([443]);
    expect(DEFAULTS.cisco.ports.host.map((x) => x.port)).toEqual([22, 443, 161]);
    expect(DEFAULTS.cisco.relations).toEqual(['identity_links']);
    expect(historyMetricFor.cisco['device-cpu-high']).toBe('cpu_pct');
    expect(cisco.agentProfile.focus).toBe(DEFAULTS.cisco.focus);
  });

  it('builds evidence lines for a Cisco or Meraki host and returns null for others', () => {
    const ev = cisco.incidentEvidence(fakeCoreApi(), { names: new Set(['NX-A.example.com']), ips: new Set() });
    expect(ev.title).toBe('Cisco');
    expect(ev.lines[0]).toContain('Cisco nx-a: nexus, state degraded');
    expect(ev.lines.join('\n')).toContain('Open warning fan-fault: fan failed');
    const mer = cisco.incidentEvidence(fakeCoreApi(), { names: new Set(['mx-1']), ips: new Set() });
    expect(mer.lines[0]).toContain('Meraki mx-1: mx');
    expect(cisco.incidentEvidence(fakeCoreApi(), { names: new Set(['somebox']), ips: new Set() })).toBeNull();
    expect(cisco.incidentEvidence(fakeCoreApi(), {})).toBeNull();
  });
});

describe('advisor', () => {
  it('lists the seven presets and gathers from feeds only', () => {
    expect(REPORT_KEYS).toEqual(['cisco_health', 'cisco_switching_hardware', 'cisco_wireless_review', 'cisco_ise_posture', 'cisco_firewall_review', 'cisco_voice_review', 'cisco_change_review']);
    const adv = createCiscoAdvisor({ feeds: fakeCoreApi().feeds, advisor: platformAdvisor });
    expect(adv.REPORTS).toEqual(REPORT_KEYS);

    const health = adv.gatherFor('cisco_health');
    expect(health.byFamily).toEqual({ cisco: 3, meraki: 2 });
    expect(health.byKind.mx).toBe(1);
    expect(health.worstDevices.map((d) => d.device)).toContain('mx-1');
    expect(health.openAlertCounts).toEqual({ critical: 3, warning: 1 });

    const hw = adv.gatherFor('cisco_switching_hardware');
    expect(hw.switchingDevices).toBe(2);
    expect(hw.hardwareIssues.map((i) => i.type)).toEqual(['fan-fault']);
    expect(hw.deviceHardwareMetrics[0]).toMatchObject({ device: 'nx-a' });
    expect(hw.deviceHardwareMetrics[0].metrics.map((m) => m.metric)).toEqual(['fan_state']);

    const wl = adv.gatherFor('cisco_wireless_review');
    expect(wl.totals.aps).toBe(40);
    expect(wl.downAps[0]).toMatchObject({ ap: 'ap-1' });

    const ise = adv.gatherFor('cisco_ise_posture');
    expect(ise.nodes.map((n) => n.node)).toEqual(['ise-1', 'ise-2']);

    const fw = adv.gatherFor('cisco_firewall_review');
    expect(fw.firewalls.map((f) => f.firewall)).toEqual(['asa-a', 'mx-1', 'asa-b']);

    const voice = adv.gatherFor('cisco_voice_review');
    expect(voice.devices).toHaveLength(2);
  });

  it('says plainly when a family feed is absent', () => {
    const adv = createCiscoAdvisor({ feeds: fakeCoreApi({ familyFeeds: false }).feeds, advisor: platformAdvisor });
    expect(adv.gatherFor('cisco_wireless_review').note).toMatch(/No Cisco or Meraki wireless data/);
    expect(adv.gatherFor('cisco_firewall_review').note).toMatch(/No Cisco ASA or Meraki MX firewalls/);
  });

  it('says plainly when the connector has no config change feed, and queries both keys when it does', () => {
    const none = createCiscoAdvisor({ feeds: fakeCoreApi().feeds, advisor: platformAdvisor }).gatherFor('cisco_change_review');
    expect(none.changes).toEqual([]);
    expect(none.note).toMatch(/does not expose a configuration change feed/);
    const feeds = fakeCoreApi({ extraFeeds: { configChanges: (p) => ({ changes: [{ device: `d-${p.vendorKey}`, change: 'x' }] }) } }).feeds;
    const some = createCiscoAdvisor({ feeds, advisor: platformAdvisor }).gatherFor('cisco_change_review');
    expect(some.changes.map((c) => c.device)).toEqual(['d-cisco', 'd-meraki']);
    expect(calls.filter((c) => c.name === 'configChanges').map((c) => c.params)).toEqual([{ vendorKey: 'cisco', days: 30 }, { vendorKey: 'meraki', days: 30 }]);
  });

  it('serves cached reports through the routes, creating the cache table on first use', async () => {
    db.prepare('DROP TABLE IF EXISTS cisco_ai_reports').run();
    const app = appFor(fakeCoreApi());
    const miss = await request(app).get('/api/cisco/advisor/cisco-health');
    expect(miss.status).toBe(200);
    expect(miss.body.report).toBeNull();
    expect(typeof miss.body.enabled).toBe('boolean');
    expect((await request(app).get('/api/cisco/advisor/nope')).status).toBe(404);
    db.prepare("INSERT INTO cisco_ai_reports (report_key, model, content, generated_at) VALUES ('cisco_health', 'm', 'hello', ?)").run(new Date().toISOString());
    const hit = await request(app).get('/api/cisco/advisor/cisco_health');
    expect(hit.body.report).toMatchObject({ reportKey: 'cisco_health', content: 'hello', stale: false });
    // no provider is configured in tests: generation answers 503, never reaches a model
    const gen = await request(app).post('/api/cisco/advisor/cisco-health');
    expect(gen.status).toBe(503);
  });
});
