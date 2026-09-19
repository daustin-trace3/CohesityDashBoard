/**
 * A saved credential only ever travels to the address it was saved for.
 * Brocade SANnav (with the direct-FOS shared password, the per-switch FOS
 * overrides and the fos-test route) and BlueCat host routers.
 *
 * Every R1 case asserts on what the platform client RECEIVED (host, port, TLS
 * flag, username, and which secret it would sign in with), not only on the
 * HTTP status. The lower half drives the real clients on a fake transport to
 * prove R4 (a redirect is a failure and is never followed), R5 (logout drops
 * the cached session before anything can reuse it) and that a failed test
 * never echoes transport text or an upstream body.
 */
import { describe, it, expect, beforeAll, beforeEach, afterEach, vi } from 'vitest';
import { createRequire } from 'module';
import express from 'express';
import request from 'supertest';

const require = createRequire(import.meta.url);
const db = require('../db/database');
const { encrypt, decrypt } = require('../services/encryption');
const axios = require('axios');

const MESSAGE = 'Enter the password or token again when changing the address. A saved credential is only ever sent to the address it was saved for.';
const BLOCKED = ['127.0.0.1', 'localhost', '169.254.169.254', '[::1]', '::ffff:127.0.0.1'];
const ALLOWED = ['10.20.30.40', 'fresh.corp.example'];
const SAFE_MESSAGES = [
  'Sign-in was refused. Check the username and password.',
  'Sign-in was refused. Check the API key.',
  'Unexpected response from the address.',
  'The TLS certificate was not trusted.',
  'Timed out.',
  'Could not reach the address.',
];

const SAVED_HOST = 'saved.corp.example';
const SAVED_PORT = 8443;
const SAVED_USER = 'svc-saved';
const SAVED_SECRET = 'saved-secret';

const quietPoller = (p) => {
  p.schedule = () => {};
  p.cancel = () => {};
  p.trigger = async () => {};
};

// -- Platform descriptions ------------------------------------------------------

const PLATFORMS = {
  brocade: {
    table: 'brocade_sources',
    secretKey: 'password',
    sslBodyKey: 'verifySsl',
    sslCol: 'verify_ssl',
    hasUsername: true,
    cachesSessions: true,
    seed() {
      return db.prepare(`
        INSERT INTO brocade_sources (name, host, port, username, password_enc, verify_ssl)
        VALUES ('saved-sannav', ?, ?, ?, ?, 1)
      `).run(SAVED_HOST, SAVED_PORT, SAVED_USER, encrypt(SAVED_SECRET)).lastInsertRowid;
    },
    testRoutes: [(id, body) => [`/sources/${id}/test`, body]],
    noIdNoSecret: [['/sources/0/test', { host: 'new.example', username: 'u' }, 404]],
    createBody: (host, n) => ({ name: `created-${n}`, host, username: 'u', password: 'p' }),
    created: (body) => body.source,
    updated: (body) => body.source,
    received(c) {
      return {
        host: c.host, port: c.port, tls: c.verify_ssl ? 1 : 0, username: c.username,
        secret: c.password != null ? c.password : decrypt(c.password_enc),
        carriesSaved: c.password_enc != null,
      };
    },
    storedSecret: (row) => decrypt(row.password_enc),
  },
  bluecat: {
    table: 'bluecat_sources',
    secretKey: 'password',
    sslBodyKey: 'sslVerify',
    sslCol: 'ssl_verify',
    hasUsername: true,
    cachesSessions: true,
    seed() {
      return db.prepare(`
        INSERT INTO bluecat_sources (name, host, port, encrypted_credentials, ssl_verify)
        VALUES ('saved-bam', ?, ?, ?, 1)
      `).run(SAVED_HOST, SAVED_PORT, encrypt(JSON.stringify({ username: SAVED_USER, password: SAVED_SECRET }))).lastInsertRowid;
    },
    testRoutes: [
      (id, body) => [`/sources/${id}/test`, body],
      (id, body) => ['/sources/test', { id, ...body }],
    ],
    noIdNoSecret: [
      ['/sources/0/test', { host: 'new.example', username: 'u' }, 404],
      ['/sources/test', { host: 'new.example', username: 'u' }, 400],
    ],
    createBody: (host, n) => ({ name: `created-${n}`, host, username: 'u', password: 'p' }),
    created: (body) => body,
    updated: (body) => body,
    received(c) {
      const typed = c.username != null && c.password != null;
      const saved = c.encrypted_credentials ? JSON.parse(decrypt(c.encrypted_credentials)) : {};
      return {
        host: c.host, port: c.port, tls: c.ssl_verify ? 1 : 0,
        username: typed ? c.username : saved.username,
        secret: typed ? c.password : saved.password,
        carriesSaved: c.encrypted_credentials != null,
      };
    },
    storedSecret: (row) => JSON.parse(decrypt(row.encrypted_credentials)).password,
  },
};

