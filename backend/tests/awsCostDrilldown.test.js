/**
 * AWS cost drill-down: migration v8, service-attributed usage types, resource-level cost,
 * per-service notes, resource resolution, error classification and the three cost routes.
 * Loaded via createRequire so every service resolves the same db singleton as the app.
 */
import { describe, it, expect, beforeAll, beforeEach, afterEach, vi } from 'vitest';
import { createRequire } from 'module';
import express from 'express';
import request from 'supertest';

const require = createRequire(import.meta.url);

const db = require('../db/database');
const Database = require('better-sqlite3');
const { runMigrations } = require('../core/migrations');
const awsMigrations = require('../db/migrations/aws');
const { setSetting } = require('../services/settings');
const awsApi = require('../services/awsApi');
const { upsertCostUsageType } = require('../services/awsPoller');
const { serviceNotes, lightsailComponent, resolveCostResource } = require('../services/awsCostNotes');
const CE = require('@aws-sdk/client-cost-explorer');

beforeAll(() => {
  runMigrations(db, 'aws', awsMigrations);
});

function insertAccount(name, extra = {}) {
  return db.prepare(`
    INSERT INTO aws_accounts (name, access_key_id, region, polling_interval_minutes, cost_resources_status, cost_resources_error)
    VALUES (?, 'AKIATEST', 'us-east-2', 10, ?, ?)
  `).run(name, extra.status ?? null, extra.error ?? null).lastInsertRowid;
}

describe('migration v8', () => {
  it('keeps usage rows with service NULL, adds the resource table and clears the capture stamp', () => {
    const scratch = new Database(':memory:');
    runMigrations(scratch, 'aws', awsMigrations.filter((m) => m.version <= 7));
    scratch.prepare("INSERT INTO aws_accounts (name, last_cost_capture_at) VALUES ('a', datetime('now'))").run();
    scratch.prepare("INSERT INTO aws_cost_usage_daily (account_id, day, usage_type, amount_usd) VALUES (1, '2026-10-01', 'BoxUsage:m5.large', 4.5)").run();
    scratch.prepare("INSERT INTO aws_cost_usage_daily (account_id, day, usage_type, amount_usd) VALUES (1, '2026-10-02', 'NatGateway-Hours', 1.5)").run();

    runMigrations(scratch, 'aws', awsMigrations);

    const rows = scratch.prepare('SELECT day, service, usage_type, amount_usd FROM aws_cost_usage_daily ORDER BY day').all();
    expect(rows).toEqual([
      { day: '2026-10-01', service: null, usage_type: 'BoxUsage:m5.large', amount_usd: 4.5 },
      { day: '2026-10-02', service: null, usage_type: 'NatGateway-Hours', amount_usd: 1.5 },
    ]);
    expect(scratch.prepare("SELECT name FROM sqlite_master WHERE name = 'aws_cost_resource_daily'").get()).toBeTruthy();
    const acct = scratch.prepare('SELECT last_cost_capture_at, cost_resources_status FROM aws_accounts').get();
    expect(acct.last_cost_capture_at).toBeNull();
    expect(acct.cost_resources_status).toBeNull();
    // New UNIQUE is (account, day, service, usage_type): the same usage type under two services coexists.
    scratch.prepare("INSERT INTO aws_cost_usage_daily (account_id, day, service, usage_type, amount_usd) VALUES (1, '2026-10-01', 'S3', 'Requests', 1)").run();
    scratch.prepare("INSERT INTO aws_cost_usage_daily (account_id, day, service, usage_type, amount_usd) VALUES (1, '2026-10-01', 'EC2', 'Requests', 1)").run();
    scratch.close();
  });
});

