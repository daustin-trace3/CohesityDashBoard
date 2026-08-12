/**
 * Self-contained UniFi platform backend test (WP1). Runs the unifi migration
 * into the shared per-file test DB, exercises unifiIssues compute/reconcile
 * against seeded rows for every rule, a minimal express app wired to
 * routes/unifi.js, and the plugin dispatcher end-to-end (mirrors
 * tests/awsPlugin.test.js / tests/platformPlugins.test.js).
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
const unifiMigrations = require('../db/migrations/unifi');
const { encrypt } = require('../services/encryption');

beforeAll(() => {
  runMigrations(db, 'unifi', unifiMigrations);
});

function insertSource(overrides = {}) {
  const info = db.prepare(`
    INSERT INTO unifi_sources (name, host, port, encrypted_credentials, ssl_verify, polling_interval_minutes,
      last_poll_status, last_poll_error, health_json)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    overrides.name ?? 'unifi1',
    overrides.host ?? '192.168.1.1',
    overrides.port ?? 443,
    overrides.encrypted_credentials !== undefined ? overrides.encrypted_credentials : encrypt(JSON.stringify({ apiKey: 'shh' })),
    overrides.ssl_verify ?? 0,
    overrides.polling_interval_minutes ?? 10,
    overrides.last_poll_status ?? null,
    overrides.last_poll_error ?? null,
    overrides.health_json ?? null,
  );
  return info.lastInsertRowid;
}

describe('unifiIssues.computeIssues + reconcileIssueHistory', () => {
  it('detects every issue rule from seeded rows', () => {
    const { computeIssues, reconcileIssueHistory } = require('../services/unifiIssues');

    const sourceId = insertSource({
      name: 'unifi-issues', host: 'udm.local', last_poll_status: 'success',
      health_json: JSON.stringify({ subsystems: [], ips: { enabled: false, categories: [], adBlocking: false, raw: null } }),
    });

    // device-offline (state != 1) + device-load (cpu/mem) + device-overheating (temp)
    db.prepare(`
      INSERT INTO unifi_devices (source_id, site, mac, name, model, type, state, cpu_pct, mem_pct, temps_json, upgradable, overheating)
      VALUES (?, 'default', 'aa:bb:cc:00:00:01', 'gw-1', 'UDMPROMAX', 'udm', 0, 95, 96, '[{"name":"CPU","type":"cpu","value":85}]', 1, 1)
    `).run(sourceId);
    // Healthy device — must not trip anything.
    db.prepare(`
      INSERT INTO unifi_devices (source_id, site, mac, name, model, type, state, cpu_pct, mem_pct, upgradable, overheating)
      VALUES (?, 'default', 'aa:bb:cc:00:00:02', 'sw-1', 'USL16LP', 'usw', 1, 20, 30, 0, 0)
    `).run(sourceId);

    // poe-fault
    db.prepare(`
      INSERT INTO unifi_ports (source_id, device_mac, port_idx, poe_enable, poe_good, up)
      VALUES (?, 'aa:bb:cc:00:00:02', 1, 1, 0, 1)
    `).run(sourceId);
    // Healthy PoE port — must not trip.
    db.prepare(`
      INSERT INTO unifi_ports (source_id, device_mac, port_idx, poe_enable, poe_good, up)
      VALUES (?, 'aa:bb:cc:00:00:02', 2, 1, 1, 1)
    `).run(sourceId);
    // port-errors: crafted port_history with a rising error delta in the last 24h.
    db.prepare(`
      INSERT INTO unifi_ports (source_id, device_mac, port_idx, up)
      VALUES (?, 'aa:bb:cc:00:00:02', 3, 1)
    `).run(sourceId);
    db.prepare(`
      INSERT INTO unifi_port_history (source_id, device_mac, port_idx, captured_at, up, rx_errors, tx_errors)
      VALUES (?, 'aa:bb:cc:00:00:02', 3, datetime('now', '-23 hours'), 1, 0, 0)
    `).run(sourceId);
    db.prepare(`
      INSERT INTO unifi_port_history (source_id, device_mac, port_idx, captured_at, up, rx_errors, tx_errors)
      VALUES (?, 'aa:bb:cc:00:00:02', 3, datetime('now', '-1 hours'), 1, 400, 300)
    `).run(sourceId);
    // port-flapping: >=3 up transitions in the trailing 24h.
    db.prepare(`
      INSERT INTO unifi_ports (source_id, device_mac, port_idx, up)
      VALUES (?, 'aa:bb:cc:00:00:02', 4, 1)
    `).run(sourceId);
    const flapTimes = ['-20 hours', '-16 hours', '-12 hours', '-8 hours', '-4 hours'];
    const flapStates = [1, 0, 1, 0, 1];
    flapTimes.forEach((t, i) => {
      db.prepare(`
        INSERT INTO unifi_port_history (source_id, device_mac, port_idx, captured_at, up)
        VALUES (?, 'aa:bb:cc:00:00:02', 4, datetime('now', ?), ?)
      `).run(sourceId, t, flapStates[i]);
    });

    // wan-latency + wan-availability
    db.prepare(`
      INSERT INTO unifi_wan (source_id, wan_name, isp_name, latency_ms, availability_pct)
      VALUES (?, 'WAN', 'Test ISP', 200, 90)
    `).run(sourceId);

    // rogue-ap
    db.prepare(`
      INSERT INTO unifi_rogue_aps (source_id, bssid, essid, is_rogue, signal)
      VALUES (?, 'de:ad:be:ef:00:01', 'evil-twin', 1, -40)
    `).run(sourceId);

    // wifi-experience: >=3 wireless clients with poor satisfaction on the same site.
    for (let i = 0; i < 3; i++) {
      db.prepare(`
        INSERT INTO unifi_clients (source_id, site, mac, name, is_wired, satisfaction)
        VALUES (?, 'default', ?, ?, 0, 20)
      `).run(sourceId, `cc:cc:cc:00:00:0${i}`, `laptop-${i}`);
    }

    const issues = computeIssues();
    const byType = (type) => issues.filter((i) => i.type === type);

    expect(byType('device-offline')).toHaveLength(1);
    expect(byType('device-offline')[0].severity).toBe('critical');
    expect(byType('device-offline')[0].target).toBe('gw-1');

    expect(byType('device-load')).toHaveLength(1);
    expect(byType('device-load')[0].severity).toBe('warning');

    expect(byType('device-overheating')).toHaveLength(1);
    expect(byType('device-overheating')[0].severity).toBe('warning');

    expect(byType('firmware-upgrade')).toHaveLength(1);
    expect(byType('firmware-upgrade')[0].severity).toBe('info');

    expect(byType('poe-fault')).toHaveLength(1);
    expect(byType('poe-fault')[0].severity).toBe('critical');
    expect(byType('poe-fault')[0].target).toBe('sw-1 port 1');

    expect(byType('port-errors').length).toBeGreaterThanOrEqual(1);
    expect(byType('port-errors')[0].severity).toBe('warning');
    expect(byType('port-errors')[0].target).toBe('sw-1 port 3');

    expect(byType('port-flapping').length).toBeGreaterThanOrEqual(1);
    expect(byType('port-flapping')[0].severity).toBe('warning');
    expect(byType('port-flapping')[0].target).toBe('sw-1 port 4');

    expect(byType('wan-latency')).toHaveLength(1);
    expect(byType('wan-availability')).toHaveLength(1);

    expect(byType('rogue-ap')).toHaveLength(1);
    expect(byType('rogue-ap')[0].target).toBe('evil-twin');

    expect(byType('ips-disabled')).toHaveLength(1);
    expect(byType('ips-disabled')[0].severity).toBe('info');

    expect(byType('wifi-experience')).toHaveLength(1);
    expect(byType('wifi-experience')[0].severity).toBe('info');

    // severity ordering: critical < warning < info
    const severityRank = { critical: 0, warning: 1, info: 2 };
    for (let i = 1; i < issues.length; i++) {
      expect(severityRank[issues[i - 1].severity]).toBeLessThanOrEqual(severityRank[issues[i].severity]);
    }

    reconcileIssueHistory();
    const openRows = db.prepare("SELECT * FROM unifi_issue_history WHERE status = 'open' AND source = 'unifi-issues'").all();
    expect(openRows.length).toBe(issues.filter((i) => i.source === 'unifi-issues').length);

    // Resolve the poe-fault by fixing poe_good, reconcile again -> flips to resolved.
    db.prepare(`UPDATE unifi_ports SET poe_good = 1 WHERE source_id = ? AND port_idx = 1`).run(sourceId);
    reconcileIssueHistory();
    const resolved = db.prepare(
      "SELECT * FROM unifi_issue_history WHERE issue_key = ?"
    ).get(`poe-fault|unifi-issues|sw-1 port 1`);
    expect(resolved.status).toBe('resolved');
    expect(resolved.resolved_at).not.toBeNull();
  });

  it('source-unreachable fires when last_poll_status is error', () => {
    const { computeIssues } = require('../services/unifiIssues');
    insertSource({ name: 'unifi-unreachable', host: 'unreachable.local', last_poll_status: 'error', last_poll_error: 'ETIMEDOUT' });
    const issues = computeIssues();
    const hit = issues.find((i) => i.type === 'source-unreachable' && i.source === 'unifi-unreachable');
    expect(hit).toBeTruthy();
    expect(hit.severity).toBe('critical');
    expect(hit.target).toBe('unreachable.local');
  });

  it('threshold getters clamp to their documented defaults', () => {
    const {
      wanLatencyWarnMs, wanAvailWarnPct, portErrDeltaWarn, portFlapWarn,
      deviceCpuWarnPct, deviceMemWarnPct, tempWarnC, satisfactionWarn,
    } = require('../services/unifiIssues');
    expect(wanLatencyWarnMs()).toBe(75);
    expect(wanAvailWarnPct()).toBe(99);
    expect(portErrDeltaWarn()).toBe(500);
    expect(portFlapWarn()).toBe(3);
    expect(deviceCpuWarnPct()).toBe(90);
    expect(deviceMemWarnPct()).toBe(92);
    expect(tempWarnC()).toBe(80);
    expect(satisfactionWarn()).toBe(50);
  });
});

describe('routes/unifi.js basic CRUD + data endpoints (minimal express app, no dispatcher)', () => {
  let app;

  beforeAll(() => {
    const unifiRouter = require('../routes/unifi');
    app = express();
    app.use(express.json());
    app.use('/api/unifi', unifiRouter);
  });

  it('GET /api/unifi/sources lists registered sources, never leaking encrypted_credentials', async () => {
    const res = await request(app).get('/api/unifi/sources');
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body)).toBe(true);
    for (const row of res.body) {
      expect(row.encryptedCredentials).toBeUndefined();
      expect(row.apiKey).toBeUndefined();
    }
  });

  it('POST/PUT/DELETE /api/unifi/sources round-trips, PUT keeps apiKey when blank, 409 on dup name', async () => {
    const created = await request(app).post('/api/unifi/sources').send({
      name: 'crud-test-source', host: '10.0.0.1', apiKey: 's3cr3t-key',
    });
    expect(created.status).toBe(201);
    expect(created.body.id).toBeTypeOf('number');
    expect(created.body.apiKey).toBeUndefined();
    const sourceId = created.body.id;

    const dup = await request(app).post('/api/unifi/sources').send({ name: 'crud-test-source', host: '10.0.0.2', apiKey: 'x' });
    expect(dup.status).toBe(409);

    const before = db.prepare('SELECT encrypted_credentials FROM unifi_sources WHERE id = ?').get(sourceId).encrypted_credentials;
    const updated = await request(app).put(`/api/unifi/sources/${sourceId}`).send({ pollingIntervalMinutes: 20 });
    expect(updated.status).toBe(200);
    expect(updated.body.pollingIntervalMinutes).toBe(20);
    const after = db.prepare('SELECT encrypted_credentials FROM unifi_sources WHERE id = ?').get(sourceId).encrypted_credentials;
    expect(after).toBe(before); // blank apiKey on PUT keeps stored credential

    const deleted = await request(app).delete(`/api/unifi/sources/${sourceId}`);
    expect(deleted.status).toBe(200);
    expect(deleted.body).toEqual({ ok: true });
  });

  it('POST /api/unifi/sources requires apiKey (400 without it)', async () => {
    const res = await request(app).post('/api/unifi/sources').send({ name: 'no-key-source', host: '10.0.0.9' });
    expect(res.status).toBe(400);
  });

  it('GET /api/unifi/issues returns the wrapped computed issue array', async () => {
    const res = await request(app).get('/api/unifi/issues');
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.issues)).toBe(true);
  });

  it('GET /api/unifi/issue-history returns a BARE array', async () => {
    const res = await request(app).get('/api/unifi/issue-history');
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body)).toBe(true);
    for (const row of res.body) {
      expect(row).toHaveProperty('issue_key');
      expect(row).toHaveProperty('source');
      expect(row).toHaveProperty('first_seen');
      expect(row).toHaveProperty('last_seen');
    }
  });

  it('GET /api/unifi/overview returns the exact contract shape keys', async () => {
    const res = await request(app).get('/api/unifi/overview');
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.sources)).toBe(true);
    expect(res.body.deviceCounts).toEqual(expect.objectContaining({
      total: expect.any(Number), online: expect.any(Number), offline: expect.any(Number),
      byType: expect.objectContaining({ udm: expect.any(Number), usw: expect.any(Number), uap: expect.any(Number) }),
    }));
    expect(res.body.clientCounts).toEqual(expect.objectContaining({
      total: expect.any(Number), wired: expect.any(Number), wireless: expect.any(Number), guest: expect.any(Number),
    }));
    expect(res.body.issueCounts).toEqual(expect.objectContaining({
      critical: expect.any(Number), warning: expect.any(Number), info: expect.any(Number),
    }));
    expect(Array.isArray(res.body.health)).toBe(true);
    expect(Array.isArray(res.body.spark)).toBe(true);
  });

  it('GET /api/unifi/devices|ports|clients|wifi|security|topology|wan|trends all 200 with documented shapes', async () => {
    const checks = [
      ['devices', (b) => Array.isArray(b)],
      ['ports', (b) => Array.isArray(b)],
      ['clients', (b) => Array.isArray(b)],
      ['wifi', (b) => Array.isArray(b.wlans) && Array.isArray(b.radios) && Array.isArray(b.rogues) && typeof b.signalBuckets === 'object'],
      ['security', (b) => typeof b.ips === 'object' && typeof b.rogueCounts === 'object' && Array.isArray(b.events)],
      ['topology', (b) => Array.isArray(b.vertices) && Array.isArray(b.edges) && typeof b.deviceMeta === 'object'],
      ['wan', (b) => Array.isArray(b.wans) && Array.isArray(b.history)],
      ['trends', (b) => Array.isArray(b)],
      ['events', (b) => Array.isArray(b)],
      ['protect', (b) => Array.isArray(b.cameras) && Array.isArray(b.nvrs)],
      ['insights', (b) => typeof b.poe === 'object' && typeof b.portHealth === 'object' && Array.isArray(b.wanScores)
        && typeof b.security24h === 'object' && typeof b.wifiCongestion === 'object'
        && Array.isArray(b.reboots) && Array.isArray(b.newDevices)],
    ];
    for (const [path, shapeOk] of checks) {
      const res = await request(app).get(`/api/unifi/${path}`);
      expect(res.status, `GET /api/unifi/${path}`).toBe(200);
      expect(shapeOk(res.body), `GET /api/unifi/${path} body shape`).toBe(true);
    }
  });

  it('GET /api/unifi/devices/:mac 404s for an unknown mac, 200 with facts for a known one', async () => {
    const missing = await request(app).get('/api/unifi/devices/zz:zz:zz:zz:zz:zz');
    expect(missing.status).toBe(404);

    const sourceId = insertSource({ name: 'device-detail-source', host: '10.0.1.1' });
    db.prepare(`
      INSERT INTO unifi_devices (source_id, site, mac, name, model, type, state)
      VALUES (?, 'default', 'bb:bb:bb:00:00:01', 'detail-dev', 'USW', 'usw', 1)
    `).run(sourceId);
    db.prepare(`
      INSERT INTO unifi_ports (source_id, device_mac, port_idx, up)
      VALUES (?, 'bb:bb:bb:00:00:01', 1, 1)
    `).run(sourceId);

    const found = await request(app).get('/api/unifi/devices/bb:bb:bb:00:00:01');
    expect(found.status).toBe(200);
    expect(found.body.device.name).toBe('detail-dev');
    expect(found.body.ports).toHaveLength(1);
    expect(Array.isArray(found.body.clients)).toBe(true);
  });

  it('GET /api/unifi/devices/:mac/port-history returns ascending rows', async () => {
    const sourceId = insertSource({ name: 'port-history-source', host: '10.0.2.1' });
    db.prepare(`
      INSERT INTO unifi_port_history (source_id, device_mac, port_idx, captured_at, rx_bytes)
      VALUES (?, 'cc:cc:cc:00:00:01', 5, datetime('now', '-2 hours'), 100),
             (?, 'cc:cc:cc:00:00:01', 5, datetime('now', '-1 hours'), 200)
    `).run(sourceId, sourceId);

    const res = await request(app).get('/api/unifi/devices/cc:cc:cc:00:00:01/port-history').query({ port: 5 });
    expect(res.status).toBe(200);
    expect(res.body.length).toBeGreaterThanOrEqual(2);
    expect(res.body[0].captured_at <= res.body[res.body.length - 1].captured_at).toBe(true);
  });

  it('GET/PUT /api/unifi/config round-trips clamped thresholds', async () => {
    const before = await request(app).get('/api/unifi/config');
    expect(before.status).toBe(200);
    expect(before.body.thresholds.unifiWanLatencyWarnMs).toBe(75);

    const saved = await request(app).put('/api/unifi/config').send({ unifiWanLatencyWarnMs: 100 });
    expect(saved.status).toBe(200);
    expect(saved.body.thresholds.unifiWanLatencyWarnMs).toBe(100);

    const invalid = await request(app).put('/api/unifi/config').send({ unifiWanLatencyWarnMs: 999999 });
    expect(invalid.status).toBe(400);

    await request(app).put('/api/unifi/config').send({ unifiWanLatencyWarnMs: 75 }); // restore default
  });

  it('POST /api/unifi/sources/test never throws with bogus credentials', async () => {
    // 127.0.0.1 on a port nothing listens on -> fast ECONNREFUSED instead of
    // a 30s connect-timeout hang (203.0.113.1/TEST-NET-3 blackholes silently).
    const res = await request(app).post('/api/unifi/sources/test').send({
      host: '127.0.0.1', port: 65533, apiKey: 'not-a-real-key',
    });
    expect(res.status).toBe(502);
    expect(res.body.ok).toBe(false);
    expect(typeof res.body.error).toBe('string');
  }, 20000);

  it('POST /api/unifi/sources/:id/poll 404s for an unknown id', async () => {
    const res = await request(app).post('/api/unifi/sources/999999/poll');
    expect(res.status).toBe(404);
  });
});

describe('unifi platform plugin dispatcher (registered via registry, like platformPlugins.test.js)', () => {
  const registry = require('../core/registry');
  const unifiManifest = require('../platforms/unifi');
  const { createApp } = require('../app');

  const API_KEY = 'test-api-key';
  let app;

  beforeEach(() => {
    registry._reset();
    registry.init();
    registry.registerPlugin(unifiManifest);
    app = createApp({ licenseGate: (req, res, next) => next() });
  });

  it('GET /api/unifi/sources -> 200 through the dispatcher when registered+enabled', async () => {
    const res = await request(app).get('/api/unifi/sources').set('x-api-key', API_KEY);
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body)).toBe(true);
  });

  it('disabling unifi returns 404 platform_disabled; re-enabling restores 200', async () => {
    const get = () => request(app).get('/api/unifi/sources').set('x-api-key', API_KEY);

    registry.setEnabled('unifi', false);
    const disabledRes = await get();
    expect(disabledRes.status).toBe(404);
    expect(disabledRes.body).toEqual({ error: 'platform_disabled' });

    registry.setEnabled('unifi', true);
    const enabledRes = await get();
    expect(enabledRes.status).toBe(200);
  });
});
