/**
 * LogicMonitor routes and advisor (WP6). Runs the logicmonitor migration into
 * the per-file test DB, seeds a small hand-built estate, and drives
 * routes/logicmonitor.js over supertest. The router is mounted directly on a
 * bare express app at /api/logicmonitor (the dispatcher mount is covered by
 * the platform manifest tests); the poller handle and lmApi.testConnection
 * are spied so nothing leaves the machine.
 */
import { describe, it, expect, beforeAll, beforeEach, afterEach, vi } from 'vitest';
import { createRequire } from 'module';
import request from 'supertest';

const require = createRequire(import.meta.url);

const express = require('express');
const db = require('../db/database');
const { runMigrations } = require('../core/migrations');
const lmMigrations = require('../db/migrations/logicmonitor');
const { encrypt, decrypt } = require('../services/encryption');

let app;
let handle;
let api;

beforeAll(() => {
  runMigrations(db, 'logicmonitor', lmMigrations);
  const router = require('../routes/logicmonitor');
  const errorHandler = require('../middleware/errorHandler');
  app = express();
  app.use(express.json());
  app.use('/api/logicmonitor', router);
  app.use(errorHandler);
  handle = require('../services/logicmonitorPoller').logicmonitorPollerHandle;
  api = require('../services/logicmonitorApi');
});

const TABLES = ['lm_ds_metrics_history', 'lm_ds_metrics', 'lm_ds_instances', 'lm_blame_history', 'lm_issue_history', 'lm_metrics_history', 'lm_ai_reports', 'lm_topology_links', 'lm_admins', 'lm_roles',
  'lm_check_daily', 'lm_check_baseline', 'lm_check_history', 'lm_check_locations', 'lm_checks', 'lm_sdts',
  'lm_collectors', 'lm_alerts', 'lm_interface_daily', 'lm_interface_history', 'lm_interfaces',
  'lm_device_datasources', 'lm_device_groups', 'lm_devices', 'lm_sources'];
const THRESHOLD_KEYS = ['lm_if_util_warn_pct', 'lm_if_err_warn', 'lm_if_flap_warn', 'lm_check_baseline_min_samples',
  'lm_check_latency_k', 'lm_check_latency_floor_ms', 'lm_check_latency_min_ms', 'lm_check_loss_min_pct'];

