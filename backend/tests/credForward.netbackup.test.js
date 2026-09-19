/**
 * Credential forwarding, NetBackup built-in platform: sources (primary server
 * and Alta tenant, password and apikey auth) and appliance connections.
 *
 * The real routers run on a bare express app. Nothing reaches the network:
 * axios.create is replaced by a recorder, so every assertion is about what the
 * platform client actually tried to send and where, not only about the HTTP
 * status the caller saw.
 */
import { describe, it, expect, beforeAll, beforeEach, afterAll, vi } from 'vitest';
import { createRequire } from 'module';
import express from 'express';
import request from 'supertest';

const require = createRequire(import.meta.url);
const axios = require('axios');
const db = require('../db/database');
const { runMigrations } = require('../core/migrations');
const netbackupMigrations = require('../db/migrations/netbackup');
const { encrypt, decrypt } = require('../services/encryption');
const netbackupApi = require('../services/netbackupApi');
const netbackupApplianceApi = require('../services/netbackupApplianceApi');

const MESSAGE = 'Enter the password or token again when changing the address. A saved credential is only ever sent to the address it was saved for.';
const BLOCKED = ['127.0.0.1', 'localhost', '169.254.169.254', '[::1]', '::ffff:127.0.0.1'];
const UPSTREAM_BODY = 'UPSTREAM-BODY-'.repeat(40);

// ---- axios.create recorder ---------------------------------------------------

let calls = [];
let responder;

const defaultResponder = (call) => {
  if (/\/ping$/.test(call.path)) return { status: 200, body: UPSTREAM_BODY };
  return { status: 200, body: { token: 'tok', accessToken: 'tok' } };
};

/** Stands in for an axios instance: records the request and answers from `responder`. */
function fakeCreate(config) {
  const record = (method, url, data, params) => {
    const base = new URL(config.baseURL);
    const call = {
      baseURL: config.baseURL,
      hostname: base.hostname,
      port: Number(base.port || 443),
      path: `${base.pathname.replace(/\/+$/, '')}${url}`,
      method,
      data,
      params,
      headers: config.headers || {},
      rejectUnauthorized: !!config.httpsAgent?.options?.rejectUnauthorized,
      maxRedirects: config.maxRedirects,
    };
    calls.push(call);
    const out = responder(call);
    if (out.error) return Promise.reject(out.error);
    const status = out.status || 200;
    if (status >= 200 && status < 300) return Promise.resolve({ status, data: out.body });
    const err = new Error(`Request failed with status code ${status}`);
    err.response = { status, data: out.body };
    return Promise.reject(err);
  };
  return {
    request: (o) => record(String(o.method || 'get').toLowerCase(), o.url, o.data, o.params),
    post: (url, data) => record('post', url, data),
    get: (url, o = {}) => record('get', url, undefined, o.params),
  };
}

let createSpy;
let app;

beforeAll(() => {
  runMigrations(db, 'netbackup', netbackupMigrations);
  createSpy = vi.spyOn(axios, 'create').mockImplementation(fakeCreate);

  // Scheduling and triggering a poll is not what these tests are about, and a
  // scheduled task would outlive the file.
  const poller = require('../services/netbackupPoller');
  for (const p of [poller.netbackupPoller, poller.netbackupAppliancePoller]) {
    vi.spyOn(p, 'schedule').mockImplementation(() => {});
    vi.spyOn(p, 'cancel').mockImplementation(() => {});
    vi.spyOn(p, 'trigger').mockResolvedValue(undefined);
  }

  app = express();
  app.use(express.json());
  app.use((req, res, next) => {
    req.auth = { kind: 'user', grants: ['*:*:manage'], user: { username: 'tester' } };
    next();
  });
  app.use('/api/netbackup', require('../routes/netbackup'));
});

beforeEach(() => {
  calls = [];
  responder = defaultResponder;
});

afterAll(() => {
  createSpy.mockRestore();
  vi.restoreAllMocks();
});

const api = (p) => `/api/netbackup${p}`;

// ---- the two source types -----------------------------------------------------

