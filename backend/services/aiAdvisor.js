const db = require('../db/database');
const { fmtBytes, FAILURE_STATUSES, computeInsights } = require('./insights');
const { getSetting } = require('./settings');
const { chatCompletion, MODEL, isConfigured } = require('./llmProvider');
const { createAnonymizer, PROMPT_NOTE } = require('./anonymizer');
const { recordExchange, attachResponse } = require('./aiAudit');
const logger = require('../utils/logger');

const REPORTS = [
  'capacity', 'dr_readiness', 'executive_digest', 'backup_failures',
  'storage_efficiency', 'alert_triage', 'ransomware_resilience',
  'what_changed', 'upgrade_advisory',
];

const FAIL_PH = FAILURE_STATUSES.map(() => '?').join(',');

// Latest metrics row per cluster (most recent captured_at).
function latestPerCluster() {
  return db.prepare(`
    SELECT m.cluster_id, m.used_bytes, m.total_capacity_bytes, m.data_reduction_ratio, m.software_version, m.captured_at
    FROM metrics_history m
    JOIN (SELECT cluster_id, MAX(captured_at) mx FROM metrics_history GROUP BY cluster_id) t
      ON t.cluster_id = m.cluster_id AND t.mx = m.captured_at
  `).all();
}

function clusterNameMap() {
  return new Map(db.prepare('SELECT id, name FROM clusters').all().map(c => [c.id, c.name]));
}
const TTL_HOURS = Number(process.env.LLM_ANALYSIS_TTL_HOURS) || 24;
const TTL_MS = TTL_HOURS * 60 * 60 * 1000;

function parseUtcMs(ts) {
  if (!ts) return 0;
  return new Date(ts.replace(' ', 'T').replace(/Z*$/, 'Z')).getTime();
}

function linReg(pts) {
  const n = pts.length;
  if (n < 2) return null;
  let sx = 0, sy = 0, sxy = 0, sx2 = 0;
  for (const p of pts) { sx += p.x; sy += p.y; sxy += p.x * p.y; sx2 += p.x * p.x; }
  const denom = n * sx2 - sx * sx;
  if (denom === 0) return null;
  const slope = (n * sxy - sx * sy) / denom;
  return { slope, intercept: (sy - slope * sx) / n };
}

function estateContext() {
  return (getSetting('llm_estate_context') || process.env.LLM_ESTATE_CONTEXT || '').trim();
}

// ── Capacity planning context (fleet-wide, from 30-day metrics history) ──────
function gatherCapacityContext() {
  const clusters = db.prepare('SELECT id, name, tags FROM clusters').all();
  const rows = db.prepare(`
    SELECT cluster_id, captured_at, used_bytes, total_capacity_bytes, data_reduction_ratio
    FROM metrics_history
    WHERE captured_at >= datetime('now', '-30 days')
    ORDER BY cluster_id, captured_at ASC
  `).all();

  const byCluster = new Map();
  for (const r of rows) {
    if (!byCluster.has(r.cluster_id)) byCluster.set(r.cluster_id, []);
    byCluster.get(r.cluster_id).push(r);
  }

  let fleetUsed = 0, fleetTotal = 0;
  const out = [];
  for (const c of clusters) {
    const series = byCluster.get(c.id) || [];
    const latest = series[series.length - 1];
    const total = latest?.total_capacity_bytes || 0;
    const used = latest?.used_bytes || 0;
    if (total > 0) { fleetUsed += used; fleetTotal += total; }
    const pts = series.filter(r => r.used_bytes != null && r.captured_at)
      .map(r => ({ x: parseUtcMs(r.captured_at), y: r.used_bytes }));
    const reg = linReg(pts);
    const growthPerDay = reg ? reg.slope * 86400000 : 0;
    let daysTo90 = null;
    if (reg && reg.slope > 0 && total > 0) {
      const d = (total * 0.9 - used) / growthPerDay;
      if (d > 0 && d <= 3650) daysTo90 = Math.round(d);
    }
    out.push({
      cluster: c.name,
      tags: c.tags || null,
      usedPct: total > 0 ? +((used / total) * 100).toFixed(1) : null,
      used: fmtBytes(used),
      total: fmtBytes(total),
      growthPerDay: growthPerDay > 0 ? fmtBytes(growthPerDay) + '/day' : 'flat/declining',
      daysTo90,
      dataReductionRatio: latest?.data_reduction_ratio ?? null,
      dataPoints: series.length,
    });
  }
  out.sort((a, b) => (a.daysTo90 ?? Infinity) - (b.daysTo90 ?? Infinity));
  return {
    generatedAt: new Date().toISOString(),
    fleet: {
      clusters: clusters.length,
      reporting: out.filter(c => c.usedPct != null).length,
      usedPct: fleetTotal > 0 ? +((fleetUsed / fleetTotal) * 100).toFixed(1) : null,
      used: fmtBytes(fleetUsed),
      total: fmtBytes(fleetTotal),
    },
    clusters: out,
  };
}