function wipe() {
  for (const t of TABLES) db.prepare(`DELETE FROM ${t}`).run();
  db.prepare(`DELETE FROM app_settings WHERE key LIKE 'lm_%'`).run();
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

function insertSource(over = {}) {
  return ins('lm_sources', {
    name: 'Acme Ops', company: 'acme', auth_mode: 'lmv1',
    encrypted_credentials: encrypt(JSON.stringify({ accessId: 'AID123', accessKey: 'SECRETKEY-xyz' })),
    features_json: JSON.stringify({ collectorMgd: '41.000', ifColumns: ['InUtilizationPercent'], netflow: false }),
    ...over,
  });
}

// Hand-built estate. Expected numbers in the tests are computed from this.
function seedEstate() {
  const sid = insertSource();
  ins('lm_collectors', { source_id: sid, collector_id: 1, hostname: 'phx-col01', build: '41.000', is_down: 1, in_sdt: 0, number_of_hosts: 2 });
  ins('lm_collectors', { source_id: sid, collector_id: 2, hostname: 'den-col01', build: '39.005', is_down: 0, in_sdt: 0, number_of_hosts: 1 });
  ins('lm_device_groups', { source_id: sid, lm_group_id: 10, name: 'Core', full_path: 'Network/Core', num_of_hosts: 2 });
  const dev = (o) => ins('lm_devices', {
    source_id: sid, device_type: 0, alert_status: 'none', sdt_status: 'none-none-none', group_ids_json: '[10]', ...o,
  });
  // d1: Cisco switch, normal, open critical alert unacked in the status string.
  dev({ lm_device_id: 101, name: '10.0.0.1', display_name: 'core-sw1', vendor: 'Cisco', role: 'switch', is_network: 1,
    host_status: 'normal', model: 'C9300', version: '17.9.4a', collector_id: 1, if_count: 4, if_up: 2,
    alert_status: 'unconfirmed-critical-none' });
  // d2: Juniper router, dead.
  dev({ lm_device_id: 102, name: '10.0.0.2', display_name: 'edge-rt1', vendor: 'Juniper', role: 'router', is_network: 1,
    host_status: 'dead', model: 'MX204', version: '21.4R3', collector_id: 2, deleted_time_ms: 1700000000000 });
  // d3: Windows server, dead-collector, in SDT (device slot), alerting disabled.
  dev({ lm_device_id: 103, name: 'srv1', display_name: 'app-srv1', vendor: 'Microsoft', role: 'server', is_network: 0,
    host_status: 'dead-collector', collector_id: 1, sdt_status: 'none-SDT-none', disable_alerting: 1, group_ids_json: '[]' });
  // d4: second C9300, older version.
  dev({ lm_device_id: 104, name: '10.0.0.4', display_name: 'core-sw2', vendor: 'Cisco', role: 'switch', is_network: 1,
    host_status: 'normal', model: 'C9300', version: '17.6.5', collector_id: 1 });
  // d5: stale row, excluded everywhere.
  dev({ lm_device_id: 105, name: 'gone', display_name: 'old-sw', vendor: 'Cisco', role: 'switch', is_network: 1,
    host_status: 'normal', stale: 1 });
  ins('lm_device_datasources', { source_id: sid, lm_device_id: 101, hds_id: 9001, datasource_name: 'SNMP_Network_Interfaces', is_interface: 1 });

  const iface = (o) => ins('lm_interfaces', { source_id: sid, lm_device_id: 101, speed_bps: 1000000000, sampled_at_epoch: nowSec() - 60, ...o });
  iface({ instance_id: 1, display_name: 'Gi1/0/1', description: 'to edge-rt1 xe-0/0/0', status: 1, status_text: 'up', in_util_pct: 90, out_util_pct: 10 });
  iface({ instance_id: 2, display_name: 'Gi1/0/2', status: 2, status_text: 'down', in_util_pct: 0, out_util_pct: 0 });
  iface({ instance_id: 3, display_name: 'Gi1/0/3', status: 2, status_text: 'down', stop_monitoring: 1 });
  iface({ instance_id: 4, display_name: 'Gi1/0/4', status: 1, status_text: null, in_util_pct: 0.2, out_util_pct: 0.1, speed_bps: 100000000 });

  // History: if 1 flaps 1,2,1,2 (3 changes) with no errors; if 2 has 60+50
  // errors in 24 h (110 > 100); one if 2 row from 2 days ago is outside 24 h.
  const hist = (o) => ins('lm_interface_history', { source_id: sid, ...o });
  [1, 2, 1, 2].forEach((st, k) => hist({ instance_id: 1, captured_at: sqlTs((40 - k * 10) * MIN), status: st, in_errors: 0, out_errors: 0, in_util_pct: 50 }));
  hist({ instance_id: 2, captured_at: sqlTs(30 * MIN), status: 2, in_errors: 60, out_errors: 0 });
  hist({ instance_id: 2, captured_at: sqlTs(20 * MIN), status: 2, in_errors: 0, out_errors: 50 });
  hist({ instance_id: 2, captured_at: sqlTs(2 * DAY), status: 2, in_errors: 5000, out_errors: 0 });
  // Daily: if 4 unused (max util < 1) for 30 consecutive days.
  for (let d = 1; d <= 30; d += 1) {
    ins('lm_interface_daily', { source_id: sid, instance_id: 4, day: new Date(Date.now() - d * DAY).toISOString().slice(0, 10), max_in_util_pct: 0.5, max_out_util_pct: 0.2, flaps: 0 });
  }

  const alert = (o) => ins('lm_alerts', {
    source_id: sid, type: 'dataSourceAlert', monitor_object_type: 'device', rule: 'Default', cleared: 0, acked: 0, sdted: 0, ...o,
  });
  alert({ lm_alert_id: 'DS1', severity: 4, severity_norm: 'critical', lm_device_id: 101, monitor_object_name: 'core-sw1',
    resource_template_name: 'SNMP_Network_Interfaces', instance_name: 'Gi1/0/2', data_point_name: 'Status',
    start_epoch: nowSec() - 8 * 86400, acked: 1, condition_key: 'lm:1:core-sw1:SNMP_Network_Interfaces:Gi1/0/2:Status' });
  alert({ lm_alert_id: 'DS2', severity: 3, severity_norm: 'warning', lm_device_id: 101, monitor_object_name: 'core-sw1',
    resource_template_name: 'Cisco_CPU_SNMP', instance_name: 'CPU', data_point_name: 'CPUBusyPercent',
    start_epoch: nowSec() - 3600, rule: '', condition_key: 'lm:1:core-sw1:Cisco_CPU_SNMP:CPU:CPUBusyPercent' });
  alert({ lm_alert_id: 'DS3', severity: 3, severity_norm: 'warning', lm_device_id: 103, monitor_object_name: 'app-srv1',
    resource_template_name: 'WinCPU', start_epoch: nowSec() - 1800, sdted: 1, condition_key: 'lm:1:app-srv1:WinCPU::' });
  alert({ lm_alert_id: 'DS4', severity: 2, severity_norm: 'info', lm_device_id: 104, monitor_object_name: 'core-sw2',
    resource_template_name: 'Cisco_CPU_SNMP', start_epoch: nowSec() - 600, condition_key: 'lm:1:core-sw2:Cisco_CPU_SNMP::' });
  // Two cleared re-fires of the CPU condition: 3 rows on that key in 30 d.
  alert({ lm_alert_id: 'DS5', severity: 4, severity_norm: 'critical', lm_device_id: 101, monitor_object_name: 'core-sw1',
    resource_template_name: 'Cisco_CPU_SNMP', instance_name: 'CPU', data_point_name: 'CPUBusyPercent', cleared: 1,
    start_epoch: nowSec() - 5 * 86400, end_epoch: nowSec() - 5 * 86400 + 600, condition_key: 'lm:1:core-sw1:Cisco_CPU_SNMP:CPU:CPUBusyPercent' });
  alert({ lm_alert_id: 'DS6', severity: 3, severity_norm: 'warning', lm_device_id: 101, monitor_object_name: 'core-sw1',
    resource_template_name: 'Cisco_CPU_SNMP', instance_name: 'CPU', data_point_name: 'CPUBusyPercent', cleared: 1,
    start_epoch: nowSec() - 4 * 86400, end_epoch: nowSec() - 4 * 86400 + 600, condition_key: 'lm:1:core-sw1:Cisco_CPU_SNMP:CPU:CPUBusyPercent' });

  ins('lm_sdts', { source_id: sid, sdt_id: 'D_1', sdt_type: 'DeviceSDT', schedule_type: 'oneTime', is_effective: 1,
    start_ms: Date.now() - HOUR, end_ms: Date.now() + HOUR, admin: 'ops', lm_device_id: 103, device_display_name: 'app-srv1' });

  // Checks. w:1 overall up, PHX down, DEN latency 90 ms over a 30 +/- 2 ms
  // baseline (threshold 30 + 3 * max(2, 5) = 45, and 90 > 20). w:2 overall down.
  const check = (o) => ins('lm_checks', { source_id: sid, kind: 'ping', origin: 'website', ...o });
  const loc = (o) => ins('lm_check_locations', { source_id: sid, last_sample_epoch: nowSec() - 120, ...o });
  check({ check_id: 'w:1', name: 'dc1-ping', target: '10.1.1.1' });
  loc({ check_id: 'w:1', checkpoint_id: 'overall', label: 'Overall', is_overall: 1, last_status: 'up', last_rtt_ms: 60, last_loss_pct: 0 });
  loc({ check_id: 'w:1', checkpoint_id: 'cp1', label: 'PHX', is_overall: 0, last_status: 'down', last_rtt_ms: null, last_loss_pct: 100 });
  loc({ check_id: 'w:1', checkpoint_id: 'cp2', label: 'DEN', is_overall: 0, last_status: 'up', last_rtt_ms: 90, last_loss_pct: 0 });
  for (let h = 0; h < 24; h += 1) {
    ins('lm_check_baseline', { source_id: sid, check_id: 'w:1', checkpoint_id: 'cp2', hour_of_day: h, samples: 30, rtt_median: 30, rtt_mad: 2, loss_median: 0, loss_mad: 0 });
  }
  for (let k = 0; k < 3; k += 1) {
    ins('lm_check_history', { source_id: sid, check_id: 'w:1', checkpoint_id: 'cp2', sample_epoch: nowSec() - (3 - k) * 300, status: 'up', rtt_avg_ms: 90, loss_pct: 0 });
  }
  check({ check_id: 'w:2', name: 'dc2-web', kind: 'web', target: 'portal.example.com' });
  loc({ check_id: 'w:2', checkpoint_id: 'overall', label: 'Overall', is_overall: 1, last_status: 'down' });
  loc({ check_id: 'w:2', checkpoint_id: 'cp1', label: 'PHX', is_overall: 0, last_status: 'down' });
  check({ check_id: 'u:5', name: 'branch-ping', origin: 'uptime', target: '10.2.2.2' });
  loc({ check_id: 'u:5', checkpoint_id: 'overall', label: 'Overall', is_overall: 1, last_status: 'up', last_rtt_ms: 12, last_loss_pct: 0 });

  ins('lm_topology_links', { source_id: sid, src_device_id: 101, src_instance_id: 1, src_port: 'Gi1/0/1', dst_device_id: 102,
    dst_name: 'edge-rt1', dst_port: 'xe-0/0/0', protocol: 'description', confidence: 'high', last_seen: sqlTs(0) });
  ins('lm_topology_links', { source_id: sid, src_device_id: 101, src_instance_id: 2, src_port: 'Gi1/0/2', dst_device_id: null,
    dst_name: 'mystery-box', protocol: 'description', confidence: 'low', last_seen: sqlTs(0) });
  return sid;
}

beforeEach(() => {
  wipe();
  vi.spyOn(handle, 'schedule').mockImplementation(() => {});
  vi.spyOn(handle, 'cancel').mockImplementation(() => {});
  vi.spyOn(handle, 'trigger').mockImplementation(() => Promise.resolve());
  vi.spyOn(handle, 'triggerInterfaces').mockImplementation(() => Promise.resolve());
});
afterEach(() => { vi.restoreAllMocks(); });

const API = '/api/logicmonitor';

describe('logicmonitor sources CRUD', () => {
  it('POST normalises the company, never leaks a secret, and 409s duplicates', async () => {
    const res = await request(app).post(`${API}/sources`).send({
      name: 'Acme Ops', company: 'https://Acme.LogicMonitor.com/santaba/rest', authMode: 'lmv1',
      accessId: 'AID123', accessKey: 'SECRETKEY-xyz', pollingIntervalMinutes: 10,
    });
    expect(res.status).toBe(201);
    expect(res.body.company).toBe('acme');
    expect(res.body.baseUrl).toBe('https://acme.logicmonitor.com');
    expect(res.body.hasCredentials).toBe(true);
    expect(res.body.pollingIntervalMinutes).toBe(10);
    expect(res.body.interfacePollMinutes).toBe(15);
    expect(res.body.groupFilter).toEqual([]);
    expect(res.body.interfaceCategories).toBeNull();
    expect(JSON.stringify(res.body)).not.toContain('SECRETKEY');
    expect(res.body.encryptedCredentials).toBeUndefined();
    expect(handle.schedule).toHaveBeenCalledTimes(1);
    expect(handle.trigger).toHaveBeenCalledTimes(1);

    const list = await request(app).get(`${API}/sources`);
    expect(list.body).toHaveLength(1);
    expect(JSON.stringify(list.body)).not.toContain('SECRETKEY');
    expect(JSON.stringify(list.body)).not.toContain('encrypted');

    const dupName = await request(app).post(`${API}/sources`).send({ name: 'Acme Ops', company: 'other', accessId: 'a', accessKey: 'b' });
    expect(dupName.status).toBe(409);
    const dupCompany = await request(app).post(`${API}/sources`).send({ name: 'Other', company: 'ACME.logicmonitor.com', accessId: 'a', accessKey: 'b' });
    expect(dupCompany.status).toBe(409);
  });

  it('POST rejects an incomplete credential pair and a bad company', async () => {
    const noKey = await request(app).post(`${API}/sources`).send({ name: 'x', company: 'acme', accessId: 'a' });
    expect(noKey.status).toBe(400);
    const noToken = await request(app).post(`${API}/sources`).send({ name: 'x', company: 'acme', authMode: 'bearer' });
    expect(noToken.status).toBe(400);
    const badCo = await request(app).post(`${API}/sources`).send({ name: 'x', company: 'a!b', accessId: 'a', accessKey: 'b' });
    expect(badCo.status).toBe(400);
    const bearer = await request(app).post(`${API}/sources`).send({ name: 'tok', company: 'tokco', authMode: 'bearer', token: 'BEARER-SECRET' });
    expect(bearer.status).toBe(201);
    expect(bearer.body.authMode).toBe('bearer');
    expect(JSON.stringify(bearer.body)).not.toContain('BEARER-SECRET');
  });

  it('PUT: company change needs the secret, clears features and rate limit; keep-if-blank merges accessId', async () => {
    const sid = insertSource({ rate_limit_json: '{"remaining":10}' });
    const refused = await request(app).put(`${API}/sources/${sid}`).send({ company: 'newco' });
    expect(refused.status).toBe(400);
    expect(refused.body.error).toMatch(/re-entering/i);

    // Name-only change keeps the stored ciphertext untouched.
    const before = db.prepare('SELECT encrypted_credentials FROM lm_sources WHERE id = ?').get(sid).encrypted_credentials;
    const renamed = await request(app).put(`${API}/sources/${sid}`).send({ name: 'Acme Renamed' });
    expect(renamed.status).toBe(200);
    expect(db.prepare('SELECT encrypted_credentials FROM lm_sources WHERE id = ?').get(sid).encrypted_credentials).toBe(before);
    expect(renamed.body.features.collectorMgd).toBe('41.000');
    expect(renamed.body.features.ifColumns).toBeUndefined();

    const moved = await request(app).put(`${API}/sources/${sid}`).send({ company: 'newco', accessKey: 'NEWKEY' });
    expect(moved.status).toBe(200);
    expect(moved.body.company).toBe('newco');
    expect(moved.body.features).toEqual({});
    expect(moved.body.rateLimit).toBeNull();
    const row = db.prepare('SELECT * FROM lm_sources WHERE id = ?').get(sid);
    expect(JSON.parse(decrypt(row.encrypted_credentials))).toEqual({ accessId: 'AID123', accessKey: 'NEWKEY' });
    expect(JSON.stringify(moved.body)).not.toContain('NEWKEY');

    const scope = await request(app).put(`${API}/sources/${sid}`).send({ groupFilter: [10, 11], interfaceCategories: ['switch'] });
    expect(scope.body.groupFilter).toEqual([10, 11]);
    expect(scope.body.interfaceCategories).toEqual(['switch']);
    const all = await request(app).put(`${API}/sources/${sid}`).send({ interfaceCategories: null });
    expect(all.body.interfaceCategories).toBeNull();
  });

  it('DELETE cancels the pollers and returns 204; unknown id 404', async () => {
    const sid = insertSource();
    const del = await request(app).delete(`${API}/sources/${sid}`);
    expect(del.status).toBe(204);
    expect(handle.cancel).toHaveBeenCalledWith(sid);
    expect(db.prepare('SELECT COUNT(*) n FROM lm_sources').get().n).toBe(0);
    expect((await request(app).delete(`${API}/sources/999`)).status).toBe(404);
  });

  it('POST /sources/0/test uses body creds; blank secret tests the saved row only', async () => {
    const seen = [];
    vi.spyOn(api, 'testConnection').mockImplementation(async (c) => { seen.push(c); return { ok: c.company !== 'failco', message: 'm', details: { company: c.company, version: 'v3' } }; });
    const fresh = await request(app).post(`${API}/sources/0/test`).send({ company: 'Fresh.logicmonitor.com', accessId: 'id1', accessKey: 'k1' });
    expect(fresh.status).toBe(200);
    expect(seen[0].company).toBe('fresh');
    expect(seen[0].accessKey).toBe('k1');
    expect(JSON.parse(decrypt(seen[0].encrypted_credentials))).toEqual({ accessId: 'id1', accessKey: 'k1' });

    const blank0 = await request(app).post(`${API}/sources/0/test`).send({ company: 'fresh' });
    expect(blank0.status).toBe(404);

    const sid = insertSource();
    const saved = await request(app).post(`${API}/sources/${sid}/test`).send({ company: 'evil' });
    expect(saved.status).toBe(200);
    expect(seen[1].company).toBe('acme');
    expect(seen[1].id).toBe(sid);

    const failing = await request(app).post(`${API}/sources/0/test`).send({ company: 'failco', authMode: 'bearer', token: 't' });
    expect(failing.status).toBe(502);
  });

  it('poll routes return 202 and call the right tier', async () => {
    const sid = insertSource();
    expect((await request(app).post(`${API}/sources/${sid}/poll`)).status).toBe(202);
    expect(handle.trigger).toHaveBeenCalledTimes(1);
    expect((await request(app).post(`${API}/sources/${sid}/poll-interfaces`)).status).toBe(202);
    expect(handle.triggerInterfaces).toHaveBeenCalledTimes(1);
    expect((await request(app).post(`${API}/sources/999/poll`)).status).toBe(404);
  });

  it('GET /sources/:id/probe reports per-section results and writes features_json', async () => {
    const sid = seedEstate();
    const poller = require('../services/logicmonitorPoller');
    const paths = [];
    vi.spyOn(api, 'probeGet').mockImplementation(async (src, path) => {
      paths.push(path);
      if (path === '/topology/topologies') return { ok: false, sample: null, count: 0, total: null, error: 'HTTP 404' };
      if (path === '/website/websites') return { ok: true, sample: [{ id: 7, checkpoints: [{ id: 3 }] }], count: 1, total: 1, error: null };
      if (path === '/swagger.json') return { ok: true, sample: { huge: true }, count: null, total: null, size: 12345, error: null };
      return { ok: true, sample: [{ id: 1 }], count: 1, total: 1, error: null };
    });
    vi.spyOn(api, 'fetchDeviceDatasources').mockResolvedValue([
      { hdsId: 9001, datasourceName: 'SNMP_Network_Interfaces' }, { hdsId: 9002, datasourceName: 'Cisco_CPU_SNMP' }]);
    const dsData = vi.spyOn(api, 'fetchDsData').mockResolvedValue({ dataPoints: ['InMbps', 'OutMbps'], instances: {} });
    vi.spyOn(api, 'fetchCheckpointData').mockResolvedValue({ dataPoints: ['rtavg', 'loss'], values: [], time: [] });
    vi.spyOn(poller, 'probeFeatures').mockResolvedValue({ netflow: false, config: false, websites: true, uptime: false, topology: false, probedAt: '2026-10-14T00:00:00.000Z' });

    const res = await request(app).get(`${API}/sources/${sid}/probe`);
    expect(res.status).toBe(200);
    expect(res.body.sections.devices.ok).toBe(true);
    expect(res.body.sections.topology).toMatchObject({ ok: false, error: 'HTTP 404' });
    expect(res.body.sections.interfaceDatasource.count).toBe(1);
    expect(res.body.sections.interfaceData.sample.dataPoints).toEqual(['InMbps', 'OutMbps']);
    expect(res.body.sections.checkData.ok).toBe(true);
    expect(res.body.sections.swagger).toMatchObject({ ok: true, size: 12345, sample: null });
    expect(res.body.sections.netflow.ok).toBe(false);
    expect(dsData.mock.calls[0][1]).toBe(101);
    expect(dsData.mock.calls[0][2]).toBe(9001);
    expect(paths).toContain('/setting/admins');
    const f = JSON.parse(db.prepare('SELECT features_json FROM lm_sources WHERE id = ?').get(sid).features_json);
    expect(f).toMatchObject({ websites: true, ifDataSource: 'SNMP_Network_Interfaces', ifColumns: ['InMbps', 'OutMbps'],
      collectorMgd: '41.000', probedAt: '2026-10-14T00:00:00.000Z' });
    expect(f.checkColumns.learned).toEqual(['rtavg', 'loss']);
    expect(res.body.source.features.ifColumns).toBeUndefined();
  });

  it('GET /sources/:id/groups returns the scope picker rows', async () => {
    const sid = seedEstate();
    const res = await request(app).get(`${API}/sources/${sid}/groups`);
    expect(res.body).toEqual([{ id: 10, name: 'Core', fullPath: 'Network/Core', parentId: null, numOfHosts: 2 }]);
  });
});

describe('logicmonitor data routes', () => {
  it('GET /summary totals match the seeded estate', async () => {
    seedEstate();
    const res = await request(app).get(`${API}/summary`);
    expect(res.status).toBe(200);
    const t = res.body.totals;
    expect(t.devices).toBe(4);
    expect(t.networkDevices).toBe(3);
    expect(t.devicesNormal).toBe(2);
    expect(t.devicesDead).toBe(1);
    expect(t.devicesDeadCollector).toBe(1);
    expect(t.devicesInSdt).toBe(1);
    expect(t.interfaces).toBe(4);
    expect(t.interfacesUp).toBe(2); // if 1 up, if 4 status 1 with no text
    expect(t.interfacesDown).toBe(1); // if 3 is down but stop_monitoring
    expect(t.alertsCritical).toBe(1);
    expect(t.alertsWarning).toBe(2);
    expect(t.alertsInfo).toBe(1);
    expect(t.alertsAcked).toBe(1);
    expect(t.collectors).toBe(2);
    expect(t.collectorsDown).toBe(1);
    expect(t.checks).toBe(3);
    expect(t.checksDown).toBe(1);
    expect(t.checksDegraded).toBe(1);
    expect(typeof t.openIssues).toBe('number');
    // Estate line: network devices core-sw1 + core-sw2 (Cisco C9300 switch)
    // and edge-rt1 (Juniper MX204 router); the stale old-sw is excluded.
    expect(t.vendors).toBe(2);
    expect(t.models).toBe(2);
    expect(t.roles).toBe(2);
    expect(res.body.byVendor[0]).toEqual({ vendor: 'Cisco', count: 2 });
    expect(res.body.deadDevices.map((d) => d.displayName)).toEqual(['edge-rt1', 'app-srv1']);
    expect(res.body.deadDevices[0].sinceMs).toBe(1700000000000);
    expect(res.body.hotInterfaces[0]).toMatchObject({ deviceName: 'core-sw1', displayName: 'Gi1/0/1', inUtilPct: 90 });
    expect(res.body.collectors.find((c) => c.hostname === 'den-col01').behind).toBe(true);
    expect(res.body.collectors.find((c) => c.hostname === 'phx-col01').behind).toBe(false);
    expect(res.body.alertsByDatasource[0]).toEqual({ name: 'Cisco_CPU_SNMP', count: 2 });
    expect(res.body.worstLinks[0].status).toBe('down');
    // Series: additive keys; if 1 has 4 history rows at util 50, w:1/cp2 has 3 rows at 90 ms.
    const hs = res.body.hotInterfaceSeries.find((x) => x.instanceId === 1);
    expect(hs).toMatchObject({ deviceName: 'core-sw1', displayName: 'Gi1/0/1' });
    expect(hs.points).toHaveLength(4);
    expect(hs.points[0]).toEqual({ at: expect.stringMatching(/Z$/), utilPct: 50 });
    expect(hs.points.map((p) => p.at)).toEqual([...hs.points.map((p) => p.at)].sort());
    expect(res.body.hotInterfaceSeries).toHaveLength(res.body.hotInterfaces.length);
    const ws = res.body.worstLinkSeries.find((x) => x.checkId === 'w:1' && x.checkpointLabel === 'DEN');
    expect(ws).toMatchObject({ checkName: 'dc1-ping', baselineRttMs: 30 });
    expect(ws.points).toHaveLength(3);
    expect(ws.points[0]).toEqual({ at: expect.stringMatching(/Z$/), rttAvgMs: 90, lossPct: 0 });
    expect(res.body.worstLinkSeries).toHaveLength(res.body.worstLinks.length);
    expect(res.body.sources[0].baseUrl).toBe('https://acme.logicmonitor.com');
  });

  it('GET /devices is server-paged, sorted and filtered', async () => {
    const sid = insertSource();
    for (let i = 0; i < 55; i += 1) {
      ins('lm_devices', { source_id: sid, lm_device_id: 1000 + i, display_name: `dev-${String(i).padStart(2, '0')}`,
        vendor: i % 5 === 0 ? 'Arista' : 'Cisco', is_network: i < 20 ? 1 : 0, host_status: 'normal', if_count: i });
    }
    const p1 = await request(app).get(`${API}/devices?limit=50`);
    expect(p1.body.total).toBe(55);
    expect(p1.body.items).toHaveLength(50);
    expect(p1.body.page).toBe(1);
    expect(p1.body.limit).toBe(50);
    expect(p1.body.items[0].displayName).toBe('dev-00');
    const p2 = await request(app).get(`${API}/devices?limit=50&page=2`);
    expect(p2.body.items).toHaveLength(5);
    const all = await request(app).get(`${API}/devices?limit=all`);
    expect(all.body.limit).toBe(500);
    expect(all.body.items).toHaveLength(55);
    const desc = await request(app).get(`${API}/devices?sort=ifCount&dir=desc&limit=3`);
    expect(desc.body.items.map((d) => d.ifCount)).toEqual([54, 53, 52]);
    expect((await request(app).get(`${API}/devices?network=1`)).body.total).toBe(20);
    expect((await request(app).get(`${API}/devices?vendor=Arista`)).body.total).toBe(11);
    expect((await request(app).get(`${API}/devices?sort=bogus`)).status).toBe(400);
    expect((await request(app).get(`${API}/devices?limit=501`)).status).toBe(400);
  });

  it('GET /devices row shape and Device 360, CSV export by posted ids', async () => {
    seedEstate();
    const list = await request(app).get(`${API}/devices?q=core-sw1`);
    const d = list.body.items[0];
    expect(d).toMatchObject({ id: 101, displayName: 'core-sw1', alertSeverity: 'critical', acked: false, inSdt: false,
      collectorName: 'phx-col01', groups: ['Network/Core'], openAlerts: 2, isNetwork: true });
    expect(d.firstSeen).toMatch(/Z$/);
    expect((await request(app).get(`${API}/devices?groupId=10`)).body.total).toBe(3);
    expect((await request(app).get(`${API}/devices?collectorId=1`)).body.total).toBe(3);

    const one = await request(app).get(`${API}/devices/101`);
    expect(one.status).toBe(200);
    expect(one.body.interfaces).toHaveLength(4);
    expect(one.body.alerts.map((a) => a.id)).toEqual(['DS1', 'DS2', 'DS6', 'DS5']);
    expect(one.body.links).toHaveLength(2);
    expect(one.body.links.find((l) => l.dstName === 'edge-rt1')).toMatchObject({ srcPort: 'Gi1/0/1', dstDeviceId: 102, status: 'up' });
    expect(one.body.collector).toMatchObject({ id: 1, hostname: 'phx-col01', isDown: true });
    const rt = await request(app).get(`${API}/devices/102`);
    expect(rt.body.links[0]).toMatchObject({ srcPort: 'xe-0/0/0', dstName: 'core-sw1', dstDeviceId: 101 });
    const srv = await request(app).get(`${API}/devices/103`);
    expect(srv.body.sdts).toHaveLength(1);
    expect(srv.body.sdts[0].startAt).toMatch(/Z$/);
    expect((await request(app).get(`${API}/devices/9999`)).status).toBe(404);

    const csv = await request(app).post(`${API}/devices/export`).send({ ids: [101, 102] });
    expect(csv.status).toBe(200);
    expect(csv.headers['content-type']).toMatch(/text\/csv/);
    const lines = csv.text.trim().split(/\r\n/);
    expect(lines[0].startsWith('displayName,name,portal')).toBe(true);
    expect(lines).toHaveLength(3);
  });

  it('GET /interfaces presets and interface history', async () => {
    seedEstate();
    const ids = async (qs) => (await request(app).get(`${API}/interfaces?${qs}`)).body.items.map((i) => i.instanceId).sort();
    expect(await ids('preset=down')).toEqual([2]);
    expect(await ids('preset=hot')).toEqual([1]);
    expect(await ids('preset=errors')).toEqual([2]);
    expect(await ids('preset=flapping')).toEqual([1]);
    expect(await ids('preset=unused')).toEqual([4]);
    expect(await ids('status=up')).toEqual([1, 4]);
    expect(await ids(`speedClass=${encodeURIComponent('<=100M')}`)).toEqual([4]);
    const all = await request(app).get(`${API}/interfaces?sort=inUtilPct&dir=desc`);
    expect(all.body.total).toBe(4);
    expect(all.body.items[0].instanceId).toBe(1);
    expect(all.body.items[0].sampledAt).toMatch(/Z$/);

    const hist = await request(app).get(`${API}/devices/101/interfaces/2/history?hours=24`);
    expect(hist.body.points).toHaveLength(2);
    expect(hist.body.points[0].at).toMatch(/Z$/);
    const unusedDaily = await request(app).get(`${API}/devices/101/interfaces/4/history`);
    expect(unusedDaily.body.daily).toHaveLength(30);

    const cmp = await request(app).get(`${API}/interfaces/compare?ids=1,2&hours=24`);
    expect(cmp.body.series.map((s) => s.points.length)).toEqual([4, 2]);
    expect((await request(app).get(`${API}/interfaces/compare?ids=1`)).status).toBe(400);

    const csv = await request(app).get(`${API}/interfaces.csv?preset=down`);
    expect(csv.text.trim().split(/\r\n/)).toHaveLength(2);
  });

  it('GET /alerts counts over the open set and filters', async () => {
    seedEstate();
    const open = await request(app).get(`${API}/alerts`);
    expect(open.body.total).toBe(4);
    expect(open.body.counts).toEqual({ critical: 1, warning: 2, info: 1, acked: 1, sdted: 1 });
    expect(open.body.items[0].id).toBe('DS4'); // newest first by default
    expect(open.body.items[0].startedAt).toMatch(/Z$/);
    expect((await request(app).get(`${API}/alerts?cleared=all`)).body.total).toBe(6);
    expect((await request(app).get(`${API}/alerts?cleared=1`)).body.total).toBe(2);
    const warn = await request(app).get(`${API}/alerts?severity=warning`);
    expect(warn.body.total).toBe(2);
    expect(warn.body.counts.critical).toBe(1);
    expect((await request(app).get(`${API}/alerts?datasource=Cisco_CPU_SNMP`)).body.total).toBe(2);
  });

  it('GET /collectors lists devices per collector and the MGD comparison', async () => {
    seedEstate();
    const res = await request(app).get(`${API}/collectors`);
    expect(res.body).toHaveLength(2);
    const phx = res.body.find((c) => c.hostname === 'phx-col01');
    expect(phx.isDown).toBe(true);
    expect(phx.mgd).toBe('41.000');
    expect(phx.devices.map((d) => d.id).sort()).toEqual([101, 103, 104]);
    expect(res.body.find((c) => c.hostname === 'den-col01').behind).toBe(true);
  });

  it('GET /checks matrix, anomalies and history', async () => {
    seedEstate();
    const res = await request(app).get(`${API}/checks`);
    expect(res.body.counts).toEqual({ total: 3, down: 1, degraded: 1, ok: 1 });
    expect(res.body.matrix.rows).toEqual(['DEN', 'PHX']);
    expect(res.body.matrix.cols.map((c) => c.checkId)).toEqual(['u:5', 'w:1', 'w:2']); // ordered by check name
    const cell = (row, col) => res.body.matrix.cells.find((c) => c.row === row && c.col === col);
    expect(cell('PHX', 'w:1').anomaly).toBe('down');
    expect(cell('DEN', 'w:1').anomaly).toBe('latency');
    expect(cell('PHX', 'w:2').anomaly).toBe('down');
    const w1 = res.body.items.find((i) => i.checkId === 'w:1');
    expect(w1.locations.find((l) => l.label === 'DEN').baselineRttMs).toBe(30);

    const hist = await request(app).get(`${API}/checks/w:1/history?checkpointId=cp2&hours=24`);
    expect(hist.body.points).toHaveLength(3);
    expect(hist.body.points[0].at).toMatch(/Z$/);
    expect(hist.body.baseline).toHaveLength(24);
    expect((await request(app).get(`${API}/checks/w:404/history`)).status).toBe(404);
  });

  it('GET /governance sections and governance.csv', async () => {
    const sid = seedEstate();
    db.prepare(`
      INSERT INTO config_changes (platform, scope, system, item, change_type, old_value, new_value, detected_at)
      VALUES ('logicmonitor', 'admins', 'Acme Ops', 'bob', 'added', NULL, '{}', ?)
    `).run(sqlTs(HOUR));
    const res = await request(app).get(`${API}/governance`);
    expect(res.status).toBe(200);
    const c9300 = res.body.codeLevels.filter((l) => l.model === 'C9300');
    expect(c9300).toEqual([
      { vendor: 'Cisco', model: 'C9300', version: '17.9.4a', count: 1, newest: true, behind: false },
      { vendor: 'Cisco', model: 'C9300', version: '17.6.5', count: 1, newest: false, behind: true },
    ]);
    expect(res.body.collectorBuilds.find((b) => b.build === '39.005').behind).toBe(true);
    expect(res.body.deadDevices).toHaveLength(2);
    // Network devices without an interface datasource row: edge-rt1, core-sw2.
    expect(res.body.coverage.noInterfaceDatasource.map((d) => d.displayName)).toEqual(['core-sw2', 'edge-rt1']);
    expect(res.body.coverage.inSdt.map((d) => d.displayName)).toEqual(['app-srv1']);
    expect(res.body.coverage.alertingDisabled.map((d) => d.displayName)).toEqual(['app-srv1']);
    expect(res.body.coverage.notPolled24h).toEqual([]);
    expect(res.body.alertHygiene.ackedOpenOver7d.map((a) => a.id)).toEqual(['DS1']);
    expect(res.body.alertHygiene.noisyConditions[0]).toMatchObject({ conditionKey: 'lm:1:core-sw1:Cisco_CPU_SNMP:CPU:CPUBusyPercent', count30d: 3 });
    expect(res.body.alertHygiene.unrouted).toBe(1);
    expect(res.body.topologyUnmatched).toEqual([{ deviceId: 101, instanceId: 2, deviceName: 'core-sw1', displayName: 'Gi1/0/2', description: null, reason: 'no-name' }]);
    expect(res.body.configChanges[0]).toMatchObject({ scope: 'admins', item: 'bob' });
    expect(res.body.configChanges[0].detectedAt).toMatch(/Z$/);
    expect(sid).toBeGreaterThan(0);

    const csv = await request(app).get(`${API}/governance.csv?section=codeLevels`);
    expect(csv.headers['content-type']).toMatch(/text\/csv/);
    expect(csv.text.split(/\r\n/)[0]).toBe('vendor,model,version,count,newest,behind');
    expect((await request(app).get(`${API}/governance.csv?section=nope`)).status).toBe(400);
  });

  it('GET /issues contract and /issue-history bare array', async () => {
    insertSource({ name: 'Broken Portal', company: 'broken', last_poll_status: 'error', last_poll_error: 'credentials rejected' });
    const res = await request(app).get(`${API}/issues`);
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.issues)).toBe(true);
    const unreachable = res.body.issues.find((i) => i.type === 'source-unreachable');
    expect(unreachable).toBeTruthy();
    expect(unreachable.source).toBe('Broken Portal');
    for (const i of res.body.issues) {
      for (const k of ['severity', 'type', 'source', 'target', 'message']) expect(i).toHaveProperty(k);
      expect(['critical', 'warning', 'info']).toContain(i.severity);
    }

    db.prepare('DELETE FROM lm_issue_history').run();
    ins('lm_issue_history', { issue_key: 'device-dead|Acme|edge-rt1', source: 'Acme', severity: 'critical', type: 'device-dead', target: 'edge-rt1', message: 'dead', status: 'open', first_seen: sqlTs(2 * HOUR), last_seen: sqlTs(0) });
    ins('lm_issue_history', { issue_key: 'device-new|Acme|x', source: 'Acme', severity: 'info', type: 'device-new', target: 'x', message: 'new', status: 'resolved', first_seen: sqlTs(3 * DAY), last_seen: sqlTs(2 * DAY), resolved_at: sqlTs(2 * DAY) });
    ins('lm_issue_history', { issue_key: 'device-new|Acme|old', source: 'Acme', severity: 'info', type: 'device-new', target: 'old', message: 'old', status: 'resolved', first_seen: sqlTs(80 * DAY), last_seen: sqlTs(60 * DAY), resolved_at: sqlTs(60 * DAY) });
    const hist = await request(app).get(`${API}/issue-history`);
    expect(Array.isArray(hist.body)).toBe(true);
    expect(hist.body).toHaveLength(2);
    expect(hist.body[0]).toMatchObject({ issueKey: 'device-dead|Acme|edge-rt1', type: 'device-dead', status: 'open' });
    expect(hist.body[0].first_seen).toMatch(/Z$/);
    expect(hist.body[0].firstSeen).toBe(hist.body[0].first_seen);
    expect(hist.body[1].resolvedAt).toMatch(/Z$/);
    expect((await request(app).get(`${API}/issue-history?days=90`)).body).toHaveLength(3);
  });

  it('GET /trends buckets by range', async () => {
    const sid = insertSource();
    const m = (ago, crit) => ins('lm_metrics_history', { source_id: sid, captured_at: sqlTs(ago), devices_normal: 10, alerts_critical: crit, alerts_error: 1, alerts_warning: 2 });
    m(3 * HOUR, 1); m(2 * HOUR, 2); m(HOUR, 3); m(3 * DAY, 9);
    const day = await request(app).get(`${API}/trends?range=24h`);
    expect(day.body.points.map((p) => p.alertsCritical)).toEqual([1, 2, 3]);
    expect(day.body.points[0].alertsWarning).toBe(3);
    expect(day.body.points[0].at).toMatch(/Z$/);
    expect((await request(app).get(`${API}/trends?range=7d`)).body.points).toHaveLength(4);
    expect((await request(app).get(`${API}/trends?range=1y`)).status).toBe(400);
  });

  it('GET /sdts and /topology-links shapes', async () => {
    seedEstate();
    const sdts = await request(app).get(`${API}/sdts`);
    expect(sdts.body[0]).toMatchObject({ id: 'D_1', type: 'DeviceSDT', isEffective: true, deviceDisplayName: 'app-srv1' });
    const links = await request(app).get(`${API}/topology-links?deviceId=102`);
    expect(links.body).toEqual([{ sourceId: links.body[0].sourceId, srcDeviceId: 101, srcDeviceName: 'core-sw1', srcPort: 'Gi1/0/1', dstDeviceId: 102, dstName: 'edge-rt1', dstPort: 'xe-0/0/0', protocol: 'description', confidence: 'high', dstPlatform: 'logicmonitor', dstRef: null }]);
  });

  it('GET/PUT /config clamps into range and rejects non-integers', async () => {
    const g = await request(app).get(`${API}/config`);
    expect(g.body.thresholds.lm_if_util_warn_pct).toBe(80);
    expect(g.body.thresholds.lm_check_data_calls_per_tick).toBe(200);
    expect(Object.keys(g.body.thresholds)).toHaveLength(57);
    for (const k of THRESHOLD_KEYS) expect(g.body.thresholds).toHaveProperty(k);
    expect(g.body.ranges.lm_if_util_warn_pct).toEqual({ min: 50, max: 100, default: 80 });
    const put = await request(app).put(`${API}/config`).send({ lm_if_util_warn_pct: 150, lm_if_flap_warn: 0, lm_dead_grace_min: 15 });
    expect(put.status).toBe(200);
    expect(put.body.thresholds.lm_if_util_warn_pct).toBe(100);
    expect(put.body.thresholds.lm_if_flap_warn).toBe(1);
    expect(put.body.thresholds.lm_dead_grace_min).toBe(15);
    const nested = await request(app).put(`${API}/config`).send({ thresholds: { lm_if_err_warn: 250 } });
    expect(nested.body.thresholds.lm_if_err_warn).toBe(250);
    const bad = await request(app).put(`${API}/config`).send({ lm_if_err_warn: 'abc' });
    expect(bad.status).toBe(400);
    expect((await request(app).get(`${API}/config`)).body.thresholds.lm_if_err_warn).toBe(250);
  });
});

