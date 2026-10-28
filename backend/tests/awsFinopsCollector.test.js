/**
 * AWS FinOps collector: multi-metric parsing from a real Cost Explorer answer, every new fetcher's
 * parser, the capability wrapper, captureFinops (degrades per capability, stamps, rethrows credential
 * errors), storeOptimizer keeping the ce-* rows, and migration v11 on a v10 database.
 */
import { describe, it, expect, beforeAll, beforeEach, afterEach, vi } from 'vitest';
import { createRequire } from 'module';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const require = createRequire(import.meta.url);

const db = require('../db/database');
const Database = require('better-sqlite3');
const { runMigrations } = require('../core/migrations');
const awsMigrations = require('../db/migrations/aws');
const { setSetting, getSetting } = require('../services/settings');
const awsApi = require('../services/awsApi');
const poller = require('../services/awsPoller');
const finops = require('../services/awsFinops');
const CE = require('@aws-sdk/client-cost-explorer');

const here = path.dirname(fileURLToPath(import.meta.url));
const fixture = JSON.parse(fs.readFileSync(path.join(here, 'fixtures', 'aws-ce-multi-metric-usage.json'), 'utf8'));

beforeAll(() => {
  runMigrations(db, 'aws', awsMigrations);
});

function insertAccount(name, extra = {}) {
  const id = db.prepare("INSERT INTO aws_accounts (name, access_key_id, region, polling_interval_minutes) VALUES (?, 'AKIATEST', 'us-east-2', 10)")
    .run(name).lastInsertRowid;
  if (extra.stamp) db.prepare("UPDATE aws_accounts SET last_finops_capture_at = datetime('now') WHERE id = ?").run(id);
  return db.prepare('SELECT * FROM aws_accounts WHERE id = ?').get(id);
}

let spy;
/** Route every Cost Explorer send through handler(commandName, input); handler returns a response or throws. */
function mockCe(handler) {
  spy = vi.spyOn(CE.CostExplorerClient.prototype, 'send').mockImplementation(async (cmd) => handler(cmd.constructor.name, cmd.input));
}
const SP = require('@aws-sdk/client-savingsplans');
const BUD = require('@aws-sdk/client-budgets');
const HUB = require('@aws-sdk/client-cost-optimization-hub');
const PRC = require('@aws-sdk/client-pricing');
const CO = require('@aws-sdk/client-compute-optimizer');
const S3 = require('@aws-sdk/client-s3');
const CW = require('@aws-sdk/client-cloudwatch');

let otherSpies = [];
const DENY_ACTIONS = {
  DescribeSavingsPlansCommand: 'savingsplans:DescribeSavingsPlans',
  DescribeBudgetsCommand: 'budgets:ViewBudget',
  DescribeBudgetNotificationsForAccountCommand: 'budgets:ViewBudget',
  ListEnrollmentStatusesCommand: 'cost-optimization-hub:ListEnrollmentStatuses',
  ListRecommendationsCommand: 'cost-optimization-hub:ListRecommendations',
  GetProductsCommand: 'pricing:GetProducts',
  GetEnrollmentStatusCommand: 'compute-optimizer:GetEnrollmentStatus',
  GetIdleRecommendationsCommand: 'compute-optimizer:GetIdleRecommendations',
  GetRDSDatabaseRecommendationsCommand: 'compute-optimizer:GetRDSDatabaseRecommendations',
  GetBucketTaggingCommand: 's3:GetBucketTagging',
};
/**
 * Route every non-Cost-Explorer send (Savings Plans, Budgets, Cost Optimization Hub, Pricing, Compute Optimizer,
 * S3, CloudWatch) through handlers[commandName](input). A command with no handler answers AccessDenied naming its
 * IAM action, so a test only spells out the services it exercises.
 */
function mockOthers(handlers = {}) {
  for (const C of [SP.SavingsplansClient, BUD.BudgetsClient, HUB.CostOptimizationHubClient, PRC.PricingClient, CO.ComputeOptimizerClient, S3.S3Client, CW.CloudWatchClient]) {
    otherSpies.push(vi.spyOn(C.prototype, 'send').mockImplementation(async (cmd) => {
      const name = cmd.constructor.name;
      if (handlers[name]) return handlers[name](cmd.input);
      throw denied(DENY_ACTIONS[name] || `unknown:${name}`);
    }));
  }
}
afterEach(() => {
  if (spy) { spy.mockRestore(); spy = null; }
  for (const o of otherSpies) o.mockRestore();
  otherSpies = [];
});

const denied = (action) => Object.assign(new Error(`User: arn:aws:iam::123456789012:user/dashboard-readonly is not authorized to perform: ${action} on resource: arn:aws:ce:us-east-1:123456789012:/x because no identity-based policy allows the ${action} action`), { name: 'AccessDeniedException' });

describe('multi-metric parsing (real Cost Explorer answer)', () => {
  it('reads unblended, amortized and usage quantity from one response', async () => {
    mockCe(() => fixture);
    const acct = insertAccount('fixture-acct');
    const rows = await awsApi.fetchCostByUsageType(acct);
    expect(rows.length).toBe(fixture.ResultsByTime.reduce((n, p) => n + p.Groups.length, 0));
    const sp = rows.find((r) => r.service === 'Savings Plans for AWS Compute usage' && r.usageType === 'ComputeSP:1yrNoUpfront');
    expect(sp.amountUsd).toBeCloseTo(53.904, 6);
    expect(sp.amortizedUsd).toBeCloseTo(3.002736, 6);
    const opus = rows.find((r) => r.service.startsWith('Claude Opus 4.6') && /OutputTokenCount/.test(r.usageType));
    expect(opus.usageUnit).toBe('1M tokens');
    expect(opus.usageQty).toBeGreaterThan(0);
    expect(typeof opus.amountUsd).toBe('number');
    // The two metrics add up to the same day total on this account (143.95 on the first day).
    const firstDay = fixture.ResultsByTime[0].TimePeriod.Start;
    const sum = (k) => rows.filter((r) => r.day === firstDay).reduce((n, r) => n + r[k], 0);
    expect(sum('amountUsd')).toBeCloseTo(sum('amortizedUsd'), 2);
    // Both metrics plus UsageQuantity were requested.
    expect(spy.mock.calls[0][0].input.Metrics).toEqual(['UnblendedCost', 'AmortizedCost', 'UsageQuantity']);
  });

  it('service and instance-type fetchers carry amortizedUsd and the options form returns keys and requests', async () => {
    mockCe((name, input) => {
      expect(name).toBe('GetCostAndUsageCommand');
      expect(input.Metrics).toEqual(['UnblendedCost', 'AmortizedCost']);
      return { ResultsByTime: [{ TimePeriod: { Start: '2026-10-01', End: '2026-10-02' }, Groups: [
        { Keys: [input.GroupBy[0].Type === 'TAG' ? 'Environment$prod' : 'm5.large', 'Amazon EC2'], Metrics: { UnblendedCost: { Amount: '0' }, AmortizedCost: { Amount: '2.88' } } },
        { Keys: [input.GroupBy[0].Type === 'TAG' ? 'Environment$' : 'NoInstanceType', 'Amazon S3'], Metrics: { UnblendedCost: { Amount: '4' }, AmortizedCost: { Amount: '4' } } },
      ] }] };
    });
    const acct = insertAccount('grouped-acct');
    const svc = await awsApi.fetchCostAndUsage(acct);
    expect(svc[0]).toMatchObject({ day: '2026-10-01', amountUsd: 0, amortizedUsd: 2.88 });
    const inst = await awsApi.fetchCostByInstanceType(acct);
    expect(inst[0]).toEqual({ day: '2026-10-01', instanceType: 'm5.large', amountUsd: 0, amortizedUsd: 2.88 });
    const tag = await awsApi.fetchCostAndUsageGrouped(acct, { start: '2026-09-01', end: '2026-10-01', groupBy: [{ Type: 'TAG', Key: 'Environment' }, { Type: 'DIMENSION', Key: 'SERVICE' }] });
    expect(tag.requests).toBe(1);
    expect(tag.rows[0]).toEqual({ day: '2026-10-01', keys: ['Environment$prod', 'Amazon EC2'], amountUsd: 0, amortizedUsd: 2.88 });
    expect(spy.mock.calls.at(-1)[0].input.TimePeriod).toEqual({ Start: '2026-09-01', End: '2026-10-01' });
  });

  it('follows NextPageToken and counts the requests', async () => {
    let n = 0;
    mockCe(() => {
      n++;
      return { ResultsByTime: [{ TimePeriod: { Start: `2026-10-0${n}` }, Groups: [{ Keys: ['S'], Metrics: { UnblendedCost: { Amount: '1' }, AmortizedCost: { Amount: '1' } } }] }], NextPageToken: n < 3 ? `t${n}` : undefined };
    });
    const out = await awsApi.fetchCostAndUsageGrouped(insertAccount('paged'), { start: '2026-10-01', end: '2026-10-05', groupBy: [{ Type: 'DIMENSION', Key: 'SERVICE' }] });
    expect(out.requests).toBe(3);
    expect(out.rows).toHaveLength(3);
  });
});

