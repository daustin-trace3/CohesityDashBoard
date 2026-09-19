/**
 * Credential forwarding, pack-only platforms: Proxmox, NetBackup (sources and
 * appliance connections), Nutanix (Prism sources and Move connections), Rubrik.
 *
 * Each pack is loaded from plugin-sdk/<id>/backend/src and its bare router is
 * called directly. Nothing reaches the network: node's https.request (and, for
 * Rubrik, global fetch) is replaced by a recorder, so every assertion is about
 * what the platform client actually tried to send and where.
 */
import { describe, it, expect, beforeAll, beforeEach, afterAll, vi } from 'vitest';
import { createRequire } from 'module';
import { EventEmitter } from 'events';
import path from 'path';

const require = createRequire(import.meta.url);
const https = require('https');
const { loadPack } = require('./helpers/packRouter');
const { encrypt, decrypt } = require('../services/encryption');

const MESSAGE = 'Enter the password or token again when changing the address. A saved credential is only ever sent to the address it was saved for.';
const BLOCKED = ['127.0.0.1', 'localhost', '169.254.169.254', '[::1]', '::ffff:127.0.0.1'];
const UPSTREAM_BODY = 'UPSTREAM-BODY-'.repeat(40);

const packSrc = (id, file) => require(path.join('..', '..', 'plugin-sdk', id, 'backend', 'src', file));

// ---- https.request recorder -------------------------------------------------

let calls = [];
let responder;

/** One answer fits every client here: NetBackup and the appliance read
 *  `token`, Move reads `Status.Token`, Proxmox reads `data`, Prism `version`. */
const defaultResponder = (call) => {
  if (/\/ping$/.test(call.path)) return { status: 200, body: UPSTREAM_BODY };
  return { status: 200, body: { token: 'tok', Status: { Token: 'tok', Version: '5.1' }, data: { version: '8.2', release: '8' }, version: '6.5' } };
};

function fakeRequest(opts, cb) {
  const call = {
    hostname: opts.hostname, port: opts.port, path: opts.path, method: opts.method,
    rejectUnauthorized: opts.rejectUnauthorized, headers: opts.headers || {}, body: '',
  };
  calls.push(call);
  const req = new EventEmitter();
  req.write = (chunk) => { call.body += chunk; };
  req.destroy = () => {};
  req.end = () => {
    setImmediate(() => {
      const out = responder(call);
      if (out.error) { req.emit('error', out.error); return; }
      const res = new EventEmitter();
      res.statusCode = out.status || 200;
      res.headers = out.headers || {};
      res.resume = () => {};
      cb(res);
      res.emit('data', typeof out.body === 'string' ? out.body : JSON.stringify(out.body === undefined ? null : out.body));
      res.emit('end');
    });
  };
  return req;
}

let requestSpy;
const packs = {};

beforeAll(() => {
  requestSpy = vi.spyOn(https, 'request').mockImplementation(fakeRequest);
  for (const id of ['proxmox', 'netbackup', 'nutanix', 'rubrik']) packs[id] = loadPack(id);
});

beforeEach(() => {
  calls = [];
  responder = defaultResponder;
});

afterAll(() => {
  // Updates re-schedule the pack pollers; stop them so nothing outlives the file.
  const stop = (fn) => { try { fn(); } catch { /* poller never built */ } };
  stop(() => packSrc('proxmox', 'poller.js').getPoller(packs.proxmox.coreApi).stopAll());
  stop(() => packSrc('netbackup', 'poller.js').getSourcePoller(packs.netbackup.coreApi).stopAll());
  stop(() => packSrc('netbackup', 'poller.js').getAppliancePoller(packs.netbackup.coreApi).stopAll());
  stop(() => packSrc('nutanix', 'poller.js').getPoller(packs.nutanix.coreApi).stopAll());
  stop(() => packSrc('nutanix', 'poller.js').getMovePoller(packs.nutanix.coreApi).stopAll());
  requestSpy.mockRestore();
});

const basic = (header) => {
  const [user, ...rest] = Buffer.from(String(header || '').replace(/^Basic /, ''), 'base64').toString('utf8').split(':');
  return { user, secret: rest.join(':') };
};
const jsonBody = (call) => { try { return JSON.parse(call.body); } catch { return {}; } };

// ---- the five host/port style source types ------------------------------------

