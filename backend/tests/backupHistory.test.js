/**
 * Cohesity Backup History route: shared range params, response additions and
 * export.csv. Mounts the router on a scratch express app against the per-file
 * test DB.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { createRequire } from 'module';
import express from 'express';
import request from 'supertest';

const require = createRequire(import.meta.url);

const db = require('../db/database');
const router = require('../routes/backupHistory');
const { setSetting } = require('../services/settings');

let app;
const DAY = 86400000;

beforeAll(() => {
  app = express();
  app.use('/api/cohesity/backup-history', router);

  const clusterId = db.prepare(`
    INSERT INTO clusters (name, vip, connection_type, auth_type, encrypted_credentials)
    VALUES ('bh-cluster', '10.0.0.9', 'direct', 'apikey', 'enc')
  `).run().lastInsertRowid;
  db.prepare(`
    INSERT INTO cohesity_objects (cluster_id, name, environment, object_type, os_type, source_name,
      is_protected, protection_groups, policy_names, last_backup_status, sla_violated, logical_bytes)
    VALUES (?, 'bh-server1', 'kVMware', 'kVirtualMachine', 'Linux', 'vc1', 1, ?, ?, 'kSuccess', 0, 1000)
  `).run(clusterId, JSON.stringify(['bh-group']), JSON.stringify(['gold']));

  const insRun = db.prepare(`
    INSERT INTO protection_runs (cluster_id, job_id, job_name, run_type, status, start_time, end_time,
      error_code, error_message, logical_bytes)
    VALUES (?, 1, 'bh-group', 'kRegular', ?, ?, ?, ?, ?, ?)
  `);
  const insRep = db.prepare(`
    INSERT INTO replication_runs (protection_run_id, cluster_id, target_cluster_name, status, logical_bytes, lag_seconds)
    VALUES (?, ?, 'dr-cluster', 'kSuccess', 500, 120)
  `);
  // One run at noon UTC for each of the last 60 days, one of them failed with
  // a message that starts like a spreadsheet formula.
  for (let d = 0; d < 60; d++) {
    const start = new Date(Date.now() - d * DAY);
    start.setUTCHours(12, 0, 0, 0);
    const end = new Date(start.getTime() + 600000);
    const failed = d === 3;
    const id = insRun.run(
      clusterId, failed ? 'kFailure' : 'kSuccess', start.toISOString(), end.toISOString(),
      failed ? 'kTimeout' : null, failed ? '=cmd|calc, "bad"' : null, 1000,
    ).lastInsertRowid;
    if (d === 1) insRep.run(id, clusterId);
  }
});

describe('GET /api/cohesity/backup-history', () => {
  it('days=7 returns 7 dayKeys and the response additions', async () => {
    const res = await request(app).get('/api/cohesity/backup-history?q=bh-server&days=7');
    expect(res.status).toBe(200);
    expect(res.body.dayKeys).toHaveLength(7);
    expect(res.body.range).toMatchObject({ mode: 'days', days: 7, tz: 0 });
    expect(res.body.historyDays).toBe(90);
    expect(res.body.truncated).toBe(false);
    expect(res.body.servers).toHaveLength(1);
    // Runs sit at 12:00 UTC; "today" noon may be in the future, so 6 or 7.
    expect(res.body.servers[0].runs.length).toBeGreaterThanOrEqual(6);
    expect(res.body.servers[0].runs.length).toBeLessThanOrEqual(7);
    expect(res.body.servers[0].runs[0]).toHaveProperty('startMs');
  });

  it('accepts ranges beyond 31 days up to 365', async () => {
    const res = await request(app).get('/api/cohesity/backup-history?q=bh-server&days=90');
    expect(res.status).toBe(200);
    expect(res.body.dayKeys).toHaveLength(90);
    expect(res.body.servers[0].runs).toHaveLength(60);
    const bad = await request(app).get('/api/cohesity/backup-history?q=bh-server&days=366');
    expect(bad.status).toBe(400);
  });

  it('custom from/to is inclusive on both ends', async () => {
    const day = (d) => new Date(Date.now() - d * DAY).toISOString().slice(0, 10);
    const res = await request(app).get(`/api/cohesity/backup-history?q=bh-server&from=${day(9)}&to=${day(5)}`);
    expect(res.status).toBe(200);
    expect(res.body.range.mode).toBe('custom');
    expect(res.body.dayKeys).toHaveLength(5);
    expect(res.body.dayKeys[0]).toBe(day(5));
    expect(res.body.dayKeys[4]).toBe(day(9));
    expect(res.body.servers[0].runs).toHaveLength(5);
  });

  it('rejects an inverted custom range', async () => {
    const res = await request(app).get('/api/cohesity/backup-history?from=2026-10-10&to=2026-10-01');
    expect(res.status).toBe(400);
  });

  it('flags truncated when the range starts before the history depth', async () => {
    setSetting('cohesity_run_history_days', '30');
    const res = await request(app).get('/api/cohesity/backup-history?q=bh-server&days=90');
    expect(res.body.historyDays).toBe(30);
    expect(res.body.truncated).toBe(true);
    const ok = await request(app).get('/api/cohesity/backup-history?q=bh-server&days=14');
    expect(ok.body.truncated).toBe(false);
    setSetting('cohesity_run_history_days', '90');
  });
});

describe('GET /api/cohesity/backup-history/export.csv', () => {
  it('returns the header, one row per run and a guarded error cell', async () => {
    const res = await request(app).get('/api/cohesity/backup-history/export.csv?q=bh-server&days=7');
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toMatch(/text\/csv/);
    expect(res.headers['content-disposition']).toMatch(/attachment; filename="cohesity-backup-history-\d{4}-\d{2}-\d{2}_\d{4}-\d{2}-\d{2}\.csv"/);
    const lines = res.text.trim().split('\r\n');
    expect(lines[0]).toBe('Server,Cluster,Protection Group,Policy,Run Type,Status,Start,End,Duration (min),Logical Bytes,Error Code,Error Message,Replication Targets,Replication Status,Replication Lag (s)');
    expect(lines.length).toBeGreaterThanOrEqual(7);
    expect(lines.length).toBeLessThanOrEqual(8);
    expect(res.text).toContain('"\'=cmd|calc, ""bad"""');
    expect(res.text).toContain('dr-cluster,kSuccess,120');
    expect(lines[1]).toContain('bh-server1,bh-cluster,bh-group,gold');
  });

  it('honours the same range as the page', async () => {
    const page = await request(app).get('/api/cohesity/backup-history?q=bh-server&days=14');
    const res = await request(app).get('/api/cohesity/backup-history/export.csv?q=bh-server&days=14');
    expect(res.text.trim().split('\r\n')).toHaveLength(1 + page.body.servers[0].runs.length);
    const bad = await request(app).get('/api/cohesity/backup-history/export.csv?days=0');
    expect(bad.status).toBe(400);
  });
});