describe('fetcher parsers (shapes from the installed SDK types)', () => {
  const acct = () => insertAccount(`parse-${Math.random().toString(36).slice(2, 8)}`);
  const win = { start: '2026-09-20', end: '2026-10-20' };

  it('allocation tags, linked accounts and forecast', async () => {
    mockCe((name) => {
      if (name === 'ListCostAllocationTagsCommand') return { CostAllocationTags: [{ TagKey: 'Environment', Type: 'UserDefined', Status: 'Active', LastUpdatedDate: '2026-09-01' }, { TagKey: 'Old', Status: 'Inactive' }] };
      if (name === 'GetDimensionValuesCommand') return { DimensionValues: [{ Value: '111', Attributes: { description: 'prod' } }, { Value: '222' }], ReturnSize: 2, TotalSize: 2 };
      return { ForecastResultsByTime: [
        { TimePeriod: { Start: '2026-10-21', End: '2026-10-22' }, MeanValue: '1234.5', PredictionIntervalLowerBound: '1000', PredictionIntervalUpperBound: '1500.25' },
        { TimePeriod: { Start: '2026-10-22', End: '2026-10-23' }, MeanValue: '100', PredictionIntervalLowerBound: '90', PredictionIntervalUpperBound: '110' },
      ] };
    });
    const tags = await awsApi.fetchCostAllocationTags(acct());
    expect(tags.requests).toBe(1);
    expect(tags.rows).toEqual([
      { tagKey: 'Environment', type: 'UserDefined', status: 'Active', lastUpdatedDate: '2026-09-01' },
      { tagKey: 'Old', type: null, status: 'Inactive', lastUpdatedDate: null },
    ]);
    expect((await awsApi.fetchLinkedAccountValues(acct())).rows).toEqual([{ value: '111', description: 'prod' }, { value: '222', description: null }]);
    const f = await awsApi.fetchCostForecast(acct(), { metric: 'AMORTIZED_COST', start: '2026-10-21', end: '2026-11-01' });
    expect(f.requests).toBe(1);
    expect(f.rows[0]).toEqual({ periodStart: '2026-10-21', periodEnd: '2026-10-22', meanUsd: 1234.5, lowerUsd: 1000, upperUsd: 1500.25 });
    const input = spy.mock.calls.at(-1)[0].input;
    expect(input).toMatchObject({ Metric: 'AMORTIZED_COST', Granularity: 'DAILY', PredictionIntervalLevel: 80 });
    expect(f.rows).toHaveLength(2);
    expect(f.rows[1]).toMatchObject({ periodStart: '2026-10-22', meanUsd: 100, lowerUsd: 90, upperUsd: 110 });
  });

  it('Savings Plans utilization, details and coverage', async () => {
    mockCe((name) => {
      if (name === 'GetSavingsPlansUtilizationCommand') return { Total: {}, SavingsPlansUtilizationsByTime: [{ TimePeriod: { Start: '2026-10-01', End: '2026-10-02' },
        Utilization: { TotalCommitment: '72', UsedCommitment: '66.5', UnusedCommitment: '5.5', UtilizationPercentage: '92.36' }, Savings: { NetSavings: '40.1', OnDemandCostEquivalent: '112.1' } }] };
      if (name === 'GetSavingsPlansUtilizationDetailsCommand') return { SavingsPlansUtilizationDetails: [{
        SavingsPlanArn: 'arn:aws:savingsplans::123456789012:savingsplan/abc-123',
        Attributes: { SavingsPlansType: 'COMPUTE_SP', PaymentOption: 'NO_UPFRONT', PurchaseTerm: '1yr', HourlyCommitment: '3.0', Region: 'ALL', InstanceFamily: 'ALL', StartDateTime: '2026-01-01T00:00:00Z', EndDateTime: '2027-01-01T00:00:00Z' },
        Utilization: { UtilizationPercentage: '91' }, Savings: { NetSavings: '1200.5' } }, { Attributes: {} }], TimePeriod: {} };
      return { SavingsPlansCoverages: [{ TimePeriod: { Start: '2026-10-01', End: '2026-10-02' }, Coverage: { SpendCoveredBySavingsPlans: '60', OnDemandCost: '40', TotalCost: '100', CoveragePercentage: '60' } }] };
    });
    expect((await awsApi.fetchSavingsPlansUtilization(acct(), win)).rows).toEqual([
      { day: '2026-10-01', utilizationPct: 92.36, commitmentUsd: 72, usedUsd: 66.5, unusedUsd: 5.5, netSavingsUsd: 40.1, onDemandEquivalentUsd: 112.1 }]);
    expect((await awsApi.fetchSavingsPlansUtilizationDetails(acct(), win)).rows).toEqual([{
      spArn: 'arn:aws:savingsplans::123456789012:savingsplan/abc-123', spType: 'COMPUTE_SP', paymentOption: 'NO_UPFRONT', term: '1yr',
      hourlyCommitmentUsd: 3, region: 'ALL', instanceFamily: 'ALL', startAt: '2026-01-01T00:00:00Z', endAt: '2027-01-01T00:00:00Z', utilizationPct: 91, netSavingsUsd: 1200.5 }]);
    expect((await awsApi.fetchSavingsPlansCoverage(acct(), win)).rows).toEqual([{ day: '2026-10-01', coveragePct: 60, coveredUsd: 60, onDemandUsd: 40, totalUsd: 100 }]);
    expect(spy.mock.calls.at(-1)[0].input.Metrics).toEqual(['SpendCoveredBySavingsPlans']);
  });

  it('reservation utilization and coverage', async () => {
    mockCe((name) => (name === 'GetReservationUtilizationCommand'
      ? { UtilizationsByTime: [{ TimePeriod: { Start: '2026-10-01' }, Total: { UtilizationPercentage: '88.5', PurchasedHours: '240', TotalActualHours: '212.4', UnusedHours: '27.6', NetRISavings: '31.2' } }] }
      : { CoveragesByTime: [{ TimePeriod: { Start: '2026-10-01' }, Total: { CoverageHours: { CoverageHoursPercentage: '45.5', ReservedHours: '100', OnDemandHours: '120', TotalRunningHours: '220' } } }] }));
    expect((await awsApi.fetchReservationUtilization(acct(), win)).rows).toEqual([{ day: '2026-10-01', utilizationPct: 88.5, purchasedHours: 240, usedHours: 212.4, unusedHours: 27.6, netSavingsUsd: 31.2 }]);
    expect((await awsApi.fetchReservationCoverage(acct(), win)).rows).toEqual([{ day: '2026-10-01', coveragePct: 45.5, reservedHours: 100, onDemandHours: 120, totalHours: 220 }]);
  });

  it('anomaly monitors and anomalies', async () => {
    mockCe((name) => (name === 'GetAnomalyMonitorsCommand'
      ? { AnomalyMonitors: [{ MonitorArn: 'arn:mon/1', MonitorName: 'Services', MonitorType: 'DIMENSIONAL', MonitorDimension: 'SERVICE' }] }
      : { Anomalies: [{ AnomalyId: 'an-1', AnomalyStartDate: '2026-10-10', AnomalyEndDate: '2026-10-12', DimensionValue: 'Amazon OpenSearch Service', MonitorArn: 'arn:mon/1',
        AnomalyScore: { MaxScore: 90, CurrentScore: 55.5 }, Impact: { MaxImpact: 50, TotalImpact: 120, TotalActualSpend: 220, TotalExpectedSpend: 100, TotalImpactPercentage: 120 }, Feedback: 'YES',
        RootCauses: [{ Service: 'Amazon OpenSearch Service', Region: 'us-east-1', UsageType: 'ESInstance', LinkedAccount: '111', LinkedAccountName: 'prod' }] }] }));
    expect((await awsApi.fetchAnomalyMonitors(acct())).rows).toEqual([{ monitorArn: 'arn:mon/1', name: 'Services', type: 'DIMENSIONAL', dimension: 'SERVICE' }]);
    const a = await awsApi.fetchAnomalies(acct(), win);
    expect(a.rows).toEqual([{
      anomalyId: 'an-1', startDay: '2026-10-10', endDay: '2026-10-12', monitorArn: 'arn:mon/1', dimensionValue: 'Amazon OpenSearch Service',
      actualUsd: 220, expectedUsd: 100, impactUsd: 120, impactPct: 120, score: 55.5, feedback: 'YES',
      rootCauses: [{ service: 'Amazon OpenSearch Service', region: 'us-east-1', usageType: 'ESInstance', linkedAccount: '111', linkedAccountName: 'prod' }] }]);
    expect(spy.mock.calls.at(-1)[0].input.MaxResults).toBe(100);
  });

  it('rightsizing (modify and terminate) and the Savings Plan purchase recommendation', async () => {
    const ec2 = (type) => ({ EC2ResourceDetails: { InstanceType: type, Region: 'us-east-1' } });
    mockCe((name) => (name === 'GetRightsizingRecommendationCommand'
      ? { RightsizingRecommendations: [
        { RightsizingType: 'Modify', CurrentInstance: { ResourceId: 'i-1', InstanceName: 'web', MonthlyCost: '140.2', ResourceDetails: ec2('m5.2xlarge'), ResourceUtilization: { EC2ResourceUtilization: { MaxCpuUtilizationPercentage: '12.5' } } },
          ModifyRecommendationDetail: { TargetInstances: [{ EstimatedMonthlySavings: '70.1', ResourceDetails: ec2('m5.xlarge') }] } },
        { RightsizingType: 'Terminate', CurrentInstance: { ResourceId: 'i-2', ResourceDetails: ec2('t3.large') }, TerminateRecommendationDetail: { EstimatedMonthlySavings: '60' } },
        { RightsizingType: 'Modify', CurrentInstance: {} }] }
      : { SavingsPlansPurchaseRecommendation: { SavingsPlansType: 'COMPUTE_SP', TermInYears: 'ONE_YEAR', PaymentOption: 'NO_UPFRONT', LookbackPeriodInDays: 'THIRTY_DAYS',
        SavingsPlansPurchaseRecommendationDetails: [{ HourlyCommitmentToPurchase: '1.25', EstimatedMonthlySavingsAmount: '210.5', EstimatedSavingsPercentage: '22.1', EstimatedOnDemandCost: '950', CurrentAverageHourlyOnDemandSpend: '1.9' }] } }));
    const r = await awsApi.fetchRightsizingRecommendations(acct());
    expect(r.rows).toEqual([
      { resourceId: 'i-1', resourceName: 'web', region: 'us-east-1', currentType: 'm5.2xlarge', action: 'Modify', recommendedType: 'm5.xlarge', estMonthlySavingsUsd: 70.1, currentMonthlyCostUsd: 140.2, cpuMaxPct: 12.5 },
      { resourceId: 'i-2', resourceName: null, region: 'us-east-1', currentType: 't3.large', action: 'Terminate', recommendedType: null, estMonthlySavingsUsd: 60, currentMonthlyCostUsd: null, cpuMaxPct: null },
    ]);
    expect(spy.mock.calls[0][0].input).toMatchObject({ Service: 'AmazonEC2', PageSize: 100 });
    const p = await awsApi.fetchSavingsPlansPurchaseRecommendation(acct());
    expect(p.rows).toEqual([{ spType: 'COMPUTE_SP', term: 'ONE_YEAR', paymentOption: 'NO_UPFRONT', hourlyCommitmentUsd: 1.25, estMonthlySavingsUsd: 210.5,
      estSavingsPct: 22.1, estOnDemandCostUsd: 950, currentAvgHourlyOnDemandUsd: 1.9, lookbackDays: 30 }]);
    expect(spy.mock.calls.at(-1)[0].input).toMatchObject({ SavingsPlansType: 'COMPUTE_SP', TermInYears: 'ONE_YEAR', PaymentOption: 'NO_UPFRONT', LookbackPeriodInDays: 'THIRTY_DAYS' });
  });
});

