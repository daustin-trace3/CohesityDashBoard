/**
 * Cross-platform pages must never serve a platform's data on the strength of
 * "authenticated" alone. Each test drives the real routers with a caller whose
 * grants are set per request, the way middleware/authenticate.js sets them for
 * a user or a scoped service-account key.
 */
import { describe, it, expect, beforeAll, beforeEach, afterEach } from 'vitest';
import { createRequire } from 'module';
import express from 'express';
import request from 'supertest';

const require = createRequire(import.meta.url);
const db = require('../db/database');
const { setSetting } = require('../services/settings');
const appSvc = require('../services/appServiceStatus');
const svc = require('../services/serviceStatus');
const { matches, hasPermission, canViewPlatform, canManagePlatform } = require('../services/rbac');

let app;
let vcId;
let brocadeSourceId;
let clusterId;

const as = (grants) => ({ 'x-test-grants': JSON.stringify(grants) });

function clearAll() {
  for (const t of [
    'service_alert_analyses', 'service_alert_events', 'service_status_timeline',
    'app_service_state', 'app_service_watch', 'app_service_catalog',
    'vcenter_vms', 'vcenter_hosts', 'vcenter_datastores', 'vcenter_vcenters',
    'brocade_device_ports', 'brocade_sources', 'cohesity_objects', 'clusters', 'poller_status',
  ]) db.exec('DELETE FROM ' + t);
}

function seedIncidentApp() {
  vcId = db.prepare("INSERT INTO vcenter_vcenters (name, host, username, encrypted_credentials) VALUES ('rbac-vc', 'rbac-vc.corp.local', 'admin', 'enc')").run().lastInsertRowid;
  brocadeSourceId = db.prepare("INSERT INTO brocade_sources (name, host) VALUES ('sannav-rbac', 'sannav.corp.local')").run().lastInsertRowid;
  clusterId = db.prepare("INSERT INTO clusters (name, connection_type, auth_type, encrypted_credentials) VALUES ('rbac-coh', 'direct', 'userpass', 'enc')").run().lastInsertRowid;
  db.prepare("INSERT INTO vcenter_hosts (vcenter_id, host_id, name, cluster_name, connection_state, power_state) VALUES (?, 'host-1', 'esx-rbac.corp.local', 'cl', 'CONNECTED', 'POWERED_ON')").run(vcId);
  db.prepare("INSERT INTO vcenter_datastores (vcenter_id, datastore_id, name, ds_type, accessible) VALUES (?, 'ds-1', 'ds-rbac-01', 'VMFS', 1)").run(vcId);
  for (let i = 1; i <= 4; i += 1) {
    db.prepare(`
      INSERT INTO vcenter_vms (vcenter_id, vm_id, name, host_name, cluster_name, power_state, tools_status, ip_address, tags, datastores)
      VALUES (?, ?, ?, 'esx-rbac.corp.local', 'cl', 'POWERED_ON', 'toolsOk', NULL, ?, ?)
    `).run(vcId, 'vm-' + i, 'rbac-vm-0' + i, JSON.stringify(['usage-id: AA00009999']), JSON.stringify(['ds-rbac-01']));
  }
  // Both SAN paths of the host lost: critical, and the reason names switch + port.
  for (const [wwn, sw, port] of [['10:00:00:00:00:00:00:01', 'SECRET-SW01', 18], ['10:00:00:00:00:00:00:02', 'SECRET-SW02', 19]]) {
    db.prepare(`
      INSERT INTO brocade_device_ports (source_id, wwn, port_role, switch_name, port_number, enclosure_name, is_missing, stale)
      VALUES (?, ?, 'Initiator', ?, ?, 'esx-rbac', 1, 0)
    `).run(brocadeSourceId, wwn, sw, port);
  }
  db.prepare(`
    INSERT INTO cohesity_objects (cluster_id, object_id, name, is_protected, last_backup_ms, last_backup_status)
    VALUES (?, 'obj-1', 'rbac-vm-01', 1, ?, 'kSuccess')
  `).run(clusterId, Date.now() - 50 * 3600000);
  appSvc.addWatch({ usageId: 'AA00009999', label: 'Payments', user: 'tester' });
  appSvc.evaluateAll();
}

