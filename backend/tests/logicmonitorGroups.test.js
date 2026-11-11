/**
 * LogicMonitor groups as services (round 14): device state rule, group tree
 * rollup, service picks and labels. Runs the logicmonitor migration into the
 * per-file test DB and builds tiny estates by hand.
 */
const adminOf = (d) => d.adminHandle || d; // admin tables are written through the admin connection (db/adminSplit.js)
import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const db = require('../db/database');
const { runMigrations } = require('../core/migrations');
const lmMigrations = require('../db/migrations/logicmonitor');
const { encrypt } = require('../services/encryption');
const { setSetting } = require('../services/settings');
const groups = require('../services/logicmonitorGroups');

beforeAll(() => { runMigrations(db, 'logicmonitor', lmMigrations); });

const TABLES = ['lm_issue_history', 'lm_alerts', 'lm_device_groups', 'lm_devices', 'lm_sources'];
beforeEach(() => {
  for (const t of TABLES) db.prepare(`DELETE FROM ${t}`).run();
  adminOf(db).prepare("DELETE FROM app_settings WHERE key LIKE 'lm_%'").run();
});

function ins(table, row) {
  const cols = Object.keys(row);
  return db.prepare(`INSERT INTO ${table} (${cols.join(', ')}) VALUES (${cols.map(() => '?').join(', ')})`)
    .run(...cols.map((c) => row[c])).lastInsertRowid;
}
const nowSec = () => Math.floor(Date.now() / 1000);
const sqlTs = (msAgo) => new Date(Date.now() - msAgo).toISOString().replace('T', ' ').slice(0, 19);

function source(name = 'Acme') {
  return ins('lm_sources', { name, company: 'acme', auth_mode: 'lmv1', encrypted_credentials: encrypt('{}') });
}
function group(sid, id, parent, name, path, extra = {}) {
  return ins('lm_device_groups', { source_id: sid, lm_group_id: id, parent_id: parent, name, full_path: path, ...extra });
}
let nextDev = 100;
function dev(sid, over = {}) {
  nextDev += 1;
  return {
    id: nextDev,
    row: ins('lm_devices', {
      source_id: sid, lm_device_id: nextDev, name: `10.0.0.${nextDev}`, display_name: `dev${nextDev}`, host_status: 'normal',
      sdt_status: 'none-none-none', group_ids_json: '[]', is_network: 0, ...over,
    }),
  };
}
function alert(sid, devId, sev, over = {}) {
  nextDev += 1;
  return ins('lm_alerts', {
    source_id: sid, lm_alert_id: `A${nextDev}`, type: 'dataSourceAlert', severity: sev === 'critical' ? 4 : sev === 'warning' ? 3 : 2,
    severity_norm: sev, lm_device_id: devId, resource_template_name: 'Cisco_CPU', cleared: 0, condition_key: `k${nextDev}`, ...over,
  });
}
const stateOf = (sid, id) => groups.deviceStates(db).get(`${sid}:${id}`);
const nodeOf = (sid, gid) => groups.buildGroupTree(db).nodes.find((n) => n.id === `${sid}:${gid}`);

