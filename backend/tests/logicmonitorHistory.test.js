/**
 * LogicMonitor long-term history (migration v12): lm_ds_daily and lm_device_daily are written
 * incrementally at sample time, pruned by lm_daily_history_days, and read by the new routes.
 */
import { describe, it, expect, beforeAll, beforeEach, afterEach, vi } from 'vitest';
import { createRequire } from 'module';
import request from 'supertest';

const require = createRequire(import.meta.url);
const express = require('express');
const db = require('../db/database');
const { runMigrations } = require('../core/migrations');
const lmMigrations = require('../db/migrations/logicmonitor');
const lmApi = require('../services/logicmonitorApi');
const metrics = require('../services/logicmonitorMetrics');
const raw = require('../services/logicmonitorRaw');
const poller = require('../services/logicmonitorPoller');
const history = require('../services/logicmonitorHistory');

const TABLES = ['lm_ds_daily', 'lm_device_daily', 'lm_ds_values', 'lm_ds_datapoints', 'lm_ds_metrics_history', 'lm_ds_metrics',
  'lm_ds_instances', 'lm_metrics_history', 'lm_alerts', 'lm_device_datasources', 'lm_devices', 'lm_sources'];

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
beforeEach(() => {
  for (const t of TABLES) db.prepare(`DELETE FROM ${t}`).run();
  db.prepare("DELETE FROM app_settings WHERE key LIKE 'lm_%'").run();
});

const nowSec = () => Math.floor(Date.now() / 1000);
const dayStr = (ms) => new Date(ms).toISOString().slice(0, 10);
const todayMidnightSec = () => Math.floor(Date.parse(`${dayStr(Date.now())}T00:00:00Z`) / 1000);

function insertSource(o = {}) {
  return db.prepare(`
    INSERT INTO lm_sources (name, company, auth_mode, encrypted_credentials, metrics_poll_minutes, raw_poll_enabled, raw_calls_per_tick)
    VALUES ('portal1', 'acme', 'lmv1', 'x', 30, ?, 600)
  `).run(o.raw ?? 0).lastInsertRowid;
}
const sourceRow = (id) => db.prepare('SELECT * FROM lm_sources WHERE id = ?').get(id);
function insertDevice(sid, id, o = {}) {
  db.prepare('INSERT INTO lm_devices (source_id, lm_device_id, name, display_name, is_network, stale, host_status, sdt_status) VALUES (?, ?, ?, ?, 1, 0, ?, ?)')
    .run(sid, id, `dev${id}`, `dev${id}`, o.host ?? 'normal', o.sdt ?? 'none-none-none');
}
function insertDs(sid, dev, hds, name) {
  db.prepare(`
    INSERT INTO lm_device_datasources (source_id, lm_device_id, hds_id, datasource_name, instance_count, stop_monitoring, is_interface, is_neighbor)
    VALUES (?, ?, ?, ?, 1, 0, 0, 0)
  `).run(sid, dev, hds, name);
}
const sessionsBody = (epoch, active) => ({
  dataSourceName: 'PaloAlto_FW_GlobalSessions',
  dataPoints: ['ActiveSessions', 'MaxSessions', 'SessionUtilization'],
  instances: { 'PaloAlto_FW_GlobalSessions-Global [ID:1]': { time: [epoch * 1000], values: [[active, 1000, active / 10]] } },
});
const dailyRows = (sid) => db.prepare("SELECT * FROM lm_ds_daily WHERE source_id = ? AND metric = 'sessions_active' ORDER BY day").all(sid);

describe('catalog daily rollup', () => {
  let spy;
  afterEach(() => { if (spy) spy.mockRestore(); spy = null; });

  it('two polls on one UTC day make one row; a poll on the next day makes a second', async () => {
    const sid = insertSource();
    insertDevice(sid, 1);
    insertDs(sid, 1, 501, 'PaloAlto_FW_GlobalSessions');
    const base = todayMidnightSec() + 30;
    spy = vi.spyOn(lmApi, 'fetchDsData').mockImplementation(async () => sessionsBody(base, 100));
    await metrics.pollMetrics(sourceRow(sid));
    spy.mockImplementation(async () => sessionsBody(base + 120, 300));
    await metrics.pollMetrics(sourceRow(sid));
    let rows = dailyRows(sid);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ samples: 2, min_value: 100, sum_value: 400, max_value: 300, last_value: 300, last_epoch: base + 120, kind: 'catalog', datasource_name: 'PaloAlto_FW_GlobalSessions', instance_key: 'Global' });
    // The same sample again adds nothing.
    await metrics.pollMetrics(sourceRow(sid));
    expect(dailyRows(sid)[0].samples).toBe(2);
    // Next UTC day.
    spy.mockImplementation(async () => sessionsBody(base + 86400, 50));
    await metrics.pollMetrics(sourceRow(sid));
    rows = dailyRows(sid);
    expect(rows).toHaveLength(2);
    expect(rows[1]).toMatchObject({ samples: 1, min_value: 50, max_value: 50 });
  });
});

