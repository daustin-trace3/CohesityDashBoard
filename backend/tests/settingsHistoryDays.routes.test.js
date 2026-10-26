/**
 * PUT /api/settings: backup history depth fields are range checked and the
 * 400 names the field.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { createRequire } from 'module';
import request from 'supertest';

const require = createRequire(import.meta.url);
const { createApp } = require('../app');

const API_KEY = 'test-api-key';
let app;

beforeAll(() => {
  app = createApp({ licenseGate: (req, res, next) => next() });
});

const put = (body) => request(app).put('/api/settings').set('x-api-key', API_KEY).send(body);
const get = () => request(app).get('/api/settings').set('x-api-key', API_KEY);

describe('PUT /api/settings history depth', () => {
  it('rejects cohesityRunHistoryDays=10 naming the field', async () => {
    const res = await put({ cohesityRunHistoryDays: 10 });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/cohesityRunHistoryDays/);
  });

  it('rejects netbackupJobHistoryDays=3 naming the field', async () => {
    const res = await put({ netbackupJobHistoryDays: 3 });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/netbackupJobHistoryDays/);
  });

  it('accepts 120 and returns it from GET', async () => {
    const res = await put({ cohesityRunHistoryDays: 120, netbackupJobHistoryDays: 120 });
    expect(res.status).toBe(200);
    const got = await get();
    expect(got.body).toMatchObject({ cohesityRunHistoryDays: 120, netbackupJobHistoryDays: 120 });
  });

  it('GET defaults are 90 and 30', async () => {
    await put({ cohesityRunHistoryDays: 90, netbackupJobHistoryDays: 30 });
    const got = await get();
    expect(got.body).toMatchObject({ cohesityRunHistoryDays: 90, netbackupJobHistoryDays: 30 });
  });
});
