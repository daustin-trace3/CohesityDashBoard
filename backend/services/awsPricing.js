// AWS public price catalog (round 2 of the FinOps work, 2026-10-27).
//
// The AWS Price List API (pricing:GetProducts, free) gives public on-demand prices. refreshPriceCatalog
// fetches one price per distinct inventory SKU (EC2 type + OS, EBS volume type, RDS class + engine +
// Multi-AZ) into aws_price_catalog; Lightsail bundle prices come from GetBundles and are stored by
// storeLightsailBundlePrices. The catalog feeds the savings heuristics and the CPU-only EC2 rightsizing
// heuristic. Prices are list prices: they ignore Savings Plans, reservations and discounts, and
// every consumer says so.
//
// Wire shapes are coded from the aws_v1 price list format: each PriceList entry is a JSON string with
// product.sku, product.attributes and terms.OnDemand.<offer>.priceDimensions.<dimension>.pricePerUnit.USD.
// UNVERIFIED live: that regionCode is accepted as a filter (an empty answer retries once with the long
// location name) and which attribute values match on Doug's inventory.
//
// The pack copy lives at plugin-sdk/aws/backend/src/pricing.js.
const db = require('../db/database');
const { getSetting, setSetting } = require('./settings');
const awsApi = require('./awsApi');
const logger = require('../utils/logger');
const { GetProductsCommand } = require('@aws-sdk/client-pricing');

const MAX_SKUS_PER_REFRESH = 60;
const HOURS_PER_MONTH = 730;
const DAY_MS = 86400000;

const REGION_NAMES = {
  'us-east-1': 'US East (N. Virginia)', 'us-east-2': 'US East (Ohio)', 'us-west-1': 'US West (N. California)',
  'us-west-2': 'US West (Oregon)', 'ca-central-1': 'Canada (Central)', 'eu-west-1': 'EU (Ireland)',
  'eu-west-2': 'EU (London)', 'eu-west-3': 'EU (Paris)', 'eu-central-1': 'EU (Frankfurt)',
  'eu-north-1': 'EU (Stockholm)', 'ap-south-1': 'Asia Pacific (Mumbai)', 'ap-southeast-1': 'Asia Pacific (Singapore)',
  'ap-southeast-2': 'Asia Pacific (Sydney)', 'ap-northeast-1': 'Asia Pacific (Tokyo)',
  'ap-northeast-2': 'Asia Pacific (Seoul)', 'sa-east-1': 'South America (Sao Paulo)',
};

const RDS_ENGINES = [
  [/^aurora-mysql/i, 'Aurora MySQL'], [/^aurora-postgres/i, 'Aurora PostgreSQL'], [/^mariadb/i, 'MariaDB'],
  [/^mysql/i, 'MySQL'], [/^postgres/i, 'PostgreSQL'], [/^oracle/i, 'Oracle'], [/^sqlserver/i, 'SQL Server'],
];
const rdsEngineName = (engine) => (RDS_ENGINES.find(([re]) => re.test(String(engine || ''))) || [])[1] || null;

/** 'us-east-2a' -> 'us-east-2'; a value that is already a region passes through; null stays null. */
function regionOfAz(az) {
  const s = String(az || '').trim();
  if (!s) return null;
  return /^[a-z]{2}(-[a-z]+)+-\d[a-z]$/.test(s) ? s.slice(0, -1) : s;
}

const osOf = (platform) => (/windows/i.test(String(platform || '')) ? 'Windows' : 'Linux');

// -- size ladder ---------------------------------------------------------------------------

const LADDER = ['nano', 'micro', 'small', 'medium', 'large', 'xlarge', '2xlarge', '4xlarge', '8xlarge',
  '12xlarge', '16xlarge', '24xlarge', '32xlarge', '48xlarge', 'metal'];

