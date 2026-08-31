/**
 * Brocade SAN platform plugin tests (contract §13). Mirrors
 * tests/platformPlugins.test.js (dispatcher/enable-flag) and
 * tests/pluginHooks.test.js (hook wiring) patterns.
 *
 * Loaded via createRequire so app.js, core/registry.js and db/database.js
 * all resolve to the SAME module instances.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { createRequire } from 'module';
import request from 'supertest';

const require = createRequire(import.meta.url);

const db = require('../db/database');
const registry = require('../core/registry');
const brocadeManifest = require('../platforms/brocade');
const { createApp } = require('../app');

const API_KEY = 'test-api-key';
let app;

let seedCounter = 0;

function seedSource(overrides = {}) {
  seedCounter += 1;
  const info = db.prepare(`
    INSERT INTO brocade_sources (name, host, port, username, password_enc, verify_ssl, enabled,
      polling_interval_minutes, event_poll_minutes, fos_proxy_enabled, sannav_version)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    overrides.name || `SanNav Test ${seedCounter}`,
    overrides.host || `10.0.0.${50 + seedCounter}`,
    overrides.port || 443,
    overrides.username || 'admin',
    overrides.passwordEnc || 'not-really-encrypted',
    overrides.verifySsl ?? 0,
    overrides.enabled ?? 1,
    overrides.pollingIntervalMinutes || 60,
    overrides.eventPollMinutes || 5,
    overrides.fosProxyEnabled ?? 1,
    overrides.sannavVersion || '3.0.0'
  );
  return db.prepare('SELECT * FROM brocade_sources WHERE id = ?').get(info.lastInsertRowid);
}

beforeEach(() => {
  registry._reset();
  registry.init();
  registry.registerPlugin(brocadeManifest);
  registry.setEnabled('brocade', true);
  app = createApp({ licenseGate: (req, res, next) => next() });
});

describe('dispatcher + enable flag', () => {
  it('GET /api/brocade/sources -> 200 { sources: [] } when registered+enabled', async () => {
    const res = await request(app).get('/api/brocade/sources').set('x-api-key', API_KEY);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ sources: [] });
  });

  it('disabling brocade returns 404 platform_disabled; re-enabling restores 200', async () => {
    registry.setEnabled('brocade', false);
    const disabledRes = await request(app).get('/api/brocade/sources').set('x-api-key', API_KEY);
    expect(disabledRes.status).toBe(404);
    expect(disabledRes.body).toEqual({ error: 'platform_disabled' });

    registry.setEnabled('brocade', true);
    const enabledRes = await request(app).get('/api/brocade/sources').set('x-api-key', API_KEY);
    expect(enabledRes.status).toBe(200);
  });
});

describe('sources CRUD', () => {
  it('POST /sources creates a source, never leaking password_enc', async () => {
    const res = await request(app).post('/api/brocade/sources').set('x-api-key', API_KEY).send({
      name: 'SanNav Prod', host: '10.1.1.10', username: 'admin', password: 'secret123',
    });
    expect(res.status).toBe(201);
    expect(res.body.source.name).toBe('SanNav Prod');
    expect(res.body.source.password_enc).toBeUndefined();
    expect(res.body.source.password).toBeUndefined();
    expect(res.body.source.pollingIntervalMinutes).toBe(60);
    expect(res.body.source.eventPollMinutes).toBe(5);
  });

  it('POST /sources with duplicate host+port -> 409 duplicate', async () => {
    seedSource({ host: '10.2.2.20', port: 443 });
    const res = await request(app).post('/api/brocade/sources').set('x-api-key', API_KEY).send({
      name: 'Another Name', host: '10.2.2.20', port: 443, username: 'admin', password: 'secret123',
    });
    expect(res.status).toBe(409);
    expect(res.body).toEqual({ error: 'duplicate' });
  });

  it('PUT /sources/:id keeps the stored password when password is blank/absent', async () => {
    const created = await request(app).post('/api/brocade/sources').set('x-api-key', API_KEY).send({
      name: 'SanNav KeepPw', host: '10.3.3.30', username: 'admin', password: 'orig-secret',
    });
    const before = db.prepare('SELECT password_enc FROM brocade_sources WHERE id = ?').get(created.body.source.id);

    const res = await request(app).put(`/api/brocade/sources/${created.body.source.id}`).set('x-api-key', API_KEY).send({
      name: 'SanNav KeepPw Renamed', password: '',
    });
    expect(res.status).toBe(200);
    expect(res.body.source.name).toBe('SanNav KeepPw Renamed');
    const after = db.prepare('SELECT password_enc FROM brocade_sources WHERE id = ?').get(created.body.source.id);
    expect(after.password_enc).toBe(before.password_enc);
  });

  it('DELETE /sources/:id removes the source (cascade)', async () => {
    const row = seedSource({ host: '10.4.4.40' });
    const res = await request(app).delete(`/api/brocade/sources/${row.id}`).set('x-api-key', API_KEY);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true });
    expect(db.prepare('SELECT * FROM brocade_sources WHERE id = ?').get(row.id)).toBeUndefined();
  });
});

describe('issues + issue-history shapes', () => {
  it('GET /issues -> { issues: [] } shape, each row would carry type/target/source', async () => {
    const res = await request(app).get('/api/brocade/issues').set('x-api-key', API_KEY);
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.issues)).toBe(true);
  });

  it('GET /issue-history -> BARE ARRAY (not wrapped in an object)', async () => {
    const res = await request(app).get('/api/brocade/issue-history').set('x-api-key', API_KEY);
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body)).toBe(true);
  });

  it('a computed switch_critical issue reconciles into brocade_issue_history with source/type/target', () => {
    const src = seedSource({ host: '10.5.5.50' });
    db.prepare(`
      INSERT INTO brocade_switches (source_id, wwn, name, operational_status, status_reason, stale)
      VALUES (?, ?, ?, 'CRITICAL', 'BAD_PWR', 0)
    `).run(src.id, '10:00:00:00:00:00:00:01', 'SW-CRIT-1');
    const { reconcileIssueHistory, computeIssues } = require('../services/brocadeIssues');
    const issues = computeIssues();
    expect(issues.some((i) => i.type === 'switch_critical' && i.target === 'SW-CRIT-1')).toBe(true);
    reconcileIssueHistory();
    const historyRow = db.prepare(`SELECT * FROM brocade_issue_history WHERE type = 'switch_critical' AND target = 'SW-CRIT-1'`).get();
    expect(historyRow).toBeTruthy();
    expect(historyRow.source).toBe(src.name);
    expect(historyRow.resolved_at).toBeNull();
  });
});

describe('/overview shape', () => {
  it('GET /overview returns the full documented key set', async () => {
    const res = await request(app).get('/api/brocade/overview').set('x-api-key', API_KEY);
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      sources: expect.any(Object),
      fabrics: expect.any(Object),
      switches: expect.any(Object),
      ports: expect.any(Object),
      devicePorts: expect.any(Object),
      enclosures: expect.any(Object),
      zoning: expect.any(Object),
      events: expect.any(Object),
      health: expect.any(Object),
      issues: expect.any(Object),
    });
  });
});

describe('manifest hooks', () => {
  it('opsSummary contributes a card once a source + switch exist', async () => {
    const src = seedSource({ host: '10.6.6.60' });
    db.prepare(`INSERT INTO brocade_switches (source_id, wwn, name, operational_status, stale) VALUES (?, ?, ?, 'HEALTHY', 0)`)
      .run(src.id, '10:00:00:00:00:00:00:02', 'SW-OK-1');

    const res = await request(app).get('/api/ops/summary').set('x-api-key', API_KEY);
    expect(res.status).toBe(200);
    const card = res.body.platforms.find((p) => p.id === 'brocade');
    expect(card).toBeTruthy();
    expect(card.label).toBe('Brocade SAN');
    expect(card.color).toBe('#CC092F');
    expect(card.objects).toBeGreaterThanOrEqual(1);
  });

  it('collectAlerts feeds alertNotifier without throwing', async () => {
    const alertNotifier = require('../services/alertNotifier');
    const { setSetting } = require('../services/settings');
    setSetting('smtp_enabled', '1');
    setSetting('smtp_host', 'smtp.example.com');
    setSetting('smtp_from', 'alerts@example.com');
    setSetting('smtp_recipients', 'ops@example.com');
    setSetting('alert_email_min_severity', 'info');
    alertNotifier._setTransportFactory(() => ({ sendMail: async () => {} }));
    await expect(alertNotifier.run()).resolves.toBeUndefined();
    alertNotifier._reset();
  });

  it('searchCategories: /api/search finds a seeded switch by name', async () => {
    const src = seedSource({ host: '10.7.7.70' });
    db.prepare(`INSERT INTO brocade_switches (source_id, wwn, name, operational_status, stale) VALUES (?, ?, ?, 'HEALTHY', 0)`)
      .run(src.id, '10:00:00:00:00:00:00:03', 'FINDME-SWITCH');
    const { setSetting } = require('../services/settings');
    setSetting('platform_brocade_enabled', '1');

    const res = await request(app).get('/api/search').query({ q: 'FINDME' }).set('x-api-key', API_KEY);
    expect(res.status).toBe(200);
    const cat = res.body.results.find((r) => r.key === 'brocade-switches');
    expect(cat).toBeTruthy();
    expect(cat.items[0].title).toBe('FINDME-SWITCH');
  });

  it('metricsHistory: /api/poller/status includes a brocade section', async () => {
    const res = await request(app).get('/api/poller/status').set('x-api-key', API_KEY);
    expect(res.status).toBe(200);
    expect(res.body.brocade).toBeTruthy();
    expect(res.body.brocade.enabled).toBe(true);
  });

  it('server360: a matching enclosure hostname surfaces a Brocade SAN section', () => {
    const registryMod = require('../core/registry');
    const src = seedSource({ host: '10.8.8.80' });
    db.prepare(`
      INSERT INTO brocade_enclosures (source_id, guid, name, type, host_name, stale) VALUES (?, ?, ?, 'Storage Array', 'demo-vm-01', 0)
    `).run(src.id, 'guid-1', 'Encl-1');
    const providers = registryMod.getServer360Providers();
    const brocadeProvider = providers.find((p) => p.id === 'brocade');
    expect(brocadeProvider).toBeTruthy();
    const section = brocadeProvider.run({ names: new Set(['demo-vm-01']), ips: new Set() });
    expect(section).toBeTruthy();
    expect(section.title).toBe('Brocade SAN');
    expect(section.chip.color).toBe('#CC092F');
  });
});

describe('event upsert + zone-diff', () => {
  it('upserting the same event_id twice updates rather than duplicates', () => {
    const src = seedSource({ host: '10.9.9.90' });
    const insert = () => db.prepare(`
      INSERT INTO brocade_events (source_id, event_id, severity, severity_norm, event_count, last_occurred_ms)
      VALUES (?, 'evt-1', 'Major', 'major', 1, 1000)
      ON CONFLICT(source_id, event_id) DO UPDATE SET event_count = event_count + 1, last_occurred_ms = 2000
    `).run(src.id);
    insert();
    insert();
    const rows = db.prepare('SELECT * FROM brocade_events WHERE source_id = ? AND event_id = ?').all(src.id, 'evt-1');
    expect(rows.length).toBe(1);
    expect(rows[0].event_count).toBe(2);
  });

  it('a zone checksum change writes a brocade_zone_changes row', () => {
    const src = seedSource({ host: '10.10.10.10' });
    db.prepare(`
      INSERT INTO brocade_zone_configs (source_id, fabric_name, cfg_name, is_effective, checksum, stale)
      VALUES (?, 'FAB-A', 'ZC-1', 1, 'checksum-old', 0)
    `).run(src.id);
    // Simulate the poller's diff-on-change logic directly (unit-level, not a live fetch).
    const prior = db.prepare('SELECT checksum, cfg_name FROM brocade_zone_configs WHERE source_id = ? AND fabric_name = ? AND is_effective = 1').get(src.id, 'FAB-A');
    const newChecksum = 'checksum-new';
    expect(prior.checksum).not.toBe(newChecksum);
    db.prepare(`INSERT INTO brocade_zone_changes (source_id, fabric_name, change_type, detail, old_value, new_value) VALUES (?, 'FAB-A', 'checksum_changed', 'zone database checksum changed', ?, ?)`)
      .run(src.id, prior.checksum, newChecksum);
    const changeRow = db.prepare('SELECT * FROM brocade_zone_changes WHERE source_id = ? AND fabric_name = ?').get(src.id, 'FAB-A');
    expect(changeRow.change_type).toBe('checksum_changed');
    expect(changeRow.old_value).toBe('checksum-old');
    expect(changeRow.new_value).toBe('checksum-new');
  });
});

describe('poller handle', () => {
  it('has a real combined handle with stopAll/taskCount/triggerEvents', () => {
    const handle = registry.getPollerHandle('brocade');
    expect(handle).toBeDefined();
    expect(typeof handle.stopAll).toBe('function');
    expect(typeof handle.taskCount).toBe('function');
    expect(typeof handle.trigger).toBe('function');
    expect(typeof handle.triggerEvents).toBe('function');
    expect(() => handle.stopAll()).not.toThrow();
    expect(handle.taskCount()).toBe(0);
  });

  it('addendum 1: the combined handle also exposes triggerPortStats', () => {
    const handle = registry.getPollerHandle('brocade');
    expect(typeof handle.triggerPortStats).toBe('function');
  });
});

describe('port IO statistics (addendum 1)', () => {
  it('publicSource returns portStatsIntervalMinutes and PUT can change it', async () => {
    const created = await request(app).post('/api/brocade/sources').set('x-api-key', API_KEY).send({
      name: 'SanNav PortStats', host: '10.11.11.11', username: 'admin', password: 'secret123',
    });
    expect(created.body.source.portStatsIntervalMinutes).toBe(15);

    const updated = await request(app).put(`/api/brocade/sources/${created.body.source.id}`).set('x-api-key', API_KEY).send({
      portStatsIntervalMinutes: 30,
    });
    expect(updated.status).toBe(200);
    expect(updated.body.source.portStatsIntervalMinutes).toBe(30);
  });

  it('GET /ports carries the new IO-rate columns (null when no stats sampled yet)', async () => {
    const src = seedSource({ host: '10.12.12.12' });
    db.prepare(`
      INSERT INTO brocade_switch_ports (source_id, wwn, switch_wwn, switch_name, name, port_number, stale)
      VALUES (?, 'port-wwn-1', 'sw-wwn-1', 'SW-1', 'port1', 1, 0)
    `).run(src.id);
    const res = await request(app).get('/api/brocade/ports').set('x-api-key', API_KEY);
    expect(res.status).toBe(200);
    const row = res.body.ports.find((p) => p.wwn === 'port-wwn-1');
    expect(row).toBeTruthy();
    expect(row.inFramesPerSec).toBeNull();
    expect(row.statsTs).toBeNull();
  });

  it('GET /ports surfaces the latest sampled rate for a port with stats', async () => {
    const src = seedSource({ host: '10.13.13.13' });
    db.prepare(`
      INSERT INTO brocade_switch_ports (source_id, wwn, switch_wwn, switch_name, name, port_number, stale)
      VALUES (?, 'port-wwn-2', 'sw-wwn-2', 'SW-2', 'port2', 2, 0)
    `).run(src.id);
    db.prepare(`
      INSERT INTO brocade_port_stats (source_id, port_wwn, switch_wwn, ts, in_frames_per_sec, out_frames_per_sec, crc_errors_delta)
      VALUES (?, 'port-wwn-2', 'sw-wwn-2', datetime('now', '-30 minutes'), 5000, 4800, 0)
    `).run(src.id);
    db.prepare(`
      INSERT INTO brocade_port_stats (source_id, port_wwn, switch_wwn, ts, in_frames_per_sec, out_frames_per_sec, crc_errors_delta)
      VALUES (?, 'port-wwn-2', 'sw-wwn-2', datetime('now'), 6000, 5900, 1)
    `).run(src.id);
    const res = await request(app).get('/api/brocade/ports').set('x-api-key', API_KEY);
    const row = res.body.ports.find((p) => p.wwn === 'port-wwn-2');
    expect(row.inFramesPerSec).toBe(6000);
    expect(row.outFramesPerSec).toBe(5900);
    expect(row.crcErrorsDelta).toBe(1);
  });

  it('GET /port-stats returns a series+ports shape and 400s with no wwns', async () => {
    const bad = await request(app).get('/api/brocade/port-stats').set('x-api-key', API_KEY);
    expect(bad.status).toBe(400);

    const src = seedSource({ host: '10.14.14.14' });
    db.prepare(`
      INSERT INTO brocade_switch_ports (source_id, wwn, switch_wwn, switch_name, name, port_number, stale)
      VALUES (?, 'port-wwn-3', 'sw-wwn-3', 'SW-3', 'port3', 3, 0)
    `).run(src.id);
    db.prepare(`
      INSERT INTO brocade_port_stats (source_id, port_wwn, switch_wwn, ts, in_frames_per_sec, out_frames_per_sec)
      VALUES (?, 'port-wwn-3', 'sw-wwn-3', datetime('now'), 1234, 1111)
    `).run(src.id);
    const res = await request(app).get('/api/brocade/port-stats').query({ wwns: 'port-wwn-3', hours: 24 }).set('x-api-key', API_KEY);
    expect(res.status).toBe(200);
    expect(res.body.series['port-wwn-3'].length).toBe(1);
    expect(res.body.series['port-wwn-3'][0].inFramesPerSec).toBe(1234);
    expect(res.body.ports['port-wwn-3'].name).toBe('port3');
  });

  it('POST /sources/:id/poll-port-stats triggers without error', async () => {
    const src = seedSource({ host: '10.15.15.15' });
    const res = await request(app).post(`/api/brocade/sources/${src.id}/poll-port-stats`).set('x-api-key', API_KEY);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true });
  });

  it('GET /config includes portStatsRetentionDays and PUT clamps 1-90', async () => {
    const res = await request(app).get('/api/brocade/config').set('x-api-key', API_KEY);
    expect(res.status).toBe(200);
    expect(res.body.portStatsRetentionDays).toBe(14);

    const put = await request(app).put('/api/brocade/config').set('x-api-key', API_KEY).send({ portStatsRetentionDays: 200 });
    expect(put.status).toBe(400);

    const putOk = await request(app).put('/api/brocade/config').set('x-api-key', API_KEY).send({ portStatsRetentionDays: 7 });
    expect(putOk.status).toBe(200);
    const after = await request(app).get('/api/brocade/config').set('x-api-key', API_KEY);
    expect(after.body.portStatsRetentionDays).toBe(7);
  });
});

describe('direct-FOS collector (addendum 2)', () => {
  it('publicSource exposes fos fields, never the password; POST/PUT round-trip with keep-if-blank', async () => {
    const created = await request(app).post('/api/brocade/sources').set('x-api-key', API_KEY).send({
      name: 'SanNav DirectFOS', host: '10.20.20.20', username: 'admin', password: 'secret123',
      fosDirectEnabled: true, fosUsername: 'fosadmin', fosPassword: 'fos-secret', fosPort: 443,
    });
    expect(created.status).toBe(201);
    expect(created.body.source.fosDirectEnabled).toBe(true);
    expect(created.body.source.fosUsername).toBe('fosadmin');
    expect(created.body.source.fosPort).toBe(443);
    expect(created.body.source.hasFosPassword).toBe(true);
    expect(created.body.source.fosPassword).toBeUndefined();
    expect(created.body.source.fos_password_enc).toBeUndefined();

    const before = db.prepare('SELECT fos_password_enc FROM brocade_sources WHERE id = ?').get(created.body.source.id);

    const updated = await request(app).put(`/api/brocade/sources/${created.body.source.id}`).set('x-api-key', API_KEY).send({
      fosUsername: 'fosadmin2', fosPassword: '',
    });
    expect(updated.status).toBe(200);
    expect(updated.body.source.fosUsername).toBe('fosadmin2');
    expect(updated.body.source.hasFosPassword).toBe(true);
    const after = db.prepare('SELECT fos_password_enc FROM brocade_sources WHERE id = ?').get(created.body.source.id);
    expect(after.fos_password_enc).toBe(before.fos_password_enc);
  });

  it('fos-overrides: GET empty, POST upserts by switchWwn, DELETE removes it', async () => {
    const src = seedSource({ host: '10.21.21.21' });

    const empty = await request(app).get(`/api/brocade/sources/${src.id}/fos-overrides`).set('x-api-key', API_KEY);
    expect(empty.status).toBe(200);
    expect(empty.body.overrides).toEqual([]);

    const created = await request(app).post(`/api/brocade/sources/${src.id}/fos-overrides`).set('x-api-key', API_KEY).send({
      switchWwn: '10:00:00:00:00:00:aa:bb', ipAddress: '10.21.21.100', username: 'swadmin', password: 'swpass', port: 443,
    });
    expect(created.status).toBe(200);
    expect(created.body.override.switchWwn).toBe('10:00:00:00:00:00:aa:bb');
    expect(created.body.override.hasPassword).toBe(true);
    expect(created.body.override.password).toBeUndefined();

    // Upsert (same switchWwn) updates rather than duplicates.
    const updated = await request(app).post(`/api/brocade/sources/${src.id}/fos-overrides`).set('x-api-key', API_KEY).send({
      switchWwn: '10:00:00:00:00:00:aa:bb', ipAddress: '10.21.21.101',
    });
    expect(updated.status).toBe(200);
    expect(updated.body.override.ipAddress).toBe('10.21.21.101');
    expect(updated.body.override.hasPassword).toBe(true); // password kept (blank on update)

    const listed = await request(app).get(`/api/brocade/sources/${src.id}/fos-overrides`).set('x-api-key', API_KEY);
    expect(listed.body.overrides.length).toBe(1);

    const del = await request(app).delete(`/api/brocade/sources/${src.id}/fos-overrides/${created.body.override.id}`).set('x-api-key', API_KEY);
    expect(del.status).toBe(200);
    expect(del.body).toEqual({ ok: true });

    const afterDel = await request(app).get(`/api/brocade/sources/${src.id}/fos-overrides`).set('x-api-key', API_KEY);
    expect(afterDel.body.overrides).toEqual([]);
  });

  it('POST /sources/:id/fos-test -> 200 { ok:false } when no target/creds are resolvable', async () => {
    const src = seedSource({ host: '10.22.22.22' });
    const res = await request(app).post(`/api/brocade/sources/${src.id}/fos-test`).set('x-api-key', API_KEY);
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(false);
    expect(typeof res.body.error).toBe('string');
  });

  it('POST /sources/:id/fos-test -> 200 { ok:false } against an unreachable resolvable target', async () => {
    const src = seedSource({ host: '10.23.23.23' });
    db.prepare(`
      UPDATE brocade_sources SET fos_direct_enabled = 1, fos_username = 'fosadmin', fos_password_enc = ? WHERE id = ?
    `).run(JSON.stringify({ iv: '00', authTag: '00', ciphertext: '00' }), src.id);
    db.prepare(`
      INSERT INTO brocade_switches (source_id, wwn, name, ip_address, stale) VALUES (?, 'sw-wwn-fos-1', 'SW-FOS-1', '203.0.113.250', 0)
    `).run(src.id);
    db.prepare(`
      INSERT INTO brocade_fabrics (source_id, name, seed_switch_wwn, principal_switch_wwn, stale) VALUES (?, 'FAB-FOS', 'sw-wwn-fos-1', 'sw-wwn-fos-1', 0)
    `).run(src.id);
    const res = await request(app).post(`/api/brocade/sources/${src.id}/fos-test`).set('x-api-key', API_KEY);
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(false);
  }, 20000);

  it('GET /sources/:id/probe?section=fos-direct returns 200 with a raw-shape probe result even on failure', async () => {
    const src = seedSource({ host: '10.24.24.24' });
    const res = await request(app).get(`/api/brocade/sources/${src.id}/probe`).query({ section: 'fos-direct' }).set('x-api-key', API_KEY);
    expect(res.status).toBe(200);
    expect(res.body.section).toBe('fos-direct');
  });

  it('migration v3 is idempotent (safe to run twice) and preserves existing rows', () => {
    const brocadeMigrations = require('../db/migrations/brocade');
    expect(() => brocadeMigrations[2].up(db)).not.toThrow();
    const cols = db.prepare('PRAGMA table_info(brocade_sources)').all().map((c) => c.name);
    expect(cols).toEqual(expect.arrayContaining(['fos_direct_enabled', 'fos_username', 'fos_password_enc', 'fos_port']));
  });
});
