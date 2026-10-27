import { describe, it, expect, beforeEach, afterEach, afterAll, vi } from 'vitest';
import { createRequire } from 'module';
const require = createRequire(import.meta.url);

// The capabilities call the platform API modules through the module object, so
// vi.spyOn on the CJS exports is enough to fake a vendor.
const db = require('../db/database');
const { setSetting } = require('../services/settings');
const caps = require('../services/agentCapabilities');
const tools = require('../services/agentCapabilities/tools');
const { createAnonymizer } = require('../services/anonymizer');
const cohesityApi = require('../services/cohesityApi');
const vcenterApi = require('../services/vcenterApi');
const brocadeApi = require('../services/brocadeApi');
const dellOmeApi = require('../services/dellOmeApi');

const ONSET = '2026-10-27T12:00:00.000Z';
const NOW_ISO = ONSET;

const TABLES = [
  'ops_incident_alerts', 'ops_incidents', 'ops_capability_runs', 'protection_runs', 'cohesity_objects', 'clusters',
  'vcenter_hosts', 'vcenter_vcenters', 'brocade_device_ports', 'brocade_switches', 'brocade_sources',
  'dell_devices', 'dell_ome_instances', 'pure_metrics_history', 'pure_arrays',
];

function insertIncident(key, host, platforms = ['vcenter'], severity = 'critical') {
  const r = db.prepare(`INSERT INTO ops_incidents (incident_key, title, host, platforms, severity, state, opened_at, hold_until, last_event_at)
    VALUES (?, ?, ?, ?, ?, 'collecting', ?, ?, ?)`).run(key, 'test', host, JSON.stringify(platforms), severity, ONSET, ONSET, ONSET);
  return db.prepare('SELECT * FROM ops_incidents WHERE id = ?').get(r.lastInsertRowid);
}
function attach(inc, platform, sourceKey, host, type = null) {
  db.prepare(`INSERT INTO ops_incident_alerts (incident_id, platform, source_key, severity, host, message, type, attached_at, first_seen)
    VALUES (?, ?, ?, 'critical', ?, 'm', ?, ?, ?)`).run(inc.id, platform, sourceKey, host, type, ONSET, ONSET);
}
const alertsOf = (id) => db.prepare('SELECT * FROM ops_incident_alerts WHERE incident_id = ?').all(id);
const capOf = (id) => caps.catalog().find((c) => c.id === id);
const tgt = (o) => ({ kind: 'host', hostKind: 'device', platform: 'x', address: '10.1.1.1', ports: [], portEntries: [], ...o });
const ctxOf = (inc) => ({ incidentId: inc.id, incident: inc, alerts: alertsOf(inc.id) });

beforeEach(() => {
  for (const t of TABLES) db.exec(`DELETE FROM ${t};`);
  setSetting(caps.SETTING_KEY, '');
  delete process.env.DASHBOARD_DEMO;
});
afterEach(() => { vi.restoreAllMocks(); vi.useRealTimers(); });
afterAll(() => { for (const t of TABLES) db.exec(`DELETE FROM ${t};`); setSetting(caps.SETTING_KEY, ''); });

function seedCluster() {
  const id = db.prepare("INSERT INTO clusters (name, connection_type, vip, auth_type, encrypted_credentials) VALUES ('cl1', 'direct', '10.9.9.9', 'apikey', 'x')").run().lastInsertRowid;
  db.prepare("INSERT INTO cohesity_objects (cluster_id, name, protection_groups) VALUES (?, 'srv1', ?)").run(id, JSON.stringify(['PG-A', 'PG-B']));
  db.prepare("INSERT INTO protection_runs (cluster_id, job_id, job_name, status, start_time) VALUES (?, 7, 'PG-A', 'kFailure', ?)").run(id, '2026-10-27T03:00:00.000Z');
  db.prepare("INSERT INTO protection_runs (cluster_id, job_id, job_name, status, start_time) VALUES (?, 8, 'PG-B', 'kSuccess', ?)").run(id, '2026-10-27T03:05:00.000Z');
  return id;
}

