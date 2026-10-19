/**
 * LogicMonitor round 12, package A: Palo Alto / F5 catalog picks, new metric issues
 * (ping loss, NTP, stack, reboot, inaccessible filesystem, alarm flags), the internal
 * checkpoint "<id>_<host>" parse and the polling collectors on /sites, carrier aliases,
 * the Trends service (daily buckets and movers), raw datapoint rules and their routes.
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
const lmApi = require('../services/logicmonitorApi');
const lmIssues = require('../services/logicmonitorIssues');
const lmPath = require('../services/logicmonitorPath');
const lmSites = require('../services/logicmonitorSites');
const lmMetrics = require('../services/logicmonitorMetrics');
const lmTrends = require('../services/logicmonitorTrends');
const rawRules = require('../services/logicmonitorRawRules');
const catalog = require('../services/logicmonitorCatalog');

const API = '/api/logicmonitor';
const TABLES = [
  'lm_issue_history', 'lm_ds_values', 'lm_ds_datapoints', 'lm_ds_metrics_history', 'lm_ds_metrics', 'lm_ds_instances',
  'lm_device_datasources', 'lm_interface_history', 'lm_interfaces', 'lm_check_history', 'lm_check_locations', 'lm_checks',
  'lm_alerts', 'lm_latency_episodes', 'lm_sites', 'lm_collectors', 'lm_devices', 'lm_sources',
];

let app;
let sid;
let hdsSeq;
beforeAll(() => {
  runMigrations(db, 'logicmonitor', lmMigrations);
  const router = require('../routes/logicmonitor');
  const errorHandler = require('../middleware/errorHandler');
  app = express();
  app.use(express.json());
  app.use(API, router);
  app.use(errorHandler);
});
beforeEach(() => {
  for (const t of TABLES) db.prepare(`DELETE FROM ${t}`).run();
  db.prepare("DELETE FROM app_settings WHERE key LIKE 'lm_%'").run();
  sid = db.prepare('INSERT INTO lm_sources (name, company, auth_mode, encrypted_credentials) VALUES (?, ?, ?, ?)')
    .run('Acme', 'acme', 'lmv1', encrypt(JSON.stringify({ accessId: 'a', accessKey: 'b' }))).lastInsertRowid;
  hdsSeq = 1000;
});

function dev(id, name, over = {}) {
  db.prepare(`INSERT INTO lm_devices (source_id, lm_device_id, name, display_name, device_type, host_status, sdt_status, vendor, role, is_network, site_key, collector_id, stale)
    VALUES (?, ?, ?, ?, 0, ?, 'none-none-none', ?, ?, 1, ?, ?, 0)`)
    .run(sid, id, name, name, over.status || 'normal', over.vendor || 'Cisco', over.role || 'switch', over.site || null, over.collector == null ? null : over.collector);
}
function m(devId, ds, family, instance, metric, value, extra = {}) {
  const hds = extra.hds || (db.prepare('SELECT hds_id FROM lm_ds_instances WHERE source_id = ? AND lm_device_id = ? AND datasource_name = ? LIMIT 1').get(sid, devId, ds) || {}).hds_id || (hdsSeq += 1);
  db.prepare(`INSERT OR IGNORE INTO lm_ds_instances (source_id, lm_device_id, hds_id, datasource_name, family, instance_key, instance_name, stale)
    VALUES (?, ?, ?, ?, ?, ?, ?, 0)`).run(sid, devId, hds, ds, family, instance, extra.name || instance);
  db.prepare(`INSERT OR REPLACE INTO lm_ds_metrics (source_id, lm_device_id, hds_id, datasource_name, family, instance_key, metric, datapoint, value, sampled_at_epoch)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(sid, devId, hds, ds, family, instance, metric, metric, value, Math.floor(Date.now() / 1000) - 60);
}
/** A raw store row. */
function rv(devId, ds, instance, datapoint, value, valueText = null) {
  const hds = (db.prepare('SELECT hds_id FROM lm_ds_instances WHERE source_id = ? AND lm_device_id = ? AND datasource_name = ? LIMIT 1').get(sid, devId, ds) || {}).hds_id || (hdsSeq += 1);
  db.prepare(`INSERT OR IGNORE INTO lm_ds_instances (source_id, lm_device_id, hds_id, datasource_name, family, instance_key, instance_name, stale)
    VALUES (?, ?, ?, ?, 'health', ?, ?, 0)`).run(sid, devId, hds, ds, instance, instance);
  db.prepare(`INSERT OR REPLACE INTO lm_ds_values (source_id, lm_device_id, hds_id, datasource_name, instance_key, instance_name, datapoint, value, value_text, sampled_at_epoch, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))`).run(sid, devId, hds, ds, instance, instance, datapoint, value, valueText, Math.floor(Date.now() / 1000));
}
const issuesOf = (type) => lmIssues.computeIssues().filter((i) => i.type === type);

// ---- A1 catalog picks ---------------------------------------------------------------

