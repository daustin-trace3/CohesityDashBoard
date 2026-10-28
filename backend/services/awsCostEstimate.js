// Estimated resource cost, computed locally (round 2 of the FinOps work, 2026-10-27).
//
// Cost Explorer resource-level data is a console opt-in with a 14 day window. This module instead
// splits each billed usage type's daily cost across the inventory objects the usage type names, by
// weight (instance count, volume GB, bucket bytes, ...). The matching lives in
// awsCostNotes.usageTypeObjects(..., { withWeights: true }). Every row is an ESTIMATE: it uses the
// CURRENT inventory for every day in the window, and a usage type with no matching object (or a
// discount line) is booked as 'unattributed' against its service so the totals still add up.
//
// Compute reads stored rows and writes nothing; storeResourceEstimates writes the window in
// transactions of 500 after clearing it in bounded batches. Day columns are YYYY-MM-DD in UTC.
//
// The pack copy lives at plugin-sdk/aws/backend/src/costEstimate.js.
const db = require('../db/database');
const { pruneInBatches } = require('../core/dbPrune');
const { usageTypeObjects } = require('./awsCostNotes');

const DAY_MS = 86400000;
const MONTH_DAYS = 30.4;
const utcDay = (d) => new Date(d).toISOString().slice(0, 10);
const addDays = (day, n) => utcDay(new Date(`${day}T00:00:00Z`).getTime() + n * DAY_MS);
const num = (v) => { const n = Number(v); return Number.isFinite(n) ? n : 0; };
const chunks = (list, size) => { const out = []; for (let i = 0; i < list.length; i += size) out.push(list.slice(i, i + size)); return out; };

/**
 * The rule table, kept as data so the tests and the UI notes can read it. match is a description,
 * the code that applies it is awsCostNotes.weightedUsageObjects.
 */
const shareRules = [
  { usageType: 'BoxUsage / SpotUsage / DedicatedUsage:<type>', kind: 'ec2', weight: 'instance count (running first)' },
  { usageType: 'EBS:VolumeUsage(.type), EBS:VolumeP-IOPS.*, EBS:VolumeThroughput.*', kind: 'ebs', weight: 'size_gb' },
  { usageType: 'TimedStorage-* (S3)', kind: 's3', weight: 'size_bytes (min 1)' },
  { usageType: 'Requests-*, *DataTransfer* (S3)', kind: 's3', weight: 'object_count (min 1)' },
  { usageType: 'InstanceUsage:<class> (RDS)', kind: 'rds', weight: 'Multi-AZ counts 2, else 1' },
  { usageType: 'RDS storage and backup, Aurora storage', kind: 'rds', weight: 'allocated_gb (min 1)' },
  { usageType: 'Lightsail BundleUsage:<ram>GB(_win)', kind: 'lightsail', weight: '1' },
  { usageType: 'Lightsail DatabaseUsage:<ram>GB', kind: 'lightsail-db', weight: '1' },
  { usageType: 'Lightsail Disk*', kind: 'lightsail-disk', weight: 'size_gb' },
  { usageType: 'Lightsail LoadBalancer*', kind: 'lightsail-lb', weight: '1' },
  { usageType: 'Lambda-GB-Second, Request (Lambda)', kind: 'lambda', weight: '1' },
  { usageType: 'any DynamoDB usage type', kind: 'dynamo', weight: 'size_bytes (min 1)' },
  { usageType: 'any Bedrock model service', kind: 'bedrock-model', weight: 'the service itself' },
  { usageType: 'Savings Plans for AWS Compute usage', kind: 'unattributed', weight: 'discount line' },
  { usageType: 'anything else', kind: 'unattributed', weight: 'service' },
];

const SP_DISCOUNT_RE = /^Savings Plans for AWS Compute usage/i;

