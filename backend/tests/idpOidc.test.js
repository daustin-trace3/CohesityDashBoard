/**
 * OIDC sign-in end to end through the app: discovery, authorization URL,
 * callback with a jose-signed ID token served by a fake IdP (the http() seam),
 * access rules (linked groups, pinned users, inactive, JIT) and username
 * clashes. No network is used.
 */
const adminOf = (d) => d.adminHandle || d; // admin tables are written through the admin connection (db/adminSplit.js)
import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import { createRequire } from 'module';
import request from 'supertest';

const require = createRequire(import.meta.url);

const ISSUER = 'https://dev-1.okta.test';
const CLIENT_ID = 'icc-client';
const SLUG = 'okta-test';

let db; let providers; let provision; let oidc; let app;
let jose; let keys; let otherKeys; let provider;
let httpLog;
let idTokenClaims;     // extra claims merged into the id token for the next callback
let userinfoClaims;    // userinfo answer
let tokenStatus;
let signWith;

async function makeKey(kid) {
  const { publicKey, privateKey } = await jose.generateKeyPair('RS256', { extractable: true });
  const jwk = await jose.exportJWK(publicKey);
  return { privateKey, jwk: { ...jwk, kid, alg: 'RS256', use: 'sig' }, kid };
}

async function signIdToken(key, claims) {
  return new jose.SignJWT(claims)
    .setProtectedHeader({ alg: 'RS256', kid: key.kid })
    .setIssuedAt()
    .setExpirationTime('5m')
    .sign(key.privateKey);
}

function fakeIdp() {
  oidc.setHttp(async ({ method = 'GET', url, headers, data }) => {
    httpLog.push({ method, url, headers, data });
    if (url === `${ISSUER}/.well-known/openid-configuration`) {
      return {
        status: 200, headers: {},
        data: {
          issuer: ISSUER, authorization_endpoint: `${ISSUER}/oauth2/v1/authorize`, token_endpoint: `${ISSUER}/oauth2/v1/token`,
          jwks_uri: `${ISSUER}/oauth2/v1/keys`, userinfo_endpoint: `${ISSUER}/oauth2/v1/userinfo`,
        },
      };
    }
    if (url === `${ISSUER}/oauth2/v1/keys`) return { status: 200, headers: {}, data: { keys: [keys.jwk] } };
    if (url === `${ISSUER}/oauth2/v1/token`) {
      if (tokenStatus !== 200) return { status: tokenStatus, headers: {}, data: { error: 'invalid_grant' } };
      const form = new URLSearchParams(data);
      const claims = {
        iss: ISSUER, aud: CLIENT_ID, sub: '00uAAA', email: 'carol@example.com', name: 'Carol Chen',
        preferred_username: 'carol', groups: ['ICC Admins'], nonce: httpLog.nonce, ...idTokenClaims,
      };
      for (const k of Object.keys(claims)) if (claims[k] === undefined) delete claims[k];
      httpLog.tokenForm = Object.fromEntries(form);
      return { status: 200, headers: {}, data: { access_token: 'at-1', token_type: 'Bearer', id_token: await signIdToken(signWith || keys, claims) } };
    }
    if (url === `${ISSUER}/oauth2/v1/userinfo`) return { status: 200, headers: {}, data: userinfoClaims || {} };
    return { status: 404, headers: {}, data: {} };
  });
}

/** Run /start and return { stateId, nonce, location }. */
async function start(returnTo) {
  const q = returnTo ? `?returnTo=${encodeURIComponent(returnTo)}` : '';
  const res = await request(app).get(`/api/auth/sso/${SLUG}/start${q}`);
  expect(res.status).toBe(302);
  const loc = new URL(res.headers.location);
  httpLog.nonce = loc.searchParams.get('nonce');
  return { res, loc, stateId: loc.searchParams.get('state'), nonce: loc.searchParams.get('nonce') };
}

async function callback(agentOrApp, stateId, extra = '') {
  return (agentOrApp || request(app)).get(`/api/auth/sso/${SLUG}/callback?code=abc123&state=${stateId}${extra}`);
}

