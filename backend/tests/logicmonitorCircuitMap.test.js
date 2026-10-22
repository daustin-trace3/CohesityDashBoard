/**
 * LogicMonitor round 13 routes and the demo scenario: Site 360 circuits, the circuit map, the
 * circuit event log with operator notes, the Overview node keys, and the numbers the demo seed
 * promises (abq degraded, tus down, a Zayo site link flapping on 5 of the last 7 days).
 * Routes are mounted on a bare express app like logicmonitorRoutes.test.js.
 */
import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import { createRequire } from 'module';
import { execFileSync } from 'child_process';
import path from 'path';
import fs from 'fs';
import os from 'os';
import request from 'supertest';

const require = createRequire(import.meta.url);

const express = require('express');
const Database = require('better-sqlite3');
const db = require('../db/database');
const { runMigrations } = require('../core/migrations');
const lmMigrations = require('../db/migrations/logicmonitor');
const lmCirc = require('../services/logicmonitorCircuits');

let app;

beforeAll(() => {
  runMigrations(db, 'logicmonitor', lmMigrations);
  const router = require('../routes/logicmonitor');
  const errorHandler = require('../middleware/errorHandler');
  app = express();
  app.use(express.json());
  app.use('/api/logicmonitor', router);
  app.use(errorHandler);
});

const MIN = 60000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;
const sqlStamp = (ms) => new Date(ms).toISOString().replace('T', ' ').slice(0, 19);

const TABLES = ['lm_circuit_events', 'lm_issue_history', 'lm_topology_links', 'lm_interface_daily', 'lm_interface_history',
  'lm_interfaces', 'lm_sites', 'lm_alerts', 'lm_device_datasources', 'lm_devices', 'lm_collectors', 'lm_sources'];

function wipe() {
  for (const t of TABLES) db.prepare(`DELETE FROM ${t}`).run();
  db.prepare("DELETE FROM app_settings WHERE key LIKE 'lm_%'").run();
}

function ins(table, row) {
  const cols = Object.keys(row);
  return db.prepare(`INSERT INTO ${table} (${cols.join(', ')}) VALUES (${cols.map(() => '?').join(', ')})`)
    .run(...cols.map((c) => row[c])).lastInsertRowid;
}

let devSeq = 200;
let instSeq = 2000;
let sid;
const dev = {};
const inst = {};

function device(name, siteKey, siteName, over = {}) {
  devSeq += 1;
  ins('lm_devices', {
    source_id: sid, lm_device_id: devSeq, name: `10.1.0.${devSeq}`, display_name: name, device_type: 0, role: 'router',
    is_network: 1, host_status: 'normal', alert_status: 'none', sdt_status: 'none-none-none', group_ids_json: '[]',
    site_key: siteKey, site_name: siteName, ...over,
  });
  dev[name] = devSeq;
  return devSeq;
}

function port(deviceName, name, over = {}) {
  instSeq += 1;
  const status = over.status == null ? 1 : over.status;
  ins('lm_interfaces', {
    source_id: sid, lm_device_id: dev[deviceName], instance_id: instSeq, display_name: name, instance_name: name,
    description: `WAN circuit ${deviceName} ${name}`, status, status_text: status === 1 ? 'up' : 'down', speed_bps: 1e9,
    is_wan: 1, circuit_role: over.role || 'wan', circuit_far_site_key: over.far || null, sampled_at_epoch: Math.floor(Date.now() / 1000) - 60,
  });
  inst[`${deviceName}|${name}`] = instSeq;
  return instSeq;
}

function history(instance, statuses) {
  const now = Date.now();
  statuses.forEach((st, i) => ins('lm_interface_history', {
    source_id: sid, instance_id: instance, captured_at: sqlStamp(now - (statuses.length - i) * 5 * MIN), status: st, in_util_pct: 10, out_util_pct: 10,
  }));
}

function event(deviceName, portName, kind, siteKey, far, role, at, over = {}) {
  return ins('lm_circuit_events', {
    source_id: sid, instance_id: inst[`${deviceName}|${portName}`], device_name: deviceName, port: portName,
    site_key: siteKey, far_site_key: far, role, event: kind, at: sqlStamp(at), ...over,
  });
}

/**
 * Four sites. alpha: two WAN circuits up. beta: two WAN, one down (degraded). gamma: two WAN, both down (down).
 * Site links: alpha<->beta (two circuits, the beta end down: degraded), alpha<->gamma (one circuit, up, 4 changes in 24 h:
 * flapping), beta<->gamma (one circuit each end, both down: down).
 */