const SOURCE_TYPES = [
  {
    label: 'Proxmox server',
    pack: 'proxmox',
    table: 'proxmox_servers',
    base: '/servers',
    secretKey: 'tokenSecret',
    userKey: 'tokenId',
    userColumn: 'token_id',
    storedUser: 'root@pam!icc',
    storedPort: 8006,
    hasPort: true,
    createExtra: {},
    seed: (db) => db.prepare(`INSERT INTO proxmox_servers (name, host, port, token_id, encrypted_credentials, ssl_verify, polling_interval_minutes)
      VALUES ('pve-saved', 'pve.corp.example', 8006, 'root@pam!icc', ?, 1, 10)`).run(encrypt(JSON.stringify({ tokenSecret: 'stored-secret' }))).lastInsertRowid,
    savedSecret: (row) => JSON.parse(decrypt(row.encrypted_credentials)).tokenSecret,
    // The token secret travels as an Authorization header: PVEAPIToken=<id>=<secret>
    sent: () => {
      const call = calls.find((c) => /^\/api2\/json\/version/.test(c.path));
      const m = /^PVEAPIToken=(.*)=([^=]*)$/.exec(call.headers.Authorization || '');
      return { call, user: m && m[1], secret: m && m[2] };
    },
  },
  {
    label: 'NetBackup primary source',
    pack: 'netbackup',
    table: 'netbackup_sources',
    base: '/sources',
    secretKey: 'password',
    userKey: 'username',
    userColumn: 'username',
    storedUser: 'svc-nbu',
    storedPort: 1556,
    hasPort: true,
    createExtra: {},
    invalidate: () => [packSrc('netbackup', 'netbackupApi.js'), 'invalidateSession'],
    prime: (row, coreApi) => packSrc('netbackup', 'netbackupApi.js').apiRequest(row, coreApi, 'get', '/config/hosts'),
    seed: (db) => db.prepare(`INSERT INTO netbackup_sources (name, source_type, host, port, auth_mode, username, encrypted_credentials, ssl_verify, polling_interval_minutes)
      VALUES ('nbu-saved', 'primary', 'nbu.corp.example', 1556, 'password', 'svc-nbu', ?, 1, 15)`).run(encrypt(JSON.stringify({ password: 'stored-secret' }))).lastInsertRowid,
    savedSecret: (row) => JSON.parse(decrypt(row.encrypted_credentials)).password,
    sent: () => {
      const call = calls.find((c) => c.path === '/netbackup/login');
      const body = jsonBody(call);
      return { call, user: body.userName, secret: body.password };
    },
  },
  {
    label: 'NetBackup appliance connection',
    pack: 'netbackup',
    table: 'netbackup_appliance_conns',
    base: '/appliance-connections',
    secretKey: 'password',
    userKey: 'username',
    userColumn: 'username',
    storedUser: 'svc-appl',
    storedPort: 443,
    hasPort: true,
    createExtra: {},
    invalidate: () => [packSrc('netbackup', 'netbackupApplianceApi.js'), 'invalidateSession'],
    prime: (row, coreApi) => packSrc('netbackup', 'netbackupApplianceApi.js').apiRequest(row, coreApi, 'get', '/api/appliance/v1.0/hardware/health'),
    seed: (db) => db.prepare(`INSERT INTO netbackup_appliance_conns (name, host, port, username, encrypted_credentials, ssl_verify, polling_interval_minutes)
      VALUES ('appl-saved', 'appl.corp.example', 443, 'svc-appl', ?, 1, 30)`).run(encrypt(JSON.stringify({ password: 'stored-secret' }))).lastInsertRowid,
    savedSecret: (row) => JSON.parse(decrypt(row.encrypted_credentials)).password,
    sent: () => {
      const call = calls.find((c) => c.path === '/api/appliance/v1.0/auth/login');
      const body = jsonBody(call);
      return { call, user: body.userName, secret: body.password };
    },
  },
  {
    label: 'Nutanix Prism source',
    pack: 'nutanix',
    table: 'nutanix_sources',
    base: '/sources',
    secretKey: 'password',
    userKey: 'username',
    userColumn: 'username',
    storedUser: 'svc-prism',
    storedPort: 9440,
    hasPort: true,
    createExtra: { sourceType: 'prism_element' },
    invalidate: () => [packSrc('nutanix', 'api.js'), 'invalidateSession'],
    prime: (row, coreApi) => packSrc('nutanix', 'api.js').fetchPECluster(row, coreApi),
    seed: (db) => db.prepare(`INSERT INTO nutanix_sources (name, source_type, host, port, username, encrypted_credentials, ssl_verify, polling_interval_minutes)
      VALUES ('prism-saved', 'prism_element', 'prism.corp.example', 9440, 'svc-prism', ?, 1, 15)`).run(encrypt(JSON.stringify({ password: 'stored-secret' }))).lastInsertRowid,
    savedSecret: (row) => JSON.parse(decrypt(row.encrypted_credentials)).password,
    sent: () => {
      const call = calls.find((c) => c.headers.Authorization);
      return { call, ...basic(call.headers.Authorization) };
    },
  },
  {
    label: 'Nutanix Move connection',
    pack: 'nutanix',
    table: 'nutanix_move_conns',
    base: '/move/connections',
    secretKey: 'password',
    userKey: 'username',
    userColumn: 'username',
    storedUser: 'svc-move',
    storedPort: 443,
    hasPort: false,
    createExtra: {},
    invalidate: () => [packSrc('nutanix', 'moveApi.js'), 'invalidateToken'],
    prime: (row, coreApi) => packSrc('nutanix', 'moveApi.js').fetchAppInfo(row, coreApi),
    seed: (db) => db.prepare(`INSERT INTO nutanix_move_conns (name, host, username, encrypted_credentials, ssl_verify)
      VALUES ('move-saved', 'move.corp.example', 'svc-move', ?, 1)`).run(encrypt(JSON.stringify({ password: 'stored-secret' }))).lastInsertRowid,
    savedSecret: (row) => JSON.parse(decrypt(row.encrypted_credentials)).password,
    sent: () => {
      const call = calls.find((c) => c.path === '/move/v2/users/login');
      const spec = jsonBody(call).Spec || {};
      return { call, user: spec.UserName, secret: spec.Password };
    },
  },
];

