/**
 * App Service Status: usage-id catalog, watch list, the rollup rules Doug set
 * on 2026-09-17, and the hand-off of critical apps into the Service Status
 * event tables (sweep + evidence + verdict).
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
const appServicesRouter = require('../routes/appServices');

let app;
let vcId;
let brocadeSourceId;
let clusterId;

function clearAll() {
  for (const t of [
    'service_alert_analyses', 'service_alert_events', 'service_status_timeline',
    'app_service_state', 'app_service_watch',
    'vcenter_vms', 'vcenter_hosts', 'vcenter_datastores', 'vcenter_vcenters',
    'brocade_device_ports', 'brocade_sources', 'cohesity_objects', 'clusters', 'poller_status',
  ]) db.exec(`DELETE FROM ${t}`);
}

function seedBase() {
  vcId = db.prepare(`
    INSERT INTO vcenter_vcenters (name, host, username, encrypted_credentials)
    VALUES ('app-vc', 'app-vc.corp.local', 'admin', 'enc')
  `).run().lastInsertRowid;
  brocadeSourceId = db.prepare("INSERT INTO brocade_sources (name, host) VALUES ('sannav-app', 'sannav.corp.local')").run().lastInsertRowid;
  clusterId = db.prepare(`
    INSERT INTO clusters (name, connection_type, auth_type, encrypted_credentials)
    VALUES ('app-coh', 'direct', 'userpass', 'enc')
  `).run().lastInsertRowid;
}

function host(name, connectionState = 'CONNECTED') {
  db.prepare(`
    INSERT INTO vcenter_hosts (vcenter_id, host_id, name, cluster_name, connection_state, power_state)
    VALUES (?, ?, ?, 'cl-app', ?, 'POWERED_ON')
  `).run(vcId, `host-${name}`, name, connectionState);
}

function vm(name, hostName, { power = 'POWERED_ON', tags = [], datastores = ['ds-app-01'], ip = null } = {}) {
  db.prepare(`
    INSERT INTO vcenter_vms (vcenter_id, vm_id, name, host_name, cluster_name, power_state, tools_status, ip_address, tags, datastores)
    VALUES (?, ?, ?, ?, 'cl-app', ?, 'toolsOk', ?, ?, ?)
  `).run(vcId, `vm-${name}`, name, hostName, power, ip, JSON.stringify(tags), JSON.stringify(datastores));
}

function datastore(name, accessible = 1) {
  db.prepare("INSERT INTO vcenter_datastores (vcenter_id, datastore_id, name, ds_type, accessible) VALUES (?, ?, ?, 'VMFS', ?)")
    .run(vcId, `ds-${name}`, name, accessible);
}

function devicePort(hostShort, wwn, switchName, portNumber, isMissing) {
  db.prepare(`
    INSERT INTO brocade_device_ports (source_id, wwn, port_role, switch_name, port_number, enclosure_name, is_missing, stale)
    VALUES (?, ?, 'Initiator', ?, ?, ?, ?, 0)
  `).run(brocadeSourceId, wwn, switchName, portNumber, hostShort, isMissing ? 1 : 0);
}

function cohesityObject(name, { protectedFlag = 1, ageHours = 2 } = {}) {
  db.prepare(`
    INSERT INTO cohesity_objects (cluster_id, object_id, name, is_protected, last_backup_ms, last_backup_status)
    VALUES (?, ?, ?, ?, ?, 'kSuccess')
  `).run(clusterId, `obj-${name}`, name, protectedFlag, ageHours === null ? null : Date.now() - ageHours * 3600000);
}

/** 20 online servers on two healthy hosts carrying one usage-id. */
function seedHealthyApp(tag = 'usage-id: AA00001721', count = 20) {
  host('esx-a.corp.local');
  host('esx-b.corp.local');
  datastore('ds-app-01', 1);
  for (let i = 1; i <= count; i += 1) {
    vm(`app-vm-${String(i).padStart(2, '0')}`, i % 2 ? 'esx-a.corp.local' : 'esx-b.corp.local', { tags: [tag, 'Environment: Production'] });
  }
}

beforeAll(() => {
  app = express();
  app.use(express.json());
  app.use((req, res, next) => { req.auth = { grants: ['*:*:*'], user: { username: 'tester' } }; next(); });
  app.use('/api/app-services', appServicesRouter);
});