const SOURCE_TYPES = [
  {
    label: 'NetBackup primary source',
    table: 'netbackup_sources',
    base: '/sources',
    storedHost: 'nbu.corp.example',
    storedUser: 'svc-nbu',
    storedPort: 1556,
    userColumn: 'username',
    client: () => netbackupApi,
    prime: (row) => netbackupApi.apiRequest(row, 'get', '/config/hosts'),
    seed: () => db.prepare(`INSERT INTO netbackup_sources (name, source_type, host, port, auth_mode, username, encrypted_credentials, ssl_verify, polling_interval_minutes)
      VALUES ('nbu-saved', 'primary', 'nbu.corp.example', 1556, 'password', 'svc-nbu', ?, 1, 15)`).run(encrypt(JSON.stringify({ password: 'stored-secret' }))).lastInsertRowid,
    createBody: (host) => ({ name: `blocked ${host}`, host, authMode: 'password', username: 'u', password: 's' }),
    savedSecret: (row) => JSON.parse(decrypt(row.encrypted_credentials)).password,
    sent: () => {
      const call = calls.find((c) => /\/login$/.test(c.path));
      return { call, user: call?.data?.userName, secret: call?.data?.password };
    },
  },
  {
    label: 'NetBackup appliance connection',
    table: 'netbackup_appliance_conns',
    base: '/appliance-connections',
    storedHost: 'appl.corp.example',
    storedUser: 'svc-appl',
    storedPort: 443,
    userColumn: 'username',
    client: () => netbackupApplianceApi,
    prime: (row) => netbackupApplianceApi.apiRequest(row, 'get', '/api/appliance/v1.0/hardware/health'),
    seed: () => db.prepare(`INSERT INTO netbackup_appliance_conns (name, host, port, username, encrypted_credentials, ssl_verify, polling_interval_minutes)
      VALUES ('appl-saved', 'appl.corp.example', 443, 'svc-appl', ?, 1, 30)`).run(encrypt(JSON.stringify({ password: 'stored-secret' }))).lastInsertRowid,
    createBody: (host) => ({ name: `blocked ${host}`, host, username: 'u', password: 's' }),
    savedSecret: (row) => JSON.parse(decrypt(row.encrypted_credentials)).password,
    sent: () => {
      const call = calls.find((c) => c.path === '/api/appliance/v1.0/auth/login');
      return { call, user: call?.data?.userName, secret: call?.data?.password };
    },
  },
];

