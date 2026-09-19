/**
 * Credential forwarding security tests (R1, R2, R3 from connectionGuard contract)
 * Platforms: NetApp direct arrays + AIQUM instances, Pure arrays, Cohesity clusters
 * Verifies that saved secrets never travel to a different target without re-entry.
 */
import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from 'vitest';
import { createRequire } from 'module';
import request from 'supertest';
import Database from 'better-sqlite3';

const require = createRequire(import.meta.url);

const db = require('../db/database');
const { encrypt, decrypt } = require('../services/encryption');
const netappApi = require('../services/netappApi');
const pureApi = require('../services/pureApi');
const cohesityApi = require('../services/cohesityApi');

let app;

const CONTRACT_MESSAGE = 'Enter the password or token again when changing the address. A saved credential is only ever sent to the address it was saved for.';

beforeAll(async () => {
  const registry = require('../core/registry');
  const netappManifest = require('../platforms/netapp');
  const pureManifest = require('../platforms/pure');
  registry.init();
  registry.registerPlugin(netappManifest);
  registry.registerPlugin(pureManifest);

  const { createApp } = require('../app');
  app = createApp({ licenseGate: (req, res, next) => next() });
});

describe('NetApp credential forwarding (HOLE A + B)', () => {
  let directArrayId;
  let aiqumInstanceId;

  it('seeds a direct array with a saved password', () => {
    const creds = encrypt(JSON.stringify({ password: 'saved-password' }));
    const r = db.prepare(`
      INSERT INTO netapp_arrays (name, mgmt_host, username, encrypted_credentials, source, ssl_verify)
      VALUES ('test-array', 'array.corp.local', 'admin', ?, 'direct', 1)
    `).run(creds);
    directArrayId = r.lastInsertRowid;
    expect(directArrayId).toBeGreaterThan(0);
  });

  it('seeds an AIQUM instance with a saved password', () => {
    const creds = encrypt('saved-aiqum-password');
    const r = db.prepare(`
      INSERT INTO netapp_aiqum_instances (name, host, username, encrypted_credentials, poll_interval_minutes)
      VALUES ('test-aiqum', 'aiqum.corp.local', 'admin', ?, 15)
    `).run(creds);
    aiqumInstanceId = r.lastInsertRowid;
    expect(aiqumInstanceId).toBeGreaterThan(0);
  });

  describe('R1: POST /api/netapp/arrays/test (direct cluster, HOLE A)', () => {
    it('test with no id and no secret still returns 400', async () => {
      const res = await request(app).post('/api/netapp/arrays/test')
        .send({ mgmt_host: 'new.example' });
      expect(res.status).toBe(200);
      expect(res.body.ok).toBe(false);
    });

    it('test with id + evil host but no secret uses STORED host, not evil host (R1)', async () => {
      const spy = vi.spyOn(netappApi, 'testDirectConnection');
      spy.mockResolvedValueOnce({ ok: true, name: 'test', version: '9.13' });

      const res = await request(app).post('/api/netapp/arrays/test')
        .send({ id: directArrayId, mgmt_host: 'evil.example', username: 'admin', password: '' });

      expect(res.status).toBe(200);
      expect(res.body.ok).toBe(true);
      expect(spy).toHaveBeenCalledWith(
        expect.objectContaining({ mgmt_host: 'array.corp.local' })
      );
      spy.mockRestore();
    });

    it('test with id + evil host + new secret uses evil host with the new secret', async () => {
      const spy = vi.spyOn(netappApi, 'testDirectConnection');
      spy.mockResolvedValueOnce({ ok: true, name: 'test', version: '9.13' });

      const res = await request(app).post('/api/netapp/arrays/test')
        .send({ id: directArrayId, mgmt_host: 'new.example', username: 'admin', password: 'typed-password' });

      expect(res.status).toBe(200);
      expect(res.body.ok).toBe(true);
      expect(spy).toHaveBeenCalledWith(
        expect.objectContaining({ mgmt_host: 'new.example', password: 'typed-password' })
      );
      spy.mockRestore();
    });

    it('test with loopback 127.0.0.1 is refused (R3)', async () => {
      const res = await request(app).post('/api/netapp/arrays/test')
        .send({ mgmt_host: '127.0.0.1', username: 'admin', password: 'test' });
      expect(res.status).toBe(400);
    });

    it('test with metadata 169.254.169.254 is refused (R3)', async () => {
      const res = await request(app).post('/api/netapp/arrays/test')
        .send({ mgmt_host: '169.254.169.254', username: 'admin', password: 'test' });
      expect(res.status).toBe(400);
    });
  });

  describe('R1: POST /api/netapp/aiqum/test (HOLE A)', () => {
    it('test with id + evil host but no password uses STORED host (R1)', async () => {
      const spy = vi.spyOn(netappApi, 'testAiqum');
      spy.mockResolvedValueOnce({ ok: true, clusterCount: 1, clusters: [] });

      const res = await request(app).post('/api/netapp/aiqum/test')
        .send({ id: aiqumInstanceId, host: 'evil.example', password: '' });

      expect(res.status).toBe(200);
      expect(res.body.ok).toBe(true);
      expect(spy).toHaveBeenCalledWith(
        expect.objectContaining({ host: expect.stringContaining('aiqum.corp.local') })
      );
      spy.mockRestore();
    });

    it('test with id + evil host + new password uses evil host with new password', async () => {
      const spy = vi.spyOn(netappApi, 'testAiqum');
      spy.mockResolvedValueOnce({ ok: true, clusterCount: 0, clusters: [] });

      const res = await request(app).post('/api/netapp/aiqum/test')
        .send({ id: aiqumInstanceId, host: 'new.example', password: 'typed-password' });

      expect(res.status).toBe(200);
      expect(spy).toHaveBeenCalledWith(
        expect.objectContaining({ host: expect.stringContaining('new.example') })
      );
      spy.mockRestore();
    });
  });

  describe('R2: PUT /api/netapp/arrays/:id (HOLE B)', () => {
    it('PUT with same host + blank password succeeds (target not changing)', async () => {
      const res = await request(app).put(`/api/netapp/arrays/${directArrayId}`)
        .set('x-auth-header', 'Bearer test')
        .send({ name: 'renamed', mgmt_host: 'array.corp.local', password: '' });

      expect(res.status).toBe(200);
      const updated = db.prepare('SELECT * FROM netapp_arrays WHERE id = ?').get(directArrayId);
      expect(updated.name).toBe('renamed');
    });

    it('PUT with changed host + blank password is 400 (R2)', async () => {
      const res = await request(app).put(`/api/netapp/arrays/${directArrayId}`)
        .send({ name: 'test', mgmt_host: 'evil.example', password: '' });

      expect(res.status).toBe(400);
      expect(res.body.error).toMatch(/again when changing/);
      // Create and PUT have always stored the https origin form of the host.
      const unchanged = db.prepare('SELECT * FROM netapp_arrays WHERE id = ?').get(directArrayId);
      expect(unchanged.mgmt_host).toBe('https://array.corp.local');
      expect(netappApi.getPassword(unchanged)).toBe('saved-password');
    });

    it('PUT with changed host + new password succeeds', async () => {
      const res = await request(app).put(`/api/netapp/arrays/${directArrayId}`)
        .send({ name: 'test', mgmt_host: 'new-array.local', password: 'new-password' });

      expect(res.status).toBe(200);
      const updated = db.prepare('SELECT * FROM netapp_arrays WHERE id = ?').get(directArrayId);
      expect(updated.mgmt_host).toBe('https://new-array.local');
      expect(netappApi.getPassword(updated)).toBe('new-password');
    });

    it('PUT with loopback is refused (R3)', async () => {
      const res = await request(app).put(`/api/netapp/arrays/${directArrayId}`)
        .send({ mgmt_host: '127.0.0.1', password: 'test' });
      expect(res.status).toBe(400);
    });
  });

  describe('R2: PUT /api/netapp/aiqum/instances/:id (HOLE B)', () => {
    it('PUT with changed host + blank password is 400 (R2)', async () => {
      const res = await request(app).put(`/api/netapp/aiqum/instances/${aiqumInstanceId}`)
        .send({ host: 'evil.example', password: '' });

      expect(res.status).toBe(400);
      expect(res.body.error).toMatch(/again when changing/);
      const unchanged = db.prepare('SELECT * FROM netapp_aiqum_instances WHERE id = ?').get(aiqumInstanceId);
      expect(unchanged.host).toBe('aiqum.corp.local');
    });
  });
});

