/**
 * Full first-run auth flow (contract C8.4): setup-status, claim-token gated
 * setup, login, session shape, CSRF enforcement on session mutations, and
 * logout. Uses a supertest agent so the `icc_session` cookie rides along
 * between requests like a real browser.
 *
 * Loaded via createRequire (not dynamic import) so app.js's own
 * `require('./services/authService')` resolves to the SAME module instance
 * as this test's — see the equivalent note in tests/characterization.api.test.js.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { createRequire } from 'module';
import request from 'supertest';

const require = createRequire(import.meta.url);

let app;
let authService;
let agent;

beforeAll(() => {
  const registry = require('../core/registry');
  const pureManifest = require('../platforms/pure');
  const netappManifest = require('../platforms/netapp');
  registry.init();
  registry.registerPlugin(pureManifest);
  registry.registerPlugin(netappManifest);

  authService = require('../services/authService');
  const { createApp } = require('../app');
  app = createApp({ licenseGate: (req, res, next) => next() });
  agent = request.agent(app);
});

describe('first-run setup + login + session + CSRF + logout', () => {

  it('GET /api/auth/setup-status → needsSetup true before any user exists', async () => {
    const res = await agent.get('/api/auth/setup-status');
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ needsSetup: true, authEnabled: false, directory: { enabled: false } });
  });

  it('POST /api/auth/setup with a bad token → 403', async () => {
    const res = await agent.post('/api/auth/setup').send({
      token: 'not-the-real-token',
      username: 'admin',
      password: 'correct horse battery staple',
    });
    expect(res.status).toBe(403);
  });

  it('POST /api/auth/setup with the real claim token → creates the admin, sets the cookie', async () => {
    const token = authService.getClaimToken();
    expect(token).toMatch(/^[0-9a-f]{32}$/);

    const res = await agent.post('/api/auth/setup').send({
      token,
      username: 'admin',
      password: 'correct horse battery staple',
    });
    expect(res.status).toBe(200);
    expect(res.body.user).toMatchObject({ username: 'admin', displayName: 'admin' });
    expect(Array.isArray(res.body.user.permissions)).toBe(true);
    expect(res.body.user.permissions).toContain('*:*:*');

    const setCookie = res.headers['set-cookie'] || [];
    expect(setCookie.some((c) => c.startsWith('icc_session='))).toBe(true);
  });

  it('GET /api/auth/setup-status → needsSetup false once an admin exists', async () => {
    const res = await agent.get('/api/auth/setup-status');
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ needsSetup: false, authEnabled: true, directory: { enabled: false } });
  });

  it('POST /api/auth/login with the wrong password → 401 (generic error)', async () => {
    const res = await request(app).post('/api/auth/login').send({
      username: 'admin',
      password: 'wrong password',
    });
    expect(res.status).toBe(401);
  });

  let sessionAgent;
  let csrfToken;

  it('POST /api/auth/login with the right credentials → 200, sets the cookie', async () => {
    sessionAgent = request.agent(app);
    const res = await sessionAgent.post('/api/auth/login').send({
      username: 'admin',
      password: 'correct horse battery staple',
    });
    expect(res.status).toBe(200);
    expect(res.body.user.username).toBe('admin');

    const setCookie = res.headers['set-cookie'] || [];
    expect(setCookie.some((c) => c.startsWith('icc_session='))).toBe(true);
  });

  it('GET /api/auth/session → user + csrfToken shape', async () => {
    const res = await sessionAgent.get('/api/auth/session');
    expect(res.status).toBe(200);
    expect(res.body.user).toMatchObject({ username: 'admin', displayName: 'admin' });
    expect(Array.isArray(res.body.user.permissions)).toBe(true);
    expect(typeof res.body.csrfToken).toBe('string');
    expect(res.body.csrfToken).toMatch(/^[0-9a-f]{64}$/);
    csrfToken = res.body.csrfToken;
  });

  it('CSRF: a session mutation without x-csrf-token → 403 {error: "csrf"}', async () => {
    const res = await sessionAgent.put('/api/settings').send({ llmEstateContext: 'test' });
    expect(res.status).toBe(403);
    expect(res.body).toEqual({ error: 'csrf' });
  });

  it('CSRF: the same mutation WITH the correct x-csrf-token → 200', async () => {
    const res = await sessionAgent
      .put('/api/settings')
      .set('x-csrf-token', csrfToken)
      .send({ llmEstateContext: 'test' });
    expect(res.status).toBe(200);
  });

  it('POST /api/auth/logout → destroys the session, clears the cookie', async () => {
    const res = await sessionAgent.post('/api/auth/logout');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true });
  });

  it('GET /api/auth/session after logout → 401', async () => {
    const res = await sessionAgent.get('/api/auth/session');
    expect(res.status).toBe(401);
  });
});
