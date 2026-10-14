/**
 * LogicMonitor Overview rollup (round 5, option B site map). Seeds a small
 * hand-built estate straight into the tables and drives both the service and
 * GET /api/logicmonitor/overview. Expected numbers are computed from the seed.
 */
import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import { createRequire } from 'module';
import request from 'supertest';

const require = createRequire(import.meta.url);

const express = require('express');
const db = require('../db/database');
const { runMigrations } = require('../core/migrations');
const lmMigrations = require('../db/migrations/logicmonitor');
const { encrypt } = require('../services/encryption');

let app;
let buildOverview;

beforeAll(() => {
  runMigrations(db, 'logicmonitor', lmMigrations);
  const router = require('../routes/logicmonitor');
  const errorHandler = require('../middleware/errorHandler');
  app = express();
  app.use(express.json());
  app.use('/api/logicmonitor', router);
  app.use(errorHandler);
  ({ buildOverview } = require('../services/logicmonitorOverview'));
});

const TABLES = ['lm_blame_history', 'lm_issue_history', 'lm_metrics_history', 'lm_topology_links', 'lm_check_daily',
  'lm_check_baseline', 'lm_check_history', 'lm_check_locations', 'lm_checks', 'lm_sdts', 'lm_collectors', 'lm_alerts',
  'lm_interface_daily', 'lm_interface_baseline', 'lm_interface_history', 'lm_interfaces', 'lm_device_datasources',
  'lm_device_groups', 'lm_devices', 'lm_sites', 'lm_sources'];

function wipe() {
  for (const t of TABLES) db.prepare(`DELETE FROM ${t}`).run();
  db.prepare("DELETE FROM app_settings WHERE key LIKE 'lm_%'").run();
}
function ins(table, row) {
  const cols = Object.keys(row);
  return db.prepare(`INSERT INTO ${table} (${cols.join(', ')}) VALUES (${cols.map(() => '?').join(', ')})`)
    .run(...cols.map((c) => row[c])).lastInsertRowid;
}
const sqlTs = (msAgo) => new Date(Date.now() - msAgo).toISOString().replace('T', ' ').slice(0, 19);
const nowSec = () => Math.floor(Date.now() / 1000);
const MIN = 60 * 1000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;