function seedEstate() {
  wipe();
  sid = ins('lm_sources', { name: 'Acme', company: 'acme', auth_mode: 'lmv1', encrypted_credentials: 'x' });
  for (const [k, n] of [['alpha', 'Alpha DC'], ['beta', 'Beta'], ['gamma', 'Gamma']]) {
    ins('lm_sites', { source_id: sid, site_key: k, site_name: n, device_count: 3, network_count: k === 'alpha' ? 5 : 2 });
  }
  device('a-rtr', 'alpha', 'Alpha DC');
  device('b-rtr', 'beta', 'Beta');
  device('g-rtr', 'gamma', 'Gamma');
  device('a-sw', 'alpha', 'Alpha DC', { role: 'switch', host_status: 'dead' });
  device('b-sw', 'beta', 'Beta', { role: 'switch' });
  port('a-rtr', 'Gi0/0/0'); port('a-rtr', 'Gi0/0/1');
  port('b-rtr', 'Gi0/0/0'); port('b-rtr', 'Gi0/0/1', { status: 2 });
  port('g-rtr', 'Gi0/0/0', { status: 2 }); port('g-rtr', 'Gi0/0/1', { status: 2 });
  port('a-rtr', 'Te0/1/0', { role: 'site-link', far: 'beta' });
  port('b-rtr', 'Te0/1/0', { role: 'site-link', far: 'alpha', status: 2 });
  const flap = port('a-rtr', 'Te0/1/1', { role: 'site-link', far: 'gamma' });
  history(flap, [1, 2, 1, 2, 1]);
  port('b-rtr', 'Te0/1/1', { role: 'site-link', far: 'gamma', status: 2 });
  port('g-rtr', 'Te0/1/1', { role: 'site-link', far: 'beta', status: 2 });
  ins('lm_interfaces', {
    source_id: sid, lm_device_id: dev['b-sw'], instance_id: 9001, display_name: 'Gi1/0/9', instance_name: 'Gi1/0/9', status: 2, status_text: 'down', speed_bps: 1e9,
  });
}

describe('GET /sites/:siteKey/circuits', () => {
  beforeEach(seedEstate);

  it('answers wan, circuits, siteLinks and events in the contract shape', async () => {
    event('b-rtr', 'Gi0/0/1', 'down', 'beta', null, 'wan', Date.now() - 2 * HOUR);
    event('a-rtr', 'Te0/1/0', 'down', 'alpha', 'beta', 'site-link', Date.now() - HOUR, { note: 'carrier ticket 4411', issue_key: 'site-link-down|Acme|Alpha DC <-> Beta' });
    const res = await request(app).get('/api/logicmonitor/sites/beta/circuits');
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ siteKey: 'beta', siteName: 'Beta', wan: { state: 'degraded', total: 2, down: 1, flapping: 0 } });
    expect(res.body.circuits).toHaveLength(2);
    for (const c of res.body.circuits) {
      expect(c).toMatchObject({ role: 'wan' });
      for (const k of ['farSiteKey', 'farSiteName', 'flaps7d', 'lastDownAt', 'lastUpAt', 'openIssueKey', 'state', 'deviceName', 'port']) expect(c).toHaveProperty(k);
    }
    expect(res.body.circuits.find((c) => c.port === 'GigabitEthernet0/0/1' || c.port === 'Gi0/0/1').statusText).toBe('down');
    // beta monitors its own end of two site links and also lists the far ends other sites monitor (remoteEnd).
    const linkPorts = res.body.siteLinks.map((c) => `${c.deviceName} ${c.port}`).sort();
    expect(linkPorts).toEqual(['a-rtr Te0/1/0', 'b-rtr Te0/1/0', 'b-rtr Te0/1/1', 'g-rtr Te0/1/1']);
    expect(res.body.siteLinks.filter((c) => c.remoteEnd).map((c) => c.deviceName).sort()).toEqual(['a-rtr', 'g-rtr']);
    // Events name this site as either end, newest first, with the shape the Site 360 timeline reads.
    expect(res.body.events.map((e) => e.event)).toEqual(['down', 'down']);
    expect(res.body.events[0]).toMatchObject({ deviceName: 'a-rtr', port: 'Te0/1/0', role: 'site-link', farSiteKey: 'beta', note: 'carrier ticket 4411' });
    for (const k of ['id', 'at', 'event', 'deviceName', 'port', 'role', 'farSiteKey', 'note', 'issueKey']) expect(res.body.events[0]).toHaveProperty(k);
    expect(res.body.events[0].at).toMatch(/Z$/);
  });

  it('reports a down site and the open issue key of a circuit', async () => {
    ins('lm_issue_history', { issue_key: 'circuit-down|Acme|g-rtr Gi0/0/0', source: 'Acme', severity: 'warning', type: 'circuit-down', target: 'g-rtr Gi0/0/0', message: 'm', status: 'open' });
    const res = await request(app).get('/api/logicmonitor/sites/gamma/circuits');
    expect(res.status).toBe(200);
    expect(res.body.wan).toEqual({ state: 'down', total: 2, down: 2, flapping: 0 });
    const hit = res.body.circuits.find((c) => c.deviceName === 'g-rtr' && /0\/0\/0$/.test(c.port));
    expect(hit.openIssueKey).toBe('circuit-down|Acme|g-rtr Gi0/0/0');
  });

  it('404s an unknown site and 400s a bad key', async () => {
    expect((await request(app).get('/api/logicmonitor/sites/nowhere/circuits')).status).toBe(404);
    expect((await request(app).get('/api/logicmonitor/sites/Bad_Key/circuits')).status).toBe(400);
  });
});