describe('A1: exact Palo Alto and F5 picks', () => {
  const body = (names, values) => ({ dataPoints: names, instances: { x: { values: [values], time: [1700000000000] } } });

  it('PaloAlto_FW_SystemResources reads the percent datapoints, not cpu_nice or mem_used', () => {
    const names = ['available_mem', 'cpu_hardirq', 'cpu_idle', 'cpu_nice', 'cpu_pct_used', 'mem_buffers', 'mem_free', 'mem_pct_used', 'mem_total', 'mem_used',
      'memory_swap_pct_used', 'swap_free', 'swap_pct_used', 'swap_total'];
    const vals = names.map((n) => ({ cpu_pct_used: 80, mem_pct_used: 54.99, mem_used: 27406630912, mem_total: 49837875200, swap_pct_used: 0, memory_swap_pct_used: 1 }[n] ?? 0));
    const out = lmMetrics.parseDsBody(body(names, vals), catalog.catalogFor('PaloAlto_FW_SystemResources'));
    expect(out.learned).toMatchObject({ mgmt_cpu_pct: 'cpu_pct_used', mem_pct: 'mem_pct_used', swap_pct: 'swap_pct_used', mem_used_bytes: 'mem_used', mem_total_bytes: 'mem_total' });
    expect(out.instances[0].latest.mem_pct.value).toBe(54.99);
    expect(out.instances[0].latest.mgmt_cpu_pct.value).toBe(80);
  });

  it('swap falls back to memory_swap_pct_used when swap_pct_used is absent', () => {
    const out = lmMetrics.parseDsBody(body(['cpu_pct_used', 'memory_swap_pct_used'], [1, 3]), catalog.catalogFor('PaloAlto_FW_SystemResources'));
    expect(out.learned.swap_pct).toBe('memory_swap_pct_used');
  });

  it('temperature, power, F5 memory and interfaces, Ping and NTP read their verified names', () => {
    const t = lmMetrics.parseDsBody(body(['cur_temp', 'max_temp', 'min_temp', 'temp_alarm'], [41, 60, 0, 0]), catalog.catalogFor('PaloAlto_FW_Temperature'));
    expect(t.learned).toMatchObject({ temp_c: 'cur_temp', temp_alarm: 'temp_alarm' });
    const p = lmMetrics.parseDsBody(body(['cur_voltage', 'high_alarm', 'low_alarm', 'max_voltage', 'min_voltage'], [3.3, 0, 0, 3.5, 3]), catalog.catalogFor('PaloAlto_FW_Power'));
    expect(p.learned).toMatchObject({ psu_low_alarm: 'low_alarm', psu_high_alarm: 'high_alarm', cur_voltage: 'cur_voltage' });
    expect(p.learned.psu_state).toBeUndefined();
    const f5 = lmMetrics.parseDsBody(body(['MemBuffer', 'RealMemAvailable', 'RealMemTotal', 'SwapTotal', 'TotalMemFree'], [1, 2, 3, 4, 5]), catalog.catalogFor('F5_BigIP_Memory'));
    expect(f5.learned).toMatchObject({ mem_total_bytes: 'RealMemTotal', mem_avail_bytes: 'RealMemAvailable', mem_free_bytes: 'TotalMemFree' });
    const f5i = lmMetrics.parseDsBody(body(['BytesIn', 'BytesOut', 'ErrorsIn', 'PacketsIn'], [1, 2, 3, 4]), catalog.catalogFor('F5_BigIP_Interfaces'));
    expect(f5i.learned).toMatchObject({ if_in_bytes: 'BytesIn', if_out_bytes: 'BytesOut', if_errors_in: 'ErrorsIn' });
    const ping = lmMetrics.parseDsBody(body(['PingLossPercent', 'average', 'maxrtt', 'minrtt'], [0, 3, 5, 1]), catalog.catalogFor('Ping'));
    expect(ping.learned).toMatchObject({ ping_loss_pct: 'PingLossPercent', ping_rtt_ms: 'average', ping_rtt_max_ms: 'maxrtt' });
    const ntp = lmMetrics.parseDsBody(body(['Offset', 'SelfSynced', 'Stratum', 'synced'], [1, 0, 3, 1]), catalog.catalogFor('Cisco_NTP'));
    expect(ntp.learned).toMatchObject({ ntp_synced: 'synced', ntp_stratum: 'Stratum', ntp_offset_ms: 'Offset' });
    const fs = lmMetrics.parseDsBody(body(['HRUptime', 'StorageNotAccessible', 'StorageUsed'], [1, 0, 3]), catalog.catalogFor('SNMP_Filesystem_Status'));
    expect(fs.learned.fs_not_accessible).toBe('StorageNotAccessible');
    const stack = lmMetrics.parseDsBody(body(['PowerBudget', 'StackState', 'SwitchRole'], [1, 4, 1]), catalog.catalogFor('Cisco Switch Stack-'));
    expect(stack.learned).toMatchObject({ stack_member_state: 'StackState', stack_role: 'SwitchRole' });
  });

  it('CATALOG_VERSION is 5', () => { expect(catalog.CATALOG_VERSION).toBe(6); });

  it('an _alarm metric is a fault at 1 and fine at 0; other states keep their enum', () => {
    expect(lmIssues.stateIsFault(0, 'psu_low_alarm')).toBe(false);
    expect(lmIssues.stateIsFault(1, 'psu_high_alarm')).toBe(true);
    expect(lmIssues.stateIsFault(1, 'psu_state')).toBe(false);
    expect(lmIssues.stateIsFault(2, 'psu_state')).toBe(true);
  });
});

// ---- A1/A5 issues -------------------------------------------------------------------

