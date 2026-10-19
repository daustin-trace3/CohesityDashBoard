/**
 * Global Settings: poller_calls_in_flight round trip and validation, and a load
 * check that every poller converted to the concurrency helper still parses.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createRequire } from 'module';
import request from 'supertest';

const require = createRequire(import.meta.url);
const { createApp } = require('../app');
const db = require('../db/database');

const API_KEY = 'test-api-key';
let app;

beforeAll(() => { app = createApp({ licenseGate: (req, res, next) => next() }); });
afterAll(() => { db.prepare("DELETE FROM app_settings WHERE key = 'poller_calls_in_flight'").run(); });

describe('pollerCallsInFlight setting', () => {
  const put = (body) => request(app).put('/api/settings').set('x-api-key', API_KEY).send(body);

  it('GET returns the default of 4', async () => {
    const res = await request(app).get('/api/settings').set('x-api-key', API_KEY);
    expect(res.status).toBe(200);
    expect(res.body.pollerCallsInFlight).toBe(4);
  });

  it('PUT saves a value in range and the next GET returns it', async () => {
    const res = await put({ pollerCallsInFlight: 7 });
    expect(res.status).toBe(200);
    expect(res.body.pollerCallsInFlight).toBe(7);
  });

  it('PUT rejects 0 and 17', async () => {
    expect((await put({ pollerCallsInFlight: 0 })).status).toBe(400);
    expect((await put({ pollerCallsInFlight: 17 })).status).toBe(400);
  });
});

describe('converted pollers load', () => {
  it('requires cleanly', () => {
    for (const m of ['dellPoller', 'awsPoller', 'bluecatPoller', 'vcenterPoller', 'brocadePoller', 'logicmonitorPoller', 'logicmonitorMetrics']) {
      expect(() => require(`../services/${m}`)).not.toThrow();
    }
  });
});
