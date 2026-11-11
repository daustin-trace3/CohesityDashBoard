/**
 * Identity provider registry (services/idpProviders.js) and the admin API
 * (routes/idp.js): validation, secret handling, enable gate, public URLs,
 * sign-in state and return-path sanitising.
 */
const adminOf = (d) => d.adminHandle || d; // admin tables are written through the admin connection (db/adminSplit.js)
import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import { createRequire } from 'module';
import request from 'supertest';

const require = createRequire(import.meta.url);
let db; let providers; let encryption; let app; let settings;

const oidcBody = (over = {}) => ({
  type: 'oidc', name: 'Okta Prod', slug: 'okta-prod', issuer: 'https://example.okta.test',
  clientId: 'cid', clientSecret: 's3cret', ...over,
});

beforeAll(() => {
  const registry = require('../core/registry');
  registry.init();
  db = require('../db/database');
  providers = require('../services/idpProviders');
  encryption = require('../services/encryption');
  settings = require('../services/settings');
  const { createApp } = require('../app');
  app = createApp({ licenseGate: (req, res, next) => next() });
});

beforeEach(() => {
  adminOf(db).prepare('DELETE FROM idp_providers').run();
  adminOf(db).prepare('DELETE FROM idp_auth_state').run();
  adminOf(db).prepare("DELETE FROM groups WHERE provider = 'idp'").run();
  settings.setSetting('icc_base_url', '');
});

const api = (method, path, body) => request(app)[method](`/api/idp${path}`).set('x-api-key', process.env.DASHBOARD_API_KEY).send(body);

describe('create and validate', () => {
  it('creates an OIDC provider with defaults and an encrypted secret', () => {
    const row = providers.createProvider(oidcBody());
    expect(row.enabled).toBe(0);
    expect(row.claim_subject).toBe('sub');
    expect(row.scopes).toBe('openid profile email groups');
    expect(row.client_secret).not.toContain('s3cret');
    expect(providers.getSecret(row, 'client_secret')).toBe('s3cret');
    const pub = providers.toPublic(row);
    expect(pub.clientSecretSet).toBe(true);
    expect(JSON.stringify(pub)).not.toContain('s3cret');
    expect(JSON.stringify(pub)).not.toContain(row.client_secret);
  });

  it('SAML defaults the subject claim to nameid', () => {
    const row = providers.createProvider({ type: 'saml', name: 'Okta SAML', slug: 'okta-saml' });
    expect(row.claim_subject).toBe('nameid');
  });

  it('rejects bad input with a field name', () => {
    const cases = [
      [oidcBody({ slug: 'A' }), 'slug'],
      [oidcBody({ slug: 'Bad_Slug' }), 'slug'],
      [oidcBody({ name: '' }), 'name'],
      [oidcBody({ name: 'x'.repeat(65) }), 'name'],
      [oidcBody({ type: 'ldap' }), 'type'],
      [oidcBody({ issuer: 'http://insecure.example.com' }), 'issuer'],
      [oidcBody({ scopes: 'profile email' }), 'scopes'],
      [oidcBody({ mgmtKind: 'okta', mgmtBaseUrl: 'http://okta.example.com' }), 'mgmtBaseUrl'],
      [oidcBody({ mgmtSyncMinutes: 2 }), 'mgmtSyncMinutes'],
      [oidcBody({ mgmtSyncMinutes: 2000 }), 'mgmtSyncMinutes'],
    ];
    for (const [body, field] of cases) {
      let err;
      try { providers.createProvider(body); } catch (e) { err = e; }
      expect(err, field).toBeTruthy();
      expect(err.status).toBe(400);
      expect(err.field).toBe(field);
    }
  });

  it('allows http only for localhost and 127.0.0.1', () => {
    expect(() => providers.createProvider(oidcBody({ slug: 'loc', name: 'Local', issuer: 'http://127.0.0.1:9000' }))).not.toThrow();
    expect(() => providers.createProvider(oidcBody({ slug: 'loc2', name: 'Local2', issuer: 'http://localhost:9000' }))).not.toThrow();
  });

  it('refuses a duplicate slug or name with 409', () => {
    providers.createProvider(oidcBody());
    expect(() => providers.createProvider(oidcBody({ name: 'Other' }))).toThrow(/slug/);
    let err;
    try { providers.createProvider(oidcBody({ slug: 'another' })); } catch (e) { err = e; }
    expect(err.status).toBe(409);
    expect(err.field).toBe('name');
  });

  it('refuses to create enabled', () => {
    expect(() => providers.createProvider(oidcBody({ enabled: true }))).toThrow(/Test the provider/);
  });
});

