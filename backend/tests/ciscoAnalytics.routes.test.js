/**
 * Cisco switching and routing analytics routes. A fake coreApi whose feeds.query serves fixtures drives the router:
 * shape and 200 on empty for every route, tile math, forecast basis text, shadowed routing peers.
 */
import { describe, it, expect } from 'vitest';
import { createRequire } from 'module';
import express from 'express';
import request from 'supertest';

const require = createRequire(import.meta.url);
const cisco = require('../platforms/cisco');
const analytics = require('../platforms/cisco/analytics');

const NOW = new Date('2026-11-09T12:00:00Z');
const unknown = (name) => Object.assign(new Error(`unknown feed ${name}`), { code: 'FEED_UNKNOWN' });
const DEVS = [{ id: 1, sourceId: 1, displayName: 'sw-a', name: '10.0.0.1', vendorKey: 'cisco', vendorKind: 'switch', siteName: 'Phoenix', siteKey: 'phx', state: 'ok', reasons: [] }];

const FEEDS = {
  hardware: () => ({
    components: [
      { device: 'sw-a', site: 'Phoenix', model: 'C9300', component: 'psu', instance: 'PSU 1', state: 'ok', value: 1 },
      { device: 'sw-a', site: 'Phoenix', model: 'C9300', component: 'psu', instance: 'PSU 2', state: 'failed', value: 5 },
      { device: 'sw-b', site: 'Phoenix', model: 'C9300', component: 'temp', instance: 'Inlet', state: 'degraded', value: 61, unit: 'C' },
    ],
    derived: {
      redundancyLost: [{ device: 'sw-a', reason: 'one of 2 power supplies ok' }],
      thermalOutliers: [{ device: 'sw-b', sensor: 'Inlet', tempC: 61, modelMedian: 38, suspectedSiteHvac: true }],
      switchovers30d: [{ device: 'sw-a', subject: 'stack_role', kind: 'state_change', value: 2, detail: { events: [{ day: '2026-11-01' }] } }],
    },
  }),
  optics: () => [
    { device: 'sw-a', ifName: 'Te1/0/1', sensorKind: 'rx_power', value: -9.5, lowWarn: -10.5, marginDb: 1, trend: { severity: 'warning', daysToThreshold: 12, r2: 0.82, n: 28, basis: { windowDays: 28 } } },
    { device: 'sw-a', ifName: 'Te1/0/2', sensorKind: 'rx_power', value: -3, lowWarn: -10.5, marginDb: 7.5, trend: null },
    { device: 'sw-a', ifName: 'Te1/0/3', sensorKind: 'rx_power', value: -4, lowWarn: -10.5, marginDb: 6.5, trend: { severity: 'info', daysToThreshold: null, basis: { reason: 'insufficient_points' } } },
  ],
  poe: () => ({ rows: [{ device: 'sw-a', member: 1, usedWatts: 440, budgetWatts: 500, usedPct: 88, headroomWatts: 60, trend: { daysToThreshold: 9, r2: 0.9, n: 20, basis: { windowDays: 20 } } }], sites: [{ site: 'Phoenix', headroomWatts: 60, devices: 1 }] }),
  routingPeers: () => [
    { device: 'rtr-a', protocol: 'bgp', peer: '10.1.1.1', state: 'established', establishedS: 90000, flaps7d: 3, flaps30d: 5, shadowed: false },
    { device: 'rtr-a', protocol: 'ospf', peer: '10.1.1.2', state: 'down', establishedS: 0, flaps7d: 0, flaps30d: 0, shadowed: false },
    { device: 'rtr-dead', protocol: 'bgp', peer: '10.2.2.2', state: 'idle', establishedS: 0, flaps7d: 4, flaps30d: 4, shadowed: true },
  ],
  trends: (p) => {
    const all = [
      { sourceId: 1, deviceId: 1, device: 'sw-a', kind: 'if_util_forecast', subject: 'Te1/0/1', metric: 'max_in_util_pct', value: 70, threshold: 80, daysToThreshold: 14, severity: 'warning', r2: 0.7, n: 30, basis: { windowDays: 30 } },
      { sourceId: 1, deviceId: 1, device: 'sw-a', kind: 'if_util_forecast', subject: 'Te1/0/2', metric: 'max_in_util_pct', value: 20, threshold: 80, daysToThreshold: null, severity: 'info', n: 3, basis: { reason: 'insufficient_points' } },
      { sourceId: 1, deviceId: 1, device: 'sw-a', kind: 'if_util_forecast', subject: 'Te1/0/3', metric: 'max_out_util_pct', value: 50, threshold: 80, daysToThreshold: 90, severity: 'info', r2: 0.6, n: 30, basis: { windowDays: 30 } },
      { sourceId: 1, deviceId: 1, device: 'sw-a', kind: 'reboot', subject: 'device', metric: 'uptime_s', value: 2, severity: 'info', detail: { events: [{ day: '2026-11-07' }, { day: '2026-11-05' }, { day: '2026-10-01' }] } },
    ];
    return all.filter((r) => !p.kind || r.kind === p.kind);
  },
  deviceResources: () => [{ deviceId: 1, sourceId: 1, device: 'sw-a', cpu: { now: 20, p95: 55, slope: 0.4, forecast: { daysToThreshold: 40, r2: 0.8, n: 30 } }, mem: { now: 60, p95: 70, slope: 0.2, creep: { severity: 'warning' } }, flash: [{ fs: 'flash:', usedPct: 92, daysTo95: 20 }] }],
  trendSeries: () => [{ day: '2026-11-01', value: 40, samples: 24 }],
  reachability: () => ({ ping: [{ device: 'sw-a', lossPct: 2, rttMs: 12 }, { device: 'sw-c', lossPct: 0, rttMs: 4 }], ntp: [{ device: 'sw-a', synced: false, stratum: 16, offsetMs: 0 }, { device: 'sw-c', synced: true, stratum: 2, offsetMs: 250 }], ipsla: [{ probe: 'p1' }] }),
  wirelessAnalytics: () => ({ apLoadImbalance: [{ controller: 'wlc-1', site: 'Phoenix', cv: 0.8, apCount: 10, zeroClientAps7d: ['ap-1'] }], channelUtilTrend: [], radiusFailureRatio: [] }),
  fleetVersions: () => ({ versions: [{ model: 'C9300', version: '17.9', devices: 5, dominant: true }], outliers: [] }),
  availability: () => ({ devices: [{ device: 'sw-a', availabilityPct: 99.9 }], sites: [] }),
  alertNoise: () => ({ byDataSource: [], byDevice: [], repeatOffenders: [] }),
  interfacesAnalytics: (p) => [{ device: 'sw-a', ifName: 'Te1/0/1', p95InUtil: 70, maxInUtil: 90, daysTo80In: p.tab === 'hot' ? 10 : null, tab: p.tab }],
  interfaces: () => ({ items: [{ instanceId: 5, deviceId: 1, deviceName: 'sw-a', displayName: 'Te1/0/1' }], total: 1 }),
  interfaceHistory: () => ({ points: [], daily: [] }),
  interfaceCompare: () => ({ series: [] }),
};

