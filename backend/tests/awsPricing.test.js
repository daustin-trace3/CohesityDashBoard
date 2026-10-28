/**
 * AWS price catalog: aws_v1 PriceList parsing, the refresh (filters, the location retry, per-SKU failures, a
 * denied first call, the cap), lookups, the size ladder, the CPU-only rightsizing heuristic, and the savings
 * heuristics reading catalog prices.
 */
import { describe, it, expect, beforeAll, beforeEach, afterEach, vi } from 'vitest';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);

const db = require('../db/database');
const { runMigrations } = require('../core/migrations');
const awsMigrations = require('../db/migrations/aws');
const { setSetting, getSetting } = require('../services/settings');
const pricing = require('../services/awsPricing');
const poller = require('../services/awsPoller');
const PRC = require('@aws-sdk/client-pricing');

beforeAll(() => { runMigrations(db, 'aws', awsMigrations); });

let n = 0;
const account = (region = 'us-east-2') => {
  const id = db.prepare("INSERT INTO aws_accounts (name, access_key_id, region, polling_interval_minutes) VALUES (?, 'AKIATEST', ?, 10)")
    .run(`price-${++n}-${Math.random().toString(36).slice(2, 6)}`, region).lastInsertRowid;
  return db.prepare('SELECT * FROM aws_accounts WHERE id = ?').get(id);
};

/** Hand-written aws_v1 PriceList entry: product.sku, product.attributes, terms.OnDemand.<offer>.priceDimensions.<dim>.pricePerUnit.USD. */
const entry = ({ sku = 'SKU1', usd = '0.0416', unit = 'Hrs', attributes = {} } = {}) => JSON.stringify({
  product: { sku, productFamily: 'Compute Instance', attributes: { instanceType: 't3.medium', regionCode: 'us-east-2', ...attributes } },
  serviceCode: 'AmazonEC2',
  terms: { OnDemand: { [`${sku}.JRTCKXETXF`]: { offerTermCode: 'JRTCKXETXF', priceDimensions: { [`${sku}.JRTCKXETXF.6YS6EN2CT7`]: {
    unit, pricePerUnit: { USD: usd }, description: `$${usd} per On Demand Linux t3.medium Instance Hour`,
  } } } } },
});

let spy;
const mockPricing = (handler) => {
  const calls = [];
  spy = vi.spyOn(PRC.PricingClient.prototype, 'send').mockImplementation(async (cmd) => {
    calls.push(cmd.input);
    return handler(cmd.input, calls.length);
  });
  return calls;
};
afterEach(() => { if (spy) { spy.mockRestore(); spy = null; } });

const clearInventory = () => {
  for (const t of ['aws_ec2_instances', 'aws_ebs_volumes', 'aws_rds_instances', 'aws_ec2_metrics_daily', 'aws_price_catalog', 'aws_optimizer_recommendations']) db.prepare(`DELETE FROM ${t}`).run();
};
const filterMap = (input) => Object.fromEntries(input.Filters.map((f) => [f.Field, f.Value]));
const catalog = () => db.prepare('SELECT region, service_code, sku_key, unit, price_usd FROM aws_price_catalog ORDER BY service_code, sku_key').all();

describe('parsing a PriceList entry', () => {
  it('reads sku, attributes, price and unit from the first on-demand dimension', () => {
    expect(pricing.parsePriceListEntry(entry({ sku: 'ABC', usd: '0.0416' }))).toEqual({
      sku: 'ABC', attributes: { instanceType: 't3.medium', regionCode: 'us-east-2' }, priceUsd: 0.0416, unit: 'Hrs',
    });
    expect(pricing.parsePriceListEntry(JSON.parse(entry({ usd: '0.1' }))).priceUsd).toBe(0.1);
    expect(pricing.parsePriceListEntry('not json')).toBeNull();
    expect(pricing.parsePriceListEntry(JSON.stringify({ product: { sku: 'x' }, terms: {} }))).toBeNull();
  });
});