describe('error classification', () => {
  it('classifies denied, not_enabled and error and parses the action from the message', () => {
    expect(awsApi.classifyCeError(denied('ce:GetCostForecast'))).toBe('denied');
    expect(awsApi.classifyCeError({ name: 'ValidationException', message: 'bad input' })).toBe('error');
    // Cost Explorer reports a console opt-in feature as AccessDeniedException with an opt-in message (rightsizing, live 2026-10-27).
    expect(awsApi.classifyCeError({ name: 'AccessDeniedException', message: 'Rightsizing EC2 recommendation is an opt-in only feature. You can enable this feature from the PAYER account Cost Explorer Preferences page.' })).toBe('not_enabled');
    expect(awsApi.classifyCeError({ name: 'X', message: 'Resource-level data has not been enabled' })).toBe('not_enabled');
    expect(awsApi.classifyCeError({ name: 'ThrottlingException', message: 'slow down' })).toBe('error');
    expect(awsApi.classifyCostResourceError).toBe(awsApi.classifyCeError);
    expect(awsApi.actionFromDeniedMessage(denied('ce:GetCostForecast').message)).toBe('ce:GetCostForecast');
    expect(awsApi.actionFromDeniedMessage('boom')).toBeNull();
  });
});

describe('capability wrapper', () => {
  const status = (acct, id) => db.prepare('SELECT * FROM aws_capability_status WHERE account_id = ? AND capability = ?').get(acct.id, id);

  it('records ok with the request count, then denied with the action, keeping last_ok_at', async () => {
    const acct = insertAccount('cap-acct');
    const ok = await finops._capability(acct, 'forecast', async () => ({ requests: 2 }));
    expect(ok.status).toBe('ok');
    expect(status(acct, 'forecast')).toMatchObject({ status: 'ok', requests: 2, error: null });
    const firstOk = status(acct, 'forecast').last_ok_at;
    expect(firstOk).toBeTruthy();

    const d = await finops._capability(acct, 'forecast', async () => { throw denied('ce:GetCostForecast'); });
    expect(d.status).toBe('denied');
    const row = status(acct, 'forecast');
    expect(row).toMatchObject({ status: 'denied', requests: 0 });
    expect(row.error).toContain('ce:GetCostForecast');
    expect(row.last_ok_at).toBe(firstOk);

    expect((await finops._capability(acct, 'rightsizing', async () => { throw Object.assign(new Error('Enable rightsizing in the Cost Management preferences'), { name: 'ValidationException' }); })).status).toBe('not_enabled');
    expect((await finops._capability(acct, 'anomalies', async () => { throw new Error('socket hang up'); })).status).toBe('error');
    expect((await finops._capability(acct, 'ri_coverage', async () => { throw Object.assign(new Error('no data'), { name: 'DataUnavailableException' }); })).status).toBe('ok');
  });

  it('rethrows credential errors before classifying and records nothing', async () => {
    const acct = insertAccount('cap-cred');
    await expect(finops._capability(acct, 'forecast', async () => { throw Object.assign(new Error('The security token included in the request is expired'), { name: 'ExpiredToken' }); }))
      .rejects.toThrow(/expired/);
    expect(status(acct, 'forecast')).toBeUndefined();
  });

  it('capabilityRows lists every capability (unknown when never run) and missingActions lists denied ones', async () => {
    const acct = insertAccount('cap-rows');
    await finops._capability(acct, 'forecast', async () => { throw denied('ce:GetCostForecast'); });
    await finops._capability(acct, 'sp_utilization', async () => { throw denied('ce:GetSavingsPlansUtilization'); });
    const rows = finops.capabilityRows(acct.id);
    expect(rows.map((r) => r.capability)).toEqual([...finops.CAPABILITIES, 'cost_resources']);
    const f = rows.find((r) => r.capability === 'forecast');
    expect(f).toMatchObject({ status: 'denied', iamActions: ['ce:GetCostForecast'] });
    expect(Array.isArray(f.iamActions)).toBe(true);
    expect(rows.find((r) => r.capability === 'tag_keys').status).toBe('unknown');
    expect(finops.missingActions(acct.id)).toEqual(['ce:GetCostForecast', 'ce:GetSavingsPlansUtilization']);
  });
});

