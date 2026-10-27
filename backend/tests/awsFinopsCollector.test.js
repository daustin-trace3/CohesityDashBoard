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
afterEach(() => { if (spy) { spy.mockRestore(); spy = null; } });

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
        default: throw new Error(`unexpected command ${name}`);
      }
    };
  }

  beforeEach(() => {
    setSetting('aws_finops_tag_keys', JSON.stringify(['Environment']));
    setSetting('aws_finops_linked_accounts', 'auto');
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
