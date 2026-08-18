/**
 * RBAC enforcement across the real middleware chain (contract C8.5/C8.6):
 * Viewer vs Admin group membership drives 200 vs 403 on representative
 * routes, the legacy env x-api-key lane keeps full access, an unrecognized
 * key is 401, and a scoped service_accounts key only gets what its grants
 * allow.
 *
 * Loaded via createRequire so app.js's own requires (db, authService,
 * registry) resolve to the SAME module instances as this test's — see the
 * equivalent note in tests/characterization.api.test.js.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { createRequire } from 'module';
import crypto from 'crypto';
import request from 'supertest';

const require = createRequire(import.meta.url);

const API_KEY = 'test-api-key';
let app;
let db;
let authService;

async function insertUser(username, password, groupName) {
  const now = new Date().toISOString();
  const passwordHash = await authService.hashPassword(password);
  const info = db.prepare(`
    INSERT INTO users (username, password_hash, display_name, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?)
  `).run(username, passwordHash, username, now, now);

  const group = db.prepare('SELECT id FROM groups WHERE name = ?').get(groupName);
  db.prepare('INSERT INTO user_groups (user_id, group_id) VALUES (?, ?)').run(info.lastInsertRowid, group.id);

  return info.lastInsertRowid;
}

/** Logs in via the real API and returns { agent, csrfToken }. */
async function loginAgent(username, password) {
  const agent = request.agent(app);
  const loginRes = await agent.post('/api/auth/login').send({ username, password });
  expect(loginRes.status).toBe(200);
  const sessionRes = await agent.get('/api/auth/session');
  return { agent, csrfToken: sessionRes.body.csrfToken };
}

beforeAll(async () => {
  const registry = require('../core/registry');
  registry.init();

  db = require('../db/database');
  authService = require('../services/authService');
  const { createApp } = require('../app');
  app = createApp({ licenseGate: (req, res, next) => next() });

  await insertUser('viewer1', 'viewer-password-123', 'Viewer');
  await insertUser('admin1', 'admin-password-123', 'Admin');
});

describe('Viewer group', () => {
  it('GET /api/cohesity/clusters → 200', async () => {
    const { agent } = await loginAgent('viewer1', 'viewer-password-123');
    const res = await agent.get('/api/cohesity/clusters');
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body)).toBe(true);
  });

  it('POST /api/cohesity/clusters → 403 {error: "forbidden"} (view-only grant)', async () => {
    const { agent, csrfToken } = await loginAgent('viewer1', 'viewer-password-123');
    const res = await agent.post('/api/cohesity/clusters').set('x-csrf-token', csrfToken).send({});
    expect(res.status).toBe(403);
    expect(res.body.error).toBe('forbidden');
  });

  it('GET /api/settings → 403 (no admin:settings grant)', async () => {
    const { agent } = await loginAgent('viewer1', 'viewer-password-123');
    const res = await agent.get('/api/settings');
    expect(res.status).toBe(403);
    expect(res.body.error).toBe('forbidden');
  });
});

describe('Admin group', () => {
  it('GET /api/settings → 200', async () => {
    const { agent } = await loginAgent('admin1', 'admin-password-123');
    const res = await agent.get('/api/settings');
    expect(res.status).toBe(200);
  });
});

describe('legacy env x-api-key lane', () => {
  it('still has full access (matches DASHBOARD_API_KEY)', async () => {
    const res = await request(app).get('/api/settings').set('x-api-key', API_KEY);
    expect(res.status).toBe(200);
  });

  it('an unrecognized key → 401', async () => {
    const res = await request(app).get('/api/cohesity/clusters').set('x-api-key', 'totally-unknown-key');
    expect(res.status).toBe(401);
  });
});

describe('scoped service account key', () => {
  it('respects its stored permission scope', async () => {
    const key = `icc_${crypto.randomBytes(20).toString('hex')}`;
    const keyHash = crypto.createHash('sha256').update(key).digest('hex');
    const now = new Date().toISOString();
    db.prepare(`
      INSERT INTO service_accounts (name, key_hash, key_prefix, permissions, is_active, created_at)
      VALUES (?, ?, ?, ?, 1, ?)
    `).run('scoped-test-account', keyHash, key.slice(0, 8), JSON.stringify(['cohesity:clusters:view']), now);

    const allowed = await request(app).get('/api/cohesity/clusters').set('x-api-key', key);
    expect(allowed.status).toBe(200);

    const denied = await request(app).get('/api/settings').set('x-api-key', key);
    expect(denied.status).toBe(403);

    const row = db.prepare('SELECT last_used_at FROM service_accounts WHERE key_hash = ?').get(keyHash);
    expect(row.last_used_at).toBeTruthy();
  });

  it('an inactive service account key → 401', async () => {
    const key = `icc_${crypto.randomBytes(20).toString('hex')}`;
    const keyHash = crypto.createHash('sha256').update(key).digest('hex');
    const now = new Date().toISOString();
    db.prepare(`
      INSERT INTO service_accounts (name, key_hash, key_prefix, permissions, is_active, created_at)
      VALUES (?, ?, ?, ?, 0, ?)
    `).run('inactive-test-account', keyHash, key.slice(0, 8), JSON.stringify(['*:*:*']), now);

    const res = await request(app).get('/api/cohesity/clusters').set('x-api-key', key);
    expect(res.status).toBe(401);
  });
});