describe('upsertCostUsageType', () => {
  it('replaces a refetched day legacy rows and leaves other days alone', () => {
    const id = insertAccount('upsert-acct');
    const ins = db.prepare('INSERT INTO aws_cost_usage_daily (account_id, day, service, usage_type, amount_usd) VALUES (?, ?, NULL, ?, ?)');
    ins.run(id, '2026-09-01', 'BoxUsage', 5);
    ins.run(id, '2026-09-02', 'BoxUsage', 6);

    upsertCostUsageType(id, [
      { day: '2026-09-02', service: 'Amazon EC2', usageType: 'BoxUsage', amountUsd: 2 },
      { day: '2026-09-02', service: 'Amazon EC2', usageType: 'EBS', amountUsd: 1 },
    ]);
    const rows = db.prepare('SELECT day, service, usage_type, amount_usd FROM aws_cost_usage_daily WHERE account_id = ? ORDER BY day, usage_type').all(id);
    expect(rows).toEqual([
      { day: '2026-09-01', service: null, usage_type: 'BoxUsage', amount_usd: 5 },
      { day: '2026-09-02', service: 'Amazon EC2', usage_type: 'BoxUsage', amount_usd: 2 },
      { day: '2026-09-02', service: 'Amazon EC2', usage_type: 'EBS', amount_usd: 1 },
    ]);
    // Re-running the same day is idempotent.
    upsertCostUsageType(id, [{ day: '2026-09-02', service: 'Amazon EC2', usageType: 'BoxUsage', amountUsd: 3 }]);
    const sum = db.prepare("SELECT SUM(amount_usd) AS s FROM aws_cost_usage_daily WHERE account_id = ? AND day = '2026-09-02'").get(id).s;
    expect(sum).toBe(4);
  });
});

describe('serviceNotes + lightsailComponent', () => {
  it('RDS note counts Aurora engines and spots Aurora usage types', () => {
    const id = insertAccount('rds-notes');
    const ins = db.prepare("INSERT INTO aws_rds_instances (account_id, db_id, engine) VALUES (?, ?, ?)");
    ['aurora-mysql', 'aurora-postgresql', 'mysql', 'postgres', 'mariadb'].forEach((e, i) => ins.run(id, `db-${i}`, e));
    const notes = serviceNotes('Amazon Relational Database Service', {
      db, accountId: id, usageTypes: ['USE1-Aurora:StorageUsage', 'InstanceUsage:db.t3.micro'],
    });
    expect(notes[0]).toBe('Includes Aurora (RDS and Aurora bill under this line).');
    expect(notes).toContain('2 of 5 registered instances run Aurora engines.');
    expect(notes).toContain('Aurora storage and I/O usage types present.');
    expect(serviceNotes('Amazon Relational Database Service', { usageTypes: ['InstanceUsage:db.t3.micro'] })).toHaveLength(1);
  });

  it('classifies Lightsail usage types, with and without a region prefix', () => {
    expect(lightsailComponent('USE1-BundleUsage:8GB')).toBe('instances');
    expect(lightsailComponent('USE1-BundleUsage:16GB_win')).toBe('instances');
    expect(lightsailComponent('USE1-DatabaseUsage:1GB')).toBe('databases');
    expect(lightsailComponent('USE2-TotalDataXfer-Out-Bytes')).toBe('data transfer');
    expect(lightsailComponent('LoadBalancerUsage')).toBe('load balancers');
    expect(lightsailComponent('USE1-LoadBalancerUsage')).toBe('load balancers');
    expect(lightsailComponent('DataTransfer-Out-Bytes')).toBe('data transfer');
    expect(lightsailComponent('SnapshotUsage')).toBe('snapshots');
    expect(lightsailComponent('USE1-DiskUsage')).toBe('block storage');
    expect(lightsailComponent('SomethingElse')).toBeNull();

    const notes = serviceNotes('Amazon Lightsail', {
      usageTypes: ['USE1-BundleUsage:8GB', 'USE1-DatabaseUsage:1GB', 'LoadBalancerUsage', 'DataTransfer-Out-Bytes'],
    });
    expect(notes).toEqual(['Covers instances, databases, load balancers and data transfer.']);
    expect(serviceNotes('Amazon Lightsail', { usageTypes: [] })[0])
      .toBe('Instances, databases, disks, buckets, load balancers and CDN all bill under this line.');
    expect(serviceNotes('AWS Lambda', {})).toEqual([]);
  });
});

