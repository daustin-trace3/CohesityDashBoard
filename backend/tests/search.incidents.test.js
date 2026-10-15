/**
 * /api/search ops-incidents category: find an Ops Agent incident by number
 * ("12" or "#12") or by title/host words, deep-linking to /ops/agent?incident=<id>.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { createRequire } from 'module';
import request from 'supertest';

const require = createRequire(import.meta.url);
const express = require('express');
const db = require('../db/database');
const searchRouter = require('../routes/search');

const appFor = (grants) => {
  const app = express();
  app.use((req, res, next) => { req.auth = { grants }; next(); });
  app.use('/api/search', searchRouter);
  return app;
};
const admin = appFor(['*:*:*']);
const incidents = (res) => (res.body.results.find((g) => g.key === 'ops-incidents') || { items: [] }).items;

beforeEach(() => {
  db.exec('DELETE FROM ops_incident_alerts; DELETE FROM ops_incidents;');
  const ins = db.prepare(`INSERT INTO ops_incidents (id, incident_key, title, host, platforms, severity, state, opened_at, hold_until, last_event_at)
    VALUES (?, ?, ?, ?, '["dell"]', 'critical', 'notified', '2026-10-14T10:00:00.000Z', '2026-10-14T10:10:00.000Z', '2026-10-14T10:00:00.000Z')`);
  ins.run(12, 'host:r740-07', 'Fan failure on r740-07', 'r740-07');
  ins.run(13, 'host:esx-01', 'Datastore latency', 'esx-01');
  ins.run(5, 'host:zeta', 'Zeta outage', 'zeta');
});

describe('GET /api/search ops-incidents', () => {
  it('finds an incident by #id', async () => {
    const items = incidents(await request(admin).get('/api/search').query({ q: '#12' }));
    expect(items).toHaveLength(1);
    expect(items[0].route).toBe('/ops/agent?incident=12');
    expect(items[0].title).toBe('#12 Fan failure on r740-07');
  });

  it('finds an incident by bare id, including a 1-digit query', async () => {
    const items = incidents(await request(admin).get('/api/search').query({ q: '12' }));
    expect(items.map((i) => i.route)).toContain('/ops/agent?incident=12');
    const one = await request(admin).get('/api/search').query({ q: '#5' });
    expect(incidents(one).map((i) => i.route)).toEqual(['/ops/agent?incident=5']);
  });

  it('finds an incident by a title word', async () => {
    const items = incidents(await request(admin).get('/api/search').query({ q: 'latency' }));
    expect(items.map((i) => i.route)).toEqual(['/ops/agent?incident=13']);
  });

  it('returns nothing for a 1-character non-numeric query', async () => {
    const res = await request(admin).get('/api/search').query({ q: 'f' });
    expect(res.body.results).toEqual([]);
  });

  it('omits the category when the caller lacks the permission', async () => {
    const res = await request(appFor(['aws:ec2:view'])).get('/api/search').query({ q: '#12' });
    expect(incidents(res)).toHaveLength(0);
  });
});
