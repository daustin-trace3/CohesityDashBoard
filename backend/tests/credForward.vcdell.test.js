/**
 * A saved credential only ever travels to the address it was saved for.
 * vCenter and Dell OME, host routers AND their plugin-sdk pack twins.
 *
 * Every R1 case asserts on what the platform client RECEIVED (host, TLS flag,
 * username, and which secret it would log in with), not only on the HTTP
 * status. The lower half drives the real clients with a fake transport to
 * prove R4 (no redirects), R6 (a test never overwrites the live session) and
 * that a failed test never echoes transport text or an upstream body.
 */
import { describe, it, expect, beforeAll, beforeEach, afterEach, vi } from 'vitest';
import { createRequire } from 'module';
import { EventEmitter } from 'events';
import express from 'express';
import request from 'supertest';

const require = createRequire(import.meta.url);
const db = require('../db/database');
const { encrypt, decrypt } = require('../services/encryption');
const axios = require('axios');
const https = require('https');
const { loadPack } = require('./helpers/packRouter');

const vcenterApi = require('../services/vcenterApi');
const dellOmeApi = require('../services/dellOmeApi');
const { vcenterPoller } = require('../services/vcenterPoller');
const { dellPoller } = require('../services/dellPoller');

const MESSAGE = 'Enter the password or token again when changing the address. A saved credential is only ever sent to the address it was saved for.';
const BLOCKED = ['127.0.0.1', 'localhost', '169.254.169.254', '[::1]', '::ffff:127.0.0.1'];
const SAFE_MESSAGES = [
  'Sign-in was refused. Check the username and password.',
  'Unexpected response from the address.',
  'The TLS certificate was not trusted.',
  'Timed out.',
  'Could not reach the address.',
];

let app;
let vcPack;
let dellPack;
let vcPackApi;
let dellPackApi;

const quietPoller = (p) => {
  p.schedule = () => {};
  p.cancel = () => {};
  p.trigger = async () => {};
};

beforeAll(() => {
  // No poll may ever leave this process: create/PUT call schedule + trigger.
  quietPoller(vcenterPoller);
  quietPoller(dellPoller);

  app = express();
  app.use(express.json());
  app.use((req, res, next) => {
    req.auth = { kind: 'service', grants: ['*:*:*'], user: { username: 'tester' } };
    next();
  });
  app.use('/api/vcenter', require('../routes/vcenter'));
  app.use('/api/dell', require('../routes/dell'));

  vcPack = loadPack('vcenter');
  dellPack = loadPack('dell');
  vcPackApi = require('../../plugin-sdk/vcenter/backend/src/api.js');
  dellPackApi = require('../../plugin-sdk/dell/backend/src/api.js');
  quietPoller(require('../../plugin-sdk/vcenter/backend/src/poller.js').getPoller(vcPack.coreApi));
  quietPoller(require('../../plugin-sdk/dell/backend/src/poller.js').getPoller(dellPack.coreApi));
});

const hostCall = (prefix) => async (method, path, body) => {
  const res = await request(app)[method.toLowerCase()](prefix + path).send(body || {});
  return { status: res.status, body: res.body };
};

// One entry per router under test. `api` is the module object whose
// testConnection the router calls at request time (so replacing the property
// is seen by the route); `collection` is the CRUD path inside that router.
const targets = [
  { label: 'vcenter host router', table: 'vcenter_vcenters', collection: '/vcenters', api: () => vcenterApi, call: () => hostCall('/api/vcenter') },
  { label: 'vcenter pack twin', table: 'vcenter_vcenters', collection: '/vcenters', api: () => vcPackApi, call: () => vcPack.call },
  { label: 'dell host router', table: 'dell_ome_instances', collection: '/instances', api: () => dellOmeApi, call: () => hostCall('/api/dell') },
  { label: 'dell pack twin', table: 'dell_ome_instances', collection: '/instances', api: () => dellPackApi, call: () => dellPack.call },
];

/** The password the client would log in with for this candidate. */
function secretOf(candidate) {
  if (candidate.password) return candidate.password;
  if (!candidate.encrypted_credentials) return null;
  return JSON.parse(decrypt(candidate.encrypted_credentials)).password;
}