// -- Every platform, driven through its host router ----------------------------

let app;
const sides = {}; // platform -> [{ label, call, api, fosApi }]

beforeAll(() => {
  // No poll may ever leave this process: create and PUT call schedule + trigger.
  quietPoller(require('../services/brocadePoller').brocadePollerHandle);
  quietPoller(require('../services/bluecatPoller').bluecatPollerHandle);

  app = express();
  app.use(express.json());
  app.use((req, res, next) => {
    req.auth = { kind: 'service', grants: ['*:*:*'], user: { username: 'tester' } };
    next();
  });
  app.use('/api/brocade', require('../routes/brocade'));
  app.use('/api/bluecat', require('../routes/bluecat'));

  const hostApis = {
    brocade: require('../services/brocadeApi'),
    bluecat: require('../services/bluecatApi'),
  };
  for (const id of Object.keys(PLATFORMS)) {
    sides[id] = [
      {
        label: 'host router',
        api: hostApis[id],
        fosApi: id === 'brocade' ? require('../services/brocadeFosApi') : null,
        async call(method, path, body) {
          const res = await request(app)[method.toLowerCase()](`/api/${id}${path}`).send(body || {});
          return { status: res.status, body: res.body };
        },
      },
    ];
  }
});

const restores = [];
function stub(obj, key, impl) {
  const real = obj[key];
  obj[key] = impl;
  restores.push(() => { obj[key] = real; });
}

afterEach(() => {
  while (restores.length) restores.pop()();
  vi.restoreAllMocks();
});

const rowOf = (table, id) => db.prepare(`SELECT * FROM ${table} WHERE id = ?`).get(id);

