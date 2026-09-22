/**
 * Multi-tenant phase 4 (docs/MULTI-TENANT-DESIGN.md decisions 4, 12, 14, 15):
 * a key per tenant, a licence per tenant, platforms per tenant, the tenant
 * setup flow and suspension.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { createRequire } from 'module';
import request from 'supertest';

const require = createRequire(import.meta.url);

let app;
let accounts;
let tenants;
let registry;
let agent;
let csrf;

beforeAll(async () => {
  registry = require('../core/registry');
  registry.init();
  registry.registerPlugin(require('../platforms/pure'));
  registry.registerPlugin(require('../platforms/netapp'));
  registry.setEnabled('pure', true);
  registry.setEnabled('netapp', true);
  tenants = require('../core/tenantRegistry');
  accounts = require('../core/accounts');
  const { hashPassword } = require('../services/authService');
  const { setSetting } = require('../services/settings');
  setSetting('auth_enabled', '1');
  const root = accounts.createUser({ username: 'root', passwordHash: await hashPassword('root-pw'), displayName: 'Root', isGlobalAdmin: 1 });
  accounts.addMember('default', root.id, 'test');

  const { createApp } = require('../app');
  app = createApp({ licenseGate: (req, res, next) => next() });
  agent = request.agent(app);
  expect((await agent.post('/api/auth/login').send({ username: 'root', password: 'root-pw' })).status).toBe(200);
  csrf = (await agent.get('/api/t/default/auth/session')).body.csrfToken;
});

describe('tenant setup', () => {
  it('creates a tenant with a platform pick and a first admin who is Admin there and nowhere else', async () => {
    const res = await agent.post('/api/t/default/tenants').set('x-csrf-token', csrf)
      .send({ id: 'wayne', name: 'Wayne Corp', platforms: ['cohesity', 'pure'], admin: { username: 'bruce', password: 'bat-pw', displayName: 'Bruce' } });
    expect(res.status).toBe(201);
    expect(res.body.platforms.sort()).toEqual(['cohesity', 'pure']);
    expect(res.body.members).toBe(1);

    const bruce = request.agent(app);
    expect((await bruce.post('/api/auth/login').send({ username: 'bruce', password: 'bat-pw' })).status).toBe(200);
    const session = await bruce.get('/api/t/wayne/auth/session');
    expect(session.body.user.permissions).toContain('*:*:*');
    expect(session.body.user.isGlobalAdmin).toBe(false);
    expect((await bruce.get('/api/t/default/clusters')).status).toBe(403);
    expect(accounts.tenantsOf(accounts.findUserByUsername('bruce').id)).toEqual(['wayne']);
  });

  it('a platform the tenant was not given answers platform_disabled there and works elsewhere', async () => {
    expect((await agent.get('/api/t/wayne/netapp/arrays')).status).toBe(404);
    expect((await agent.get('/api/t/wayne/netapp/arrays')).body.error).toBe('platform_disabled');
    expect((await agent.get('/api/t/wayne/pure/arrays')).status).toBe(200);
    expect((await agent.get('/api/t/default/netapp/arrays')).status).toBe(200);
    const list = await agent.get('/api/t/wayne/plugins');
    const byId = Object.fromEntries(list.body.map((p) => [p.id, p.enabled]));
    expect(byId.netapp).toBe(false);
    expect(byId.pure).toBe(true);

    const put = await agent.put('/api/t/default/tenants/wayne').set('x-csrf-token', csrf).send({ platforms: ['cohesity', 'pure', 'netapp'] });
    expect(put.status).toBe(200);
    expect((await agent.get('/api/t/wayne/netapp/arrays')).status).toBe(200);
  });

  it('a bad licence key at setup is refused before anything is created; the key on the row is validated too', async () => {
    const res = await agent.post('/api/t/default/tenants').set('x-csrf-token', csrf).send({ id: 'nokey', name: 'No Key', licenseKey: 'CDBL-not-a-real-key' });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/invalid/);
    expect(tenants.getTenant('nokey')).toBe(null);
    const row = await agent.put('/api/t/default/tenants/wayne').set('x-csrf-token', csrf).send({ licenseKey: 'CDBL-not-a-real-key' });
    expect(row.status).toBe(400);
    const def = await agent.put('/api/t/default/tenants/default').set('x-csrf-token', csrf).send({ licenseKey: 'CDBL-x' });
    expect(def.status).toBe(400);
    expect(def.body.error).toMatch(/default tenant/);
  });

  it('refuses a bad platform list, an unknown admin without a password, and a duplicate id', async () => {
    expect((await agent.post('/api/t/default/tenants').set('x-csrf-token', csrf).send({ id: 'x-1', name: 'X', platforms: 'pure' })).status).toBe(400);
    expect((await agent.post('/api/t/default/tenants').set('x-csrf-token', csrf).send({ id: 'x-2', name: 'X', admin: { username: 'nobody' } })).status).toBe(400);
    expect((await agent.post('/api/t/default/tenants').set('x-csrf-token', csrf).send({ id: 'wayne', name: 'Again' })).status).toBe(400);
  });
});

describe('a key per tenant', () => {
  it('a secret saved in one tenant cannot be read in another', () => {
    const { runAsTenant } = require('../core/tenantContext');
    const { encrypt, decrypt } = require('../services/encryption');
    const sealed = runAsTenant('wayne', () => encrypt('s3cret'));
    expect(runAsTenant('wayne', () => decrypt(sealed))).toBe('s3cret');
    expect(() => runAsTenant('default', () => decrypt(sealed))).toThrow();
    tenants.createTenant({ id: 'stark', name: 'Stark' });
    expect(() => runAsTenant('stark', () => decrypt(sealed))).toThrow();
    const plain = runAsTenant('default', () => encrypt('master'));
    expect(runAsTenant('default', () => decrypt(plain))).toBe('master');
  });
});

describe('a licence per tenant and suspension', () => {
  it('a new tenant has no licence of its own; the default tenant keeps the install key', () => {
    const { runAsTenant } = require('../core/tenantContext');
    const { getLicenseStatus } = require('../services/license');
    expect(runAsTenant('stark', () => getLicenseStatus().state)).toBe('missing');
    expect(['missing', 'valid', 'grace', 'invalid']).toContain(runAsTenant('default', () => getLicenseStatus().state));
  });

  it('suspending a tenant locks its members to the licence page, lets a global admin in, and stops its worker', async () => {
    const put = await agent.put('/api/t/default/tenants/wayne').set('x-csrf-token', csrf).send({ status: 'suspended' });
    expect(put.status).toBe(200);
    expect(put.body.status).toBe('suspended');

    const bruce = request.agent(app);
    await bruce.post('/api/auth/login').send({ username: 'bruce', password: 'bat-pw' });
    const locked = await bruce.get('/api/t/wayne/pure/arrays');
    expect(locked.status).toBe(403);
    expect(locked.body).toMatchObject({ error: 'license_required', state: 'suspended' });
    expect((await bruce.get('/api/t/wayne/license/status')).body.state).toBe('suspended');
    expect((await agent.get('/api/t/wayne/pure/arrays')).status).toBe(200);

    const { createSupervisor } = require('../core/pollerSupervisor');
    const spawned = [];
    const sup = createSupervisor({ spawn: (s, id) => { spawned.push(id); return { pid: 1, on() {}, kill() {} }; }, rescanMs: 3600000, isLicensed: () => true }).run();
    expect(spawned).not.toContain('wayne');
    sup.stopAll();

    expect((await agent.put('/api/t/default/tenants/default').set('x-csrf-token', csrf).send({ status: 'suspended' })).status).toBe(400);
    expect((await agent.put('/api/t/default/tenants/wayne').set('x-csrf-token', csrf).send({ status: 'active' })).status).toBe(200);
    expect((await bruce.get('/api/t/wayne/pure/arrays')).status).toBe(200);
    expect(accounts.listAudit({ tenantId: 'wayne' }).map((e) => e.action)).toEqual(expect.arrayContaining(['tenant.suspended', 'tenant.resumed', 'tenant.created', 'member.added']));
  });
});
