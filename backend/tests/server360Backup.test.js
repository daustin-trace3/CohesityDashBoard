/**
 * Server 360 backup panel: a server known to several Cohesity clusters shows
 * only the entries that hold a backup, unless none of them does.
 */
import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import { createRequire } from 'module';
import express from 'express';
import request from 'supertest';

const require = createRequire(import.meta.url);
const db = require('../db/database');
const server360Router = require('../routes/server360');

let app;
let clusterA;
let clusterB;

function cluster(name) {
  return db.prepare(`
    INSERT INTO clusters (name, connection_type, auth_type, encrypted_credentials)
    VALUES (?, 'direct', 'userpass', 'enc')
  `).run(name).lastInsertRowid;
}

function object(clusterId, name, lastBackupMs) {
  db.prepare(`
    INSERT INTO cohesity_objects (cluster_id, object_id, name, is_protected, last_backup_ms, last_backup_status)
    VALUES (?, ?, ?, 1, ?, 'kSuccess')
  `).run(clusterId, `obj-${clusterId}-${name}`, name, lastBackupMs);
}

beforeAll(() => {
  app = express();
  app.use((req, res, next) => { req.auth = { grants: ['*:*:*'], user: { username: 'tester' } }; next(); });
  app.use('/api/server-360', server360Router);
});

beforeEach(() => {
  db.exec('DELETE FROM cohesity_objects');
  db.exec("DELETE FROM clusters WHERE name IN ('s360-a', 's360-b')");
  clusterA = cluster('s360-a');
  clusterB = cluster('s360-b');
});

describe('Server 360 Cohesity entries', () => {
  it('keeps only the entries with a backup time and counts the rest', async () => {
    object(clusterA, 'srv-multi', null);
    object(clusterB, 'srv-multi', Date.now() - 50 * 3600000);
    const res = await request(app).get('/api/server-360').query({ name: 'srv-multi' });
    expect(res.status).toBe(200);
    expect(res.body.cohesity.objects.map((o) => o.cluster_name)).toEqual(['s360-b']);
    expect(res.body.cohesity.hiddenObjects).toBe(1);
  });

  it('with no backup time anywhere every entry stays', async () => {
    object(clusterA, 'srv-none', null);
    object(clusterB, 'srv-none', null);
    const res = await request(app).get('/api/server-360').query({ name: 'srv-none' });
    expect(res.body.cohesity.objects).toHaveLength(2);
    expect(res.body.cohesity.hiddenObjects).toBe(0);
  });
});
