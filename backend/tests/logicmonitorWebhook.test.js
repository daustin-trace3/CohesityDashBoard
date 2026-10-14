/**
 * LogicMonitor webhook ingest (WP-S2): token issue and disable, constant-time
 * token check, rate limit, demo refusal, the active -> cleared upsert, key
 * equality with a polled row, the event log and the Ops Agent wake flag.
 * The router is mounted the way app.js mounts it: ingest unauthenticated, the
 * admin router behind a fake session.
 */
import { describe, it, expect, beforeAll, beforeEach, afterEach } from 'vitest';
import { createRequire } from 'module';
import request from 'supertest';

const require = createRequire(import.meta.url);
const crypto = require('crypto');
const express = require('express');
const db = require('../db/database');
const { runMigrations } = require('../core/migrations');
const lmMigrations = require('../db/migrations/logicmonitor');
const { setSetting, getSetting } = require('../services/settings');
const lmWebhook = require('../routes/logicmonitorWebhook');
const api = require('../services/logicmonitorApi');

let app;
let sid;

// A database migrated before WP-S1's v3 lands lacks the webhook pieces; add
// exactly what v3 specifies so this file runs either way.
function ensureV3() {
  const cols = (t) => db.prepare(`PRAGMA table_info(${t})`).all().map((c) => c.name);
  const add = (t, c, def) => { if (!cols(t).includes(c)) db.exec(`ALTER TABLE ${t} ADD COLUMN ${c} ${def}`); };
  add('lm_sources', 'webhook_token_hash', 'TEXT');
  add('lm_sources', 'webhook_enabled', 'INTEGER DEFAULT 0');
  add('lm_sources', 'webhook_last_at', 'TEXT');
  add('lm_sources', 'webhook_count', 'INTEGER DEFAULT 0');
  add('lm_sources', 'webhook_last_error', 'TEXT');
  add('lm_alerts', 'ingest', 'TEXT');
  add('lm_alerts', 'shadowed_by', 'TEXT');
  db.exec(`CREATE TABLE IF NOT EXISTS lm_webhook_events (
    id INTEGER PRIMARY KEY AUTOINCREMENT, source_id INTEGER NOT NULL, received_at TEXT DEFAULT (datetime('now')),
    status TEXT, lm_alert_id TEXT, internal_id TEXT, host TEXT, accepted INTEGER, error TEXT, raw_json TEXT)`);
}

beforeAll(() => {
  runMigrations(db, 'logicmonitor', lmMigrations);
  ensureV3();
  app = express();
  app.use(express.json({ limit: '1mb' }));
  app.use('/api/logicmonitor/webhook', lmWebhook);
  app.use((req, res, next) => { req.auth = { grants: ['*:*:*'], user: { username: 'tester' } }; next(); });
  app.use('/api/logicmonitor/sources/:id', lmWebhook.adminRouter);
  app.use((err, req, res, next) => res.status(500).json({ error: err.message })); // eslint-disable-line no-unused-vars
});

beforeEach(() => {
  for (const t of ['lm_webhook_events', 'lm_alerts', 'lm_devices', 'lm_sources']) db.exec(`DELETE FROM ${t}`);
  db.prepare("DELETE FROM app_settings WHERE key IN ('ops_agent_wake_requested', 'lm_webhook_rate_per_min', 'icc_base_url')").run();
  setSetting('platform_logicmonitor_enabled', '1');
  sid = db.prepare("INSERT INTO lm_sources (name, company, auth_mode, encrypted_credentials) VALUES ('Acme', 'acme', 'lmv1', 'x')").run().lastInsertRowid;
  db.prepare("INSERT INTO lm_devices (source_id, lm_device_id, name, display_name, role, is_network, host_status) VALUES (?, 301, '10.9.9.1', 'phx-sw-01', 'switch', 1, 'normal')").run(sid);
});

afterEach(() => { delete process.env.DASHBOARD_DEMO; });

const payload = (o = {}) => ({
  status: 'active', type: 'alert', alertId: 'DS1001', recurringId: 'LMD777', severity: 'critical', host: 'phx-sw-01', hostId: '301',
  datasource: 'SNMP_Network_Interfaces', instance: 'Gi1/0/5', datapoint: 'OperStatus', value: '2', threshold: '> 1',
  startEpoch: '1790000000', endEpoch: '0', message: 'port down', ackedBy: '', ackComment: '', group: 'Network/Branch/Phoenix', ...o,
});

