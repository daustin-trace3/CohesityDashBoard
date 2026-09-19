/**
 * Credential forwarding contract (R1 to R6) for Aria Automation, Aria
 * Operations and Zerto host routers.
 * A saved password only ever travels to the address it was saved for.
 *
 * No test here opens a socket: the routers' outbound call is replaced on the
 * client module object, and the client-level tests replace axios and assert
 * on what the wire would have received.
 */
import { describe, it, expect, beforeAll, beforeEach, afterEach, vi } from 'vitest';
import { createRequire } from 'module';
import express from 'express';
import request from 'supertest';

const require = createRequire(import.meta.url);
const axios = require('axios');
const db = require('../db/database');
const { runMigrations } = require('../core/migrations');
const { encrypt, decrypt } = require('../services/encryption');
const { getSetting, setSetting } = require('../services/settings');

const MSG = 'Enter the password or token again when changing the address. A saved credential is only ever sent to the address it was saved for.';
const BLOCKED_HOSTS = ['127.0.0.1', 'localhost', '169.254.169.254', '[::1]', '::ffff:127.0.0.1'];
const FIXED_MESSAGES = [
  'Could not reach the address.',
  'The TLS certificate was not trusted.',
  'The connection timed out.',
  'Unexpected response from the server.',
];

function hostCaller(prefix, router) {
  const app = express();
  app.use(express.json());
  app.use((req, res, next) => { req.auth = { kind: 'service', name: 'test', grants: ['*:*:*'] }; next(); });
  app.use(prefix, router);
  const passedToNext = [];
  // eslint-disable-next-line no-unused-vars
  app.use((err, req, res, next) => { passedToNext.push(err); res.status(500).json({ error: 'handler' }); });
  const call = async (method, p, body) => {
    const r = await request(app)[method.toLowerCase()](`${prefix}${p}`).send(body || {});
    return { status: r.status, body: r.body };
  };
  return { call, passedToNext };
}

function quietPoller(poller) {
  poller.schedule = () => {};
  poller.cancel = () => {};
  poller.trigger = async () => {};
}

/** Fake axios instance factory: records every axios.create config. */
function fakeAxiosCreate(handler) {
  const creates = [];
  vi.spyOn(axios, 'create').mockImplementation((cfg) => {
    creates.push(cfg);
    return {
      post: async (url, data) => handler({ method: 'POST', url, data, cfg }),
      get: async (url, c) => handler({ method: 'GET', url, params: c && c.params, cfg }),
    };
  });
  return creates;
}

const upstream = (status, body) => Object.assign(new Error(`Request failed with status code ${status}`), { isAxiosError: true, response: { status, data: body } });
const transport = (code, text) => Object.assign(new Error(text), { code });

const FAILURES = [
  ['a refused connection', () => transport('ECONNREFUSED', 'connect ECONNREFUSED 10.1.2.3:443'), 'Could not reach the address.'],
  ['an unknown name', () => transport('ENOTFOUND', 'getaddrinfo ENOTFOUND inside.corp.example'), 'Could not reach the address.'],
  ['a self signed certificate', () => transport('DEPTH_ZERO_SELF_SIGNED_CERT', 'self-signed certificate'), 'The TLS certificate was not trusted.'],
  ['a certificate for another name', () => transport('ERR_TLS_CERT_ALTNAME_INVALID', 'Hostname/IP does not match certificate altnames: inside.corp.example'), 'The TLS certificate was not trusted.'],
  ['a timeout', () => transport('ECONNABORTED', 'timeout of 60000ms exceeded'), 'The connection timed out.'],
  ['an upstream 500 with a body', () => upstream(500, { message: 'SECRET-UPSTREAM-BODY at 10.9.9.9' }), 'Unexpected response from the server.'],
];

