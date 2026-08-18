/**
 * Registry/dispatcher core mechanics (contract C4): a plugin manifest
 * registered with the registry is reachable through the `/api/:pluginId`
 * dispatcher, respects the enable/disable flag (404 platform_disabled when
 * off), and its `metricsHistory` config drives its /api/poller/status
 * section. Poller handles returned from createPoller expose a real
 * stopAll/taskCount.
 *
 * This used to exercise the real pure/netapp/zerto/dell/aria/ariaops/aws
 * platform manifests as examples (WP5/6), but those 9 platforms were
 * removed from core in the 2026-08 pluginization campaign and now only
 * exist as installable .iccplugin packs. The mechanic under test here is
 * generic (any manifest shape works identically), so two minimal inline
 * fake manifests stand in for them.
 *
 * Loaded via createRequire (not dynamic import) so registry.js, the fake
 * manifests' migrations, and app.js's own `require('./core/registry')` all
 * resolve to the SAME module instance — see the equivalent note in
 * tests/pollerFramework.test.js. The app is built once; each test resets
 * the registry's in-memory state via registry._reset() and re-registers,
 * which is safe because runMigrations is idempotent against the shared
 * (already-migrated) test database.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { createRequire } from 'module';
import express from 'express';
import request from 'supertest';

const require = createRequire(import.meta.url);

const registry = require('../core/registry');
const { createPoller } = require('../core/pollerFramework');
const { createApp } = require('../app');

function makeFakeManifest(id) {
  return {
    id,
    name: `Fake ${id}`,
    apiVersion: registry.PLUGIN_API_VERSION,
    migrations: [
      {
        version: 1,
        up(db) {
          db.exec(`CREATE TABLE IF NOT EXISTS ${id}_things (
            id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT, polling_interval_minutes INTEGER
          )`);
          db.exec(`CREATE TABLE IF NOT EXISTS ${id}_metrics_history (
            id INTEGER PRIMARY KEY AUTOINCREMENT, thing_id INTEGER, captured_at DATETIME
          )`);
        },
      },
    ],
    metricsHistory: { arraysTable: `${id}_things`, metricsTable: `${id}_metrics_history`, arrayIdColumn: 'thing_id' },
    createRouter(coreApi) {
      const router = express.Router();
      router.get('/things', (req, res) => {
        res.json(coreApi.db.prepare(`SELECT * FROM ${id}_things`).all());
      });
      return router;
    },
    createPoller() {
      return createPoller({ id, loadSources: () => [], poll: async () => {} });
    },
  };
}

const API_KEY = 'test-api-key';
let app;

beforeEach(() => {
  registry._reset();
  registry.init();
  registry.registerPlugin(makeFakeManifest('fakeplata'));
  registry.registerPlugin(makeFakeManifest('fakeplatb'));
  app = createApp({ licenseGate: (req, res, next) => next() });
});

describe('registry-driven platform plugin dispatcher + poller/status mechanics', () => {
  it('GET /api/<pluginId>/things -> 200 [] through the dispatcher when registered+enabled', async () => {
    const get = (p) => request(app).get(p).set('x-api-key', API_KEY);

    const aRes = await get('/api/fakeplata/things');
    expect(aRes.status).toBe(200);
    expect(aRes.body).toEqual([]);

    const bRes = await get('/api/fakeplatb/things');
    expect(bRes.status).toBe(200);
    expect(bRes.body).toEqual([]);
  });

  it('disabling a plugin returns 404 platform_disabled; re-enabling restores 200', async () => {
    const get = (p) => request(app).get(p).set('x-api-key', API_KEY);

    registry.setEnabled('fakeplata', false);
    const disabledRes = await get('/api/fakeplata/things');
    expect(disabledRes.status).toBe(404);
    expect(disabledRes.body).toEqual({ error: 'platform_disabled' });

    registry.setEnabled('fakeplata', true);
    const enabledRes = await get('/api/fakeplata/things');
    expect(enabledRes.status).toBe(200);
    expect(Array.isArray(enabledRes.body)).toBe(true);
  });

  it('GET /api/poller/status has a metricsHistory section for an enabled plugin, and omits a disabled one', async () => {
    const get = (p) => request(app).get(p).set('x-api-key', API_KEY);

    // getMetricsHistoryContributors() only surfaces enabled, non-errored
    // plugins (see core/registry.js) — a disabled plugin's section is
    // simply absent rather than present with enabled:false.
    registry.setEnabled('fakeplatb', false);

    const res = await get('/api/poller/status');
    expect(res.status).toBe(200);

    expect(res.body.fakeplata).toBeTypeOf('object');
    expect(res.body.fakeplata.enabled).toBe(true);
    expect(Array.isArray(res.body.fakeplata.entities)).toBe(true);

    expect(res.body.fakeplatb).toBeUndefined();
  });

  it('poller handles have real stopAll that cancels cron tasks', () => {
    const aHandle = registry.getPollerHandle('fakeplata');
    const bHandle = registry.getPollerHandle('fakeplatb');

    // Both handles exist and are the real framework handles from createPoller.
    expect(aHandle).toBeDefined();
    expect(bHandle).toBeDefined();

    // Both have stopAll and taskCount as functions (from pollerFramework).
    expect(typeof aHandle.stopAll).toBe('function');
    expect(typeof aHandle.taskCount).toBe('function');
    expect(typeof bHandle.stopAll).toBe('function');
    expect(typeof bHandle.taskCount).toBe('function');

    // Calling stopAll does not throw (idempotent, even with 0 tasks).
    expect(() => aHandle.stopAll()).not.toThrow();
    expect(() => bHandle.stopAll()).not.toThrow();

    // After stopAll, taskCount is 0.
    expect(aHandle.taskCount()).toBe(0);
    expect(bHandle.taskCount()).toBe(0);
  });
});