describe('device state', () => {
  it('is ok with no signals', () => {
    const sid = source();
    const d = dev(sid);
    expect(stateOf(sid, d.id).state).toBe('ok');
  });

  it('a past-grace dead device is failed, a fresh one is not', () => {
    const sid = source();
    const old = dev(sid, { host_status: 'dead', dead_since: sqlTs(3600 * 1000) });
    const fresh = dev(sid, { host_status: 'dead', dead_since: sqlTs(60 * 1000) });
    expect(stateOf(sid, old.id).state).toBe('failed');
    expect(stateOf(sid, old.id).reasons[0]).toMatch(/^dead since \d\d:\d\d$/);
    expect(stateOf(sid, fresh.id).state).toBe('ok');
  });

  it('dead-collector and SDT degrade', () => {
    const sid = source();
    const a = dev(sid, { host_status: 'dead-collector' });
    const b = dev(sid, { sdt_status: 'none-SDT-none' });
    expect(stateOf(sid, a.id)).toMatchObject({ state: 'degraded', reasons: ['collector down'] });
    expect(stateOf(sid, b.id)).toMatchObject({ state: 'degraded', reasons: ['in SDT'] });
  });

  it('critical beats warning, info never colours, acked still counts', () => {
    const sid = source();
    const a = dev(sid); const b = dev(sid); const c = dev(sid);
    alert(sid, a.id, 'warning'); alert(sid, a.id, 'critical', { acked: 1 });
    alert(sid, b.id, 'info');
    alert(sid, c.id, 'warning');
    // A live device never reads Failed: a critical alert degrades it (Doug, 2026-11-06).
    expect(stateOf(sid, a.id).state).toBe('degraded');
    expect(stateOf(sid, a.id).reasons).toEqual(['critical alert: Cisco_CPU', 'warning alert: Cisco_CPU']);
    expect(stateOf(sid, b.id).state).toBe('ok');
    expect(stateOf(sid, c.id).state).toBe('degraded');
  });

  it('ignores cleared, duplicate and shadowed alerts', () => {
    const sid = source();
    const a = dev(sid);
    alert(sid, a.id, 'critical', { cleared: 1 });
    alert(sid, a.id, 'critical', { duplicate_of: 'x' });
    alert(sid, a.id, 'critical', { shadowed_by: '{"d":1}' });
    expect(stateOf(sid, a.id).state).toBe('ok');
  });

  it('open issues resolve to a device by name or by name prefix', () => {
    const sid = source('Acme');
    const a = dev(sid, { display_name: 'core-sw1' });
    ins('lm_issue_history', { issue_key: 'k1', source: 'Acme', severity: 'critical', type: 'interface-flapping', target: 'core-sw1 Gi1/0/2', message: 'm', status: 'open' });
    ins('lm_issue_history', { issue_key: 'k2', source: 'Acme', severity: 'critical', type: 'x', target: 'core-sw1', message: 'm', status: 'resolved' });
    expect(stateOf(sid, a.id)).toMatchObject({ state: 'degraded', reasons: ['issue interface-flapping'], openIssues: 1 });
  });

  it('flags networkCritical only for dead network devices', () => {
    const sid = source();
    const net = dev(sid, { host_status: 'dead', dead_since: sqlTs(3600 * 1000), is_network: 1 });
    const srv = dev(sid, { host_status: 'dead', dead_since: sqlTs(3600 * 1000), is_network: 0 });
    const alerting = dev(sid, { is_network: 1 }); alert(sid, alerting.id, 'critical');
    expect(stateOf(sid, net.id).networkCritical).toBe(true);
    expect(stateOf(sid, srv.id).networkCritical).toBe(false);
    expect(stateOf(sid, alerting.id).networkCritical).toBe(false);
  });

  it('stale devices are left out', () => {
    const sid = source();
    const d = dev(sid, { stale: 1 });
    expect(stateOf(sid, d.id)).toBeUndefined();
  });
});