describe('cohesity_run_detail', () => {
  it('returns the newest runs of the failing group, newest first, with the error text', async () => {
    const clusterId = seedCluster();
    const t0 = Date.parse('2026-10-27T03:00:00.000Z') * 1000;
    const spy = vi.spyOn(cohesityApi, 'fetchProtectionRuns').mockResolvedValue([
      { backupRun: { status: 'kSuccess', stats: { startTimeUsecs: t0 - 86400e6, endTimeUsecs: t0 - 86400e6 + 600e6 } } },
      { backupRun: { status: 'kFailure', error: 'Quiesce timed out', stats: { startTimeUsecs: t0, endTimeUsecs: t0 + 1200e6 } } },
    ]);
    const inc = insertIncident('k1', 'srv1', ['cohesity']);
    attach(inc, 'cohesity', 'job:1', 'srv1');
    const cap = capOf('cohesity_run_detail');
    const target = tgt({ name: 'srv1', platform: 'cohesity' });
    expect(cap.appliesTo(target, ctxOf(inc))).toBe(true);
    const rec = await caps.runOne(cap, target, ctxOf(inc));
    expect(rec.ok).toBe(true);
    expect(rec.data.lines[0]).toMatch(/^Run 2026-10-27T03:00:00.000Z Failure 20m Quiesce timed out/);
    expect(rec.data.lines[1]).toMatch(/Success/);
    expect(rec.data.group).toBe('PG-A');
    expect(spy).toHaveBeenCalledTimes(1);
    const [clusterArg, num, , , jobId] = spy.mock.calls[0];
    expect(clusterArg.id).toBe(clusterId);
    expect(num).toBe(5);
    expect(jobId).toBe(7);
    expect(caps.listRuns({ incidentId: inc.id })[0]).toMatchObject({ capability: 'cohesity_run_detail', risk: 'platform-api', ok: true });
  });

  it('does not apply to a server no protection group knows', () => {
    seedCluster();
    expect(capOf('cohesity_run_detail').appliesTo(tgt({ name: 'unknown-box' }), {})).toBe(false);
  });
});

describe('vcenter_events_live', () => {
  it('asks for the hour before onset and keeps only the host\'s events', async () => {
    const vc = db.prepare("INSERT INTO vcenter_vcenters (name, host, username, encrypted_credentials) VALUES ('vc-a', 'vc-a.lab', 'u', 'x')").run().lastInsertRowid;
    db.prepare("INSERT INTO vcenter_hosts (vcenter_id, host_id, name) VALUES (?, 'host-1', 'esx01.lab')").run(vc);
    const spy = vi.spyOn(vcenterApi, 'fetchEvents').mockResolvedValue([
      { eventKey: 1, eventType: 'HostConnectionLostEvent', severity: 'error', message: 'lost connection', entityName: 'esx01.lab', createdAt: '2026-10-27T11:40:00Z' },
      { eventKey: 2, eventType: 'VmPoweredOffEvent', severity: 'info', message: 'other host', entityName: 'esx02.lab', createdAt: '2026-10-27T11:41:00Z' },
      { eventKey: 3, eventType: 'EnteredMaintenanceModeEvent', severity: 'info', message: 'maintenance', entityName: 'esx01.lab', createdAt: '2026-10-27T11:50:00Z' },
    ]);
    const inc = insertIncident('v1', 'esx01', ['vcenter']);
    attach(inc, 'vcenter', 'host:1', 'esx01');
    const rec = await caps.runOne(capOf('vcenter_events_live'), tgt({ name: 'esx01', platform: 'vcenter' }), ctxOf(inc));
    expect(rec.ok).toBe(true);
    expect(spy.mock.calls[0][1]).toBe('2026-10-27T11:00:00.000Z');
    expect(rec.data.lines).toHaveLength(2);
    expect(rec.data.lines.join('\n')).not.toMatch(/esx02|other host/);
    expect(rec.data.lines[0]).toMatch(/^2026-10-27T11:50:00Z EnteredMaintenanceModeEvent/);
  });
});

describe('brocade_port_stats', () => {
  it('keeps only the ports the host is logged in on', async () => {
    const src = db.prepare("INSERT INTO brocade_sources (name, host) VALUES ('san1', 'sannav.lab')").run().lastInsertRowid;
    db.prepare("INSERT INTO brocade_switches (source_id, wwn, name, ip_address, virtual_fabric_id) VALUES (?, '10:00:aa', 'sw-a', '10.5.5.5', 128)").run(src);
    db.prepare("INSERT INTO brocade_device_ports (source_id, wwn, fdmi_host_name, switch_wwn, switch_name, slot_number, port_number) VALUES (?, '21:00:01', 'dbhost1', '10:00:aa', 'sw-a', 1, 4)").run(src);
    const spy = vi.spyOn(brocadeApi, 'fetchPortStats').mockResolvedValue([
      { name: '1/4', inFrames: 100, outFrames: 90, crcErrors: 37, invalidWords: 12 },
      { name: '1/5', inFrames: 5, outFrames: 5, crcErrors: 900, invalidWords: 0 },
      { name: '0/1', inFrames: 7, outFrames: 7, crcErrors: 0, invalidWords: 0 },
    ]);
    const inc = insertIncident('b1', 'dbhost1', ['brocade']);
    const rec = await caps.runOne(capOf('brocade_port_stats'), tgt({ name: 'dbhost1', platform: 'brocade' }), ctxOf(inc));
    expect(rec.ok).toBe(true);
    expect(spy).toHaveBeenCalledTimes(1);
    expect(spy.mock.calls[0][1]).toEqual({ switchIp: '10.5.5.5', vfId: 128 });
    expect(rec.data.lines).toEqual(['sw-a 1/4: crc 37, invalid words 12, in frames 100, out frames 90']);
  });
});