function seed() {
  const sid = ins('lm_sources', {
    name: 'Acme Ops', company: 'acme', auth_mode: 'lmv1',
    encrypted_credentials: encrypt(JSON.stringify({ accessId: 'AID', accessKey: 'KEY' })),
    features_json: JSON.stringify({}),
  });
  for (const [key, name] of [['phoenix', 'Phoenix DC'], ['denver', 'Denver'], ['austin', 'Austin']]) {
    ins('lm_sites', { source_id: sid, site_key: key, site_name: name });
  }
  ins('lm_collectors', { source_id: sid, collector_id: 1, hostname: 'phx-col01', is_down: 0, in_sdt: 0, site_key: 'phoenix', stale: 0 });
  ins('lm_collectors', { source_id: sid, collector_id: 2, hostname: 'den-col01', is_down: 1, in_sdt: 0, site_key: 'denver', stale: 0 });
  const dev = (o) => ins('lm_devices', {
    source_id: sid, device_type: 0, host_status: 'normal', alert_status: 'none', sdt_status: 'none-none-none', is_network: 1, stale: 0, ...o,
  });
  dev({ lm_device_id: 1, name: '10.1.0.1', display_name: 'phx-sw1', site_key: 'phoenix', collector_id: 1, role: 'switch' });
  dev({ lm_device_id: 2, name: '10.1.0.2', display_name: 'phx-rtr1', site_key: 'phoenix', collector_id: 1, role: 'router' });
  dev({ lm_device_id: 3, name: '10.2.0.1', display_name: 'den-sw1', site_key: 'denver', collector_id: 2, role: 'switch',
    host_status: 'dead', dead_since: sqlTs(2 * HOUR) });
  dev({ lm_device_id: 4, name: '10.3.0.1', display_name: 'aus-sw1', site_key: 'austin', collector_id: 1, role: 'switch', host_status: 'dead-collector' });

  const ifc = (o) => ins('lm_interfaces', { source_id: sid, status: 1, status_text: 'up', speed_bps: 1000000000, stale: 0, ...o });
  ifc({ lm_device_id: 1, instance_id: 11, display_name: 'Gi1/0/1' });
  ifc({ lm_device_id: 1, instance_id: 12, display_name: 'Gi1/0/2', status: 2, status_text: 'down' });
  ifc({ lm_device_id: 3, instance_id: 31, display_name: 'Gi1/0/1', status: 2, status_text: 'down' });
  ifc({ lm_device_id: 2, instance_id: 21, display_name: 'Gi0/0/1', is_wan: 1, wan_reason: 'carrier-description', description: 'WAN circuit to Denver office' });

  const hist = (instance, util, n) => {
    for (let i = 0; i < n; i += 1) {
      ins('lm_interface_history', { source_id: sid, instance_id: instance, captured_at: sqlTs((i + 1) * 10 * MIN), status: 1, in_util_pct: util, out_util_pct: util - 5, in_errors: 0, out_errors: 0 });
    }
  };
  hist(11, 95, 30);
  hist(21, 92, 40);

  // Checks: phoenix -> denver is down, denver -> phoenix is fine.
  ins('lm_checks', { source_id: sid, check_id: 'w:1', kind: 'ping', origin: 'website', name: 'Ping den', target: 'den-sw1', is_internal: 1, site_key: 'denver', stale: 0 });
  ins('lm_check_locations', { source_id: sid, check_id: 'w:1', checkpoint_id: 'c1', label: 'phx-col01', collector_id: 1, site_key: 'phoenix', is_overall: 0, last_status: 'down', last_rtt_ms: null, last_sample_epoch: nowSec(), stale: 0 });
  ins('lm_check_locations', { source_id: sid, check_id: 'w:1', checkpoint_id: 'overall', label: 'Overall', is_overall: 1, last_status: 'down', last_sample_epoch: nowSec(), stale: 0 });
  ins('lm_checks', { source_id: sid, check_id: 'w:2', kind: 'ping', origin: 'website', name: 'Ping phx', target: 'phx-sw1', is_internal: 1, site_key: 'phoenix', stale: 0 });
  ins('lm_check_locations', { source_id: sid, check_id: 'w:2', checkpoint_id: 'c2', label: 'den-col01', collector_id: 2, site_key: 'denver', is_overall: 0, last_status: 'up', last_rtt_ms: 21, last_loss_pct: 0, last_sample_epoch: nowSec(), stale: 0 });
  for (let i = 0; i < 5; i += 1) {
    ins('lm_check_history', { source_id: sid, check_id: 'w:1', checkpoint_id: 'overall', sample_epoch: nowSec() - (5 - i) * 300, status: i < 2 ? 'up' : 'down', rtt_avg_ms: 10 + i, loss_pct: 0 });
  }

  // Alerts: two open critical, one open warning, one critical cleared 2 h ago.
  const alert = (id, sev, over) => ins('lm_alerts', {
    source_id: sid, lm_alert_id: id, severity: sev === 'critical' ? 4 : 3, severity_norm: sev, condition_key: id, cleared: 0,
    start_epoch: nowSec() - 30 * 60, ...over,
  });
  alert('A1', 'critical', {});
  alert('A2', 'critical', {});
  alert('A3', 'warning', {});
  alert('A4', 'critical', { cleared: 1, start_epoch: nowSec() - 5 * 3600, end_epoch: nowSec() - 2 * 3600 });

  // Issue history (drives "since" and the degradation trend).
  const hi = (key, type, target, sev, ago, extra = {}) => ins('lm_issue_history', {
    issue_key: key, source: 'Acme Ops', severity: sev, type, target, message: type, status: 'open', first_seen: sqlTs(ago), ...extra,
  });
  // Inside a severity the NEWEST issue ranks first (what just broke), so the
  // check-down at 1 h sits above the device-dead at 3 h.
  hi('check-down|Acme Ops|Ping den', 'check-down', 'Ping den', 'critical', 1 * HOUR);
  hi('device-dead|Acme Ops|den-sw1', 'device-dead', 'den-sw1', 'critical', 3 * HOUR);
  hi('circuit-saturated|Acme Ops|phx-rtr1 Gi0/0/1', 'circuit-saturated', 'phx-rtr1 Gi0/0/1', 'warning', 2 * HOUR);

  // Interface-down trend source.
  ins('lm_metrics_history', { source_id: sid, captured_at: sqlTs(2 * HOUR), interfaces_down: 3 });
  ins('lm_metrics_history', { source_id: sid, captured_at: sqlTs(30 * MIN), interfaces_down: 2 });
  return sid;
}

