/**
 * Characterizes the REAL product-license gate (no mocks): with LICENSE_KEY
 * unset (state 'missing'), every /api route except /api/license/* is blocked
 * with 403 license_required. The ICC refactor must preserve this exactly.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import request from 'supertest';

const API_KEY = 'test-api-key';
let app;

beforeAll(async () => {
  const { createApp } = await import('../app.js');
  app = createApp(); // real license gate
});

describe('license gate with no license configured', () => {
  const get = (p) => request(app).get(p).set('x-api-key', API_KEY);

  it('blocks /api/clusters → 403 license_required', async () => {
    const res = await get('/api/clusters');
    expect(res.status).toBe(403);
    expect(res.body.error).toBe('license_required');
    expect(res.body.state).toBe('missing');
  });

  it('blocks platform routes (pure, netapp) the same way', async () => {
    for (const p of ['/api/pure/arrays', '/api/netapp/arrays', '/api/settings']) {
      const res = await get(p);
      expect(res.status, p).toBe(403);
      expect(res.body.error, p).toBe('license_required');
    }
  });

  it('keeps /api/license/status reachable → 200 state missing', async () => {
    const res = await get('/api/license/status');
    expect(res.status).toBe(200);
    expect(res.body.state).toBe('missing');
  });

  // C8.5: /api/license/* is auth-EXEMPT (activation must work pre-auth on a
  // fresh, unlicensed install) — GET /api/license/status is now reachable
  // without an x-api-key. Only intentional behavior change in WP7b.
  it('is reachable without an api key when unlicensed', async () => {
    const res = await request(app).get('/api/license/status');
    expect(res.status).toBe(200);
    expect(res.body.state).toBe('missing');
  });
});
