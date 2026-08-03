/**
 * Self-contained Cohesity Object 360 backend test (WP-A). Wires a minimal
 * express app directly to routes/cohesityObject360.js against the shared
 * per-file test DB (mirrors tests/netbackupPlugin.test.js).
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { createRequire } from 'module';
import express from 'express';
import request from 'supertest';

const require = createRequire(import.meta.url);

const db = require('../db/database');
const object360Router = require('../routes/cohesityObject360');

let app;
let clusterId;

beforeAll(() => {
  app = express();
  app.use('/api/cohesity/object-360', object360Router);

  const info = db.prepare(`
    INSERT INTO clusters (name, vip, connection_type, auth_type, encrypted_credentials)
    VALUES (?, ?, ?, ?, ?)
  `).run('test-cluster', '10.0.0.1', 'direct', 'apikey', 'enc');
  clusterId = info.lastInsertRowid;

  db.prepare(`
    INSERT INTO cohesity_objects (cluster_id, name, environment, object_type, os_type,
      source_name, is_protected, protection_groups, policy_names, last_backup_status,
      last_backup_ms, sla_violated, logical_bytes)
    VALUES (?, 'obj360-server1', 'kVMware', 'kVirtualMachine', 'Linux', 'vc1', 1, ?, ?, 'kSuccess', ?, 0, 123456789)
  `).run(clusterId, JSON.stringify(['group-a']), JSON.stringify(['policy-a']), Date.now() - 3600000);

  const startEpoch = Math.floor(Date.now() / 1000) - 86400;
  db.prepare(`
    INSERT INTO protection_runs (cluster_id, job_id, job_name, run_type, status, start_time, end_time, logical_bytes)
    VALUES (?, 1, 'group-a', 'kRegular', 'kSuccess', ?, ?, 123456789)
  `).run(clusterId, startEpoch, startEpoch + 600);

  db.prepare(`
    INSERT INTO alerts (cluster_id, cohesity_alert_id, severity, alert_type, description, resolved, dismissed, first_seen)
    VALUES (?, 'alert-1', 'critical', 'kDiskFailure', 'Disk failure detected', 0, 0, CURRENT_TIMESTAMP)
  `).run(clusterId);
});

describe('GET /api/cohesity/object-360/suggest', () => {
  it('200 with names matching the query', async () => {
    const res = await request(app).get('/api/cohesity/object-360/suggest?q=obj360');
    expect(res.status).toBe(200);
    expect(res.body.names).toContain('obj360-server1');
  });

  it('400 without q', async () => {
    const res = await request(app).get('/api/cohesity/object-360/suggest');
    expect(res.status).toBe(400);
  });
});

describe('GET /api/cohesity/object-360', () => {
  it('200 with found:true and the expected shape for a seeded object', async () => {
    const res = await request(app).get('/api/cohesity/object-360?name=obj360-server1');
    expect(res.status).toBe(200);
    expect(res.body.found).toBe(true);
    expect(res.body.objects).toHaveLength(1);
    expect(res.body.objects[0]).toMatchObject({
      name: 'obj360-server1',
      environment: 'kVMware',
      isProtected: true,
      clusterName: 'test-cluster',
      protectionGroups: ['group-a'],
      policyNames: ['policy-a'],
    });
    expect(res.body.runs14d.length).toBeGreaterThan(0);
    expect(res.body.runs14d[0]).toHaveProperty('status');
    expect(res.body.alerts).toHaveLength(1);
    expect(res.body.alerts[0]).toMatchObject({ severity: 'critical', alertType: 'kDiskFailure', clusterName: 'test-cluster' });
  });

  it('200 with found:false for an unknown name', async () => {
    const res = await request(app).get('/api/cohesity/object-360?name=does-not-exist');
    expect(res.status).toBe(200);
    expect(res.body.found).toBe(false);
    expect(res.body.objects).toEqual([]);
  });

  it('400 without name', async () => {
    const res = await request(app).get('/api/cohesity/object-360');
    expect(res.status).toBe(400);
  });
});