describe('resolveCostResource', () => {
  let acct;
  beforeAll(() => {
    acct = insertAccount('resolve-acct');
    db.prepare("INSERT INTO aws_ec2_instances (account_id, instance_id, name, state) VALUES (?, 'i-0abc123', 'web-prod', 'running')").run(acct);
    db.prepare("INSERT INTO aws_s3_buckets (account_id, name) VALUES (?, 'my-data-bucket')").run(acct);
    db.prepare("INSERT INTO aws_lightsail_instances (account_id, name) VALUES (?, 'ls-blog')").run(acct);
  });

  it('resolves an EC2 instance id to its name', () => {
    expect(resolveCostResource('i-0abc123', 'Amazon Elastic Compute Cloud - Compute', db, acct))
      .toEqual({ label: 'web-prod', kind: 'EC2 instance', link: '/aws/ec2?q=i-0abc123' });
  });

  it('resolves a Lightsail database ARN and a bare Lightsail name', () => {
    const arn = 'arn:aws:lightsail:us-east-2:111122223333:RelationalDatabase/ls-db-1';
    expect(resolveCostResource(arn, 'Amazon Lightsail', db, acct))
      .toEqual({ label: 'ls-db-1', kind: 'Lightsail database', link: '/aws/lightsail?q=ls-db-1' });
    expect(resolveCostResource('ls-blog', 'Amazon Lightsail', db, acct))
      .toEqual({ label: 'ls-blog', kind: 'Lightsail instance', link: '/aws/lightsail?q=ls-blog' });
  });

  it('resolves an RDS cluster ARN as an Aurora cluster', () => {
    const arn = 'arn:aws:rds:us-east-1:111122223333:cluster:aurora-prod';
    expect(resolveCostResource(arn, 'Amazon Relational Database Service', db, acct))
      .toEqual({ label: 'aurora-prod', kind: 'Aurora cluster', link: '/aws/rds?q=aurora-prod' });
  });

  it('resolves an S3 bucket name', () => {
    expect(resolveCostResource('my-data-bucket', 'Amazon Simple Storage Service', db, acct))
      .toEqual({ label: 'my-data-bucket', kind: 'S3 bucket', link: '/aws/s3?q=my-data-bucket' });
  });

  it('falls back to the ARN tail for an unknown ARN and never throws on odd input', () => {
    expect(resolveCostResource('arn:aws:kinesis:us-east-1:111122223333:stream/clicks', 'Amazon Kinesis', db, acct))
      .toEqual({ label: 'clicks', kind: 'KINESIS', link: null });
    expect(() => resolveCostResource(null, null, db, null)).not.toThrow();
    expect(resolveCostResource('weird:::id', undefined, db, acct).link).toBeNull();
  });
});

describe('classifyCostResourceError', () => {
  it('maps the three branches', () => {
    expect(awsApi.classifyCostResourceError({ name: 'DataUnavailableException', message: 'Resource level data is not enabled for this account; opt in' })).toBe('not_enabled');
    expect(awsApi.classifyCostResourceError({ name: 'ValidationException', message: 'Resource granularity not supported, check preference' })).toBe('not_enabled');
    expect(awsApi.classifyCostResourceError({ name: 'AccessDeniedException', message: 'nope' })).toBe('denied');
    expect(awsApi.classifyCostResourceError({ name: 'X', message: 'User is not authorized to perform ce:Get' })).toBe('denied');
    expect(awsApi.classifyCostResourceError(new Error('boom'))).toBe('error');
  });
});

describe('fetchCostByResource (stubbed client)', () => {
  const account = { region: 'us-east-1', access_key_id: '', encrypted_credentials: null };
  let spy;
  afterEach(() => { spy?.mockRestore(); });

  const page = (groups, token) => ({
    ResultsByTime: [{ TimePeriod: { Start: '2026-10-18' }, Groups: groups }],
    ...(token ? { NextPageToken: token } : {}),
  });
  const group = (svc, rid, amt) => ({ Keys: [svc, rid], Metrics: { UnblendedCost: { Amount: String(amt) } } });

  it('stops at maxPages, follows tokens and skips NoResourceId', async () => {
    const sent = [];
    spy = vi.spyOn(CE.CostExplorerClient.prototype, 'send').mockImplementation(async (cmd) => {
      sent.push(cmd.input);
      const n = sent.length;
      return page([group('S', `r-${n}`, 1), group('S', 'NoResourceId', 9)], `tok-${n}`);
    });
    const out = await awsApi.fetchCostByResource(account, { maxPages: 3, services: ['S'] });
    expect(out.pages).toBe(3);
    expect(out.rows.map((r) => r.resourceId)).toEqual(['r-1', 'r-2', 'r-3']);
    expect(sent[0].Filter).toEqual({ Not: { Dimensions: { Key: 'RECORD_TYPE', Values: ['Tax', 'Refund', 'Credit'] } } });
    expect(sent[1].NextPageToken).toBe('tok-1');
  });

  it('retries once with a SERVICE filter after a filter ValidationException', async () => {
    const sent = [];
    spy = vi.spyOn(CE.CostExplorerClient.prototype, 'send').mockImplementation(async (cmd) => {
      sent.push(cmd.input);
      if (sent.length === 1) { const e = new Error('Invalid Filter expression'); e.name = 'ValidationException'; throw e; }
      return page([group('Amazon Lightsail', 'arn:x', 2)]);
    });
    const out = await awsApi.fetchCostByResource(account, { services: ['Amazon Lightsail'] });
    expect(sent).toHaveLength(2);
    expect(sent[1].Filter).toEqual({ Dimensions: { Key: 'SERVICE', Values: ['Amazon Lightsail'], MatchOptions: ['EQUALS'] } });
    expect(out.rows).toEqual([{ day: '2026-10-18', service: 'Amazon Lightsail', resourceId: 'arn:x', amountUsd: 2 }]);
  });

  it('does not retry twice and passes other errors through', async () => {
    spy = vi.spyOn(CE.CostExplorerClient.prototype, 'send').mockImplementation(async () => {
      const e = new Error('Invalid Filter expression'); e.name = 'ValidationException'; throw e;
    });
    await expect(awsApi.fetchCostByResource(account, { services: ['S'] })).rejects.toThrow('Invalid Filter');
    expect(spy).toHaveBeenCalledTimes(2);
  });
});