describe('buildOverview', () => {
  beforeEach(() => { wipe(); });

  it('returns the full shape with empty arrays and a null score on an empty database', () => {
    const o = buildOverview(db, {});
    expect(Object.keys(o)).toEqual(['generatedAt', 'health', 'counters', 'map', 'burning', 'trends']);
    expect(o.health.score).toBeNull();
    expect(typeof o.health.formula).toBe('string');
    expect(o.counters).toMatchObject({ devicesDead: 0, interfaces: 0, circuits: 0, collectors: 0, openIssues: 0, coverageScore: null });
    expect(o.map).toEqual({ nodes: [], edges: [], circuits: [] });
    expect(o.burning).toEqual([]);
    expect(o.trends.hours).toHaveLength(24);
    expect(o.trends.alertsBySeverity.critical).toEqual(Array(24).fill(0));
    expect(o.trends.degradation.linksDegraded).toEqual(Array(24).fill(0));
    expect(o.trends.degradation.portsDown).toEqual(Array(24).fill(null));
  });

  it('GET /overview answers the same shape on an empty database', async () => {
    const res = await request(app).get('/api/logicmonitor/overview');
    expect(res.status).toBe(200);
    expect(res.body.health.score).toBeNull();
    expect(res.body.map.nodes).toEqual([]);
    expect(res.body.trends.hours).toHaveLength(24);
  });

  it('rolls the seeded estate into counters, health, nodes, edges, circuits, burning and trends', async () => {
    seed();
    const res = await request(app).get('/api/logicmonitor/overview');
    expect(res.status).toBe(200);
    const o = res.body;

    expect(o.counters).toMatchObject({
      devicesDead: 1, devicesDeadCollector: 1, interfacesDown: 2, interfaces: 4, checksDown: 1, checksDegraded: 0, linksDegraded: 1,
      circuits: 1, circuitsSaturated: 1, collectors: 2, collectorsDown: 1, alertsCritical: 2, alertsWarning: 1, alertsInfo: 0, shadowed: 0,
    });
    expect(o.counters.openIssues).toBeGreaterThan(0);
    // 100 - (0.5*2 + 2*1 + 0.5*2 + 1*1 + 3*1) = 100 - 8
    expect(o.health.score).toBe(92);

    const nodes = Object.fromEntries(o.map.nodes.map((n) => [n.siteKey, n]));
    expect(Object.keys(nodes).sort()).toEqual(['austin', 'denver', 'phoenix']);
    expect(nodes.phoenix).toMatchObject({ siteName: 'Phoenix DC', tier: 'dc', sourceId: expect.any(Number), viaCollector: null, deviceCount: 2, circuitsSaturated: 1 });
    expect(nodes.phoenix.collectors).toEqual([{ hostname: 'phx-col01', isDown: false }]);
    expect(nodes.denver).toMatchObject({ state: 'critical', devicesDead: 1, interfacesDown: 1, tier: 'site' });
    expect(nodes.denver.collectors).toEqual([{ hostname: 'den-col01', isDown: true }]);
    expect(nodes.austin).toMatchObject({ devicesDeadCollector: 1, collectors: [], viaCollector: 'phx-col01' });
    expect(nodes.denver.openIssues).toBeGreaterThan(0);

    const edges = Object.fromEntries(o.map.edges.map((e) => [e.key, e]));
    expect(Object.keys(edges).sort()).toEqual(['denver>phoenix', 'phoenix>denver']);
    expect(edges['phoenix>denver']).toMatchObject({ from: 'phoenix', to: 'denver', state: 'down', severity: 'critical' });
    expect(edges['phoenix>denver'].checks).toHaveLength(1);
    expect(edges['phoenix>denver'].checks[0]).toMatchObject({ checkName: 'Ping den', checkpointLabel: 'phx-col01', state: 'down' });
    expect(edges['phoenix>denver'].checks[0].since).toEqual(expect.any(String));
    expect(edges['phoenix>denver'].blame).toMatchObject({ deviceName: 'den-sw1' });
    expect(edges['denver>phoenix']).toMatchObject({ state: 'ok', severity: 'ok', rttAvgMs: 21, blame: null });
    expect(o.map.edges[0].key).toBe('phoenix>denver');

    expect(o.map.circuits).toHaveLength(1);
    expect(o.map.circuits[0]).toMatchObject({ siteKey: 'phoenix', deviceName: 'phx-rtr1', port: 'Gi0/0/1', state: 'warning', farSiteKey: 'denver' });

    expect(o.burning.length).toBeLessThanOrEqual(6);
    const sev = o.burning.map((b) => b.severity);
    expect(sev).toEqual([...sev].sort((a, b) => ({ critical: 0, warning: 1, info: 2 }[a] - { critical: 0, warning: 1, info: 2 }[b])));
    const crit = o.burning.filter((b) => b.severity === 'critical');
    expect(crit[0].type).toBe('check-down');
    expect(crit.map((b) => b.type).slice(0, 2)).toEqual(['check-down', 'device-dead']);
    expect(crit[0]).toMatchObject({ issueKey: 'check-down|Acme Ops|Ping den', siteKey: 'denver', siteName: 'Denver' });
    expect(crit[0].metric.label).toBe('RTT ms');
    expect(crit[0].metric.series).toHaveLength(24);
    expect(crit[0].metric.series.filter((v) => v != null)).toHaveLength(5);
    const dead = o.burning.find((b) => b.type === 'device-dead');
    expect(dead).toMatchObject({ siteKey: 'denver', metric: null });
    expect(new Date(dead.since).getTime()).toBeLessThan(Date.now() - 50 * MIN);
    const util = o.burning.find((b) => b.type === 'interface-utilization-high');
    expect(util.metric.label).toBe('util %');
    expect(util.metric.series).toHaveLength(24);
    expect(util.siteKey).toBe('phoenix');

    const t = o.trends;
    expect(t.hours).toHaveLength(24);
    expect(t.alertsBySeverity.critical).toHaveLength(24);
    expect(t.alertsBySeverity.critical[23]).toBe(2);
    expect(t.alertsBySeverity.warning[23]).toBe(1);
    expect(t.alertsBySeverity.info[23]).toBe(0);
    expect(t.alertsBySeverity.critical[0]).toBe(0);
    expect(t.alertsBySeverity.critical).toContain(1); // the alert cleared 2 h ago counts in the hours it was open
    expect(t.degradation.linksDegraded).toHaveLength(24);
    expect(t.degradation.linksDegraded[23]).toBe(2);
    expect(t.degradation.linksDegraded[0]).toBe(0);
    expect(t.degradation.portsDown).toHaveLength(24);
    expect(t.degradation.portsDown[23]).toBe(2);
    expect(t.degradation.portsDown[0]).toBeNull();
  });

  it('prefers a per-location checkpoint with samples over an Overall row with null RTT', () => {
    const sid = seed();
    db.prepare("DELETE FROM lm_check_history WHERE checkpoint_id = 'overall'").run();
    for (let i = 0; i < 4; i += 1) {
      ins('lm_check_history', { source_id: sid, check_id: 'w:1', checkpoint_id: 'overall', sample_epoch: nowSec() - (4 - i) * 300, status: 'down', rtt_avg_ms: null, loss_pct: 100 });
    }
    for (let i = 0; i < 3; i += 1) {
      ins('lm_check_history', { source_id: sid, check_id: 'w:1', checkpoint_id: 'c1', sample_epoch: nowSec() - (3 - i) * 300, status: 'up', rtt_avg_ms: 200 + i, loss_pct: 0 });
    }
    const o = buildOverview(db, {});
    const b = o.burning.find((x) => x.type === 'check-down');
    expect(b.metric.label).toBe('RTT ms');
    expect(b.metric.series).toHaveLength(24);
    expect(b.metric.series.slice(-3)).toEqual([200, 201, 202]);
    expect(b.metric.series.filter((v) => v != null)).toHaveLength(3);
  });

  it('derives a likely hop from the path model when the message carries none', () => {
    const sid = seed();
    // The phoenix devices are dead, so a check whose collector sits in phoenix is blamed on it.
    db.prepare("UPDATE lm_devices SET host_status = 'dead', dead_since = ? WHERE site_key = 'phoenix'").run(sqlTs(2 * HOUR));
    ins('lm_checks', { source_id: sid, check_id: 'w:9', kind: 'ping', origin: 'website', name: 'Ping ext', target: '8.8.8.8', is_internal: 1, site_key: 'denver', stale: 0 });
    ins('lm_check_locations', { source_id: sid, check_id: 'w:9', checkpoint_id: 'c9', label: 'phx-col01', collector_id: 1, site_key: 'phoenix', is_overall: 0, last_status: 'down', last_sample_epoch: nowSec(), stale: 0 });
    ins('lm_check_locations', { source_id: sid, check_id: 'w:9', checkpoint_id: 'overall9', label: 'Overall', is_overall: 1, last_status: 'down', last_sample_epoch: nowSec(), stale: 0 });
    const o = buildOverview(db, {});
    const ext = o.burning.find((b) => b.type === 'check-down' && b.target === 'Ping ext');
    expect(ext).toBeTruthy();
    expect(ext.message).not.toMatch(/Likely hop:/);
    expect(ext.likelyHop).not.toBeNull();
    expect(ext.likelyHop.deviceName).toEqual(expect.any(String));
    const dead = o.burning.find((b) => b.type === 'device-dead' && b.target === 'den-sw1');
    expect(dead.message).not.toMatch(/Likely hop:/);
    expect(dead.likelyHop).toMatchObject({ deviceName: 'den-sw1' });
    expect(dead.likelyHop.text).toMatch(/den-sw1/);
  });

  it('resolves the site of a location-degraded issue through the collector hostname', () => {
    const sid = seed();
    // Three checks failing from den-col01 at once fold into one location-degraded issue targeted at the label.
    for (const n of [3, 4, 5]) {
      ins('lm_checks', { source_id: sid, check_id: `w:${n}0`, kind: 'ping', origin: 'website', name: `Ping x${n}`, target: '10.9.9.9', is_internal: 1, site_key: 'phoenix', stale: 0 });
      ins('lm_check_locations', { source_id: sid, check_id: `w:${n}0`, checkpoint_id: `d${n}`, label: 'den-col01', collector_id: 2, site_key: 'denver', is_overall: 0, last_status: 'down', last_sample_epoch: nowSec(), stale: 0 });
      ins('lm_check_locations', { source_id: sid, check_id: `w:${n}0`, checkpoint_id: `o${n}`, label: 'Overall', is_overall: 1, last_status: 'up', last_sample_epoch: nowSec(), stale: 0 });
    }
    const o = buildOverview(db, {});
    const row = o.burning.find((b) => b.type === 'location-degraded');
    expect(row).toBeTruthy();
    expect(row.target).toBe('den-col01');
    expect(row.siteKey).toBe('denver');
    expect(row.siteName).toBe('Denver');
  });

  it('adds an inbound reachability series and worst location to every node', () => {
    const sid = seed();
    const cur = Math.floor(Date.now() / HOUR) * HOUR / 1000;
    const row = (epoch, rtt, cp = 'c2') => ins('lm_check_history', { source_id: sid, check_id: 'w:2', checkpoint_id: cp, sample_epoch: epoch, status: 'up', rtt_avg_ms: rtt, loss_pct: 0 });
    row(cur + 1, 10); row(cur + 2, 20); row(cur - 2 * 3600 + 5, 40);
    ins('lm_check_history', { source_id: sid, check_id: 'w:2', checkpoint_id: 'c2x', sample_epoch: cur + 3, status: 'up', rtt_avg_ms: 999, loss_pct: 0 });
    const o = buildOverview(db, {});
    const n = Object.fromEntries(o.map.nodes.map((x) => [x.siteKey, x]));
    expect(n.phoenix.reachability.label).toBe('RTT ms');
    expect(n.phoenix.reachability.series).toHaveLength(24);
    expect(n.phoenix.reachability.series[23]).toBe(15);
    expect(n.phoenix.reachability.series[21]).toBe(40);
    expect(n.phoenix.reachability.series.filter((v) => v != null)).toHaveLength(2);
    expect(n.phoenix.reachability.worst).toMatchObject({ checkName: 'Ping phx', fromLabel: 'den-col01', state: 'ok' });
    // denver has no inbound samples, but den-col01 (its collector) hosts the three Ping phx samples: outbound wins.
    expect(n.denver.reachability.direction).toBe('out');
    expect(n.denver.reachability.series[23]).toBe(15);
    expect(n.denver.reachability.worst).toMatchObject({ checkName: 'Ping phx', fromLabel: 'den-col01', state: 'ok' });
    expect(n.phoenix.reachability.direction).toBe('in');
    expect(n.austin.reachability.series).toEqual(Array(24).fill(null));
    expect(n.austin.reachability.worst).toBeNull();
    expect(n.austin.reachability.direction).toBeNull();
  });

  it('falls back to outbound locations for a site that only hosts a collector', () => {
    const sid = seed();
    // austin hosts collector 3 and no check targets; its location pings the phoenix check.
    ins('lm_collectors', { source_id: sid, collector_id: 3, hostname: 'aus-col01', is_down: 0, in_sdt: 0, site_key: 'austin', stale: 0 });
    ins('lm_check_locations', { source_id: sid, check_id: 'w:2', checkpoint_id: 'c3', label: 'aus-col01', collector_id: 3, is_overall: 0, last_status: 'up', last_rtt_ms: 60, last_loss_pct: 0, last_sample_epoch: nowSec(), stale: 0 });
    const cur = Math.floor(Date.now() / HOUR) * HOUR / 1000;
    ins('lm_check_history', { source_id: sid, check_id: 'w:2', checkpoint_id: 'c3', sample_epoch: cur + 1, status: 'up', rtt_avg_ms: 50, loss_pct: 0 });
    ins('lm_check_history', { source_id: sid, check_id: 'w:2', checkpoint_id: 'c3', sample_epoch: cur + 2, status: 'up', rtt_avg_ms: 70, loss_pct: 0 });
    const o = buildOverview(db, {});
    const a = o.map.nodes.find((x) => x.siteKey === 'austin').reachability;
    expect(a.direction).toBe('out');
    expect(a.series).toHaveLength(24);
    expect(a.series[23]).toBe(60);
    expect(a.series.filter((v) => v != null)).toHaveLength(1);
    expect(a.worst).toMatchObject({ checkName: 'Ping phx', fromLabel: 'aus-col01', state: 'ok' });
  });

  it('reports out when the inbound series is sparse and the outbound one is fuller', () => {
    const sid = seed();
    const cur = Math.floor(Date.now() / HOUR) * HOUR / 1000;
    // phoenix: one inbound point (Ping phx from den-col01), three outbound points (den-col01 is not phoenix, so use phx-col01 on w:1).
    ins('lm_check_history', { source_id: sid, check_id: 'w:2', checkpoint_id: 'c2', sample_epoch: cur + 1, status: 'up', rtt_avg_ms: 30, loss_pct: 0 });
    for (let h = 0; h < 3; h += 1) {
      ins('lm_check_history', { source_id: sid, check_id: 'w:1', checkpoint_id: 'c1', sample_epoch: cur - h * 3600 + 5, status: 'up', rtt_avg_ms: 80 + h, loss_pct: 0 });
    }
    const o = buildOverview(db, {});
    const ph = o.map.nodes.find((x) => x.siteKey === 'phoenix').reachability;
    expect(ph.direction).toBe('out');
    expect(ph.series.filter((v) => v != null)).toHaveLength(3);
    expect(ph.series[23]).toBe(80);
    expect(ph.worst).toMatchObject({ checkName: 'Ping den', fromLabel: 'phx-col01' });
  });

  it('clamps the health score at zero', () => {
    const sid = seed();
    for (let i = 0; i < 250; i += 1) {
      ins('lm_alerts', { source_id: sid, lm_alert_id: `X${i}`, severity: 4, severity_norm: 'critical', condition_key: `X${i}`, cleared: 0, start_epoch: nowSec() - 60 });
    }
    const o = buildOverview(db, {});
    expect(o.counters.alertsCritical).toBe(252);
    expect(o.health.score).toBe(0);
  });
});
