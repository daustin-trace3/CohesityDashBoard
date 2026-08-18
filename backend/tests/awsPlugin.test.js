/**
 * Self-contained AWS platform backend test (WP1). Runs the aws migration
 * into the shared per-file test DB, exercises awsIssues compute/reconcile
 * against seeded rows for every rule, a minimal express app wired to
 * routes/aws.js, and the plugin dispatcher end-to-end (mirrors
 * tests/netbackupPlugin.test.js).
 *
 * Loaded via createRequire (not ESM import) so every service module below
 * resolves the SAME db/database.js singleton instance as app.js.
 */
import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import { createRequire } from 'module';
import express from 'express';
import request from 'supertest';

const require = createRequire(import.meta.url);

// aws was removed from core as part of the 2026-08 pluginization campaign
// and now only exists as an installable .iccplugin — skip this suite when
// its backend (db/migrations/aws.js) is absent instead of throwing on the
// require below.
let PLATFORM_PRESENT = true;
try { require.resolve('../db/migrations/aws'); } catch { PLATFORM_PRESENT = false; }

const db = require('../db/database');
const { runMigrations } = require('../core/migrations');
const awsMigrations = PLATFORM_PRESENT ? require('../db/migrations/aws') : null;
const { encrypt } = require('../services/encryption');

beforeAll(() => {
  if (PLATFORM_PRESENT) runMigrations(db, 'aws', awsMigrations);
});