beforeEach(() => {
  clearAll();
  appSvc._resetTableCache();
  seedBase();
  setSetting('service_status_ai_enabled', '0');
  svc._resetTestSeams();
});

afterEach(() => { svc._resetTestSeams(); });

describe('usage-id catalog and watch list', () => {
  it('groups tags case-insensitively, counts VMs, filters by q and flags watched ids', () => {
    host('esx-a.corp.local');
    vm('v1', 'esx-a.corp.local', { tags: ['usage-id: AA00001721'] });
    vm('v2', 'esx-a.corp.local', { tags: ['usage-id: aa00001721', 'App: DB'] });
    vm('v3', 'esx-a.corp.local', { tags: ['usage-id: PP00003101'] });
    vm('v4', 'esx-a.corp.local', { tags: ['Environment: Dev'] });
    appSvc.addWatch({ usageId: 'pp00003101', label: 'Payroll', user: 'tester' });

    const all = appSvc.listUsageIds();
    expect(all.map((u) => [u.usageId, u.vmCount, u.watched])).toEqual([
      ['aa00001721', 2, false],
      ['pp00003101', 1, true],
    ]);
    expect(all[0].displayId.toLowerCase()).toBe('aa00001721');
    expect(appSvc.listUsageIds({ q: 'pp0000' }).map((u) => u.usageId)).toEqual(['pp00003101']);
    expect(appSvc.listWatch()).toMatchObject([{ usageId: 'pp00003101', displayId: 'PP00003101', label: 'Payroll' }]);
  });

  it('routes: add, relabel, list, remove; the board carries the persisted state', async () => {
    seedHealthyApp();
    const add = await request(app).post('/api/app-services/watch').send({ usageId: 'AA00001721' });
    expect(add.status).toBe(201);
    expect(add.body).toMatchObject({ usageId: 'aa00001721', displayId: 'AA00001721', label: null });

    const put = await request(app).put('/api/app-services/watch/aa00001721').send({ label: 'Trading' });
    expect(put.body.label).toBe('Trading');

    const board = await request(app).get('/api/app-services/board');
    expect(board.status).toBe(200);
    expect(board.body.apps).toHaveLength(1);
    expect(board.body.apps[0]).toMatchObject({ usageId: 'aa00001721', label: 'Trading', state: 'ok', eventId: null });
    expect(board.body.apps[0].counts).toMatchObject({ vms: 20, vmsOnline: 20, vmsOffline: 0, hosts: 2 });

    const catalog = await request(app).get('/api/app-services/usage-ids').query({ q: 'aa' });
    expect(catalog.body.usageIds[0].watched).toBe(true);

    const del = await request(app).delete('/api/app-services/watch/AA00001721');
    expect(del.status).toBe(204);
    expect((await request(app).get('/api/app-services/board')).body.apps).toEqual([]);
    expect((await request(app).delete('/api/app-services/watch/AA00001721')).status).toBe(404);
    expect((await request(app).post('/api/app-services/watch').send({})).status).toBe(400);
  });
});