// ── DR / replication readiness context (fleet-wide) ──────────────────────────
function gatherDrContext() {
  const fail = FAILURE_STATUSES.map(() => '?').join(',');

  const repl = db.prepare(`
    SELECT COUNT(*) total,
           SUM(CASE WHEN status IN (${fail}) THEN 1 ELSE 0 END) failed,
           AVG(lag_seconds) avgLag,
           SUM(CASE WHEN status IN ('kAccepted','kRunning') AND start_time <= datetime('now','-4 hours') THEN 1 ELSE 0 END) stuck
    FROM replication_runs WHERE start_time >= datetime('now', '-7 days')
  `).get(...FAILURE_STATUSES);

  const flows = db.prepare(`
    SELECT c.name source, rr.target_cluster_name target,
           COUNT(*) runs,
           SUM(CASE WHEN rr.status IN (${fail}) THEN 1 ELSE 0 END) failed,
           AVG(rr.lag_seconds) avgLag,
           MAX(rr.start_time) lastSeen
    FROM replication_runs rr JOIN clusters c ON rr.cluster_id = c.id
    WHERE rr.start_time >= datetime('now', '-7 days')
    GROUP BY rr.cluster_id, rr.target_cluster_id, rr.target_cluster_name
    ORDER BY runs DESC LIMIT 40
  `).all(...FAILURE_STATUSES).map(f => ({
    source: f.source, target: f.target || 'unknown',
    runs: f.runs, failRatePct: f.runs > 0 ? +((f.failed / f.runs) * 100).toFixed(1) : 0,
    avgLagSeconds: f.avgLag != null ? Math.round(f.avgLag) : null,
    lastSeen: f.lastSeen,
  }));

  const policies = db.prepare(`
    SELECT COUNT(*) total,
           SUM(CASE WHEN replication_targets != '[]' OR archival_targets != '[]' THEN 1 ELSE 0 END) withOffsite,
           SUM(CASE WHEN datalock = 1 THEN 1 ELSE 0 END) withDatalock
    FROM policies
  `).get();

  // Clusters with no outbound replication in the last 7 days = DR gaps.
  const allClusters = db.prepare('SELECT id, name FROM clusters').all();
  const replicating = new Set(db.prepare(`
    SELECT DISTINCT cluster_id FROM replication_runs WHERE start_time >= datetime('now','-7 days')
  `).all().map(r => r.cluster_id));
  const noReplication = allClusters.filter(c => !replicating.has(c.id)).map(c => c.name);

  return {
    generatedAt: new Date().toISOString(),
    replication7d: {
      total: repl.total || 0,
      failed: repl.failed || 0,
      failRatePct: repl.total > 0 ? +((repl.failed / repl.total) * 100).toFixed(1) : 0,
      avgLagSeconds: repl.avgLag != null ? Math.round(repl.avgLag) : null,
      stuckOver4h: repl.stuck || 0,
    },
    policies: {
      total: policies.total || 0,
      withOffsiteCopy: policies.withOffsite || 0,
      withoutOffsiteCopy: (policies.total || 0) - (policies.withOffsite || 0),
      withDatalock: policies.withDatalock || 0,
    },
    clustersWithoutOutboundReplication: noReplication,
    topFlows: flows,
  };
}