for (const t of SOURCE_TYPES) {
  describe(`${t.label}: a saved credential only travels to the saved address`, () => {
    let pack;
    let id;
    let storedHost;
    const rowNow = () => pack.db.prepare(`SELECT * FROM ${t.table} WHERE id = ?`).get(id);
    const everyCallWentTo = (host) => calls.length > 0 && calls.every((c) => c.hostname === host);

    beforeAll(() => {
      pack = packs[t.pack];
      id = Number(t.seed(pack.db));
      storedHost = rowNow().host;
    });

    it('R1 test with { id, host: evil } and no secret dials the STORED host, port, TLS flag and account with the stored secret', async () => {
      const res = await pack.call('POST', `${t.base}/test`, {
        id, host: 'evil.example', port: 22, sslVerify: false, [t.userKey]: 'attacker',
      });
      expect(res.status).toBe(200);
      expect(res.body.ok).toBe(true);
      expect(everyCallWentTo(storedHost)).toBe(true);
      expect(calls.some((c) => c.hostname === 'evil.example')).toBe(false);
      const sent = t.sent();
      expect(sent.call.hostname).toBe(storedHost);
      expect(Number(sent.call.port)).toBe(t.storedPort); // body said 22
      expect(sent.call.rejectUnauthorized).toBe(true); // stored ssl_verify = 1, the body said false
      expect(sent.user).toBe(t.storedUser);
      expect(sent.secret).toBe('stored-secret');
    });

    it('R1 test with a typed secret dials the body address with the typed secret; the stored secret is not used', async () => {
      const res = await pack.call('POST', `${t.base}/test`, {
        id, host: 'new.example', sslVerify: false, [t.userKey]: 'typed-user', [t.secretKey]: 'typed-secret',
      });
      expect(res.status).toBe(200);
      expect(everyCallWentTo('new.example')).toBe(true);
      const sent = t.sent();
      expect(sent.call.rejectUnauthorized).toBe(false);
      expect(sent.user).toBe('typed-user');
      expect(sent.secret).toBe('typed-secret');
      expect(JSON.stringify(calls)).not.toContain('stored-secret');
    });

    it('R6 a test never sends, drops or replaces the live session of the saved source', async () => {
      if (!t.prime) return; // Proxmox keeps no session: the secret rides on every request
      // A poll has logged in: the client now holds a live token / cookie for this source id.
      responder = () => ({
        status: 200,
        headers: { 'set-cookie': ['NTNX_SESSION=live-cookie; Path=/; HttpOnly'] },
        body: { token: 'live-token', Status: { Token: 'live-token' }, version: '6.5' },
      });
      await t.prime(rowNow(), pack.coreApi);
      expect(t.sent().secret).toBe('stored-secret');

      // Typed-secret test against another address: the live session must not go there.
      calls = [];
      responder = defaultResponder;
      const typed = await pack.call('POST', `${t.base}/test`, { id, host: 'new.example', [t.secretKey]: 'typed-secret' });
      expect(typed.status).toBe(200);
      expect(calls.every((c) => c.hostname === 'new.example')).toBe(true);
      expect(JSON.stringify(calls)).not.toContain('live-');
      expect(t.sent().secret).toBe('typed-secret');

      // The live session is still there for the next poll: no new login, same token.
      calls = [];
      await t.prime(rowNow(), pack.coreApi);
      expect(calls.length).toBeGreaterThan(0);
      expect(calls.every((c) => c.hostname === storedHost && JSON.stringify(c.headers).includes('live-'))).toBe(true);
    });

    it('R3 test accepts a 10.x address and an ordinary DNS name', async () => {
      const res = await pack.call('POST', `${t.base}/test`, { id, host: '10.1.2.3', [t.secretKey]: 'typed-secret' });
      expect(res.status).toBe(200);
      expect(everyCallWentTo('10.1.2.3')).toBe(true);
    });

    it('R3 test, create and PUT refuse loopback, link-local and metadata addresses', async () => {
      const before = JSON.stringify(rowNow());
      for (const host of BLOCKED) {
        const test = await pack.call('POST', `${t.base}/test`, { host, ...t.createExtra, [t.userKey]: 'u', [t.secretKey]: 's' });
        expect([host, test.status]).toEqual([host, 400]);
        const testSaved = await pack.call('POST', `${t.base}/test`, { id, host, [t.secretKey]: 's' });
        expect([host, testSaved.status]).toEqual([host, 400]);
        const create = await pack.call('POST', t.base, { name: `blocked ${host}`, host, ...t.createExtra, [t.userKey]: 'u', [t.secretKey]: 's' });
        expect([host, create.status]).toEqual([host, 400]);
        expect(create.body.details[0].msg).toBe('that address is not allowed');
        const put = await pack.call('PUT', `${t.base}/${id}`, { host, [t.secretKey]: 's' });
        expect([host, put.status]).toEqual([host, 400]);
      }
      expect(calls).toEqual([]);
      expect(JSON.stringify(rowNow())).toBe(before);
      expect(pack.db.prepare(`SELECT COUNT(*) n FROM ${t.table} WHERE name LIKE 'blocked %'`).get().n).toBe(0);
    });

    it('a failed test returns a fixed message, never transport text or an upstream body', async () => {
      responder = () => ({ error: Object.assign(new Error('connect ECONNREFUSED 10.1.2.3:8006'), { code: 'ECONNREFUSED' }) });
      const refused = await pack.call('POST', `${t.base}/test`, { id });
      expect(refused.status).toBe(502);
      expect(refused.body.error).toBe('Could not reach the address.');
      expect(JSON.stringify(refused.body)).not.toContain('10.1.2.3');

      responder = () => ({ status: 500, body: { message: UPSTREAM_BODY, errorMessage: UPSTREAM_BODY } });
      const upstream = await pack.call('POST', `${t.base}/test`, { id });
      expect(upstream.status).toBe(502);
      expect(JSON.stringify(upstream.body)).not.toContain('UPSTREAM-BODY');

      responder = () => ({ error: Object.assign(new Error('self-signed certificate'), { code: 'DEPTH_ZERO_SELF_SIGNED_CERT' }) });
      const tls = await pack.call('POST', `${t.base}/test`, { id });
      expect(tls.body.error).toBe('The TLS certificate was not trusted.');
    });

    it('R2 PUT that changes the host with a blank secret is 400 with the contract message and the row is unchanged', async () => {
      const before = JSON.stringify(rowNow());
      for (const body of [{ host: 'evil.example' }, { host: 'evil.example', [t.secretKey]: '' }]) {
        const res = await pack.call('PUT', `${t.base}/${id}`, body);
        expect(res.status).toBe(400);
        expect(res.body.error).toBe(MESSAGE);
      }
      expect(JSON.stringify(rowNow())).toBe(before);
    });

    it('R2 PUT that changes the port, or turns certificate verification off, with a blank secret is 400', async () => {
      const before = JSON.stringify(rowNow());
      if (t.hasPort) {
        const port = await pack.call('PUT', `${t.base}/${id}`, { port: 2222 });
        expect(port.status).toBe(400);
        expect(port.body.error).toBe(MESSAGE);
      }
      const tls = await pack.call('PUT', `${t.base}/${id}`, { sslVerify: false });
      expect(tls.status).toBe(400);
      expect(tls.body.error).toBe(MESSAGE);
      expect(JSON.stringify(rowNow())).toBe(before);
    });

    it('R2 PUT with the same address and a blank secret succeeds: rename, account name only, omitted sslVerify kept', async () => {
      const rename = await pack.call('PUT', `${t.base}/${id}`, { name: `${t.label} renamed`, host: ` ${storedHost.toUpperCase()} `, ...(t.hasPort ? { port: String(t.storedPort) } : {}) });
      expect(rename.status).toBe(200);
      // A username (or token id) is not an address: it may change while the saved secret is kept.
      const account = await pack.call('PUT', `${t.base}/${id}`, { [t.userKey]: 'other-account' });
      expect(account.status).toBe(200);
      const row = rowNow();
      expect(row.name).toBe(`${t.label} renamed`);
      expect(row[t.userColumn]).toBe('other-account');
      expect(row.host.toLowerCase()).toBe(storedHost);
      expect(row.ssl_verify).toBe(1); // never silently reset to off
      expect(t.savedSecret(row)).toBe('stored-secret');
    });

    it('R2/R5 PUT that changes the address with a typed secret succeeds and drops the cached session', async () => {
      const spy = t.invalidate ? vi.spyOn(...t.invalidate()) : null;
      const res = await pack.call('PUT', `${t.base}/${id}`, { host: 'new.example', sslVerify: false, [t.secretKey]: 'typed-secret' });
      expect(res.status).toBe(200);
      const row = rowNow();
      expect(row.host).toBe('new.example');
      expect(row.ssl_verify).toBe(0);
      expect(t.savedSecret(row)).toBe('typed-secret');
      expect(JSON.stringify(res.body)).not.toContain('typed-secret');
      if (spy) {
        expect(spy).toHaveBeenCalledWith(id);
        spy.mockRestore();
      }
    });
  });
}