/**
 * Split every stored usage row of the window into resource rows.
 * Returns { rows: [{ day, service, usageType, resourceKind, resourceId, amountUsd, amortizedUsd, shareRule }],
 * attributedUsd, unattributedUsd } (the totals use the amortized figure, falling back to unblended).
 */
function computeResourceEstimates(accountId, { fromDay, toDay, now = new Date() } = {}) {
  const to = toDay || utcDay(now);
  const from = fromDay || addDays(to, -34);
  const usage = db.prepare(`
    SELECT day, service, usage_type, amount_usd, amortized_usd FROM aws_cost_usage_daily
    WHERE account_id = ? AND service IS NOT NULL AND day >= ? AND day <= ?
  `).all(accountId, from, to);

  const cache = new Map();
  const planFor = (service, usageType) => {
    const key = `${service}\u0000${usageType}`;
    if (cache.has(key)) return cache.get(key);
    let plan;
    if (SP_DISCOUNT_RE.test(service)) {
      plan = { objects: [], rule: 'Savings Plans discount line, not attributable to one resource.' };
    } else if (/bedrock/i.test(service)) {
      plan = { objects: [{ resourceId: service, kind: 'bedrock-model', weight: 1 }], totalWeight: 1, rule: 'Bedrock model service, billed as one line.' };
    } else {
      plan = usageTypeObjects(usageType, service, db, accountId, { all: true, withWeights: true });
      if (!plan.objects.length) plan = { objects: [], rule: plan.rule ? `No inventory matches (${plan.rule}).` : 'No inventory object matches this usage type.' };
    }
    cache.set(key, plan);
    return plan;
  };
  const ruleText = (plan, o) => {
    const uniform = plan.objects.every((x) => x.weight === plan.objects[0].weight);
    return uniform
      ? `1 of ${plan.objects.length}: ${plan.rule}`
      : `by weight ${Math.round(o.weight)} of ${Math.round(plan.totalWeight)}: ${plan.rule}`;
  };

  const merged = new Map();
  let attributed = 0;
  let unattributed = 0;
  const add = (r) => {
    const key = `${r.day}|${r.usageType}|${r.resourceKind}|${r.resourceId}`;
    const cur = merged.get(key);
    if (!cur) { merged.set(key, r); return; }
    cur.amountUsd += r.amountUsd;
    cur.amortizedUsd += r.amortizedUsd;
  };
  for (const u of usage) {
    const amount = num(u.amount_usd);
    const amortized = u.amortized_usd == null ? amount : num(u.amortized_usd);
    const plan = planFor(u.service, u.usage_type);
    if (!plan.objects.length) {
      unattributed += amortized;
      add({ day: u.day, service: u.service, usageType: u.usage_type, resourceKind: 'unattributed', resourceId: u.service,
        amountUsd: amount, amortizedUsd: amortized, shareRule: plan.rule });
      continue;
    }
    attributed += amortized;
    for (const o of plan.objects) {
      const share = o.weight / plan.totalWeight;
      add({ day: u.day, service: u.service, usageType: u.usage_type, resourceKind: o.kind, resourceId: o.resourceId,
        amountUsd: amount * share, amortizedUsd: amortized * share, shareRule: ruleText(plan, o) });
    }
  }
  return { rows: [...merged.values()], attributedUsd: attributed, unattributedUsd: unattributed };
}

/** Replace the account's estimate rows for [fromDay, toDay]: bounded delete, then inserts in transactions of 500. */
function storeResourceEstimates(accountId, { fromDay, toDay, rows }) {
  pruneInBatches(db, 'aws_cost_resource_estimate_daily', 'account_id = ? AND day >= ? AND day <= ?', [accountId, fromDay, toDay]);
  const stmt = db.prepare(`
    INSERT INTO aws_cost_resource_estimate_daily (account_id, day, service, usage_type, resource_kind, resource_id, amount_usd, amortized_usd, share_rule)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(account_id, day, usage_type, resource_kind, resource_id) DO UPDATE SET
      service = excluded.service, amount_usd = excluded.amount_usd, amortized_usd = excluded.amortized_usd, share_rule = excluded.share_rule
  `);
  const write = db.transaction((list) => {
    for (const r of list) stmt.run(accountId, r.day, r.service, r.usageType, r.resourceKind, r.resourceId, r.amountUsd, r.amortizedUsd, r.shareRule ?? null);
  });
  for (const part of chunks(rows || [], 500)) write(part);
  return (rows || []).length;
}

