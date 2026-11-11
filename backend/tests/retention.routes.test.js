/**
 * /api/retention: GET shape, PUT global and platform overrides, validation 400s,
 * 404 for an unknown platform, and the permission gate (router mounted alone
 * with hand-set grants).
 */
const adminOf = (d) => d.adminHandle || d; // admin tables are written through the admin connection (db/adminSplit.js)
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { createRequire } from 'module';
import express from 'express';
import request from 'supertest';

const require = createRequire(import.meta.url);
const { createApp } = require('../app');
const db = require('../db/database');
const retention = require('../core/retention');
const registry = require('../core/registry');

const API_KEY = 'test-api-key';
let app;

const FAKE = ['pure', 'netapp'];
beforeAll(() => {
  // The compiled-in platforms register in server.js; register stand-ins so the list has members.
  for (const id of FAKE) {
    if (registry.getPlugin(id)) continue;
    registry.registerPlugin({ id, name: id, apiVersion: registry.PLUGIN_API_VERSION, migrations: [], createRouter: () => (req, res, next) => next() });
  }
  app = createApp({ licenseGate: (req, res, next) => next() });
});
afterAll(() => { for (const id of FAKE) { try { registry.unregisterPlugin(id); } catch { /* already gone */ } } });
beforeEach(() => {
  adminOf(db).prepare("DELETE FROM app_settings WHERE key LIKE 'retention_%' OR key = 'config_ledger_retention_days'").run();
});

const get = () => request(app).get('/api/retention').set('x-api-key', API_KEY);
const putGlobal = (b) => request(app).put('/api/retention/global').set('x-api-key', API_KEY).send(b);
const putPlatform = (id, b) => request(app).put(`/api/retention/platforms/${id}`).set('x-api-key', API_KEY).send(b);

describe('GET /api/retention', () => {
  it('returns buckets, global values, ledgers and a platform list', async () => {
    const res = await get();
    expect(res.status).toBe(200);
    expect(res.body.buckets.trending).toMatchObject({ key: 'trending', default: 365, min: 30, max: 3650 });
    expect(res.body.buckets.events).toMatchObject({ key: 'events', default: 30, min: 7, max: 3650 });
    expect(res.body.global.trending).toEqual({ days: 365, source: 'default', saved: null });
    expect(res.body.global.events).toEqual({ days: 30, source: 'default', saved: null });
    expect(res.body.ledgers).toEqual({ configLedgerDays: 365 });
    expect(res.body.note).toMatch(/Service Status/);
    const ids = res.body.platforms.map((p) => p.id);
    expect(ids).toContain('cohesity');
    expect(ids).not.toContain('rubrik');
    expect(ids).not.toContain('icc');
    const cohesity = res.body.platforms.find((p) => p.id === 'cohesity');
    expect(cohesity).toMatchObject({ settingsRoute: '/settings', label: 'Cohesity', trending: { override: null, days: 365, source: 'default' } });
    expect(cohesity.coverage.trending).toContain('metrics_history');
    expect(Array.isArray(cohesity.raw)).toBe(true);
    const labels = res.body.platforms.map((p) => p.label);
    expect([...labels].sort((a, b) => a.localeCompare(b))).toEqual(labels);
  });
});

describe('PUT /api/retention/global', () => {
  it('saves trending, events and the config ledger, and answers the GET payload', async () => {
    const res = await putGlobal({ trending: 180, events: 0, configLedgerDays: 400 });
    expect(res.status).toBe(200);
    expect(res.body.global.trending).toMatchObject({ days: 180, source: 'global', saved: 180 });
    expect(res.body.global.events).toMatchObject({ days: 0, source: 'global' });
    expect(res.body.ledgers.configLedgerDays).toBe(400);
    expect(retention.days('pure', 'trending')).toBe(180);
  });

  it('rejects out-of-range and non-integer values with field', async () => {
    const cases = [[{ trending: 10 }, 'trending'], [{ events: 3 }, 'events'], [{ trending: 'x' }, 'trending'],
      [{ events: 12.5 }, 'events'], [{ configLedgerDays: 5 }, 'configLedgerDays'], [{ trending: '' }, 'trending']];
    for (const [body, field] of cases) {
      const res = await putGlobal(body);
      expect(res.status).toBe(400);
      expect(res.body.field).toBe(field);
      expect(typeof res.body.error).toBe('string');
    }
    expect(retention.globalDays('trending').saved).toBeNull();
  });

  it('writes nothing when one field of the body is bad', async () => {
    const res = await putGlobal({ trending: 200, events: 2 });
    expect(res.status).toBe(400);
    expect(retention.globalDays('trending').saved).toBeNull();
  });
});

describe('PUT /api/retention/platforms/:id', () => {
  it('sets an override, then null clears it', async () => {
    const set = await putPlatform('pure', { trending: 90, events: 14 });
    expect(set.status).toBe(200);
    const pure = set.body.platforms.find((p) => p.id === 'pure');
    expect(pure.trending).toMatchObject({ override: 90, days: 90, source: 'platform' });
    expect(pure.events).toMatchObject({ override: 14, days: 14, source: 'platform' });
    const clear = await putPlatform('pure', { trending: null, events: '' });
    const pure2 = clear.body.platforms.find((p) => p.id === 'pure');
    expect(pure2.trending.override).toBeNull();
    expect(pure2.events.source).toBe('default');
  });

  it('a platform override of 0 keeps forever while the global still applies elsewhere', async () => {
    await putGlobal({ trending: 100 });
    const res = await putPlatform('netapp', { trending: 0 });
    expect(res.body.platforms.find((p) => p.id === 'netapp').trending).toMatchObject({ days: 0, source: 'platform' });
    expect(res.body.platforms.find((p) => p.id === 'pure').trending).toMatchObject({ days: 100, source: 'global' });
  });

  it('400s a bad value and 404s an unknown platform', async () => {
    const bad = await putPlatform('pure', { events: 2 });
    expect(bad.status).toBe(400);
    expect(bad.body.field).toBe('events');
    expect((await putPlatform('not-a-platform', { trending: 90 })).status).toBe(404);
    expect((await putPlatform('rubrik', { trending: 90 })).status).toBe(404);
  });
});

describe('permission gate', () => {
  const router = require('../routes/retention');
  function appWith(grants) {
    const a = express();
    a.use(express.json());
    a.use((req, res, next) => { req.auth = { grants }; next(); });
    a.use('/api/retention', router);
    return a;
  }
  it('GET needs admin:settings:view', async () => {
    expect((await request(appWith([])).get('/api/retention')).status).toBe(403);
    expect((await request(appWith(['admin:settings:view'])).get('/api/retention')).status).toBe(200);
  });
  it('PUT global needs admin:settings:manage', async () => {
    expect((await request(appWith(['admin:settings:view'])).put('/api/retention/global').send({ trending: 200 })).status).toBe(403);
    expect((await request(appWith(['admin:settings:manage'])).put('/api/retention/global').send({ trending: 200 })).status).toBe(200);
  });
  it('PUT platform accepts the platform manage grant or the admin grant', async () => {
    expect((await request(appWith([])).put('/api/retention/platforms/pure').send({ trending: 90 })).status).toBe(403);
    expect((await request(appWith(['dell:settings:manage'])).put('/api/retention/platforms/pure').send({ trending: 90 })).status).toBe(403);
    expect((await request(appWith(['pure:settings:manage'])).put('/api/retention/platforms/pure').send({ trending: 90 })).status).toBe(200);
    expect((await request(appWith(['admin:settings:manage'])).put('/api/retention/platforms/pure').send({ trending: 91 })).status).toBe(200);
  });
});