function insertAccount(overrides = {}) {
  const info = db.prepare(`
    INSERT INTO aws_accounts (name, access_key_id, encrypted_credentials, region,
      polling_interval_minutes, last_poll_status, last_poll_error)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(
    overrides.name ?? 'aws1',
    overrides.access_key_id ?? 'AKIATESTKEYID',
    overrides.encrypted_credentials !== undefined ? overrides.encrypted_credentials : encrypt(JSON.stringify({ secretAccessKey: 'shh' })),
    overrides.region ?? 'us-east-2',
    overrides.polling_interval_minutes ?? 10,
    overrides.last_poll_status ?? null,
    overrides.last_poll_error ?? null,
  );
  return info.lastInsertRowid;
}

describe.skipIf(!PLATFORM_PRESENT)('awsIssues.computeIssues + reconcileIssueHistory', () => {
  it('detects every issue rule from seeded rows', () => {
    const { computeIssues, reconcileIssueHistory } = require('../services/awsIssues');

    const accountId = insertAccount({ name: 'aws-issues', last_poll_status: 'error', last_poll_error: 'connect ETIMEDOUT' });

    // ec2-status-check: running instance with a failed status check.
    db.prepare(`
      INSERT INTO aws_ec2_instances (account_id, instance_id, name, state, status_check)
      VALUES (?, 'i-failed', 'web-1', 'running', 'failed: instance status check')
    `).run(accountId);
    // Healthy instance — must not trip the rule.
    db.prepare(`
      INSERT INTO aws_ec2_instances (account_id, instance_id, name, state, status_check)
      VALUES (?, 'i-ok', 'web-2', 'running', 'ok')
    `).run(accountId);

    // ecs-degraded: ACTIVE service running < desired.
    db.prepare(`
      INSERT INTO aws_ecs_services (account_id, cluster_name, service_name, status, desired_count, running_count)
      VALUES (?, 'main-cluster', 'api-svc', 'ACTIVE', 3, 1)
    `).run(accountId);
    db.prepare(`
      INSERT INTO aws_ecs_services (account_id, cluster_name, service_name, status, desired_count, running_count)
      VALUES (?, 'main-cluster', 'ok-svc', 'ACTIVE', 2, 2)
    `).run(accountId);

    // s3-public: bucket without public access block.
    db.prepare(`
      INSERT INTO aws_s3_buckets (account_id, name, region, public_access_blocked)
      VALUES (?, 'open-bucket', 'us-east-2', 0)
    `).run(accountId);
    db.prepare(`
      INSERT INTO aws_s3_buckets (account_id, name, region, public_access_blocked)
      VALUES (?, 'closed-bucket', 'us-east-2', 1)
    `).run(accountId);

    // ebs-unattached: volume state 'available'.
    db.prepare(`
      INSERT INTO aws_ebs_volumes (account_id, volume_id, state, size_gb)
      VALUES (?, 'vol-unattached', 'available', 20)
    `).run(accountId);
    db.prepare(`
      INSERT INTO aws_ebs_volumes (account_id, volume_id, state, size_gb, attached_instance_id)
      VALUES (?, 'vol-attached', 'in-use', 20, 'i-ok')
    `).run(accountId);

    // cost-spike: yesterday >= $1 and > day-before * 1.30 (default pct).
    const yesterday = "datetime('now', '-1 day')";
    const dayBefore = "datetime('now', '-2 day')";
    db.prepare(`INSERT INTO aws_cost_daily (account_id, day, service, amount_usd) VALUES (?, date(${yesterday}), 'EC2', 14.0)`).run(accountId);
    db.prepare(`INSERT INTO aws_cost_daily (account_id, day, service, amount_usd) VALUES (?, date(${dayBefore}), 'EC2', 10.0)`).run(accountId);

    const issues = computeIssues();
    const byType = (type) => issues.filter((i) => i.type === type);

    expect(byType('ec2-status-check')).toHaveLength(1);
    expect(byType('ec2-status-check')[0].severity).toBe('critical');
    expect(byType('ec2-status-check')[0].target).toBe('web-1');

    expect(byType('ecs-degraded')).toHaveLength(1);
    expect(byType('ecs-degraded')[0].severity).toBe('critical');
    expect(byType('ecs-degraded')[0].target).toBe('main-cluster/api-svc');

    expect(byType('cost-spike').some((i) => i.accountId === accountId)).toBe(true);
    expect(byType('cost-spike')[0].severity).toBe('warning');

    expect(byType('s3-public')).toHaveLength(1);
    expect(byType('s3-public')[0].target).toBe('open-bucket');
    expect(byType('s3-public')[0].severity).toBe('warning');

    expect(byType('ebs-unattached')).toHaveLength(1);
    expect(byType('ebs-unattached')[0].target).toBe('vol-unattached');
    expect(byType('ebs-unattached')[0].severity).toBe('info');

    expect(byType('account-poll-error').some((i) => i.accountId === accountId)).toBe(true);
    expect(byType('account-poll-error')[0].severity).toBe('warning');

    // severity ordering: critical < warning < info
    const severityRank = { critical: 0, warning: 1, info: 2 };
    for (let i = 1; i < issues.length; i++) {
      expect(severityRank[issues[i - 1].severity]).toBeLessThanOrEqual(severityRank[issues[i].severity]);
    }

    reconcileIssueHistory();
    const openRows = db.prepare("SELECT * FROM aws_issue_history WHERE status = 'open' AND account_id = ?").all(accountId);
    expect(openRows.length).toBe(issues.filter((i) => i.accountId === accountId).length);

    // Resolve the ecs-degraded issue by fixing running_count, reconcile again -> flips to resolved.
    db.prepare("UPDATE aws_ecs_services SET running_count = 3 WHERE account_id = ? AND service_name = 'api-svc'").run(accountId);
    reconcileIssueHistory();
    const resolved = db.prepare(
      "SELECT * FROM aws_issue_history WHERE issue_key = ? AND account_id = ?"
    ).get(`ecs-degraded|aws-issues|main-cluster/api-svc`, accountId);
    expect(resolved.status).toBe('resolved');
    expect(resolved.resolved_at).not.toBeNull();
  });

  it('clamps costSpikePct to its documented default/bounds', () => {
    const { costSpikePct } = require('../services/awsIssues');
    expect(costSpikePct()).toBe(30);
  });

  it('clamps rdsStorageWarnPct to its documented default/bounds', () => {
    const { rdsStorageWarnPct } = require('../services/awsIssues');
    expect(rdsStorageWarnPct()).toBe(15);
  });

  it('detects rds-storage-low and respects the clamped threshold', () => {
    const { computeIssues, reconcileIssueHistory } = require('../services/awsIssues');
    const { setSetting } = require('../services/settings');

    const accountId = insertAccount({ name: 'aws-rds-issues' });

    // Below default 15% threshold — should trip.
    db.prepare(`
      INSERT INTO aws_rds_instances (account_id, db_id, status, allocated_gb, free_storage_bytes)
      VALUES (?, 'db-low', 'available', 100, ?)
    `).run(accountId, Math.round(100 * 1073741824 * 0.10)); // 10% free
    // Comfortably above threshold — must not trip.
    db.prepare(`
      INSERT INTO aws_rds_instances (account_id, db_id, status, allocated_gb, free_storage_bytes)
      VALUES (?, 'db-ok', 'available', 100, ?)
    `).run(accountId, Math.round(100 * 1073741824 * 0.50)); // 50% free

    let issues = computeIssues();
    let low = issues.filter((i) => i.type === 'rds-storage-low' && i.accountId === accountId);
    expect(low).toHaveLength(1);
    expect(low[0].target).toBe('db-low');
    expect(low[0].severity).toBe('warning');

    reconcileIssueHistory();
    const openRow = db.prepare(
      "SELECT * FROM aws_issue_history WHERE issue_key = ? AND account_id = ?"
    ).get(`rds-storage-low|aws-rds-issues|db-low`, accountId);
    expect(openRow.status).toBe('open');

    // Tighten the threshold to 5% — the 10%-free instance no longer trips.
    setSetting('aws_rds_storage_warn_pct', '5');
    issues = computeIssues();
    low = issues.filter((i) => i.type === 'rds-storage-low' && i.accountId === accountId);
    expect(low).toHaveLength(0);
    setSetting('aws_rds_storage_warn_pct', '15'); // restore default
  });
});

describe.skipIf(!PLATFORM_PRESENT)('awsPoller global-collector election (Fix #0)', () => {
  it('elects the lowest account id among rows sharing the same effective access key', () => {
    const { isElected } = require('../services/awsPoller');
    const a = insertAccount({ name: 'elect-a', access_key_id: 'AKIASHARED' });
    const b = insertAccount({ name: 'elect-b', access_key_id: 'AKIASHARED' });
    const c = insertAccount({ name: 'elect-c', access_key_id: 'AKIAOTHER' });
    const d = insertAccount({ name: 'elect-d', access_key_id: null, encrypted_credentials: null });
    const rowA = db.prepare('SELECT * FROM aws_accounts WHERE id = ?').get(a);
    const rowB = db.prepare('SELECT * FROM aws_accounts WHERE id = ?').get(b);
    const rowC = db.prepare('SELECT * FROM aws_accounts WHERE id = ?').get(c);
    const rowD = db.prepare('SELECT * FROM aws_accounts WHERE id = ?').get(d);

    expect(isElected(rowA)).toBe(true); // lowest id in the AKIASHARED group
    expect(isElected(rowB)).toBe(false);
    expect(isElected(rowC)).toBe(true); // sole member of the AKIAOTHER group
    // Blank access_key_id falls back to env — grouped with any other blank-key row (env mode).
    expect(typeof isElected(rowD)).toBe('boolean');
  });

  it('non-elected row: cost + S3-family rows are deleted (idempotent self-heal)', () => {
    const { cleanupNonElectedGlobalRows } = require('../services/awsPoller');
    const accountId = insertAccount({ name: 'cleanup-account' });

    db.prepare("INSERT INTO aws_cost_daily (account_id, day, service, amount_usd) VALUES (?, date('now'), 'EC2', 5)").run(accountId);
    db.prepare("INSERT INTO aws_cost_usage_daily (account_id, day, usage_type, amount_usd) VALUES (?, date('now'), 'BoxUsage', 5)").run(accountId);
    db.prepare("INSERT INTO aws_cost_instance_type_daily (account_id, day, instance_type, amount_usd) VALUES (?, date('now'), 't3.micro', 5)").run(accountId);
    db.prepare("INSERT INTO aws_s3_buckets (account_id, name) VALUES (?, 'dup-bucket')").run(accountId);
    db.prepare("INSERT INTO aws_s3_size_history (account_id, bucket_name, day, size_bytes, object_count) VALUES (?, 'dup-bucket', date('now'), 100, 1)").run(accountId);

    cleanupNonElectedGlobalRows(accountId);
    cleanupNonElectedGlobalRows(accountId); // idempotent

    for (const table of ['aws_cost_daily', 'aws_cost_usage_daily', 'aws_cost_instance_type_daily', 'aws_s3_buckets', 'aws_s3_size_history']) {
      expect(db.prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE account_id = ?`).get(accountId).n).toBe(0);
    }
  });

  it('history upserts (S3 size, RDS storage, cost groupings) are idempotent per day', () => {
    const {
      upsertS3SizeHistory, upsertRdsStorageHistory, upsertCostUsageType, upsertCostInstanceType,
    } = require('../services/awsPoller');
    const accountId = insertAccount({ name: 'history-upsert-account' });

    upsertS3SizeHistory(accountId, [{ name: 'bkt', sizeBytes: 100, objectCount: 10 }]);
    upsertS3SizeHistory(accountId, [{ name: 'bkt', sizeBytes: 200, objectCount: 20 }]);
    let rows = db.prepare('SELECT * FROM aws_s3_size_history WHERE account_id = ? AND bucket_name = ?').all(accountId, 'bkt');
    expect(rows).toHaveLength(1);
    expect(rows[0].size_bytes).toBe(200);
    expect(rows[0].object_count).toBe(20);

    upsertRdsStorageHistory(accountId, [{ dbId: 'db-x', freeStorageBytes: 1000, allocatedGb: 50 }]);
    upsertRdsStorageHistory(accountId, [{ dbId: 'db-x', freeStorageBytes: 500, allocatedGb: 50 }]);
    rows = db.prepare('SELECT * FROM aws_rds_storage_history WHERE account_id = ? AND db_id = ?').all(accountId, 'db-x');
    expect(rows).toHaveLength(1);
    expect(rows[0].free_storage_bytes).toBe(500);

    upsertRdsStorageHistory(accountId, [{ dbId: 'db-null', freeStorageBytes: null, allocatedGb: 50 }]);
    expect(db.prepare('SELECT COUNT(*) AS n FROM aws_rds_storage_history WHERE account_id = ? AND db_id = ?').get(accountId, 'db-null').n).toBe(0);

    const today = new Date().toISOString().slice(0, 10);
    upsertCostUsageType(accountId, [{ day: today, usageType: 'BoxUsage:t3.micro', amountUsd: 1.5 }]);
    upsertCostUsageType(accountId, [{ day: today, usageType: 'BoxUsage:t3.micro', amountUsd: 2.5 }]);
    rows = db.prepare('SELECT * FROM aws_cost_usage_daily WHERE account_id = ? AND day = ? AND usage_type = ?').all(accountId, today, 'BoxUsage:t3.micro');
    expect(rows).toHaveLength(1);
    expect(rows[0].amount_usd).toBe(2.5);

    upsertCostInstanceType(accountId, [{ day: today, instanceType: 't3.micro', amountUsd: 3 }]);
    upsertCostInstanceType(accountId, [{ day: today, instanceType: 't3.micro', amountUsd: 4 }]);
    rows = db.prepare('SELECT * FROM aws_cost_instance_type_daily WHERE account_id = ? AND day = ? AND instance_type = ?').all(accountId, today, 't3.micro');
    expect(rows).toHaveLength(1);
    expect(rows[0].amount_usd).toBe(4);
  });
});