for (const [platformId, P] of Object.entries(PLATFORMS)) {
  for (const sideIndex of [0]) {
    const sideLabel = sideIndex === 0 ? 'host router' : 'plugin pack';

    describe(`${platformId} ${sideLabel}`, () => {
      let side;
      let id;
      let seen;

      beforeEach(() => {
        side = sides[platformId][sideIndex];
        if (platformId === 'brocade') db.exec('DELETE FROM brocade_fos_overrides; DELETE FROM brocade_switches; DELETE FROM brocade_fabrics;');
        db.exec(`DELETE FROM ${P.table}`);
        id = P.seed();
        seen = [];
        stub(side.api, 'testConnection', async (c) => { seen.push(c); return { ok: true }; });
      });

      // R1, no typed secret: everything the saved secret travels with is the saved value.
      for (const [n, route] of P.testRoutes.entries()) {
        it(`R1 test route ${n + 1}: no typed secret dials the STORED host, port, TLS flag and username`, async () => {
          const [path, body] = route(id, { host: 'evil.example', port: 9443, username: 'mallory', [P.sslBodyKey]: false });
          const res = await side.call('POST', path, body);
          expect(res.status).toBe(200);
          expect(seen.length).toBe(1);
          const got = P.received(seen[0]);
          expect(got.host).toBe(SAVED_HOST);
          expect(got.port).toBe(SAVED_PORT);
          expect(got.tls).toBe(1);
          if (P.hasUsername) expect(got.username).toBe(SAVED_USER);
          expect(got.secret).toBe(SAVED_SECRET);
          expect(JSON.stringify(seen[0])).not.toContain('evil.example');
          expect(JSON.stringify(seen[0])).not.toContain('mallory');
        });

        it(`R1 test route ${n + 1}: a typed secret dials the body's host with the typed secret, saved secret left out`, async () => {
          const [path, body] = route(id, { host: 'new.example', port: 9443, username: 'typed-user', [P.secretKey]: 'typed-secret' });
          const res = await side.call('POST', path, body);
          expect(res.status).toBe(200);
          expect(seen.length).toBe(1);
          const got = P.received(seen[0]);
          expect(got.host).toBe('new.example');
          expect(got.port).toBe(9443);
          expect(got.secret).toBe('typed-secret');
          if (P.hasUsername) expect(got.username).toBe('typed-user');
          expect(got.carriesSaved).toBe(false);
        });

        it(`R6 test route ${n + 1}: the candidate never carries the live source id`, async () => {
          for (const extra of [{}, { [P.secretKey]: 'typed-secret' }]) {
            const [path, body] = route(id, { host: 'new.example', ...extra });
            await side.call('POST', path, body);
          }
          expect(seen.length).toBe(2);
          // UniFi keeps no session cache, so its saved-row candidate may keep the id.
          if (P.cachesSessions) for (const c of seen) expect(c.id === id).toBe(false);
        });
      }

      it('R1: a test with no saved source and no secret keeps its 400/404 and dials nothing', async () => {
        for (const [path, body, status] of P.noIdNoSecret) {
          const res = await side.call('POST', path, body);
          expect(res.status).toBe(status);
        }
        expect(seen.length).toBe(0);
      });

      it('R2 PUT: a new host or port with a blank secret is 400 with the contract message, row unchanged', async () => {
        const before = rowOf(P.table, id);
        for (const body of [
          { host: 'evil.example' },
          { host: 'evil.example', [P.secretKey]: '' },
          { port: 9443 },
        ]) {
          const res = await side.call('PUT', `/sources/${id}`, body);
          expect(res.status).toBe(400);
          expect(res.body.error).toBe(MESSAGE);
        }
        expect(rowOf(P.table, id)).toEqual(before);
      });

      it('R2 PUT: a new host with a typed secret succeeds and stores both', async () => {
        const res = await side.call('PUT', `/sources/${id}`, { host: 'new.example', port: 9443, [P.secretKey]: 'typed-secret' });
        expect(res.status).toBe(200);
        expect(P.updated(res.body).host).toBe('new.example');
        const row = rowOf(P.table, id);
        expect(row.host).toBe('new.example');
        expect(row.port).toBe(9443);
        expect(P.storedSecret(row)).toBe('typed-secret');
      });

      it('R2 PUT: a rename with the same address and a blank secret succeeds, and an omitted TLS flag stays on', async () => {
        const res = await side.call('PUT', `/sources/${id}`, { name: 'renamed', host: SAVED_HOST.toUpperCase(), port: SAVED_PORT });
        expect(res.status).toBe(200);
        const row = rowOf(P.table, id);
        expect(row.name).toBe('renamed');
        expect(row[P.sslCol]).toBe(1);
        expect(P.storedSecret(row)).toBe(SAVED_SECRET);
      });

      it('R3: create, PUT and test refuse loopback, link-local and metadata addresses', async () => {
        let n = 0;
        for (const host of BLOCKED) {
          n += 1;
          const created = await side.call('POST', '/sources', P.createBody(host, `${sideIndex}-${n}`));
          expect(created.status, `create ${host}`).toBe(400);
          const put = await side.call('PUT', `/sources/${id}`, { host, [P.secretKey]: 'typed-secret' });
          expect(put.status, `put ${host}`).toBe(400);
          for (const route of P.testRoutes) {
            const [path, body] = route(id, { host, username: 'u', [P.secretKey]: 'typed-secret' });
            const tested = await side.call('POST', path, body);
            expect(tested.status, `test ${host}`).toBe(400);
          }
        }
        expect(seen.length).toBe(0);
        expect(rowOf(P.table, id).host).toBe(SAVED_HOST);
        expect(db.prepare(`SELECT COUNT(*) n FROM ${P.table}`).get().n).toBe(1);
      });

      it('R3: RFC1918 addresses and ordinary DNS names are accepted', async () => {
        let n = 0;
        for (const host of ALLOWED) {
          n += 1;
          const created = await side.call('POST', '/sources', P.createBody(host, `ok-${sideIndex}-${n}`));
          expect(created.status, `create ${host}`).toBe(201);
          expect(P.created(created.body).host).toBe(host);
        }
      });

      if (P.cachesSessions) {
        it('R5 PUT drops the cached session, logging out against the OLD address only', async () => {
          const loggedOut = [];
          stub(side.api, 'logout', async (row) => { loggedOut.push(row); });
          const res = await side.call('PUT', `/sources/${id}`, { host: 'new.example', [P.secretKey]: 'typed-secret' });
          expect(res.status).toBe(200);
          expect(loggedOut.length).toBe(1);
          expect(loggedOut[0].id).toBe(id);
          expect(loggedOut[0].host).toBe(SAVED_HOST);
        });
      }
    });
  }
}