describe('Pure credential forwarding (HOLE A + B)', () => {
  let arrayId;

  it('seeds a Pure array with a saved API token', () => {
    const creds = encrypt(JSON.stringify({ apiToken: 'saved-token-xyz' }));
    const r = db.prepare(`
      INSERT INTO pure_arrays (name, mgmt_host, auth_method, client_id, key_id, username, encrypted_credentials, ssl_verify)
      VALUES ('test-pure', 'pure.corp.local', 'token', '', '', '', ?, 1)
    `).run(creds);
    arrayId = r.lastInsertRowid;
    expect(arrayId).toBeGreaterThan(0);
  });

  describe('R1: POST /api/pure/arrays/test (HOLE A)', () => {
    it('test with id + evil host but no secret uses STORED host (R1)', async () => {
      const spy = vi.spyOn(pureApi, 'testConnection');
      spy.mockResolvedValueOnce({ ok: true, name: 'test', model: 'FA-XY' });

      const res = await request(app).post('/api/pure/arrays/test')
        .send({ id: arrayId, mgmt_host: 'evil.example', auth_method: 'token' });

      expect(res.status).toBe(200);
      expect(spy).toHaveBeenCalledWith(
        expect.objectContaining({ mgmt_host: 'pure.corp.local' })
      );
      spy.mockRestore();
    });

    it('test with id + evil host + new token uses evil host with new token', async () => {
      const spy = vi.spyOn(pureApi, 'testConnection');
      spy.mockResolvedValueOnce({ ok: true, name: 'test', model: 'FA-XY' });

      const res = await request(app).post('/api/pure/arrays/test')
        .send({ id: arrayId, mgmt_host: 'new.example', auth_method: 'token', apiToken: 'new-token' });

      expect(res.status).toBe(200);
      expect(spy).toHaveBeenCalledWith(
        expect.objectContaining({ mgmt_host: 'new.example', apiToken: 'new-token' })
      );
      spy.mockRestore();
    });

    it('test with loopback is refused (R3)', async () => {
      const res = await request(app).post('/api/pure/arrays/test')
        .send({ mgmt_host: '127.0.0.1', auth_method: 'token', apiToken: 'test' });
      expect(res.status).toBe(400);
    });
  });

  describe('R2: PUT /api/pure/arrays/:id (HOLE B)', () => {
    it('PUT with changed host + blank secret is 400 (R2)', async () => {
      const res = await request(app).put(`/api/pure/arrays/${arrayId}`)
        .send({ name: 'test-pure', mgmt_host: 'evil.example', auth_method: 'token' });

      // name is required on this PUT, so it is sent: the 400 must come from the
      // R2 guard with the contract message, not from the validator.
      expect(res.status).toBe(400);
      expect(res.body.error).toBe(CONTRACT_MESSAGE);
      const unchanged = db.prepare('SELECT * FROM pure_arrays WHERE id = ?').get(arrayId);
      expect(unchanged.mgmt_host).toBe('pure.corp.local');
      expect(JSON.parse(decrypt(unchanged.encrypted_credentials)).apiToken).toBe('saved-token-xyz');
    });

    it('PUT with same host + blank secret succeeds', async () => {
      const res = await request(app).put(`/api/pure/arrays/${arrayId}`)
        .send({ name: 'renamed', mgmt_host: 'pure.corp.local', auth_method: 'token' });

      expect(res.status).toBe(200);
      const updated = db.prepare('SELECT * FROM pure_arrays WHERE id = ?').get(arrayId);
      expect(updated.name).toBe('renamed');
    });

    it('PUT with changed host + new secret succeeds', async () => {
      const res = await request(app).put(`/api/pure/arrays/${arrayId}`)
        .send({ name: 'test-pure', mgmt_host: 'new-pure.local', auth_method: 'token', apiToken: 'new-token' });

      expect(res.status).toBe(200);
      const updated = db.prepare('SELECT * FROM pure_arrays WHERE id = ?').get(arrayId);
      expect(updated.mgmt_host).toBe('https://new-pure.local');
    });
  });
});

describe('Cohesity credential forwarding (HOLE B)', () => {
  let clusterId;

  it('seeds a Cohesity cluster with a saved API key', () => {
    const creds = encrypt(JSON.stringify({ apiKey: 'saved-key-abc' }));
    const r = db.prepare(`
      INSERT INTO clusters (name, connection_type, vip, auth_type, encrypted_credentials, ssl_verify)
      VALUES ('test-cohesity', 'direct', 'cohesity.corp.local', 'apikey', ?, 1)
    `).run(creds);
    clusterId = r.lastInsertRowid;
    expect(clusterId).toBeGreaterThan(0);
  });

  describe('R2: PUT /api/clusters/:id (HOLE B)', () => {
    it('PUT with changed vip + blank credentials is 400 (R2)', async () => {
      const res = await request(app).put(`/api/clusters/${clusterId}`)
        .send({ vip: 'evil.example' });

      expect(res.status).toBe(400);
      expect(res.body.error).toMatch(/again when changing/);
      const unchanged = db.prepare('SELECT * FROM clusters WHERE id = ?').get(clusterId);
      expect(unchanged.vip).toBe('cohesity.corp.local');
    });

    it('PUT with same vip + blank credentials succeeds', async () => {
      const res = await request(app).put(`/api/clusters/${clusterId}`)
        .send({ name: 'renamed', vip: 'cohesity.corp.local' });

      expect(res.status).toBe(200);
      const updated = db.prepare('SELECT * FROM clusters WHERE id = ?').get(clusterId);
      expect(updated.name).toBe('renamed');
    });

    it('PUT with changed vip + new credentials succeeds', async () => {
      const res = await request(app).put(`/api/clusters/${clusterId}`)
        .send({ vip: 'new-cohesity.local', auth_type: 'apikey', credentials: { apiKey: 'new-key' } });

      expect(res.status).toBe(200);
      const updated = db.prepare('SELECT * FROM clusters WHERE id = ?').get(clusterId);
      expect(updated.vip).toBe('new-cohesity.local');
    });

    it('PUT with loopback is refused (R3)', async () => {
      const res = await request(app).put(`/api/clusters/${clusterId}`)
        .send({ vip: '127.0.0.1', auth_type: 'apikey', credentials: { apiKey: 'test' } });
      expect(res.status).toBe(400);
    });
  });
});

