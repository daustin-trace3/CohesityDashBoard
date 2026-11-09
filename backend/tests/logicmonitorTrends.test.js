/**
 * LogicMonitor trend findings (migration v17): the pure fit / forecast / reset / state-change helpers and
 * computeTrendFindings over seeded lm_ds_daily and lm_interface_daily rows.
 */
import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const db = require('../db/database');
const { runMigrations } = require('../core/migrations');
const lmMigrations = require('../db/migrations/logicmonitor');
const trends = require('../services/logicmonitorTrends');

const NOW = Date.parse('2026-11-09T12:00:00Z');
const dayStr = (ms) => new Date(ms).toISOString().slice(0, 10);
const dayAt = (ago) => dayStr(NOW - ago * 86400000);
let SID;

beforeAll(() => { runMigrations(db, 'logicmonitor', lmMigrations); });
beforeEach(() => {
  for (const t of ['lm_trend_findings', 'lm_ds_daily', 'lm_ds_instances', 'lm_ds_metrics', 'lm_ds_metric_baseline',
    'lm_interface_daily', 'lm_interfaces', 'lm_devices', 'lm_sources']) db.prepare(`DELETE FROM ${t}`).run();
  SID = db.prepare("INSERT INTO lm_sources (name, company, auth_mode, encrypted_credentials) VALUES ('p1', 'acme', 'lmv1', 'x')").run().lastInsertRowid;
});

const series = (n, f) => Array.from({ length: n }, (_, i) => ({ day: dayAt(n - 1 - i), value: f(i), samples: 24 }));

describe('linearFit and daysUntil', () => {
  it('fits a clean line', () => {
    const fit = trends.linearFit(series(10, (i) => 10 + 2 * i));
    expect(fit.slopePerDay).toBeCloseTo(2, 6);
    expect(fit.r2).toBeCloseTo(1, 6);
    expect(fit.n).toBe(10);
  });

  it('honours real gaps in the day index', () => {
    const pts = [{ day: '2026-11-01', value: 10, samples: 1 }, { day: '2026-11-05', value: 18, samples: 1 }, { day: '2026-11-09', value: 26, samples: 1 }];
    expect(trends.linearFit(pts).slopePerDay).toBeCloseTo(2, 6);
  });

  it('estimates days to a threshold with its basis', () => {
    const r = trends.daysUntil(series(10, (i) => 50 + 2 * i), 80, { direction: 'up' });
    // last value 68, slope 2 per day: 6 days
    expect(r.days).toBeCloseTo(6, 0);
    expect(r.basis).toMatchObject({ n: 10, reason: 'ok' });
    expect(r.basis.r2).toBeGreaterThan(0.99);
  });

  it('answers null for too few points, a weak fit and the wrong direction', () => {
    expect(trends.daysUntil(series(3, (i) => 50 + i), 80)).toMatchObject({ days: null, basis: { reason: 'insufficient_points' } });
    const noisy = series(14, (i) => (i % 2 ? 70 : 30));
    expect(trends.daysUntil(noisy, 90)).toMatchObject({ days: null, basis: { reason: 'weak_fit' } });
    expect(trends.daysUntil(series(10, (i) => 60 - i), 80)).toMatchObject({ days: null, basis: { reason: 'wrong_direction' } });
  });

  it('flat series never forecast, already past answers 0', () => {
    expect(trends.daysUntil(series(10, () => 40), 80).days).toBeNull();
    expect(trends.daysUntil(series(10, (i) => 85 + i), 80)).toMatchObject({ days: 0, basis: { reason: 'already_past' } });
  });

  it('forecasts downward for optic margin', () => {
    const r = trends.daysUntil(series(10, (i) => 5 - 0.2 * i), 0, { direction: 'down' });
    expect(r.days).toBeGreaterThan(15);
    expect(r.days).toBeLessThan(20);
  });
});

describe('resetEvents and stateChanges', () => {
  it('finds counter resets, including one that regrows inside the day', () => {
    const pts = [
      { day: '2026-11-01', value: 5000, min: 4000, last: 5000 },
      { day: '2026-11-02', value: 9000, min: 6000, last: 9000 },
      { day: '2026-11-03', value: 9000, min: 120, last: 9000 }, // reset at the start of the day, regrown
      { day: '2026-11-04', value: 18000, min: 10000, last: 18000 },
    ];
    expect(trends.resetEvents(pts)).toEqual([{ day: '2026-11-03', from: 9000, to: 120 }]);
  });

  it('finds days where a state metric changed', () => {
    const rows = [
      { day: '2026-11-01', min: 4, max: 4, last: 4 },
      { day: '2026-11-02', min: 3, max: 4, last: 3 },
      { day: '2026-11-03', min: 3, max: 3, last: 3 },
      { day: '2026-11-04', min: 4, max: 4, last: 4 }, // changed overnight
    ];
    expect(trends.stateChanges(rows).map((r) => r.day)).toEqual(['2026-11-02', '2026-11-04']);
  });
});