// -- Brocade: shared FOS password, per-switch overrides, fos-test ---------------

for (const sideIndex of [0]) {
  describe(`brocade direct-FOS secrets, ${sideIndex === 0 ? 'host router' : 'plugin pack'}`, () => {
    let side;
    let id;
    const WWN = '10:00:00:00:00:00:aa:01';

    const seedSource = ({ fosPassword = null, allowHttp = 0 } = {}) => db.prepare(`
      INSERT INTO brocade_sources (name, host, port, username, password_enc, verify_ssl,
        fos_direct_enabled, fos_username, fos_password_enc, fos_port, fos_allow_http)
      VALUES ('fos-sannav', ?, ?, ?, ?, 1, 1, 'fosadmin', ?, 443, ?)
    `).run(SAVED_HOST, SAVED_PORT, SAVED_USER, encrypt(SAVED_SECRET), fosPassword ? encrypt(fosPassword) : null, allowHttp).lastInsertRowid;

    const seedSwitch = (wwn, ip) => db.prepare(`
      INSERT INTO brocade_switches (source_id, wwn, name, ip_address, stale) VALUES (?, ?, 'SW', ?, 0)
    `).run(id, wwn, ip);

    const overrides = () => db.prepare('SELECT * FROM brocade_fos_overrides WHERE source_id = ? ORDER BY id').all(id);

    beforeEach(() => {
      side = sides.brocade[sideIndex];
      db.exec('DELETE FROM brocade_fos_overrides; DELETE FROM brocade_switches; DELETE FROM brocade_fabrics; DELETE FROM brocade_sources;');
    });

    it('PUT: plain http ON, a new FOS port or a new SANnav address all need the FOS password typed again', async () => {
      id = seedSource({ fosPassword: 'fos-saved' });
      const before = rowOf('brocade_sources', id);
      for (const body of [
        { fosAllowHttp: true },
        { fosAllowHttp: true, password: 'typed-sannav' }, // the SANnav password is a different secret
        { fosPort: 8080 },
        { host: 'new.example', password: 'typed-sannav' }, // a new SANnav decides where the FOS password goes
      ]) {
        const res = await side.call('PUT', `/sources/${id}`, body);
        expect(res.status, JSON.stringify(body)).toBe(400);
        expect(res.body.error).toBe(MESSAGE);
      }
      expect(rowOf('brocade_sources', id)).toEqual(before);

      const ok = await side.call('PUT', `/sources/${id}`, { fosAllowHttp: true, fosPort: 8080, fosPassword: 'fos-typed' });
      expect(ok.status).toBe(200);
      const row = rowOf('brocade_sources', id);
      expect(row.fos_allow_http).toBe(1);
      expect(row.fos_port).toBe(8080);
      expect(decrypt(row.fos_password_enc)).toBe('fos-typed');
    });

    it('PUT: the SANnav address cannot move while an override has a saved password but no pinned address', async () => {
      // No shared FOS password here: the only FOS secret is the override's own.
      id = seedSource({ fosPassword: null });
      seedSwitch(WWN, '10.20.30.40');
      db.prepare("INSERT INTO brocade_fos_overrides (source_id, switch_wwn, ip_address, username, password_enc) VALUES (?, ?, NULL, 'admin', ?)")
        .run(id, WWN, encrypt('override-secret'));
      const before = rowOf('brocade_sources', id);

      // A rogue SANnav would report its own address for that switch, so even a
      // typed SANnav password must not be enough to move the source.
      const moved = await side.call('PUT', `/sources/${id}`, { host: 'rogue-sannav.example', password: 'typed-sannav' });
      expect(moved.status).toBe(400);
      expect(moved.body.error).toBe(MESSAGE);
      expect(String(moved.body.detail)).toMatch(/pinned IP address/i);
      expect(rowOf('brocade_sources', id)).toEqual(before);

      // Renaming with the same address is still fine.
      const rename = await side.call('PUT', `/sources/${id}`, { name: 'still-here', host: SAVED_HOST, port: SAVED_PORT });
      expect(rename.status).toBe(200);

      // Once the override is pinned to an address, the SANnav may move.
      db.prepare("UPDATE brocade_fos_overrides SET ip_address = '10.20.30.40' WHERE source_id = ?").run(id);
      const pinned = await side.call('PUT', `/sources/${id}`, { host: 'new-sannav.example', password: 'typed-sannav' });
      expect(pinned.status).toBe(200);
    });

    it('PUT: the settings form resending unchanged FOS fields with blank passwords still saves, and http can always go OFF', async () => {
      id = seedSource({ fosPassword: 'fos-saved', allowHttp: 1 });
      const same = await side.call('PUT', `/sources/${id}`, {
        name: 'renamed', host: SAVED_HOST, port: SAVED_PORT, username: SAVED_USER, fosPort: 443, fosAllowHttp: true,
      });
      expect(same.status).toBe(200);
      const off = await side.call('PUT', `/sources/${id}`, { fosAllowHttp: false });
      expect(off.status).toBe(200);
      const row = rowOf('brocade_sources', id);
      expect(row.name).toBe('renamed');
      expect(row.fos_allow_http).toBe(0);
      expect(decrypt(row.fos_password_enc)).toBe('fos-saved');

      // fosAllowHttp:false against a stored 0 is "unchanged", not a target change.
      const stillOff = await side.call('PUT', `/sources/${id}`, { name: 'renamed-again', fosAllowHttp: false, fosPort: 443 });
      expect(stillOff.status).toBe(200);
    });

    it('PUT: with no FOS secret saved anywhere, http and the FOS port change freely', async () => {
      id = seedSource();
      const res = await side.call('PUT', `/sources/${id}`, { fosAllowHttp: true, fosPort: 8080 });
      expect(res.status).toBe(200);
      expect(rowOf('brocade_sources', id).fos_allow_http).toBe(1);
    });

    it('PUT: plain http cannot go ON while a per-switch override still holds a saved password', async () => {
      id = seedSource({ fosPassword: 'fos-saved' });
      const made = await side.call('POST', `/sources/${id}/fos-overrides`, { switchWwn: WWN, ipAddress: '10.5.5.5', username: 'sw', password: 'sw-saved' });
      expect(made.status).toBe(200);
      const res = await side.call('PUT', `/sources/${id}`, { fosAllowHttp: true, fosPassword: 'fos-typed' });
      expect(res.status).toBe(400);
      expect(res.body.error).toBe(MESSAGE);
      expect(rowOf('brocade_sources', id).fos_allow_http).toBe(0);
      expect(decrypt(rowOf('brocade_sources', id).fos_password_enc)).toBe('fos-saved');
    });

    it('override: a brand new override with a typed password is accepted (nothing saved to protect yet)', async () => {
      id = seedSource({ fosPassword: 'fos-saved' });
      const res = await side.call('POST', `/sources/${id}/fos-overrides`, { switchWwn: WWN, ipAddress: '10.5.5.5', username: 'sw', password: 'sw-typed', port: 8443 });
      expect(res.status).toBe(200);
      expect(res.body.override.hasPassword).toBe(true);
      expect(decrypt(overrides()[0].password_enc)).toBe('sw-typed');
    });

    it('override: a brand new override with no password is fine when no shared FOS password would travel with it', async () => {
      id = seedSource();
      const res = await side.call('POST', `/sources/${id}/fos-overrides`, { switchWwn: WWN, ipAddress: '10.5.5.5', username: 'sw' });
      expect(res.status).toBe(200);
      expect(res.body.override.hasPassword).toBe(false);
    });

    it('override: a new address with no password is refused when the SHARED FOS password would be sent there', async () => {
      id = seedSource({ fosPassword: 'fos-saved' });
      seedSwitch(WWN, '10.5.5.5');
      for (const body of [
        { switchWwn: WWN, ipAddress: 'evil.example' },
        { switchWwn: WWN, port: 8080 },
        { switchWwn: '10:00:00:00:00:00:ff:ff', ipAddress: 'evil.example', username: 'sw' },
      ]) {
        const res = await side.call('POST', `/sources/${id}/fos-overrides`, body);
        expect(res.status, JSON.stringify(body)).toBe(400);
        expect(res.body.error).toBe(MESSAGE);
      }
      expect(overrides().length).toBe(0);

      // An address SANnav already reports for this source is where the shared
      // password already goes: a username-only override there is legitimate.
      const ok = await side.call('POST', `/sources/${id}/fos-overrides`, { switchWwn: '10:00:00:00:00:00:ff:ff', ipAddress: '10.5.5.5', username: 'sw' });
      expect(ok.status).toBe(200);
      const same = await side.call('POST', `/sources/${id}/fos-overrides`, { switchWwn: WWN, username: 'sw' });
      expect(same.status).toBe(200);
    });

    it('override: changing ipAddress or port, or clearing them, while keeping the saved password is refused', async () => {
      id = seedSource();
      const made = await side.call('POST', `/sources/${id}/fos-overrides`, { switchWwn: WWN, ipAddress: '10.5.5.5', username: 'sw', password: 'sw-saved', port: 8443 });
      expect(made.status).toBe(200);
      const before = overrides();
      for (const body of [
        { switchWwn: WWN, ipAddress: 'evil.example', username: 'sw', port: 8443 },
        { switchWwn: WWN, ipAddress: '10.5.5.5', username: 'sw', port: 9443 },
        { switchWwn: WWN, ipAddress: '10.5.5.5', username: 'sw' }, // port cleared: falls back to fos_port
        { switchWwn: WWN, username: 'sw', port: 8443 }, // address cleared: falls back to the inventory address
        { switchWwn: WWN, ipAddress: 'evil.example', username: 'sw', port: 8443, password: '' },
      ]) {
        const res = await side.call('POST', `/sources/${id}/fos-overrides`, body);
        expect(res.status, JSON.stringify(body)).toBe(400);
        expect(res.body.error).toBe(MESSAGE);
      }
      expect(overrides()).toEqual(before);

      const renamed = await side.call('POST', `/sources/${id}/fos-overrides`, { switchWwn: WWN, ipAddress: '10.5.5.5', username: 'sw2', port: 8443 });
      expect(renamed.status).toBe(200);
      expect(overrides()[0].username).toBe('sw2');
      expect(decrypt(overrides()[0].password_enc)).toBe('sw-saved');

      const moved = await side.call('POST', `/sources/${id}/fos-overrides`, { switchWwn: WWN, ipAddress: '10.6.6.6', username: 'sw2', port: 9443, password: 'sw-typed' });
      expect(moved.status).toBe(200);
      expect(overrides()[0].ip_address).toBe('10.6.6.6');
      expect(decrypt(overrides()[0].password_enc)).toBe('sw-typed');
    });

    it('override: loopback, link-local and metadata addresses are refused', async () => {
      id = seedSource();
      for (const ipAddress of BLOCKED) {
        const res = await side.call('POST', `/sources/${id}/fos-overrides`, { switchWwn: WWN, ipAddress, username: 'sw', password: 'sw-typed' });
        expect(res.status, ipAddress).toBe(400);
      }
      expect(overrides().length).toBe(0);
    });

    it('fos-test dials the STORED override target with the stored password, whatever the body says', async () => {
      id = seedSource({ fosPassword: 'fos-saved', allowHttp: 0 });
      seedSwitch(WWN, '10.5.5.5');
      const made = await side.call('POST', `/sources/${id}/fos-overrides`, { switchWwn: WWN, ipAddress: '10.7.7.7', username: 'sw', password: 'sw-saved', port: 8443 });
      expect(made.status).toBe(200);
      const seen = [];
      stub(side.fosApi, 'testFos', async (t) => { seen.push(t); return { ok: true }; });
      const res = await side.call('POST', `/sources/${id}/fos-test`, {
        switchWwn: WWN, ipAddress: 'evil.example', ip: 'evil.example', host: 'evil.example', port: 1, username: 'mallory', fosAllowHttp: true, allowHttp: true,
      });
      expect(res.status).toBe(200);
      expect(seen.length).toBe(1);
      expect(seen[0].ip).toBe('10.7.7.7');
      expect(seen[0].port).toBe(8443);
      expect(seen[0].username).toBe('sw');
      expect(seen[0].allow_http).toBe(false);
      expect(seen[0].verify_ssl).toBe(1);
      expect(seen[0].password).toBeUndefined();
      expect(decrypt(seen[0].password_enc)).toBe('sw-saved');
      expect(JSON.stringify(seen[0])).not.toContain('evil.example');
    });
  });
}

