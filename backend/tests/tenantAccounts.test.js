/**
 * Multi-tenant phase 2 (docs/MULTI-TENANT-DESIGN.md decisions 7, 8, 11, 16):
 * accounts and sessions are global, membership is per tenant, a global admin
 * enters every tenant and that entry is audited, existing single-tenant
 * accounts move into the global database on first use.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { createRequire } from 'module';
import request from 'supertest';

const require = createRequire(import.meta.url);

let app;
let db;
let accounts;
let tenants;
let agentAdmin;
let agentAlice;

async function login(agent, username, password, tenant = 'default') {
  const res = await agent.post(`/api/t/${tenant}/auth/login`).send({ username, password });
  expect(res.status).toBe(200);
  return res.body;
}

beforeAll(async () => {
  const registry = require('../core/registry');
  registry.init();
  db = require('../db/database');
  tenants = require('../core/tenantRegistry');
  const { hashPassword } = require('../services/authService');
  const { setSetting } = require('../services/settings');

  // The pre-migration state of a single-tenant install: two accounts in the
  // tenant's own users table, one of them in the Admin group.
  const now = new Date().toISOString();
  const adminHash = await hashPassword('admin-pw');
  const aliceHash = await hashPassword('alice-pw');
  const adminId = db.prepare("INSERT INTO users (username, password_hash, display_name, created_at, updated_at) VALUES ('admin', ?, 'Admin', ?, ?)").run(adminHash, now, now).lastInsertRowid;
  db.prepare("INSERT INTO users (username, password_hash, display_name, created_at, updated_at) VALUES ('alice', ?, 'Alice', ?, ?)").run(aliceHash, now, now);
  const adminGroup = db.prepare("SELECT id FROM groups WHERE name = 'Admin'").get();
  db.prepare('INSERT INTO user_groups (user_id, group_id) VALUES (?, ?)').run(adminId, adminGroup.id);
  setSetting('auth_enabled', '1');

  accounts = require('../core/accounts');
  const { createApp } = require('../app');
  app = createApp({ licenseGate: (req, res, next) => next() });
  agentAdmin = request.agent(app);
  agentAlice = request.agent(app);
});

describe('moving a single-tenant install', () => {
  it('the first sign-in moves the accounts to the global database and makes the Admin a global admin', async () => {
    const body = await login(agentAdmin, 'admin', 'admin-pw');
    expect(body.user.username).toBe('admin');
    expect(body.tenants.map((t) => t.id)).toEqual(['default']);
    const admin = accounts.findUserByUsername('admin');
    const alice = accounts.findUserByUsername('alice');
    expect(admin.is_global_admin).toBe(1);
    expect(alice.is_global_admin).toBe(0);
    expect(accounts.tenantsOf(alice.id)).toEqual(['default']);
    expect(accounts.listAudit().some((e) => e.action === 'accounts.migrated')).toBe(true);
  });

  it('alice signs in with her old password and still holds only her tenant grants', async () => {
    const body = await login(agentAlice, 'alice', 'alice-pw');
    expect(body.user.permissions).not.toContain('*:*:*');
    const session = await agentAlice.get('/api/t/default/auth/session');
    expect(session.body.tenant).toBe('default');
    expect(session.body.tenants.map((t) => t.id)).toEqual(['default']);
  });
});

describe('tenants and membership', () => {
  it('a global admin creates tenants; a member cannot', async () => {
    const admin = await agentAdmin.get('/api/t/default/auth/session');
    const csrf = admin.body.csrfToken;
    const created = await agentAdmin.post('/api/t/default/tenants').set('x-csrf-token', csrf).send({ id: 'acme', name: 'Acme Corp' });
    expect(created.status).toBe(201);
    const again = await agentAdmin.post('/api/t/default/tenants').set('x-csrf-token', csrf).send({ id: 'globex', name: 'Globex' });
    expect(again.status).toBe(201);
    const alice = await agentAlice.get('/api/t/default/auth/session');
    const denied = await agentAlice.post('/api/t/default/tenants').set('x-csrf-token', alice.body.csrfToken).send({ id: 'nope', name: 'Nope' });
    expect(denied.status).toBe(403);
  });

  it('a member sees only her tenants and is refused elsewhere; a global admin enters anywhere and is audited once', async () => {
    const admin = await agentAdmin.get('/api/t/default/auth/session');
    const csrf = admin.body.csrfToken;
    const alice = accounts.findUserByUsername('alice');
    const add = await agentAdmin.post('/api/t/default/tenants/acme/members').set('x-csrf-token', csrf).send({ username: 'alice' });
    expect(add.status).toBe(201);

    expect((await agentAlice.get('/api/t/acme/clusters')).status).toBe(200);
    expect((await agentAlice.get('/api/t/globex/clusters')).status).toBe(403);
    expect((await agentAlice.get('/api/tenants')).body.tenants.map((t) => t.id).sort()).toEqual(['acme', 'default']);

    expect((await agentAdmin.get('/api/t/globex/clusters')).status).toBe(200);
    expect((await agentAdmin.get('/api/t/globex/clusters')).status).toBe(200);
    expect((await agentAdmin.get('/api/tenants')).body.tenants.map((t) => t.id).sort()).toEqual(['acme', 'default', 'globex']);
    const entries = accounts.listAudit({ tenantId: 'globex' }).filter((e) => e.action === 'tenant.entered');
    expect(entries).toHaveLength(1);
    expect(entries[0].actor).toBe('admin');

    // alice's tenant grants in acme are the Viewer defaults, not admin's.
    const { runAsTenant } = require('../core/tenantContext');
    const viewerRows = runAsTenant('acme', () => db.prepare('SELECT g.name FROM user_groups ug JOIN groups g ON g.id = ug.group_id WHERE ug.user_id = ?').all(alice.id));
    expect(viewerRows.map((r) => r.name)).toEqual(['Viewer']);
  });

  it('a request that names no tenant can still sign in and list tenants, but nothing else', async () => {
    expect((await agentAlice.get('/api/auth/session')).status).toBe(200);
    expect((await agentAlice.get('/api/tenants')).status).toBe(200);
    expect((await agentAlice.get('/api/clusters')).status).toBe(400);
    // The frontend manifest is install-wide; a pack bundle names its tenant in ?t=.
    expect((await agentAlice.get('/api/plugins/frontend-manifest')).status).not.toBe(400);
    expect((await agentAlice.get('/api/plugins/nothere/bundle.js?v=1&t=acme')).status).not.toBe(400);
    expect((await agentAlice.get('/api/plugins/nothere/bundle.js?v=1&t=globex')).status).toBe(403);
  });
});

describe('tenant user management', () => {
  it('adding a known username links the account; a new one creates it; removing keeps the account', async () => {
    const admin = await agentAdmin.get('/api/t/acme/auth/session');
    const csrf = admin.body.csrfToken;
    // admin is a global admin, so no membership row in acme, yet may manage it.
    const link = await agentAdmin.post('/api/t/globex/users').set('x-csrf-token', csrf).send({ username: 'alice' });
    expect(link.status).toBe(201);
    expect(accounts.tenantsOf(accounts.findUserByUsername('alice').id).sort()).toEqual(['acme', 'default', 'globex']);

    const dup = await agentAdmin.post('/api/t/globex/users').set('x-csrf-token', csrf).send({ username: 'alice', password: 'x' });
    expect(dup.status).toBe(409);

    const made = await agentAdmin.post('/api/t/globex/users').set('x-csrf-token', csrf).send({ username: 'bob', password: 'bob-pw', displayName: 'Bob' });
    expect(made.status).toBe(201);
    const bob = accounts.findUserByUsername('bob');
    expect(accounts.tenantsOf(bob.id)).toEqual(['globex']);
    expect(accounts.isMember('default', bob.id)).toBe(false);

    const removed = await agentAdmin.delete(`/api/t/globex/users/${bob.id}`).set('x-csrf-token', csrf);
    expect(removed.status).toBe(200);
    expect(accounts.findUserByUsername('bob')).not.toBe(null);
    expect(accounts.isMember('globex', bob.id)).toBe(false);

    const agentBob = request.agent(app);
    expect((await agentBob.post('/api/auth/login').send({ username: 'bob', password: 'bob-pw' })).status).toBe(200);
    expect((await agentBob.get('/api/tenants')).body.tenants).toEqual([]);
    expect((await agentBob.get('/api/t/globex/clusters')).status).toBe(403);
  });

  it('a password change applies to the account everywhere', async () => {
    const admin = await agentAdmin.get('/api/t/acme/auth/session');
    const alice = accounts.findUserByUsername('alice');
    const res = await agentAdmin.put(`/api/t/acme/users/${alice.id}`).set('x-csrf-token', admin.body.csrfToken).send({ password: 'alice-new' });
    expect(res.status).toBe(200);
    const fresh = request.agent(app);
    expect((await fresh.post('/api/t/default/auth/login').send({ username: 'alice', password: 'alice-pw' })).status).toBe(401);
    expect((await fresh.post('/api/t/default/auth/login').send({ username: 'alice', password: 'alice-new' })).status).toBe(200);
  });

  it('a second tenant cannot be created while auth is off', async () => {
    const { setSetting } = require('../services/settings');
    const { runAsTenant } = require('../core/tenantContext');
    runAsTenant('default', () => setSetting('auth_enabled', '0'));
    const admin = await agentAdmin.get('/api/t/default/auth/session');
    const res = await agentAdmin.post('/api/t/default/tenants').set('x-csrf-token', admin.body.csrfToken).send({ id: 'later', name: 'Later' });
    expect(res.status).toBe(409);
    runAsTenant('default', () => setSetting('auth_enabled', '1'));
  });
});