/**
 * { family, size, smaller } for 'm5.xlarge' -> { family: 'm5', size: 'xlarge', smaller: 'large' }.
 * smaller is null at the bottom of the ladder, for a size the ladder does not know (3xlarge, 9xlarge)
 * and for metal (a bare-metal size has no smaller step). Not every family sells every step
 * (c5 has no medium); the price lookup, not the ladder, tells whether a step exists.
 */
function sizeLadder(instanceType) {
  const s = String(instanceType || '');
  const dot = s.indexOf('.');
  if (dot < 0) return { family: s || null, size: null, smaller: null };
  const family = s.slice(0, dot);
  const size = s.slice(dot + 1);
  const idx = LADDER.indexOf(size);
  const smaller = idx > 0 && size !== 'metal' ? LADDER[idx - 1] : null;
  return { family, size, smaller };
}

// -- reading the catalog -------------------------------------------------------------------

/** price_usd for one catalog row, or null. */
function lookupPrice({ region, serviceCode, skuKey }) {
  const r = regionOfAz(region);
  if (!r || !serviceCode || skuKey == null) return null;
  const row = db.prepare('SELECT price_usd FROM aws_price_catalog WHERE region = ? AND service_code = ? AND sku_key = ?')
    .get(r, serviceCode, String(skuKey));
  return row && row.price_usd != null ? Number(row.price_usd) : null;
}

/**
 * Convenience lookups. ec2 { instanceType, region, os } -> USD per hour; ebs { volumeType, region } ->
 * USD per GB-month; rds { instanceClass, region, engine, multiAz } -> USD per hour. Null when absent.
 */
function priceFor(kind, attrs = {}) {
  if (kind === 'ec2') {
    return lookupPrice({ region: attrs.region, serviceCode: 'AmazonEC2', skuKey: `${attrs.instanceType}|${attrs.os || 'Linux'}` });
  }
  if (kind === 'ebs') return lookupPrice({ region: attrs.region, serviceCode: 'AmazonEC2', skuKey: attrs.volumeType });
  if (kind === 'rds') {
    return lookupPrice({
      region: attrs.region, serviceCode: 'AmazonRDS',
      skuKey: `${attrs.instanceClass}|${attrs.engine}|${attrs.multiAz ? 'multi' : 'single'}`,
    });
  }
  return null;
}

function catalogSummary() {
  const refreshedAt = getSetting('aws_price_catalog_refreshed_at') || null;
  const rows = db.prepare('SELECT COUNT(*) AS n FROM aws_price_catalog').get().n;
  const byService = db.prepare('SELECT service_code AS serviceCode, COUNT(*) AS n FROM aws_price_catalog GROUP BY service_code ORDER BY n DESC').all();
  const sample = db.prepare('SELECT * FROM aws_price_catalog ORDER BY service_code, region, sku_key LIMIT 50').all().map((r) => {
    let attributes = null;
    try { attributes = r.attributes_json ? JSON.parse(r.attributes_json) : null; } catch { attributes = null; }
    return {
      region: r.region, serviceCode: r.service_code, skuKey: r.sku_key, unit: r.unit,
      priceUsd: r.price_usd, attributes, capturedAt: r.captured_at,
    };
  });
  return { refreshedAt, rows, byService, sample };
}

// -- parsing and storing -------------------------------------------------------------------

/**
 * One PriceList entry (JSON string or object) -> { sku, attributes, priceUsd, unit } or null.
 * terms.OnDemand -> first offer -> priceDimensions -> first dimension -> pricePerUnit.USD.
 */
function parsePriceListEntry(entry) {
  let doc = entry;
  // The SDK hands each entry back as a smithy LazyJsonString (a String object, typeof 'object'), so a
  // typeof check alone misses it and every price reads as an object without terms (live 2026-10-28).
  if (doc != null && typeof doc === 'object' && !doc.product && !doc.terms) doc = String(doc);
  if (typeof doc === 'string') {
    try { doc = JSON.parse(doc); } catch { return null; }
  }
  if (!doc || typeof doc !== 'object') return null;
  const offers = doc.terms?.OnDemand ? Object.values(doc.terms.OnDemand) : [];
  const dims = offers[0]?.priceDimensions ? Object.values(offers[0].priceDimensions) : [];
  const dim = dims[0];
  const usd = Number(dim?.pricePerUnit?.USD);
  if (!dim || !Number.isFinite(usd)) return null;
  return { sku: doc.product?.sku || null, attributes: doc.product?.attributes || {}, priceUsd: usd, unit: dim.unit || null };
}