// -- Real clients on a fake transport --------------------------------------------

const transportError = (code, message) => Object.assign(new Error(message), { code });
const httpError = (status, data) => Object.assign(new Error(`Request failed with status code ${status}`), { response: { status, data, headers: {} } });

/** Fake axios.create(): records each instance config, routes every verb to
 *  `respond`, and applies the instance's validateStatus the way axios does. */
function fakeAxios(respond) {
  const created = [];
  const calls = [];
  vi.spyOn(axios, 'create').mockImplementation((cfg) => {
    created.push(cfg);
    const run = async (method, path, headers) => {
      calls.push({ method, path, baseURL: cfg.baseURL, headers: { ...(cfg.headers || {}), ...(headers || {}) } });
      const r = respond({ method, path, baseURL: cfg.baseURL });
      const res = { status: r.status, data: r.data, headers: r.headers || {} };
      const valid = cfg.validateStatus ? cfg.validateStatus(res.status) : (res.status >= 200 && res.status < 300);
      if (!valid) throw httpError(res.status, res.data);
      return res;
    };
    return {
      post: (path, data, opts) => run('POST', path, opts?.headers),
      get: (path, opts) => run('GET', path, opts?.headers),
      patch: (path, data, opts) => run('PATCH', path, opts?.headers),
      request: (opts) => run(String(opts.method || 'GET').toUpperCase(), opts.url, opts.headers),
    };
  });
  return { created, calls };
}