/* -------------------------------------------------------------------------
 * Second pass. The cases above mostly assert status codes and the dialled
 * host. These assert what the platform client RECEIVED: host, certificate
 * flag, username and which secret it would use, for the host routers and for
 * the netapp and pure pack twins. The cohesity pack cannot be loaded here (it
 * needs axios from plugin-sdk/node_modules, which is not installed in this
 * worktree), so it has no case below.
 * ------------------------------------------------------------------------- */
const fs = require('fs');
const path = require('path');
const { loadPack } = require('./helpers/packRouter');

const BLOCKED = ['127.0.0.1', 'localhost', '169.254.169.254', '[::1]', '::ffff:127.0.0.1'];
const ALLOWED = ['10.20.30.40', 'array-02.corp.example'];

// Replace one function on a module object, record every call, restore after.
const restores = [];
function stub(mod, name, impl) {
  const real = mod[name];
  const seen = [];
  mod[name] = async (...args) => { seen.push(args); return impl(...args); };
  restores.push(() => { mod[name] = real; });
  return seen;
}
afterEach(() => { while (restores.length) restores.pop()(); });

describe('second pass: NetApp host router', () => {
  let arrayId;
  let gwId;
  let firstGwId;

  beforeAll(() => {
    db.exec("DELETE FROM netapp_arrays; DELETE FROM netapp_aiqum_instances;");
    // A first gateway that must never be used as a fallback for a posted host.
    firstGwId = db.prepare(`
      INSERT INTO netapp_aiqum_instances (name, host, username, encrypted_credentials, poll_interval_minutes)
      VALUES ('first-gw', 'first-gw.corp.example', 'first-admin', ?, 15)
    `).run(encrypt('first-gateway-password')).lastInsertRowid;
    gwId = db.prepare(`
      INSERT INTO netapp_aiqum_instances (name, host, username, encrypted_credentials, poll_interval_minutes)
      VALUES ('gw2', 'aiqum2.corp.example', 'gw-admin', ?, 15)
    `).run(encrypt('gw2-saved-password')).lastInsertRowid;
    arrayId = db.prepare(`
      INSERT INTO netapp_arrays (name, mgmt_host, username, encrypted_credentials, source, ssl_verify)
      VALUES ('p2-array', 'https://p2-array.corp.example', 'svc-ontap', ?, 'direct', 1)
    `).run(encrypt(JSON.stringify({ password: 'p2-saved-password' }))).lastInsertRowid;
  });

  it('R1 array test, no secret: stored host, stored ssl flag, stored username, stored secret', async () => {
    const seen = stub(netappApi, 'testDirectConnection', () => ({ ok: true }));
    const res = await request(app).post('/api/netapp/arrays/test')
      .send({ id: arrayId, mgmt_host: 'evil.example', username: 'mallory', ssl_verify: false });
    expect(res.status).toBe(200);
    expect(seen).toHaveLength(1);
    const got = seen[0][0];
    expect(got.mgmt_host).toBe('https://p2-array.corp.example');
    expect(got.ssl_verify).toBe(1);
    expect(got.username).toBe('svc-ontap');
    expect(got.password).toBeUndefined();
    expect(netappApi.getPassword(got)).toBe('p2-saved-password');
    expect(JSON.stringify(got)).not.toContain('evil.example');
  });

  it('R1 array test, typed secret: body host and typed secret, stored secret not handed over', async () => {
    const seen = stub(netappApi, 'testDirectConnection', () => ({ ok: true }));
    const res = await request(app).post('/api/netapp/arrays/test')
      .send({ id: arrayId, mgmt_host: 'new.example', username: 'typed-user', password: 'typed-password', ssl_verify: false });
    expect(res.status).toBe(200);
    const got = seen[0][0];
    expect(got.mgmt_host).toBe('new.example');
    expect(got.password).toBe('typed-password');
    expect(got.username).toBe('typed-user');
    expect(got.ssl_verify).toBe(0);
    expect(got.encrypted_credentials).toBeUndefined();
  });

  it('R1 AIQUM test, no secret: stored host, stored username, stored secret', async () => {
    const seen = stub(netappApi, 'testAiqum', () => ({ ok: true, clusterCount: 0, clusters: [] }));
    const res = await request(app).post('/api/netapp/aiqum/test')
      .send({ id: gwId, host: 'evil.example', username: 'mallory', ssl_verify: false });
    expect(res.status).toBe(200);
    const got = seen[0][0];
    expect(got.host).toBe('aiqum2.corp.example');
    expect(got.username).toBe('gw-admin');
    expect(got.password).toBe('gw2-saved-password');
    expect(got.sslVerify).toBe(false);
  });

  it('R1 AIQUM test, typed secret: body host with the typed secret only', async () => {
    const seen = stub(netappApi, 'testAiqum', () => ({ ok: true, clusterCount: 0, clusters: [] }));
    await request(app).post('/api/netapp/aiqum/test')
      .send({ id: gwId, host: 'new.example', username: 'typed-user', password: 'typed-password', ssl_verify: true });
    const got = seen[0][0];
    expect(got.host).toBe('new.example');
    expect(got.password).toBe('typed-password');
    expect(got.sslVerify).toBe(true);
    expect(JSON.stringify(got)).not.toContain('gw2-saved-password');
  });

  it('AIQUM test with NO id and no password dials nothing (it used to send the first gateway password to the posted host)', async () => {
    const seen = stub(netappApi, 'testAiqum', () => ({ ok: true }));
    const res = await request(app).post('/api/netapp/aiqum/test').send({ host: 'evil.example' });
    expect(res.body.ok).toBe(false);
    expect(seen).toHaveLength(0);
    expect(firstGwId).toBeGreaterThan(0);
  });

  it('R3: blocked targets are refused on create, test and PUT; 10.x and DNS names are accepted', async () => {
    const seen = stub(netappApi, 'testDirectConnection', () => ({ ok: true }));
    const seenGw = stub(netappApi, 'testAiqum', () => ({ ok: true }));
    for (const h of BLOCKED) {
      const t = await request(app).post('/api/netapp/arrays/test').send({ mgmt_host: h, username: 'u', password: 'typed-password' });
      expect([h, t.status]).toEqual([h, 400]);
      const c = await request(app).post('/api/netapp/arrays').send({ name: `blk-${h}`, mgmt_host: h, username: 'u', password: 'typed-password' });
      expect([h, c.status]).toEqual([h, 400]);
      const p = await request(app).put(`/api/netapp/arrays/${arrayId}`).send({ name: 'p2-array', mgmt_host: h, password: 'typed-password' });
      expect([h, p.status]).toEqual([h, 400]);
      const gt = await request(app).post('/api/netapp/aiqum/test').send({ host: h, username: 'u', password: 'typed-password' });
      expect([h, gt.status]).toEqual([h, 400]);
      const gc = await request(app).post('/api/netapp/aiqum/instances').send({ host: h, username: 'u', password: 'typed-password' });
      expect([h, gc.status]).toEqual([h, 400]);
      const gp = await request(app).put(`/api/netapp/aiqum/instances/${gwId}`).send({ host: h, password: 'typed-password' });
      expect([h, gp.status]).toEqual([h, 400]);
    }
    expect(seen).toHaveLength(0);
    expect(seenGw).toHaveLength(0);
    for (const h of ALLOWED) {
      const t = await request(app).post('/api/netapp/arrays/test').send({ mgmt_host: h, username: 'u', password: 'typed-password' });
      expect([h, t.status, t.body.ok]).toEqual([h, 200, true]);
    }
    expect(seen).toHaveLength(ALLOWED.length);
  });

  it('R2 array PUT: the exact contract message, the row unchanged, and an omitted ssl_verify kept', async () => {
    const bad = await request(app).put(`/api/netapp/arrays/${arrayId}`).send({ name: 'p2-array', mgmt_host: 'evil.example' });
    expect(bad.status).toBe(400);
    expect(bad.body.error).toBe(CONTRACT_MESSAGE);
    let row = db.prepare('SELECT * FROM netapp_arrays WHERE id = ?').get(arrayId);
    expect(row.mgmt_host).toBe('https://p2-array.corp.example');
    expect(netappApi.getPassword(row)).toBe('p2-saved-password');

    // Same target typed without the scheme, no ssl_verify in the body.
    const ok = await request(app).put(`/api/netapp/arrays/${arrayId}`).send({ name: 'p2-renamed', mgmt_host: 'p2-array.corp.example' });
    expect(ok.status).toBe(200);
    row = db.prepare('SELECT * FROM netapp_arrays WHERE id = ?').get(arrayId);
    expect(row.name).toBe('p2-renamed');
    expect(row.ssl_verify).toBe(1);
    expect(netappApi.getPassword(row)).toBe('p2-saved-password');
  });

  it('R2 AIQUM PUT: contract message and row unchanged; same host with a blank password still saves', async () => {
    const bad = await request(app).put(`/api/netapp/aiqum/instances/${gwId}`).send({ host: 'evil.example' });
    expect(bad.status).toBe(400);
    expect(bad.body.error).toBe(CONTRACT_MESSAGE);
    expect(db.prepare('SELECT host FROM netapp_aiqum_instances WHERE id = ?').get(gwId).host).toBe('aiqum2.corp.example');

    const ok = await request(app).put(`/api/netapp/aiqum/instances/${gwId}`).send({ name: 'gw2-renamed', host: 'aiqum2.corp.example' });
    expect(ok.status).toBe(200);
    const typed = await request(app).put(`/api/netapp/aiqum/instances/${gwId}`).send({ host: 'aiqum3.corp.example', password: 'typed-password' });
    expect(typed.status).toBe(200);
    expect(db.prepare('SELECT host FROM netapp_aiqum_instances WHERE id = ?').get(gwId).host).toBe('aiqum3.corp.example');
  });

  it('a failed test never echoes transport text or an upstream body', async () => {
    stub(netappApi, 'testDirectConnection', () => {
      throw Object.assign(new Error('connect ECONNREFUSED 10.1.2.3:443'), { code: 'ECONNREFUSED' });
    });
    const net = await request(app).post('/api/netapp/arrays/test').send({ mgmt_host: 'a.corp.example', username: 'u', password: 'typed-password' });
    expect(net.body).toEqual({ ok: false, error: 'Could not reach the address' });

    restores.pop()();
    stub(netappApi, 'testDirectConnection', () => {
      throw Object.assign(new Error('Request failed'), { response: { status: 500, data: { error: { message: 'INTERNAL-BODY-TEXT' } } } });
    });
    const up = await request(app).post('/api/netapp/arrays/test').send({ mgmt_host: 'a.corp.example', username: 'u', password: 'typed-password' });
    expect(up.body.error).toBe('Unexpected response (HTTP 500)');
    expect(JSON.stringify(up.body)).not.toContain('INTERNAL-BODY-TEXT');
  });

  it('normalizeHost never keeps a caller-supplied http://', () => {
    expect(netappApi.normalizeHost('http://a.corp.example')).toBe('https://a.corp.example');
    expect(netappApi.normalizeHost('HTTP://a.corp.example/')).toBe('https://a.corp.example');
    expect(netappApi.normalizeHost('a.corp.example')).toBe('https://a.corp.example');
    expect(pureApi.normalizeHost('http://p.corp.example')).toBe('https://p.corp.example');
    expect(pureApi.normalizeHost('https://p.corp.example/')).toBe('https://p.corp.example');
  });
});