/** Best entry of a GetProducts answer: the first with a positive price, preferring the wanted unit. */
function pickPrice(priceList, wantUnit) {
  const parsed = (priceList || []).map(parsePriceListEntry).filter(Boolean);
  return parsed.find((p) => p.priceUsd > 0 && (!wantUnit || p.unit === wantUnit))
    || parsed.find((p) => p.priceUsd > 0) || null;
}

function upsertCatalogRows(rows, iso) {
  const stmt = db.prepare(`
    INSERT INTO aws_price_catalog (region, service_code, sku_key, unit, price_usd, attributes_json, captured_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(region, service_code, sku_key) DO UPDATE SET
      unit = excluded.unit, price_usd = excluded.price_usd, attributes_json = excluded.attributes_json,
      captured_at = excluded.captured_at
  `);
  db.transaction((list) => {
    for (const r of list) stmt.run(r.region, r.serviceCode, r.skuKey, r.unit ?? null, r.priceUsd, r.attributes ? JSON.stringify(r.attributes) : null, iso);
  })(rows);
}

/** Lightsail bundle prices (USD per month) from GetBundles; bundles = Map(bundleId -> { price }). */
function storeLightsailBundlePrices(region, bundles) {
  const r = regionOfAz(region);
  if (!r || !bundles || typeof bundles.entries !== 'function') return 0;
  const rows = [];
  for (const [bundleId, b] of bundles.entries()) {
    if (b?.price == null || !Number.isFinite(Number(b.price))) continue;
    rows.push({ region: r, serviceCode: 'AmazonLightsail', skuKey: bundleId, unit: 'month', priceUsd: Number(b.price) });
  }
  if (rows.length) upsertCatalogRows(rows, new Date().toISOString());
  return rows.length;
}

// -- refresh -------------------------------------------------------------------------------

/** Distinct SKUs the inventory names, never-fetched first and then oldest first, capped. */
function skuCandidates() {
  const found = new Map();
  const add = (c) => { const k = `${c.serviceCode}|${c.region}|${c.skuKey}`; if (!found.has(k)) found.set(k, c); };
  for (const r of db.prepare('SELECT DISTINCT instance_type, az, platform FROM aws_ec2_instances WHERE instance_type IS NOT NULL AND az IS NOT NULL').all()) {
    const region = regionOfAz(r.az);
    const os = osOf(r.platform);
    add({ kind: 'ec2', serviceCode: 'AmazonEC2', region, skuKey: `${r.instance_type}|${os}`, instanceType: r.instance_type, os });
  }
  for (const r of db.prepare('SELECT DISTINCT volume_type, az FROM aws_ebs_volumes WHERE volume_type IS NOT NULL AND az IS NOT NULL').all()) {
    add({ kind: 'ebs', serviceCode: 'AmazonEC2', region: regionOfAz(r.az), skuKey: r.volume_type, volumeType: r.volume_type });
  }
  // RDS rows carry no region of their own: the account's region is the best available.
  for (const r of db.prepare(`
    SELECT DISTINCT i.instance_class, i.engine, i.multi_az, a.region AS region
    FROM aws_rds_instances i JOIN aws_accounts a ON a.id = i.account_id
    WHERE i.instance_class IS NOT NULL AND a.region IS NOT NULL
  `).all()) {
    const multi = r.multi_az ? 'multi' : 'single';
    add({
      kind: 'rds', serviceCode: 'AmazonRDS', region: regionOfAz(r.region), skuKey: `${r.instance_class}|${r.engine}|${multi}`,
      instanceClass: r.instance_class, engine: r.engine, multiAz: !!r.multi_az,
    });
  }
  const list = [...found.values()].filter((c) => c.region);
  const stamp = new Map(db.prepare('SELECT region, service_code, sku_key, captured_at FROM aws_price_catalog').all()
    .map((r) => [`${r.service_code}|${r.region}|${r.sku_key}`, r.captured_at]));
  list.sort((a, b) => {
    const sa = stamp.get(`${a.serviceCode}|${a.region}|${a.skuKey}`) || '';
    const sb = stamp.get(`${b.serviceCode}|${b.region}|${b.skuKey}`) || '';
    return sa < sb ? -1 : sa > sb ? 1 : 0;
  });
  return list.slice(0, MAX_SKUS_PER_REFRESH);
}

