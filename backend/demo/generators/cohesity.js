// Cohesity scope demo data: clusters, metrics, alerts, protection/replication
// runs, policies, source registrations, licensing tables, replication cache.
const { randInt, randFloat, pick, chance, rngFor } = require('./core');

const SITES = ['nyc', 'lon', 'fra', 'sgp', 'syd', 'chi', 'dal', 'tor'];
const DR_SITES = ['nyc', 'lon', 'fra', 'sgp', 'syd'];
const DEV_SITES = ['chi', 'dal', 'tor'];
// Which prd site's clusters replicate to which dr site's cluster.
const DR_PAIR = { nyc: 'lon', lon: 'nyc', fra: 'sgp', sgp: 'fra', syd: 'syd' };

const SOFTWARE_VERSIONS = ['7.1.2_release', '7.0.1_release', '6.8.1_release'];
const JOB_TYPES = ['VM_Prod_Backup', 'SQL_Daily', 'NAS_Archive', 'Exchange_DB', 'Oracle_Weekly'];
const ALERT_TYPES = ['kNodeHealth', 'kDiskFailure', 'kClusterCapacity', 'kJobFailure', 'kCertExpiry', 'kThrottling'];
const SOURCE_TYPES = ['kVMware', 'kPhysical', 'kSQL', 'kView'];
const ERROR_MESSAGES = ['Snapshot quiesce timeout', 'Target unreachable'];

function buildClusterList() {
  const clusters = [];
  for (const site of SITES) {
    clusters.push({ name: `${site}-coh-prd-01`, site, env: 'prd' });
    clusters.push({ name: `${site}-coh-prd-02`, site, env: 'prd' });
  }
  for (const site of DR_SITES) {
    clusters.push({ name: `${site}-coh-dr-01`, site, env: 'dr' });
  }
  for (const site of DEV_SITES) {
    clusters.push({ name: `${site}-coh-dev-01`, site, env: 'dev' });
  }
  return clusters;
}

function drTargetFor(cluster) {
  if (cluster.env !== 'prd') return null;
  const targetSite = DR_PAIR[cluster.site];
  if (!targetSite) return null;
  return `${targetSite}-coh-dr-01`;
}

function severityPick(rng) {
  const r = rng();
  if (r < 0.4) return 'info';
  if (r < 0.7) return 'warning';
  return 'critical';
}