describe('fetchCostByUsageType (stubbed client)', () => {
  const account = { region: 'us-east-1', access_key_id: '', encrypted_credentials: null };
  let spy;
  afterEach(() => { spy?.mockRestore(); });

  it('follows NextPageToken so a large SERVICE + USAGE_TYPE grouping is not truncated', async () => {
    const sent = [];
    spy = vi.spyOn(CE.CostExplorerClient.prototype, 'send').mockImplementation(async (cmd) => {
      sent.push(cmd.input);
      const n = sent.length;
      return {
        ResultsByTime: [{ TimePeriod: { Start: `2026-10-0${n}` }, Groups: [
          { Keys: ['Amazon Lightsail', `USE1-BundleUsage:${n}GB`], Metrics: { UnblendedCost: { Amount: '1.5' } } },
        ] }],
        ...(n < 3 ? { NextPageToken: `tok-${n}` } : {}),
      };
    });
    const rows = await awsApi.fetchCostByUsageType(account);
    expect(sent).toHaveLength(3);
    expect(sent[0].NextPageToken).toBeUndefined();
    expect(sent[1].NextPageToken).toBe('tok-1');
    expect(sent[0].GroupBy).toEqual([{ Type: 'DIMENSION', Key: 'SERVICE' }, { Type: 'DIMENSION', Key: 'USAGE_TYPE' }]);
    expect(rows.map((r) => r.day)).toEqual(['2026-10-01', '2026-10-02', '2026-10-03']);
    expect(rows[0]).toEqual({ day: '2026-10-01', service: 'Amazon Lightsail', usageType: 'USE1-BundleUsage:1GB', amountUsd: 1.5, amortizedUsd: null, usageQty: null, usageUnit: null });
  });
});