describe('size ladder', () => {
  it('steps down one size and stops at the bottom, at unknown sizes and at metal', () => {
    expect(pricing.sizeLadder('m5.xlarge')).toEqual({ family: 'm5', size: 'xlarge', smaller: 'large' });
    expect(pricing.sizeLadder('t3.2xlarge')).toEqual({ family: 't3', size: '2xlarge', smaller: 'xlarge' });
    expect(pricing.sizeLadder('t3.nano')).toEqual({ family: 't3', size: 'nano', smaller: null });
    expect(pricing.sizeLadder('c5.24xlarge').smaller).toBe('16xlarge');
    expect(pricing.sizeLadder('m5.metal').smaller).toBeNull();
    expect(pricing.sizeLadder('r5.3xlarge')).toEqual({ family: 'r5', size: '3xlarge', smaller: null });
    expect(pricing.sizeLadder('weird')).toEqual({ family: 'weird', size: null, smaller: null });
    expect(pricing.sizeLadder(null).smaller).toBeNull();
  });
});

describe('refreshPriceCatalog', () => {
  beforeEach(() => { clearInventory(); setSetting('aws_price_catalog_refreshed_at', ''); });

  it('asks one GetProducts per inventory SKU with the contract filters and stores keyed prices', async () => {
    const a = account();
    db.prepare("INSERT INTO aws_ec2_instances (account_id, instance_id, state, instance_type, az, platform) VALUES (?, 'i-1', 'running', 't3.medium', 'us-east-2a', 'Linux/UNIX')").run(a.id);
    db.prepare("INSERT INTO aws_ec2_instances (account_id, instance_id, state, instance_type, az, platform) VALUES (?, 'i-2', 'running', 't3.medium', 'us-east-2b', 'Linux/UNIX')").run(a.id);
    db.prepare("INSERT INTO aws_ec2_instances (account_id, instance_id, state, instance_type, az, platform) VALUES (?, 'i-3', 'running', 'm5.large', 'us-east-2a', 'Windows')").run(a.id);
    db.prepare("INSERT INTO aws_ebs_volumes (account_id, volume_id, size_gb, volume_type, az) VALUES (?, 'vol-1', 10, 'gp3', 'us-east-2a')").run(a.id);
    db.prepare("INSERT INTO aws_rds_instances (account_id, db_id, engine, instance_class, multi_az) VALUES (?, 'orders', 'aurora-postgresql', 'db.r5.large', 1)").run(a.id);
    db.prepare("INSERT INTO aws_rds_instances (account_id, db_id, engine, instance_class, multi_az) VALUES (?, 'legacy', 'oracle-ee', 'db.m5.large', 0)").run(a.id);
    const calls = mockPricing((input) => {
      const f = filterMap(input);
      if (input.ServiceCode === 'AmazonRDS') return { PriceList: [entry({ sku: 'R', usd: '0.29', attributes: { instanceType: f.instanceType } })] };
      if (f.productFamily === 'Storage') return { PriceList: [entry({ sku: 'S', usd: '0.08', unit: 'GB-Mo' })] };
      return { PriceList: [entry({ sku: 'E', usd: f.operatingSystem === 'Windows' ? '0.192' : '0.0416' })] };
    });
    const out = await pricing.refreshPriceCatalog(a, { now: new Date('2026-10-20T00:00:00Z') });
    expect(out).toEqual({ requests: 5, rows: 5 });
    expect(calls.every((c) => c.FormatVersion === 'aws_v1' && c.MaxResults === 100 && c.Filters.every((f) => f.Type === 'TERM_MATCH'))).toBe(true);
    const ec2Call = calls.find((c) => filterMap(c).instanceType === 't3.medium');
    expect(ec2Call.ServiceCode).toBe('AmazonEC2');
    expect(filterMap(ec2Call)).toEqual({
      instanceType: 't3.medium', regionCode: 'us-east-2', operatingSystem: 'Linux', tenancy: 'Shared', preInstalledSw: 'NA',
      capacitystatus: 'Used', licenseModel: 'No License required',
    });
    expect(filterMap(calls.find((c) => filterMap(c).productFamily === 'Storage'))).toEqual({ productFamily: 'Storage', volumeApiName: 'gp3', regionCode: 'us-east-2' });
    const aurora = calls.find((c) => filterMap(c).instanceType === 'db.r5.large');
    expect(filterMap(aurora)).toEqual({
      instanceType: 'db.r5.large', regionCode: 'us-east-2', deploymentOption: 'Multi-AZ', databaseEngine: 'Aurora PostgreSQL', licenseModel: 'No license required',
    });
    const oracle = filterMap(calls.find((c) => filterMap(c).instanceType === 'db.m5.large'));
    expect(oracle.databaseEngine).toBe('Oracle');
    expect('licenseModel' in oracle).toBe(false);   // Oracle and SQL Server omit the license filter
    expect(catalog()).toEqual([
      { region: 'us-east-2', service_code: 'AmazonEC2', sku_key: 'gp3', unit: 'GB-Mo', price_usd: 0.08 },
      { region: 'us-east-2', service_code: 'AmazonEC2', sku_key: 'm5.large|Windows', unit: 'Hrs', price_usd: 0.192 },
      { region: 'us-east-2', service_code: 'AmazonEC2', sku_key: 't3.medium|Linux', unit: 'Hrs', price_usd: 0.0416 },
      { region: 'us-east-2', service_code: 'AmazonRDS', sku_key: 'db.m5.large|oracle-ee|single', unit: 'Hrs', price_usd: 0.29 },
      { region: 'us-east-2', service_code: 'AmazonRDS', sku_key: 'db.r5.large|aurora-postgresql|multi', unit: 'Hrs', price_usd: 0.29 },
    ]);
    expect(getSetting('aws_price_catalog_refreshed_at')).toBe('2026-10-20T00:00:00.000Z');
    expect(pricing.priceFor('ec2', { instanceType: 't3.medium', region: 'us-east-2a' })).toBe(0.0416);
    expect(pricing.priceFor('ec2', { instanceType: 'm5.large', region: 'us-east-2', os: 'Windows' })).toBe(0.192);
    expect(pricing.priceFor('ebs', { volumeType: 'gp3', region: 'us-east-2' })).toBe(0.08);
    expect(pricing.priceFor('rds', { instanceClass: 'db.r5.large', region: 'us-east-2', engine: 'aurora-postgresql', multiAz: true })).toBe(0.29);
    expect(pricing.priceFor('rds', { instanceClass: 'db.r5.large', region: 'us-east-2', engine: 'aurora-postgresql', multiAz: false })).toBeNull();
    expect(pricing.lookupPrice({ region: 'us-east-2', serviceCode: 'AmazonEC2', skuKey: 'nope' })).toBeNull();
  });

  it('retries once with the long location name when regionCode gives an empty answer', async () => {
    const a = account();
    db.prepare("INSERT INTO aws_ec2_instances (account_id, instance_id, state, instance_type, az, platform) VALUES (?, 'i-1', 'running', 't3.medium', 'us-east-2a', 'Linux/UNIX')").run(a.id);
    const calls = mockPricing((input) => (filterMap(input).regionCode ? { PriceList: [] } : { PriceList: [entry({ usd: '0.05' })] }));
    const out = await pricing.refreshPriceCatalog(a);
    expect(out).toEqual({ requests: 2, rows: 1 });
    expect(filterMap(calls[1]).location).toBe('US East (Ohio)');
    expect('regionCode' in filterMap(calls[1])).toBe(false);
    expect(pricing.priceFor('ec2', { instanceType: 't3.medium', region: 'us-east-2' })).toBe(0.05);
  });

  it('logs and skips a failing SKU, keeps going, and rethrows a denied first call', async () => {
    const a = account();
    db.prepare("INSERT INTO aws_ec2_instances (account_id, instance_id, state, instance_type, az, platform) VALUES (?, 'i-1', 'running', 't3.medium', 'us-east-2a', 'Linux/UNIX')").run(a.id);
    db.prepare("INSERT INTO aws_ebs_volumes (account_id, volume_id, size_gb, volume_type, az) VALUES (?, 'vol-1', 10, 'gp3', 'us-east-2a')").run(a.id);
    mockPricing((input) => {
      if (input.ServiceCode === 'AmazonEC2' && filterMap(input).instanceType) return { PriceList: [entry({ usd: '0.04' })] };
      throw Object.assign(new Error('Throttling'), { name: 'ThrottlingException' });
    });
    const out = await pricing.refreshPriceCatalog(a);
    expect(out.rows).toBe(1);
    expect(catalog().map((r) => r.sku_key)).toEqual(['t3.medium|Linux']);
    spy.mockRestore();

    clearInventory();
    setSetting('aws_price_catalog_refreshed_at', '');
    db.prepare("INSERT INTO aws_ec2_instances (account_id, instance_id, state, instance_type, az, platform) VALUES (?, 'i-1', 'running', 't3.medium', 'us-east-2a', 'Linux/UNIX')").run(a.id);
    mockPricing(() => { throw Object.assign(new Error('User: arn:aws:iam::1:user/x is not authorized to perform: pricing:GetProducts'), { name: 'AccessDeniedException' }); });
    await expect(pricing.refreshPriceCatalog(a)).rejects.toThrow(/pricing:GetProducts/);
    expect(getSetting('aws_price_catalog_refreshed_at')).toBeFalsy();
  });

  it('fetches at most 60 SKUs per refresh, never-fetched first', async () => {
    const a = account();
    for (let i = 0; i < 70; i++) {
      db.prepare("INSERT INTO aws_ec2_instances (account_id, instance_id, state, instance_type, az, platform) VALUES (?, ?, 'running', ?, 'us-east-2a', 'Linux/UNIX')").run(a.id, `i-${i}`, `x${i}.large`);
    }
    db.prepare("INSERT INTO aws_price_catalog (region, service_code, sku_key, unit, price_usd, captured_at) VALUES ('us-east-2', 'AmazonEC2', 'x0.large|Linux', 'Hrs', 1, '2026-01-01T00:00:00Z')").run();
    const calls = mockPricing(() => ({ PriceList: [entry()] }));
    const out = await pricing.refreshPriceCatalog(a);
    expect(out.requests).toBe(60);
    expect(calls.some((c) => filterMap(c).instanceType === 'x0.large')).toBe(false);   // the one already fetched waits its turn
  });

  it('stores Lightsail bundle prices per month under AmazonLightsail', () => {
    const bundles = new Map([['small_3_0', { ramGb: 2, price: 12 }], ['nano_3_0', { ramGb: 0.5, price: 5 }], ['broken', { ramGb: 1 }]]);
    expect(pricing.storeLightsailBundlePrices('us-east-2', bundles)).toBe(2);
    expect(pricing.lookupPrice({ region: 'us-east-2', serviceCode: 'AmazonLightsail', skuKey: 'small_3_0' })).toBe(12);
    expect(db.prepare("SELECT unit FROM aws_price_catalog WHERE service_code = 'AmazonLightsail' AND sku_key = 'nano_3_0'").get().unit).toBe('month');
    const s = pricing.catalogSummary();
    expect(s.rows).toBeGreaterThanOrEqual(2);
    expect(s.byService.find((b) => b.serviceCode === 'AmazonLightsail').n).toBe(2);
    expect(s.sample[0]).toEqual(expect.objectContaining({ region: expect.any(String), serviceCode: expect.any(String), skuKey: expect.any(String), priceUsd: expect.any(Number) }));
  });
});