function expectSafeFailure(result, expected) {
  expect(result.ok).toBe(false);
  expect(result.error).toBe(expected);
  expect(JSON.stringify(result)).not.toMatch(/ECONN|ENOTFOUND|10\.1\.2\.3|10\.9\.9\.9|inside\.corp|SECRET-UPSTREAM-BODY|altnames|60000ms/);
}

// ---------------------------------------------------------------------------
// Aria Automation + Aria Operations: one saved row per instance
// ---------------------------------------------------------------------------

const INSTANCE_PLATFORMS = [
  {
    key: 'aria', table: 'aria_instances', extraCol: 'domain', extraBody: 'domain',
    hostRouter: '../routes/aria', hostApi: '../services/ariaApi',
    hostPoller: () => require('../services/ariaPoller').ariaPoller,
    migrations: '../db/migrations/aria',
  },
  {
    key: 'ariaops', table: 'ariaops_instances', extraCol: 'auth_source', extraBody: 'authSource',
    hostRouter: '../routes/ariaops', hostApi: '../services/ariaopsApi',
    hostPoller: () => require('../services/ariaopsPoller').ariaopsPoller,
    migrations: '../db/migrations/ariaops',
  },
];

let rowCounter = 0;

for (const p of INSTANCE_PLATFORMS) {
  for (const variant of ['host']) {
    describe(`${p.key} ${variant === 'host' ? 'host router' : 'plugin pack'}: saved password stays with the saved address`, () => {
      let call;
      let api;
      let poller;
      let passedToNext = [];
      let seen;
      let realTest;

      beforeAll(() => {
        runMigrations(db, p.key, require(p.migrations));
        if (variant === 'host') {
          api = require(p.hostApi);
          poller = p.hostPoller();
          ({ call, passedToNext } = hostCaller(`/api/${p.key}`, require(p.hostRouter)));
        }
        quietPoller(poller);
      });

      beforeEach(() => {
        seen = [];
        realTest = api.testConnection;
        api.testConnection = async (candidate) => { seen.push(candidate); return { ok: true }; };
      });

      afterEach(() => {
        api.testConnection = realTest;
        vi.restoreAllMocks();
        quietPoller(poller);
      });

      function freshRow() {
        rowCounter += 1;
        const host = `saved${rowCounter}.corp.example`;
        const id = db.prepare(`
          INSERT INTO ${p.table} (name, host, username, ${p.extraCol}, encrypted_credentials, ssl_verify, polling_interval_minutes)
          VALUES (?, ?, 'svc-saved', 'saved.identity', ?, 1, 15)
        `).run(`saved-${rowCounter}`, host, encrypt(JSON.stringify({ password: 'saved-secret' }))).lastInsertRowid;
        return { id: Number(id), host };
      }
      const rowOf = (id) => db.prepare(`SELECT * FROM ${p.table} WHERE id = ?`).get(id);

      it('R1 a) test with a saved id, another host and no password dials the STORED host, user and ssl flag', async () => {
        const { id, host } = freshRow();
        const res = await call('POST', '/instances/test', {
          id, host: 'evil.example', username: 'attacker', [p.extraBody]: 'evil.identity', sslVerify: false,
        });
        expect(res.status).toBe(200);
        expect(seen).toHaveLength(1);
        expect(seen[0].host).toBe(host);
        expect(seen[0].username).toBe('svc-saved');
        expect(seen[0][p.extraCol]).toBe('saved.identity');
        expect(seen[0].ssl_verify).toBe(1);
        expect(seen[0].password).toBe('saved-secret');
        expect(JSON.stringify(seen[0])).not.toContain('evil');
      });

      it('R1 b) test with a typed password dials the body host with the typed password only', async () => {
        const { id } = freshRow();
        const res = await call('POST', '/instances/test', {
          id, host: 'new.example', username: 'typed-user', password: 'typed', sslVerify: false,
        });
        expect(res.status).toBe(200);
        expect(seen).toHaveLength(1);
        expect(seen[0].host).toBe('new.example');
        expect(seen[0].username).toBe('typed-user');
        expect(seen[0].password).toBe('typed');
        expect(seen[0].ssl_verify).toBe(0);
        expect(seen[0].encrypted_credentials).toBeUndefined();
        expect(JSON.stringify(seen[0])).not.toContain('saved-secret');
      });

      it('R1) a whitespace password counts as no password', async () => {
        const { id, host } = freshRow();
        const res = await call('POST', '/instances/test', { id, host: 'evil.example', username: 'attacker', password: '   ' });
        expect(res.status).toBe(200);
        expect(seen[0].host).toBe(host);
        expect(seen[0].password).toBe('saved-secret');
      });

      it('R1) test with no id and no password is 400 and dials nothing', async () => {
        const res = await call('POST', '/instances/test', { host: 'new.example', username: 'someone' });
        expect(res.status).toBe(400);
        const unknown = await call('POST', '/instances/test', { id: 999999, host: 'new.example', username: 'someone' });
        expect(unknown.status).toBe(400);
        expect(seen).toHaveLength(0);
      });

      it('R2 c) PUT that changes the host with a blank password is 400 and leaves the row alone', async () => {
        const { id } = freshRow();
        const before = rowOf(id);
        for (const body of [{ host: 'evil.example' }, { host: 'evil.example', password: '' }, { host: 'evil.example', password: '   ' }]) {
          const res = await call('PUT', `/instances/${id}`, body);
          expect(res.status).toBe(400);
          expect(res.body.error).toBe(MSG);
        }
        expect(rowOf(id)).toEqual(before);
      });

      it('R2 d) + R5) PUT with a new host and a typed password succeeds and drops the cached session', async () => {
        const { id } = freshRow();
        const forget = vi.spyOn(api, 'invalidateSession');
        const res = await call('PUT', `/instances/${id}`, { host: 'new-target.example', password: 'typed' });
        expect(res.status).toBe(200);
        const after = rowOf(id);
        expect(after.host).toBe('new-target.example');
        expect(JSON.parse(decrypt(after.encrypted_credentials)).password).toBe('typed');
        expect(forget).toHaveBeenCalledWith(id);
      });

      it('R2 e) rename with the same host and a blank password succeeds, omitted sslVerify keeps the stored value', async () => {
        const { id, host } = freshRow();
        const res = await call('PUT', `/instances/${id}`, { name: `renamed-${id}`, host: host.toUpperCase(), password: '' });
        expect(res.status).toBe(200);
        const after = rowOf(id);
        expect(after.name).toBe(`renamed-${id}`);
        expect(after.ssl_verify).toBe(1);
        expect(JSON.parse(decrypt(after.encrypted_credentials)).password).toBe('saved-secret');
        // The edit form resends the unchanged sslVerify and username every time.
        const resend = await call('PUT', `/instances/${id}`, { host, username: 'svc-saved', sslVerify: true, password: '' });
        expect(resend.status).toBe(200);
      });

      it('R3 f) create, PUT and test refuse loopback, link-local and metadata hosts', async () => {
        const { id } = freshRow();
        const before = rowOf(id);
        for (const bad of [...BLOCKED_HOSTS, 'name@127.0.0.1', 'vra.corp.example/path', 'vra.corp.example?x=1']) {
          const created = await call('POST', '/instances', { name: `bad-${bad}`, host: bad, username: 'u', password: 'typed' });
          expect(created.status, `create ${bad}`).toBe(400);
          const put = await call('PUT', `/instances/${id}`, { host: bad, password: 'typed' });
          expect(put.status, `put ${bad}`).toBe(400);
          const tested = await call('POST', '/instances/test', { host: bad, username: 'u', password: 'typed' });
          expect(tested.status, `test ${bad}`).toBe(400);
        }
        expect(seen).toHaveLength(0);
        expect(rowOf(id)).toEqual(before);
        expect(db.prepare(`SELECT COUNT(*) AS n FROM ${p.table} WHERE name LIKE 'bad-%'`).get().n).toBe(0);
      });

      it('R3) RFC1918 addresses and ordinary names are accepted', async () => {
        const ten = variant === 'host' ? '10.1.2.3' : '10.1.2.4';
        const created = await call('POST', '/instances', { name: `ten-${p.key}-${variant}`, host: ten, username: 'u', password: 'typed' });
        expect(created.status).toBe(201);
        const named = await call('POST', '/instances', { name: `dns-${p.key}-${variant}`, host: `${variant}.${p.key}.corp.example`, username: 'u', password: 'typed' });
        expect(named.status).toBe(201);
        const tested = await call('POST', '/instances/test', { host: '10.20.30.40', username: 'u', password: 'typed' });
        expect(tested.status).toBe(200);
        expect(seen[0].host).toBe('10.20.30.40');
      });

      if (variant === 'host') {
        it('refresh never hands a raw axios error to next()', async () => {
          const { id } = freshRow();
          poller.trigger = async () => {
            throw Object.assign(new Error('Request failed with status code 500'), {
              isAxiosError: true,
              config: { data: '{"password":"saved-secret"}', headers: { Authorization: 'Bearer live-token' } },
              response: { status: 500, data: 'SECRET-UPSTREAM-BODY' },
            });
          };
          const res = await call('POST', `/instances/${id}/refresh`);
          expect(res.status).toBe(502);
          expect(res.body).toEqual({ error: 'The platform did not answer as expected.' });
          expect(passedToNext.filter((e) => e && (e.isAxiosError || e.config || e.response))).toHaveLength(0);
        });
      }
    });
  }
}

