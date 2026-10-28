const db = require('../../db/database');
const { createPlatformAdvisor } = require('../platformAdvisor');
const { computeIssues, costSpikePct } = require('../awsIssues');
const { getSetting } = require('../settings');

function instanceTypeTotals(days) {
  const rows = db.prepare(`
    SELECT instance_type, SUM(amount_usd) AS total_usd FROM aws_cost_instance_type_daily
    WHERE day >= date('now', ?)
    GROUP BY instance_type ORDER BY total_usd DESC LIMIT 10
  `).all(`-${days} days`);
  return rows.map((r) => {
    const running = db.prepare(`
      SELECT COUNT(*) AS n FROM aws_ec2_instances WHERE instance_type = ? AND state = 'running'
    `).get(r.instance_type).n || 0;
    return {
      instanceType: r.instance_type,
      totalUsd: +(r.total_usd || 0).toFixed(2),
      runningCount: running,
      estPerInstanceUsd: running > 0 ? +((r.total_usd || 0) / running).toFixed(2) : null,
    };
  });
}

function gatherCostGrowth() {
  const totalCostRows = db.prepare("SELECT COUNT(*) AS n FROM aws_cost_daily WHERE day >= date('now', '-30 days')").get().n;

  const byServiceRows = db.prepare(`
    SELECT service,
      SUM(CASE WHEN day < date('now', '-15 days') THEN amount_usd ELSE 0 END) AS first_half,
      SUM(CASE WHEN day >= date('now', '-15 days') THEN amount_usd ELSE 0 END) AS second_half
    FROM aws_cost_daily
    WHERE day >= date('now', '-30 days')
    GROUP BY service
  `).all();
  const costByServiceDeltas = byServiceRows
    .map((r) => ({
      service: r.service,
      firstHalfUsd: +(r.first_half || 0).toFixed(2),
      secondHalfUsd: +(r.second_half || 0).toFixed(2),
      deltaUsd: +((r.second_half || 0) - (r.first_half || 0)).toFixed(2),
    }))
    .sort((a, b) => Math.abs(b.deltaUsd) - Math.abs(a.deltaUsd))
    .slice(0, 15);

  const byUsageTypeRows = db.prepare(`
    SELECT usage_type,
      SUM(CASE WHEN day < date('now', '-15 days') THEN amount_usd ELSE 0 END) AS first_half,
      SUM(CASE WHEN day >= date('now', '-15 days') THEN amount_usd ELSE 0 END) AS second_half
    FROM aws_cost_usage_daily
    WHERE day >= date('now', '-30 days')
    GROUP BY usage_type
  `).all();
  const costByUsageTypeDeltas = byUsageTypeRows
    .map((r) => ({
      usageType: r.usage_type,
      firstHalfUsd: +(r.first_half || 0).toFixed(2),
      secondHalfUsd: +(r.second_half || 0).toFixed(2),
      deltaUsd: +((r.second_half || 0) - (r.first_half || 0)).toFixed(2),
    }))
    .sort((a, b) => Math.abs(b.deltaUsd) - Math.abs(a.deltaUsd))
    .slice(0, 15);

  const instanceTypeCosts = instanceTypeTotals(30);

  const newResourceSignal = [
    ['ec2', 'aws_ec2_instances'],
    ['lightsail', 'aws_lightsail_instances'],
    ['ecs', 'aws_ecs_clusters'],
    ['s3', 'aws_s3_buckets'],
    ['rds', 'aws_rds_instances'],
    ['lambda', 'aws_lambda_functions'],
    ['dynamo', 'aws_dynamo_tables'],
    ['ecr', 'aws_ecr_repos'],
  ].map(([label, table]) => {
    const row = db.prepare(`
      SELECT COUNT(*) AS total, SUM(CASE WHEN captured_at >= datetime('now', '-7 days') THEN 1 ELSE 0 END) AS recent7d
      FROM ${table}
    `).get();
    return { resource: label, total: row.total || 0, capturedLast7d: row.recent7d || 0 };
  });

  const openCostSpikeIssues = computeIssues()
    .filter((i) => i.type === 'cost-spike')
    .map((i) => ({ account: i.account, message: i.message }));

  const today = new Date().toISOString().slice(0, 10);
  const monthStart = `${today.slice(0, 7)}-01`;
  const mtdUsd = db.prepare('SELECT SUM(amount_usd) AS s FROM aws_cost_daily WHERE day >= ?').get(monthStart).s || 0;
  const prevMonthUsd = db.prepare(`
    SELECT SUM(amount_usd) AS s FROM aws_cost_daily WHERE day >= date(?, '-1 month') AND day < ?
  `).get(monthStart, monthStart).s || 0;

  return {
    generatedAt: new Date().toISOString(),
    costByServiceDeltas,
    costByUsageTypeDeltas,
    instanceTypeCosts,
    newResourceSignal,
    openCostSpikeIssues,
    costSpikeThresholdPct: costSpikePct(),
    mtdUsd: +mtdUsd.toFixed(2),
    previousMonthUsd: +prevMonthUsd.toFixed(2),
    note: totalCostRows === 0 ? 'No cost data captured yet.' : undefined,
  };
}

