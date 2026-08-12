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
  // Optional modules default OFF in shipping settings; these tests exercise
  // the fully-enabled surface, so switch them on like an operator would.
  const { setSetting } = require('../services/settings');
  for (const k of ['unifi_feature_protect', 'unifi_feature_wifi', 'unifi_feature_security']) {
    setSetting(k, '1');
  }
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
      ['wifi', (b) => Array.isArray(b.wlans) && Array.isArray(b.radios) && Array.isArray(b.rogues) && typeof b.signalBuckets === 'object'
        && Array.isArray(b.roaming) && typeof b.history === 'object' && Array.isArray(b.history.site) && Array.isArray(b.history.aps)],
      ['security', (b) => typeof b.ips === 'object' && typeof b.rogueCounts === 'object' && Array.isArray(b.events)
        && Array.isArray(b.posture) && typeof b.rules === 'object' && Array.isArray(b.rules.firewall) && Array.isArray(b.rules.traffic)
        && Array.isArray(b.timeline) && Array.isArray(b.topDestinations) && Array.isArray(b.topOffenders)
        && Array.isArray(b.policyHits) && typeof b.rogueChanges === 'object' && Array.isArray(b.rogueChanges.flagged)],
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
  }, 20000); // /wifi live-fetches hourly reports for any success-status source (DNS-fail tolerant, but not instant)

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

