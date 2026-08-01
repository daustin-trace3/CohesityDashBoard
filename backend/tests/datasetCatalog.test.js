/**
 * Dataset catalog (custom dashboards phase 1): declaration validation,
 * registry integration, safe query building, and per-viewer RBAC on the
 * /api/datasets routes. Route tests mount routes/datasets.js behind a stub
 * auth middleware so grants can vary per request.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { createRequire } from 'module';
import express from 'express';
import request from 'supertest';

const require = createRequire(import.meta.url);

const db = require('../db/database');
const catalog = require('../services/datasetCatalog');

function testDatasets() {
  return [
    {
      id: 'testns.items',
      label: 'Test Items',
      table: 'testns_items',
      section: 'overview',
      defaultSort: 'name',
      columns: [
        { key: 'name', label: 'Name', type: 'string', filterable: true },
        { key: 'kind', label: 'Kind', type: 'enum', filterable: true },
        { key: 'size_bytes', label: 'Size', type: 'number', aggregatable: true },
        { key: 'active', label: 'Active', type: 'boolean', filterable: true },
        { key: 'notes', label: 'Notes', type: 'string' },
      ],
    },
  ];
}

beforeAll(() => {
  db.exec(`
    CREATE TABLE IF NOT EXISTS testns_items (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT, kind TEXT, size_bytes INTEGER, active INTEGER, notes TEXT
    );
  `);
  const rows = [
    ['alpha', 'disk', 100, 1, 'first'],
    ['beta', 'disk', 200, 0, 'second'],
    ['gamma', 'tape', 50, 1, "o'brien; DROP TABLE testns_items"],
  ];
  const ins = db.prepare('INSERT INTO testns_items (name, kind, size_bytes, active, notes) VALUES (?, ?, ?, ?, ?)');
  for (const r of rows) ins.run(...r);
});

describe('registerDatasets validation', () => {
  it('rejects a dataset id outside the namespace', () => {
    expect(() =>
      catalog.registerDatasets('testns', [{ ...testDatasets()[0], id: 'other.items' }])
    ).toThrow(/must be 'testns\.<name>'/);
  });

  it('rejects a plugin table not prefixed with the namespace', () => {
    expect(() =>
      catalog.registerDatasets('testns', [{ ...testDatasets()[0], table: 'alerts' }])
    ).toThrow(/must be prefixed 'testns_'/);
  });

  it('allows unprefixed tables only with core: true', () => {
    expect(() =>
      catalog.registerDatasets('testcore', [{ ...testDatasets()[0], id: 'testcore.items', table: 'testns_items' }], { core: true })
    ).not.toThrow();
    catalog.unregisterNamespace('testcore');
  });

  it('rejects unknown defaultSort and duplicate columns, leaving nothing partially registered', () => {
    const bad = testDatasets()[0];
    bad.defaultSort = 'nope';
    expect(() => catalog.registerDatasets('testns', [bad])).toThrow(/defaultSort/);
    const dup = testDatasets()[0];
    dup.columns.push({ key: 'name', type: 'string' });
    expect(() => catalog.registerDatasets('testns', [dup])).toThrow(/duplicate column/);
    expect(catalog.getDataset('testns.items')).toBeNull();
  });

  it('re-registering a namespace replaces its datasets', () => {
    catalog.registerDatasets('testns', testDatasets());
    catalog.registerDatasets('testns', testDatasets());
    expect(catalog.getDataset('testns.items')).not.toBeNull();
  });
});

describe('queryDataset', () => {
  beforeAll(() => {
    catalog.registerDatasets('testns', testDatasets());
  });

  it('selects declared columns with default sort', () => {
    const out = catalog.queryDataset(db, 'testns.items', {});
    expect(out.columns).toEqual(['name', 'kind', 'size_bytes', 'active', 'notes']);
    expect(out.rows.map((r) => r.name)).toEqual(['alpha', 'beta', 'gamma']);
  });

  it('applies filters with parameterized values (hostile strings are data, not SQL)', () => {
    const out = catalog.queryDataset(db, 'testns.items', {
      filters: [{ column: 'name', op: 'eq', value: "x' OR '1'='1" }],
    });
    expect(out.rows).toEqual([]);
    expect(db.prepare('SELECT COUNT(*) AS n FROM testns_items').get().n).toBe(3);
  });

  it('supports eq/gt/in/like and boolean coercion', () => {
    expect(catalog.queryDataset(db, 'testns.items', { filters: [{ column: 'active', op: 'eq', value: true }] }).rows).toHaveLength(2);
    expect(catalog.queryDataset(db, 'testns.items', { filters: [{ column: 'kind', op: 'in', value: ['disk'] }] }).rows).toHaveLength(2);
    expect(catalog.queryDataset(db, 'testns.items', { filters: [{ column: 'name', op: 'like', value: '%amma' }] }).rows).toHaveLength(1);
  });

  it('rejects filtering on undeclared or non-filterable columns', () => {
    expect(() => catalog.queryDataset(db, 'testns.items', { filters: [{ column: 'id', op: 'eq', value: 1 }] })).toThrow(/unknown filter column/);
    expect(() => catalog.queryDataset(db, 'testns.items', { filters: [{ column: 'notes', op: 'eq', value: 'x' }] })).toThrow(/not filterable/);
  });

  it('groups and aggregates only on declared aggregatable columns', () => {
    const grouped = catalog.queryDataset(db, 'testns.items', {
      groupBy: 'kind',
      aggregate: { fn: 'sum', column: 'size_bytes' },
    });
    expect(grouped.columns).toEqual(['group', 'value']);
    expect(grouped.rows).toEqual([
      { group: 'disk', value: 300 },
      { group: 'tape', value: 50 },
    ]);
    expect(() =>
      catalog.queryDataset(db, 'testns.items', { groupBy: 'kind', aggregate: { fn: 'sum', column: 'name' } })
    ).toThrow(/not aggregatable/);
  });

  it('count(*) works without an aggregate column', () => {
    const out = catalog.queryDataset(db, 'testns.items', { groupBy: 'kind' });
    expect(out.rows.find((r) => r.group === 'disk').value).toBe(2);
  });

  it('caps limit at 1000 and rejects unknown sort columns', () => {
    expect(catalog.queryDataset(db, 'testns.items', { limit: 999999 }).rows).toHaveLength(3);
    expect(() => catalog.queryDataset(db, 'testns.items', { sort: { column: 'id' } })).toThrow(/unknown sort column/);
  });
});

describe('registry integration', () => {
  it('registerPlugin registers manifest.datasets; invalid datasets mark the plugin errored', () => {
    const registry = require('../core/registry');
    registry.init();
    const okRouter = () => express.Router();
    registry.registerPlugin({
      id: 'dstest',
      name: 'DS Test',
      apiVersion: 1,
      createRouter: okRouter,
      datasets: [
        {
          id: 'dstest.things',
          label: 'Things',
          table: 'dstest_things',
          columns: [{ key: 'name', type: 'string', filterable: true }],
        },
      ],
    });
    expect(catalog.getDataset('dstest.things')).not.toBeNull();
    expect(registry.getPlugin('dstest').status).toBe('active');

    const bad = registry.registerPlugin({
      id: 'dsbad',
      name: 'DS Bad',
      apiVersion: 1,
      createRouter: okRouter,
      datasets: [{ id: 'dsbad.x', label: 'X', table: 'not_owned', columns: [{ key: 'a', type: 'string' }] }],
    });
    expect(bad.status).toBe('error');
    expect(bad.error).toMatch(/must be prefixed/);
    expect(catalog.getDataset('dsbad.x')).toBeNull();
  });
});

describe('/api/datasets routes', () => {
  let makeApp;

  beforeAll(() => {
    catalog.registerDatasets('testns', testDatasets(), { core: true }); // core: always available
    const datasetsRouter = require('../routes/datasets');
    makeApp = (grants) => {
      const app = express();
      app.use(express.json());
      app.use((req, res, next) => {
        req.auth = { kind: 'session', grants };
        next();
      });
      app.use('/api/datasets', datasetsRouter);
      return app;
    };
  });

  it('lists only datasets the viewer is granted', async () => {
    const res = await request(makeApp(['testns:overview:view'])).get('/api/datasets');
    expect(res.status).toBe(200);
    const ids = res.body.datasets.map((d) => d.id);
    expect(ids).toContain('testns.items');
    expect(ids).not.toContain('dstest.things'); // no grant for it
  });

  it('returns dataset schema with its required permission', async () => {
    const res = await request(makeApp(['*:*:*'])).get('/api/datasets/testns.items');
    expect(res.status).toBe(200);
    expect(res.body.permission).toBe('testns:overview:view');
    expect(res.body.columns.length).toBe(5);
  });

  it('query enforces per-dataset RBAC fail-closed', async () => {
    const denied = await request(makeApp(['cohesity:*:view']))
      .post('/api/datasets/testns.items/query')
      .send({});
    expect(denied.status).toBe(403);
    expect(denied.body.required).toBe('testns:overview:view');

    const ok = await request(makeApp(['testns:overview:view']))
      .post('/api/datasets/testns.items/query')
      .send({ groupBy: 'kind' });
    expect(ok.status).toBe(200);
    expect(ok.body.rows.length).toBe(2);
  });

  it('invalid query shapes return 400, unknown datasets 404', async () => {
    const bad = await request(makeApp(['*:*:*']))
      .post('/api/datasets/testns.items/query')
      .send({ filters: [{ column: 'nope', op: 'eq', value: 'x' }] });
    expect(bad.status).toBe(400);
    expect(bad.body.error).toBe('invalid_query');

    const missing = await request(makeApp(['*:*:*'])).get('/api/datasets/nope.items');
    expect(missing.status).toBe(404);
  });
});