function gatherFinopsWaste() {
  const unattachedEbs = db.prepare(`
    SELECT volume_id AS id, size_gb AS sizeGb, volume_type AS volumeType
    FROM aws_ebs_volumes WHERE state = 'available' LIMIT 20
  `).all();

  const stoppedEc2 = db.prepare(`
    SELECT name, instance_type AS type FROM aws_ec2_instances WHERE state = 'stopped' LIMIT 20
  `).all();

  const natGatewaysByVpc = db.prepare(`
    SELECT vpc_id AS vpcId, name, nat_gateway_count AS natGatewayCount
    FROM aws_vpcs WHERE nat_gateway_count > 0 ORDER BY nat_gateway_count DESC LIMIT 20
  `).all();

  const s3NoLifecycle = db.prepare(`
    SELECT name, size_bytes AS sizeBytes FROM aws_s3_buckets
    WHERE lifecycle_rules = 0 ORDER BY size_bytes DESC LIMIT 15
  `).all();

  const instanceTypeCosts = instanceTypeTotals(30);

  const lightsailSnapshots = db.prepare(`
    SELECT name, snapshot_count AS snapshotCount FROM aws_lightsail_instances
    WHERE snapshot_count > 0 ORDER BY snapshot_count DESC LIMIT 20
  `).all();

  // Recommendation lifecycle (FinOps v11 tables): top 25 by estimate with the state a person set.
  let recommendations = [];
  let realizedSavings90dUsd = 0;
  let potentialSavingsUsd = 0;
  try {
    recommendations = db.prepare(`
      SELECT o.source, o.finding, o.resource_type, o.resource_id, o.resource_name, o.est_monthly_savings_usd,
             COALESCE(st.status, 'open') AS status, st.note
      FROM aws_optimizer_recommendations o
      LEFT JOIN aws_recommendation_state st ON st.account_id = o.account_id
        AND st.rec_key = o.source || '|' || o.finding || '|' || o.resource_id
      ORDER BY (o.est_monthly_savings_usd IS NULL) ASC, o.est_monthly_savings_usd DESC LIMIT 25
    `).all().map((r) => ({
      key: `${r.source}|${r.finding}|${r.resource_id}`, source: r.source, finding: r.finding, resourceType: r.resource_type,
      resource: r.resource_name || r.resource_id, estMonthlySavingsUsd: r.est_monthly_savings_usd, status: r.status, note: r.note || null,
    }));
    const cutoff = new Date(Date.now() - 90 * 86400000).toISOString();
    realizedSavings90dUsd = +(db.prepare(`
      SELECT COALESCE(SUM(realized_usd), 0) AS s FROM aws_recommendation_state WHERE status = 'done' AND realized_at >= ?
    `).get(cutoff).s || 0).toFixed(2);
    potentialSavingsUsd = +(db.prepare(`
      SELECT COALESCE(SUM(o.est_monthly_savings_usd), 0) AS s FROM aws_optimizer_recommendations o
      LEFT JOIN aws_recommendation_state st ON st.account_id = o.account_id
        AND st.rec_key = o.source || '|' || o.finding || '|' || o.resource_id
      WHERE COALESCE(st.status, 'open') IN ('open', 'accepted')
    `).get().s || 0).toFixed(2);
  } catch { /* FinOps v11 tables not present */ }

  // Cost Optimization Hub rows (savings after discounts) and the ICC CPU-only rightsizing rows.
  let hubRecommendations = [];
  let iccRightsizing = [];
  try {
    hubRecommendations = db.prepare(`
      SELECT resource_type, resource_id, resource_name, finding, current_config, recommended_config, effort,
             restart_needed, rollback_possible, est_monthly_savings_usd
      FROM aws_optimizer_recommendations WHERE source = 'cost-optimization-hub'
      ORDER BY (est_monthly_savings_usd IS NULL) ASC, est_monthly_savings_usd DESC LIMIT 15
    `).all().map((r) => ({
      resourceType: r.resource_type, resource: r.resource_name || r.resource_id, action: r.finding,
      current: r.current_config, recommended: r.recommended_config, effort: r.effort || null,
      restartNeeded: r.restart_needed == null ? null : !!r.restart_needed,
      rollbackPossible: r.rollback_possible == null ? null : !!r.rollback_possible,
      estMonthlySavingsUsd: r.est_monthly_savings_usd,
    }));
    iccRightsizing = db.prepare(`
      SELECT resource_id, resource_name, current_config, recommended_config, reason, est_monthly_savings_usd
      FROM aws_optimizer_recommendations WHERE source = 'heuristic' AND finding = 'ec2-low-utilization'
      ORDER BY (est_monthly_savings_usd IS NULL) ASC, est_monthly_savings_usd DESC LIMIT 15
    `).all().map((r) => ({
      instance: r.resource_name || r.resource_id, current: r.current_config, recommended: r.recommended_config,
      reason: r.reason, estMonthlySavingsUsd: r.est_monthly_savings_usd,
    }));
  } catch { /* FinOps v12 columns not present */ }

  const empty = !unattachedEbs.length && !stoppedEc2.length && !natGatewaysByVpc.length
    && !s3NoLifecycle.length && !instanceTypeCosts.length && !lightsailSnapshots.length && !recommendations.length
    && !hubRecommendations.length && !iccRightsizing.length;

  return {
    generatedAt: new Date().toISOString(),
    unattachedEbs,
    stoppedEc2,
    natGatewaysByVpc,
    s3NoLifecycle,
    instanceTypeCosts,
    lightsailSnapshots,
    recommendations,
    hubRecommendations,
    iccRightsizing,
    realizedSavings90dUsd,
    potentialSavingsUsd,
    note: empty ? 'No inventory captured yet.' : undefined,
  };
}

