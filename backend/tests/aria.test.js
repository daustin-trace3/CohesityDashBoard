/**
 * Self-contained aria platform backend test (WP1). Runs the aria migration
 * into the shared per-file test DB that tests/setup.js already points at a
 * throwaway temp file (see that file's note on env vars needing to be set
 * before any app module loads), then exercises ariaIssues compute/reconcile
 * against seeded rows and a minimal express app wired to routes/aria.js.
 *
 * Loaded via createRequire (not ESM import) so every service module below
 * resolves the SAME db/database.js singleton instance — see the identical
 * note in tests/platformPlugins.test.js.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { createRequire } from 'module';
import express from 'express';
import request from 'supertest';

const require = createRequire(import.meta.url);

const db = require('../db/database');
const { runMigrations } = require('../core/migrations');
const ariaMigrations = require('../db/migrations/aria');
const { encrypt } = require('../services/encryption');

beforeAll(() => {
  runMigrations(db, 'aria', ariaMigrations);
});

function insertInstance(overrides = {}) {
  const info = db.prepare(`
    INSERT INTO aria_instances (name, host, username, domain, encrypted_credentials, ssl_verify,
      polling_interval_minutes, last_poll_status, last_poll_error, cert_valid_to)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    overrides.name ?? 'vra1',
    overrides.host ?? 'test-aria.invalid',
    overrides.username ?? 'administrator',
    overrides.domain ?? null,
    encrypt(JSON.stringify({ password: 'p@ss' })),
    0, 15,
    overrides.last_poll_status ?? null,
    overrides.last_poll_error ?? null,
    overrides.cert_valid_to ?? null,
  );
  return info.lastInsertRowid;
}

const isoIn = (days) => new Date(Date.now() + days * 86400000).toISOString();

describe('ariaIssues.computeIssues + reconcileIssueHistory', () => {
  it('detects every issue type from seeded rows', () => {
    const { computeIssues, reconcileIssueHistory } = require('../services/ariaIssues');

    const instanceId = insertInstance({
      name: 'vra-issues', last_poll_status: 'error', last_poll_error: 'connect ETIMEDOUT',
      cert_valid_to: isoIn(5), // < default 30d cert warn window
    });

    db.prepare(`
      INSERT INTO aria_endpoints (instance_id, endpoint_id, kind, name, type, health_state, detail)
      VALUES (?, 'ep-1', 'integration', 'Broken Integration', 'abx', 'DOWN', '{}')
    `).run(instanceId);

    db.prepare(`
      INSERT INTO aria_deployments (instance_id, deployment_id, name, status, lease_expire_at)
      VALUES (?, 'dep-1', 'my-deployment', 'CREATE_FAILED', ?)
    `).run(instanceId, isoIn(3)); // < default 7d lease warn window

    db.prepare(`
      INSERT INTO aria_catalog_sources (instance_id, source_id, name, type, last_import_errors)
      VALUES (?, 'src-1', 'GitHub Source', 'git', 'sync failed: timeout')
    `).run(instanceId);

    db.prepare(`
      INSERT INTO aria_runs (instance_id, kind, run_id, name, status)
      VALUES (?, 'abx', 'run-1', 'my-action', 'FAILED')
    `).run(instanceId);

    db.prepare(`
      INSERT INTO aria_approvals (instance_id, approval_id, subject, requested_by, status)
      VALUES (?, 'appr-1', 'Deploy prod', 'jdoe', 'PENDING')
    `).run(instanceId);

    const issues = computeIssues();
    const byType = (type) => issues.filter((i) => i.type === type);

    expect(byType('instance-unreachable')).toHaveLength(1);
    expect(byType('instance-unreachable')[0].severity).toBe('error');

    expect(byType('endpoint-unhealthy')).toHaveLength(1);
    expect(byType('endpoint-unhealthy')[0].severity).toBe('error');

    expect(byType('deployment-failed')).toHaveLength(1);
    expect(byType('deployment-failed')[0].severity).toBe('warning');

    expect(byType('lease-expiring')).toHaveLength(1);
    expect(byType('lease-expiring')[0].severity).toBe('warning');

    expect(byType('cert-expiring')).toHaveLength(1);
    expect(byType('cert-expiring')[0].severity).toBe('warning');

    expect(byType('catalog-import-errors')).toHaveLength(1);
    expect(byType('catalog-import-errors')[0].severity).toBe('warning');

    expect(byType('runs-failed')).toHaveLength(1);
    expect(byType('runs-failed')[0].severity).toBe('warning');
    expect(byType('runs-failed')[0].message).toMatch(/1 abx run/);

    expect(byType('approvals-pending')).toHaveLength(1);
    expect(byType('approvals-pending')[0].severity).toBe('info');

    // error severities sort before warning, which sorts before info.
    const severityRank = { error: 0, warning: 1, info: 2 };
    for (let i = 1; i < issues.length; i++) {
      expect(severityRank[issues[i - 1].severity]).toBeLessThanOrEqual(severityRank[issues[i].severity]);
    }

    reconcileIssueHistory();
    const openRows = db.prepare("SELECT * FROM aria_issue_history WHERE status = 'open' AND instance = 'vra-issues'").all();
    expect(openRows.length).toBe(issues.length);
    for (const row of openRows) {
      expect(row.issue_key).toBe(`${row.type}|${row.instance}|${row.target}`);
    }

    // Resolve the deployment-failed issue by fixing the underlying row, then
    // reconcile again — its history row should flip to resolved.
    db.prepare("UPDATE aria_deployments SET status = 'CREATE_SUCCESSFUL' WHERE deployment_id = 'dep-1'").run();
    reconcileIssueHistory();
    const resolved = db.prepare(
      "SELECT * FROM aria_issue_history WHERE type = 'deployment-failed' AND instance = 'vra-issues'"
    ).get();
    expect(resolved.status).toBe('resolved');
    expect(resolved.resolved_at).not.toBeNull();

    // Everything else is still open.
    const stillOpen = db.prepare(
      "SELECT COUNT(*) c FROM aria_issue_history WHERE status = 'open' AND instance = 'vra-issues'"
    ).get().c;
    expect(stillOpen).toBe(issues.length - 1);
  });

  it('clamps thresholds to their documented defaults/bounds', () => {
    const { leaseWarnDays, certWarnDays, requestFailLookbackHours } = require('../services/ariaIssues');
    expect(leaseWarnDays()).toBe(7);
    expect(certWarnDays()).toBe(30);
    expect(requestFailLookbackHours()).toBe(24);
  });
});

describe('routes/aria.js basic CRUD (minimal express app, no dispatcher)', () => {
  let app;

  beforeAll(() => {
    const ariaRouter = require('../routes/aria');
    app = express();
    app.use(express.json());
    app.use('/api/aria', ariaRouter);
  });

  it('GET /api/aria/instances lists registered instances', async () => {
    const res = await request(app).get('/api/aria/instances');
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body)).toBe(true);
    // Never leaks the encrypted credentials blob.
    for (const row of res.body) expect(row.encrypted_credentials).toBeUndefined();
  });

  it('POST/PUT/DELETE /api/aria/instances round-trips a registration', async () => {
    const created = await request(app).post('/api/aria/instances').send({
      name: 'crud-test-instance', host: 'crud-test.invalid',
      username: 'administrator', password: 'p@ssw0rd!',
    });
    expect(created.status).toBe(201);
    expect(created.body.id).toBeTypeOf('number');
    expect(created.body.password).toBeUndefined();
    expect(created.body.sslVerify).toBe(false);

    const dup = await request(app).post('/api/aria/instances').send({
      name: 'crud-test-instance', host: 'other.invalid', username: 'x', password: 'y',
    });
    expect(dup.status).toBe(409);

    const updated = await request(app).put(`/api/aria/instances/${created.body.id}`).send({
      pollingIntervalMinutes: 30,
    });
    expect(updated.status).toBe(200);
    expect(updated.body.pollingIntervalMinutes).toBe(30);

    const deleted = await request(app).delete(`/api/aria/instances/${created.body.id}`);
    expect(deleted.status).toBe(200);
    expect(deleted.body).toEqual({ deleted: true });
  });

  it('POST /api/aria/instances/test never throws on an unreachable host', async () => {
    const res = await request(app).post('/api/aria/instances/test').send({
      host: 'definitely-not-a-real-aria-host.invalid', username: 'administrator', password: 'x',
    });
    expect(res.status).toBe(502);
    expect(res.body.ok).toBe(false);
    expect(typeof res.body.error).toBe('string');
  });

  it('GET /api/aria/overview returns the instances+totals rollup shape', async () => {
    const res = await request(app).get('/api/aria/overview');
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.instances)).toBe(true);
    expect(res.body.totals).toBeTypeOf('object');
  });

  it('GET /api/aria/issues returns the computed issue array', async () => {
    const res = await request(app).get('/api/aria/issues');
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body)).toBe(true);
  });

  it('GET/PUT /api/aria/config round-trips clamped thresholds', async () => {
    const before = await request(app).get('/api/aria/config');
    expect(before.status).toBe(200);
    expect(before.body).toEqual({ leaseWarnDays: 7, certWarnDays: 30, requestFailLookbackHours: 24 });

    const saved = await request(app).put('/api/aria/config').send({
      leaseWarnDays: 14, certWarnDays: 45, requestFailLookbackHours: 48,
    });
    expect(saved.status).toBe(200);
    expect(saved.body).toEqual({
      saved: true, leaseWarnDays: 14, certWarnDays: 45, requestFailLookbackHours: 48,
    });

    const invalid = await request(app).put('/api/aria/config').send({
      leaseWarnDays: 999, certWarnDays: 45, requestFailLookbackHours: 48,
    });
    expect(invalid.status).toBe(400);
  });

  it('GET /api/aria/deployments|requests|endpoints|projects|catalog-sources|runs|approvals|metrics-history all 200 with []', async () => {
    for (const path of [
      'deployments', 'requests', 'endpoints', 'projects', 'catalog-sources', 'runs', 'approvals', 'metrics-history',
    ]) {
      const res = await request(app).get(`/api/aria/${path}`);
      expect(res.status, `GET /api/aria/${path}`).toBe(200);
      expect(Array.isArray(res.body), `GET /api/aria/${path} body`).toBe(true);
    }
  });
});
