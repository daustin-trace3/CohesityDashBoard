/**
 * LogicMonitor round 9 WP7: hour-of-day baselines for IP SLA metrics and the
 * IP SLA latency watch built on them. Rows are seeded by hand into the
 * per-file test DB through the migration; the engine is driven with explicit
 * epochs like the poller does.
 */
import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const db = require('../db/database');
const { runMigrations } = require('../core/migrations');
const lmMigrations = require('../db/migrations/logicmonitor');
const { encrypt } = require('../services/encryption');
const lmIssues = require('../services/logicmonitorIssues');
const lmWatch = require('../services/logicmonitorWatch');
const lmIpsla = require('../services/logicmonitorWatchIpsla');
const lmBase = require('../services/logicmonitorMetricBaselines');

const TABLES = ['lm_latency_episodes', 'lm_ds_metric_baseline', 'lm_ds_metrics_history', 'lm_ds_metrics', 'lm_ds_instances',
  'lm_device_datasources', 'lm_devices', 'lm_issue_history', 'lm_sources'];
const NOW = Math.floor(Date.UTC(2026, 9, 16, 12, 0, 0) / 1000);
const STEP = 1800;

beforeAll(() => { runMigrations(db, 'logicmonitor', lmMigrations); });

let sid;
let source;
let t;
beforeEach(() => {
  for (const tbl of TABLES) db.prepare(`DELETE FROM ${tbl}`).run();
  db.prepare("DELETE FROM app_settings WHERE key LIKE 'lm_%'").run();
  sid = db.prepare('INSERT INTO lm_sources (name, company, auth_mode, encrypted_credentials) VALUES (?, ?, ?, ?)')
    .run('Acme', 'acme', 'lmv1', encrypt(JSON.stringify({ accessId: 'a', accessKey: 'b' }))).lastInsertRowid;
  source = { id: sid, name: 'Acme' };
  t = lmIssues.getThresholds();
});

function device(id, name) {
  db.prepare(`INSERT INTO lm_devices (source_id, lm_device_id, name, display_name, device_type, host_status, vendor, role, is_network, site_key, stale)
    VALUES (?, ?, ?, ?, 0, 'normal', 'Cisco', 'router', 1, 'denver', 0)`).run(sid, id, name, name);
}
/** An IP SLA probe instance with rtt_ms (and loss_pct) history; values(i) for sample i, i = 0 is oldest. */
function probe(devId, key, { count, rtt, loss = () => 0, family = 'ipsla', latestEpoch = NOW - 60, step = STEP, ds = 'CiscoSLA_ICMPEcho-' }) {
  const hds = 5000 + devId;
  const r = db.prepare(`INSERT OR IGNORE INTO lm_ds_instances (source_id, lm_device_id, hds_id, datasource_name, family, instance_key, instance_name, stale)
    VALUES (?, ?, ?, ?, ?, ?, ?, 0)`).run(sid, devId, hds, ds, family, key, `echo ${key}`);
  const ins = db.prepare('INSERT INTO lm_ds_metrics_history (source_id, lm_device_id, hds_id, instance_key, metric, value, sampled_at_epoch) VALUES (?, ?, ?, ?, ?, ?, ?)');
  for (let i = 0; i < count; i += 1) {
    const e = latestEpoch - (count - 1 - i) * step;
    ins.run(sid, devId, hds, key, 'rtt_ms', rtt(i, e), e);
    ins.run(sid, devId, hds, key, 'loss_pct', loss(i, e), e);
  }
  db.prepare(`INSERT OR REPLACE INTO lm_ds_metrics (source_id, lm_device_id, hds_id, datasource_name, family, instance_key, metric, datapoint, value, sampled_at_epoch)
    VALUES (?, ?, ?, ?, ?, ?, 'rtt_ms', 'rtt', ?, ?)`).run(sid, devId, hds, ds, family, key, rtt(count - 1, latestEpoch), latestEpoch);
  return { hds, instId: db.prepare('SELECT id FROM lm_ds_instances WHERE source_id = ? AND lm_device_id = ? AND instance_key = ?').get(sid, devId, key).id, created: r.changes };
}
const baselineRows = (metric) => db.prepare('SELECT * FROM lm_ds_metric_baseline WHERE metric = ? ORDER BY hour_of_day').all(metric);

describe('migration v7 table', () => {
  it('creates lm_ds_metric_baseline with the contract key', () => {
    const cols = db.prepare("PRAGMA table_info('lm_ds_metric_baseline')").all().map((c) => c.name);
    expect(cols).toEqual(['source_id', 'lm_device_id', 'hds_id', 'instance_key', 'metric', 'hour_of_day', 'samples', 'median', 'mad', 'computed_at']);
  });
});