describe('A1/A5: metric issues', () => {
  it('Palo Alto power alarm raises hardware-fault, a zero never does', () => {
    dev(1, 'fw-a', { vendor: 'Palo Alto', role: 'firewall' });
    m(1, 'PaloAlto_FW_Power', 'firewall', 'PSU 1', 'psu_low_alarm', 1);
    m(1, 'PaloAlto_FW_Power', 'firewall', 'PSU 2', 'psu_low_alarm', 0);
    m(1, 'PaloAlto_FW_Temperature', 'firewall', 'Slot 1', 'temp_alarm', 0);
    const got = issuesOf('hardware-fault');
    expect(got).toHaveLength(1);
    expect(got[0].target).toBe('fw-a PSU 1');
    expect(got[0].message).toContain('is set');
  });

  it('a temperature alarm raises hardware-fault', () => {
    dev(1, 'fw-a', { vendor: 'Palo Alto', role: 'firewall' });
    m(1, 'PaloAlto_FW_Temperature', 'firewall', 'Slot 1', 'temp_alarm', 1);
    expect(issuesOf('hardware-fault')).toHaveLength(1);
  });

  it('an out of range memory percent raises nothing', () => {
    dev(1, 'fw-a', { vendor: 'Palo Alto', role: 'firewall' });
    m(1, 'PaloAlto_FW_SystemResources', 'firewall', 'r', 'mem_pct', 27406630912);
    expect(issuesOf('device-memory-high')).toHaveLength(0);
  });

  it('device-ping-loss: warning at the minimum, critical at the critical line, quiet at zero and on a dead device', () => {
    dev(1, 'sw-a'); m(1, 'Ping', 'health', 'Ping', 'ping_loss_pct', 5); m(1, 'Ping', 'health', 'Ping', 'ping_rtt_ms', 12);
    dev(2, 'sw-b'); m(2, 'Ping', 'health', 'Ping', 'ping_loss_pct', 40);
    dev(3, 'sw-c'); m(3, 'Ping', 'health', 'Ping', 'ping_loss_pct', 0);
    dev(4, 'sw-d', { status: 'dead' }); m(4, 'Ping', 'health', 'Ping', 'ping_loss_pct', 100);
    const got = issuesOf('device-ping-loss');
    expect(got.map((i) => [i.target, i.severity])).toEqual(expect.arrayContaining([['sw-a', 'warning'], ['sw-b', 'critical']]));
    expect(got).toHaveLength(2);
    expect(got.find((i) => i.target === 'sw-a').message).toContain('12 ms');
  });

  it('ntp-unsynced: warning when synced = 0 with the stratum', () => {
    dev(1, 'sw-a'); m(1, 'Cisco_NTP', 'health', 'ntp', 'ntp_synced', 0); m(1, 'Cisco_NTP', 'health', 'ntp', 'ntp_stratum', 16);
    dev(2, 'sw-b'); m(2, 'Cisco_NTP', 'health', 'ntp', 'ntp_synced', 1);
    const got = issuesOf('ntp-unsynced');
    expect(got).toHaveLength(1);
    expect(got[0]).toMatchObject({ target: 'sw-a', severity: 'warning' });
    expect(got[0].message).toContain('stratum 16');
  });

  it('stack-member-degraded: state 4 and 9 are healthy, 5 names sdmMismatch, and no hardware-fault double count', () => {
    dev(1, 'sw-a');
    m(1, 'Cisco Switch Stack-', 'health', '1000', 'stack_member_state', 4);
    m(1, 'Cisco Switch Stack-', 'health', '2000', 'stack_member_state', 5);
    m(1, 'Cisco Switch Stack-', 'health', '3000', 'stack_member_state', 9);
    m(1, 'Cisco Switch Stack-', 'health', '2000', 'stack_role', 2);
    const got = issuesOf('stack-member-degraded');
    expect(got).toHaveLength(1);
    expect(got[0].message).toContain('sdmMismatch');
    expect(got[0].message).toContain('role member');
    expect(issuesOf('hardware-fault')).toHaveLength(0);
  });

  it('device-rebooted: info under 24 h of uptime with "Xh Ym", gone after, skipped when dead', () => {
    dev(1, 'sw-a'); m(1, 'SNMP_Host_Uptime', 'health', 'u', 'uptime_s', 5400);
    dev(2, 'sw-b'); m(2, 'SNMP_Host_Uptime', 'health', 'u', 'uptime_s', 90000);
    dev(3, 'sw-c', { status: 'dead' }); m(3, 'SNMP_Host_Uptime', 'health', 'u', 'uptime_s', 100);
    const got = issuesOf('device-rebooted');
    expect(got).toHaveLength(1);
    expect(got[0]).toMatchObject({ target: 'sw-a', severity: 'info' });
    expect(got[0].message).toContain('1h 30m');
  });

  it('filesystem-inaccessible: warning when StorageNotAccessible = 1', () => {
    dev(1, 'srv-a', { role: 'server' });
    m(1, 'SNMP_Filesystem_Status', 'os', '/data', 'fs_not_accessible', 1);
    m(1, 'SNMP_Filesystem_Status', 'os', '/', 'fs_not_accessible', 0);
    const got = issuesOf('filesystem-inaccessible');
    expect(got).toHaveLength(1);
    expect(got[0].target).toBe('srv-a /data');
  });

  it('threshold keys: 62 including lm_carrier_aliases and lm_raw_rules', () => {
    expect(Object.keys(lmIssues.THRESHOLD_DEFS)).toHaveLength(62);
    expect(lmIssues.THRESHOLD_DEFS.lm_raw_rules).toMatchObject({ type: 'text', def: '[]', maxLength: 20000 });
    expect(lmIssues.THRESHOLD_DEFS.lm_carrier_aliases).toMatchObject({ type: 'text', def: '', maxLength: 2000 });
  });
});

// ---- A2 checkpoints and sites -----------------------------------------------------------