describe('captureFinops', () => {
  const NOW = new Date('2026-10-20T12:00:00Z');

  /** Healthy answers for every command except the ones the test overrides. */
  function handler(overrides = {}) {
    return (name, input) => {
      if (overrides[name]) return overrides[name](input);
      switch (name) {
        case 'GetCostAndUsageCommand': {
          const first = input.GroupBy[0];
          const keys = first.Type === 'TAG' ? ['Environment$prod', 'Amazon EC2'] : ['Amazon EC2'];
          return { ResultsByTime: [{ TimePeriod: { Start: '2026-10-18', End: '2026-10-19' }, Groups: [{ Keys: keys, Metrics: { UnblendedCost: { Amount: '10' }, AmortizedCost: { Amount: '9' } } }] }] };
        }
        case 'ListCostAllocationTagsCommand': return { CostAllocationTags: [{ TagKey: 'Environment', Status: 'Active', Type: 'UserDefined' }] };
        case 'GetDimensionValuesCommand': return { DimensionValues: [{ Value: '111' }], ReturnSize: 1, TotalSize: 1 };
        case 'GetCostForecastCommand': return { ForecastResultsByTime: [{ TimePeriod: { Start: '2026-10-21', End: '2026-11-01' }, MeanValue: '500', PredictionIntervalLowerBound: '400', PredictionIntervalUpperBound: '600' }] };
        case 'GetSavingsPlansUtilizationCommand': return { Total: {}, SavingsPlansUtilizationsByTime: [{ TimePeriod: { Start: '2026-10-18' }, Utilization: { TotalCommitment: '72', UsedCommitment: '70', UnusedCommitment: '2', UtilizationPercentage: '97.2' }, Savings: { NetSavings: '30', OnDemandCostEquivalent: '100' } }] };
        case 'GetSavingsPlansUtilizationDetailsCommand': return { SavingsPlansUtilizationDetails: [{ SavingsPlanArn: 'arn:aws:savingsplans::1:savingsplan/p-1', Attributes: { SavingsPlansType: 'COMPUTE_SP', PurchaseTerm: '1yr', HourlyCommitment: '3', EndDateTime: '2027-01-01T00:00:00Z' } }], TimePeriod: {} };
        case 'GetSavingsPlansCoverageCommand': return { SavingsPlansCoverages: [{ TimePeriod: { Start: '2026-10-18' }, Coverage: { CoveragePercentage: '61', SpendCoveredBySavingsPlans: '61', OnDemandCost: '39', TotalCost: '100' } }] };
        case 'GetReservationUtilizationCommand':
        case 'GetReservationCoverageCommand': throw Object.assign(new Error('No reservations found'), { name: 'DataUnavailableException' });
        case 'GetAnomalyMonitorsCommand': return { AnomalyMonitors: [{ MonitorArn: 'arn:mon/1', MonitorName: 'Services', MonitorType: 'DIMENSIONAL', MonitorDimension: 'SERVICE' }] };
        case 'GetAnomaliesCommand': return { Anomalies: [{ AnomalyId: 'an-9', AnomalyStartDate: '2026-10-17', DimensionValue: 'Amazon RDS', MonitorArn: 'arn:mon/1', AnomalyScore: { CurrentScore: 40 }, Impact: { TotalImpact: 30, TotalActualSpend: 80, TotalExpectedSpend: 50, TotalImpactPercentage: 60 } }] };
        case 'GetRightsizingRecommendationCommand': return { RightsizingRecommendations: [{ RightsizingType: 'Terminate', CurrentInstance: { ResourceId: 'i-9', ResourceDetails: { EC2ResourceDetails: { InstanceType: 't3.large', Region: 'us-east-1' } } }, TerminateRecommendationDetail: { EstimatedMonthlySavings: '45' } }] };
        case 'GetSavingsPlansPurchaseRecommendationCommand': return { SavingsPlansPurchaseRecommendation: { SavingsPlansType: 'COMPUTE_SP', TermInYears: 'ONE_YEAR', PaymentOption: 'NO_UPFRONT', SavingsPlansPurchaseRecommendationDetails: [{ HourlyCommitmentToPurchase: '1.5', EstimatedMonthlySavingsAmount: '120', EstimatedOnDemandCost: '900' }] } };
        case 'ListCostCategoryDefinitionsCommand': return { CostCategoryReferences: [] };
        case 'GetCostAndUsageComparisonsCommand': return { CostAndUsageComparisons: [] };
        default: throw new Error(`unexpected command ${name}`);
      }
    };
  }

  beforeEach(() => {
    setSetting('aws_finops_tag_keys', JSON.stringify(['Environment']));
    setSetting('aws_finops_linked_accounts', 'auto');
    mockOthers();   // the round 2 services answer AccessDenied unless a test says otherwise
  });

  it('continues after a denied capability, stores what worked and stamps the account', async () => {
    mockCe(handler({ GetCostForecastCommand: () => { throw denied('ce:GetCostForecast'); } }));
    const acct = insertAccount('capture-ok');
    const out = await finops.captureFinops(acct, { skipped: [], now: NOW });

    expect(out.capabilities.forecast).toBe('denied');
    expect(out.capabilities.tag_keys).toBe('ok');
    expect(out.capabilities.cost_tags).toBe('ok');
    expect(out.capabilities.linked_accounts).toBe('ok');
    expect(out.capabilities.sp_utilization).toBe('ok');
    expect(out.capabilities.ri_utilization).toBe('ok');   // DataUnavailable is "nothing yet", not a failure
    expect(out.capabilities.anomalies).toBe('ok');
    expect(out.requests).toBeGreaterThan(8);

    const row = db.prepare('SELECT last_finops_capture_at, finops_backfill_at FROM aws_accounts WHERE id = ?').get(acct.id);
    expect(row.last_finops_capture_at).toBeTruthy();
    expect(row.finops_backfill_at).toBeTruthy();
    expect(JSON.parse(getSetting('aws_finops_tag_keys_seen'))).toEqual(['Environment']);
    expect(db.prepare("SELECT COUNT(*) AS n FROM aws_cost_daily WHERE account_id = ? AND amortized_usd = 9").get(acct.id).n).toBe(1);
    expect(db.prepare("SELECT value, service, amortized_usd FROM aws_cost_alloc_daily WHERE account_id = ? AND dimension = 'tag'").get(acct.id))
      .toEqual({ value: 'prod', service: 'Amazon EC2', amortized_usd: 9 });
    expect(db.prepare('SELECT COUNT(*) AS n FROM aws_sp_utilization_daily WHERE account_id = ?').get(acct.id).n).toBe(1);
    expect(db.prepare('SELECT COUNT(*) AS n FROM aws_sp_coverage_daily WHERE account_id = ?').get(acct.id).n).toBe(1);
    expect(db.prepare('SELECT sp_arn, hourly_commitment_usd FROM aws_savings_plans WHERE account_id = ?').get(acct.id)).toEqual({ sp_arn: 'arn:aws:savingsplans::1:savingsplan/p-1', hourly_commitment_usd: 3 });
    expect(db.prepare("SELECT scope_key, status, source FROM aws_cost_anomalies WHERE account_id = ? AND source = 'aws'").get(acct.id)).toEqual({ scope_key: 'Amazon RDS', status: 'open', source: 'aws' });
    expect(JSON.parse(getSetting('aws_finops_anomaly_monitors'))[0].name).toBe('Services');

    // Cost Explorer recommendations land in the optimizer table with lifecycle state rows.
    const recs = db.prepare("SELECT source, resource_id, finding, est_monthly_savings_usd FROM aws_optimizer_recommendations WHERE account_id = ? ORDER BY source").all(acct.id);
    expect(recs).toEqual([
      { source: 'ce-rightsizing', resource_id: 'i-9', finding: 'Terminate', est_monthly_savings_usd: 45 },
      { source: 'ce-savings-plan', resource_id: 'COMPUTE_SP|ONE_YEAR|NO_UPFRONT', finding: 'purchase-savings-plan', est_monthly_savings_usd: 120 },
    ]);
    expect(db.prepare('SELECT COUNT(*) AS n FROM aws_recommendation_state WHERE account_id = ?').get(acct.id).n).toBe(2);
    // The forecast failed and there are too few days for a linear one: no forecast row, no crash.
    expect(db.prepare('SELECT COUNT(*) AS n FROM aws_cost_forecast WHERE account_id = ?').get(acct.id).n).toBe(0);
  });

  it('stores the CE forecast as month to date plus the remaining days', async () => {
    mockCe(handler());
    const acct = insertAccount('capture-forecast');
    db.prepare("INSERT INTO aws_cost_daily (account_id, day, service, amount_usd, amortized_usd) VALUES (?, '2026-10-05', 'Amazon EC2', 100, 100)").run(acct.id);
    await finops.captureFinops(acct, { skipped: [], now: NOW });
    const f = db.prepare('SELECT * FROM aws_cost_forecast WHERE account_id = ?').get(acct.id);
    expect(f).toMatchObject({ scope: 'total', metric: 'amortized', period_start: '2026-10-01', period_end: '2026-11-01', generated_on: '2026-10-20', source: 'ce' });
    // month to date = 100 seeded + 9 from the backfill day 2026-10-18 (amortized); remaining 500.
    expect(f.mean_usd).toBeCloseTo(609, 6);
    expect(f.lower_usd).toBeCloseTo(509, 6);
    expect(f.upper_usd).toBeCloseTo(709, 6);
  });

  it('does not run the cost tag capability without configured keys', async () => {
    setSetting('aws_finops_tag_keys', '[]');
    mockCe(handler());
    const acct = insertAccount('capture-notags');
    const out = await finops.captureFinops(acct, { skipped: [], now: NOW });
    expect(out.capabilities.cost_tags).toBe('unknown');
    expect(spy.mock.calls.some(([c]) => c.input.GroupBy?.[0]?.Type === 'TAG')).toBe(false);
  });

  it('rethrows a credential error and does not stamp', async () => {
    mockCe(handler({ ListCostAllocationTagsCommand: () => { throw Object.assign(new Error('The security token included in the request is expired'), { name: 'ExpiredToken' }); } }));
    const acct = insertAccount('capture-cred');
    await expect(finops.captureFinops(acct, { skipped: [], now: NOW })).rejects.toThrow(/expired/);
    expect(db.prepare('SELECT last_finops_capture_at FROM aws_accounts WHERE id = ?').get(acct.id).last_finops_capture_at).toBeNull();
  });

  it('a failed rightsizing call keeps the previous ce-rightsizing rows', async () => {
    const acct = insertAccount('capture-keep');
    poller.storeCeRecommendations(acct.id, [{ source: 'ce-rightsizing', resourceType: 'ec2', resourceId: 'i-old', finding: 'Modify', estMonthlySavingsUsd: 30 }], { sources: ['ce-rightsizing'] });
    mockCe(handler({ GetRightsizingRecommendationCommand: () => { throw Object.assign(new Error('Enable rightsizing preference'), { name: 'ValidationException' }); } }));
    const out = await finops.captureFinops(acct, { skipped: [], now: NOW });
    expect(out.capabilities.rightsizing).toBe('not_enabled');
    const ids = db.prepare("SELECT resource_id FROM aws_optimizer_recommendations WHERE account_id = ? AND source = 'ce-rightsizing'").all(acct.id).map((r) => r.resource_id);
    expect(ids).toEqual(['i-old']);
    expect(db.prepare("SELECT status FROM aws_recommendation_state WHERE account_id = ? AND rec_key = 'ce-rightsizing|Modify|i-old'").get(acct.id).status).toBe('open');
  });
});

