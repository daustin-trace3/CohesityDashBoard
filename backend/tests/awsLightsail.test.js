/**
 * Lightsail inventory (WP-A): migration v9, issue rules, routes and the bundle map.
 * Loaded via createRequire so every module shares the one db singleton.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { createRequire } from 'module';
import express from 'express';
import request from 'supertest';

const require = createRequire(import.meta.url);

const db = require('../db/database');
const { runMigrations } = require('../core/migrations');
const awsMigrations = require('../db/migrations/aws');
const { encrypt } = require('../services/encryption');

beforeAll(() => {
  runMigrations(db, 'aws', awsMigrations);
});

const NEW_TABLES = [
  'aws_lightsail_databases', 'aws_lightsail_disks', 'aws_lightsail_buckets', 'aws_lightsail_load_balancers',
  'aws_lightsail_distributions', 'aws_lightsail_domains', 'aws_lightsail_static_ips',
];

function insertAccount(name) {
  return db.prepare(`
    INSERT INTO aws_accounts (name, access_key_id, encrypted_credentials, region, polling_interval_minutes)
    VALUES (?, 'AKIATESTKEYID', ?, 'us-east-2', 10)
  `).run(name, encrypt(JSON.stringify({ secretAccessKey: 'shh' }))).lastInsertRowid;
}

describe('migration aws v9', () => {
  it('creates every Lightsail table and the instance columns', () => {
    for (const t of NEW_TABLES) {
      const row = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?").get(t);
      expect(row?.name).toBe(t);
    }
    const cols = db.prepare("PRAGMA table_info('aws_lightsail_instances')").all().map((c) => c.name);
    for (const c of ['ram_gb', 'cpu_count', 'is_windows', 'arn', 'private_ip', 'created_at']) {
      expect(cols).toContain(c);
    }
  });
});

describe('fetchLightsailBundles mapping', () => {
  it('maps xlarge_win_3_0 to 16 GB Windows and large_3_0 to 8 GB', async () => {
    const awsApi = require('../services/awsApi');
    const lightsail = require('@aws-sdk/client-lightsail');
    const original = lightsail.LightsailClient.prototype.send;
    lightsail.LightsailClient.prototype.send = async () => ({
      bundles: [
        { bundleId: 'xlarge_win_3_0', ramSizeInGb: 16, cpuCount: 4, supportedPlatforms: ['WINDOWS'] },
        { bundleId: 'large_3_0', ramSizeInGb: 8, cpuCount: 2, supportedPlatforms: ['LINUX_UNIX'] },
      ],
    });
    try {
      const map = await awsApi.fetchLightsailBundles({ name: 'x', region: 'us-east-2', access_key_id: 'AKIA', encrypted_credentials: encrypt(JSON.stringify({ secretAccessKey: 's' })) });
      expect(map.get('xlarge_win_3_0')).toMatchObject({ ramGb: 16, isWindows: true });
      expect(map.get('large_3_0')).toMatchObject({ ramGb: 8, isWindows: false });
    } finally {
      lightsail.LightsailClient.prototype.send = original;
    }
  });
});

describe('Lightsail issue rules', () => {
  it('fires on bad rows and stays quiet on healthy rows', () => {
    const { computeIssues } = require('../services/awsIssues');
    const a = insertAccount('ls-issues');

    const disk = db.prepare(`INSERT INTO aws_lightsail_disks (account_id, name, size_gb, state, attachment_state, is_system_disk)
      VALUES (?, ?, 32, 'available', ?, ?)`);
    disk.run(a, 'idle-disk', 'detached', 0);
    disk.run(a, 'good-disk', 'attached', 0);
    disk.run(a, 'sys-disk', 'attached', 1);

    const ip = db.prepare('INSERT INTO aws_lightsail_static_ips (account_id, name, ip_address, is_attached) VALUES (?, ?, ?, ?)');
    ip.run(a, 'spare-ip', '1.2.3.4', 0);
    ip.run(a, 'used-ip', '1.2.3.5', 1);

    const bucket = db.prepare('INSERT INTO aws_lightsail_buckets (account_id, name, read_only_access) VALUES (?, ?, ?)');
    bucket.run(a, 'open-bucket', 1);
    bucket.run(a, 'closed-bucket', 0);

    const dbs = db.prepare('INSERT INTO aws_lightsail_databases (account_id, name, state, backup_retention) VALUES (?, ?, ?, ?)');
    dbs.run(a, 'nobackup-db', 'available', 0);
    dbs.run(a, 'down-db', 'stopped', 1);
    dbs.run(a, 'good-db', 'available', 1);

    const lb = db.prepare(`INSERT INTO aws_lightsail_load_balancers (account_id, name, attached_instances, healthy_count, unhealthy_count)
      VALUES (?, ?, ?, ?, ?)`);
    lb.run(a, 'dead-lb', JSON.stringify(['w1']), 0, 1);
    lb.run(a, 'wobbly-lb', JSON.stringify(['w1', 'w2']), 1, 1);
    lb.run(a, 'good-lb', JSON.stringify(['w1']), 1, 0);

    const dist = db.prepare('INSERT INTO aws_lightsail_distributions (account_id, name, is_enabled) VALUES (?, ?, ?)');
    dist.run(a, 'off-cdn', 0);
    dist.run(a, 'on-cdn', 1);

    const mine = computeIssues().filter((i) => i.accountId === a);
    const has = (type, target, severity) => mine.some((i) => i.type === type && i.target === target && (!severity || i.severity === severity));

    expect(has('lightsail-disk-unattached', 'idle-disk', 'warning')).toBe(true);
    expect(has('lightsail-disk-unattached', 'good-disk')).toBe(false);
    expect(has('lightsail-disk-unattached', 'sys-disk')).toBe(false);
    expect(has('lightsail-static-ip-unattached', 'spare-ip', 'warning')).toBe(true);
    expect(has('lightsail-static-ip-unattached', 'used-ip')).toBe(false);
    expect(has('lightsail-bucket-public', 'open-bucket', 'warning')).toBe(true);
    expect(has('lightsail-bucket-public', 'closed-bucket')).toBe(false);
    expect(has('lightsail-db-no-backup', 'nobackup-db', 'warning')).toBe(true);
    expect(has('lightsail-db-no-backup', 'good-db')).toBe(false);
    expect(has('lightsail-db-unavailable', 'down-db', 'critical')).toBe(true);
    expect(has('lightsail-db-unavailable', 'good-db')).toBe(false);
    expect(has('lightsail-lb-unhealthy', 'dead-lb', 'critical')).toBe(true);
    expect(has('lightsail-lb-unhealthy', 'wobbly-lb', 'warning')).toBe(true);
    expect(has('lightsail-lb-unhealthy', 'good-lb')).toBe(false);
    expect(has('lightsail-distribution-disabled', 'off-cdn', 'info')).toBe(true);
    expect(has('lightsail-distribution-disabled', 'on-cdn')).toBe(false);
  });
});

describe('Lightsail routes', () => {
  let app;
  let accountId;

  beforeAll(() => {
    accountId = insertAccount('ls-routes');
    db.prepare(`INSERT INTO aws_lightsail_instances (account_id, name, state, bundle, ram_gb, is_windows)
      VALUES (?, 'win-1', 'running', 'xlarge_win_3_0', 16, 1)`).run(accountId);
    db.prepare("INSERT INTO aws_lightsail_databases (account_id, name, engine, state, backup_retention) VALUES (?, 'r-db', 'mysql', 'available', 0)").run(accountId);
    db.prepare("INSERT INTO aws_lightsail_disks (account_id, name, size_gb, attachment_state, is_system_disk) VALUES (?, 'r-disk', 8, 'detached', 0)").run(accountId);
    db.prepare("INSERT INTO aws_lightsail_buckets (account_id, name, read_only_access) VALUES (?, 'r-bucket', 1)").run(accountId);
    db.prepare("INSERT INTO aws_lightsail_load_balancers (account_id, name, attached_instances, healthy_count, unhealthy_count) VALUES (?, 'r-lb', '[\"a\"]', 1, 1)").run(accountId);
    db.prepare("INSERT INTO aws_lightsail_distributions (account_id, name, is_enabled, alternative_domains) VALUES (?, 'r-dist', 1, '[]')").run(accountId);
    db.prepare("INSERT INTO aws_lightsail_domains (account_id, name, entry_count) VALUES (?, 'r.example.com', 6)").run(accountId);
    db.prepare("INSERT INTO aws_lightsail_static_ips (account_id, name, ip_address, is_attached) VALUES (?, 'r-ip', '9.9.9.9', 0)").run(accountId);

    const awsRouter = require('../routes/aws');
    app = express();
    app.use(express.json());
    app.use('/api/aws', awsRouter);
  });

  it('GET /lightsail returns instances with the new columns', async () => {
    const res = await request(app).get('/api/aws/lightsail').query({ accountId });
    expect(res.status).toBe(200);
    expect(res.body.instances).toHaveLength(1);
    expect(res.body.instances[0]).toMatchObject({ name: 'win-1', ramGb: 16, isWindows: true, account: 'ls-routes' });
  });

  it.each([
    ['databases', 'databases', 'r-db'],
    ['disks', 'disks', 'r-disk'],
    ['buckets', 'buckets', 'r-bucket'],
    ['load-balancers', 'loadBalancers', 'r-lb'],
    ['distributions', 'distributions', 'r-dist'],
    ['domains', 'domains', 'r.example.com'],
    ['static-ips', 'staticIps', 'r-ip'],
  ])('GET /lightsail/%s answers 200 with %s', async (path, key, name) => {
    const res = await request(app).get(`/api/aws/lightsail/${path}`).query({ accountId });
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body[key])).toBe(true);
    expect(res.body[key]).toHaveLength(1);
    expect(res.body[key][0]).toMatchObject({ name, account: 'ls-routes' });
  });

  it('GET /lightsail/load-balancers parses attached instances', async () => {
    const res = await request(app).get('/api/aws/lightsail/load-balancers').query({ accountId });
    expect(res.body.loadBalancers[0].attachedInstances).toEqual(['a']);
    expect(res.body.loadBalancers[0]).toMatchObject({ healthyCount: 1, unhealthyCount: 1 });
  });

  it('GET /lightsail/summary counts families and the watch items', async () => {
    const res = await request(app).get('/api/aws/lightsail/summary').query({ accountId });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      instances: 1, instancesRunning: 1, databases: 1, disks: 1, buckets: 1, loadBalancers: 1,
      distributions: 1, domains: 1, staticIps: 1,
      unattachedDisks: 1, unattachedStaticIps: 1, publicBuckets: 1, databasesWithoutBackups: 1, loadBalancersUnhealthy: 1,
    });
  });

  it('GET /overview lightsail block carries database, disk and bucket counts', async () => {
    const res = await request(app).get('/api/aws/overview').query({ accountId });
    expect(res.status).toBe(200);
    expect(res.body.lightsail).toMatchObject({ total: 1, running: 1, databases: 1, disks: 1, buckets: 1 });
  });
});
