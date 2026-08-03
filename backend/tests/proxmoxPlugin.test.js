/**
 * Self-contained Proxmox VE platform backend test (WP1). Runs the proxmox
 * migration into the shared per-file test DB, exercises proxmoxIssues
 * compute/reconcile against seeded rows for every rule, a minimal express
 * app wired to routes/proxmox.js, and the plugin dispatcher end-to-end
 * (mirrors tests/awsPlugin.test.js).
 *
 * Loaded via createRequire (not ESM import) so every service module below
 * resolves the SAME db/database.js singleton instance as app.js.
 */
import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import { createRequire } from 'module';
import express from 'express';
import request from 'supertest';

const require = createRequire(import.meta.url);

const db = require('../db/database');
const { runMigrations } = require('../core/migrations');
const proxmoxMigrations = require('../db/migrations/proxmox');
const { encrypt } = require('../services/encryption');

beforeAll(() => {
  runMigrations(db, 'proxmox', proxmoxMigrations);
});

function insertServer(overrides = {}) {
  const info = db.prepare(`
    INSERT INTO proxmox_servers (name, host, port, token_id, encrypted_credentials,
      ssl_verify, polling_interval_minutes, last_poll_status, last_poll_error, quorate, forbidden_endpoints)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    overrides.name ?? 'pve1',
    overrides.host ?? '10.0.0.10',
    overrides.port ?? 8006,
    overrides.token_id ?? 'root@pam!icc',
    overrides.encrypted_credentials !== undefined ? overrides.encrypted_credentials : encrypt(JSON.stringify({ tokenSecret: 'shh' })),
    overrides.ssl_verify ?? 0,
    overrides.polling_interval_minutes ?? 10,
    overrides.last_poll_status ?? null,
    overrides.last_poll_error ?? null,
    overrides.quorate ?? null,
    overrides.forbidden_endpoints ?? null,
  );
  return info.lastInsertRowid;
}

describe('proxmoxIssues.computeIssues + reconcileIssueHistory', () => {
  it('detects every issue rule from seeded rows', () => {
    const { computeIssues, reconcileIssueHistory } = require('../services/proxmoxIssues');

    const serverId = insertServer({
      name: 'pve-issues', quorate: 0, forbidden_endpoints: JSON.stringify(['cluster/resources']),
    });

    // node-offline
    db.prepare(`
      INSERT INTO proxmox_nodes (server_id, name, status) VALUES (?, 'node-down', 'offline')
    `).run(serverId);

    // storage-full / storage-warn
    db.prepare(`
      INSERT INTO proxmox_storage (server_id, node, storage, used_bytes, total_bytes)
      VALUES (?, 'node-down', 'local-crit', 970, 1000)
    `).run(serverId);
    db.prepare(`
      INSERT INTO proxmox_storage (server_id, node, storage, used_bytes, total_bytes)
      VALUES (?, 'node-down', 'local-warn', 880, 1000)
    `).run(serverId);
    db.prepare(`
      INSERT INTO proxmox_storage (server_id, node, storage, used_bytes, total_bytes)
      VALUES (?, 'node-down', 'local-ok', 100, 1000)
    `).run(serverId);

    // backup-failed: vzdump task failed within last 7 days.
    db.prepare(`
      INSERT INTO proxmox_guests (server_id, vmid, name, type, node, status, is_template)
      VALUES (?, 100, 'web-1', 'qemu', 'node-down', 'running', 0)
    `).run(serverId);
    db.prepare(`
      INSERT INTO proxmox_tasks (server_id, upid, node, type, target, status, started_at, ended_at)
      VALUES (?, 'UPID:failed', 'node-down', 'vzdump', '100', 'job errors', datetime('now', '-1 day'), datetime('now', '-1 day'))
    `).run(serverId);

    // task-failed: non-vzdump task failed within last 24h.
    db.prepare(`
      INSERT INTO proxmox_tasks (server_id, upid, node, type, target, status, started_at, ended_at)
      VALUES (?, 'UPID:migrate-fail', 'node-down', 'qmigrate', '100', 'failed', datetime('now', '-1 hour'), datetime('now', '-1 hour'))
    `).run(serverId);

    // backup-stale: non-template guest with no successful backup + a backup job exists.
    db.prepare(`
      INSERT INTO proxmox_guests (server_id, vmid, name, type, node, status, is_template)
      VALUES (?, 101, 'stale-guest', 'lxc', 'node-down', 'running', 0)
    `).run(serverId);
    db.prepare(`
      INSERT INTO proxmox_backup_jobs (server_id, job_id, enabled, storage, selection)
      VALUES (?, 'job1', 1, 'local', 'all')
    `).run(serverId);

    // cert-expiring
    db.prepare(`
      UPDATE proxmox_nodes SET cert_expires_at = datetime('now', '+10 days') WHERE server_id = ? AND name = 'node-down'
    `).run(serverId);

    const issues = computeIssues();
    const byType = (type) => issues.filter((i) => i.type === type);

    expect(byType('node-offline')).toHaveLength(1);
    expect(byType('node-offline')[0].severity).toBe('critical');
    expect(byType('node-offline')[0].target).toBe('node-down');

    expect(byType('storage-full').some((i) => i.target === 'node-down/local-crit')).toBe(true);
    expect(byType('storage-warn').some((i) => i.target === 'node-down/local-warn')).toBe(true);
    expect(byType('storage-full').some((i) => i.target === 'node-down/local-ok')).toBe(false);

    expect(byType('backup-failed').some((i) => i.target === 'web-1 (100)')).toBe(true);
    expect(byType('backup-failed')[0].severity).toBe('critical');

    expect(byType('task-failed').some((i) => i.target === 'qmigrate on node-down')).toBe(true);

    expect(byType('backup-stale').some((i) => i.target === 'stale-guest (101)')).toBe(true);

    expect(byType('cert-expiring').some((i) => i.target === 'node-down')).toBe(true);

    expect(byType('quorum-lost')).toHaveLength(1);
    expect(byType('quorum-lost')[0].source).toBe('pve-issues');

    expect(byType('token-permissions')).toHaveLength(1);
    expect(byType('token-permissions')[0].source).toBe('pve-issues');

    const severityRank = { critical: 0, warning: 1, info: 2 };
    for (let i = 1; i < issues.length; i++) {
      expect(severityRank[issues[i - 1].severity]).toBeLessThanOrEqual(severityRank[issues[i].severity]);
    }

    reconcileIssueHistory();
    const openRows = db.prepare("SELECT * FROM proxmox_issue_history WHERE status = 'open' AND source_id = ?").all(serverId);
    expect(openRows.length).toBe(issues.filter((i) => i.sourceId === serverId).length);

    // Resolve node-offline by fixing status, reconcile again -> flips to resolved.
    db.prepare("UPDATE proxmox_nodes SET status = 'online' WHERE server_id = ? AND name = 'node-down'").run(serverId);
    reconcileIssueHistory();
    const resolved = db.prepare(
      'SELECT * FROM proxmox_issue_history WHERE issue_key = ? AND source_id = ?'
    ).get('node-offline|pve-issues|node-down', serverId);
    expect(resolved.status).toBe('resolved');
    expect(resolved.resolved_at).not.toBeNull();
  });

  it('clamps thresholds to their documented defaults', () => {
    const { storageWarnPct, storageCritPct, backupStaleDays, certWarnDays } = require('../services/proxmoxIssues');
    expect(storageWarnPct()).toBe(85);
    expect(storageCritPct()).toBe(95);
    expect(backupStaleDays()).toBe(3);
    expect(certWarnDays()).toBe(30);
  });
});

describe('routes/proxmox.js basic CRUD + data endpoints (minimal express app, no dispatcher)', () => {
  let app;

  beforeAll(() => {
    const proxmoxRouter = require('../routes/proxmox');
    app = express();
    app.use(express.json());
    app.use('/api/proxmox', proxmoxRouter);
  });

  it('GET /api/proxmox/servers lists registered servers, never leaking the secret', async () => {
    const res = await request(app).get('/api/proxmox/servers');
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body)).toBe(true);
    for (const row of res.body) {
      expect(row.encryptedCredentials).toBeUndefined();
      expect(row.tokenSecret).toBeUndefined();
      expect(typeof row.hasCredentials).toBe('boolean');
    }
  });

  it('POST/PUT/DELETE /api/proxmox/servers round-trips, PUT keeps secret when blank, 409 on dup name', async () => {
    const created = await request(app).post('/api/proxmox/servers').send({
      name: 'crud-test-server', host: '10.0.0.20', tokenId: 'root@pam!crud', tokenSecret: 's3cr3t',
    });
    expect(created.status).toBe(201);
    expect(created.body.id).toBeTypeOf('number');
    expect(created.body.tokenId).toBe('root@pam!crud');
    expect(created.body.hasCredentials).toBe(true);
    expect(created.body.tokenSecret).toBeUndefined();
    const serverId = created.body.id;

    const dup = await request(app).post('/api/proxmox/servers').send({
      name: 'crud-test-server', host: '10.0.0.99', tokenId: 'x', tokenSecret: 'y',
    });
    expect(dup.status).toBe(409);

    const before = db.prepare('SELECT encrypted_credentials FROM proxmox_servers WHERE id = ?').get(serverId).encrypted_credentials;
    const updated = await request(app).put(`/api/proxmox/servers/${serverId}`).send({ pollingIntervalMinutes: 20 });
    expect(updated.status).toBe(200);
    expect(updated.body.pollingIntervalMinutes).toBe(20);
    const after = db.prepare('SELECT encrypted_credentials FROM proxmox_servers WHERE id = ?').get(serverId).encrypted_credentials;
    expect(after).toBe(before); // blank tokenSecret on PUT keeps stored credential

    const deleted = await request(app).delete(`/api/proxmox/servers/${serverId}`);
    expect(deleted.status).toBe(200);
    expect(deleted.body).toEqual({ ok: true });
  });

  it('GET/PUT /api/proxmox/config round-trips clamped thresholds', async () => {
    const before = await request(app).get('/api/proxmox/config');
    expect(before.status).toBe(200);
    expect(before.body).toEqual({
      storageWarnPct: 85, storageCritPct: 95, backupStaleDays: 3, certWarnDays: 30,
    });

    const saved = await request(app).put('/api/proxmox/config').send({
      storageWarnPct: 80, storageCritPct: 90, backupStaleDays: 5, certWarnDays: 45,
    });
    expect(saved.status).toBe(200);
    expect(saved.body).toEqual({
      storageWarnPct: 80, storageCritPct: 90, backupStaleDays: 5, certWarnDays: 45,
    });

    const invalid = await request(app).put('/api/proxmox/config').send({
      storageWarnPct: 0, storageCritPct: 90, backupStaleDays: 5, certWarnDays: 45,
    });
    expect(invalid.status).toBe(400);

    // restore defaults
    await request(app).put('/api/proxmox/config').send({
      storageWarnPct: 85, storageCritPct: 95, backupStaleDays: 3, certWarnDays: 30,
    });
  });

  it('GET /api/proxmox/overview returns the fleet rollup shape', async () => {
    const res = await request(app).get('/api/proxmox/overview');
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.servers)).toBe(true);
    expect(res.body.totals).toEqual(expect.objectContaining({
      nodes: expect.any(Number), nodesOnline: expect.any(Number),
      guests: expect.any(Number), guestsRunning: expect.any(Number),
      vms: expect.any(Number), containers: expect.any(Number), templates: expect.any(Number),
      storagePools: expect.any(Number), storageUsedBytes: expect.any(Number), storageTotalBytes: expect.any(Number),
      openIssues: expect.any(Number), criticalIssues: expect.any(Number),
    }));
  });

  it('GET /api/proxmox/issues returns a bare computed-issue array', async () => {
    const res = await request(app).get('/api/proxmox/issues');
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body)).toBe(true);
  });

  it('GET /api/proxmox/issue-history returns a BARE array', async () => {
    const res = await request(app).get('/api/proxmox/issue-history');
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body)).toBe(true);
    for (const row of res.body) {
      expect(row).toHaveProperty('issueKey');
      expect(row).toHaveProperty('source');
      expect(row).toHaveProperty('firstSeen');
      expect(row).toHaveProperty('lastSeen');
    }
  });

  it('GET /api/proxmox/nodes|guests|storage|backups|tasks|metrics-history all 200 with camelCase shapes', async () => {
    const checks = [
      ['nodes', (b) => Array.isArray(b)],
      ['guests', (b) => Array.isArray(b)],
      ['storage', (b) => Array.isArray(b)],
      ['backups', (b) => Array.isArray(b.jobs) && Array.isArray(b.recentTasks)],
      ['tasks', (b) => Array.isArray(b)],
      ['metrics-history', (b) => Array.isArray(b)],
    ];
    for (const [path, shapeOk] of checks) {
      const res = await request(app).get(`/api/proxmox/${path}`);
      expect(res.status, `GET /api/proxmox/${path}`).toBe(200);
      expect(shapeOk(res.body), `GET /api/proxmox/${path} body shape`).toBe(true);
    }
  });

  it('POST /api/proxmox/servers/test never throws with bogus credentials', async () => {
    const res = await request(app).post('/api/proxmox/servers/test').send({
      host: '127.0.0.1', port: 1, tokenId: 'root@pam!fake', tokenSecret: 'not-a-real-secret',
    });
    expect(res.status).toBe(502);
    expect(res.body.ok).toBe(false);
    expect(typeof res.body.error).toBe('string');
  }, 20000);

  it('POST /api/proxmox/servers/:id/refresh 404s for an unknown id', async () => {
    const res = await request(app).post('/api/proxmox/servers/999999/refresh');
    expect(res.status).toBe(404);
  });
});

describe('proxmox platform plugin dispatcher (registered via registry, like awsPlugin.test.js)', () => {
  const registry = require('../core/registry');
  const proxmoxManifest = require('../platforms/proxmox');
  const { createApp } = require('../app');

  const API_KEY = 'test-api-key';
  let app;

  beforeEach(() => {
    registry._reset();
    registry.init();
    registry.registerPlugin(proxmoxManifest);
    app = createApp({ licenseGate: (req, res, next) => next() });
  });

  it('GET /api/proxmox/servers -> 200 [] through the dispatcher when registered+enabled', async () => {
    const res = await request(app).get('/api/proxmox/servers').set('x-api-key', API_KEY);
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body)).toBe(true);
  });

  it('disabling proxmox returns 404 platform_disabled; re-enabling restores 200', async () => {
    const get = () => request(app).get('/api/proxmox/servers').set('x-api-key', API_KEY);

    registry.setEnabled('proxmox', false);
    const disabledRes = await get();
    expect(disabledRes.status).toBe(404);
    expect(disabledRes.body).toEqual({ error: 'platform_disabled' });

    registry.setEnabled('proxmox', true);
    const enabledRes = await get();
    expect(enabledRes.status).toBe(200);
  });
});