function seedCohesity(db, { now, encrypt }) {
  const clusterDefs = buildClusterList();

  const insertCluster = db.prepare(`
    INSERT INTO clusters (name, connection_type, vip, auth_type, encrypted_credentials, polling_interval_minutes, ssl_verify, tags, created_at, updated_at)
    VALUES (?, 'direct', ?, 'apikey', ?, 15, 0, ?, ?, ?)
  `);
  const insertMetric = db.prepare(`
    INSERT INTO metrics_history (cluster_id, captured_at, total_capacity_bytes, used_bytes, logical_bytes, data_reduction_ratio, software_version, node_count)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const insertAlert = db.prepare(`
    INSERT INTO alerts (cluster_id, cohesity_alert_id, severity, alert_type, description, resolved, dismissed, first_seen, last_updated)
    VALUES (?, ?, ?, ?, ?, ?, 0, ?, ?)
  `);
  const insertProtRun = db.prepare(`
    INSERT INTO protection_runs (cluster_id, job_id, job_name, run_type, status, start_time, end_time, error_code, error_message, logical_bytes, captured_at)
    VALUES (?, ?, ?, 'kRegular', ?, ?, ?, ?, ?, ?, ?)
  `);
  const insertReplRun = db.prepare(`
    INSERT INTO replication_runs (protection_run_id, cluster_id, target_cluster_name, target_cluster_id, status, logical_bytes, start_time, end_time, lag_seconds, captured_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const insertPolicy = db.prepare(`
    INSERT INTO policies (cluster_id, policy_id, name, retention_days, replication_targets, archival_targets, datalock, captured_at)
    VALUES (?, ?, ?, ?, ?, '[]', ?, ?)
  `);
  const insertSource = db.prepare(`
    INSERT INTO source_registrations (cluster_id, source_id, source_name, environment, protected_count, unprotected_count, protected_bytes, unprotected_bytes, captured_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const insertLicenseUsage = db.prepare(`
    INSERT INTO license_usage (system_id, system_name, front_end_bytes, physical_bytes, capacity_bytes, usage_percent, data_reduction, captured_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const insertMeterUsage = db.prepare(`
    INSERT INTO license_meter_usage (system_id, system_name, feature, usage_gib, captured_at)
    VALUES (?, ?, ?, ?, ?)
  `);
  const insertViewDetail = db.prepare(`
    INSERT INTO license_view_detail (system_id, system_name, view_name, is_read_only, created_ms, physical_bytes, logical_bytes, data_written_bytes, captured_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const insertConsumption = db.prepare(`
    INSERT INTO consumption_breakdown (system_id, system_name, category, consumers, physical_bytes, logical_bytes, captured_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `);
  const insertReplCache = db.prepare(`
    INSERT INTO replication_status_cache (cache_key, cluster_name, status_filter, days, num_runs_per_group, payload_json, scanning, error, updated_at)
    VALUES (?, ?, 'all', 7, 20, ?, 0, NULL, ?)
  `);

  const clusters = [];
  const nowIso = new Date(now).toISOString();

  clusterDefs.forEach((def, idx) => {
    const rng = rngFor(def.name);
    const credentials = encrypt(JSON.stringify({ apiKey: 'demo-not-real' }));
    const vip = `10.${10 + (idx % 20)}.${randInt(rng, 1, 254)}.${randInt(rng, 1, 254)}`;
    const tags = `${def.env},${def.site}`;
    insertCluster.run(def.name, vip, credentials, tags, nowIso, nowIso);
    const clusterId = db.prepare('SELECT id FROM clusters WHERE name = ?').get(def.name).id;
    clusters.push({ ...def, id: clusterId, rng, drTarget: drTargetFor(def) });
  });

  const clusterByName = new Map(clusters.map((c) => [c.name, c]));

  // ── Metrics history: 30 days @ 2h cadence ──────────────────────────────
  let metricsCount = 0;
  const insightsClusterName = clusters[0].name;
  for (const cluster of clusters) {
    const rng = cluster.rng;
    const capacityBytes = Math.round(randFloat(rng, 0.4, 2.0, 3) * 1e15);
    const isInsightsCluster = cluster.name === insightsClusterName;
    const startPct = isInsightsCluster ? 80 : randFloat(rng, 45, 70, 1);
    const growthRange = isInsightsCluster ? 6 : randFloat(rng, 3, 15, 1);
    const softwareVersion = idx_softwareVersion(cluster, rng);
    const nodeCount = randInt(rng, 4, 16);
    const reduction = randFloat(rng, 2.2, 4.8, 2);

    for (let i = 0; i < 360; i++) {
      const capturedAt = new Date(now - i * 120 * 60000).toISOString();
      const progress = (359 - i) / 359;
      const usedPct = Math.min(96, startPct + progress * growthRange + randFloat(rng, -1, 1, 2));
      const usedBytes = Math.round(capacityBytes * (usedPct / 100));
      const logicalBytes = Math.round(usedBytes * reduction);
      insertMetric.run(cluster.id, capturedAt, capacityBytes, usedBytes, logicalBytes, reduction, softwareVersion, nodeCount);
      metricsCount++;
    }
  }

  function idx_softwareVersion(cluster, rng) {
    if (chance(rng, 0.15)) return pick(rng, SOFTWARE_VERSIONS.slice(1));
    return SOFTWARE_VERSIONS[0];
  }

  // ── Alerts: ~4 per cluster ──────────────────────────────────────────────
  let alertsCount = 0;
  for (const cluster of clusters) {
    const rng = cluster.rng;
    const count = randInt(rng, 3, 5);
    for (let i = 0; i < count; i++) {
      const severity = severityPick(rng);
      const alertType = pick(rng, ALERT_TYPES);
      const ageHours = randInt(rng, 1, 24 * 14);
      const firstSeen = new Date(now - ageHours * 3600000).toISOString();
      const lastUpdated = new Date(now - randInt(rng, 0, ageHours) * 3600000).toISOString();
      const resolved = chance(rng, 0.3) ? 1 : 0;
      insertAlert.run(
        cluster.id,
        `demo-${cluster.id}-${i}`,
        severity,
        alertType,
        `${alertType} on ${cluster.name}`,
        resolved,
        firstSeen,
        lastUpdated
      );
      alertsCount++;
    }
  }

  // ── Protection runs: 14 days, 6-10 jobs/cluster, 4 runs/day/job ─────────
  let protRunCount = 0;
  const protRunsByCluster = new Map();
  for (const cluster of clusters) {
    const rng = cluster.rng;
    const jobCount = randInt(rng, 6, 10);
    const rows = [];
    for (let jobIdx = 1; jobIdx <= jobCount; jobIdx++) {
      const jobName = `${pick(rng, JOB_TYPES)}_${jobIdx}`;
      for (let day = 0; day < 14; day++) {
        for (let run = 0; run < 4; run++) {
          const isLatest = day === 0 && run === 3;
          const startTime = new Date(now - (day * 24 + run * 6) * 3600000);
          const roll = rng();
          let status = 'kSuccess';
          let errorCode = null;
          let errorMessage = null;
          if (isLatest && chance(rng, 0.15)) {
            status = 'kRunning';
          } else if (roll > 0.93) {
            status = chance(rng, 0.5) ? 'kFailure' : 'kWarning';
            errorCode = status === 'kFailure' ? 'kTimeout' : 'kPartial';
            errorMessage = pick(rng, ERROR_MESSAGES);
          }
          const durationMin = randInt(rng, 15, 180);
          const endTime = status === 'kRunning' ? null : new Date(startTime.getTime() + durationMin * 60000);
          const logicalBytes = Math.round(randFloat(rng, 1, 500, 2) * 1e9);

          const info = insertProtRun.run(
            cluster.id,
            jobIdx,
            jobName,
            status,
            startTime.toISOString(),
            endTime ? endTime.toISOString() : null,
            errorCode,
            errorMessage,
            logicalBytes,
            startTime.toISOString()
          );
          protRunCount++;
          rows.push({
            id: info.lastInsertRowid,
            jobName,
            status,
            startTime,
            logicalBytes,
          });
        }
      }
    }
    protRunsByCluster.set(cluster.name, rows);
  }

  // ── Replication runs: prd clusters w/ dr target, from successful runs ──
  let replRunCount = 0;
  const replicationsByCluster = new Map();
  for (const cluster of clusters) {
    if (!cluster.drTarget) continue;
    const rng = cluster.rng;
    const targetCluster = clusterByName.get(cluster.drTarget);
    const runs = protRunsByCluster.get(cluster.name) || [];
    const replList = [];
    for (const run of runs) {
      if (run.status !== 'kSuccess') continue;
      if (!chance(rng, 0.7)) continue;
      const status = chance(rng, 0.95) ? 'kSuccess' : (chance(rng, 0.5) ? 'kFailure' : 'kRunning');
      const lagSeconds = randInt(rng, 120, 3600);
      const startTime = run.startTime;
      const endTime = status === 'kRunning' ? null : new Date(startTime.getTime() + lagSeconds * 1000);
      insertReplRun.run(
        run.id,
        cluster.id,
        cluster.drTarget,
        targetCluster ? targetCluster.id : null,
        status,
        run.logicalBytes,
        startTime.toISOString(),
        endTime ? endTime.toISOString() : null,
        lagSeconds,
        startTime.toISOString()
      );
      replRunCount++;
      replList.push({
        jobName: run.jobName,
        protectionGroupId: run.id,
        runId: run.id,
        runStartTimeUsecs: startTime.getTime() * 1000,
        localBackupStatus: 'kSuccess',
        targetCluster: cluster.drTarget,
        status: status === 'kSuccess' ? 'Succeeded' : (status === 'kRunning' ? 'Running' : 'Failed'),
        replicationStartTimeUsecs: startTime.getTime() * 1000,
        logicalSizeBytes: run.logicalBytes,
        logicalBytesTransferred: status === 'kFailure' ? Math.round(run.logicalBytes * 0.4) : run.logicalBytes,
        physicalBytesTransferred: Math.round(run.logicalBytes * 0.3),
        percentComplete: status === 'kSuccess' ? 100 : (status === 'kFailure' ? randInt(rng, 10, 80) : randInt(rng, 10, 90)),
      });
    }
    replicationsByCluster.set(cluster.name, replList);
  }

  // ── Policies: 4-8/cluster ────────────────────────────────────────────────
  let policyCount = 0;
  const TIERS = [
    { name: 'Gold-15min', retention: 30 },
    { name: 'Silver-1h', retention: 90 },
    { name: 'Bronze-24h', retention: 365 },
  ];
  for (const cluster of clusters) {
    const rng = cluster.rng;
    const count = randInt(rng, 4, 8);
    for (let i = 0; i < count; i++) {
      const tier = TIERS[i % TIERS.length];
      const name = i < TIERS.length ? tier.name : `${tier.name}-${Math.floor(i / TIERS.length) + 1}`;
      const hasTarget = !!cluster.drTarget && !chance(rng, 0.2);
      const replicationTargets = hasTarget
        ? JSON.stringify([{ clusterName: cluster.drTarget }])
        : '[]';
      const datalock = chance(rng, 0.2) ? 1 : 0;
      insertPolicy.run(cluster.id, `policy-${cluster.id}-${i}`, name, tier.retention, replicationTargets, datalock, nowIso);
      policyCount++;
    }
  }

  // ── Source registrations: 3-6/cluster ───────────────────────────────────
  let sourceCount = 0;
  for (const cluster of clusters) {
    const rng = cluster.rng;
    const count = randInt(rng, 3, 6);
    for (let i = 0; i < count; i++) {
      const env = pick(rng, SOURCE_TYPES);
      const protectedCount = randInt(rng, 20, 200);
      const unprotectedCount = randInt(rng, 0, 15);
      const protectedBytes = Math.round(randFloat(rng, 10, 800, 2) * 1e9);
      const unprotectedBytes = Math.round(randFloat(rng, 0, 50, 2) * 1e9);
      insertSource.run(
        cluster.id,
        1000 + cluster.id * 10 + i,
        `${cluster.name}-source-${i}`,
        env,
        protectedCount,
        unprotectedCount,
        protectedBytes,
        unprotectedBytes,
        nowIso
      );
      sourceCount++;
    }
  }

  // ── Licensing tables ────────────────────────────────────────────────────
  const ENTITLED = { dataProtect: 2500, replica: 1200, smartFiles: 400 }; // TiB
  const TIB = 1024 ** 4;
  const GIB = 1024 ** 3;
  const totalUsageByType = { dataProtect: 0, replica: 0, smartFiles: 0 };

  for (const cluster of clusters) {
    const rng = cluster.rng;
    const feBytes = Math.round(randFloat(rng, 5, 90, 2) * TIB);
    const physicalBytes = Math.round(feBytes * randFloat(rng, 0.3, 0.6, 2));
    const capacityBytes = Math.round(physicalBytes * randFloat(rng, 1.5, 3, 2));
    const usagePct = randFloat(rng, 40, 85, 1);
    const dataReduction = randFloat(rng, 2, 5, 2);
    insertLicenseUsage.run(String(cluster.id), cluster.name, feBytes, physicalBytes, capacityBytes, usagePct, dataReduction, nowIso);

    const dpGib = randFloat(rng, 2000, 6000, 1);
    const replicaGib = cluster.drTarget ? randFloat(rng, 1000, 4000, 1) : randFloat(rng, 0, 200, 1);
    const smartFilesGib = randFloat(rng, 300, 1500, 1);
    insertMeterUsage.run(String(cluster.id), cluster.name, 'dataProtect', dpGib, nowIso);
    insertMeterUsage.run(String(cluster.id), cluster.name, 'dataProtectReplica', replicaGib, nowIso);
    insertMeterUsage.run(String(cluster.id), cluster.name, 'externalViews', smartFilesGib, nowIso);
    totalUsageByType.dataProtect += dpGib;
    totalUsageByType.replica += replicaGib;
    totalUsageByType.smartFiles += smartFilesGib;

    for (const category of ['backup', 'replication', 'viewBackups', 'views', 'viewsReplicated']) {
      const consumers = randInt(rng, 1, 40);
      const physical = Math.round(randFloat(rng, 1, 50, 2) * GIB);
      const logical = Math.round(physical * randFloat(rng, 1.5, 3, 2));
      insertConsumption.run(String(cluster.id), cluster.name, category, consumers, physical, logical, nowIso);
    }
  }

  // Scale meter totals down/up to land near ~70% of entitlement, spread proportionally.
  const targetGib = {
    dataProtect: ENTITLED.dataProtect * 1024 * 0.7,
    replica: ENTITLED.replica * 1024 * 0.7,
    smartFiles: ENTITLED.smartFiles * 1024 * 0.7,
  };
  const scaleFactor = {
    dataProtect: targetGib.dataProtect / (totalUsageByType.dataProtect || 1),
    dataProtectReplica: targetGib.replica / (totalUsageByType.replica || 1),
    externalViews: targetGib.smartFiles / (totalUsageByType.smartFiles || 1),
  };
  db.prepare('UPDATE license_meter_usage SET usage_gib = usage_gib * ? WHERE feature = ?').run(scaleFactor.dataProtect, 'dataProtect');
  db.prepare('UPDATE license_meter_usage SET usage_gib = usage_gib * ? WHERE feature = ?').run(scaleFactor.dataProtectReplica, 'dataProtectReplica');
  db.prepare('UPDATE license_meter_usage SET usage_gib = usage_gib * ? WHERE feature = ?').run(scaleFactor.externalViews, 'externalViews');

  // ── License type usage (global row per type) ────────────────────────────
  const scaledDp = totalUsageByType.dataProtect * scaleFactor.dataProtect * GIB;
  const scaledReplica = totalUsageByType.replica * scaleFactor.dataProtectReplica * GIB;
  const scaledSmartFiles = totalUsageByType.smartFiles * scaleFactor.externalViews * GIB;
  const insertTypeUsage = db.prepare(`
    INSERT INTO license_type_usage (license_type, front_end_bytes, captured_at) VALUES (?, ?, ?)
  `);
  insertTypeUsage.run('dataProtect', Math.round(scaledDp), nowIso);
  insertTypeUsage.run('replica', Math.round(scaledReplica), nowIso);
  insertTypeUsage.run('smartFiles', Math.round(scaledSmartFiles), nowIso);

  // ── License view detail: ~30 views spread across clusters ───────────────
  let viewCount = 0;
  const viewsPerCluster = Math.ceil(30 / clusters.length);
  outer: for (const cluster of clusters) {
    const rng = cluster.rng;
    for (let i = 0; i < viewsPerCluster; i++) {
      if (viewCount >= 30) break outer;
      const physicalBytes = Math.round(randFloat(rng, 1, 100, 2) * GIB);
      const logicalBytes = Math.round(physicalBytes * randFloat(rng, 1.5, 3, 2));
      const isReadOnly = chance(rng, 0.3) ? 1 : 0;
      insertViewDetail.run(
        String(cluster.id),
        cluster.name,
        `${cluster.name}-view-${i}`,
        isReadOnly,
        now - randInt(rng, 1, 300) * 86400000,
        physicalBytes,
        logicalBytes,
        Math.round(logicalBytes * 0.5),
        nowIso
      );
      viewCount++;
    }
  }

  // ── Replication status cache: seed the default key for every cluster ───
  for (const cluster of clusters) {
    const replList = replicationsByCluster.get(cluster.name) || [];
    const cacheKey = `${cluster.name}:all:7:20`;
    const payload = {
      sourceCluster: cluster.name,
      generatedAt: nowIso,
      totalGroupsScanned: (protRunsByCluster.get(cluster.name) || []).length ? new Set((protRunsByCluster.get(cluster.name) || []).map(r => r.jobName)).size : 0,
      groupsWithActiveReplication: new Set(replList.map(r => r.protectionGroupId)).size,
      replications: replList,
    };
    insertReplCache.run(cacheKey, cluster.name, JSON.stringify(payload), nowIso);
  }

  return {
    clusters: clusters.length,
    metrics: metricsCount,
    alerts: alertsCount,
    protectionRuns: protRunCount,
    replicationRuns: replRunCount,
    policies: policyCount,
    sourceRegistrations: sourceCount,
    licenseViews: viewCount,
  };
}

module.exports = { seedCohesity, buildClusterList, drTargetFor };
