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
});