describe('group tree', () => {
  // Root row stored (CG export shape): 1 <- 10 (Network) <- 11 (Core), 12 (Edge)
  function cgShape() {
    const sid = source();
    group(sid, 1, 0, 'Devices by Type', null);
    group(sid, 10, 1, 'Network', 'Network');
    group(sid, 11, 10, 'Core', 'Network/Core', { applies_to: 'isSwitch()' });
    group(sid, 12, 10, 'Edge', 'Network/Edge');
    return sid;
  }

  it('works when the root row is stored: root is not emitted, children are depth 0 with parentId null', () => {
    const sid = cgShape();
    const t = groups.buildGroupTree(db);
    expect(t.nodes.map((n) => n.groupId).sort((a, b) => a - b)).toEqual([10, 11, 12]);
    const net = t.nodes.find((n) => n.groupId === 10);
    expect(net).toMatchObject({ id: `${sid}:10`, parentId: null, depth: 0, name: 'Network', fullPath: 'Network', dynamic: false });
    expect(t.nodes.find((n) => n.groupId === 11)).toMatchObject({ parentId: 10, depth: 1, dynamic: true });
  });

  it('works when the root row is missing: parent_id with no row is a root boundary', () => {
    const sid = source();
    group(sid, 18, 1, 'Network', 'Network');
    group(sid, 19, 18, 'Core', 'Network/Core');
    group(sid, 20, 1, 'Servers', 'Servers');
    const t = groups.buildGroupTree(db);
    expect(t.nodes.find((n) => n.groupId === 18)).toMatchObject({ parentId: null, depth: 0 });
    expect(t.nodes.find((n) => n.groupId === 20)).toMatchObject({ parentId: null, depth: 0 });
    expect(t.nodes.find((n) => n.groupId === 19)).toMatchObject({ parentId: 18, depth: 1 });
  });

  it('an empty group is unknown', () => {
    const sid = cgShape();
    expect(nodeOf(sid, 12)).toMatchObject({ state: 'unknown', counts: { total: 0 } });
  });

  it('counts a device once at the parent when it sits in two subgroups, and keeps multi-membership', () => {
    const sid = cgShape();
    const both = dev(sid, { group_ids_json: '[11,12]' });
    const only = dev(sid, { group_ids_json: '[11]' });
    expect(both.id).toBeTruthy(); expect(only.id).toBeTruthy();
    expect(nodeOf(sid, 10).counts.total).toBe(2);
    expect(nodeOf(sid, 11).counts.total).toBe(2);
    expect(nodeOf(sid, 12).counts.total).toBe(1);
    expect(nodeOf(sid, 10).directDevices).toBe(0);
    expect(nodeOf(sid, 11).directDevices).toBe(2);
  });

  it('fail share at the line fails, under the line degrades', () => {
    const sid = cgShape();
    // 10 devices, 1 failed (dead past the grace window) = 10% (default line 10) -> failed
    for (let i = 0; i < 9; i += 1) dev(sid, { group_ids_json: '[12]' });
    dev(sid, { group_ids_json: '[12]', host_status: 'dead', dead_since: sqlTs(3600 * 1000) });
    expect(nodeOf(sid, 12)).toMatchObject({ state: 'failed', counts: { crit: 1, ok: 9, total: 10 } });
    expect(nodeOf(sid, 12).reasons[0]).toBe('1 of 10 failed (10%, red line 10%)');
    // one more healthy device -> 1/11 = 9.1% -> degraded
    dev(sid, { group_ids_json: '[12]' });
    const n = nodeOf(sid, 12);
    expect(n.state).toBe('degraded');
    expect(n.reasons[0]).toMatch(/^1 of 11 failed \(9\.1%, under the red line 10%\)$/);
  });

  it('degraded devices alone give a degraded group', () => {
    const sid = cgShape();
    const a = dev(sid, { group_ids_json: '[12]' }); dev(sid, { group_ids_json: '[12]' });
    alert(sid, a.id, 'warning');
    expect(nodeOf(sid, 12)).toMatchObject({ state: 'degraded', reasons: ['1 degraded'] });
  });

  it('a dead network device fails its groups when the rule is on, not when it is off', () => {
    const sid = cgShape();
    for (let i = 0; i < 20; i += 1) dev(sid, { group_ids_json: '[12]' });
    dev(sid, { group_ids_json: '[12]', host_status: 'dead', dead_since: sqlTs(3600 * 1000), is_network: 1, display_name: 'edge-rt1' });
    // 1/21 = 4.8%, under the line
    let n = nodeOf(sid, 12);
    expect(n.state).toBe('failed');
    expect(n.reasons[0]).toBe('dead network device edge-rt1');
    expect(nodeOf(sid, 10).state).toBe('failed');
    setSetting('lm_group_fail_on_network_dead', '0');
    n = nodeOf(sid, 12);
    expect(n.state).toBe('degraded');
  });

  it('lm_group_fail_pct is honoured', () => {
    const sid = cgShape();
    for (let i = 0; i < 3; i += 1) dev(sid, { group_ids_json: '[12]' });
    dev(sid, { group_ids_json: '[12]', host_status: 'dead', dead_since: sqlTs(3600 * 1000) });
    expect(nodeOf(sid, 12).state).toBe('failed'); // 25% >= 10
    setSetting('lm_group_fail_pct', '50');
    expect(nodeOf(sid, 12).state).toBe('degraded');
  });

  it('summary counts groups and distinct devices', () => {
    const sid = cgShape();
    dev(sid, { group_ids_json: '[11,12]', host_status: 'dead', dead_since: sqlTs(3600 * 1000) });
    dev(sid, { group_ids_json: '[12]' });
    const s = groups.buildGroupTree(db).summary;
    expect(s.groups).toBe(3);
    expect(s.devices).toEqual({ crit: 1, warn: 0, ok: 1, total: 2 });
  });
});