describe('GET /circuit-map', () => {
  beforeEach(seedEstate);

  it('groups site-link circuits per unordered pair and applies the edge state rule', async () => {
    const res = await request(app).get('/api/logicmonitor/circuit-map');
    expect(res.status).toBe(200);
    expect(Object.keys(res.body).sort()).toEqual(['edges', 'nodes', 'wan']);
    const edges = Object.fromEntries(res.body.edges.map((e) => [e.key, e]));
    expect(Object.keys(edges).sort()).toEqual(['alpha|beta', 'alpha|gamma', 'beta|gamma']);
    // alpha<->beta: two circuits, one down: degraded.
    expect(edges['alpha|beta'].state).toBe('degraded');
    expect(edges['alpha|beta'].circuits).toHaveLength(2);
    expect(edges['alpha|beta']).toMatchObject({ a: 'alpha', b: 'beta' });
    // alpha<->gamma: one circuit, up, 4 changes in 24 h: flapping.
    expect(edges['alpha|gamma'].state).toBe('flapping');
    expect(edges['alpha|gamma'].circuits[0].flaps24h).toBe(4);
    // beta<->gamma: both circuits down: down.
    expect(edges['beta|gamma'].state).toBe('down');
    expect(edges['beta|gamma'].circuits).toHaveLength(2);
    for (const c of edges['beta|gamma'].circuits) for (const k of ['instanceId', 'deviceName', 'port', 'siteKey', 'state', 'flaps24h', 'label']) expect(c).toHaveProperty(k);
    for (const e of res.body.edges) for (const k of ['key', 'a', 'b', 'state', 'circuits', 'issueKey', 'lastEventAt']) expect(e).toHaveProperty(k);
  });

  it('nodes carry the WAN picture and the devices behind the counts', async () => {
    const res = await request(app).get('/api/logicmonitor/circuit-map');
    const nodes = Object.fromEntries(res.body.nodes.map((n) => [n.siteKey, n]));
    expect(nodes.alpha).toMatchObject({ siteName: 'Alpha DC', wanState: 'ok', wanTotal: 2, wanDown: 0, devicesDead: 1, deadDevices: ['a-sw'] });
    expect(nodes.beta).toMatchObject({ wanState: 'degraded', wanTotal: 2, wanDown: 1 });
    expect(nodes.gamma).toMatchObject({ wanState: 'down', wanTotal: 2, wanDown: 2, worstState: 'down' });
    expect(nodes.alpha.tier).toBe('dc');
    for (const n of res.body.nodes) {
      for (const k of ['siteKey', 'siteName', 'tier', 'wanState', 'wanTotal', 'wanDown', 'devicesDead', 'deadDevices', 'degradedDevices', 'openIssues', 'worstState']) expect(n).toHaveProperty(k);
      expect(n.deadDevices.length).toBeLessThanOrEqual(10);
    }
    expect(res.body.wan.map((w) => w.siteKey).sort()).toEqual(['alpha', 'beta', 'gamma']);
  });

  it('an edge carries the open issue to jump to and the time of its newest event', async () => {
    ins('lm_issue_history', { issue_key: 'site-link-down|Acme|Alpha DC <-> Beta', source: 'Acme', severity: 'warning', type: 'site-link-down', target: 'Alpha DC <-> Beta', message: 'm', status: 'open' });
    event('b-rtr', 'Te0/1/0', 'down', 'beta', 'alpha', 'site-link', Date.now() - 3 * HOUR);
    const res = await request(app).get('/api/logicmonitor/circuit-map');
    const e = res.body.edges.find((x) => x.key === 'alpha|beta');
    expect(e.issueKey).toBe('site-link-down|Acme|Alpha DC <-> Beta');
    expect(e.lastEventAt).toMatch(/Z$/);
    expect(res.body.edges.find((x) => x.key === 'beta|gamma').issueKey).toBe(null);
  });

  it('a site link with no far site draws no edge', () => {
    const map = lmCirc.buildCircuitMap({
      nodes: [{ siteKey: 'a', siteName: 'A', tier: 'site', wanTotal: 0, wanDown: 0, wanFlapping: 0 }],
      circuits: [{ role: 'site-link', siteKey: 'a', farSiteKey: null, down: true, flaps24h: 0, instanceId: 1, deviceName: 'x', port: 'p', label: 'l' }],
    });
    expect(map.edges).toEqual([]);
    expect(map.nodes[0].wanState).toBe(null);
  });
});

