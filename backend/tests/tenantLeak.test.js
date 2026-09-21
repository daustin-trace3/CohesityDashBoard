/**
 * Two-tenant leak test (docs/MULTI-TENANT-DESIGN.md, release gate 17).
 *
 * Tenant "leaky" gets one row carrying a marker string in every platform's
 * source table plus settings. Every GET route the app registers with no path
 * parameter is then called as tenant "clean" (and as the default tenant); a
 * response that contains the marker is a leak. Routes with parameters are
 * listed, not called, so the count printed at the end shows what the walk did
 * not reach.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { createRequire } from 'module';
import request from 'supertest';

const require = createRequire(import.meta.url);
const API_KEY = 'test-api-key';
const MARKER = 'zq-leak-marker-7731';

let app;
let getRoutes = [];
let skipped = [];

function walk(stack, prefix, out) {
  for (const layer of stack || []) {
    if (layer.route) {
      const path = prefix + layer.route.path;
      if (layer.route.methods.get) out.push(path);
    } else if (layer.name === 'router' && layer.handle && layer.handle.stack) {
      const seg = layer.regexp && layer.regexp.source
        .replace('^\\/', '/').replace('\\/?(?=\\/|$)', '').replace(/\\\//g, '/').replace('(?:/(?=$))?', '');
      walk(layer.handle.stack, prefix + (seg && !seg.includes('(?') && !seg.includes('^') ? seg : ''), out);
    }
  }
}

beforeAll(() => {
  const registry = require('../core/registry');
  const tenants = require('../core/tenantRegistry');
  const db = require('../db/database');
  const { runAsTenant } = require('../core/tenantContext');
  const { setSetting } = require('../services/settings');

  registry.init();
  for (const id of ['pure', 'netapp', 'zerto', 'vcenter', 'dell', 'aria', 'ariaops', 'aws', 'unifi', 'brocade', 'bluecat']) {
    registry.registerPlugin(require(`../platforms/${id}`));
  }
  if (typeof registry.markBuiltin === 'function') registry.markBuiltin('cohesity');

  tenants.createTenant({ id: 'leaky', name: 'Leaky Corp' });
  tenants.createTenant({ id: 'clean', name: 'Clean Corp' });

  runAsTenant('leaky', () => {
    const run = (sql) => { try { db.prepare(sql).run(); } catch (e) { throw new Error(`${sql.slice(0, 60)}: ${e.message}`); } };
    run(`INSERT INTO clusters (name, vip, connection_type, auth_type, encrypted_credentials) VALUES ('${MARKER}-cohesity', '10.9.9.1', 'direct', 'userpass', 'enc')`);
    run(`INSERT INTO pure_arrays (name, mgmt_host, client_id, key_id, username, encrypted_credentials) VALUES ('${MARKER}-pure', '10.9.9.2', 'c', 'k', 'u', 'enc')`);
    run(`INSERT INTO netapp_arrays (name, mgmt_host, username, encrypted_credentials) VALUES ('${MARKER}-netapp', '10.9.9.3', 'u', 'enc')`);
    run(`INSERT INTO vcenter_vcenters (name, host, username, encrypted_credentials) VALUES ('${MARKER}-vcenter', '10.9.9.4', 'u', 'enc')`);
    run(`INSERT INTO dell_ome_instances (name, host, username, encrypted_credentials) VALUES ('${MARKER}-dell', '10.9.9.5', 'u', 'enc')`);
    run(`INSERT INTO aria_instances (name, host, username, encrypted_credentials) VALUES ('${MARKER}-aria', '10.9.9.6', 'u', 'enc')`);
    run(`INSERT INTO aws_accounts (name) VALUES ('${MARKER}-aws')`);
    run(`INSERT INTO unifi_sources (name, host) VALUES ('${MARKER}-unifi', '10.9.9.7')`);
    run(`INSERT INTO brocade_sources (name, host) VALUES ('${MARKER}-brocade', '10.9.9.8')`);
    run(`INSERT INTO bluecat_sources (name, host) VALUES ('${MARKER}-bluecat', '10.9.9.9')`);
    run(`INSERT INTO zerto_sites (site_identifier, name) VALUES ('${MARKER}-site', '${MARKER}-zerto')`);
    setSetting('dns_server', `${MARKER}.example`);
    setSetting('smtp_recipients', `${MARKER}@example.com`);
  });

  const { createApp } = require('../app');
  app = createApp({ licenseGate: (req, res, next) => next() });

  const found = [];
  walk(app._router.stack, '', found);
  for (const [id, router] of registry._routers()) {
    if (router.stack) walk(router.stack, `/api/${id}`, found);
  }
  const unique = [...new Set(found)].filter((p) => p.startsWith('/api/'));
  getRoutes = unique.filter((p) => !p.includes(':') && !p.includes('*'));
  skipped = unique.filter((p) => p.includes(':') || p.includes('*'));
});

describe('two-tenant leak test', () => {
  it('walks a meaningful number of GET routes', () => {
    expect(getRoutes.length).toBeGreaterThan(40);
  });

  it('the marker is visible inside its own tenant', async () => {
    const res = await request(app).get('/api/t/leaky/clusters').set('x-api-key', API_KEY);
    expect(res.status).toBe(200);
    expect(JSON.stringify(res.body)).toContain(MARKER);
  });

  it('no GET route answers tenant clean with tenant leaky data', async () => {
    const leaks = [];
    const errors = [];
    for (const route of getRoutes) {
      const res = await request(app).get(route.replace('/api/', '/api/t/clean/')).set('x-api-key', API_KEY);
      const text = typeof res.text === 'string' ? res.text : JSON.stringify(res.body);
      if (text && text.includes(MARKER)) leaks.push(`${route} -> ${res.status}`);
      if (res.status >= 500) errors.push(`${route} -> ${res.status} ${text.slice(0, 80)}`);
    }
    expect(leaks).toEqual([]);
    expect(errors).toEqual([]);
  }, 120000);

  it('the header form isolates the same way, and the default tenant sees nothing either', async () => {
    const leaks = [];
    for (const route of getRoutes) {
      const viaHeader = await request(app).get(route).set('x-api-key', API_KEY).set('x-icc-tenant', 'clean');
      if ((viaHeader.text || '').includes(MARKER)) leaks.push(`${route} (header)`);
      const viaDefault = await request(app).get(route.replace('/api/', '/api/t/default/')).set('x-api-key', API_KEY);
      if ((viaDefault.text || '').includes(MARKER)) leaks.push(`${route} (default)`);
    }
    expect(leaks).toEqual([]);
  }, 120000);

  it('a request that names no tenant is refused now that there are several', async () => {
    const res = await request(app).get('/api/clusters').set('x-api-key', API_KEY);
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/more than one tenant/);
    const unknown = await request(app).get('/api/t/nobody/clusters').set('x-api-key', API_KEY);
    expect(unknown.status).toBe(404);
    const bad = await request(app).get('/api/clusters').set('x-api-key', API_KEY).set('x-icc-tenant', '../etc');
    expect(bad.status).toBe(404);
  });

  it('reports what the walk could not call', () => {
    process.stderr.write(`[leak test] called ${getRoutes.length} GET routes; ${skipped.length} routes with path parameters were not called
`);
    expect(skipped.length).toBeGreaterThanOrEqual(0);
  });
});