for (const t of SOURCE_TYPES) {
  describe(`${t.label}: a saved credential only travels to the saved address`, () => {
    let id;
    const rowNow = () => db.prepare(`SELECT * FROM ${t.table} WHERE id = ?`).get(id);
    const everyCallWentTo = (host) => calls.length > 0 && calls.every((c) => c.hostname === host);

    beforeAll(() => {
      id = Number(t.seed());
    });

    it('a: test with { id, host: evil } and no secret dials the STORED host, port, TLS flag and account with the stored secret', async () => {
      const res = await request(app).post(api(`${t.base}/test`)).send({
        id, host: 'evil.example', port: 22, sslVerify: false, username: 'attacker',
      });
      expect(res.status).toBe(200);
      expect(res.body.ok).toBe(true);
      expect(everyCallWentTo(t.storedHost)).toBe(true);
      expect(calls.some((c) => c.hostname === 'evil.example')).toBe(false);
      const sent = t.sent();
      expect(sent.call.hostname).toBe(t.storedHost);
      expect(sent.call.port).toBe(t.storedPort); // the body said 22
      expect(sent.call.rejectUnauthorized).toBe(true); // stored ssl_verify = 1, the body said false
      expect(sent.user).toBe(t.storedUser);
      expect(sent.secret).toBe('stored-secret');
    });

    it('b: test with a typed secret dials the body address with the typed secret; the stored secret is not used', async () => {
      const res = await request(app).post(api(`${t.base}/test`)).send({
        id, host: 'new.example', sslVerify: false, username: 'typed-user', password: 'typed-secret',
      });
      expect(res.status).toBe(200);
      expect(everyCallWentTo('new.example')).toBe(true);
      const sent = t.sent();
      expect(sent.call.rejectUnauthorized).toBe(false);
      expect(sent.user).toBe('typed-user');
      expect(sent.secret).toBe('typed-secret');
      expect(JSON.stringify(calls)).not.toContain('stored-secret');
    });

    it('R4: every credentialed call refuses to follow a redirect', async () => {
      await request(app).post(api(`${t.base}/test`)).send({ id });
      expect(calls.length).toBeGreaterThan(0);
      expect(calls.every((c) => c.maxRedirects === 0)).toBe(true);
    });

    it('R6: a test never sends, drops or replaces the live session of the saved source', async () => {
      // A poll has logged in: the client now holds a live token for this id.
      responder = () => ({ status: 200, body: { token: 'live-token', accessToken: 'live-token' } });
      await t.prime(rowNow());
      expect(t.sent().secret).toBe('stored-secret');

      // Typed-secret test against another address: the live session must not go there.
      calls = [];
      responder = defaultResponder;
      const typed = await request(app).post(api(`${t.base}/test`)).send({ id, host: 'new.example', password: 'typed-secret' });
      expect(typed.status).toBe(200);
      expect(everyCallWentTo('new.example')).toBe(true);
      expect(JSON.stringify(calls)).not.toContain('live-token');
      expect(t.sent().secret).toBe('typed-secret');

      // The live session is still there for the next poll: no new login, same token.
      calls = [];
      await t.prime(rowNow());
      expect(calls.length).toBeGreaterThan(0);
      expect(calls.every((c) => c.hostname === t.storedHost && JSON.stringify(c.headers).includes('live-token'))).toBe(true);
    });

    it('f: create, test and PUT refuse loopback, link-local and metadata addresses; 10.x and DNS names are accepted', async () => {
      const before = JSON.stringify(rowNow());
      for (const host of BLOCKED) {
        const test = await request(app).post(api(`${t.base}/test`)).send({ host, username: 'u', password: 's' });
        expect([host, test.status]).toEqual([host, 400]);
        const testSaved = await request(app).post(api(`${t.base}/test`)).send({ id, host, password: 's' });
        expect([host, testSaved.status]).toEqual([host, 400]);
        const create = await request(app).post(api(t.base)).send(t.createBody(host));
        expect([host, create.status]).toEqual([host, 400]);
        const put = await request(app).put(api(`${t.base}/${id}`)).send({ host, password: 's' });
        expect([host, put.status]).toEqual([host, 400]);
      }
      expect(calls).toEqual([]);
      expect(JSON.stringify(rowNow())).toBe(before);
      expect(db.prepare(`SELECT COUNT(*) n FROM ${t.table} WHERE name LIKE 'blocked %'`).get().n).toBe(0);

      const ok = await request(app).post(api(`${t.base}/test`)).send({ id, host: '10.1.2.3', password: 'typed-secret' });
      expect(ok.status).toBe(200);
      expect(everyCallWentTo('10.1.2.3')).toBe(true);
    });

    it('7: a failed test returns a fixed message, never transport text or an upstream body', async () => {
      responder = () => ({ error: Object.assign(new Error('connect ECONNREFUSED 10.1.2.3:1556'), { code: 'ECONNREFUSED' }) });
      const refused = await request(app).post(api(`${t.base}/test`)).send({ id });
      expect(refused.status).toBe(502);
      expect(refused.body.error).toBe('Could not reach the address.');
      expect(JSON.stringify(refused.body)).not.toContain('10.1.2.3');

      responder = () => ({ status: 500, body: { message: UPSTREAM_BODY, errorMessage: UPSTREAM_BODY } });
      const upstream = await request(app).post(api(`${t.base}/test`)).send({ id });
      expect(upstream.status).toBe(502);
      expect(JSON.stringify(upstream.body)).not.toContain('UPSTREAM-BODY');

      responder = () => ({ error: Object.assign(new Error('self-signed certificate'), { code: 'DEPTH_ZERO_SELF_SIGNED_CERT' }) });
      const tls = await request(app).post(api(`${t.base}/test`)).send({ id });
      expect(tls.body.error).toBe('The TLS certificate was not trusted.');
    });

    it('c: PUT that changes the host with a blank secret is 400 with the contract message and the row is unchanged', async () => {
      const before = JSON.stringify(rowNow());
      for (const body of [{ host: 'evil.example' }, { host: 'evil.example', password: '' }]) {
        const res = await request(app).put(api(`${t.base}/${id}`)).send(body);
        expect(res.status).toBe(400);
        expect(res.body.error).toBe(MESSAGE);
      }
      expect(JSON.stringify(rowNow())).toBe(before);
    });

    it('c: PUT that changes the port, or turns certificate verification off, with a blank secret is 400', async () => {
      const before = JSON.stringify(rowNow());
      const port = await request(app).put(api(`${t.base}/${id}`)).send({ port: 2222 });
      expect(port.status).toBe(400);
      expect(port.body.error).toBe(MESSAGE);
      const tls = await request(app).put(api(`${t.base}/${id}`)).send({ sslVerify: false });
      expect(tls.status).toBe(400);
      expect(tls.body.error).toBe(MESSAGE);
      expect(JSON.stringify(rowNow())).toBe(before);
    });

    it('e: PUT with the same address and a blank secret succeeds: rename, account name only, omitted sslVerify kept', async () => {
      const rename = await request(app).put(api(`${t.base}/${id}`)).send({
        name: `${t.label} renamed`, host: ` ${t.storedHost.toUpperCase()} `, port: String(t.storedPort),
      });
      expect(rename.status).toBe(200);
      // A username is not an address: it may change while the saved secret is kept.
      const account = await request(app).put(api(`${t.base}/${id}`)).send({ username: 'other-account' });
      expect(account.status).toBe(200);
      const row = rowNow();
      expect(row.name).toBe(`${t.label} renamed`);
      expect(row[t.userColumn]).toBe('other-account');
      expect(row.host.toLowerCase()).toBe(t.storedHost);
      expect(row.ssl_verify).toBe(1); // never silently reset to off
      expect(t.savedSecret(row)).toBe('stored-secret');
    });

    it('d: PUT that changes the address with a typed secret succeeds and drops the cached session', async () => {
      const spy = vi.spyOn(t.client(), 'invalidateSession');
      const res = await request(app).put(api(`${t.base}/${id}`)).send({ host: 'new.example', sslVerify: false, password: 'typed-secret' });
      expect(res.status).toBe(200);
      const row = rowNow();
      expect(row.host).toBe('new.example');
      expect(row.ssl_verify).toBe(0);
      expect(t.savedSecret(row)).toBe('typed-secret');
      expect(JSON.stringify(res.body)).not.toContain('typed-secret');
      expect(spy).toHaveBeenCalledWith(id);
      spy.mockRestore();
    });
  });
}

