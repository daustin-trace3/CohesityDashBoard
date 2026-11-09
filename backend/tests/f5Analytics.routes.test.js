/**
 * F5 analytics routes and builders with stubbed feeds (no db): shape on every route, 200 on empty and on a
 * missing feed, certificate dedupe, forecast basis wording, pool SPOF and imbalance, overview tiles.
 */
import { describe, it, expect } from 'vitest';
import { createRequire } from 'module';
import express from 'express';
import request from 'supertest';

const require = createRequire(import.meta.url);
const f5 = require('../platforms/f5');
const analytics = require('../platforms/f5/analytics');

const NOW = Date.parse('2026-11-09T12:00:00Z');
const unknown = () => { throw Object.assign(new Error('unknown feed'), { code: 'FEED_UNKNOWN' }); };

function fakeCoreApi(feedMap = {}) {
  const calls = [];
  const feeds = {
    hasFeed: (c, n) => c === 'logicmonitor' && n in feedMap,
    query(connector, name, params) {
      calls.push({ name, params });
      if (name === 'presence') return 2;
      if (name === 'devices') return [{ id: 1, sourceId: 1, displayName: 'gtm-a', vendorKind: 'gtm', vendorKey: 'f5', state: 'ok' }];
      if (['alerts', 'issues', 'sources', 'loadBalancers'].includes(name) && !(name in feedMap)) return name === 'issues' ? { issues: [] } : [];
      if (!(name in feedMap)) return unknown();
      return typeof feedMap[name] === 'function' ? feedMap[name](params) : feedMap[name];
    },
  };
  return { feeds, calls, db: null, advisor: null };
}
const appFor = (coreApi) => {
  const app = express();
  app.use('/api/f5', f5.createRouter(coreApi));
  app.use((err, req, res, next) => res.status(500).json({ error: err.message })); // eslint-disable-line no-unused-vars
  return app;
};

const CERTS = [
  { device: 'lb-01', vip: 'vip-a', daysLeft: 12.2, instanceName: '/Common/shop.example.com.crt' },
  { device: 'lb-02', vip: 'vip-a', daysLeft: 12.9, instanceName: '/Common/shop.example.com.crt' }, // same cert on the HA peer
  { device: 'lb-01', vip: 'vip-b', daysLeft: -3, instanceName: 'old.example.com' },
  { device: 'lb-01', vip: 'vip-c', daysLeft: 70, instanceName: 'api.example.com' },
  { device: 'lb-01', vip: 'vip-d', daysLeft: 400, instanceName: 'wild.example.com' },
  { device: 'lb-01', vip: 'vip-e', daysLeft: 30.5, instanceName: 'shop.example.com' }, // same stem, far apart in days: not a duplicate
];

describe('certificates', () => {
  it('dedupes by instance stem plus days left within 1 and buckets the unique certificates', () => {
    const c = analytics.buildCertificates((n) => (n === 'certificates' ? CERTS : unknown()), { now: NOW });
    expect(c.rawTotal).toBe(6);
    expect(c.uniqueTotal).toBe(5);
    expect(c.duplicatesCollapsed).toBe(1);
    const shop = c.certs.find((x) => x.stem === 'shop.example.com' && x.daysLeft < 13);
    expect(shop.copies).toBe(2);
    expect(shop.devices.sort()).toEqual(['lb-01', 'lb-02']);
    expect(c.buckets).toEqual({ expired: 1, lt7: 0, lt30: 1, lt60: 1, lt90: 1, gt90: 1 });
    expect(c.expiring30).toBe(2);
    expect(c.expiring90).toBe(4);
    expect(c.weeks.length).toBeGreaterThan(0);
    expect(c.perDevice.find((d) => d.device === 'lb-01')).toMatchObject({ certs: 5, expired: 1 });
  });

  it('is unavailable, not an error, without the feed', () => {
    const c = analytics.buildCertificates(() => unknown(), { now: NOW });
    expect(c.available).toBe(false);
    expect(c.certs).toEqual([]);
  });
});

describe('forecastOf', () => {
  it('shows the basis and says insufficient data when days is null', () => {
    expect(analytics.forecastOf({ daysToThreshold: 25, r2: 0.824, n: 28, basis: { windowDays: 28 } }).basis).toBe('linear fit over 28 days, R2 0.82');
    const none = analytics.forecastOf({ daysToThreshold: null, basis: { reason: 'insufficient_points' } });
    expect(none.days).toBeNull();
    expect(none.insufficient).toBe(true);
    expect(none.basis).toBe('insufficient points');
    expect(analytics.forecastOf(null).insufficient).toBe(true);
  });
});