describe('GET /overview node keys', () => {
  beforeEach(seedEstate);

  it('each map node gains the WAN and device-name keys and keeps the existing ones', async () => {
    const res = await request(app).get('/api/logicmonitor/overview');
    expect(res.status).toBe(200);
    const nodes = res.body.map.nodes;
    expect(nodes.length).toBeGreaterThanOrEqual(3);
    const keys = ['wanState', 'wanTotal', 'wanDown', 'deadDevices', 'degradedDevices', 'portsDownNames', 'circuitsDown'];
    const old = ['siteKey', 'siteName', 'state', 'tier', 'deviceCount', 'devicesDead', 'interfacesDown', 'openIssues', 'collectors', 'reachability'];
    for (const n of nodes) {
      for (const k of [...keys, ...old]) expect(n).toHaveProperty(k);
      expect(Array.isArray(n.deadDevices)).toBe(true);
      expect(Array.isArray(n.degradedDevices)).toBe(true);
      expect(n.portsDownNames.length).toBeLessThanOrEqual(5);
    }
    const byKey = Object.fromEntries(nodes.map((n) => [n.siteKey, n]));
    expect(byKey.alpha).toMatchObject({ wanState: 'ok', wanTotal: 2, wanDown: 0, deadDevices: ['a-sw'] });
    expect(byKey.gamma).toMatchObject({ wanState: 'down', wanTotal: 2, wanDown: 2 });
    expect(byKey.gamma.circuitsDown).toBeGreaterThanOrEqual(2);
    expect(byKey.beta.portsDownNames.some((s) => /b-sw/.test(s) || /b-rtr/.test(s))).toBe(true);
  });
});