function linkGroup(name, externalName) {
  const now = new Date().toISOString();
  return adminOf(db).prepare("INSERT INTO groups (name, is_system, created_at, provider, idp_provider_id, external_name) VALUES (?, 0, ?, 'idp', ?, ?)")
    .run(name, now, provider.id, externalName).lastInsertRowid;
}

beforeAll(async () => {
  jose = await import('jose');
  keys = await makeKey('k1');
  otherKeys = await makeKey('k1');
  const registry = require('../core/registry');
  registry.init();
  db = require('../db/database');
  providers = require('../services/idpProviders');
  provision = require('../services/idpProvision');
  oidc = require('../services/idpOidc');
  const { createApp } = require('../app');
  app = createApp({ licenseGate: (req, res, next) => next() });
});

beforeEach(() => {
  httpLog = [];
  idTokenClaims = {};
  userinfoClaims = null;
  tokenStatus = 200;
  signWith = null;
  adminOf(db).prepare('DELETE FROM user_groups').run();
  adminOf(db).prepare("DELETE FROM users WHERE idp_provider_id IS NOT NULL OR auth_provider IN ('oidc','saml')").run();
  adminOf(db).prepare("DELETE FROM users WHERE username IN ('carol', 'carol#okta-test')").run();
  adminOf(db).prepare("DELETE FROM groups WHERE provider = 'idp'").run();
  adminOf(db).prepare('DELETE FROM idp_auth_state').run();
  adminOf(db).prepare('DELETE FROM idp_providers').run();
  adminOf(db).prepare('DELETE FROM auth_sessions').run();
  provider = providers.createProvider({ type: 'oidc', name: 'Okta Test', slug: SLUG, issuer: ISSUER, clientId: CLIENT_ID, clientSecret: 'the-secret' });
  providers.markTested(provider.id, true);
  provider = providers.updateProvider(provider.id, { enabled: true });
  fakeIdp();
});

describe('start', () => {
  it('redirects to the authorization endpoint with PKCE, state and nonce', async () => {
    const { loc, stateId, nonce } = await start('/cohesity/clusters');
    expect(`${loc.origin}${loc.pathname}`).toBe(`${ISSUER}/oauth2/v1/authorize`);
    const p = loc.searchParams;
    expect(p.get('response_type')).toBe('code');
    expect(p.get('client_id')).toBe(CLIENT_ID);
    expect(p.get('redirect_uri')).toMatch(/\/api\/auth\/sso\/okta-test\/callback$/);
    expect(p.get('scope')).toBe('openid profile email groups');
    expect(p.get('code_challenge_method')).toBe('S256');
    expect(p.get('code_challenge')).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(stateId).toMatch(/^[0-9a-f]{64}$/);
    expect(nonce).toMatch(/^[0-9a-f]{32}$/);
    const row = db.prepare('SELECT * FROM idp_auth_state WHERE id = ?').get(stateId);
    expect(row).toMatchObject({ kind: 'oidc', nonce, return_to: '/cohesity/clusters' });
  });

  it('caches the discovery document for 24 hours', async () => {
    await start();
    await start();
    expect(httpLog.filter((c) => c.url.endsWith('/.well-known/openid-configuration')).length).toBe(1);
    expect(providers.getProvider(provider.id).discovery_json).toContain('authorization_endpoint');
    adminOf(db).prepare("UPDATE idp_providers SET discovery_at = '2000-01-01T00:00:00.000Z' WHERE id = ?").run(provider.id);
    await start();
    expect(httpLog.filter((c) => c.url.endsWith('/.well-known/openid-configuration')).length).toBe(2);
  });

  it('answers 404 sso_provider for an unknown or disabled slug', async () => {
    expect((await request(app).get('/api/auth/sso/nope/start')).status).toBe(404);
    adminOf(db).prepare('UPDATE idp_providers SET enabled = 0 WHERE id = ?').run(provider.id);
    const res = await request(app).get(`/api/auth/sso/${SLUG}/start`);
    expect(res.status).toBe(404);
    expect(res.body.error).toBe('sso_provider');
  });

  it('a discovery issuer mismatch fails the start with a login error', async () => {
    oidc.setHttp(async ({ url }) => (url.endsWith('openid-configuration')
      ? { status: 200, headers: {}, data: { issuer: 'https://evil.test', authorization_endpoint: 'https://evil.test/a', token_endpoint: 'https://evil.test/t', jwks_uri: 'https://evil.test/k' } }
      : { status: 404, headers: {}, data: {} }));
    const res = await request(app).get(`/api/auth/sso/${SLUG}/start`);
    expect(res.status).toBe(302);
    expect(res.headers.location).toBe('/login?error=sso_provider');
  });
});