const costCol = (metric) => (metric === 'unblended' ? 'amount_usd' : 'COALESCE(amortized_usd, amount_usd)');
const windowOf = ({ fromDay, toDay } = {}) => {
  const to = toDay || utcDay(Date.now());
  return { from: fromDay || addDays(to, -29), to };
};

/**
 * Map(resourceId -> { usd, days, estMonthlyUsd }) for inventory rows of one kind. days = days with an
 * estimate row; estMonthlyUsd = usd / days x 30.4. Default window: the last 30 days.
 */
function estimateForResources(kind, ids, { fromDay, toDay, metric } = {}) {
  const out = new Map();
  const list = [...new Set((ids || []).filter(Boolean))];
  if (!list.length) return out;
  const { from, to } = windowOf({ fromDay, toDay });
  const col = costCol(metric);
  for (const part of chunks(list, 400)) {
    const rows = db.prepare(`
      SELECT resource_id, SUM(${col}) AS usd, COUNT(DISTINCT day) AS days FROM aws_cost_resource_estimate_daily
      WHERE resource_kind = ? AND day >= ? AND day <= ? AND resource_id IN (${part.map(() => '?').join(',')})
      GROUP BY resource_id
    `).all(kind, from, to, ...part);
    for (const r of rows) {
      const usd = num(r.usd);
      out.set(r.resource_id, { usd, days: r.days, estMonthlyUsd: r.days > 0 ? (usd / r.days) * MONTH_DAYS : null });
    }
  }
  return out;
}

// -- inventory lookups (labels, links, tags) -----------------------------------------------

const KIND_TABLES = {
  ec2: { table: 'aws_ec2_instances', idCol: 'instance_id', nameCol: 'name', link: '/aws/ec2' },
  ebs: { table: 'aws_ebs_volumes', idCol: 'volume_id', nameCol: null, link: '/aws/ec2' },
  s3: { table: 'aws_s3_buckets', idCol: 'name', nameCol: null, link: '/aws/s3' },
  rds: { table: 'aws_rds_instances', idCol: 'db_id', nameCol: null, link: '/aws/rds' },
  lightsail: { table: 'aws_lightsail_instances', idCol: 'name', nameCol: null, link: '/aws/lightsail' },
  'lightsail-db': { table: 'aws_lightsail_databases', idCol: 'name', nameCol: null, link: '/aws/lightsail' },
  'lightsail-disk': { table: 'aws_lightsail_disks', idCol: 'name', nameCol: null, link: '/aws/lightsail', noTags: true },
  'lightsail-lb': { table: 'aws_lightsail_load_balancers', idCol: 'name', nameCol: null, link: '/aws/lightsail', noTags: true },
  lambda: { table: 'aws_lambda_functions', idCol: 'name', nameCol: null, link: '/aws/lambda', noTags: true },
  dynamo: { table: 'aws_dynamo_tables', idCol: 'name', nameCol: null, link: '/aws/dynamo', noTags: true },
};

const parseTags = (raw) => { try { const v = raw ? JSON.parse(raw) : {}; return v && typeof v === 'object' && !Array.isArray(v) ? v : {}; } catch { return {}; } };