describe('raw daily rollup', () => {
  it('rolls up only a datapoint named by a raw rule', () => {
    const sid = insertSource({ raw: 1 });
    insertDevice(sid, 1);
    insertDs(sid, 1, 11, 'Custom_Widget');
    const t = nowSec();
    const body = (v) => ({
      dataSourceName: 'Custom_Widget',
      dataPoints: ['Alpha', 'Beta'],
      instances: { 'Custom_Widget-One [ID:1]': { time: [t * 1000], values: [[v, v + 1]] } },
    });
    const keys = raw.rawRuleKeySet(JSON.stringify([{ id: 'r1', datasource: 'Custom_Widget', datapoint: 'Alpha', op: '>', value: 5, severity: 'warning' }]));
    expect([...keys]).toEqual(['Custom_Widget:Alpha']);
    const cand = { lm_device_id: 1, hds_id: 11, datasource_name: 'Custom_Widget' };
    raw.storeRawBody(db, sourceRow(sid), cand, body(7), '2026-10-16 12:00:00', { nowEpoch: t, dailyRawKeys: keys });
    raw.storeRawBody(db, sourceRow(sid), cand, { ...body(9), instances: { 'Custom_Widget-One [ID:1]': { time: [(t + 60) * 1000], values: [[9, 10]] } } }, '2026-10-16 12:01:00', { nowEpoch: t + 60, dailyRawKeys: keys });
    const rows = db.prepare('SELECT * FROM lm_ds_daily WHERE source_id = ?').all(sid);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ metric: 'Alpha', kind: 'raw', samples: 2, min_value: 7, max_value: 9, sum_value: 16 });
  });
});

describe('device daily', () => {
  it('writeMetrics counts samples and keeps the worst status of the day', () => {
    const sid = insertSource();
    insertDevice(sid, 1);
    poller.writeMetrics(sid);
    db.prepare("UPDATE lm_devices SET host_status = 'dead' WHERE lm_device_id = 1").run();
    poller.writeMetrics(sid);
    db.prepare("UPDATE lm_devices SET host_status = 'normal', sdt_status = 'none-SDT-none' WHERE lm_device_id = 1").run();
    poller.writeMetrics(sid);
    const r = db.prepare('SELECT * FROM lm_device_daily WHERE source_id = ? AND lm_device_id = 1').get(sid);
    expect(r).toMatchObject({ samples: 3, dead_samples: 1, dead_collector_samples: 0, sdt_samples: 1, worst_host_status: 'dead', day: dayStr(Date.now()) });
  });

  it('the alert-count fill sets counts from lm_alerts and does not double on a second run', () => {
    const sid = insertSource();
    insertDevice(sid, 1);
    insertDevice(sid, 2);
    const alert = (id, dev, sev, sevNorm, epoch, dup = null) => db.prepare(`
      INSERT INTO lm_alerts (source_id, lm_alert_id, condition_key, type, severity, severity_norm, lm_device_id, start_epoch, cleared, duplicate_of)
      VALUES (?, ?, ?, 'dataSourceAlert', ?, ?, ?, ?, 0, ?)
    `).run(sid, id, `ck-${id}`, sev, sevNorm, dev, epoch, dup);
    const t = nowSec();
    alert('A1', 1, 4, 'critical', t - 5);
    alert('A2', 1, 3, 'warning', t - 4);
    alert('A3', 1, 3, 'warning', t - 3, 'A1');           // duplicate, not counted
    alert('A4', 2, 4, 'critical', t - 5 * 86400);        // outside today and yesterday
    poller.fillDeviceAlertCounts(sid);
    poller.fillDeviceAlertCounts(sid);
    const r = db.prepare('SELECT * FROM lm_device_daily WHERE source_id = ? AND lm_device_id = 1 AND day = ?').get(sid, dayStr(Date.now()));
    expect(r).toMatchObject({ samples: 0, alerts_opened: 2, alerts_critical: 1, alerts_warning: 1 });
    expect(db.prepare('SELECT COUNT(*) c FROM lm_device_daily WHERE lm_device_id = 2').get().c).toBe(0);
  });
});