describe('computeMetricBaselines', () => {
  it('writes a median and MAD per UTC hour for ipsla rtt and loss over the baseline window', () => {
    device(1, 'den-rtr-01');
    // 7 days of 30 minute samples: 40 ms by day (hours 6 to 17), 30 ms otherwise.
    probe(1, '101', { count: 336, rtt: (i, e) => (new Date(e * 1000).getUTCHours() >= 6 && new Date(e * 1000).getUTCHours() < 18 ? 40 : 30) });
    const r = lmBase.computeMetricBaselines(db, sid, t, { nowMs: NOW * 1000 });
    expect(r.written).toBeGreaterThan(0);
    const rtt = baselineRows('rtt_ms');
    expect(rtt.length).toBe(24);
    expect(rtt.find((x) => x.hour_of_day === 9)).toMatchObject({ median: 40, mad: 0 });
    expect(rtt.find((x) => x.hour_of_day === 2)).toMatchObject({ median: 30 });
    expect(rtt.every((x) => x.samples >= lmBase.MIN_SAMPLES)).toBe(true);
    expect(baselineRows('loss_pct').length).toBe(24);
  });

  it('skips hour buckets with too few samples and non-ipsla families', () => {
    device(1, 'den-rtr-01');
    probe(1, '101', { count: 5, rtt: () => 20 });
    probe(1, 'cpu', { count: 336, rtt: () => 20, family: 'health', ds: 'Cisco_CPU_SNMP' });
    lmBase.computeMetricBaselines(db, sid, t, { nowMs: NOW * 1000 });
    expect(db.prepare('SELECT COUNT(*) c FROM lm_ds_metric_baseline').get().c).toBe(0);
  });

  it('is a full rewrite: a second run replaces the rows and a run for another source leaves them alone', () => {
    device(1, 'den-rtr-01');
    probe(1, '101', { count: 336, rtt: () => 25 });
    lmBase.computeMetricBaselines(db, sid, t, { nowMs: NOW * 1000 });
    const first = db.prepare('SELECT COUNT(*) c FROM lm_ds_metric_baseline').get().c;
    lmBase.computeMetricBaselines(db, sid, t, { nowMs: NOW * 1000 });
    expect(db.prepare('SELECT COUNT(*) c FROM lm_ds_metric_baseline').get().c).toBe(first);
    const other = db.prepare('INSERT INTO lm_sources (name, company, auth_mode, encrypted_credentials) VALUES (?, ?, ?, ?)')
      .run('Other', 'o', 'lmv1', encrypt('{}')).lastInsertRowid;
    lmBase.computeMetricBaselines(db, other, t, { nowMs: NOW * 1000 });
    expect(db.prepare('SELECT COUNT(*) c FROM lm_ds_metric_baseline WHERE source_id = ?').get(sid).c).toBe(first);
  });

  it('writes frozen reference rows from the window that ends 7 days ago', () => {
    device(1, 'den-rtr-01');
    // 14 days: the older 7 at 20 ms, the newest 7 at 30 ms.
    probe(1, '101', { count: 672, rtt: (i, e) => (e < NOW - 7 * 86400 ? 20 : 30) });
    const r = lmBase.computeMetricBaselines(db, sid, t, { nowMs: NOW * 1000 });
    expect(r.reference).toBe(24);
    const ref = baselineRows(`rtt_ms${lmBase.REF_SUFFIX}`);
    expect(ref.length).toBe(24);
    expect(ref.every((x) => x.median === 20)).toBe(true);
    expect(baselineRows('rtt_ms').every((x) => x.median === 30)).toBe(true);
  });
});