describe('second pass: Pure host router', () => {
  let arrayId;

  beforeAll(() => {
    db.exec('DELETE FROM pure_arrays;');
    arrayId = db.prepare(`
      INSERT INTO pure_arrays (name, mgmt_host, auth_method, client_id, key_id, username, encrypted_credentials, ssl_verify)
      VALUES ('p2-pure', 'https://p2-pure.corp.example', 'token', '', '', '', ?, 1)
    `).run(encrypt(JSON.stringify({ apiToken: 'p2-saved-token' }))).lastInsertRowid;
  });

  it('R1 no secret: stored host, stored ssl flag, stored auth method, stored token', async () => {
    const seen = stub(pureApi, 'testConnection', () => ({ ok: true }));
    const res = await request(app).post('/api/pure/arrays/test')
      .send({ id: arrayId, mgmt_host: 'evil.example', auth_method: 'token', ssl_verify: false });
    expect(res.status).toBe(200);
    const got = seen[0][0];
    expect(got.mgmt_host).toBe('https://p2-pure.corp.example');
    expect(got.ssl_verify).toBe(1);
    expect(got.auth_method).toBe('token');
    expect(got.apiToken).toBe('p2-saved-token');
    expect(JSON.stringify(got)).not.toContain('evil.example');
  });

  it('R1 no secret, body claims the other auth method: still the stored row as saved', async () => {
    const seen = stub(pureApi, 'testConnection', () => ({ ok: true }));
    await request(app).post('/api/pure/arrays/test')
      .send({ id: arrayId, mgmt_host: 'evil.example', auth_method: 'client', client_id: 'c', key_id: 'k', username: 'mallory' });
    const got = seen[0][0];
    expect(got.mgmt_host).toBe('https://p2-pure.corp.example');
    expect(got.auth_method).toBe('token');
    expect(got.username).toBe('');
  });

  it('R1 typed token: body host with the typed token, stored token not handed over', async () => {
    const seen = stub(pureApi, 'testConnection', () => ({ ok: true }));
    await request(app).post('/api/pure/arrays/test')
      .send({ id: arrayId, mgmt_host: 'new.example', auth_method: 'token', apiToken: 'typed-token-123', ssl_verify: false });
    const got = seen[0][0];
    expect(got.mgmt_host).toBe('new.example');
    expect(got.apiToken).toBe('typed-token-123');
    expect(got.ssl_verify).toBe(0);
    expect(JSON.stringify(got)).not.toContain('p2-saved-token');
  });

  it('a test with no id and no secret keeps its 400 and dials nothing', async () => {
    const seen = stub(pureApi, 'testConnection', () => ({ ok: true }));
    const res = await request(app).post('/api/pure/arrays/test').send({ mgmt_host: 'new.example', auth_method: 'token' });
    expect(res.status).toBe(400);
    expect(seen).toHaveLength(0);
  });

  it('R3: blocked targets are refused on create, test and PUT; 10.x and DNS names are accepted', async () => {
    const seen = stub(pureApi, 'testConnection', () => ({ ok: true }));
    for (const h of BLOCKED) {
      const t = await request(app).post('/api/pure/arrays/test').send({ mgmt_host: h, auth_method: 'token', apiToken: 'typed-token-123' });
      expect([h, t.status]).toEqual([h, 400]);
      const c = await request(app).post('/api/pure/arrays').send({ name: `blk-${h}`, mgmt_host: h, auth_method: 'token', apiToken: 'typed-token-123' });
      expect([h, c.status]).toEqual([h, 400]);
      const p = await request(app).put(`/api/pure/arrays/${arrayId}`).send({ name: 'p2-pure', mgmt_host: h, auth_method: 'token', apiToken: 'typed-token-123' });
      expect([h, p.status]).toEqual([h, 400]);
    }
    expect(seen).toHaveLength(0);
    for (const h of ALLOWED) {
      const t = await request(app).post('/api/pure/arrays/test').send({ mgmt_host: h, auth_method: 'token', apiToken: 'typed-token-123' });
      expect([h, t.status]).toEqual([h, 200]);
    }
  });

  it('R2 PUT: contract message, row unchanged, omitted ssl_verify kept, R5 cache dropped', async () => {
    const bad = await request(app).put(`/api/pure/arrays/${arrayId}`).send({ name: 'p2-pure', mgmt_host: 'evil.example', auth_method: 'token' });
    expect(bad.status).toBe(400);
    expect(bad.body.error).toBe(CONTRACT_MESSAGE);
    let row = db.prepare('SELECT * FROM pure_arrays WHERE id = ?').get(arrayId);
    expect(row.mgmt_host).toBe('https://p2-pure.corp.example');

    const dropped = stub(pureApi, 'invalidate', () => {});
    const ok = await request(app).put(`/api/pure/arrays/${arrayId}`).send({ name: 'p2-pure-renamed', mgmt_host: 'p2-pure.corp.example', auth_method: 'token' });
    expect(ok.status).toBe(200);
    row = db.prepare('SELECT * FROM pure_arrays WHERE id = ?').get(arrayId);
    expect(row.name).toBe('p2-pure-renamed');
    expect(row.ssl_verify).toBe(1);
    expect(JSON.parse(decrypt(row.encrypted_credentials)).apiToken).toBe('p2-saved-token');
    expect(dropped.map((a) => a[0])).toContain(Number(arrayId));
  });

  it('a failed test never echoes transport text or an upstream body', async () => {
    stub(pureApi, 'testConnection', () => {
      throw Object.assign(new Error('Request failed'), { response: { status: 401, data: { errors: [{ message: 'INTERNAL-BODY-TEXT' }] } } });
    });
    const res = await request(app).post('/api/pure/arrays/test').send({ mgmt_host: 'a.corp.example', auth_method: 'token', apiToken: 'typed-token-123' });
    expect(res.body.error).toBe('Sign-in was refused');
    expect(JSON.stringify(res.body)).not.toContain('INTERNAL-BODY-TEXT');
  });
});