describe('logicmonitor round 2: model review, endpoints, server path', () => {
  function seedRound2(sid) {
    db.exec(`
      CREATE TABLE IF NOT EXISTS vcenter_host_nic_neighbors (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        vcenter_id INTEGER NOT NULL REFERENCES vcenter_vcenters(id) ON DELETE CASCADE,
        host_name TEXT NOT NULL, nic TEXT NOT NULL, mac TEXT, protocol TEXT NOT NULL,
        switch_name TEXT, switch_port TEXT, switch_address TEXT, switch_platform TEXT, vlan INTEGER,
        raw_json TEXT, captured_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
        UNIQUE (vcenter_id, host_name, nic, protocol)
      );
    `);
    const vc = ins('vcenter_vcenters', { name: 'vc-r2', host: 'vc.r2', username: 'u', encrypted_credentials: 'x' });
    ins('vcenter_hosts', { vcenter_id: vc, host_id: 'h-1', name: 'esx-01.lab', connection_state: 'connected' });
    ins('vcenter_vms', { vcenter_id: vc, vm_id: 'vm-1', name: 'app-vm1', host_name: 'esx-01.lab', ip_address: '10.7.7.7' });
    // Hint on core-sw1 "GigabitEthernet1/0/4": matches Gi1/0/4 by port number.
    ins('vcenter_host_nic_neighbors', { vcenter_id: vc, host_name: 'esx-01.lab', nic: 'vmnic2', protocol: 'cdp',
      switch_name: 'core-sw1', switch_port: 'GigabitEthernet1/0/4', captured_at: sqlTs(MIN) });
    // An interface description resolved to a Dell server by the poller.
    ins('lm_topology_links', { source_id: sid, src_device_id: 101, src_instance_id: 3, src_port: 'Gi1/0/3', dst_device_id: null,
      dst_name: 'db-srv9', dst_platform: 'dell', dst_ref: 'db-srv9', protocol: 'description', confidence: 'medium', last_seen: sqlTs(2 * MIN) });
  }
  function clearRound2() {
    db.prepare('DELETE FROM vcenter_host_nic_neighbors').run();
    db.prepare('DELETE FROM vcenter_vms').run();
    db.prepare('DELETE FROM vcenter_hosts').run();
    db.prepare("DELETE FROM vcenter_vcenters WHERE name = 'vc-r2'").run();
  }
  afterEach(() => clearRound2());

  it('GET /governance modelReview rows, rollups, endpoints and both CSV sections', async () => {
    const sid = seedEstate();
    seedRound2(sid);
    const res = await request(app).get(`${API}/governance`);
    expect(res.status).toBe(200);
    expect(res.body.modelReview.map((r) => r.displayName)).toEqual(['core-sw1', 'core-sw2', 'edge-rt1']);
    expect(res.body.modelReview[0]).toEqual({
      id: 101, sourceId: sid, sourceName: 'Acme Ops', displayName: 'core-sw1', name: '10.0.0.1', vendor: 'Cisco', model: 'C9300',
      version: '17.9.4a', role: 'switch', serial: null, collectorName: 'phx-col01', groups: ['Network/Core'], hostStatus: 'normal',
      ifCount: 4, ifUp: 2, uplinks: 1, endpoints: 2, behind: false, firstSeen: res.body.modelReview[0].firstSeen,
      siteKey: null, siteName: null, tier: null,
    });
    expect(res.body.modelReview[1]).toMatchObject({ displayName: 'core-sw2', behind: true, uplinks: 0, endpoints: 0 });
    expect(res.body.rollups).toEqual({
      byVendor: [{ vendor: 'Cisco', count: 2 }, { vendor: 'Juniper', count: 1 }],
      byRole: [{ role: 'switch', count: 2 }, { role: 'router', count: 1 }],
      byModel: [{ vendor: 'Cisco', model: 'C9300', count: 2 }, { vendor: 'Juniper', model: 'MX204', count: 1 }],
    });
    expect(res.body.endpoints).toHaveLength(2);
    expect(res.body.endpointsSummary).toEqual({
      total: 2, corroborated: 0, byPlatform: [{ platform: 'dell', count: 1 }, { platform: 'vcenter', count: 1 }], unmatchedPorts: 0,
    });
    // The Dell-resolved row is not an unmatched link.
    expect(res.body.topologyUnmatched.map((r) => r.instanceId)).toEqual([2]);

    const mr = await request(app).get(`${API}/governance.csv?section=modelReview`);
    const mrLines = mr.text.trim().split(/\r\n/);
    expect(mrLines[0]).toBe('displayName,name,sourceName,vendor,model,version,behind,role,serial,collectorName,groups,hostStatus,ifUp,ifCount,uplinks,endpoints,firstSeen,id,sourceId');
    expect(mrLines).toHaveLength(4);
    expect(mrLines[2]).toMatch(/^core-sw2,10\.0\.0\.4,Acme Ops,Cisco,C9300,17\.6\.5,yes,switch,/);
    const ep = await request(app).get(`${API}/governance.csv?section=endpoints`);
    const epLines = ep.text.trim().split(/\r\n/);
    expect(epLines[0]).toBe('deviceName,port,portStatusText,portInUtilPct,portOutUtilPct,portErrors,endpoint,endpointPlatform,nic,protocol,confidence,corroborated,matchQuality,origin,mac,vlan,switchName,lastSeen,instanceId,deviceId,sourceId');
    expect(epLines).toHaveLength(3);
  });

  it('GET /endpoints/summary answers per-host port counts for one platform and rejects an unknown platform', async () => {
    const sid = seedEstate();
    seedRound2(sid);
    const dell = await request(app).get(`${API}/endpoints/summary?platform=dell`);
    expect(dell.status).toBe(200);
    expect(dell.body['db-srv9']).toEqual({ ports: 1, switches: ['core-sw1'], state: 'down' });
    const vc = await request(app).get(`${API}/endpoints/summary?platform=vcenter`);
    expect(vc.body['esx-01.lab']).toEqual({ ports: 1, switches: ['core-sw1'], state: 'up' });
    expect(vc.body['db-srv9']).toBeUndefined();
    const none = await request(app).get(`${API}/endpoints/summary?platform=cohesity`);
    expect(none.status).toBe(200);
    expect(none.body).toEqual({});
    expect((await request(app).get(`${API}/endpoints/summary?platform=bogus`)).status).toBe(400);
    expect((await request(app).get(`${API}/endpoints/summary`)).status).toBe(400);
  });

  it('GET /endpoints is server-paged, sorted, filtered; CSV', async () => {
    const sid = seedEstate();
    seedRound2(sid);
    const page = await request(app).get(`${API}/endpoints?sort=endpoint&dir=asc&limit=1&page=2`);
    expect(page.status).toBe(200);
    expect(page.body).toMatchObject({ total: 2, page: 2, limit: 1 });
    expect(page.body.items[0]).toMatchObject({
      sourceId: sid, deviceId: 101, deviceName: 'core-sw1', port: 'Gi1/0/4', instanceId: 4, portStatusText: 'up',
      endpoint: 'esx-01.lab', endpointPlatform: 'vcenter', nic: 'vmnic2', protocol: 'cdp', confidence: 'medium',
      origin: 'vcenter-hint', matchQuality: 'port-number', switchName: 'core-sw1',
    });
    expect(page.body.items[0].lastSeen).toMatch(/Z$/);
    const dell = await request(app).get(`${API}/endpoints?platform=dell`);
    expect(dell.body.items.map((r) => [r.endpoint, r.port, r.portStatusText, r.origin])).toEqual([['db-srv9', 'Gi1/0/3', 'down', 'description']]);
    expect((await request(app).get(`${API}/endpoints?q=esx`)).body.total).toBe(1);
    expect((await request(app).get(`${API}/endpoints?deviceId=104`)).body.total).toBe(0);
    expect((await request(app).get(`${API}/endpoints?sort=bogus`)).status).toBe(400);
    const csv = await request(app).get(`${API}/endpoints.csv?platform=vcenter`);
    expect(csv.headers['content-type']).toMatch(/text\/csv/);
    expect(csv.text.trim().split(/\r\n/)).toHaveLength(2);
  });

  it('GET /devices/:id adds endpoints, uplinks and platform fields on links', async () => {
    const sid = seedEstate();
    seedRound2(sid);
    const res = await request(app).get(`${API}/devices/101`);
    expect(res.status).toBe(200);
    expect(res.body.endpoints.map((e) => e.endpoint).sort()).toEqual(['db-srv9', 'esx-01.lab']);
    expect(res.body.uplinks).toEqual([{
      srcPort: 'Gi1/0/1', dstDeviceId: 102, dstName: 'edge-rt1', dstPort: 'xe-0/0/0', protocol: 'description', confidence: 'high',
      status: 'up', farInstanceId: null, farStatus: 'unknown',
    }]);
    expect(res.body.links.find((l) => l.srcPort === 'Gi1/0/3')).toMatchObject({ dstPlatform: 'dell', dstRef: 'db-srv9', dstDeviceId: null });
    expect(res.body.links.find((l) => l.srcPort === 'Gi1/0/1')).toMatchObject({ dstPlatform: 'logicmonitor', dstRef: null });
  });

  it('GET /server-path for a VM, for an unknown name, and without parameters', async () => {
    const sid = seedEstate();
    seedRound2(sid);
    const vm = await request(app).get(`${API}/server-path?name=app-vm1`);
    expect(vm.status).toBe(200);
    expect(vm.body.anchor).toEqual({ name: 'app-vm1', kind: 'vm', hostName: 'esx-01.lab' });
    expect(vm.body.switchPorts).toHaveLength(1);
    expect(vm.body.switchPorts[0]).toMatchObject({
      sourceId: sid, deviceId: 101, deviceName: 'core-sw1', port: 'Gi1/0/4', instanceId: 4, statusText: 'up',
      inUtilPct: 0.2, outUtilPct: 0.1, issues: [], nic: 'vmnic2', protocol: 'cdp', source: 'vcenter-hint', tone: 'ok',
    });
    expect(vm.body.uplinks).toEqual([expect.objectContaining({
      from: { deviceId: 101, deviceName: 'core-sw1', port: 'Gi1/0/1' },
      to: { deviceId: 102, deviceName: 'edge-rt1', port: 'xe-0/0/0' }, statusText: 'up',
    })]);
    expect(vm.body.checks).toEqual([]);
    const none = await request(app).get(`${API}/server-path?name=nobody-here`);
    expect(none.body).toEqual({ anchor: { name: 'nobody-here', kind: 'device', hostName: null }, switchPorts: [], uplinks: [], checks: [], path: [], blame: null });
    const byIp = await request(app).get(`${API}/server-path?ip=10.1.1.1`);
    expect(byIp.body.checks.map((c) => c.checkId)).toEqual(['w:1']);
    expect((await request(app).get(`${API}/server-path`)).status).toBe(400);
  });
});