describe('cost routes', () => {
  let app;
  let acctId;
  beforeAll(() => {
    const awsRouter = require('../routes/aws');
    app = express();
    app.use(express.json());
    app.use('/api/aws', awsRouter);

    acctId = insertAccount('route-acct', { status: 'not_enabled', error: 'Resource level data is not enabled' });
    const today = new Date().toISOString().slice(0, 10);
    db.prepare("INSERT INTO aws_cost_daily (account_id, day, service, amount_usd) VALUES (?, ?, 'Amazon Lightsail', 3)").run(acctId, today);
    db.prepare("INSERT INTO aws_cost_daily (account_id, day, service, amount_usd) VALUES (?, ?, 'Amazon Relational Database Service', 5)").run(acctId, today);
    const u = db.prepare('INSERT INTO aws_cost_usage_daily (account_id, day, service, usage_type, amount_usd) VALUES (?, ?, ?, ?, ?)');
    u.run(acctId, today, 'Amazon Lightsail', 'USE1-BundleUsage:8GB', 2);
    u.run(acctId, today, 'Amazon Lightsail', 'USE1-DatabaseUsage:1GB', 1);
    u.run(acctId, today, 'Amazon Relational Database Service', 'InstanceUsage:db.t3.micro', 5);
    u.run(acctId, today, null, 'Legacy-Usage', 7);
  });

  it('/costs rows carry notes and the costResources state', async () => {
    const res = await request(app).get(`/api/aws/costs?accountId=${acctId}`);
    expect(res.status).toBe(200);
    const ls = res.body.byService.find((s) => s.service === 'Amazon Lightsail');
    expect(ls.notes).toEqual(['Covers instances and databases.']);
    const rds = res.body.byService.find((s) => s.service === 'Amazon Relational Database Service');
    expect(rds.notes[0]).toMatch(/^Includes Aurora/);
    expect(res.body.costResources.enabled).toBe(true);
    expect(res.body.costResources.accounts).toEqual([
      { accountId: acctId, name: 'route-acct', status: 'not_enabled', error: 'Resource level data is not enabled' },
    ]);
  });

  it('/costs/usage-types?service= filters and drops legacy rows; without it legacy rows are labelled', async () => {
    const filtered = await request(app).get(`/api/aws/costs/usage-types?accountId=${acctId}&service=${encodeURIComponent('Amazon Lightsail')}`);
    expect(filtered.body.rows.map((r) => r.usageType).sort()).toEqual(['USE1-BundleUsage:8GB', 'USE1-DatabaseUsage:1GB']);
    expect(filtered.body.rows.find((r) => r.usageType === 'USE1-BundleUsage:8GB').component).toBe('instances');
    expect(filtered.body.rows.every((r) => r.service === 'Amazon Lightsail')).toBe(true);

    const all = await request(app).get(`/api/aws/costs/usage-types?accountId=${acctId}`);
    const legacy = all.body.rows.find((r) => r.usageType === 'Legacy-Usage');
    expect(legacy.service).toBe('Unattributed (collected before service tagging)');
    expect(legacy.component).toBeNull();
    const rds = all.body.rows.find((r) => r.usageType === 'InstanceUsage:db.t3.micro');
    expect(rds.component).toBeNull();
  });

  it('/costs/resources returns rows, a window and the state in precedence order', async () => {
    const today = new Date().toISOString().slice(0, 10);
    const r = db.prepare('INSERT INTO aws_cost_resource_daily (account_id, day, service, resource_id, amount_usd) VALUES (?, ?, ?, ?, ?)');
    r.run(acctId, today, 'Amazon Lightsail', 'arn:aws:lightsail:us-east-2:1:RelationalDatabase/ls-db-9', 4);
    r.run(acctId, today, 'Amazon Lightsail', 'ls-small', 1);

    const res = await request(app).get(`/api/aws/costs/resources?accountId=${acctId}&service=${encodeURIComponent('Amazon Lightsail')}`);
    expect(res.status).toBe(200);
    expect(res.body.rows.map((x) => x.label)).toEqual(['ls-db-9', 'ls-small']);
    expect(res.body.rows[0]).toMatchObject({ kind: 'Lightsail database', totalUsd: 4, service: 'Amazon Lightsail' });
    expect(res.body.window.end).toBe(today);

    const byDay = await request(app).get(`/api/aws/costs/resources?accountId=${acctId}&day=2000-01-01`);
    expect(byDay.body.rows).toEqual([]);
    expect(byDay.body.window).toEqual({ start: '2000-01-01', end: '2000-01-01' });

    // Account status drives the message the UI picks; the toggle is reported separately.
    setSetting('aws_cost_resources_enabled', '0');
    const off = await request(app).get(`/api/aws/costs/resources?accountId=${acctId}`);
    expect(off.body.costResources.enabled).toBe(false);
    setSetting('aws_cost_resources_enabled', '1');
    const on = await request(app).get(`/api/aws/costs/resources?accountId=${acctId}`);
    expect(on.body.costResources.enabled).toBe(true);
    expect(on.body.costResources.accounts[0].status).toBe('not_enabled');
  });

  it('/config round-trips the resource-level settings with validation', async () => {
    const before = await request(app).get('/api/aws/config');
    expect(before.body).toMatchObject({ costResourcesEnabled: true, costResourcesMaxPages: 10 });
    const put = await request(app).put('/api/aws/config').send({ costSpikePct: 30, costResourcesEnabled: false, costResourcesMaxPages: 5 });
    expect(put.status).toBe(200);
    expect(put.body).toMatchObject({ costResourcesEnabled: false, costResourcesMaxPages: 5 });
    const bad = await request(app).put('/api/aws/config').send({ costSpikePct: 30, costResourcesMaxPages: 99 });
    expect(bad.status).toBe(400);
    await request(app).put('/api/aws/config').send({ costSpikePct: 30, costResourcesEnabled: true, costResourcesMaxPages: 10 });
  });
});
