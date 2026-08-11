/**
 * WP1: Nutanix platform manifest tests, mirroring tests/platformPlugins.test.js
 * style — dispatcher 200, disabled -> 404 platform_disabled, sources CRUD with
 * keep-if-blank credentials, /issues shape, /issue-history bare array, and
 * the probe endpoint (hit against an unreachable host — no network mocking,
 * same convention as tests/netbackupPlugin.test.js).
 *
 * Loaded via createRequire so app.js, core/registry.js and db/database.js all
 * resolve to the SAME module instance (see tests/platformPlugins.test.js).
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { createRequire } from 'module';
import request from 'supertest';

const require = createRequire(import.meta.url);

const registry = require('../core/registry');
const nutanixManifest = require('../platforms/nutanix');
const { createApp } = require('../app');

const API_KEY = 'test-api-key';
let app;

beforeEach(() => {
  registry._reset();
  registry.init();
  registry.registerPlugin(nutanixManifest);
  registry.setEnabled('nutanix', true);
  app = createApp({ licenseGate: (req, res, next) => next() });
});

const get = (p) => request(app).get(p).set('x-api-key', API_KEY);
const post = (p, body) => request(app).post(p).send(body).set('x-api-key', API_KEY);
const put = (p, body) => request(app).put(p).send(body).set('x-api-key', API_KEY);
const del = (p) => request(app).delete(p).set('x-api-key', API_KEY);

describe('nutanix platform manifest', () => {
  it('registers with the expected id/name/color', () => {
    expect(nutanixManifest.id).toBe('nutanix');
    expect(nutanixManifest.name).toBe('Nutanix');
    expect(nutanixManifest.color).toBe('#7855FA');
  });

  it('dispatcher 200: GET /api/nutanix/sources returns an empty list', async () => {
    const res = await get('/api/nutanix/sources');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ sources: [] });
  });

  it('disabling nutanix returns 404 platform_disabled; re-enabling restores 200', async () => {
    registry.setEnabled('nutanix', false);
    const disabledRes = await get('/api/nutanix/sources');
    expect(disabledRes.status).toBe(404);
    expect(disabledRes.body).toEqual({ error: 'platform_disabled' });

    registry.setEnabled('nutanix', true);
    const enabledRes = await get('/api/nutanix/sources');
    expect(enabledRes.status).toBe(200);
  });

  it('GET /api/nutanix/overview returns the totals/clusters/issues shape', async () => {
    const res = await get('/api/nutanix/overview');
    expect(res.status).toBe(200);
    expect(res.body.totals).toBeTypeOf('object');
    expect(res.body.totals.sources).toBe(0);
    expect(Array.isArray(res.body.clusters)).toBe(true);
    expect(res.body.moveConfigured).toBe(false);
    expect(res.body.mineConfigured).toBe(false);
    expect(Array.isArray(res.body.issues)).toBe(true);
  });

  it('GET /api/nutanix/issues -> {issues:[...]}', async () => {
    const res = await get('/api/nutanix/issues');
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.issues)).toBe(true);
  });

  it('GET /api/nutanix/issue-history -> a bare array', async () => {
    const res = await get('/api/nutanix/issue-history');
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body)).toBe(true);
  });

  it('sources CRUD: create -> 201, duplicate name/host+type -> 409, list -> 200, delete -> ok', async () => {
    const createRes = await post('/api/nutanix/sources', {
      name: 'PE-Test', sourceType: 'prism_element', host: '10.0.0.50',
      username: 'viewer', password: 'secret123',
    });
    expect(createRes.status).toBe(201);
    expect(createRes.body.source.name).toBe('PE-Test');
    expect(createRes.body.source.sourceType).toBe('prism_element');
    expect(createRes.body.source.password).toBeUndefined();
    expect(createRes.body.source.encrypted_credentials).toBeUndefined();
    const id = createRes.body.source.id;

    const dupRes = await post('/api/nutanix/sources', {
      name: 'PE-Test', sourceType: 'prism_element', host: '10.0.0.51',
      username: 'viewer', password: 'secret123',
    });
    expect(dupRes.status).toBe(409);

    const listRes = await get('/api/nutanix/sources');
    expect(listRes.status).toBe(200);
    expect(listRes.body.sources.length).toBe(1);

    const delRes = await del(`/api/nutanix/sources/${id}`);
    expect(delRes.status).toBe(200);
    expect(delRes.body).toEqual({ ok: true });

    const listAfter = await get('/api/nutanix/sources');
    expect(listAfter.body.sources.length).toBe(0);
  });

  it('PUT /api/nutanix/sources/:id keeps stored credentials when password is blank/omitted', async () => {
    const createRes = await post('/api/nutanix/sources', {
      name: 'PE-Keep', sourceType: 'prism_element', host: '10.0.0.60',
      username: 'viewer', password: 'original-pass',
    });
    const id = createRes.body.source.id;

    // Blank update: no password field at all, just a name change.
    const updateRes = await put(`/api/nutanix/sources/${id}`, { name: 'PE-Keep-Renamed' });
    expect(updateRes.status).toBe(200);
    expect(updateRes.body.source.name).toBe('PE-Keep-Renamed');

    // A second update with an empty-string password must also not fail
    // validation (keep-if-blank contract).
    const blankPwRes = await put(`/api/nutanix/sources/${id}`, { name: 'PE-Keep-Renamed', password: '' });
    expect(blankPwRes.status).toBe(200);
  });

  it('POST /api/nutanix/sources/:id/poll ends in /poll and returns {ok:true}', async () => {
    const createRes = await post('/api/nutanix/sources', {
      name: 'PE-Poll', sourceType: 'prism_element', host: 'definitely-not-a-real-cluster.invalid',
      username: 'viewer', password: 'secret123',
    });
    const id = createRes.body.source.id;
    const res = await post(`/api/nutanix/sources/${id}/poll`);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true });
  });

  it('GET /api/nutanix/sources/:id/probe 200s with per-section ok:false against an unreachable host', async () => {
    const createRes = await post('/api/nutanix/sources', {
      name: 'PE-Probe', sourceType: 'prism_element', host: 'definitely-not-a-real-cluster-2.invalid',
      username: 'viewer', password: 'secret123',
    });
    const id = createRes.body.source.id;
    const res = await get(`/api/nutanix/sources/${id}/probe?sections=cluster,hosts`);
    expect(res.status).toBe(200);
    expect(res.body.sections.cluster.ok).toBe(false);
    expect(res.body.sections.hosts.ok).toBe(false);
  }, 60000);

  it('POST /api/nutanix/sources/test never throws on an unreachable host', async () => {
    const res = await post('/api/nutanix/sources/test', {
      host: 'definitely-not-a-real-cluster.invalid', sourceType: 'prism_central', username: 'admin', password: 'x',
    });
    expect(res.status).toBe(502);
    expect(res.body.ok).toBe(false);
  }, 20000);

  it('GET /api/poller/status includes a nutanix section for the enabled plugin (metricsHistory hook)', async () => {
    const res = await get('/api/poller/status');
    expect(res.status).toBe(200);
    expect(res.body.nutanix).toBeTypeOf('object');
    expect(res.body.nutanix.enabled).toBe(true);
    expect(Array.isArray(res.body.nutanix.entities)).toBe(true);
  });

  it('move connections CRUD + summary shape', async () => {
    const createRes = await post('/api/nutanix/move/connections', {
      name: 'Move-1', host: '10.0.0.70', username: 'nutanix', password: 'secret123',
    });
    expect(createRes.status).toBe(201);
    const id = createRes.body.connection.id;

    const summaryRes = await get('/api/nutanix/move/summary');
    expect(summaryRes.status).toBe(200);
    expect(summaryRes.body.configured).toBe(true);
    expect(Array.isArray(summaryRes.body.plans)).toBe(true);

    const delRes = await del(`/api/nutanix/move/connections/${id}`);
    expect(delRes.status).toBe(200);
  });

  it('GET /api/nutanix/mine/summary reflects mine-flagged sources', async () => {
    const before = await get('/api/nutanix/mine/summary');
    expect(before.body.configured).toBe(false);

    await post('/api/nutanix/sources', {
      name: 'Mine-Cluster', sourceType: 'prism_element', host: '10.0.0.80',
      username: 'viewer', password: 'secret123', isMine: true,
    });

    const after = await get('/api/nutanix/mine/summary');
    expect(after.body.configured).toBe(true);
    expect(after.body.clusters.length).toBe(1);
  });

  it('advisor route 404s for an unknown report', async () => {
    const res = await get('/api/nutanix/advisor/not-a-real-report');
    expect(res.status).toBe(404);
  });

  it('advisor route recognizes the four contract reports', async () => {
    for (const report of ['capacity', 'replication', 'hotspots', 'resiliency']) {
      const res = await get(`/api/nutanix/advisor/${report}`);
      expect(res.status).toBe(200);
      expect(res.body).toHaveProperty('enabled');
    }
  });
});