describe('ICC rightsizing heuristic', () => {
  beforeEach(clearInventory);
  const TODAY = new Date('2026-10-20T12:00:00Z');
  const instance = (a, id, type, state = 'running') => db.prepare("INSERT INTO aws_ec2_instances (account_id, instance_id, name, state, instance_type, az, platform) VALUES (?, ?, ?, ?, ?, 'us-east-2a', 'Linux/UNIX')").run(a.id, id, `${id}-n`, state, type);
  const cpu = (a, id, days, max, startDay = 19) => {
    for (let d = 0; d < days; d++) {
      db.prepare('INSERT INTO aws_ec2_metrics_daily (account_id, instance_id, day, cpu_avg, cpu_max, samples) VALUES (?, ?, ?, ?, ?, 3)')
        .run(a.id, id, `2026-10-${String(startDay - d).padStart(2, '0')}`, max / 2, max);
    }
  };
  const price = (type, usd) => db.prepare("INSERT INTO aws_price_catalog (region, service_code, sku_key, unit, price_usd) VALUES ('us-east-2', 'AmazonEC2', ?, 'Hrs', ?)").run(`${type}|Linux`, usd);

  it('fires only with enough days, low CPU, a running instance and a smaller size', () => {
    const a = account();
    instance(a, 'i-ok', 'm5.xlarge');
    cpu(a, 'i-ok', 8, 6.4);
    instance(a, 'i-short', 'm5.xlarge');
    cpu(a, 'i-short', 6, 3);
    instance(a, 'i-hot', 'm5.xlarge');
    cpu(a, 'i-hot', 10, 55);
    instance(a, 'i-spike', 'm5.xlarge');
    cpu(a, 'i-spike', 9, 4);
    db.prepare("UPDATE aws_ec2_metrics_daily SET cpu_max = 40 WHERE instance_id = 'i-spike' AND day = '2026-10-15'").run();
    instance(a, 'i-nano', 't3.nano');
    cpu(a, 'i-nano', 10, 1);
    instance(a, 'i-stopped', 'm5.xlarge', 'stopped');
    cpu(a, 'i-stopped', 10, 1);
    instance(a, 'i-old', 'm5.xlarge');
    cpu(a, 'i-old', 10, 2, 3);   // history is older than 14 days: ignored
    price('m5.xlarge', 0.192);
    price('m5.large', 0.096);
    const rows = pricing.ec2RightsizeRecommendations(a.id, { cpuMaxPct: 10, minDays: 7 }, { now: TODAY });
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      source: 'heuristic', resourceType: 'ec2', resourceId: 'i-ok', resourceName: 'i-ok-n', finding: 'ec2-low-utilization',
      currentConfig: 'm5.xlarge', recommendedConfig: 'm5.large', reason: 'ICC rightsizing: max CPU 6.4% over 8 days (CPU only, no memory data)',
    });
    expect(rows[0].estMonthlySavingsUsd).toBeCloseTo((0.192 - 0.096) * 730, 6);
  });

  it('leaves the savings null without prices and honours the settings and existing Optimizer or Hub rows', () => {
    const a = account();
    instance(a, 'i-np', 'c5.2xlarge');
    cpu(a, 'i-np', 8, 5);
    instance(a, 'i-co', 'c5.2xlarge');
    cpu(a, 'i-co', 8, 5);
    instance(a, 'i-hub', 'c5.2xlarge');
    cpu(a, 'i-hub', 8, 5);
    db.prepare("INSERT INTO aws_optimizer_recommendations (account_id, source, resource_type, resource_id, finding) VALUES (?, 'compute-optimizer', 'ec2', 'i-co', 'Overprovisioned')").run(a.id);
    db.prepare("INSERT INTO aws_optimizer_recommendations (account_id, source, resource_type, resource_id, finding) VALUES (?, 'cost-optimization-hub', 'ec2instance', 'i-hub', 'Rightsize')").run(a.id);
    const rows = pricing.ec2RightsizeRecommendations(a.id, {}, { now: TODAY });
    expect(rows.map((r) => r.resourceId)).toEqual(['i-np']);
    expect(rows[0].estMonthlySavingsUsd).toBeNull();
    expect(rows[0].recommendedConfig).toBe('c5.xlarge');
    // This run's own Compute Optimizer ids can be passed in before they are stored.
    expect(pricing.ec2RightsizeRecommendations(a.id, {}, { now: TODAY, skipIds: ['i-np'] })).toEqual([]);
    // Defaults come from the settings.
    setSetting('aws_rightsize_cpu_max_pct', '4');
    expect(pricing.ec2RightsizeRecommendations(a.id, {}, { now: TODAY })).toEqual([]);
    setSetting('aws_rightsize_cpu_max_pct', '10');
    setSetting('aws_rightsize_min_days', '9');
    expect(pricing.ec2RightsizeRecommendations(a.id, {}, { now: TODAY })).toEqual([]);
    setSetting('aws_rightsize_min_days', '7');
  });
});