describe('storeOptimizer keeps the ce-* rows', () => {
  it('replaces only compute-optimizer and heuristic rows and tracks their lifecycle', () => {
    const acct = insertAccount('opt-acct');
    poller.storeCeRecommendations(acct.id, [{ source: 'ce-savings-plan', resourceType: 'savings-plan', resourceId: 'COMPUTE_SP|ONE_YEAR|NO_UPFRONT', finding: 'purchase-savings-plan', estMonthlySavingsUsd: 120 }]);
    const heur = { source: 'heuristic', resourceType: 'ebs', resourceId: 'vol-1', finding: 'ebs-unattached', estMonthlySavingsUsd: 10 };
    poller.storeOptimizer(acct.id, 'Active', [heur]);
    const sources = () => db.prepare('SELECT source FROM aws_optimizer_recommendations WHERE account_id = ? ORDER BY source').all(acct.id).map((r) => r.source);
    expect(sources()).toEqual(['ce-savings-plan', 'heuristic']);
    expect(db.prepare("SELECT status FROM aws_recommendation_state WHERE account_id = ? AND rec_key = 'heuristic|ebs-unattached|vol-1'").get(acct.id).status).toBe('open');

    poller.storeOptimizer(acct.id, 'Active', []);
    expect(sources()).toEqual(['ce-savings-plan']);
    expect(db.prepare("SELECT status, resolved_by, realized_usd FROM aws_recommendation_state WHERE account_id = ? AND rec_key = 'heuristic|ebs-unattached|vol-1'").get(acct.id))
      .toEqual({ status: 'done', resolved_by: 'auto', realized_usd: 10 });
    // The ce row's state was not touched by the optimizer reconcile.
    expect(db.prepare("SELECT status FROM aws_recommendation_state WHERE account_id = ? AND rec_key LIKE 'ce-savings-plan|%'").get(acct.id).status).toBe('open');
  });
});

describe('heuristic prices come from settings', () => {
  it('uses the configured gp2 to gp3 and NAT prices', () => {
    const acct = insertAccount('price-acct');
    db.prepare("INSERT INTO aws_ebs_volumes (account_id, volume_id, state, size_gb, volume_type, az) VALUES (?, 'vol-p', 'in-use', 100, 'gp2', 'us-east-1a')").run(acct.id);
    db.prepare("INSERT INTO aws_vpcs (account_id, vpc_id, nat_gateway_count) VALUES (?, 'vpc-p', 3)").run(acct.id);
    const before = poller.computeHeuristicRecommendations(acct.id, false);
    expect(before.find((r) => r.finding === 'gp2-to-gp3').estMonthlySavingsUsd).toBeCloseTo(2, 6);
    expect(before.find((r) => r.finding === 'nat-gateway-consolidation').estMonthlySavingsUsd).toBeCloseTo(65.7, 6);
    setSetting('aws_price_gp2_to_gp3_per_gb', '0.05');
    setSetting('aws_price_nat_gateway_month', '40');
    const after = poller.computeHeuristicRecommendations(acct.id, false);
    expect(after.find((r) => r.finding === 'gp2-to-gp3').estMonthlySavingsUsd).toBeCloseTo(5, 6);
    expect(after.find((r) => r.finding === 'nat-gateway-consolidation').estMonthlySavingsUsd).toBeCloseTo(80, 6);
    setSetting('aws_price_gp2_to_gp3_per_gb', '0.02');
    setSetting('aws_price_nat_gateway_month', '32.85');
  });
});

