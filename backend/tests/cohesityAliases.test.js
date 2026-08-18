/**
 * WP4: unprefixed Cohesity routes moved under /api/cohesity/*, with the old
 * unprefixed paths kept as deprecated aliases (same router instance). This
 * asserts old and new paths return identical status + body for a
 * representative set, and that both `/api/cohesity/clusters` and the
 * `/api/clusters` alias work.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { createRequire } from 'module';
import request from 'supertest';

const require = createRequire(import.meta.url);

const API_KEY = 'test-api-key';
let app;

beforeAll(() => {
  const registry = require('../core/registry');
  registry.init();

  const { createApp } = require('../app');
  app = createApp({ licenseGate: (req, res, next) => next() });
});

describe('cohesity route aliases: old path === new path', () => {
  const get = (p) => request(app).get(p).set('x-api-key', API_KEY);

  const pairs = [
    ['/api/clusters', '/api/cohesity/clusters'],
    ['/api/alerts', '/api/cohesity/alerts'],
    ['/api/dashboard/snapshot', '/api/cohesity/dashboard/snapshot'],
    ['/api/licensing', '/api/cohesity/licensing'],
    ['/api/analytics/clusters', '/api/cohesity/analytics/clusters'],
  ];

  // /dashboard/snapshot caches its computed snapshot; the first call of a
  // pair computes fresh (no cachedAt) while the second returns the cached
  // copy (adds cachedAt), which is a caching side effect, not a routing
  // difference. Strip volatile timestamp fields before comparing.
  function stripVolatile(body) {
    const clone = JSON.parse(JSON.stringify(body));
    delete clone.cachedAt;
    delete clone.generatedAt;
    if (clone.insights && typeof clone.insights === 'object') delete clone.insights.generatedAt;
    return clone;
  }

  for (const [oldPath, newPath] of pairs) {
    it(`${oldPath} and ${newPath} return the same status and body`, async () => {
      const oldRes = await get(oldPath);
      const newRes = await get(newPath);
      expect(oldRes.status).toBe(newRes.status);
      expect(stripVolatile(oldRes.body)).toEqual(stripVolatile(newRes.body));
    });
  }
});

describe('new mount and old alias both work independently', () => {
  const get = (p) => request(app).get(p).set('x-api-key', API_KEY);

  it('GET /api/cohesity/clusters → 200 empty list', async () => {
    const res = await get('/api/cohesity/clusters');
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body)).toBe(true);
    expect(res.body).toHaveLength(0);
  });

  it('GET /api/clusters (deprecated alias) → 200 empty list', async () => {
    const res = await get('/api/clusters');
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body)).toBe(true);
    expect(res.body).toHaveLength(0);
  });
});
