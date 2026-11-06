/**
 * LogicMonitor groups as services (round 14): device state rule, group tree
 * rollup, service picks and labels. Runs the logicmonitor migration into the
 * per-file test DB and builds tiny estates by hand.
 */
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
  db.prepare("DELETE FROM app_settings WHERE key LIKE 'lm_%'").run();
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
    expect(stateOf(sid, a.id).state).toBe('failed');
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
    expect(stateOf(sid, a.id)).toMatchObject({ state: 'failed', reasons: ['issue interface-flapping'], openIssues: 1 });
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
    // 10 devices, 1 failed by critical alert = 10% (default line 10) -> failed
    const ids = [];
    for (let i = 0; i < 10; i += 1) ids.push(dev(sid, { group_ids_json: '[12]' }).id);
    alert(sid, ids[0], 'critical');
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
    const ids = [];
    for (let i = 0; i < 4; i += 1) ids.push(dev(sid, { group_ids_json: '[12]' }).id);
    alert(sid, ids[0], 'critical');
    expect(nodeOf(sid, 12).state).toBe('failed'); // 25% >= 10
    setSetting('lm_group_fail_pct', '50');
    expect(nodeOf(sid, 12).state).toBe('degraded');
  });

  it('summary counts groups and distinct devices', () => {
    const sid = cgShape();
    const a = dev(sid, { group_ids_json: '[11,12]' });
    dev(sid, { group_ids_json: '[12]' });
    alert(sid, a.id, 'critical');
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