describe('logicmonitor advisor', () => {
  const advisor = require('../services/advisors/logicmonitorAdvisor');
  const slug = (k) => k.replace(/_/g, '-');

  it('exposes the nineteen presets', () => {
    expect(advisor.REPORTS).toEqual(['network_health', 'interface_capacity', 'alert_noise', 'collector_health',
      'device_lifecycle', 'site_reachability', 'circuit_capacity', 'backup_network_impact', 'replication_bandwidth', 'availability_review',
      'network_brief', 'chokepoints', 'change_impact', 'monitoring_coverage', 'suppression_review', 'app_network_exposure',
      'interface_errors', 'alert_delivery', 'site_brief']);
    expect(advisor.SCOPED).toEqual(['site_brief']);
  });

  it('every gather runs on the empty schema and on the seeded estate', () => {
    const unscoped = advisor.REPORTS.filter((k) => !advisor.SCOPED.includes(k));
    for (const k of unscoped) {
      const empty = advisor.gatherFor(k);
      expect(empty.note).toBe('No LogicMonitor portals registered.');
    }
    seedEstate();
    for (const k of unscoped) expect(advisor.gatherFor(k).note).toBeUndefined();
    const nh = advisor.gatherFor('network_health');
    expect(nh.deadAndDeadCollectorDevices).toHaveLength(2);
    expect(nh.interfacesDown).toEqual([{ device: 'core-sw1', iface: 'Gi1/0/2', description: null }]);
    const dl = advisor.gatherFor('device_lifecycle');
    const c9300 = dl.versionsByModel.find((m) => m.model === 'C9300');
    expect(c9300).toMatchObject({ newest: '17.9.4a', devicesBehind: 1, drift: true, devices: 2 });
    const an = advisor.gatherFor('alert_noise');
    expect(an.top15ConditionsByRefire30d[0].fires).toBe(3);
    expect(an.openAlertsWithoutRule).toBe(1);
    const ch = advisor.gatherFor('collector_health');
    expect(ch.collectors.find((c) => c.collector === 'den-col01').behindMgd).toBe(true);
  });

  it('routes: GET 200 {enabled:false, report:null}, POST 503 without a provider, unknown 404', async () => {
    const g = await request(app).get(`${API}/advisor/${slug(advisor.REPORTS[0])}`);
    expect(g.status).toBe(200);
    expect(g.body).toEqual({ enabled: false, report: null });
    const p = await request(app).post(`${API}/advisor/${slug('site_reachability')}`);
    expect(p.status).toBe(503);
    expect((await request(app).get(`${API}/advisor/not-a-report`)).status).toBe(404);
    const alias = await request(app).get(`${API}/advisor/reports`);
    expect(alias.body.reports).toHaveLength(19);
    expect((await request(app).post(`${API}/advisor/reports/alert-noise/generate`)).status).toBe(503);
    const mail = await request(app).post(`${API}/advisor/network_health/email`).send({});
    expect(mail.status).toBe(404); // nothing cached yet
  });
});

// ---- Round 3: sites, circuits, shadows, governance additions, config ----------