describe.each(targets)('$label', (t) => {
  let call;
  let api;
  let savedId;
  let seen;
  let realTest;
  let realInvalidate;
  let invalidated;

  const row = () => db.prepare(`SELECT * FROM ${t.table} WHERE id = ?`).get(savedId);

  beforeEach(() => {
    call = t.call();
    api = t.api();
    db.exec(`DELETE FROM ${t.table}`);
    savedId = Number(db.prepare(`
      INSERT INTO ${t.table} (name, host, username, encrypted_credentials, ssl_verify, polling_interval_minutes)
      VALUES ('saved-src', 'saved.corp.example', 'svc-saved', ?, 1, 15)
    `).run(encrypt(JSON.stringify({ password: 'STORED-SECRET' }))).lastInsertRowid);

    seen = [];
    realTest = api.testConnection;
    api.testConnection = async (candidate) => { seen.push(candidate); return { ok: true }; };
    invalidated = [];
    realInvalidate = api.invalidateSession;
    api.invalidateSession = (id) => { invalidated.push(id); return realInvalidate(id); };
  });

  afterEach(() => {
    api.testConnection = realTest;
    api.invalidateSession = realInvalidate;
  });

  // -- R1 --------------------------------------------------------------------
  it('R1a: test with { id, host: evil } and no secret dials the STORED host, TLS flag, username and secret', async () => {
    const res = await call('POST', `${t.collection}/test`, {
      id: savedId, host: 'evil.example', username: 'attacker', sslVerify: false,
    });
    expect(res.status).toBe(200);
    expect(seen).toHaveLength(1);
    const c = seen[0];
    expect(c.host).toBe('saved.corp.example');
    expect(c.ssl_verify).toBe(1); // stored flag, the body said false
    expect(c.username).toBe('svc-saved');
    expect(secretOf(c)).toBe('STORED-SECRET');
    expect(JSON.stringify(c)).not.toContain('evil.example');
    expect(String(c.id)).not.toBe(String(savedId)); // never the live session key
  });

  it('R1a: a blank password string counts as "no secret"', async () => {
    const res = await call('POST', `${t.collection}/test`, {
      id: savedId, host: 'evil.example', username: 'attacker', password: '', sslVerify: false,
    });
    expect(res.status).toBe(200);
    expect(seen[0].host).toBe('saved.corp.example');
    expect(seen[0].ssl_verify).toBe(1);
    expect(seen[0].username).toBe('svc-saved');
  });

  it('R1b: test with a typed secret dials the body host with the typed secret; the stored secret is not used', async () => {
    const res = await call('POST', `${t.collection}/test`, {
      id: savedId, host: 'new.example', username: 'Typed-User', password: 'typed', sslVerify: false,
    });
    expect(res.status).toBe(200);
    expect(seen).toHaveLength(1);
    const c = seen[0];
    expect(c.host).toBe('new.example');
    expect(c.username).toBe('Typed-User');
    expect(c.ssl_verify).toBe(0);
    expect(c.password).toBe('typed');
    expect(c.encrypted_credentials).toBeUndefined();
    expect(secretOf(c)).toBe('typed');
  });

  it('R1: test with no id and no secret is 400 and nothing is dialled', async () => {
    const res = await call('POST', `${t.collection}/test`, { host: 'new.example', username: 'u' });
    expect(res.status).toBe(400);
    expect(seen).toHaveLength(0);
  });

  it('R1: test naming an id that does not exist, with no secret, is 400 and nothing is dialled', async () => {
    const res = await call('POST', `${t.collection}/test`, { id: 999999, host: 'new.example', username: 'u' });
    expect(res.status).toBe(400);
    expect(seen).toHaveLength(0);
  });

  // -- R2 / R5 ---------------------------------------------------------------
  it.each([
    ['omitted', { host: 'evil.example' }],
    ['blank', { host: 'evil.example', password: '' }],
  ])('R2c: PUT that changes the host with an %s password is 400 and the row is unchanged', async (_n, body) => {
    const before = row();
    const res = await call('PUT', `${t.collection}/${savedId}`, body);
    expect(res.status).toBe(400);
    expect(res.body.error).toBe(MESSAGE);
    expect(row()).toEqual(before);
  });

  it('R2d + R5: PUT with a new host and a typed password succeeds and drops the cached session', async () => {
    const res = await call('PUT', `${t.collection}/${savedId}`, { host: 'new.example', password: 'typed' });
    expect(res.status).toBe(200);
    const r = row();
    expect(r.host).toBe('new.example');
    expect(JSON.parse(decrypt(r.encrypted_credentials)).password).toBe('typed');
    expect(invalidated).toContain(savedId);
  });

  it('R5: PUT that only replaces the password drops the cached session', async () => {
    const res = await call('PUT', `${t.collection}/${savedId}`, { password: 'rotated' });
    expect(res.status).toBe(200);
    expect(JSON.parse(decrypt(row().encrypted_credentials)).password).toBe('rotated');
    expect(invalidated).toContain(savedId);
  });

  it('R2e: PUT that only renames (same host, blank password) succeeds and keeps secret and sslVerify', async () => {
    const before = row();
    const res = await call('PUT', `${t.collection}/${savedId}`, { name: 'renamed', host: ' SAVED.corp.example ', password: '' });
    expect(res.status).toBe(200);
    const r = row();
    expect(r.name).toBe('renamed');
    expect(r.encrypted_credentials).toBe(before.encrypted_credentials);
    expect(r.ssl_verify).toBe(1); // omitted sslVerify must not reset to off
    expect(res.body.sslVerify).toBe(true);
  });

  // -- R3 --------------------------------------------------------------------
  it.each(BLOCKED)('R3f: create, PUT and test refuse %s', async (bad) => {
    const created = await call('POST', t.collection, { name: `bad-${bad}`, host: bad, username: 'u', password: 'p' });
    expect(created.status).toBe(400);
    expect(db.prepare(`SELECT COUNT(*) AS n FROM ${t.table}`).get().n).toBe(1);

    const before = row();
    const put = await call('PUT', `${t.collection}/${savedId}`, { host: bad, password: 'typed' });
    expect(put.status).toBe(400);
    expect(row()).toEqual(before);

    const typed = await call('POST', `${t.collection}/test`, { host: bad, username: 'u', password: 'p' });
    expect(typed.status).toBe(400);
    const saved = await call('POST', `${t.collection}/test`, { id: savedId, host: bad, username: 'u' });
    expect(saved.status).toBe(400);
    expect(seen).toHaveLength(0);
  });

  it('R3: RFC1918 addresses and ordinary DNS names are accepted on create, PUT and test', async () => {
    const a = await call('POST', t.collection, { name: 'ten', host: '10.20.30.40', username: 'u', password: 'p' });
    expect(a.status).toBe(201);
    const b = await call('POST', t.collection, { name: 'dns', host: 'vc01.corp.example', username: 'u', password: 'p', sslVerify: true });
    expect(b.status).toBe(201);
    expect(b.body.sslVerify).toBe(true);
    const put = await call('PUT', `${t.collection}/${savedId}`, { host: '192.168.50.9', password: 'typed' });
    expect(put.status).toBe(200);
    const test = await call('POST', `${t.collection}/test`, { host: '10.20.30.41', username: 'u', password: 'p' });
    expect(test.status).toBe(200);
    expect(seen[0].host).toBe('10.20.30.41');
  });

  it('never returns the credential columns', async () => {
    const res = await call('GET', t.collection);
    expect(res.status).toBe(200);
    expect(JSON.stringify(res.body)).not.toMatch(/encrypted|STORED-SECRET/i);
  });
});