beforeAll(() => {
  app = express();
  app.use(express.json());
  app.use((req, res, next) => {
    req.auth = { kind: 'service', grants: JSON.parse(req.get('x-test-grants') || '[]'), user: { username: 'tester' } };
    next();
  });
  app.use('/api/app-services', require('../routes/appServices'));
  app.use('/api/service-status', require('../routes/serviceStatus'));
  app.use('/api/ops', require('../routes/ops'));
  app.use('/api/poller', require('../routes/poller'));
  app.use('/api/dns', require('../routes/dns'));

  // Service Status enablement is registry-driven: a minimal manifest per id.
  const registry = require('../core/registry');
  for (const id of ['dell', 'vcenter']) {
    if (registry.getPlugin(id)) continue;
    registry.registerPlugin({
      id, name: id, apiVersion: registry.PLUGIN_API_VERSION, migrations: [],
      createRouter: () => (req, res, next) => next(),
    });
    registry.setEnabled(id, true);
  }
});

beforeEach(() => {
  clearAll();
  appSvc._resetTableCache();
  setSetting('service_status_ai_enabled', '0');
  svc._resetTestSeams();
});

afterEach(() => { svc._resetTestSeams(); });

describe('rbac helpers', () => {
  it('canViewPlatform needs a grant inside that namespace', () => {
    expect(canViewPlatform(['dell:*:view'], 'dell')).toBe(true);
    expect(canViewPlatform(['dell:alerts:view'], 'dell')).toBe(true);
    expect(canViewPlatform(['dell:*:view'], 'vcenter')).toBe(false);
    expect(canViewPlatform(['*:*:view'], 'vcenter')).toBe(true);
    expect(canViewPlatform([], 'vcenter')).toBe(false);
    expect(canViewPlatform(['*:*:*'], 'admin')).toBe(false);
    expect(canManagePlatform(['dell:*:view'], 'dell')).toBe(false);
    expect(canManagePlatform(['dell:*:*'], 'dell')).toBe(true);
  });

  it('a namespace wildcard does not reach the admin namespace unless it is the full *:*:* grant', () => {
    expect(matches('*:*:view', 'admin:ai-audit:view')).toBe(false);
    expect(matches('*:*:view', 'admin:users:view')).toBe(false);
    expect(matches('*:settings:manage', 'admin:settings:manage')).toBe(false);
    expect(matches('*:*:*', 'admin:users:manage')).toBe(true);
    expect(matches('admin:*:view', 'admin:users:view')).toBe(true);
    expect(matches('*:*:view', 'vcenter:vms:view')).toBe(true);
    expect(hasPermission(['*:*:view'], 'admin:settings:view')).toBe(false);
  });
});

describe('app services', () => {
  beforeEach(seedIncidentApp);

  it('refuses every read without a vcenter grant, including a zero-grant key', async () => {
    for (const grants of [[], ['dell:*:view'], ['cohesity:*:*']]) {
      for (const path of ['/board', '/usage-ids', '/watch', '/catalog', '/apps/AA00009999']) {
        const res = await request(app).get('/api/app-services' + path).set(as(grants));
        expect(res.status, JSON.stringify(grants) + ' ' + path).toBe(403);
      }
    }
  });

  it('a vcenter-only caller sees servers and hosts but no SAN, array or backup detail', async () => {
    const res = await request(app).get('/api/app-services/apps/AA00009999').set(as(['vcenter:*:view']));
    expect(res.status).toBe(200);
    expect(res.body.state).toBe('critical');
    expect(res.body.servers).toHaveLength(4);
    expect(res.body.hosts[0].sanPaths).toEqual({ total: 0, missing: 0, ports: [] });
    expect(res.body.backup).toEqual([]);
    expect(res.body.counts.pathsMissing).toBe(0);
    expect(res.body.counts.backupsStale).toBe(0);
    const text = JSON.stringify(res.body);
    expect(text).not.toContain('SECRET-SW01');
    expect(text).not.toContain('SECRET-SW02');
    expect(text).not.toContain('10:00:00:00:00:00:00:01');

    const board = await request(app).get('/api/app-services/board').set(as(['vcenter:*:view']));
    expect(board.status).toBe(200);
    expect(board.body.apps[0].state).toBe('critical');
    expect(JSON.stringify(board.body)).not.toContain('SECRET-SW');
  });

  it('a caller holding the component platforms gets the full picture', async () => {
    const grants = ['vcenter:*:view', 'brocade:*:view', 'pure:*:view', 'netapp:*:view', 'cohesity:*:view', 'zerto:*:view'];
    const res = await request(app).get('/api/app-services/apps/AA00009999').set(as(grants));
    expect(res.status).toBe(200);
    expect(res.body.hosts[0].sanPaths.missing).toBe(2);
    expect(res.body.reason).toContain('SECRET-SW01');
    expect(res.body.backup).toHaveLength(1);
  });
});

