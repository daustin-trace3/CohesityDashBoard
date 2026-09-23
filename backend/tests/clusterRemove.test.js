/**
 * Removing a Cohesity cluster from the dashboard: the row, everything collected
 * for it, and its poll status row go; other clusters are untouched.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { createRequire } from 'module';
import express from 'express';
import request from 'supertest';

const require = createRequire(import.meta.url);
const db = require('../db/database');
const pollerStatus = require('../services/pollerStatus');
const { refreshDashboardSnapshot, getDashboardSnapshot } = require('../services/snapshot');
const clustersRouter = require('../routes/clusters');

let app;

function cluster(name, vip) {
  return db.prepare(`
    INSERT INTO clusters (name, vip, connection_type, auth_type, encrypted_credentials)
    VALUES (?, ?, 'helios', 'apikey', 'enc')
  `).run(name, vip).lastInsertRowid;
}

beforeAll(() => {
  app = express();
  app.use(express.json());
  app.use((req, res, next) => { req.auth = { grants: ['*:*:*'], user: { username: 'tester' } }; next(); });
  app.use('/api/clusters', clustersRouter);
});

describe('DELETE /api/clusters/:id', () => {
  it('removes the cluster, its collected rows and its poll status, and leaves the others alone', async () => {
    const gone = cluster('remove-me-az', '1111111111');
    const kept = cluster('keep-me-az', '2222222222');
    for (const id of [gone, kept]) {
      db.prepare("INSERT INTO cohesity_objects (cluster_id, name, is_protected) VALUES (?, 'srv', 1)").run(id);
      pollerStatus.markStart('cohesity', id);
      pollerStatus.markEnd('cohesity', id, 'success');
    }

    // The Overview reads this cached payload; it must not keep the removed cluster.
    refreshDashboardSnapshot();
    expect(getDashboardSnapshot().clusters.map(c => c.id)).toContain(gone);

    const res = await request(app).delete(`/api/clusters/${gone}`);
    expect(res.status).toBe(200);

    const snapshotIds = getDashboardSnapshot().clusters.map(c => c.id);
    expect(snapshotIds).not.toContain(gone);
    expect(snapshotIds).toContain(kept);

    const count = (sql, id) => db.prepare(sql).get(id).c;
    expect(count('SELECT COUNT(*) c FROM clusters WHERE id = ?', gone)).toBe(0);
    expect(count('SELECT COUNT(*) c FROM cohesity_objects WHERE cluster_id = ?', gone)).toBe(0);
    expect(count("SELECT COUNT(*) c FROM poller_status WHERE type = 'cohesity' AND entity_id = ?", gone)).toBe(0);
    expect(count('SELECT COUNT(*) c FROM clusters WHERE id = ?', kept)).toBe(1);
    expect(count('SELECT COUNT(*) c FROM cohesity_objects WHERE cluster_id = ?', kept)).toBe(1);
    expect(count("SELECT COUNT(*) c FROM poller_status WHERE type = 'cohesity' AND entity_id = ?", kept)).toBe(1);

    expect((await request(app).delete(`/api/clusters/${gone}`)).status).toBe(404);
    db.prepare('DELETE FROM clusters WHERE id = ?').run(kept);
    db.prepare("DELETE FROM poller_status WHERE type = 'cohesity' AND entity_id = ?").run(kept);
  });
});