// -- Dell probe routes: saved credentials, saved host, nothing from the caller -
describe.each([
  { label: 'dell host router', api: () => dellOmeApi, call: () => hostCall('/api/dell') },
  { label: 'dell pack twin', api: () => dellPackApi, call: () => dellPack.call },
])('$label probe routes', (t) => {
  it('inventory-probe and audit-probe dial the saved row and ignore a host in the query', async () => {
    const api = t.api();
    db.exec('DELETE FROM dell_ome_instances');
    const id = Number(db.prepare(`
      INSERT INTO dell_ome_instances (name, host, username, encrypted_credentials, ssl_verify, polling_interval_minutes)
      VALUES ('probe-src', 'ome.corp.example', 'svc', ?, 1, 15)
    `).run(encrypt(JSON.stringify({ password: 'STORED-SECRET' }))).lastInsertRowid);
    const got = [];
    const real = { inv: api.probeInventory, aud: api.probeAudit };
    api.probeInventory = async (ome) => { got.push(ome); return { ok: true }; };
    api.probeAudit = async (ome) => { got.push(ome); return { ok: true }; };
    try {
      const call = t.call();
      const a = await call('GET', `/instances/${id}/inventory-probe?deviceId=5&host=evil.example&sslVerify=false`);
      const b = await call('GET', `/instances/${id}/audit-probe?host=evil.example`);
      expect(a.status).toBe(200);
      expect(b.status).toBe(200);
      expect(got).toHaveLength(2);
      for (const ome of got) {
        expect(ome.host).toBe('ome.corp.example');
        expect(ome.ssl_verify).toBe(1);
        expect(ome.id).toBe(id);
      }
    } finally {
      api.probeInventory = real.inv;
      api.probeAudit = real.aud;
    }
  });
});