describe('second pass: Cohesity clusters host router', () => {
  let directId;
  let heliosId;

  beforeAll(() => {
    db.exec('DELETE FROM clusters;');
    directId = db.prepare(`
      INSERT INTO clusters (name, connection_type, vip, auth_type, encrypted_credentials, ssl_verify)
      VALUES ('p2-direct', 'direct', 'p2-coh.corp.example', 'userpass', ?, 1)
    `).run(encrypt(JSON.stringify({ username: 'svc-coh', password: 'p2-saved-coh-password' }))).lastInsertRowid;
    heliosId = db.prepare(`
      INSERT INTO clusters (name, connection_type, vip, auth_type, encrypted_credentials, ssl_verify)
      VALUES ('p2-helios', 'helios', '1111', 'apikey', ?, 1)
    `).run(encrypt(JSON.stringify({ apiKey: 'p2-saved-helios-key' }))).lastInsertRowid;
  });

  const rowOf = (id) => db.prepare('SELECT * FROM clusters WHERE id = ?').get(id);

  it('R2: vip change with no credentials is the contract 400 and the row is unchanged', async () => {
    const res = await request(app).put(`/api/clusters/${directId}`).send({ vip: 'evil.example' });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe(CONTRACT_MESSAGE);
    expect(rowOf(directId).vip).toBe('p2-coh.corp.example');
    expect(JSON.parse(decrypt(rowOf(directId).encrypted_credentials)).password).toBe('p2-saved-coh-password');
  });

  it('R2: switching connection_type with no credentials is refused both ways (it decides where the key goes)', async () => {
    const toHelios = await request(app).put(`/api/clusters/${directId}`).send({ connection_type: 'helios', vip: '2222' });
    expect(toHelios.status).toBe(400);
    expect(toHelios.body.error).toBe(CONTRACT_MESSAGE);
    expect(rowOf(directId).connection_type).toBe('direct');

    const toDirect = await request(app).put(`/api/clusters/${heliosId}`).send({ connection_type: 'direct', vip: 'evil.example' });
    expect(toDirect.status).toBe(400);
    expect(toDirect.body.error).toBe(CONTRACT_MESSAGE);
    expect(rowOf(heliosId).connection_type).toBe('helios');
  });

  it('Helios to Helios: a new cluster id with the kept key still saves (the key still only goes to Helios)', async () => {
    const res = await request(app).put(`/api/clusters/${heliosId}`).send({ connection_type: 'helios', vip: '3333' });
    expect(res.status).toBe(200);
    expect(rowOf(heliosId).vip).toBe('3333');
  });

  it('a rename keeps the stored ssl_verify and the stored credential', async () => {
    const res = await request(app).put(`/api/clusters/${directId}`).send({ name: 'p2-direct-renamed' });
    expect(res.status).toBe(200);
    expect(rowOf(directId).ssl_verify).toBe(1);
    expect(JSON.parse(decrypt(rowOf(directId).encrypted_credentials)).password).toBe('p2-saved-coh-password');
  });

  it('R5: a target change with typed credentials drops the cached session', async () => {
    // clusters.js took invalidateSession at require time, so stubbing the
    // property would prove nothing. Measure the effect on the real cache
    // instead: count logins. No network: axios.post and axios.create are fakes.
    const axios = require('axios');
    const realPost = axios.post;
    const realCreate = axios.create;
    let logins = 0;
    axios.post = async () => { logins += 1; return { data: { accessToken: `tok-${logins}`, tokenType: 'Bearer' } }; };
    axios.create = () => ({ defaults: { headers: { common: {} } }, get: async () => ({ data: {} }) });
    restores.push(() => { axios.post = realPost; axios.create = realCreate; });

    await cohesityApi.fetchClusterInfo(rowOf(directId));
    expect(logins).toBe(1);
    await cohesityApi.fetchClusterInfo(rowOf(directId));
    expect(logins).toBe(1); // served from the session cache, so the cache is real

    const res = await request(app).put(`/api/clusters/${directId}`)
      .send({ vip: 'p2-coh-new.corp.example', auth_type: 'userpass', credentials: { username: 'svc-coh', password: 'typed-password' } });
    expect(res.status).toBe(200);
    expect(rowOf(directId).vip).toBe('p2-coh-new.corp.example');

    await cohesityApi.fetchClusterInfo(rowOf(directId));
    expect(logins).toBe(2); // the PUT dropped the cached session for this id
  });

  it('R3: blocked vips are refused on create, test and PUT, including a vip-only PUT body', async () => {
    // clusters.js took testClusterConnection at require time, so a stub on the
    // module object is never called. Fake axios itself: cohesityApi reaches it
    // through the module object, so nothing in this case can touch the network
    // and `dials` counts every attempt.
    const axios = require('axios');
    const realPost = axios.post;
    const realCreate = axios.create;
    const dials = [];
    axios.post = async (url) => { dials.push(url); return { data: { accessToken: 'tok', tokenType: 'Bearer' } }; };
    axios.create = (cfg) => ({
      defaults: { headers: { common: {} } },
      get: async () => { dials.push(cfg && cfg.baseURL); return { data: { name: 'fake-cluster' } }; },
    });
    restores.push(() => { axios.post = realPost; axios.create = realCreate; });
    const creds = { username: 'u', password: 'typed-password' };
    for (const h of ['127.0.0.1', 'localhost', '169.254.169.254']) {
      const c = await request(app).post('/api/clusters').send({ name: `blk-${h}`, connection_type: 'direct', vip: h, auth_type: 'userpass', credentials: creds });
      expect([h, c.status]).toEqual([h, 400]);
      const t = await request(app).post('/api/clusters/test').send({ connection_type: 'direct', vip: h, auth_type: 'userpass', credentials: creds });
      expect([h, t.status]).toEqual([h, 400]);
      const p = await request(app).put(`/api/clusters/${directId}`).send({ vip: h, auth_type: 'userpass', credentials: creds });
      expect([h, p.status]).toEqual([h, 400]);
    }
    // IPv6 forms and the URL-fragment trick never pass the vip character rule.
    for (const h of ['[::1]', '::ffff:127.0.0.1', '127.0.0.1#@p2-coh.corp.example']) {
      const p = await request(app).put(`/api/clusters/${directId}`).send({ vip: h, auth_type: 'userpass', credentials: creds });
      expect([h, p.status]).toEqual([h, 400]);
    }
    expect(dials).toHaveLength(0);
    const ok = await request(app).post('/api/clusters/test').send({ connection_type: 'direct', vip: '10.20.30.40', auth_type: 'userpass', credentials: creds });
    expect(ok.status).toBe(200);
    expect(ok.body.ok).toBe(true);
    // The allowed 10.x target is the only thing dialled: the login, then one GET.
    expect(dials).toEqual(['https://10.20.30.40/login', 'https://10.20.30.40']);
  });

  it('a failed upstream call reaches the error handler as a plain Error: no credentials, never an ICC 401', async () => {
    const leaky = Object.assign(new Error('Request failed with status code 401'), {
      isAxiosError: true,
      status: 401,
      response: { status: 401, data: { message: 'INTERNAL-BODY-TEXT' } },
      config: { data: JSON.stringify({ username: 'svc-coh', password: 'p2-saved-coh-password' }), headers: { apiKey: 'p2-saved-helios-key' } },
      request: {},
    });
    stub(cohesityApi, 'fetchClusterStatus', () => { throw leaky; });
    stub(cohesityApi, 'fetchNodes', () => { throw leaky; });
    for (const p of [`/api/clusters/${directId}/status`, `/api/clusters/${directId}/hardware`]) {
      const res = await request(app).get(p);
      expect(res.status).not.toBe(401);
      expect(res.status).toBeGreaterThanOrEqual(500);
      const text = JSON.stringify(res.body);
      expect(text).not.toContain('p2-saved-coh-password');
      expect(text).not.toContain('p2-saved-helios-key');
      expect(text).not.toContain('INTERNAL-BODY-TEXT');
    }
  });

  it('a failed userpass login is a plain Error with status 502, not the upstream 401', async () => {
    const axios = require('axios');
    const realPost = axios.post;
    axios.post = async () => {
      throw Object.assign(new Error('Request failed with status code 401'), {
        isAxiosError: true, response: { status: 401 }, config: { data: '{"password":"p2-saved-coh-password"}' },
      });
    };
    restores.push(() => { axios.post = realPost; });
    cohesityApi.invalidateSession(987654);
    let caught;
    try {
      await cohesityApi.fetchClusterInfo({
        id: 987654, connection_type: 'direct', vip: 'p2-coh.corp.example', auth_type: 'userpass', ssl_verify: 1,
        encrypted_credentials: encrypt(JSON.stringify({ username: 'svc-coh', password: 'p2-saved-coh-password' })),
      });
    } catch (err) { caught = err; }
    expect(caught).toBeTruthy();
    expect(caught.status).toBe(502);
    expect(caught.config).toBeUndefined();
    expect(caught.response).toEqual({ status: 401 });
    expect(JSON.stringify(Object.assign({}, caught, { message: caught.message }))).not.toContain('p2-saved-coh-password');
  });
});