const FAILURES = [
  ['refused', () => { throw transportError('ECONNREFUSED', 'connect ECONNREFUSED 10.1.2.3:443'); }, 'Could not reach the address.'],
  ['dns', () => { throw transportError('ENOTFOUND', 'getaddrinfo ENOTFOUND secret-internal-name.corp'); }, 'Could not reach the address.'],
  ['self-signed', () => { throw transportError('DEPTH_ZERO_SELF_SIGNED_CERT', 'self-signed certificate'); }, 'The TLS certificate was not trusted.'],
  ['timeout', () => { throw transportError('ECONNABORTED', 'timeout of 15000ms exceeded'); }, 'Timed out.'],
  ['upstream 500 body', () => ({ status: 500, data: { errorMessage: 'INTERNAL-BODY-TEXT', message: 'INTERNAL-BODY-TEXT' } }), 'Unexpected response from the address.'],
  ['upstream 401 body', () => ({ status: 401, data: { errorMessage: 'INTERNAL-BODY-TEXT', message: 'INTERNAL-BODY-TEXT' } }), null],
  ['redirect', () => ({ status: 302, headers: { location: 'https://evil.example/login' }, data: '' }), 'Unexpected response from the address.'],
];

function expectSafeFailure(result, expected) {
  expect(result.ok).toBe(false);
  expect(SAFE_MESSAGES).toContain(result.error);
  if (expected) expect(result.error).toBe(expected);
  else expect(result.error).toMatch(/^Sign-in was refused\./);
  expect(JSON.stringify(result)).not.toMatch(/10\.1\.2\.3|ECONNREFUSED|ENOTFOUND|secret-internal-name|INTERNAL-BODY-TEXT|evil\.example/);
}

