/**
 * Round 10 WP-C: GET /api/aws/network-circuits returns the LogicMonitor cloud rows whose
 * system.aws.ownerAccount equals a registered ICC AWS account number.
 */
import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import { createRequire } from 'module';
import express from 'express';
import request from 'supertest';

const require = createRequire(import.meta.url);
const db = require('../db/database');
const { runMigrations } = require('../core/migrations');
const awsMigrations = require('../db/migrations/aws');
const lmMigrations = require('../db/migrations/logicmonitor');
const { encrypt } = require('../services/encryption');

let app;
beforeAll(() => {
  runMigrations(db, 'aws', awsMigrations);
  runMigrations(db, 'logicmonitor', lmMigrations);
  app = express();
  app.use(express.json());
  app.use('/api/aws', require('../routes/aws'));
});

const NOW = Math.floor(Date.now() / 1000);
let sid;
beforeEach(() => {
  for (const t of ['lm_ds_metrics', 'lm_ds_instances', 'lm_devices', 'lm_sources', 'aws_accounts']) db.prepare(`DELETE FROM ${t}`).run();
  sid = db.prepare('INSERT INTO lm_sources (name, company, auth_mode, encrypted_credentials) VALUES (?, ?, ?, ?)')
    .run('Acme', 'acme', 'lmv1', encrypt(JSON.stringify({ accessId: 'a', accessKey: 'b' }))).lastInsertRowid;
});

function dx(id, name, owner) {
  db.prepare(`INSERT INTO lm_devices (source_id, lm_device_id, name, display_name, device_type, host_status, sdt_status, vendor, role, is_network, ert,
    system_props_json, site_key, stale) VALUES (?, ?, ?, ?, 2, 'normal', 'none-none-none', 'AWS', 'other', 0, 'AWS/DirectConnect', ?, 'aws', 0)`)
    .run(sid, id, name, name, JSON.stringify([{ name: 'system.aws.ownerAccount', value: owner }, { name: 'system.aws.bandwidth', value: '10Gbps' }]));
  db.prepare(`INSERT INTO lm_ds_instances (source_id, lm_device_id, hds_id, datasource_name, family, instance_key, instance_name, stale)
    VALUES (?, ?, ?, 'AWS_DirectConnect_Connection', 'cloud', 'c', 'c', 0)`).run(sid, id, 8000 + id);
  db.prepare(`INSERT INTO lm_ds_metrics (source_id, lm_device_id, hds_id, datasource_name, family, instance_key, metric, datapoint, value, sampled_at_epoch)
    VALUES (?, ?, ?, 'AWS_DirectConnect_Connection', 'cloud', 'c', 'dx_state', 'dx_state', 1, ?)`).run(sid, id, 8000 + id, NOW - 60);
}

describe('GET /api/aws/network-circuits', () => {
  it('returns only rows owned by a registered account number', async () => {
    db.prepare("INSERT INTO aws_accounts (name, access_key_id, region, polling_interval_minutes, account_number) VALUES ('mine', 'AKIA', 'us-east-1', 10, '893373391538')").run();
    dx(1, 'dx-mine', '893373391538');
    dx(2, 'dx-other', '000000000001');
    const res = await request(app).get('/api/aws/network-circuits');
    expect(res.status).toBe(200);
    expect(res.body.map((r) => r.name)).toEqual(['dx-mine']);
    expect(res.body[0]).toMatchObject({ ownerAccount: '893373391538', bandwidthBps: 1e10 });
  });

  it('answers [] when no account has a number yet', async () => {
    db.prepare("INSERT INTO aws_accounts (name, access_key_id, region, polling_interval_minutes) VALUES ('nonum', 'AKIA', 'us-east-1', 10)").run();
    dx(1, 'dx-mine', '893373391538');
    const res = await request(app).get('/api/aws/network-circuits');
    expect(res.status).toBe(200);
    expect(res.body).toEqual([]);
  });

  it('exposes accountNumber on /accounts', async () => {
    db.prepare("INSERT INTO aws_accounts (name, access_key_id, region, polling_interval_minutes, account_number) VALUES ('mine', 'AKIA', 'us-east-1', 10, '893373391538')").run();
    const res = await request(app).get('/api/aws/accounts');
    expect(res.body[0].accountNumber).toBe('893373391538');
  });
});
