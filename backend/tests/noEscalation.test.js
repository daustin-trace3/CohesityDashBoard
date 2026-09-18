/**
 * admin:users:manage is "may run user administration", not "may become a full
 * administrator". A scoped service-account key holding it drives the real app
 * here; every path that used to hand out more access than the caller holds
 * must now refuse.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { createRequire } from 'module';
import request from 'supertest';

const require = createRequire(import.meta.url);
const ROOT_KEY = 'test-api-key';
let app;
let db;
let helpdeskKey;
let adminGroupId;
let viewerGroupId;
let adminUserId;

const root = (method, url) => request(app)[method](url).set('x-api-key', ROOT_KEY);
const helpdesk = (method, url) => request(app)[method](url).set('x-api-key', helpdeskKey);

beforeAll(async () => {
  db = require('../db/database');
  const { createApp } = require('../app');
  app = createApp({ licenseGate: (req, res, next) => next() });

  adminGroupId = db.prepare("SELECT id FROM groups WHERE name = 'Admin'").get().id;
  viewerGroupId = db.prepare("SELECT id FROM groups WHERE name = 'Viewer'").get().id;

  const made = await root('post', '/api/users/service-accounts')
    .send({ name: 'helpdesk-' + Date.now(), permissions: ['admin:users:manage', 'dell:*:view'] });
  expect(made.status).toBe(201);
  helpdeskKey = made.body.key;

  const boss = await root('post', '/api/users').send({ username: 'boss-' + Date.now(), password: 'long-enough-pw', groupIds: [adminGroupId] });
  expect(boss.status).toBe(201);
  adminUserId = boss.body.id;
});

describe('a holder of admin:users:manage cannot escalate', () => {
  it('cannot grant a permission it does not hold', async () => {
    const victim = await helpdesk('post', '/api/users').send({ username: 'plain-' + Date.now(), password: 'long-enough-pw' });
    expect(victim.status).toBe(201);
    for (const permission of ['*:*:*', 'admin:settings:manage', 'vcenter:*:view', 'dell:*:manage']) {
      const res = await helpdesk('post', '/api/users/grants').send({ subjectType: 'user', subjectId: victim.body.id, permission });
      expect(res.status, permission).toBe(403);
    }
    const ok = await helpdesk('post', '/api/users/grants').send({ subjectType: 'user', subjectId: victim.body.id, permission: 'dell:alerts:view' });
    expect(ok.status).toBe(201);
  });

  it('cannot mint a service-account key stronger than itself, or edit one that is', async () => {
    const strong = await helpdesk('post', '/api/users/service-accounts').send({ name: 'god-' + Date.now(), permissions: ['*:*:*'] });
    expect(strong.status).toBe(403);
    const fine = await helpdesk('post', '/api/users/service-accounts').send({ name: 'dell-ro-' + Date.now(), permissions: ['dell:*:view'] });
    expect(fine.status).toBe(201);
    const widen = await helpdesk('put', '/api/users/service-accounts/' + fine.body.id).send({ permissions: ['dell:*:view', 'cohesity:*:*'] });
    expect(widen.status).toBe(403);

    const rootKey = await root('post', '/api/users/service-accounts').send({ name: 'root-made-' + Date.now(), permissions: ['vcenter:*:*'] });
    const touch = await helpdesk('put', '/api/users/service-accounts/' + rootKey.body.id).send({ isActive: false });
    expect(touch.status).toBe(403);
    const del = await helpdesk('delete', '/api/users/service-accounts/' + rootKey.body.id);
    expect(del.status).toBe(403);
  });

  it('cannot put anyone (itself included) into a group that holds more than it does', async () => {
    const made = await helpdesk('post', '/api/users').send({ username: 'climber-' + Date.now(), password: 'long-enough-pw', groupIds: [adminGroupId] });
    expect(made.status).toBe(403);
    const plain = await helpdesk('post', '/api/users').send({ username: 'climber2-' + Date.now(), password: 'long-enough-pw' });
    expect(plain.status).toBe(201);
    const promote = await helpdesk('put', '/api/users/' + plain.body.id).send({ groupIds: [adminGroupId] });
    expect(promote.status).toBe(403);
    // Viewer holds platform grants the helpdesk key lacks, so that is refused too.
    const viewer = await helpdesk('put', '/api/users/' + plain.body.id).send({ groupIds: [viewerGroupId] });
    expect(viewer.status).toBe(403);
  });

  it('cannot reset the password of, deactivate or delete an account that holds more than it does', async () => {
    const reset = await helpdesk('put', '/api/users/' + adminUserId).send({ password: 'attacker-chosen-pw' });
    expect(reset.status).toBe(403);
    const off = await helpdesk('put', '/api/users/' + adminUserId).send({ isActive: false });
    expect(off.status).toBe(403);
    const del = await helpdesk('delete', '/api/users/' + adminUserId);
    expect(del.status).toBe(403);
  });

  it('cannot strip the Admin group of its full-access grant, and neither can a full admin by accident', async () => {
    const res = await helpdesk('delete', '/api/users/grants').send({ subjectType: 'group', subjectId: adminGroupId, permission: '*:*:*' });
    expect(res.status).toBe(403);
    const asRoot = await root('delete', '/api/users/grants').send({ subjectType: 'group', subjectId: adminGroupId, permission: '*:*:*' });
    expect(asRoot.status).toBe(409);
  });

  it('a full administrator is not restricted by any of this', async () => {
    const u = await root('post', '/api/users').send({ username: 'made-by-root-' + Date.now(), password: 'long-enough-pw', groupIds: [adminGroupId] });
    expect(u.status).toBe(201);
    const g = await root('post', '/api/users/grants').send({ subjectType: 'user', subjectId: u.body.id, permission: 'admin:settings:manage' });
    expect(g.status).toBe(201);
    const pw = await root('put', '/api/users/' + u.body.id).send({ password: 'another-long-pw' });
    expect(pw.status).toBe(200);
  });
});

describe('passwords and sessions', () => {
  it('refuses short passwords on create and on reset', async () => {
    const made = await root('post', '/api/users').send({ username: 'shorty-' + Date.now(), password: 'short' });
    expect(made.status).toBe(400);
    const ok = await root('post', '/api/users').send({ username: 'longy-' + Date.now(), password: 'long-enough-pw' });
    const reset = await root('put', '/api/users/' + ok.body.id).send({ password: 'x' });
    expect(reset.status).toBe(400);
  });

  it('a password reset signs the account out everywhere', async () => {
    const { createSession, validateSession } = require('../services/authService');
    const made = await root('post', '/api/users').send({ username: 'evictme-' + Date.now(), password: 'long-enough-pw' });
    const s1 = createSession(made.body.id);
    const s2 = createSession(made.body.id);
    expect(validateSession(s1.id)).not.toBeNull();
    const reset = await root('put', '/api/users/' + made.body.id).send({ password: 'brand-new-long-pw' });
    expect(reset.status).toBe(200);
    expect(validateSession(s1.id)).toBeNull();
    expect(validateSession(s2.id)).toBeNull();
  });

  it('a read-only all-platform key cannot read users, settings or the AI audit store', async () => {
    const made = await root('post', '/api/users/service-accounts').send({ name: 'ai-agent-' + Date.now(), permissions: ['*:*:view'] });
    const agent = (url) => request(app).get(url).set('x-api-key', made.body.key);
    for (const url of ['/api/users', '/api/users/service-accounts', '/api/settings', '/api/settings/credentials', '/api/ai-audit', '/api/plugins', '/api/directory/config']) {
      const res = await agent(url);
      expect(res.status, url).toBe(403);
    }
  });
});