describe('callback', () => {
  it('signs a user in, creates the account and sets the memberships', async () => {
    const gid = linkGroup('Okta ICC Admins', 'ICC Admins');
    adminOf(db).prepare("INSERT INTO role_grants (subject_type, subject_id, permission, created_at) VALUES ('group', ?, 'cohesity:*:view', ?)").run(gid, new Date().toISOString());
    const agent = request.agent(app);
    const { stateId } = await start('/cohesity/clusters');
    const res = await callback(agent, stateId);
    expect(res.status).toBe(302);
    expect(res.headers.location).toBe('/cohesity/clusters');
    expect(res.headers['set-cookie'].join(';')).toContain('icc_session=');

    // The token request: form encoded, PKCE verifier, Basic client auth.
    const form = httpLog.tokenForm;
    expect(form).toMatchObject({ grant_type: 'authorization_code', code: 'abc123' });
    expect(form.code_verifier).toMatch(/^[A-Za-z0-9_-]{43}$/);
    const tokenCall = httpLog.find((c) => c.url.endsWith('/token'));
    expect(tokenCall.headers.Authorization).toBe(`Basic ${Buffer.from(`${CLIENT_ID}:the-secret`).toString('base64')}`);

    const user = db.prepare("SELECT * FROM users WHERE username = 'carol'").get();
    expect(user).toMatchObject({ auth_provider: 'oidc', email: 'carol@example.com', display_name: 'Carol Chen', idp_provider_id: provider.id, is_active: 1 });
    expect(user.external_id).toBe(`idp:${ISSUER}:00uAAA`);
    expect(db.prepare('SELECT group_id, source FROM user_groups WHERE user_id = ?').all(user.id)).toEqual([{ group_id: gid, source: 'idp' }]);
    expect(db.prepare("SELECT auth_provider, password_hash FROM users WHERE username = 'carol'").get()).toEqual({ auth_provider: 'oidc', password_hash: '!sso' });

    const session = await agent.get('/api/auth/session');
    expect(session.status).toBe(200);
    expect(session.body.user.username).toBe('carol');
    expect(session.body.user.permissions).toContain('cohesity:*:view');
  });

  it('a second login finds the same account and replaces idp memberships', async () => {
    const a = linkGroup('Okta A', 'Group A');
    const b = linkGroup('Okta B', 'Group B');
    idTokenClaims = { groups: ['Group A'] };
    let s = await start();
    expect((await callback(null, s.stateId)).status).toBe(302);
    idTokenClaims = { groups: ['group b'] };
    s = await start();
    expect((await callback(null, s.stateId)).headers.location).toBe('/');
    expect(db.prepare("SELECT COUNT(*) c FROM users WHERE username = 'carol'").get().c).toBe(1);
    const uid = db.prepare("SELECT id FROM users WHERE username = 'carol'").get().id;
    expect(db.prepare('SELECT group_id FROM user_groups WHERE user_id = ?').all(uid).map((r) => r.group_id)).toEqual([b]);
    expect(a).not.toBe(b);
  });

  it('wrong nonce -> sso_idtoken and no session', async () => {
    linkGroup('Okta ICC Admins', 'ICC Admins');
    const s = await start();
    idTokenClaims = { nonce: 'not-the-nonce' };
    const res = await callback(null, s.stateId);
    expect(res.headers.location).toBe('/login?error=sso_idtoken');
    expect(res.headers['set-cookie']).toBeUndefined();
    expect(db.prepare("SELECT COUNT(*) c FROM users WHERE username = 'carol'").get().c).toBe(0);
  });

  it('an ID token signed by another key, or for another audience, is refused', async () => {
    linkGroup('Okta ICC Admins', 'ICC Admins');
    let s = await start();
    signWith = otherKeys;
    expect((await callback(null, s.stateId)).headers.location).toBe('/login?error=sso_idtoken');
    signWith = null;
    s = await start();
    idTokenClaims = { aud: 'someone-else' };
    expect((await callback(null, s.stateId)).headers.location).toBe('/login?error=sso_idtoken');
  });

  it('missing, unknown, expired and reused state -> sso_state', async () => {
    linkGroup('Okta ICC Admins', 'ICC Admins');
    expect((await request(app).get(`/api/auth/sso/${SLUG}/callback?code=x`)).headers.location).toBe('/login?error=sso_state');
    expect((await callback(null, 'f'.repeat(64))).headers.location).toBe('/login?error=sso_state');

    let s = await start();
    adminOf(db).prepare("UPDATE idp_auth_state SET expires_at = '2000-01-01T00:00:00.000Z' WHERE id = ?").run(s.stateId);
    expect((await callback(null, s.stateId)).headers.location).toBe('/login?error=sso_state');

    s = await start();
    expect((await callback(null, s.stateId)).status).toBe(302);
    expect((await callback(null, s.stateId)).headers.location).toBe('/login?error=sso_state');
  });

  it('an error from the IdP -> sso_token', async () => {
    const s = await start();
    const res = await request(app).get(`/api/auth/sso/${SLUG}/callback?error=access_denied&error_description=nope&state=${s.stateId}`);
    expect(res.headers.location).toBe('/login?error=sso_token');
  });

  it('a refused token exchange -> sso_token', async () => {
    const s = await start();
    tokenStatus = 400;
    expect((await callback(null, s.stateId)).headers.location).toBe('/login?error=sso_token');
  });

  it('an unreachable IdP -> sso_unavailable', async () => {
    const s = await start();
    oidc.setHttp(async () => { throw new Error('ECONNREFUSED'); });
    // discovery is cached, so the failure comes from the token call
    expect((await callback(null, s.stateId)).headers.location).toBe('/login?error=sso_unavailable');
  });

  it('no linked group -> sso_no_access and no user is created', async () => {
    linkGroup('Okta Other', 'Some Other Group');
    const s = await start();
    const res = await callback(null, s.stateId);
    expect(res.headers.location).toBe('/login?error=sso_no_access');
    expect(res.headers['set-cookie']).toBeUndefined();
    expect(db.prepare("SELECT COUNT(*) c FROM users WHERE username = 'carol'").get().c).toBe(0);
  });

  it('a pinned user signs in with no matching group', async () => {
    const viewer = db.prepare("SELECT id FROM groups WHERE name = 'Viewer'").get();
    provision.importUser(provider, { subject: '00uAAA', email: 'carol@example.com', username: 'carol', displayName: 'Carol Chen', groups: [], groupIds: [], active: true }, [viewer.id]);
    idTokenClaims = { groups: [] };
    const agent = request.agent(app);
    const s = await start();
    const res = await callback(agent, s.stateId);
    expect(res.headers.location).toBe('/');
    expect((await agent.get('/api/auth/session')).body.user.username).toBe('carol');
    expect(db.prepare("SELECT directory_pinned FROM users WHERE username = 'carol'").get().directory_pinned).toBe(1);
  });

  it('an imported user (email only) is matched by email at first sign-in', async () => {
    const viewer = db.prepare("SELECT id FROM groups WHERE name = 'Viewer'").get();
    provision.importUser(provider, { subject: 'carol@example.com', email: 'carol@example.com', username: 'carol@example.com', groups: [], groupIds: [], active: true }, [viewer.id]);
    idTokenClaims = { groups: [], email: 'Carol@Example.com' };
    const s = await start();
    expect((await callback(null, s.stateId)).headers.location).toBe('/');
    expect(db.prepare("SELECT COUNT(*) c FROM users WHERE idp_provider_id = ?").get(provider.id).c).toBe(1);
  });

  it('a username that belongs to a local account becomes <name>#<slug>', async () => {
    const now = new Date().toISOString();
    adminOf(db).prepare("INSERT INTO users (username, password_hash, display_name, auth_provider, created_at, updated_at) VALUES ('carol', 'localhash', 'Local Carol', 'local', ?, ?)").run(now, now);
    linkGroup('Okta ICC Admins', 'ICC Admins');
    const s = await start();
    expect((await callback(null, s.stateId)).headers.location).toBe('/');
    expect(db.prepare("SELECT auth_provider FROM users WHERE username = 'carol'").get()).toEqual({ auth_provider: 'local' });
    expect(db.prepare("SELECT auth_provider, idp_provider_id FROM users WHERE username = 'carol#okta-test'").get()).toEqual({ auth_provider: 'oidc', idp_provider_id: provider.id });
    expect(db.prepare("SELECT password_hash FROM users WHERE username = 'carol'").get().password_hash).toBe('localhash');
  });

  it('an inactive user is refused: sso_inactive', async () => {
    linkGroup('Okta ICC Admins', 'ICC Admins');
    let s = await start();
    expect((await callback(null, s.stateId)).headers.location).toBe('/');
    adminOf(db).prepare("UPDATE users SET is_active = 0 WHERE username = 'carol'").run();
    s = await start();
    expect((await callback(null, s.stateId)).headers.location).toBe('/login?error=sso_inactive');
  });

  it('JIT off and no existing user -> sso_jit_disabled', async () => {
    linkGroup('Okta ICC Admins', 'ICC Admins');
    adminOf(db).prepare('UPDATE idp_providers SET jit_enabled = 0 WHERE id = ?').run(provider.id);
    const s = await start();
    expect((await callback(null, s.stateId)).headers.location).toBe('/login?error=sso_jit_disabled');
    expect(db.prepare("SELECT COUNT(*) c FROM users WHERE username = 'carol'").get().c).toBe(0);
  });

  it('reads groups from userinfo when the ID token has none', async () => {
    linkGroup('Okta ICC Admins', 'ICC Admins');
    idTokenClaims = { groups: undefined };
    userinfoClaims = { sub: '00uAAA', groups: ['ICC Admins', 'Everyone'] };
    const s = await start();
    expect((await callback(null, s.stateId)).headers.location).toBe('/');
    const userinfoCall = httpLog.find((c) => c.url.endsWith('/userinfo'));
    expect(userinfoCall.headers.Authorization).toBe('Bearer at-1');
    const uid = db.prepare("SELECT id FROM users WHERE username = 'carol'").get().id;
    expect(db.prepare('SELECT COUNT(*) c FROM user_groups WHERE user_id = ?').get(uid).c).toBe(1);
  });

  it('a return path that tries to leave the site falls back to /', async () => {
    linkGroup('Okta ICC Admins', 'ICC Admins');
    const s = await start('//evil.example.com/x');
    expect((await callback(null, s.stateId)).headers.location).toBe('/');
  });
});

