/**
 * Zerto account disconnect: DELETE /api/zerto/account (credentials cleared,
 * optional purge of collected data, alert preferences kept), the envFallback
 * flag, the createGlobalTask shouldRun gate and Service Status source counting
 * for an unconfigured account. Direct-mount style like zertoEvents.test.js.
 */
import { describe, it, expect, beforeAll, beforeEach, afterEach, vi } from 'vitest';
import { createRequire } from 'module';
import express from 'express';
import request from 'supertest';

const require = createRequire(import.meta.url);
const db = require('../db/database');
const { getSetting, setSetting } = require('../services/settings');
const pollerStatus = require('../services/pollerStatus');
const { createGlobalTask } = require('../core/pollerFramework');
const svc = require('../services/serviceStatus');
const zertoRouter = require('../routes/zerto');

const TABLES = [
  'zerto_sites', 'zerto_vpgs', 'zerto_alerts', 'zerto_vms', 'zerto_vras',
  'zerto_licenses', 'zerto_events', 'zerto_metrics_history', 'zerto_ai_reports',
];

let app;
let savedEnv;

function seedRows() {
  db.prepare("INSERT INTO zerto_sites (site_identifier, name) VALUES ('s1', 'site one')").run();
  db.prepare("INSERT INTO zerto_vpgs (vpg_identifier, name) VALUES ('v1', 'vpg one')").run();
  db.prepare("INSERT INTO zerto_alerts (alert_identifier) VALUES ('a1')").run();
  db.prepare("INSERT INTO zerto_vms (vm_identifier) VALUES ('vm1')").run();
  db.prepare("INSERT INTO zerto_vras (site_identifier) VALUES ('s1')").run();
  db.prepare("INSERT INTO zerto_licenses (license_key) VALUES ('k1')").run();
  db.prepare(`INSERT INTO zerto_events (event_identifier, category, code, event_type, description,
    completed_successfully, occurred_on, site_identifier, site_name, site_type)
    VALUES ('e1', 'Alerts', 'EV1', 'T', 'x', 1, ?, 'sid', 'site', 'VCenter')`).run(new Date().toISOString());
  db.prepare('INSERT INTO zerto_metrics_history (captured_at) VALUES (CURRENT_TIMESTAMP)').run();
  db.prepare("INSERT INTO zerto_ai_reports (report_key, content) VALUES ('r1', 'text')").run();
}

const count = (t) => db.prepare(`SELECT COUNT(*) AS n FROM ${t}`).get().n;

beforeAll(() => {
  app = express();
  app.use(express.json());
  app.use((req, res, next) => { req.auth = { grants: ['*:*:*'], user: { username: 'tester' } }; next(); });
  app.use('/api/zerto', zertoRouter);
});

beforeEach(() => {
  savedEnv = { u: process.env.ZERTO_USERNAME, p: process.env.ZERTO_PASSWORD };
  delete process.env.ZERTO_USERNAME;
  delete process.env.ZERTO_PASSWORD;
  for (const t of TABLES) db.exec(`DELETE FROM ${t}`);
  db.prepare('DELETE FROM poller_status WHERE type = ?').run('zerto');
  db.prepare("INSERT OR IGNORE INTO zerto_alert_catalog (alert_type, enabled) VALUES ('ZTEST', 1)").run();
});

afterEach(() => {
  if (savedEnv.u === undefined) delete process.env.ZERTO_USERNAME; else process.env.ZERTO_USERNAME = savedEnv.u;
  if (savedEnv.p === undefined) delete process.env.ZERTO_PASSWORD; else process.env.ZERTO_PASSWORD = savedEnv.p;
});