describe('A2: internal checkpoint "<id>_<host>"', () => {
  const site = {
    isInternal: true,
    collectors: [{ id: 48, hostname: 'CGUSER\\W860345', description: 'CGUSER\\W860345' }, { id: 49, hostname: 'CGUSER\\W078598', description: 'CGUSER\\W078598' }],
    checkpoints: [
      { id: 1, geoInfo: '48_CGUSER\\W860345', smgId: 4 },
      { id: 2, geoInfo: '49_CGUSER\\W078598', smgId: 5 },
      { id: 3, geoInfo: 'Overall', smgId: 0 },
    ],
  };

  it('takes the collector id from the prefix and drops it from the label', () => {
    const locs = lmApi.checkpointLocations(site, true);
    expect(locs[0]).toMatchObject({ collectorId: 48, label: 'CGUSER\\W860345', isOverall: 0 });
    expect(locs[1]).toMatchObject({ collectorId: 49, label: 'CGUSER\\W078598' });
    expect(locs[2]).toMatchObject({ isOverall: 1, collectorId: null, label: 'Overall' });
  });

  it('falls back to the prefix number alone when the website lists no collectors, and ignores it for an external check', () => {
    const w = { checkpoints: [{ id: 1, geoInfo: '48_CGUSER\\W860345', smgId: 4 }] };
    expect(lmApi.checkpointLocations(w, true)[0]).toMatchObject({ collectorId: 48, label: 'CGUSER\\W860345' });
    expect(lmApi.checkpointLocations(w, false)[0].collectorId).toBe(null);
  });

  it('leaves other labels alone', () => {
    const w = { isInternal: false, collectors: [], checkpoints: [{ id: 9, geoInfo: 'US - San Francisco', smgId: 2 }] };
    expect(lmApi.checkpointLocations(w, false)[0]).toMatchObject({ label: 'US - San Francisco', collectorId: null });
  });

  it('the sites engine stamps the site on a location carrying collector 48, and /sites lists polling collectors', async () => {
    dev(1, 'phx-sw-01', { collector: 48 });
    dev(2, 'phx-sw-02', { collector: 48 });
    dev(3, 'dal-sw-01', { collector: 49 });
    dev(4, 'aws-vpn', { collector: -9 });
    db.prepare("INSERT INTO lm_collectors (source_id, collector_id, hostname, is_down, stale) VALUES (?, 48, 'CGUSER\\W860345', 0, 0)").run(sid);
    db.prepare("INSERT INTO lm_collectors (source_id, collector_id, hostname, is_down, stale) VALUES (?, 49, 'CGUSER\\W078598', 1, 0)").run(sid);
    db.prepare("INSERT INTO lm_checks (source_id, check_id, kind, origin, name, target, is_internal, stale) VALUES (?, 'w:1', 'web', 'website', 'cgweb', 'cgweb.example.com', 1, 0)").run(sid);
    const l = lmApi.checkpointLocations(site, true);
    for (const x of l) {
      db.prepare('INSERT INTO lm_check_locations (source_id, check_id, checkpoint_id, label, collector_id, is_overall, stale) VALUES (?, ?, ?, ?, ?, ?, 0)')
        .run(sid, 'w:1', x.checkpointId, x.label, x.collectorId, x.isOverall);
    }
    lmSites.computeSites(db, sid);
    const stamped = db.prepare("SELECT checkpoint_id, site_key FROM lm_check_locations WHERE source_id = ? AND check_id = 'w:1' ORDER BY checkpoint_id").all(sid);
    expect(stamped.find((r) => r.checkpoint_id === '1').site_key).toBe('phx');
    expect(stamped.find((r) => r.checkpoint_id === 'overall').site_key).toBe(null);

    const res = await request(app).get(`${API}/sites`);
    expect(res.status).toBe(200);
    const phx = res.body.find((s) => s.siteKey === 'phx');
    expect(phx.pollingCollectors).toEqual([{ id: 48, hostname: 'CGUSER\\W860345', siteKey: 'phx', siteName: 'phx', isDown: false, devices: 2 }]);
    expect(phx.collectors).toHaveLength(1);
    const aws = res.body.find((s) => s.devices === undefined && (s.pollingCollectors || []).some((c) => c.id === -9));
    if (aws) expect(aws.pollingCollectors[0]).toMatchObject({ id: -9, hostname: 'LogicMonitor cloud', siteKey: null, siteName: null, isDown: false });
    const one = await request(app).get(`${API}/sites/phx`);
    expect(one.body.pollingCollectors[0].id).toBe(48);
  });
});

// ---- A3 carriers ---------------------------------------------------------------------

