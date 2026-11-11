/**
 * Per-family checks that the converted prune sites follow the Data retention buckets:
 * 0 keeps rows, a lowered value removes them, a platform override beats the global.
 */
const adminOf = (d) => d.adminHandle || d; // admin tables are written through the admin connection (db/adminSplit.js)
import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const db = require('../db/database');
const { runMigrations } = require('../core/migrations');
const retention = require('../core/retention');

const iso = (daysAgo) => new Date(Date.now() - daysAgo * 86400000).toISOString();
const day = (daysAgo) => iso(daysAgo).slice(0, 10);
const count = (sql) => db.prepare(sql).get().n;

function clear() {
  adminOf(db).prepare("DELETE FROM app_settings WHERE key LIKE 'retention_%'").run();
}

// Hyper-V is a feat/multi-tenant platform only; icc-phase1 has no hyperv migrations or service.
const HAS_HYPERV = require('fs').existsSync(require('path').join(__dirname, '../db/migrations/hyperv.js'));
(HAS_HYPERV ? describe : describe.skip)('Hyper-V pruneHistory', () => {
  let capacity;
  beforeAll(() => {
    runMigrations(db, 'hyperv', require('../db/migrations/hyperv'));
    capacity = require('../services/hypervCapacity');
    db.pragma('foreign_keys = OFF');
  });
  afterAll(() => { db.pragma('foreign_keys = ON'); });
  beforeEach(() => {
    clear();
    for (const t of ['hyperv_host_history', 'hyperv_vm_daily', 'hyperv_issue_history']) db.prepare(`DELETE FROM ${t}`).run();
    db.prepare('INSERT INTO hyperv_host_history (source_id, captured_at, host_name) VALUES (1, ?, ?)').run(iso(100), 'old');
    db.prepare('INSERT INTO hyperv_host_history (source_id, captured_at, host_name) VALUES (1, ?, ?)').run(iso(5), 'new');
    db.prepare('INSERT INTO hyperv_vm_daily (source_id, vm_id, vm_name, day) VALUES (1, ?, ?, ?)').run('a', 'old', day(100));
  });

  it('keeps everything under the default 365 days', () => {
    capacity.pruneHistory();
    expect(count('SELECT COUNT(*) n FROM hyperv_host_history')).toBe(2);
  });

  it('a lowered platform trending value removes older rows from the history and daily tables', () => {
    retention.setPlatform('hyperv', 'trending', 30);
    capacity.pruneHistory();
    expect(count('SELECT COUNT(*) n FROM hyperv_host_history')).toBe(1);
    expect(count('SELECT COUNT(*) n FROM hyperv_vm_daily')).toBe(0);
  });

  it('0 keeps forever even when the global is low', () => {
    retention.setGlobal('trending', 30);
    retention.setPlatform('hyperv', 'trending', 0);
    capacity.pruneHistory();
    expect(count('SELECT COUNT(*) n FROM hyperv_host_history')).toBe(2);
    expect(count('SELECT COUNT(*) n FROM hyperv_vm_daily')).toBe(1);
  });

  it('the global applies when no platform override is set', () => {
    retention.setGlobal('trending', 60);
    capacity.pruneHistory();
    expect(count('SELECT COUNT(*) n FROM hyperv_host_history')).toBe(1);
  });
});

describe('Brocade events (epoch_ms) and the events bucket', () => {
  beforeAll(() => {
    runMigrations(db, 'brocade', require('../db/migrations/brocade'));
    db.pragma('foreign_keys = OFF');
  });
  afterAll(() => { db.pragma('foreign_keys = ON'); });
  beforeEach(() => {
    clear();
    db.prepare('DELETE FROM brocade_events').run();
    const ins = db.prepare('INSERT INTO brocade_events (source_id, event_id, last_occurred_ms) VALUES (1, ?, ?)');
    ins.run('old', Date.now() - 60 * 86400000);
    ins.run('new', Date.now() - 2 * 86400000);
  });
  const run = () => retention.prune(db, { platform: 'brocade', bucket: 'events', table: 'brocade_events', column: 'last_occurred_ms', kind: 'epoch_ms', where: 'source_id = ?', params: [1] });

  it('default 30 days drops the 60 day old row only', () => {
    expect(run().deleted).toBe(1);
    expect(count('SELECT COUNT(*) n FROM brocade_events')).toBe(1);
  });
  it('0 keeps both', () => {
    retention.setPlatform('brocade', 'events', 0);
    expect(run().skipped).toBe(true);
    expect(count('SELECT COUNT(*) n FROM brocade_events')).toBe(2);
  });
  it('a 90 day override keeps both', () => {
    retention.setPlatform('brocade', 'events', 90);
    run();
    expect(count('SELECT COUNT(*) n FROM brocade_events')).toBe(2);
  });
});

describe('AWS FinOps runPrunes', () => {
  let finops;
  beforeAll(() => {
    runMigrations(db, 'aws', require('../db/migrations/aws'));
    finops = require('../services/awsFinops');
    db.pragma('foreign_keys = OFF');
  });
  afterAll(() => { db.pragma('foreign_keys = ON'); });
  beforeEach(() => {
    clear();
    db.prepare('DELETE FROM aws_cost_forecast').run();
    const ins = db.prepare(`INSERT INTO aws_cost_forecast (account_id, scope, metric, period_start, period_end, generated_on, source)
      VALUES (1, 'total', 'm', ?, ?, ?, 'test')`);
    ins.run(day(500), day(470), day(500));
    ins.run(day(10), day(-20), day(10));
  });

  it('default 365 days removes the 500 day old forecast', () => {
    finops.runPrunes(Date.now());
    expect(count('SELECT COUNT(*) n FROM aws_cost_forecast')).toBe(1);
  });
  it('0 keeps forever', () => {
    retention.setPlatform('aws', 'trending', 0);
    finops.runPrunes(Date.now());
    expect(count('SELECT COUNT(*) n FROM aws_cost_forecast')).toBe(2);
  });
  it('a 5 day-old row survives a 30 day override and a 3650 day override keeps the old one', () => {
    retention.setPlatform('aws', 'trending', 30);
    finops.runPrunes(Date.now());
    expect(count('SELECT COUNT(*) n FROM aws_cost_forecast')).toBe(1);
    db.prepare('DELETE FROM aws_cost_forecast').run();
    db.prepare("INSERT INTO aws_cost_forecast (account_id, scope, metric, period_start, period_end, generated_on, source) VALUES (1, 'total', 'm', ?, ?, ?, 'test')").run(day(500), day(470), day(500));
    retention.setPlatform('aws', 'trending', 3650);
    finops.runPrunes(Date.now());
    expect(count('SELECT COUNT(*) n FROM aws_cost_forecast')).toBe(1);
  });
});

describe('Service Status icc rows follow the global values', () => {
  beforeEach(clear);
  it('icc has no platform override of its own', () => {
    retention.setGlobal('trending', 90);
    expect(retention.days('icc', 'trending')).toBe(90);
    expect(retention.days('icc', 'events')).toBe(30);
  });
});
