/**
 * AI Advisor contracts (REPORTS/gather/cache) and the registry-dispatcher
 * -mounted advisor route pattern.
 *
 * This used to exercise the per-platform advisors (Pure, NetApp, Zerto,
 * vCenter, Dell, Aria, AWS) built on the shared services/platformAdvisor.js
 * engine, but those 9 platforms were removed from core in the 2026-08
 * pluginization campaign and now only exist as installable .iccplugin
 * packs (services/advisors/*.js deleted). Coverage is preserved two ways:
 *  - the REPORTS/gather/cache contract is exercised against cohesity's own
 *    advisor (services/aiAdvisor.js), which stays in core and follows the
 *    identical contract platformAdvisor.js was modeled on;
 *  - the registry-dispatcher-mounted route pattern (GET /api/:id/advisor/:report)
 *    is exercised with a minimal fake manifest built on the still-present
 *    services/platformAdvisor.js engine, since that engine is generic and
 *    not owned by any single platform.
 *
 * Loaded via createRequire (not dynamic import) so the advisor modules and
 * app.js's own requires resolve to the SAME module instances — same pattern
 * as tests/platformPlugins.test.js.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { createRequire } from 'module';
import express from 'express';
import request from 'supertest';

// Force the LLM to read as unconfigured regardless of the developer's real
// .env (dotenv never overrides already-set vars) — these tests must never
// make a live network call.
process.env.OPENAI_API_KEY = '';
process.env.OPENAI_TOKEN = '';
process.env.GITHUB_MODELS_TOKEN = '';

const require = createRequire(import.meta.url);

const registry = require('../core/registry');
const { createApp } = require('../app');
const { createPlatformAdvisor } = require('../services/platformAdvisor');

const cohesityAdvisor = require('../services/aiAdvisor');

const API_KEY = 'test-api-key';

const ADVISORS = {
  cohesity: cohesityAdvisor,
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

function makeFakeAdvisorManifest(id) {
  const table = `${id}_ai_reports`;
  return {
    id,
    name: `Fake Advisor ${id}`,
    apiVersion: registry.PLUGIN_API_VERSION,
    migrations: [
      {
        version: 1,
        up(db) {
          db.exec(`CREATE TABLE IF NOT EXISTS ${table} (
            report_key TEXT PRIMARY KEY, model TEXT, content TEXT, generated_at DATETIME
          )`);
        },
      },
    ],
    createRouter() {
      const advisor = createPlatformAdvisor({
        platform: id,
        feature: `${id} AI Advisor`,
        table,
        reports: {
          fake_report: { system: 'You are a test advisor.', gather: () => ({ ok: true }), noun: 'fake report' },
        },
      });
      const router = express.Router();
      const slugToKey = (slug) => String(slug).replace(/-/g, '_');
      router.get('/advisor/:report', (req, res) => {
        const key = slugToKey(req.params.report);
        if (!advisor.REPORTS.includes(key)) return res.status(404).json({ error: 'Unknown report.' });
        res.json({ enabled: advisor.isConfigured(), report: advisor.getCachedReport(key) });
      });
      return router;
    },
  };
}

describe('platform AI advisors: dispatcher routes', () => {
  let app;

  beforeEach(() => {
    registry._reset();
    registry.init();
    registry.registerPlugin(makeFakeAdvisorManifest('fakeadv'));
    app = createApp({ licenseGate: (req, res, next) => next() });
  });

  it('GET /api/<pluginId>/advisor/:report -> 200 { enabled:false, report:null } on an empty DB', async () => {
    const res = await request(app).get('/api/fakeadv/advisor/fake-report').set('x-api-key', API_KEY);
    expect(res.status).toBe(200);
    expect(res.body.enabled).toBe(false);
    expect(res.body.report).toBeNull();
  });

  it('GET /api/<pluginId>/advisor/:report -> 404 for an unknown report slug', async () => {
    const res = await request(app).get('/api/fakeadv/advisor/not-a-real-report').set('x-api-key', API_KEY);
    expect(res.status).toBe(404);
  });
});