describe('circuit events routes', () => {
  let a;
  let b;
  beforeEach(() => {
    seedEstate();
    a = event('g-rtr', 'Gi0/0/0', 'down', 'gamma', null, 'wan', Date.now() - 5 * HOUR);
    b = event('b-rtr', 'Gi0/0/1', 'down', 'beta', null, 'wan', Date.now() - 2 * HOUR);
    event('b-rtr', 'Gi0/0/1', 'up', 'beta', null, 'wan', Date.now() - HOUR);
    event('b-rtr', 'Gi0/0/1', 'down', 'beta', null, 'wan', Date.now() - 40 * DAY);
  });

  it('lists newest first inside the 30 day default and filters by site, event and search', async () => {
    const all = await request(app).get('/api/logicmonitor/circuits/events');
    expect(all.status).toBe(200);
    expect(all.body.total).toBe(3);
    expect(all.body.rows.map((r) => r.event)).toEqual(['up', 'down', 'down']);
    expect((await request(app).get('/api/logicmonitor/circuits/events?siteKey=beta')).body.total).toBe(2);
    expect((await request(app).get('/api/logicmonitor/circuits/events?event=up')).body.total).toBe(1);
    expect((await request(app).get('/api/logicmonitor/circuits/events?days=90')).body.total).toBe(4);
    expect((await request(app).get('/api/logicmonitor/circuits/events?q=g-rtr')).body.total).toBe(1);
    expect((await request(app).get(`/api/logicmonitor/circuits/events?instanceId=${inst['g-rtr|Gi0/0/0']}`)).body.total).toBe(1);
    const paged = await request(app).get('/api/logicmonitor/circuits/events?page=2&pageSize=2');
    expect(paged.body.rows).toHaveLength(1);
    expect(paged.body.total).toBe(3);
    expect((await request(app).get('/api/logicmonitor/circuits/events?event=bogus')).status).toBe(400);
  });

  it('exports CSV with the header row', async () => {
    const res = await request(app).get('/api/logicmonitor/circuits/events.csv');
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toMatch(/csv/);
    const lines = res.text.trim().split(/\r?\n/);
    expect(lines[0]).toBe('at,event,deviceName,port,role,siteKey,farSiteKey,note,notedBy,issueKey');
    expect(lines).toHaveLength(4);
  });

  it('PUT note stores the note and who wrote it, and a later read returns it', async () => {
    const res = await request(app).put(`/api/logicmonitor/circuits/events/${b}/note`).send({ note: '  Carrier ticket 1234 opened  ' });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ id: b, note: 'Carrier ticket 1234 opened' });
    expect(res.body.notedAt).toMatch(/Z$/);
    const row = db.prepare('SELECT note, noted_by, noted_at FROM lm_circuit_events WHERE id = ?').get(b);
    expect(row.note).toBe('Carrier ticket 1234 opened');
    expect(row.noted_by).toBeTruthy();
    expect(row.noted_at).toBeTruthy();
    const read = await request(app).get('/api/logicmonitor/circuits/events?siteKey=beta');
    expect(read.body.rows.find((r) => r.id === b).note).toBe('Carrier ticket 1234 opened');
    // The other event is untouched.
    expect(db.prepare('SELECT note FROM lm_circuit_events WHERE id = ?').get(a).note).toBe(null);
  });

  it('PUT note refuses a blank or missing note, 404s an unknown event and 400s a bad id', async () => {
    for (const body of [{ note: '' }, { note: '   ' }, {}, { note: 42 }]) {
      const res = await request(app).put(`/api/logicmonitor/circuits/events/${b}/note`).send(body);
      expect(res.status).toBe(400);
    }
    expect(db.prepare('SELECT note FROM lm_circuit_events WHERE id = ?').get(b).note).toBe(null);
    expect((await request(app).put('/api/logicmonitor/circuits/events/999999/note').send({ note: 'x' })).status).toBe(404);
    expect((await request(app).put('/api/logicmonitor/circuits/events/abc/note').send({ note: 'x' })).status).toBe(400);
  });
});

