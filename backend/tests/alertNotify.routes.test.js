/**
 * /api/alert-notify: per-platform recipients/minSeverity/enabled, the
 * per-alert-type mute toggle, and the platform test-email route (403 on the
 * public demo, 400 when SMTP or recipients aren't resolvable).
 */
import { describe, it, expect, beforeAll, beforeEach, afterEach } from 'vitest';
import { createRequire } from 'module';
import request from 'supertest';

const require = createRequire(import.meta.url);
const { createApp } = require('../app');
const db = require('../db/database');
const { setSetting } = require('../services/settings');
const alertNotifier = require('../services/alertNotifier');

const API_KEY = 'test-api-key';
let app;

beforeAll(() => {
  app = createApp({ licenseGate: (req, res, next) => next() });
});

beforeEach(() => {
  db.exec('DELETE FROM alert_notify_platform');
  db.exec('DELETE FROM alert_notify_types');
  setSetting('smtp_enabled', '1');
  setSetting('smtp_host', 'smtp.example.com');
  setSetting('smtp_from', 'alerts@example.com');
  setSetting('smtp_recipients', 'ops@example.com');
});

const get = (platform) => request(app).get(`/api/alert-notify/${platform}`).set('x-api-key', API_KEY);
const put = (platform, body) => request(app).put(`/api/alert-notify/${platform}`).set('x-api-key', API_KEY).send(body);
const putType = (platform, type, body) => request(app).put(`/api/alert-notify/${platform}/types/${encodeURIComponent(type)}`).set('x-api-key', API_KEY).send(body);
const post = (platform) => request(app).post(`/api/alert-notify/${platform}/test`).set('x-api-key', API_KEY).send({});

describe('GET /api/alert-notify/:platform', () => {
  it('404s for an unknown platform', async () => {
    const res = await get('not-a-real-platform');
    expect(res.status).toBe(404);
  });

  it('returns the default shape for a known platform', async () => {
    const res = await get('cohesity');
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      platform: 'cohesity',
      enabled: true,
      recipients: '',
      minSeverity: null,
      globalRecipientsSet: true,
      smtpReady: true,
      types: [],
    });
  });

  it('returns backfilled types on a fresh catalog', async () => {
    db.exec('DELETE FROM alerts');
    const clusterId = db.prepare(`
      INSERT INTO clusters (name, connection_type, auth_type, encrypted_credentials)
      VALUES ('routes-backfill-cluster', 'direct', 'apikey', 'x')
    `).run().lastInsertRowid;
    db.prepare(`
      INSERT INTO alerts (cluster_id, cohesity_alert_id, severity, alert_type, alert_category, description, resolved, dismissed, first_seen, last_updated)
      VALUES (?, 'a1', 'critical', 'kTest', 'kDisk', 'disk fault', 0, 0, datetime('now'), datetime('now'))
    `).run(clusterId);

    const res = await get('cohesity');
    expect(res.status).toBe(200);
    expect(res.body.types).toEqual([expect.objectContaining({ type: 'kDisk', label: 'Disk', enabled: true })]);
  });
});

describe('PUT /api/alert-notify/:platform validation', () => {
  it('rejects a bad email address', async () => {
    const res = await put('cohesity', { recipients: 'not-an-email' });
    expect(res.status).toBe(400);
    expect(res.body.error).toBeDefined();
  });

  it('rejects an invalid minSeverity', async () => {
    const res = await put('cohesity', { minSeverity: 'bogus' });
    expect(res.status).toBe(400);
    expect(res.body.error).toBeDefined();
  });

  it('404s for an unknown platform', async () => {
    const res = await put('not-a-real-platform', { recipients: 'a@example.com' });
    expect(res.status).toBe(404);
  });
});

describe('PUT round trip', () => {
  it('saves recipients + minSeverity + enabled and GET reflects them', async () => {
    const putRes = await put('cohesity', {
      recipients: 'a@example.com, b@example.com',
      minSeverity: 'critical',
      enabled: false,
    });
    expect(putRes.status).toBe(200);
    expect(putRes.body).toMatchObject({
      platform: 'cohesity',
      recipients: 'a@example.com, b@example.com',
      minSeverity: 'critical',
      enabled: false,
    });

    const after = await get('cohesity');
    expect(after.body).toMatchObject({
      recipients: 'a@example.com, b@example.com',
      minSeverity: 'critical',
      enabled: false,
    });

    // Clearing minSeverity back to blank reverts to inherit (null).
    const cleared = await put('cohesity', { minSeverity: '' });
    expect(cleared.body.minSeverity).toBeNull();
  });
});

describe('PUT /api/alert-notify/:platform/types/:type', () => {
  it('404s for an unknown type', async () => {
    const res = await putType('cohesity', 'kNoSuchType', { enabled: false });
    expect(res.status).toBe(404);
  });

  it('toggles a known type and GET reflects it', async () => {
    db.prepare(`
      INSERT INTO alert_notify_types (platform, type, label, enabled, first_seen, last_seen)
      VALUES ('cohesity', 'kDisk', 'Disk', 1, datetime('now'), datetime('now'))
    `).run();
    const res = await putType('cohesity', 'kDisk', { enabled: false });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ platform: 'cohesity', type: 'kDisk', enabled: false });

    const after = await get('cohesity');
    expect(after.body.types).toEqual([expect.objectContaining({ type: 'kDisk', enabled: false })]);
  });
});

describe('POST /api/alert-notify/:platform/test', () => {
  afterEach(() => {
    delete process.env.DASHBOARD_DEMO;
    alertNotifier._reset();
  });

  it('403s on the public demo', async () => {
    process.env.DASHBOARD_DEMO = '1';
    const res = await post('cohesity');
    expect(res.status).toBe(403);
  });

  it('400s when no recipients resolve (global and platform both blank)', async () => {
    setSetting('smtp_recipients', '');
    const res = await post('cohesity');
    expect(res.status).toBe(400);
    expect(res.body.error).toBeDefined();
  });

  it('200s and sends to the resolved recipients when the transport succeeds', async () => {
    const sent = [];
    alertNotifier._setTransportFactory(() => ({ sendMail: async (msg) => { sent.push(msg); } }));
    const res = await post('cohesity');
    expect(res.status).toBe(200);
    expect(sent).toHaveLength(1);
    expect(sent[0].to).toBe('ops@example.com');
  });
});