describe('dell_hardware_log', () => {
  it('lines carry severity and message and stop at 24 h before onset', async () => {
    const ome = db.prepare("INSERT INTO dell_ome_instances (name, host, username, encrypted_credentials) VALUES ('ome1', 'ome.lab', 'u', 'x')").run().lastInsertRowid;
    db.prepare("INSERT INTO dell_devices (ome_id, device_id, name, service_tag, ip_address) VALUES (?, 42, 'dl380-1', 'ABC1234', '10.7.7.7')").run(ome);
    const spy = vi.spyOn(dellOmeApi, 'fetchHardwareLogs').mockResolvedValue([
      { deviceId: 42, logId: 'a', seq: 3, severity: 'critical', messageId: 'PSU0003', message: 'Power supply 1 failed', createdAt: '2026-10-27T11:30:00.000Z' },
      { deviceId: 42, logId: 'b', seq: 2, severity: 'info', messageId: 'SYS1000', message: 'System boot', createdAt: '2026-10-27T09:00:00.000Z' },
      { deviceId: 42, logId: 'c', seq: 1, severity: 'warning', messageId: 'OLD001', message: 'two days ago', createdAt: '2026-10-25T09:00:00.000Z' },
    ]);
    const inc = insertIncident('d1', 'dl380-1', ['dell']);
    attach(inc, 'dell', 'dev:42', 'dl380-1');
    const rec = await caps.runOne(capOf('dell_hardware_log'), tgt({ name: 'dl380-1', platform: 'dell' }), ctxOf(inc));
    expect(rec.ok).toBe(true);
    expect(spy.mock.calls[0][1]).toBe(42);
    expect(rec.data.lines).toEqual([
      '2026-10-27T11:30:00.000Z critical PSU0003: Power supply 1 failed',
      '2026-10-27T09:00:00.000Z info SYS1000: System boot',
    ]);
    expect(rec.summary).toMatch(/1 above info/);
  });
});