// ── Executive digest (cross-domain fleet rollup + top insights) ──────────────
function gatherExecutiveDigest() {
  const ins = computeInsights();
  const clusters = db.prepare('SELECT COUNT(*) n FROM clusters').get().n;
  const latest = latestPerCluster();
  let used = 0, total = 0;
  for (const m of latest) { used += m.used_bytes || 0; total += m.total_capacity_bytes || 0; }
  const alerts = db.prepare(`
    SELECT SUM(CASE WHEN severity='critical' THEN 1 ELSE 0 END) crit,
           SUM(CASE WHEN severity='warning' THEN 1 ELSE 0 END) warn
    FROM alerts WHERE resolved=0 AND dismissed=0
  `).get();
  const prot = db.prepare(`SELECT COUNT(*) total, SUM(CASE WHEN status IN (${FAIL_PH}) THEN 1 ELSE 0 END) failed FROM protection_runs WHERE start_time >= datetime('now','-7 days')`).get(...FAILURE_STATUSES);
  const repl = db.prepare(`SELECT COUNT(*) total, SUM(CASE WHEN status IN (${FAIL_PH}) THEN 1 ELSE 0 END) failed FROM replication_runs WHERE start_time >= datetime('now','-7 days')`).get(...FAILURE_STATUSES);
  return {
    fleet: {
      clusters,
      capacityUsedPct: total > 0 ? +((used / total) * 100).toFixed(1) : null,
      capacity: `${fmtBytes(used)} / ${fmtBytes(total)}`,
      activeCriticalAlerts: alerts.crit || 0,
      activeWarningAlerts: alerts.warn || 0,
      backupSuccessRate7dPct: prot.total > 0 ? +(((prot.total - prot.failed) / prot.total) * 100).toFixed(1) : null,
      replicationFailRate7dPct: repl.total > 0 ? +((repl.failed / repl.total) * 100).toFixed(1) : null,
    },
    insightSummary: ins.summary,
    topInsights: ins.insights.slice(0, 15).map(i => ({ severity: i.severity, category: i.category, title: i.title, cluster: i.clusterName || null })),
  };
}

// ── Backup success & failure analysis (7-day) ────────────────────────────────
function gatherBackupFailures() {
  const summary = db.prepare(`
    SELECT COUNT(*) total, SUM(CASE WHEN status='kSuccess' THEN 1 ELSE 0 END) success,
           SUM(CASE WHEN status IN (${FAIL_PH}) THEN 1 ELSE 0 END) failed
    FROM protection_runs WHERE start_time >= datetime('now','-7 days')
  `).get(...FAILURE_STATUSES);
  const topReasons = db.prepare(`
    SELECT COALESCE(NULLIF(TRIM(error_message),''), NULLIF(TRIM(error_code),''), status, 'Unknown') reason,
           COUNT(*) count, COUNT(DISTINCT cluster_id) clusters, COUNT(DISTINCT job_id) jobs
    FROM protection_runs
    WHERE start_time >= datetime('now','-7 days') AND status IN (${FAIL_PH})
    GROUP BY reason ORDER BY count DESC LIMIT 15
  `).all(...FAILURE_STATUSES);
  const worstClusters = db.prepare(`
    SELECT c.name cluster, COUNT(*) total, SUM(CASE WHEN pr.status IN (${FAIL_PH}) THEN 1 ELSE 0 END) failed
    FROM protection_runs pr JOIN clusters c ON pr.cluster_id=c.id
    WHERE pr.start_time >= datetime('now','-7 days')
    GROUP BY pr.cluster_id HAVING failed>0 ORDER BY failed DESC LIMIT 15
  `).all(...FAILURE_STATUSES).map(r => ({ cluster: r.cluster, failed: r.failed, total: r.total, failRatePct: r.total > 0 ? +((r.failed / r.total) * 100).toFixed(1) : 0 }));
  const mostFailingJobs = db.prepare(`
    SELECT c.name cluster, pr.job_name job, COUNT(*) failures, MAX(pr.start_time) lastSeen
    FROM protection_runs pr JOIN clusters c ON pr.cluster_id=c.id
    WHERE pr.start_time >= datetime('now','-7 days') AND pr.status IN (${FAIL_PH})
    GROUP BY pr.cluster_id, pr.job_id ORDER BY failures DESC LIMIT 15
  `).all(...FAILURE_STATUSES);
  return {
    window: '7 days',
    summary: { total: summary.total || 0, success: summary.success || 0, failed: summary.failed || 0, successRatePct: summary.total > 0 ? +(((summary.total - summary.failed) / summary.total) * 100).toFixed(1) : null },
    topFailureReasons: topReasons,
    worstClusters,
    mostFailingJobs,
  };
}