// ---- NetBackup source specifics: auth mode and the Alta base URL ---------------

describe('NetBackup source: auth mode and Alta base URL', () => {
  let id;
  const rowNow = () => db.prepare('SELECT * FROM netbackup_sources WHERE id = ?').get(id);

  beforeAll(() => {
    id = Number(db.prepare(`INSERT INTO netbackup_sources (name, source_type, host, port, auth_mode, username, encrypted_credentials, ssl_verify, polling_interval_minutes)
      VALUES ('nbu-mode', 'primary', 'nbu2.corp.example', 1556, 'password', 'svc-nbu', ?, 1, 15)`).run(encrypt(JSON.stringify({ password: 'stored-secret' }))).lastInsertRowid);
  });

  it('an apiKey typed on a password-mode source is not stored, so it does not unlock a new host', async () => {
    const before = JSON.stringify(rowNow());
    const res = await request(app).put(api(`/sources/${id}`)).send({ host: 'evil.example', apiKey: 'anything' });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe(MESSAGE);
    expect(JSON.stringify(rowNow())).toBe(before);
  });

  it('the same trick on the test route still dials the stored host with the stored password', async () => {
    const res = await request(app).post(api('/sources/test')).send({ id, host: 'evil.example', apiKey: 'anything' });
    expect(res.status).toBe(200);
    expect(calls.every((c) => c.hostname === 'nbu2.corp.example')).toBe(true);
    expect(calls.find((c) => /\/login$/.test(c.path)).data.password).toBe('stored-secret');
  });

  it('switching sourceType with a blank secret is refused (it changes how host becomes a URL)', async () => {
    const res = await request(app).put(api(`/sources/${id}`)).send({ sourceType: 'alta', host: 'https://nbu2.corp.example' });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe(MESSAGE);
  });

  it('the test result carries no upstream /ping body', async () => {
    const res = await request(app).post(api('/sources/test')).send({ id });
    expect(res.status).toBe(200);
    expect(calls.some((c) => /\/ping$/.test(c.path))).toBe(true);
    expect(res.body).toEqual({ ok: true, version: null });
  });

  it('an Alta base URL must be https, with no userinfo, and not a blocked host', async () => {
    const alta = { name: 'alta-bad', sourceType: 'alta', authMode: 'apikey', apiKey: 'k' };
    for (const host of ['http://alta.example', 'https://user:pw@alta.example', 'alta.example', 'https://169.254.169.254/netbackup', 'https://localhost']) {
      const create = await request(app).post(api('/sources')).send({ ...alta, host });
      expect([host, create.status]).toEqual([host, 400]);
      const test = await request(app).post(api('/sources/test')).send({ ...alta, host });
      expect([host, test.status]).toEqual([host, 400]);
    }
    expect(calls).toEqual([]);
    expect(db.prepare("SELECT COUNT(*) n FROM netbackup_sources WHERE name = 'alta-bad'").get().n).toBe(0);
  });

  it('an https Alta base URL is dialled with the typed API key', async () => {
    const res = await request(app).post(api('/sources/test')).send({
      sourceType: 'alta', authMode: 'apikey', apiKey: 'typed-key', host: 'https://tenant.alta.example/netbackup',
    });
    expect(res.status).toBe(200);
    expect(calls.every((c) => c.hostname === 'tenant.alta.example')).toBe(true);
    expect(calls[0].headers.Authorization).toBe('typed-key');
  });

  it('an apikey source keeps the saved key when only the name changes, and needs it retyped to move', async () => {
    const keyId = Number(db.prepare(`INSERT INTO netbackup_sources (name, source_type, host, port, auth_mode, encrypted_credentials, ssl_verify, polling_interval_minutes)
      VALUES ('alta-saved', 'alta', 'https://tenant2.alta.example/netbackup', 443, 'apikey', ?, 1, 15)`).run(encrypt(JSON.stringify({ apiKey: 'stored-key' }))).lastInsertRowid);

    const renamed = await request(app).put(api(`/sources/${keyId}`)).send({ name: 'alta-renamed' });
    expect(renamed.status).toBe(200);

    const moved = await request(app).put(api(`/sources/${keyId}`)).send({ host: 'https://evil.alta.example/netbackup' });
    expect(moved.status).toBe(400);
    expect(moved.body.error).toBe(MESSAGE);
    expect(db.prepare('SELECT host FROM netbackup_sources WHERE id = ?').get(keyId).host).toBe('https://tenant2.alta.example/netbackup');

    // A test with no typed key dials the saved tenant with the saved key.
    const test = await request(app).post(api('/sources/test')).send({ id: keyId, host: 'https://evil.alta.example/netbackup' });
    expect(test.status).toBe(200);
    expect(calls.every((c) => c.hostname === 'tenant2.alta.example')).toBe(true);
    expect(calls[0].headers.Authorization).toBe('stored-key');

    const retyped = await request(app).put(api(`/sources/${keyId}`)).send({ host: 'https://new.alta.example/netbackup', apiKey: 'typed-key' });
    expect(retyped.status).toBe(200);
    expect(JSON.parse(decrypt(db.prepare('SELECT * FROM netbackup_sources WHERE id = ?').get(keyId).encrypted_credentials)).apiKey).toBe('typed-key');
  });
});