const round2 = (v) => (v == null ? null : +Number(v).toFixed(2));
const avg = (arr) => (arr.length ? arr.reduce((a, b) => a + b, 0) / arr.length : null);

function gatherCommitments() {
  const since = new Date(Date.now() - 30 * 86400000).toISOString().slice(0, 10);
  const spUtil = db.prepare(`
    SELECT day, utilization_pct, commitment_usd, used_usd, unused_usd, net_savings_usd FROM aws_sp_utilization_daily
    WHERE day >= ? ORDER BY day ASC
  `).all(since);
  const spCov = db.prepare('SELECT day, coverage_pct, covered_usd, on_demand_usd FROM aws_sp_coverage_daily WHERE day >= ? ORDER BY day ASC').all(since);
  const riUtil = db.prepare('SELECT day, utilization_pct, unused_hours, net_savings_usd FROM aws_ri_utilization_daily WHERE day >= ? ORDER BY day ASC').all(since);
  const riCov = db.prepare('SELECT day, coverage_pct, on_demand_hours FROM aws_ri_coverage_daily WHERE day >= ? ORDER BY day ASC').all(since);
  const now = Date.now();
  const plans = db.prepare('SELECT * FROM aws_savings_plans ORDER BY end_at ASC').all().map((p) => ({
    type: p.sp_type, term: p.term, paymentOption: p.payment_option, hourlyCommitmentUsd: round2(p.hourly_commitment_usd),
    region: p.region || null, instanceFamily: p.instance_family || null, endAt: p.end_at,
    daysToExpiry: p.end_at && Number.isFinite(Date.parse(p.end_at)) ? Math.ceil((Date.parse(p.end_at) - now) / 86400000) : null,
    utilizationPct: round2(p.utilization_pct), netSavingsUsd: round2(p.net_savings_usd),
  }));
  const purchase = db.prepare(`
    SELECT finding, current_config, recommended_config, est_monthly_savings_usd FROM aws_optimizer_recommendations
    WHERE source = 'ce-savings-plan' ORDER BY est_monthly_savings_usd DESC LIMIT 3
  `).all().map((r) => ({
    finding: r.finding, onDemandToday: r.current_config, commitment: r.recommended_config, estMonthlySavingsUsd: r.est_monthly_savings_usd,
  }));
  const empty = !spUtil.length && !spCov.length && !riUtil.length && !riCov.length && !plans.length;
  return {
    generatedAt: new Date().toISOString(),
    windowDays: 30,
    savingsPlans: {
      avgUtilizationPct: round2(avg(spUtil.map((r) => r.utilization_pct).filter((v) => v != null))),
      avgCoveragePct: round2(avg(spCov.map((r) => r.coverage_pct).filter((v) => v != null))),
      unusedCommitmentUsd: round2(spUtil.reduce((a, r) => a + (r.unused_usd || 0), 0)),
      netSavingsUsd: round2(spUtil.reduce((a, r) => a + (r.net_savings_usd || 0), 0)),
      lastSevenUtilizationPct: spUtil.slice(-7).map((r) => round2(r.utilization_pct)),
      lastSevenCoveragePct: spCov.slice(-7).map((r) => round2(r.coverage_pct)),
    },
    reservedInstances: {
      avgUtilizationPct: round2(avg(riUtil.map((r) => r.utilization_pct).filter((v) => v != null))),
      avgCoveragePct: round2(avg(riCov.map((r) => r.coverage_pct).filter((v) => v != null))),
      unusedHours: round2(riUtil.reduce((a, r) => a + (r.unused_hours || 0), 0)),
      samples: riUtil.length + riCov.length,
    },
    plans,
    purchaseRecommendations: purchase,
    note: empty ? 'No commitment data captured yet. Either the account has no Savings Plans or Reserved Instances, or the Cost Explorer commitment permissions are not granted.' : undefined,
  };
}