describe('retention', () => {
  it('pruneHistories honours a saved lm_daily_history_days', () => {
    const sid = insertSource();
    const insDs = db.prepare(`INSERT INTO lm_ds_daily (source_id, lm_device_id, hds_id, instance_key, metric, day, samples, min_value, sum_value, max_value, last_value)
      VALUES (?, 1, 1, 'k', 'm', ?, 1, 1, 1, 1, 1)`);
    const insDev = db.prepare('INSERT INTO lm_device_daily (source_id, lm_device_id, day, samples) VALUES (?, 1, ?, 1)');
    for (const age of [5, 50, 200]) {
      const day = dayStr(Date.now() - age * 86400000);
      insDs.run(sid, day);
      insDev.run(sid, day);
    }
    db.prepare("INSERT OR REPLACE INTO app_settings (key, value) VALUES ('lm_daily_history_days', '100')").run();
    poller.pruneHistories(sid);
    expect(db.prepare('SELECT COUNT(*) c FROM lm_ds_daily').get().c).toBe(2);
    expect(db.prepare('SELECT COUNT(*) c FROM lm_device_daily').get().c).toBe(2);
    db.prepare("INSERT OR REPLACE INTO app_settings (key, value) VALUES ('lm_daily_history_days', '30')").run();
    poller.pruneHistories(sid);
    expect(db.prepare('SELECT COUNT(*) c FROM lm_ds_daily').get().c).toBe(1);
  });

  it('defaults: 365 days daily history and 90 days cleared-alert retention', () => {
    const t = require('../services/logicmonitorIssues').getThresholds();
    expect(t.lm_daily_history_days).toBe(365);
    expect(t.lm_alert_retention_days).toBe(90);
  });
});

describe('routes', () => {
  function seedHistory() {
    const sid = insertSource();
    insertDevice(sid, 1);
    const ds = db.prepare(`INSERT INTO lm_ds_daily (source_id, lm_device_id, hds_id, datasource_name, instance_key, metric, kind, day, samples, min_value, sum_value, max_value, last_value, last_epoch)
      VALUES (?, 1, 7, 'Cisco_CPU_SNMP', 'CPU 1', 'cpu_pct', 'catalog', ?, 10, ?, ?, ?, ?, 1)`);
    const dev = db.prepare(`INSERT INTO lm_device_daily (source_id, lm_device_id, day, samples, dead_samples, dead_collector_samples, sdt_samples, worst_host_status, alerts_opened, alerts_critical, alerts_warning)
      VALUES (?, 1, ?, ?, ?, 0, ?, ?, ?, ?, ?)`);
    for (let k = 0; k < 12; k += 1) {
      const day = dayStr(Date.now() - k * 86400000);
      ds.run(sid, day, 10 + k, 100 + k * 10, 90 + k, 50 + k);
      dev.run(sid, day, 288, k === 3 ? 100 : 0, k === 5 ? 96 : 0, k === 3 ? 'dead' : 'normal', 2, 1, 1);
    }
    db.prepare("INSERT INTO lm_ds_instances (source_id, lm_device_id, hds_id, datasource_name, family, instance_key, instance_name, stale) VALUES (?, 1, 7, 'Cisco_CPU_SNMP', 'health', 'CPU 1', 'CPU slot 1', 0)").run(sid);
    return sid;
  }

  it('GET /metrics/history?days=30 returns day points; hours keeps the hour shape', async () => {
    seedHistory();
    const res = await request(app).get('/api/logicmonitor/metrics/history').query({ deviceId: 1, hdsId: 7, instanceKey: 'CPU 1', metric: 'cpu_pct', days: 30 });
    expect(res.status).toBe(200);
    expect(res.body).toHaveLength(12);
    expect(res.body[0]).toMatchObject({ granularity: 'day', samples: expect.any(Number) });
    expect(res.body[0]).toHaveProperty('t');
    expect(res.body[0]).toHaveProperty('min');
    expect(res.body[0]).toHaveProperty('max');
    const sid = db.prepare('SELECT id FROM lm_sources').get().id;
    db.prepare("INSERT INTO lm_ds_metrics_history (source_id, lm_device_id, hds_id, instance_key, metric, value, sampled_at_epoch) VALUES (?, 1, 7, 'CPU 1', 'cpu_pct', 12, ?)").run(sid, nowSec() - 60);
    const h = await request(app).get('/api/logicmonitor/metrics/history').query({ deviceId: 1, hdsId: 7, instanceKey: 'CPU 1', metric: 'cpu_pct', hours: 24 });
    expect(h.body).toEqual([{ epoch: expect.any(Number), value: 12, granularity: 'hour' }]);
    const bad = await request(app).get('/api/logicmonitor/metrics/history').query({ deviceId: 1, hdsId: 7, instanceKey: 'CPU 1', metric: 'cpu_pct', days: 3 });
    expect(bad.status).toBe(400);
  });

  it('GET /devices/:id/daily returns ascending rows and a summary', async () => {
    seedHistory();
    const res = await request(app).get('/api/logicmonitor/devices/1/daily').query({ days: 30 });
    expect(res.status).toBe(200);
    expect(res.body.device).toMatchObject({ id: 1, name: 'dev1' });
    expect(res.body.rows).toHaveLength(12);
    expect(res.body.rows[0].day < res.body.rows[11].day).toBe(true);
    const dead = res.body.rows.find((r) => r.worstHostStatus === 'dead');
    expect(dead.deadPct).toBeCloseTo(34.7, 1);
    expect(res.body.summary).toMatchObject({ days: 12, daysDead: 1, daysInSdt: 1, alertsOpened: 24, alertsCritical: 12 });
    expect((await request(app).get('/api/logicmonitor/devices/999/daily')).status).toBe(404);
  });

  it('GET /devices/:id/baseline groups the window', async () => {
    seedHistory();
    const res = await request(app).get('/api/logicmonitor/devices/1/baseline').query({ days: 30 });
    expect(res.status).toBe(200);
    expect(res.body.metrics).toHaveLength(1);
    expect(res.body.metrics[0]).toMatchObject({ datasourceName: 'Cisco_CPU_SNMP', instanceKey: 'CPU 1', instanceName: 'CPU slot 1', metric: 'cpu_pct', kind: 'catalog', days: 12 });
    expect(res.body.metrics[0].samples).toBe(120);
    const rawKind = await request(app).get('/api/logicmonitor/devices/1/baseline').query({ kind: 'raw' });
    expect(rawKind.body.metrics).toEqual([]);
  });

  it('GET /trends accepts 90d and 365d and carries deviceDaily', async () => {
    seedHistory();
    const sid = db.prepare('SELECT id FROM lm_sources').get().id;
    db.prepare("INSERT INTO lm_metrics_history (source_id, captured_at, devices_normal, devices_dead) VALUES (?, datetime('now', '-3 days'), 10, 1)").run(sid);
    for (const range of ['90d', '365d', '30d']) {
      const res = await request(app).get('/api/logicmonitor/trends').query({ range });
      expect(res.status, range).toBe(200);
      expect(res.body.range).toBe(range);
      expect(res.body.deviceDaily).toMatchObject({ range });
      expect(res.body.deviceDaily.topDead[0]).toMatchObject({ deviceId: 1, name: 'dev1', daysDead: 1 });
      expect(res.body.deviceDaily.topAlerting[0]).toMatchObject({ deviceId: 1 });
      expect(res.body.deviceDaily.alertsByDay.length).toBeGreaterThan(0);
    }
    const day = await request(app).get('/api/logicmonitor/trends').query({ range: '365d' });
    expect(day.body.points).toHaveLength(1);
    expect(day.body.points[0].devicesDead).toBe(1);
    expect((await request(app).get('/api/logicmonitor/trends').query({ range: '2y' })).status).toBe(400);
  });
});

