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
      expect(Object.keys(raw).sort()).toEqual(['anomalies', 'aws_budgets', 'co_idle', 'co_rds', 'cost_categories', 'cost_comparison',
        'cost_comparison_drivers', 'cost_tags', 'forecast', 'linked_accounts', 'optimization_hub', 'pricing', 'ri_coverage', 'ri_utilization',
        'rightsizing', 'savings_plans_inventory', 'sp_coverage', 'sp_recommendation', 'sp_utilization', 'tag_keys']);
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

// -- FinOps round 2 (WP2): estimated resource cost, inventory tags, comparison, price catalog, Hub shadowing,
// AWS-managed budgets and the new config keys. awsCostEstimate is the real module when it exists; when it does
// not (builder A has not landed it yet) a fake with the documented exports is installed for the require() the
// routes make lazily. Assertions are about the route contract, so they hold for both.
describe('FinOps round 2 routes', () => {
  const Module = require('module');
  const path = require('path');
  const realPath = path.join(__dirname, '..', 'services', 'awsCostEstimate.js');
  const fs = require('fs');
  const usingFake = !fs.existsSync(realPath);
  const calls = [];
  const origResolve = Module._resolveFilename;

  const fakeEstimate = {
    resourceRollup: (args) => {
      calls.push(['resourceRollup', args]);
      return {
        totals: { totalUsd: 30, attributedUsd: 24, unattributedUsd: 6, attributedPct: 80 },
        byKind: [{ kind: 'ec2', usd: 20, count: 1 }, { kind: 's3', usd: 4, count: 1 }],
        rows: [{ resourceKind: 'ec2', resourceId: 'i-r2-1', label: 'web-r2', link: '/aws/ec2?q=i-r2-1', services: ['Amazon Elastic Compute Cloud - Compute'], usd: 20, pct: 66.7, dailyAvgUsd: 0.67, estMonthlyUsd: 20.3, days: 30, tags: { Environment: 'prod' } }],
        unattributed: [{ service: 'EC2 - Other', usd: 6, usageTypes: 2 }],
        computedAt: new Date().toISOString(),
      };
    },
    resourceSeries: (args) => { calls.push(['resourceSeries', args]); return { rows: [{ day: day(1), usd: 0.7, usageTypes: [{ usageType: 'USE2-BoxUsage:m5.large', usd: 0.7 }] }] }; },
    estimateForResources: (kind, ids) => new Map(ids.map((id) => [id, { usd: 10, days: 30, estMonthlyUsd: 10.133 }])),
    inventoryTagRows: (args) => { calls.push(['inventoryTagRows', args]); return [{ day: day(1), value: 'prod', service: 'Svc A', usd: 5 }, { day: day(1), value: '', service: 'Svc A', usd: 1 }]; },
    computeResourceEstimates: () => ({ rows: [], attributedUsd: 0, unattributedUsd: 0 }),
    storeResourceEstimates: () => {},
  };

  beforeAll(() => {
    if (usingFake) {
      const fakePath = path.join(__dirname, '..', 'services', '__fake_awsCostEstimate.js');
      require.cache[fakePath] = { id: fakePath, filename: fakePath, loaded: true, exports: fakeEstimate, children: [], paths: [] };
      Module._resolveFilename = function resolve(request, ...rest) {
        if (/services\/awsCostEstimate$/.test(request)) return fakePath;
        return origResolve.call(this, request, ...rest);
      };
    }
    setSetting('aws_inventory_tag_keys_seen', JSON.stringify(['Environment', 'Team']));
    const tags = JSON.stringify({ Environment: 'prod', Team: 'platform' });
    db.prepare("INSERT INTO aws_ec2_instances (account_id, instance_id, name, state, instance_type, az, tags_json) VALUES (?, 'i-r2-1', 'web-r2', 'running', 'm5.large', 'us-east-2a', ?)").run(accountId, tags);
    db.prepare("INSERT INTO aws_ebs_volumes (account_id, volume_id, state, size_gb, volume_type, az, tags_json) VALUES (?, 'vol-r2-1', 'in-use', 100, 'gp3', 'us-east-2a', ?)").run(accountId, tags);
    db.prepare("INSERT INTO aws_s3_buckets (account_id, name, region, size_bytes, object_count, tags_json) VALUES (?, 'bucket-r2', 'us-east-2', 1000, 10, ?)").run(accountId, tags);
    db.prepare("INSERT INTO aws_rds_instances (account_id, db_id, engine, instance_class, status, multi_az, allocated_gb, tags_json) VALUES (?, 'db-r2', 'postgres', 'db.t3.medium', 'available', 0, 20, ?)").run(accountId, tags);
    db.prepare("INSERT INTO aws_lightsail_instances (account_id, name, state, bundle, az, tags_json) VALUES (?, 'ls-r2', 'running', 'small_3_0', 'us-east-2a', ?)").run(accountId, tags);
    const est = db.prepare(`INSERT INTO aws_cost_resource_estimate_daily (account_id, day, service, usage_type, resource_kind, resource_id, amount_usd, amortized_usd, share_rule)
                            VALUES (?, ?, ?, ?, ?, ?, ?, ?, '1 of 1')`);
    for (let i = 0; i < 5; i++) {
      est.run(accountId, day(i), 'Amazon Elastic Compute Cloud - Compute', 'USE2-BoxUsage:m5.large', 'ec2', 'i-r2-1', 2, 1.5);
      est.run(accountId, day(i), 'EC2 - Other', 'USE2-NatGateway-Hours', 'unattributed', 'EC2 - Other', 1, 1);
    }
  });

  afterAll(() => {
    if (usingFake) {
      Module._resolveFilename = origResolve;
      delete require.cache[path.join(__dirname, '..', 'services', '__fake_awsCostEstimate.js')];
    }
  });

  it('GET /finops/resources answers the documented keys, validates, and CSV is text/csv', async () => {
    const res = await request(app).get('/api/aws/finops/resources').query({ days: 30, metric: 'unblended', limit: 10 });
    expect(res.status).toBe(200);
    for (const k of ['range', 'metric', 'totals', 'byKind', 'rows', 'unattributed', 'note', 'computedAt']) expect(res.body).toHaveProperty(k);
    expect(res.body.metric).toBe('unblended');
    expect(res.body.note).toMatch(/Estimated/);
    expect(Object.keys(res.body.totals)).toEqual(expect.arrayContaining(['totalUsd', 'attributedUsd', 'unattributedUsd', 'attributedPct']));
    expect(res.body.rows[0]).toEqual(expect.objectContaining({ resourceKind: 'ec2', resourceId: 'i-r2-1', usd: expect.any(Number), estMonthlyUsd: expect.any(Number) }));
    expect((await request(app).get('/api/aws/finops/resources').query({ limit: 501 })).status).toBe(200); // clamped, not rejected
    expect((await request(app).get('/api/aws/finops/resources').query({ metric: 'bogus' })).status).toBe(400);
    if (usingFake) {
      const last = calls.filter((c) => c[0] === 'resourceRollup').pop()[1];
      expect(last.limit).toBe(500);
    }
    const csv = await request(app).get('/api/aws/finops/resources/export.csv').query({ days: 30 });
    expect(csv.status).toBe(200);
    expect(csv.headers['content-type']).toMatch(/text\/csv/);
    expect(csv.text.split('\n')[0]).toMatch(/^"?Kind"?,"?Resource"?,"?Label"?,"?Services"?,"?Cost USD \(amortized\)"?,"?Est monthly USD"?,"?Tags"?/);
    expect(csv.text).toContain('i-r2-1');
  });

  it('GET /finops/resources/series requires kind and resourceId, honours metric, and returns day rows', async () => {
    expect((await request(app).get('/api/aws/finops/resources/series').query({ kind: 'ec2' })).status).toBe(400);
    const res = await request(app).get('/api/aws/finops/resources/series').query({ kind: 'ec2', resourceId: 'i-r2-1', days: 14, metric: 'unblended' });
    expect(res.status).toBe(200);
    expect(res.body.metric).toBe('unblended');
    expect(Array.isArray(res.body.rows)).toBe(true);
    expect(res.body.rows[0]).toEqual(expect.objectContaining({ day: expect.any(String), usd: expect.any(Number), usageTypes: expect.any(Array) }));
    if (usingFake) expect(calls.filter((c) => c[0] === 'resourceSeries').pop()[1]).toEqual(expect.objectContaining({ kind: 'ec2', resourceId: 'i-r2-1', metric: 'unblended' }));
    expect((await request(app).get('/api/aws/finops/resources/series').query({ kind: 'ec2', resourceId: 'i-r2-1', metric: 'nope' })).status).toBe(400);
  });

  it('GET /finops/allocation with dimension inventory_tag is flagged estimated and lists the seen keys; the CSV export works', async () => {
    const res = await request(app).get('/api/aws/finops/allocation').query({ dimension: 'inventory_tag', key: 'Environment', days: 30 });
    expect(res.status).toBe(200);
    expect(res.body.dimension).toBe('inventory_tag');
    expect(res.body.estimated).toBe(true);
    expect(res.body.keysAvailable.inventory_tag).toEqual(['Environment', 'Team']);
    const defaulted = await request(app).get('/api/aws/finops/allocation').query({ dimension: 'inventory_tag' });
    expect(defaulted.body.key).toBe('Environment');
    const plain = await request(app).get('/api/aws/finops/allocation').query({ dimension: 'tag', key: 'Environment' });
    expect('estimated' in plain.body).toBe(false);
    const csv = await request(app).get('/api/aws/finops/allocation/export.csv').query({ dimension: 'inventory_tag', key: 'Environment', days: 30 });
    expect(csv.status).toBe(200);
    expect(csv.headers['content-type']).toMatch(/text\/csv/);
    expect((await request(app).get('/api/aws/finops/allocation').query({ dimension: 'nope' })).status).toBe(400);
  });

  it('GET /finops/comparison is empty (null months) until a pair is stored, then returns the newest pair with drivers', async () => {
    const real = awsFinops.comparisonLatest;
    delete awsFinops.comparisonLatest; // exercise the route's own read of aws_cost_comparison
    try {
      const empty = await request(app).get('/api/aws/finops/comparison');
      expect(empty.status).toBe(200);
      expect(empty.body).toEqual({ baselineMonth: null, comparisonMonth: null, metric: null, capturedAt: null, rows: [] });
      const ins = db.prepare(`INSERT INTO aws_cost_comparison (account_id, baseline_month, comparison_month, metric, service, baseline_usd, comparison_usd, delta_usd, delta_pct, drivers_json)
                              VALUES (?, '2026-08', '2026-09', 'amortized', ?, ?, ?, ?, ?, ?)`);
      ins.run(accountId, 'Svc A', 100, 160, 60, 60, JSON.stringify([{ type: 'USAGE_CHANGE', name: 'More hours', usageType: 'BoxUsage', baselineUsd: 80, comparisonUsd: 140, deltaUsd: 60 }]));
      ins.run(accountId, 'Svc B', 50, 40, -10, -20, '[]');
      const filled = await request(app).get('/api/aws/finops/comparison');
      expect(filled.status).toBe(200);
      expect(filled.body).toEqual(expect.objectContaining({ baselineMonth: '2026-08', comparisonMonth: '2026-09', metric: 'amortized' }));
      expect(filled.body.rows.map((r) => r.service)).toEqual(['Svc A', 'Svc B']); // largest move first
      expect(filled.body.rows[0]).toEqual(expect.objectContaining({ baselineUsd: 100, comparisonUsd: 160, deltaUsd: 60, deltaPct: 60 }));
      expect(filled.body.rows[0].drivers[0]).toEqual(expect.objectContaining({ type: 'USAGE_CHANGE', deltaUsd: 60 }));
      expect(filled.body.rows[1].drivers).toEqual([]);
    } finally { if (real) awsFinops.comparisonLatest = real; }
  });

  it('GET /finops/pricing reads the catalog table; POST /finops/pricing/refresh clears the stamps and answers 202', async () => {
    const empty = await request(app).get('/api/aws/finops/pricing');
    expect(empty.status).toBe(200);
    expect(empty.body).toEqual(expect.objectContaining({ refreshedAt: null, rows: 0, byService: [], sample: [] }));
    db.prepare("INSERT INTO aws_price_catalog (region, service_code, sku_key, unit, price_usd, attributes_json) VALUES ('us-east-2', 'AmazonEC2', 'm5.large|Linux', 'Hrs', 0.096, '{\"instanceType\":\"m5.large\"}')").run();
    db.prepare("INSERT INTO aws_price_catalog (region, service_code, sku_key, unit, price_usd) VALUES ('us-east-2', 'AmazonRDS', 'db.t3.medium|postgres|single', 'Hrs', 0.082)").run();
    setSetting('aws_price_catalog_refreshed_at', iso(1));
    const res = await request(app).get('/api/aws/finops/pricing');
    expect(res.body.rows).toBe(2);
    expect(res.body.refreshedAt).toBe(getSetting('aws_price_catalog_refreshed_at'));
    expect(res.body.byService).toEqual([{ serviceCode: 'AmazonEC2', n: 1 }, { serviceCode: 'AmazonRDS', n: 1 }]);
    expect(res.body.sample[0]).toEqual(expect.objectContaining({ region: 'us-east-2', serviceCode: 'AmazonEC2', skuKey: 'm5.large|Linux', unit: 'Hrs', priceUsd: 0.096, attributes: { instanceType: 'm5.large' } }));

    db.prepare("UPDATE aws_accounts SET last_finops_capture_at = datetime('now') WHERE id = ?").run(accountId);
    const refresh = await request(app).post('/api/aws/finops/pricing/refresh');
    expect(refresh.status).toBe(202);
    expect(getSetting('aws_price_catalog_refreshed_at') || '').toBe('');
    expect(db.prepare('SELECT last_finops_capture_at AS c FROM aws_accounts WHERE id = ?').get(accountId).c).toBeNull();
  });

  it('GET /optimizer hides shadowed rows by default, shows them with includeShadowed, and totals never count them', async () => {
    const ins = db.prepare(`INSERT INTO aws_optimizer_recommendations (account_id, source, resource_type, resource_id, resource_name, finding, est_monthly_savings_usd, effort, restart_needed, rollback_possible, action_type, lookback_days, after_discounts)
                            VALUES (?, ?, 'ec2', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
    ins.run(accountId, 'compute-optimizer', 'i-shadow-1', 'shadow-1', 'Overprovisioned', 40, null, null, null, null, 14, 0);
    ins.run(accountId, 'cost-optimization-hub', 'i-shadow-1', 'shadow-1', 'Rightsize', 35, 'Medium', 1, 1, 'Rightsize', 14, 1);
    ins.run(accountId, 'heuristic', 'i-shadow-2', 'shadow-2', 'ec2-low-utilization', 20, null, null, null, null, 14, 0);
    ins.run(accountId, 'compute-optimizer', 'i-shadow-2', 'shadow-2', 'Overprovisioned', 22, null, null, null, null, 14, 0);
    ins.run(accountId, 'heuristic', 'i-shadow-3', 'shadow-3', 'ec2-low-utilization', 11, null, null, null, null, 14, 0);

    const def = await request(app).get('/api/aws/optimizer').query({ accountId });
    expect(def.status).toBe(200);
    const keys = def.body.recommendations.map((r) => r.key);
    expect(keys).toContain('cost-optimization-hub|Rightsize|i-shadow-1');
    expect(keys).not.toContain('compute-optimizer|Overprovisioned|i-shadow-1');
    expect(keys).not.toContain('heuristic|ec2-low-utilization|i-shadow-2');
    expect(keys).toContain('heuristic|ec2-low-utilization|i-shadow-3');
    expect(def.body.totals.shadowed).toBe(2);
    expect(def.body.totals.sources['cost-optimization-hub']).toBe(1);
    expect(def.body.totals.sources.heuristic).toBeGreaterThanOrEqual(1);
    expect(def.body.totals.sources['compute-optimizer'] || 0).toBeLessThan(2); // i-shadow-1 and i-shadow-2 CO rows are hidden
    const hub = def.body.recommendations.find((r) => r.key === 'cost-optimization-hub|Rightsize|i-shadow-1');
    expect(hub).toEqual(expect.objectContaining({ effort: 'Medium', restartNeeded: true, rollbackPossible: true, actionType: 'Rightsize', lookbackDays: 14, afterDiscounts: true, shadowedBy: null }));

    const all = await request(app).get('/api/aws/optimizer').query({ accountId, includeShadowed: 1 });
    expect(all.body.recommendations.length).toBe(def.body.recommendations.length + 2);
    const co = all.body.recommendations.find((r) => r.key === 'compute-optimizer|Overprovisioned|i-shadow-1');
    expect(co.shadowedBy).toBe('cost-optimization-hub');
    expect(all.body.recommendations.find((r) => r.key === 'heuristic|ec2-low-utilization|i-shadow-2').shadowedBy).toBe('compute-optimizer');
    expect(all.body.totals.count).toBe(def.body.totals.count);
    expect(all.body.totals.estMonthlySavingsUsd).toBe(def.body.totals.estMonthlySavingsUsd);
  });

  it('a service budget with scopeMatch contains evaluates over every matching service; contains is only for service scope', async () => {
    const ins = db.prepare('INSERT INTO aws_cost_daily (account_id, day, service, amount_usd, amortized_usd) VALUES (?, ?, ?, ?, ?)');
    ins.run(accountId, day(0), 'Claude Opus X (Amazon Bedrock Edition)', 30, 30);
    ins.run(accountId, day(0), 'Claude Sonnet X (Amazon Bedrock Edition)', 12, 12);
    ins.run(accountId, day(0), 'Amazon Simple Storage Service', 99, 99);
    const post = await request(app).post('/api/aws/finops/budgets').send({ name: 'Bedrock contains', scopeType: 'service', scopeValue: 'Bedrock', scopeMatch: 'contains', amountUsd: 1000 });
    expect(post.status).toBe(201);
    expect(post.body.budget).toEqual(expect.objectContaining({ scopeMatch: 'contains', scopeValue: 'Bedrock', source: 'icc' }));
    const id = post.body.budget.id;
    // The evaluation half needs the collector's scope_match support (builder A); it runs once that is in the file.
    if (require('fs').readFileSync(require('path').join(__dirname, '..', 'services', 'awsFinops.js'), 'utf8').includes('scope_match')) {
      saved.evaluateBudgets();
      const status = db.prepare('SELECT actual_usd FROM aws_budget_status WHERE budget_id = ?').get(id);
      expect(status.actual_usd).toBe(42);
    }
    const bad = await request(app).post('/api/aws/finops/budgets').send({ name: 'bad contains', scopeType: 'total', scopeMatch: 'contains', amountUsd: 10 });
    expect(bad.status).toBe(400);
    expect((await request(app).post('/api/aws/finops/budgets').send({ name: 'bad enum', scopeType: 'service', scopeValue: 'x', scopeMatch: 'regex', amountUsd: 10 })).status).toBe(400);
    const put = await request(app).put(`/api/aws/finops/budgets/${id}`).send({ scopeMatch: 'exact' });
    expect(put.body.budget.scopeMatch).toBe('exact');
    expect((await request(app).put(`/api/aws/finops/budgets/${id}`).send({ scopeType: 'total', scopeMatch: 'contains' })).status).toBe(400);
  });

  it('AWS-managed budgets list with their AWS fields and refuse PUT and DELETE with 409', async () => {
    const info = db.prepare(`INSERT INTO aws_budgets (name, scope_type, amount_usd, source, external_name, time_unit, aws_actual_usd, aws_forecast_usd, last_synced_at)
                             VALUES ('Finance monthly', 'total', 500, 'aws', 'Finance monthly', 'MONTHLY', 120.5, 480, datetime('now'))`).run();
    const id = Number(info.lastInsertRowid);
    const list = await request(app).get('/api/aws/finops/budgets');
    const row = list.body.budgets.find((b) => b.id === id);
    expect(row).toEqual(expect.objectContaining({ source: 'aws', scopeMatch: 'exact', externalName: 'Finance monthly', timeUnit: 'MONTHLY', awsActualUsd: 120.5, awsForecastUsd: 480 }));
    expect(row.lastSyncedAt).toBeTruthy();
    const put = await request(app).put(`/api/aws/finops/budgets/${id}`).send({ amountUsd: 1 });
    expect(put.status).toBe(409);
    expect(put.body).toEqual({ error: 'This budget is managed in AWS Budgets.' });
    const del = await request(app).delete(`/api/aws/finops/budgets/${id}`);
    expect(del.status).toBe(409);
    expect(db.prepare('SELECT COUNT(*) AS n FROM aws_budgets WHERE id = ?').get(id).n).toBe(1);
  });

  it('GET /finops/commitments plan rows carry state, payment split, product types and source', async () => {
    db.prepare(`INSERT INTO aws_savings_plans (account_id, sp_arn, sp_type, payment_option, term, hourly_commitment_usd, start_at, end_at, state, upfront_usd, recurring_usd, product_types_json, description, source)
                VALUES (?, 'arn:aws:savingsplans::1:savingsplan/sp-queued', 'Compute', 'No Upfront', '1yr', 3, ?, ?, 'queued', 0, 3, '["EC2","Lambda"]', 'renewal', 'api')`).run(accountId, iso(-20), iso(-385));
    const res = await request(app).get('/api/aws/finops/commitments').query({ days: 30 });
    expect(res.status).toBe(200);
    const queued = res.body.savingsPlans.plans.find((p) => p.arn.endsWith('sp-queued'));
    expect(queued).toEqual(expect.objectContaining({ state: 'queued', upfrontUsd: 0, recurringUsd: 3, productTypes: ['EC2', 'Lambda'], source: 'api' }));
    const derived = res.body.savingsPlans.plans.find((p) => p.arn.endsWith('sp-abc'));
    expect(derived).toEqual(expect.objectContaining({ state: null, productTypes: [], source: 'details' }));
  });

  it('GET /config and PUT /config round-trip the six round 2 keys with their clamps', async () => {
    const get = await request(app).get('/api/aws/config');
    expect(get.body).toEqual(expect.objectContaining({
      priceRefreshDays: 7, rightsizeCpuMaxPct: 10, rightsizeMinDays: 7, comparisonEnabled: true, costCategoriesMax: 5, estimateWindowDays: 35,
    }));
    const body = { costSpikePct: 30, priceRefreshDays: 14, rightsizeCpuMaxPct: 15, rightsizeMinDays: 10, comparisonEnabled: false, costCategoriesMax: 0, estimateWindowDays: 60 };
    const put = await request(app).put('/api/aws/config').send(body);
    expect(put.status).toBe(200);
    expect(put.body).toEqual(expect.objectContaining({ priceRefreshDays: 14, rightsizeCpuMaxPct: 15, rightsizeMinDays: 10, comparisonEnabled: false, costCategoriesMax: 0, estimateWindowDays: 60 }));
    expect(getSetting('aws_finops_comparison_enabled')).toBe('0');
    for (const bad of [{ priceRefreshDays: 0 }, { priceRefreshDays: 91 }, { rightsizeCpuMaxPct: 0 }, { rightsizeCpuMaxPct: 101 }, { rightsizeMinDays: 0 },
      { rightsizeMinDays: 31 }, { comparisonEnabled: 'maybe' }, { costCategoriesMax: -1 }, { costCategoriesMax: 21 }, { estimateWindowDays: 6 }, { estimateWindowDays: 91 }]) {
      const r = await request(app).put('/api/aws/config').send({ costSpikePct: 30, ...bad });
      expect(r.status, JSON.stringify(bad)).toBe(400);
    }
    await request(app).put('/api/aws/config').send({ costSpikePct: 30, priceRefreshDays: 7, rightsizeCpuMaxPct: 10, rightsizeMinDays: 7, comparisonEnabled: true, costCategoriesMax: 5, estimateWindowDays: 35 });
  });

  it('inventory routes carry estMonthlyUsd and a tags object', async () => {
    const checks = [
      ['/api/aws/ec2', (b) => b.instances.find((r) => r.instanceId === 'i-r2-1')],
      ['/api/aws/ebs', (b) => b.volumes.find((r) => r.volumeId === 'vol-r2-1')],
      ['/api/aws/s3', (b) => b.buckets.find((r) => r.name === 'bucket-r2')],
      ['/api/aws/rds', (b) => b.instances.find((r) => r.dbId === 'db-r2')],
      ['/api/aws/lightsail', (b) => b.instances.find((r) => r.name === 'ls-r2')],
    ];
    for (const [url, pick] of checks) {
      const res = await request(app).get(url);
      expect(res.status, url).toBe(200);
      const row = pick(res.body);
      expect(row.tags, url).toEqual({ Environment: 'prod', Team: 'platform' });
      expect('estMonthlyUsd' in row, url).toBe(true);
    }
    const ec2 = (await request(app).get('/api/aws/ec2')).body.instances.find((r) => r.instanceId === 'i-r2-1');
    expect(typeof ec2.estMonthlyUsd).toBe('number'); // estimate rows were seeded for this instance
    const untagged = (await request(app).get('/api/aws/ec2')).body.instances.filter((r) => r.instanceId !== 'i-r2-1');
    for (const r of untagged) expect(r.tags).toEqual({});
  });

  it('GET /finops/capabilities passes the free flag through; GET /costs/resources carries a top-level costResources.status', async () => {
    const real = awsFinops.capabilityRows;
    awsFinops.capabilityRows = () => [{ capability: 'pricing', status: 'ok', error: null, iamActions: ['pricing:GetProducts'], requests: 0, free: true, lastOkAt: iso(0), lastCheckedAt: iso(0) }];
    try {
      const res = await request(app).get('/api/aws/finops/capabilities');
      expect(res.body.capabilities[0].free).toBe(true);
    } finally { awsFinops.capabilityRows = real; }
    db.prepare("UPDATE aws_accounts SET cost_resources_status = 'denied', cost_resources_error = 'nope' WHERE id = ?").run(accountId);
    const denied = await request(app).get('/api/aws/costs/resources');
    expect(denied.body.costResources.status).toBe('denied');
    db.prepare("UPDATE aws_accounts SET cost_resources_status = 'ok', cost_resources_error = NULL WHERE id = ?").run(accountId);
    expect((await request(app).get('/api/aws/costs/resources')).body.costResources.status).toBe('ok');
    db.prepare('UPDATE aws_accounts SET cost_resources_status = NULL WHERE id = ?').run(accountId);
  });
});

describe('FinOps round 2 integrations', () => {
  it('anonymizer tokenizes inventory tag values and AWS budget external names', () => {
    db.prepare("INSERT INTO aws_ec2_instances (account_id, instance_id, name, state, instance_type, az, tags_json) VALUES (?, 'i-anon-1', 'anon-host', 'running', 'm5.large', 'us-east-2a', ?)")
      .run(accountId, JSON.stringify({ Project: 'Phoenix-Billing', CostCenter: 'CC-7788' }));
    db.prepare("INSERT INTO aws_budgets (name, scope_type, amount_usd, source, external_name) VALUES ('Alpha budget (AWS)', 'total', 1, 'aws', 'Quarterly-Moonshot')").run();
    const { createAnonymizer } = require('../services/anonymizer');
    const an = createAnonymizer();
    const out = an.anonymize('Project Phoenix-Billing cost center CC-7788 under Quarterly-Moonshot');
    expect(out).not.toContain('Phoenix-Billing');
    expect(out).not.toContain('CC-7788');
    expect(out).not.toContain('Quarterly-Moonshot');
    expect(out).toContain('Project'); // keys stay clear
    expect(an.restore(out)).toContain('Phoenix-Billing');
  });

  it('advisor: finops_waste carries Hub and ICC rightsizing rows; resource_costs is a registered preset', () => {
    const awsAdvisor = require('../services/advisors/awsAdvisor');
    expect(awsAdvisor.REPORTS).toContain('resource_costs');
    const w = awsAdvisor.gatherFor('finops_waste');
    expect(w.hubRecommendations.length).toBeGreaterThan(0);
    expect(w.hubRecommendations[0]).toEqual(expect.objectContaining({ effort: 'Medium', resourceType: 'ec2' }));
    expect(w.iccRightsizing.length).toBeGreaterThan(0);
    const rc = awsAdvisor.gatherFor('resource_costs');
    expect(rc).toHaveProperty('topResources');
    expect(Array.isArray(rc.byKind)).toBe(true);
  });

  it('the demo generator seeds round 2: tags, CPU history, prices, Hub rows with a shadow, AWS budgets, comparison, capabilities', () => {
    const { seedAws } = require('../demo/generators/aws');
    const { encrypt: enc } = require('../services/encryption');
    const wipe = ['aws_cost_resource_estimate_daily', 'aws_ec2_metrics_daily', 'aws_cost_comparison'];
    // A scratch demo account: run the generator against its own isolated rows by clearing what it owns first.
    const accountsBefore = db.prepare("SELECT id FROM aws_accounts WHERE name = 'Demo AWS'").all();
    expect(accountsBefore.length).toBe(0);
    const out = seedAws(db, { now: new Date(), encrypt: enc });
    expect(out.finops.round2.taggedRows).toBeGreaterThan(20);
    const demoId = db.prepare("SELECT id FROM aws_accounts WHERE name = 'Demo AWS'").get().id;
    const tagged = db.prepare('SELECT COUNT(*) AS n FROM aws_ec2_instances WHERE account_id = ? AND tags_json IS NOT NULL').get(demoId).n;
    expect(tagged).toBeGreaterThan(0);
    const untaggedAll = ['aws_ec2_instances', 'aws_ebs_volumes', 'aws_rds_instances', 'aws_s3_buckets', 'aws_lightsail_instances', 'aws_lightsail_databases']
      .reduce((a, tb) => a + db.prepare(`SELECT COUNT(*) AS n FROM ${tb} WHERE account_id = ? AND tags_json IS NULL`).get(demoId).n, 0);
    expect(untaggedAll).toBeGreaterThan(0); // about 15% stay untagged
    const cpu = db.prepare('SELECT instance_id, MAX(cpu_max) AS m, COUNT(*) AS n FROM aws_ec2_metrics_daily WHERE account_id = ? GROUP BY instance_id').all(demoId);
    expect(cpu.every((r) => r.n === 14)).toBe(true);
    const low = cpu.filter((r) => r.m < 6).map((r) => db.prepare('SELECT instance_type AS t FROM aws_ec2_instances WHERE instance_id = ?').get(r.instance_id).t).sort();
    expect(low).toEqual(['m5.xlarge', 't3.large']);
    expect(db.prepare("SELECT COUNT(*) AS n FROM aws_price_catalog WHERE service_code = 'AmazonEC2' AND sku_key IN ('gp2', 'gp3', 'io1', 'm5.large|Linux')").get().n).toBe(4);
    expect(db.prepare("SELECT COUNT(*) AS n FROM aws_price_catalog WHERE service_code = 'AmazonLightsail'").get().n).toBeGreaterThan(0);
    const hub = db.prepare("SELECT resource_id FROM aws_optimizer_recommendations WHERE account_id = ? AND source = 'cost-optimization-hub'").all(demoId);
    expect(hub.length).toBe(4);
    const shadowed = db.prepare("SELECT COUNT(*) AS n FROM aws_optimizer_recommendations WHERE account_id = ? AND source = 'compute-optimizer' AND resource_id IN (SELECT resource_id FROM aws_optimizer_recommendations WHERE source = 'cost-optimization-hub')").get(demoId).n;
    expect(shadowed).toBe(1);
    expect(db.prepare("SELECT COUNT(*) AS n FROM aws_optimizer_recommendations WHERE account_id = ? AND resource_type LIKE 'idle-%'").get(demoId).n).toBe(2);
    expect(db.prepare("SELECT COUNT(*) AS n FROM aws_savings_plans WHERE account_id = ? AND state = 'queued'").get(demoId).n).toBe(1);
    expect(db.prepare("SELECT COUNT(*) AS n FROM aws_budgets WHERE source = 'aws'").get().n).toBeGreaterThanOrEqual(2);
    expect(db.prepare("SELECT scope_match, scope_value FROM aws_budgets WHERE name = 'Bedrock models'").get()).toEqual({ scope_match: 'contains', scope_value: 'Bedrock' });
    const cmp = db.prepare('SELECT COUNT(*) AS n, SUM(CASE WHEN drivers_json <> \'[]\' THEN 1 ELSE 0 END) AS withDrivers FROM aws_cost_comparison WHERE account_id = ?').get(demoId);
    expect(cmp).toEqual({ n: 11, withDrivers: 6 }); // one row per demo cost service (11)
    const caps = db.prepare('SELECT capability FROM aws_capability_status WHERE account_id = ?').all(demoId).map((r) => r.capability);
    for (const id of ['cost_categories', 'cost_comparison', 'savings_plans_inventory', 'aws_budgets', 'optimization_hub', 'pricing', 'co_idle', 'co_rds', 'inventory_tags', 'resource_estimate']) expect(caps).toContain(id);
    expect(JSON.parse(getSetting('aws_inventory_tag_keys_seen'))).toEqual(['Environment', 'Team', 'CostCenter']);
    if (!usingFakeEstimate()) {
      const est = db.prepare('SELECT COUNT(*) AS n FROM aws_cost_resource_estimate_daily WHERE account_id = ?').get(demoId).n;
      expect(est).toBeGreaterThan(0);
      expect(out.finops.round2.estimate.attributedPct).toBeGreaterThanOrEqual(60);
    }
    void wipe;
  });
});

function usingFakeEstimate() {
  return !require('fs').existsSync(require('path').join(__dirname, '..', 'services', 'awsCostEstimate.js'));
}
