// Rubrik AI Advisor: backup-compliance/alert-triage/replication-archival/
// capacity-runway reports. Pack-only build (no built-in Rubrik platform to
// port from) - a FACTORY, createRubrikAdvisor(coreApi), built lazily by
// routes.js once coreApi is known (dell/nutanix pack pattern). Per the
// plugin contract, coreApi.advisor is the host's services/platformAdvisor
// module (createPlatformAdvisor/linReg/parseUtcMs), never required
// directly, and coreApi.db is the same sqlite connection the host uses.
function createRubrikAdvisor(coreApi) {
  const db = coreApi.db;
  const { createPlatformAdvisor, linReg } = coreApi.advisor;

  function clusterNameMap() {
    const rows = db.prepare('SELECT id, name FROM rubrik_clusters').all();
    return new Map(rows.map((r) => [r.id, r.name]));
  }

  function gatherBackupCompliance() {
    const clusters = db.prepare('SELECT id, name FROM rubrik_clusters ORDER BY id').all();
    const nameOf = clusterNameMap();

    const bySlaDomain = db.prepare(`
      SELECT sla_domain,
             SUM(CASE WHEN compliant = 1 THEN 1 ELSE 0 END) AS compliantCount,
             SUM(CASE WHEN compliant = 0 THEN 1 ELSE 0 END) AS nonCompliantCount
      FROM rubrik_protected_objects
      GROUP BY sla_domain ORDER BY nonCompliantCount DESC
    `).all();

    const byCluster = db.prepare(`
      SELECT cluster_id,
             SUM(CASE WHEN compliant = 1 THEN 1 ELSE 0 END) AS compliantCount,
             SUM(CASE WHEN compliant = 0 THEN 1 ELSE 0 END) AS nonCompliantCount
      FROM rubrik_protected_objects
      GROUP BY cluster_id
    `).all().map((r) => ({
      cluster: nameOf.get(r.cluster_id) || `cluster ${r.cluster_id}`,
      compliantCount: r.compliantCount,
      nonCompliantCount: r.nonCompliantCount,
    }));

    const topNonCompliant = db.prepare(`
      SELECT name, type, sla_domain, cluster_id, last_backup_at
      FROM rubrik_protected_objects WHERE compliant = 0
      ORDER BY last_backup_at ASC LIMIT 30
    `).all().map((r) => ({
      object: r.name,
      type: r.type,
      slaDomain: r.sla_domain,
      cluster: nameOf.get(r.cluster_id) || `cluster ${r.cluster_id}`,
      lastBackupAt: r.last_backup_at,
    }));

    const protectionRuns7d = db.prepare(`
      SELECT run_type, status, COUNT(*) AS n
      FROM rubrik_protection_runs WHERE day >= date('now', '-7 days')
      GROUP BY run_type, status ORDER BY run_type, status
    `).all();

    const chronicFailing = db.prepare(`
      SELECT object_name, cluster, COUNT(*) AS failedCount
      FROM rubrik_protection_runs
      WHERE run_type = 'Backup' AND status = 'Failed' AND day >= date('now', '-7 days')
      GROUP BY object_name, cluster HAVING failedCount >= 2
      ORDER BY failedCount DESC LIMIT 30
    `).all().map((r) => ({ object: r.object_name, cluster: r.cluster, failedRuns7d: r.failedCount }));

    const slaDomainsWithTargets = db.prepare(`
      SELECT name, retention, archival_location, replication_target
      FROM rubrik_sla_domains
      WHERE archival_location IS NOT NULL OR replication_target IS NOT NULL
      ORDER BY name
    `).all();

    return {
      generatedAt: new Date().toISOString(),
      complianceBySlaDomain: bySlaDomain,
      complianceByCluster: byCluster,
      topNonCompliantObjects: topNonCompliant,
      protectionRunsLast7dByTypeAndStatus: protectionRuns7d,
      chronicallyFailingObjects: chronicFailing,
      slaDomainsWithArchivalOrReplicationTargets: slaDomainsWithTargets,
      note: clusters.length === 0 ? 'No Rubrik clusters registered.' : undefined,
    };
  }

  function gatherAlertTriage() {
    const openAlertsBySeverityAndType = db.prepare(`
      SELECT severity, alert_type, COUNT(*) AS n
      FROM rubrik_alerts WHERE resolved = 0 AND dismissed = 0
      GROUP BY severity, alert_type ORDER BY n DESC
    `).all();

    const topOpenAlerts = db.prepare(`
      SELECT description, object_name, cluster, first_seen,
             CAST((julianday('now') - julianday(first_seen)) * 24 AS INTEGER) AS ageHours
      FROM rubrik_alerts WHERE resolved = 0 AND dismissed = 0
      ORDER BY first_seen ASC LIMIT 20
    `).all();

    const openAnomalyEvents = db.prepare(`
      SELECT cluster, object_name, object_type, anomaly_probability, encryption_detected,
             file_changes, status, snapshot_quarantined, detected_at
      FROM rubrik_anomaly_events WHERE status != 'Resolved'
      ORDER BY anomaly_probability DESC LIMIT 30
    `).all().map((r) => ({
      cluster: r.cluster,
      object: r.object_name,
      objectType: r.object_type,
      probability: r.anomaly_probability,
      encryptionDetected: !!r.encryption_detected,
      fileChanges: r.file_changes,
      status: r.status,
      quarantined: !!r.snapshot_quarantined,
      detectedAt: r.detected_at,
    }));

    const huntsTotal = db.prepare('SELECT COUNT(*) AS n FROM rubrik_threat_hunts').get().n;
    let threatHunts = { note: 'No threat hunts recorded.' };
    if (huntsTotal > 0) {
      const byStatus = db.prepare('SELECT status, COUNT(*) AS n FROM rubrik_threat_hunts GROUP BY status').all();
      const totalMatchesFound = db.prepare('SELECT COALESCE(SUM(matches_found), 0) AS n FROM rubrik_threat_hunts').get().n;
      threatHunts = { total: huntsTotal, byStatus, totalMatchesFound };
    }

    return {
      generatedAt: new Date().toISOString(),
      openAlertsBySeverityAndType: openAlertsBySeverityAndType,
      topOpenAlerts,
      openAnomalyEvents,
      threatHunts,
      note: openAlertsBySeverityAndType.length === 0 && openAnomalyEvents.length === 0
        ? 'No open alerts or unresolved anomaly events.' : undefined,
    };
  }

  function gatherReplicationArchival() {
    const replicationPairs = db.prepare(`
      SELECT source_cluster, target_cluster, status, lag_seconds, last_sync_at
      FROM rubrik_replication_pairs ORDER BY status DESC
    `).all().map((r) => ({
      sourceCluster: r.source_cluster,
      targetCluster: r.target_cluster,
      status: r.status,
      lagMinutes: Math.round(r.lag_seconds / 60),
      lastSyncAt: r.last_sync_at,
    }));

    // rubrik_replication_runs.start_ms_offset is "milliseconds ago" (age),
    // not an absolute timestamp - a run started within the last 7 days has
    // start_ms_offset <= 7 days in ms (same math as routes.js /analytics/replication).
    const replicationRunsLast7dByStatus = db.prepare(`
      SELECT status, COUNT(*) AS n, COALESCE(SUM(transferred_bytes), 0) AS transferredBytes
      FROM rubrik_replication_runs WHERE start_ms_offset <= 604800000
      GROUP BY status
    `).all();

    const archivalLocations = db.prepare(`
      SELECT name, type, status, archived_bytes, object_count FROM rubrik_archival_locations ORDER BY name
    `).all();

    const slaDomainsWithReplicationTarget = db.prepare(`
      SELECT name, replication_target FROM rubrik_sla_domains WHERE replication_target IS NOT NULL
    `).all();
    const healthySourcePairs = new Set(
      db.prepare("SELECT DISTINCT source_cluster FROM rubrik_replication_pairs WHERE LOWER(status) = 'healthy'").all()
        .map((r) => r.source_cluster)
    );
    const clustersBySla = db.prepare(`
      SELECT DISTINCT o.sla_domain, c.name AS cluster_name
      FROM rubrik_protected_objects o JOIN rubrik_clusters c ON c.id = o.cluster_id
    `).all();
    const clusterMapBySla = new Map();
    for (const r of clustersBySla) {
      if (!clusterMapBySla.has(r.sla_domain)) clusterMapBySla.set(r.sla_domain, []);
      clusterMapBySla.get(r.sla_domain).push(r.cluster_name);
    }
    const slaDomainsAtReplicationRisk = [];
    for (const sla of slaDomainsWithReplicationTarget) {
      const clustersUsing = clusterMapBySla.get(sla.name) || [];
      const withoutHealthyPair = clustersUsing.filter((c) => !healthySourcePairs.has(c));
      if (withoutHealthyPair.length > 0) {
        slaDomainsAtReplicationRisk.push({
          slaDomain: sla.name,
          replicationTarget: sla.replication_target,
          clustersWithoutHealthyPair: withoutHealthyPair,
        });
      }
    }

    return {
      generatedAt: new Date().toISOString(),
      replicationPairs,
      replicationRunsLast7dByStatus,
      archivalLocations,
      slaDomainsAtReplicationRisk,
      note: replicationPairs.length === 0 && archivalLocations.length === 0
        ? 'No replication pairs or archival locations configured.' : undefined,
    };
  }

  function gatherCapacityRunway() {
    const clusters = db.prepare('SELECT id, name, used_bytes, capacity_bytes FROM rubrik_clusters ORDER BY id').all();

    const historyRows = db.prepare(`
      SELECT cluster, day, used_bytes FROM rubrik_capacity_history
      WHERE day >= date('now', '-90 days') ORDER BY cluster, day ASC
    `).all();
    const historyByCluster = new Map();
    for (const r of historyRows) {
      if (!historyByCluster.has(r.cluster)) historyByCluster.set(r.cluster, []);
      historyByCluster.get(r.cluster).push(r);
    }

    const clusterRunway = clusters.map((c) => {
      const usedPct = c.capacity_bytes > 0 ? Math.round((c.used_bytes / c.capacity_bytes) * 1000) / 10 : 0;
      const series = historyByCluster.get(c.name) || [];
      const pts = series.map((r) => ({ x: new Date(`${r.day}T00:00:00Z`).getTime(), y: r.used_bytes }));
      const reg = linReg(pts);
      let daysToFull = null;
      if (reg && reg.slope > 0 && c.capacity_bytes > c.used_bytes) {
        daysToFull = Math.round((c.capacity_bytes - c.used_bytes) / reg.slope);
      }
      return {
        cluster: c.name,
        usedBytes: c.used_bytes,
        capacityBytes: c.capacity_bytes,
        usedPct,
        slopeBytesPerDay: reg ? Math.round(reg.slope) : null,
        daysToFull,
        historyDataPoints: series.length,
      };
    });

    const topObjectsByLocalStorage = db.prepare(`
      SELECT o.name, o.type, o.local_storage_bytes, c.name AS cluster_name
      FROM rubrik_protected_objects o JOIN rubrik_clusters c ON c.id = o.cluster_id
      WHERE o.local_storage_bytes IS NOT NULL
      ORDER BY o.local_storage_bytes DESC LIMIT 20
    `).all().map((r) => ({ object: r.name, type: r.type, cluster: r.cluster_name, localStorageBytes: r.local_storage_bytes }));

    const licensing = db.prepare('SELECT key, label, consumed_bytes, entitled_tb, basis FROM rubrik_licensing').all();

    return {
      generatedAt: new Date().toISOString(),
      clusterCapacityRunway: clusterRunway,
      topObjectsByLocalStorage,
      licensing: licensing.length ? licensing : undefined,
      note: clusters.length === 0
        ? 'No Rubrik clusters registered.'
        : (licensing.length === 0 ? 'No licensing rows recorded.' : undefined),
    };
  }

  return createPlatformAdvisor({
    platform: 'rubrik',
    feature: 'Rubrik AI Advisor',
    table: 'rubrik_ai_reports',
    reports: {
      backup_compliance: {
        system:
          'You are a Rubrik data protection engineer reviewing SLA-domain and cluster compliance. You are given ' +
          'compliance counts by SLA domain and by cluster, the most overdue non-compliant objects, protection-run ' +
          'totals for the last 7 days by run type and status, objects with 2 or more failed Backup runs in the last ' +
          '7 days (chronic failures), and SLA domains with an archival or replication target configured. Identify ' +
          'which SLA domains or clusters are at the greatest compliance risk and which objects need the soonest ' +
          'attention. Do not invent data. Markdown sections: **Summary**, **Findings (severity-ordered)**, ' +
          '**Recommended actions**, **Data gaps**. Keep under ~400 words.',
        gather: gatherBackupCompliance,
        noun: 'backup compliance report',
      },
      alert_triage: {
        system:
          'You are a security operations lead triaging Rubrik alerts and Radar ransomware-detection signals. You are ' +
          'given open (unresolved, undismissed) alert totals by severity and alert type, the oldest 20 open alert ' +
          'descriptions with object and age, anomaly events not yet resolved (with encryption/file-change signal and ' +
          'quarantine state), and a threat-hunt summary if any hunts have run. Separate signal from noise and give a ' +
          'prioritized triage order, calling out anything that looks like active ransomware behavior first. Do not ' +
          'invent data. Markdown sections: **Summary**, **Findings (severity-ordered)**, **Recommended actions**, ' +
          '**Data gaps**. Keep under ~400 words.',
        gather: gatherAlertTriage,
        noun: 'alert triage report',
      },
      replication_archival: {
        system:
          'You are a Rubrik disaster-recovery engineer reviewing replication and archival posture. You are given ' +
          'replication pairs (source, target, status, lag in minutes), replication runs from the last 7 days grouped ' +
          'by status, archival locations with status and archived-byte totals, and SLA domains that declare a ' +
          'replication target but whose clusters have no healthy replication pair. Identify DR exposure - lagging or ' +
          'failed pairs, SLA domains without a working replication path - and what to fix first. Do not invent data. ' +
          'Markdown sections: **Summary**, **Findings (severity-ordered)**, **Recommended actions**, **Data gaps**. ' +
          'Keep under ~400 words.',
        gather: gatherReplicationArchival,
        noun: 'replication and archival report',
      },
      capacity_runway: {
        system:
          'You are a Rubrik capacity planner. You are given, per cluster, current used/capacity percentage plus a ' +
          '90-day capacity-history growth slope (bytes/day) and a projected days-to-full (null when usage is flat or ' +
          'shrinking), the top 20 protected objects by local storage consumption, and any licensing/entitlement rows. ' +
          'Identify which clusters are closest to running out of capacity and what is driving growth. Do not invent ' +
          'data. Markdown sections: **Summary**, **Findings (severity-ordered)**, **Recommended actions**, ' +
          '**Data gaps**. Keep under ~400 words.',
        gather: gatherCapacityRunway,
        noun: 'capacity runway report',
      },
    },
  });
}

module.exports = { createRubrikAdvisor };
