/**
 * App Services networkSummary (round 12, package B): per-app site rollup from the
 * LogicMonitor tables, single-switch servers, unresolved servers, the degraded-only
 * site findings, and the unknown shape when LogicMonitor is absent.
 */
import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import { createRequire } from 'module';
import express from 'express';
import request from 'supertest';

const require = createRequire(import.meta.url);
const db = require('../db/database');
const { setSetting } = require('../services/settings');
const appSvc = require('../services/appServiceStatus');
const svc = require('../services/serviceStatus');
const appServicesRouter = require('../routes/appServices');
const { runMigrations } = require('../core/migrations');
const lmMigrations = require('../db/migrations/logicmonitor');

let app;
let vcId;
let lmSource;

const CLEAR = [
  'service_alert_analyses', 'service_alert_events', 'service_status_timeline',
  'app_service_state', 'app_service_watch', 'app_service_catalog',
  'vcenter_vms', 'vcenter_hosts', 'vcenter_datastores', 'vcenter_vcenters',
  'poller_status',
];
const LM_CLEAR = [
  'lm_latency_episodes', 'lm_collectors', 'lm_interface_history', 'lm_interface_daily', 'lm_issue_history',
  'lm_check_locations', 'lm_checks', 'lm_topology_links', 'lm_interfaces', 'lm_devices', 'lm_sources',
];

const ins = (table, row) => {
  const cols = Object.keys(row);
  return db.prepare(`INSERT INTO ${table} (${cols.join(', ')}) VALUES (${cols.map(() => '?').join(', ')})`).run(...cols.map((c) => row[c])).lastInsertRowid;
};

function vm(name, hostName, ip) {
  db.prepare(`
    INSERT INTO vcenter_vms (vcenter_id, vm_id, name, host_name, cluster_name, power_state, tools_status, ip_address, tags, datastores)
    VALUES (?, ?, ?, ?, 'cl-app', 'POWERED_ON', 'toolsOk', ?, ?, ?)
  `).run(vcId, `vm-${name}`, name, hostName, ip, JSON.stringify(['usage-id: AA00001721']), JSON.stringify([]));
}

beforeAll(() => {
  app = express();
  app.use(express.json());
  app.use((req, res, next) => { req.auth = { grants: ['*:*:*'], user: { username: 'tester' } }; next(); });
  app.use('/api/app-services', appServicesRouter);
});

beforeEach(() => {
  runMigrations(db, 'logicmonitor', lmMigrations);
  for (const t of CLEAR) db.exec(`DELETE FROM ${t}`);
  for (const t of LM_CLEAR) db.exec(`DELETE FROM ${t}`);
  appSvc._resetTableCache();
  setSetting('service_status_ai_enabled', '0');
  svc._resetTestSeams();
  vcId = db.prepare("INSERT INTO vcenter_vcenters (name, host, username, encrypted_credentials) VALUES ('nsum-vc', 'nsum-vc.corp.local', 'admin', 'enc')").run().lastInsertRowid;
  db.prepare("INSERT INTO vcenter_hosts (vcenter_id, host_id, name, cluster_name, connection_state, power_state) VALUES (?, 'h1', 'esx-a.corp.local', 'cl-app', 'CONNECTED', 'POWERED_ON')").run(vcId);
  vm('app-vm-01', 'esx-a.corp.local', '10.9.0.1');
  vm('app-vm-02', 'esx-a.corp.local', '10.9.0.2');
  vm('app-vm-03', 'esx-a.corp.local', '10.9.0.3');
  appSvc.addWatch({ usageId: 'aa00001721' });
});

/** Switch sw-1 at site phx with one port to esx-a; all three servers sit there through the switch. */
function seedLm({ deadSwitch = false, wan = null, collectorDown = false, episode = null } = {}) {
  lmSource = ins('lm_sources', { name: 'Acme', company: 'acme', auth_mode: 'lmv1', encrypted_credentials: 'x' });
  ins('lm_devices', { source_id: lmSource, lm_device_id: 201, name: '10.1.1.1', display_name: 'sw-1', role: 'switch', is_network: 1, host_status: deadSwitch ? 'dead' : 'normal', site_key: 'phx', site_name: 'Phoenix DC' });
  ins('lm_devices', { source_id: lmSource, lm_device_id: 301, name: 'app-vm-01', display_name: 'app-vm-01', is_network: 0, host_status: 'normal', site_key: 'phx', site_name: 'Phoenix DC' });
  ins('lm_devices', { source_id: lmSource, lm_device_id: 302, name: 'app-vm-02', display_name: 'app-vm-02', is_network: 0, host_status: 'normal', site_key: 'phx', site_name: 'Phoenix DC' });
  ins('lm_interfaces', { source_id: lmSource, lm_device_id: 201, instance_id: 1, display_name: 'Gi1/0/5', status: 1, status_text: 'up' });
  ins('lm_topology_links', {
    source_id: lmSource, src_device_id: 201, src_instance_id: 1, src_port: 'Gi1/0/5', dst_name: 'esx-a.corp.local', dst_port: 'vmnic0',
    protocol: 'lldp', confidence: 'high', last_seen: new Date().toISOString(), dst_platform: 'vcenter', dst_ref: 'esx-a.corp.local',
  });
  if (wan) {
    ins('lm_interfaces', { source_id: lmSource, lm_device_id: 201, instance_id: 2, display_name: 'Gi0/0/1', status: wan === 'down' ? 2 : 1, status_text: wan === 'down' ? 'down' : 'up', is_wan: 1, stale: 0, wan_label: 'MPLS Dallas', description: 'MPLS Dallas' });
  }
  if (collectorDown) ins('lm_collectors', { source_id: lmSource, collector_id: 48, hostname: 'col-phx', is_down: 1, stale: 0, site_key: 'phx', site_name: 'Phoenix DC' });
  if (episode) {
    ins('lm_latency_episodes', {
      source_id: lmSource, subject_kind: 'check', check_id: 'c1', checkpoint_id: 'cp1', subject_key: 'check:c1:cp1', subject_label: 'ping dal-core from Phoenix',
      site_key: 'phx', kind: 'latency', state: episode, opened_at: new Date().toISOString(),
    });
  }
  appSvc._resetTableCache();
}