// ── Storage efficiency (data reduction) ──────────────────────────────────────
function gatherStorageEfficiency() {
  const names = clusterNameMap();
  const rows = latestPerCluster().filter(m => m.total_capacity_bytes > 0).map(m => ({
    cluster: names.get(m.cluster_id) || `Cluster ${m.cluster_id}`,
    dataReductionRatio: m.data_reduction_ratio != null ? +m.data_reduction_ratio.toFixed(2) : null,
    used: fmtBytes(m.used_bytes),
    usedPct: +((m.used_bytes / m.total_capacity_bytes) * 100).toFixed(1),
  }));
  const drs = rows.map(r => r.dataReductionRatio).filter(v => v != null && v > 0);
  rows.sort((a, b) => (a.dataReductionRatio ?? 99) - (b.dataReductionRatio ?? 99));
  return {
    fleetAvgDataReduction: drs.length ? +(drs.reduce((a, b) => a + b, 0) / drs.length).toFixed(2) : null,
    clusters: rows,
  };
}

// ── Fleet alert triage ───────────────────────────────────────────────────────
function gatherAlertTriage() {
  const totals = db.prepare(`
    SELECT COUNT(*) total,
           SUM(CASE WHEN severity='critical' THEN 1 ELSE 0 END) critical,
           SUM(CASE WHEN severity='warning' THEN 1 ELSE 0 END) warning,
           SUM(CASE WHEN severity NOT IN ('critical','warning') THEN 1 ELSE 0 END) info
    FROM alerts WHERE resolved=0 AND dismissed=0
  `).get();
  const byType = db.prepare(`
    SELECT alert_type type, severity, COUNT(*) count, COUNT(DISTINCT cluster_id) clusters, MAX(description) description
    FROM alerts WHERE resolved=0 AND dismissed=0
    GROUP BY alert_type, severity ORDER BY count DESC LIMIT 20
  `).all();
  const topClusters = db.prepare(`
    SELECT c.name cluster, COUNT(*) count, SUM(CASE WHEN a.severity='critical' THEN 1 ELSE 0 END) critical
    FROM alerts a JOIN clusters c ON a.cluster_id=c.id
    WHERE a.resolved=0 AND a.dismissed=0
    GROUP BY a.cluster_id ORDER BY count DESC LIMIT 15
  `).all();
  return { active: { total: totals.total || 0, critical: totals.critical || 0, warning: totals.warning || 0, info: totals.info || 0 }, byType, topClusters };
}

// ── Ransomware resilience / immutability ─────────────────────────────────────
function gatherRansomwareResilience() {
  const pol = db.prepare(`
    SELECT COUNT(*) total,
           SUM(CASE WHEN datalock=1 THEN 1 ELSE 0 END) datalock,
           SUM(CASE WHEN replication_targets!='[]' OR archival_targets!='[]' THEN 1 ELSE 0 END) offsite
    FROM policies
  `).get();
  const src = db.prepare('SELECT SUM(COALESCE(unprotected_count,0)) unprotected, SUM(COALESCE(protected_count,0)) protected FROM source_registrations').get();
  const clusters = db.prepare('SELECT COUNT(*) n FROM clusters').get().n;
  const replicating = db.prepare(`SELECT COUNT(DISTINCT cluster_id) n FROM replication_runs WHERE start_time >= datetime('now','-7 days')`).get().n;
  return {
    policies: {
      total: pol.total || 0,
      withDatalock: pol.datalock || 0,
      withoutDatalock: (pol.total || 0) - (pol.datalock || 0),
      withOffsiteCopy: pol.offsite || 0,
      withoutOffsiteCopy: (pol.total || 0) - (pol.offsite || 0),
    },
    sources: { protected: src.protected || 0, unprotected: src.unprotected || 0 },
    clusters: { total: clusters, replicatingLast7d: replicating, notReplicating: clusters - replicating },
  };
}

