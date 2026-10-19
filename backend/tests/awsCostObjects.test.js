/**
 * AWS cost objects: which inventory or billed objects sit behind each usage type.
 * Derived mapping (usageTypeObjects), fetchCostByResourceUsage, migration v10 and the two routes.
 */
import { describe, it, expect, beforeAll, afterEach, vi } from 'vitest';
import { createRequire } from 'module';
import express from 'express';
import request from 'supertest';

const require = createRequire(import.meta.url);

const db = require('../db/database');
const Database = require('better-sqlite3');
const { runMigrations } = require('../core/migrations');
const awsMigrations = require('../db/migrations/aws');
const awsApi = require('../services/awsApi');
const { usageTypeObjects, REGION_PREFIXES } = require('../services/awsCostNotes');
const CE = require('@aws-sdk/client-cost-explorer');

beforeAll(() => {
  runMigrations(db, 'aws', awsMigrations);
});

const names = (r) => r.objects.map((o) => o.label).sort();

describe('migration v10', () => {
  it('creates aws_cost_resource_usage_daily with its unique key', () => {
    const scratch = new Database(':memory:');
    runMigrations(scratch, 'aws', awsMigrations);
    expect(scratch.prepare("SELECT name FROM sqlite_master WHERE name = 'aws_cost_resource_usage_daily'").get()).toBeTruthy();
    scratch.prepare("INSERT INTO aws_accounts (name) VALUES ('a')").run();
    const ins = scratch.prepare('INSERT INTO aws_cost_resource_usage_daily (account_id, day, usage_type, resource_id, amount_usd) VALUES (1, ?, ?, ?, 1)');
    ins.run('2026-10-01', 'BoxUsage:t3.medium', 'i-1');
    expect(() => ins.run('2026-10-01', 'BoxUsage:t3.medium', 'i-1')).toThrow();
    scratch.close();
  });
});