describe.skipIf(!PLATFORM_PRESENT)('routes/aws.js basic CRUD + data endpoints (minimal express app, no dispatcher)', () => {
  let app;

  beforeAll(() => {
    const awsRouter = require('../routes/aws');
    app = express();
    app.use(express.json());
    app.use('/api/aws', awsRouter);
  });

  it('GET /api/aws/accounts lists registered accounts, never leaking the secret', async () => {
    const res = await request(app).get('/api/aws/accounts');
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body)).toBe(true);
    for (const row of res.body) {
      expect(row.encryptedCredentials).toBeUndefined();
      expect(row.secretAccessKey).toBeUndefined();
      expect(['stored', 'env', 'none']).toContain(row.credSource);
    }
  });

  it('POST/PUT/DELETE /api/aws/accounts round-trips, PUT keeps secret when blank, 409 on dup name', async () => {
    const created = await request(app).post('/api/aws/accounts').send({
      name: 'crud-test-account', accessKeyId: 'AKIACRUDTEST', secretAccessKey: 's3cr3t', region: 'us-west-2',
    });
    expect(created.status).toBe(201);
    expect(created.body.id).toBeTypeOf('number');
    expect(created.body.accessKeyId).toBe('AKIACRUDTEST');
    expect(created.body.credSource).toBe('stored');
    expect(created.body.secretAccessKey).toBeUndefined();
    const accountId = created.body.id;

    const dup = await request(app).post('/api/aws/accounts').send({ name: 'crud-test-account' });
    expect(dup.status).toBe(409);
    expect(dup.body.error).toBe('duplicate');

    const before = db.prepare('SELECT encrypted_credentials FROM aws_accounts WHERE id = ?').get(accountId).encrypted_credentials;
    const updated = await request(app).put(`/api/aws/accounts/${accountId}`).send({ pollingIntervalMinutes: 20 });
    expect(updated.status).toBe(200);
    expect(updated.body.pollingIntervalMinutes).toBe(20);
    const after = db.prepare('SELECT encrypted_credentials FROM aws_accounts WHERE id = ?').get(accountId).encrypted_credentials;
    expect(after).toBe(before); // blank secretAccessKey on PUT keeps stored credential

    const deleted = await request(app).delete(`/api/aws/accounts/${accountId}`);
    expect(deleted.status).toBe(200);
    expect(deleted.body).toEqual({ deleted: true });
  });

  it('POST /api/aws/accounts with no creds registers in env mode', async () => {
    const created = await request(app).post('/api/aws/accounts').send({ name: 'env-mode-account' });
    expect(created.status).toBe(201);
    expect(created.body.accessKeyId).toBeNull();
    await request(app).delete(`/api/aws/accounts/${created.body.id}`);
  });

  it('GET/PUT /api/aws/config round-trips clamped costSpikePct and rdsStorageWarnPct', async () => {
    const before = await request(app).get('/api/aws/config');
    expect(before.status).toBe(200);
    expect(before.body).toEqual({ costSpikePct: 30, rdsStorageWarnPct: 15 });

    const saved = await request(app).put('/api/aws/config').send({ costSpikePct: 50 });
    expect(saved.status).toBe(200);
    expect(saved.body).toEqual({ costSpikePct: 50, rdsStorageWarnPct: 15 });

    const savedRds = await request(app).put('/api/aws/config').send({ costSpikePct: 50, rdsStorageWarnPct: 25 });
    expect(savedRds.status).toBe(200);
    expect(savedRds.body).toEqual({ costSpikePct: 50, rdsStorageWarnPct: 25 });

    const invalid = await request(app).put('/api/aws/config').send({ costSpikePct: 1 });
    expect(invalid.status).toBe(400);

    const invalidRds = await request(app).put('/api/aws/config').send({ costSpikePct: 30, rdsStorageWarnPct: 1 });
    expect(invalidRds.status).toBe(400);

    await request(app).put('/api/aws/config').send({ costSpikePct: 30, rdsStorageWarnPct: 15 }); // restore defaults
  });

  it('GET /api/aws/overview returns the estate rollup shape', async () => {
    const res = await request(app).get('/api/aws/overview');
    expect(res.status).toBe(200);
    expect(res.body.ec2).toBeTypeOf('object');
    expect(res.body.lightsail).toBeTypeOf('object');
    expect(res.body.ecs).toBeTypeOf('object');
    expect(res.body.s3).toBeTypeOf('object');
    expect(res.body.cost).toBeTypeOf('object');
    expect(Array.isArray(res.body.cost.topServices)).toBe(true);
    expect(res.body.bedrock).toBeTypeOf('object');
    expect(res.body.issues).toEqual(expect.objectContaining({ critical: expect.any(Number), warning: expect.any(Number), info: expect.any(Number) }));
    expect(res.body.rds).toEqual(expect.objectContaining({ total: expect.any(Number), available: expect.any(Number), storageLow: expect.any(Number) }));
    expect(res.body.lambda).toEqual(expect.objectContaining({ total: expect.any(Number), errors24h: expect.any(Number) }));
    expect(res.body.dynamo).toEqual(expect.objectContaining({ total: expect.any(Number), sizeBytes: expect.any(Number) }));
    expect(res.body.ecr).toEqual(expect.objectContaining({ repos: expect.any(Number) }));
    expect(res.body.vpc).toEqual(expect.objectContaining({ vpcs: expect.any(Number), natGateways: expect.any(Number) }));
  });

  it('GET /api/aws/issues returns the wrapped computed issue array', async () => {
    const res = await request(app).get('/api/aws/issues');
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.issues)).toBe(true);
  });

  it('GET /api/aws/issue-history returns a BARE array', async () => {
    const res = await request(app).get('/api/aws/issue-history');
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body)).toBe(true);
    for (const row of res.body) {
      expect(row).toHaveProperty('issueKey');
      expect(row).toHaveProperty('account');
      expect(row).toHaveProperty('firstSeen');
      expect(row).toHaveProperty('lastSeen');
    }
  });

  it('GET /api/aws/ec2|ebs|lightsail|ecs|s3|bedrock|costs|trends all 200 with camelCase shapes', async () => {
    const checks = [
      ['ec2', (b) => Array.isArray(b.instances)],
      ['ebs', (b) => Array.isArray(b.volumes)],
      ['lightsail', (b) => Array.isArray(b.instances)],
      ['ecs', (b) => Array.isArray(b.clusters) && Array.isArray(b.services)],
      ['s3', (b) => Array.isArray(b.buckets)],
      ['bedrock', (b) => Array.isArray(b.models) && typeof b.totals === 'object'],
      ['costs', (b) => Array.isArray(b.days) && Array.isArray(b.byService)],
      ['trends', (b) => Array.isArray(b.rows)],
      ['rds', (b) => Array.isArray(b.instances)],
      ['lambda', (b) => Array.isArray(b.functions)],
      ['dynamo', (b) => Array.isArray(b.tables)],
      ['ecr', (b) => Array.isArray(b.repos)],
      ['vpc', (b) => Array.isArray(b.vpcs) && Array.isArray(b.subnets)],
      ['health', (b) => typeof b.operational === 'boolean' && Array.isArray(b.events)],
      ['costs/usage-types', (b) => Array.isArray(b.rows)],
      ['costs/instance-types', (b) => Array.isArray(b.rows)],
    ];
    for (const [path, shapeOk] of checks) {
      const res = await request(app).get(`/api/aws/${path}`);
      expect(res.status, `GET /api/aws/${path}`).toBe(200);
      expect(shapeOk(res.body), `GET /api/aws/${path} body shape`).toBe(true);
    }
  });

  it('GET /api/aws/s3/history and /api/aws/rds/history return ascending day rows', async () => {
    const accountId = insertAccount({ name: 'aws-history-route' });
    db.prepare(`
      INSERT INTO aws_s3_size_history (account_id, bucket_name, day, size_bytes, object_count)
      VALUES (?, 'hist-bucket', date('now', '-2 days'), 100, 1), (?, 'hist-bucket', date('now', '-1 days'), 200, 2)
    `).run(accountId, accountId);
    const s3res = await request(app).get('/api/aws/s3/history').query({ bucket: 'hist-bucket', days: 30 });
    expect(s3res.status).toBe(200);
    expect(s3res.body.rows.length).toBeGreaterThanOrEqual(2);
    expect(s3res.body.rows[0].day <= s3res.body.rows[s3res.body.rows.length - 1].day).toBe(true);
    expect(s3res.body.rows[0]).toEqual(expect.objectContaining({ day: expect.any(String), sizeBytes: expect.any(Number), objectCount: expect.any(Number) }));

    const missingBucket = await request(app).get('/api/aws/s3/history');
    expect(missingBucket.status).toBe(400);

    db.prepare(`
      INSERT INTO aws_rds_storage_history (account_id, db_id, day, free_storage_bytes, allocated_gb)
      VALUES (?, 'hist-db', date('now', '-2 days'), 500, 100), (?, 'hist-db', date('now', '-1 days'), 400, 100)
    `).run(accountId, accountId);
    const rdsRes = await request(app).get('/api/aws/rds/history').query({ dbId: 'hist-db', days: 30 });
    expect(rdsRes.status).toBe(200);
    expect(rdsRes.body.rows.length).toBeGreaterThanOrEqual(2);
    expect(rdsRes.body.rows[0]).toEqual(expect.objectContaining({ day: expect.any(String), freeStorageBytes: expect.any(Number), allocatedGb: expect.any(Number) }));
  });

  it('GET /api/aws/costs accepts an optional accountId filter without changing the omitted-filter shape', async () => {
    const accountId = insertAccount({ name: 'aws-costs-filter' });
    db.prepare(`INSERT INTO aws_cost_daily (account_id, day, service, amount_usd) VALUES (?, date('now'), 'S3', 3.5)`).run(accountId);

    const all = await request(app).get('/api/aws/costs');
    expect(all.status).toBe(200);
    expect(Array.isArray(all.body.days)).toBe(true);
    expect(Array.isArray(all.body.byService)).toBe(true);

    const filtered = await request(app).get('/api/aws/costs').query({ accountId });
    expect(filtered.status).toBe(200);
    expect(Array.isArray(filtered.body.days)).toBe(true);
  });

  it('GET /api/aws/overview exposes the round-3 additive keys (health, accountsDetail, estate)', async () => {
    const res = await request(app).get('/api/aws/overview');
    expect(res.status).toBe(200);
    expect(res.body.health).toEqual(expect.objectContaining({ operational: expect.any(Boolean), recentEvents: expect.any(Number) }));
    expect(Array.isArray(res.body.accountsDetail)).toBe(true);
    if (res.body.accountsDetail.length) {
      expect(res.body.accountsDetail[0]).toEqual(expect.objectContaining({
        id: expect.any(Number), name: expect.any(String), region: expect.any(String),
      }));
    }
    expect(res.body.estate).toEqual(expect.objectContaining({
      unattachedEbs: expect.any(Number), natGateways: expect.any(Number), topMovers: expect.any(Array),
    }));
  });

  it('GET /api/aws/rds pins camelCase shape and computes freeStoragePct', async () => {
    const accountId = insertAccount({ name: 'aws-rds-route' });
    db.prepare(`
      INSERT INTO aws_rds_instances (account_id, db_id, engine, engine_version, instance_class, status,
        multi_az, allocated_gb, free_storage_bytes, cpu_util, connections, backup_retention_days,
        latest_backup_at, endpoint)
      VALUES (?, 'db-route-test', 'postgres', '15.4', 'db.t3.medium', 'available', 1, 100,
        ?, 12.5, 3, 7, datetime('now'), 'db-route-test.abc123.us-east-2.rds.amazonaws.com')
    `).run(accountId, Math.round(100 * 1073741824 * 0.20));

    const res = await request(app).get('/api/aws/rds');
    expect(res.status).toBe(200);
    const row = res.body.instances.find((i) => i.dbId === 'db-route-test');
    expect(row).toBeTruthy();
    expect(row).toEqual(expect.objectContaining({
      dbId: 'db-route-test', engine: 'postgres', engineVersion: '15.4', instanceClass: 'db.t3.medium',
      status: 'available', multiAz: true, allocatedGb: 100, cpuUtil: 12.5, connections: 3,
      backupRetentionDays: 7, account: 'aws-rds-route',
    }));
    expect(row.freeStoragePct).toBeCloseTo(20, 1);
  });

  it('POST /api/aws/accounts/test never throws with bogus credentials', async () => {
    const res = await request(app).post('/api/aws/accounts/test').send({
      accessKeyId: 'AKIAFAKEFAKEFAKEFAKE', secretAccessKey: 'not-a-real-secret', region: 'us-east-2',
    });
    expect(res.status).toBe(502);
    expect(res.body.ok).toBe(false);
    expect(typeof res.body.error).toBe('string');
  }, 20000);

  it('POST /api/aws/accounts/:id/refresh 404s for an unknown id', async () => {
    const res = await request(app).post('/api/aws/accounts/999999/refresh');
    expect(res.status).toBe(404);
  });
});

