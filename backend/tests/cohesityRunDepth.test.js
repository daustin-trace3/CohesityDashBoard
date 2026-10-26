/**
 * Cohesity run history depth: backfill window when the depth was raised, the
 * per-cluster marker, and the prune of rows older than the depth.
 */
import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);

const db = require('../db/database');
const poller = require('../services/poller');
const { getSetting, setSetting } = require('../services/settings');

const DAY = 86400000;
let clusterId;

const insRun = () => db.prepare(`
  INSERT INTO protection_runs (cluster_id, job_id, job_name, run_type, status, start_time, end_time, logical_bytes)
  VALUES (?, ?, 'g', 'kRegular', 'kSuccess', ?, ?, 1)
`);

beforeAll(() => {
  clusterId = db.prepare(`
    INSERT INTO clusters (name, vip, connection_type, auth_type, encrypted_credentials)
    VALUES ('depth-cluster', '10.0.0.8', 'direct', 'apikey', 'enc')
  `).run().lastInsertRowid;
});

beforeEach(() => {
  db.prepare('DELETE FROM replication_runs').run();
  db.prepare('DELETE FROM protection_runs').run();
  db.prepare("DELETE FROM app_settings WHERE key LIKE 'cohesity_runs_backfilled_days_%'").run();
  setSetting('cohesity_run_history_days', '90');
});

describe('runsFetchWindow', () => {
  it('empty table fetches the full depth, not incremental', () => {
    setSetting('cohesity_run_history_days', '120');
    const w = poller._runsFetchWindow(clusterId);
    expect(w.incremental).toBe(false);
    expect(w.numRuns).toBe(2000);
    expect(Math.abs(w.sinceUsecs / 1000 - (Date.now() - 120 * DAY))).toBeLessThan(5000);
  });

  it('returns a backfill window when the oldest row is newer than the floor and the marker is missing', () => {
    const start = new Date(Date.now() - 20 * DAY).toISOString();
    insRun().run(clusterId, 1, start, start);
    const w = poller._runsFetchWindow(clusterId);
    expect(w.backfill).toBe(true);
    expect(w.incremental).toBe(false);
    expect(w.numRuns).toBe(2000);
    expect(w.depth).toBe(90);
    expect(Math.abs(w.sinceUsecs / 1000 - (Date.now() - 90 * DAY))).toBeLessThan(5000);
  });

  it('goes incremental once the marker covers the depth, and backfills again when the depth is raised', () => {
    const start = new Date(Date.now() - 20 * DAY).toISOString();
    insRun().run(clusterId, 1, start, start);
    setSetting(`cohesity_runs_backfilled_days_${clusterId}`, '90');
    const w = poller._runsFetchWindow(clusterId);
    expect(w.backfill).toBeUndefined();
    expect(w.incremental).toBe(true);
    expect(w.numRuns).toBe(500);
    setSetting('cohesity_run_history_days', '180');
    expect(poller._runsFetchWindow(clusterId).backfill).toBe(true);
  });

  it('stays incremental when the oldest row already reaches the floor', () => {
    const old = new Date(Date.now() - 89.5 * DAY).toISOString();
    insRun().run(clusterId, 1, old, old);
    const w = poller._runsFetchWindow(clusterId);
    expect(w.incremental).toBe(true);
    expect(w.backfill).toBeUndefined();
  });
});

describe('pruneRunHistory', () => {
  it('removes runs older than the depth and their replication legs, keeps the rest', () => {
    const ins = insRun();
    const iso = (d) => new Date(Date.now() - d * DAY).toISOString();
    const oldId = ins.run(clusterId, 1, iso(100), iso(100)).lastInsertRowid;
    const newId = ins.run(clusterId, 2, iso(10), iso(10)).lastInsertRowid;
    // Legacy epoch-seconds rows are pruned by the same expression.
    const legacyOld = ins.run(clusterId, 3, String(Math.floor((Date.now() - 200 * DAY) / 1000)), null).lastInsertRowid;
    const insRep = db.prepare(`
      INSERT INTO replication_runs (protection_run_id, cluster_id, target_cluster_name, status) VALUES (?, ?, 'dr', 'kSuccess')
    `);
    insRep.run(oldId, clusterId);
    insRep.run(newId, clusterId);
    insRep.run(legacyOld, clusterId);

    const out = poller._pruneRunHistory(clusterId, 90);
    expect(out.runs).toBe(2);
    expect(db.prepare('SELECT id FROM protection_runs').all().map((r) => r.id)).toEqual([newId]);
    expect(db.prepare('SELECT protection_run_id p FROM replication_runs').all().map((r) => r.p)).toEqual([newId]);
  });

  it('is a no-op when nothing is old enough', () => {
    const s = new Date(Date.now() - 5 * DAY).toISOString();
    insRun().run(clusterId, 1, s, s);
    expect(poller._pruneRunHistory(clusterId, 90)).toEqual({ runs: 0, replication: 0 });
  });
});

describe('marker key', () => {
  it('is stored per cluster', () => {
    setSetting(`cohesity_runs_backfilled_days_${clusterId}`, '90');
    expect(getSetting(`cohesity_runs_backfilled_days_${clusterId}`)).toBe('90');
    expect(getSetting('cohesity_runs_backfilled_days_999999')).toBeFalsy();
  });
});