describe('usageTypeObjects (derived mapping)', () => {
  let acct;
  beforeAll(() => {
    acct = db.prepare("INSERT INTO aws_accounts (name, access_key_id, region, polling_interval_minutes) VALUES ('obj-acct', 'AKIAOBJ', 'us-east-1', 10)").run().lastInsertRowid;
    const ls = db.prepare(`INSERT INTO aws_lightsail_instances (account_id, name, state, bundle, az, ram_gb, is_windows, snapshot_count)
      VALUES (?, ?, 'running', ?, ?, ?, ?, ?)`);
    ls.run(acct, 'FSGCustPortal', 'large_3_0', 'us-east-1a', 8, 0, 0);
    ls.run(acct, 'crewai-oss', 'small_3_0', 'us-east-1a', 2, 0, 1);
    ls.run(acct, 'rapid7-scan-engine', 'xlarge_win_3_0', 'us-east-1a', 16, 1, 0);
    ls.run(acct, 'Windows_Server_2019-1', 'xlarge_win_3_0', 'us-east-2a', 16, 1, 0);
    db.prepare("INSERT INTO aws_lightsail_databases (account_id, name, engine, bundle, ram_gb, az, state) VALUES (?, 'ls-db-1', 'mysql', 'micro_2_0', 1, 'us-east-1a', 'available')").run(acct);
    const ec2 = db.prepare("INSERT INTO aws_ec2_instances (account_id, instance_id, name, state, instance_type, az, public_ip) VALUES (?, ?, ?, 'running', ?, ?, ?)");
    ec2.run(acct, 'i-aaa', 'web-1', 't3.medium', 'us-east-1b', '1.2.3.4');
    ec2.run(acct, 'i-bbb', 'web-2', 't3.medium', 'us-west-2a', null);
    const ebs = db.prepare("INSERT INTO aws_ebs_volumes (account_id, volume_id, volume_type, az) VALUES (?, ?, ?, ?)");
    ebs.run(acct, 'vol-east', 'gp3', 'us-east-1b');
    ebs.run(acct, 'vol-west', 'gp3', 'us-west-2a');
    db.prepare("INSERT INTO aws_rds_instances (account_id, db_id, engine, instance_class) VALUES (?, 'aur-1', 'aurora-mysql', 'db.r5.large')").run(acct);
    db.prepare("INSERT INTO aws_rds_instances (account_id, db_id, engine, instance_class) VALUES (?, 'pg-1', 'postgres', 'db.t3.micro')").run(acct);
  });

  it('matches FSGCustPortal to USE1-BundleUsage:8GB only', () => {
    const r = usageTypeObjects('USE1-BundleUsage:8GB', 'Amazon Lightsail', db, acct);
    expect(r.mode).toBe('inventory');
    expect(names(r)).toEqual(['FSGCustPortal']);
    expect(r.rule).toMatch(/8 GB bundle in us-east-1/);
    expect(usageTypeObjects('USE2-BundleUsage:8GB', 'Amazon Lightsail', db, acct).objects).toEqual([]);
    expect(names(usageTypeObjects('USE1-BundleUsage:16GB_win', 'Amazon Lightsail', db, acct))).toEqual(['rapid7-scan-engine']);
  });

  it('separates the Windows pair by region', () => {
    expect(names(usageTypeObjects('USE2-BundleUsage:16GB_win', 'Amazon Lightsail', db, acct))).toEqual(['Windows_Server_2019-1']);
    expect(names(usageTypeObjects('USE1-BundleUsage:2GB', 'Amazon Lightsail', db, acct))).toEqual(['crewai-oss']);
  });

  it('maps Lightsail databases, snapshots and pooled transfer', () => {
    expect(names(usageTypeObjects('USE1-DatabaseUsage:1GB', 'Amazon Lightsail', db, acct))).toEqual(['ls-db-1']);
    expect(names(usageTypeObjects('USE1-SnapshotUsage', 'Amazon Lightsail', db, acct))).toEqual(['crewai-oss']);
    const x = usageTypeObjects('USE1-TotalDataXfer-Out-Bytes', 'Amazon Lightsail', db, acct);
    expect(x.objectCount).toBe(3);
    expect(x.rule).toMatch(/transfer is pooled/);
  });

  it('treats an unprefixed EC2 and EBS usage type as us-east-1', () => {
    expect(names(usageTypeObjects('BoxUsage:t3.medium', 'Amazon Elastic Compute Cloud - Compute', db, acct))).toEqual(['web-1']);
    expect(names(usageTypeObjects('EBS:VolumeUsage.gp3', 'Amazon Elastic Compute Cloud - Compute', db, acct))).toEqual(['vol-east']);
  });

  it('keeps the region prefix for other regions', () => {
    expect(names(usageTypeObjects('USW2-EBS:VolumeUsage.gp3', 'EC2 - Other', db, acct))).toEqual(['vol-west']);
    expect(names(usageTypeObjects('USW2-BoxUsage:t3.medium', 'Amazon Elastic Compute Cloud - Compute', db, acct))).toEqual(['web-2']);
  });

  it('maps Aurora and RDS instance classes', () => {
    expect(names(usageTypeObjects('Aurora:StorageUsage', 'Amazon Relational Database Service', db, acct))).toEqual(['aur-1']);
    expect(names(usageTypeObjects('InstanceUsage:db.t3.micro', 'Amazon Relational Database Service', db, acct))).toEqual(['pg-1']);
  });

  it('has fixed answers for non-inventoried types and unknown types', () => {
    expect(usageTypeObjects('EBS:SnapshotUsage', 'EC2 - Other', db, acct).rule).toBe('Snapshots are not inventoried');
    expect(usageTypeObjects('Something-Unknown', 'Mystery Service', db, acct)).toEqual({ mode: 'inventory', objects: [], objectCount: 0, rule: null });
  });

  it('returns empty rather than throwing when a table is missing', () => {
    const bare = new Database(':memory:');
    expect(usageTypeObjects('USE1-BundleUsage:8GB', 'Amazon Lightsail', bare, null).objects).toEqual([]);
    bare.close();
  });

  it('exports the region prefix map', () => {
    expect(REGION_PREFIXES.USE1).toBe('us-east-1');
    expect(REGION_PREFIXES.SAE1).toBe('sa-east-1');
  });
});