describe('A3: carriers', () => {
  const carrier = (desc, aliases) => lmPath.circuitInfo(desc, null, aliases === undefined ? {} : aliases).carrier;

  it('reads the live descriptions that had no carrier', () => {
    expect(carrier('Google Direct Peering- Order ID 192152287, Ckt ID 20974407 @int')).toBe('Google');
    expect(carrier('CTL/L3 CKT ID: 440530656 @int')).toBe('Lumen');
    expect(carrier('ECX Circuit 557706-LD4-CX-PRI-01 22436196-A @if')).toBe('Equinix');
    expect(carrier('Webex Edge Cloud, circuit WebEx-west-pri-02')).toBe('Cisco Webex');
    expect(carrier('VZB MPLS circuit')).toBe('Verizon');
    expect(carrier('Level 3 internet')).toBe('Lumen');
    expect(carrier('ZYO wave')).toBe('Zayo');
    expect(carrier('plain text')).toBe(null);
  });

  it('parseCarrierAliases: blank, one pair, spaces, bad entries', () => {
    expect(lmPath.parseCarrierAliases('')).toEqual({});
    expect(lmPath.parseCarrierAliases(null)).toEqual({});
    expect(lmPath.parseCarrierAliases('abc=Acme Net')).toEqual({ abc: 'Acme Net' });
    expect(lmPath.parseCarrierAliases('  ABC = Acme Net ,  x2=Other  ')).toEqual({ abc: 'Acme Net', x2: 'Other' });
    expect(lmPath.parseCarrierAliases('novalue=, =nokey, junk, ok=Fine')).toEqual({ ok: 'Fine' });
  });

  it('user aliases win over the built-in table and match whole words only', () => {
    expect(carrier('ACX handoff circuit 1234', { acx: 'Acme Exchange' })).toBe('Acme Exchange');
    expect(carrier('PACXY handoff', { acx: 'Acme Exchange' })).toBe(null);
    expect(carrier('CTL ckt id 9999', { ctl: 'CenturyLink Legacy' })).toBe('CenturyLink Legacy');
  });

  it('the saved setting changes circuitInfo and /circuits; /circuits/unknown-carriers lists the rest', async () => {
    dev(1, 'rtr-a', { role: 'router' });
    db.prepare(`INSERT INTO lm_interfaces (source_id, lm_device_id, instance_id, display_name, description, is_wan, wan_reason, stale)
      VALUES (?, 1, 1, 'Te0/0', 'WAN to ACX circuit 5555', 1, 'override', 0), (?, 1, 2, 'Te0/1', 'WAN mystery link', 1, 'override', 0)`).run(sid, sid);
    let res = await request(app).get(`${API}/circuits`);
    expect(res.body.find((r) => r.instanceId === 1)).toMatchObject({ carrier: null, carrierKnown: false });
    let unk = await request(app).get(`${API}/circuits/unknown-carriers`);
    expect(unk.body.map((r) => r.port).sort()).toEqual(['Te0/0', 'Te0/1']);
    expect(unk.body[0]).toHaveProperty('label');
    db.prepare("INSERT INTO app_settings (key, value) VALUES ('lm_carrier_aliases', 'acx=Acme Exchange')").run();
    res = await request(app).get(`${API}/circuits`);
    expect(res.body.find((r) => r.instanceId === 1)).toMatchObject({ carrier: 'Acme Exchange', carrierKnown: true });
    unk = await request(app).get(`${API}/circuits/unknown-carriers`);
    expect(unk.body.map((r) => r.port)).toEqual(['Te0/1']);
  });
});

// ---- A4 trends -----------------------------------------------------------------------