// One entry per client module that sends a credential.
const CLIENTS = [
  {
    name: 'services/brocadeApi.js', transport: 'axios',
    run: () => require('../services/brocadeApi').testConnection({ host: 'sannav.corp.example', port: 443, username: 'u', password: 'p', verify_ssl: 1 }),
  },
  {
    name: 'services/brocadeFosApi.js', transport: 'axios',
    run: () => require('../services/brocadeFosApi').testFos({ ip: '10.5.5.5', port: 443, username: 'u', password: 'p', verify_ssl: 1, allow_http: false }),
  },
  {
    name: 'services/bluecatApi.js', transport: 'axios',
    run: () => require('../services/bluecatApi').testConnection({ host: 'bam.corp.example', port: 443, username: 'u', password: 'p', ssl_verify: 1 }),
  },
];

describe('real clients: redirects and failure text', () => {
  for (const client of CLIENTS) {
    describe(client.name, () => {
      for (const [label, respond, expected] of FAILURES) {
        it(`${label}: fixed wording, no transport text, no upstream body`, async () => {
          const fake = fakeAxios(respond);
          const result = await client.run();
          expectSafeFailure(result, expected);
          if (label === 'redirect') {
            // The redirect is a failure and nothing is sent anywhere else.
            for (const c of fake.calls) expect(JSON.stringify([c.baseURL, c.hostname, c.path])).not.toContain('evil.example');
          }
        });
      }

      if (client.transport === 'axios') {
        it('R4: every axios instance that carries the credential has maxRedirects 0', async () => {
          const fake = fakeAxios(() => ({ status: 401, data: {} }));
          await client.run();
          expect(fake.created.length).toBeGreaterThan(0);
          for (const cfg of fake.created) expect(cfg.maxRedirects).toBe(0);
        });
      }
    });
  }
});