// ── What changed (week-over-week) ────────────────────────────────────────────
function gatherWhatChanged() {
  const alerts = db.prepare(`
    SELECT (SELECT COUNT(*) FROM alerts WHERE first_seen >= datetime('now','-7 days')) last7d,
           (SELECT COUNT(*) FROM alerts WHERE first_seen >= datetime('now','-14 days') AND first_seen < datetime('now','-7 days')) prior7d
  `).get();
  const protLast = db.prepare(`SELECT COUNT(*) total, SUM(CASE WHEN status IN (${FAIL_PH}) THEN 1 ELSE 0 END) failed FROM protection_runs WHERE start_time >= datetime('now','-7 days')`).get(...FAILURE_STATUSES);
  const protPrior = db.prepare(`SELECT COUNT(*) total, SUM(CASE WHEN status IN (${FAIL_PH}) THEN 1 ELSE 0 END) failed FROM protection_runs WHERE start_time >= datetime('now','-14 days') AND start_time < datetime('now','-7 days')`).get(...FAILURE_STATUSES);
  const names = clusterNameMap();
  const weekAgo = db.prepare(`
    SELECT m.cluster_id, m.used_bytes FROM metrics_history m
    JOIN (SELECT cluster_id, MAX(captured_at) mx FROM metrics_history WHERE captured_at <= datetime('now','-7 days') GROUP BY cluster_id) t
      ON t.cluster_id=m.cluster_id AND t.mx=m.captured_at
  `).all();
  const weekMap = new Map(weekAgo.map(r => [r.cluster_id, r.used_bytes]));
  const capChanges = latestPerCluster().map(m => {
    const prev = weekMap.get(m.cluster_id);
    if (prev == null || m.used_bytes == null) return null;
    return { cluster: names.get(m.cluster_id), deltaBytes: m.used_bytes - prev };
  }).filter(Boolean).sort((a, b) => Math.abs(b.deltaBytes) - Math.abs(a.deltaBytes)).slice(0, 12)
    .map(c => ({ cluster: c.cluster, usedChange7d: (c.deltaBytes >= 0 ? '+' : '') + fmtBytes(c.deltaBytes) }));
  return {
    alerts: { newLast7d: alerts.last7d || 0, newPrior7d: alerts.prior7d || 0 },
    backups: { last7d: { total: protLast.total || 0, failed: protLast.failed || 0 }, prior7d: { total: protPrior.total || 0, failed: protPrior.failed || 0 } },
    capacityChanges7d: capChanges,
  };
}

// ── Upgrade advisory (software version drift) ────────────────────────────────
function gatherUpgradeAdvisory() {
  const names = clusterNameMap();
  const rows = latestPerCluster().filter(m => m.software_version)
    .map(m => ({ cluster: names.get(m.cluster_id), version: m.software_version }));
  const counts = {};
  for (const r of rows) counts[r.version] = (counts[r.version] || 0) + 1;
  const distribution = Object.entries(counts).map(([version, count]) => ({ version, count })).sort((a, b) => b.count - a.count);
  return { totalClustersWithVersion: rows.length, dominant: distribution[0]?.version || null, distribution, clusters: rows };
}

