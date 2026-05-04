const express = require('express');
const db = require('../db/database');

const router = express.Router();

/**
 * GET /api/analytics/clusters
 * Returns clusters list for filter dropdowns.
 */
router.get('/clusters', (req, res, next) => {
  try {
    const clusters = db.prepare('SELECT id, name FROM clusters ORDER BY name').all();
    res.json(clusters);
  } catch (err) {
    next(err);
  }
});

/**
 * GET /api/analytics/protection-runs
 * Query params: clusterId (optional), days (optional, default 7, max 90)
 */
router.get('/protection-runs', (req, res, next) => {
  try {
    const clusterId = req.query.clusterId ? parseInt(req.query.clusterId, 10) : null;
    const days = Math.min(Math.max(parseInt(req.query.days, 10) || 7, 1), 90);

    const clusterFilter = clusterId ? ' AND pr.cluster_id = ?' : '';
    const baseParams = clusterId ? [days, clusterId] : [days];

    // Summary counts
    const summaryRows = db.prepare(`
      SELECT
        COUNT(*) AS total,
        SUM(CASE WHEN pr.status = 'kSuccess' THEN 1 ELSE 0 END) AS success,
        SUM(CASE WHEN pr.status IN ('kFailure', 'kFailed', 'kError', 'kCanceled', 'kCancelled') THEN 1 ELSE 0 END) AS failure,
        SUM(CASE WHEN pr.status = 'kWarning' THEN 1 ELSE 0 END) AS warning
      FROM protection_runs pr
      WHERE pr.start_time >= datetime('now', '-' || ? || ' days')
        ${clusterFilter}
    `).get(...baseParams);

    const total = summaryRows.total || 0;
    const success = summaryRows.success || 0;
    const failure = summaryRows.failure || 0;
    const warning = summaryRows.warning || 0;
    const successRate = total > 0 ? Math.round(((total - failure) / total) * 1000) / 10 : 0;

    // By day
    const byDay = db.prepare(`
      SELECT
        date(pr.start_time) AS date,
        SUM(CASE WHEN pr.status = 'kSuccess' THEN 1 ELSE 0 END) AS success,
        SUM(CASE WHEN pr.status IN ('kFailure', 'kFailed', 'kError', 'kCanceled', 'kCancelled') THEN 1 ELSE 0 END) AS failure,
        SUM(CASE WHEN pr.status = 'kWarning' THEN 1 ELSE 0 END) AS warning
      FROM protection_runs pr
      WHERE pr.start_time >= datetime('now', '-' || ? || ' days')
        ${clusterFilter}
      GROUP BY date(pr.start_time)
      ORDER BY date(pr.start_time) ASC
    `).all(...baseParams);

    // Top errors (failure reasons)
    const topErrors = db.prepare(`
      SELECT
        pr.error_code AS errorCode,
        COALESCE(
          NULLIF(TRIM(pr.error_message), ''),
          NULLIF(TRIM(pr.error_code), ''),
          pr.status,
          'Unknown failure'
        ) AS errorMessage,
        COUNT(*) AS count,
        MAX(pr.start_time) AS lastSeen,
        c.name AS clusterName
      FROM protection_runs pr
      JOIN clusters c ON pr.cluster_id = c.id
      WHERE pr.start_time >= datetime('now', '-' || ? || ' days')
        AND pr.status IN ('kFailure', 'kFailed', 'kError', 'kCanceled', 'kCancelled')
        ${clusterFilter}
      GROUP BY errorMessage
      ORDER BY count DESC
      LIMIT 20
    `).all(...baseParams);

    // By cluster
    const byCluster = db.prepare(`
      SELECT
        pr.cluster_id AS clusterId,
        c.name AS clusterName,
        COUNT(*) AS total,
        SUM(CASE WHEN pr.status IN ('kFailure', 'kFailed', 'kError', 'kCanceled', 'kCancelled') THEN 1 ELSE 0 END) AS failure,
        SUM(CASE WHEN pr.status = 'kSuccess' THEN 1 ELSE 0 END) AS successCount
      FROM protection_runs pr
      JOIN clusters c ON pr.cluster_id = c.id
      WHERE pr.start_time >= datetime('now', '-' || ? || ' days')
        ${clusterFilter}
      GROUP BY pr.cluster_id
      ORDER BY c.name ASC
    `).all(...baseParams).map(row => ({
      clusterId: row.clusterId,
      clusterName: row.clusterName,
      total: row.total,
      failure: row.failure,
      successRate: row.total > 0 ? Math.round(((row.total - row.failure) / row.total) * 1000) / 10 : 0
    }));

    // Recent runs (200 most recent)
    const runs = db.prepare(`
      SELECT
        pr.id,
        pr.job_name AS jobName,
        pr.status,
        pr.start_time AS startTime,
        pr.end_time AS endTime,
        pr.error_code AS errorCode,
        pr.error_message AS errorMessage,
        c.name AS clusterName
      FROM protection_runs pr
      JOIN clusters c ON pr.cluster_id = c.id
      WHERE pr.start_time >= datetime('now', '-' || ? || ' days')
        ${clusterFilter}
      ORDER BY pr.start_time DESC
      LIMIT 200
    `).all(...baseParams);

    // Status breakdown
    const statusBreakdownRows = db.prepare(`
      SELECT
        COUNT(*) AS total,
        SUM(CASE WHEN pr.status = 'kSuccess' THEN 1 ELSE 0 END) AS kSuccess,
        SUM(CASE WHEN pr.status IN ('kFailure', 'kFailed', 'kError', 'kCanceled', 'kCancelled') THEN 1 ELSE 0 END) AS kFailure,
        SUM(CASE WHEN pr.status = 'kWarning' THEN 1 ELSE 0 END) AS kWarning,
        SUM(CASE WHEN pr.status = 'kRunning' THEN 1 ELSE 0 END) AS kRunning,
        SUM(CASE WHEN pr.status NOT IN ('kSuccess', 'kFailure', 'kFailed', 'kError', 'kCanceled', 'kCancelled', 'kWarning', 'kRunning') THEN 1 ELSE 0 END) AS other
      FROM protection_runs pr
      WHERE pr.start_time >= datetime('now', '-' || ? || ' days')
        ${clusterFilter}
    `).get(...baseParams);

    const statusBreakdown = {
      kSuccess: statusBreakdownRows.kSuccess || 0,
      kFailure: statusBreakdownRows.kFailure || 0,
      kWarning: statusBreakdownRows.kWarning || 0,
      kRunning: statusBreakdownRows.kRunning || 0,
      other: statusBreakdownRows.other || 0
    };

    // At-risk jobs (top 50)
    const jobAggRows = db.prepare(`
      SELECT
        pr.cluster_id AS clusterId,
        c.name AS clusterName,
        pr.job_id AS jobId,
        pr.job_name AS jobName,
        COUNT(*) AS totalRuns,
        SUM(CASE WHEN pr.status IN ('kFailure', 'kFailed', 'kError', 'kCanceled', 'kCancelled') THEN 1 ELSE 0 END) AS failedRuns,
        MAX(pr.start_time) AS lastRunTime,
        MAX(CASE WHEN pr.status = 'kSuccess' THEN pr.start_time ELSE NULL END) AS lastSuccessTime
      FROM protection_runs pr
      JOIN clusters c ON pr.cluster_id = c.id
      WHERE pr.start_time >= datetime('now', '-' || ? || ' days')
        ${clusterFilter}
      GROUP BY pr.cluster_id, pr.job_id
    `).all(...baseParams);

    const atRiskJobs = jobAggRows.map(job => {
      const failureRate = job.totalRuns > 0 ? Math.round((job.failedRuns / job.totalRuns) * 1000) / 10 : 0;
      const hoursSinceLastSuccess = job.lastSuccessTime
        ? Math.max(0, Math.round((new Date() - new Date(job.lastSuccessTime)) / (1000 * 3600)))
        : null;

      // Get consecutive failures: most recent runs ordered by start_time desc until first non-failure
      const recentRuns = db.prepare(`
        SELECT pr.status
        FROM protection_runs pr
        WHERE pr.cluster_id = ? AND pr.job_id = ?
          AND pr.start_time >= datetime('now', '-' || ? || ' days')
        ORDER BY pr.start_time DESC
        LIMIT 100
      `).all(job.clusterId, job.jobId, days);

      let consecutiveFailures = 0;
      const failureStatuses = ['kFailure', 'kFailed', 'kError', 'kCanceled', 'kCancelled'];
      for (const run of recentRuns) {
        if (failureStatuses.includes(run.status)) {
          consecutiveFailures++;
        } else {
          break;
        }
      }

      // Get last status
      const lastRunRow = db.prepare(`
        SELECT pr.status
        FROM protection_runs pr
        WHERE pr.cluster_id = ? AND pr.job_id = ?
          AND pr.start_time >= datetime('now', '-' || ? || ' days')
        ORDER BY pr.start_time DESC
        LIMIT 1
      `).get(job.clusterId, job.jobId, days);

      const lastStatus = lastRunRow ? lastRunRow.status : null;

      const riskScore = job.failedRuns * 2 + consecutiveFailures * 10 + (hoursSinceLastSuccess && hoursSinceLastSuccess >= 24 ? 20 : 0);

      return {
        clusterId: job.clusterId,
        clusterName: job.clusterName,
        jobId: job.jobId,
        jobName: job.jobName,
        totalRuns: job.totalRuns,
        failedRuns: job.failedRuns,
        failureRate,
        consecutiveFailures,
        lastStatus,
        lastRunTime: job.lastRunTime,
        lastSuccessTime: job.lastSuccessTime,
        hoursSinceLastSuccess,
        riskScore
      };
    })
      .sort((a, b) => b.riskScore - a.riskScore)
      .slice(0, 50);

    // ===== PHASE 2: SLA & Streak Analysis =====
    // Calculate SLA metrics for each job
    const slaSummaryData = { totalJobs: 0, compliantJobs: 0, breachedJobs: 0, nearingBreachJobs: 0, complianceRate: 0 };
    const slaRiskJobsRaw = [];

    const allJobsForSLA = db.prepare(`
      SELECT DISTINCT
        pr.cluster_id AS clusterId,
        c.name AS clusterName,
        pr.job_id AS jobId,
        pr.job_name AS jobName
      FROM protection_runs pr
      JOIN clusters c ON pr.cluster_id = c.id
      WHERE pr.start_time >= datetime('now', '-' || ? || ' days')
        ${clusterFilter}
    `).all(...baseParams);

    for (const job of allJobsForSLA) {
      // Get run times for this job, ordered by start_time desc
      const jobRuns = db.prepare(`
        SELECT pr.start_time
        FROM protection_runs pr
        WHERE pr.cluster_id = ? AND pr.job_id = ?
          AND pr.start_time >= datetime('now', '-' || ? || ' days')
        ORDER BY pr.start_time DESC
        LIMIT 100
      `).all(job.clusterId, job.jobId, days);

      if (jobRuns.length === 0) continue;

      // Calculate expected interval from gaps between recent runs
      let expectedIntervalHours = 24;
      if (jobRuns.length >= 2) {
        const gaps = [];
        for (let i = 0; i < Math.min(jobRuns.length - 1, 10); i++) {
          const prev = new Date(jobRuns[i].start_time).getTime();
          const next = new Date(jobRuns[i + 1].start_time).getTime();
          const gapHours = (prev - next) / (1000 * 3600);
          if (gapHours > 0) gaps.push(gapHours);
        }
        if (gaps.length > 0) {
          expectedIntervalHours = Math.max(1, Math.round(gaps.reduce((a, b) => a + b, 0) / gaps.length * 10) / 10);
        }
      }

      // Hours since last run
      const lastRunTime = new Date(jobRuns[0].start_time).getTime();
      const hoursSinceLastRun = Math.max(0, Math.round((new Date().getTime() - lastRunTime) / (1000 * 3600)));

      // Determine SLA state
      let slaState = 'compliant';
      if (hoursSinceLastRun > expectedIntervalHours * 1.5) {
        slaState = 'breached';
      } else if (hoursSinceLastRun > expectedIntervalHours * 1.2) {
        slaState = 'nearing_breach';
      }

      slaSummaryData.totalJobs++;
      if (slaState === 'compliant') slaSummaryData.compliantJobs++;
      else if (slaState === 'breached') slaSummaryData.breachedJobs++;
      else slaSummaryData.nearingBreachJobs++;

      slaRiskJobsRaw.push({
        clusterId: job.clusterId,
        clusterName: job.clusterName,
        jobId: job.jobId,
        jobName: job.jobName,
        lastRunTime: jobRuns[0].start_time,
        expectedIntervalHours,
        hoursSinceLastRun,
        slaState
      });
    }

    slaSummaryData.complianceRate = slaSummaryData.totalJobs > 0
      ? Math.round((slaSummaryData.compliantJobs / slaSummaryData.totalJobs) * 1000) / 10
      : 0;

    const slaRiskJobs = slaRiskJobsRaw
      .sort((a, b) => {
        const stateOrder = { breached: 3, nearing_breach: 2, compliant: 1 };
        if (stateOrder[a.slaState] !== stateOrder[b.slaState]) {
          return stateOrder[b.slaState] - stateOrder[a.slaState];
        }
        return b.hoursSinceLastRun - a.hoursSinceLastRun;
      })
      .slice(0, 50);

    // Streak summary: count jobs with consecutive failures
    const streakSummaryData = {
      jobsWith2PlusFailures: 0,
      jobsWith3PlusFailures: 0,
      jobsWith5PlusFailures: 0,
      maxConsecutiveFailures: 0
    };

    for (const job of atRiskJobs) {
      if (job.consecutiveFailures >= 2) streakSummaryData.jobsWith2PlusFailures++;
      if (job.consecutiveFailures >= 3) streakSummaryData.jobsWith3PlusFailures++;
      if (job.consecutiveFailures >= 5) streakSummaryData.jobsWith5PlusFailures++;
      streakSummaryData.maxConsecutiveFailures = Math.max(
        streakSummaryData.maxConsecutiveFailures,
        job.consecutiveFailures
      );
    }

    // ===== PHASE 3: Runtime Anomalies, Forecast, Alert Correlation =====
    
    // Runtime anomalies: jobs with significant runtime delta
    const runtimeAnomaliesRaw = [];
    const jobsWithRuntimeData = db.prepare(`
      SELECT
        pr.cluster_id AS clusterId,
        c.name AS clusterName,
        pr.job_id AS jobId,
        pr.job_name AS jobName,
        pr.start_time,
        pr.end_time
      FROM protection_runs pr
      JOIN clusters c ON pr.cluster_id = c.id
      WHERE pr.start_time >= datetime('now', '-' || ? || ' days')
        AND pr.end_time IS NOT NULL
        AND pr.start_time IS NOT NULL
        ${clusterFilter}
    `).all(...baseParams);

    const now = new Date();
    const oneDayAgo = new Date(now.getTime() - 24 * 3600 * 1000);
    const eightDaysAgo = new Date(now.getTime() - 8 * 24 * 3600 * 1000);
    const oneDay = 24 * 3600 * 1000;

    const jobRuntimes = {};
    for (const run of jobsWithRuntimeData) {
      const key = `${run.clusterId}|${run.jobId}`;
      if (!jobRuntimes[key]) {
        jobRuntimes[key] = { clusterId: run.clusterId, clusterName: run.clusterName, jobId: run.jobId, jobName: run.jobName, last24h: [], baseline: [] };
      }
      const startTime = new Date(run.start_time).getTime();
      const endTime = new Date(run.end_time).getTime();
      const runtimeSec = Math.max(0, (endTime - startTime) / 1000);
      
      if (startTime >= oneDayAgo.getTime()) {
        jobRuntimes[key].last24h.push(runtimeSec);
      } else if (startTime >= eightDaysAgo.getTime()) {
        jobRuntimes[key].baseline.push(runtimeSec);
      }
    }

    for (const [, data] of Object.entries(jobRuntimes)) {
      if (data.last24h.length > 0 && data.baseline.length > 0) {
        const avgLast24h = data.last24h.reduce((a, b) => a + b, 0) / data.last24h.length;
        const avgBaseline = data.baseline.reduce((a, b) => a + b, 0) / data.baseline.length;
        
        if (avgBaseline > 0) {
          const deltaPct = Math.round(((avgLast24h - avgBaseline) / avgBaseline) * 1000) / 10;
          if (deltaPct >= 50) {
            runtimeAnomaliesRaw.push({
              clusterId: data.clusterId,
              clusterName: data.clusterName,
              jobId: data.jobId,
              jobName: data.jobName,
              avgRuntimeLast24hSec: Math.round(avgLast24h),
              avgRuntimeBaselineSec: Math.round(avgBaseline),
              deltaPct,
              sampleCount: data.last24h.length
            });
          }
        }
      }
    }

    const runtimeAnomalies = runtimeAnomaliesRaw
      .sort((a, b) => b.deltaPct - a.deltaPct)
      .slice(0, 30);

    // Failure forecast: linear regression on failure trend
    const failureForecastData = { trend: 'flat', slopePerDay: 0, projectedFailuresNext7d: 0, avgDailyFailures: 0 };
    if (byDay.length >= 2) {
      const dataPoints = byDay.map((d, idx) => ({ x: idx, y: d.failure || 0 }));
      const n = dataPoints.length;
      const sumX = dataPoints.reduce((s, p) => s + p.x, 0);
      const sumY = dataPoints.reduce((s, p) => s + p.y, 0);
      const sumXY = dataPoints.reduce((s, p) => s + p.x * p.y, 0);
      const sumX2 = dataPoints.reduce((s, p) => s + p.x * p.x, 0);
      
      const slope = (n * sumXY - sumX * sumY) / (n * sumX2 - sumX * sumX);
      const intercept = (sumY - slope * sumX) / n;
      
      failureForecastData.slopePerDay = Math.round(slope * 10) / 10;
      failureForecastData.avgDailyFailures = Math.round(sumY / n);
      
      if (Math.abs(slope) < 0.5) {
        failureForecastData.trend = 'flat';
      } else if (slope > 0) {
        failureForecastData.trend = 'up';
      } else {
        failureForecastData.trend = 'down';
      }
      
      // Project next 7 days
      let projectedTotal = 0;
      for (let i = 1; i <= 7; i++) {
        projectedTotal += Math.max(0, slope * (n - 1 + i) + intercept);
      }
      failureForecastData.projectedFailuresNext7d = Math.round(projectedTotal);
    }

    // Alert correlation: find failed runs within 2h of alerts on same cluster
    const alertCorrelationData = {
      correlatedFailedRuns: 0,
      totalFailedRuns: 0,
      correlationRate: 0,
      topAlertTypes: []
    };

    const failedRunsInRange = db.prepare(`
      SELECT
        pr.cluster_id AS clusterId,
        pr.start_time,
        a.alert_type AS alertType,
        a.last_updated
      FROM protection_runs pr
      LEFT JOIN alerts a ON pr.cluster_id = a.cluster_id
        AND a.last_updated >= datetime(pr.start_time, '-2 hours')
        AND a.last_updated <= datetime(pr.start_time, '+2 hours')
      WHERE pr.start_time >= datetime('now', '-' || ? || ' days')
        AND pr.status IN ('kFailure', 'kFailed', 'kError', 'kCanceled', 'kCancelled')
        ${clusterFilter}
    `).all(...baseParams);

    const failedRunsSet = new Set();
    const correlatedSet = new Set();
    const alertTypeMap = {};

    for (const row of failedRunsInRange) {
      const runKey = `${row.clusterId}|${row.start_time}`;
      failedRunsSet.add(runKey);

      if (row.alertType) {
        correlatedSet.add(runKey);
        alertTypeMap[row.alertType] = (alertTypeMap[row.alertType] || 0) + 1;
      }
    }

    alertCorrelationData.totalFailedRuns = failedRunsSet.size;
    alertCorrelationData.correlatedFailedRuns = correlatedSet.size;
    alertCorrelationData.correlationRate = alertCorrelationData.totalFailedRuns > 0
      ? Math.round((alertCorrelationData.correlatedFailedRuns / alertCorrelationData.totalFailedRuns) * 1000) / 10
      : 0;

    alertCorrelationData.topAlertTypes = Object.entries(alertTypeMap)
      .map(([alertType, count]) => ({ alertType, count }))
      .sort((a, b) => b.count - a.count)
      .slice(0, 10);

    res.json({
      summary: { total, success, failure, warning, successRate },
      byDay,
      topErrors,
      byCluster,
      statusBreakdown,
      atRiskJobs,
      runs,
      slaSummary: slaSummaryData,
      slaRiskJobs,
      streakSummary: streakSummaryData,
      runtimeAnomalies,
      failureForecast: failureForecastData,
      alertCorrelation: alertCorrelationData
    });
  } catch (err) {
    next(err);
  }
});

