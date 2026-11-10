/**
 * System Health: poll run records, request statistics, the database snapshot,
 * the heartbeat payload, and /api/system/health (GET, export.json, db-refresh).
 * CJS modules are loaded through createRequire so the route, framework and test
 * share one module instance.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createRequire } from 'module';
import request from 'supertest';

const require = createRequire(import.meta.url);
const express = require('express');
const Database = require('better-sqlite3');
const db = require('../db/database');
const { createPoller, createGlobalTask, stats: pollerStats } = require('../core/pollerFramework');
const requestStats = require('../services/requestStats');
const systemHealth = require('../services/systemHealth');
const hb = require('../services/workerHeartbeat');
const { setSetting, getSetting } = require('../services/settings');
const router = require('../routes/systemHealth');

function fakeCron() {
  const scheduled = [];
  return { scheduled, schedule(expression, cb) { const task = { expression, cb, stop() {} }; scheduled.push(task); return task; } };
}
const tick = () => new Promise((r) => setImmediate(r));

const runs = (platform) => db.prepare('SELECT * FROM icc_poll_runs WHERE platform = ? ORDER BY id').all(platform);

beforeEach(() => { db.prepare('DELETE FROM icc_poll_runs').run(); });

describe('poll run records', () => {
  it('createPoller writes one row per run with duration and status, success and throw', async () => {
    const cronLib = fakeCron();
    const rows = [{ id: 1, name: 'good', polling_interval_minutes: 10 }, { id: 2, name: 'bad', polling_interval_minutes: 10 }];
    const poller = createPoller({
      id: 'healthtest', loadSources: () => rows, cronLib,
      poll: async (s) => { await new Promise((r) => setTimeout(r, 15)); if (s.id === 2) throw new Error('boom '.repeat(100)); },
    });
    rows.forEach((r) => poller.schedule(r));
    cronLib.scheduled[0].cb();
    cronLib.scheduled[1].cb();
    await new Promise((r) => setTimeout(r, 80));

    const got = runs('healthtest');
    expect(got).toHaveLength(2);
    const good = got.find((r) => r.source_id === 1);
    const bad = got.find((r) => r.source_id === 2);
    expect(good).toMatchObject({ kind: 'poll', status: 'success', source_name: 'good', error: null });
    expect(good.duration_ms).toBeGreaterThanOrEqual(10);
    expect(Date.parse(good.ended_at)).toBeGreaterThanOrEqual(Date.parse(good.started_at));
    expect(bad.status).toBe('error');
    expect(bad.error.length).toBe(300);
    expect(good.rss_before_mb).toBeGreaterThan(0);
  });

  it('createGlobalTask writes kind task', async () => {
    const cronLib = fakeCron();
    const task = createGlobalTask({ id: 'healthglobal', intervalMinutes: 15, run: async () => {}, cronLib });
    await task.trigger();
    const got = runs('healthglobal');
    expect(got).toHaveLength(1);
    expect(got[0]).toMatchObject({ kind: 'task', status: 'success', source_id: 0 });
  });

  it('a failing insert never throws into the poll', () => {
    expect(() => systemHealth.recordPollRun({ platform: null, startedAt: null, endedAt: null, durationMs: NaN })).not.toThrow();
  });

  it('stats() counts runs in flight and sources waiting in a serialized queue', async () => {
    const cronLib = fakeCron();
    let release;
    const gate = new Promise((r) => { release = r; });
    const poller = createPoller({ id: 'healthq', loadSources: () => [{ id: 1, name: 'q1' }, { id: 2, name: 'q2' }], cronLib, serialize: true, poll: async () => { await gate; } });
    const a = poller.trigger(1);
    const b = poller.trigger(2);
    await tick();
    const during = pollerStats();
    expect(during.active).toBeGreaterThanOrEqual(1);
    expect(during.queued).toBeGreaterThanOrEqual(1);
    release();
    await Promise.all([a, b]);
    expect(pollerStats().active).toBe(0);
  });

  it('prunes rows older than 7 days and keeps newer ones', () => {
    const old = new Date(Date.now() - 8 * 86400000).toISOString();
    const fresh = new Date().toISOString();
    const ins = db.prepare("INSERT INTO icc_poll_runs (platform, source_id, kind, started_at, ended_at, duration_ms, status) VALUES ('pruneplat', 1, 'poll', ?, ?, 5, 'success')");
    ins.run(old, old); ins.run(fresh, fresh);
    systemHealth.pruneRuns(db);
    expect(runs('pruneplat')).toHaveLength(1);
  });
});

describe('request statistics', () => {
  beforeEach(() => requestStats.reset());

  it('route template: route path wins, ids, UUIDs and long segments fold, tenant prefix collapses', () => {
    const key = requestStats.routeKey;
    expect(key({ method: 'GET', baseUrl: '/api/vcenter', route: { path: '/hosts/:id' }, originalUrl: '/api/vcenter/hosts/7' })).toBe('GET /api/vcenter/hosts/:id');
    expect(key({ method: 'GET', baseUrl: '/api/t/acme/vcenter', route: { path: '/hosts/:id' }, originalUrl: '/api/t/acme/vcenter/hosts/7' })).toBe('GET /api/t/:tenant/vcenter/hosts/:id');
    expect(key({ method: 'GET', originalUrl: '/api/things/42/detail?x=1' })).toBe('GET /api/things/:id/detail');
    expect(key({ method: 'POST', originalUrl: '/api/x/123e4567-e89b-12d3-a456-426614174000' })).toBe('POST /api/x/:id');
    expect(key({ method: 'GET', originalUrl: `/api/x/${'a'.repeat(25)}` })).toBe('GET /api/x/:id');
    expect(key({ method: 'GET', originalUrl: '/api/t/default/nothing/here' })).toBe('GET /api/t/:tenant/nothing/here');
  });

  it('p50 and p95 on a known series, error counts, and the route cap folds into other', () => {
    for (let i = 1; i <= 100; i += 1) requestStats.record('GET /api/a', i, i === 100 ? 500 : i === 99 ? 404 : 200);
    const snap = requestStats.snapshot();
    const a = snap.routes.find((r) => r.route === 'GET /api/a');
    expect(a).toMatchObject({ count: 100, p50: 50, p95: 95, maxMs: 100, errors4xx: 1, errors5xx: 1 });
    expect(snap.total).toBe(100);

    requestStats.reset();
    for (let i = 0; i < requestStats.MAX_ROUTES + 5; i += 1) requestStats.record(`GET /api/r${i}`, 1, 200);
    const capped = requestStats.snapshot();
    expect(capped.routes.length).toBe(requestStats.MAX_ROUTES + 1);
    expect(capped.routes.find((r) => r.route === 'other').count).toBe(5);
  });

  it('keeps only the last 200 durations for the percentiles', () => {
    for (let i = 0; i < 200; i += 1) requestStats.record('GET /api/b', 1000, 200);
    for (let i = 0; i < 200; i += 1) requestStats.record('GET /api/b', 1, 200);
    const b = requestStats.snapshot().routes.find((r) => r.route === 'GET /api/b');
    expect(b.count).toBe(400);
    expect(b.p95).toBe(1);
    expect(b.maxMs).toBe(1000);
  });
});

describe('database snapshot', () => {
  it('returns rows and bytes per table with an index mapped to its table', () => {
    const scratch = new Database(':memory:');
    scratch.exec(`
      CREATE TABLE alpha (id INTEGER PRIMARY KEY, body TEXT);
      CREATE INDEX idx_alpha_body ON alpha(body);
      CREATE TABLE beta (id INTEGER PRIMARY KEY);
    `);
    const ins = scratch.prepare('INSERT INTO alpha (body) VALUES (?)');
    for (let i = 0; i < 300; i += 1) ins.run(`row-${i}-${'x'.repeat(60)}`);
    scratch.prepare('INSERT INTO beta DEFAULT VALUES').run();

    const snap = systemHealth.dbSnapshot(scratch, ':memory:');
    const alpha = snap.tables.find((t) => t.name === 'alpha');
    const beta = snap.tables.find((t) => t.name === 'beta');
    expect(alpha.rows).toBe(300);
    expect(alpha.bytes).toBeGreaterThan(0);
    expect(alpha.indexBytes).toBeGreaterThan(0);
    expect(beta.rows).toBe(1);
    expect(snap.tables.find((t) => t.name === 'idx_alpha_body')).toBeUndefined();
    expect(snap.tables[0].name).toBe('alpha');
    expect(snap.totals.tables).toBe(snap.tables.length);
    expect(snap.totals.rows).toBeGreaterThanOrEqual(301);
    expect(snap.pageSize).toBeGreaterThan(0);
    expect(snap.pageCount).toBeGreaterThan(0);
    expect(typeof snap.computeMs).toBe('number');
    scratch.close();
  });
});

describe('heartbeat payload', () => {
  afterEach(() => { hb.stopHeartbeat(); setSetting(hb.KEY, ''); });

  it('carries mem, loopLagP99Ms, nodeVersion, polling, log and db', () => {
    setSetting(hb.KEY, '');
    hb._beatForTest('poller');
    const h = hb.readHeartbeat();
    expect(h.alive).toBe(true);
    expect(h.mem).toMatchObject({ rssMb: expect.any(Number), heapUsedMb: expect.any(Number), heapTotalMb: expect.any(Number), externalMb: expect.any(Number) });
    expect(typeof h.loopLagP99Ms).toBe('number');
    expect(h.nodeVersion).toBe(process.version);
    expect(h.polling).toMatchObject({ active: expect.any(Number), queued: expect.any(Number) });
    expect(h.log).toMatchObject({ error: expect.any(Number), warn: expect.any(Number) });
    expect(Array.isArray(h.log.recent)).toBe(true);
    expect(h.db).toMatchObject({ slowTransactions: expect.any(Number), busyRetries: expect.any(Number) });
  });

  it('logger.stats keeps the last 10 error and warn lines in the heartbeat, capped at 200 characters', () => {
    const logger = require('../utils/logger');
    for (let i = 0; i < 12; i += 1) logger.warn(`health-test line ${i} ${'z'.repeat(400)}`);
    const log = systemHealth.logSummary();
    expect(log.recent.length).toBe(10);
    expect(log.recent[9].msg.length).toBeLessThanOrEqual(200);
    expect(log.recent[9].msg).toContain('health-test line 11');
    expect(log.warn).toBeGreaterThanOrEqual(12);
  });
});

describe('/api/system/health', () => {
  let grants;
  let app;
  beforeEach(() => {
    grants = ['*:*:*'];
    app = express();
    app.use((req, res, next) => { req.auth = { grants }; next(); });
    app.use('/api/system/health', router);
    db.prepare("DELETE FROM app_settings WHERE key IN ('icc_health_db_snapshot', 'icc_health_db_refresh_requested')").run();
  });

  it('answers 200 with every top-level key and findings as an array', async () => {
    const res = await request(app).get('/api/system/health');
    expect(res.status).toBe(200);
    for (const k of ['generatedAt', 'app', 'processes', 'database', 'polling', 'requests', 'migrations', 'platforms', 'users', 'license', 'findings']) {
      expect(res.body).toHaveProperty(k);
    }
    expect(Array.isArray(res.body.findings)).toBe(true);
    expect(res.body.app).toMatchObject({ nodeVersion: process.version, platform: process.platform });
    expect(res.body.app.sqliteVersion).toMatch(/^\d/);
    expect(res.body.processes.web.pid).toBe(process.pid);
    expect(res.body.polling).toHaveProperty('summary');
    expect(Array.isArray(res.body.polling.sources)).toBe(true);
    expect(res.body.migrations.some((m) => m.scope === 'core' && m.version >= 37)).toBe(true);
    // No poller heartbeat in this run: it is reported, not hidden.
    setSetting(hb.KEY, '');
    const quiet = await request(app).get('/api/system/health');
    expect(quiet.body.processes.poller).toBeNull();
    expect(quiet.body.findings.some((f) => f.id === 'poller-silent' && f.severity === 'crit')).toBe(true);
  });

  it('a small database has its snapshot computed on first read, and findings follow a slow route', async () => {
    const first = await request(app).get('/api/system/health');
    expect(first.body.database.snapshot).not.toBeNull();
    expect(first.body.database.snapshot.tables.length).toBeGreaterThan(10);
    expect(getSetting('icc_health_db_snapshot')).toBeTruthy();

    requestStats.reset();
    for (let i = 0; i < 5; i += 1) requestStats.record('GET /api/slow/thing', 2500, 200);
    const res = await request(app).get('/api/system/health');
    expect(res.body.requests.routes[0].route).toBe('GET /api/slow/thing');
    expect(res.body.findings.some((f) => f.id === 'slow-routes' && f.text.includes('/api/slow/thing'))).toBe(true);
    requestStats.reset();
  });

  it('answers 403 without the grant', async () => {
    grants = [];
    expect((await request(app).get('/api/system/health')).status).toBe(403);
    expect((await request(app).get('/api/system/health/export.json')).status).toBe(403);
    grants = ['admin:settings:view'];
    expect((await request(app).post('/api/system/health/db-refresh')).status).toBe(403);
  });

  it('export.json is an attachment with the poll runs and uncapped routes', async () => {
    db.prepare("INSERT INTO icc_poll_runs (platform, source_id, kind, started_at, ended_at, duration_ms, status) VALUES ('exp', 1, 'poll', ?, ?, 9, 'success')").run(new Date().toISOString(), new Date().toISOString());
    const res = await request(app).get('/api/system/health/export.json');
    expect(res.status).toBe(200);
    expect(res.headers['content-disposition']).toMatch(/^attachment; filename="icc-health-.+-\d{8}-\d{4}\.json"$/);
    expect(res.headers['cache-control']).toBe('no-store');
    const body = JSON.parse(res.text);
    expect(Array.isArray(body.pollRuns)).toBe(true);
    expect(body.pollRuns.some((r) => r.platform === 'exp')).toBe(true);
    expect(body).toHaveProperty('findings');
  });

  it('db-refresh on a small file computes the snapshot now', async () => {
    const res = await request(app).post('/api/system/health/db-refresh');
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ requested: false, computedNow: true });
    expect(res.body.snapshot.tables.length).toBeGreaterThan(0);
    expect(getSetting('icc_health_db_refresh_requested') || '').toBe('');
  });

  it('the sweep writes a snapshot and clears a pending refresh request', () => {
    setSetting('icc_health_db_refresh_requested', new Date().toISOString());
    systemHealth.sweepTick();
    const snap = JSON.parse(getSetting('icc_health_db_snapshot'));
    expect(snap.tables.length).toBeGreaterThan(10);
    expect(getSetting('icc_health_db_refresh_requested') || '').toBe('');
  });
});