describe('services and labels', () => {
  it('derives labels', () => {
    expect(groups.deriveLabel('office-connectivity')).toBe('Office Connectivity');
    expect(groups.deriveLabel('voice-video-connectivity')).toBe('Voice Video Connectivity');
    expect(groups.deriveLabel('ddi')).toBe('DDI');
    expect(groups.deriveLabel('DDI')).toBe('DDI');
    expect(groups.deriveLabel('ASX1_F5')).toBe('ASX1 F5');
    expect(groups.deriveLabel('Cloud AWS')).toBe('Cloud AWS');
  });

  it('lists picks in order, with a custom label, and marks a vanished group missing', () => {
    const sid = source();
    group(sid, 10, 1, 'office-connectivity', 'office-connectivity');
    group(sid, 11, 1, 'ddi', 'ddi');
    setSetting('lm_service_groups', JSON.stringify([
      { sourceId: sid, groupId: 11 },
      { sourceId: sid, groupId: 10, label: 'Office' },
      { sourceId: sid, groupId: 99 },
    ]));
    const list = groups.services(db);
    expect(list.map((s) => s.serviceId)).toEqual([`${sid}-11`, `${sid}-10`, `${sid}-99`]);
    expect(list[0]).toMatchObject({ label: 'DDI', missing: false, state: 'unknown' });
    expect(list[1].label).toBe('Office');
    expect(list[2]).toMatchObject({ label: 'Group 99', missing: true, state: 'unknown', counts: { crit: 0, warn: 0, ok: 0, total: 0 } });
  });

  it('is empty with no picks', () => {
    expect(groups.services(db)).toEqual([]);
  });
});