describe('sensorKind', () => {
  it('reads the kind from the instance name', () => {
    expect(trends.sensorKind('Ethernet1/1 Transceiver Rx Power Sensor')).toBe('rx_power');
    expect(trends.sensorKind('Te1/0/1 Receive Power')).toBe('rx_power');
    expect(trends.sensorKind('Gi1/0/2 Tx Power')).toBe('tx_power');
    expect(trends.sensorKind('Ethernet1/1 Module Temperature Sensor')).toBe('temperature');
    expect(trends.sensorKind('Fan tray 1')).toBe('unknown');
  });
});

function dev(id, o = {}) {
  db.prepare('INSERT INTO lm_devices (source_id, lm_device_id, name, display_name, vendor_key, vendor_kind, is_network, stale) VALUES (?, ?, ?, ?, ?, ?, 1, 0)')
    .run(SID, id, o.name || `dev${id}`, o.name || `dev${id}`, o.vendorKey || 'cisco', o.kind || 'switch');
}
function inst(devId, hds, key, name) {
  db.prepare("INSERT INTO lm_ds_instances (source_id, lm_device_id, hds_id, datasource_name, family, instance_key, instance_name) VALUES (?, ?, ?, 'ds', 'health', ?, ?)")
    .run(SID, devId, hds, key, name);
}
function daily(devId, hds, key, metric, pts) {
  const ins = db.prepare(`INSERT INTO lm_ds_daily (source_id, lm_device_id, hds_id, datasource_name, instance_key, metric, kind, day, samples, min_value, sum_value, max_value, last_value)
    VALUES (?, ?, ?, 'ds', ?, ?, 'catalog', ?, ?, ?, ?, ?, ?)`);
  for (const p of pts) {
    const v = p.value; const n = p.samples || 24;
    ins.run(SID, devId, hds, key, metric, p.day, n, p.min != null ? p.min : v, v * n, p.max != null ? p.max : v, p.last != null ? p.last : v);
  }
}
const finding = (kind, devId, subject) => {
  const r = db.prepare('SELECT * FROM lm_trend_findings WHERE source_id = ? AND lm_device_id = ? AND kind = ?' + (subject ? ' AND subject = ?' : '')).all(...[SID, devId, kind].concat(subject ? [subject] : []));
  return r;
};