/**
 * GET /api/analytics/replication
 * Query params: clusterId (optional), days (optional, default 7, max 90)
 */
router.get('/replication', (req, res, next) => {
  try {
    const clusterId = req.query.clusterId ? parseInt(req.query.clusterId, 10) : null;
    const days = Math.min(Math.max(parseInt(req.query.days, 10) || 7, 1), 90);

    const clusterFilter = clusterId ? ' AND rr.cluster_id = ?' : '';
    const baseParams = clusterId ? [days, clusterId] : [days];

    // Summary
    const summaryRow = db.prepare(`
      SELECT
        COUNT(*) AS total,
        SUM(CASE WHEN rr.status IN ('kSuccess', 'kAccepted', 'kRunning') THEN 1 ELSE 0 END) AS success,
        SUM(CASE WHEN rr.status IN ('kFailed', 'kFailure', 'kCanceled', 'kCancelled', 'kError') THEN 1 ELSE 0 END) AS failure,
        SUM(COALESCE(rr.logical_bytes, 0)) AS totalBytesTransferred
      FROM replication_runs rr
      WHERE rr.start_time >= datetime('now', '-' || ? || ' days')
        ${clusterFilter}
    `).get(...baseParams);

    const total = summaryRow.total || 0;
    const success = summaryRow.success || 0;
    const failure = summaryRow.failure || 0;
    const successRate = total > 0 ? Math.round(((total - failure) / total) * 1000) / 10 : 0;
    const totalBytesTransferred = summaryRow.totalBytesTransferred || 0;

    // Replication flows: source cluster -> target cluster
    const flows = db.prepare(`
      SELECT
        rr.cluster_id AS sourceClusterId,
        c.name AS sourceClusterName,
        rr.target_cluster_name AS targetClusterName,
        rr.target_cluster_id AS targetClusterId,
        COUNT(*) AS runCount,
        SUM(CASE WHEN rr.status IN ('kSuccess', 'kAccepted', 'kRunning') THEN 1 ELSE 0 END) AS successCount,
        SUM(CASE WHEN rr.status IN ('kFailed', 'kFailure', 'kCanceled', 'kCancelled', 'kError') THEN 1 ELSE 0 END) AS failureCount,
        SUM(COALESCE(rr.logical_bytes, 0)) AS totalBytesTransferred,
        AVG(rr.lag_seconds) AS avgLagSeconds,
        MAX(rr.start_time) AS lastSeen,
        SUM(CASE WHEN rr.status IN ('kAccepted','kRunning') AND rr.start_time <= datetime('now', '-2 hours') THEN 1 ELSE 0 END) AS longRunningCount,
        MAX(CASE WHEN rr.status IN ('kAccepted','kRunning') AND rr.start_time <= datetime('now', '-2 hours') THEN CAST((julianday('now') - julianday(rr.start_time)) * 86400 AS INTEGER) ELSE NULL END) AS oldestLongRunningSeconds
      FROM replication_runs rr
      JOIN clusters c ON rr.cluster_id = c.id
      WHERE rr.start_time >= datetime('now', '-' || ? || ' days')
        ${clusterFilter}
      GROUP BY rr.cluster_id, rr.target_cluster_id, rr.target_cluster_name
      ORDER BY totalBytesTransferred DESC
    `).all(...baseParams).map(row => ({
      sourceClusterId: row.sourceClusterId,
      sourceClusterName: row.sourceClusterName,
      targetClusterName: row.targetClusterName,
      targetClusterId: row.targetClusterId,
      runCount: row.runCount,
      successCount: row.successCount,
      failureCount: row.failureCount,
      totalBytesTransferred: row.totalBytesTransferred,
      avgLagSeconds: row.avgLagSeconds != null ? Math.round(row.avgLagSeconds) : null,
      lastSeen: row.lastSeen,
      longRunningCount: row.longRunningCount || 0,
      oldestLongRunningSeconds: row.oldestLongRunningSeconds != null ? Math.round(row.oldestLongRunningSeconds) : null
    }));

    // By cluster (outbound summary)
    const byCluster = db.prepare(`
      SELECT
        rr.cluster_id AS clusterId,
        c.name AS clusterName,
        COUNT(DISTINCT rr.target_cluster_id) AS outboundFlows,
        SUM(COALESCE(rr.logical_bytes, 0)) AS totalBytes
      FROM replication_runs rr
      JOIN clusters c ON rr.cluster_id = c.id
      WHERE rr.start_time >= datetime('now', '-' || ? || ' days')
        ${clusterFilter}
      GROUP BY rr.cluster_id
      ORDER BY c.name ASC
    `).all(...baseParams);

    res.json({
      summary: { total, success, failure, successRate, totalBytesTransferred },
      flows,
      byCluster
    });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
