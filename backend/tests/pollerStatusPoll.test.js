/**
 * Manual re-poll of one source (POST /api/poller/sources/:platform/:id/poll)
 * and the lastPollError / staleAfterMinutes fields on GET /api/poller/status.
 * Loaded via createRequire so the router, registry and app share one module
 * instance (see tests/platformPlugins.test.js).
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { createRequire } from 'module';
import request from 'supertest';

const require = createRequire(import.meta.url);
const express = require('express');
const registry = require('../core/registry');
const pollerStatus = require('../services/pollerStatus');
const router = require('../routes/poller');

let grants = [];
function miniApp() {
  const app = express();
  app.use((req, res, next) => { req.auth = { grants }; next(); });
  app.use('/api/poller', router);
  return app;
}

describe('POST /api/poller/sources/:platform/:entityId/poll', () => {
  let app;
  let trigger;
  beforeEach(() => {
    app = miniApp();
    grants = ['*:*:*'];
    trigger = vi.fn(() => Promise.resolve());
    vi.spyOn(registry, 'getPlugin').mockImplementation((id) => (id === 'fakeplat' || id === 'nopoll' ? { id, enabled: true } : undefined));
    vi.spyOn(registry, 'getPollerHandle').mockImplementation((id) => (id === 'fakeplat' ? { trigger } : undefined));
  });
  afterEach(() => { vi.restoreAllMocks(); });

  it('triggers the platform handle with the source id', async () => {
    const res = await request(app).post('/api/poller/sources/fakeplat/7/poll');
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ ok: true, platform: 'fakeplat', entityId: 7 });
    expect(trigger).toHaveBeenCalledWith(7);
  });

  it('answers 404 when the platform has no poller handle', async () => {
    const res = await request(app).post('/api/poller/sources/nopoll/7/poll');
    expect(res.status).toBe(404);
  });

  it('answers 404 for an unknown platform and 400 for a bad id', async () => {
    expect((await request(app).post('/api/poller/sources/ghost/7/poll')).status).toBe(404);
    expect((await request(app).post('/api/poller/sources/fakeplat/abc/poll')).status).toBe(400);
  });

  it('answers 403 without the platform manage grant', async () => {
    grants = ['fakeplat:*:view'];
    const res = await request(app).post('/api/poller/sources/fakeplat/7/poll');
    expect(res.status).toBe(403);
    expect(res.body.required).toBe('fakeplat:settings:manage');
    expect(trigger).not.toHaveBeenCalled();
  });

  it('answers 409 when the source is already polling', async () => {
    pollerStatus.markStart('fakeplat', 7);
    const res = await request(app).post('/api/poller/sources/fakeplat/7/poll');
    expect(res.status).toBe(409);
    expect(trigger).not.toHaveBeenCalled();
    pollerStatus.markEnd('fakeplat', 7, 'success');
  });
});

describe('GET /api/poller/status error fields', () => {
  it('carries lastPollError and staleAfterMinutes on source rows', async () => {
    registry._reset();
    registry.init();
    for (const m of ['pure', 'netapp', 'zerto', 'dell', 'aria', 'ariaops', 'aws', 'vcenter']) {
      registry.registerPlugin(require(`../platforms/${m}`));
    }
    const db = require('../db/database');
    const { createApp } = require('../app');
    const app = createApp({ licenseGate: (req, res, next) => next() });
    db.prepare(`INSERT INTO vcenter_vcenters (name, host, username, encrypted_credentials, polling_interval_minutes, last_poll_status, last_poll_error)
                VALUES ('tor-vc-test', 'h', 'u', 'x', 15, 'error', 'login refused')`).run();
    const res = await request(app).get('/api/poller/status').set('x-api-key', 'test-api-key');
    expect(res.status).toBe(200);
    const row = res.body.vcenter.entities.find((e) => e.name === 'tor-vc-test');
    expect(row.lastPollError).toBe('login refused');
    expect(row.staleAfterMinutes).toBe(35);
    expect(res.body.zerto.staleAfterMinutes).toBeTypeOf('number');
  });
});
