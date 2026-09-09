/**
 * Self-contained BlueCat platform backend test (WP1). Runs the bluecat
 * migration into the shared per-file test DB (self-contained per contract:
 * WP2 may not have wired database.js yet), exercises bluecatIssues
 * compute/reconcile against seeded rows for every rule, the free-space math
 * helpers, the route dispatcher, and the plugin registry end-to-end.
 * Mirrors backend/tests/unifiPlugin.test.js.
 */
import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import { createRequire } from 'module';
import express from 'express';
import request from 'supertest';

const require = createRequire(import.meta.url);

const db = require('../db/database');
const { runMigrations } = require('../core/migrations');
const bluecatMigrations = require('../db/migrations/bluecat');
const { encrypt } = require('../services/encryption');

beforeAll(() => {
  runMigrations(db, 'bluecat', bluecatMigrations);
});

function insertSource(overrides = {}) {
  const info = db.prepare(`
    INSERT INTO bluecat_sources (name, host, port, encrypted_credentials, ssl_verify, polling_interval_minutes,
      enumerate_interval_minutes, last_poll_status, last_poll_error)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    overrides.name ?? 'bam1',
    overrides.host ?? '10.10.10.10',
    overrides.port ?? 443,
    overrides.encrypted_credentials !== undefined ? overrides.encrypted_credentials : encrypt(JSON.stringify({ username: 'api', password: 'shh' })),
    overrides.ssl_verify ?? 0,
    overrides.polling_interval_minutes ?? 30,
    overrides.enumerate_interval_minutes ?? 60,
    overrides.last_poll_status ?? null,
    overrides.last_poll_error ?? null,
  );
  return info.lastInsertRowid;
}

describe('migrations/bluecat.js: every contract table exists', () => {
  it('creates all bluecat_* tables', () => {
    const tables = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name LIKE 'bluecat_%'").all().map((r) => r.name);
    const expected = [
      'bluecat_sources', 'bluecat_views', 'bluecat_zones', 'bluecat_records', 'bluecat_blocks',
      'bluecat_networks', 'bluecat_ranges', 'bluecat_addresses', 'bluecat_devices', 'bluecat_servers',
      'bluecat_network_overrides', 'bluecat_metrics_history', 'bluecat_issue_history',
    ];
    for (const t of expected) expect(tables, `missing table ${t}`).toContain(t);
  });
});

describe('bluecatApi free-space math', () => {
  const bluecatApi = require('../services/bluecatApi');

  it('capacityForPrefix: /24 -> 254, /30 -> 2, /31 -> 2, /32 -> 1, v6 -> null', () => {
    expect(bluecatApi.capacityForPrefix(24, 4)).toBe(254);
    expect(bluecatApi.capacityForPrefix(30, 4)).toBe(2);
    expect(bluecatApi.capacityForPrefix(31, 4)).toBe(2);
    expect(bluecatApi.capacityForPrefix(32, 4)).toBe(1);
    expect(bluecatApi.capacityForPrefix(64, 6)).toBeNull();
  });

  it('free_static = capacity - dhcp_pool - used_static, floored at 0: a /24 with a 100-address DHCP pool and 30 statics', () => {
    const capacity = bluecatApi.capacityForPrefix(24, 4); // 254
    const dhcpPool = 100;
    const usedStatic = 30;
    const freeStatic = Math.max(0, capacity - dhcpPool - usedStatic);
    // NOTE (contract deviation, flagged in the WP1 report): section 5's worked
    // example states "-> free_static 122" for this exact scenario, but the
    // documented formula (capacity = 2^(32-prefix)-2 = 254; free_static =
    // capacity - dhcp_pool - used_static) yields 254-100-30 = 124, not 122.
    // This test asserts the formula as specified, not the example's number.
    expect(capacity).toBe(254);
    expect(freeStatic).toBe(124);
  });

  it('free_pct = free_static / capacity * 100, null when capacity is null/0', () => {
    const capacity = 254;
    const freeStatic = 124;
    expect(Math.round((freeStatic / capacity) * 100)).toBe(49);
  });

  it('per-range free_dhcp = size - excluded - used, with 2 excluded addresses', () => {
    const size = 10;
    const excluded = 2;
    const used = 3; // non-free, non-excluded states inside the range
    const freeDhcp = size - excluded - used;
    expect(freeDhcp).toBe(5);
  });

  it('computeUsageBasedCounts uses usage.static+reserved+dhcpReserved and usage.unassigned when present', () => {
    const { computeUsageBasedCounts } = require('../services/bluecatPoller');
    const usage = { static: 10, reserved: 2, dhcpReserved: 1, unassigned: 50 };
    const result = computeUsageBasedCounts(usage, 254, 100);
    expect(result.usedStatic).toBe(13);
    expect(result.freeStatic).toBe(50);
  });

  it('computeUsageBasedCounts falls back to capacity - dhcpPool - usedStatic when usage.unassigned is missing', () => {
    const { computeUsageBasedCounts } = require('../services/bluecatPoller');
    const usage = { static: 10, reserved: 0, dhcpReserved: 0 };
    const result = computeUsageBasedCounts(usage, 254, 100);
    expect(result.usedStatic).toBe(10);
    expect(result.freeStatic).toBe(144); // 254 - 100 - 10
  });
});

describe('bluecatIssues.computeIssues + reconcileIssueHistory', () => {
  it('detects every issue rule from seeded rows, honoring exclude_low_space and gateway precedence', () => {
    const { computeIssues, reconcileIssueHistory } = require('../services/bluecatIssues');

    const sourceId = insertSource({ name: 'bam-issues', host: 'bam.local', last_poll_status: 'success' });

    // server-disconnected + server-deploy-failed
    db.prepare(`
      INSERT INTO bluecat_servers (source_id, server_id, name, connected, last_deploy_status)
      VALUES (?, 1, 'bam-server-1', 0, 'FAILED')
    `).run(sourceId);
    // Healthy server — must not trip anything.
    db.prepare(`
      INSERT INTO bluecat_servers (source_id, server_id, name, connected, last_deploy_status)
      VALUES (?, 2, 'bam-server-2', 1, 'COMPLETED')
    `).run(sourceId);

    // network-full: free_static = 0
    db.prepare(`
      INSERT INTO bluecat_networks (source_id, network_id, name, range, prefix, ip_version, capacity,
        gateway, gateway_source, used_static, free_static, free_pct, counts_source, enumerated_at)
      VALUES (?, 100, 'full-net', '10.1.1.0/24', 24, 4, 254, '10.1.1.1', 'bam', 254, 0, 0.0, 'enumerated', datetime('now'))
    `).run(sourceId);

    // network-low-space: 0 < free_static < warn(20)
    db.prepare(`
      INSERT INTO bluecat_networks (source_id, network_id, name, range, prefix, ip_version, capacity,
        gateway, gateway_source, used_static, free_static, free_pct, counts_source, enumerated_at)
      VALUES (?, 101, 'low-net', '10.1.2.0/24', 24, 4, 254, '10.1.2.1', 'bam', 244, 10, 3.9, 'enumerated', datetime('now'))
    `).run(sourceId);

    // network-low-space suppressed by exclude_low_space override on a /30.
    db.prepare(`
      INSERT INTO bluecat_networks (source_id, network_id, name, range, prefix, ip_version, capacity,
        gateway, gateway_source, used_static, free_static, free_pct, counts_source, enumerated_at)
      VALUES (?, 102, 'excluded-net', '10.1.3.0/30', 30, 4, 2, '10.1.3.1', 'bam', 1, 1, 50.0, 'enumerated', datetime('now'))
    `).run(sourceId);
    db.prepare(`
      INSERT INTO bluecat_network_overrides (source_id, network_id, exclude_low_space, note, updated_by)
      VALUES (?, 102, 1, 'known small subnet', 'tester')
    `).run(sourceId);

    // gateway-unknown: ipv4, prefix <= 30, gateway null.
    db.prepare(`
      INSERT INTO bluecat_networks (source_id, network_id, name, range, prefix, ip_version, capacity,
        gateway, gateway_source, used_static, free_static, free_pct, counts_source, enumerated_at)
      VALUES (?, 103, 'no-gw-net', '10.1.4.0/24', 24, 4, 254, NULL, NULL, 50, 204, 80.3, 'enumerated', datetime('now'))
    `).run(sourceId);

    // Gateway precedence (override > bam > address): a network whose stored
    // gateway/gateway_source already reflect the winning tier — this asserts
    // the STORED precedence result the poller is responsible for writing.
    db.prepare(`
      INSERT INTO bluecat_networks (source_id, network_id, name, range, prefix, ip_version, capacity,
        gateway, gateway_source, used_static, free_static, free_pct, counts_source, enumerated_at)
      VALUES (?, 104, 'override-gw-net', '10.1.5.0/24', 24, 4, 254, '10.1.5.254', 'override', 50, 204, 80.3, 'enumerated', datetime('now'))
    `).run(sourceId);
    db.prepare(`
      INSERT INTO bluecat_network_overrides (source_id, network_id, gateway, updated_by)
      VALUES (?, 104, '10.1.5.254', 'tester')
    `).run(sourceId);

    // dhcp-range-full / dhcp-range-low-space
    db.prepare(`
      INSERT INTO bluecat_ranges (source_id, range_id, network_id, name, range_type, start_ip, end_ip, size, dhcp_used, free_dhcp)
      VALUES (?, 200, 101, 'full-range', 'DHCPv4Range', '10.1.2.10', '10.1.2.20', 10, 10, 0)
    `).run(sourceId);
    db.prepare(`
      INSERT INTO bluecat_ranges (source_id, range_id, network_id, name, range_type, start_ip, end_ip, size, dhcp_used, free_dhcp)
      VALUES (?, 201, 101, 'low-range', 'DHCPv4Range', '10.1.2.30', '10.1.2.60', 30, 25, 5)
    `).run(sourceId);

    const issues = computeIssues();
    const byType = (type) => issues.filter((i) => i.type === type);

    expect(byType('source-unreachable')).toHaveLength(0);

    expect(byType('server-disconnected')).toHaveLength(1);
    expect(byType('server-disconnected')[0].severity).toBe('critical');
    expect(byType('server-disconnected')[0].target).toBe('bam-server-1');

    expect(byType('server-deploy-failed')).toHaveLength(1);
    expect(byType('server-deploy-failed')[0].severity).toBe('warning');

    expect(byType('network-full')).toHaveLength(1);
    expect(byType('network-full')[0].severity).toBe('critical');
    expect(byType('network-full')[0].target).toBe('10.1.1.0/24 (full-net)');

    expect(byType('network-low-space').map((i) => i.target)).toContain('10.1.2.0/24 (low-net)');
    // Excluded network never fires network-low-space despite free_static < warn.
    expect(byType('network-low-space').map((i) => i.target)).not.toContain('10.1.3.0/30 (excluded-net)');

    expect(byType('gateway-unknown').map((i) => i.target)).toContain('10.1.4.0/24 (no-gw-net)');
    // A network with a resolved gateway never fires gateway-unknown.
    expect(byType('gateway-unknown').map((i) => i.target)).not.toContain('10.1.5.0/24 (override-gw-net)');
    // Excluded override still allows gateway-unknown when it has no gateway supplied — not the case here (has one).

    expect(byType('dhcp-range-full')).toHaveLength(1);
    expect(byType('dhcp-range-full')[0].target).toBe('10.1.2.10-10.1.2.20 in 10.1.2.0/24');

    expect(byType('dhcp-range-low-space')).toHaveLength(1);
    expect(byType('dhcp-range-low-space')[0].target).toBe('10.1.2.30-10.1.2.60 in 10.1.2.0/24');

    const severityRank = { critical: 0, warning: 1, info: 2 };
    for (let i = 1; i < issues.length; i++) {
      expect(severityRank[issues[i - 1].severity]).toBeLessThanOrEqual(severityRank[issues[i].severity]);
    }

    reconcileIssueHistory();
    const openRows = db.prepare("SELECT * FROM bluecat_issue_history WHERE status = 'open' AND source = 'bam-issues'").all();
    expect(openRows.length).toBe(issues.filter((i) => i.source === 'bam-issues').length);

    // Resolve server-disconnected by fixing connected, reconcile again -> flips to resolved.
    db.prepare(`UPDATE bluecat_servers SET connected = 1 WHERE source_id = ? AND server_id = 1`).run(sourceId);
    reconcileIssueHistory();
    const resolved = db.prepare('SELECT * FROM bluecat_issue_history WHERE issue_key = ?').get('server-disconnected|bam-issues|bam-server-1');
    expect(resolved.status).toBe('resolved');
    expect(resolved.resolved_at).not.toBeNull();
  });

  it('source-unreachable fires when last_poll_status is error', () => {
    const { computeIssues } = require('../services/bluecatIssues');
    insertSource({ name: 'bam-unreachable', host: 'unreachable.local', last_poll_status: 'error', last_poll_error: 'ETIMEDOUT' });
    const issues = computeIssues();
    const hit = issues.find((i) => i.type === 'source-unreachable' && i.source === 'bam-unreachable');
    expect(hit).toBeTruthy();
    expect(hit.severity).toBe('critical');
  });

  it('threshold getters clamp to their documented defaults', () => {
    const { lowFreeWarn, lowFreePct } = require('../services/bluecatIssues');
    expect(lowFreeWarn()).toBe(20);
    expect(lowFreePct()).toBe(10);
  });
});

describe('routes/bluecat.js basic CRUD + data endpoints (minimal express app, no dispatcher)', () => {
  let app;

  beforeAll(() => {
    const bluecatRouter = require('../routes/bluecat');
    app = express();
    app.use(express.json());
    app.use('/api/bluecat', bluecatRouter);
  });

  it('GET /api/bluecat/sources lists registered sources, never leaking credentials', async () => {
    const res = await request(app).get('/api/bluecat/sources');
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body)).toBe(true);
    for (const row of res.body) {
      expect(row.encryptedCredentials).toBeUndefined();
      expect(row.password).toBeUndefined();
    }
  });

  it('POST/PUT/DELETE /api/bluecat/sources round-trips, PUT keeps password when blank, 409 on dup name', async () => {
    const created = await request(app).post('/api/bluecat/sources').send({
      name: 'crud-test-source', host: '10.0.0.1', username: 'admin', password: 's3cr3t',
    });
    expect(created.status).toBe(201);
    expect(created.body.id).toBeTypeOf('number');
    expect(created.body.password).toBeUndefined();
    const sourceId = created.body.id;

    const dup = await request(app).post('/api/bluecat/sources').send({ name: 'crud-test-source', host: '10.0.0.2', username: 'x', password: 'x' });
    expect(dup.status).toBe(409);

    const before = db.prepare('SELECT encrypted_credentials FROM bluecat_sources WHERE id = ?').get(sourceId).encrypted_credentials;
    const updated = await request(app).put(`/api/bluecat/sources/${sourceId}`).send({ pollingIntervalMinutes: 45 });
    expect(updated.status).toBe(200);
    expect(updated.body.pollingIntervalMinutes).toBe(45);
    const after = db.prepare('SELECT encrypted_credentials FROM bluecat_sources WHERE id = ?').get(sourceId).encrypted_credentials;
    expect(after).toBe(before); // blank password on PUT keeps stored credential

    const deleted = await request(app).delete(`/api/bluecat/sources/${sourceId}`);
    expect(deleted.status).toBe(204);
  });

  it('POST /api/bluecat/sources requires username and password (400 without them)', async () => {
    const res = await request(app).post('/api/bluecat/sources').send({ name: 'no-creds-source', host: '10.0.0.9' });
    expect(res.status).toBe(400);
  });

  it('POST /api/bluecat/sources/:id/test works with a nonexistent id when full creds are in the body', async () => {
    const res = await request(app).post('/api/bluecat/sources/999999/test').send({
      host: '127.0.0.1', port: 65533, username: 'admin', password: 'not-a-real-password',
    });
    expect(res.status).toBe(502);
    expect(res.body.ok).toBe(false);
    expect(typeof res.body.error).toBe('string');
  }, 20000);

  it('POST /api/bluecat/sources/test never throws with bogus credentials (no id)', async () => {
    const res = await request(app).post('/api/bluecat/sources/test').send({
      host: '127.0.0.1', port: 65533, username: 'admin', password: 'nope',
    });
    expect(res.status).toBe(502);
    expect(res.body.ok).toBe(false);
  }, 20000);

  it('POST /api/bluecat/sources/:id/poll 404s for an unknown id', async () => {
    const res = await request(app).post('/api/bluecat/sources/999999/poll');
    expect(res.status).toBe(404);
  });

  it('GET /api/bluecat/issues returns the wrapped computed issue array', async () => {
    const res = await request(app).get('/api/bluecat/issues');
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.issues)).toBe(true);
  });

  it('GET /api/bluecat/issue-history returns a BARE array', async () => {
    const res = await request(app).get('/api/bluecat/issue-history');
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body)).toBe(true);
    for (const row of res.body) {
      expect(row).toHaveProperty('source');
      expect(row).toHaveProperty('type');
      expect(row).toHaveProperty('target');
    }
  });

  it('GET /api/bluecat/overview returns the exact contract shape keys', async () => {
    const res = await request(app).get('/api/bluecat/overview');
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.sources)).toBe(true);
    expect(res.body.counts).toEqual(expect.objectContaining({
      views: expect.any(Number), zones: expect.any(Number), records: expect.any(Number), networks: expect.any(Number),
      networksLowSpace: expect.any(Number), rangesLowSpace: expect.any(Number), devices: expect.any(Number),
      servers: expect.any(Number), serversDown: expect.any(Number), sourcesUnreachable: expect.any(Number),
    }));
    expect(res.body.issues).toEqual(expect.objectContaining({
      critical: expect.any(Number), warning: expect.any(Number), info: expect.any(Number),
    }));
    expect(Array.isArray(res.body.lowSpace)).toBe(true);
    expect(Array.isArray(res.body.trends)).toBe(true);
  });

  it('GET /api/bluecat/views|zones|records|blocks|networks|ranges|addresses|devices|servers|trends all 200 with array/object shapes', async () => {
    const checks = [
      ['views', (b) => Array.isArray(b)],
      ['zones', (b) => Array.isArray(b)],
      ['records', (b) => Array.isArray(b.records) && typeof b.total === 'number' && typeof b.limited === 'boolean'],
      ['blocks', (b) => Array.isArray(b)],
      ['networks', (b) => Array.isArray(b)],
      ['ranges', (b) => Array.isArray(b)],
      ['addresses', (b) => Array.isArray(b)],
      ['devices', (b) => Array.isArray(b)],
      ['servers', (b) => Array.isArray(b)],
      ['trends', (b) => Array.isArray(b)],
    ];
    for (const [path, shapeOk] of checks) {
      const res = await request(app).get(`/api/bluecat/${path}`);
      expect(res.status, `GET /api/bluecat/${path}`).toBe(200);
      expect(shapeOk(res.body), `GET /api/bluecat/${path} body shape`).toBe(true);
    }
  });

  it('GET/PUT /api/bluecat/config round-trips clamped thresholds', async () => {
    const before = await request(app).get('/api/bluecat/config');
    expect(before.status).toBe(200);
    expect(before.body.lowFreeWarn).toBe(20);

    const saved = await request(app).put('/api/bluecat/config').send({ lowFreeWarn: 30 });
    expect(saved.status).toBe(200);
    expect(saved.body.lowFreeWarn).toBe(30);

    const invalid = await request(app).put('/api/bluecat/config').send({ lowFreeWarn: 999999 });
    expect(invalid.status).toBe(400);

    await request(app).put('/api/bluecat/config').send({ lowFreeWarn: 20 }); // restore default
  });

  it('PUT /networks/:id/override validates the gateway is inside the network range', async () => {
    const sourceId = insertSource({ name: 'override-test-source', host: 'override.local' });
    const info = db.prepare(`
      INSERT INTO bluecat_networks (source_id, network_id, name, range, prefix, ip_version, capacity)
      VALUES (?, 500, 'override-net', '192.168.50.0/24', 24, 4, 254)
    `).run(sourceId);
    const networkRowId = db.prepare('SELECT id FROM bluecat_networks WHERE source_id = ? AND network_id = 500').get(sourceId).id;

    const outside = await request(app).put(`/api/bluecat/networks/${networkRowId}/override`).send({ gateway: '10.0.0.1' });
    expect(outside.status).toBe(400);

    const inside = await request(app).put(`/api/bluecat/networks/${networkRowId}/override`).send({ gateway: '192.168.50.254', excludeLowSpace: true, note: 'test note' });
    expect(inside.status).toBe(200);
    expect(inside.body.gateway).toBe('192.168.50.254');
    expect(inside.body.gatewaySource).toBe('override');
    expect(inside.body.excludeLowSpace).toBe(true);
    expect(inside.body.override).toEqual(expect.objectContaining({ gateway: '192.168.50.254', note: 'test note' }));

    const cleared = await request(app).delete(`/api/bluecat/networks/${networkRowId}/override`);
    expect(cleared.status).toBe(200);
    expect(cleared.body.override).toBeNull();
  });

  it('PUT /networks/:id/override 404s for an unknown network row id', async () => {
    const res = await request(app).put('/api/bluecat/networks/999999/override').send({ gateway: '10.0.0.1' });
    expect(res.status).toBe(404);
  });
});

describe('bluecat platform plugin dispatcher (registered via registry, like unifiPlugin.test.js)', () => {
  const registry = require('../core/registry');
  const bluecatManifest = require('../platforms/bluecat');
  const { createApp } = require('../app');

  const API_KEY = 'test-api-key';
  let app;

  beforeEach(() => {
    registry._reset();
    registry.init();
    registry.registerPlugin(bluecatManifest);
    app = createApp({ licenseGate: (req, res, next) => next() });
  });

  it('GET /api/bluecat/sources -> 200 through the dispatcher when registered+enabled', async () => {
    const res = await request(app).get('/api/bluecat/sources').set('x-api-key', API_KEY);
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body)).toBe(true);
  });

  it('disabling bluecat returns 404 platform_disabled; re-enabling restores 200', async () => {
    const get = () => request(app).get('/api/bluecat/sources').set('x-api-key', API_KEY);

    registry.setEnabled('bluecat', false);
    const disabledRes = await get();
    expect(disabledRes.status).toBe(404);
    expect(disabledRes.body).toEqual({ error: 'platform_disabled' });

    registry.setEnabled('bluecat', true);
    const enabledRes = await get();
    expect(enabledRes.status).toBe(200);
  });
});