function gatherAllocation() {
  const since = new Date(Date.now() - 30 * 86400000).toISOString().slice(0, 10);
  let keys = [];
  try {
    const configured = JSON.parse(getSetting('aws_finops_tag_keys') || '[]');
    if (Array.isArray(configured)) keys = configured.map(String);
  } catch { keys = []; }
  if (!keys.length) {
    keys = db.prepare("SELECT DISTINCT key FROM aws_cost_alloc_daily WHERE dimension = 'tag' ORDER BY key").all().map((r) => r.key);
  }
  const metricCol = getSetting('aws_finops_metric') === 'unblended' ? 'amount_usd' : 'COALESCE(amortized_usd, amount_usd)';
  const tagKeys = keys.slice(0, 10).map((key) => {
    const total = db.prepare(`SELECT COALESCE(SUM(${metricCol}), 0) AS s FROM aws_cost_alloc_daily WHERE dimension = 'tag' AND key = ? AND day >= ?`).get(key, since).s || 0;
    const untagged = db.prepare(`SELECT COALESCE(SUM(${metricCol}), 0) AS s FROM aws_cost_alloc_daily WHERE dimension = 'tag' AND key = ? AND day >= ? AND value = ''`).get(key, since).s || 0;
    const values = db.prepare(`
      SELECT value, SUM(${metricCol}) AS usd FROM aws_cost_alloc_daily
      WHERE dimension = 'tag' AND key = ? AND day >= ? AND value <> '' GROUP BY value ORDER BY usd DESC LIMIT 10
    `).all(key, since).map((r) => ({ value: r.value, usd: round2(r.usd), pct: total > 0 ? round2((r.usd / total) * 100) : null }));
    const untaggedServices = db.prepare(`
      SELECT service, SUM(${metricCol}) AS usd FROM aws_cost_alloc_daily
      WHERE dimension = 'tag' AND key = ? AND day >= ? AND value = '' GROUP BY service ORDER BY usd DESC LIMIT 10
    `).all(key, since).map((r) => ({ service: r.service, usd: round2(r.usd) }));
    return {
      key,
      totalUsd: round2(total),
      coveragePct: total > 0 ? round2(((total - untagged) / total) * 100) : null,
      unallocatedPct: total > 0 ? round2((untagged / total) * 100) : null,
      topValues: values,
      topUntaggedServices: untaggedServices,
    };
  });
  return {
    generatedAt: new Date().toISOString(),
    windowDays: 30,
    metric: getSetting('aws_finops_metric') === 'unblended' ? 'unblended' : 'amortized',
    tagKeys,
    note: tagKeys.length === 0 ? 'No cost allocation tag data captured yet. Tags must be activated as cost allocation tags in the AWS Billing console and listed under Settings, FinOps.' : undefined,
  };
}