describe('networkSummary', () => {
  it('is { state: unknown } and adds no findings when the LogicMonitor tables are empty', () => {
    const d = appSvc.evaluate('aa00001721');
    expect(d.networkSummary).toEqual({ state: 'unknown' });
    expect(d.counts).toMatchObject({ networkSites: 0, networkSingleSwitch: 0, networkUnresolved: 0 });
    expect(d.state).toBe('ok');
  });

  it('is { state: unknown } when the LogicMonitor tables do not exist', () => {
    for (const t of ['lm_devices']) db.exec(`ALTER TABLE ${t} RENAME TO ${t}_hold`);
    try {
      appSvc._resetTableCache();
      const d = appSvc.evaluate('aa00001721');
      expect(d.networkSummary).toEqual({ state: 'unknown' });
    } finally {
      db.exec('ALTER TABLE lm_devices_hold RENAME TO lm_devices');
      appSvc._resetTableCache();
    }
  });

  it('reports sites, resolved and unresolved servers, and single-switch servers without a finding', () => {
    seedLm();
    const d = appSvc.evaluate('aa00001721');
    const n = d.networkSummary;
    expect(n.state).toBe('ok');
    expect(n.sites).toHaveLength(1);
    expect(n.sites[0]).toMatchObject({ siteKey: 'phx', siteName: 'Phoenix DC', servers: 3, state: 'ok', deadNetworkDevices: 0, collectorsDown: 0 });
    expect(n.sites[0].openEpisodes).toEqual({ watching: 0, degrading: 0, critical: 0 });
    // The path resolver matches servers on their host, so every VM on esx-a resolves; each sits behind sw-1 only.
    expect(n.resolvedServers).toBe(3);
    expect(n.unresolvedServers).toBe(0);
    expect(n.singleSwitchServers.sort()).toEqual(['app-vm-01', 'app-vm-02', 'app-vm-03']);
    expect(d.findings).toEqual([]);
    expect(d.state).toBe('ok');
    expect(d.counts).toMatchObject({ networkSites: 1, networkSingleSwitch: 3, networkUnresolved: 0 });
  });

  it('a dead network device at the site degrades the app (never critical)', () => {
    seedLm({ deadSwitch: true });
    const d = appSvc.evaluate('aa00001721');
    expect(d.findings.map((f) => f.level)).toEqual(['degraded']);
    expect(d.findings[0].text).toBe('Site Phoenix DC: network device sw-1 is dead (3 servers of this app are there)');
    expect(d.state).toBe('degraded');
    expect(d.networkSummary.sites[0]).toMatchObject({ state: 'critical', deadNetworkDevices: 1 });
    expect(d.networkSummary.state).toBe('degraded');
  });

  it('a critical WAN circuit at the site is a degraded finding with the circuit in the summary', () => {
    seedLm({ wan: 'down' });
    const d = appSvc.evaluate('aa00001721');
    const f = d.findings.find((x) => /WAN circuit/.test(x.text));
    expect(f).toMatchObject({ level: 'degraded', text: 'Site Phoenix DC: WAN circuit sw-1 Gi0/0/1 is critical' });
    expect(d.state).toBe('degraded');
    expect(d.networkSummary.sites[0].circuits[0]).toMatchObject({ deviceName: 'sw-1', port: 'Gi0/0/1', state: 'critical' });
  });

  it('a critical latency episode at the site is a degraded finding; watching and degrading are counted only', () => {
    seedLm({ episode: 'watching' });
    let d = appSvc.evaluate('aa00001721');
    expect(d.findings).toEqual([]);
    expect(d.networkSummary.sites[0].openEpisodes).toEqual({ watching: 1, degrading: 0, critical: 0 });
    db.exec("UPDATE lm_latency_episodes SET state = 'critical'");
    appSvc._resetTableCache();
    d = appSvc.evaluate('aa00001721');
    expect(d.findings).toMatchObject([{ level: 'degraded', text: 'Site Phoenix DC: reachability episode critical on ping dal-core from Phoenix' }]);
    expect(d.state).toBe('degraded');
    db.exec("UPDATE lm_latency_episodes SET state = 'closed'");
    appSvc._resetTableCache();
    d = appSvc.evaluate('aa00001721');
    expect(d.networkSummary.sites[0].openEpisodes).toEqual({ watching: 0, degrading: 0, critical: 0 });
  });

  it('counts collectors that are down at the site', () => {
    seedLm({ collectorDown: true });
    const d = appSvc.evaluate('aa00001721');
    expect(d.networkSummary.sites[0]).toMatchObject({ collectorsDown: 1, state: 'critical' });
  });

  it('the board and the detail route carry networkSummary and the new counts', async () => {
    seedLm({ deadSwitch: true });
    appSvc.evaluateAll();
    const board = await request(app).get('/api/app-services/board');
    const row = board.body.apps[0];
    expect(row.networkSummary.sites[0]).toMatchObject({ siteKey: 'phx' });
    expect(row.counts).toMatchObject({ networkSites: 1, networkSingleSwitch: 3 });
    expect(row.counts.networkSummary).toBeUndefined();
    const detail = await request(app).get('/api/app-services/apps/aa00001721');
    expect(detail.body.networkSummary.resolvedServers).toBe(3);
  });
});