describe('fetchCostByResourceUsage (stubbed client)', () => {
  const account = { region: 'us-east-1', access_key_id: '', encrypted_credentials: null };
  let spy;
  afterEach(() => { spy?.mockRestore(); });

  it('groups by USAGE_TYPE then RESOURCE_ID, pages and skips NoResourceId', async () => {
    const sent = [];
    spy = vi.spyOn(CE.CostExplorerClient.prototype, 'send').mockImplementation(async (cmd) => {
      sent.push(cmd.input);
      const n = sent.length;
      return {
        ResultsByTime: [{ TimePeriod: { Start: '2026-10-18' }, Groups: [
          { Keys: ['USE1-BundleUsage:8GB', `r-${n}`], Metrics: { UnblendedCost: { Amount: '2.5' } } },
          { Keys: ['USE1-BundleUsage:8GB', 'NoResourceId'], Metrics: { UnblendedCost: { Amount: '9' } } },
        ] }],
        ...(n < 2 ? { NextPageToken: 'tok' } : {}),
      };
    });
    const out = await awsApi.fetchCostByResourceUsage(account, { maxPages: 5, services: ['S'] });
    expect(sent[0].GroupBy).toEqual([{ Type: 'DIMENSION', Key: 'USAGE_TYPE' }, { Type: 'DIMENSION', Key: 'RESOURCE_ID' }]);
    expect(sent[1].NextPageToken).toBe('tok');
    expect(out.pages).toBe(2);
    expect(out.rows).toEqual([
      { day: '2026-10-18', usageType: 'USE1-BundleUsage:8GB', resourceId: 'r-1', amountUsd: 2.5 },
      { day: '2026-10-18', usageType: 'USE1-BundleUsage:8GB', resourceId: 'r-2', amountUsd: 2.5 },
    ]);
  });
});

describe('cost routes with objects', () => {
  let app;
  let acctId;
  const today = new Date().toISOString().slice(0, 10);

  beforeAll(async () => {
    const router = require('../routes/aws');
    app = express();
    app.use(express.json());
    app.use('/api/aws', router);
    acctId = db.prepare("INSERT INTO aws_accounts (name, access_key_id, region, polling_interval_minutes) VALUES ('route-obj', 'AKIAROUTE', 'us-east-1', 10)").run().lastInsertRowid;
    db.prepare("INSERT INTO aws_lightsail_instances (account_id, name, state, bundle, az, ram_gb, is_windows) VALUES (?, 'FSGCustPortal', 'running', 'large_3_0', 'us-east-1a', 8, 0)").run(acctId);
    const u = db.prepare('INSERT INTO aws_cost_usage_daily (account_id, day, service, usage_type, amount_usd) VALUES (?, ?, ?, ?, ?)');
    u.run(acctId, today, 'Amazon Lightsail', 'USE1-BundleUsage:8GB', 10);
    u.run(acctId, today, 'Amazon Lightsail', 'USE1-DatabaseUsage:1GB', 5);
    db.prepare('INSERT INTO aws_cost_resource_usage_daily (account_id, day, usage_type, resource_id, amount_usd) VALUES (?, ?, ?, ?, ?)')
      .run(acctId, today, 'USE1-DatabaseUsage:1GB', 'arn:aws:lightsail:us-east-1:1:RelationalDatabase/ls-db-9', 4.5);
  });

  it('/costs/usage-types gives inventory objects when no billing rows exist', async () => {
    const res = await request(app).get(`/api/aws/costs/usage-types?accountId=${acctId}&service=${encodeURIComponent('Amazon Lightsail')}`);
    expect(res.status).toBe(200);
    const bundle = res.body.rows.find((r) => r.usageType === 'USE1-BundleUsage:8GB');
    expect(bundle.objectsMode).toBe('inventory');
    expect(bundle.objects.map((o) => o.label)).toEqual(['FSGCustPortal']);
    expect(bundle.objectCount).toBe(1);
    expect(bundle.objectsRule).toMatch(/8 GB bundle/);
  });

  it('/costs/usage-types gives billing objects when the new table has rows', async () => {
    const res = await request(app).get(`/api/aws/costs/usage-types?accountId=${acctId}&service=${encodeURIComponent('Amazon Lightsail')}`);
    const dbRow = res.body.rows.find((r) => r.usageType === 'USE1-DatabaseUsage:1GB');
    expect(dbRow.objectsMode).toBe('billing');
    expect(dbRow.objectCount).toBe(1);
    expect(dbRow.objects[0]).toMatchObject({ label: 'ls-db-9', kind: 'Lightsail database', totalUsd: 4.5 });
  });

  it('/costs/resources?usageType= reads the usage table', async () => {
    const res = await request(app).get(`/api/aws/costs/resources?accountId=${acctId}&usageType=${encodeURIComponent('USE1-DatabaseUsage:1GB')}`);
    expect(res.status).toBe(200);
    expect(res.body.rows).toHaveLength(1);
    expect(res.body.rows[0]).toMatchObject({ label: 'ls-db-9', service: 'Amazon Lightsail', totalUsd: 4.5 });
    const none = await request(app).get(`/api/aws/costs/resources?accountId=${acctId}&usageType=Nope`);
    expect(none.body.rows).toEqual([]);
  });
});
