/**
 * Per-user saved preferences: GET/PUT /api/auth/preferences, the session
 * payload, and the admin migration that creates the table.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { createRequire } from 'module';
import request from 'supertest';

const require = createRequire(import.meta.url);

let app;
let agent;
let csrf;

beforeAll(async () => {
  const registry = require('../core/registry');
  registry.init();
  const authService = require('../services/authService');
  const { createApp } = require('../app');
  app = createApp({ licenseGate: (req, res, next) => next() });
  agent = request.agent(app);
  const setup = await agent.post('/api/auth/setup').send({
    token: authService.getClaimToken(),
    username: 'prefadmin',
    password: 'correct horse battery staple',
  });
  expect(setup.status).toBeLessThan(300);
  const login = await agent.post('/api/auth/login').send({ username: 'prefadmin', password: 'correct horse battery staple' });
  expect(login.status).toBe(200);
  const sess = await agent.get('/api/auth/session');
  csrf = sess.body.csrfToken;
});

describe('user preferences', () => {
  it('401 without a session', async () => {
    expect((await request(app).get('/api/auth/preferences')).status).toBe(401);
    expect((await request(app).put('/api/auth/preferences').send({ switcherMode: 'grid' })).status).toBe(401);
  });

  it('PUT without csrf is 403', async () => {
    const res = await agent.put('/api/auth/preferences').send({ switcherMode: 'grid' });
    expect(res.status).toBe(403);
  });

  it('400 on a bad mode or an unknown key', async () => {
    let res = await agent.put('/api/auth/preferences').set('x-csrf-token', csrf).send({ switcherMode: 'tabs' });
    expect(res.status).toBe(400);
    res = await agent.put('/api/auth/preferences').set('x-csrf-token', csrf).send({ theme: 'dark' });
    expect(res.status).toBe(400);
    res = await agent.put('/api/auth/preferences').set('x-csrf-token', csrf).send({});
    expect(res.status).toBe(400);
  });

  it('empty before any save, then PUT/GET round trip', async () => {
    const before = await agent.get('/api/auth/preferences');
    expect(before.status).toBe(200);
    expect(before.body).toEqual({ preferences: {} });
    const put = await agent.put('/api/auth/preferences').set('x-csrf-token', csrf).send({ switcherMode: 'dropdown' });
    expect(put.status).toBe(200);
    expect(put.body).toEqual({ preferences: { switcherMode: 'dropdown' } });
    const get = await agent.get('/api/auth/preferences');
    expect(get.body).toEqual({ preferences: { switcherMode: 'dropdown' } });
  });

  it('the session payload carries the saved preferences', async () => {
    await agent.put('/api/auth/preferences').set('x-csrf-token', csrf).send({ switcherMode: 'grid' });
    const sess = await agent.get('/api/auth/session');
    expect(sess.body.user.preferences).toEqual({ switcherMode: 'grid' });
  });

  it('admin migration v2 creates user_preferences', () => {
    const Database = require('better-sqlite3');
    const migrations = require('../db/migrations/admin');
    const v2 = migrations.find((m) => m.version === 2);
    expect(v2).toBeTruthy();
    const d = new Database(':memory:');
    v2.up(d);
    d.prepare("INSERT INTO user_preferences (user_id, prefs_json, updated_at) VALUES (1, '{}', 'x')").run();
    expect(d.prepare('SELECT COUNT(*) c FROM user_preferences').get().c).toBe(1);
  });
});