const PROMPTS = {
  capacity: {
    system:
      'You are a senior storage capacity planner for a Cohesity backup estate. You are given fleet totals and ' +
      'per-cluster capacity: current usage %, used/total, modeled daily growth, projected days until 90% full, and ' +
      'data-reduction ratio (clusters sorted by soonest to fill). Produce a capacity plan: identify which clusters ' +
      'need expansion and roughly when (prioritized by urgency), flag anomalous or runaway growth, suggest ' +
      'archive/retention or rebalancing actions, and give a fleet procurement timeline. Be specific with cluster ' +
      'names and the projected dates. Do not invent data; if growth is flat or history is thin, say so. ' +
      'Markdown sections: **Fleet summary**, **Needs attention (soonest first)**, **Procurement timeline**, ' +
      '**Recommended actions**. Keep under ~400 words.',
    gather: gatherCapacityContext,
    noun: 'capacity plan',
  },
  dr_readiness: {
    system:
      'You are a disaster-recovery and business-continuity analyst for a Cohesity backup estate. You are given ' +
      '7-day replication health (success/failure, average lag, tasks stuck >4h), protection-policy off-site ' +
      'coverage (replication/archival targets, datalock), clusters with NO outbound replication, and top ' +
      'source→target flows with failure rates and lag. Assess DR readiness and recoverability. Flag single-site ' +
      'risk (policies with no off-site copy = 3-2-1 violation), clusters with no replication at all, high RPO lag, ' +
      'and failing or stuck replication. Be specific with names/numbers. Do not invent data. ' +
      'Markdown sections: **DR readiness summary**, **Key gaps (prioritized)**, **RPO / lag risks**, ' +
      '**Recommended actions**. Keep under ~400 words.',
    gather: gatherDrContext,
    noun: 'DR readiness report',
  },
  executive_digest: {
    system:
      'You are a principal backup/storage architect briefing leadership on a Cohesity estate. You are given fleet ' +
      'rollups (capacity, active alerts, 7-day backup success, replication) and the top prioritized insights. ' +
      'Produce a crisp executive brief — do not restate every insight. Markdown sections: **Bottom line** ' +
      '(2-3 sentences), **Top risks this week** (bulleted, highest first, name the affected cluster), ' +
      "**What's going well**, **Recommended focus this week**. Keep under ~350 words.",
    gather: gatherExecutiveDigest,
    noun: 'executive digest',
  },
  backup_failures: {
    system:
      'You are a senior backup operations engineer analyzing data-protection failures across a Cohesity estate ' +
      '(last 7 days). You are given the overall success rate, top failure reasons (with how many clusters and jobs ' +
      'each spans), the worst clusters, and the most-failing jobs. Group failures into likely root-cause themes — a ' +
      'reason spanning many clusters/jobs is systemic, not isolated. Prioritize by impact to recoverability. ' +
      'Markdown sections: **Summary**, **Systemic failure themes (root causes)**, **Worst offenders**, ' +
      '**Recommended actions**. Keep under ~400 words.',
    gather: gatherBackupFailures,
    noun: 'backup failure analysis',
  },
  storage_efficiency: {
    system:
      'You are a storage efficiency analyst for a Cohesity estate. You are given the fleet average data-reduction ' +
      'ratio and per-cluster ratios (sorted lowest first) with usage. Identify clusters with poor ' +
      'dedup/compression, outliers well below the fleet average, and likely causes (encrypted, pre-compressed, or ' +
      'media-heavy workloads). Suggest where efficiency gains or workload/storage-domain changes are worthwhile. ' +
      'Markdown sections: **Summary**, **Low-efficiency outliers**, **Likely causes**, **Recommended actions**. ' +
      'Keep under ~350 words.',
    gather: gatherStorageEfficiency,
    noun: 'storage efficiency review',
  },
  alert_triage: {
    system:
      'You are an operations lead triaging active alerts across a Cohesity estate. You are given active alert totals ' +
      'by severity, alert types grouped by how many clusters each spans (each with a numeric code AND a human ' +
      'description), and the noisiest clusters. ALWAYS refer to an alert type by a short plain-English summary of ' +
      'its description (e.g. "node power-supply removed"), NEVER by the raw numeric code (e.g. "13015.0") — the ' +
      'reader should not have to map a number to a meaning. An alert type spanning many clusters is likely one ' +
      'systemic root cause. Separate signal from noise and give a prioritized triage plan. Markdown sections: ' +
      '**Summary**, **Systemic / cross-cluster patterns**, **Noisiest clusters**, **Recommended triage order**. ' +
      'Keep under ~350 words.',
    gather: gatherAlertTriage,
    noun: 'alert triage report',
  },
  ransomware_resilience: {
    system:
      'You are a security architect assessing ransomware resilience of a Cohesity backup estate. You are given ' +
      'policy DataLock (immutability) coverage, off-site copy coverage, protected vs unprotected source counts, and ' +
      'how many clusters replicate. Assess recovery readiness against a ransomware or data-loss event. Flag ' +
      'immutability gaps (policies without DataLock), single-site risk (no off-site copy = 3-2-1 violation), ' +
      'unprotected data, and clusters with no replication. Markdown sections: **Resilience summary**, ' +
      '**Key gaps (prioritized)**, **Recommended actions**. Keep under ~350 words.',
    gather: gatherRansomwareResilience,
    noun: 'ransomware resilience assessment',
  },
  what_changed: {
    system:
      'You are an SRE producing a week-over-week change digest for a Cohesity estate. You are given new alert volume ' +
      '(last 7 days vs the prior 7), backup run and failure counts (last 7 vs prior 7), and the largest per-cluster ' +
      'capacity changes over the last 7 days. Narrate what materially changed and why it matters; call out ' +
      'regressions (rising failures or alerts, sudden growth). Ignore noise. Markdown sections: **What changed**, ' +
      '**Regressions to watch**, **Recommended actions**. Keep under ~350 words.',
    gather: gatherWhatChanged,
    noun: 'week-over-week change digest',
  },
  upgrade_advisory: {
    system:
      'You are a Cohesity platform engineer planning software upgrades across a fleet. You are given the ' +
      'software-version distribution, the dominant version, and per-cluster versions. Recommend a convergence plan: ' +
      'which clusters are outliers, a sensible upgrade order, and the risks of a mixed-version fleet (support, ' +
      'replication compatibility). If every cluster already shares one version, state the fleet is converged and no ' +
      'action is needed. Markdown sections: **Version landscape**, **Outliers**, **Upgrade plan (ordered)**, ' +
      '**Risks**. Keep under ~350 words.',
    gather: gatherUpgradeAdvisory,
    noun: 'upgrade advisory',
  },
};