describe('DELETE /api/zerto/account', () => {
  it('clears the credentials, keeps the poll interval and reports unconfigured', async () => {
    const put = await request(app).put('/api/zerto/account')
      .send({ username: 'me@x.com', password: 'pw', baseUrl: 'https://z.example', pollIntervalMinutes: 30 });
    expect(put.status).toBe(200);
    expect(put.body.configured).toBe(true);

    const del = await request(app).delete('/api/zerto/account');
    expect(del.status).toBe(200);
    expect(del.body).toMatchObject({ removed: true, configured: false, envFallback: false, purged: false });
    expect(getSetting('zerto_username')).toBeFalsy();
    expect(getSetting('zerto_password')).toBeFalsy();
    expect(getSetting('zerto_base_url')).toBeFalsy();
    expect(getSetting('zerto_poll_interval_minutes')).toBe('30');

    const get = await request(app).get('/api/zerto/account');
    expect(get.body.configured).toBe(false);
    expect(get.body.hasPassword).toBe(false);
  });

  it('purge=1 empties the nine collected tables and keeps the alert catalog', async () => {
    seedRows();
    const catalogBefore = count('zerto_alert_catalog');
    const del = await request(app).delete('/api/zerto/account?purge=1');
    expect(del.status).toBe(200);
    expect(del.body.purged).toBe(true);
    for (const t of TABLES) {
      expect(count(t)).toBe(0);
      expect(del.body.purgedRows[t]).toBe(1);
    }
    expect(count('zerto_alert_catalog')).toBe(catalogBefore);
    expect(catalogBefore).toBeGreaterThan(0);
  });

  it('without purge the collected rows stay', async () => {
    seedRows();
    const del = await request(app).delete('/api/zerto/account');
    expect(del.body.purged).toBe(false);
    expect(del.body.purgedRows).toEqual({});
    for (const t of TABLES) expect(count(t)).toBe(1);
  });

  it('forgets the zerto poller_status row', async () => {
    pollerStatus.markStart('zerto', 0);
    pollerStatus.markEnd('zerto', 0, 'success');
    expect(pollerStatus.getState('zerto', 0).lastPollStatus).toBe('success');
    await request(app).delete('/api/zerto/account');
    expect(pollerStatus.getState('zerto', 0).lastPollStatus).toBeNull();
  });

  it('envFallback is true when both env vars are set, and configured stays true', async () => {
    process.env.ZERTO_USERNAME = 'env@x.com';
    process.env.ZERTO_PASSWORD = 'envpw';
    const get = await request(app).get('/api/zerto/account');
    expect(get.body.envFallback).toBe(true);
    const del = await request(app).delete('/api/zerto/account');
    expect(del.body.envFallback).toBe(true);
    expect(del.body.configured).toBe(true);
  });
});

describe('createGlobalTask shouldRun', () => {
  const fakeCron = () => ({ schedule: (expr, cb) => ({ cb, stop: vi.fn() }) });

  it('false: run is not called and poller_status is untouched', async () => {
    const run = vi.fn(async () => {});
    const task = createGlobalTask({ id: 'zgate1', intervalMinutes: 15, run, shouldRun: () => false, cronLib: fakeCron() });
    await task.trigger();
    expect(run).not.toHaveBeenCalled();
    expect(pollerStatus.getState('zgate1', 0).lastPollStatus).toBeNull();
    expect(pollerStatus.getState('zgate1', 0).lastPollStart).toBeNull();
  });

  it('true: run is called and success is recorded', async () => {
    const run = vi.fn(async () => {});
    const task = createGlobalTask({ id: 'zgate2', intervalMinutes: 15, run, shouldRun: () => true, cronLib: fakeCron() });
    await task.trigger();
    expect(run).toHaveBeenCalledTimes(1);
    expect(pollerStatus.getState('zgate2', 0).lastPollStatus).toBe('success');
  });
});

describe('Service Status polled sources for zerto', () => {
  it('is empty when unconfigured even with a zerto:0 row, one row when configured', () => {
    setSetting('zerto_username', '');
    setSetting('zerto_password', '');
    pollerStatus.markStart('zerto', 0);
    pollerStatus.markEnd('zerto', 0, 'success');
    expect(svc.polledSourcesFor('zerto')).toEqual([]);

    process.env.ZERTO_USERNAME = 'env@x.com';
    process.env.ZERTO_PASSWORD = 'envpw';
    expect(svc.polledSourcesFor('zerto')).toHaveLength(1);
  });
});