// ---------------------------------------------------------------------------
// Aria clients: redirects, fixed failure text, login fallbacks, test id clobber
// ---------------------------------------------------------------------------

describe('services/ariaApi.js (host client)', () => {
  const api = require('../services/ariaApi');
  const candidate = { host: 'vra.corp.example', username: 'svc', password: 'typed', ssl_verify: 1 };
  afterEach(() => vi.restoreAllMocks());

  it('R4) every credential-bearing client is created with maxRedirects 0, and the refresh token flow still works', async () => {
    const urls = [];
    const creates = fakeAxiosCreate(({ method, url, data }) => {
      urls.push(`${method} ${url}`);
      if (url.startsWith('/csp/gateway/am/api/login')) {
        expect(data).toMatchObject({ username: 'svc', password: 'typed' });
        return { data: { refresh_token: 'rt-1' } };
      }
      if (url === '/iaas/api/login') {
        expect(data).toEqual({ refreshToken: 'rt-1' });
        return { data: { token: 'bearer-1' } };
      }
      return { data: { content: [] } };
    });
    const result = await api.testConnection(candidate);
    expect(result.ok).toBe(true);
    expect(urls[0]).toBe('POST /csp/gateway/am/api/login?access_token');
    expect(urls).toContain('POST /iaas/api/login');
    expect(creates.length).toBeGreaterThan(2);
    for (const cfg of creates) {
      expect(cfg.maxRedirects).toBe(0);
      expect(cfg.baseURL).toBe('https://vra.corp.example');
      expect(cfg.httpsAgent.options.rejectUnauthorized).toBe(true);
    }
    expect(creates.some((cfg) => cfg.headers.Authorization === 'Bearer bearer-1')).toBe(true);
  });

  it('login fallback: a gateway that returns only cspAuthToken still signs in', async () => {
    const creates = fakeAxiosCreate(({ url }) => {
      if (url.startsWith('/csp/gateway/am/api/login')) return { data: { cspAuthToken: 'csp-only' } };
      if (url === '/iaas/api/login') throw new Error('must not be called without a refresh token');
      return { data: { content: [] } };
    });
    const result = await api.testConnection(candidate);
    expect(result.ok).toBe(true);
    expect(creates.some((cfg) => cfg.headers.Authorization === 'Bearer csp-only')).toBe(true);
  });

  it('a vIDM 400 invalid_grant is reported as a refused sign-in without the body', async () => {
    fakeAxiosCreate(() => { throw upstream(400, { error: 'invalid_grant', error_description: 'SECRET-UPSTREAM-BODY' }); });
    const result = await api.testConnection(candidate);
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/^Sign-in was refused\./);
    expect(result.error).not.toContain('SECRET-UPSTREAM-BODY');
  });

  it('a login answer with no usable token does not echo the upstream keys', async () => {
    fakeAxiosCreate(() => ({ data: { SECRET_UPSTREAM_KEY: 1 } }));
    const result = await api.testConnection(candidate);
    expect(result).toEqual({ ok: false, error: 'Unexpected response from the server.' });
  });

  for (const [label, makeErr, expected] of FAILURES) {
    it(`test result for ${label} is fixed text`, async () => {
      fakeAxiosCreate(() => { throw makeErr(); });
      expectSafeFailure(await api.testConnection(candidate), expected);
      expect(FIXED_MESSAGES).toContain(expected);
    });
  }

  it('R6) a test for a row that carries a real id leaves that id\'s cached session alone', async () => {
    let logins = 0;
    fakeAxiosCreate(({ url }) => {
      if (url.startsWith('/csp/gateway/am/api/login')) { logins += 1; return { data: { cspAuthToken: `csp-${logins}` } }; }
      return { data: { content: [] } };
    });
    await api.testConnection({ ...candidate, id: 4242 });
    const before = logins;
    await api.getBearer({ ...candidate, id: 4242 });
    expect(logins).toBe(before + 1); // nothing was cached under 4242 by the test
    api.invalidateSession(4242);
  });
});