describe('pools', () => {
  const ROWS = [
    { device: 'lb-01', pool: 'one', member: 'm1', connections: 50, bitsIn: 1000, bitsOut: 500 },
    { device: 'lb-01', pool: 'two', member: 'a', connections: 100, bitsIn: 10, bitsOut: 10 },
    { device: 'lb-01', pool: 'two', member: 'b', connections: 0, bitsIn: 0, bitsOut: 0 },
    { device: 'lb-01', pool: 'two', member: 'c', connections: 0, bitsIn: 0, bitsOut: 0 },
    { device: 'lb-01', pool: 'three', member: 'x', connections: 10 },
    { device: 'lb-01', pool: 'three', member: 'y', connections: 12 },
    { device: 'lb-01', pool: 'four', member: 'p', connections: 200 },
    { device: 'lb-01', pool: 'four', member: 'q', connections: 5 },
    { device: 'lb-01', pool: 'four', member: 'r', connections: 6 },
  ];
  it('finds single points of failure, idle members and imbalance, and ranks top talkers', () => {
    const r = analytics.buildPools((n) => (n === 'poolMembers' ? ROWS : unknown()));
    const by = Object.fromEntries(r.pools.map((p) => [p.pool, p]));
    expect(by.one.spof).toBe(true);
    expect(by.one.spofReason).toMatch(/Single member/);
    expect(by.two.spof).toBe(true);
    expect(by.two.zeroMembers).toEqual(['b', 'c']);
    expect(by.three.spof).toBe(false);
    expect(by.three.imbalanced).toBe(false);
    expect(by.four.imbalanced).toBe(true);
    expect(r.summary).toMatchObject({ pools: 4, spof: 2, imbalanced: 1, withIdleMembers: 1 });
    expect(r.topMembers[0].member).toBe('m1');
    expect(r.rules).toMatch(/assumption/);
  });
});

