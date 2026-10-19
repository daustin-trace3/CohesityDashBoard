/**
 * pollMetrics at a bounded number of calls in flight: wall time drops with the
 * limit, results are identical, one failing DataSource does not stop the rest.
 */
import { describe, it, expect, beforeAll, beforeEach, afterEach, vi } from 'vitest';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const db = require('../db/database');
const { runMigrations } = require('../core/migrations');
const lmMigrations = require('../db/migrations/logicmonitor');
const lmApi = require('../services/logicmonitorApi');
const metrics = require('../services/logicmonitorMetrics');
const settings = require('../services/settings');

beforeAll(() => { runMigrations(db, 'logicmonitor', lmMigrations); });

const TABLES = ['lm_sources', 'lm_devices', 'lm_device_datasources', 'lm_ds_instances', 'lm_ds_metrics', 'lm_ds_metrics_history'];
const wipe = () => { for (const t of [...TABLES].reverse()) db.prepare(`DELETE FROM ${t}`).run(); };
const now = () => Math.floor(Date.now() / 1000);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function seed(n) {
  const sid = db.prepare(`INSERT INTO lm_sources (name, company, auth_mode, encrypted_credentials, metrics_poll_minutes)
    VALUES ('portal1', 'acme', 'lmv1', 'x', 30)`).run().lastInsertRowid;
  for (let i = 1; i <= n; i++) {
    db.prepare('INSERT INTO lm_devices (source_id, lm_device_id, name, display_name, is_network, stale) VALUES (?, ?, ?, ?, 1, 0)').run(sid, i, `dev${i}`, `dev${i}`);
    db.prepare(`INSERT INTO lm_device_datasources (source_id, lm_device_id, hds_id, datasource_name, instance_count, stop_monitoring, is_interface, is_neighbor)
      VALUES (?, ?, ?, 'PaloAlto_FW_GlobalSessions', 1, 0, 0, 0)`).run(sid, i, 1000 + i);
  }
  return sid;
}

const body = () => ({
  dataSourceName: 'PaloAlto_FW_GlobalSessions',
  dataPoints: ['ActiveSessions', 'MaxSessions', 'SessionUtilization'],
  instances: { 'PaloAlto_FW_GlobalSessions-Global [ID:1]': { time: [(now() - 60) * 1000], values: [[150, 1000, 15]] } },
});

describe('pollMetrics concurrency', () => {
  let spy;
  beforeEach(() => { wipe(); });
  afterEach(() => {
    if (spy) spy.mockRestore();
    spy = null;
    db.prepare("DELETE FROM app_settings WHERE key = 'poller_calls_in_flight'").run();
  });

  async function timed(limit, calls = 40, failId = null) {
    wipe();
    const sid = seed(calls);
    settings.setSetting('poller_calls_in_flight', String(limit));
    let active = 0;
    let peak = 0;
    spy = vi.spyOn(lmApi, 'fetchDsData').mockImplementation(async (src, dev, hds) => {
      active += 1;
      peak = Math.max(peak, active);
      await sleep(50);
      active -= 1;
      if (failId && hds === failId) throw new Error('HTTP 500');
      return body();
    });
    const src = db.prepare('SELECT * FROM lm_sources WHERE id = ?').get(sid);
    const t0 = Date.now();
    const r = await metrics.pollMetrics(src);
    const ms = Date.now() - t0;
    spy.mockRestore();
    spy = null;
    return { r, ms, peak, sid };
  }

  it('limit 4 finishes in well under the sequential time and writes every DataSource', async () => {
    const four = await timed(4);
    expect(four.r.ok).toBe(40);
    expect(four.r.inFlight).toBe(4);
    expect(four.peak).toBe(4);
    expect(four.ms).toBeLessThan(40 * 50 * 0.5);
    expect(db.prepare('SELECT COUNT(*) c FROM lm_ds_metrics WHERE source_id = ?').get(four.sid).c).toBeGreaterThan(0);
  });

  it('limit 1 stays close to the sequential time', async () => {
    const one = await timed(1);
    expect(one.r.ok).toBe(40);
    expect(one.peak).toBe(1);
    expect(one.ms).toBeGreaterThanOrEqual(40 * 50 * 0.9);
  });

  it('a failing DataSource is marked and the rest still land', async () => {
    const res = await timed(4, 12, 1005);
    expect(res.r.ok).toBe(11);
    expect(res.r.failed).toBe(1);
    const row = db.prepare('SELECT metrics_last_error FROM lm_device_datasources WHERE hds_id = 1005').get();
    expect(row.metrics_last_error).toMatch(/500/);
  });
});
