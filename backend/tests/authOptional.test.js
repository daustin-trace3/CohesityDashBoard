/**
 * Optional-auth mode: a fresh install (zero users, no auth_enabled setting)
 * runs open-access — every request gets an anonymous *:*:* identity and the
 * session endpoint reports authEnabled:false instead of 401. Enabling auth
 * creates the first admin and enforces login; disabling reopens the app.
 *
 * Loaded via createRequire so app.js resolves the same module instances.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { createRequire } from 'module';
import request from 'supertest';

const require = createRequire(import.meta.url);

let app;
let agent;

beforeAll(() => {
  const registry = require('../core/registry');
  registry.init();
  const { createApp } = require('../app');
  app = createApp({ licenseGate: (req, res, next) => next() });
  agent = request.agent(app);
});

describe('optional auth (open-access mode)', () => {
  it('a protected route works with no credentials while auth is disabled', async () => {
    const res = await agent.get('/api/clusters');
    expect(res.status).toBe(200);
  });

  it('GET /api/auth/session reports open access instead of 401', async () => {
    const res = await agent.get('/api/auth/session');
    expect(res.status).toBe(200);
    expect(res.body.authEnabled).toBe(false);
    expect(res.body.user.permissions).toEqual(['*:*:*']);
    expect(res.body.user.id).toBeNull();
  });

  it('a scoped service-account key keeps its scoping even in open mode', async () => {
    const crypto = require('crypto');
    const db = require('../db/database');
    const key = 'icc_scoped_test_key';
    db.prepare(`
      INSERT INTO service_accounts (name, key_prefix, key_hash, permissions, is_active, created_at)
      VALUES ('scoped', ?, ?, ?, 1, ?)
    `).run(
      key.slice(0, 12),
      crypto.createHash('sha256').update(key).digest('hex'),
      JSON.stringify(['netapp:*:view']),
      new Date().toISOString()
    );
    const res = await request(app).get('/api/clusters').set('x-api-key', key);
    expect(res.status).toBe(403);
  });

  it('POST /api/auth/enable without credentials on a fresh install → 400', async () => {
    const res = await agent.post('/api/auth/enable').send({});
    expect(res.status).toBe(400);
  });

  it('POST /api/auth/enable creates the first admin, signs in, and enforces auth', async () => {
    const res = await agent.post('/api/auth/enable').send({ username: 'admin', password: 'correct horse battery staple' });
    expect(res.status).toBe(200);
    expect(res.body.user.username).toBe('admin');

    // Anonymous access is now gone…
    const anon = await request(app).get('/api/clusters');
    expect(anon.status).toBe(401);

    // …but the agent's new session works.
    const mine = await agent.get('/api/clusters');
    expect(mine.status).toBe(200);
  });

  it('POST /api/auth/enable again → 403 (already enabled)', async () => {
    const res = await agent.post('/api/auth/enable').send({});
    expect(res.status).toBe(403);
  });

  it('POST /api/auth/disable requires CSRF, then reopens the app', async () => {
    const noCsrf = await agent.post('/api/auth/disable');
    expect(noCsrf.status).toBe(403);

    const session = await agent.get('/api/auth/session');
    const res = await agent.post('/api/auth/disable').set('x-csrf-token', session.body.csrfToken);
    expect(res.status).toBe(200);

    const anon = await request(app).get('/api/clusters');
    expect(anon.status).toBe(200);
  });

  it('re-enable with existing users just flips the flag (needsLogin)', async () => {
    const res = await request(app).post('/api/auth/enable').send({});
    expect(res.status).toBe(200);
    expect(res.body.needsLogin).toBe(true);
    const anon = await request(app).get('/api/clusters');
    expect(anon.status).toBe(401);
  });
});