function fakeCoreApi({ only } = {}) {
  const have = (name) => name === 'devices' || (only ? only.includes(name) : name in FEEDS);
  return {
    feeds: {
      hasFeed: (c, name) => have(name),
      query(connector, name, params) {
        if (name === 'devices') return DEVS.filter((d) => !params.vendorKey || d.vendorKey === params.vendorKey);
        if (!have(name)) throw unknown(name);
        return FEEDS[name](params);
      },
    },
  };
}
function appFor(coreApi) {
  const app = express();
  app.use(express.json());
  app.use('/api/cisco', cisco.createRouter(coreApi));
  app.use((err, req, res, next) => res.status(500).json({ error: err.message })); // eslint-disable-line no-unused-vars
  return app;
}

describe('forecast basis text', () => {
  it('states the fit and R2 when days exist, and "insufficient data" when days is null', () => {
    expect(analytics.forecastOf(14, { r2: 0.82, n: 28, basis: { windowDays: 28 } })).toEqual({ days: 14, text: 'estimate: linear fit over 28 days, R2 0.82' });
    expect(analytics.forecastOf(null, { basis: { reason: 'weak_fit' } }).text).toBe('insufficient data (weak linear fit)');
    expect(analytics.forecastOf(null, {})).toEqual({ days: null, text: 'insufficient data' });
  });
});

describe('every analytics route answers 200 on an empty connector', () => {
  const ROUTES = ['/hardware', '/interfaces-analytics?tab=hot', '/interfaces-analytics?tab=flapping', '/interfaces-analytics?tab=errors', '/optics', '/poe', '/routing',
    '/resources', '/reachability', '/wireless-analytics', '/fleet', '/trends', '/trends?kind=reboot', '/interfaces', '/summary', '/sites',
    '/interfaces/compare?ids=1,2', '/devices/1/interfaces/5/history', '/trend-series?sourceId=1&deviceId=1&metric=cpu_pct'];
  it.each(ROUTES)('%s', async (route) => {
    const res = await request(appFor(fakeCoreApi({ only: [] }))).get(`/api/cisco${route}`);
    expect(res.status).toBe(200);
    expect(res.body).toBeTruthy();
    if (/hardware|optics|poe|routing|resources|reachability|wireless-analytics|fleet|trends/.test(route)) expect(res.body.available).toBe(false);
  });
});

describe('hardware', () => {
  it('sorts failed first, flags the site HVAC outlier and counts the tiles', async () => {
    const res = await request(appFor(fakeCoreApi())).get('/api/cisco/hardware');
    expect(res.status).toBe(200);
    expect(res.body.tiles).toEqual({ componentsFailed: 1, redundancyLost: 1, hotSensors: 1, switchovers30d: 1 });
    expect(res.body.components[0]).toMatchObject({ state: 'failed', instance: 'PSU 2', redundancyNote: 'one of 2 power supplies ok' });
    const hot = res.body.components.find((c) => c.instance === 'Inlet');
    expect(hot).toMatchObject({ outlier: true, siteHvacSuspected: true });
    expect(res.body.thermalOutliers[0].why).toBe('site HVAC suspected');
  });
});