describe('A4: trends service', () => {
  const NOW = Date.parse('2026-10-19T12:30:00Z');
  const ts = (ms) => new Date(ms).toISOString().slice(0, 19).replace('T', ' ');

  it('daily buckets: hourly for 24h, daily for 7d and 30d, zero filled, severity mapped', () => {
    const k24 = lmTrends.bucketKeys('24h', NOW);
    expect(k24).toHaveLength(24);
    expect(k24[23]).toBe('2026-10-19T12');
    expect(k24[0]).toBe('2026-10-18T13');
    const k7 = lmTrends.bucketKeys('7d', NOW);
    expect(k7).toEqual(['2026-10-13', '2026-10-14', '2026-10-15', '2026-10-16', '2026-10-17', '2026-10-18', '2026-10-19']);
    expect(lmTrends.bucketKeys('30d', NOW)).toHaveLength(30);

    const ins = db.prepare('INSERT INTO lm_alerts (source_id, lm_alert_id, condition_key, severity, severity_norm, start_epoch) VALUES (?, ?, ?, ?, ?, ?)');
    const at = (iso) => Math.floor(Date.parse(iso) / 1000);
    ins.run(sid, 'a1', 'c1', 4, 'critical', at('2026-10-19T03:00:00Z'));
    ins.run(sid, 'a2', 'c2', 3, 'warning', at('2026-10-19T03:10:00Z'));
    ins.run(sid, 'a3', 'c3', 3, 'error', at('2026-10-19T04:10:00Z'));
    ins.run(sid, 'a4', 'c4', 2, 'info', at('2026-10-17T10:00:00Z'));
    ins.run(sid, 'a5', 'c5', 4, 'critical', at('2026-10-01T10:00:00Z')); // outside 7d
    const iss = db.prepare("INSERT INTO lm_issue_history (issue_key, source, severity, type, target, first_seen) VALUES (?, 'Acme', 'warning', ?, ?, ?)");
    iss.run('k1', 'check-down', 't1', '2026-10-19 03:20:00');
    iss.run('k2', 'check-down', 't2', '2026-10-19 03:25:00');
    iss.run('k3', 'device-dead', 't3', '2026-10-17 01:00:00');
    const ep = db.prepare("INSERT INTO lm_latency_episodes (source_id, subject_kind, subject_key, kind, state, outcome, opened_at) VALUES (?, 'check', ?, 'latency', ?, ?, ?)");
    ep.run(sid, 's1', 'closed', 'one-off', '2026-10-19T03:40:00.000Z');
    ep.run(sid, 's2', 'closed', 'escalated', '2026-10-17T03:40:00.000Z');
    ep.run(sid, 's3', 'degrading', null, '2026-10-19T09:00:00.000Z');

    const h = lmTrends.buildDaily(db, '24h', NOW);
    const i3 = h.buckets.indexOf('2026-10-19T03');
    expect(h.alerts.critical[i3]).toBe(1);
    expect(h.alerts.warning[i3]).toBe(1);
    expect(h.alerts.warning[h.buckets.indexOf('2026-10-19T04')]).toBe(1); // error counts as warning
    expect(h.issues.series['check-down'][i3]).toBe(2);
    expect(h.episodes['one-off'][i3]).toBe(1);
    expect(h.episodes.open[h.buckets.indexOf('2026-10-19T09')]).toBe(1);
    expect(h.alerts.critical.reduce((a, b) => a + b, 0)).toBe(1);

    const d = lmTrends.buildDaily(db, '7d', NOW);
    expect(d.alerts.critical.reduce((a, b) => a + b, 0)).toBe(1); // the 10-01 alert is outside
    expect(d.alerts.info[d.buckets.indexOf('2026-10-17')]).toBe(1);
    expect(d.alerts.warning[d.buckets.indexOf('2026-10-19')]).toBe(2);
    expect(d.issues.types[0]).toBe('check-down');
    expect(d.episodes.escalated[d.buckets.indexOf('2026-10-17')]).toBe(1);
    expect(d.buckets.every((k) => d.alerts.critical.length === d.buckets.length && d.episodes.open.length === d.buckets.length && k.length === 10)).toBe(true);
  });

  it('top 6 issue types plus other', () => {
    const iss = db.prepare("INSERT INTO lm_issue_history (issue_key, source, severity, type, target, first_seen) VALUES (?, 'Acme', 'info', ?, 't', '2026-10-19 03:20:00')");
    for (let i = 0; i < 8; i += 1) for (let j = 0; j <= i; j += 1) iss.run(`k${i}-${j}`, `type-${i}`);
    const d = lmTrends.buildDaily(db, '7d', NOW);
    expect(d.issues.types).toHaveLength(7);
    expect(d.issues.types[0]).toBe('type-7');
    expect(d.issues.types[6]).toBe('other');
    expect(d.issues.series.other.reduce((a, b) => a + b, 0)).toBe(1 + 2);
  });

  function iface(inst, name, wan, devId = 1) {
    db.prepare('INSERT INTO lm_interfaces (source_id, lm_device_id, instance_id, display_name, description, is_wan, stale) VALUES (?, ?, ?, ?, ?, ?, 0)').run(sid, devId, inst, name, `${name} desc`, wan);
  }
  function hist(inst, hoursAgo, inU, outU, inE = null) {
    db.prepare('INSERT INTO lm_interface_history (source_id, instance_id, captured_at, in_util_pct, out_util_pct, in_errors, out_errors) VALUES (?, ?, ?, ?, ?, ?, ?)')
      .run(sid, inst, ts(NOW - hoursAgo * 3600000), inU, outU, inE, inE == null ? null : 0);
  }

  it('movers split the range in half, need the minimum samples and apply the delta floors', () => {
    dev(1, 'sw-a');
    iface(1, 'Gi1/0/1', 0); iface(2, 'Gi1/0/2', 0); iface(3, 'Te0/0', 1); iface(4, 'Gi1/0/4', 0);
    for (let i = 0; i < 8; i += 1) {
      hist(1, 150 - i * 3, 10, 5, 0); hist(1, 70 - i * 3, 40, 20, 50 + i); // delta 30 (max of in/out), errors rising
      hist(3, 150 - i * 3, 50, 10); hist(3, 70 - i * 3, 52, 10); // WAN: delta 2, below the floor for interfaces
      hist(4, 150 - i * 3, 10, 10); hist(4, 70 - i * 3, 12, 10); // delta 2
    }
    for (let i = 0; i < 3; i += 1) { hist(2, 150 - i, 5, 5); hist(2, 70 - i, 90, 90); } // only 3 samples a half
    const mv = lmTrends.buildMovers(db, '7d', NOW);
    expect(mv.interfaces).toHaveLength(1);
    expect(mv.interfaces[0]).toMatchObject({ deviceName: 'sw-a', port: 'Gi1/0/1', before: 10, after: 40, delta: 30, isWan: false });
    expect(mv.circuits).toHaveLength(1);
    expect(mv.circuits[0]).toMatchObject({ port: 'Te0/0', before: 50, after: 52, delta: 2, isWan: true });
    expect(mv.errors[0]).toMatchObject({ port: 'Gi1/0/1' });
    expect(mv.errors[0].delta).toBeGreaterThan(0);
    // the same 3-sample interface qualifies on 24h (minimum 3)
    for (let i = 0; i < 3; i += 1) { hist(2, 20 - i, 5, 5); hist(2, 4 - i, 90, 90); }
    const mv24 = lmTrends.buildMovers(db, '24h', NOW);
    expect(mv24.interfaces.map((r) => r.port)).toContain('Gi1/0/2');
  });

  it('movers: slower checks (floors, overall skipped when per-location rows exist), busier devices', () => {
    dev(1, 'sw-a');
    db.prepare("INSERT INTO lm_checks (source_id, check_id, name, stale) VALUES (?, 'w:1', 'cgweb', 0), (?, 'w:2', 'tiny', 0)").run(sid, sid);
    db.prepare("INSERT INTO lm_check_locations (source_id, check_id, checkpoint_id, label, is_overall, stale) VALUES (?, 'w:1', 'cp1', 'Dallas', 0, 0), (?, 'w:1', 'overall', 'Overall', 1, 0), (?, 'w:2', 'cp1', 'Dallas', 0, 0)").run(sid, sid, sid);
    const ch = db.prepare('INSERT INTO lm_check_history (source_id, check_id, checkpoint_id, captured_at, rtt_avg_ms) VALUES (?, ?, ?, ?, ?)');
    for (let i = 0; i < 8; i += 1) {
      ch.run(sid, 'w:1', 'cp1', ts(NOW - (150 - i * 3) * 3600000), 20); ch.run(sid, 'w:1', 'cp1', ts(NOW - (70 - i * 3) * 3600000), 40);
      ch.run(sid, 'w:1', 'overall', ts(NOW - (150 - i * 3) * 3600000), 20); ch.run(sid, 'w:1', 'overall', ts(NOW - (70 - i * 3) * 3600000), 40);
      ch.run(sid, 'w:2', 'cp1', ts(NOW - (150 - i * 3) * 3600000), 100); ch.run(sid, 'w:2', 'cp1', ts(NOW - (70 - i * 3) * 3600000), 104);
    }
    const dh = db.prepare('INSERT INTO lm_ds_metrics_history (source_id, lm_device_id, hds_id, instance_key, metric, value, sampled_at_epoch) VALUES (?, 1, 5, ?, ?, ?, ?)');
    for (let i = 0; i < 8; i += 1) {
      const e1 = Math.floor((NOW - (150 - i * 3) * 3600000) / 1000);
      const e2 = Math.floor((NOW - (70 - i * 3) * 3600000) / 1000);
      dh.run(sid, 'cpu0', 'cpu_pct', 20, e1); dh.run(sid, 'cpu1', 'cpu_pct', 10, e1); dh.run(sid, 'cpu0', 'cpu_pct', 50, e2); dh.run(sid, 'cpu1', 'cpu_pct', 12, e2);
      dh.run(sid, 'm', 'mem_pct', 30, e1); dh.run(sid, 'm', 'mem_pct', 32, e2);
    }
    const mv = lmTrends.buildMovers(db, '7d', NOW);
    expect(mv.checks).toHaveLength(1);
    expect(mv.checks[0]).toMatchObject({ checkName: 'cgweb', label: 'Dallas', beforeMs: 20, afterMs: 40, deltaMs: 20, deltaPct: 100 });
    expect(mv.devices).toHaveLength(1);
    expect(mv.devices[0]).toMatchObject({ deviceName: 'sw-a', metric: 'cpu_pct', before: 20, after: 50, delta: 30 });
  });

  it('GET /trends keeps points and adds range, daily and movers; default range is 7d', async () => {
    const res = await request(app).get(`${API}/trends`);
    expect(res.status).toBe(200);
    expect(res.body.range).toBe('7d');
    expect(res.body.points).toEqual([]);
    expect(res.body.daily.buckets).toHaveLength(7);
    expect(res.body.movers).toMatchObject({ interfaces: [], circuits: [], checks: [], devices: [], errors: [] });
    const r24 = await request(app).get(`${API}/trends?range=24h`);
    expect(r24.body.daily.buckets).toHaveLength(24);
  });
});

