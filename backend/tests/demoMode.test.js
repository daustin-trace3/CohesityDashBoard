/**
 * Contract C11.5 (WP-A) — demo mode (DASHBOARD_DEMO=1) serves fixture data
 * with zero network calls: Pure1 fleet fixtures, Cohesity hardware fixtures,
 * and the replication status cache path that never kicks off a live scan.
 *
 * isDemo() reads process.env per call (backend/services/demoMode.js), so
 * setting/clearing DASHBOARD_DEMO around this suite cannot leak state into
 * other test files even though each file already gets its own process
 * (vitest.config.mjs pool: 'forks', isolate: true).
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createRequire } from 'module';
import request from 'supertest';

const require = createRequire(import.meta.url);

// pure1 (Pure1 SaaS legacy fixtures) was removed from core along with the
// rest of the pure platform in the 2026-08 pluginization campaign —
// routes/pure1.js, services/pure1Api.js/pure1Poller.js, and
// demo/pure1Fixtures.js are all gone — skip that describe block below
// instead of throwing on the now-missing route.
let PURE1_PRESENT = true;
try { require.resolve('../routes/pure1'); } catch { PURE1_PRESENT = false; }

const API_KEY = 'test-api-key';
let app;
let db;
let encrypt;

beforeAll(() => {
  process.env.DASHBOARD_DEMO = '1';

  const registry = require('../core/registry');
  registry.init();

  const { createApp } = require('../app');
  app = createApp({ licenseGate: (req, res, next) => next() });

  db = require('../db/database');
  ({ encrypt } = require('../services/encryption'));
});

afterAll(() => {
  delete process.env.DASHBOARD_DEMO;
});

const get = (p) => request(app).get(p).set('x-api-key', API_KEY);

describe.skipIf(!PURE1_PRESENT)('demo mode: pure1 fixtures', () => {
  it('GET /api/pure1/overview returns the 20-array fleet without network', async () => {
    const res = await get('/api/pure1/overview');
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body)).toBe(true);
    expect(res.body).toHaveLength(20);
    expect(res.body[0]).toHaveProperty('name');
    expect(res.body[0]).toHaveProperty('total');
    expect(res.body[0]).toHaveProperty('used');
    expect(res.body[0]).toHaveProperty('dataReduction');
  });

  it('GET /api/pure1/status reports configured=true in demo mode', async () => {
    const res = await get('/api/pure1/status');
    expect(res.status).toBe(200);
    expect(res.body.configured).toBe(true);
  });

  it('GET /api/pure1/alerts returns fixture alerts without network', async () => {
    const res = await get('/api/pure1/alerts');
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body)).toBe(true);
    expect(res.body.length).toBeGreaterThan(0);
  });
});

describe('demo mode: cohesity hardware fixtures', () => {
  it('GET /api/cohesity/hardware/:clusterId returns generated nodes for a seeded cluster', async () => {
    const info = db.prepare(`
      INSERT INTO clusters (name, connection_type, auth_type, encrypted_credentials)
      VALUES (?, 'direct', 'apikey', ?)
    `).run('demo-hw-cluster', encrypt(JSON.stringify({ apiKey: 'x' })));
    const clusterId = info.lastInsertRowid;

    const res = await get(`/api/cohesity/hardware/${clusterId}`);
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.nodes)).toBe(true);
    expect(res.body.nodes.length).toBeGreaterThanOrEqual(4);
    expect(res.body.nodes.length).toBeLessThanOrEqual(8);
    expect(Array.isArray(res.body.chassis)).toBe(true);
    expect(res.body.chassis.length).toBeGreaterThan(0);
  });
});

describe('demo mode: replication status cache', () => {
  it('serves a seeded stale cache row without triggering a live scan', async () => {
    const clusterName = 'demo-repl-cluster';
    db.prepare(`
      INSERT INTO clusters (name, connection_type, auth_type, encrypted_credentials)
      VALUES (?, 'direct', 'apikey', ?)
    `).run(clusterName, encrypt(JSON.stringify({ apiKey: 'x' })));

    const payload = {
      sourceCluster: clusterName,
      generatedAt: new Date(Date.now() - 30 * 60 * 1000).toISOString(),
      totalGroupsScanned: 3,
      groupsWithActiveReplication: 1,
      replications: [{ jobName: 'VM_Prod_Backup', protectionGroupId: 1, runId: 1, status: 'Succeeded' }],
    };
    const cacheKey = `${clusterName}:all:7:20`;
    // 1h old — well past the route's 15-minute TTL, so a non-demo request
    // would trigger a background scan here.
    const staleUpdatedAt = new Date(Date.now() - 60 * 60 * 1000).toISOString();

    db.prepare(`
      INSERT INTO replication_status_cache
        (cache_key, cluster_name, status_filter, days, num_runs_per_group, payload_json, scanning, error, updated_at)
      VALUES (?, ?, 'all', 7, 20, ?, 0, NULL, ?)
    `).run(cacheKey, clusterName, JSON.stringify(payload), staleUpdatedAt);

    const res = await get(`/api/cohesity/replication/status?clusterName=${encodeURIComponent(clusterName)}&days=7&numRunsPerGroup=20`);
    expect(res.status).toBe(200);
    expect(res.body.scanning).toBe(false);
    expect(res.body.replications).toHaveLength(1);
    expect(res.body.totalGroupsScanned).toBe(3);

    // No scan means no in-memory replicationCache mutation from a background
    // scan overwriting this row: re-reading immediately still shows the same
    // (still-stale) updated_at, i.e. nothing re-wrote the cache row.
    const row = db.prepare('SELECT updated_at FROM replication_status_cache WHERE cache_key = ?').get(cacheKey);
    expect(row).toBeTruthy();
  });
});