describe('logicmonitor round 3 routes', () => {
  let sid;

  function seedRound3() {
    for (const t of ['lm_webhook_events', 'lm_interface_baseline', 'lm_sites']) db.prepare(`DELETE FROM ${t}`).run();
    sid = insertSource();
    ins('lm_device_groups', { source_id: sid, lm_group_id: 1, name: 'Phoenix', full_path: 'Network/Branch/Phoenix', stale: 0 });
    const dev = (o) => ins('lm_devices', { source_id: sid, device_type: 0, host_status: 'normal', alert_status: 'none', sdt_status: 'none-none-none', is_network: 1, group_ids_json: '[1]', collector_id: 1, ...o });
    dev({ lm_device_id: 1, name: '10.1.1.1', display_name: 'phx-acc-01', role: 'switch', vendor: 'Cisco', model: 'C9300', version: '17.9.4a', ips_json: '["10.1.1.1"]' });
    dev({ lm_device_id: 2, name: '10.1.1.2', display_name: 'phx-dist-01', role: 'switch', vendor: 'Cisco', model: 'C9500', version: '17.9.4a' });
    dev({ lm_device_id: 3, name: '10.1.1.3', display_name: 'phx-rtr-01', role: 'router', vendor: 'Cisco', model: 'ISR4451', version: '17.6.5' });
    ins('lm_collectors', { source_id: sid, collector_id: 1, hostname: 'phx-col01', build: '41.000', is_down: 1, in_sdt: 0, stale: 0 });
    const ifc = (o) => ins('lm_interfaces', { source_id: sid, status: 1, status_text: 'up', speed_bps: 1000000000, stale: 0, ...o });
    ifc({ lm_device_id: 1, instance_id: 11, display_name: 'Gi1/0/48', description: 'to phx-dist-01 Gi1/0/1' });
    ifc({ lm_device_id: 2, instance_id: 20, display_name: 'Gi1/0/1' });
    ifc({ lm_device_id: 2, instance_id: 21, display_name: 'Te1/1/1', description: 'to phx-rtr-01 Gi0/0/1', status: 2, status_text: 'down' });
    ifc({ lm_device_id: 3, instance_id: 40, display_name: 'Gi0/0/1', description: 'WAN Zayo circuit 99' });
    const link = (src, inst, port, dst, dport) => ins('lm_topology_links', { source_id: sid, src_device_id: src, src_instance_id: inst, src_port: port, dst_device_id: dst, dst_port: dport, protocol: 'description', confidence: 'high', dst_platform: 'logicmonitor', stale: 0 });
    link(1, 11, 'Gi1/0/48', 2, 'Gi1/0/1');
    link(2, 21, 'Te1/1/1', 3, 'Gi0/0/1');
    ins('lm_checks', { source_id: sid, check_id: 'w:1', kind: 'ping', origin: 'website', name: 'Ping acc', target: 'phx-acc-01', is_internal: 0, stale: 0 });
    ins('lm_check_locations', { source_id: sid, check_id: 'w:1', checkpoint_id: 'c1', label: 'Dallas', is_overall: 0, last_status: 'down', last_sample_epoch: nowSec(), stale: 0 });
    ins('lm_check_locations', { source_id: sid, check_id: 'w:1', checkpoint_id: 'overall', label: 'Overall', is_overall: 1, last_status: 'down', last_sample_epoch: nowSec(), stale: 0 });
    require('../services/logicmonitorSites').computeSites(db, sid);
    require('../services/logicmonitorPath').computeTiers(db, sid);
    require('../services/logicmonitorPath').computeCircuits(db, sid);
    require('../services/logicmonitorPoller').upsertAlertRow(db, sid, {
      id: 'DS1', severity: 4, monitorObjectType: 'device', monitorObjectId: 1, monitorObjectName: 'phx-acc-01',
      resourceTemplateName: 'Host Status', instanceName: 'HostStatus', dataPointName: 'idleInterval', startEpoch: nowSec() - 120, cleared: false,
    });
    require('../services/logicmonitorIssues').computeShadows(db);
  }

  beforeEach(() => { wipe(); seedRound3(); });
  afterEach(() => { for (const t of ['lm_webhook_events', 'lm_interface_baseline', 'lm_sites']) db.prepare(`DELETE FROM ${t}`).run(); });

  it('GET /sites lists the rollup row and GET /sites/:siteKey the detail', async () => {
    const list = await request(app).get(`${API}/sites`);
    expect(list.status).toBe(200);
    expect(list.body).toHaveLength(1);
    expect(list.body[0]).toMatchObject({
      siteKey: 'phoenix', siteName: 'Phoenix', source: 'Acme Ops', deviceCount: 3, networkCount: 3, devicesDead: 0,
      interfacesDown: 1, servers: 0, state: 'critical',
      collectors: [{ id: 1, hostname: 'phx-col01', isDown: true }],
    });
    expect(list.body[0].circuits).toEqual([{ deviceName: 'phx-rtr-01', port: 'Gi0/0/1', state: 'ok', p95InPct: null, p95OutPct: null }]);
    expect(list.body[0].reachabilityIn).toEqual([expect.objectContaining({ checkName: 'Ping acc', fromLabel: 'Dallas', state: 'down' })]);
    expect(list.body[0].reachabilityOut).toEqual([]);

    const one = await request(app).get(`${API}/sites/phoenix`);
    expect(one.status).toBe(200);
    expect(one.body.devices.map((d) => d.displayName)).toEqual(['phx-acc-01', 'phx-dist-01', 'phx-rtr-01']);
    expect(one.body.devices[0]).toMatchObject({ vendor: 'Cisco', model: 'C9300', siteKey: 'phoenix' });
    expect(Array.isArray(one.body.interfacesDown)).toBe(true);
    expect(one.body.interfacesDown.map((i) => i.displayName)).toEqual(['Te1/1/1']);
    expect(one.body).toHaveProperty('openIssues');
    expect(one.body).toHaveProperty('recentChanges');
    expect(one.body.endpoints).toEqual([]);
    expect((await request(app).get(`${API}/sites/nowhere`)).status).toBe(404);
    expect((await request(app).get(`${API}/sites/Bad%20Key`)).status).toBe(400);
  });

  it('circuits: list, profile, recompute', async () => {
    const list = await request(app).get(`${API}/circuits`);
    expect(list.body).toHaveLength(1);
    expect(list.body[0]).toMatchObject({ deviceName: 'phx-rtr-01', siteKey: 'phoenix', instanceId: 40, port: 'Gi0/0/1', wanReason: 'carrier-description', state: 'ok' });
    expect((await request(app).get(`${API}/circuits?state=critical`)).body).toEqual([]);
    expect((await request(app).get(`${API}/circuits?siteKey=phoenix`)).body).toHaveLength(1);
    const prof = await request(app).get(`${API}/circuits/40/profile`);
    expect(prof.status).toBe(200);
    expect(prof.body.hours).toHaveLength(24);
    expect(prof.body.hours[0]).toEqual({ hour: 0, avgInPct: null, avgOutPct: null, maxInPct: null, maxOutPct: null });
    expect(prof.body.daily).toEqual([]);
    expect((await request(app).get(`${API}/circuits/9999/profile`)).status).toBe(404);
    const rc = await request(app).post(`${API}/circuits/recompute`);
    expect(rc.body).toEqual({ marked: 1 });
  });

  it('alerts and governance carry shadowedBy as a parsed object', async () => {
    const al = await request(app).get(`${API}/alerts`);
    expect(al.body.items[0].shadowedBy).toEqual({ deviceId: 2, deviceName: 'phx-dist-01', port: 'Te1/1/1', reason: 'port-down', sourceId: sid });
    expect((await request(app).get(`${API}/alerts?shadowed=1`)).body.total).toBe(1);
    expect((await request(app).get(`${API}/alerts?shadowed=0`)).body.total).toBe(0);
    const gov = await request(app).get(`${API}/governance`);
    expect(gov.body.shadowedAlerts).toHaveLength(1);
    expect(gov.body.shadowedAlerts[0]).toMatchObject({ id: 'DS1', datasource: 'Host Status', shadowedBy: { deviceName: 'phx-dist-01', port: 'Te1/1/1' } });
    const csv = await request(app).get(`${API}/governance.csv?section=shadowedAlerts`);
    expect(csv.text.split('\r\n')[0]).toContain('upstreamDevice');
    expect(csv.text).toContain('phx-dist-01');
  });

  it('circuit ID and carrier come from ifAlias, a circuit property or the description; a circuit ID alone marks WAN', async () => {
    const { circuitInfo } = require('../services/logicmonitorPath');
    expect(circuitInfo('L2 AT&T AVPN Ckt ID: L4YS539825..ATI 10Gbps @mpls', null))
      .toEqual({ circuitId: 'L4YS539825..ATI', carrier: 'AT&T', alias: null, source: 'description' });
    expect(circuitInfo('WAN circuit Lumen', null).circuitId).toBeNull();
    const props = JSON.stringify({ auto: { 'auto.interface.alias': 'LDCX-WAN-2 T0/1/6 LUMEN Circuit ID: 442059777 [t=p2p m=1 q=1 n=0]' }, custom: { 'circuit.id': 'OGYX/254139//ZYO', 'circuit.carrier': 'Zayo' } });
    expect(circuitInfo('ignored', props)).toMatchObject({ circuitId: 'OGYX/254139//ZYO', carrier: 'Zayo', source: 'custom:circuit.id' });
    expect(circuitInfo(null, JSON.stringify({ auto: { 'auto.interface.alias': 'Cogent DIA Ckt ID:3-001729255' } })))
      .toMatchObject({ circuitId: '3-001729255', carrier: 'Cogent', source: 'ifAlias' });

    ins('lm_interfaces', { source_id: sid, lm_device_id: 1, instance_id: 12, display_name: 'Te1/1/2', description: 'DCI CTL CKT ID:440463607 @ptp', status: 1, status_text: 'up', speed_bps: 10000000000, stale: 0 });
    const rc = await request(app).post(`${API}/circuits/recompute`);
    expect(rc.body).toEqual({ marked: 2 });
    const list = await request(app).get(`${API}/circuits`);
    const dci = list.body.find((c) => c.instanceId === 12);
    expect(dci).toMatchObject({ wanReason: 'circuit-id', circuitId: '440463607', carrier: null, circuitIdSource: 'description' });
    const ifs = await request(app).get(`${API}/interfaces?q=Te1/1/2`);
    expect(ifs.body.items[0]).toMatchObject({ circuitId: "440463607", alias: null });
  });

  it('settings/discovery and settings/export.json describe and dump the collected estate without secrets', async () => {
    ins('lm_device_datasources', { source_id: sid, lm_device_id: 1, hds_id: 5, datasource_id: 5, datasource_name: 'Cisco_CPU_SNMP', datasource_display_name: 'CPU', instance_count: 2, is_interface: 0, is_neighbor: 0 });
    ins('lm_device_datasources', { source_id: sid, lm_device_id: 1, hds_id: 6, datasource_id: 6, datasource_name: 'SNMP_Network_Interfaces', datasource_display_name: 'Interfaces', instance_count: 48, is_interface: 1, is_neighbor: 0 });
    ins('lm_device_datasources', { source_id: sid, lm_device_id: 1, hds_id: 7, datasource_id: 7, datasource_name: 'Cisco_Transceiver_Sensors', datasource_display_name: 'Optics', instance_count: 48, is_interface: 0, is_neighbor: 0 });
    db.prepare("UPDATE lm_devices SET custom_props_json = ?, system_props_json = ? WHERE lm_device_id = 1").run(
      JSON.stringify({ 'snmp.community': 'public', 'snmp.auth': 'x', 'location': 'PHX' }), JSON.stringify({ 'system.sysinfo': 'Cisco IOS' }));
    const disc = await request(app).get(`${API}/settings/discovery`);
    expect(disc.status).toBe(200);
    expect(disc.body.devicesByVendorRole).toEqual(expect.arrayContaining([expect.objectContaining({ vendor: 'Cisco', role: 'switch', devices: 2 })]));
    const ds = Object.fromEntries(disc.body.datasources.map((d) => [d.name, d.collected]));
    expect(ds).toEqual({ Cisco_CPU_SNMP: 'metrics (health)', SNMP_Network_Interfaces: 'instances + metrics', Cisco_Transceiver_Sensors: 'metrics (optics)' });
    const keys = Object.fromEntries(disc.body.devicePropertyKeys.map((k) => [k.key, k.sample]));
    expect(keys['snmp.community']).toBe('[redacted]');
    expect(keys['snmp.auth']).toBe('[redacted]');
    expect(keys.location).toBe('PHX');
    expect(disc.body.circuitCoverage).toMatchObject({ interfaces: 4, wan: 1, withCircuitId: 0 });
    expect(disc.body.devicesWithoutDatasourceInventory).toBe(2);
    // round 9: the identity block is always present (counts may be empty on a test database)
    expect(disc.body.identity).toMatchObject({ refs: expect.any(Number), byPlatform: expect.any(Object), resolvedLinksByPlatform: expect.any(Object) });

    const exp = await request(app).get(`${API}/settings/export.json`);
    expect(exp.status).toBe(200);
    expect(exp.headers['content-disposition']).toMatch(/logicmonitor-export-\d{4}-\d{2}-\d{2}\.json/);
    const body = JSON.parse(exp.text);
    expect(body.history).toBe(false);
    expect(Object.keys(body.tables)).not.toContain('lm_interface_history');
    expect(body.tables.lm_devices).toHaveLength(3);
    const dev1 = body.tables.lm_devices.find((d) => d.lm_device_id === 1);
    expect(dev1.custom_props_json).toEqual({ 'snmp.community': '[redacted]', 'snmp.auth': '[redacted]', location: 'PHX' });
    expect(body.tables.lm_sources[0]).not.toHaveProperty('encrypted_credentials');
    expect(JSON.stringify(body.tables.lm_sources)).not.toMatch(/access_id|access_key|bearer/i);
    expect(body.tables.lm_interfaces.find((i) => i.instance_id === 40).circuit).toMatchObject({ circuitId: null, carrier: 'Zayo' });
    expect(body.circuits).toHaveLength(1);
    const hist = await request(app).get(`${API}/settings/export.json?history=1`);
    expect(Object.keys(hist.body.tables)).toContain('lm_interface_history');
    expect((await request(app).get(`${API}/settings/export.json?history=2`)).status).toBe(400);
  });

  it('governance dataQuality, its score and the new CSV sections', async () => {
    const gov = await request(app).get(`${API}/governance`);
    const dq = gov.body.dataQuality;
    expect(dq.portsNoDescription).toEqual([{ deviceName: 'phx-dist-01', port: 'Gi1/0/1' }]);
    expect(dq.switchesNoNeighbors.map((r) => r.deviceName)).toEqual(['phx-acc-01', 'phx-dist-01']);
    expect(dq.devicesNoSite).toEqual([]);
    expect(dq.checksNoBaseline).toEqual([{ checkName: 'Ping acc', label: 'Dallas', samples: 0 }]); // the Overall checkpoint never counts
    expect(dq.unresolvedLinks).toBe(0);
    expect(dq.coverageScore).toBe(48);
    expect(require('../routes/logicmonitor').buildDataQuality().coverageScore).toBe(48);
    expect(gov.body.backupWindows).toEqual([]);
    for (const section of ['portsNoDescription', 'switchesNoNeighbors', 'devicesNoSite', 'checksNoBaseline', 'backupWindows', 'shadowedAlerts']) {
      const r = await request(app).get(`${API}/governance.csv?section=${section}`);
      expect(r.status, section).toBe(200);
    }
    expect((await request(app).get(`${API}/governance.csv?section=portsNoDescription`)).text).toContain('phx-dist-01,Gi1/0/1');
  });

  it('checks locations and the summary worst links carry the blame hop', async () => {
    const res = await request(app).get(`${API}/checks`);
    const loc = res.body.items[0].locations.find((l) => l.label === 'Dallas');
    expect(loc.anomaly).toBe('down');
    expect(loc.blame).toMatchObject({ deviceName: 'phx-dist-01', port: 'Te1/1/1' });
    expect(Object.keys(loc.blame).sort()).toEqual(['deviceName', 'port', 'reason']);
    expect(res.body.matrix.cells[0]).toHaveProperty('blame');
    const sum = await request(app).get(`${API}/summary`);
    expect(sum.body.worstLinks[0].blame).toMatchObject({ deviceName: 'phx-dist-01' });
    expect(sum.body.totals).toMatchObject({ sites: 1, circuits: 1, circuitsSaturated: 0, shadowed: 1 });
  });

  it('devices and interfaces carry site fields and filters; server-path adds path and blame', async () => {
    const devs = await request(app).get(`${API}/devices?siteKey=phoenix`);
    expect(devs.body.total).toBe(3);
    expect(devs.body.items.find((d) => d.displayName === 'phx-rtr-01')).toMatchObject({ siteKey: 'phoenix', siteName: 'Phoenix', tier: 4 });
    expect((await request(app).get(`${API}/devices?siteKey=other`)).body.total).toBe(0);
    const det = await request(app).get(`${API}/devices/1`);
    expect(det.body.device).toMatchObject({ siteKey: 'phoenix', siteName: 'Phoenix', tier: 1 });
    const wan = await request(app).get(`${API}/interfaces?wan=1`);
    expect(wan.body.items.map((i) => i.instanceId)).toEqual([40]);
    expect(wan.body.items[0]).toMatchObject({ siteKey: 'phoenix', isWan: true });
    expect((await request(app).get(`${API}/interfaces?siteKey=phoenix`)).body.total).toBe(4);
    const sp = await request(app).get(`${API}/server-path?name=phx-acc-01`);
    expect(sp.body.path.map((h) => h.deviceName)).toEqual(['phx-acc-01', 'phx-dist-01', 'phx-rtr-01']);
    expect(sp.body.blame).toMatchObject({ deviceName: 'phx-dist-01', state: 'critical' });
  });

  it('config returns text as strings and booleans as 1/0 strings; PUT validates and clamps', async () => {
    const g = await request(app).get(`${API}/config`);
    expect(g.body.thresholds).toMatchObject({
      lm_site_group_roots: 'Network,Sites,Locations,Branch', lm_site_property: 'site', lm_wan_overrides: '',
      lm_site_from_hostname: '1', lm_shadow_enabled: '1', lm_path_max_hops: 6, lm_circuit_sat_pct: 80, lm_webhook_rate_per_min: 600,
    });
    expect(g.body.ranges.lm_circuit_sat_pct).toEqual({ min: 50, max: 100, default: 80 });
    expect(g.body.ranges.lm_site_property).toMatchObject({ type: 'text' });
    expect(g.body.labels.lm_circuit_sat_pct).toMatch(/Circuit/);
    const put = await request(app).put(`${API}/config`).send({ lm_shadow_enabled: 0, lm_site_from_hostname: '0', lm_site_property: ' location ', lm_circuit_sat_pct: 10, lm_wan_overrides: 'a:b' });
    expect(put.status).toBe(200);
    expect(put.body.thresholds).toMatchObject({ lm_shadow_enabled: '0', lm_site_from_hostname: '0', lm_site_property: 'location', lm_circuit_sat_pct: 50, lm_wan_overrides: 'a:b' });
    expect((await request(app).put(`${API}/config`).send({ lm_shadow_enabled: 5 })).status).toBe(400);
    expect((await request(app).put(`${API}/config`).send({ lm_site_property: 12 })).status).toBe(400);
    db.prepare("DELETE FROM app_settings WHERE key LIKE 'lm_%'").run();
  });

  it('PUT /sources/:id stores siteRule and publicSource returns it parsed', async () => {
    const put = await request(app).put(`${API}/sources/${sid}`).send({ siteRule: { roots: ['Branch'], property: 'loc', fromHostname: false } });
    expect(put.status).toBe(200);
    expect(put.body.siteRule).toEqual({ roots: ['Branch'], property: 'loc', fromHostname: false });
    expect((await request(app).get(`${API}/sources`)).body[0].siteRule).toEqual({ roots: ['Branch'], property: 'loc', fromHostname: false });
    expect(JSON.parse(db.prepare('SELECT site_rule_json FROM lm_sources WHERE id = ?').get(sid).site_rule_json).roots).toEqual(['Branch']);
    // the rule is applied at once: "Network/Branch/Phoenix" still yields phoenix
    expect(db.prepare('SELECT site_key FROM lm_devices WHERE lm_device_id = 1').get().site_key).toBe('phoenix');
    const cleared = await request(app).put(`${API}/sources/${sid}`).send({ siteRule: null });
    expect(cleared.body.siteRule).toBe(null);
  });
});

