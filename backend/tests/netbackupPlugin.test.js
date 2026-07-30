/**
 * Self-contained netbackup platform backend test (WP1). Runs the netbackup
 * migration into the shared per-file test DB, exercises netbackupIssues
 * compute/reconcile against seeded rows, a minimal express app wired to
 * routes/netbackup.js, and the plugin dispatcher end-to-end (mirrors
 * tests/aria.test.js and tests/platformPlugins.test.js).
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
const netbackupMigrations = require('../db/migrations/netbackup');
const { encrypt } = require('../services/encryption');

beforeAll(() => {
  runMigrations(db, 'netbackup', netbackupMigrations);
});

function insertSource(overrides = {}) {
  const info = db.prepare(`
    INSERT INTO netbackup_sources (name, source_type, host, port, auth_mode, username,
      encrypted_credentials, ssl_verify, polling_interval_minutes, last_poll_status, last_poll_error)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    overrides.name ?? 'nb1',
    overrides.source_type ?? 'primary',
    overrides.host ?? 'test-netbackup.invalid',
    overrides.port ?? 1556,
    overrides.auth_mode ?? 'password',
    overrides.username ?? 'nbadmin',
    encrypt(JSON.stringify({ password: 'p@ss' })),
    0, 15,
    overrides.last_poll_status ?? null,
    overrides.last_poll_error ?? null,
  );
  return info.lastInsertRowid;
}

describe('netbackupIssues.computeIssues + reconcileIssueHistory', () => {
  it('detects every issue type from seeded rows', () => {
    const { computeIssues, reconcileIssueHistory } = require('../services/netbackupIssues');

    const sourceId = insertSource({
      name: 'nb-issues', last_poll_status: 'error', last_poll_error: 'connect ETIMEDOUT',
    });

    // Policy with 2 failed jobs out of 2 (100% failed -> critical) in the last 24h,
    // plus enough total failures to also trip the source-wide success-rate rule.
    const jobStmt = db.prepare(`
      INSERT INTO netbackup_jobs (source_id, job_id, state, status_code, policy_name, policy_type,
        client_name, started_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, datetime('now', '-1 hour'))
    `);
    jobStmt.run(sourceId, 1, 'FAILED', 1, 'daily-policy', 'Standard', 'client-a');
    jobStmt.run(sourceId, 2, 'DONE', 6, 'daily-policy', 'Standard', 'client-b');

    db.prepare(`
      INSERT INTO netbackup_storage_units (source_id, name, capacity_bytes, free_bytes)
      VALUES (?, 'su1', 1000, 50)
    `).run(sourceId); // 5% free -> critical

    db.prepare(`
      INSERT INTO netbackup_disk_pools (source_id, name, total_capacity_bytes, available_capacity_bytes)
      VALUES (?, 'dp1', 1000, 150)
    `).run(sourceId); // 15% free -> warning

    db.prepare(`
      INSERT INTO netbackup_media_servers (source_id, name, state) VALUES (?, 'media1', 'DOWN')
    `).run(sourceId);

    db.prepare(`
      INSERT INTO netbackup_alerts (source_id, alert_id, severity, message) VALUES (?, 'al-1', 'critical', 'Disk full')
    `).run(sourceId);

    // Client with no job at all in the lookback window -> never-backed-up stale client.
    jobStmt.run(sourceId, 3, 'DONE', 0, 'daily-policy', 'Standard', 'client-stale');
    db.prepare("UPDATE netbackup_jobs SET started_at = datetime('now', '-10 days') WHERE job_id = 3 AND source_id = ?").run(sourceId);

    const issues = computeIssues();
    const byPrefix = (prefix) => issues.filter((i) => i.issue_key.startsWith(prefix));

    expect(byPrefix(`poll-error:${sourceId}`)).toHaveLength(1);
    expect(byPrefix(`poll-error:${sourceId}`)[0].severity).toBe('critical');

    expect(byPrefix(`job-failures:${sourceId}:daily-policy`)).toHaveLength(1);
    expect(byPrefix(`job-failures:${sourceId}:daily-policy`)[0].severity).toBe('critical');

    expect(byPrefix(`success-rate:${sourceId}`)).toHaveLength(1);

    expect(byPrefix(`storage-low:${sourceId}:su1`)).toHaveLength(1);
    expect(byPrefix(`storage-low:${sourceId}:su1`)[0].severity).toBe('critical');

    expect(byPrefix(`storage-low:${sourceId}:dp1`)).toHaveLength(1);
    expect(byPrefix(`storage-low:${sourceId}:dp1`)[0].severity).toBe('warning');

    expect(byPrefix(`media-server-down:${sourceId}:media1`)).toHaveLength(1);

    expect(byPrefix(`stale-backup:${sourceId}:client-stale`)).toHaveLength(1);

    expect(byPrefix(`upstream-alert:${sourceId}:al-1`)).toHaveLength(1);
    expect(byPrefix(`upstream-alert:${sourceId}:al-1`)[0].severity).toBe('critical');

    // critical severities sort before warning, which sorts before info.
    const severityRank = { critical: 0, warning: 1, info: 2 };
    for (let i = 1; i < issues.length; i++) {
      expect(severityRank[issues[i - 1].severity]).toBeLessThanOrEqual(severityRank[issues[i].severity]);
    }

    reconcileIssueHistory();
    const openRows = db.prepare("SELECT * FROM netbackup_issue_history WHERE status = 'open' AND source_id = ?").all(sourceId);
    expect(openRows.length).toBe(issues.filter((i) => i.source_id === sourceId).length);

    // Resolve the media-server-down issue, reconcile again -> flips to resolved.
    db.prepare("UPDATE netbackup_media_servers SET state = 'ACTIVE' WHERE source_id = ? AND name = 'media1'").run(sourceId);
    reconcileIssueHistory();
    const resolved = db.prepare(
      "SELECT * FROM netbackup_issue_history WHERE issue_key = ? AND source_id = ?"
    ).get(`media-server-down:${sourceId}:media1`, sourceId);
    expect(resolved.status).toBe('resolved');
    expect(resolved.resolved_at).not.toBeNull();
  });

  it('clamps thresholds to their documented defaults/bounds', () => {
    const { successWarnPct, storageWarnPct, staleBackupHours } = require('../services/netbackupIssues');
    expect(successWarnPct()).toBe(90);
    expect(storageWarnPct()).toBe(20);
    expect(staleBackupHours()).toBe(48);
  });
});

describe('routes/netbackup.js basic CRUD (minimal express app, no dispatcher)', () => {
  let app;

  beforeAll(() => {
    const netbackupRouter = require('../routes/netbackup');
    app = express();
    app.use(express.json());
    app.use('/api/netbackup', netbackupRouter);
  });

  it('GET /api/netbackup/sources lists registered sources, never leaking credentials', async () => {
    const res = await request(app).get('/api/netbackup/sources');
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.sources)).toBe(true);
    for (const row of res.body.sources) expect(row.encrypted_credentials).toBeUndefined();
  });

  it('POST/PUT/DELETE /api/netbackup/sources round-trips a primary registration, PUT keeps creds when blank', async () => {
    const created = await request(app).post('/api/netbackup/sources').send({
      name: 'crud-test-source', host: 'crud-test.invalid', authMode: 'password',
      username: 'nbadmin', password: 'p@ssw0rd!',
    });
    expect(created.status).toBe(201);
    expect(created.body.source.id).toBeTypeOf('number');
    expect(created.body.source.password).toBeUndefined();
    expect(created.body.source.sslVerify).toBe(false);
    const sourceId = created.body.source.id;

    const dup = await request(app).post('/api/netbackup/sources').send({
      name: 'crud-test-source', host: 'other.invalid', username: 'x', password: 'y',
    });
    expect(dup.status).toBe(409);

    const missingCred = await request(app).post('/api/netbackup/sources').send({
      name: 'crud-test-source-2', host: 'other2.invalid', authMode: 'apikey',
    });
    expect(missingCred.status).toBe(400);

    const before = db.prepare('SELECT encrypted_credentials FROM netbackup_sources WHERE id = ?').get(sourceId).encrypted_credentials;
    const updated = await request(app).put(`/api/netbackup/sources/${sourceId}`).send({
      pollingIntervalMinutes: 30,
    });
    expect(updated.status).toBe(200);
    expect(updated.body.source.pollingIntervalMinutes).toBe(30);
    const after = db.prepare('SELECT encrypted_credentials FROM netbackup_sources WHERE id = ?').get(sourceId).encrypted_credentials;
    expect(after).toBe(before); // blank password on PUT keeps the stored credential

    const deleted = await request(app).delete(`/api/netbackup/sources/${sourceId}`);
    expect(deleted.status).toBe(200);
    expect(deleted.body).toEqual({ deleted: true });
  });

  it('POST /api/netbackup/sources with sourceType alta + apiKey round-trips', async () => {
    const created = await request(app).post('/api/netbackup/sources').send({
      name: 'alta-tenant', sourceType: 'alta', host: 'https://tenant.netbackup.alta.veritas.com/netbackup',
      authMode: 'apikey', apiKey: 'abc123',
    });
    expect(created.status).toBe(201);
    expect(created.body.source.sourceType).toBe('alta');
    expect(created.body.source.authMode).toBe('apikey');
    await request(app).delete(`/api/netbackup/sources/${created.body.source.id}`);
  });

  it('POST /api/netbackup/sources/test never throws on an unreachable host', async () => {
    const res = await request(app).post('/api/netbackup/sources/test').send({
      host: 'definitely-not-a-real-netbackup-host.invalid', authMode: 'password', username: 'nbadmin', password: 'x',
    });
    expect(res.status).toBe(502);
    expect(res.body.ok).toBe(false);
    expect(typeof res.body.error).toBe('string');
  });

  it('GET /api/netbackup/overview returns the stats rollup shape', async () => {
    const res = await request(app).get('/api/netbackup/overview');
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.sources)).toBe(true);
    expect(res.body.stats).toBeTypeOf('object');
    expect(res.body.stats.sourceCount).toBeTypeOf('number');
    expect(res.body.jobsByState).toBeTypeOf('object');
    expect(Array.isArray(res.body.recentFailedJobs)).toBe(true);
  });

  it('GET /api/netbackup/issues returns the computed issue array', async () => {
    const res = await request(app).get('/api/netbackup/issues');
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.issues)).toBe(true);
  });

  it('GET/PUT /api/netbackup/config round-trips clamped thresholds', async () => {
    const before = await request(app).get('/api/netbackup/config');
    expect(before.status).toBe(200);
    expect(before.body).toEqual({ successWarnPct: 90, storageWarnPct: 20, staleBackupHours: 48 });

    const saved = await request(app).put('/api/netbackup/config').send({
      successWarnPct: 95, storageWarnPct: 25, staleBackupHours: 72,
    });
    expect(saved.status).toBe(200);
    expect(saved.body).toEqual({ successWarnPct: 95, storageWarnPct: 25, staleBackupHours: 72 });

    const invalid = await request(app).put('/api/netbackup/config').send({
      successWarnPct: 10, storageWarnPct: 25, staleBackupHours: 72,
    });
    expect(invalid.status).toBe(400);
  });

  it('GET /api/netbackup/jobs|policies|storage|media-servers|appliances|issue-history|trends all 200', async () => {
    const checks = [
      ['jobs', (b) => Array.isArray(b.jobs)],
      ['policies', (b) => Array.isArray(b.policies)],
      ['storage', (b) => Array.isArray(b.storageUnits) && Array.isArray(b.diskPools)],
      ['media-servers', (b) => Array.isArray(b.mediaServers)],
      ['appliances', (b) => Array.isArray(b.appliances)],
      ['issue-history', (b) => Array.isArray(b)],
      ['trends', (b) => Array.isArray(b.trends)],
    ];
    for (const [path, shapeOk] of checks) {
      const res = await request(app).get(`/api/netbackup/${path}`);
      expect(res.status, `GET /api/netbackup/${path}`).toBe(200);
      expect(shapeOk(res.body), `GET /api/netbackup/${path} body shape`).toBe(true);
    }
  });
});

describe('netbackup platform plugin dispatcher (registered via registry, like platformPlugins.test.js)', () => {
  const registry = require('../core/registry');
  const netbackupManifest = require('../platforms/netbackup');
  const { createApp } = require('../app');

  const API_KEY = 'test-api-key';
  let app;

  beforeEach(() => {
    registry._reset();
    registry.init();
    registry.registerPlugin(netbackupManifest);
    app = createApp({ licenseGate: (req, res, next) => next() });
  });

  it('GET /api/netbackup/sources -> 200 through the dispatcher when registered+enabled', async () => {
    const res = await request(app).get('/api/netbackup/sources').set('x-api-key', API_KEY);
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.sources)).toBe(true);
  });

  it('disabling netbackup returns 404 platform_disabled; re-enabling restores 200', async () => {
    const get = () => request(app).get('/api/netbackup/sources').set('x-api-key', API_KEY);

    registry.setEnabled('netbackup', false);
    const disabledRes = await get();
    expect(disabledRes.status).toBe(404);
    expect(disabledRes.body).toEqual({ error: 'platform_disabled' });

    registry.setEnabled('netbackup', true);
    const enabledRes = await get();
    expect(enabledRes.status).toBe(200);
  });
});