describe('migration v11', () => {
  it('clears last_cost_capture_at on a v10 database and is idempotent', () => {
    const scratch = new Database(':memory:');
    runMigrations(scratch, 'aws', awsMigrations.filter((m) => m.version <= 10));
    scratch.prepare("INSERT INTO aws_accounts (name, last_cost_capture_at) VALUES ('a', datetime('now'))").run();
    expect(scratch.prepare('SELECT last_cost_capture_at FROM aws_accounts').get().last_cost_capture_at).toBeTruthy();

    runMigrations(scratch, 'aws', awsMigrations);
    const acct = scratch.prepare('SELECT * FROM aws_accounts').get();
    expect(acct.last_cost_capture_at).toBeNull();
    expect(acct).toHaveProperty('last_finops_capture_at');
    expect(acct).toHaveProperty('finops_backfill_at');
    for (const t of ['aws_cost_alloc_daily', 'aws_sp_utilization_daily', 'aws_sp_coverage_daily', 'aws_ri_utilization_daily', 'aws_ri_coverage_daily', 'aws_savings_plans',
      'aws_cost_anomalies', 'aws_cost_forecast', 'aws_budgets', 'aws_budget_status', 'aws_recommendation_state', 'aws_capability_status']) {
      expect(scratch.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?").get(t)).toBeTruthy();
    }
    const cols = scratch.prepare("PRAGMA table_info('aws_cost_usage_daily')").all().map((c) => c.name);
    expect(cols).toEqual(expect.arrayContaining(['amortized_usd', 'usage_qty', 'usage_unit']));

    // Running the step itself a second time (a retried boot) must not throw on existing columns or tables.
    const v11 = awsMigrations.find((m) => m.version === 11);
    expect(() => v11.up(scratch)).not.toThrow();
    scratch.close();
  });
});

// -- Round 2 capabilities (2026-10-27): comparison, categories, budgets, hub, idle/RDS, savings plan inventory, S3 tags --

describe('round 2 capture', () => {
  const NOW = new Date('2026-10-20T12:00:00Z');

  /** Cost Explorer answers: anything not overridden is denied, so a test only wires what it checks. */
  const ceBase = (overrides = {}) => (name, input) => {
    if (overrides[name]) return overrides[name](input);
    if (name === 'GetCostAndUsageCommand') return { ResultsByTime: [] };
    throw denied(`ce:${name.replace(/Command$/, '')}`);
  };
  const acctWithNumber = (name) => {
    const a = insertAccount(name);
    db.prepare("UPDATE aws_accounts SET account_number = '123456789012' WHERE id = ?").run(a.id);
    return db.prepare('SELECT * FROM aws_accounts WHERE id = ?').get(a.id);
  };
  const capStatus = (acct, id) => db.prepare('SELECT * FROM aws_capability_status WHERE account_id = ? AND capability = ?').get(acct.id, id);

  beforeEach(() => {
    setSetting('aws_finops_tag_keys', '[]');
    setSetting('aws_finops_linked_accounts', 'off');
    setSetting('aws_finops_comparison_enabled', '1');
    setSetting('aws_finops_cost_categories_max', '5');
    db.prepare('DELETE FROM aws_budgets').run();
  });

  it('skips the comparison when its month pair is already stored, and fetches nothing', async () => {
    mockCe(ceBase());
    mockOthers();
    const acct = insertAccount('cmp-skip');
    db.prepare(`INSERT INTO aws_cost_comparison (account_id, baseline_month, comparison_month, metric, service, baseline_usd, comparison_usd, delta_usd)
      VALUES (?, '2026-08', '2026-09', 'amortized', 'Amazon EC2', 10, 20, 10)`).run(acct.id);
    const out = await finops.captureFinops(acct, { skipped: [], now: NOW });
    expect(out.capabilities.cost_comparison).toBe('unknown');
    expect(capStatus(acct, 'cost_comparison').error).toBe('Already captured for 2026-09');
    expect(spy.mock.calls.some(([c]) => c.constructor.name === 'GetCostAndUsageComparisonsCommand')).toBe(false);
  });

  it('stores the comparison with a driver call per top mover and a (total) row', async () => {
    const comparison = (name, base, comp) => ({
      CostAndUsageSelector: { Dimensions: { Key: 'SERVICE', Values: [name] } },
      Metrics: { AmortizedCost: { BaselineTimePeriodAmount: String(base), ComparisonTimePeriodAmount: String(comp), Difference: String(comp - base), Unit: 'USD' } },
    });
    const driverCalls = [];
    mockCe(ceBase({
      GetCostAndUsageComparisonsCommand: (input) => {
        expect(input).toMatchObject({
          BaselineTimePeriod: { Start: '2026-08-01', End: '2026-09-01' }, ComparisonTimePeriod: { Start: '2026-09-01', End: '2026-10-01' },
          MetricForComparison: 'AmortizedCost', GroupBy: [{ Type: 'DIMENSION', Key: 'SERVICE' }],
        });
        return {
          CostAndUsageComparisons: [comparison('Amazon Lightsail', 300, 450), comparison('Amazon S3', 50, 40), comparison('Amazon RDS', 0, 80)],
          TotalCostAndUsage: { AmortizedCost: { BaselineTimePeriodAmount: '350', ComparisonTimePeriodAmount: '570', Difference: '220', Unit: 'USD' } },
        };
      },
      GetCostComparisonDriversCommand: (input) => {
        driverCalls.push(input);
        const service = input.Filter.Dimensions.Values[0];
        return { CostComparisonDrivers: [{
          CostSelector: { And: [{ Dimensions: { Key: 'SERVICE', Values: [service] } }, { Dimensions: { Key: 'USAGE_TYPE', Values: ['USE1-BundleUsage:16GB_win'] } }] },
          Metrics: { AmortizedCost: { BaselineTimePeriodAmount: '43.5', ComparisonTimePeriodAmount: '120', Difference: '76.5' } },
          CostDrivers: [{ Type: 'USAGE_CHANGE', Name: 'Usage', Metrics: { AmortizedCost: { Difference: '76.5' }, UsageQuantity: { Difference: '458.6', Unit: 'Hrs' } } }],
        }] };
      },
    }));
    mockOthers();
    const acct = insertAccount('cmp-store');
    const out = await finops.captureFinops(acct, { skipped: [], now: NOW });
    expect(out.capabilities.cost_comparison).toBe('ok');
    expect(driverCalls).toHaveLength(3);   // fewer than 8 services: one per service
    expect(driverCalls[0]).toMatchObject({ MaxResults: 10, GroupBy: [{ Type: 'DIMENSION', Key: 'SERVICE' }] });
    expect(capStatus(acct, 'cost_comparison').requests).toBe(4);   // 1 comparison page + 3 driver calls
    const latest = finops.comparisonLatest({ accountId: acct.id });
    expect(latest).toMatchObject({ baselineMonth: '2026-08', comparisonMonth: '2026-09', metric: 'amortized' });
    expect(latest.rows.map((r) => r.service)).toEqual(['Amazon Lightsail', 'Amazon RDS', 'Amazon S3']);   // by |delta|
    expect(latest.rows[0]).toMatchObject({ baselineUsd: 300, comparisonUsd: 450, deltaUsd: 150, deltaPct: 50 });
    expect(latest.rows[0].drivers[0]).toEqual({
      usageType: 'USE1-BundleUsage:16GB_win', baselineUsd: 43.5, comparisonUsd: 120, deltaUsd: 76.5,
      drivers: [{ type: 'USAGE_CHANGE', name: 'Usage', deltaUsd: 76.5, usageDelta: 458.6, usageUnit: 'Hrs' }],
    });
    expect(latest.total).toMatchObject({ service: '(total)', deltaUsd: 220 });
  });

  it('stores nothing when a driver call is denied, so the pair is retried', async () => {
    mockCe(ceBase({
      GetCostAndUsageComparisonsCommand: () => ({ CostAndUsageComparisons: [{ CostAndUsageSelector: { Dimensions: { Key: 'SERVICE', Values: ['Amazon EC2'] } }, Metrics: { AmortizedCost: { BaselineTimePeriodAmount: '1', ComparisonTimePeriodAmount: '2', Difference: '1' } } }] }),
      GetCostComparisonDriversCommand: () => { throw denied('ce:GetCostComparisonDrivers'); },
    }));
    mockOthers();
    const acct = insertAccount('cmp-denied');
    const out = await finops.captureFinops(acct, { skipped: [], now: NOW });
    expect(out.capabilities.cost_comparison).toBe('denied');
    expect(finops.comparisonLatest({ accountId: acct.id }).rows).toEqual([]);
    expect(finops.capabilityRows(acct.id).find((r) => r.capability === 'cost_comparison').iamActions).toEqual(['ce:GetCostComparisonDrivers']);
  });

  it('caps cost category grouping calls at aws_finops_cost_categories_max and splits the key after the dollar sign', async () => {
    setSetting('aws_finops_cost_categories_max', '2');
    mockCe(ceBase({
      ListCostCategoryDefinitionsCommand: () => ({ CostCategoryReferences: ['Team', 'Product', 'Unit'].map((Name) => ({ Name, CostCategoryArn: `arn:cc/${Name}` })) }),
      GetCostAndUsageCommand: (input) => (input.GroupBy[0].Type === 'COST_CATEGORY'
        ? { ResultsByTime: [{ TimePeriod: { Start: '2026-10-18', End: '2026-10-19' }, Groups: [{ Keys: [`${input.GroupBy[0].Key}$core`, 'Amazon EC2'], Metrics: { UnblendedCost: { Amount: '4' }, AmortizedCost: { Amount: '3' } } }] }] }
        : { ResultsByTime: [] }),
    }));
    mockOthers();
    const acct = insertAccount('cat-cap');
    const out = await finops.captureFinops(acct, { skipped: [], now: NOW });
    expect(out.capabilities.cost_categories).toBe('ok');
    const catCalls = spy.mock.calls.filter(([c]) => c.input.GroupBy?.[0]?.Type === 'COST_CATEGORY');
    expect(catCalls.map(([c]) => c.input.GroupBy[0].Key)).toEqual(['Team', 'Product']);
    const rows = db.prepare("SELECT key, value, service, amortized_usd FROM aws_cost_alloc_daily WHERE account_id = ? AND dimension = 'cost_category' ORDER BY key").all(acct.id);
    expect(rows).toEqual([
      { key: 'Product', value: 'core', service: 'Amazon EC2', amortized_usd: 3 },
      { key: 'Team', value: 'core', service: 'Amazon EC2', amortized_usd: 3 },
    ]);
  });

  it('records a note when no cost categories exist', async () => {
    mockCe(ceBase({ ListCostCategoryDefinitionsCommand: () => ({ CostCategoryReferences: [] }) }));
    mockOthers();
    const acct = insertAccount('cat-none');
    const out = await finops.captureFinops(acct, { skipped: [], now: NOW });
    expect(out.capabilities.cost_categories).toBe('ok');
    expect(capStatus(acct, 'cost_categories').error).toBe('No cost categories are defined on this account.');
  });

  it('mirrors AWS budgets: scope mapping, an (AWS) suffix on a name clash, and removal of vanished rows', async () => {
    db.prepare("INSERT INTO aws_budgets (name, scope_type, amount_usd) VALUES ('Platform', 'total', 100)").run();
    const budget = (name, extra = {}) => ({
      BudgetName: name, BudgetType: 'COST', TimeUnit: 'MONTHLY', BudgetLimit: { Amount: '500', Unit: 'USD' },
      CalculatedSpend: { ActualSpend: { Amount: '120.5', Unit: 'USD' }, ForecastedSpend: { Amount: '480', Unit: 'USD' } }, CostFilters: {}, ...extra,
    });
    let list = [
      budget('Platform'),
      budget('Compute', { CostFilters: { Service: ['Amazon Elastic Compute Cloud - Compute'] } }),
      budget('EnvProd', { CostFilters: { TagKeyValue: ['user:Environment$prod'] } }),
      budget('Mixed', { CostFilters: { Service: ['Amazon S3', 'Amazon RDS'] } }),
      budget('Usage', { BudgetType: 'USAGE' }),
    ];
    mockCe(ceBase());
    mockOthers({
      DescribeBudgetsCommand: (input) => {
        expect(input).toMatchObject({ AccountId: '123456789012', ShowFilterExpression: true });
        return { Budgets: list };
      },
      DescribeBudgetNotificationsForAccountCommand: () => ({ BudgetNotificationsForAccount: [
        { BudgetName: 'Platform', Notifications: [
          { NotificationType: 'ACTUAL', ComparisonOperator: 'GREATER_THAN', Threshold: 60, ThresholdType: 'PERCENTAGE' },
          { NotificationType: 'ACTUAL', ComparisonOperator: 'GREATER_THAN', Threshold: 90, ThresholdType: 'PERCENTAGE' },
          { NotificationType: 'FORECASTED', ComparisonOperator: 'GREATER_THAN', Threshold: 100, ThresholdType: 'PERCENTAGE' },
        ] },
      ] }),
    });
    const acct = acctWithNumber('bud-acct');
    const out = await finops.captureFinops(acct, { skipped: [], now: NOW });
    expect(out.capabilities.aws_budgets).toBe('ok');
    const rows = db.prepare("SELECT name, scope_type, scope_key, scope_value, amount_usd, warn_pct, forecast_alert, external_name, time_unit, aws_actual_usd, aws_forecast_usd FROM aws_budgets WHERE source = 'aws' ORDER BY external_name").all();
    expect(rows.map((r) => r.name)).toEqual(['Compute', 'EnvProd', 'Mixed', 'Platform (AWS)']);
    const by = Object.fromEntries(rows.map((r) => [r.external_name, r]));
    expect(by.Platform).toMatchObject({ scope_type: 'total', warn_pct: 60, forecast_alert: 1, amount_usd: 500, aws_actual_usd: 120.5, aws_forecast_usd: 480, time_unit: 'MONTHLY' });
    expect(by.Compute).toMatchObject({ scope_type: 'service', scope_value: 'Amazon Elastic Compute Cloud - Compute', warn_pct: 80, forecast_alert: 0 });
    expect(by.EnvProd).toMatchObject({ scope_type: 'tag', scope_key: 'Environment', scope_value: 'prod' });
    expect(by.Mixed.scope_type).toBe('external');
    expect(db.prepare("SELECT name FROM aws_budgets WHERE source = 'icc'").all()).toEqual([{ name: 'Platform' }]);   // the ICC budget is untouched

    // The AWS figures drive the evaluation of an AWS row.
    const state = db.prepare(`SELECT s.actual_usd, s.forecast_usd, s.forecast_source FROM aws_budget_status s JOIN aws_budgets b ON b.id = s.budget_id
      WHERE b.external_name = 'Mixed' AND s.month = '2026-10'`).get();
    expect(state).toEqual({ actual_usd: 120.5, forecast_usd: 480, forecast_source: 'aws' });

    // A budget that vanished from AWS is removed on the next capture.
    list = [budget('Platform')];
    db.prepare('UPDATE aws_accounts SET last_finops_capture_at = NULL WHERE id = ?').run(acct.id);
    await finops.captureFinops(acct, { skipped: [], now: NOW });
    expect(db.prepare("SELECT name FROM aws_budgets WHERE source = 'aws'").all()).toEqual([{ name: 'Platform (AWS)' }]);
  });

  it('evaluates a service budget with scope_match contains against every matching service line', () => {
    const acct = insertAccount('bud-contains');
    for (const [service, usd] of [['Claude Opus 4.6 (Amazon Bedrock Edition)', 30], ['Claude Sonnet 4.6 (Amazon Bedrock Edition)', 20], ['Amazon S3', 99]]) {
      db.prepare("INSERT INTO aws_cost_daily (account_id, day, service, amount_usd, amortized_usd) VALUES (?, '2026-10-05', ?, ?, ?)").run(acct.id, service, usd, usd);
    }
    const id = db.prepare("INSERT INTO aws_budgets (name, scope_type, scope_value, scope_match, amount_usd) VALUES ('Bedrock', 'service', 'Bedrock', 'contains', 100)").run().lastInsertRowid;
    const exact = db.prepare("INSERT INTO aws_budgets (name, scope_type, scope_value, scope_match, amount_usd) VALUES ('BedrockExact', 'service', 'Bedrock', 'exact', 100)").run().lastInsertRowid;
    finops.evaluateBudgets({ now: NOW });
    const st = (budgetId) => db.prepare("SELECT actual_usd FROM aws_budget_status WHERE budget_id = ? AND month = '2026-10'").get(budgetId);
    expect(st(id).actual_usd).toBe(50);
    expect(st(exact).actual_usd).toBe(0);
  });

  it('Cost Optimization Hub: not enrolled is not_enabled; enrolled rows land in the optimizer table with the new columns', async () => {
    mockCe(ceBase());
    mockOthers({ ListEnrollmentStatusesCommand: () => ({ items: [{ accountId: '1', status: 'Inactive' }] }) });
    const first = insertAccount('hub-off');
    const out = await finops.captureFinops(first, { skipped: [], now: NOW });
    expect(out.capabilities.optimization_hub).toBe('not_enabled');
    expect(capStatus(first, 'optimization_hub').error).toMatch(/^Cost Optimization Hub is not enrolled/);

    for (const o of otherSpies) o.mockRestore();
    otherSpies = [];
    mockOthers({
      ListEnrollmentStatusesCommand: () => ({ items: [{ accountId: '1', status: 'Active' }] }),
      ListRecommendationsCommand: (input) => {
        expect(input).toMatchObject({ includeAllRecommendations: true, maxResults: 100 });
        return { items: [{
          recommendationId: 'r-1', resourceId: 'i-0abc', resourceArn: 'arn:aws:ec2:us-east-2:1:instance/i-0abc', region: 'us-east-2',
          currentResourceType: 'Ec2Instance', recommendedResourceType: 'Ec2Instance', actionType: 'Rightsize', estimatedMonthlySavings: 42.5,
          estimatedSavingsPercentage: 30, estimatedMonthlyCost: 140, implementationEffort: 'Medium', restartNeeded: true, rollbackPossible: true,
          currentResourceSummary: 'm5.2xlarge', recommendedResourceSummary: 'm5.xlarge', recommendationLookbackPeriodInDays: 14,
          source: 'ComputeOptimizer', tags: [{ key: 'Name', value: 'web-1' }],
        }] };
      },
    });
    const second = insertAccount('hub-on');
    const ok = await finops.captureFinops(second, { skipped: [], now: NOW });
    expect(ok.capabilities.optimization_hub).toBe('ok');
    expect(capStatus(second, 'optimization_hub').requests).toBe(0);   // free
    const row = db.prepare("SELECT * FROM aws_optimizer_recommendations WHERE account_id = ? AND source = 'cost-optimization-hub'").get(second.id);
    expect(row).toMatchObject({
      resource_type: 'ec2instance', resource_id: 'i-0abc', resource_name: 'web-1', finding: 'Rightsize', current_config: 'm5.2xlarge',
      recommended_config: 'm5.xlarge', est_monthly_savings_usd: 42.5, effort: 'Medium', restart_needed: 1, rollback_possible: 1,
      action_type: 'Rightsize', lookback_days: 14, after_discounts: 1, reason: 'Cost Optimization Hub, 14 day lookback',
    });
    expect(JSON.parse(row.detail_json).recommendationId).toBe('r-1');
    expect(db.prepare("SELECT status FROM aws_recommendation_state WHERE account_id = ? AND rec_key = 'cost-optimization-hub|Rightsize|i-0abc'").get(second.id).status).toBe('open');
  });

  it('Savings Plans inventory keeps its API columns over the details call and refreshes only utilization', () => {
    const acct = insertAccount('sp-api');
    const arn = 'arn:aws:savingsplans::1:savingsplan/sp-1';
    poller.upsertSavingsPlans(acct.id, [{ spArn: arn, spType: 'COMPUTE_SP', paymentOption: 'NO_UPFRONT', term: '1yr', commitmentUsd: 3, state: 'active',
      upfrontUsd: 0, recurringUsd: 3, offeringId: 'off-1', productTypes: ['EC2', 'Fargate'], description: 'one year', start: '2026-01-01T00:00:00Z', end: '2027-01-01T00:00:00Z' },
    { spArn: `${arn}-q`, spType: 'COMPUTE_SP', state: 'queued', commitmentUsd: 3 }], 'api');
    poller.upsertSavingsPlans(acct.id, [{ spArn: arn, spType: 'ignored', hourlyCommitmentUsd: 99, utilizationPct: 91, netSavingsUsd: 12.5 },
      { spArn: `${arn}-d`, spType: 'COMPUTE_SP', hourlyCommitmentUsd: 1, utilizationPct: 50 }], 'details');
    const rows = db.prepare('SELECT sp_arn, sp_type, hourly_commitment_usd, state, source, utilization_pct, net_savings_usd, product_types_json, offering_id FROM aws_savings_plans WHERE account_id = ? ORDER BY sp_arn').all(acct.id);
    expect(rows.find((r) => r.sp_arn === arn)).toEqual({
      sp_arn: arn, sp_type: 'COMPUTE_SP', hourly_commitment_usd: 3, state: 'active', source: 'api', utilization_pct: 91, net_savings_usd: 12.5,
      product_types_json: '["EC2","Fargate"]', offering_id: 'off-1',
    });
    expect(rows.find((r) => r.sp_arn === `${arn}-d`).source).toBe('details');
    // A later details call replaces details-only rows and leaves API rows; a later API call drops plans AWS no longer lists.
    poller.upsertSavingsPlans(acct.id, [], 'details');
    expect(db.prepare('SELECT COUNT(*) AS n FROM aws_savings_plans WHERE account_id = ?').get(acct.id).n).toBe(2);
    poller.upsertSavingsPlans(acct.id, [{ spArn: arn, state: 'retired' }], 'api');
    expect(db.prepare('SELECT sp_arn, state FROM aws_savings_plans WHERE account_id = ?').all(acct.id)).toEqual([{ sp_arn: arn, state: 'retired' }]);
  });

  it('collectComputeOptimizer adds idle and RDS rows and records co_idle / co_rds status', async () => {
    mockOthers({
      GetEnrollmentStatusCommand: () => ({ status: 'Active' }),
      GetEC2InstanceRecommendationsCommand: () => ({ instanceRecommendations: [] }),
      GetEBSVolumeRecommendationsCommand: () => ({ volumeRecommendations: [] }),
      GetLambdaFunctionRecommendationsCommand: () => ({ lambdaFunctionRecommendations: [] }),
      GetECSServiceRecommendationsCommand: () => ({ ecsServiceRecommendations: [] }),
      GetIdleRecommendationsCommand: () => ({ idleRecommendations: [{
        resourceArn: 'arn:aws:ec2:us-east-2:1:instance/i-idle', resourceId: 'i-idle', resourceType: 'EC2Instance', finding: 'Idle',
        findingDescription: 'CPU under 5 percent', savingsOpportunityAfterDiscounts: { estimatedMonthlySavings: { currency: 'USD', value: 21 } },
        savingsOpportunity: { estimatedMonthlySavings: { currency: 'USD', value: 30 } }, lookBackPeriodInDays: 14, tags: [{ key: 'Name', value: 'idle-box' }],
      }, {
        resourceArn: 'arn:aws:ec2:us-east-2:1:volume/vol-1', resourceType: 'EBSVolume', finding: 'Unattached',
        savingsOpportunity: { estimatedMonthlySavings: { value: 8 } },
      }] }),
      GetRDSDatabaseRecommendationsCommand: () => ({ rdsDBRecommendations: [{
        resourceArn: 'arn:aws:rds:us-east-2:1:db:orders', currentDBInstanceClass: 'db.m5.xlarge', instanceFinding: 'Overprovisioned',
        instanceFindingReasonCodes: ['CPUOverprovisioned'], storageFinding: 'NotOptimized',
        currentStorageConfiguration: { storageType: 'gp2', allocatedStorage: 500 },
        instanceRecommendationOptions: [{ rank: 2, dbInstanceClass: 'db.m5.large' }, { rank: 1, dbInstanceClass: 'db.m5.2xlarge-nope', savingsOpportunity: { estimatedMonthlySavings: { value: 100 } }, savingsOpportunityAfterDiscounts: { estimatedMonthlySavings: { value: 70 } } }],
        storageRecommendationOptions: [{ rank: 1, storageConfiguration: { storageType: 'gp3', allocatedStorage: 500 }, savingsOpportunity: { estimatedMonthlySavings: { value: 15 } } }],
        lookbackPeriodInDays: 14,
      }, { resourceArn: 'arn:aws:rds:us-east-2:1:db:fine', instanceFinding: 'Optimized', storageFinding: 'Optimized' }] }),
    });
    const acct = insertAccount('co-extra');
    const out = await poller.collectComputeOptimizer(acct);
    expect(out.status).toBe('Active');
    const by = (type) => out.rows.filter((r) => r.resourceType === type);
    expect(by('idle-ec2instance')).toEqual([expect.objectContaining({ resourceId: 'i-idle', finding: 'Idle', resourceName: 'idle-box', estMonthlySavingsUsd: 21, afterDiscounts: 1, lookbackDays: 14, reason: 'CPU under 5 percent' })]);
    expect(by('idle-ebsvolume')[0]).toMatchObject({ resourceId: 'vol-1', finding: 'Unattached', estMonthlySavingsUsd: 8, afterDiscounts: 0 });
    expect(by('rds').find((r) => r.resourceId === 'orders')).toMatchObject({ finding: 'Overprovisioned', currentConfig: 'db.m5.xlarge', recommendedConfig: 'db.m5.2xlarge-nope', estMonthlySavingsUsd: 70, afterDiscounts: 1 });
    expect(by('rds-storage')).toEqual([expect.objectContaining({ resourceId: 'orders', finding: 'NotOptimized', currentConfig: 'gp2 500GiB', recommendedConfig: 'gp3 500GiB', estMonthlySavingsUsd: 15 })]);
    expect(capStatus(acct, 'co_idle').status).toBe('ok');
    expect(capStatus(acct, 'co_rds').status).toBe('ok');
    // Stored through the optimizer path, the idle row keeps its own resource type and discount flag.
    poller.storeOptimizer(acct.id, 'Active', out.rows.map((r) => ({ ...r, source: 'compute-optimizer' })));
    expect(db.prepare("SELECT resource_type, after_discounts FROM aws_optimizer_recommendations WHERE account_id = ? AND resource_id = 'i-idle'").get(acct.id))
      .toEqual({ resource_type: 'idle-ec2instance', after_discounts: 1 });
  });

  it('a denied idle call records co_idle denied with its action and leaves the other rows', async () => {
    mockOthers({
      GetEnrollmentStatusCommand: () => ({ status: 'Active' }),
      GetEC2InstanceRecommendationsCommand: () => ({ instanceRecommendations: [] }),
      GetEBSVolumeRecommendationsCommand: () => ({ volumeRecommendations: [] }),
      GetLambdaFunctionRecommendationsCommand: () => ({ lambdaFunctionRecommendations: [] }),
      GetECSServiceRecommendationsCommand: () => ({ ecsServiceRecommendations: [] }),
      GetRDSDatabaseRecommendationsCommand: () => ({ rdsDBRecommendations: [] }),
    });
    const acct = insertAccount('co-denied');
    const out = await poller.collectComputeOptimizer(acct);
    expect(out.rows).toEqual([]);
    expect(capStatus(acct, 'co_idle').status).toBe('denied');
    expect(finops.capabilityRows(acct.id).find((r) => r.capability === 'co_idle')).toMatchObject({ status: 'denied', iamActions: ['compute-optimizer:GetIdleRecommendations'], free: true });
  });

  it('S3 tags: tags are read per bucket, NoSuchTagSet is an empty set, and one denial records inventory_tags once and nulls every tag', async () => {
    const wire = (tagging) => ({
      ListBucketsCommand: () => ({ Buckets: [{ Name: 'b-one', CreationDate: new Date('2025-01-01') }, { Name: 'b-two', CreationDate: new Date('2025-02-01') }] }),
      GetBucketLocationCommand: () => ({}),
      GetPublicAccessBlockCommand: () => { throw Object.assign(new Error('none'), { name: 'NoSuchPublicAccessBlockConfiguration' }); },
      GetBucketVersioningCommand: () => ({ Status: 'Enabled' }),
      GetBucketLifecycleConfigurationCommand: () => { throw Object.assign(new Error('none'), { name: 'NoSuchLifecycleConfiguration' }); },
      GetBucketTaggingCommand: tagging,
      GetMetricDataCommand: () => ({ MetricDataResults: [] }),
    });
    mockOthers(wire((input) => {
      if (input.Bucket === 'b-two') throw Object.assign(new Error('The specified bucket does not have a TagSet'), { name: 'NoSuchTagSet' });
      return { TagSet: [{ Key: 'Team', Value: 'data' }, { Key: 'Environment', Value: 'prod' }] };
    }));
    const acct = insertAccount('s3-tags');
    const rows = await poller.collectS3(acct);
    expect(rows.find((r) => r.name === 'b-one').tags).toEqual({ Team: 'data', Environment: 'prod' });
    expect(rows.find((r) => r.name === 'b-two').tags).toEqual({});
    expect(capStatus(acct, 'inventory_tags').status).toBe('ok');
    poller.storeS3(acct.id, rows);
    expect(db.prepare("SELECT tags_json FROM aws_s3_buckets WHERE account_id = ? AND name = 'b-one'").get(acct.id).tags_json).toBe('{"Team":"data","Environment":"prod"}');
    expect(db.prepare("SELECT tags_json FROM aws_s3_buckets WHERE account_id = ? AND name = 'b-two'").get(acct.id).tags_json).toBeNull();
    poller.refreshInventoryTagKeysSeen();
    expect(JSON.parse(getSetting('aws_inventory_tag_keys_seen'))).toEqual(expect.arrayContaining(['Environment', 'Team']));

    for (const o of otherSpies) o.mockRestore();
    otherSpies = [];
    mockOthers(wire(() => { throw denied('s3:GetBucketTagging'); }));
    const acct2 = insertAccount('s3-tags-denied');
    const logs = vi.spyOn(finops._logger, 'warn');
    const denies = await poller.collectS3(acct2);
    expect(denies.every((r) => r.tags === null)).toBe(true);
    expect(capStatus(acct2, 'inventory_tags')).toMatchObject({ status: 'denied' });
    expect(capStatus(acct2, 'inventory_tags').error).toContain('s3:GetBucketTagging');
    expect(logs.mock.calls.filter(([m]) => /bucket tags unavailable/.test(String(m)))).toHaveLength(1);   // once, not per bucket
    logs.mockRestore();
  });
});

describe('round 2 error classification and capability rows', () => {
  it('classifies non-ce denials, the hub enrollment message, and lists the new actions', () => {
    for (const action of ['savingsplans:DescribeSavingsPlans', 'budgets:ViewBudget', 'cost-optimization-hub:ListRecommendations', 'pricing:GetProducts', 'compute-optimizer:GetIdleRecommendations', 's3:GetBucketTagging']) {
      expect(awsApi.classifyCeError(denied(action))).toBe('denied');
      expect(finops._deniedActions(denied(action).message)).toEqual([action]);
    }
    // Pricing's message has no "on resource" clause.
    expect(finops._deniedActions('User: arn:aws:iam::1:user/x is not authorized to perform: pricing:GetProducts')).toEqual(['pricing:GetProducts']);
    expect(awsApi.classifyCeError({ name: 'NotEnrolled', message: 'Cost Optimization Hub is not enrolled for this account (enable it in the Billing console).' })).toBe('not_enabled');
    const rows = finops.capabilityRows(null);
    const ids = rows.map((r) => r.capability);
    expect(ids.slice(ids.indexOf('sp_recommendation'), -1)).toEqual(['sp_recommendation', 'cost_categories', 'cost_comparison', 'savings_plans_inventory', 'aws_budgets',
      'optimization_hub', 'pricing', 'co_idle', 'co_rds', 'inventory_tags', 'resource_estimate']);
    expect(rows.filter((r) => r.free).map((r) => r.capability).sort()).toEqual([...finops.FREE_CAPABILITIES].sort());
    expect(finops.CAPABILITY_ACTIONS.optimization_hub).toContain('cost-optimization-hub:ListEnrollmentStatuses');
    expect(finops.CAPABILITY_ACTIONS.aws_budgets).toEqual(['budgets:ViewBudget']);
  });
});