/** { label, link, tags } resolvers for one kind, reading the inventory table once per call. */
function inventoryLookup(kind, accountId) {
  const def = KIND_TABLES[kind];
  const byId = new Map();
  if (def) {
    const cols = [def.idCol, def.nameCol, def.noTags ? null : 'tags_json'].filter(Boolean).join(', ');
    try {
      const rows = db.prepare(`SELECT ${cols} FROM ${def.table}${accountId ? ' WHERE account_id = ?' : ''}`).all(...(accountId ? [accountId] : []));
      for (const r of rows) byId.set(r[def.idCol], r);
    } catch { /* table missing on an old schema: fall back to bare ids */ }
  }
  return (id, service) => {
    const r = byId.get(id);
    if (kind === 'bedrock-model') return { label: id, link: null, tags: {} };
    if (!def) return { label: id, link: null, tags: {} };
    return {
      label: (def.nameCol && r?.[def.nameCol]) || id,
      link: `${def.link}?q=${encodeURIComponent(id)}`,
      tags: r && !def.noTags ? parseTags(r.tags_json) : {},
      service,
    };
  };
}

function baseFilters({ fromDay, toDay, service, usageType, accountId }) {
  const { from, to } = windowOf({ fromDay, toDay });
  const where = ['day >= ?', 'day <= ?'];
  const args = [from, to];
  if (service) { where.push('service = ?'); args.push(service); }
  if (usageType) { where.push('usage_type = ?'); args.push(usageType); }
  if (accountId) { where.push('account_id = ?'); args.push(Number(accountId)); }
  return { where: where.join(' AND '), args };
}

/**
 * The GET /finops/resources body minus range. totals, byKind and the unattributed list follow the
 * service / usageType / accountId filters; kind and q narrow the rows only. rows are sorted by cost,
 * limited to opts.limit (default 200, at most 500).
 */
function resourceRollup({ fromDay, toDay, metric, kind, service, usageType, q, accountId, limit } = {}) {
  const col = costCol(metric);
  const { where, args } = baseFilters({ fromDay, toDay, service, usageType, accountId });
  const lim = Math.min(500, Math.max(1, Math.round(Number(limit)) || 200));

  const perKind = db.prepare(`
    SELECT resource_kind AS kind, SUM(${col}) AS usd, COUNT(DISTINCT resource_id) AS n
    FROM aws_cost_resource_estimate_daily WHERE ${where} GROUP BY resource_kind ORDER BY usd DESC
  `).all(...args);
  const totalUsd = perKind.reduce((n, r) => n + num(r.usd), 0);
  const unattributedUsd = perKind.filter((r) => r.kind === 'unattributed').reduce((n, r) => n + num(r.usd), 0);
  const attributedUsd = totalUsd - unattributedUsd;
  const byKind = perKind.filter((r) => r.kind !== 'unattributed').map((r) => ({ kind: r.kind, usd: num(r.usd), count: r.n }));

  const unattributed = db.prepare(`
    SELECT service, SUM(${col}) AS usd, COUNT(DISTINCT usage_type) AS n
    FROM aws_cost_resource_estimate_daily WHERE ${where} AND resource_kind = 'unattributed'
    GROUP BY service ORDER BY usd DESC
  `).all(...args).map((r) => ({ service: r.service, usd: num(r.usd), usageTypes: r.n }));

  const kindWhere = kind ? ' AND resource_kind = ?' : '';
  const grouped = db.prepare(`
    SELECT resource_kind, resource_id, SUM(${col}) AS usd, COUNT(DISTINCT day) AS days, GROUP_CONCAT(DISTINCT service) AS services
    FROM aws_cost_resource_estimate_daily WHERE ${where} AND resource_kind != 'unattributed'${kindWhere}
    GROUP BY resource_kind, resource_id ORDER BY usd DESC
  `).all(...args, ...(kind ? [kind] : []));

  const lookups = new Map();
  const needle = q ? String(q).toLowerCase() : null;
  const rows = [];
  for (const g of grouped) {
    if (!lookups.has(g.resource_kind)) lookups.set(g.resource_kind, inventoryLookup(g.resource_kind, accountId ? Number(accountId) : null));
    const services = String(g.services || '').split(',').filter(Boolean);
    const inv = lookups.get(g.resource_kind)(g.resource_id, services[0]);
    const usd = num(g.usd);
    const dailyAvgUsd = g.days > 0 ? usd / g.days : 0;
    const row = {
      resourceKind: g.resource_kind, resourceId: g.resource_id, label: inv.label, link: inv.link, services,
      usd, pct: totalUsd > 0 ? (usd / totalUsd) * 100 : 0, dailyAvgUsd, estMonthlyUsd: dailyAvgUsd * MONTH_DAYS,
      days: g.days, tags: inv.tags,
    };
    if (needle) {
      const hay = [row.resourceId, row.label, ...services, ...Object.entries(row.tags).map(([k, v]) => `${k}=${v}`)].join(' ').toLowerCase();
      if (!hay.includes(needle)) continue;
    }
    rows.push(row);
    if (rows.length >= lim) break;
  }
  return {
    totals: { totalUsd, attributedUsd, unattributedUsd, attributedPct: totalUsd > 0 ? (attributedUsd / totalUsd) * 100 : 0 },
    byKind, rows, unattributed, computedAt: new Date().toISOString(),
  };
}