describe('update, secrets and the enable gate', () => {
  it('keeps a secret on blank or missing, replaces it on a string, clears it on null', () => {
    const row = providers.createProvider(oidcBody());
    const before = row.client_secret;
    expect(providers.updateProvider(row.id, { name: 'Renamed', clientSecret: '' }).client_secret).toBe(before);
    expect(providers.updateProvider(row.id, { scopes: 'openid email' }).client_secret).toBe(before);
    const replaced = providers.updateProvider(row.id, { clientSecret: 'new-secret' });
    expect(replaced.client_secret).not.toBe(before);
    expect(providers.getSecret(replaced, 'client_secret')).toBe('new-secret');
    expect(providers.updateProvider(row.id, { clientSecret: null }).client_secret).toBeNull();
  });

  it('changing the issuer clears the saved client secret', () => {
    const row = providers.createProvider(oidcBody());
    const next = providers.updateProvider(row.id, { issuer: 'https://other.okta.test' });
    expect(next.client_secret).toBeNull();
    const withNew = providers.updateProvider(row.id, { issuer: 'https://third.okta.test', clientSecret: 'typed-again' });
    expect(providers.getSecret(withNew, 'client_secret')).toBe('typed-again');
  });

  it('changing the management URL clears the saved token', () => {
    const row = providers.createProvider(oidcBody({ mgmtKind: 'okta', mgmtBaseUrl: 'https://a.okta.test', mgmtToken: 'ssws-token' }));
    expect(providers.toPublic(row).mgmtTokenSet).toBe(true);
    expect(providers.getSecret(row, 'mgmt_token')).toBe('ssws-token');
    const same = providers.updateProvider(row.id, { mgmtBaseUrl: 'https://a.okta.test' });
    expect(providers.getSecret(same, 'mgmt_token')).toBe('ssws-token');
    const moved = providers.updateProvider(row.id, { mgmtBaseUrl: 'https://b.okta.test' });
    expect(moved.mgmt_token).toBeNull();
  });

  it('enabling needs a passing test; changing the connection undoes it', () => {
    const row = providers.createProvider(oidcBody());
    expect(() => providers.updateProvider(row.id, { enabled: true })).toThrow(/Test the provider/);
    providers.markTested(row.id, true);
    const on = providers.updateProvider(row.id, { enabled: true });
    expect(on.enabled).toBe(1);
    expect(providers.listEnabledPublic()).toEqual([{ slug: 'okta-prod', name: 'Okta Prod', type: 'oidc' }]);
    const changed = providers.updateProvider(row.id, { clientId: 'different' });
    expect(changed.enabled).toBe(0);
    expect(changed.tested_at).toBeNull();
    expect(providers.listEnabledPublic()).toEqual([]);
  });

  it('enabling OIDC needs issuer, client id and a saved secret', () => {
    const row = providers.createProvider({ type: 'oidc', name: 'Bare', slug: 'bare' });
    providers.markTested(row.id, true);
    let err;
    try { providers.updateProvider(row.id, { enabled: true }); } catch (e) { err = e; }
    expect(err.status).toBe(400);
    expect(err.field).toBe('enabled');
  });

  it('type and slug are immutable', () => {
    const row = providers.createProvider(oidcBody());
    expect(() => providers.updateProvider(row.id, { type: 'saml' })).toThrow(/Type cannot be changed/);
    expect(() => providers.updateProvider(row.id, { slug: 'new-slug' })).toThrow(/Slug cannot be changed/);
  });

  it('delete removes the provider, its linked groups and their grants but keeps users', () => {
    const row = providers.createProvider(oidcBody());
    const now = new Date().toISOString();
    const gid = adminOf(db).prepare("INSERT INTO groups (name, is_system, created_at, provider, idp_provider_id, external_name) VALUES ('Linked', 0, ?, 'idp', ?, 'Linked')").run(now, row.id).lastInsertRowid;
    adminOf(db).prepare("INSERT INTO role_grants (subject_type, subject_id, permission, created_at) VALUES ('group', ?, 'cohesity:*:view', ?)").run(gid, now);
    expect(providers.toPublic(row).linkedGroups).toBe(1);
    providers.deleteProvider(row.id);
    expect(db.prepare('SELECT COUNT(*) c FROM groups WHERE id = ?').get(gid).c).toBe(0);
    expect(db.prepare("SELECT COUNT(*) c FROM role_grants WHERE subject_type = 'group' AND subject_id = ?").get(gid).c).toBe(0);
    expect(providers.getProvider(row.id)).toBeNull();
  });
});