describe('rollup rules', () => {
  it('all servers online with healthy components -> ok', () => {
    seedHealthyApp();
    const d = appSvc.evaluate('aa00001721');
    expect(d.state).toBe('ok');
    expect(d.findings).toEqual([]);
    expect(d.counts).toMatchObject({ vms: 20, vmsOnline: 20, hosts: 2, pathsTotal: 0 });
    expect(d.servers.every((s) => s.online)).toBe(true);
  });

  it('1 of 20 servers powered off -> degraded; 3 of 20 (15%) -> critical', () => {
    seedHealthyApp();
    db.prepare("UPDATE vcenter_vms SET power_state = 'POWERED_OFF' WHERE name = 'app-vm-01'").run();
    let d = appSvc.evaluate('AA00001721');
    expect(d.state).toBe('degraded');
    expect(d.findings[0].text).toMatch(/1 of 20 servers offline/);

    db.prepare("UPDATE vcenter_vms SET power_state = 'POWERED_OFF' WHERE name IN ('app-vm-02', 'app-vm-03')").run();
    d = appSvc.evaluate('AA00001721');
    expect(d.state).toBe('critical');
    expect(d.findings[0]).toMatchObject({ level: 'critical' });
    expect(d.findings[0].text).toMatch(/3 of 20 servers offline.*above the 10% threshold/);
    expect(d.counts.vmsOffline).toBe(3);
  });

  it('a NOT_RESPONDING host takes its servers offline even when vCenter still lists them powered on', () => {
    seedHealthyApp();
    db.prepare("UPDATE vcenter_hosts SET connection_state = 'NOT_RESPONDING' WHERE name = 'esx-b.corp.local'").run();
    const d = appSvc.evaluate('aa00001721');
    expect(d.state).toBe('critical'); // 10 of 20 offline
    expect(d.counts).toMatchObject({ vmsOffline: 10, hostsDisconnected: 1 });
    expect(d.hosts.find((h) => h.name === 'esx-b.corp.local').state).toBe('critical');
    expect(d.findings.some((f) => /ESX host esx-b.corp.local is NOT_RESPONDING/.test(f.text))).toBe(true);
  });

  it('one lost SAN path on a host -> degraded; every path lost -> critical, naming the switch ports', () => {
    seedHealthyApp();
    devicePort('esx-a', '10:00:00:00:00:00:00:01', 'PROD-A-SW01', 18, false);
    devicePort('esx-a', '10:00:00:00:00:00:00:02', 'PROD-B-SW01', 18, true);
    let d = appSvc.evaluate('aa00001721');
    expect(d.state).toBe('degraded');
    expect(d.counts).toMatchObject({ pathsTotal: 2, pathsMissing: 1 });
    expect(d.findings[0].text).toMatch(/1 of 2 SAN paths lost on host esx-a.corp.local \(PROD-B-SW01 port 18\)/);

    db.prepare('UPDATE brocade_device_ports SET is_missing = 1').run();
    d = appSvc.evaluate('aa00001721');
    expect(d.state).toBe('critical');
    expect(d.findings[0].text).toMatch(/all 2 SAN paths lost on host esx-a.corp.local/);
    expect(d.hosts.find((h) => h.name === 'esx-a.corp.local').sanPaths.ports).toHaveLength(2);
  });

  it('an inaccessible datastore -> critical; storage rows list who uses it', () => {
    seedHealthyApp();
    db.prepare("UPDATE vcenter_datastores SET accessible = 0 WHERE name = 'ds-app-01'").run();
    const d = appSvc.evaluate('aa00001721');
    expect(d.state).toBe('critical');
    expect(d.findings[0].text).toMatch(/datastore ds-app-01 is not accessible/);
    expect(d.storage[0]).toMatchObject({ kind: 'datastore', name: 'ds-app-01', accessible: false, state: 'critical' });
    expect(d.storage[0].usedBy).toHaveLength(20);
    expect(d.counts.datastoresInaccessible).toBe(1);
  });

  it('a protected VM with no Cohesity backup in 24 h -> degraded; a fresh backup or an unprotected VM does not colour the app', () => {
    seedHealthyApp();
    cohesityObject('app-vm-01', { ageHours: 30 });
    cohesityObject('app-vm-02', { ageHours: 2 });
    cohesityObject('app-vm-03', { protectedFlag: 0, ageHours: null });
    const d = appSvc.evaluate('aa00001721');
    expect(d.state).toBe('degraded');
    expect(d.findings).toHaveLength(1);
    expect(d.findings[0].text).toMatch(/last Cohesity backup of app-vm-01 is 30 h old/);
    expect(d.backup.map((b) => [b.vm, b.state])).toEqual([['app-vm-01', 'degraded'], ['app-vm-02', 'ok'], ['app-vm-03', 'ok']]);
    expect(d.counts.backupsStale).toBe(1);
  });

  it('backup rows fold per server: copies on two clusters and a guest-hostname match make one row, newest backup wins', () => {
    host('esx-a.corp.local');
    vm('bk-vm-01', 'esx-a.corp.local', { tags: ['usage-id: BB00002210'] });
    db.prepare("UPDATE vcenter_vms SET guest_hostname = 'bk-vm-01-guest.corp.local' WHERE name = 'bk-vm-01'").run();
    const cluster2 = db.prepare(`
      INSERT INTO clusters (name, connection_type, auth_type, encrypted_credentials)
      VALUES ('app-coh-dr', 'direct', 'userpass', 'enc')
    `).run().lastInsertRowid;
    cohesityObject('bk-vm-01', { ageHours: 40 });                       // primary cluster copy, stale
    db.prepare(`
      INSERT INTO cohesity_objects (cluster_id, object_id, name, is_protected, last_backup_ms, last_backup_status)
      VALUES (?, 'obj-dr', 'bk-vm-01', 1, ?, 'kSuccess')
    `).run(cluster2, Date.now() - 3 * 3600000);                          // DR cluster copy, fresh
    cohesityObject('bk-vm-01-guest', { protectedFlag: 0, ageHours: null }); // agent object by guest hostname

    const d = appSvc.evaluate('bb00002210');
    expect(d.backup).toHaveLength(1);
    expect(d.backup[0]).toMatchObject({ vm: 'bk-vm-01', platform: 'cohesity', protected: true, state: 'ok', copies: 3 });
    expect(d.backup[0].clusters.sort()).toEqual(['app-coh', 'app-coh-dr']);
    expect(d.backup[0].ageHours).toBe(3);
    expect(d.state).toBe('ok');
  });

  it('a usage-id no VM carries -> unknown', () => {
    const d = appSvc.evaluate('zz00000000');
    expect(d.state).toBe('unknown');
    expect(d.counts.vms).toBe(0);
  });
});