describe('history_slice', () => {
  function seedPure(rows = 200) {
    const id = db.prepare("INSERT INTO pure_arrays (name, mgmt_host, client_id, key_id, username, encrypted_credentials) VALUES ('pure01.lab', '10.8.8.8', 'c', 'k', 'u', 'x')").run().lastInsertRowid;
    const ins = db.prepare('INSERT INTO pure_metrics_history (array_id, captured_at, capacity_bytes, used_bytes, read_latency_us) VALUES (?, ?, 1000, ?, ?)');
    const now = Date.now();
    db.transaction(() => {
      for (let i = 0; i < rows; i += 1) {
        const ts = new Date(now - (rows - i) * 3600000).toISOString().slice(0, 19).replace('T', ' ');
        ins.run(id, ts, 500 + i, 200 + i);
      }
    })();
    return id;
  }

  it('thins 200 rows to 48 points and reports min, avg, max and last', async () => {
    seedPure(200);
    const cap = capOf('history_slice');
    const rec = await caps.runOne(cap, tgt({ name: 'pure01.lab', platform: 'pure' }), { incident: null, alerts: [] }, { metric: 'pure_used_pct', hours: 720 });
    expect(rec.ok).toBe(true);
    expect(rec.data.series).toHaveLength(48);
    expect(rec.data.samples).toBe(200);
    expect(rec.data.min).toBe(50);
    expect(rec.data.max).toBe(69.9);
    expect(rec.data.last).toBe(69.9);
    expect(rec.data.unit).toBe('%');
    expect(rec.data.series[0].t < rec.data.series[47].t).toBe(true);
    expect(rec.summary).toMatch(/^pure_used_pct over 720 h: min 50, avg .*, max 69.9, last 69.9/);
  });

  it('refuses an unknown metric and hours out of range', async () => {
    seedPure(10);
    const cap = capOf('history_slice');
    const target = tgt({ name: 'pure01.lab', platform: 'pure' });
    const ctx = { incident: null, alerts: [] };
    expect((await caps.runOne(cap, target, ctx, { metric: 'not_a_metric' })).ok).toBe(false);
    expect((await caps.runOne(cap, target, ctx, { metric: 'pure_used_pct', hours: 0 })).ok).toBe(false);
    expect((await caps.runOne(cap, target, ctx, { metric: 'pure_used_pct', hours: 721 })).ok).toBe(false);
    // and through the tool surface, where the schema check refuses before any run
    const inc = insertIncident('h1', 'pure01.lab', ['pure']);
    attach(inc, 'pure', 'cap:1', 'pure01.lab');
    const ts = tools.buildToolset(inc, alertsOf(inc.id), createAnonymizer());
    const token = [...ts.targets.keys()][0];
    const call = (a) => ({ id: 'c', function: { name: 'history_slice', arguments: JSON.stringify({ target: token, reason: 'r', ...a }) } });
    expect(ts.tools.find((t) => t.function.name === 'history_slice').function.parameters.properties.metric.enum).toContain('pure_used_pct');
    expect((await tools.runToolCall(call({ metric: 'bogus' }), ts, inc, ctxOf(inc))).refused).toBe(true);
    expect((await tools.runToolCall(call({ metric: 'pure_used_pct', hours: 721 }), ts, inc, ctxOf(inc))).refused).toBe(true);
    expect((await tools.runToolCall(call({ metric: 'pure_used_pct', hours: 2.5 }), ts, inc, ctxOf(inc))).refused).toBe(true);
    const ok = await tools.runToolCall(call({ metric: 'pure_used_pct', hours: 48 }), ts, inc, ctxOf(inc));
    expect(ok.refused).toBeFalsy();
    expect(ok.ok).toBe(true);
    expect(ok.data.series.length).toBeGreaterThan(0);
  });

  it('playbook mode picks the metric from the alert type map and skips when nothing maps', async () => {
    seedPure(30);
    const cap = capOf('history_slice');
    const target = tgt({ name: 'pure01.lab', platform: 'pure' });
    const mapped = insertIncident('h2', 'pure01.lab', ['pure']);
    attach(mapped, 'pure', 'cap:1', 'pure01.lab', 'capacity-high');
    const rec = await caps.runOne(cap, target, ctxOf(mapped));
    expect(rec.ok).toBe(true);
    expect(rec.summary).toMatch(/^pure_used_pct over 24 h/);
    const unmapped = insertIncident('h3', 'pure01.lab', ['pure']);
    attach(unmapped, 'pure', 'x:1', 'pure01.lab', 'some-other-type');
    expect(await caps.runOne(cap, target, ctxOf(unmapped))).toBeNull();
    expect(caps.listRuns({ incidentId: unmapped.id })).toEqual([]);
  });

  it('works in demo mode because it never leaves the box', async () => {
    seedPure(5);
    process.env.DASHBOARD_DEMO = '1';
    const inc = insertIncident('h4', 'pure01.lab', ['pure']);
    attach(inc, 'pure', 'cap:1', 'pure01.lab', 'capacity-high');
    const ts = tools.buildToolset(inc, alertsOf(inc.id), createAnonymizer());
    expect(ts.tools.map((t) => t.function.name)).toContain('history_slice');
    caps.saveEnabled({ ping: true });
    const out = await caps.runPlaybook(inc, alertsOf(inc.id), {});
    // only the DB-only check runs in the demo; ping stays refused
    expect(out.ran).toBe(true);
    expect(out.results.map((r) => r.capability)).toEqual(['history_slice']);
  });
});

describe('timeout', () => {
  it('a platform-api capability stops at its own 8 s, not the 4 s default', async () => {
    seedCluster();
    vi.spyOn(cohesityApi, 'fetchProtectionRuns').mockImplementation(() => new Promise(() => {}));
    vi.useFakeTimers();
    const inc = insertIncident('t1', 'srv1', ['cohesity']);
    const pending = caps.runOne(capOf('cohesity_run_detail'), tgt({ name: 'srv1', platform: 'cohesity' }), ctxOf(inc));
    let settled = false;
    pending.then(() => { settled = true; });
    await vi.advanceTimersByTimeAsync(caps.RUN_TIMEOUT_MS + 500);
    expect(settled).toBe(false);
    await vi.advanceTimersByTimeAsync(4000);
    const rec = await pending;
    expect(rec.ok).toBe(false);
    expect(rec.summary).toMatch(/timed out after 8000 ms/);
  });
});

