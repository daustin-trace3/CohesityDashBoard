/**
 * Per-platform AI Advisor backends (Pure, NetApp, Zerto, vCenter, Dell, Aria),
 * modeled on services/aiAdvisor.js via the shared services/platformAdvisor.js
 * engine. Verifies each advisor's REPORTS/gather/cache contract against an
 * empty test DB, and the dispatcher-mounted GET /advisor/:report route.
 *
 * Loaded via createRequire (not dynamic import) so the advisor modules and
 * app.js's own requires resolve to the SAME module instances — same pattern
 * as tests/platformPlugins.test.js.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { createRequire } from 'module';
import request from 'supertest';

// Force the LLM to read as unconfigured regardless of the developer's real
// .env (dotenv never overrides already-set vars) — these tests must never
// make a live network call.
process.env.OPENAI_API_KEY = '';
process.env.OPENAI_TOKEN = '';
process.env.GITHUB_MODELS_TOKEN = '';

const require = createRequire(import.meta.url);

const registry = require('../core/registry');
const pureManifest = require('../platforms/pure');
const netappManifest = require('../platforms/netapp');
const zertoManifest = require('../platforms/zerto');
const vcenterManifest = require('../platforms/vcenter');
const dellManifest = require('../platforms/dell');
const ariaManifest = require('../platforms/aria');
const { createApp } = require('../app');

const pureAdvisor = require('../services/advisors/pureAdvisor');
const netappAdvisor = require('../services/advisors/netappAdvisor');
const zertoAdvisor = require('../services/advisors/zertoAdvisor');
const vcenterAdvisor = require('../services/advisors/vcenterAdvisor');
const dellAdvisor = require('../services/advisors/dellAdvisor');
const ariaAdvisor = require('../services/advisors/ariaAdvisor');

const API_KEY = 'test-api-key';

const ADVISORS = {
  pure: pureAdvisor,
  netapp: netappAdvisor,
  zerto: zertoAdvisor,
  vcenter: vcenterAdvisor,
  dell: dellAdvisor,
  aria: ariaAdvisor,
};

describe('platform AI advisors: contract', () => {
  for (const [platform, advisor] of Object.entries(ADVISORS)) {
    describe(platform, () => {
      it('REPORTS is a non-empty array', () => {
        expect(Array.isArray(advisor.REPORTS)).toBe(true);
        expect(advisor.REPORTS.length).toBeGreaterThan(0);
      });

      it('every report gather() runs without throwing against the empty test DB', () => {
        for (const key of advisor.REPORTS) {
          expect(() => advisor.getCachedReport(key)).not.toThrow();
        }
      });

      it('getCachedReport of an unknown key returns null', () => {
        expect(advisor.getCachedReport('not_a_real_report')).toBeNull();
      });

      it('generateReport throws LLM_NOT_CONFIGURED when the LLM is unconfigured (no network call)', async () => {
        const key = advisor.REPORTS[0];
        await expect(advisor.generateReport(key)).rejects.toMatchObject({ code: 'LLM_NOT_CONFIGURED' });
      });

      it('generateReport throws BAD_REPORT for an unknown key', async () => {
        await expect(advisor.generateReport('not_a_real_report')).rejects.toMatchObject({ code: 'BAD_REPORT' });
      });
    });
  }
});

describe('platform AI advisors: dispatcher routes', () => {
  let app;

  beforeEach(() => {
    registry._reset();
    registry.init();
    registry.registerPlugin(pureManifest);
    registry.registerPlugin(netappManifest);
    registry.registerPlugin(zertoManifest);
    registry.registerPlugin(vcenterManifest);
    registry.registerPlugin(dellManifest);
    registry.registerPlugin(ariaManifest);
    app = createApp({ licenseGate: (req, res, next) => next() });
  });

  const slug = (key) => key.replace(/_/g, '-');

  it('GET /api/pure/advisor/:report -> 200 { enabled:false, report:null } on an empty DB', async () => {
    const key = pureAdvisor.REPORTS[0];
    const res = await request(app).get(`/api/pure/advisor/${slug(key)}`).set('x-api-key', API_KEY);
    expect(res.status).toBe(200);
    expect(res.body.enabled).toBe(false);
    expect(res.body.report).toBeNull();
  });

  it('GET /api/netapp/advisor/:report -> 200 { enabled:false, report:null } on an empty DB', async () => {
    const key = netappAdvisor.REPORTS[0];
    const res = await request(app).get(`/api/netapp/advisor/${slug(key)}`).set('x-api-key', API_KEY);
    expect(res.status).toBe(200);
    expect(res.body.enabled).toBe(false);
    expect(res.body.report).toBeNull();
  });

  it('GET /api/zerto/advisor/:report -> 200 { enabled:false, report:null } on an empty DB', async () => {
    const key = zertoAdvisor.REPORTS[0];
    const res = await request(app).get(`/api/zerto/advisor/${slug(key)}`).set('x-api-key', API_KEY);
    expect(res.status).toBe(200);
    expect(res.body.enabled).toBe(false);
    expect(res.body.report).toBeNull();
  });

  it('GET /api/vcenter/advisor/:report -> 200 { enabled:false, report:null } on an empty DB', async () => {
    const key = vcenterAdvisor.REPORTS[0];
    const res = await request(app).get(`/api/vcenter/advisor/${slug(key)}`).set('x-api-key', API_KEY);
    expect(res.status).toBe(200);
    expect(res.body.enabled).toBe(false);
    expect(res.body.report).toBeNull();
  });

  it('GET /api/dell/advisor/:report -> 200 { enabled:false, report:null } on an empty DB', async () => {
    const key = dellAdvisor.REPORTS[0];
    const res = await request(app).get(`/api/dell/advisor/${slug(key)}`).set('x-api-key', API_KEY);
    expect(res.status).toBe(200);
    expect(res.body.enabled).toBe(false);
    expect(res.body.report).toBeNull();
  });

  it('GET /api/aria/advisor/:report -> 200 { enabled:false, report:null } on an empty DB', async () => {
    const key = ariaAdvisor.REPORTS[0];
    const res = await request(app).get(`/api/aria/advisor/${slug(key)}`).set('x-api-key', API_KEY);
    expect(res.status).toBe(200);
    expect(res.body.enabled).toBe(false);
    expect(res.body.report).toBeNull();
  });

  it('GET /api/pure/advisor/:report -> 404 for an unknown report slug', async () => {
    const res = await request(app).get('/api/pure/advisor/not-a-real-report').set('x-api-key', API_KEY);
    expect(res.status).toBe(404);
  });
});