describe('optics, poe and resources carry basis text', () => {
  it('marks thin margin or warning trend as at risk and prints the basis', async () => {
    const res = await request(appFor(fakeCoreApi())).get('/api/cisco/optics');
    expect(res.body.tiles).toEqual({ atRisk: 1, total: 3 });
    expect(res.body.rows[0]).toMatchObject({ ifName: 'Te1/0/1', atRisk: true });
    expect(res.body.rows[0].forecast).toEqual({ days: 12, text: 'estimate: linear fit over 28 days, R2 0.82' });
    const none = res.body.rows.find((r) => r.ifName === 'Te1/0/3');
    expect(none.forecast.text).toBe('insufficient data (too few daily points)');
  });
  it('poe rows sort by used percent with a forecast', async () => {
    const res = await request(appFor(fakeCoreApi())).get('/api/cisco/poe');
    expect(res.body.rows[0].forecast.days).toBe(9);
    expect(res.body.sites).toHaveLength(1);
  });
  it('resources flag creep and flash days, and a deviceId adds the trend series', async () => {
    const res = await request(appFor(fakeCoreApi())).get('/api/cisco/resources?deviceId=1&sourceId=1');
    expect(res.body.rows[0].mem.creepFlag).toBe(true);
    expect(res.body.rows[0].cpu.forecast.text).toContain('R2 0.8');
    expect(res.body.rows[0].flashMinDays).toBe(20);
    expect(res.body.tiles).toEqual({ creeping: 1, flashRisk: 1 });
    expect(res.body.series.cpu).toHaveLength(1);
  });
});

describe('routing peers', () => {
  it('shadows peers on a dead device so they are not counted', async () => {
    const res = await request(appFor(fakeCoreApi())).get('/api/cisco/routing');
    expect(res.body.tiles).toEqual({ peers: 3, notEstablished: 1, flapping: 1, shadowed: 1 });
    expect(res.body.note).toMatch(/Prefix counts not collected/);
    expect(res.body.rows.find((r) => r.shadowed).notEstablished).toBe(false);
  });
});

describe('reachability and fleet', () => {
  it('adds the site from the device list, groups RTT by site and flags NTP outliers', async () => {
    const res = await request(appFor(fakeCoreApi())).get('/api/cisco/reachability');
    expect(res.body.ping[0]).toMatchObject({ device: 'sw-a', site: 'Phoenix' });
    expect(res.body.siteRtt.find((s) => s.site === 'Phoenix')).toMatchObject({ devices: 1, p50Ms: 12 });
    expect(res.body.ntpTiles).toMatchObject({ unsynced: 1, outliers: 1 });
    expect(res.body.ntp[0].synced).toBe(false);
  });
  it('fleet merges versions, availability, noise and reboot events', async () => {
    const res = await request(appFor(fakeCoreApi())).get('/api/cisco/fleet');
    expect(res.body.versions).toHaveLength(1);
    expect(res.body.availability.devices).toHaveLength(1);
    expect(res.body.reboots[0]).toMatchObject({ device: 'sw-a', count: 2 });
  });
});

describe('overview tiles', () => {
  it('computes the five tiles from the feeds', () => {
    const call = analytics.makeCaller(fakeCoreApi().feeds);
    expect(analytics.buildTiles(call, NOW)).toEqual({ redundancyLost: 1, opticsAtRisk: 1, ifForecast30d: 1, peersFlapping: 1, reboots7d: 2 });
  });
  it('a missing feed gives null for its figure, never zero', () => {
    const call = analytics.makeCaller(fakeCoreApi({ only: ['hardware'] }).feeds);
    expect(analytics.buildTiles(call, NOW)).toEqual({ redundancyLost: 1, opticsAtRisk: null, ifForecast30d: null, peersFlapping: null, reboots7d: null });
  });
});

describe('interfaces analytics and the reused interface routes', () => {
  it('hot rows carry both direction forecasts with basis text', async () => {
    const res = await request(appFor(fakeCoreApi())).get('/api/cisco/interfaces-analytics?tab=hot');
    expect(res.body.rows[0].forecastIn.days).toBe(10);
    expect(res.body.rows[0].forecastOut.text).toBe('insufficient data');
  });
  it('rejects an unknown tab and a compare of one interface', async () => {
    const app = appFor(fakeCoreApi());
    expect((await request(app).get('/api/cisco/interfaces-analytics?tab=bogus')).status).toBe(400);
    expect((await request(app).get('/api/cisco/interfaces/compare?ids=1')).status).toBe(400);
  });
  it('the interface list answers { items, total, page, limit }', async () => {
    const res = await request(appFor(fakeCoreApi())).get('/api/cisco/interfaces?page=1&limit=25');
    expect(res.body).toMatchObject({ total: 1, page: 1, limit: 25 });
    expect(res.body.items[0].displayName).toBe('Te1/0/1');
  });
});