describe('logicmonitor round 4 routes: Correlation', () => {
  let sid;
  const R4_TABLES = ['lm_blame_history', 'lm_sites', 'config_changes', 'replication_runs', 'protection_runs', 'cohesity_objects', 'clusters'];
  const cleanR4 = () => { for (const t of R4_TABLES) db.prepare(`DELETE FROM ${t}`).run(); };

  function seedRound4() {
    sid = insertSource();
    ins('lm_device_groups', { source_id: sid, lm_group_id: 1, name: 'Phoenix', full_path: 'Network/Branch/Phoenix', stale: 0 });
    const dev = (o) => ins('lm_devices', { source_id: sid, device_type: 0, host_status: 'normal', alert_status: 'none', sdt_status: 'none-none-none', is_network: 1, group_ids_json: '[1]', ...o });
    dev({ lm_device_id: 1, name: '10.1.1.1', display_name: 'phx-acc-01', role: 'switch', vendor: 'Cisco' });
    dev({ lm_device_id: 2, name: '10.1.1.2', display_name: 'phx-dist-01', role: 'switch', vendor: 'Cisco' });
    dev({ lm_device_id: 3, name: '10.1.1.3', display_name: 'phx-rtr-01', role: 'router', vendor: 'Cisco' });
    const ifc = (o) => ins('lm_interfaces', { source_id: sid, status: 1, status_text: 'up', speed_bps: 1000000000, stale: 0, ...o });
    ifc({ lm_device_id: 1, instance_id: 11, display_name: 'Gi1/0/7' });
    ifc({ lm_device_id: 1, instance_id: 12, display_name: 'Gi1/0/48', description: 'to phx-dist-01 Gi1/0/1' });
    ifc({ lm_device_id: 2, instance_id: 20, display_name: 'Gi1/0/1' });
    ifc({ lm_device_id: 2, instance_id: 21, display_name: 'Te1/1/1', description: 'to phx-rtr-01 Gi0/0/1', status: 2, status_text: 'down' });
    ifc({ lm_device_id: 3, instance_id: 40, display_name: 'Gi0/0/1' });
    const link = (src, inst, port, dst, dport, extra = {}) => ins('lm_topology_links', {
      source_id: sid, src_device_id: src, src_instance_id: inst, src_port: port, dst_device_id: dst, dst_port: dport,
      protocol: 'description', confidence: 'high', dst_platform: 'logicmonitor', stale: 0, ...extra,
    });
    link(1, 12, 'Gi1/0/48', 2, 'Gi1/0/1');
    link(2, 21, 'Te1/1/1', 3, 'Gi0/0/1');
    link(1, 11, 'Gi1/0/7', null, null, { dst_platform: 'dell', dst_ref: 'db-srv9', dst_name: 'db-srv9', last_seen: sqlTs(MIN) });
    require('../services/logicmonitorSites').computeSites(db, sid);
    require('../services/logicmonitorPath').computeTiers(db, sid);

    // two overlapping runs of one server, equal bytes, port busy during them
    const clusterId = ins('clusters', { name: 'cg-clu1', connection_type: 'direct', auth_type: 'apikey', encrypted_credentials: 'x' });
    const run = (job, jobId, startAgo, endAgo) => ins('protection_runs', {
      cluster_id: clusterId, job_id: jobId, job_name: job, status: 'kSuccess', logical_bytes: 500,
      start_time: new Date(Date.now() - startAgo).toISOString(), end_time: new Date(Date.now() - endAgo).toISOString(),
    });
    run('JobA', 1, 2 * HOUR, HOUR);
    run('JobB', 2, 110 * MIN, 70 * MIN);
    ins('cohesity_objects', { cluster_id: clusterId, name: 'db-srv9', protection_groups: JSON.stringify(['JobA', 'JobB']) });
    for (let m = 115; m >= 65; m -= 10) ins('lm_interface_history', { source_id: sid, instance_id: 11, captured_at: sqlTs(m * MIN), status: 1, in_util_pct: 90, out_util_pct: 5 });

    ins('config_changes', { platform: 'logicmonitor', scope: 'device-inventory', system: 'phx-dist-01', item: 'Te1/1/1 description', change_type: 'changed',
      old_value: 'a', new_value: 'b', detected_at: new Date(Date.now() - 3 * HOUR).toISOString() });
    ins('lm_issue_history', { issue_key: 'interface-flapping|Acme Ops|phx-dist-01 Te1/1/1', source: 'Acme Ops', severity: 'warning', type: 'interface-flapping',
      target: 'phx-dist-01 Te1/1/1', message: 'flapping', status: 'open', first_seen: sqlTs(2 * HOUR) });
    const corr = require('../services/logicmonitorCorrelation');
    const hop = { deviceId: 2, deviceName: 'phx-dist-01', port: 'Te1/1/1', state: 'critical', reason: 'port Te1/1/1 on phx-dist-01 is down' };
    corr.recordBlame(db, { sourceId: sid, kind: 'check', subject: 'Ping acc', subjectKey: 'w:1', blame: hop, at: sqlTs(HOUR) });
    corr.recordBlame(db, { sourceId: sid, kind: 'check', subject: 'Ping acc', subjectKey: 'w:1', blame: hop, at: sqlTs(2 * HOUR), issueKey: 'x' });
  }

  beforeEach(() => { wipe(); cleanR4(); seedRound4(); });
  afterEach(() => cleanR4());

  it('GET /correlation returns the four sections and generatedAt', async () => {
    const res = await request(app).get(`${API}/correlation`);
    expect(res.status).toBe(200);
    expect(Object.keys(res.body).sort()).toEqual(['backupLoad', 'blameHistory', 'changesThenIncidents', 'generatedAt', 'replicationVsCircuits', 'snapmirror']);
    expect(res.body.generatedAt).toMatch(/Z$/);
    expect(res.body.backupLoad).toHaveLength(1);
    expect(res.body.backupLoad[0]).toMatchObject({
      deviceName: 'phx-acc-01', port: 'Gi1/0/7', host: 'db-srv9', hostPlatform: 'dell', uplinkRule: 'physical', side: 'client', runCount: 2, finding: 'saturates', meanUtilPct: 90,
    });
    expect(res.body.backupLoad[0].runs.map((r) => [r.jobName, r.sharePct])).toEqual([['JobA', 50], ['JobB', 50]]);
    expect(res.body.replicationVsCircuits).toEqual([]);
    expect(res.body.changesThenIncidents).toHaveLength(1);
    expect(res.body.changesThenIncidents[0]).toMatchObject({ system: 'phx-dist-01', siteKey: 'phoenix', incident: { type: 'interface-flapping', minutesAfter: 60 } });
    expect(Object.keys(res.body.blameHistory).sort()).toEqual(['hops', 'recent']);
    expect(res.body.blameHistory.hops[0]).toMatchObject({ deviceName: 'phx-dist-01', port: 'Te1/1/1', count: 2, siteKey: 'phoenix' });
    expect(res.body.blameHistory.recent).toHaveLength(2);
  });

  it('GET /correlation.csv serves each section and rejects an unknown one', async () => {
    const bl = await request(app).get(`${API}/correlation.csv?section=backupLoad`);
    expect(bl.status).toBe(200);
    expect(bl.headers['content-type']).toMatch(/text\/csv/);
    const lines = bl.text.trim().split(/\r\n/);
    expect(lines[0]).toBe('deviceName,port,host,hostPlatform,windowStart,windowEnd,meanUtilPct,maxUtilPct,baselineUtilPct,finding,uplinkRule,side,runCount,runs');
    expect(lines).toHaveLength(2);
    expect(lines[1]).toContain('phx-acc-01,Gi1/0/7,db-srv9,dell');
    expect(lines[1]).toContain('JobA (50%); JobB (50%)');
    const ch = await request(app).get(`${API}/correlation.csv?section=changesThenIncidents`);
    expect(ch.text.trim().split(/\r\n/)[1]).toContain('phx-dist-01,device-inventory,Te1/1/1 description,changed,a,b');
    const hops = await request(app).get(`${API}/correlation.csv?section=blameHops`);
    expect(hops.text.trim().split(/\r\n/)[1]).toContain('phx-dist-01,Te1/1/1,phoenix,2');
    expect(hops.text).toContain('check: Ping acc (2)');
    expect((await request(app).get(`${API}/correlation.csv?section=blameRecent`)).text.trim().split(/\r\n/)).toHaveLength(3);
    expect((await request(app).get(`${API}/correlation.csv?section=replicationVsCircuits`)).status).toBe(200);
    expect((await request(app).get(`${API}/correlation.csv?section=nope`)).status).toBe(400);
  });

  it('device endpoints carry backupRuns7d and backupLastWindow; Site 360 carries correlation counts', async () => {
    const dev = await request(app).get(`${API}/devices/1`);
    expect(dev.status).toBe(200);
    const ep = dev.body.endpoints.find((e) => e.endpoint === 'db-srv9');
    expect(ep).toMatchObject({ port: 'Gi1/0/7', backupRuns7d: 1 });
    expect(ep.backupLastWindow).toMatch(/Z$/);
    const quiet = await request(app).get(`${API}/devices/2`);
    expect(quiet.body.endpoints).toEqual([]);
    const site = await request(app).get(`${API}/sites/phoenix`);
    expect(site.status).toBe(200);
    expect(site.body.correlation).toEqual({ backupLoad: 1, replication: 0, changes: 1, blames: 2 });
  });

  it('GET /server-path records a server blame once per hour for an unhealthy hop', async () => {
    const first = await request(app).get(`${API}/server-path?name=db-srv9`);
    expect(first.status).toBe(200);
    expect(first.body.blame).toMatchObject({ deviceName: 'phx-dist-01', port: 'Te1/1/1', state: 'critical' });
    const rows = () => db.prepare("SELECT * FROM lm_blame_history WHERE kind = 'server'").all();
    expect(rows()).toHaveLength(1);
    expect(rows()[0]).toMatchObject({ subject: 'db-srv9', subject_key: 'db-srv9', hop_device_name: 'phx-dist-01', hop_port: 'Te1/1/1', site_key: 'phoenix' });
    await request(app).get(`${API}/server-path?name=db-srv9`);
    expect(rows()).toHaveLength(1);
  });
});

// ---- Round 8: DataSource metrics, firewalls, load balancers ------------------