describe('composite services (round 15)', () => {
  // Two regions, each with a Firewalls group, plus a Core group; roles on the devices.
  function estate() {
    const sid = source();
    group(sid, 1, 0, 'root', 'root');
    group(sid, 10, 1, 'NA', 'NA');
    group(sid, 11, 10, 'phx_Firewalls', 'NA/phx_Firewalls');
    group(sid, 12, 1, 'EU', 'EU');
    group(sid, 13, 12, 'lon_Firewalls', 'EU/lon_Firewalls');
    group(sid, 14, 13, 'inner', 'EU/lon_Firewalls/inner');
    group(sid, 15, 10, 'Core', 'NA/Core');
    const fw1 = dev(sid, { group_ids_json: '[11]', role: 'firewall', is_network: 1 });
    const fw2 = dev(sid, { group_ids_json: '[14]', role: 'firewall', is_network: 1, host_status: 'dead', dead_since: sqlTs(3600 * 1000) });
    const core = dev(sid, { group_ids_json: '[15]', role: 'router', is_network: 1 });
    const stray = dev(sid, { group_ids_json: '[]', role: 'firewall', is_network: 1 });
    return { sid, fw1, fw2, core, stray };
  }
  const put = (v) => setSetting('lm_service_groups', JSON.stringify(v));

  it('reads a round 14 entry as a one-group service with the <sid>-<gid> id', () => {
    const { sid } = estate();
    put([{ sourceId: sid, groupId: 15, label: 'Core WAN' }, { sourceId: sid, groupId: 11 }]);
    const list = groups.services(db);
    expect(list.map((s) => [s.serviceId, s.label, s.kind])).toEqual([[`${sid}-15`, 'Core WAN', 'group'], [`${sid}-11`, 'Phx Firewalls', 'group']]);
    expect(list[0].members).toEqual([{ kind: 'group', sourceId: sid, groupId: 15, matched: 1, label: 'Core' }]);
    expect(list[0].id).toBe(`${sid}:15`);
  });

  it('a segment glob matches one level, ** crosses levels', () => {
    expect(groups.matchPattern('*/*_Firewalls', 'NA/phx_Firewalls')).toBe(true);
    expect(groups.matchPattern('*/*_firewalls', 'NA/phx_Firewalls')).toBe(true);
    expect(groups.matchPattern('*/*_Firewalls', 'EU/lon_Firewalls/inner')).toBe(false);
    expect(groups.matchPattern('**/inner', 'EU/lon_Firewalls/inner')).toBe(true);
    expect(groups.matchPattern('*/*_Firewalls', 'A/B/phx_Firewalls')).toBe(false);
    expect(groups.matchPattern('NA/Core', 'NA/Core')).toBe(true);
  });

  it('a pattern member rolls up every matched group and its descendants', () => {
    const { sid, fw1, fw2 } = estate();
    put([{ id: 'firewalls', label: 'Firewalls', members: [{ kind: 'pattern', sourceId: null, match: '*/*_Firewalls' }] }]);
    const [svc] = groups.services(db);
    expect(svc).toMatchObject({ serviceId: 'firewalls', kind: 'composite', id: 'svc:firewalls', sourceId: null, groupId: null, state: 'failed' });
    expect(svc.counts).toEqual({ crit: 1, warn: 0, ok: 1, total: 2 });
    expect(svc.members).toEqual([{ kind: 'pattern', sourceId: null, match: '*/*_Firewalls', matched: 2, label: '*/*_Firewalls' }]);
    expect(svc.memberGroups.map((n) => n.fullPath)).toEqual(['EU/lon_Firewalls', 'NA/phx_Firewalls']);
    expect([...svc._keys].sort()).toEqual([`${sid}:${fw1.id}`, `${sid}:${fw2.id}`].sort());
  });

  it('a role member unions with a group member and a device in both counts once', () => {
    const { sid } = estate();
    put([{ id: 'edge', label: 'Edge', members: [
      { kind: 'role', sourceId: null, role: 'firewall' },
      { kind: 'group', sourceId: sid, groupId: 11 },
      { kind: 'pattern', sourceId: sid, match: 'NA/*' },
    ] }]);
    const [svc] = groups.services(db);
    // 3 firewalls by role (stray included); the group member repeats fw1; NA/* is phx_Firewalls and Core, so the router joins.
    expect(svc.counts.total).toBe(4);
    expect(svc.members.map((m) => [m.kind, m.matched])).toEqual([['role', 3], ['group', 1], ['pattern', 2]]);
    expect(svc.memberGroups.map((n) => n.groupId).sort((a, b) => a - b)).toEqual([11, 15]);
    expect(new Set(svc._keys).size).toBe(svc._keys.length);
  });

  it('a role member covers every portal when sourceId is null and one portal when set', () => {
    const { sid } = estate();
    const sid2 = source('Other');
    dev(sid2, { role: 'firewall', is_network: 1 });
    put([{ id: 'fw', label: 'FW', members: [{ kind: 'role', sourceId: null, role: 'firewall' }] }, { id: 'fw1', label: 'FW1', members: [{ kind: 'role', sourceId: sid, role: 'firewall' }] }]);
    const list = groups.services(db);
    expect(list[0].counts.total).toBe(4);
    expect(list[1].counts.total).toBe(3);
  });

  it('a composite with no devices is unknown, not missing', () => {
    estate();
    put([{ id: 'none', label: 'None', members: [{ kind: 'pattern', sourceId: null, match: 'Zzz/*' }] }]);
    expect(groups.services(db)[0]).toMatchObject({ state: 'unknown', missing: false, counts: { total: 0 } });
  });

  it('derives ids from labels, de-duplicates them and keeps the round 14 id', () => {
    const { sid } = estate();
    const r = groups.normalizeEntries([
      { label: 'Core Network', members: [{ kind: 'role', role: 'router' }] },
      { label: 'Core Network', members: [{ kind: 'role', role: 'switch' }] },
      { sourceId: sid, groupId: 15 },
    ]);
    expect(r.entries.map((e) => e.id)).toEqual(['core-network', 'core-network-2', `${sid}-15`]);
    expect(r.entries[0].members).toEqual([{ kind: 'role', sourceId: null, role: 'router' }]);
  });

  it('validates strictly', () => {
    const chk = (v) => groups.checkServiceGroups(JSON.stringify(v));
    const m = { kind: 'role', role: 'firewall' };
    expect(chk([{ label: 'A', members: [m] }])).toBeNull();
    expect(chk([{ label: 'A', members: [{ kind: 'zone' }] }])).toMatch(/kind/);
    expect(chk([{ label: 'A', members: [{ kind: 'pattern', match: 'a<b' }] }])).toMatch(/pattern/);
    expect(chk([{ label: 'A', members: [{ kind: 'pattern', match: '' }] }])).toMatch(/pattern/);
    expect(chk([{ label: 'A', members: [{ kind: 'pattern', match: 'x'.repeat(201) }] }])).toMatch(/pattern/);
    expect(chk([{ label: 'A', members: [{ kind: 'role', role: 'toaster' }] }])).toMatch(/role/);
    expect(chk([{ id: 'a', label: 'A', members: [m] }, { id: 'a', label: 'B', members: [m] }])).toMatch(/used twice/);
    expect(chk([{ id: 'Bad Id', label: 'A', members: [m] }])).toMatch(/id/);
    expect(chk([{ label: 'A', members: Array.from({ length: 33 }, () => m) }])).toMatch(/1 to 32/);
    expect(chk([{ label: 'A', members: [] }])).toMatch(/1 to 32/);
    expect(chk([{ members: [m] }])).toMatch(/label is required/);
    expect(chk([{ label: 'x'.repeat(61), members: [m] }])).toMatch(/label/);
    expect(chk([{ sourceId: 1, groupId: 2 }, { sourceId: 1, groupId: 2 }])).toMatch(/used twice/);
    expect(chk([{ label: 'A', members: [{ kind: 'group', sourceId: 0, groupId: 1 }] }])).toMatch(/sourceId/);
  });

  it('previews counts and a sample for a pattern and for a role', () => {
    estate();
    expect(groups.previewMembers(db, { match: '*/*_Firewalls' })).toEqual({ groups: 2, devices: 2, sample: ['EU/lon_Firewalls', 'NA/phx_Firewalls'] });
    expect(groups.previewMembers(db, { match: 'Nothing/*' })).toEqual({ groups: 0, devices: 0, sample: [] });
    const r = groups.previewMembers(db, { role: 'firewall' });
    expect(r.groups).toBe(0);
    expect(r.devices).toBe(3);
    expect(r.sample).toHaveLength(3);
  });

  it('lists the role vocabulary with device counts', () => {
    estate();
    const roles = groups.roleCounts(db);
    expect(roles.map((r) => r.role)).toEqual(['switch', 'router', 'firewall', 'load-balancer', 'wireless', 'server', 'storage', 'other']);
    expect(roles.find((r) => r.role === 'firewall')).toEqual({ role: 'firewall', label: 'Firewall', devices: 3 });
    expect(roles.find((r) => r.role === 'router').devices).toBe(1);
    expect(roles.find((r) => r.role === 'storage').devices).toBe(0);
  });
});
