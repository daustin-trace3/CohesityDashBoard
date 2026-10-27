/**
 * AWS FinOps routes and integrations (WP2): every new route against seeded rows, the metric param on the
 * Cost Explorer routes, budgets CRUD, the optimizer lifecycle, the allocation CSV, the capability policy,
 * the finops probe, FinOps config, the Ops card, search categories, the anonymizer block and the advisor
 * gathers. awsFinops functions are replaced with fakes returning the documented shapes so this suite is
 * independent of the collector (the routes call them through the module object).
 *
 * Loaded via createRequire so every module resolves the same db singleton as the routes.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createRequire } from 'module';
import express from 'express';
import request from 'supertest';

const require = createRequire(import.meta.url);

const db = require('../db/database');
const { runMigrations } = require('../core/migrations');
const awsMigrations = require('../db/migrations/aws');
const { encrypt } = require('../services/encryption');
const awsFinops = require('../services/awsFinops');
const awsApi = require('../services/awsApi');
const { setSetting, getSetting } = require('../services/settings');

const day = (offset) => new Date(Date.now() - offset * 86400000).toISOString().slice(0, 10);
const iso = (offset) => new Date(Date.now() - offset * 86400000).toISOString();

let app;
let accountId;
const saved = {};
const FAKES = {
  capabilityRows: () => [
    { capability: 'forecast', status: 'denied', error: 'not authorized to perform: ce:GetCostForecast', iamActions: ['ce:GetCostForecast'], requests: 1, lastOkAt: null, lastCheckedAt: iso(0) },
    { capability: 'sp_utilization', status: 'ok', error: null, iamActions: ['ce:GetSavingsPlansUtilization'], requests: 2, lastOkAt: iso(0), lastCheckedAt: iso(0) },
    { capability: 'anomalies', status: 'ok', error: null, iamActions: ['ce:GetAnomalies'], requests: 2, lastOkAt: iso(0), lastCheckedAt: iso(0) },
    { capability: 'ri_coverage', status: 'ok', error: null, iamActions: ['ce:GetReservationCoverage'], requests: 1, lastOkAt: iso(0), lastCheckedAt: iso(0) },
    { capability: 'cost_resources', status: 'denied', error: 'denied', iamActions: ['ce:GetCostAndUsageWithResources'], requests: 40, lastOkAt: null, lastCheckedAt: iso(0) },
  ],
  missingActions: () => ['ce:GetCostForecast', 'ce:GetCostAndUsageWithResources'],
  buildFinopsOverview: ({ metric, accountId: acct }) => ({
    metric, amortizedFrom: day(30), month: day(0).slice(0, 7), accountId: acct,
    kpis: { mtdUsd: 12.5 }, mix: [], trend: [], topMovers: [], budgets: [], anomalies: [],
  }),
  evaluateBudgets: () => [{ budgetId: 1, month: day(0).slice(0, 7), state: 'ok', actualUsd: 1, forecastUsd: 2 }],
  allocationSummary: ({ rows, costRows }) => {
    const total = rows.reduce((a, r) => a + r.usd, 0);
    const unalloc = rows.filter((r) => r.value === '').reduce((a, r) => a + r.usd, 0);
    const cost = costRows.reduce((a, r) => a + r.usd, 0);
    return {
      totalUsd: total, allocatedUsd: total - unalloc, unallocatedUsd: unalloc, unallocatedPct: total ? (unalloc / total) * 100 : 0,
      coverageGapPct: cost ? ((cost - total) / cost) * 100 : 0, values: [], days: [],
    };
  },
  unitEconomics: ({ metric, from, to }) => ({ bedrock: [], ec2: [], s3: { usd: 1 }, lightsail: { usd: 2 }, echo: { metric, from, to } }),
  sendFinopsDigest: async () => ({ ok: true, recipients: ['a@example.com'] }),
};

beforeAll(() => {
  runMigrations(db, 'aws', awsMigrations);
  setSetting('platform_aws_enabled', '1');
  for (const [k, fn] of Object.entries(FAKES)) { saved[k] = awsFinops[k]; awsFinops[k] = fn; }
  const info = db.prepare(`
    INSERT INTO aws_accounts (name, access_key_id, encrypted_credentials, region, polling_interval_minutes)
    VALUES ('finops-acct', 'AKIAFINOPSTEST', ?, 'us-east-2', 10)
  `).run(encrypt(JSON.stringify({ secretAccessKey: 'shh' })));
  accountId = Number(info.lastInsertRowid);
  const awsRouter = require('../routes/aws');
  app = express();
  app.use(express.json());
  app.use('/api/aws', awsRouter);
  app.use((err, req, res, next) => { res.status(err.status || 500).json({ error: err.message }); }); // eslint-disable-line no-unused-vars
});

afterAll(() => {
  for (const [k, fn] of Object.entries(saved)) awsFinops[k] = fn;
});

describe('Cost Explorer routes: metric param', () => {
  beforeAll(() => {
    const ins = db.prepare('INSERT INTO aws_cost_daily (account_id, day, service, amount_usd, amortized_usd) VALUES (?, ?, ?, ?, ?)');
    ins.run(accountId, day(0), 'Svc A', 10, 4);
    ins.run(accountId, day(0), 'Svc B', 6, null); // captured before v11: no amortized value
    ins.run(accountId, day(1), 'Svc A', 8, 3);
    db.prepare('INSERT INTO aws_cost_usage_daily (account_id, day, service, usage_type, amount_usd, amortized_usd, usage_qty, usage_unit) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
      .run(accountId, day(0), 'Svc A', 'USE2-BoxUsage:m5.large', 0, 2.5, 48, 'Hrs');
    db.prepare('INSERT INTO aws_cost_usage_daily (account_id, day, service, usage_type, amount_usd) VALUES (?, ?, ?, ?, ?)')
      .run(accountId, day(0), 'Svc B', 'legacy-type', 1);
    db.prepare('INSERT INTO aws_cost_instance_type_daily (account_id, day, instance_type, amount_usd, amortized_usd) VALUES (?, ?, ?, ?, ?)')
      .run(accountId, day(0), 'm5.large', 0, 2.5);
  });

  const ADDED = ['metric', 'amortizedFrom'];
  const strip = (body) => Object.fromEntries(Object.entries(body).filter(([k]) => !ADDED.includes(k)));

  it('GET /costs: omitted metric equals metric=unblended and matches the raw unblended rows', async () => {
    const before = await request(app).get('/api/aws/costs').query({ days: 30, accountId });
    const explicit = await request(app).get('/api/aws/costs').query({ days: 30, accountId, metric: 'unblended' });
    expect(before.status).toBe(200);
    expect(explicit.body).toEqual(before.body);
    // The same expectation built from the seeded rows, independent of the route.
    const rows = db.prepare('SELECT day, service, amount_usd FROM aws_cost_daily WHERE account_id = ? ORDER BY day ASC').all(accountId);
    const mtd = rows.filter((r) => r.day >= `${day(0).slice(0, 7)}-01`).reduce((a, r) => a + r.amount_usd, 0);
    expect(strip(before.body).mtdUsd).toBe(mtd);
    expect(strip(before.body).days.flatMap((d) => d.services.map((s) => s.amountUsd)).sort()).toEqual(rows.map((r) => r.amount_usd).sort());
    expect(before.body.metric).toBe('unblended');
    expect(before.body.amortizedFrom).toBe(day(1));
  });

  it('GET /costs: metric=amortized uses COALESCE(amortized_usd, amount_usd)', async () => {
    const res = await request(app).get('/api/aws/costs').query({ days: 30, accountId, metric: 'amortized' });
    expect(res.status).toBe(200);
    expect(res.body.metric).toBe('amortized');
    const today = res.body.days.find((d) => d.day === day(0));
    expect(today.totalUsd).toBe(4 + 6); // Svc A amortized, Svc B falls back to unblended
    const svcB = res.body.byService.find((s) => s.service === 'Svc B');
    expect(svcB.mtdUsd).toBe(6);
    expect((await request(app).get('/api/aws/costs').query({ metric: 'bogus' })).status).toBe(400);
  });

  it('GET /costs/usage-types and /costs/instance-types honor metric and carry usage quantities', async () => {
    const unb = await request(app).get('/api/aws/costs/usage-types').query({ accountId });
    const am = await request(app).get('/api/aws/costs/usage-types').query({ accountId, metric: 'amortized' });
    const box = (b) => b.rows.find((r) => r.usageType === 'USE2-BoxUsage:m5.large');
    expect(box(unb.body).totalUsd).toBe(0);
    expect(box(am.body).totalUsd).toBe(2.5);
    expect(box(am.body)).toEqual(expect.objectContaining({ usageQty: 48, usageUnit: 'Hrs' }));
    const legacy = unb.body.rows.find((r) => r.usageType === 'legacy-type');
    expect(legacy.usageQty).toBeNull();
    expect(legacy.usageUnit).toBeNull();
    expect(am.body.metric).toBe('amortized');

    const itU = await request(app).get('/api/aws/costs/instance-types').query({ accountId });
    const itA = await request(app).get('/api/aws/costs/instance-types').query({ accountId, metric: 'amortized' });
    expect(itU.body.rows.find((r) => r.instanceType === 'm5.large').totalUsd).toBe(0);
    expect(itA.body.rows.find((r) => r.instanceType === 'm5.large').totalUsd).toBe(2.5);
  });
});

describe('FinOps GET routes answer with the documented keys', () => {
  beforeAll(() => {
    const ins = db.prepare('INSERT INTO aws_cost_alloc_daily (account_id, day, dimension, key, value, service, amount_usd, amortized_usd) VALUES (?, ?, ?, ?, ?, ?, ?, ?)');
    ins.run(accountId, day(1), 'tag', 'Environment', 'prod', 'Svc A', 6, 5);
    ins.run(accountId, day(1), 'tag', 'Environment', '', 'Svc A', 2, 1.5);
    ins.run(accountId, day(2), 'tag', 'Environment', 'dev', 'Svc B', 3, 3);
    db.prepare('INSERT INTO aws_sp_utilization_daily (account_id, day, utilization_pct, commitment_usd, used_usd, unused_usd, net_savings_usd, on_demand_equivalent_usd) VALUES (?, ?, 90, 72, 64.8, 7.2, 18, 83)').run(accountId, day(2));
    db.prepare('INSERT INTO aws_sp_coverage_daily (account_id, day, coverage_pct, covered_usd, on_demand_usd, total_usd) VALUES (?, ?, 60, 90, 60, 150)').run(accountId, day(2));
    db.prepare('INSERT INTO aws_ri_utilization_daily (account_id, day, utilization_pct, purchased_hours, used_hours, unused_hours, net_savings_usd) VALUES (?, ?, 80, 100, 80, 20, 5)').run(accountId, day(2));
    db.prepare(`INSERT INTO aws_savings_plans (account_id, sp_arn, sp_type, payment_option, term, hourly_commitment_usd, region, instance_family, start_at, end_at, utilization_pct, net_savings_usd)
                VALUES (?, 'arn:aws:savingsplans::1:savingsplan/sp-abc', 'Compute', 'No Upfront', '1yr', 3, NULL, NULL, ?, ?, 93, 100)`).run(accountId, iso(300), iso(-20));
    db.prepare(`INSERT INTO aws_optimizer_recommendations (account_id, source, resource_type, resource_id, resource_name, finding, current_config, recommended_config, est_monthly_savings_usd)
                VALUES (?, 'ce-savings-plan', 'savings-plan', 'COMPUTE_SP|ONE_YEAR|NO_UPFRONT', 'Compute SP', 'purchase-savings-plan', 'on-demand $100/mo', '$1/h', 50)`).run(accountId);
    const anom = db.prepare(`INSERT INTO aws_cost_anomalies (account_id, anomaly_id, source, monitor_name, scope, scope_key, start_day, end_day, actual_usd, expected_usd, impact_usd, impact_pct, root_causes_json, status)
                             VALUES (?, ?, ?, ?, 'service', ?, ?, ?, 90, 40, 50, 125, ?, ?)`);
    anom.run(accountId, 'a-open', 'aws', 'Services monitor', 'Svc A', day(2), null, JSON.stringify([{ service: 'Svc A' }]), 'open');
    anom.run(accountId, 'a-closed', 'icc', null, 'Svc B', day(40), day(38), '[]', 'closed');
    setSetting('aws_finops_anomaly_monitors', JSON.stringify([{ monitorArn: 'arn:m', name: 'Services monitor', type: 'DIMENSIONAL', dimension: 'SERVICE' }]));
    setSetting('aws_finops_tag_keys_seen', JSON.stringify(['Environment', 'CostCenter']));
    const mb = new Date();
    const start = `${mb.toISOString().slice(0, 7)}-01`;
    db.prepare(`INSERT INTO aws_cost_forecast (account_id, scope, metric, period_start, period_end, generated_on, mean_usd, lower_usd, upper_usd, source)
                VALUES (?, 'total', 'amortized', ?, ?, ?, 1000, 900, 1100, 'ce')`).run(accountId, start, start, day(1));
    db.prepare(`INSERT INTO aws_cost_forecast (account_id, scope, metric, period_start, period_end, generated_on, mean_usd, lower_usd, upper_usd, source)
                VALUES (?, 'total', 'amortized', ?, ?, ?, 1100, 990, 1210, 'ce')`).run(accountId, start, start, day(0));
  });

  it('GET /finops/overview adds capabilities and capture info to the collector body', async () => {
    const res = await request(app).get('/api/aws/finops/overview').query({ metric: 'unblended', accountId });
    expect(res.status).toBe(200);
    expect(res.body.metric).toBe('unblended');
    expect(res.body.accountId).toBe(accountId);
    expect(res.body).toEqual(expect.objectContaining({ kpis: expect.any(Object), capabilities: expect.any(Array), lastCaptureRequests: 6 }));
    expect('lastCaptureAt' in res.body).toBe(true);
    expect((await request(app).get('/api/aws/finops/overview')).body.metric).toBe('amortized'); // setting default
  });

  it('GET /finops/allocation summarises one key, accepts a blank key and flags the coverage gap', async () => {
    const res = await request(app).get('/api/aws/finops/allocation').query({ dimension: 'tag', key: 'Environment', days: 30, metric: 'unblended' });
    expect(res.status).toBe(200);
    expect(res.body).toEqual(expect.objectContaining({
      dimension: 'tag', key: 'Environment', metric: 'unblended', totalUsd: 11, unallocatedUsd: 2,
      keysAvailable: expect.objectContaining({ tag: expect.arrayContaining(['Environment', 'CostCenter']), cost_category: [], linked_account: [] }),
    }));
    expect(res.body.range).toEqual(expect.objectContaining({ days: 30 }));
    expect(typeof res.body.coverageGapFlag).toBe('boolean');
    const blank = await request(app).get('/api/aws/finops/allocation').query({ days: 30 });
    expect(blank.status).toBe(200);
    expect(blank.body.key).toBeTruthy(); // adopts the first available key
    expect(blank.body.keysAvailable.tag.length).toBeGreaterThan(0);
    expect((await request(app).get('/api/aws/finops/allocation').query({ dimension: 'nope' })).status).toBe(400);
    expect((await request(app).get('/api/aws/finops/allocation').query({ from: '2026-02-31', to: '2026-03-01' })).status).toBe(400);
  });

  it('GET /finops/allocation/export.csv is text/csv with a header row; a blank key is 400', async () => {
    const res = await request(app).get('/api/aws/finops/allocation/export.csv').query({ dimension: 'tag', key: 'Environment', days: 30, metric: 'unblended' });
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toMatch(/text\/csv/);
    expect(res.headers['content-disposition']).toMatch(/attachment; filename="aws-allocation-Environment-/);
    const lines = res.text.trim().split('\r\n');
    expect(lines[0]).toBe('Day,Dimension,Key,Value,Service,Cost USD (unblended)');
    expect(lines).toHaveLength(4);
    expect(lines.some((l) => l.includes('(unallocated)'))).toBe(true);
    expect((await request(app).get('/api/aws/finops/allocation/export.csv').query({ days: 30 })).status).toBe(400);
  });

  it('GET /finops/commitments returns plans with expiry, utilization, coverage, reservations and sp/ri capabilities only', async () => {
    const res = await request(app).get('/api/aws/finops/commitments').query({ days: 30 });
    expect(res.status).toBe(200);
    const sp = res.body.savingsPlans;
    expect(sp.utilization).toHaveLength(1);
    expect(sp.coverage).toHaveLength(1);
    expect(sp.plans[0]).toEqual(expect.objectContaining({ arnTail: 'sp-abc', daysToExpiry: 20, hourlyCommitmentUsd: 3 }));
    expect(sp.summary).toEqual(expect.objectContaining({ avgUtilizationPct: 90, avgCoveragePct: 60, unusedUsd: 7.2, netSavingsUsd: 18 }));
    expect(sp.recommendations[0]).toEqual(expect.objectContaining({ source: 'ce-savings-plan', key: 'ce-savings-plan|purchase-savings-plan|COMPUTE_SP|ONE_YEAR|NO_UPFRONT', state: expect.objectContaining({ status: 'open' }) }));
    expect(res.body.reservations.utilization).toHaveLength(1);
    expect(res.body.capabilities.map((c) => c.capability).sort()).toEqual(['ri_coverage', 'sp_utilization']);
  });

  it('GET /finops/anomalies filters by status and source and parses root causes', async () => {
    const all = await request(app).get('/api/aws/finops/anomalies').query({ days: 90 });
    expect(all.status).toBe(200);
    expect(all.body.anomalies.map((a) => a.anomalyId).sort()).toEqual(['a-closed', 'a-open']);
    const open = await request(app).get('/api/aws/finops/anomalies').query({ status: 'open', source: 'aws', days: 30 });
    expect(open.body.anomalies).toHaveLength(1);
    expect(open.body.anomalies[0]).toEqual(expect.objectContaining({ source: 'aws', status: 'open', rootCauses: [{ service: 'Svc A' }], impactUsd: 50 }));
    expect(open.body.monitors).toEqual([{ monitorArn: 'arn:m', name: 'Services monitor', type: 'DIMENSIONAL', dimension: 'SERVICE' }]);
    expect(open.body.rule).toEqual({ pct: 30, floorUsd: 5, baselineDays: 7, clearDays: 2 });
    expect(open.body.capabilities.map((c) => c.capability)).toEqual(['anomalies']);
    expect((await request(app).get('/api/aws/finops/anomalies').query({ status: 'bad' })).status).toBe(400);
  });

  it('GET /finops/forecast returns the newest current row and the month history', async () => {
    const res = await request(app).get('/api/aws/finops/forecast');
    expect(res.status).toBe(200);
    expect(res.body.current).toEqual(expect.objectContaining({ meanUsd: 1100, lowerUsd: 990, upperUsd: 1210, source: 'ce' }));
    expect(res.body.history.map((h) => h.meanUsd)).toEqual([1000, 1100]);
  });

  it('GET /finops/unit-economics passes the collector result through with the range', async () => {
    const res = await request(app).get('/api/aws/finops/unit-economics').query({ from: '2026-03-01', to: '2026-03-10', metric: 'unblended' });
    expect(res.status).toBe(200);
    expect(res.body).toEqual(expect.objectContaining({ metric: 'unblended', bedrock: [], s3: { usd: 1 } }));
    expect(res.body.echo).toEqual({ metric: 'unblended', from: '2026-03-01', to: '2026-03-10' });
    expect(res.body.range).toEqual(expect.objectContaining({ days: 10, fromDay: '2026-03-01', toDay: '2026-03-10' }));
  });

  it('GET /finops/capabilities lists the policy for the missing actions only', async () => {
    const res = await request(app).get('/api/aws/finops/capabilities');
    expect(res.status).toBe(200);
    expect(res.body.capabilities).toHaveLength(5);
    expect(res.body.lastCaptureRequests).toBe(6); // cost_resources is counted apart
    expect(res.body.estimatedDailyUsd).toBe(0.06);
    expect(res.body.missingActions).toEqual(['ce:GetCostForecast', 'ce:GetCostAndUsageWithResources']);
    expect(res.body.policy).toEqual({
      Version: '2012-10-17',
      Statement: [{ Effect: 'Allow', Action: ['ce:GetCostForecast', 'ce:GetCostAndUsageWithResources'], Resource: '*' }],
    });
  });

  it('GET /overview cost gains the forecast, open anomaly count and budget state', async () => {
    const res = await request(app).get('/api/aws/overview');
    expect(res.status).toBe(200);
    expect(res.body.cost).toEqual(expect.objectContaining({
      forecastUsd: 1100, forecastSource: 'ce', openAnomalies: 1, budgetState: { worst: null, count: 0 },
    }));
  });
});

describe('Budgets', () => {
  const good = { name: 'Total cap', scopeType: 'total', amountUsd: 5000 };
  let id;

  it('creates, evaluates synchronously, lists with status and rejects bad input', async () => {
    let evaluated = 0;
    const real = awsFinops.evaluateBudgets;
    awsFinops.evaluateBudgets = () => { evaluated += 1; return real(); };
    try {
      const res = await request(app).post('/api/aws/finops/budgets').send(good);
      expect(res.status).toBe(201);
      expect(evaluated).toBe(1);
      expect(res.body.budget).toEqual(expect.objectContaining({
        name: 'Total cap', scopeType: 'total', amountUsd: 5000, warnPct: 80, critPct: 100, forecastAlert: true, enabled: true, status: null,
      }));
      id = res.body.budget.id;
    } finally { awsFinops.evaluateBudgets = real; }

    db.prepare("INSERT INTO aws_budget_status (budget_id, month, actual_usd, forecast_usd, forecast_source, pct_actual, pct_forecast, state) VALUES (?, ?, 100, 200, 'linear', 2, 4, 'ok')")
      .run(id, new Date().toISOString().slice(0, 7));
    const list = await request(app).get('/api/aws/finops/budgets');
    expect(list.status).toBe(200);
    const row = list.body.budgets.find((b) => b.id === id);
    expect(row.status).toEqual(expect.objectContaining({ actualUsd: 100, forecastUsd: 200, pctActual: 2, state: 'ok' }));
    expect(list.body.scopes).toEqual(expect.objectContaining({ services: expect.any(Array), tagKeys: expect.any(Array), tagValues: expect.any(Object), accounts: expect.any(Array) }));
    expect(list.body.scopes.tagValues.Environment).toEqual(expect.arrayContaining(['prod', 'dev']));

    const bad = (body) => request(app).post('/api/aws/finops/budgets').send(body);
    expect((await bad({ ...good, name: '' })).status).toBe(400);
    expect((await bad({ ...good, name: 'x', amountUsd: 0 })).status).toBe(400);
    expect((await bad({ ...good, name: 'x', scopeType: 'nope' })).status).toBe(400);
    expect((await bad({ ...good, name: 'x', warnPct: 90, critPct: 80 })).status).toBe(400);
    expect((await bad({ name: 'x', scopeType: 'service', amountUsd: 10 })).status).toBe(400);
    expect((await bad({ name: 'x', scopeType: 'tag', scopeKey: 'Environment', amountUsd: 10 })).status).toBe(400);
    expect((await bad({ name: 'x', scopeType: 'account', scopeKey: 'abc', amountUsd: 10 })).status).toBe(400);
    expect((await bad(good)).status).toBe(409);
  });

  it('updates (partial body), 404s unknown ids, 409s a name clash and deletes with 204', async () => {
    const upd = await request(app).put(`/api/aws/finops/budgets/${id}`).send({ amountUsd: 6000, enabled: false, notes: 'raised' });
    expect(upd.status).toBe(200);
    expect(upd.body.budget).toEqual(expect.objectContaining({ amountUsd: 6000, enabled: false, notes: 'raised', name: 'Total cap' }));
    expect((await request(app).put('/api/aws/finops/budgets/99999').send({ amountUsd: 1 })).status).toBe(404);
    const other = await request(app).post('/api/aws/finops/budgets').send({ name: 'Svc A cap', scopeType: 'service', scopeValue: 'Svc A', amountUsd: 100 });
    expect(other.status).toBe(201);
    expect((await request(app).put(`/api/aws/finops/budgets/${other.body.budget.id}`).send({ name: 'Total cap' })).status).toBe(409);
    expect((await request(app).put(`/api/aws/finops/budgets/${id}`).send({ critPct: 10 })).status).toBe(400);

    const ledger = db.prepare("SELECT item, change_type FROM config_changes WHERE platform = 'aws' AND scope = 'finops' AND system = 'budgets'").all();
    expect(ledger.some((l) => l.item === 'budget:Svc A cap' && l.change_type === 'added')).toBe(true);

    expect((await request(app).delete(`/api/aws/finops/budgets/${other.body.budget.id}`)).status).toBe(204);
    expect((await request(app).delete(`/api/aws/finops/budgets/${other.body.budget.id}`)).status).toBe(404);
    const removed = db.prepare("SELECT 1 FROM config_changes WHERE platform = 'aws' AND system = 'budgets' AND item = 'budget:Svc A cap' AND change_type = 'removed'").get();
    expect(removed).toBeTruthy();
    expect(db.prepare('SELECT COUNT(*) AS n FROM aws_budget_status WHERE budget_id = ?').get(other.body.budget.id).n).toBe(0);
  });

  it('POST /finops/budgets/evaluate answers 202 with the count', async () => {
    const res = await request(app).post('/api/aws/finops/budgets/evaluate');
    expect(res.status).toBe(202);
    expect(res.body).toEqual({ evaluated: 1 });
  });
});

describe('Optimizer lifecycle', () => {
  const rec = { source: 'heuristic', finding: 'ebs-unattached', resourceId: 'vol-lifecycle' };
  const key = 'heuristic|ebs-unattached|vol-lifecycle';

  beforeAll(() => {
    db.prepare(`INSERT INTO aws_optimizer_recommendations (account_id, source, resource_type, resource_id, resource_name, finding, est_monthly_savings_usd)
                VALUES (?, ?, 'ebs', ?, 'vol-lifecycle', ?, 25)`).run(accountId, rec.source, rec.resourceId, rec.finding);
  });

  it('rows carry key and state, status filter and totals work', async () => {
    const all = await request(app).get('/api/aws/optimizer').query({ accountId });
    expect(all.status).toBe(200);
    const row = all.body.recommendations.find((r) => r.key === key);
    expect(row.state).toEqual({ status: 'open', note: null, updatedAt: null, realizedUsd: null });
    expect(all.body.totals.byStatus).toEqual(expect.objectContaining({ open: expect.any(Number), accepted: 0, dismissed: 0, done: 0 }));
    expect(all.body.totals.realized90dUsd).toBe(0);
    expect(all.body.totals.count).toBeGreaterThan(0);
    expect((await request(app).get('/api/aws/optimizer').query({ status: 'bad' })).status).toBe(400);
  });

  it('POST /optimizer/state round-trips accepted then done (books the estimate) and 404s an unknown key', async () => {
    const acc = await request(app).post('/api/aws/optimizer/state').send({ key, status: 'accepted', note: 'next window' });
    expect(acc.status).toBe(200);
    expect(acc.body.state).toEqual(expect.objectContaining({ key, status: 'accepted', note: 'next window', realizedUsd: null }));
    const done = await request(app).post('/api/aws/optimizer/state').send({ key, status: 'done' });
    expect(done.body.state).toEqual(expect.objectContaining({ status: 'done', note: 'next window', realizedUsd: 25 }));
    const st = db.prepare('SELECT * FROM aws_recommendation_state WHERE rec_key = ?').get(key);
    expect(st).toEqual(expect.objectContaining({ resolved_by: 'user', realized_usd: 25, updated_by: 'user' }));

    const open = await request(app).get('/api/aws/optimizer').query({ accountId, status: 'done' });
    expect(open.body.recommendations.map((r) => r.key)).toEqual([key]);
    expect(open.body.totals.byStatus.done).toBe(1);
    expect(open.body.totals.realized90dUsd).toBe(25);

    const reopen = await request(app).post('/api/aws/optimizer/state').send({ key, status: 'open' });
    expect(reopen.body.state.realizedUsd).toBeNull();
    expect((await request(app).post('/api/aws/optimizer/state').send({ key: 'nope|nope|nope', status: 'open' })).status).toBe(404);
    expect((await request(app).post('/api/aws/optimizer/state').send({ key, status: 'bogus' })).status).toBe(400);
    expect((await request(app).post('/api/aws/optimizer/state').send({ key, status: 'open', note: 'x'.repeat(501) })).status).toBe(400);
  });
});

describe('Refresh, digest, probe', () => {
  it('POST /finops/refresh clears the FinOps and cost stamps on the elected row and answers 202', async () => {
    db.prepare("UPDATE aws_accounts SET last_finops_capture_at = datetime('now'), last_cost_capture_at = datetime('now') WHERE id = ?").run(accountId);
    const res = await request(app).post('/api/aws/finops/refresh');
    expect(res.status).toBe(202);
    const row = db.prepare('SELECT last_finops_capture_at AS c, last_cost_capture_at AS k FROM aws_accounts WHERE id = ?').get(accountId);
    expect(row.c).toBeNull();
    expect(row.k).toBeNull();
  });

  it('POST /finops/digest/send answers 202 with recipients, 503 when SMTP is not configured, 500 on other errors', async () => {
    const ok = await request(app).post('/api/aws/finops/digest/send');
    expect(ok.status).toBe(202);
    expect(ok.body).toEqual({ ok: true, recipients: ['a@example.com'] });
    const real = awsFinops.sendFinopsDigest;
    try {
      awsFinops.sendFinopsDigest = async () => { const e = new Error('SMTP is not configured'); e.code = 'SMTP_NOT_CONFIGURED'; throw e; };
      const no = await request(app).post('/api/aws/finops/digest/send');
      expect(no.status).toBe(503);
      expect(no.body.error).toMatch(/SMTP/);
      awsFinops.sendFinopsDigest = async () => { throw new Error('boom'); };
      expect((await request(app).post('/api/aws/finops/digest/send')).status).toBe(500);
    } finally { awsFinops.sendFinopsDigest = real; }
  });

  it('a thrown collector error becomes a plain 500', async () => {
    const real = awsFinops.capabilityRows;
    try {
      awsFinops.capabilityRows = () => { throw new Error('not implemented'); };
      expect((await request(app).get('/api/aws/finops/capabilities')).status).toBe(500);
    } finally { awsFinops.capabilityRows = real; }
  });

  it('GET /accounts/:id/probe?service=finops runs every fetcher once, records ok and denied, stamps nothing', async () => {
    const names = ['fetchCostAllocationTags', 'fetchCostAndUsageGrouped', 'fetchLinkedAccountValues', 'fetchCostForecast',
      'fetchSavingsPlansUtilization', 'fetchSavingsPlansUtilizationDetails', 'fetchSavingsPlansCoverage', 'fetchReservationUtilization',
      'fetchReservationCoverage', 'fetchAnomalyMonitors', 'fetchAnomalies', 'fetchRightsizingRecommendations',
      'fetchSavingsPlansPurchaseRecommendation'];
    const before = {};
    const calls = [];
    for (const n of names) {
      before[n] = awsApi[n];
      awsApi[n] = async () => { calls.push(n); return { rows: [{ n }, { n }, { n }], requests: 1 }; };
    }
    const beforeClassify = awsApi.classifyCeError;
    awsApi.fetchReservationCoverage = async () => { throw Object.assign(new Error('User is not authorized to perform: ce:GetReservationCoverage'), { name: 'AccessDeniedException' }); };
    awsApi.classifyCeError = () => 'denied';
    setSetting('aws_finops_tag_keys', JSON.stringify(['Environment']));
    try {
      const stamp = db.prepare('SELECT last_finops_capture_at AS a, last_cost_capture_at AS b FROM aws_accounts WHERE id = ?').get(accountId);
      const res = await request(app).get(`/api/aws/accounts/${accountId}/probe`).query({ service: 'finops' });
      expect(res.status).toBe(200);
      expect(res.body.service).toBe('finops');
      const raw = res.body.raw;
      expect(Object.keys(raw).sort()).toEqual(['anomalies', 'cost_tags', 'forecast', 'linked_accounts', 'ri_coverage', 'ri_utilization',
        'rightsizing', 'sp_coverage', 'sp_recommendation', 'sp_utilization', 'tag_keys']);
      expect(raw.tag_keys).toEqual({ ok: true, status: 'ok', sample: { items: [{ n: 'fetchCostAllocationTags' }, { n: 'fetchCostAllocationTags' }], _count: 3 } });
      expect(raw.ri_coverage).toEqual(expect.objectContaining({ ok: false, status: 'denied' }));
      expect(raw.ri_coverage.error).toMatch(/not authorized/);
      expect(raw.sp_utilization.sample.utilization._count).toBe(3);
      expect(db.prepare('SELECT last_finops_capture_at AS a, last_cost_capture_at AS b FROM aws_accounts WHERE id = ?').get(accountId)).toEqual(stamp);
    } finally {
      for (const n of names) awsApi[n] = before[n];
      awsApi.classifyCeError = beforeClassify;
    }
    expect(calls).toContain('fetchAnomalies');
  });
});

describe('FinOps config', () => {
  it('GET returns every FinOps key with defaults and a string array for tagKeysSeen', async () => {
    const res = await request(app).get('/api/aws/config');
    expect(res.status).toBe(200);
    expect(res.body).toEqual(expect.objectContaining({
      costSpikePct: 30, finopsMetric: 'amortized', finopsLinkedAccounts: 'auto', anomalyPct: 30, anomalyFloorUsd: 5,
      anomalyBaselineDays: 7, anomalyClearDays: 2, spUtilWarnPct: 80, spExpiryWarnDays: 30, priceGp2ToGp3PerGb: 0.02,
      priceEbsGp2PerGb: 0.1, priceEbsGp3PerGb: 0.08, priceNatGatewayMonth: 32.85, finopsDigestEnabled: false,
      finopsDigestRecipients: '', finopsDigestWeekday: 1, tagKeysSeen: ['Environment', 'CostCenter'],
    }));
    expect(Array.isArray(res.body.finopsTagKeys)).toBe(true);
  });

  it('PUT round-trips every key, ignores tagKeysSeen, requires costSpikePct and rejects out-of-range values', async () => {
    const body = {
      costSpikePct: 40, finopsMetric: 'unblended', finopsTagKeys: ['Environment', ' Team ', 'Environment'], finopsLinkedAccounts: 'on',
      anomalyPct: 45, anomalyFloorUsd: 7.5, anomalyBaselineDays: 10, anomalyClearDays: 3, spUtilWarnPct: 75, spExpiryWarnDays: 45,
      priceGp2ToGp3PerGb: 0.03, priceEbsGp2PerGb: 0.11, priceEbsGp3PerGb: 0.09, priceNatGatewayMonth: 40,
      finopsDigestEnabled: true, finopsDigestRecipients: 'a@example.com, b@example.com', finopsDigestWeekday: 5, tagKeysSeen: ['ignored'],
    };
    const res = await request(app).put('/api/aws/config').send(body);
    expect(res.status).toBe(200);
    expect(res.body).toEqual(expect.objectContaining({
      costSpikePct: 40, finopsMetric: 'unblended', finopsTagKeys: ['Environment', 'Team'], finopsLinkedAccounts: 'on',
      anomalyPct: 45, anomalyFloorUsd: 7.5, anomalyBaselineDays: 10, anomalyClearDays: 3, spUtilWarnPct: 75, spExpiryWarnDays: 45,
      priceGp2ToGp3PerGb: 0.03, priceEbsGp2PerGb: 0.11, priceEbsGp3PerGb: 0.09, priceNatGatewayMonth: 40,
      finopsDigestEnabled: true, finopsDigestRecipients: 'a@example.com, b@example.com', finopsDigestWeekday: 5,
      tagKeysSeen: ['Environment', 'CostCenter'],
    }));
    expect(getSetting('aws_finops_digest_enabled')).toBe('1');
    expect(getSetting('aws_finops_tag_keys')).toBe('["Environment","Team"]');

    const keep = await request(app).put('/api/aws/config').send({ costSpikePct: 41 });
    expect(keep.body.anomalyPct).toBe(45); // untouched keys keep their values
    expect((await request(app).put('/api/aws/config').send({ finopsMetric: 'amortized' })).status).toBe(400);
    for (const bad of [{ anomalyPct: 4 }, { anomalyPct: 501 }, { anomalyFloorUsd: -1 }, { anomalyBaselineDays: 2 }, { anomalyBaselineDays: 31 },
      { anomalyClearDays: 15 }, { spUtilWarnPct: 0 }, { spUtilWarnPct: 101 }, { spExpiryWarnDays: 366 }, { priceNatGatewayMonth: 1001 },
      { priceEbsGp2PerGb: 11 }, { finopsDigestWeekday: 8 }, { finopsMetric: 'net' }, { finopsLinkedAccounts: 'maybe' },
      { finopsTagKeys: Array.from({ length: 11 }, (_, i) => `k${i}`) }, { finopsTagKeys: [''] }, { finopsTagKeys: ['x'.repeat(129)] },
      { finopsDigestRecipients: 'x'.repeat(1001) }]) {
      const r = await request(app).put('/api/aws/config').send({ costSpikePct: 40, ...bad });
      expect(r.status, JSON.stringify(bad)).toBe(400);
    }
    // restore defaults for later suites in this file
    await request(app).put('/api/aws/config').send({ costSpikePct: 30, finopsMetric: 'amortized', finopsTagKeys: [], finopsDigestEnabled: false });
  });
});

describe('Integrations', () => {
  it('Ops Monitor AWS card gains Forecast and budget exceptions', () => {
    const month = new Date().toISOString().slice(0, 7);
    const b = db.prepare("INSERT INTO aws_budgets (name, scope_type, amount_usd) VALUES ('ops-crit', 'total', 10)").run().lastInsertRowid;
    db.prepare("INSERT INTO aws_budget_status (budget_id, month, actual_usd, pct_actual, state) VALUES (?, ?, 20, 200, 'crit')").run(b, month);
    const registry = require('../core/registry');
    const realGetPlugin = registry.getPlugin;
    registry.getPlugin = (id) => (id === 'aws' ? { id: 'aws', enabled: true } : realGetPlugin(id));
    const ops = require('../routes/ops');
    const opsApp = express();
    opsApp.use('/api/ops', ops);
    return Promise.resolve(request(opsApp).get('/api/ops/summary')).finally(() => { registry.getPlugin = realGetPlugin; }).then((res) => {
      expect(res.status).toBe(200);
      const aws = res.body.platforms.find((p) => p.id === 'aws');
      expect(aws).toBeTruthy();
      expect(aws.headline.map((h) => h.label)).toEqual(expect.arrayContaining(['MTD Spend', 'Forecast', 'EC2 Running']));
      expect(aws.headline.find((h) => h.label === 'Forecast').value).toBe('$1100.00');
      const budgetEx = aws.exceptions.find((e) => e.link === '/aws/finops/budgets');
      expect(budgetEx).toEqual(expect.objectContaining({ severity: 'critical', count: 1 }));
    });
  });

  it('search finds budgets and recommendations', async () => {
    setSetting('platform_aws_enabled', '1');
    const search = require('../routes/search');
    const sApp = express();
    sApp.use((req, res, next) => { req.auth = { grants: ['*:*:*'] }; next(); });
    sApp.use('/api/search', search);
    const res = await request(sApp).get('/api/search').query({ q: 'ops-crit' });
    expect(res.status).toBe(200);
    const cat = res.body.results.find((r) => r.key === 'aws-budgets');
    expect(cat.items[0]).toEqual(expect.objectContaining({ title: 'ops-crit', route: '/aws/finops/budgets?q=ops-crit' }));
    const rec = await request(sApp).get('/api/search').query({ q: 'vol-lifecycle' });
    const recCat = rec.body.results.find((r) => r.key === 'aws-recommendations');
    expect(recCat.items[0].title).toBe('vol-lifecycle');
    expect(recCat.items[0].subtitle).toMatch(/ebs-unattached - \$25\/mo/);
  });

  it('anonymizer dictionary includes budget names, tag values and anomaly monitors', () => {
    const { createAnonymizer } = require('../services/anonymizer');
    const an = createAnonymizer();
    const out = an.anonymize('Budget ops-crit tag prod monitor Services monitor');
    expect(out).not.toContain('ops-crit');
    expect(out).not.toContain('Services monitor');
  });

  it('advisor gathers: commitments, allocation and the finops_waste lifecycle fields', () => {
    const awsAdvisor = require('../services/advisors/awsAdvisor');
    expect(awsAdvisor.REPORTS).toEqual(expect.arrayContaining(['commitments', 'allocation', 'finops_waste']));
    const c = awsAdvisor.gatherFor('commitments');
    expect(c.plans[0]).toEqual(expect.objectContaining({ hourlyCommitmentUsd: 3, daysToExpiry: 20 }));
    expect(c.savingsPlans.avgUtilizationPct).toBe(90);
    expect(c.purchaseRecommendations[0].finding).toBe('purchase-savings-plan');
    setSetting('aws_finops_tag_keys', JSON.stringify(['Environment']));
    const a = awsAdvisor.gatherFor('allocation');
    expect(a.tagKeys[0]).toEqual(expect.objectContaining({ key: 'Environment', unallocatedPct: expect.any(Number) }));
    expect(a.tagKeys[0].topValues.length).toBeGreaterThan(0);
    setSetting('aws_finops_tag_keys', '[]');
    const w = awsAdvisor.gatherFor('finops_waste');
    expect(w.recommendations.length).toBeGreaterThan(0);
    expect(w.recommendations[0]).toEqual(expect.objectContaining({ key: expect.any(String), status: expect.any(String) }));
    expect(w).toEqual(expect.objectContaining({ realizedSavings90dUsd: expect.any(Number), potentialSavingsUsd: expect.any(Number) }));
  });

  it('estate cloud_cost_posture reads the collector overview and reports unavailable when it throws', () => {
    const estate = require('../services/advisors/estateAdvisor');
    const ok = estate.gatherFor('cloud_cost_posture');
    expect(ok.unavailable).toBeUndefined();
    expect(ok.kpis).toEqual({ mtdUsd: 12.5 });
    expect(ok.budgets.length).toBeGreaterThan(0);
    const real = awsFinops.buildFinopsOverview;
    try {
      awsFinops.buildFinopsOverview = () => { throw new Error('no data'); };
      expect(estate.gatherFor('cloud_cost_posture')).toEqual({ unavailable: true, reason: expect.stringMatching(/no data/) });
    } finally { awsFinops.buildFinopsOverview = real; }
  });

  it('the demo generator loads', () => {
    expect(typeof require('../demo/generators/aws').seedAws).toBe('function');
  });
});