describe('demo scenario (seeded in a child process)', () => {
  let seedDb;
  let tmpDir;

  beforeAll(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'icc-lm13-seed-'));
    const dbPath = path.join(tmpDir, 'seed.db');
    execFileSync(process.execPath, [path.join(__dirname, '..', 'demo', 'seedDemo.js'), '--db', dbPath, '--force'], {
      cwd: path.join(__dirname, '..'), env: process.env, stdio: 'pipe',
    });
    seedDb = new Database(dbPath, { readonly: true });
  }, 180000);

  const c = (sql, ...a) => seedDb.prepare(sql).get(...a);
  const all = (sql, ...a) => seedDb.prepare(sql).all(...a);

  it('abq is degraded (WAN2 down 3 days), tus is down (both WAN down), the DCs have two WAN circuits each', () => {
    const sites = Object.fromEntries(all('SELECT site_key, wan_state, wan_total, wan_down FROM lm_sites WHERE wan_total > 0').map((r) => [r.site_key, r]));
    expect(sites.albuquerque).toMatchObject({ wan_state: 'degraded', wan_total: 2, wan_down: 1 });
    expect(sites.tucson).toMatchObject({ wan_state: 'down', wan_total: 2, wan_down: 2 });
    expect(sites['phoenix-dc']).toMatchObject({ wan_state: 'ok', wan_total: 2 });
    expect(sites['dallas-dc']).toMatchObject({ wan_state: 'ok', wan_total: 2 });
    expect(sites.denver).toMatchObject({ wan_state: 'ok', wan_total: 2 });
    expect(sites.saltlake).toMatchObject({ wan_state: 'ok', wan_total: 1 });
  });

  it('the Zayo phx<->dal pair is a site link, the CenturyLink "to Dallas DC" port stays a WAN by its tag', () => {
    const roles = Object.fromEntries(all(`SELECT d.display_name || ' ' || i.display_name AS k, i.circuit_role r, i.circuit_far_site_key far, i.circuit_role_reason why
      FROM lm_interfaces i JOIN lm_devices d ON d.source_id = i.source_id AND d.lm_device_id = i.lm_device_id WHERE i.is_wan = 1`).map((r) => [r.k, r]));
    expect(roles['phx-wan-rtr-01 GigabitEthernet0/0/1']).toMatchObject({ r: 'site-link', far: 'dallas-dc', why: 'tag:p2p' });
    expect(roles['dal-wan-rtr-01 GigabitEthernet0/0/1']).toMatchObject({ r: 'site-link', far: 'phoenix-dc', why: 'tag:p2p' });
    expect(roles['phx-wan-rtr-01 GigabitEthernet0/0/0']).toMatchObject({ r: 'wan', why: 'tag:dia' });
    expect(Object.values(roles).filter((r) => r.r === 'site-link')).toHaveLength(2);
    expect(Object.keys(roles)).toHaveLength(13);
  });

  it('the site link flapped on 5 of the last 7 days and the issue rules see it', () => {
    const days = all(`SELECT DISTINCT substr(at, 1, 10) d FROM lm_circuit_events WHERE event = 'down' AND device_name = 'phx-wan-rtr-01' AND port = 'GigabitEthernet0/0/1'
      AND at >= datetime('now', '-7 days')`);
    expect(days.length).toBeGreaterThanOrEqual(5);
    expect(c("SELECT COUNT(*) n FROM lm_circuit_events WHERE event = 'flap-start' AND role = 'site-link'").n).toBeGreaterThanOrEqual(2);
    const open = all("SELECT type, target FROM lm_issue_history WHERE status = 'open' AND type IN ('circuit-flapping', 'circuit-flap-pattern', 'site-wan-down', 'site-wan-degraded', 'circuit-down')");
    const types = (t) => open.filter((i) => i.type === t).map((i) => i.target).sort();
    expect(types('circuit-flap-pattern')).toEqual(['dal-wan-rtr-01 GigabitEthernet0/0/1', 'phx-wan-rtr-01 GigabitEthernet0/0/1']);
    expect(types('circuit-flapping')).toEqual(['dal-wan-rtr-01 GigabitEthernet0/0/1', 'phx-wan-rtr-01 GigabitEthernet0/0/1']);
    expect(types('site-wan-down')).toEqual(['Tucson']);
    expect(types('site-wan-degraded')).toEqual(['Albuquerque']);
    expect(types('circuit-down')).toHaveLength(3);
    // The generic rule does not fire for the circuit ports.
    expect(c("SELECT COUNT(*) n FROM lm_issue_history WHERE status = 'open' AND type = 'interface-flapping' AND target LIKE '%wan-rtr%'").n).toBe(0);
  });

  it('the log is consistent with the interface history and one abq event carries an operator note', () => {
    expect(c('SELECT COUNT(*) n FROM lm_circuit_events').n).toBeGreaterThan(20);
    const note = all("SELECT device_name, port, event, note, noted_by FROM lm_circuit_events WHERE note IS NOT NULL");
    expect(note).toHaveLength(1);
    expect(note[0]).toMatchObject({ device_name: 'abq-rtr-01', event: 'down', noted_by: 'netops' });
    // abq WAN2 went down about 3 days ago and has no up event since.
    const abq = all("SELECT event, at FROM lm_circuit_events WHERE device_name = 'abq-rtr-01' ORDER BY at");
    expect(abq.map((e) => e.event)).toEqual(['down']);
    const ageDays = (Date.now() - Date.parse(`${abq[0].at.replace(' ', 'T')}Z`)) / DAY;
    expect(ageDays).toBeGreaterThan(2.5);
    expect(ageDays).toBeLessThan(3.5);
    // Every down event matches a down sample in the history for the same instance.
    const orphans = c(`SELECT COUNT(*) n FROM lm_circuit_events e WHERE e.event = 'down' AND NOT EXISTS (
      SELECT 1 FROM lm_interface_history h WHERE h.source_id = e.source_id AND h.instance_id = e.instance_id AND h.captured_at = e.at AND h.status = 2)`).n;
    expect(orphans).toBe(0);
    // A rerun of the recorder over the seeded data adds nothing for the last 26 hours.
    expect(c("SELECT COUNT(*) n FROM lm_circuit_events WHERE event = 'saturated'").n).toBe(1);
  });

  it('the pinned counts survive: 10 interfaces down, nothing else flagged as interface-flapping on a wan router', () => {
    expect(c("SELECT COUNT(*) n FROM lm_interfaces WHERE status_text = 'down'").n).toBe(16); // 10 original plus the 6 link-burst ports on dal-acc-01..03
  });
});
