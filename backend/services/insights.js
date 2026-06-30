const db = require('../db/database');

const FAILURE_STATUSES = ['kFailure', 'kFailed', 'kError', 'kCanceled', 'kCancelled'];

function linReg(pts) {
  const n = pts.length;
  if (n < 2) return null;
  let sumX = 0, sumY = 0, sumXY = 0, sumX2 = 0;
  for (const p of pts) {
    sumX += p.x; sumY += p.y; sumXY += p.x * p.y; sumX2 += p.x * p.x;
  }
  const denom = n * sumX2 - sumX * sumX;
  if (denom === 0) return null;
  const slope = (n * sumXY - sumX * sumY) / denom;
  const intercept = (sumY - slope * sumX) / n;
  return { slope, intercept };
}

function fmtBytes(b) {
  if (b == null) return '—';
  const abs = Math.abs(b);
  if (abs >= 1e15) return (b / 1e15).toFixed(2) + ' PB';
  if (abs >= 1e12) return (b / 1e12).toFixed(2) + ' TB';
  if (abs >= 1e9) return (b / 1e9).toFixed(1) + ' GB';
  return (b / 1e6).toFixed(0) + ' MB';
}

function parseUtcMs(ts) {
  if (!ts) return 0;
  return new Date(ts.replace(' ', 'T').replace(/Z*$/, 'Z')).getTime();
}

/**
 * Compute prioritized, actionable insights across capacity, availability,
 * alerts, data protection, replication, and governance. Pure SQLite reads.
 * Returns { generatedAt, summary, insights }.
 */
