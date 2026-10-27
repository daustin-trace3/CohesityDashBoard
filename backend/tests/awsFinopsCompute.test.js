/**
 * AWS FinOps computations: forecast, ICC anomaly rule, budget state, recommendation lifecycle,
 * allocation summary, unit economics and the Bedrock model matcher. Pure functions run on rows;
 * the db-backed evaluators run on a seeded scratch database (one per test file).
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);

const db = require('../db/database');
const { runMigrations } = require('../core/migrations');
const awsMigrations = require('../db/migrations/aws');
const { setSetting } = require('../services/settings');
const finops = require('../services/awsFinops');

beforeAll(() => {
  runMigrations(db, 'aws', awsMigrations);
});

const NOW = new Date('2026-10-20T12:00:00Z');
const TODAY = '2026-10-20';

function insertAccount(name) {
  return db.prepare("INSERT INTO aws_accounts (name, access_key_id, region, polling_interval_minutes) VALUES (?, 'AKIATEST', 'us-east-2', 10)")
    .run(name).lastInsertRowid;
}
const addDays = (day, n) => new Date(new Date(`${day}T00:00:00Z`).getTime() + n * 86400000).toISOString().slice(0, 10);

describe('linearForecast', () => {
  const seven = [];
  for (let i = 8; i >= 2; i--) seven.push({ day: addDays(TODAY, -i), usd: 100 });

  it('is mtd plus run rate times days left, with a 0.85 / 1.15 band', () => {
    // October has 31 days; the 20th leaves 12 including today.
    const f = finops.linearForecast({ mtdUsd: 2000, dailyTotals: seven, today: TODAY });
    expect(f.meanUsd).toBeCloseTo(3200, 6);
    expect(f.lowerUsd).toBeCloseTo(2720, 6);
    expect(f.upperUsd).toBeCloseTo(3680, 6);
    expect(f.source).toBe('linear');
  });

  it('ignores yesterday, which may be partial', () => {
    const withPartial = [...seven, { day: addDays(TODAY, -1), usd: 3 }, { day: TODAY, usd: 1 }];
    const f = finops.linearForecast({ mtdUsd: 2000, dailyTotals: withPartial, today: TODAY });
    expect(f.meanUsd).toBeCloseTo(3200, 6);
  });

  it('returns null with fewer than three complete days', () => {
    expect(finops.linearForecast({ mtdUsd: 10, dailyTotals: seven.slice(-2), today: TODAY })).toBeNull();
    expect(finops.linearForecast({ mtdUsd: 10, dailyTotals: [], today: TODAY })).toBeNull();
  });
});

describe('iccAnomalies', () => {
  const rule = { pct: 30, floorUsd: 5, baselineDays: 7, clearDays: 2 };
  // 13 flat days ending 2026-10-18, then the values given for 10-19.
  function series(service, flat, last, usage = [['A', 0.5], ['B', 0.5]], lastUsage = null) {
    const rows = [];
    for (let i = 14; i >= 2; i--) {
      for (const [usageType, share] of usage) rows.push({ day: addDays(TODAY, -i), service, usageType, usd: flat * share });
    }
    const lu = lastUsage || usage.map(([usageType, share]) => [usageType, last * share]);
    for (const [usageType, usd] of lu) rows.push({ day: addDays(TODAY, -1), service, usageType, usd });
    return rows;
  }

  it('fires when yesterday clears both the percentage and the floor, naming the usage types behind it', () => {
    const rows = series('Svc', 10, 30, [['A', 0.5], ['B', 0.5]], [['A', 25], ['B', 5]]);
    const r = finops.iccAnomalies({ rows, open: [], rule, today: TODAY });
    expect(r.open).toHaveLength(1);
    expect(r.open[0]).toMatchObject({ anomalyId: 'icc:service:Svc:2026-10-19', scopeKey: 'Svc', startDay: '2026-10-19' });
    expect(r.open[0].actualUsd).toBeCloseTo(30, 6);
    expect(r.open[0].expectedUsd).toBeCloseTo(10, 6);
    expect(r.open[0].impactPct).toBeCloseTo(200, 6);
    expect(r.open[0].rootCauses[0]).toMatchObject({ usageType: 'A', usd: 25 });
    expect(r.open[0].rootCauses.length).toBeLessThanOrEqual(5);
  });

  it('does not fire below the floor or below the percentage', () => {
    // +4 on a 10 baseline is 40 percent but under the 5 dollar floor.
    expect(finops.iccAnomalies({ rows: series('Svc', 10, 14), open: [], rule, today: TODAY }).open).toHaveLength(0);
    // +25 on 100 clears the floor but not 30 percent.
    expect(finops.iccAnomalies({ rows: series('Big', 100, 125), open: [], rule, today: TODAY }).open).toHaveLength(0);
    expect(finops.iccAnomalies({ rows: series('Big', 100, 131), open: [], rule, today: TODAY }).open).toHaveLength(1);
  });

  it('skips services under one dollar a day and needs three baseline days', () => {
    expect(finops.iccAnomalies({ rows: series('Tiny', 0.5, 20), open: [], rule, today: TODAY }).open).toHaveLength(0);
    const short = [
      { day: addDays(TODAY, -3), service: 'New', usageType: 'A', usd: 10 },
      { day: addDays(TODAY, -2), service: 'New', usageType: 'A', usd: 10 },
      { day: addDays(TODAY, -1), service: 'New', usageType: 'A', usd: 90 },
    ];
    expect(finops.iccAnomalies({ rows: short, open: [], rule, today: TODAY }).open).toHaveLength(0);
  });

  it('keeps the earlier day when both candidate days fire', () => {
    const rows = series('Svc', 10, 30);
    rows.push({ day: addDays(TODAY, -2), service: 'Svc', usageType: 'A', usd: 20 });
    const r = finops.iccAnomalies({ rows, open: [], rule, today: TODAY });
    expect(r.open).toHaveLength(1);
    expect(r.open[0].anomalyId).toBe('icc:service:Svc:2026-10-18');
  });

  const openRow = { anomalyId: 'icc:service:Svc:2026-10-17', scopeKey: 'Svc', startDay: '2026-10-17', expectedUsd: 10, normalDays: 0 };
  const day = (n, usd) => ({ day: addDays(TODAY, -n), service: 'Svc', usageType: 'A', usd });

  it('closes an open row after clearDays normal days, ending at the last elevated day', () => {
    const rows = [day(3, 30), day(2, 11), day(1, 10)];
    const r = finops.iccAnomalies({ rows, open: [openRow], rule, today: TODAY });
    expect(r.close).toEqual([{ anomalyId: openRow.anomalyId, endDay: '2026-10-17' }]);
    expect(r.keepOpen).toHaveLength(0);
  });

  it('counts a single normal day and resets on re-elevation', () => {
    const one = finops.iccAnomalies({ rows: [day(3, 30), day(2, 30), day(1, 10)], open: [openRow], rule, today: TODAY });
    expect(one.close).toHaveLength(0);
    expect(one.keepOpen[0]).toMatchObject({ anomalyId: openRow.anomalyId, normalDays: 1, elevated: false });

    const again = finops.iccAnomalies({ rows: [day(3, 30), day(2, 10), day(1, 30)], open: [openRow], rule, today: TODAY });
    expect(again.close).toHaveLength(0);
    expect(again.keepOpen[0]).toMatchObject({ normalDays: 0, elevated: true });
    expect(again.keepOpen[0].actualUsd).toBeCloseTo(30, 6);
  });

  it('does not open a second row for a service that already has one open', () => {
    const rows = series('Svc', 10, 30);
    const r = finops.iccAnomalies({ rows, open: [{ ...openRow, startDay: '2026-10-19' }], rule, today: TODAY });
    expect(r.open).toHaveLength(0);
  });
});

describe('detectIccAnomalies (db)', () => {
  it('writes the row, then supersedes it when an AWS anomaly names the same service', () => {
    setSetting('aws_finops_metric', 'unblended');
    const id = insertAccount('anom-db');
    const ins = db.prepare('INSERT INTO aws_cost_usage_daily (account_id, day, service, usage_type, amount_usd) VALUES (?, ?, ?, ?, ?)');
    for (let i = 14; i >= 2; i--) ins.run(id, addDays(TODAY, -i), 'Amazon Bedrock', 'Tokens', 10);
    ins.run(id, addDays(TODAY, -1), 'Amazon Bedrock', 'Tokens', 40);

    const r1 = finops.detectIccAnomalies(id, { now: NOW });
    expect(r1.opened).toBe(1);
    const row = db.prepare("SELECT * FROM aws_cost_anomalies WHERE account_id = ? AND source = 'icc'").get(id);
    expect(row).toMatchObject({ scope_key: 'Amazon Bedrock', status: 'open', start_day: '2026-10-19', normal_days: 0 });
    expect(row.superseded_by).toBeNull();

    // Re-running the same day opens nothing new.
    expect(finops.detectIccAnomalies(id, { now: NOW }).opened).toBe(0);

    db.prepare(`
      INSERT INTO aws_cost_anomalies (account_id, anomaly_id, source, scope, scope_key, start_day, end_day, status, root_causes_json)
      VALUES (?, 'aws-anom-1', 'aws', 'service', 'Amazon Bedrock', '2026-10-18', NULL, 'open', '[]')
    `).run(id);
    const r2 = finops.detectIccAnomalies(id, { now: NOW });
    expect(r2.superseded).toBe(1);
    expect(db.prepare("SELECT superseded_by FROM aws_cost_anomalies WHERE account_id = ? AND source = 'icc'").get(id).superseded_by).toBe('aws-anom-1');
    setSetting('aws_finops_metric', 'amortized');
  });
});

describe('budgetState', () => {
  const base = { amountUsd: 1000, warnPct: 80, critPct: 100, forecastAlert: true };
  it('walks crit, warn, forecast_warn, ok', () => {
    expect(finops.budgetState({ ...base, actualUsd: 1000, forecastUsd: 1200 })).toBe('crit');
    expect(finops.budgetState({ ...base, actualUsd: 1500, forecastUsd: null })).toBe('crit');
    expect(finops.budgetState({ ...base, actualUsd: 800, forecastUsd: 900 })).toBe('warn');
    expect(finops.budgetState({ ...base, actualUsd: 799.99, forecastUsd: 1000 })).toBe('forecast_warn');
    expect(finops.budgetState({ ...base, actualUsd: 100, forecastUsd: 999 })).toBe('ok');
    expect(finops.budgetState({ ...base, actualUsd: 100, forecastUsd: null })).toBe('ok');
    expect(finops.budgetState({ ...base, forecastAlert: false, actualUsd: 100, forecastUsd: 5000 })).toBe('ok');
  });
});

describe('evaluateBudgets', () => {
  it('evaluates total, service and tag scopes and stores one status row per budget and month', () => {
    setSetting('aws_finops_metric', 'unblended');
    const id = insertAccount('budget-acct');
    const cost = db.prepare('INSERT INTO aws_cost_daily (account_id, day, service, amount_usd, amortized_usd) VALUES (?, ?, ?, ?, ?)');
    for (let d = 1; d <= 19; d++) {
      const day = `2026-10-${String(d).padStart(2, '0')}`;
      cost.run(id, day, 'Amazon EC2', 60, 10);
      cost.run(id, day, 'Amazon S3', 40, 40);
    }
    const alloc = db.prepare("INSERT INTO aws_cost_alloc_daily (account_id, day, dimension, key, value, service, amount_usd) VALUES (?, ?, 'tag', 'Environment', ?, 'Amazon EC2', ?)");
    alloc.run(id, '2026-10-05', 'dev', 90);
    alloc.run(id, '2026-10-06', 'dev', 40);
    alloc.run(id, '2026-10-06', 'prod', 500);
    const bud = db.prepare('INSERT INTO aws_budgets (name, scope_type, scope_key, scope_value, amount_usd) VALUES (?, ?, ?, ?, ?)');
    const total = bud.run('Total', 'total', null, null, 10000).lastInsertRowid;
    const svc = bud.run('EC2', 'service', null, 'Amazon EC2', 1000).lastInsertRowid;
    const tag = bud.run('Dev', 'tag', 'Environment', 'dev', 150).lastInsertRowid;

    const out = finops.evaluateBudgets({ now: NOW });
    const by = new Map(out.map((r) => [r.budgetId, r]));
    // 19 days x 100 = 1900 of 10000; run rate 100 a day over 12 days left forecasts 3100.
    expect(by.get(total)).toMatchObject({ state: 'ok', month: '2026-10' });
    expect(by.get(total).actualUsd).toBeCloseTo(1900, 6);
    expect(by.get(total).forecastUsd).toBeCloseTo(3100, 6);
    expect(by.get(svc)).toMatchObject({ state: 'crit' });
    expect(by.get(svc).actualUsd).toBeCloseTo(1140, 6);
    expect(by.get(tag).actualUsd).toBeCloseTo(130, 6);
    expect(by.get(tag).state).toBe('warn');

    // A stored CE forecast replaces the linear one for the total scope.
    db.prepare(`
      INSERT INTO aws_cost_forecast (account_id, scope, metric, period_start, period_end, generated_on, mean_usd, lower_usd, upper_usd, source)
      VALUES (?, 'total', 'unblended', '2026-10-01', '2026-11-01', '2026-10-20', 12000, 11000, 13000, 'ce')
    `).run(id);
    const again = finops.evaluateBudgets({ now: NOW });
    expect(again.find((r) => r.budgetId === total)).toMatchObject({ state: 'forecast_warn', forecastUsd: 12000 });
    const rows = db.prepare('SELECT * FROM aws_budget_status WHERE budget_id = ?').all(total);
    expect(rows).toHaveLength(1);
    expect(rows[0].forecast_source).toBe('ce');

    // Disabled budgets are not evaluated.
    db.prepare('UPDATE aws_budgets SET enabled = 0 WHERE id = ?').run(tag);
    expect(finops.evaluateBudgets({ now: NOW }).some((r) => r.budgetId === tag)).toBe(false);
    setSetting('aws_finops_metric', 'amortized');
  });
});

describe('reconcileRecommendationState', () => {
  const NOW2 = new Date('2026-10-21T08:00:00Z');
  const fresh = (items) => items.map(([finding, resourceId, est, source = 'heuristic']) => ({ source, finding, resourceId, estMonthlySavingsUsd: est }));
  const state = (id, key) => db.prepare('SELECT * FROM aws_recommendation_state WHERE account_id = ? AND rec_key = ?').get(id, key);

  it('creates, keeps, auto-completes with the last estimate and leaves dismissed rows alone', () => {
    const id = insertAccount('rec-acct');
    const opts = { sources: ['heuristic', 'compute-optimizer'], now: NOW };

    expect(finops.reconcileRecommendationState(id, fresh([
      ['ebs-unattached', 'vol-1', 12.5], ['gp2-to-gp3', 'vol-2', 3], ['ebs-unattached', 'vol-3', 8],
      ['Optimized', 'i-opt', null, 'compute-optimizer'], ['Optimized', 'i-zero', 0, 'compute-optimizer'],
    ]), opts)).toEqual({ kept: 0, created: 3, autoDone: 0 });
    expect(state(id, 'compute-optimizer|Optimized|i-opt')).toBeUndefined();

    db.prepare("UPDATE aws_recommendation_state SET status = 'accepted', note = 'ticket 42' WHERE account_id = ? AND rec_key = 'heuristic|gp2-to-gp3|vol-2'").run(id);
    db.prepare("UPDATE aws_recommendation_state SET status = 'dismissed' WHERE account_id = ? AND rec_key = 'heuristic|ebs-unattached|vol-3'").run(id);

    // vol-1 stays; vol-2 (accepted) and vol-3 (dismissed) vanish.
    const r = finops.reconcileRecommendationState(id, fresh([['ebs-unattached', 'vol-1', 14]]), { ...opts, now: NOW2 });
    expect(r).toEqual({ kept: 1, created: 0, autoDone: 1 });
    expect(state(id, 'heuristic|ebs-unattached|vol-1')).toMatchObject({ status: 'open', est_monthly_savings_usd: 14 });
    expect(state(id, 'heuristic|gp2-to-gp3|vol-2')).toMatchObject({ status: 'done', resolved_by: 'auto', realized_usd: 3, note: 'ticket 42' });
    expect(state(id, 'heuristic|gp2-to-gp3|vol-2').realized_at).toBe(NOW2.toISOString());
    expect(state(id, 'heuristic|ebs-unattached|vol-3').status).toBe('dismissed');

    // A dismissed row that reappears stays dismissed; an auto-completed one that returns reopens.
    finops.reconcileRecommendationState(id, fresh([['ebs-unattached', 'vol-3', 8], ['gp2-to-gp3', 'vol-2', 3]]), { ...opts, now: NOW2 });
    expect(state(id, 'heuristic|ebs-unattached|vol-3').status).toBe('dismissed');
    expect(state(id, 'heuristic|gp2-to-gp3|vol-2')).toMatchObject({ status: 'open', resolved_by: null, realized_usd: null });
  });

  it('only considers rows of the sources it is given', () => {
    const id = insertAccount('rec-sources');
    finops.reconcileRecommendationState(id, fresh([['Modify', 'i-1', 20, 'ce-rightsizing']]), { sources: ['ce-rightsizing'], now: NOW });
    const r = finops.reconcileRecommendationState(id, [], { sources: ['heuristic'], now: NOW });
    expect(r.autoDone).toBe(0);
    expect(state(id, 'ce-rightsizing|Modify|i-1').status).toBe('open');
  });
});

describe('allocationSummary', () => {
  it('splits allocated from unallocated and reports the coverage gap against total cost', () => {
    const rows = [
      { day: '2026-10-01', value: 'prod', service: 'EC2', usd: 50 },
      { day: '2026-10-01', value: 'prod', service: 'S3', usd: 10 },
      { day: '2026-10-01', value: 'dev', service: 'EC2', usd: 20 },
      { day: '2026-10-01', value: '', service: 'EC2', usd: 20 },
      { day: '2026-10-02', value: 'prod', service: 'EC2', usd: 40 },
      { day: '2026-10-02', value: '', service: 'S3', usd: 10 },
    ];
    const costRows = [{ day: '2026-10-01', usd: 110 }, { day: '2026-10-02', usd: 60 }];
    const a = finops.allocationSummary({ rows, costRows });
    expect(a.totalUsd).toBe(150);
    expect(a.unallocatedUsd).toBe(30);
    expect(a.allocatedUsd).toBe(120);
    expect(a.unallocatedPct).toBeCloseTo(20, 6);
    expect(a.coverageGapPct).toBeCloseTo(((170 - 150) / 170) * 100, 6);
    expect(a.values.map((v) => v.value)).toEqual(['prod', '', 'dev']);
    expect(a.values[0]).toMatchObject({ usd: 100 });
    expect(a.values[0].pct).toBeCloseTo((100 / 150) * 100, 6);
    expect(a.values[0].services).toEqual([{ service: 'EC2', usd: 90 }, { service: 'S3', usd: 10 }]);
    expect(a.days).toEqual([
      { day: '2026-10-01', values: { prod: 60, dev: 20, '': 20 } },
      { day: '2026-10-02', values: { prod: 40, '': 10 } },
    ]);
  });

  it('is all zeros for no rows', () => {
    const a = finops.allocationSummary({ rows: [], costRows: [] });
    expect(a).toMatchObject({ totalUsd: 0, unallocatedPct: 0, coverageGapPct: 0, values: [], days: [] });
  });
});

describe('unitEconomics', () => {
  it('prices Bedrock per million tokens, EC2 per instance month, S3 per TB month and Lightsail per instance', () => {
    const id = insertAccount('unit-acct');
    const usage = db.prepare('INSERT INTO aws_cost_usage_daily (account_id, day, service, usage_type, amount_usd, amortized_usd, usage_qty, usage_unit) VALUES (?, ?, ?, ?, ?, ?, ?, ?)');
    const opus = 'Claude Opus 4.6 (Amazon Bedrock Edition)';
    for (const day of ['2026-10-01', '2026-10-02']) {
      usage.run(id, day, opus, 'USE1-MP:USE1_InputTokenCount-Units', 30, 30, 2, '1M tokens');
      usage.run(id, day, opus, 'USE1-MP:USE1_OutputTokenCount-Units', 50, 50, 1, '1M tokens');
      usage.run(id, day, opus, 'USE1-MP:USE1_CacheReadInputTokenCount-Units', 5, 5, 10, '1M tokens');
      usage.run(id, day, 'Amazon EC2', 'BoxUsage:m5.large', 9, 9, 24, 'Hrs');
    }
    db.prepare("INSERT INTO aws_bedrock_usage (account_id, model_id, day, invocations) VALUES (?, 'us.anthropic.claude-opus-4-6-v1', '2026-10-01', 100)").run(id);
    db.prepare("INSERT INTO aws_bedrock_usage (account_id, model_id, day, invocations) VALUES (?, 'us.anthropic.claude-opus-4-6-v1', '2026-10-02', 50)").run(id);
    db.prepare("INSERT INTO aws_bedrock_usage (account_id, model_id, day, invocations) VALUES (?, 'us.anthropic.claude-sonnet-4-6-v1', '2026-10-02', 7)").run(id);

    const it = db.prepare('INSERT INTO aws_cost_instance_type_daily (account_id, day, instance_type, amount_usd, amortized_usd) VALUES (?, ?, ?, ?, ?)');
    it.run(id, '2026-10-01', 'm5.large', 0, 3);
    it.run(id, '2026-10-02', 'm5.large', 0, 3);
    db.prepare("INSERT INTO aws_ec2_instances (account_id, instance_id, state, instance_type) VALUES (?, 'i-1', 'running', 'm5.large')").run(id);
    db.prepare("INSERT INTO aws_ec2_instances (account_id, instance_id, state, instance_type) VALUES (?, 'i-2', 'stopped', 'm5.large')").run(id);

    const cost = db.prepare('INSERT INTO aws_cost_daily (account_id, day, service, amount_usd, amortized_usd) VALUES (?, ?, ?, ?, ?)');
    for (const day of ['2026-10-01', '2026-10-02']) {
      cost.run(id, day, 'Amazon Simple Storage Service', 2, 2);
      cost.run(id, day, 'Amazon Lightsail', 1, 1);
    }
    db.prepare("INSERT INTO aws_s3_buckets (account_id, name, size_bytes) VALUES (?, 'b1', 2000000000000)").run(id);
    db.prepare("INSERT INTO aws_lightsail_instances (account_id, name) VALUES (?, 'ls1')").run(id);
    db.prepare("INSERT INTO aws_lightsail_instances (account_id, name) VALUES (?, 'ls2')").run(id);

    const u = finops.unitEconomics({ metric: 'amortized', from: '2026-10-01', to: '2026-10-02' });
    const b = u.bedrock.find((x) => x.service === opus);
    expect(b.usd).toBeCloseTo(170, 6);
    expect(b.mTokens).toBeCloseTo(26, 6);
    expect(b.usdPerMTok).toBeCloseTo(170 / 26, 6);
    expect(b.modelId).toBe('us.anthropic.claude-opus-4-6-v1');
    expect(b.invocations).toBe(150);
    const kinds = Object.fromEntries(b.kinds.map((k) => [k.kind, k]));
    expect(kinds.input).toMatchObject({ usd: 60, mTokens: 4 });
    expect(kinds.output.usdPerMTok).toBeCloseTo(50, 6);
    expect(kinds.cacheRead.mTokens).toBe(20);
    expect(b.series).toHaveLength(2);
    expect(u.bedrock.some((x) => x.service === 'Amazon EC2')).toBe(false);

    // 6 USD over 2 days for one running instance: 3 a day x 30.4.
    const e = u.ec2.find((x) => x.instanceType === 'm5.large');
    expect(e).toMatchObject({ usd: 6, runningCount: 1 });
    expect(e.usdPerInstanceMonth).toBeCloseTo(91.2, 6);
    expect(u.s3.tb).toBeCloseTo(2, 6);
    expect(u.s3.usdPerTbMonth).toBeCloseTo((4 / 2 / 2) * 30.4, 6);
    expect(u.s3.series).toHaveLength(2);
    expect(u.lightsail.count).toBe(2);
    expect(u.lightsail.usdPerInstanceMonth).toBeCloseTo((2 / 2 / 2) * 30.4, 6);
  });
});

describe('bedrockModelForService', () => {
  const ids = ['us.anthropic.claude-sonnet-4-6-v1', 'us.anthropic.claude-opus-4-5-v1', 'us.anthropic.claude-opus-4-6-v1', 'anthropic.claude-3-5-sonnet-20241022-v2:0'];
  it('matches the family and the version', () => {
    expect(finops.bedrockModelForService('Claude Opus 4.6 (Amazon Bedrock Edition)', ids)).toBe('us.anthropic.claude-opus-4-6-v1');
    expect(finops.bedrockModelForService('Claude Sonnet 4.6 (Amazon Bedrock Edition)', ids)).toBe('us.anthropic.claude-sonnet-4-6-v1');
    expect(finops.bedrockModelForService('Claude 3.5 Sonnet (Amazon Bedrock Edition)', ids)).toBe('anthropic.claude-3-5-sonnet-20241022-v2:0');
    expect(finops.bedrockModelForService('Claude Opus 4.6 (Amazon Bedrock Edition)', ['us.anthropic.claude-opus-4_6-v1'])).toBe('us.anthropic.claude-opus-4_6-v1');
  });
  it('returns null on a wrong version, a wrong family or no digits', () => {
    expect(finops.bedrockModelForService('Claude Opus 4.7 (Amazon Bedrock Edition)', ids)).toBeNull();
    expect(finops.bedrockModelForService('Claude Haiku 4.6 (Amazon Bedrock Edition)', ids)).toBeNull();
    expect(finops.bedrockModelForService('Amazon Nova Pro', ids)).toBeNull();
    expect(finops.bedrockModelForService('Claude Opus 4.6 (Amazon Bedrock Edition)', [])).toBeNull();
  });
});

describe('finopsSettings and buildFinopsOverview', () => {
  it('clamps out-of-range settings and falls back on garbage', () => {
    setSetting('aws_finops_anomaly_pct', '9999');
    setSetting('aws_finops_anomaly_baseline_days', 'abc');
    setSetting('aws_finops_tag_keys', JSON.stringify(['Environment', '', 'x'.repeat(200)]));
    const s = finops.finopsSettings();
    expect(s.anomalyPct).toBe(500);
    expect(s.anomalyBaselineDays).toBe(7);
    expect(s.finopsTagKeys).toEqual(['Environment']);
    setSetting('aws_finops_anomaly_pct', '30');
    setSetting('aws_finops_tag_keys', '[]');
  });

  it('returns the documented overview keys on an empty and a seeded database', () => {
    const o = finops.buildFinopsOverview({ metric: 'unblended', now: NOW });
    for (const k of ['metric', 'amortizedFrom', 'month', 'kpis', 'mix', 'trend', 'topMovers', 'budgets', 'anomalies']) expect(o).toHaveProperty(k);
    // Movers: increases first (largest to smallest), then decreases (largest to smallest), at most 8.
    expect(o.topMovers.length).toBeLessThanOrEqual(8);
    const signs = o.topMovers.map((m) => (m.deltaUsd >= 0 ? 1 : -1));
    expect(signs.indexOf(-1) === -1 || signs.lastIndexOf(1) < signs.indexOf(-1)).toBe(true);
    for (let i = 1; i < o.topMovers.length; i++) {
      if (signs[i] === signs[i - 1]) expect(Math.abs(o.topMovers[i].deltaUsd)).toBeLessThanOrEqual(Math.abs(o.topMovers[i - 1].deltaUsd));
    }
    expect(o.trend).toHaveLength(13);
    expect(o.trend[12].month).toBe('2026-10');
    for (const k of ['mtdUsd', 'forecastUsd', 'forecastSource', 'lastMonthUsd', 'momPct', 'runRatePerDayUsd', 'commitmentCoveragePct',
      'commitmentUtilizationPct', 'openAnomalies', 'potentialSavingsUsd', 'realizedSavings90dUsd', 'unallocatedPct', 'unallocatedTagKey']) {
      expect(o.kpis).toHaveProperty(k);
    }
    expect(o.kpis.mtdUsd).toBeGreaterThan(0);          // seeded by the budget test above
    expect(o.mix.length).toBeGreaterThan(0);
    expect(o.kpis.forecastSource).toBe('ce');
    expect(o.budgets.length).toBeGreaterThan(0);
  });
});