// ---- NetBackup specifics -------------------------------------------------------

describe('NetBackup source: auth mode and Alta base URL', () => {
  let pack;
  let id;
  const rowNow = () => pack.db.prepare('SELECT * FROM netbackup_sources WHERE id = ?').get(id);

  beforeAll(() => {
    pack = packs.netbackup;
    id = Number(pack.db.prepare(`INSERT INTO netbackup_sources (name, source_type, host, port, auth_mode, username, encrypted_credentials, ssl_verify, polling_interval_minutes)
      VALUES ('nbu-mode', 'primary', 'nbu2.corp.example', 1556, 'password', 'svc-nbu', ?, 1, 15)`).run(encrypt(JSON.stringify({ password: 'stored-secret' }))).lastInsertRowid);
  });

  it('an apiKey typed on a password-mode source is not stored, so it does not unlock a new host', async () => {
    const before = JSON.stringify(rowNow());
    const res = await pack.call('PUT', `/sources/${id}`, { host: 'evil.example', apiKey: 'anything' });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe(MESSAGE);
    expect(JSON.stringify(rowNow())).toBe(before);
  });

  it('the same trick on the test route still dials the stored host with the stored password', async () => {
    const res = await pack.call('POST', '/sources/test', { id, host: 'evil.example', apiKey: 'anything' });
    expect(res.status).toBe(200);
    expect(calls.every((c) => c.hostname === 'nbu2.corp.example')).toBe(true);
    expect(JSON.parse(calls.find((c) => c.path === '/netbackup/login').body).password).toBe('stored-secret');
  });

  it('switching sourceType with a blank secret is refused (it changes how host becomes a URL)', async () => {
    const res = await pack.call('PUT', `/sources/${id}`, { sourceType: 'alta', host: 'https://nbu2.corp.example' });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe(MESSAGE);
  });

  it('the test result carries no upstream /ping body', async () => {
    const res = await pack.call('POST', '/sources/test', { id });
    expect(res.status).toBe(200);
    expect(calls.some((c) => /\/ping$/.test(c.path))).toBe(true);
    expect(res.body).toEqual({ ok: true, version: null });
  });

  it('an Alta base URL must be https, with no userinfo, and not a blocked host', async () => {
    const alta = { name: 'alta-bad', sourceType: 'alta', authMode: 'apikey', apiKey: 'k' };
    for (const host of ['http://alta.example', 'https://user:pw@alta.example', 'alta.example', 'https://169.254.169.254/netbackup', 'https://localhost']) {
      const create = await pack.call('POST', '/sources', { ...alta, host });
      expect([host, create.status]).toEqual([host, 400]);
      const test = await pack.call('POST', '/sources/test', { ...alta, host });
      expect([host, test.status]).toEqual([host, 400]);
    }
    expect(calls).toEqual([]);
    expect(pack.db.prepare("SELECT COUNT(*) n FROM netbackup_sources WHERE name = 'alta-bad'").get().n).toBe(0);
  });

  it('an https Alta base URL is dialled with the typed API key', async () => {
    const res = await pack.call('POST', '/sources/test', { sourceType: 'alta', authMode: 'apikey', apiKey: 'typed-key', host: 'https://tenant.alta.example/netbackup' });
    expect(res.status).toBe(200);
    expect(calls.every((c) => c.hostname === 'tenant.alta.example')).toBe(true);
    expect(calls[0].headers.Authorization).toBe('typed-key');
  });
});