function gatherResourceCosts() {
  const empty = { generatedAt: new Date().toISOString(), windowDays: 30, topResources: [], byKind: [], note: 'No estimated resource cost yet.' };
  let mod;
  try { mod = require('../awsCostEstimate'); } catch { return empty; }
  const day = (offset) => new Date(Date.now() - offset * 86400000).toISOString().slice(0, 10);
  const metric = getSetting('aws_finops_metric') === 'unblended' ? 'unblended' : 'amortized';
  let out;
  try { out = mod.resourceRollup({ fromDay: day(29), toDay: day(0), metric, limit: 25 }); } catch { return empty; }
  if (!out || !(out.rows || []).length) return empty;
  const totals = out.totals || {};
  return {
    generatedAt: new Date().toISOString(),
    windowDays: 30,
    metric,
    estimated: true,
    totalUsd: round2(totals.totalUsd),
    attributedUsd: round2(totals.attributedUsd),
    unattributedUsd: round2(totals.unattributedUsd),
    attributedPct: round2(totals.attributedPct),
    byKind: (out.byKind || []).map((k) => ({ kind: k.kind, usd: round2(k.usd), count: k.count })),
    topResources: out.rows.slice(0, 25).map((r) => ({
      kind: r.resourceKind, resource: r.label || r.resourceId, services: r.services, usd: round2(r.usd),
      sharePct: round2(r.pct), estMonthlyUsd: round2(r.estMonthlyUsd), tags: r.tags || {},
    })),
    unattributed: (out.unattributed || []).slice(0, 10).map((u) => ({ service: u.service, usd: round2(u.usd) })),
    note: 'Costs are local estimates: billed usage types split across the current inventory by weight.',
  };
}

function gatherMonthlyTrend() {
  const rows = db.prepare(`
    SELECT strftime('%Y-%m', day) AS month, service, SUM(amount_usd) AS total_usd
    FROM aws_cost_daily WHERE day >= date('now', '-12 months')
    GROUP BY month, service ORDER BY month ASC, total_usd DESC LIMIT 300
  `).all();

  const byMonth = new Map();
  for (const r of rows) {
    if (!byMonth.has(r.month)) byMonth.set(r.month, { month: r.month, totalUsd: 0, services: [] });
    const m = byMonth.get(r.month);
    m.totalUsd += r.total_usd || 0;
    if (m.services.length < 5) m.services.push({ service: r.service, usd: +(r.total_usd || 0).toFixed(2) });
  }
  const months = [...byMonth.values()]
    .map((m) => ({ ...m, totalUsd: +m.totalUsd.toFixed(2) }))
    .sort((a, b) => a.month.localeCompare(b.month));

  const monthOverMonth = months.map((m, idx) => {
    const prev = idx > 0 ? months[idx - 1] : null;
    return {
      month: m.month,
      totalUsd: m.totalUsd,
      deltaUsd: prev ? +(m.totalUsd - prev.totalUsd).toFixed(2) : null,
    };
  });

  return {
    generatedAt: new Date().toISOString(),
    months,
    monthOverMonth,
    note: months.length === 0 ? 'No cost data captured yet.' : undefined,
  };
}

