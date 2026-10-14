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
const netbackupManifest = require('../platforms/netbackup');
const awsManifest = require('../platforms/aws');
const bluecatManifest = require('../platforms/bluecat');
const logicmonitorManifest = require('../platforms/logicmonitor');
const ariaopsManifest = require('../platforms/ariaops');
const brocadeManifest = require('../platforms/brocade');
const { createApp } = require('../app');

const pureAdvisor = require('../services/advisors/pureAdvisor');
const netappAdvisor = require('../services/advisors/netappAdvisor');
const zertoAdvisor = require('../services/advisors/zertoAdvisor');
const vcenterAdvisor = require('../services/advisors/vcenterAdvisor');
const dellAdvisor = require('../services/advisors/dellAdvisor');
const ariaAdvisor = require('../services/advisors/ariaAdvisor');
const netbackupAdvisor = require('../services/advisors/netbackupAdvisor');
const awsAdvisor = require('../services/advisors/awsAdvisor');
const bluecatAdvisor = require('../services/advisors/bluecatAdvisor');
const logicmonitorAdvisor = require('../services/advisors/logicmonitorAdvisor');
const ariaopsAdvisor = require('../services/advisors/ariaopsAdvisor');
const brocadeAdvisor = require('../services/advisors/brocadeAdvisor');
const estateAdvisor = require('../services/advisors/estateAdvisor');

const API_KEY = 'test-api-key';

