/**
 * Demo mode (DASHBOARD_DEMO=1) blocks manual poll-trigger endpoints
 * (refresh/poll/trigger) centrally, before any route handler runs — see
 * backend/middleware/demoPollGuard.js. Manual "Refresh" endpoints call
 * pollers directly and are NOT covered by the background-poller isDemo()
 * guards (server.js, pollerProcess.js); on the seeded demo instance they
 * poll fictional hosts, fail, and wipe seeded inventory.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { createRequire } from 'module';
import request from 'supertest';

const require = createRequire(import.meta.url);

const API_KEY = 'test-api-key';

function buildApp() {
  // Fresh app per test so DASHBOARD_DEMO is read at request time via
  // isDemo(), matching the pattern in tests/demoMode.test.js.
  delete require.cache[require.resolve('../app')];
  const { createApp } = require('../app');
  return createApp({ licenseGate: (req, res, next) => next() });
}

afterEach(() => {
  delete process.env.DASHBOARD_DEMO;
});

describe('demoPollGuard', () => {
  it('demo mode: POST /api/poller/trigger returns the demo short-circuit payload, not a real poll', async () => {
    process.env.DASHBOARD_DEMO = '1';
    const app = buildApp();

    const res = await request(app)
      .post('/api/poller/trigger')
      .set('x-api-key', API_KEY);

    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      triggered: false,
      demo: true,
      message: 'Demo mode — data is static; live polling is disabled.',
    });
    // Real handler response shape ({ started: N }) must NOT appear.
    expect(res.body.started).toBeUndefined();
  });

  it('demo off: POST /api/poller/trigger reaches the real handler', async () => {
    const app = buildApp();

    const res = await request(app)
      .post('/api/poller/trigger')
      .set('x-api-key', API_KEY);

    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty('started');
    expect(res.body.demo).toBeUndefined();
  });

  it('demo mode: a GET/probe route is unaffected', async () => {
    process.env.DASHBOARD_DEMO = '1';
    const app = buildApp();

    const res = await request(app)
      .get('/api/poller/status')
      .set('x-api-key', API_KEY);

    expect(res.status).toBe(200);
    expect(res.body.demo).toBeUndefined();
    expect(res.body.triggered).toBeUndefined();
  });
});