describe.skipIf(!PLATFORM_PRESENT)('awsPoller optimizer heuristics (computeHeuristicRecommendations)', () => {
  let computeHeuristicRecommendations;
  beforeAll(() => {
    ({ computeHeuristicRecommendations } = require('../services/awsPoller'));
  });

  it('gp2-to-gp3: gp2 volume -> savings = size_gb * 0.02, recommended gp3', () => {
    const accountId = insertAccount({ name: 'opt-gp2' });
    db.prepare(`
      INSERT INTO aws_ebs_volumes (account_id, volume_id, state, size_gb, volume_type, az)
      VALUES (?, 'vol-gp2', 'in-use', 100, 'gp2', 'us-east-2a')
    `).run(accountId);

    const rows = computeHeuristicRecommendations(accountId, true);
    const row = rows.find((r) => r.finding === 'gp2-to-gp3');
    expect(row).toBeTruthy();
    expect(row).toEqual(expect.objectContaining({
      source: 'heuristic', resourceType: 'ebs', resourceId: 'vol-gp2', region: 'us-east-2a',
      currentConfig: 'gp2', recommendedConfig: 'gp3',
    }));
    expect(row.estMonthlySavingsUsd).toBeCloseTo(100 * 0.02, 5);
  });

  it('ebs-unattached: available volume -> savings = size_gb * (gp2 ? 0.10 : 0.08)', () => {
    const accountId = insertAccount({ name: 'opt-unattached' });
    db.prepare(`
      INSERT INTO aws_ebs_volumes (account_id, volume_id, state, size_gb, volume_type, az)
      VALUES (?, 'vol-unattached-gp3', 'available', 50, 'gp3', 'us-east-2a')
    `).run(accountId);
    db.prepare(`
      INSERT INTO aws_ebs_volumes (account_id, volume_id, state, size_gb, volume_type, az)
      VALUES (?, 'vol-attached', 'in-use', 50, 'gp3', 'us-east-2a')
    `).run(accountId);

    const rows = computeHeuristicRecommendations(accountId, true);
    const unattachedRows = rows.filter((r) => r.finding === 'ebs-unattached');
    expect(unattachedRows).toHaveLength(1);
    expect(unattachedRows[0].resourceId).toBe('vol-unattached-gp3');
    expect(unattachedRows[0].estMonthlySavingsUsd).toBeCloseTo(50 * 0.08, 5);
    expect(unattachedRows[0].recommendedConfig).toBe('delete or snapshot-and-delete');
  });

  it('stopped-ec2-ebs: stopped instance with attached volumes -> savings = sum(size_gb) * 0.08', () => {
    const accountId = insertAccount({ name: 'opt-stopped' });
    db.prepare(`
      INSERT INTO aws_ec2_instances (account_id, instance_id, name, state, instance_type, az)
      VALUES (?, 'i-stopped', 'stopped-box', 'stopped', 'm5.large', 'us-east-2a')
    `).run(accountId);
    db.prepare(`
      INSERT INTO aws_ebs_volumes (account_id, volume_id, state, size_gb, volume_type, az, attached_instance_id)
      VALUES (?, 'vol-a', 'in-use', 30, 'gp3', 'us-east-2a', 'i-stopped')
    `).run(accountId);
    db.prepare(`
      INSERT INTO aws_ebs_volumes (account_id, volume_id, state, size_gb, volume_type, az, attached_instance_id)
      VALUES (?, 'vol-b', 'in-use', 20, 'gp3', 'us-east-2a', 'i-stopped')
    `).run(accountId);

    const rows = computeHeuristicRecommendations(accountId, true);
    const row = rows.find((r) => r.finding === 'stopped-ec2-ebs');
    expect(row).toBeTruthy();
    expect(row.resourceId).toBe('i-stopped');
    expect(row.currentConfig).toBe('m5.large');
    expect(row.estMonthlySavingsUsd).toBeCloseTo((30 + 20) * 0.08, 5);
  });

  it('prev-gen-type: t2 instance -> recommended t3, savings null', () => {
    const accountId = insertAccount({ name: 'opt-prevgen' });
    db.prepare(`
      INSERT INTO aws_ec2_instances (account_id, instance_id, name, state, instance_type, az)
      VALUES (?, 'i-oldgen', 'old-box', 'running', 't2.micro', 'us-east-2a')
    `).run(accountId);

    const rows = computeHeuristicRecommendations(accountId, true);
    const row = rows.find((r) => r.finding === 'prev-gen-type');
    expect(row).toBeTruthy();
    expect(row.resourceId).toBe('i-oldgen');
    expect(row.currentConfig).toBe('t2.micro');
    expect(row.recommendedConfig).toBe('t3.micro');
    expect(row.estMonthlySavingsUsd).toBeNull();
  });

  it('nat-gateway-consolidation: VPC with 2 NATs -> savings = (count-1) * 32.85', () => {
    const accountId = insertAccount({ name: 'opt-nat' });
    db.prepare(`
      INSERT INTO aws_vpcs (account_id, vpc_id, nat_gateway_count)
      VALUES (?, 'vpc-multi-nat', 2)
    `).run(accountId);
    db.prepare(`
      INSERT INTO aws_vpcs (account_id, vpc_id, nat_gateway_count)
      VALUES (?, 'vpc-single-nat', 1)
    `).run(accountId);

    const rows = computeHeuristicRecommendations(accountId, true);
    const natRows = rows.filter((r) => r.finding === 'nat-gateway-consolidation');
    expect(natRows).toHaveLength(1);
    expect(natRows[0].resourceId).toBe('vpc-multi-nat');
    expect(natRows[0].estMonthlySavingsUsd).toBeCloseTo(1 * 32.85, 5);
  });

  it('s3-no-lifecycle: only emitted when elected — large bucket with no lifecycle rules', () => {
    const accountId = insertAccount({ name: 'opt-s3-lifecycle' });
    db.prepare(`
      INSERT INTO aws_s3_buckets (account_id, name, region, lifecycle_rules, size_bytes)
      VALUES (?, 'big-no-lifecycle', 'us-east-2', 0, ?)
    `).run(accountId, 60 * 1024 ** 3);
    db.prepare(`
      INSERT INTO aws_s3_buckets (account_id, name, region, lifecycle_rules, size_bytes)
      VALUES (?, 'small-no-lifecycle', 'us-east-2', 0, ?)
    `).run(accountId, 1024);
    db.prepare(`
      INSERT INTO aws_s3_buckets (account_id, name, region, lifecycle_rules, size_bytes)
      VALUES (?, 'big-with-lifecycle', 'us-east-2', 2, ?)
    `).run(accountId, 60 * 1024 ** 3);

    const electedRows = computeHeuristicRecommendations(accountId, true);
    const s3Rows = electedRows.filter((r) => r.finding === 's3-no-lifecycle');
    expect(s3Rows).toHaveLength(1);
    expect(s3Rows[0].resourceId).toBe('big-no-lifecycle');
    expect(s3Rows[0].recommendedConfig).toBe('add lifecycle/IA transition');
    expect(s3Rows[0].estMonthlySavingsUsd).toBeNull();

    const nonElectedRows = computeHeuristicRecommendations(accountId, false);
    expect(nonElectedRows.some((r) => r.finding === 's3-no-lifecycle')).toBe(false);
  });
});