describe('routes', () => {
  const ALL = {
    haState: [
      { sourceId: 1, deviceId: 1, device: 'lb-01', site: 'phx', failoverText: 'active', syncState: 'In Sync', cpuP95_7d: 20, cpuBaseline: 10, clientConnections: 100, lastFailoverDay: '2026-10-01', failovers90d: 1 },
      { sourceId: 1, deviceId: 2, device: 'lb-02', site: 'phx', failoverText: 'active', syncState: 'In Sync', cpuP95_7d: 20, cpuBaseline: 10, clientConnections: 100, lastFailoverDay: '2026-10-01', failovers90d: 1 },
    ],
    certificates: CERTS,
    trends: (p) => (!p.kind || p.kind === 'cpu_forecast' ? [{ sourceId: 1, deviceId: 1, device: 'lb-01', kind: 'cpu_forecast', daysToThreshold: 20, r2: 0.9, n: 30, basis: { windowDays: 30 } }] : []),
    deviceResources: [{ sourceId: 1, deviceId: 1, device: 'lb-01', cpu: { now: 40, p95: 60, slope: 1 }, mem: { now: 50, p95: 60 }, flash: [{ fs: '/var/log', usedPct: 80, daysTo90: 12 }] }],
    poolMembers: [{ device: 'lb-01', pool: 'p', member: 'm', connections: 5 }],
    daemonFlaps: [{ device: 'lb-01', daemon: 'mcpd', nonZeroDays: 2, events: [{ day: '2026-11-01' }] }],
    gtm: { requestsPerDay: [{ day: '2026-11-01', value: 100 }], resolutionsPerDay: [{ day: '2026-11-01', value: 90 }], wideIpAvailability: [{ wideIp: 'w1', day: '2026-11-01', min: 1, max: 3 }], perWideIp: [{ wideIp: 'w1', requests: 5 }] },
    hardware: { components: [{ device: 'lb-01', component: 'psu', instance: '1', state: 'ok' }], derived: { redundancyLost: [], thermalOutliers: [] } },
    interfacesAnalytics: [{ device: 'lb-01', ifName: '1.1', errorsSum: 4, discardsSum: 1, deviates: true }],
    fleetVersions: [{ vendorKind: 'bigip', model: 'i5800', version: '17.1', devices: 2, dominant: true }],
    availability: { devices: [{ device: 'lb-01', availabilityPct: 99.9 }] },
    alertNoise: { repeatOffenders: [] },
    trendSeries: [{ day: '2026-11-01', value: 12, samples: 24 }],
  };
  const get = (coreApi, url) => request(appFor(coreApi)).get(`/api/f5${url}`);

  it('answers every analytics route with data', async () => {
    const api = fakeCoreApi(ALL);
    const ha = (await get(api, '/ha')).body;
    expect(ha.summary).toMatchObject({ pairs: 1, bothActive: 1, atRisk: 1 });
    const tr = (await get(api, '/trends?days=30')).body;
    expect(tr.devices).toHaveLength(1);
    expect(tr.devices[0].cpu.forecast).toMatchObject({ days: 20, basis: 'linear fit over 30 days, R2 0.9' });
    expect(tr.devices[0].filesystems[0].forecast.days).toBe(12);
    expect(tr.heatmap).toBeNull();
    const series = (await get(api, '/trends/series?deviceId=1&metric=cpu_pct&days=30')).body;
    expect(series).toMatchObject({ available: true, metric: 'cpu_pct', days: 30 });
    expect(series.points).toHaveLength(1);
    expect((await get(api, '/pools')).body.summary.pools).toBe(1);
    expect((await get(api, '/certificates')).body.uniqueTotal).toBe(5);
    const gtm = (await get(api, '/gtm')).body;
    expect(gtm).toMatchObject({ present: true, available: true });
    expect(gtm.ratio[0].value).toBeCloseTo(0.9);
    const st = (await get(api, '/stability')).body;
    expect(st.daemons[0].nonZeroDays).toBe(2);
    expect(st.interfaces.errors).toHaveLength(1);
    const fleet = (await get(api, '/fleet')).body;
    expect(fleet.versions).toHaveLength(1);
    expect(api.calls.find((c) => c.name === 'haState').params).toEqual({ vendorKey: 'f5' });
  });

  it('answers 200 with empty states when no analytics feed exists yet', async () => {
    const api = fakeCoreApi({});
    for (const url of ['/ha', '/trends', '/pools', '/certificates', '/gtm', '/stability', '/fleet', '/trends/series?deviceId=1&metric=cpu_pct']) {
      const res = await get(api, url);
      expect(res.status, url).toBe(200);
    }
    expect((await get(api, '/ha')).body).toMatchObject({ available: false, pairs: [] });
    expect((await get(api, '/trends/series?deviceId=1&metric=cpu_pct')).body.available).toBe(false);
  });

  it('validates parameters', async () => {
    const api = fakeCoreApi(ALL);
    expect((await get(api, '/trends?days=3')).status).toBe(400);
    expect((await get(api, '/trends/series?deviceId=1&metric=bogus')).status).toBe(400);
    expect((await get(api, '/trends/series?metric=cpu_pct')).status).toBe(400);
  });
});

describe('overview', () => {
  it('builds tiles from the feeds and replaces the per-device certificate loop with one query', () => {
    const api = fakeCoreApi({
      haState: [{ sourceId: 1, deviceId: 1, device: 'a-01', site: 's', failoverText: 'active' }, { sourceId: 1, deviceId: 2, device: 'a-02', site: 's', failoverText: 'active' }],
      certificates: CERTS,
      trends: [{ kind: 'cpu_forecast', daysToThreshold: 10 }, { kind: 'cpu_forecast', daysToThreshold: 60 }, { kind: 'cpu_forecast', daysToThreshold: null }],
      poolMembers: [{ device: 'd', pool: 'p', member: 'm', connections: 1 }],
      daemonFlaps: [{ device: 'd', daemon: 'mcpd', nonZeroDays: 1 }, { device: 'd', daemon: 'tmm', nonZeroDays: 0 }],
    });
    const o = f5._test.buildOverview(api);
    expect(o.tiles).toEqual({ haPairsAtRisk: 1, certs30dDeduped: 2, cpuForecast30d: 1, poolsSpof: 1, daemonFlaps7d: 1 });
    expect(o.certs).toMatchObject({ expiring30: 2, expiring90: 4, expired: 1, uniqueTotal: 5, rawTotal: 6 });
    expect(api.calls.filter((c) => c.name === 'loadBalancer')).toEqual([]);
    expect(api.calls.filter((c) => c.name === 'certificates')).toHaveLength(1);
  });
});