describe('WiFi/Security round (migration v5): posture, rules, roaming, timeline, rogueChanges', () => {
  let app;

  beforeAll(() => {
    const unifiRouter = require('../routes/unifi');
    app = express();
    app.use(express.json());
    app.use('/api/unifi', unifiRouter);
  });

  it('GET /api/unifi/wifi parses WLAN posture, computes radio interference, and builds the roaming table from CLIENT events', async () => {
    const sourceId = insertSource({ name: 'wifisec-source', host: 'wifisec.local' });

    db.prepare(`
      INSERT INTO unifi_wlans (source_id, wlan_id, name, enabled, security, wpa_mode, is_guest, hide_ssid, posture_json)
      VALUES (?, 'wlan-1', 'IoT', 1, 'wpapsk', 'wpa2', 0, 0, ?)
    `).run(sourceId, JSON.stringify({ wpa_mode: 'wpa2', wpa3_support: 0, pmf_mode: 'optional' }));

    db.prepare(`
      INSERT INTO unifi_devices (source_id, site, mac, name, model, type, state, radios_json)
      VALUES (?, 'default', 'dd:dd:dd:00:00:01', 'ap-1', 'UAL6', 'uap', 1, ?)
    `).run(sourceId, JSON.stringify([{ name: 'wifi1', radio: 'ng', channel: 6, cu_total: 55, tx_retries_pct: 22.5, cu_self_rx: 10, cu_self_tx: 5 }]));

    db.prepare(`
      INSERT INTO unifi_clients (source_id, site, mac, name, is_wired, signal)
      VALUES (?, 'default', 'ee:ee:ee:00:00:01', 'roam-laptop', 0, -74)
    `).run(sourceId);

    const roamTime = new Date(Date.now() - 60 * 60 * 1000).toISOString();
    db.prepare(`
      INSERT INTO unifi_events (source_id, event_id, category, event_key, event_type, message, raw_json, occurred_at)
      VALUES (?, 'evt-roam-test-1', 'CLIENT', 'EVT_WC_Disconnected', 'EVT_WC_Disconnected', 'disconnected', ?, ?)
    `).run(sourceId, JSON.stringify({ parameters: { CLIENT: { mac: 'ee:ee:ee:00:00:01', name: 'roam-laptop' } } }), roamTime);

    const res = await request(app).get('/api/unifi/wifi');
    expect(res.status).toBe(200);

    const wlan = res.body.wlans.find((w) => w.wlan_id === 'wlan-1');
    expect(wlan.posture).toEqual(expect.objectContaining({ wpa_mode: 'wpa2', wpa3_support: 0, pmf_mode: 'optional' }));

    const radio = res.body.radios.find((r) => r.deviceMac === 'dd:dd:dd:00:00:01');
    expect(radio.txRetriesPct).toBe(22.5);
    expect(radio.selfPct).toBe(15);
    expect(radio.interferencePct).toBe(40); // max(0, 55 - 15)

    const roamEntry = res.body.roaming.find((r) => r.mac === 'ee:ee:ee:00:00:01');
    expect(roamEntry).toBeTruthy();
    expect(roamEntry.disconnects24h).toBe(1);
    expect(roamEntry.roams24h).toBe(0);
    expect(roamEntry.signal).toBe(-74);
    expect(roamEntry.sticky).toBe(true); // signal <= -70 AND roams24h === 0
  }, 20000);

  it('GET /api/unifi/security surfaces posture, rules, timeline, top lists, and rogueChanges from seeded rows', async () => {
    const sourceId = insertSource({
      name: 'wifisec-security-source', host: 'wifisec-sec.local',
      health_json: JSON.stringify({ ips: { mode: 'ips', honeypotEnabled: true, dnsFiltering: true, adBlocking: false, contentFiltering: true, enabledNetworks: ['Default', 'IoT'] } }),
    });

    db.prepare(`
      INSERT INTO unifi_firewall_rules (source_id, rule_id, kind, ruleset, rule_index, name, action, enabled, protocol, src, dst, logging, raw_json)
      VALUES (?, 'fw-1', 'firewall', 'WAN_IN', 2000, 'NAS Germany', 'drop', 1, 'all', '85.214.0.0/16', 'any', 1, '{}')
    `).run(sourceId);
    db.prepare(`
      INSERT INTO unifi_firewall_rules (source_id, rule_id, kind, ruleset, rule_index, name, action, enabled, protocol, src, dst, logging, raw_json)
      VALUES (?, 'tr-1', 'traffic', NULL, NULL, 'Block ads', 'BLOCK', 1, NULL, 'Default', NULL, NULL, '{}')
    `).run(sourceId);

    const eventTime = new Date(Date.now() - 30 * 60 * 1000).toISOString();
    db.prepare(`
      INSERT INTO unifi_events (source_id, event_id, category, event_key, event_type, message, raw_json, occurred_at)
      VALUES (?, 'evt-sec-test-1', 'SECURITY', 'BLOCKED_BY_FIREWALL', 'BLOCKED_BY_FIREWALL', 'blocked', ?, ?)
    `).run(sourceId, JSON.stringify({
      parameters: { SRC_CLIENT: { ip: '192.168.1.55', name: 'offender-laptop' }, DST_IP: { ip: '85.214.1.1' }, TRIGGER: { name: 'NAS Germany' } },
    }), eventTime);

    db.prepare(`
      INSERT INTO unifi_rogue_aps (source_id, bssid, essid, is_rogue, signal, first_seen_at)
      VALUES (?, 'ff:ff:ff:00:00:01', 'evil-twin-test', 1, -40, datetime('now', '-2 days'))
    `).run(sourceId);

    const res = await request(app).get('/api/unifi/security');
    expect(res.status).toBe(200);

    const posture = res.body.posture.find((p) => p.sourceId === sourceId);
    expect(posture).toEqual(expect.objectContaining({
      mode: 'ips', honeypotEnabled: true, dnsFiltering: true, adBlocking: false, contentFiltering: true, enabledNetworksCount: 2,
    }));

    expect(res.body.rules.firewall.some((r) => r.name === 'NAS Germany' && r.source_id === sourceId)).toBe(true);
    expect(res.body.rules.traffic.some((r) => r.name === 'Block ads' && r.source_id === sourceId)).toBe(true);

    expect(res.body.timeline.length).toBeGreaterThan(0);
    expect(res.body.timeline.some((t) => t.blocks >= 1)).toBe(true);

    expect(res.body.topDestinations.some((d) => d.dst === '85.214.1.1')).toBe(true);
    expect(res.body.policyHits.some((p) => p.policy === 'NAS Germany')).toBe(true);

    const flaggedEntry = res.body.rogueChanges.flagged.find((r) => r.bssid === 'ff:ff:ff:00:00:01');
    expect(flaggedEntry).toBeTruthy();
    expect(res.body.rogueChanges.newThisWeek).toBeGreaterThanOrEqual(0);
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