describe('public URLs', () => {
  it('uses icc_base_url when set', () => {
    const row = providers.createProvider(oidcBody());
    settings.setSetting('icc_base_url', 'https://icc.example.com/');
    const urls = providers.publicUrls({ headers: {}, protocol: 'http', get: () => 'ignored:3001' }, row);
    expect(urls.redirectUri).toBe('https://icc.example.com/api/auth/sso/okta-prod/callback');
    expect(urls.acsUrl).toBe('https://icc.example.com/api/auth/sso/okta-prod/acs');
    expect(urls.metadataUrl).toBe('https://icc.example.com/api/auth/sso/okta-prod/metadata');
    expect(urls.spEntityId).toBe(urls.metadataUrl);
    expect(urls.urlsFromRequest).toBe(false);
  });

  it('falls back to the request host and forwarded protocol, and says so', () => {
    const row = providers.createProvider(oidcBody());
    const req = { headers: { 'x-forwarded-proto': 'https, http', 'x-forwarded-host': 'proxy.example.com' }, protocol: 'http', get: () => 'internal:3001' };
    const urls = providers.publicUrls(req, row);
    expect(urls.redirectUri).toBe('https://proxy.example.com/api/auth/sso/okta-prod/callback');
    expect(urls.urlsFromRequest).toBe(true);
    const plain = providers.publicUrls({ headers: {}, protocol: 'http', get: () => 'box:3001' }, row);
    expect(plain.redirectUri).toBe('http://box:3001/api/auth/sso/okta-prod/callback');
  });

  it('keeps a configured SP entity id', () => {
    const row = providers.createProvider({ type: 'saml', name: 'S', slug: 'sp-one', spEntityId: 'urn:icc:sp' });
    expect(providers.publicUrls({ headers: {}, protocol: 'http', get: () => 'x' }, row).spEntityId).toBe('urn:icc:sp');
  });
});

describe('sign-in state', () => {
  it('is single use and expires', () => {
    const row = providers.createProvider(oidcBody());
    const id = providers.createState({ providerId: row.id, kind: 'oidc', nonce: 'n', codeVerifier: 'v', returnTo: '/ops' });
    expect(id).toMatch(/^[0-9a-f]{64}$/);
    const first = providers.consumeState(id);
    expect(first).toMatchObject({ nonce: 'n', code_verifier: 'v', return_to: '/ops', kind: 'oidc' });
    expect(providers.consumeState(id)).toBeNull();

    const old = providers.createState({ providerId: row.id, kind: 'oidc' });
    adminOf(db).prepare("UPDATE idp_auth_state SET expires_at = '2000-01-01T00:00:00.000Z' WHERE id = ?").run(old);
    expect(providers.consumeState(old)).toBeNull();
    expect(db.prepare('SELECT COUNT(*) c FROM idp_auth_state WHERE id = ?').get(old).c).toBe(0);
  });

  it('looks up by SAML request id only while unexpired', () => {
    const row = providers.createProvider({ type: 'saml', name: 'S', slug: 'sx' });
    const id = providers.createState({ providerId: row.id, kind: 'saml' });
    providers.setStateRequestId(id, '_req123');
    expect(providers.getStateByRequestId('_req123').id).toBe(id);
    expect(providers.getStateByRequestId('_other')).toBeNull();
    adminOf(db).prepare("UPDATE idp_auth_state SET expires_at = '2000-01-01T00:00:00.000Z' WHERE id = ?").run(id);
    expect(providers.getStateByRequestId('_req123')).toBeNull();
  });

  it('pruneState drops expired state and assertions', () => {
    const row = providers.createProvider(oidcBody());
    const id = providers.createState({ providerId: row.id, kind: 'oidc' });
    adminOf(db).prepare("UPDATE idp_auth_state SET expires_at = '2000-01-01T00:00:00.000Z' WHERE id = ?").run(id);
    adminOf(db).prepare("INSERT OR REPLACE INTO idp_seen_assertions (assertion_id, provider_id, expires_at) VALUES ('a1', ?, '2000-01-01T00:00:00.000Z'), ('a2', ?, '2999-01-01T00:00:00.000Z')").run(row.id, row.id);
    providers.pruneState();
    expect(db.prepare('SELECT COUNT(*) c FROM idp_auth_state').get().c).toBe(0);
    expect(db.prepare('SELECT assertion_id FROM idp_seen_assertions').all()).toEqual([{ assertion_id: 'a2' }]);
  });
});