function filtersFor(c, useLocation) {
  const place = useLocation
    ? { Type: 'TERM_MATCH', Field: 'location', Value: REGION_NAMES[c.region] || c.region }
    : { Type: 'TERM_MATCH', Field: 'regionCode', Value: c.region };
  const f = (field, value) => ({ Type: 'TERM_MATCH', Field: field, Value: value });
  if (c.kind === 'ec2') {
    return { ServiceCode: 'AmazonEC2', Filters: [f('instanceType', c.instanceType), place, f('operatingSystem', c.os),
      f('tenancy', 'Shared'), f('preInstalledSw', 'NA'), f('capacitystatus', 'Used'), f('licenseModel', 'No License required')] };
  }
  if (c.kind === 'ebs') {
    return { ServiceCode: 'AmazonEC2', Filters: [f('productFamily', 'Storage'), f('volumeApiName', c.volumeType), place] };
  }
  const engine = rdsEngineName(c.engine);
  const filters = [f('instanceType', c.instanceClass), place, f('deploymentOption', c.multiAz ? 'Multi-AZ' : 'Single-AZ')];
  if (engine) filters.push(f('databaseEngine', engine));
  if (engine && engine !== 'Oracle' && engine !== 'SQL Server') filters.push(f('licenseModel', 'No license required'));
  return { ServiceCode: 'AmazonRDS', Filters: filters };
}

const CREDENTIAL_RE = /ExpiredToken|InvalidClientTokenId|UnrecognizedClientException|SignatureDoesNotMatch|InvalidSignature|AuthFailure|CredentialsProviderError/i;

/**
 * Fetch prices for the inventory's SKUs (cap 60 per call, never-fetched and oldest first). A failure for
 * one SKU is logged and skipped; a denied FIRST call, or a credential error, rethrows so the capability
 * records it. Stamps aws_price_catalog_refreshed_at. Returns { requests, rows }.
 */
async function refreshPriceCatalog(account, { now = new Date() } = {}) {
  const client = awsApi.pricingClient(account);
  const candidates = skuCandidates();
  const out = [];
  let requests = 0;
  let sawAnswer = false;
  const send = async (c, useLocation) => {
    const { ServiceCode, Filters } = filtersFor(c, useLocation);
    requests++;
    const resp = await client.send(new GetProductsCommand({ ServiceCode, Filters, FormatVersion: 'aws_v1', MaxResults: 100 }));
    sawAnswer = true;
    return resp;
  };
  for (const c of candidates) {
    try {
      let resp = await send(c, false);
      if (!(resp?.PriceList || []).length) resp = await send(c, true);
      const hit = pickPrice(resp?.PriceList, c.kind === 'ebs' ? 'GB-Mo' : c.kind === 'ec2' || c.kind === 'rds' ? 'Hrs' : null);
      if (!hit) continue;
      out.push({ region: c.region, serviceCode: c.serviceCode, skuKey: c.skuKey, unit: hit.unit, priceUsd: hit.priceUsd, attributes: hit.attributes });
    } catch (err) {
      const msg = String(err?.message || err);
      const credential = CREDENTIAL_RE.test(String(err?.name || '')) || CREDENTIAL_RE.test(msg);
      if (credential || (!sawAnswer && awsApi.classifyCeError(err) === 'denied')) throw err;
      logger.warn(`[AwsPricing] ${c.serviceCode} ${c.region} ${c.skuKey}: price lookup failed: ${msg.slice(0, 160)}`);
    }
  }
  const iso = new Date(now).toISOString();
  if (out.length) upsertCatalogRows(out, iso);
  setSetting('aws_price_catalog_refreshed_at', iso);
  return { requests, rows: out.length };
}