/** Daily series for one resource: { rows: [{ day, usd, usageTypes: [{ usageType, usd }] }] } ascending. */
function resourceSeries({ kind, resourceId, fromDay, toDay, metric, accountId } = {}) {
  const col = costCol(metric);
  const { from, to } = windowOf({ fromDay, toDay });
  const rows = db.prepare(`
    SELECT day, usage_type, SUM(${col}) AS usd FROM aws_cost_resource_estimate_daily
    WHERE resource_kind = ? AND resource_id = ? AND day >= ? AND day <= ?${accountId ? ' AND account_id = ?' : ''}
    GROUP BY day, usage_type ORDER BY day, usd DESC
  `).all(kind, resourceId, from, to, ...(accountId ? [Number(accountId)] : []));
  const byDay = new Map();
  for (const r of rows) {
    if (!byDay.has(r.day)) byDay.set(r.day, { day: r.day, usd: 0, usageTypes: [] });
    const d = byDay.get(r.day);
    d.usd += num(r.usd);
    d.usageTypes.push({ usageType: r.usage_type, usd: num(r.usd) });
  }
  return { rows: [...byDay.values()] };
}

/**
 * Estimate rows grouped by an inventory tag value, shaped like allocationRows(): [{ day, value, service, usd }].
 * Untagged resources and unattributed lines carry value ''. Works over every stored estimate day.
 */
function inventoryTagRows({ key, fromDay, toDay, metric, accountId } = {}) {
  if (!key) return [];
  const col = costCol(metric);
  const { where, args } = baseFilters({ fromDay, toDay, accountId });
  const rows = db.prepare(`
    SELECT day, service, resource_kind, resource_id, SUM(${col}) AS usd FROM aws_cost_resource_estimate_daily
    WHERE ${where} GROUP BY day, service, resource_kind, resource_id
  `).all(...args);
  const lookups = new Map();
  const valueOf = (kind, id) => {
    if (kind === 'unattributed') return '';
    if (!lookups.has(kind)) lookups.set(kind, inventoryLookup(kind, accountId ? Number(accountId) : null));
    const v = lookups.get(kind)(id).tags?.[key];
    return v == null ? '' : String(v);
  };
  const agg = new Map();
  for (const r of rows) {
    const value = valueOf(r.resource_kind, r.resource_id);
    const k = `${r.day}\u0000${value}\u0000${r.service}`;
    const cur = agg.get(k);
    if (cur) cur.usd += num(r.usd);
    else agg.set(k, { day: r.day, value, service: r.service, usd: num(r.usd) });
  }
  return [...agg.values()];
}

module.exports = {
  computeResourceEstimates, storeResourceEstimates, estimateForResources, resourceRollup, resourceSeries,
  inventoryTagRows, shareRules, MONTH_DAYS,
};