describe('computeTrendFindings', () => {
  it('writes cpu forecasts, memory creep, filesystem and reboot rows with basis', () => {
    dev(1);
    inst(1, 10, 'cpu', 'CPU 1');
    daily(1, 10, 'cpu', 'cpu_pct', series(30, (i) => 40 + 1.2 * i)); // reaches 80 in ~4 days from 74.8
    inst(1, 11, 'mem', 'Memory');
    daily(1, 11, 'mem', 'mem_pct', series(30, (i) => 50 + 0.4 * i));
    inst(1, 12, 'flash', 'flash:');
    daily(1, 12, 'flash', 'fs_used_pct', series(30, (i) => 80 + 0.4 * i));
    const res = trends.computeTrendFindings(db, { sourceId: SID, nowMs: NOW, thresholds: {} });
    expect(res.written).toBeGreaterThan(0);
    const cpu = finding('cpu_forecast', 1)[0];
    expect(cpu.threshold).toBe(80);
    expect(cpu.days_to_threshold).toBeLessThan(10);
    expect(cpu.severity).toBe('critical');
    expect(JSON.parse(cpu.basis_json)).toMatchObject({ n: 30, note: 'ok' });
    const creep = finding('mem_creep', 1)[0];
    expect(creep.severity).toBe('warning');
    const fs = finding('fs_forecast', 1)[0];
    expect(fs.threshold).toBe(95);
    expect(fs.days_to_threshold).not.toBeNull();
  });

  it('suppresses memory creep when the device rebooted inside the window', () => {
    dev(1);
    inst(1, 11, 'mem', 'Memory');
    daily(1, 11, 'mem', 'mem_pct', series(30, (i) => 50 + 0.4 * i));
    inst(1, 13, 'up', 'uptime');
    const pts = series(30, (i) => 1e6 + i * 86400);
    pts[15] = { ...pts[15], value: 500000, min: 100, last: 500000 };
    daily(1, 13, 'up', 'uptime_s', pts);
    trends.computeTrendFindings(db, { sourceId: SID, nowMs: NOW, thresholds: {} });
    expect(finding('mem_creep', 1)).toHaveLength(0);
    const rb = finding('reboot', 1)[0];
    expect(rb.value).toBe(1);
  });

  it('records peer flaps, state changes and optic margin', () => {
    dev(2);
    inst(2, 20, 'peer1', 'BGP peer 10.0.0.1');
    const est = series(10, (i) => 1000 + i * 86400);
    for (const k of [2, 4, 6]) est[k] = { ...est[k], value: 3000, min: 50, last: 3000 };
    daily(2, 20, 'peer1', 'bgp_established_s', est);
    inst(2, 21, 'stack', 'Switch 1');
    const role = series(20, () => 4).map((p, i) => (i === 10 ? { ...p, min: 3, max: 4, last: 3 } : p));
    daily(2, 21, 'stack', 'stack_role', role);
    inst(2, 22, 'rx1', 'Ethernet1/1 Transceiver Rx Power Sensor');
    daily(2, 22, 'rx1', 'optic_value', series(14, (i) => -8 - 0.1 * i));
    daily(2, 22, 'rx1', 'optic_low_warn', series(14, () => -9.2));
    trends.computeTrendFindings(db, { sourceId: SID, nowMs: NOW, thresholds: {} });
    const flap = finding('peer_flap', 2)[0];
    expect(flap.severity).toBe('warning');
    expect(JSON.parse(flap.detail_json).events7d).toBeGreaterThanOrEqual(3);
    const sc = finding('state_change', 2, 'Switch 1')[0];
    expect(JSON.parse(sc.detail_json).events.length).toBeGreaterThan(0);
    const optic = finding('optic_margin', 2)[0];
    expect(optic.value).toBeLessThan(2);
    expect(['warning', 'critical']).toContain(optic.severity);
    expect(optic.metric).toBe('rx_margin_db');
  });

  it('forecasts interface utilisation from lm_interface_daily', () => {
    dev(3);
    db.prepare("INSERT INTO lm_interfaces (source_id, lm_device_id, instance_id, instance_name, display_name, stale) VALUES (?, 3, 900, 'Te1/1', 'Te1/1', 0)").run(SID);
    const ins = db.prepare('INSERT INTO lm_interface_daily (source_id, instance_id, day, samples, max_in_util_pct, max_out_util_pct) VALUES (?, 900, ?, 96, ?, ?)');
    for (const p of series(30, (i) => 40 + 1.0 * i)) ins.run(SID, p.day, p.value, 10);
    trends.computeTrendFindings(db, { sourceId: SID, nowMs: NOW, thresholds: {} });
    const f = finding('if_util_forecast', 3);
    expect(f).toHaveLength(1);
    expect(f[0]).toMatchObject({ subject: 'Te1/1', metric: 'max_in_util_pct', threshold: 80 });
    expect(f[0].days_to_threshold).toBeGreaterThan(5);
  });

  it('flags a connection spike against the hour baseline and rebuilds cleanly on a second run', () => {
    dev(4, { vendorKey: 'f5', kind: 'bigip' });
    const epoch = Math.floor(NOW / 1000) - 600;
    db.prepare("INSERT INTO lm_ds_metrics (source_id, lm_device_id, hds_id, datasource_name, family, instance_key, metric, value, sampled_at_epoch) VALUES (?, 4, 40, 'F5_BigIP_System', 'loadbalancer', 'sys', 'client_connections', 90000, ?)").run(SID, epoch);
    const hour = new Date(epoch * 1000).getUTCHours();
    db.prepare("INSERT INTO lm_ds_metric_baseline (source_id, lm_device_id, hds_id, instance_key, metric, hour_of_day, samples, median, mad) VALUES (?, 4, 40, 'sys', 'client_connections', ?, 14, 20000, 1500)").run(SID, hour);
    trends.computeTrendFindings(db, { sourceId: SID, nowMs: NOW, thresholds: {} });
    const f = finding('conn_anomaly', 4)[0];
    expect(JSON.parse(f.detail_json)).toMatchObject({ direction: 'spike' });
    const again = trends.computeTrendFindings(db, { sourceId: SID, nowMs: NOW, thresholds: {} });
    expect(again.deleted).toBe(1);
    expect(db.prepare('SELECT COUNT(*) n FROM lm_trend_findings').get().n).toBe(again.written);
  });

  it('drops findings of devices that are gone', () => {
    dev(1);
    inst(1, 10, 'cpu', 'CPU 1');
    daily(1, 10, 'cpu', 'cpu_pct', series(20, (i) => 40 + i));
    trends.computeTrendFindings(db, { sourceId: SID, nowMs: NOW, thresholds: {} });
    expect(finding('cpu_forecast', 1)).toHaveLength(1);
    db.prepare('UPDATE lm_devices SET stale = 1').run();
    trends.computeTrendFindings(db, { sourceId: SID, nowMs: NOW, thresholds: {} });
    expect(db.prepare('SELECT COUNT(*) n FROM lm_trend_findings').get().n).toBe(0);
  });
});

describe('dailySeries', () => {
  it('combines instances per day with the chosen aggregate', () => {
    dev(1);
    daily(1, 10, 'a', 'cpu_pct', [{ day: dayAt(1), value: 10, max: 20 }]);
    daily(1, 10, 'b', 'cpu_pct', [{ day: dayAt(1), value: 30, max: 50 }]);
    const avg = trends.dailySeries(db, { sourceId: SID, deviceId: 1, metric: 'cpu_pct', days: 5, agg: 'avg', nowMs: NOW });
    const max = trends.dailySeries(db, { sourceId: SID, deviceId: 1, metric: 'cpu_pct', days: 5, agg: 'max', nowMs: NOW });
    expect(avg[0].value).toBeCloseTo(20, 6);
    expect(max[0].value).toBe(50);
  });
});