// ---- Rubrik (endpoint URL, OAuth client secret, global fetch) -----------------

describe('Rubrik connection: a saved client secret only travels to the saved endpoint', () => {
  let pack;
  let id;
  let fetchCalls;
  let fetchResponder;
  const realFetch = globalThis.fetch;
  const rowNow = () => pack.db.prepare('SELECT * FROM rubrik_connections WHERE id = ?').get(id);

  const okFetch = (call) => {
    const host = new URL(call.url).hostname;
    if (call.url.endsWith('/api/client_token')) return { status: 200, body: { access_token: `bearer-from-${host}`, expires_in: 3600 } };
    return { status: 200, body: { data: { clusterConnection: { nodes: [{ id: 'c1', state: { connectedState: 'Connected' } }] } } } };
  };

  beforeAll(() => {
    pack = packs.rubrik;
    id = Number(pack.db.prepare(`INSERT INTO rubrik_connections (name, kind, endpoint, identity, encrypted_credentials)
      VALUES ('rsc-saved', 'rsc', 'https://rsc.corp.example', 'client|stored', ?)`).run(encrypt(JSON.stringify({ secret: 'stored-secret' }))).lastInsertRowid);
    globalThis.fetch = async (url, init = {}) => {
      const call = { url: String(url), init, body: init.body ? JSON.parse(init.body) : null };
      fetchCalls.push(call);
      const out = fetchResponder(call);
      if (out.error) throw out.error;
      const text = typeof out.body === 'string' ? out.body : JSON.stringify(out.body);
      return { ok: out.status >= 200 && out.status < 300, status: out.status, text: async () => text };
    };
  });

  beforeEach(() => {
    fetchCalls = [];
    fetchResponder = okFetch;
  });

  afterAll(() => { globalThis.fetch = realFetch; });

  const tokenCalls = () => fetchCalls.filter((c) => c.url.endsWith('/api/client_token'));
  const gqlCalls = () => fetchCalls.filter((c) => c.url.endsWith('/api/graphql'));

  it('R1 test with { id, endpoint: evil } and no secret uses the stored endpoint with the stored secret', async () => {
    const res = await pack.call('POST', '/connections/test', { id, endpoint: 'https://evil.example', identity: 'attacker' });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ ok: true, authenticated: true, clusters: 1 });
    expect(fetchCalls.length).toBe(2);
    expect(fetchCalls.every((c) => c.url.startsWith('https://rsc.corp.example/'))).toBe(true);
    expect(tokenCalls()[0].body).toEqual({ client_id: 'client|stored', client_secret: 'stored-secret' });
    expect(gqlCalls()[0].init.headers.Authorization).toBe('Bearer bearer-from-rsc.corp.example');
  });

  it('R4 every fetch that carries the client secret or a bearer refuses redirects', async () => {
    const rscApi = packSrc('rubrik', 'rscApi.js');
    rscApi.forgetToken(id);
    await pack.call('POST', '/connections/test', { id });
    expect(tokenCalls().length).toBe(1);
    expect(gqlCalls().length).toBe(1);
    expect(fetchCalls.every((c) => c.init.redirect === 'error')).toBe(true);
  });

  it('R1 test with a typed secret uses the body endpoint, the typed secret and a fresh token: the cached bearer stays home', async () => {
    // the previous tests left a bearer for the stored endpoint in the token cache
    const res = await pack.call('POST', '/connections/test', { id, endpoint: 'https://new.example', identity: 'client|typed', secret: 'typed-secret' });
    expect(res.status).toBe(200);
    expect(fetchCalls.every((c) => c.url.startsWith('https://new.example/'))).toBe(true);
    expect(tokenCalls()[0].body).toEqual({ client_id: 'client|typed', client_secret: 'typed-secret' });
    expect(gqlCalls()[0].init.headers.Authorization).toBe('Bearer bearer-from-new.example');
    expect(JSON.stringify(fetchCalls)).not.toContain('stored-secret');
    expect(JSON.stringify(fetchCalls)).not.toContain('bearer-from-rsc.corp.example');
  });

  it('the typed-secret test did not replace the live token of the saved connection', async () => {
    await pack.call('POST', '/connections/test', { id });
    expect(tokenCalls().length).toBe(0); // still cached
    expect(gqlCalls()[0].url).toBe('https://rsc.corp.example/api/graphql');
    expect(gqlCalls()[0].init.headers.Authorization).toBe('Bearer bearer-from-rsc.corp.example');
  });

  it('R3 endpoint must be https with no userinfo, query or fragment, and not a blocked host (create, PUT, test)', async () => {
    const before = JSON.stringify(rowNow());
    const bad = [
      'http://rsc.corp.example', 'ftp://rsc.corp.example', 'not a url',
      'https://user:pw@rsc.corp.example', 'https://rsc.corp.example/?x=1', 'https://rsc.corp.example/#frag', 'https://rsc.corp.example/?',
      'https://127.0.0.1', 'https://localhost', 'https://169.254.169.254', 'https://[::1]', 'https://[::ffff:127.0.0.1]',
    ];
    for (const endpoint of bad) {
      const create = await pack.call('POST', '/connections', { name: `bad ${endpoint}`, kind: 'rsc', endpoint, identity: 'c', secret: 's' });
      expect([endpoint, create.status]).toEqual([endpoint, 400]);
      const put = await pack.call('PUT', `/connections/${id}`, { endpoint, secret: 's' });
      expect([endpoint, put.status]).toEqual([endpoint, 400]);
      const test = await pack.call('POST', '/connections/test', { endpoint });
      expect([endpoint, test.status]).toEqual([endpoint, 400]);
      const testSaved = await pack.call('POST', '/connections/test', { id, endpoint, secret: 's' });
      expect([endpoint, testSaved.status]).toEqual([endpoint, 400]);
    }
    expect(fetchCalls).toEqual([]);
    expect(calls).toEqual([]);
    expect(JSON.stringify(rowNow())).toBe(before);
    expect(pack.db.prepare("SELECT COUNT(*) n FROM rubrik_connections WHERE name LIKE 'bad %'").get().n).toBe(0);
  });

  it('R3 a 10.x endpoint is accepted', async () => {
    const res = await pack.call('POST', '/connections/test', { id, endpoint: 'https://10.1.2.3', secret: 'typed-secret' });
    expect(res.status).toBe(200);
    expect(fetchCalls.every((c) => c.url.startsWith('https://10.1.2.3/'))).toBe(true);
  });

  it('a failed test returns a fixed message, never the upstream body or transport text', async () => {
    const rscApi = packSrc('rubrik', 'rscApi.js');
    rscApi.forgetToken(id);
    fetchResponder = () => ({ status: 500, body: UPSTREAM_BODY });
    const upstream = await pack.call('POST', '/connections/test', { id });
    expect(upstream.body.ok).toBe(false);
    expect(upstream.body.error).toBe('Unexpected response.');
    expect(rowNow().last_test_error).toBe('Unexpected response.');

    fetchResponder = () => ({ status: 401, body: UPSTREAM_BODY });
    const refused = await pack.call('POST', '/connections/test', { id });
    expect(refused.body.error).toBe('Sign-in was refused.');

    fetchResponder = (call) => (call.url.endsWith('/api/client_token') ? okFetch(call) : { status: 200, body: { errors: [{ message: UPSTREAM_BODY }] } });
    const gqlError = await pack.call('POST', '/connections/test', { id });
    expect(JSON.stringify(gqlError.body)).not.toContain('UPSTREAM-BODY');
    rscApi.forgetToken(id);

    fetchResponder = () => ({ error: Object.assign(new TypeError('fetch failed'), { cause: Object.assign(new Error('connect ECONNREFUSED 10.1.2.3:443'), { code: 'ECONNREFUSED' }) }) });
    const transport = await pack.call('POST', '/connections/test', { id });
    expect(transport.body.error).toBe('Could not reach the address.');
    expect(JSON.stringify(transport.body)).not.toContain('10.1.2.3');
  });

  it('the reachability check (no saved secret involved) maps transport errors too', async () => {
    responder = () => ({ error: Object.assign(new Error('connect ECONNREFUSED 10.9.9.9:443'), { code: 'ECONNREFUSED' }) });
    const res = await pack.call('POST', '/connections/test', { endpoint: 'https://cdm.corp.example' });
    expect(res.body).toEqual({ ok: false, error: 'Could not reach the address.' });
    expect(calls.every((c) => c.hostname === 'cdm.corp.example')).toBe(true);
  });

  it('R2 PUT that changes the endpoint, or the kind, with a blank secret is 400 and the row is unchanged', async () => {
    const before = JSON.stringify(rowNow());
    for (const body of [{ endpoint: 'https://evil.example' }, { endpoint: 'https://evil.example', secret: '' }, { kind: 'cdm' }]) {
      const res = await pack.call('PUT', `/connections/${id}`, body);
      expect(res.status).toBe(400);
      expect(res.body.error).toBe(MESSAGE);
    }
    expect(JSON.stringify(rowNow())).toBe(before);
  });

  it('R2 PUT with the same endpoint and a blank secret succeeds: rename and identity only', async () => {
    const res = await pack.call('PUT', `/connections/${id}`, { name: 'rsc renamed', endpoint: 'https://RSC.corp.example/', identity: 'client|other' });
    expect(res.status).toBe(200);
    const row = rowNow();
    expect(row.name).toBe('rsc renamed');
    expect(row.identity).toBe('client|other');
    expect(JSON.parse(decrypt(row.encrypted_credentials)).secret).toBe('stored-secret');
  });

  it('R2/R5 PUT with a new endpoint and a typed secret succeeds and the cached bearer never goes to the new endpoint', async () => {
    const rscApi = packSrc('rubrik', 'rscApi.js');
    // make sure a bearer for the old endpoint is cached first
    await pack.call('PUT', `/connections/${id}`, { endpoint: 'https://rsc.corp.example' });
    await pack.call('POST', '/connections/test', { id });
    fetchCalls = [];
    const forget = vi.spyOn(rscApi, 'forgetToken');

    const res = await pack.call('PUT', `/connections/${id}`, { endpoint: 'https://new.example', secret: 'typed-secret' });
    expect(res.status).toBe(200);
    expect(forget).toHaveBeenCalledWith(id);
    forget.mockRestore();
    expect(JSON.stringify(res.body)).not.toContain('typed-secret');
    expect(rowNow().endpoint).toBe('https://new.example');

    await pack.call('POST', '/connections/test', { id });
    expect(fetchCalls.every((c) => c.url.startsWith('https://new.example/'))).toBe(true);
    expect(tokenCalls()[0].body.client_secret).toBe('typed-secret');
    expect(gqlCalls()[0].init.headers.Authorization).toBe('Bearer bearer-from-new.example');
  });

  it('an older row that holds a plain http endpoint never receives the client secret', async () => {
    const legacy = Number(pack.db.prepare(`INSERT INTO rubrik_connections (name, kind, endpoint, identity, encrypted_credentials)
      VALUES ('rsc-legacy-http', 'rsc', 'http://legacy.corp.example', 'client|legacy', ?)`).run(encrypt(JSON.stringify({ secret: 'legacy-secret' }))).lastInsertRowid);
    const rscApi = packSrc('rubrik', 'rscApi.js');
    const result = await rscApi.verifyCredentials(pack.coreApi, pack.db.prepare('SELECT * FROM rubrik_connections WHERE id = ?').get(legacy));
    expect(result).toMatchObject({ ok: false, error: 'The endpoint must use https.' });
    expect(fetchCalls).toEqual([]);
  });
});