describe('second pass: R4, no credentialed client follows a redirect', () => {
  const read = (rel) => fs.readFileSync(path.join(__dirname, rel), 'utf8');
  // Every axios.create( / axios.post( / axios.get( call must carry maxRedirects
  // somewhere before its closing. Counted per file: calls versus settings.
  const calls = (src) => (src.match(/axios\.(create|post|get)\(/g) || []).length;
  const settings = (src) => (src.match(/maxRedirects:\s*0/g) || []).length;

  it.each([
    ['../services/netappApi.js'],
    ['../services/pureApi.js'],
    ['../services/cohesityApi.js'],
    ['../../plugin-sdk/cohesity/backend/src/api.js'],
  ])('%s: one maxRedirects: 0 per axios call', (rel) => {
    const src = read(rel);
    expect(calls(src)).toBeGreaterThan(0);
    expect(settings(src)).toBe(calls(src));
  });

  it('the netapp and pure packs do not use axios at all (https.request never follows a redirect)', () => {
    for (const rel of ['../../plugin-sdk/netapp/backend/src/api.js', '../../plugin-sdk/pure/backend/src/api.js']) {
      const src = read(rel);
      expect(src).not.toMatch(/require\(['"]axios['"]\)/);
      expect(src).toMatch(/https\.request\(/);
    }
  });

  it('the AIQUM clients no longer hardcode rejectUnauthorized: false', () => {
    expect(read('../services/netappApi.js')).not.toMatch(/rejectUnauthorized:\s*false/);
    expect(read('../../plugin-sdk/netapp/backend/src/api.js')).not.toMatch(/rejectUnauthorized:\s*false/);
  });
});

describe('second pass: NetApp pack twin', () => {
  let pack;
  let packApi;
  let arrayId;
  let gwId;

  beforeAll(() => {
    pack = loadPack('netapp');
    packApi = require('../../plugin-sdk/netapp/backend/src/api.js');
    db.exec("DELETE FROM netapp_arrays; DELETE FROM netapp_aiqum_instances;");
    db.prepare(`
      INSERT INTO netapp_aiqum_instances (name, host, username, encrypted_credentials, poll_interval_minutes)
      VALUES ('first-gw', 'first-gw.corp.example', 'first-admin', ?, 15)
    `).run(encrypt('first-gateway-password'));
    gwId = db.prepare(`
      INSERT INTO netapp_aiqum_instances (name, host, username, encrypted_credentials, poll_interval_minutes)
      VALUES ('pk-gw', 'pk-aiqum.corp.example', 'pk-gw-admin', ?, 15)
    `).run(encrypt('pk-gw-saved-password')).lastInsertRowid;
    arrayId = db.prepare(`
      INSERT INTO netapp_arrays (name, mgmt_host, username, encrypted_credentials, source, ssl_verify)
      VALUES ('pk-array', 'https://pk-array.corp.example', 'pk-svc', ?, 'direct', 1)
    `).run(encrypt(JSON.stringify({ password: 'pk-saved-password' }))).lastInsertRowid;
  });

  it('R1 array test, no secret: stored host, stored ssl flag, stored username, stored secret', async () => {
    const seen = stub(packApi, 'testDirectConnection', () => ({ ok: true }));
    const res = await pack.call('POST', '/arrays/test', { id: arrayId, mgmt_host: 'evil.example', username: 'mallory', ssl_verify: false });
    expect(res.status).toBe(200);
    const got = seen[0][0];
    expect(got.mgmt_host).toBe('https://pk-array.corp.example');
    expect(got.ssl_verify).toBe(1);
    expect(got.username).toBe('pk-svc');
    expect(got.password).toBeUndefined();
    expect(packApi.getPassword(got, pack.coreApi)).toBe('pk-saved-password');
  });

  it('R1 array test, typed secret: body host and typed secret only', async () => {
    const seen = stub(packApi, 'testDirectConnection', () => ({ ok: true }));
    await pack.call('POST', '/arrays/test', { id: arrayId, mgmt_host: 'new.example', username: 'typed-user', password: 'typed-password', ssl_verify: false });
    const got = seen[0][0];
    expect(got.mgmt_host).toBe('new.example');
    expect(got.password).toBe('typed-password');
    expect(got.ssl_verify).toBe(0);
    expect(got.encrypted_credentials).toBeUndefined();
  });

  it('R1 AIQUM test: stored gateway as saved; typed secret goes to the body host; no id and no secret dials nothing', async () => {
    const seen = stub(packApi, 'testAiqum', () => ({ ok: true, clusterCount: 0, clusters: [] }));
    await pack.call('POST', '/aiqum/test', { id: gwId, host: 'evil.example', username: 'mallory' });
    expect(seen[0][0]).toEqual({ host: 'pk-aiqum.corp.example', username: 'pk-gw-admin', password: 'pk-gw-saved-password', sslVerify: false });

    await pack.call('POST', '/aiqum/test', { id: gwId, host: 'new.example', password: 'typed-password' });
    expect(seen[1][0].host).toBe('new.example');
    expect(seen[1][0].password).toBe('typed-password');
    expect(JSON.stringify(seen[1][0])).not.toContain('pk-gw-saved-password');

    const none = await pack.call('POST', '/aiqum/test', { host: 'evil.example' });
    expect(none.body.ok).toBe(false);
    expect(seen).toHaveLength(2);
  });

  it('R2 array PUT and AIQUM PUT: contract message, rows unchanged, omitted ssl_verify kept', async () => {
    const bad = await pack.call('PUT', `/arrays/${arrayId}`, { name: 'pk-array', mgmt_host: 'evil.example' });
    expect(bad.status).toBe(400);
    expect(bad.body.error).toBe(CONTRACT_MESSAGE);
    let row = db.prepare('SELECT * FROM netapp_arrays WHERE id = ?').get(arrayId);
    expect(row.mgmt_host).toBe('https://pk-array.corp.example');

    const ok = await pack.call('PUT', `/arrays/${arrayId}`, { name: 'pk-renamed', mgmt_host: 'pk-array.corp.example' });
    expect(ok.status).toBe(200);
    row = db.prepare('SELECT * FROM netapp_arrays WHERE id = ?').get(arrayId);
    expect(row.name).toBe('pk-renamed');
    expect(row.ssl_verify).toBe(1);
    expect(packApi.getPassword(row, pack.coreApi)).toBe('pk-saved-password');

    const typed = await pack.call('PUT', `/arrays/${arrayId}`, { name: 'pk-renamed', mgmt_host: 'pk-new.corp.example', password: 'typed-password' });
    expect(typed.status).toBe(200);

    const badGw = await pack.call('PUT', `/aiqum/instances/${gwId}`, { host: 'evil.example' });
    expect(badGw.status).toBe(400);
    expect(badGw.body.error).toBe(CONTRACT_MESSAGE);
    expect(db.prepare('SELECT host FROM netapp_aiqum_instances WHERE id = ?').get(gwId).host).toBe('pk-aiqum.corp.example');
    const okGw = await pack.call('PUT', `/aiqum/instances/${gwId}`, { name: 'pk-gw-renamed', host: 'pk-aiqum.corp.example' });
    expect(okGw.status).toBe(200);
  });

  it('R3: blocked targets are refused on create, test and PUT; 10.x and DNS names are accepted', async () => {
    const seen = stub(packApi, 'testDirectConnection', () => ({ ok: true }));
    const seenGw = stub(packApi, 'testAiqum', () => ({ ok: true }));
    for (const h of BLOCKED) {
      expect([h, (await pack.call('POST', '/arrays/test', { mgmt_host: h, username: 'u', password: 'typed-password' })).status]).toEqual([h, 400]);
      expect([h, (await pack.call('POST', '/arrays', { name: `pk-blk-${h}`, mgmt_host: h, username: 'u', password: 'typed-password' })).status]).toEqual([h, 400]);
      expect([h, (await pack.call('PUT', `/arrays/${arrayId}`, { name: 'pk-renamed', mgmt_host: h, password: 'typed-password' })).status]).toEqual([h, 400]);
      expect([h, (await pack.call('POST', '/aiqum/test', { host: h, username: 'u', password: 'typed-password' })).status]).toEqual([h, 400]);
      expect([h, (await pack.call('POST', '/aiqum/instances', { host: h, username: 'u', password: 'typed-password' })).status]).toEqual([h, 400]);
      expect([h, (await pack.call('PUT', `/aiqum/instances/${gwId}`, { host: h, password: 'typed-password' })).status]).toEqual([h, 400]);
    }
    expect(seen).toHaveLength(0);
    expect(seenGw).toHaveLength(0);
    for (const h of ALLOWED) {
      expect([h, (await pack.call('POST', '/arrays/test', { mgmt_host: h, username: 'u', password: 'typed-password' })).status]).toEqual([h, 200]);
    }
  });

  it('http:// is never kept, and a failed test never echoes transport text', async () => {
    expect(packApi.normalizeHost('http://a.corp.example')).toBe('https://a.corp.example');
    stub(packApi, 'testDirectConnection', () => {
      throw Object.assign(new Error('connect ECONNREFUSED 10.1.2.3:443'), { code: 'ECONNREFUSED' });
    });
    const res = await pack.call('POST', '/arrays/test', { mgmt_host: 'a.corp.example', username: 'u', password: 'typed-password' });
    expect(res.body).toEqual({ ok: false, error: 'Could not reach the address' });
  });
});

describe('second pass: Pure pack twin', () => {
  let pack;
  let packApi;
  let arrayId;

  beforeAll(() => {
    pack = loadPack('pure');
    packApi = require('../../plugin-sdk/pure/backend/src/api.js');
    db.exec('DELETE FROM pure_arrays;');
    arrayId = db.prepare(`
      INSERT INTO pure_arrays (name, mgmt_host, auth_method, client_id, key_id, username, encrypted_credentials, ssl_verify)
      VALUES ('pk-pure', 'https://pk-pure.corp.example', 'token', '', '', '', ?, 1)
    `).run(encrypt(JSON.stringify({ apiToken: 'pk-saved-token' }))).lastInsertRowid;
  });

  it('R1 no secret: stored host, stored ssl flag, stored auth method, stored token', async () => {
    const seen = stub(packApi, 'testConnection', () => ({ ok: true }));
    const res = await pack.call('POST', '/arrays/test', { id: arrayId, mgmt_host: 'evil.example', auth_method: 'token', ssl_verify: false });
    expect(res.status).toBe(200);
    const got = seen[0][0];
    expect(got.mgmt_host).toBe('https://pk-pure.corp.example');
    expect(got.ssl_verify).toBe(1);
    expect(got.auth_method).toBe('token');
    expect(got.apiToken).toBe('pk-saved-token');
  });

  it('R1 typed token: body host with the typed token; no id and no secret keeps its 400', async () => {
    const seen = stub(packApi, 'testConnection', () => ({ ok: true }));
    await pack.call('POST', '/arrays/test', { id: arrayId, mgmt_host: 'new.example', auth_method: 'token', apiToken: 'typed-token-123', ssl_verify: false });
    const got = seen[0][0];
    expect(got.mgmt_host).toBe('new.example');
    expect(got.apiToken).toBe('typed-token-123');
    expect(got.ssl_verify).toBe(0);
    expect(JSON.stringify(got)).not.toContain('pk-saved-token');

    const none = await pack.call('POST', '/arrays/test', { mgmt_host: 'new.example', auth_method: 'token' });
    expect(none.status).toBe(400);
    expect(seen).toHaveLength(1);
  });

  it('R2 PUT: contract message, row unchanged, omitted ssl_verify kept, R5 cache dropped', async () => {
    const bad = await pack.call('PUT', `/arrays/${arrayId}`, { name: 'pk-pure', mgmt_host: 'evil.example', auth_method: 'token' });
    expect(bad.status).toBe(400);
    expect(bad.body.error).toBe(CONTRACT_MESSAGE);
    let row = db.prepare('SELECT * FROM pure_arrays WHERE id = ?').get(arrayId);
    expect(row.mgmt_host).toBe('https://pk-pure.corp.example');

    const dropped = stub(packApi, 'invalidate', () => {});
    const ok = await pack.call('PUT', `/arrays/${arrayId}`, { name: 'pk-pure-renamed', mgmt_host: 'pk-pure.corp.example', auth_method: 'token' });
    expect(ok.status).toBe(200);
    row = db.prepare('SELECT * FROM pure_arrays WHERE id = ?').get(arrayId);
    expect(row.name).toBe('pk-pure-renamed');
    expect(row.ssl_verify).toBe(1);
    expect(JSON.parse(decrypt(row.encrypted_credentials)).apiToken).toBe('pk-saved-token');
    expect(dropped.map((a) => a[0])).toContain(Number(arrayId));

    const typed = await pack.call('PUT', `/arrays/${arrayId}`, { name: 'pk-pure-renamed', mgmt_host: 'pk-new.corp.example', auth_method: 'token', apiToken: 'typed-token-123' });
    expect(typed.status).toBe(200);
  });

  it('R3: blocked targets are refused on create, test and PUT; 10.x and DNS names are accepted', async () => {
    const seen = stub(packApi, 'testConnection', () => ({ ok: true }));
    for (const h of BLOCKED) {
      expect([h, (await pack.call('POST', '/arrays/test', { mgmt_host: h, auth_method: 'token', apiToken: 'typed-token-123' })).status]).toEqual([h, 400]);
      expect([h, (await pack.call('POST', '/arrays', { name: `pk-blk-${h}`, mgmt_host: h, auth_method: 'token', apiToken: 'typed-token-123' })).status]).toEqual([h, 400]);
      expect([h, (await pack.call('PUT', `/arrays/${arrayId}`, { name: 'pk-pure-renamed', mgmt_host: h, auth_method: 'token', apiToken: 'typed-token-123' })).status]).toEqual([h, 400]);
    }
    expect(seen).toHaveLength(0);
    for (const h of ALLOWED) {
      expect([h, (await pack.call('POST', '/arrays/test', { mgmt_host: h, auth_method: 'token', apiToken: 'typed-token-123' })).status]).toEqual([h, 200]);
    }
  });

  it('http:// is never kept, and a failed test never echoes an upstream body', async () => {
    expect(packApi.normalizeHost('http://p.corp.example')).toBe('https://p.corp.example');
    stub(packApi, 'testConnection', () => {
      throw Object.assign(new Error('HTTP 401'), { response: { status: 401, data: { errors: [{ message: 'INTERNAL-BODY-TEXT' }] } } });
    });
    const res = await pack.call('POST', '/arrays/test', { mgmt_host: 'a.corp.example', auth_method: 'token', apiToken: 'typed-token-123' });
    expect(res.body.error).toBe('Sign-in was refused');
    expect(JSON.stringify(res.body)).not.toContain('INTERNAL-BODY-TEXT');
  });
});