describe('IP SLA watch', () => {
  /** 7 days at 40 ms with a little jitter, the last `spike` samples multiplied. */
  function seedProbe({ spike = 0, factor = 1.9, extra = {} } = {}) {
    device(1, 'slc-rtr-01');
    const count = 336;
    const p = probe(1, '102', { count, rtt: (i) => (i >= count - spike ? Math.round(40 * factor) : 40 + (i % 3)), ...extra });
    lmBase.computeMetricBaselines(db, sid, t, { nowMs: NOW * 1000 });
    return p;
  }
  /** Replay the engine at 30 minute steps up to NOW, like the demo seed. */
  function replay(hours = 6) {
    const total = { opened: 0, promoted: 0, closed: 0 };
    for (let e = NOW - hours * 3600; e <= NOW; e += STEP) {
      const r = lmIpsla.evaluateIpsla(db, source, t, e);
      total.opened += r.opened; total.promoted += r.promoted; total.closed += r.closed;
    }
    return total;
  }
  const episodes = () => db.prepare('SELECT * FROM lm_latency_episodes ORDER BY id').all();

  it('opens an ipsla episode on a spike, promotes it when sustained and labels it device + instance + probe type', () => {
    const p = seedProbe({ spike: 4 });
    const total = replay();
    expect(total.opened).toBe(1);
    expect(total.promoted).toBeGreaterThanOrEqual(1);
    const ep = episodes()[0];
    expect(ep).toMatchObject({ subject_kind: 'ipsla', subject_key: `ipsla:${p.instId}:rtt_ms`, state: 'degrading', site_key: 'denver', kind: 'latency' });
    expect(ep.subject_label).toMatch(/^slc-rtr-01 echo 102 \(.+\)$/);
    expect(ep.baseline_median).toBeGreaterThanOrEqual(40);
    expect(ep.baseline_median).toBeLessThanOrEqual(42);
    expect(ep.peak_ratio).toBeGreaterThan(1.5);
  });

  it('computeWatchIssues raises latency-degrading with the target "<device> <instance>"', () => {
    seedProbe({ spike: 4 });
    replay();
    const rows = lmWatch.computeWatchIssues(db, t, new Map([[sid, 'Acme']]));
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ severity: 'warning', type: 'latency-degrading', source: 'Acme', target: 'slc-rtr-01 echo 102' });
    expect(rows[0].message).toMatch(/RTT \d+ ms against a 4[0-2] ms baseline/);
  });

  it('a one-sample blip opens and closes a one-off without raising anything', () => {
    device(1, 'slc-rtr-01');
    const count = 336;
    probe(1, '102', { count, rtt: (i) => (i === count - 6 ? 200 : 40 + (i % 3)) });
    lmBase.computeMetricBaselines(db, sid, t, { nowMs: NOW * 1000 });
    const total = replay();
    expect(total.opened).toBeGreaterThanOrEqual(1);
    const eps = episodes();
    expect(eps.every((e) => e.state === 'closed' && e.outcome === 'one-off')).toBe(true);
    expect(lmWatch.computeWatchIssues(db, t, new Map([[sid, 'Acme']])).filter((i) => i.type === 'latency-degrading')).toEqual([]);
  });

  it('stays quiet on a flat probe and re-running at the same epoch changes nothing', () => {
    seedProbe();
    expect(replay()).toEqual({ opened: 0, promoted: 0, closed: 0 });
    expect(lmIpsla.evaluateIpsla(db, source, t, NOW)).toEqual({ opened: 0, promoted: 0, closed: 0 });
    expect(episodes()).toEqual([]);
  });

  it('does nothing without baselines and ignores stale instances', () => {
    device(1, 'slc-rtr-01');
    probe(1, '102', { count: 336, rtt: (i) => (i > 330 ? 400 : 40) });
    expect(replay()).toEqual({ opened: 0, promoted: 0, closed: 0 });
    lmBase.computeMetricBaselines(db, sid, t, { nowMs: NOW * 1000 });
    db.prepare('UPDATE lm_ds_instances SET stale = 1').run();
    expect(replay()).toEqual({ opened: 0, promoted: 0, closed: 0 });
  });

  it('evaluateWatch runs the ipsla pass too, but not for a single-location replay', () => {
    seedProbe({ spike: 4 });
    for (let e = NOW - 6 * 3600; e <= NOW; e += STEP) lmWatch.evaluateWatch(db, source, t, e, { only: { checkId: 'x', checkpointId: 'y' } });
    expect(episodes()).toEqual([]);
    let opened = 0;
    for (let e = NOW - 6 * 3600; e <= NOW; e += STEP) opened += lmWatch.evaluateWatch(db, source, t, e).opened;
    expect(opened).toBe(1);
    expect(episodes()[0].subject_kind).toBe('ipsla');
  });

  it('a probe that leaves the inventory closes its open episode', () => {
    seedProbe({ spike: 4 });
    replay();
    expect(episodes()[0].state).toBe('degrading');
    db.prepare('UPDATE lm_ds_instances SET stale = 1').run();
    const r = lmIpsla.evaluateIpsla(db, source, t, NOW + STEP);
    expect(r.closed).toBe(1);
    expect(episodes()[0]).toMatchObject({ state: 'closed', outcome: 'sustained' });
  });

  it('raises latency-drift when the live baseline runs 40% above the frozen reference', () => {
    device(1, 'den-rtr-01');
    probe(1, '101', { count: 672, rtt: (i, e) => (e < NOW - 7 * 86400 ? 30 : 42) });
    lmBase.computeMetricBaselines(db, sid, t, { nowMs: NOW * 1000 });
    const rows = lmIpsla.computeIpslaDrift(db, t, new Map([[sid, 'Acme']]));
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ type: 'latency-drift', severity: 'info', target: 'den-rtr-01 echo 101', source: 'Acme' });
    expect(rows[0].message).toMatch(/up 40%/);
    // it also reaches computeWatchIssues
    expect(lmWatch.computeWatchIssues(db, t, new Map([[sid, 'Acme']])).some((i) => i.type === 'latency-drift' && i.target === 'den-rtr-01 echo 101')).toBe(true);
  });

  it('episodeSummary finds an ipsla episode by the device name', () => {
    seedProbe({ spike: 4 });
    replay();
    expect(lmWatch.episodeSummary(db, { names: ['slc-rtr-01'] }).total).toBe(1);
    expect(lmWatch.episodeSummary(db, { names: ['slc-rtr-0'] }).total).toBe(0);
  });
});