describe.skipIf(!PLATFORM_PRESENT)('GET /api/aws/optimizer', () => {
  let app;

  beforeAll(() => {
    const awsRouter = require('../routes/aws');
    app = express();
    app.use(express.json());
    app.use('/api/aws', awsRouter);
  });

  it('returns totals + recommendations, sorted savings desc with nulls last, and supports accountId filter', async () => {
    const { storeOptimizer } = require('../services/awsPoller');
    const accountId = insertAccount({ name: 'optimizer-route-account' });
    const otherAccountId = insertAccount({ name: 'optimizer-route-other' });

    storeOptimizer(accountId, 'Active', [
      { source: 'heuristic', resourceType: 'ebs', resourceId: 'vol-low', region: 'us-east-2a',
        finding: 'gp2-to-gp3', currentConfig: 'gp2', recommendedConfig: 'gp3', reason: 'x', estMonthlySavingsUsd: 2 },
      { source: 'compute-optimizer', resourceType: 'ec2', resourceId: 'i-high', region: 'us-east-2a',
        finding: 'Overprovisioned', currentConfig: 'm5.xlarge', recommendedConfig: 'm5.large', reason: 'y', estMonthlySavingsUsd: 40 },
      { source: 'heuristic', resourceType: 'ec2', resourceId: 'i-nullsave', region: 'us-east-2a',
        finding: 'prev-gen-type', currentConfig: 't2.micro', recommendedConfig: 't3.micro', reason: 'z', estMonthlySavingsUsd: null },
    ]);
    storeOptimizer(otherAccountId, 'Inactive', [
      { source: 'heuristic', resourceType: 'vpc', resourceId: 'vpc-other', region: null,
        finding: 'nat-gateway-consolidation', currentConfig: '2 NAT gateways', recommendedConfig: 'consolidate to 1 NAT gateway',
        reason: 'w', estMonthlySavingsUsd: 32.85 },
    ]);

    const all = await request(app).get('/api/aws/optimizer');
    expect(all.status).toBe(200);
    expect(all.body.totals.count).toBeGreaterThanOrEqual(4);
    const savings = all.body.recommendations.map((r) => r.estMonthlySavingsUsd);
    const nonNull = savings.filter((s) => s !== null);
    for (let i = 1; i < nonNull.length; i++) expect(nonNull[i - 1]).toBeGreaterThanOrEqual(nonNull[i]);
    const firstNullIdx = savings.findIndex((s) => s === null);
    if (firstNullIdx >= 0) expect(savings.slice(firstNullIdx).every((s) => s === null)).toBe(true);

    const filtered = await request(app).get('/api/aws/optimizer').query({ accountId });
    expect(filtered.status).toBe(200);
    expect(filtered.body.totals.count).toBe(3);
    expect(filtered.body.recommendations.every((r) => r.account === 'optimizer-route-account')).toBe(true);
    expect(filtered.body.recommendations[0].resourceId).toBe('i-high');
    expect(filtered.body.recommendations[0].source).toBe('compute-optimizer');
  });

  it('POST /api/aws/optimizer/refresh clears the daily gate and returns 202', async () => {
    const accountId = insertAccount({ name: 'optimizer-refresh-account' });
    db.prepare("UPDATE aws_accounts SET last_optimizer_capture_at = datetime('now') WHERE id = ?").run(accountId);

    const res = await request(app).post('/api/aws/optimizer/refresh').query({ accountId });
    expect(res.status).toBe(202);
    expect(res.body).toEqual({ ok: true });
    const row = db.prepare('SELECT last_optimizer_capture_at FROM aws_accounts WHERE id = ?').get(accountId);
    expect(row.last_optimizer_capture_at).toBeNull();
  });
});

describe.skipIf(!PLATFORM_PRESENT)('aws platform plugin dispatcher (registered via registry, like platformPlugins.test.js)', () => {
  const API_KEY = 'test-api-key';
  let app;
  let registry;

  beforeEach(() => {
    registry = require('../core/registry');
    const awsManifest = require('../platforms/aws');
    const { createApp } = require('../app');
    registry._reset();
    registry.init();
    registry.registerPlugin(awsManifest);
    app = createApp({ licenseGate: (req, res, next) => next() });
  });

  it('GET /api/aws/accounts -> 200 [] through the dispatcher when registered+enabled', async () => {
    const res = await request(app).get('/api/aws/accounts').set('x-api-key', API_KEY);
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body)).toBe(true);
  });

  it('disabling aws returns 404 platform_disabled; re-enabling restores 200', async () => {
    const get = () => request(app).get('/api/aws/accounts').set('x-api-key', API_KEY);

    registry.setEnabled('aws', false);
    const disabledRes = await get();
    expect(disabledRes.status).toBe(404);
    expect(disabledRes.body).toEqual({ error: 'platform_disabled' });

    registry.setEnabled('aws', true);
    const enabledRes = await get();
    expect(enabledRes.status).toBe(200);
  });
});