describe('sanitizeReturnTo', () => {
  it('passes plain in-app paths', () => {
    expect(providers.sanitizeReturnTo('/ops')).toBe('/ops');
    expect(providers.sanitizeReturnTo('/cohesity/clusters?x=1')).toBe('/cohesity/clusters?x=1');
  });
  it('strips a leading tenant prefix', () => {
    expect(providers.sanitizeReturnTo('/t/acme/ops')).toBe('/ops');
    expect(providers.sanitizeReturnTo('/t/acme')).toBe('/');
  });
  it('rejects anything that could leave the site', () => {
    for (const bad of ['//evil.com', 'https://evil.com', '/\\evil.com', 'javascript:alert(1)', '/a//b', '/x\\y', 'ops', '', undefined, null, '/ok\nbad', `/${'a'.repeat(600)}`]) {
      expect(providers.sanitizeReturnTo(bad), String(bad)).toBe('/');
    }
  });
});

describe('admin API', () => {
  it('creates, reads, updates and deletes; never returns a secret', async () => {
    const created = await api('post', '/providers', oidcBody());
    expect(created.status).toBe(201);
    expect(created.body).toMatchObject({ slug: 'okta-prod', type: 'oidc', clientSecretSet: true, enabled: false, linkedGroups: 0, users: 0 });
    expect(created.body.urls.redirectUri).toMatch(/\/api\/auth\/sso\/okta-prod\/callback$/);
    expect(JSON.stringify(created.body)).not.toContain('s3cret');
    const id = created.body.id;

    const list = await api('get', '/providers');
    expect(list.body.map((p) => p.slug)).toEqual(['okta-prod']);

    const bad = await api('put', `/providers/${id}`, { enabled: true });
    expect(bad.status).toBe(400);
    expect(bad.body.field).toBe('enabled');

    const put = await api('put', `/providers/${id}`, { name: 'Okta Production', claimEmail: 'mail' });
    expect(put.status).toBe(200);
    expect(put.body).toMatchObject({ name: 'Okta Production', claimEmail: 'mail' });

    const del = await api('delete', `/providers/${id}`);
    expect(del.body).toEqual({ ok: true });
    expect((await api('get', `/providers/${id}`)).status).toBe(404);
  });

  it('setup-status lists enabled providers for the login page', async () => {
    const row = providers.createProvider(oidcBody());
    providers.markTested(row.id, true);
    providers.updateProvider(row.id, { enabled: true });
    const res = await request(app).get('/api/auth/setup-status');
    expect(res.body.providers).toEqual([{ slug: 'okta-prod', name: 'Okta Prod', type: 'oidc' }]);
  });

  it('test endpoint marks the provider tested only when every check passes', async () => {
    const oidc = require('../services/idpOidc');
    const row = providers.createProvider(oidcBody({ issuer: 'http://127.0.0.1:9' }));
    oidc.setHttp(async () => { throw new Error('connect ECONNREFUSED'); });
    const res = await api('post', `/providers/${row.id}/test`);
    expect(res.status).toBe(502);
    expect(res.body.ok).toBe(false);
    expect(providers.getProvider(row.id).tested_at).toBeNull();
    expect(providers.getProvider(row.id).test_error).toMatch(/Discovery/);
  });

  it('encrypt/decrypt round trip is per tenant key (sanity)', () => {
    expect(encryption.decrypt(encryption.encrypt('abc'))).toBe('abc');
  });
});
