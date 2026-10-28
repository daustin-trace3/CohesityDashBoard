/**
 * Local resource cost estimate: usage-type weights per rule on a scratch database (instance count, volume GB,
 * bucket bytes, RDS Multi-AZ, Lightsail), unattributed lines, the amortized split, an idempotent recompute of
 * the window, inventory tag rows, estimateForResources, and the rollup and series reads.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);

const db = require('../db/database');
const { runMigrations } = require('../core/migrations');
const awsMigrations = require('../db/migrations/aws');
const estimate = require('../services/awsCostEstimate');
const notes = require('../services/awsCostNotes');

beforeAll(() => { runMigrations(db, 'aws', awsMigrations); });

let n = 0;
const account = () => db.prepare("INSERT INTO aws_accounts (name, access_key_id, region, polling_interval_minutes) VALUES (?, 'AKIATEST', 'us-east-2', 10)")
  .run(`est-${++n}-${Math.random().toString(36).slice(2, 6)}`).lastInsertRowid;

const WIN = { fromDay: '2026-10-01', toDay: '2026-10-20' };
const usage = (acct, day, service, usageType, amount, amortized) => db.prepare(`
  INSERT INTO aws_cost_usage_daily (account_id, day, service, usage_type, amount_usd, amortized_usd) VALUES (?, ?, ?, ?, ?, ?)
`).run(acct, day, service, usageType, amount, amortized === undefined ? amount : amortized);
const ec2 = (acct, id, type, state = 'running', tags = null, az = 'us-east-2a') => db.prepare(`
  INSERT INTO aws_ec2_instances (account_id, instance_id, name, state, instance_type, az, tags_json) VALUES (?, ?, ?, ?, ?, ?, ?)
`).run(acct, id, `${id}-name`, state, type, az, tags ? JSON.stringify(tags) : null);
const run = (acct, opts = WIN) => {
  const out = estimate.computeResourceEstimates(acct, opts);
  estimate.storeResourceEstimates(acct, { ...opts, rows: out.rows });
  return out;
};
const stored = (acct) => db.prepare('SELECT * FROM aws_cost_resource_estimate_daily WHERE account_id = ? ORDER BY day, resource_kind, resource_id').all(acct);

const EC2_SVC = 'Amazon Elastic Compute Cloud - Compute';
const S3_SVC = 'Amazon Simple Storage Service';
const RDS_SVC = 'Amazon Relational Database Service';

describe('weights per usage type', () => {
  it('splits two t3.medium instances 50/50, amortized and unblended separately, and explains the share', () => {
    const a = account();
    ec2(a, 'i-a', 't3.medium');
    ec2(a, 'i-b', 't3.medium');
    ec2(a, 'i-c', 't3.medium', 'stopped');   // running instances win over stopped ones
    ec2(a, 'i-other', 'm5.large');
    usage(a, '2026-10-10', EC2_SVC, 'USE2-BoxUsage:t3.medium', 10, 8);
    const out = run(a);
    const rows = stored(a);
    expect(rows).toHaveLength(2);
    expect(rows.map((r) => r.resource_id)).toEqual(['i-a', 'i-b']);
    for (const r of rows) {
      expect(r).toMatchObject({ resource_kind: 'ec2', service: EC2_SVC, usage_type: 'USE2-BoxUsage:t3.medium', amount_usd: 5, amortized_usd: 4 });
      expect(r.share_rule).toContain('1 of 2');
      expect(r.share_rule).toContain('t3.medium');
    }
    expect(out.attributedUsd).toBe(8);
    expect(out.unattributedUsd).toBe(0);
  });

  it('falls back to all states when no instance of the type is running, and ignores other regions', () => {
    const a = account();
    ec2(a, 'i-stop', 'c5.large', 'stopped');
    ec2(a, 'i-west', 'c5.large', 'running', null, 'us-west-2a');
    usage(a, '2026-10-10', EC2_SVC, 'USE2-BoxUsage:c5.large', 6);
    run(a);
    expect(stored(a).map((r) => [r.resource_id, r.amount_usd])).toEqual([['i-stop', 6]]);
  });

  it('splits EBS volume usage by size in GB', () => {
    const a = account();
    db.prepare("INSERT INTO aws_ebs_volumes (account_id, volume_id, state, size_gb, volume_type, az) VALUES (?, 'vol-small', 'in-use', 100, 'gp3', 'us-east-2a')").run(a);
    db.prepare("INSERT INTO aws_ebs_volumes (account_id, volume_id, state, size_gb, volume_type, az) VALUES (?, 'vol-big', 'in-use', 300, 'gp3', 'us-east-2b')").run(a);
    db.prepare("INSERT INTO aws_ebs_volumes (account_id, volume_id, state, size_gb, volume_type, az) VALUES (?, 'vol-gp2', 'in-use', 500, 'gp2', 'us-east-2b')").run(a);
    usage(a, '2026-10-10', 'EC2 - Other', 'USE2-EBS:VolumeUsage.gp3', 8);
    usage(a, '2026-10-10', 'EC2 - Other', 'USE2-EBS:VolumeP-IOPS.gp3', 4);
    run(a);
    const byUsage = (u) => Object.fromEntries(stored(a).filter((r) => r.usage_type === u).map((r) => [r.resource_id, r.amount_usd]));
    expect(byUsage('USE2-EBS:VolumeUsage.gp3')).toEqual({ 'vol-small': 2, 'vol-big': 6 });
    expect(byUsage('USE2-EBS:VolumeP-IOPS.gp3')).toEqual({ 'vol-small': 1, 'vol-big': 3 });
    expect(stored(a).find((r) => r.usage_type === 'USE2-EBS:VolumeUsage.gp3').share_rule).toMatch(/by weight 100 of 400|by weight 300 of 400/);
  });

  it('splits S3 storage by bucket bytes and requests by object count, only for the S3 service', () => {
    const a = account();
    db.prepare("INSERT INTO aws_s3_buckets (account_id, name, region, size_bytes, object_count) VALUES (?, 'big', 'us-east-2', 3000000000, 10)").run(a);
    db.prepare("INSERT INTO aws_s3_buckets (account_id, name, region, size_bytes, object_count) VALUES (?, 'small', 'us-east-2', 1000000000, 30)").run(a);
    db.prepare("INSERT INTO aws_s3_buckets (account_id, name, region, size_bytes, object_count) VALUES (?, 'elsewhere', 'eu-west-1', 9000000000, 1)").run(a);
    usage(a, '2026-10-10', S3_SVC, 'USE2-TimedStorage-ByteHrs', 4);
    usage(a, '2026-10-10', S3_SVC, 'USE2-Requests-Tier1', 8);
    usage(a, '2026-10-10', 'Amazon Elastic File System', 'USE2-TimedStorage-ByteHrs', 5);   // same usage type, other service
    run(a);
    const pick = (u) => Object.fromEntries(stored(a).filter((r) => r.usage_type === u && r.resource_kind === 's3').map((r) => [r.resource_id, r.amount_usd]));
    expect(pick('USE2-TimedStorage-ByteHrs')).toEqual({ big: 3, small: 1 });
    expect(pick('USE2-Requests-Tier1')).toEqual({ big: 2, small: 6 });
    expect(stored(a).find((r) => r.service === 'Amazon Elastic File System')).toMatchObject({ resource_kind: 'unattributed', resource_id: 'Amazon Elastic File System', amount_usd: 5 });
  });

  it('counts a Multi-AZ RDS instance double and splits storage by allocated GB', () => {
    const a = account();
    db.prepare("INSERT INTO aws_rds_instances (account_id, db_id, engine, instance_class, multi_az, allocated_gb) VALUES (?, 'solo', 'postgres', 'db.m5.large', 0, 100)").run(a);
    db.prepare("INSERT INTO aws_rds_instances (account_id, db_id, engine, instance_class, multi_az, allocated_gb) VALUES (?, 'pair', 'postgres', 'db.m5.large', 1, 300)").run(a);
    usage(a, '2026-10-10', RDS_SVC, 'USE2-InstanceUsage:db.m5.large', 9);
    usage(a, '2026-10-10', RDS_SVC, 'USE2-RDS:GP2-Storage', 8);
    run(a);
    const pick = (u) => Object.fromEntries(stored(a).filter((r) => r.usage_type === u).map((r) => [r.resource_id, r.amount_usd]));
    expect(pick('USE2-InstanceUsage:db.m5.large')).toEqual({ solo: 3, pair: 6 });
    expect(pick('USE2-RDS:GP2-Storage')).toEqual({ solo: 2, pair: 6 });
  });

  it('weights Lightsail bundles, disks and database lines by their rule', () => {
    const a = account();
    db.prepare("INSERT INTO aws_lightsail_instances (account_id, name, state, bundle, az, ram_gb, is_windows) VALUES (?, 'ls-1', 'running', 'b', 'us-east-1a', 8, 0)").run(a);
    db.prepare("INSERT INTO aws_lightsail_instances (account_id, name, state, bundle, az, ram_gb, is_windows) VALUES (?, 'ls-2', 'running', 'b', 'us-east-1b', 8, 0)").run(a);
    db.prepare("INSERT INTO aws_lightsail_instances (account_id, name, state, bundle, az, ram_gb, is_windows) VALUES (?, 'ls-win', 'running', 'b', 'us-east-1a', 8, 1)").run(a);
    db.prepare("INSERT INTO aws_lightsail_disks (account_id, name, size_gb, az) VALUES (?, 'disk-a', 50, 'us-east-1a')").run(a);
    db.prepare("INSERT INTO aws_lightsail_disks (account_id, name, size_gb, az) VALUES (?, 'disk-b', 150, 'us-east-1a')").run(a);
    usage(a, '2026-10-10', 'Amazon Lightsail', 'USE1-BundleUsage:8GB', 6);
    usage(a, '2026-10-10', 'Amazon Lightsail', 'USE1-BundleUsage:8GB_win', 5);
    usage(a, '2026-10-10', 'Amazon Lightsail', 'USE1-DiskUsage', 4);
    usage(a, '2026-10-10', 'Amazon Lightsail', 'USE1-DNS-Queries', 0.5);
    run(a);
    const pick = (u) => Object.fromEntries(stored(a).filter((r) => r.usage_type === u).map((r) => [`${r.resource_kind}:${r.resource_id}`, r.amount_usd]));
    expect(pick('USE1-BundleUsage:8GB')).toEqual({ 'lightsail:ls-1': 3, 'lightsail:ls-2': 3 });
    expect(pick('USE1-BundleUsage:8GB_win')).toEqual({ 'lightsail:ls-win': 5 });
    expect(pick('USE1-DiskUsage')).toEqual({ 'lightsail-disk:disk-a': 1, 'lightsail-disk:disk-b': 3 });
    expect(pick('USE1-DNS-Queries')).toEqual({ 'unattributed:Amazon Lightsail': 0.5 });
  });

  it('books Bedrock as the service line, DynamoDB by table size, and the Savings Plans discount as unattributed', () => {
    const a = account();
    db.prepare("INSERT INTO aws_dynamo_tables (account_id, name, size_bytes) VALUES (?, 'orders', 900)").run(a);
    db.prepare("INSERT INTO aws_dynamo_tables (account_id, name, size_bytes) VALUES (?, 'tiny', 100)").run(a);
    usage(a, '2026-10-10', 'Claude Opus 4.6 (Amazon Bedrock Edition)', 'USE2-Opus-InputTokenCount-Units', 12);
    usage(a, '2026-10-10', 'Amazon DynamoDB', 'USE2-TimedStorage-ByteHrs', 10);
    usage(a, '2026-10-10', 'Savings Plans for AWS Compute usage', 'ComputeSP:1yrNoUpfront', -7);
    usage(a, '2026-10-10', 'AWS Support (Business)', 'Dollar', 3);
    const out = run(a);
    const rows = stored(a);
    expect(rows.find((r) => r.resource_kind === 'bedrock-model')).toMatchObject({ resource_id: 'Claude Opus 4.6 (Amazon Bedrock Edition)', amount_usd: 12 });
    expect(Object.fromEntries(rows.filter((r) => r.resource_kind === 'dynamo').map((r) => [r.resource_id, r.amount_usd]))).toEqual({ orders: 9, tiny: 1 });
    expect(rows.find((r) => r.service.startsWith('Savings Plans'))).toMatchObject({ resource_kind: 'unattributed', amount_usd: -7 });
    expect(rows.find((r) => r.service === 'AWS Support (Business)')).toMatchObject({ resource_kind: 'unattributed', resource_id: 'AWS Support (Business)', amount_usd: 3 });
    expect(out.unattributedUsd).toBe(-4);
    expect(out.attributedUsd).toBe(22);
  });

  it('books a usage type with no matching inventory as unattributed against its service, and falls back to unblended when amortized is null', () => {
    const a = account();
    usage(a, '2026-10-10', EC2_SVC, 'USE2-BoxUsage:p4d.24xlarge', 100, null);
    const out = run(a);
    expect(stored(a)).toEqual([expect.objectContaining({ resource_kind: 'unattributed', resource_id: EC2_SVC, amount_usd: 100, amortized_usd: 100 })]);
    expect(out.unattributedUsd).toBe(100);
  });

  it('keeps the default matcher output when no weights are asked for', () => {
    const a = account();
    ec2(a, 'i-q', 't3.small');
    const plain = notes.usageTypeObjects('USE2-BoxUsage:t3.small', EC2_SVC, db, a);
    expect(plain.objects).toEqual([{ resourceId: 'i-q-name', label: 'i-q-name', kind: 'EC2 instance', link: '/aws/ec2?q=i-q-name' }]);
    const weighted = notes.usageTypeObjects('USE2-BoxUsage:t3.small', EC2_SVC, db, a, { all: true, withWeights: true });
    expect(weighted.objects).toEqual([{ resourceId: 'i-q', label: 'i-q', kind: 'ec2', weight: 1 }]);
    expect(weighted.totalWeight).toBe(1);
  });
});

describe('storing and reading estimates', () => {
  it('recomputing the window is idempotent and replaces stale rows', () => {
    const a = account();
    ec2(a, 'i-a', 't3.large');
    usage(a, '2026-10-10', EC2_SVC, 'USE2-BoxUsage:t3.large', 10);
    usage(a, '2026-10-11', EC2_SVC, 'USE2-BoxUsage:t3.large', 12);
    run(a);
    const first = stored(a);
    run(a);
    expect(stored(a)).toEqual(first.map((r) => expect.objectContaining({ id: expect.any(Number), day: r.day, amount_usd: r.amount_usd })));
    expect(stored(a)).toHaveLength(2);
    // The usage the second day was built from disappears: its estimate row must go with the next recompute.
    db.prepare("DELETE FROM aws_cost_usage_daily WHERE account_id = ? AND day = '2026-10-11'").run(a);
    run(a);
    expect(stored(a).map((r) => r.day)).toEqual(['2026-10-10']);
    // Rows outside the window are left alone.
    db.prepare("INSERT INTO aws_cost_resource_estimate_daily (account_id, day, service, usage_type, resource_kind, resource_id, amount_usd) VALUES (?, '2026-09-01', 's', 'u', 'ec2', 'old', 1)").run(a);
    run(a);
    expect(stored(a).map((r) => r.day)).toEqual(['2026-09-01', '2026-10-10']);
  });

  it('stores more than one transaction of rows (chunks of 500)', () => {
    const a = account();
    const rows = Array.from({ length: 1203 }, (_, i) => ({
      day: '2026-10-05', service: 'S', usageType: `u${i}`, resourceKind: 'ec2', resourceId: 'i-x', amountUsd: 1, amortizedUsd: 1, shareRule: 'r',
    }));
    estimate.storeResourceEstimates(a, { ...WIN, rows });
    expect(stored(a)).toHaveLength(1203);
  });

  it('estimateForResources reports usd, days and a 30.4 day month', () => {
    const a = account();
    ec2(a, 'i-m', 't3.medium');
    for (const d of ['2026-10-10', '2026-10-11', '2026-10-12', '2026-10-13']) usage(a, d, EC2_SVC, 'USE2-BoxUsage:t3.medium', 10, 5);
    run(a);
    const amortized = estimate.estimateForResources('ec2', ['i-m', 'i-none'], WIN);
    expect([...amortized.keys()]).toEqual(['i-m']);
    expect(amortized.get('i-m')).toMatchObject({ usd: 20, days: 4 });
    expect(amortized.get('i-m').estMonthlyUsd).toBeCloseTo((20 / 4) * 30.4, 8);
    expect(estimate.estimateForResources('ec2', ['i-m'], { ...WIN, metric: 'unblended' }).get('i-m').usd).toBe(40);
    expect(estimate.estimateForResources('ebs', ['i-m'], WIN).size).toBe(0);
    expect(estimate.estimateForResources('ec2', [], WIN).size).toBe(0);
  });

  it('inventoryTagRows groups by tag value, with an empty value for untagged resources and unattributed lines', () => {
    const a = account();
    ec2(a, 'i-data', 't3.medium', 'running', { Team: 'data', Environment: 'prod' });
    ec2(a, 'i-plain', 't3.medium');
    usage(a, '2026-10-10', EC2_SVC, 'USE2-BoxUsage:t3.medium', 10);
    usage(a, '2026-10-10', 'AWS Support (Business)', 'Dollar', 3);
    run(a);
    const rows = estimate.inventoryTagRows({ key: 'Team', ...WIN, accountId: a });
    const byValue = Object.fromEntries(rows.map((r) => [`${r.value}|${r.service}`, r.usd]));
    expect(byValue).toEqual({ [`data|${EC2_SVC}`]: 5, [`|${EC2_SVC}`]: 5, '|AWS Support (Business)': 3 });
    expect(rows.every((r) => r.day === '2026-10-10')).toBe(true);
    expect(estimate.inventoryTagRows({ key: '', ...WIN })).toEqual([]);
  });

  it('resourceRollup totals, kinds, rows with labels, tags and unattributed, and resourceSeries by day', () => {
    const a = account();
    ec2(a, 'i-top', 't3.xlarge', 'running', { Team: 'platform' });
    db.prepare("INSERT INTO aws_s3_buckets (account_id, name, region, size_bytes, object_count) VALUES (?, 'logs', 'us-east-2', 10, 1)").run(a);
    for (const d of ['2026-10-10', '2026-10-11']) {
      usage(a, d, EC2_SVC, 'USE2-BoxUsage:t3.xlarge', 30);
      usage(a, d, S3_SVC, 'USE2-TimedStorage-ByteHrs', 10);
      usage(a, d, 'AWS Support (Business)', 'Dollar', 10);
    }
    run(a);
    const r = estimate.resourceRollup({ ...WIN, accountId: a });
    expect(r.totals).toMatchObject({ totalUsd: 100, attributedUsd: 80, unattributedUsd: 20, attributedPct: 80 });
    expect(r.byKind).toEqual([{ kind: 'ec2', usd: 60, count: 1 }, { kind: 's3', usd: 20, count: 1 }]);
    expect(r.rows.map((x) => x.resourceId)).toEqual(['i-top', 'logs']);
    expect(r.rows[0]).toMatchObject({
      resourceKind: 'ec2', label: 'i-top-name', link: '/aws/ec2?q=i-top', usd: 60, days: 2, dailyAvgUsd: 30, tags: { Team: 'platform' }, services: [EC2_SVC],
    });
    expect(r.rows[0].pct).toBeCloseTo(60, 8);
    expect(r.rows[0].estMonthlyUsd).toBeCloseTo(30 * 30.4, 8);
    expect(r.unattributed).toEqual([{ service: 'AWS Support (Business)', usd: 20, usageTypes: 1 }]);
    expect(typeof r.computedAt).toBe('string');

    // kind and q narrow the rows only; totals and the kind chips keep the whole picture.
    const k = estimate.resourceRollup({ ...WIN, accountId: a, kind: 's3' });
    expect(k.rows.map((x) => x.resourceId)).toEqual(['logs']);
    expect(k.byKind).toHaveLength(2);
    expect(estimate.resourceRollup({ ...WIN, accountId: a, q: 'platform' }).rows.map((x) => x.resourceId)).toEqual(['i-top']);
    expect(estimate.resourceRollup({ ...WIN, accountId: a, limit: 1 }).rows).toHaveLength(1);
    expect(estimate.resourceRollup({ ...WIN, accountId: a, service: S3_SVC }).totals.totalUsd).toBe(20);

    const s = estimate.resourceSeries({ kind: 'ec2', resourceId: 'i-top', ...WIN, accountId: a });
    expect(s.rows).toEqual([
      { day: '2026-10-10', usd: 30, usageTypes: [{ usageType: 'USE2-BoxUsage:t3.xlarge', usd: 30 }] },
      { day: '2026-10-11', usd: 30, usageTypes: [{ usageType: 'USE2-BoxUsage:t3.xlarge', usd: 30 }] },
    ]);
  });

  it('exposes the rule table', () => {
    expect(estimate.shareRules.length).toBeGreaterThanOrEqual(10);
    expect(estimate.shareRules.map((r) => r.kind)).toEqual(expect.arrayContaining(['ec2', 'ebs', 's3', 'rds', 'unattributed']));
  });
});
