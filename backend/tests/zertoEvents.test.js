/**
 * Zerto event log: GET /api/zerto/events (server-paged, windowed, filtered)
 * and its CSV twin. Direct-mount style like netappGovernance.test.js.
 * Event rows mirror /v2/monitoring/events (verified live 2026-09-28).
 */
import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import { createRequire } from 'module';
import express from 'express';
import request from 'supertest';

const require = createRequire(import.meta.url);
const db = require('../db/database');
const zertoRouter = require('../routes/zerto');

let app;

const iso = (hoursAgo) => new Date(Date.now() - hoursAgo * 3600e3).toISOString();

function insertEvent({ id, category = 'Alerts', code = 'EV0056', type = 'AlertTurnedOn', desc = 'x', ok = 1, hoursAgo = 1, site = 'zmsnx2gcprd' }) {
  db.prepare(`
    INSERT INTO zerto_events (event_identifier, category, code, event_type, description,
      completed_successfully, occurred_on, site_identifier, site_name, site_type, zorg_name)
    VALUES (?, ?, ?, ?, ?, ?, ?, 'sid', ?, 'VCenter', NULL)
  `).run(id, category, code, type, desc, ok, iso(hoursAgo), site);
}

beforeAll(() => {
  app = express();
  app.use(express.json());
  app.use((req, res, next) => { req.auth = { grants: ['*:*:*'], user: { username: 'tester' } }; next(); });
  app.use('/api/zerto', zertoRouter);
});

beforeEach(() => { db.exec('DELETE FROM zerto_events'); });

describe('GET /api/zerto/events', () => {
  it('windows, pages newest first and rolls up counts', async () => {
    insertEvent({ id: 'e-new', hoursAgo: 1, category: 'Alerts' });
    insertEvent({ id: 'e-mid', hoursAgo: 3, category: 'Events', type: 'MoveCompleted', ok: 0, desc: 'failed move' });
    insertEvent({ id: 'e-old', hoursAgo: 10 * 24, category: 'Events' }); // outside a 7d window
    const res = await request(app).get('/api/zerto/events?days=7&pageSize=10');
    expect(res.status).toBe(200);
    expect(res.body.total).toBe(2);
    expect(res.body.rows.map((r) => r.event_identifier)).toEqual(['e-new', 'e-mid']);
    expect(res.body.counts.windowTotal).toBe(2);
    expect(res.body.counts.byCategory).toEqual({ Alerts: 1, Events: 1 });
    expect(res.body.counts.failures).toBe(1);
  });

  it('filters by category and search, with counts still window-wide', async () => {
    insertEvent({ id: 'a1', category: 'Alerts', desc: 'VRA not connected' });
    insertEvent({ id: 'v1', category: 'Events', type: 'VpgCreated', desc: 'VPG PROD-SQL created' });
    const byCat = await request(app).get('/api/zerto/events?category=Events');
    expect(byCat.body.total).toBe(1);
    expect(byCat.body.rows[0].event_identifier).toBe('v1');
    expect(byCat.body.counts.windowTotal).toBe(2);
    const byQ = await request(app).get('/api/zerto/events?q=PROD-SQL');
    expect(byQ.body.total).toBe(1);
    expect(byQ.body.rows[0].event_identifier).toBe('v1');
  });

  it('pages with total intact', async () => {
    for (let i = 0; i < 25; i++) insertEvent({ id: `p${i}`, hoursAgo: i + 1 });
    const p2 = await request(app).get('/api/zerto/events?pageSize=10&page=2');
    expect(p2.body.total).toBe(25);
    expect(p2.body.rows).toHaveLength(5);
  });
});

describe('GET /api/zerto/events.csv', () => {
  it('returns the filtered rows as CSV with quoting', async () => {
    insertEvent({ id: 'c1', desc: 'has, comma and "quotes"' });
    insertEvent({ id: 'c2', category: 'Events', desc: 'plain' });
    const res = await request(app).get('/api/zerto/events.csv?category=Alerts');
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toContain('text/csv');
    const lines = res.text.split('\r\n');
    expect(lines[0]).toBe('Occurred (UTC),Category,Type,Code,Site,ZORG,Success,Description');
    expect(lines).toHaveLength(2);
    expect(lines[1]).toContain('"has, comma and ""quotes"""');
  });
});
