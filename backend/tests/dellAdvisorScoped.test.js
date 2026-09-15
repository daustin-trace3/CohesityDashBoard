/**
 * Dell AI Advisor: the six new fleet reports plus the scoped device_360
 * report and its dedicated routes. Modeled on tests/platformAdvisors.test.js
 * (createRequire so the advisor module and app.js's own require resolve to
 * the same instance, same registry/createApp/licenseGate-bypass pattern).
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { createRequire } from 'module';
import request from 'supertest';

// Force the LLM to read as unconfigured regardless of the developer's real
// .env (dotenv never overrides already-set vars) - these tests must never
// make a live network call.
process.env.OPENAI_API_KEY = '';
process.env.OPENAI_TOKEN = '';
process.env.GITHUB_MODELS_TOKEN = '';

const require = createRequire(import.meta.url);

const registry = require('../core/registry');
const dellManifest = require('../platforms/dell');
const { createApp } = require('../app');
const dellAdvisor = require('../services/advisors/dellAdvisor');

const API_KEY = 'test-api-key';

const NEW_FLEET_KEYS = [
  'power_thermal',
  'config_drift',
  'job_health',
  'hardware_log_forensics',
  'capacity_consolidation',
  'support_case_prep',
];

const slug = (key) => key.replace(/_/g, '-');

describe('dell advisor: new fleet reports registered', () => {
  it('every new fleet key is in dellAdvisor.REPORTS', () => {
    for (const key of NEW_FLEET_KEYS) {
      expect(dellAdvisor.REPORTS).toContain(key);
    }
  });

  it('dellAdvisor.SCOPED equals [\'device_360\']', () => {
    expect(dellAdvisor.SCOPED).toEqual(['device_360']);
  });

  it('dellAdvisor.isScoped is true only for device_360', () => {
    expect(dellAdvisor.isScoped('device_360')).toBe(true);
    for (const key of NEW_FLEET_KEYS) expect(dellAdvisor.isScoped(key)).toBe(false);
  });

  it('every new fleet report gather() runs without throwing against the empty test DB', () => {
    for (const key of NEW_FLEET_KEYS) {
      expect(() => dellAdvisor.getCachedReport(key)).not.toThrow();
    }
  });

  it('device_360 gather() requires a scope and returns null for an unknown one', () => {
    expect(dellAdvisor.getCachedReport('device_360')).toBeNull();
    expect(dellAdvisor.getCachedReport('device_360', { scope: 'NOPE' })).toBeNull();
  });
});

describe('dell advisor: dispatcher routes', () => {
  let app;

  beforeEach(() => {
    registry._reset();
    registry.init();
    registry.registerPlugin(dellManifest);
    app = createApp({ licenseGate: (req, res, next) => next() });
  });

  it('GET /api/dell/advisor/device-360/NOPE1234 -> 200 { enabled:false, report:null }', async () => {
    const res = await request(app).get('/api/dell/advisor/device-360/NOPE1234').set('x-api-key', API_KEY);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ enabled: false, report: null });
  });

  it('GET /api/dell/advisor/device-360 (generic route with the scoped key) -> 400', async () => {
    const res = await request(app).get('/api/dell/advisor/device-360').set('x-api-key', API_KEY);
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/device scope/i);
  });

  it('POST /api/dell/advisor/device-360 (generic route with the scoped key) -> 400', async () => {
    const res = await request(app).post('/api/dell/advisor/device-360').set('x-api-key', API_KEY);
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/device scope/i);
  });

  it('POST /api/dell/advisor/device-360/NOPE1234 -> 503 (LLM not configured comes before scope lookup)', async () => {
    const res = await request(app).post('/api/dell/advisor/device-360/NOPE1234').set('x-api-key', API_KEY);
    expect(res.status).toBe(503);
  });

  for (const key of NEW_FLEET_KEYS) {
    it(`GET /api/dell/advisor/${slug(key)} -> 200 { enabled:false, report:null } on an empty DB`, async () => {
      const res = await request(app).get(`/api/dell/advisor/${slug(key)}`).set('x-api-key', API_KEY);
      expect(res.status).toBe(200);
      expect(res.body.enabled).toBe(false);
      expect(res.body.report).toBeNull();
    });
  }
});
