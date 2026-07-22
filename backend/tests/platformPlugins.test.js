/**
 * WP5/6 (T7): pure/netapp extracted into backend platform manifests
 * registered with the registry. Verifies the dispatcher path end-to-end,
 * enable-flag teeth (disabled -> 404 platform_disabled), and that
 * /api/poller/status derives its pure/netapp sections from registry state.
 *
 * Loaded via createRequire (not dynamic import) so registry.js, the platform
 * manifests, and app.js's own `require('./core/registry')` all resolve to
 * the SAME module instance — see the equivalent note in
 * tests/pollerFramework.test.js. The app is built once; each test resets
 * the registry's in-memory state via registry._reset() and re-registers,
 * which is safe because runMigrations is idempotent against the shared
 * (already-migrated) test database.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { createRequire } from 'module';
import request from 'supertest';

const require = createRequire(import.meta.url);

const registry = require('../core/registry');
const pureManifest = require('../platforms/pure');
const netappManifest = require('../platforms/netapp');
const zertoManifest = require('../platforms/zerto');
const dellManifest = require('../platforms/dell');
const { createApp } = require('../app');

const API_KEY = 'test-api-key';
let app;

beforeEach(() => {
  registry._reset();
  registry.init();
  registry.registerPlugin(pureManifest);
  registry.registerPlugin(netappManifest);
  registry.registerPlugin(zertoManifest);
  registry.registerPlugin(dellManifest);
  app = createApp({ licenseGate: (req, res, next) => next() });
});

describe('platform plugin manifests (pure, netapp)', () => {
  it('GET /api/pure/arrays and /api/netapp/arrays -> 200 [] through the dispatcher when registered+enabled', async () => {
    const get = (p) => request(app).get(p).set('x-api-key', API_KEY);

    const pureRes = await get('/api/pure/arrays');
    expect(pureRes.status).toBe(200);
    expect(pureRes.body).toEqual([]);

    const netappRes = await get('/api/netapp/arrays');
    expect(netappRes.status).toBe(200);
    expect(netappRes.body).toEqual([]);
  });

  it('disabling pure returns 404 platform_disabled; re-enabling restores 200', async () => {
    const get = (p) => request(app).get(p).set('x-api-key', API_KEY);

    registry.setEnabled('pure', false);
    const disabledRes = await get('/api/pure/arrays');
    expect(disabledRes.status).toBe(404);
    expect(disabledRes.body).toEqual({ error: 'platform_disabled' });

    registry.setEnabled('pure', true);
    const enabledRes = await get('/api/pure/arrays');
    expect(enabledRes.status).toBe(200);
    expect(Array.isArray(enabledRes.body)).toBe(true);
  });

  it('GET /api/poller/status has pure/netapp sections reflecting registry enabled state', async () => {
    const get = (p) => request(app).get(p).set('x-api-key', API_KEY);

    registry.setEnabled('netapp', false);

    const res = await get('/api/poller/status');
    expect(res.status).toBe(200);

    expect(res.body.pure).toBeTypeOf('object');
    expect(res.body.pure.enabled).toBe(true);
    expect(Array.isArray(res.body.pure.entities)).toBe(true);

    expect(res.body.netapp).toBeTypeOf('object');
    expect(res.body.netapp.enabled).toBe(false);
    expect(Array.isArray(res.body.netapp.entities)).toBe(true);
  });

  it('zerto: dispatcher 200, disabled -> 404 platform_disabled, /status zerto section', async () => {
    const get = (p) => request(app).get(p).set('x-api-key', API_KEY);

    const sitesRes = await get('/api/zerto/sites');
    expect(sitesRes.status).toBe(200);
    expect(sitesRes.body).toEqual([]);

    const overviewRes = await get('/api/zerto/overview');
    expect(overviewRes.status).toBe(200);
    expect(overviewRes.body.configured).toBeTypeOf('boolean');

    registry.setEnabled('zerto', false);
    const disabledRes = await get('/api/zerto/sites');
    expect(disabledRes.status).toBe(404);
    expect(disabledRes.body).toEqual({ error: 'platform_disabled' });

    const statusRes = await get('/api/poller/status');
    expect(statusRes.status).toBe(200);
    expect(statusRes.body.zerto).toBeTypeOf('object');
    expect(statusRes.body.zerto.enabled).toBe(false);

    registry.setEnabled('zerto', true);
    const enabledRes = await get('/api/zerto/sites');
    expect(enabledRes.status).toBe(200);
  });

  it('dell: dispatcher 200, disabled -> 404 platform_disabled, /status dell section', async () => {
    const get = (p) => request(app).get(p).set('x-api-key', API_KEY);

    const instancesRes = await get('/api/dell/instances');
    expect(instancesRes.status).toBe(200);
    expect(instancesRes.body).toEqual([]);

    const overviewRes = await get('/api/dell/overview');
    expect(overviewRes.status).toBe(200);
    expect(Array.isArray(overviewRes.body.instances)).toBe(true);
    expect(Array.isArray(overviewRes.body.issues)).toBe(true);
    expect(overviewRes.body.warranty.warnDays).toBeTypeOf('number');

    registry.setEnabled('dell', false);
    const disabledRes = await get('/api/dell/instances');
    expect(disabledRes.status).toBe(404);
    expect(disabledRes.body).toEqual({ error: 'platform_disabled' });

    const statusRes = await get('/api/poller/status');
    expect(statusRes.status).toBe(200);
    expect(statusRes.body.dell).toBeTypeOf('object');
    expect(statusRes.body.dell.enabled).toBe(false);

    registry.setEnabled('dell', true);
    const enabledRes = await get('/api/dell/instances');
    expect(enabledRes.status).toBe(200);
  });

  it('poller handles have real stopAll that cancels cron tasks', () => {
    const pureHandle = registry.getPollerHandle('pure');
    const netappHandle = registry.getPollerHandle('netapp');

    // Both handles exist and are the real framework handles from createPoller.
    expect(pureHandle).toBeDefined();
    expect(netappHandle).toBeDefined();

    // Both have stopAll and taskCount as functions (from pollerFramework).
    expect(typeof pureHandle.stopAll).toBe('function');
    expect(typeof pureHandle.taskCount).toBe('function');
    expect(typeof netappHandle.stopAll).toBe('function');
    expect(typeof netappHandle.taskCount).toBe('function');

    // Calling stopAll does not throw (idempotent, even with 0 tasks).
    expect(() => pureHandle.stopAll()).not.toThrow();
    expect(() => netappHandle.stopAll()).not.toThrow();

    // After stopAll, taskCount is 0.
    expect(pureHandle.taskCount()).toBe(0);
    expect(netappHandle.taskCount()).toBe(0);
  });
});
