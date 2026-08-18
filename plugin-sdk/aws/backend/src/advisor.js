// AWS FinOps AI Advisor: cost-growth-attribution/waste/monthly-trend reports.
// Ported from backend/services/advisors/awsAdvisor.js. The original module
// eagerly required the host's db + services/platformAdvisor at require-time;
// a bundled plugin has neither available until coreApi is handed to it, so
// this exports a FACTORY — createAwsAdvisor(coreApi) — built lazily by
// router.js once coreApi is known (dell/nutanix advisor.js pattern). Per the
// plugin contract, coreApi.advisor is the host's services/platformAdvisor
// module (createPlatformAdvisor/linReg/parseUtcMs/fmtBytes), never required
// directly.
function createAwsAdvisor(coreApi) {
  const db = coreApi.db;
  const { createPlatformAdvisor } = coreApi.advisor;
  const { computeIssues, costSpikePct } = require('./issues');

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

    const openCostSpikeIssues = computeIssues(coreApi)
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
      costSpikeThresholdPct: costSpikePct(coreApi),
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

    const empty = !unattachedEbs.length && !stoppedEc2.length && !natGatewaysByVpc.length
      && !s3NoLifecycle.length && !instanceTypeCosts.length && !lightsailSnapshots.length;

    return {
      generatedAt: new Date().toISOString(),
      unattachedEbs,
      stoppedEc2,
      natGatewaysByVpc,
      s3NoLifecycle,
      instanceTypeCosts,
      lightsailSnapshots,
      note: empty ? 'No inventory captured yet.' : undefined,
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

  return createPlatformAdvisor({
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
          'running count, and Lightsail snapshot counts. Identify concrete monthly savings opportunities, estimate ' +
          'rough dollar savings where computable from the given figures, and rank the list by impact. Do not invent ' +
          'data. Markdown, under ~400 words.',
        gather: gatherFinopsWaste,
        noun: 'waste and savings report',
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
}

module.exports = { createAwsAdvisor };