// -- Real clients on a fake transport ----------------------------------------

/** Fake axios.create(): records each instance config and routes post/get. */
function fakeAxios(respond) {
  const created = [];
  vi.spyOn(axios, 'create').mockImplementation((cfg) => {
    created.push(cfg);
    return {
      post: async (path) => respond({ cfg, method: 'POST', path }),
      get: async (path) => respond({ cfg, method: 'GET', path }),
    };
  });
  return created;
}

/** Fake https.request() for the packs (they cannot use axios). */
function fakeHttps(respond) {
  const calls = [];
  vi.spyOn(https, 'request').mockImplementation((opts, cb) => {
    const req = new EventEmitter();
    req.write = () => {};
    req.destroy = () => {};
    req.end = () => setImmediate(() => {
      calls.push(opts);
      let r;
      try { r = respond({ opts, method: opts.method, path: opts.path }); } catch (err) { req.emit('error', err); return; }
      const res = new EventEmitter();
      res.statusCode = r.status;
      res.headers = r.headers || {};
      cb(res);
      res.emit('data', Buffer.from(typeof r.body === 'string' ? r.body : JSON.stringify(r.body ?? null)));
      res.emit('end');
    });
    return req;
  });
  return calls;
}

const transportError = (code, message) => Object.assign(new Error(message), { code });
const httpError = (status, data) => Object.assign(new Error(`Request failed with status code ${status}`), { response: { status, data, headers: {} } });

const FAILURES = [
  ['refused', () => { throw transportError('ECONNREFUSED', 'connect ECONNREFUSED 10.1.2.3:443'); }, 'Could not reach the address.'],
  ['dns', () => { throw transportError('ENOTFOUND', 'getaddrinfo ENOTFOUND secret-internal-name.corp'); }, 'Could not reach the address.'],
  ['self-signed', () => { throw transportError('DEPTH_ZERO_SELF_SIGNED_CERT', 'self-signed certificate'); }, 'The TLS certificate was not trusted.'],
  ['timeout', () => { throw transportError('ECONNABORTED', 'timeout of 60000ms exceeded'); }, 'Timed out.'],
];