describe('service status', () => {
  beforeEach(async () => {
    seedIncidentApp();
    svc._setCollector(() => ({ failed: [], items: [
      { platform: 'dell', sourceKey: 'alert:1', severity: 'critical', host: 'r740-secret (TAG1234)', message: 'PSU failed', firstSeen: new Date().toISOString(), lastSeen: new Date().toISOString() },
      { platform: 'cohesity', sourceKey: 'alert:2', severity: 'critical', host: 'coh-secret', message: 'Node down', firstSeen: new Date().toISOString(), lastSeen: new Date().toISOString() },
    ] }));
    await svc.sweep();
  });

  const today = () => new Date().toISOString().slice(0, 10);

  it('the board lists only platforms the caller holds', async () => {
    const none = await request(app).get('/api/service-status/board').set(as([]));
    expect(none.status).toBe(200);
    expect(none.body.platforms).toEqual([]);
    const dellOnly = await request(app).get('/api/service-status/board').set(as(['dell:*:view']));
    const ids = dellOnly.body.platforms.map((p) => p.id);
    expect(ids.every((id) => id === 'dell')).toBe(true);
  });

  it('events of another platform are 403, event detail by id is 404', async () => {
    const list = await request(app).get('/api/service-status/events').query({ platform: 'cohesity', date: today() }).set(as(['dell:*:view']));
    expect(list.status).toBe(403);
    const own = await request(app).get('/api/service-status/events').query({ platform: 'dell', date: today() }).set(as(['dell:*:view']));
    expect(own.status).toBe(200);
    expect(own.body.events).toHaveLength(1);

    const cohEvent = db.prepare("SELECT id FROM service_alert_events WHERE platform = 'cohesity'").get();
    const peek = await request(app).get('/api/service-status/events/' + cohEvent.id).set(as(['dell:*:view']));
    expect(peek.status).toBe(404);
    const zero = await request(app).get('/api/service-status/events/' + cohEvent.id).set(as([]));
    expect(zero.status).toBe(404);
  });

  it('the appservice row needs vcenter, and its SAN detail needs brocade', async () => {
    const appEvent = db.prepare("SELECT id FROM service_alert_events WHERE platform = 'appservice'").get();
    expect(appEvent).toBeTruthy();
    const dellOnly = await request(app).get('/api/service-status/events/' + appEvent.id).set(as(['dell:*:view']));
    expect(dellOnly.status).toBe(404);
    const vcOnly = await request(app).get('/api/service-status/events/' + appEvent.id).set(as(['vcenter:*:view']));
    expect(vcOnly.status).toBe(200);
    expect(JSON.stringify(vcOnly.body)).not.toContain('SECRET-SW');
    const list = await request(app).get('/api/service-status/events').query({ platform: 'appservice', date: today() }).set(as(['vcenter:*:view']));
    expect(JSON.stringify(list.body)).not.toContain('SECRET-SW');
  });

  it('manual analysis needs manage on the platform, sweep needs settings manage', async () => {
    const dellEvent = db.prepare("SELECT id FROM service_alert_events WHERE platform = 'dell'").get();
    const viewer = await request(app).post('/api/service-status/events/' + dellEvent.id + '/analyze').set(as(['dell:*:view']));
    expect(viewer.status).toBe(403);
    const other = await request(app).post('/api/service-status/events/' + dellEvent.id + '/analyze').set(as(['cohesity:*:*']));
    expect(other.status).toBe(404);
    const sweep = await request(app).post('/api/service-status/sweep').set(as(['dell:*:*']));
    expect(sweep.status).toBe(403);
  });

  it('manual analysis honours the AI switch and the per-event cooldown', async () => {
    const dellEvent = db.prepare("SELECT id FROM service_alert_events WHERE platform = 'dell'").get();
    const saved = { a: process.env.OPENAI_API_KEY, b: process.env.OPENAI_TOKEN };
    process.env.OPENAI_TOKEN = 'test-token';
    try {
      const off = await request(app).post('/api/service-status/events/' + dellEvent.id + '/analyze').set(as(['dell:*:*']));
      expect(off.status).toBe(409);
      setSetting('service_status_ai_enabled', '1');
      let calls = 0;
      svc._setChat(async () => { calls += 1; return JSON.stringify({ verdict: 'degraded', verdict_reason: '', why: 'x', actions: [], current_state: 'y', confidence: 'low' }); });
      const first = await request(app).post('/api/service-status/events/' + dellEvent.id + '/analyze').set(as(['dell:*:*']));
      expect(first.status).toBe(200);
      const second = await request(app).post('/api/service-status/events/' + dellEvent.id + '/analyze').set(as(['dell:*:*']));
      expect(second.status).toBe(429);
      expect(calls).toBe(1);
    } finally {
      if (saved.a === undefined) delete process.env.OPENAI_API_KEY; else process.env.OPENAI_API_KEY = saved.a;
      if (saved.b === undefined) delete process.env.OPENAI_TOKEN; else process.env.OPENAI_TOKEN = saved.b;
    }
  });
});