async function issueToken() {
  const r = await request(app).post(`/api/logicmonitor/sources/${sid}/webhook-token`);
  expect(r.status).toBe(200);
  return r.body.token;
}
const send = (token, body, id = sid) => request(app).post(`/api/logicmonitor/webhook/${id}`).set('x-icc-webhook-token', token).send(body);
const alerts = () => db.prepare('SELECT * FROM lm_alerts ORDER BY id').all();

describe('token issue and settings view', () => {
  it('issues a 64 hex token once, stores only its sha256, enables the webhook and describes the contract', async () => {
    const token = await issueToken();
    expect(token).toMatch(/^[0-9a-f]{64}$/);
    const row = db.prepare('SELECT webhook_token_hash, webhook_enabled FROM lm_sources WHERE id = ?').get(sid);
    expect(row.webhook_enabled).toBe(1);
    expect(row.webhook_token_hash).toBe(crypto.createHash('sha256').update(token).digest('hex'));
    expect(JSON.stringify(row)).not.toContain(token);

    setSetting('icc_base_url', 'https://icc.example.com/');
    const view = await request(app).get(`/api/logicmonitor/sources/${sid}/webhook`);
    expect(view.body).toMatchObject({ enabled: true, count: 0, lastAt: null, lastError: null, header: 'x-icc-webhook-token' });
    expect(view.body.url).toMatch(/^https:\/\/icc\.example\.com\/api(\/t\/[^/]+)?\/logicmonitor\/webhook\/\d+$/);
    expect(view.body.url.endsWith(`/logicmonitor/webhook/${sid}`)).toBe(true);
    expect(view.body.template).toContain('"alertId":"##INTERNALID##"');
    expect(view.body.template).toContain('"recurringId":"##ALERTID##"');
    expect(() => JSON.parse(view.body.template.replace(/##[A-Z]+##/g, 'x'))).not.toThrow();
    expect(JSON.stringify(view.body)).not.toContain(token);
    expect((await request(app).get('/api/logicmonitor/sources/9999/webhook')).status).toBe(404);
  });

  it('DELETE disables it: the same token is refused afterwards', async () => {
    const token = await issueToken();
    expect((await send(token, payload())).status).toBe(202);
    const off = await request(app).delete(`/api/logicmonitor/sources/${sid}/webhook-token`);
    expect(off.body.enabled).toBe(false);
    expect((await send(token, payload({ alertId: 'DS1002' }))).status).toBe(401);
  });
});

describe('ingest auth', () => {
  it('refuses a missing, wrong, or other-source token with 401 and writes nothing', async () => {
    const token = await issueToken();
    const noToken = await request(app).post(`/api/logicmonitor/webhook/${sid}`).send(payload());
    expect(noToken.status).toBe(401);
    expect((await send('f'.repeat(64), payload())).status).toBe(401);
    expect((await send(token, payload(), 424242)).status).toBe(401);
    expect(alerts()).toHaveLength(0);
    expect(db.prepare('SELECT COUNT(*) c FROM lm_webhook_events').get().c).toBe(0);
  });

  it('accepts the token as ?token= too', async () => {
    const token = await issueToken();
    const r = await request(app).post(`/api/logicmonitor/webhook/${sid}?token=${token}`).send(payload());
    expect(r.status).toBe(202);
  });

  it('is refused in demo mode and when the platform is off', async () => {
    const token = await issueToken();
    process.env.DASHBOARD_DEMO = '1';
    const demo = await send(token, payload());
    expect(demo.status).toBe(403);
    expect(demo.body.error).toMatch(/^Demo mode: this change is disabled/);
    delete process.env.DASHBOARD_DEMO;
    setSetting('platform_logicmonitor_enabled', '0');
    expect((await send(token, payload())).status).toBe(503);
    expect(alerts()).toHaveLength(0);
  });

  it('answers 429 past the per-source limit', async () => {
    setSetting('lm_webhook_rate_per_min', '60');
    let last;
    for (let i = 0; i < 61; i += 1) last = await send('0'.repeat(64), payload(), 777);
    expect(last.status).toBe(429);
    // another source has its own bucket
    expect((await send('0'.repeat(64), payload(), 778)).status).toBe(401);
  });

  it('refuses an oversized body with 413', async () => {
    const token = await issueToken();
    const r = await send(token, payload({ message: 'x'.repeat(70 * 1024) }));
    expect(r.status).toBe(413);
  });
});

describe('ingest handling', () => {
  it('writes the active row, then updates the same row on acknowledged and cleared', async () => {
    const token = await issueToken();
    const a = await send(token, payload());
    expect(a.status).toBe(202);
    expect(a.body).toEqual({ accepted: true });
    let rows = alerts();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      source_id: sid, lm_alert_id: 'DS1001', internal_id: 'LMD777', severity: 4, severity_norm: 'critical', lm_device_id: 301,
      monitor_object_name: 'phx-sw-01', resource_template_name: 'SNMP_Network_Interfaces', instance_name: 'Gi1/0/5',
      data_point_name: 'OperStatus', alert_value: '2', start_epoch: 1790000000, cleared: 0, ingest: 'webhook',
    });

    await send(token, payload({ status: 'acknowledged', ackedBy: 'doug', ackComment: 'on it' }));
    rows = alerts();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ acked: 1, acked_by: 'doug', ack_comment: 'on it', cleared: 0 });

    await send(token, payload({ status: 'cleared', endEpoch: '1790000600' }));
    rows = alerts();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ cleared: 1, closed_reason: 'cleared', end_epoch: 1790000600, severity: 4 });

    const src = db.prepare('SELECT webhook_count, webhook_last_at, webhook_last_error FROM lm_sources WHERE id = ?').get(sid);
    expect(src.webhook_count).toBe(3);
    expect(src.webhook_last_at).toBeTruthy();
    expect(src.webhook_last_error).toBeNull();
  });

  it('maps severity words (warning/error/critical) and the inverted ids', async () => {
    const token = await issueToken();
    await send(token, payload({ alertId: 'DS2', severity: 'warning' }));
    await send(token, payload({ alertId: 'DS3', severity: 'error' }));
    const bySev = Object.fromEntries(alerts().map((r) => [r.lm_alert_id, [r.severity, r.severity_norm]]));
    expect(bySev).toEqual({ DS2: [2, 'info'], DS3: [3, 'warning'] });
  });

  it('builds the same condition_key the poller builds, so a pushed and a polled row are one Ops Agent alert', async () => {
    const token = await issueToken();
    await send(token, payload());
    const polled = api.normalizeAlert({
      id: 'DS1001', internalId: 'LMD777', monitorObjectName: 'phx-sw-01', monitorObjectType: 'device', monitorObjectId: 301,
      resourceTemplateName: 'SNMP_Network_Interfaces', instanceName: 'Gi1/0/5', dataPointName: 'OperStatus', severity: 4,
    }, sid);
    expect(alerts()[0].condition_key).toBe(polled.conditionKey);
    expect(alerts()[0].condition_key).toBe(`lm:${sid}:phx-sw-01:SNMP_Network_Interfaces:Gi1/0/5:OperStatus`);
  });

  it('logs every accepted delivery and every rejected payload, and records the last error', async () => {
    const token = await issueToken();
    await send(token, payload());
    const bad = await send(token, payload({ status: 'bogus', alertId: 'DS9' }));
    expect(bad.status).toBe(400);
    const missing = await send(token, payload({ alertId: '', status: 'active' }));
    expect(missing.status).toBe(400);
    const ev = db.prepare('SELECT * FROM lm_webhook_events ORDER BY id').all();
    expect(ev.map((e) => [e.accepted, e.status])).toEqual([[1, 'active'], [0, 'bogus'], [0, 'active']]);
    expect(ev[0]).toMatchObject({ lm_alert_id: 'DS1001', internal_id: 'LMD777', host: 'phx-sw-01' });
    expect(ev[0].raw_json).toContain('port down');
    expect(db.prepare('SELECT webhook_last_error FROM lm_sources WHERE id = ?').get(sid).webhook_last_error).toMatch(/alertId/);
    expect(alerts()).toHaveLength(1);
  });

  it('nudges the Ops Agent through the wake flag', async () => {
    const token = await issueToken();
    expect(getSetting('ops_agent_wake_requested')).toBeFalsy();
    await send(token, payload());
    expect(getSetting('ops_agent_wake_requested')).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });
});