describe('logicmonitor round 8 routes: metrics, firewalls, load balancers', () => {
  let sid8;
  const hdsOf = new Map();
  let hdsSeq8 = 5000;

  function dev8(id, name, over = {}) {
    return ins('lm_devices', {
      source_id: sid8, lm_device_id: id, name, display_name: name, device_type: 0, host_status: 'normal', alert_status: 'none',
      sdt_status: 'none-none-none', vendor: over.vendor || 'Cisco', role: over.role || 'switch', is_network: 1, model: over.model || null,
      version: over.version || null, site_key: over.site || 'phoenix', site_name: over.siteName || 'Phoenix DC', ips_json: '[]', stale: 0,
    });
  }
  // Sets one metric on one instance (instance row created once).
  function met(devId, ds, family, inst, metric, value, extra = {}) {
    const hk = `${devId}|${ds}`;
    if (!hdsOf.has(hk)) { hdsSeq8 += 1; hdsOf.set(hk, hdsSeq8); }
    const hds = hdsOf.get(hk);
    db.prepare(`INSERT OR IGNORE INTO lm_ds_instances (source_id, lm_device_id, hds_id, datasource_name, family, instance_key, instance_name, stale)
      VALUES (?, ?, ?, ?, ?, ?, ?, 0)`).run(sid8, devId, hds, ds, family, inst, extra.name || inst);
    db.prepare(`INSERT OR REPLACE INTO lm_ds_metrics (source_id, lm_device_id, hds_id, datasource_name, family, instance_key, metric, datapoint, value, sampled_at_epoch)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(sid8, devId, hds, ds, family, inst, metric, extra.datapoint || metric, value, nowSec() - 120);
    return hds;
  }
  function hist8(devId, hds, inst, metric, points) {
    const stmt = db.prepare('INSERT INTO lm_ds_metrics_history (source_id, lm_device_id, hds_id, instance_key, metric, value, sampled_at_epoch) VALUES (?, ?, ?, ?, ?, ?, ?)');
    for (const [ageSec, v] of points) stmt.run(sid8, devId, hds, inst, metric, v, nowSec() - ageSec);
  }

  beforeEach(() => {
    wipe();
    hdsOf.clear();
    sid8 = insertSource();
    // Firewalls.
    dev8(201, 'phx-fw-01', { vendor: 'Palo Alto', role: 'firewall', model: 'PA-5220', version: '10.2.9' });
    dev8(202, 'phx-fw-02', { vendor: 'Palo Alto', role: 'firewall', model: 'PA-5220', version: '10.2.9' });
    dev8(203, 'den-asa-01', { vendor: 'Cisco', role: 'firewall', model: 'ASA5525', site: 'denver', siteName: 'Denver' });
    dev8(299, 'phx-core-01', { vendor: 'Cisco', role: 'switch' });
    met(201, 'PaloAlto_FW_HA_Status', 'firewall', 'ha', 'ha_enabled', 1);
    met(201, 'PaloAlto_FW_HA_Status', 'firewall', 'ha', 'ha_local_state', 1);
    met(201, 'PaloAlto_FW_HA_Status', 'firewall', 'ha', 'ha_peer_state', 5);
    met(201, 'PaloAlto_FW_HA_Interface', 'firewall', 'HA1', 'ha_if_state', 1);
    met(201, 'PaloAlto_FW_HA_Interface', 'firewall', 'HA2', 'ha_if_state', 0);
    const hs = met(201, 'PaloAlto_FW_GlobalSessions', 'firewall', 'g', 'sessions_active', 87000);
    met(201, 'PaloAlto_FW_GlobalSessions', 'firewall', 'g', 'sessions_max', 100000);
    met(201, 'PaloAlto_FW_GlobalSessions', 'firewall', 'g', 'sessions_util_pct', 87);
    hist8(201, hs, 'g', 'sessions_util_pct', [[7200, 60], [5400, 70], [600, 87]]);
    hist8(201, hs, 'g', 'sessions_active', [[7200, 60000], [600, 87000]]);
    met(201, 'PaloAlto_FW_DataplaneCores', 'firewall', 'core0', 'core_cpu_pct', 40);
    met(201, 'PaloAlto_FW_DataplaneCores', 'firewall', 'core1', 'core_cpu_pct', 66.66);
    met(201, 'PaloAlto_FW_SystemResources', 'firewall', 'sys', 'mgmt_cpu_pct', 30);
    met(201, 'PaloAlto_FW_SystemResources', 'firewall', 'sys', 'mem_pct', 51);
    met(201, 'PaloAlto_FW_IPSecTunnelStats', 'firewall', 'Appian_proxy1', 'tunnel_state', 0);
    met(201, 'PaloAlto_FW_IPSecTunnelStats', 'firewall', 'Appian_proxy1', 'tunnel_in_bps', 1000);
    met(201, 'PaloAlto_FW_IPSecTunnelStats', 'firewall', 'Zayo_proxy2', 'tunnel_state', 1);
    met(201, 'PaloAlto_FW_IPSecTunnelStats', 'firewall', 'Zayo_proxy2', 'tunnel_in_bps', 5000);
    met(201, 'PaloAlto_FW_IPSecTunnelStats', 'firewall', 'Zayo_proxy2', 'tunnel_out_bps', 6000);
    met(201, 'PaloAlto_GlobalProtect_Gateway', 'firewall', 'gw1', 'gp_users_active', 14);
    met(201, 'PaloAlto_GlobalProtect_Gateway', 'firewall', 'gw1', 'gp_users_max', 500);
    met(201, 'PaloAlto_FW_Zones', 'firewall', 'trust', 'zone_in_bps', 100);
    met(201, 'PaloAlto_FW_Zones', 'firewall', 'trust', 'zone_sessions', 4000);
    met(201, 'PaloAlto_FW_Disk', 'firewall', '/', 'disk_used_pct', 33);
    met(201, 'PaloAlto_FW_Power', 'firewall', 'PSU1', 'psu_state', 1);
    met(201, 'PaloAlto_FW_Temperature', 'firewall', 'Ambient', 'temp_c', 31);
    met(201, 'PaloAlto_FW_BGP', 'firewall', 'peer1', 'bgp_peer_state', 6);
    met(201, 'PaloAlto_FW_BGP', 'firewall', 'peer1', 'bgp_prefixes', 12);
    met(202, 'PaloAlto_FW_HA_Status', 'firewall', 'ha', 'ha_enabled', 1);
    met(202, 'PaloAlto_FW_HA_Status', 'firewall', 'ha', 'ha_local_state', 2);
    met(202, 'PaloAlto_FW_HA_Status', 'firewall', 'ha', 'ha_peer_state', 1);
    met(202, 'PaloAlto_FW_Config_Synced', 'firewall', 'c', 'config_synced', 0);
    met(203, 'CiscoASA', 'firewall', 'asa', 'asa_cpu_pct', 22);
    met(203, 'CiscoASA', 'firewall', 'asa', 'asa_mem_pct', 41);
    // Load balancers.
    dev8(301, 'phx-f5-01', { vendor: 'F5', role: 'load-balancer', model: 'BIG-IP i5800', version: '17.1.1' });
    dev8(302, 'phx-f5-02', { vendor: 'F5', role: 'load-balancer', model: 'BIG-IP i5800', version: '17.1.1' });
    met(301, 'F5_BigIP_FailoverStatus', 'loadbalancer', 'f', 'failover_state', 4);
    met(301, 'F5_BigIP_FailoverStatus', 'loadbalancer', 'f', 'sync_state', 3);
    met(302, 'F5_BigIP_FailoverStatus', 'loadbalancer', 'f', 'failover_state', 3);
    const sysH = met(301, 'F5_BigIP_System', 'loadbalancer', 'sys', 'cpu_pct', 22);
    met(301, 'F5_BigIP_System', 'loadbalancer', 'sys', 'mem_pct', 61);
    met(301, 'F5_BigIP_System', 'loadbalancer', 'sys', 'client_connections', 1200);
    met(301, 'F5_BigIP_System', 'loadbalancer', 'sys', 'server_connections', 1100);
    hist8(301, sysH, 'sys', 'cpu_pct', [[7200, 10], [600, 22]]);
    for (let i = 1; i <= 3; i += 1) met(301, 'F5_BigIP_PoolMemberStats', 'loadbalancer', `app-payments/10.0.0.${i}:443`, 'member_avail', 3);
    for (let i = 1; i <= 4; i += 1) {
      met(301, 'F5_BigIP_PoolMemberStats', 'loadbalancer', `web-portal/10.0.1.${i}:443`, 'member_avail', i === 1 ? 3 : 1);
      met(301, 'F5_BigIP_PoolMemberStats', 'loadbalancer', `web-portal/10.0.1.${i}:443`, 'member_connections', 10 * i);
    }
    met(301, 'F5_GTM_WideIP-', 'loadbalancer', 'pay.example.com', 'wideip_avail', 1);
    met(301, 'F5_GTM_WideIP-', 'loadbalancer', 'old.example.com', 'wideip_avail', 3);
    for (let i = 1; i <= 3; i += 1) met(301, 'F5_GTM_VIPs-', 'loadbalancer', `vip${i}`, 'vip_avail', i === 3 ? 3 : 1);
    met(301, 'f5_mcpd_service_status', 'loadbalancer', 'mcpd', 'daemon_state', 1);
    met(301, 'f5_tmm_service_status', 'loadbalancer', 'tmm', 'daemon_state', 0);
    met(301, 'F5_BigIP_SSL_VIP_Certs', 'loadbalancer', 'www.example.com', 'cert_days_left', 12);
    met(301, 'F5_BigIP_SSL_VIP_Certs', 'loadbalancer', 'api.example.com', 'cert_days_left', 300);
    met(301, 'F5_BigIP_Interfaces', 'loadbalancer', '1.1', 'if_status', 1);
    met(301, 'F5_BigIP_Interfaces', 'loadbalancer', '1.1', 'if_in_bps', 5000);
    // Health on the core switch.
    met(299, 'Cisco_CPU_SNMP', 'health', 'c1', 'cpu_pct', 91);
    met(299, 'Cisco_FRU_Power', 'health', 'PS2', 'psu_state', 3);
    ins('lm_device_datasources', { source_id: sid8, lm_device_id: 201, hds_id: hdsOf.get('201|PaloAlto_FW_GlobalSessions'), datasource_id: 1, datasource_name: 'PaloAlto_FW_GlobalSessions', datasource_display_name: 'PAN sessions', instance_count: 1, metrics_last_at: sqlTs(5 * MIN) });
  });
  afterEach(() => { wipe(); });

  it('GET /metrics/families lists every catalog family with inventory and collected counts', async () => {
    ins('lm_device_datasources', { source_id: sid8, lm_device_id: 301, hds_id: 9001, datasource_id: 2, datasource_name: 'F5_BigIP_System', datasource_display_name: 'F5 system', instance_count: 1, is_interface: 0, is_neighbor: 0 });
    const res = await request(app).get(`${API}/metrics/families`);
    expect(res.status).toBe(200);
    expect(res.body.map((f) => f.family)).toEqual(['firewall', 'loadbalancer', 'health', 'optics', 'routing', 'ipsla', 'voice', 'wireless', 'cloud', 'cohesity']);
    const fw = res.body.find((f) => f.family === 'firewall');
    expect(fw).toMatchObject({ label: 'Firewalls', enabled: true, datasources: 1, devices: 1, instances: 1, collectedDevices: 3 });
    expect(Object.keys(fw)).toEqual(expect.arrayContaining(['family', 'label', 'enabled', 'sources', 'datasources', 'devices', 'instances', 'collectedInstances', 'lastPollAt']));
    expect(fw.lastPollAt).toMatch(/Z$/);
    expect(res.body.find((f) => f.family === 'loadbalancer')).toMatchObject({ datasources: 1, devices: 1 });
    // A family switched off on the only source reads disabled.
    db.prepare('UPDATE lm_sources SET metrics_families_json = ? WHERE id = ?').run(JSON.stringify(['health']), sid8);
    const off = await request(app).get(`${API}/metrics/families`);
    expect(off.body.find((f) => f.family === 'firewall').enabled).toBe(false);
    expect(off.body.find((f) => f.family === 'health').enabled).toBe(true);
  });

  it('GET /firewalls returns one row per firewall with the rolled-up figures and a state from the issues', async () => {
    const res = await request(app).get(`${API}/firewalls`);
    expect(res.status).toBe(200);
    expect(res.body.map((r) => r.deviceName)).toEqual(['den-asa-01', 'phx-fw-01', 'phx-fw-02']);
    const a = res.body.find((r) => r.deviceName === 'phx-fw-01');
    expect(a).toMatchObject({
      deviceId: 201, sourceId: sid8, siteKey: 'phoenix', vendor: 'Palo Alto', model: 'PA-5220', version: '10.2.9',
      haEnabled: true, haLocalState: 'active', haPeerState: 'non-functional', haText: 'active / non-functional',
      sessionsActive: 87000, sessionsMax: 100000, sessionsUtilPct: 87, dataplaneCpuPct: 66.7, mgmtCpuPct: 30, memPct: 51,
      tunnelsUp: 1, tunnelsDown: 1, gpUsers: 14, configSynced: null, state: 'critical',
    });
    expect(a.sampledAt).toMatch(/Z$/);
    const b = res.body.find((r) => r.deviceName === 'phx-fw-02');
    expect(b).toMatchObject({ haText: 'passive / active', configSynced: false, state: 'ok' });
    const asa = res.body.find((r) => r.deviceName === 'den-asa-01');
    expect(asa).toMatchObject({ mgmtCpuPct: 22, memPct: 41, haEnabled: false, haText: null, state: 'ok' });
    expect(res.body.some((r) => r.deviceName === 'phx-core-01')).toBe(false);
    for (const k of ['threatsPerHour', 'droppedPerMin', 'siteName', 'hostStatus']) expect(a).toHaveProperty(k);
  });

  it('GET /firewalls filters by q, siteKey, vendor and state', async () => {
    expect((await request(app).get(`${API}/firewalls?q=asa`)).body.map((r) => r.deviceName)).toEqual(['den-asa-01']);
    expect((await request(app).get(`${API}/firewalls?siteKey=denver`)).body.map((r) => r.deviceName)).toEqual(['den-asa-01']);
    expect((await request(app).get(`${API}/firewalls?vendor=Palo%20Alto`)).body).toHaveLength(2);
    expect((await request(app).get(`${API}/firewalls?state=critical`)).body.map((r) => r.deviceName)).toEqual(['phx-fw-01']);
    expect((await request(app).get(`${API}/firewalls?state=bogus`)).status).toBe(400);
  });

  it('GET /firewalls.csv has the header row and one line per firewall', async () => {
    const res = await request(app).get(`${API}/firewalls.csv`);
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toContain('text/csv');
    const lines = res.text.trim().split(/\r\n/);
    expect(lines[0]).toBe('deviceName,siteName,vendor,model,version,hostStatus,haText,sessionsActive,sessionsMax,sessionsUtilPct,dataplaneCpuPct,mgmtCpuPct,memPct,tunnelsUp,tunnelsDown,gpUsers,configSynced,threatsPerHour,droppedPerMin,state,sampledAt');
    expect(lines).toHaveLength(4);
  });

  it('threatsPerHour comes from monotonic counter history and stays null otherwise', async () => {
    const h = hdsOf.get('201|PaloAlto_FW_GlobalSessions');
    hist8(201, h, 'g', 'threats_total', [[7200, 1000], [3600, 1600], [0, 2200]]);
    const a = (await request(app).get(`${API}/firewalls`)).body.find((r) => r.deviceName === 'phx-fw-01');
    expect(a.threatsPerHour).toBe(600);
    expect(a.droppedPerMin).toBeNull();
  });

  it('GET /firewalls/:deviceId returns the 360 sections and 404s for a non-firewall', async () => {
    const res = await request(app).get(`${API}/firewalls/201`);
    expect(res.status).toBe(200);
    expect(Object.keys(res.body)).toEqual(expect.arrayContaining(['device', 'summary', 'ha', 'tunnels', 'zones', 'vsys', 'globalProtect', 'logForwarding', 'hardware', 'routing', 'sessionsHistory', 'issues']));
    expect(res.body.summary.deviceName).toBe('phx-fw-01');
    expect(res.body.ha).toEqual([{ name: 'HA1', state: 'up', raw: 1 }, { name: 'HA2', state: 'down', raw: 0 }]);
    expect(res.body.tunnels).toEqual([
      { name: 'Appian_proxy1', state: 'down', stateRaw: 0, inBps: 1000, outBps: null },
      { name: 'Zayo_proxy2', state: 'up', stateRaw: 1, inBps: 5000, outBps: 6000 },
    ]);
    expect(res.body.zones).toEqual([{ name: 'trust', inBps: 100, outBps: null, sessions: 4000 }]);
    expect(res.body.globalProtect).toMatchObject({ users: 14, maxUsers: 500, gateways: [{ name: 'gw1', users: 14, maxUsers: 500, tunnels: null }] });
    expect(res.body.hardware).toMatchObject({ disks: [{ name: '/', usedPct: 33 }], psus: [{ name: 'PSU1', state: 1, ok: true }], temps: [{ name: 'Ambient', tempC: 31, alarm: null }], chassisWatts: null });
    expect(res.body.routing.bgp).toEqual([{ name: 'peer1', state: 6, established: true, prefixes: 12 }]);
    expect(res.body.routing.ospf).toEqual([]);
    expect(res.body.sessionsHistory.utilPct.map((p) => p.value)).toEqual([60, 70, 87]);
    expect(res.body.sessionsHistory.active.map((p) => p.value)).toEqual([60000, 87000]);
    expect(res.body.issues.map((i) => i.type).sort()).toEqual(['fw-ha-degraded', 'fw-session-high', 'fw-tunnel-down']);
    expect((await request(app).get(`${API}/firewalls/299`)).status).toBe(404);
    expect((await request(app).get(`${API}/firewalls/9999`)).status).toBe(404);
    expect((await request(app).get(`${API}/firewalls/abc`)).status).toBe(400);
  });

  it('GET /load-balancers rolls pools, members, wide IPs, VIPs, daemons and certificates up per F5', async () => {
    const res = await request(app).get(`${API}/load-balancers`);
    expect(res.status).toBe(200);
    expect(res.body.map((r) => r.deviceName)).toEqual(['phx-f5-01', 'phx-f5-02']);
    const a = res.body[0];
    expect(a).toMatchObject({
      deviceId: 301, failoverState: 4, failoverText: 'active', syncState: 'in sync', cpuPct: 22, memPct: 61,
      clientConnections: 1200, serverConnections: 1100, pools: 2, poolsDegraded: 2, membersTotal: 7, membersDown: 4,
      wideIps: 2, wideIpsDown: 1, vips: 3, vipsDown: 1, daemonsDown: 1, certsExpiring: 1, state: 'critical',
    });
    expect(res.body[1]).toMatchObject({ failoverText: 'standby', state: 'ok', pools: 0 });
    expect((await request(app).get(`${API}/load-balancers?state=ok`)).body.map((r) => r.deviceName)).toEqual(['phx-f5-02']);
    const csv = await request(app).get(`${API}/load-balancers.csv`);
    expect(csv.text.split(/\r\n/)[0]).toBe('deviceName,siteName,vendor,model,version,hostStatus,failoverText,syncState,cpuPct,memPct,clientConnections,serverConnections,pools,poolsDegraded,membersTotal,membersDown,wideIps,wideIpsDown,vips,vipsDown,daemonsDown,certsExpiring,state,sampledAt');
  });

  it('GET /load-balancers/:deviceId groups pool members from the instance key and pages the VIPs', async () => {
    const res = await request(app).get(`${API}/load-balancers/301?limit=2`);
    expect(res.status).toBe(200);
    expect(Object.keys(res.body)).toEqual(expect.arrayContaining(['device', 'summary', 'pools', 'wideIps', 'vips', 'gtmServers', 'datacenters', 'daemons', 'certs', 'hardware', 'interfaces', 'cpuHistory', 'connectionsHistory', 'issues']));
    expect(res.body.pools.map((p) => [p.pool, p.up, p.down, p.members.length])).toEqual([['app-payments', 0, 3, 3], ['web-portal', 3, 1, 4]]);
    const web = res.body.pools.find((p) => p.pool === 'web-portal');
    expect(web.members[0]).toMatchObject({ member: '10.0.1.1:443', key: 'web-portal/10.0.1.1:443', avail: 'down', availRaw: 3, connections: 10 });
    expect(web.members[1]).toMatchObject({ avail: 'up' });
    expect(res.body.wideIps).toEqual([
      { name: 'old.example.com', avail: 'down', availRaw: 3, requests: null },
      { name: 'pay.example.com', avail: 'up', availRaw: 1, requests: null },
    ]);
    expect(res.body.vips).toMatchObject({ total: 3, page: 1, limit: 2 });
    expect(res.body.vips.items).toHaveLength(2);
    expect(res.body.daemons).toEqual([{ name: 'mcpd', state: 'running', raw: 1 }, { name: 'tmm', state: 'down', raw: 0 }]);
    expect(res.body.certs).toEqual([{ name: 'www.example.com', daysLeft: 12 }, { name: 'api.example.com', daysLeft: 300 }]);
    expect(res.body.cpuHistory.map((p) => p.value)).toEqual([10, 22]);
    expect(res.body.interfaces).toEqual([{ name: '1.1', status: 1, inBps: 5000, outBps: null }]);
    const page2 = await request(app).get(`${API}/load-balancers/301?limit=2&page=2`);
    expect(page2.body.vips.items).toHaveLength(1);
    expect((await request(app).get(`${API}/load-balancers/299`)).status).toBe(404);
  });

  it('GET /devices/:deviceId/metrics groups the device by family and DataSource with catalog units', async () => {
    const res = await request(app).get(`${API}/devices/301/metrics`);
    expect(res.status).toBe(200);
    expect(res.body.families.map((f) => f.family)).toEqual(['loadbalancer']);
    const lb = res.body.families[0];
    expect(lb.label).toBe('Load balancers');
    const sys = lb.datasources.find((d) => d.name === 'F5_BigIP_System');
    expect(sys).toMatchObject({ hdsId: hdsOf.get('301|F5_BigIP_System'), instanceCount: 1 });
    expect(sys.lastAt).toMatch(/Z$/);
    expect(sys.instances[0]).toMatchObject({ key: 'sys', name: 'sys' });
    expect(sys.instances[0].metrics.cpu_pct).toMatchObject({ value: 22, datapoint: 'cpu_pct' });
    expect(Object.keys(sys.instances[0].metrics.cpu_pct)).toEqual(expect.arrayContaining(['value', 'unit', 'kind', 'datapoint', 'epoch']));
    const core = await request(app).get(`${API}/devices/299/metrics`);
    expect(core.body.families.map((f) => f.family)).toEqual(['health']);
    expect((await request(app).get(`${API}/devices/777/metrics`)).status).toBe(404);
    db.prepare('DELETE FROM lm_ds_metrics WHERE lm_device_id = 302').run();
    expect((await request(app).get(`${API}/devices/302/metrics`)).body).toEqual({ families: [] });
  });

  it('GET /metrics/history returns the series, 400s on a missing parameter, and [] for an unknown instance', async () => {
    const h = hdsOf.get('201|PaloAlto_FW_GlobalSessions');
    const res = await request(app).get(`${API}/metrics/history?deviceId=201&hdsId=${h}&instanceKey=g&metric=sessions_util_pct&hours=3`);
    expect(res.status).toBe(200);
    expect(res.body.map((p) => p.value)).toEqual([60, 70, 87]);
    expect(Object.keys(res.body[0]).sort()).toEqual(['epoch', 'value']);
    const short = await request(app).get(`${API}/metrics/history?deviceId=201&hdsId=${h}&instanceKey=g&metric=sessions_util_pct&hours=1`);
    expect(short.body.map((p) => p.value)).toEqual([87]);
    expect((await request(app).get(`${API}/metrics/history?deviceId=201&hdsId=${h}&metric=sessions_util_pct`)).status).toBe(400);
    expect((await request(app).get(`${API}/metrics/history?hdsId=${h}&instanceKey=g&metric=sessions_util_pct`)).status).toBe(400);
    expect((await request(app).get(`${API}/metrics/history?deviceId=201&hdsId=${h}&instanceKey=g&metric=sessions_util_pct&hours=500`)).status).toBe(400);
    expect((await request(app).get(`${API}/metrics/history?deviceId=999&hdsId=1&instanceKey=x&metric=cpu_pct`)).body).toEqual([]);
  });

  it('sources round-trip metricsPollMinutes and metricsFamilies', async () => {
    const created = await request(app).post(`${API}/sources`).send({
      name: 'Beta', company: 'beta', accessId: 'AID', accessKey: 'KEY', metricsPollMinutes: 60, metricsFamilies: ['firewall', 'health'],
    });
    expect(created.status).toBe(201);
    expect(created.body).toMatchObject({ metricsPollMinutes: 60, metricsFamilies: ['firewall', 'health'] });
    const dflt = await request(app).post(`${API}/sources`).send({ name: 'Gamma', company: 'gamma', accessId: 'AID', accessKey: 'KEY' });
    expect(dflt.body).toMatchObject({ metricsPollMinutes: 30, metricsFamilies: null });
    const put = await request(app).put(`${API}/sources/${created.body.id}`).send({ metricsPollMinutes: 15, metricsFamilies: null });
    expect(put.status).toBe(200);
    expect(put.body).toMatchObject({ metricsPollMinutes: 15, metricsFamilies: null });
    const keep = await request(app).put(`${API}/sources/${created.body.id}`).send({ name: 'Beta2' });
    expect(keep.body).toMatchObject({ metricsPollMinutes: 15, metricsFamilies: null });
    const list = (await request(app).get(`${API}/sources`)).body.find((s) => s.id === created.body.id);
    expect(list.metricsPollMinutes).toBe(15);
    expect((await request(app).put(`${API}/sources/${created.body.id}`).send({ metricsPollMinutes: 2 })).status).toBe(400);
    expect((await request(app).put(`${API}/sources/${created.body.id}`).send({ metricsFamilies: ['nonsense'] })).status).toBe(400);
  });

  it('POST /metrics/poll triggers the metrics tier for one source or all enabled sources', async () => {
    const trig = vi.fn(() => Promise.resolve());
    handle.triggerMetrics = trig;
    try {
      const one = await request(app).post(`${API}/metrics/poll`).send({ sourceId: sid8 });
      expect(one.status).toBe(202);
      expect(one.body).toEqual({ ok: true, triggered: 1 });
      expect(trig).toHaveBeenCalledTimes(1);
      const all = await request(app).post(`${API}/metrics/poll`).send({});
      expect(all.body.triggered).toBe(1);
      expect((await request(app).post(`${API}/metrics/poll`).send({ sourceId: 99999 })).status).toBe(404);
      const alias = await request(app).post(`${API}/sources/${sid8}/poll-metrics`);
      expect(alias.status).toBe(202);
      expect(trig).toHaveBeenCalledTimes(3);
    } finally { delete handle.triggerMetrics; }
  });

  it('discovery labels a catalog DataSource "metrics (<family>)"', async () => {
    ins('lm_device_datasources', { source_id: sid8, lm_device_id: 201, hds_id: 9100, datasource_id: 3, datasource_name: 'PaloAlto_FW_IPSecTunnelStats', datasource_display_name: 'IPSec', instance_count: 24, is_interface: 0, is_neighbor: 0 });
    ins('lm_device_datasources', { source_id: sid8, lm_device_id: 201, hds_id: 9101, datasource_id: 4, datasource_name: 'SomeUnknownDS', datasource_display_name: 'x', instance_count: 1, is_interface: 0, is_neighbor: 0 });
    const disc = await request(app).get(`${API}/settings/discovery`);
    const ds = Object.fromEntries(disc.body.datasources.map((d) => [d.name, d.collected]));
    expect(ds.PaloAlto_FW_IPSecTunnelStats).toBe('metrics (firewall)');
    expect(ds.SomeUnknownDS).toBe('inventory only');
  });
});

describe('logicmonitor wireless routes', () => {
  let sidW;
  const hdsW = new Map();
  let seq = 8000;
  function wdev(id, name, over = {}) {
    ins('lm_devices', {
      source_id: sidW, lm_device_id: id, name, display_name: name, device_type: 0, host_status: 'normal', alert_status: 'none',
      sdt_status: 'none-none-none', vendor: 'Cisco', role: over.role || 'wireless', is_network: 1, model: over.model || 'C9800-40-K9',
      site_key: over.site || 'irv', site_name: over.siteName || 'IRV', ips_json: '[]', stale: 0,
    });
  }
  function wm(devId, ds, inst, metric, value, extra = {}) {
    const hk = `${devId}|${ds}`;
    if (!hdsW.has(hk)) { seq += 1; hdsW.set(hk, seq); }
    const hds = hdsW.get(hk);
    db.prepare(`INSERT OR IGNORE INTO lm_ds_instances (source_id, lm_device_id, hds_id, datasource_name, family, instance_key, instance_name, stale)
      VALUES (?, ?, ?, ?, 'wireless', ?, ?, ?)`).run(sidW, devId, hds, ds, inst, extra.name || inst, extra.stale ? 1 : 0);
    db.prepare(`INSERT OR REPLACE INTO lm_ds_metrics (source_id, lm_device_id, hds_id, datasource_name, family, instance_key, metric, datapoint, value, sampled_at_epoch)
      VALUES (?, ?, ?, ?, 'wireless', ?, ?, ?, ?, ?)`).run(sidW, devId, hds, ds, inst, metric, metric, value, nowSec() - 120);
    return hds;
  }

  beforeEach(() => {
    wipe();
    hdsW.clear();
    sidW = insertSource();
    wdev(401, 'IRV-WLC-1');
    wdev(402, 'SJCX-GANC-1', { model: 'AIR-CT3504-K9', site: 'sjcx', siteName: 'SJCX' });
    wdev(499, 'irv-core-1', { role: 'switch' });
    // IRV: 3 APs (one disassociating), 2.4 and 5 GHz radios, two SSIDs.
    wm(401, 'Cisco_Wireless_AP', 'AP-A', 'ap_oper', 1);
    wm(401, 'Cisco_Wireless_AP', 'AP-B', 'ap_oper', 1);
    wm(401, 'Cisco_Wireless_AP', 'AP-C', 'ap_oper', 2);
    for (const [k, util, clients] of [['AP-A:0', 30, 4], ['AP-A:1', 85, 20], ['AP-B:0', 10, 1], ['AP-B:1', 40, 9]]) {
      wm(401, 'Cisco_Wireless_AccessPointRadio', k, 'radio_admin', 1);
      wm(401, 'Cisco_Wireless_AccessPointRadio', k, 'radio_oper', 2);
      wm(401, 'Cisco_Wireless_AccessPointRadio', k, 'radio_util_pct', util);
      wm(401, 'Cisco_Wireless_AccessPointRadio', k, 'radio_clients', clients);
      wm(401, 'Cisco_Wireless_AccessPointRadio', k, 'radio_tx_power', 3);
    }
    wm(401, 'Cisco_Wireless_AccessPointRadio', 'AP-B:1', 'radio_noise_profile', 2);
    wm(401, 'Cisco_Wireless_AccessPointInterfaces', 'AP-A - GigabitEthernet0', 'apif_oper', 1);
    wm(401, 'Cisco_Wireless_AccessPointInterfaces', 'AP-A - GigabitEthernet0', 'apif_rx_bytes', 1000);
    const ess = wm(401, 'Cisco_Wireless_ESS', 'WLAN: 1', 'ess_clients', 30, { name: 'Corp' });
    wm(401, 'Cisco_Wireless_ESS', 'WLAN: 1', 'ess_admin', 1, { name: 'Corp' });
    wm(401, 'Cisco_Wireless_ESS', 'WLAN: 2', 'ess_clients', 4, { name: 'Guest' });
    wm(401, 'Cisco_C9800_HA_Peer_State', 'Cisco_C9800_HA_Peer_State', 'wlc_ha_peer_ok', 1);
    const stmt = db.prepare('INSERT INTO lm_ds_metrics_history (source_id, lm_device_id, hds_id, instance_key, metric, value, sampled_at_epoch) VALUES (?, ?, ?, ?, ?, ?, ?)');
    stmt.run(sidW, 401, ess, 'WLAN: 1', 'ess_clients', 20, nowSec() - 7200);
    stmt.run(sidW, 401, ess, 'WLAN: 1', 'ess_clients', 30, nowSec() - 600);
    // SJCX: AireOS with RADIUS and the connection statistics.
    wm(402, 'Cisco_Wireless_AP', 'SJ-1', 'ap_oper', 1);
    wm(402, 'Cisco_Wireless_ESS', 'WLAN: 1', 'ess_clients', 6, { name: 'Corp' });
    wm(402, 'Cisco_Wireless_ConnectionStatistics', '0', 'wlc_clients_max', 3000);
    wm(402, 'Cisco_Wireless_GlobalPerformance', 'Cisco_Wireless_GlobalPerformance', 'cpu_pct', 12);
    wm(402, 'Cisco_Wireless_RADIUSAuthServers', '10.0.0.1', 'radius_status', 1);
    wm(402, 'Cisco_Wireless_RADIUSAuthServers', '10.0.0.1', 'radius_timeouts', 3);
    wm(402, 'Cisco_Wireless_HighAvailability', '0', 'wlc_primary_unit', 1);
  });
  afterEach(() => { wipe(); });

  it('GET /wireless/controllers rolls up APs, radios, clients and HA per controller', async () => {
    const res = await request(app).get(`${API}/wireless/controllers`);
    expect(res.status).toBe(200);
    expect(res.body.map((c) => c.deviceName).sort()).toEqual(['IRV-WLC-1', 'SJCX-GANC-1']);
    const irv = res.body.find((c) => c.deviceName === 'IRV-WLC-1');
    expect(irv).toMatchObject({
      platform: 'Catalyst 9800', haText: 'hot standby', apsTotal: 3, apsUp: 2, apsDown: 1, radiosTotal: 4, radiosUp: 4, hotRadios: 1,
      avgChannelUtilPct: 41.3, clients: 34, ssids: 2, state: 'warning',
    });
    const sj = res.body.find((c) => c.deviceName === 'SJCX-GANC-1');
    expect(sj).toMatchObject({ platform: 'AireOS', haText: 'primary', cpuPct: 12, clients: 6, radiusServers: 1, radiusUnresponsive: 1, state: 'warning' });
    const csv = await request(app).get(`${API}/wireless/controllers.csv`);
    expect(csv.text.split('\r\n')[0]).toContain('deviceName,siteName,platform');
  });

  it('GET /wireless/overview returns totals, band, SSID and site analytics and the client trend', async () => {
    const res = await request(app).get(`${API}/wireless/overview`);
    expect(res.status).toBe(200);
    expect(res.body.totals).toMatchObject({ controllers: 2, aps: 4, apsUp: 3, apsDown: 1, radios: 4, hotRadios: 1, clients: 40, ssids: 2, radiusUnresponsive: 1 });
    expect(res.body.analytics.byBand.map((b) => [b.band, b.clients])).toEqual([['2.4 GHz', 5], ['5 GHz', 29]]);
    expect(res.body.analytics.bySsid.map((s) => [s.ssid, s.clients, s.controllers])).toEqual([['Corp', 36], ['Guest', 4]].map(([n, c]) => [n, c, n === 'Corp' ? 2 : 1]));
    expect(res.body.analytics.hottestRadios[0]).toMatchObject({ radio: 'AP-A:1', band: '5 GHz', channelUtilPct: 85 });
    expect(res.body.analytics.downAps.map((a) => a.ap)).toEqual(['AP-C']);
    expect(res.body.clientTrend.length).toBeGreaterThanOrEqual(2);
  });

  it('GET /wireless/aps and /wireless/ap join radios and uplinks per AP', async () => {
    const list = await request(app).get(`${API}/wireless/aps`);
    const a = list.body.find((x) => x.ap === 'AP-A');
    expect(a).toMatchObject({ controller: 'IRV-WLC-1', status: 'up', radiosUp: 2, radiosTotal: 2, clients: 24, util24: 30, util5: 85, maxChannelUtilPct: 85, uplinkState: 'up', uplinkRxBps: 8000 });
    expect(list.body.find((x) => x.ap === 'AP-C')).toMatchObject({ status: 'down', operText: 'disassociating' });
    const one = await request(app).get(`${API}/wireless/ap`).query({ controllerId: 401, ap: 'AP-C' });
    expect(one.status).toBe(200);
    expect(one.body.issues.map((i) => i.type)).toEqual(['wlan-ap-down']);
    expect((await request(app).get(`${API}/wireless/ap`).query({ controllerId: 401, ap: 'nope' })).status).toBe(404);
    expect((await request(app).get(`${API}/wireless/ap`).query({ controllerId: 499, ap: 'AP-A' })).status).toBe(404);
  });

  it('GET /wireless/rf summarises bands, histogram, Tx power and RRM profile failures', async () => {
    const res = await request(app).get(`${API}/wireless/rf`);
    expect(res.status).toBe(200);
    const five = res.body.bands.find((b) => b.band === '5 GHz');
    expect(five).toMatchObject({ radios: 2, up: 2, clients: 29, avgChannelUtilPct: 62.5, hot: 1, profileFailures: { noise: 1, load: 0 } });
    expect(five.utilHistogram.find((h) => h.bucket === '80-90%').count).toBe(1);
    expect(five.txPower).toEqual([{ level: 3, count: 2 }]);
    expect(res.body.radios).toHaveLength(4);
  });

  it('GET /wireless/ssids aggregates SSIDs across controllers with a per-SSID trend', async () => {
    const res = await request(app).get(`${API}/wireless/ssids`);
    expect(res.status).toBe(200);
    expect(res.body.summary[0]).toMatchObject({ ssid: 'Corp', clients: 36, controllers: 2 });
    expect(res.body.rows).toHaveLength(3);
    expect(res.body.trend.bySsid.find((s) => s.ssid === 'Corp').points.length).toBeGreaterThanOrEqual(2);
  });

  it('GET /wireless/controllers/:id returns the 360 sections and 404s for a non-wireless device', async () => {
    const res = await request(app).get(`${API}/wireless/controllers/402`);
    expect(res.status).toBe(200);
    expect(res.body.summary.deviceName).toBe('SJCX-GANC-1');
    expect(res.body.radius.auth).toEqual([expect.objectContaining({ server: '10.0.0.1', state: 'unresponsive' })]);
    expect(res.body.connections.clientsMax).toBe(3000);
    expect(res.body.issues.map((i) => i.type)).toContain('wlan-radius-unresponsive');
    expect((await request(app).get(`${API}/wireless/controllers/499`)).status).toBe(404);
  });
});

describe('logicmonitor round 9 routes: /lookup', () => {
  beforeEach(() => { wipe(); seedEstate(); });
  afterEach(() => { wipe(); });

  it('400s without names or ips', async () => {
    expect((await request(app).get(`${API}/lookup`)).status).toBe(400);
  });

  it('returns the LM device, its open alerts, health and switch ports for a known name', async () => {
    const res = await request(app).get(`${API}/lookup?names=core-sw1`);
    expect(res.status).toBe(200);
    expect(res.body.device).toMatchObject({ id: 101, displayName: 'core-sw1', vendor: 'Cisco', model: 'C9300' });
    expect(res.body.health).toMatchObject({ hostStatus: 'normal', alertStatus: 'unconfirmed-critical-none', collectorDown: true });
    expect(res.body.alerts.map((a) => a.datasource).sort()).toEqual(['Cisco_CPU_SNMP', 'SNMP_Network_Interfaces']);
    expect(res.body.alerts[0].severity).toBe('critical');
    expect(Array.isArray(res.body.switchPorts)).toBe(true);
  });

  it('matches by IP and reports a dead device with deadSince', async () => {
    const res = await request(app).get(`${API}/lookup?ips=10.0.0.2`);
    expect(res.status).toBe(200);
    expect(res.body.device.displayName).toBe('edge-rt1');
    expect(res.body.health.hostStatus).toBe('dead');
    expect(res.body.health.deadSince).toMatch(/^2023-11-1[45]T/);
  });

  it('omits duplicate alerts and answers device null for an unknown object', async () => {
    db.prepare("UPDATE lm_alerts SET duplicate_of = 'duplicate:netapp' WHERE lm_alert_id = 'DS2'").run();
    const res = await request(app).get(`${API}/lookup?names=core-sw1`);
    expect(res.body.alerts.map((a) => a.datasource)).toEqual(['SNMP_Network_Interfaces']);
    const none = await request(app).get(`${API}/lookup?names=not-in-lm`);
    expect(none.status).toBe(200);
    expect(none.body).toMatchObject({ device: null, alerts: [], health: null });
  });
});