describe('hand-off into Service Status', () => {
  it('a critical app becomes an appservice event on sweep, is analysed from app evidence, and clears when the app recovers', async () => {
    seedHealthyApp();
    appSvc.addWatch({ usageId: 'AA00001721', label: 'Trading' });
    svc._setCollector(() => ({ items: [], failed: [] }));

    await svc.sweep();
    expect(db.prepare("SELECT COUNT(*) c FROM service_alert_events WHERE platform = 'appservice'").get().c).toBe(0);

    db.prepare("UPDATE vcenter_vms SET power_state = 'POWERED_OFF' WHERE name IN ('app-vm-01', 'app-vm-02', 'app-vm-03')").run();
    await svc.sweep();
    const ev = db.prepare("SELECT * FROM service_alert_events WHERE platform = 'appservice' AND cleared_at IS NULL").get();
    expect(ev).toBeTruthy();
    expect(ev.source_key).toBe('usage:aa00001721');
    expect(ev.host).toBe('AA00001721 (Trading)');
    expect(ev.message).toMatch(/3 of 20 servers offline/);

    // AI is off, so the worker wrote an evidence-only analysis from the app bundle.
    const analysis = db.prepare('SELECT * FROM service_alert_analyses WHERE event_id = ?').get(ev.id);
    expect(analysis.verdict).toBe('offline');
    const evidence = JSON.parse(analysis.evidence_json);
    expect(evidence.app.state).toBe('critical');
    expect(evidence.app.servers).toHaveLength(20);

    const board = appSvc.getBoard().apps[0];
    expect(board).toMatchObject({ state: 'critical', eventId: ev.id, analysisStatus: 'disabled', verdict: 'offline' });

    // The platform board never lists appservice as a platform row.
    expect(svc.getBoard({ days: 7 }).platforms.some((p) => p.id === 'appservice')).toBe(false);

    db.prepare("UPDATE vcenter_vms SET power_state = 'POWERED_ON'").run();
    await svc.sweep();
    expect(db.prepare('SELECT cleared_at FROM service_alert_events WHERE id = ?').get(ev.id).cleared_at).toBeTruthy();
    expect(appSvc.getBoard().apps[0]).toMatchObject({ state: 'ok', eventId: null });
  });

  it('deriveVerdict for appservice: critical -> offline, degraded -> degraded; prompt names the app service', () => {
    seedHealthyApp();
    appSvc.addWatch({ usageId: 'aa00001721' });
    const event = { platform: 'appservice', source_key: 'usage:aa00001721', severity: 'critical', host: 'AA00001721', message: 'm' };
    let evidence = svc.deriveVerdict(event, appSvc.gatherEvidence(event));
    expect(evidence.verdict).toBe('degraded'); // healthy app, no critical finding

    db.prepare("UPDATE vcenter_datastores SET accessible = 0").run();
    evidence = svc.deriveVerdict(event, appSvc.gatherEvidence(event));
    expect(evidence).toMatchObject({ verdict: 'offline', confidence: 'high' });
    expect(appSvc.systemPrompt()).toMatch(/application service/);
  });
});