function computeInsights() {
  const insights = [];
  const now = Date.now();

  const clusters = db.prepare('SELECT id, name, polling_interval_minutes FROM clusters').all();
  const clusterName = new Map(clusters.map(c => [c.id, c.name]));

  // ── 1. Capacity: current pressure + linear-regression forecast ─────────
  const historyRows = db.prepare(`
    SELECT cluster_id, captured_at, used_bytes, total_capacity_bytes, data_reduction_ratio
    FROM metrics_history
    WHERE captured_at >= datetime('now', '-30 days')
    ORDER BY cluster_id, captured_at ASC
  `).all();

  const byCluster = new Map();
  for (const r of historyRows) {
    if (!byCluster.has(r.cluster_id)) byCluster.set(r.cluster_id, []);
    byCluster.get(r.cluster_id).push(r);
  }

  for (const [cid, rows] of byCluster) {
    const name = clusterName.get(cid) || `Cluster ${cid}`;
    const latest = rows[rows.length - 1];
    const total = latest?.total_capacity_bytes || 0;
    const used = latest?.used_bytes || 0;
    if (total <= 0) continue;
    const pct = (used / total) * 100;

    const pts = rows
      .filter(r => r.used_bytes != null && r.captured_at)
      .map(r => ({ x: parseUtcMs(r.captured_at), y: r.used_bytes }));
    const reg = linReg(pts);
    const growthPerDay = reg ? reg.slope * 86400000 : 0;

    let daysTo90 = null;
    if (reg && reg.slope > 0) {
      const d = (total * 0.9 - used) / growthPerDay;
      if (d > 0 && d <= 999) daysTo90 = Math.round(d);
    }

    if (pct >= 90) {
      insights.push({
        severity: 'critical', category: 'capacity', clusterId: cid, clusterName: name,
        title: `${name} is at ${pct.toFixed(1)}% capacity`,
        detail: `${fmtBytes(used)} of ${fmtBytes(total)} consumed. Cohesity recommends staying below 90% to preserve resiliency headroom for node failures and recoveries.`,
        recommendation: 'Expand the cluster, rebalance workloads, or review retention policies to reclaim space immediately.',
        metric: { pct: +pct.toFixed(1), daysTo90 },
      });
    } else if (pct >= 80 || (daysTo90 != null && daysTo90 <= 60)) {
      const eta = daysTo90 != null
        ? `At the current growth rate of ${fmtBytes(growthPerDay)}/day it will cross 90% in ~${daysTo90} days (${new Date(now + daysTo90 * 86400000).toLocaleDateString()}).`
        : '';
      insights.push({
        severity: 'warning', category: 'capacity', clusterId: cid, clusterName: name,
        title: daysTo90 != null && pct < 80
          ? `${name} will reach 90% capacity in ~${daysTo90} days`
          : `${name} is at ${pct.toFixed(1)}% capacity`,
        detail: `${fmtBytes(used)} of ${fmtBytes(total)} consumed. ${eta}`.trim(),
        recommendation: 'Plan a capacity expansion or archive cold snapshots to cloud before the threshold is reached.',
        metric: { pct: +pct.toFixed(1), daysTo90, growthPerDayBytes: Math.round(growthPerDay) },
      });
    }

    const dr = latest?.data_reduction_ratio;
    if (dr != null && dr > 0 && dr < 1.3) {
      insights.push({
        severity: 'info', category: 'efficiency', clusterId: cid, clusterName: name,
        title: `Low data reduction on ${name} (${dr.toFixed(2)}x)`,
        detail: 'A reduction ratio under 1.3x usually indicates encrypted, compressed, or media-heavy sources where dedupe is ineffective.',
        recommendation: 'Verify deduplication/compression settings on storage domains and consider excluding pre-compressed workloads.',
        metric: { dataReductionRatio: dr },
      });
    }
  }

  // ── 2. Availability: stale / silent clusters ───────────────────────────
  const latestCapture = db.prepare(`
    SELECT cluster_id, MAX(captured_at) AS last_seen FROM metrics_history GROUP BY cluster_id
  `).all();
  const lastSeenMap = new Map(latestCapture.map(r => [r.cluster_id, r.last_seen]));

  for (const c of clusters) {
    const lastSeen = lastSeenMap.get(c.id);
    const staleMs = (c.polling_interval_minutes || 15) * 2 * 60 * 1000;
    const age = lastSeen ? now - parseUtcMs(lastSeen) : Infinity;
    if (!lastSeen) {
      insights.push({
        severity: 'warning', category: 'availability', clusterId: c.id, clusterName: c.name,
        title: `${c.name} has never reported metrics`,
        detail: 'No polling data has been collected for this cluster since it was added.',
        recommendation: 'Verify credentials and network reachability, then trigger a manual poll from Cluster Management.',
        metric: {},
      });
    } else if (age > Math.max(staleMs, 60 * 60 * 1000)) {
      const hrs = Math.round(age / 3600000);
      insights.push({
        severity: hrs >= 24 ? 'critical' : 'warning', category: 'availability', clusterId: c.id, clusterName: c.name,
        title: `${c.name} has not reported in ${hrs >= 24 ? Math.round(hrs / 24) + ' day(s)' : hrs + ' hour(s)'}`,
        detail: `Last successful metric collection was ${new Date(parseUtcMs(lastSeen)).toLocaleString()}. Monitoring data for this cluster is blind.`,
        recommendation: 'Check cluster availability, credential validity, and poller status; trigger a manual poll to confirm connectivity.',
        metric: { hoursSilent: hrs },
      });
    }
  }

  // ── 3. Alerts: active criticals + 24h spike detection ──────────────────
  const alertCounts = db.prepare(`
    SELECT cluster_id,
           SUM(CASE WHEN severity = 'critical' THEN 1 ELSE 0 END) AS criticals,
           SUM(CASE WHEN severity = 'warning' THEN 1 ELSE 0 END) AS warnings
    FROM alerts WHERE resolved = 0 AND dismissed = 0
    GROUP BY cluster_id
  `).all();

  for (const row of alertCounts) {
    if (row.criticals >= 1) {
      const name = clusterName.get(row.cluster_id) || `Cluster ${row.cluster_id}`;
      insights.push({
        severity: 'critical', category: 'alerts', clusterId: row.cluster_id, clusterName: name,
        title: `${row.criticals} unresolved critical alert${row.criticals > 1 ? 's' : ''} on ${name}`,
        detail: `${row.criticals} critical and ${row.warnings || 0} warning alert(s) are awaiting action.`,
        recommendation: 'Triage critical alerts first — hardware and protection failures compound quickly if left unresolved.',
        metric: { criticals: row.criticals, warnings: row.warnings || 0 },
      });
    }
  }

  const spike = db.prepare(`
    SELECT
      (SELECT COUNT(*) FROM alerts WHERE first_seen >= datetime('now', '-1 day')) AS last24h,
      (SELECT COUNT(*) FROM alerts WHERE first_seen >= datetime('now', '-8 days') AND first_seen < datetime('now', '-1 day')) AS prior7d
  `).get();
  const dailyAvg = (spike.prior7d || 0) / 7;
  if (spike.last24h >= 5 && spike.last24h > dailyAvg * 2) {
    insights.push({
      severity: 'warning', category: 'alerts', clusterId: null, clusterName: null,
      title: `Alert volume spike: ${spike.last24h} new alerts in 24h`,
      detail: `That is ${dailyAvg > 0 ? (spike.last24h / dailyAvg).toFixed(1) + 'x' : 'well above'} the trailing 7-day average of ${dailyAvg.toFixed(1)}/day — often an early sign of a systemic issue.`,
      recommendation: 'Review the Alerts page grouped by type to identify a common root cause.',
      metric: { last24h: spike.last24h, dailyAvg: +dailyAvg.toFixed(1) },
    });
  }

  // ── 4. Data protection: failing jobs + overall success rate ────────────
  const recentRuns = db.prepare(`
    SELECT cluster_id, job_id, job_name, status, start_time
    FROM protection_runs
    WHERE start_time >= datetime('now', '-7 days')
    ORDER BY start_time DESC
  `).all();

  const jobRuns = new Map();
  let total7d = 0, failed7d = 0;
  for (const r of recentRuns) {
    total7d++;
    if (FAILURE_STATUSES.includes(r.status)) failed7d++;
    const key = `${r.cluster_id}|${r.job_id}`;
    if (!jobRuns.has(key)) jobRuns.set(key, []);
    jobRuns.get(key).push(r);
  }

  const failingJobs = [];
  for (const [, runs] of jobRuns) {
    let streak = 0;
    for (const r of runs) {
      if (FAILURE_STATUSES.includes(r.status)) streak++;
      else break;
    }
    if (streak >= 3) failingJobs.push({ run: runs[0], streak });
  }
  failingJobs.sort((a, b) => b.streak - a.streak);
  for (const { run, streak } of failingJobs.slice(0, 5)) {
    const name = clusterName.get(run.cluster_id) || `Cluster ${run.cluster_id}`;
    insights.push({
      severity: 'critical', category: 'protection', clusterId: run.cluster_id, clusterName: name,
      title: `"${run.job_name || 'Job ' + run.job_id}" has failed ${streak} consecutive times`,
      detail: `The most recent run on ${name} ended with status ${run.status}. Recovery points are not being created for the protected objects.`,
      recommendation: 'Open Data Protection analytics to inspect the error, then validate source connectivity and job configuration.',
      metric: { consecutiveFailures: streak },
    });
  }

  if (total7d >= 10) {
    const successRate = ((total7d - failed7d) / total7d) * 100;
    if (successRate < 90) {
      insights.push({
        severity: successRate < 75 ? 'critical' : 'warning', category: 'protection', clusterId: null, clusterName: null,
        title: `Backup success rate is ${successRate.toFixed(1)}% over 7 days`,
        detail: `${failed7d} of ${total7d} protection runs failed. Enterprise SLAs typically target 95%+.`,
        recommendation: 'Review the top failure reasons in Analytics and prioritize jobs with repeated errors.',
        metric: { successRate: +successRate.toFixed(1), failed: failed7d, total: total7d },
      });
    }
  }

  // ── 5. Replication health ───────────────────────────────────────────────
  const repl = db.prepare(`
    SELECT
      COUNT(*) AS total,
      SUM(CASE WHEN status IN ('kFailed','kFailure','kCanceled','kCancelled','kError') THEN 1 ELSE 0 END) AS failed,
      AVG(lag_seconds) AS avgLag,
      SUM(CASE WHEN status IN ('kAccepted','kRunning') AND start_time <= datetime('now','-4 hours') THEN 1 ELSE 0 END) AS stuck
    FROM replication_runs
    WHERE start_time >= datetime('now', '-3 days')
  `).get();

  if (repl.total > 0) {
    const failRate = (repl.failed / repl.total) * 100;
    if (failRate >= 10) {
      insights.push({
        severity: failRate >= 25 ? 'critical' : 'warning', category: 'replication', clusterId: null, clusterName: null,
        title: `${failRate.toFixed(0)}% of replication runs failed in the last 3 days`,
        detail: `${repl.failed} of ${repl.total} replication tasks did not complete. Disaster-recovery copies may be out of date.`,
        recommendation: 'Check WAN connectivity and target cluster capacity on the Replication page.',
        metric: { failRate: +failRate.toFixed(1) },
      });
    }
    if ((repl.stuck || 0) > 0) {
      insights.push({
        severity: 'warning', category: 'replication', clusterId: null, clusterName: null,
        title: `${repl.stuck} replication task(s) running for over 4 hours`,
        detail: 'Long-running replication tasks may indicate bandwidth saturation or a hung task on the target.',
        recommendation: 'Inspect the long-running flows and consider QoS or scheduling changes for large jobs.',
        metric: { stuck: repl.stuck },
      });
    }
  }

  // ── 6. Governance: unprotected sources, policy gaps, version drift ─────
  const unprotectedByCluster = db.prepare(`
    SELECT cluster_id,
           SUM(COALESCE(unprotected_count, 0)) AS unprotected,
           SUM(COALESCE(protected_count, 0)) AS protected
    FROM source_registrations
    GROUP BY cluster_id
    HAVING unprotected > 0
    ORDER BY unprotected DESC
  `).all();

  for (const row of unprotectedByCluster.slice(0, 5)) {
    const name = clusterName.get(row.cluster_id) || `Cluster ${row.cluster_id}`;
    const totalObjects = row.unprotected + row.protected;
    const pctUnprotected = totalObjects > 0 ? (row.unprotected / totalObjects) * 100 : 0;
    insights.push({
      severity: pctUnprotected >= 20 || row.unprotected >= 50 ? 'warning' : 'info',
      category: 'governance', clusterId: row.cluster_id, clusterName: name,
      title: `${row.unprotected} unprotected object${row.unprotected > 1 ? 's' : ''} on ${name}`,
      detail: `${row.unprotected} of ${totalObjects} discovered objects (${pctUnprotected.toFixed(0)}%) on registered sources have no protection job. Unprotected data cannot be recovered.`,
      recommendation: 'Review the Governance page and add the unprotected objects to a protection group, or exclude them deliberately.',
      metric: { unprotected: row.unprotected, pctUnprotected: +pctUnprotected.toFixed(1) },
    });
  }

  const noOffsitePolicies = db.prepare(`
    SELECT p.name, c.name AS cluster_name, p.cluster_id
    FROM policies p
    JOIN clusters c ON p.cluster_id = c.id
    WHERE p.replication_targets = '[]' AND p.archival_targets = '[]'
  `).all();

  if (noOffsitePolicies.length > 0) {
    const sample = noOffsitePolicies.slice(0, 3).map(p => `"${p.name}" (${p.cluster_name})`).join(', ');
    insights.push({
      severity: 'warning', category: 'governance', clusterId: null, clusterName: null,
      title: `${noOffsitePolicies.length} polic${noOffsitePolicies.length > 1 ? 'ies have' : 'y has'} no off-cluster copy`,
      detail: `${sample}${noOffsitePolicies.length > 3 ? ` and ${noOffsitePolicies.length - 3} more` : ''} keep snapshots only on the local cluster — a single-site failure loses both production and backups (3-2-1 rule violation).`,
      recommendation: 'Add a replication or archival target to these policies on the Governance page.',
      metric: { count: noOffsitePolicies.length },
    });
  }

  const retentionDriftRows = db.prepare(`
    SELECT name, COUNT(DISTINCT retention_days) AS variants, COUNT(*) AS clusters
    FROM policies
    WHERE name IS NOT NULL AND retention_days IS NOT NULL
    GROUP BY name
    HAVING variants > 1
  `).all();

  if (retentionDriftRows.length > 0) {
    insights.push({
      severity: 'info', category: 'governance', clusterId: null, clusterName: null,
      title: `Retention drift on ${retentionDriftRows.length} polic${retentionDriftRows.length > 1 ? 'ies' : 'y'}`,
      detail: `Policies sharing a name (${retentionDriftRows.slice(0, 3).map(r => `"${r.name}"`).join(', ')}${retentionDriftRows.length > 3 ? ', …' : ''}) have different retention settings on different clusters, which usually indicates unintended configuration drift.`,
      recommendation: 'Compare the variants on the Governance page and align retention to your intended standard.',
      metric: { count: retentionDriftRows.length },
    });
  }

  const versionRows = db.prepare(`
    SELECT c.id AS cluster_id, c.name, m.software_version
    FROM clusters c
    LEFT JOIN metrics_history m ON m.id = (
      SELECT id FROM metrics_history
      WHERE cluster_id = c.id AND software_version IS NOT NULL
      ORDER BY captured_at DESC LIMIT 1
    )
  `).all().filter(r => r.software_version);

  if (versionRows.length > 1) {
    const counts = new Map();
    for (const r of versionRows) counts.set(r.software_version, (counts.get(r.software_version) || 0) + 1);
    if (counts.size > 1) {
      let dominant = null, dominantCount = 0;
      for (const [v, n] of counts) if (n > dominantCount) { dominant = v; dominantCount = n; }
      const outliers = versionRows.filter(r => r.software_version !== dominant);
      insights.push({
        severity: 'info', category: 'governance', clusterId: null, clusterName: null,
        title: `${outliers.length} cluster${outliers.length > 1 ? 's' : ''} not on the fleet's dominant software version`,
        detail: `${dominantCount} of ${versionRows.length} clusters run ${dominant}. Outliers: ${outliers.slice(0, 4).map(o => `${o.name} (${o.software_version})`).join(', ')}${outliers.length > 4 ? ', …' : ''}.`,
        recommendation: 'Plan upgrades to converge on a single version — mixed fleets complicate support and replication compatibility.',
        metric: { versionSpread: counts.size },
      });
    }
  }

  // ── Prioritize & respond ────────────────────────────────────────────────
  const order = { critical: 0, warning: 1, info: 2 };
  insights.sort((a, b) => (order[a.severity] ?? 3) - (order[b.severity] ?? 3));

  const summary = {
    critical: insights.filter(i => i.severity === 'critical').length,
    warning: insights.filter(i => i.severity === 'warning').length,
    info: insights.filter(i => i.severity === 'info').length,
  };

  if (insights.length === 0) {
    insights.push({
      severity: 'ok', category: 'health',
      title: 'All systems healthy',
      detail: 'No capacity, availability, protection, or replication risks detected across the monitored estate.',
      recommendation: null,
      metric: {},
    });
  }

  return { generatedAt: new Date().toISOString(), summary, insights: insights.slice(0, 30) };
}

module.exports = { computeInsights, FAILURE_STATUSES, fmtBytes };
