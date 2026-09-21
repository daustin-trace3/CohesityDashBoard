/**
 * Characterization suite — records CURRENT behavior of the statically-wired
 * server before the ICC plugin-registry refactor (Phase 1). If the refactor
 * changes any of these observations, that is a regression, not a test bug.
 *
 * The license gate is replaced with a pass-through via createApp's DI seam so
 * routes are reachable without a signed vendor key; the real gate behavior is
 * characterized separately in license-gate.test.js.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { createRequire } from 'module';
import request from 'supertest';

// Loaded via createRequire (not dynamic import) so registry.js and app.js's
// own `require('./core/registry')` resolve to the SAME module instance —
// see the equivalent note in tests/pollerFramework.test.js.
const require = createRequire(import.meta.url);

const API_KEY = 'test-api-key';
let app;

beforeAll(() => {
  const registry = require('../core/registry');
  const pureManifest = require('../platforms/pure');
  const netappManifest = require('../platforms/netapp');
  registry.init();
  registry.registerPlugin(pureManifest);
  registry.registerPlugin(netappManifest);

  // These tests characterize ENFORCED auth. With zero users the app would
  // default to open-access mode, so pin auth on explicitly.
  require('../services/settings').setSetting('auth_enabled', '1');

  const { createApp } = require('../app');
  app = createApp({ licenseGate: (req, res, next) => next() });
});

describe('health', () => {
  it('GET /health → 200 ok (no api key required)', async () => {
    const res = await request(app).get('/health');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ status: 'ok' });
  });
});

describe('api key middleware', () => {
  it('rejects /api requests without x-api-key → 401', async () => {
    const res = await request(app).get('/api/clusters');
    expect(res.status).toBe(401);
  });

  it('rejects /api requests with a wrong key → 401', async () => {
    const res = await request(app).get('/api/clusters').set('x-api-key', 'wrong-key-x');
    expect(res.status).toBe(401);
  });

  it('rejects a wrong key of matching length → 401 (timing-safe compare path)', async () => {
    const res = await request(app).get('/api/clusters').set('x-api-key', 'X'.repeat(API_KEY.length));
    expect(res.status).toBe(401);
  });
});

// An API path no route handles must answer 404 JSON. It used to fall through to
// the app shell (index.html, 200), so a page calling a route the running backend
// did not have yet read the HTML as an empty answer.
describe('unknown api paths', () => {
  const get = (p) => request(app).get(p).set('x-api-key', API_KEY);

  it('a path under a known platform answers 404 JSON', async () => {
    const res = await get('/api/netapp/no-such-route');
    expect(res.status).toBe(404);
    expect(res.headers['content-type']).toMatch(/json/);
    expect(res.body.error).toMatch(/No API route for GET \/api\/netapp\/no-such-route/);
  });

  it('a path under no platform at all answers 404 JSON', async () => {
    const res = await get('/api/no-such-platform/thing?x=1');
    expect(res.status).toBe(404);
    expect(res.headers['content-type']).toMatch(/json/);
    expect(res.body.error).not.toMatch(/x=1/);
  });
});

describe('platform endpoints on an empty database', () => {
  const get = (p) => request(app).get(p).set('x-api-key', API_KEY);

  it('GET /api/clusters → 200 empty list', async () => {
    const res = await get('/api/clusters');
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body)).toBe(true);
    expect(res.body).toHaveLength(0);
  });

  it('GET /api/pure/arrays → 200 empty list', async () => {
    const res = await get('/api/pure/arrays');
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body)).toBe(true);
    expect(res.body).toHaveLength(0);
  });

  it('GET /api/netapp/arrays → 200 empty list', async () => {
    const res = await get('/api/netapp/arrays');
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body)).toBe(true);
    expect(res.body).toHaveLength(0);
  });

  it('GET /api/poller/status → 200', async () => {
    const res = await get('/api/poller/status');
    expect(res.status).toBe(200);
    expect(res.body).toBeTypeOf('object');
  });

  it('GET /api/settings → 200 object', async () => {
    const res = await get('/api/settings');
    expect(res.status).toBe(200);
    expect(res.body).toBeTypeOf('object');
  });

  it('GET /api/license/status → 200 state missing (no key configured in tests)', async () => {
    const res = await get('/api/license/status');
    expect(res.status).toBe(200);
    expect(res.body.state).toBe('missing');
  });
});