describe('heuristics read the catalog', () => {
  beforeEach(clearInventory);

  it('prices gp2 to gp3 and unattached volumes from the catalog when the region has the rows, else the settings', () => {
    const a = account();
    db.prepare("INSERT INTO aws_ebs_volumes (account_id, volume_id, state, size_gb, volume_type, az) VALUES (?, 'vol-gp2', 'in-use', 100, 'gp2', 'us-east-2a')").run(a.id);
    db.prepare("INSERT INTO aws_ebs_volumes (account_id, volume_id, state, size_gb, volume_type, az) VALUES (?, 'vol-free', 'available', 200, 'io1', 'us-east-2a')").run(a.id);
    db.prepare("INSERT INTO aws_ebs_volumes (account_id, volume_id, state, size_gb, volume_type, az) VALUES (?, 'vol-west', 'in-use', 100, 'gp2', 'us-west-2a')").run(a.id);
    const before = poller.computeHeuristicRecommendations(a.id, false);
    const find = (rows, id, finding) => rows.find((r) => r.resourceId === id && r.finding === finding);
    expect(find(before, 'vol-gp2', 'gp2-to-gp3').estMonthlySavingsUsd).toBeCloseTo(2, 6);   // setting 0.02 per GB
    expect(find(before, 'vol-free', 'ebs-unattached').estMonthlySavingsUsd).toBeCloseTo(200 * 0.08, 6);   // gp3 setting for a non-gp2 type
    for (const [type, usd] of [['gp2', 0.11], ['gp3', 0.088], ['io1', 0.125]]) {
      db.prepare("INSERT INTO aws_price_catalog (region, service_code, sku_key, unit, price_usd) VALUES ('us-east-2', 'AmazonEC2', ?, 'GB-Mo', ?)").run(type, usd);
    }
    const after = poller.computeHeuristicRecommendations(a.id, false);
    expect(find(after, 'vol-gp2', 'gp2-to-gp3').estMonthlySavingsUsd).toBeCloseTo(100 * (0.11 - 0.088), 6);
    expect(find(after, 'vol-free', 'ebs-unattached').estMonthlySavingsUsd).toBeCloseTo(200 * 0.125, 6);
    expect(find(after, 'vol-west', 'gp2-to-gp3').estMonthlySavingsUsd).toBeCloseTo(2, 6);   // no catalog rows for us-west-2: settings again
  });

  it('adds the ec2-low-utilization rows to the heuristic output and honours skipIds', () => {
    const a = account();
    db.prepare("INSERT INTO aws_ec2_instances (account_id, instance_id, state, instance_type, az, platform) VALUES (?, 'i-low', 'running', 'm5.large', 'us-east-2a', 'Linux/UNIX')").run(a.id);
    for (let d = 0; d < 9; d++) {
      db.prepare('INSERT INTO aws_ec2_metrics_daily (account_id, instance_id, day, cpu_avg, cpu_max, samples) VALUES (?, ?, ?, 1, 2, 4)')
        .run(a.id, 'i-low', new Date(Date.now() - d * 86400000).toISOString().slice(0, 10));
    }
    const rows = poller.computeHeuristicRecommendations(a.id, false);
    expect(rows.filter((r) => r.finding === 'ec2-low-utilization').map((r) => r.resourceId)).toEqual(['i-low']);
    expect(poller.computeHeuristicRecommendations(a.id, false, { skipIds: new Set(['i-low']) }).some((r) => r.finding === 'ec2-low-utilization')).toBe(false);
  });
});

describe('EC2 CPU daily history', () => {
  it('keeps a running mean, a running max and a sample count per UTC day', () => {
    const a = account();
    clearInventory();
    poller.upsertEc2CpuDaily(a.id, [{ instanceId: 'i-h', cpuUtil: 10 }, { instanceId: 'i-null', cpuUtil: null }], '2026-10-19');
    poller.upsertEc2CpuDaily(a.id, [{ instanceId: 'i-h', cpuUtil: 30 }], '2026-10-19');
    poller.upsertEc2CpuDaily(a.id, [{ instanceId: 'i-h', cpuUtil: 20 }], '2026-10-19');
    poller.upsertEc2CpuDaily(a.id, [{ instanceId: 'i-h', cpuUtil: 5 }], '2026-10-20');
    const rows = db.prepare('SELECT instance_id, day, cpu_avg, cpu_max, samples FROM aws_ec2_metrics_daily WHERE account_id = ? ORDER BY day').all(a.id);
    expect(rows).toEqual([
      { instance_id: 'i-h', day: '2026-10-19', cpu_avg: 20, cpu_max: 30, samples: 3 },
      { instance_id: 'i-h', day: '2026-10-20', cpu_avg: 5, cpu_max: 5, samples: 1 },
    ]);
  });
});
