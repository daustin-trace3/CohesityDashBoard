/**
 * Custom dashboards CRUD (phase 2): owner scoping, widget validation, and
 * that saving never bypasses dataset RBAC (render-time enforcement lives in
 * /api/datasets — here we only prove unknown datasets are rejected at save).
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { createRequire } from 'module';
import express from 'express';
import request from 'supertest';

const require = createRequire(import.meta.url);

const catalog = require('../services/datasetCatalog');

let makeApp;

beforeAll(() => {
  require('../db/database'); // creates schema incl. user_dashboards (core v12)
  catalog.registerDatasets(
    'dashtest',
    [{
      id: 'dashtest.items',
      label: 'Items',
      table: 'dashtest_items',
      columns: [{ key: 'name', type: 'string', filterable: true }],
    }],
    { core: true }
  );
  const router = require('../routes/userDashboards');
  makeApp = (auth) => {
    const app = express();
    app.use(express.json());
    app.use((req, res, next) => { req.auth = auth; next(); });
    app.use('/api/user-dashboards', router);
    return app;
  };
});

const alice = { kind: 'session', user: { id: 1 }, grants: ['*:*:*'] };
const bob = { kind: 'session', user: { id: 2 }, grants: ['*:*:*'] };

const widget = {
  title: 'Items by name',
  datasetId: 'dashtest.items',
  chartType: 'bar',
  query: { groupBy: 'name' },
};

describe('user dashboards CRUD', () => {
  let id;

  it('creates and lists a dashboard for the owner', async () => {
    const created = await request(makeApp(alice)).post('/api/user-dashboards').send({ name: 'My board', widgets: [widget] });
    expect(created.status).toBe(201);
    id = created.body.id;

    const list = await request(makeApp(alice)).get('/api/user-dashboards');
    expect(list.body.dashboards.some((d) => d.id === id && d.widgetCount === 1)).toBe(true);
  });

  it('other users cannot see, read, update, or delete it', async () => {
    const list = await request(makeApp(bob)).get('/api/user-dashboards');
    expect(list.body.dashboards.some((d) => d.id === id)).toBe(false);
    expect((await request(makeApp(bob)).get(`/api/user-dashboards/${id}`)).status).toBe(404);
    expect((await request(makeApp(bob)).put(`/api/user-dashboards/${id}`).send({ name: 'hijack' })).status).toBe(404);
    expect((await request(makeApp(bob)).delete(`/api/user-dashboards/${id}`)).status).toBe(404);
  });

  it('updates widgets and name for the owner', async () => {
    const res = await request(makeApp(alice))
      .put(`/api/user-dashboards/${id}`)
      .send({ name: 'Renamed', widgets: [widget, { ...widget, chartType: 'table', query: {} }] });
    expect(res.status).toBe(200);
    const got = await request(makeApp(alice)).get(`/api/user-dashboards/${id}`);
    expect(got.body.name).toBe('Renamed');
    expect(got.body.widgets).toHaveLength(2);
  });

  it('rejects invalid widgets: unknown dataset, bad chart type, oversized name', async () => {
    const app = makeApp(alice);
    const bad = async (body) => (await request(app).post('/api/user-dashboards').send(body)).status;
    expect(await bad({ name: 'x', widgets: [{ ...widget, datasetId: 'nope.items' }] })).toBe(400);
    expect(await bad({ name: 'x', widgets: [{ ...widget, chartType: 'radar' }] })).toBe(400);
    expect(await bad({ name: 'y'.repeat(200) })).toBe(400);
    expect(await bad({ widgets: [] })).toBe(400);
  });

  it('anonymous (open-access) callers get their own shared scope', async () => {
    const anon = { kind: 'anonymous', name: 'open-access', grants: ['*:*:*'] };
    const created = await request(makeApp(anon)).post('/api/user-dashboards').send({ name: 'Anon board' });
    expect(created.status).toBe(201);
    const list = await request(makeApp(anon)).get('/api/user-dashboards');
    expect(list.body.dashboards.some((d) => d.id === created.body.id)).toBe(true);
    const aliceList = await request(makeApp(alice)).get('/api/user-dashboards');
    expect(aliceList.body.dashboards.some((d) => d.id === created.body.id)).toBe(false);
  });

  it('deletes for the owner', async () => {
    expect((await request(makeApp(alice)).delete(`/api/user-dashboards/${id}`)).status).toBe(200);
    expect((await request(makeApp(alice)).get(`/api/user-dashboards/${id}`)).status).toBe(404);
  });
});