async function generateReport(reportKey) {
  const spec = PROMPTS[reportKey];
  if (!spec) { const e = new Error('Unknown report.'); e.code = 'BAD_REPORT'; throw e; }
  if (!isConfigured()) { const e = new Error('LLM not configured.'); e.code = 'LLM_NOT_CONFIGURED'; throw e; }

  // Anonymize all identifiable data (names, hosts, IPs) before it leaves the
  // box; tokens in the response are mapped back to real names below.
  const anon = createAnonymizer();
  const context = anon.anonymize(spec.gather());
  let system = spec.system + PROMPT_NOTE;
  const ec = estateContext();
  if (ec) system += ' Operator context describing what is NORMAL for this estate — treat as authoritative and do NOT flag anything it says is expected: ' + anon.anonymize(ec);

  const userPrompt =
    `Estate data (JSON):\n\`\`\`json\n${JSON.stringify(context, null, 2)}\n\`\`\`\n\nProduce the ${spec.noun}.`;

  const messages = [
    { role: 'system', content: system },
    { role: 'user', content: userPrompt },
  ];
  const auditId = recordExchange({
    feature: 'AI Advisor',
    label: spec.noun,
    model: MODEL,
    messages,
    mappings: anon.mappings(),
  });

  let content;
  try {
    content = await chatCompletion(messages);
  } catch (e) {
    logger.error(`[Advisor] ${reportKey} generation failed:`, e.code || '', e.detail || e.message);
    throw e;
  }
  if (!content) { const e = new Error('LLM returned an empty response.'); e.code = 'LLM_EMPTY'; throw e; }

  attachResponse(auditId, content);
  content = anon.restore(content);

  const generatedAt = new Date().toISOString();
  db.prepare(`
    INSERT INTO ai_reports (report_key, model, content, generated_at)
    VALUES (?, ?, ?, ?)
    ON CONFLICT(report_key) DO UPDATE SET model = excluded.model, content = excluded.content, generated_at = excluded.generated_at
  `).run(reportKey, MODEL, content, generatedAt);

  return { reportKey, model: MODEL, content, generatedAt, stale: false, ttlHours: TTL_HOURS };
}

function getCachedReport(reportKey) {
  const row = db.prepare(
    'SELECT report_key AS reportKey, model, content, generated_at AS generatedAt FROM ai_reports WHERE report_key = ?'
  ).get(reportKey);
  if (!row) return null;
  row.stale = (Date.now() - new Date(row.generatedAt).getTime()) > TTL_MS;
  row.ttlHours = TTL_HOURS;
  return row;
}

module.exports = { REPORTS, generateReport, getCachedReport, isConfigured };