describe('evidence and advisor helpers', () => {
  it('cpuMemBaseline takes the busiest instance per day; topCpuBaselines ranks devices', () => {
    const sid = insertSource();
    insertDevice(sid, 1);
    insertDevice(sid, 2);
    const ds = db.prepare(`INSERT INTO lm_ds_daily (source_id, lm_device_id, hds_id, datasource_name, instance_key, metric, kind, day, samples, min_value, sum_value, max_value, last_value)
      VALUES (?, ?, 1, 'x', ?, ?, 'catalog', ?, 10, 1, ?, ?, 1)`);
    const d0 = dayStr(Date.now());
    ds.run(sid, 1, 'a', 'cpu_pct', d0, 200, 40);   // avg 20
    ds.run(sid, 1, 'b', 'cpu_pct', d0, 600, 90);   // avg 60
    ds.run(sid, 1, 'a', 'mem_pct', d0, 500, 60);   // avg 50
    ds.run(sid, 2, 'a', 'cpu_pct', d0, 100, 15);   // avg 10
    const b = history.cpuMemBaseline(db, sid, 1, 30);
    expect(b).toMatchObject({ cpuAvg: 60, cpuMax: 90, memAvg: 50, memMax: 60, days: 1 });
    expect(history.cpuMemBaseline(db, sid, 99, 30)).toBeNull();
    const top = history.topCpuBaselines(db, 30, 25);
    expect(top.map((r) => r.deviceName)).toEqual(['dev1', 'dev2']);
    expect(top[0]).toMatchObject({ cpuAvgPct: 40, memAvgPct: 50, memMaxPct: 60 });
  });
});