// ---- A5 raw rules --------------------------------------------------------------------

describe('A5: raw datapoint rules', () => {
  const rule = (o = {}) => ({ id: 'r1', datasource: 'Cisco_NTP', datapoint: 'Offset', op: '>', value: 100, severity: 'warning', ...o });

  it('parseRules drops bad rows and never throws', () => {
    expect(rawRules.parseRules('not json')).toEqual([]);
    expect(rawRules.parseRules('{}')).toEqual([]);
    const out = rawRules.parseRules(JSON.stringify([rule(), rule({ id: 'r2', op: '=>' }), rule({ id: 'r3', value: 'abc' }), rule({ id: 'r4', instanceMatch: '(' }), 'x', rule({ id: 'r5', severity: 'bogus' })]));
    expect(out.map((r) => r.id)).toEqual(['r1']);
    expect(out[0]).toMatchObject({ enabled: true, label: '', instanceMatch: '', deviceMatch: '' });
  });

  it('evaluate: every operator, regex filters, text values ignored, dedupe, SDT and disabled rules quiet', () => {
    dev(1, 'sw-a'); dev(2, 'sw-b');
    rv(1, 'Cisco_NTP', 'Cisco_NTP', 'Offset', 150); rv(2, 'Cisco_NTP', 'Cisco_NTP', 'Offset', 50);
    rv(1, 'Cisco_NTP', 'Cisco_NTP', 'Mode', null, 'server');
    rv(1, 'Port-', 'Gi1', 'Errors', 7); rv(1, 'Port-', 'Gi2', 'Errors', 1);
    const run = (r) => rawRules.evaluate(db, [r]);
    expect(run(rule())).toHaveLength(1);
    expect(run(rule())[0]).toMatchObject({ type: 'raw-threshold', severity: 'warning', target: 'sw-a', source: 'Acme' });
    expect(run(rule())[0].message).toBe('Cisco_NTP/Offset is 150 (> 100) on sw-a');
    expect(run(rule({ op: '>=', value: 150 }))).toHaveLength(1);
    expect(run(rule({ op: '<', value: 100 }))).toHaveLength(1);
    expect(run(rule({ op: '<=', value: 150 }))).toHaveLength(2);
    expect(run(rule({ op: '==', value: 50 }))[0].target).toBe('sw-b');
    expect(run(rule({ op: '!=', value: 50 }))[0].target).toBe('sw-a');
    expect(run(rule({ deviceMatch: '^sw-b$', op: '>=', value: 0 }))).toHaveLength(1);
    expect(run(rule({ datapoint: 'Mode', op: '!=', value: 0 }))).toHaveLength(0); // text value ignored
    const inst = run({ id: 'r9', datasource: 'Port-', datapoint: 'Errors', op: '>', value: 5, severity: 'critical', label: 'Port errors', instanceMatch: 'Gi1' });
    expect(inst).toHaveLength(1);
    expect(inst[0]).toMatchObject({ severity: 'critical', target: 'sw-a Gi1' });
    expect(inst[0].message).toBe('Port errors is 7 (> 5) on Gi1 of sw-a');
    expect(rawRules.evaluate(db, [rule({ enabled: false })])).toEqual([]);
    // two rules on one target: the higher severity wins, one issue
    expect(rawRules.evaluate(db, [rule(), rule({ id: 'r2', severity: 'critical' })])).toEqual([expect.objectContaining({ severity: 'critical' })]);
    db.prepare("UPDATE lm_devices SET sdt_status = 'none-none-sdt' WHERE lm_device_id = 1").run();
    expect(run(rule())).toHaveLength(0);
  });

  it('computeIssues carries raw-threshold issues from the saved setting', () => {
    dev(1, 'sw-a');
    rv(1, 'Cisco_NTP', 'ntp', 'Offset', 150);
    db.prepare("INSERT INTO app_settings (key, value) VALUES ('lm_raw_rules', ?)").run(JSON.stringify([rule()]));
    expect(issuesOf('raw-threshold')).toHaveLength(1);
    expect(lmIssues.METRIC_ISSUE_TYPES).toContain('raw-threshold');
  });

  it('previewRule counts matches and returns up to 20 sample rows', () => {
    for (let i = 1; i <= 25; i += 1) { dev(i, `sw-${i}`); rv(i, 'Cisco_NTP', 'ntp', 'Offset', 100 + i); }
    const p = rawRules.previewRule(db, rule());
    expect(p.matches).toBe(25);
    expect(p.sample).toHaveLength(20);
    expect(p.sample[0]).toHaveProperty('deviceName');
    expect(p.sample[0]).toHaveProperty('instanceName');
    expect(p.sample[0]).toHaveProperty('value');
    expect(rawRules.previewRule(db, rule({ op: 'bad' })).error).toBeTruthy();
  });

  it('routes: GET, PUT validation (201 rules, bad regex, bad value), save re-evaluates issues, preview', async () => {
    dev(1, 'sw-a');
    rv(1, 'Cisco_NTP', 'ntp', 'Offset', 150);
    let res = await request(app).get(`${API}/raw-rules`);
    expect(res.body).toEqual({ rules: [] });
    const many = Array.from({ length: 201 }, (_, i) => rule({ id: `x${i}` }));
    res = await request(app).put(`${API}/raw-rules`).send({ rules: many });
    expect(res.status).toBe(400);
    res = await request(app).put(`${API}/raw-rules`).send({ rules: [rule({ instanceMatch: '(' })] });
    expect(res.status).toBe(400);
    res = await request(app).put(`${API}/raw-rules`).send({ rules: [rule({ value: 'x' })] });
    expect(res.status).toBe(400);
    res = await request(app).put(`${API}/raw-rules`).send({ rules: 'nope' });
    expect(res.status).toBe(400);
    res = await request(app).put(`${API}/raw-rules`).send({ rules: [rule()] });
    expect(res.status).toBe(200);
    expect(res.body.rules).toHaveLength(1);
    expect(res.body.raw_threshold_issues).toBe(1);
    expect((await request(app).get(`${API}/raw-rules`)).body.rules[0].id).toBe('r1');
    const pv = await request(app).post(`${API}/raw-rules/preview`).send({ rule: rule({ op: '>=', value: 0 }) });
    expect(pv.status).toBe(200);
    expect(pv.body.matches).toBe(1);
    expect((await request(app).post(`${API}/raw-rules/preview`).send({ rule: { datasource: 'x' } })).status).toBe(400);
    const open = db.prepare("SELECT COUNT(*) n FROM lm_issue_history WHERE type = 'raw-threshold' AND status = 'open'").get().n;
    expect(open).toBe(1);
  });

  it('the demo generator seeds two rules and at least one raw-threshold issue', () => {
    dev(1, 'sw-a'); dev(2, 'sw-b');
    m(1, 'Cisco_CPU_SNMP', 'health', 'cpu', 'cpu_pct', 10);
    m(2, 'Port-', 'health', 'Gi1', 'cpu_pct', 11);
    const seeded = require('../demo/generators/logicmonitorRawDemo').seedRawValues(db, { sourceId: sid });
    expect(seeded.rules).toBe(2);
    expect(JSON.parse(db.prepare("SELECT value FROM app_settings WHERE key = 'lm_raw_rules'").get().value)).toHaveLength(2);
    expect(issuesOf('raw-threshold').length).toBeGreaterThanOrEqual(1);
    // reseed-safe: a second run keeps two rules
    require('../demo/generators/logicmonitorRawDemo').seedRawValues(db, { sourceId: sid });
    expect(JSON.parse(db.prepare("SELECT value FROM app_settings WHERE key = 'lm_raw_rules'").get().value)).toHaveLength(2);
  });

  it('GET /settings/discovery raw block carries DataSource-level coverage', async () => {
    db.prepare("INSERT INTO lm_ds_datapoints (source_id, datasource_name, datapoint, devices, instances, numeric, catalog_metric) VALUES (?, 'A', 'x', 1, 1, 1, 'm'), (?, 'A', 'y', 1, 1, 1, NULL), (?, 'B', 'z', 1, 1, 1, NULL)").run(sid, sid, sid);
    const res = await request(app).get(`${API}/settings/discovery`);
    expect(res.status).toBe(200);
    expect(res.body.raw).toMatchObject({ datasourcesTotal: 2, datasourcesCatalogued: 1, datapoints: 3 });
    expect(res.body.raw.coveragePct).toBeCloseTo(33.3, 1);
  });
});