// -- ICC rightsizing heuristic -------------------------------------------------------------

const settingNum = (key, def) => { const n = Number(getSetting(key)); return Number.isFinite(n) && getSetting(key) !== '' && getSetting(key) != null ? n : def; };

/**
 * CPU-only rightsizing rows (heuristic shape) for running instances: at least minDays days of CPU
 * history in the last 14, the highest daily maximum under cpuMaxPct, and a smaller size on the ladder.
 * Instances Compute Optimizer or Cost Optimization Hub already name (stored rows, or opts.skipIds) are
 * skipped. Savings = (current - smaller) list price per hour x 730, null when either price is missing.
 * settings = { cpuMaxPct, minDays } (defaults come from aws_rightsize_cpu_max_pct / aws_rightsize_min_days).
 */
function ec2RightsizeRecommendations(accountId, settings = {}, opts = {}) {
  const cpuMaxPct = settings.cpuMaxPct ?? settingNum('aws_rightsize_cpu_max_pct', 10);
  const minDays = settings.minDays ?? settingNum('aws_rightsize_min_days', 7);
  const now = opts.now ? new Date(opts.now).getTime() : Date.now();
  const cutoff = new Date(now - 14 * DAY_MS).toISOString().slice(0, 10);
  const skip = new Set(opts.skipIds || []);
  for (const r of db.prepare(`
    SELECT resource_id FROM aws_optimizer_recommendations
    WHERE account_id = ? AND source IN ('compute-optimizer', 'cost-optimization-hub')
  `).all(accountId)) skip.add(r.resource_id);

  const out = [];
  const instances = db.prepare("SELECT instance_id, name, instance_type, az, platform FROM aws_ec2_instances WHERE account_id = ? AND state = 'running'").all(accountId);
  const history = db.prepare('SELECT cpu_max FROM aws_ec2_metrics_daily WHERE account_id = ? AND instance_id = ? AND day >= ? AND cpu_max IS NOT NULL');
  for (const i of instances) {
    if (skip.has(i.instance_id)) continue;
    const ladder = sizeLadder(i.instance_type);
    if (!ladder.smaller) continue;
    const rows = history.all(accountId, i.instance_id, cutoff);
    if (rows.length < minDays) continue;
    const max = Math.max(...rows.map((r) => Number(r.cpu_max)));
    if (!(max < cpuMaxPct)) continue;
    const smallerType = `${ladder.family}.${ladder.smaller}`;
    const os = osOf(i.platform);
    const cur = priceFor('ec2', { instanceType: i.instance_type, region: i.az, os });
    const next = priceFor('ec2', { instanceType: smallerType, region: i.az, os });
    const maxText = Math.round(max * 10) / 10;
    out.push({
      source: 'heuristic', resourceType: 'ec2', resourceId: i.instance_id, resourceName: i.name || null, region: i.az,
      finding: 'ec2-low-utilization', currentConfig: i.instance_type, recommendedConfig: smallerType,
      reason: `ICC rightsizing: max CPU ${maxText}% over ${rows.length} days (CPU only, no memory data)`,
      estMonthlySavingsUsd: cur != null && next != null ? Math.max(0, (cur - next) * HOURS_PER_MONTH) : null,
    });
  }
  return out;
}

module.exports = {
  refreshPriceCatalog, lookupPrice, priceFor, sizeLadder, ec2RightsizeRecommendations, catalogSummary,
  storeLightsailBundlePrices, parsePriceListEntry, regionOfAz, REGION_NAMES, rdsEngineName,
  _skuCandidates: skuCandidates, _filtersFor: filtersFor,
};