describe('ops summary, poller status and dns', () => {
  beforeEach(seedIncidentApp);

  it('ops summary builds cards only for held platforms', async () => {
    const none = await request(app).get('/api/ops/summary').set(as([]));
    expect(none.status).toBe(200);
    expect(none.body.platforms).toEqual([]);
    expect(none.body.totals.objects).toBe(0);
    const some = await request(app).get('/api/ops/summary').set(as(['vcenter:*:view']));
    expect(some.body.platforms.every((p) => p.id === 'vcenter')).toBe(true);
  });

  it('poller status hides source names of platforms the caller does not hold', async () => {
    const res = await request(app).get('/api/poller/status').set(as(['dell:*:view']));
    expect(res.status).toBe(200);
    expect(res.body.vcenter).toMatchObject({ restricted: true, entities: [] });
    expect(res.body.cohesity).toMatchObject({ restricted: true, entities: [] });
    expect(JSON.stringify(res.body)).not.toContain('rbac-vc');
    expect(JSON.stringify(res.body)).not.toContain('rbac-coh');
    const vc = await request(app).get('/api/poller/status').set(as(['vcenter:*:view']));
    expect(JSON.stringify(vc.body.vcenter)).toContain('rbac-vc');
  });

  it('dns lookups need some platform grant and never reveal the server to non-admins', async () => {
    setSetting('dns_server', '10.9.9.9');
    const zero = await request(app).post('/api/dns/resolve').set(as([])).send({ ips: ['10.0.0.1'] });
    expect(zero.status).toBe(403);
    const adminOnly = await request(app).get('/api/dns/status').set(as(['admin:users:view']));
    expect(adminOnly.status).toBe(403);
    const viewer = await request(app).get('/api/dns/status').set(as(['netapp:*:view']));
    expect(viewer.status).toBe(200);
    expect(viewer.body).toEqual({ configured: true, server: '' });
    const admin = await request(app).get('/api/dns/status').set(as(['*:*:*']));
    expect(admin.body.server).toBe('10.9.9.9');
    setSetting('dns_server', '');
  });
});