describe('services/ariaopsApi.js (host client)', () => {
  const api = require('../services/ariaopsApi');
  const candidate = { host: 'vrops.corp.example', username: 'svc', password: 'typed', auth_source: 'corp', ssl_verify: 0 };
  afterEach(() => vi.restoreAllMocks());

  it('R4) every credential-bearing client is created with maxRedirects 0', async () => {
    const creates = fakeAxiosCreate(({ url, data }) => {
      if (url === '/auth/token/acquire') {
        expect(data).toEqual({ username: 'svc', password: 'typed', authSource: 'corp' });
        return { data: { token: 'ops-token' } };
      }
      return { data: { releaseName: '8.18' } };
    });
    const result = await api.testConnection(candidate);
    expect(result).toEqual({ ok: true, version: '8.18' });
    expect(creates.length).toBeGreaterThan(1);
    for (const cfg of creates) {
      expect(cfg.maxRedirects).toBe(0);
      expect(cfg.baseURL).toBe('https://vrops.corp.example/suite-api/api');
    }
    expect(creates.some((cfg) => cfg.headers.Authorization === 'vRealizeOpsToken ops-token')).toBe(true);
  });

  it('a 401 is reported as a refused sign-in', async () => {
    fakeAxiosCreate(() => { throw upstream(401, { message: 'SECRET-UPSTREAM-BODY' }); });
    const result = await api.testConnection(candidate);
    expect(result.error).toMatch(/^Sign-in was refused\./);
    expect(result.error).not.toContain('SECRET-UPSTREAM-BODY');
  });

  for (const [label, makeErr, expected] of FAILURES) {
    it(`test result for ${label} is fixed text`, async () => {
      fakeAxiosCreate(() => { throw makeErr(); });
      expectSafeFailure(await api.testConnection(candidate), expected);
    });
  }

  it('R6) a test for a row that carries a real id leaves that id\'s cached token alone', async () => {
    let logins = 0;
    fakeAxiosCreate(({ url }) => {
      if (url === '/auth/token/acquire') { logins += 1; return { data: { token: `t-${logins}` } }; }
      return { data: {} };
    });
    await api.testConnection({ ...candidate, id: 4242 });
    const before = logins;
    await api.getToken({ ...candidate, id: 4242 });
    expect(logins).toBe(before + 1);
    api.invalidateSession(4242);
  });
});