const ADVISORS = {
  pure: pureAdvisor,
  netapp: netappAdvisor,
  zerto: zertoAdvisor,
  vcenter: vcenterAdvisor,
  dell: dellAdvisor,
  aria: ariaAdvisor,
  netbackup: netbackupAdvisor,
  aws: awsAdvisor,
  bluecat: bluecatAdvisor,
  logicmonitor: logicmonitorAdvisor,
  ariaops: ariaopsAdvisor,
  brocade: brocadeAdvisor,
  estate: estateAdvisor,
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

      it('every unscoped gather() executes its SQL and returns an object on the empty test DB', () => {
        for (const key of advisor.REPORTS) {
          if (advisor.SCOPED.includes(key)) continue;
          const out = advisor.gatherFor(key);
          expect(out, `${platform}/${key}`).toBeTruthy();
          expect(typeof out, `${platform}/${key}`).toBe('object');
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
    registry.registerPlugin(netbackupManifest);
    registry.registerPlugin(awsManifest);
    registry.registerPlugin(bluecatManifest);
    registry.registerPlugin(logicmonitorManifest);
    registry.registerPlugin(ariaopsManifest);
    registry.registerPlugin(brocadeManifest);
    app = createApp({ licenseGate: (req, res, next) => next() });
  });

  const slug = (key) => key.replace(/_/g, '-');

  it('GET /api/estate/advisor/:report -> 200 { enabled:false, report:null } on an empty DB (flat mount, not a plugin)', async () => {
    const key = estateAdvisor.REPORTS[0];
    const res = await request(app).get(`/api/estate/advisor/${slug(key)}`).set('x-api-key', API_KEY);
    expect(res.status).toBe(200);
    expect(res.body.enabled).toBe(false);
    expect(res.body.report).toBeNull();
  });

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

  it('GET /api/logicmonitor/advisor/:report -> 200 { enabled:false, report:null } on an empty DB', async () => {
    const key = logicmonitorAdvisor.REPORTS[0];
    const res = await request(app).get(`/api/logicmonitor/advisor/${slug(key)}`).set('x-api-key', API_KEY);
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

  it('GET /api/bluecat/advisor/:report -> 200 { enabled:false, report:null } on an empty DB', async () => {
    const key = bluecatAdvisor.REPORTS[0];
    const res = await request(app).get(`/api/bluecat/advisor/${slug(key)}`).set('x-api-key', API_KEY);
    expect(res.status).toBe(200);
    expect(res.body.enabled).toBe(false);
    expect(res.body.report).toBeNull();
  });

  it('GET /api/ariaops/advisor/:report -> 200 { enabled:false, report:null } on an empty DB', async () => {
    const key = ariaopsAdvisor.REPORTS[0];
    const res = await request(app).get(`/api/ariaops/advisor/${slug(key)}`).set('x-api-key', API_KEY);
    expect(res.status).toBe(200);
    expect(res.body.enabled).toBe(false);
    expect(res.body.report).toBeNull();
  });

  it('GET /api/brocade/advisor/:report -> 200 { enabled:false, report:null } on an empty DB', async () => {
    const key = brocadeAdvisor.REPORTS[0];
    const res = await request(app).get(`/api/brocade/advisor/${slug(key)}`).set('x-api-key', API_KEY);
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

  it('GET /api/netbackup/advisor/:report -> 200 { enabled:false, report:null } on an empty DB', async () => {
    const key = netbackupAdvisor.REPORTS[0];
    const res = await request(app).get(`/api/netbackup/advisor/${slug(key)}`).set('x-api-key', API_KEY);
    expect(res.status).toBe(200);
    expect(res.body.enabled).toBe(false);
    expect(res.body.report).toBeNull();
  });

  it('GET /api/aws/advisor/:report -> 200 { enabled:false, report:null } on an empty DB', async () => {
    const key = awsAdvisor.REPORTS[0];
    const res = await request(app).get(`/api/aws/advisor/${slug(key)}`).set('x-api-key', API_KEY);
    expect(res.status).toBe(200);
    expect(res.body.enabled).toBe(false);
    expect(res.body.report).toBeNull();
  });

  it('GET /api/pure/advisor/:report -> 404 for an unknown report slug', async () => {
    const res = await request(app).get('/api/pure/advisor/not-a-real-report').set('x-api-key', API_KEY);
    expect(res.status).toBe(404);
  });
});

describe('platform AI advisors: email route', () => {
  const db = require('../db/database');
  const { setSetting } = require('../services/settings');
  const alertNotifier = require('../services/alertNotifier');
  let app;
  const slug = (key) => key.replace(/_/g, '-');
  const SMTP_KEYS = ['smtp_host', 'smtp_from', 'smtp_recipients'];

  beforeEach(() => {
    registry._reset();
    registry.init();
    for (const m of [pureManifest, netappManifest, zertoManifest, vcenterManifest, dellManifest, ariaManifest,
      netbackupManifest, awsManifest, bluecatManifest, ariaopsManifest, brocadeManifest, logicmonitorManifest]) registry.registerPlugin(m);
    app = createApp({ licenseGate: (req, res, next) => next() });
    for (const k of SMTP_KEYS) setSetting(k, '');
    db.exec("DELETE FROM zerto_ai_reports WHERE report_key = 'dr_readiness'");
    db.exec("DELETE FROM ai_reports WHERE report_key = 'dr_readiness'");
    alertNotifier._reset();
  });

  for (const [platform, advisor] of Object.entries(ADVISORS)) {
    it(`POST /api/${platform}/advisor/:report/email is mounted and 404s with no cached report`, async () => {
      const key = advisor.REPORTS.find((k) => !advisor.isScoped(k));
      const res = await request(app).post(`/api/${platform}/advisor/${slug(key)}/email`).set('x-api-key', API_KEY).send({});
      expect(res.status).toBe(404);
      expect(res.body.error).toBe('No generated report to send. Run the report first.');
    });
  }

  it('409s when SMTP is not configured (dash slug resolves to the underscore key)', async () => {
    db.prepare("INSERT INTO zerto_ai_reports (report_key, model, content, generated_at) VALUES ('dr_readiness', 'm', '# DR', datetime('now'))").run();
    const res = await request(app).post('/api/zerto/advisor/dr-readiness/email').set('x-api-key', API_KEY).send({});
    expect(res.status).toBe(409);
    expect(res.body.error).toBe('SMTP is not configured. Set at least the server and from address under Global Settings > Alert Notifications.');
  });

  it('sends the cached report to the default alert list when SMTP has host + from', async () => {
    db.prepare("INSERT INTO zerto_ai_reports (report_key, model, content, generated_at) VALUES ('dr_readiness', 'm', '# DR <b>', datetime('now'))").run();
    setSetting('smtp_host', 'smtp.example.com');
    setSetting('smtp_from', 'icc@example.com');
    setSetting('smtp_recipients', 'ops@example.com');
    const sent = [];
    alertNotifier._setTransportFactory(() => ({ sendMail: async (m) => { sent.push(m); } }));
    const res = await request(app).post('/api/zerto/advisor/dr-readiness/email').set('x-api-key', API_KEY).send({});
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true, to: 'ops@example.com' });
    expect(sent).toHaveLength(1);
    expect(sent[0].subject).toBe('[ICC] Zerto AI Advisor - DR readiness report');
    expect(sent[0].html).toContain('# DR &lt;b&gt;');
    alertNotifier._reset();
    for (const k of SMTP_KEYS) setSetting(k, '');
  });

  it('Cohesity POST /api/cohesity/advisor/:report/email 404s with no report and 409s without SMTP', async () => {
    const none = await request(app).post('/api/cohesity/advisor/dr-readiness/email').set('x-api-key', API_KEY).send({});
    expect(none.status).toBe(404);
    expect(none.body.error).toBe('No generated report to send. Run the report first.');
    db.prepare("INSERT INTO ai_reports (report_key, model, content, generated_at) VALUES ('dr_readiness', 'm', '# DR', datetime('now'))").run();
    const res = await request(app).post('/api/cohesity/advisor/dr-readiness/email').set('x-api-key', API_KEY).send({});
    expect(res.status).toBe(409);
    expect(res.body.error).toMatch(/^SMTP is not configured/);
    db.exec("DELETE FROM ai_reports WHERE report_key = 'dr_readiness'");
  });
});
