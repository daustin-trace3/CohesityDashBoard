// Ops grants: the Ops Agent routes need ops:*:view to read and ops:*:manage to
// act, and a caller sees only incidents whose platforms it holds.
import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import { createRequire } from 'module';
import crypto from 'crypto';
import request from 'supertest';

const require = createRequire(import.meta.url);
const db = require('../db/database');
const { createApp } = require('../app');

let app;
const NOW = new Date().toISOString();

function keyFor(name, grants) {
  const key = `icc_${crypto.randomBytes(20).toString('hex')}`;
  const keyHash = crypto.createHash('sha256').update(key).digest('hex');
  db.prepare('INSERT INTO service_accounts (name, key_hash, key_prefix, permissions, is_active, created_at) VALUES (?, ?, ?, ?, 1, ?)')
    .run(name, keyHash, key.slice(0, 8), JSON.stringify(grants), NOW);
  return key;
}

function insertIncident(platforms, title) {
  return db.prepare(`
    INSERT INTO ops_incidents (incident_key, title, host, platforms, severity, state, opened_at, hold_until, last_event_at, event_count, baseline)
    VALUES (?, ?, 'h1', ?, 'warning', 'notified', ?, ?, ?, 1, 0)
  `).run(`host:${title}`, title, JSON.stringify(platforms), NOW, NOW, NOW).lastInsertRowid;
}

beforeAll(() => { app = createApp({ licenseGate: (req, res, next) => next() }); });
beforeEach(() => { db.exec('DELETE FROM ops_incident_alerts; DELETE FROM ops_incidents;'); });

describe('ops grants on /api/ops-agent', () => {
  it('a platform-only caller gets 403 on reads and writes', async () => {
    const k = keyFor('og-pure-only', ['pure:*:view']);
    expect((await request(app).get('/api/ops-agent/incidents').set('x-api-key', k)).status).toBe(403);
    expect((await request(app).get('/api/ops-agent/status').set('x-api-key', k)).status).toBe(403);
    expect((await request(app).post('/api/ops-agent/run').set('x-api-key', k)).status).toBe(403);
  });

  it('ops view reads but cannot act; ops manage can', async () => {
    const id = insertIncident(['cohesity'], 'a');
    const view = keyFor('og-view', ['ops:*:view', 'cohesity:*:view']);
    expect((await request(app).get('/api/ops-agent/incidents').set('x-api-key', view)).status).toBe(200);
    const denied = await request(app).post(`/api/ops-agent/incidents/${id}/resolve`).set('x-api-key', view).send({ note: 'x' });
    expect(denied.status).toBe(403);
    expect(denied.body.required).toBe('ops:*:manage');
    const manage = keyFor('og-manage', ['ops:*:manage', 'cohesity:*:view']);
    const ok = await request(app).post(`/api/ops-agent/incidents/${id}/ack`).set('x-api-key', manage).send({});
    expect(ok.status).toBe(200);
  });

  it('incidents are scoped to the caller platforms; a hidden one is 404 for reads and acts', async () => {
    const a = insertIncident(['cohesity'], 'cohesity-inc');
    const b = insertIncident(['pure'], 'pure-inc');
    const pureViewer = keyFor('og-pure-ops', ['ops:*:view', 'pure:*:view']);
    const cohViewer = keyFor('og-coh-ops', ['ops:*:view', 'cohesity:*:view']);
    const pureList = await request(app).get('/api/ops-agent/incidents?state=all').set('x-api-key', pureViewer);
    expect(pureList.body.map((i) => i.id)).toEqual([b]);
    const cohList = await request(app).get('/api/ops-agent/incidents?state=all').set('x-api-key', cohViewer);
    expect(cohList.body.map((i) => i.id)).toEqual([a]);
    expect((await request(app).get(`/api/ops-agent/incidents/${a}`).set('x-api-key', pureViewer)).status).toBe(404);
    expect((await request(app).get(`/api/ops-agent/incidents/${a}/analyses`).set('x-api-key', pureViewer)).status).toBe(404);
    expect((await request(app).get(`/api/ops-agent/incidents/${a}`).set('x-api-key', cohViewer)).status).toBe(200);
    const pureManage = keyFor('og-pure-manage', ['ops:*:manage', 'pure:*:view']);
    expect((await request(app).post(`/api/ops-agent/incidents/${a}/ack`).set('x-api-key', pureManage).send({})).status).toBe(404);
  });

  it('a *:*:view holder sees every incident', async () => {
    insertIncident(['cohesity'], 'x1');
    insertIncident(['pure'], 'x2');
    const k = keyFor('og-all-view', ['*:*:view']);
    const res = await request(app).get('/api/ops-agent/incidents?state=all').set('x-api-key', k);
    expect(res.body).toHaveLength(2);
  });
});

describe('ops grants on /api/estate and /api/service-status', () => {
  it('estate reads need ops view and generate needs ops manage', async () => {
    const none = keyFor('og-est-none', ['pure:*:view']);
    expect((await request(app).get('/api/estate/advisor/daily-brief').set('x-api-key', none)).status).toBe(403);
    const view = keyFor('og-est-view', ['ops:*:view']);
    expect((await request(app).get('/api/estate/advisor/daily-brief').set('x-api-key', view)).status).toBe(200);
    expect((await request(app).post('/api/estate/advisor/daily-brief').set('x-api-key', view)).status).toBe(403);
    expect((await request(app).post('/api/service-status/sweep').set('x-api-key', view)).status).toBe(403);
  });
});