describe('real clients: R5 logout forgets the cached session before anything can reuse it', () => {
  const loginCount = (calls, marker) => calls.filter((c) => c.method === 'POST' && String(c.path).includes(marker)).length;

  it('services/brocadeApi.js', async () => {
    const api = require('../services/brocadeApi');
    const fake = fakeAxios(({ method, path }) => (method === 'POST' && path.includes('/login/')
      ? { status: 200, data: { sessionId: 'SESSION-1' } } : { status: 200, data: {} }));
    const src = { id: 990001, host: 'sannav.corp.example', port: 443, username: 'u', password: 'p', verify_ssl: 1 };
    await api.authedRequest(src, { path: '/external-api/v1/about/' });
    await api.authedRequest(src, { path: '/external-api/v1/about/' });
    expect(loginCount(fake.calls, '/login/')).toBe(1);
    const pending = api.logout(src); // not awaited: the cache entry must already be gone
    await api.authedRequest({ ...src, host: 'moved.corp.example' }, { path: '/external-api/v1/about/' });
    await pending;
    expect(loginCount(fake.calls, '/login/')).toBe(2);
    // The old session id only ever went to the old address.
    for (const c of fake.calls.filter((x) => x.headers.Authorization === 'SESSION-1' && x.path.includes('/logout/'))) {
      expect(c.baseURL).toContain('sannav.corp.example');
    }
    // A test candidate has no id and must not leave a cache entry behind.
    await api.testConnection({ host: 'try.corp.example', port: 443, username: 'u', password: 'p', verify_ssl: 1 });
    const n = loginCount(fake.calls, '/login/');
    await api.authedRequest({ host: 'try.corp.example', port: 443, username: 'u', password: 'p' }, { path: '/external-api/v1/about/' });
    expect(loginCount(fake.calls, '/login/')).toBe(n + 1);
    await api.logout({ ...src, host: 'moved.corp.example' });
  });

  it('services/bluecatApi.js', async () => {
    const api = require('../services/bluecatApi');
    const fake = fakeAxios(({ method, path }) => (method === 'POST' && path === '/sessions'
      ? { status: 200, data: { basicAuthenticationCredentials: 'BASIC-1' } } : { status: 200, data: { data: [] } }));
    const src = { id: 990003, host: 'bam.corp.example', port: 443, username: 'u', password: 'p', ssl_verify: 1 };
    await api.getSession(src);
    await api.getSession(src);
    expect(loginCount(fake.calls, '/sessions')).toBe(1);
    const pending = api.logout(src);
    await api.getSession({ ...src, host: 'moved.corp.example' });
    await pending;
    expect(loginCount(fake.calls, '/sessions')).toBe(2);
    for (const c of fake.calls.filter((x) => x.method === 'PATCH')) expect(c.baseURL).toContain('bam.corp.example');
    api.invalidateSession(src.id);
  });
});