describe('real clients: redirects, session cache and failure text', () => {
  afterEach(() => { vi.restoreAllMocks(); });

  describe('services/vcenterApi.js', () => {
    const candidate = { host: 'vc.corp.example', username: 'u', password: 'p', ssl_verify: 1 };

    it('R4: every client instance is created with maxRedirects 0 for the dialled host', async () => {
      const created = fakeAxios(({ method }) => (method === 'POST' ? { data: 'tok' } : { data: [{}, {}] }));
      const out = await vcenterApi.testConnection(candidate);
      expect(out).toEqual({ ok: true, hosts: 2 });
      expect(created.length).toBeGreaterThanOrEqual(2);
      for (const cfg of created) {
        expect(cfg.maxRedirects).toBe(0);
        expect(cfg.baseURL).toBe('https://vc.corp.example');
        expect(cfg.httpsAgent.options.rejectUnauthorized).toBe(true);
      }
    });

    it('R6: a test handed a saved row never overwrites that row live session', async () => {
      let token = 'live-token';
      fakeAxios(({ method }) => (method === 'POST' ? { data: token } : { data: [] }));
      const saved = { id: 4242, ...candidate };
      expect(await vcenterApi.getSession(saved, true)).toBe('live-token');
      token = 'test-token';
      expect((await vcenterApi.testConnection(saved)).ok).toBe(true);
      expect(await vcenterApi.getSession(saved)).toBe('live-token');
      vcenterApi.invalidateSession(4242);
    });

    it.each(FAILURES)('failure text is fixed (%s)', async (_n, thrower, expected) => {
      fakeAxios(thrower);
      const out = await vcenterApi.testConnection(candidate);
      expect(out).toEqual({ ok: false, error: expected });
    });

    it('failure text never echoes an upstream body or a redirect target', async () => {
      fakeAxios(() => { throw httpError(500, { messages: [{ default_message: 'INTERNAL-BODY-TEXT' }] }); });
      expect(await vcenterApi.testConnection(candidate)).toEqual({ ok: false, error: 'Unexpected response from the address.' });
      vi.restoreAllMocks();
      fakeAxios(() => { throw httpError(302, 'moved to https://evil.example/'); });
      expect(await vcenterApi.testConnection(candidate)).toEqual({ ok: false, error: 'Unexpected response from the address.' });
      vi.restoreAllMocks();
      fakeAxios(() => { throw httpError(401, { error: 'nope' }); });
      expect((await vcenterApi.testConnection(candidate)).error).toBe('Sign-in was refused. Check the username and password.');
    });
  });

  describe('services/dellOmeApi.js', () => {
    const candidate = { host: 'ome.corp.example', username: 'u', password: 'p', ssl_verify: 0 };

    it('R4: every client instance is created with maxRedirects 0 for the dialled host', async () => {
      const created = fakeAxios(({ method }) => (method === 'POST'
        ? { headers: { 'x-auth-token': 'tok' }, data: {} }
        : { data: { '@odata.count': 3, value: [] } }));
      const out = await dellOmeApi.testConnection(candidate);
      expect(out.ok).toBe(true);
      expect(created.length).toBeGreaterThanOrEqual(2);
      for (const cfg of created) {
        expect(cfg.maxRedirects).toBe(0);
        expect(cfg.baseURL).toBe('https://ome.corp.example');
        expect(cfg.httpsAgent.options.rejectUnauthorized).toBe(false);
      }
    });

    it.each(FAILURES)('failure text is fixed (%s)', async (_n, thrower, expected) => {
      fakeAxios(thrower);
      expect(await dellOmeApi.testConnection(candidate)).toEqual({ ok: false, message: expected });
    });

    it('failure text never echoes the OME error body', async () => {
      fakeAxios(() => { throw httpError(400, { error: { '@Message.ExtendedInfo': [{ Message: 'INTERNAL-BODY-TEXT' }] } }); });
      expect(await dellOmeApi.testConnection(candidate)).toEqual({ ok: false, message: 'Unexpected response from the address.' });
      vi.restoreAllMocks();
      fakeAxios(() => { throw httpError(401, { error: { '@Message.ExtendedInfo': [{ Message: 'bad creds for svc-account' }] } }); });
      expect((await dellOmeApi.testConnection(candidate)).message).toBe('Sign-in was refused. Check the username and password.');
    });
  });

  describe('plugin-sdk/vcenter api.js', () => {
    const candidate = { host: 'vc.corp.example', username: 'u', password: 'p', ssl_verify: 1 };

    it('dials only the candidate host, honours its TLS flag, and cannot follow a redirect', async () => {
      const calls = fakeHttps(({ method }) => (method === 'POST'
        ? { status: 200, headers: { 'content-type': 'application/json' }, body: 'tok' }
        : { status: 200, headers: { 'content-type': 'application/json' }, body: [{}] }));
      expect(await vcPackApi.testConnection(candidate, vcPack.coreApi)).toEqual({ ok: true, hosts: 1 });
      for (const o of calls) {
        expect(o.hostname).toBe('vc.corp.example');
        expect(o.rejectUnauthorized).toBe(true);
      }
      vi.restoreAllMocks();
      const redirected = fakeHttps(() => ({ status: 302, headers: { location: 'https://evil.example/api/session' }, body: '' }));
      expect(await vcPackApi.testConnection(candidate, vcPack.coreApi)).toEqual({ ok: false, error: 'Unexpected response from the address.' });
      expect(redirected).toHaveLength(1); // the 302 was not followed
      expect(redirected[0].hostname).toBe('vc.corp.example');
    });

    it('R6: a test handed a saved row never overwrites that row live session', async () => {
      let token = 'live-token';
      fakeHttps(({ method }) => ({ status: 200, headers: { 'content-type': 'application/json' }, body: method === 'POST' ? token : [] }));
      const saved = { id: 4243, ...candidate };
      expect(await vcPackApi.getSession(saved, vcPack.coreApi, true)).toBe('live-token');
      token = 'test-token';
      expect((await vcPackApi.testConnection(saved, vcPack.coreApi)).ok).toBe(true);
      expect(await vcPackApi.getSession(saved, vcPack.coreApi)).toBe('live-token');
      vcPackApi.invalidateSession(4243);
    });

    it.each(FAILURES)('failure text is fixed (%s)', async (_n, thrower, expected) => {
      fakeHttps(thrower);
      expect(await vcPackApi.testConnection(candidate, vcPack.coreApi)).toEqual({ ok: false, error: expected });
    });

    it('failure text never echoes an upstream body', async () => {
      fakeHttps(() => ({ status: 500, headers: { 'content-type': 'application/json' }, body: { messages: [{ default_message: 'INTERNAL-BODY-TEXT' }] } }));
      expect(await vcPackApi.testConnection(candidate, vcPack.coreApi)).toEqual({ ok: false, error: 'Unexpected response from the address.' });
    });
  });

  describe('plugin-sdk/dell api.js', () => {
    const candidate = { host: 'ome.corp.example', username: 'u', password: 'p', ssl_verify: 1 };

    it('dials only the candidate host, honours its TLS flag, and cannot follow a redirect', async () => {
      const calls = fakeHttps(({ method }) => (method === 'POST'
        ? { status: 201, headers: { 'x-auth-token': 'tok' }, body: {} }
        : { status: 200, body: { '@odata.count': 1, value: [] } }));
      expect((await dellPackApi.testConnection(candidate, dellPack.coreApi)).ok).toBe(true);
      for (const o of calls) {
        expect(o.hostname).toBe('ome.corp.example');
        expect(o.rejectUnauthorized).toBe(true);
      }
      vi.restoreAllMocks();
      const redirected = fakeHttps(() => ({ status: 302, headers: { location: 'https://evil.example/' }, body: '' }));
      expect(await dellPackApi.testConnection(candidate, dellPack.coreApi)).toEqual({ ok: false, message: 'Unexpected response from the address.' });
      expect(redirected).toHaveLength(1);
    });

    it.each(FAILURES)('failure text is fixed (%s)', async (_n, thrower, expected) => {
      fakeHttps(thrower);
      expect(await dellPackApi.testConnection(candidate, dellPack.coreApi)).toEqual({ ok: false, message: expected });
    });

    it('failure text never echoes the OME error body', async () => {
      fakeHttps(() => ({ status: 400, body: { error: { '@Message.ExtendedInfo': [{ Message: 'INTERNAL-BODY-TEXT' }] } } }));
      expect(await dellPackApi.testConnection(candidate, dellPack.coreApi)).toEqual({ ok: false, message: 'Unexpected response from the address.' });
    });
  });

  it('the fixed message set is closed', () => {
    expect(new Set(FAILURES.map((f) => f[2])).size).toBeLessThanOrEqual(SAFE_MESSAGES.length);
    for (const f of FAILURES) expect(SAFE_MESSAGES).toContain(f[2]);
  });
});
