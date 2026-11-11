/**
 * POST /api/auth/change-password: session + CSRF checks, validation cases
 * and the success path (new password signs in, old one does not).
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { createRequire } from 'module';
import request from 'supertest';

const require = createRequire(import.meta.url);

let app;
let authService;
let agent;
let csrf;
const PW = 'correct horse battery staple';

beforeAll(async () => {
  const registry = require('../core/registry');
  registry.init();
  authService = require('../services/authService');
  const { createApp } = require('../app');
  app = createApp({ licenseGate: (req, res, next) => next() });
  agent = request.agent(app);
  await agent.post('/api/auth/setup').send({ token: authService.getClaimToken(), username: 'admin', password: PW });
  const s = await agent.get('/api/auth/session');
  csrf = s.body.csrfToken;
  expect(s.body.user.authProvider).toBe('local');
});

const post = (body, withCsrf = true) => {
  const r = agent.post('/api/auth/change-password');
  if (withCsrf) r.set('x-csrf-token', csrf);
  return r.send(body);
};

describe('POST /api/auth/change-password', () => {
  it('401 without a session', async () => {
    const res = await request(app).post('/api/auth/change-password').send({ currentPassword: PW, newPassword: 'another long password' });
    expect(res.status).toBe(401);
  });
  it('403 without the csrf token', async () => {
    const res = await post({ currentPassword: PW, newPassword: 'another long password' }, false);
    expect(res.status).toBe(403);
  });
  it('400 on missing fields', async () => {
    expect((await post({ currentPassword: PW })).status).toBe(400);
  });
  it('400 under 8 characters', async () => {
    expect((await post({ currentPassword: PW, newPassword: 'short' })).status).toBe(400);
  });
  it('400 on a wrong current password', async () => {
    expect((await post({ currentPassword: 'not it at all', newPassword: 'another long password' })).status).toBe(400);
  });
  it('400 when the new password equals the current one', async () => {
    expect((await post({ currentPassword: PW, newPassword: PW })).status).toBe(400);
  });
  it('200 on success, then the new password signs in and the old one does not', async () => {
    const res = await post({ currentPassword: PW, newPassword: 'another long password' });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true });
    const ok = await request(app).post('/api/auth/login').send({ username: 'admin', password: 'another long password' });
    expect(ok.status).toBe(200);
    const old = await request(app).post('/api/auth/login').send({ username: 'admin', password: PW });
    expect(old.status).toBe(401);
  });
  it('400 for a non-local account', async () => {
    const db = require('../db/adminDb');
    db.prepare("UPDATE users SET auth_provider = 'ad' WHERE username = 'admin'").run();
    const res = await post({ currentPassword: 'another long password', newPassword: 'yet another password' });
    expect(res.status).toBe(400);
  });
});
