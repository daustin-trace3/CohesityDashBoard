import { describe, it, expect, beforeAll } from 'vitest';
import { createRequire } from 'module';
import request from 'supertest';

const require = createRequire(import.meta.url);
const API_KEY = 'test-api-key';
let app, adminDb, groupId, userId;
const get = (p) => request(app).get(p).set('x-api-key', API_KEY);
const put = (p, body) => request(app).put(p).set('x-api-key', API_KEY).send(body);

beforeAll(() => {
  adminDb = require('../db/adminDb');
  const { createApp } = require('../app');
  app = createApp({ licenseGate: (req, res, next) => next() });
  const now = new Date().toISOString();
  groupId = Number(adminDb.prepare('INSERT INTO groups (name, description, is_system, created_at) VALUES (?, ?, 0, ?)')
    .run('grants-editor-test', 'x', now).lastInsertRowid);
  userId = Number(adminDb.prepare(
    "INSERT INTO users (username, password_hash, display_name, is_active, created_at, updated_at) VALUES ('ge-user', 'x', 'GE', 1, ?, ?)"
  ).run(now, now).lastInsertRowid);
});

const stored = (type, id) => adminDb.prepare(
  'SELECT permission FROM role_grants WHERE subject_type = ? AND subject_id = ? ORDER BY permission'
).all(type, id).map((r) => r.permission);

describe('PUT /api/users/grants/:subjectType/:subjectId', () => {
  it('replaces (not merges) and returns the sorted, de-duplicated, lower-cased set', async () => {
    let r = await put(`/api/users/grants/group/${groupId}`, { permissions: ['pure:*:view', 'cohesity:*:manage'] });
    expect(r.status).toBe(200);
    expect(r.body.permissions).toEqual(['cohesity:*:manage', 'pure:*:view']);
    r = await put(`/api/users/grants/group/${groupId}`, { permissions: ['Zerto:*:view', 'zerto:*:view', 'ops:*:view'] });
    expect(r.status).toBe(200);
    expect(r.body.permissions).toEqual(['ops:*:view', 'zerto:*:view']);
    expect(stored('group', groupId)).toEqual(['ops:*:view', 'zerto:*:view']);
  });

  it('works for a user and accepts an empty list', async () => {
    let r = await put(`/api/users/grants/user/${userId}`, { permissions: ['pure:alerts:view'] });
    expect(r.status).toBe(200);
    expect(stored('user', userId)).toEqual(['pure:alerts:view']);
    r = await put(`/api/users/grants/user/${userId}`, { permissions: [] });
    expect(r.status).toBe(200);
    expect(r.body.permissions).toEqual([]);
    expect(stored('user', userId)).toEqual([]);
  });

  it('400 on a bad permission naming it, and leaves the old set intact', async () => {
    await put(`/api/users/grants/group/${groupId}`, { permissions: ['pure:*:view'] });
    const r = await put(`/api/users/grants/group/${groupId}`, { permissions: ['netapp:*:view', 'not a permission'] });
    expect(r.status).toBe(400);
    expect(r.body.error).toContain('not a permission');
    expect(stored('group', groupId)).toEqual(['pure:*:view']);
  });

  it('400 on a bad subject type, bad id or non-array body', async () => {
    expect((await put(`/api/users/grants/robot/${groupId}`, { permissions: [] })).status).toBe(400);
    expect((await put('/api/users/grants/group/abc', { permissions: [] })).status).toBe(400);
    expect((await put(`/api/users/grants/group/${groupId}`, { permissions: 'x' })).status).toBe(400);
  });

  it('404 for an unknown user or group', async () => {
    expect((await put('/api/users/grants/group/999999', { permissions: [] })).status).toBe(404);
    expect((await put('/api/users/grants/user/999999', { permissions: [] })).status).toBe(404);
  });
});

describe('GET /api/users/permission-catalog', () => {
  it('answers 200 with categories, ops, admin and all', async () => {
    const registry = require('../core/registry');
    registry.markBuiltin('cohesity');
    const r = await get('/api/users/permission-catalog');
    expect(r.status).toBe(200);
    expect(Array.isArray(r.body.categories)).toBe(true);
    expect(r.body.admin.ns).toBe('admin');
    expect(r.body.ops.ns).toBe('ops');
    expect(r.body.all.ns).toBe('*');
    const backup = r.body.categories.find((c) => c.key === 'backup');
    expect(backup.platforms.some((p) => p.id === 'cohesity')).toBe(true);
  });

  it('lists a section that only a stored grant mentions', async () => {
    await put(`/api/users/grants/group/${groupId}`, { permissions: ['ops:agent:view'] });
    const r = await get('/api/users/permission-catalog');
    expect(r.body.ops.sections.map((s) => s.key)).toContain('agent');
  });
});