describe('mapIdentity and testProvider', () => {
  it('maps claims by the configured claim names and normalises groups', () => {
    const row = { claim_subject: 'uid', claim_email: 'mail', claim_name: 'cn', claim_groups: 'roles' };
    const id = oidc.mapIdentity(row, { uid: 'u1', mail: 'a@b.test', cn: 'Ann', roles: 'solo', preferred_username: 'ann' });
    expect(id).toEqual({ subject: 'u1', email: 'a@b.test', username: 'ann', displayName: 'Ann', groups: ['solo'], groupIds: [], active: true });
    expect(oidc.mapIdentity({ ...row, claim_groups: 'x' }, { uid: 'u1' }).groups).toEqual([]);
  });

  it('testProvider reports each check', async () => {
    const ok = await oidc.testProvider(providers.getProvider(provider.id));
    expect(ok.ok).toBe(true);
    expect(ok.checks.map((c) => c.name)).toEqual(['Client ID', 'Client secret', 'Discovery', 'Signing keys']);
    adminOf(db).prepare('UPDATE idp_providers SET client_secret = NULL WHERE id = ?').run(provider.id);
    const bad = await oidc.testProvider(providers.getProvider(provider.id));
    expect(bad.ok).toBe(false);
    expect(bad.checks.find((c) => c.name === 'Client secret').ok).toBe(false);
  });
});