describe('deep only', () => {
  function seedVcenterIncident() {
    const vc = db.prepare("INSERT INTO vcenter_vcenters (name, host, username, encrypted_credentials) VALUES ('vc-a', 'vc-a.lab', 'u', 'x')").run().lastInsertRowid;
    db.prepare("INSERT INTO vcenter_hosts (vcenter_id, host_id, name) VALUES (?, 'host-1', 'esx01.lab')").run(vc);
    const inc = insertIncident('dp1', 'esx01.lab', ['vcenter']);
    attach(inc, 'vcenter', 'host:1', 'esx01.lab');
    return inc;
  }

  it('is absent from the first-pass toolset and playbook and present with deep: true', async () => {
    caps.saveEnabled({ vcenter_events_live: true });
    vi.spyOn(vcenterApi, 'fetchEvents').mockResolvedValue([]);
    const inc = seedVcenterIncident();
    const names = (ts) => ts.tools.map((t) => t.function.name);
    expect(names(tools.buildToolset(inc, alertsOf(inc.id), createAnonymizer()))).not.toContain('vcenter_events_live');
    const deepSet = tools.buildToolset(inc, alertsOf(inc.id), createAnonymizer(), { deep: true });
    expect(names(deepSet)).toContain('vcenter_events_live');

    const first = await caps.runPlaybook(inc, alertsOf(inc.id), {});
    expect((first.results || []).map((r) => r.capability)).not.toContain('vcenter_events_live');
    const deep = await caps.runPlaybook(inc, alertsOf(inc.id), { deep: true });
    expect(deep.results.map((r) => r.capability)).toContain('vcenter_events_live');
  });

  it('a first-pass toolset refuses a deep-only call even if the model names it', async () => {
    caps.saveEnabled({ vcenter_events_live: true });
    const inc = seedVcenterIncident();
    const shallow = tools.buildToolset(inc, alertsOf(inc.id), createAnonymizer());
    const deepSet = tools.buildToolset(inc, alertsOf(inc.id), createAnonymizer(), { deep: true });
    // graft the deep tool's cap into the shallow set: the runtime check still refuses
    shallow.caps.set('vcenter_events_live', deepSet.caps.get('vcenter_events_live'));
    const r = await tools.runToolCall({ id: 'c', function: { name: 'vcenter_events_live', arguments: JSON.stringify({ target: [...deepSet.targets.keys()][0], reason: 'r' }) } }, shallow, inc, ctxOf(inc));
    expect(r.refused).toBe(true);
    expect(r.summary).toMatch(/deep pass/);
  });

  it('platform-api checks ship off and listCapabilities reports deepOnly and timeoutMs', () => {
    const list = caps.listCapabilities();
    const api = list.filter((c) => c.risk === 'platform-api');
    expect(api.map((c) => c.id).sort()).toEqual(['brocade_port_stats', 'cohesity_run_detail', 'dell_hardware_log', 'pure_perf_now', 'vcenter_events_live', 'zerto_events_live']);
    for (const c of api) {
      expect(c.enabled).toBe(false);
      expect(c.deepOnly).toBe(true);
      expect(c.timeoutMs).toBe(8000);
    }
    const hs = list.find((c) => c.id === 'history_slice');
    expect(hs).toMatchObject({ risk: 'read-only', enabled: true, deepOnly: false, platform: null });
    expect(list.find((c) => c.id === 'ping').timeoutMs).toBe(caps.RUN_TIMEOUT_MS);
  });
});

describe('credential hygiene', () => {
  it('the stored source row is not enumerable, so a JSON dump of a target never carries it', () => {
    const vc = db.prepare("INSERT INTO vcenter_vcenters (name, host, username, encrypted_credentials) VALUES ('vc-a', 'vc-a.lab', 'u', 'SECRETBLOB')").run().lastInsertRowid;
    const inc = insertIncident('c1', null, ['vcenter']);
    attach(inc, 'vcenter', `poll:${vc}`, 'vc-a');
    const [t] = caps.targetsFor(inc, alertsOf(inc.id));
    expect(t.source.platform).toBe('vcenter');
    expect(t.source.row.name).toBe('vc-a');
    expect(JSON.stringify(t)).not.toMatch(/SECRETBLOB/);
  });
});
