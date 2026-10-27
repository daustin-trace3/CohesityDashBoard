/**
 * Pure1 metrics gap: when Pure1 holds no recent telemetry the poll succeeds
 * with empty capacity and performance answers. The poller keeps the last-good
 * values AND the time of the newest point, flags the array as metrics-stale,
 * warns once per poll, and the notifier raises one item per stale array.
 */
import { describe, it, expect, beforeAll, beforeEach, afterEach, vi } from 'vitest';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const db = require('../db/database');
const logger = require('../utils/logger');
const pure1Api = require('../services/pure1Api');
const registry = require('../core/registry');

const behaviour = {};
let refreshAll;
let metricsStaleness;
let alertNotifier;
let warn;

const HOUR = 3600 * 1000;
const iso = (agoHours) => new Date(Date.now() - agoHours * HOUR).toISOString();

beforeAll(() => {
  pure1Api.isConfigured = () => true;
  pure1Api.getOverview = () => Promise.resolve(behaviour.overview);
  pure1Api.getEnrichment = () => Promise.resolve({});
  pure1Api.getAlerts = () => Promise.resolve([]);
  pure1Api.fetchPods = () => Promise.resolve([]);
  pure1Api.fetchLatestPerformance = () => Promise.resolve(behaviour.perf);
  ({ refreshAll, metricsStaleness } = require('../services/pure1Poller'));
  alertNotifier = require('../services/alertNotifier');
  // icc-phase1: no markBuiltin on this branch's registry; the cohesity gate falls back to always-on.
  if (typeof registry.markBuiltin === 'function') registry.markBuiltin('cohesity');
});

function seedArray(id, { metricsAt, perfAt }) {
  db.prepare(`
    INSERT INTO pure1_arrays (pure1_id, name, capacity_bytes, used_bytes, read_iops, metrics_captured_at, perf_captured_at)
    VALUES (?, ?, 1000, 400, 1234, ?, ?)
  `).run(id, `fa-${id}`, metricsAt, perfAt);
}
const row = (id) => db.prepare('SELECT * FROM pure1_arrays WHERE pure1_id = ?').get(id);

beforeEach(() => {
  db.exec('DELETE FROM pure1_arrays');
  warn = vi.spyOn(logger, 'warn').mockImplementation(() => {});
  behaviour.perf = new Map();
});
afterEach(() => { warn.mockRestore(); });

const staleWarnings = () => warn.mock.calls.filter((c) => String(c[0]).includes('no recent metric points'));

describe('pure1 metrics staleness', () => {
  it('empty capacity and performance answers keep last-good values and mark the array stale', async () => {
    const old = iso(5 * 24);
    seedArray('a1', { metricsAt: old, perfAt: old });
    behaviour.overview = [{ id: 'a1', name: 'fa-a1', total: 0, used: 0, capturedAt: null, tags: [] }];

    await refreshAll();

    const r = row('a1');
    expect(r.metrics_captured_at).toBe(old);
    expect(r.perf_captured_at).toBe(old);
    expect(r.read_iops).toBe(1234);
    expect(r.capacity_bytes).toBe(1000);
    expect(staleWarnings()).toHaveLength(1);
    expect(String(staleWarnings()[0][0])).toContain('1 of 1 arrays');

    const st = metricsStaleness([r], 48);
    expect(st.count).toBe(1);
    expect(st.stale[0].pure1_id).toBe('a1');
    expect(metricsStaleness([r], 24 * 30).count).toBe(0);
  });

  it('a poll with fresh points clears the flag and logs nothing', async () => {
    const old = iso(5 * 24);
    seedArray('a1', { metricsAt: old, perfAt: old });
    const now = Date.now();
    behaviour.overview = [{ id: 'a1', name: 'fa-a1', total: 2000, used: 500, capturedAt: now, tags: [] }];
    behaviour.perf = new Map([['a1', { readIops: 10, writeIops: 5, readLatencyUs: 1, writeLatencyUs: 1, readBw: 1, writeBw: 1, capturedAt: now }]]);

    await refreshAll();

    const r = row('a1');
    expect(r.metrics_captured_at).toBe(new Date(now).toISOString());
    expect(metricsStaleness([r], 48).count).toBe(0);
    expect(staleWarnings()).toHaveLength(0);
  });

  it('an array is not stale while either its capacity or its performance point is recent', () => {
    const fresh = { pure1_id: 'x', metrics_captured_at: iso(100), perf_captured_at: iso(1) };
    const none = { pure1_id: 'y', metrics_captured_at: null, perf_captured_at: null };
    const st = metricsStaleness([fresh, none], 48);
    expect(st.stale.map((s) => s.pure1_id)).toEqual(['y']);
    expect(st.total).toBe(2);
    expect(st.newestPointAt).toBe(fresh.perf_captured_at);
  });
});

describe('notifier collector', () => {
  it('emits one pure1-metrics-stale warning per stale array and none for a fresh one', () => {
    // collectOpenAlerts gates each platform on the registry; enable 'pure' for this test.
    registry.registerPlugin({
      id: 'pure', name: 'Pure', apiVersion: registry.PLUGIN_API_VERSION, migrations: [],
      createRouter: () => (req, res, next) => next(),
    });
    const old = iso(5 * 24);
    seedArray('s1', { metricsAt: old, perfAt: old });
    seedArray('s2', { metricsAt: null, perfAt: null });
    seedArray('f1', { metricsAt: iso(1), perfAt: iso(1) });

    let items;
    try { ({ items } = alertNotifier.collectOpenAlerts()); } finally { registry.unregisterPlugin('pure'); }
    const stale = items.filter((i) => i.type === 'pure1-metrics-stale');
    expect(stale.map((i) => i.sourceKey).sort()).toEqual(['pure1-metrics-stale:s1', 'pure1-metrics-stale:s2']);
    expect(stale.every((i) => i.platform === 'pure' && i.severity === 'warning')).toBe(true);
    expect(stale.find((i) => i.host === 'fa-s2').message).toContain('since ever');
  });
});