module.exports = createPlatformAdvisor({
  platform: 'aws',
  feature: 'AWS FinOps Advisor',
  table: 'aws_ai_reports',
  reports: {
    cost_growth: {
      system:
        'You are a senior FinOps analyst reviewing AWS spend. You are given 30-day service and usage-type cost ' +
        'deltas (first half vs second half of the window), instance-type cost totals against running instance ' +
        'counts, a new-resource capture signal per resource type, open cost-spike issues, and MTD vs previous-month ' +
        'totals. Attribute the growth to specific services, usage types, or resource classes. Call out the single ' +
        'biggest driver. Suggest 2-3 concrete next checks. Do not invent data. Markdown, under ~400 words.',
      gather: gatherCostGrowth,
      noun: 'cost growth attribution report',
    },
    finops_waste: {
      system:
        'You are a senior FinOps analyst hunting for AWS waste. You are given unattached EBS volumes, stopped EC2 ' +
        'instances, NAT gateway counts per VPC, S3 buckets with no lifecycle rules, per-instance-type cost vs ' +
        'running count, Lightsail snapshot counts, and the top recommendations with the status a person set ' +
        '(open, accepted, dismissed, done), the savings still open and the savings realized in the last 90 days. ' +
        'Cost Optimization Hub rows carry savings after discounts, an effort level and restart and rollback flags; ' +
        'ICC rightsizing rows come from CPU history only (no memory data), so call them candidates to verify, not ' +
        'sure savings. Identify concrete monthly savings opportunities, estimate ' +
        'rough dollar savings where computable from the given figures, and rank the list by impact. Do not invent ' +
        'data. Markdown, under ~400 words.',
      gather: gatherFinopsWaste,
      noun: 'waste and savings report',
    },
    commitments: {
      system:
        'You are a senior FinOps analyst reviewing AWS commitment discounts. You are given 30 days of Savings Plan ' +
        'utilization and coverage, unused commitment in dollars, Reserved Instance utilization and coverage, each ' +
        'plan with its term, hourly commitment and days to expiry, and any purchase recommendation from Cost ' +
        'Explorer. State whether commitments are used well, what is lost to unused commitment, which plans expire ' +
        'soonest and what to do before then, and whether more commitment is justified by the coverage gap and the ' +
        'recommendation. Say plainly when there is no commitment data. Do not invent data. Markdown, under ~350 words.',
      gather: gatherCommitments,
      noun: 'commitments report',
    },
    allocation: {
      system:
        'You are a senior FinOps analyst reviewing cost allocation. You are given, per cost allocation tag key, the ' +
        'share of 30-day spend that carries a tag value, the share that does not, the ten largest values and the ten ' +
        'services with the most untagged spend. Say which tag keys are usable for showback, which services leave ' +
        'the most spend unallocated, and which tagging fixes recover the most allocation. Say plainly when no tag ' +
        'data exists. Do not invent data. Markdown, under ~350 words.',
      gather: gatherAllocation,
      noun: 'cost allocation report',
    },
    resource_costs: {
      system:
        'You are a senior FinOps analyst reviewing estimated per-resource AWS cost. You are given the 25 most ' +
        'expensive resources of the last 30 days with kind, services, cost, estimated monthly run rate and tags, ' +
        'the spend by resource kind, and how much spend could not be attributed to a resource. These figures are ' +
        'ICC estimates built by splitting each billed usage type across the inventory it names, not AWS resource ' +
        'billing; say so once. Name the resources that dominate cost, point at anything untagged or expensive for ' +
        'its kind, and say what the unattributed share means for how far to trust the list. Do not invent data. ' +
        'Markdown, under ~350 words.',
      gather: gatherResourceCosts,
      noun: 'resource cost report',
    },
    monthly_trend: {
      system:
        'You are a senior FinOps analyst reviewing AWS spend history. You are given up to 12 months of total spend ' +
        'plus the top-5 services per month and month-over-month deltas. Describe the trend, call out seasonality or ' +
        'inflection months, and give a naive projection for next month. Do not invent data; if history is thin, say ' +
        'so. Markdown, under ~350 words.',
      gather: gatherMonthlyTrend,
      noun: 'monthly trend report',
    },
  },
});