// ---------------------------------------------------------------------------
// Zerto: one account-wide credential in app_settings, target = baseUrl
// ---------------------------------------------------------------------------

const SAVED_BASE = 'https://zerto.corp.example';
const BAD_BASE_URLS = [
  'http://zerto.corp.example', // cleartext
  'ftp://zerto.corp.example',
  'https://user:pw@zerto.corp.example', // userinfo
  'https://user@zerto.corp.example',
  'https://zerto.corp.example/?next=1', // query
  'https://zerto.corp.example?',
  'https://zerto.corp.example/#frag', // fragment
  'https://zerto.corp.example/some/path', // path
  'https://127.0.0.1',
  'https://localhost',
  'https://169.254.169.254',
  'https://[::1]',
  'https://[::ffff:127.0.0.1]',
  'https://2130706433', // decimal 127.0.0.1
  'not a url',
];

function seedZerto() {
  setSetting('zerto_username', 'saved-user');
  setSetting('zerto_password', encrypt('saved-secret'));
  setSetting('zerto_base_url', SAVED_BASE);
}
const zertoState = () => ({
  username: getSetting('zerto_username'),
  password: decrypt(getSetting('zerto_password')),
  baseUrl: getSetting('zerto_base_url'),
});

describe('zerto host router: saved password stays with the saved base URL', () => {
  let call;
  let zertoApi;
  let posts;
  let gets;

  beforeAll(() => {
    runMigrations(db, 'zerto', require('../db/migrations/zerto'));
    zertoApi = require('../services/zertoApi');
    const { zertoTask } = require('../services/zertoPoller');
    zertoTask.reschedule = () => {};
    zertoTask.isRunning = () => true;
    ({ call } = hostCaller('/api/zerto', require('../routes/zerto')));
  });

  beforeEach(() => {
    seedZerto();
    zertoApi.invalidateToken();
    posts = [];
    gets = [];
    vi.spyOn(axios, 'post').mockImplementation(async (url, data, cfg) => { posts.push({ url, data, cfg }); return { data: { token: 'jwt-1' } }; });
    vi.spyOn(axios, 'get').mockImplementation(async (url, cfg) => { gets.push({ url, cfg }); return { data: [{}, {}] }; });
  });
  afterEach(() => vi.restoreAllMocks());

  it('R1 a) test with another baseUrl and no password uses the STORED baseUrl and username', async () => {
    const res = await call('POST', '/account/test', { baseUrl: 'https://evil.example', username: 'attacker' });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true, sites: 2 });
    expect(posts).toHaveLength(1);
    expect(posts[0].url).toBe(`${SAVED_BASE}/v2/auth/token`);
    expect(posts[0].data).toEqual({ username: 'saved-user', password: 'saved-secret' });
    expect(gets[0].url).toBe(`${SAVED_BASE}/v2/monitoring/sites`);
    expect(JSON.stringify([posts, gets])).not.toContain('evil');
  });

  it('R1 b) test with a typed password uses the body baseUrl with the typed password only', async () => {
    const res = await call('POST', '/account/test', { baseUrl: 'https://new.example/', username: 'typed-user', password: 'typed' });
    expect(res.status).toBe(200);
    expect(posts[0].url).toBe('https://new.example/v2/auth/token');
    expect(posts[0].data).toEqual({ username: 'typed-user', password: 'typed' });
    expect(JSON.stringify([posts, gets])).not.toContain('saved-secret');
  });

  it('R4) every credential-bearing call has maxRedirects 0', async () => {
    await call('POST', '/account/test', {});
    await zertoApi.zGet('/v2/monitoring/vpgs');
    expect(posts.length + gets.length).toBeGreaterThanOrEqual(4);
    for (const c of [...posts, ...gets]) expect(c.cfg.maxRedirects).toBe(0);
  });

  it('R3) test refuses http, userinfo, query, fragment, paths and blocked hosts, even with a typed password', async () => {
    for (const baseUrl of BAD_BASE_URLS) {
      const res = await call('POST', '/account/test', { baseUrl, username: 'typed-user', password: 'typed' });
      expect(res.status, baseUrl).toBe(400);
      const blank = await call('POST', '/account/test', { baseUrl });
      expect(blank.status, baseUrl).toBe(400);
    }
    expect(posts).toHaveLength(0);
    expect(gets).toHaveLength(0);
  });

  it('R3) PUT refuses the same base URLs and leaves the saved account alone', async () => {
    const before = zertoState();
    for (const baseUrl of BAD_BASE_URLS) {
      const res = await call('PUT', '/account', { baseUrl, password: 'typed' });
      expect(res.status, baseUrl).toBe(400);
    }
    expect(zertoState()).toEqual(before);
  });

  it('R2 c) PUT that changes the baseUrl with a blank password is 400 and saves nothing', async () => {
    const before = zertoState();
    for (const body of [{ baseUrl: 'https://evil.example' }, { baseUrl: 'https://evil.example', password: '' }, { baseUrl: '', password: '' }]) {
      const res = await call('PUT', '/account', body);
      expect(res.status).toBe(400);
      expect(res.body.error).toBe(MSG);
    }
    expect(zertoState()).toEqual(before);
  });

  it('R2 d) + R5) PUT with a new baseUrl and a typed password succeeds and drops the cached token', async () => {
    const forget = vi.spyOn(zertoApi, 'invalidateToken');
    const res = await call('PUT', '/account', { baseUrl: 'https://10.1.2.3', password: 'typed' });
    expect(res.status).toBe(200);
    expect(zertoState()).toEqual({ username: 'saved-user', password: 'typed', baseUrl: 'https://10.1.2.3' });
    expect(forget).toHaveBeenCalled();
  });

  it('R2 e) PUT with the same baseUrl and a blank password still succeeds', async () => {
    const res = await call('PUT', '/account', { username: 'saved-user', baseUrl: `${SAVED_BASE.toUpperCase().replace('HTTPS', 'https')}/`, password: '', pollIntervalMinutes: 20 });
    expect(res.status).toBe(200);
    expect(zertoState().password).toBe('saved-secret');
    expect(getSetting('zerto_poll_interval_minutes')).toBe('20');
  });

  it('a base URL saved as http before the validation existed is never dialled', async () => {
    setSetting('zerto_base_url', 'http://legacy.corp.example');
    const res = await call('POST', '/account/test', {});
    expect(res.status).toBe(502);
    expect(res.body).toEqual({ ok: false, error: 'The Zerto base URL must be an https address.' });
    await expect(zertoApi.zGet('/v2/monitoring/vpgs')).rejects.toThrow('https address');
    expect(posts).toHaveLength(0);
    expect(gets).toHaveLength(0);
  });

  for (const [label, makeErr, expected] of FAILURES) {
    it(`test result for ${label} is fixed text`, async () => {
      axios.post.mockImplementation(async () => { throw makeErr(); });
      const res = await call('POST', '/account/test', {});
      expect(res.status).toBe(502);
      expectSafeFailure(res.body, expected);
    });
  }

  it('a 401 is reported as a refused sign-in without the body', async () => {
    axios.post.mockImplementation(async () => { throw upstream(401, { message: 'SECRET-UPSTREAM-BODY' }); });
    const res = await call('POST', '/account/test', {});
    expect(res.body.error).toMatch(/^Sign-in was refused\./);
    expect(res.body.error).not.toContain('SECRET-UPSTREAM-BODY');
  });
});
