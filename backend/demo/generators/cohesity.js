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
  const insertCohesityView = db.prepare(`
    INSERT INTO cohesity_views
      (system_id, system_name, view_id, name, category, storage_domain, protocols,
       is_read_only, protected, protection_groups, replicated_out,
       last_backup_status, last_backup_ms, datalock_mode, datalock_retention_ms,
       logical_bytes, consumed_bytes, data_in_bytes, data_written_bytes, file_count, created_ms, captured_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
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
      // Array of plain cluster-name strings — the shape the real poller
      // stores and the Governance page renders (objects crash React #31).
      const replicationTargets = hasTarget
        ? JSON.stringify([cluster.drTarget])
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
      const viewName = `${cluster.name}-view-${i}`;
      const createdMs = now - randInt(rng, 1, 300) * 86400000;
      insertViewDetail.run(
        String(cluster.id),
        cluster.name,
        viewName,
        isReadOnly,
        createdMs,
        physicalBytes,
        logicalBytes,
        Math.round(logicalBytes * 0.5),
        nowIso
      );
      // Same view in the Views inventory (Views page + governance audit),
      // with a mix of protection states so every audit tab has rows.
      // Read-only views are inbound replicas: never protected/locked locally.
      const isProtected = !isReadOnly && chance(rng, 0.7) ? 1 : 0;
      const replicatedOut = isProtected && chance(rng, 0.6) ? 1 : 0;
      const hasDatalock = !isReadOnly && chance(rng, 0.5);
      insertCohesityView.run(
        String(cluster.id),
        cluster.name,
        1000 + viewCount,
        viewName,
        chance(rng, 0.6) ? 'BackupTarget' : 'FileServices',
        hasDatalock ? 'DefaultDataLockDomain' : 'DefaultStorageDomain',
        chance(rng, 0.5) ? 'SMB' : 'NFS,SMB',
        isReadOnly,
        isProtected,
        isProtected ? JSON.stringify([`${cluster.name}_CView-${String(i + 1).padStart(3, '0')}`]) : null,
        replicatedOut,
        isProtected ? (chance(rng, 0.9) ? 'Succeeded' : 'Failed') : null,
        isProtected ? now - randInt(rng, 1, 24) * 3600000 : null,
        hasDatalock ? (chance(rng, 0.8) ? 'Enterprise' : 'Compliance') : null,
        hasDatalock ? randInt(rng, 7, 90) * 86400000 : null,
        logicalBytes,
        physicalBytes,
        logicalBytes,
        Math.round(logicalBytes * 0.5),
        randInt(rng, 100, 50000),
        createdMs,
        nowIso
      );
      viewCount++;
    }
  }

  // ── Workload history: 60 days of daily per-environment snapshots ────────
  // Shapes match services/workloads.js: env names have the 'k' prefix already
  // stripped, all of a cluster's rows for a day share one captured_at (the
  // getWorkloads query joins on the exact latest timestamp per cluster), and
  // the Views row is derived from the seeded cohesity_views with job_count NULL.
  const insertWorkload = db.prepare(`
    INSERT INTO workload_history
      (cluster_id, environment, protected_count, unprotected_count, protected_bytes,
       job_count, logical_bytes, physical_bytes, captured_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const WORKLOAD_ENVS = ['VMware', 'Physical', 'SQL', 'Oracle', 'NetApp', 'GenericNas', 'Exchange'];
  const TB = 1e12;
  let workloadRows = 0;
  const WORKLOAD_DAYS = 60;
  for (const cluster of clusters) {
    const rng = rngFor(`${cluster.name}-workloads`);
    // VMware + Physical everywhere, plus 2-4 of the rest per cluster.
    const envs = WORKLOAD_ENVS.filter((e, i) => i < 2 || chance(rng, 0.55));
    const baseByEnv = envs.map((environment, i) => ({
      environment,
      protectedCount: i === 0 ? randInt(rng, 120, 600) : randInt(rng, 8, 150),
      unprotectedCount: randInt(rng, 0, 25),
      protectedTb: i === 0 ? randFloat(rng, 30, 150, 2) : randFloat(rng, 2, 60, 2),
      jobCount: randInt(rng, 2, 14),
      reduction: randFloat(rng, 2.4, 4.2, 2),
      growth: randFloat(rng, 0.03, 0.14, 3), // fraction grown over the window
    }));
    const viewStats = db.prepare(`
      SELECT COUNT(*) AS total,
             COALESCE(SUM(protected), 0) AS prot,
             COALESCE(SUM(CASE WHEN protected = 1 THEN logical_bytes END), 0) AS prot_logical,
             COALESCE(SUM(logical_bytes), 0) AS logical,
             COALESCE(SUM(consumed_bytes), 0) AS physical
      FROM cohesity_views WHERE system_name = ?
    `).get(cluster.name);

    for (let d = WORKLOAD_DAYS; d >= 0; d--) {
      const capturedAt = new Date(now - d * 86400000).toISOString();
      const progress = (WORKLOAD_DAYS - d) / WORKLOAD_DAYS;
      for (const base of baseByEnv) {
        const scale = 1 - base.growth + base.growth * progress;
        const protectedBytes = Math.round(base.protectedTb * TB * scale);
        const logicalBytes = Math.round(protectedBytes * randFloat(rng, 1.05, 1.3, 2));
        insertWorkload.run(
          cluster.id, base.environment,
          Math.round(base.protectedCount * scale), base.unprotectedCount,
          protectedBytes, base.jobCount, logicalBytes,
          Math.round(logicalBytes / base.reduction), capturedAt
        );
        workloadRows++;
      }
      if (viewStats.total > 0) {
        insertWorkload.run(
          cluster.id, 'Views', viewStats.prot, viewStats.total - viewStats.prot,
          viewStats.prot_logical, null, viewStats.logical, viewStats.physical, capturedAt
        );
        workloadRows++;
      }
    }
  }

  // ── Object inventory (Sources page): per-object rows per cluster ─────────
  const insertObject = db.prepare(`
    INSERT INTO cohesity_objects
      (cluster_id, object_id, global_id, name, source_name, environment, object_type,
       os_type, protection_type, logical_bytes, is_protected, protection_groups,
       policy_names, last_backup_status, sla_violated, last_backup_ms, captured_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const OBJ_SHAPES = {
    VMware: { type: 'VirtualMachine', src: (c) => `vc-${c.site}.icc.demo`, os: ['Linux', 'Windows'] },
    Physical: { type: 'Host', src: (c, n) => n, os: ['Windows', 'Linux'] },
    SQL: { type: 'Database', src: (c) => `${c.site}-sql-cluster`, os: ['Windows'] },
    Oracle: { type: 'Database', src: (c) => `${c.site}-ora-rac`, os: ['Linux'] },
    NetApp: { type: 'Volume', src: (c) => `${c.site}-ntap-01`, os: [null] },
    GenericNas: { type: 'Share', src: (c) => `${c.site}-nas-01`, os: [null] },
    Exchange: { type: 'Database', src: (c) => `${c.site}-exch-dag`, os: ['Windows'] },
  };
  let objectRows = 0;
  // Objects reference the cluster's REAL seeded run job names so the Backup
  // History page (objects → protection_groups → protection_runs) lights up.
  const ENV_JOB_PREFIX = {
    VMware: 'VM_Prod_Backup', Physical: 'VM_Prod_Backup', SQL: 'SQL_Daily',
    Oracle: 'Oracle_Weekly', Exchange: 'Exchange_DB', NetApp: 'NAS_Archive', GenericNas: 'NAS_Archive',
  };
  for (const cluster of clusters) {
    const rng = rngFor(`${cluster.name}-objects`);
    const site = cluster.name.split('-')[0];
    const clusterJobs = [...new Set((protRunsByCluster.get(cluster.name) || []).map((r) => r.jobName))];
    const envRows = db.prepare(`
      SELECT DISTINCT environment FROM workload_history WHERE cluster_id = ? AND environment != 'Views'
    `).all(cluster.id).map((r) => r.environment);
    for (const environment of envRows) {
      const shape = OBJ_SHAPES[environment] || { type: 'Object', src: () => null, os: [null] };
      const envJobs = clusterJobs.filter((j) => j.startsWith(ENV_JOB_PREFIX[environment] || ''));
      const groupPool = envJobs.length ? envJobs : clusterJobs;
      const count = environment === 'VMware' ? randInt(rng, 25, 60) : randInt(rng, 4, 18);
      for (let i = 1; i <= count; i++) {
        const name = environment === 'VMware' ? `${site}-vm-${String(i).padStart(3, '0')}`
          : environment === 'Physical' ? `${site}-phys-${String(i).padStart(2, '0')}`
            : `${site}-${environment.toLowerCase()}-${String(i).padStart(2, '0')}`;
        const isProtected = chance(rng, 0.86);
        const groupName = groupPool.length ? groupPool[i % groupPool.length] : `${environment}_Protect_${1 + (i % 3)}`;
        const failed = isProtected && chance(rng, 0.06);
        insertObject.run(
          cluster.id, 10000 + objectRows, `${cluster.id}:demo:${10000 + objectRows}`,
          name, shape.src(({ site }), name), environment, shape.type,
          pick(rng, shape.os), environment === 'Physical' ? 'Volume' : null,
          randInt(rng, 20, 900) * 1e9,
          isProtected ? 1 : 0,
          isProtected ? JSON.stringify([groupName]) : null,
          isProtected ? JSON.stringify([`${site}-${environment.toLowerCase()}-daily`]) : null,
          isProtected ? (failed ? 'Failed' : 'Succeeded') : null,
          isProtected ? (failed && chance(rng, 0.5) ? 1 : 0) : null,
          // Failed runs' last GOOD backup skews stale — a few land >7d old.
          isProtected ? now - (failed ? randInt(rng, 3, 21) : randInt(rng, 0, 2)) * 86400000 - randInt(rng, 0, 20) * 3600000 : null,
          new Date(now - randInt(rng, 2, 30) * 60000).toISOString()
        );
        objectRows++;
      }
    }
  }

  // ── Cohesity agents on physical sources (Governance > Agent Versions) ────
  const AGENT_VERSIONS = ['7.3.2_release-20260123_529553a9', '7.1.2_u2_release-20240925_66722648', '6.8.2_release-20240317_97f56d9a'];
  const insertAgent = db.prepare(`
    INSERT INTO cohesity_agents
      (cluster_id, source_id, name, host_type, os_name, agent_version, agent_status, upgradability, upgrade_status, captured_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'Finished', ?)
  `);
  let agentRows = 0;
  for (const cluster of clusters) {
    const rng = rngFor(`${cluster.name}-agents`);
    const physNames = db.prepare(`
      SELECT name FROM cohesity_objects WHERE cluster_id = ? AND environment = 'Physical'
    `).all(cluster.id).map((r) => r.name);
    for (const name of physNames) {
      // ~70% on the current agent, the rest lag one or two releases behind.
      const version = chance(rng, 0.7) ? AGENT_VERSIONS[0] : pick(rng, AGENT_VERSIONS.slice(1));
      const windows = chance(rng, 0.7);
      insertAgent.run(
        cluster.id, 20000 + agentRows, name,
        windows ? 'Windows' : 'Linux',
        windows ? 'Windows Server 2019 Standard' : 'Red Hat Enterprise Linux 8.9',
        version, 'Healthy',
        version === AGENT_VERSIONS[0] ? 'Current' : 'Upgradable',
        new Date(now - randInt(rng, 2, 30) * 60000).toISOString()
      );
      agentRows++;
    }
  }

  // ── Gflags: fleet-wide baseline + per-cluster support-case drift + audit ──
  // Current state in cluster_gflags must stay consistent with gflag_changes
  // (an 'added'/'modified' event's new_value is what the cluster shows now).
  const insertGflag = db.prepare(`
    INSERT INTO cluster_gflags (cluster_id, service_name, flag_name, flag_value, reason, source_timestamp, captured_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `);
  const insertGflagChange = db.prepare(`
    INSERT INTO gflag_changes (cluster_id, service_name, flag_name, old_value, new_value, change_type, source_reason, source_timestamp, detected_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  const GFLAG_BASELINE = [
    ['kMagneto', 'magneto_master_snapshot_gc_delay_secs', '3600', 'FY25 baseline tuning rollout'],
    ['kMagneto', 'magneto_gatekeeper_max_outstanding_rpcs', '256', null],
    ['kBridge', 'bridge_apollo_compaction_min_epochs', '4', 'Support case 05512233'],
    ['kBridge', 'bridge_max_dedup_cache_size_mb', '8192', null],
    ['kScribe', 'scribe_flush_interval_msecs', '500', null],
    ['kGandalf', 'gandalf_leader_lease_timeout_msecs', '10000', 'Support case 05498711'],
    ['kIris', 'iris_session_idle_timeout_secs', '1800', 'Security baseline'],
    ['kKeychain', 'keychain_kms_retry_limit', '5', null],
  ];
  const GFLAG_DRIFT = [
    ['kMagneto', 'magneto_disable_parallel_runs', 'true', 'Support case 05633104 — job hang mitigation'],
    ['kBridge', 'bridge_prefer_sequential_restore', 'true', 'Support case 05641220 — restore throughput'],
    ['kScribe', 'scribe_max_commit_batch_size', '2048', 'ENG-51877 workaround'],
    ['kYoda', 'yoda_indexing_max_parallel_files', '64', 'Support case 05659812 — indexing backlog'],
  ];
  const gflagKey = (service, flag) => `${service}\x00${flag}`;

  let gflagCount = 0;
  let gflagChangeCount = 0;
  for (const cluster of clusters) {
    const rng = rngFor(`gflags:${cluster.name}`);
    const state = new Map();
    for (const [service, flag, value, reason] of GFLAG_BASELINE) {
      const setMs = now - randInt(rng, 120, 400) * 86400000;
      state.set(gflagKey(service, flag), { service, flag, value, reason, ts: Math.floor(setMs / 1000) });
    }
    // ~40% of clusters carry one or two support-case drift flags — the whole
    // point of the Compare tab is that the fleet is NOT uniform.
    if (chance(rng, 0.4)) {
      const count = chance(rng, 0.3) ? 2 : 1;
      for (let i = 0; i < count; i++) {
        const [service, flag, value, reason] = pick(rng, GFLAG_DRIFT);
        if (state.has(gflagKey(service, flag))) continue;
        const setMs = now - randInt(rng, 5, 75) * 86400000;
        const ts = Math.floor(setMs / 1000);
        state.set(gflagKey(service, flag), { service, flag, value, reason, ts });
        insertGflagChange.run(cluster.id, service, flag, null, value, 'added', reason, ts, new Date(setMs).toISOString());
        gflagChangeCount++;
      }
    }
    // Some clusters had a baseline value retuned since the initial rollout.
    if (chance(rng, 0.25)) {
      const retuneMs = now - randInt(rng, 10, 60) * 86400000;
      const ts = Math.floor(retuneMs / 1000);
      const row = state.get(gflagKey('kScribe', 'scribe_flush_interval_msecs'));
      insertGflagChange.run(cluster.id, 'kScribe', 'scribe_flush_interval_msecs', row.value, '250',
        'modified', 'Support case 05661409 — scribe latency', ts, new Date(retuneMs).toISOString());
      gflagChangeCount++;
      Object.assign(row, { value: '250', reason: 'Support case 05661409 — scribe latency', ts });
    }
    // Occasional cleanup: a workaround flag reverted after the case closed.
    if (chance(rng, 0.2)) {
      const removedMs = now - randInt(rng, 15, 80) * 86400000;
      insertGflagChange.run(cluster.id, 'kMagneto', 'magneto_enable_aggressive_gc', 'true', null,
        'removed', 'Reverted — fix shipped in 7.1.2', null, new Date(removedMs).toISOString());
      gflagChangeCount++;
    }
    for (const row of state.values()) {
      insertGflag.run(cluster.id, row.service, row.flag, row.value, row.reason, row.ts, nowIso);
      gflagCount++;
    }
  }
  // Two fresh changes inside 24h so the Ops attention feed and the Changes tab
  // both have something recent to show right after a re-seed.
  {
    const freshMod = clusterByName.get('nyc-coh-prd-01');
    const modMs = now - 10 * 3600000;
    const modTs = Math.floor(modMs / 1000);
    db.prepare(`UPDATE cluster_gflags SET flag_value = '7200', reason = 'Support case 05712844 — GC tuning', source_timestamp = ?
                WHERE cluster_id = ? AND flag_name = 'magneto_master_snapshot_gc_delay_secs'`).run(modTs, freshMod.id);
    insertGflagChange.run(freshMod.id, 'kMagneto', 'magneto_master_snapshot_gc_delay_secs', '3600', '7200',
      'modified', 'Support case 05712844 — GC tuning', modTs, new Date(modMs).toISOString());
    gflagChangeCount++;

    const freshAdd = clusterByName.get('lon-coh-dr-01');
    const addMs = now - 5 * 3600000;
    const addTs = Math.floor(addMs / 1000);
    const [service, flag, value, reason] = GFLAG_DRIFT[1];
    const displaced = db.prepare('DELETE FROM cluster_gflags WHERE cluster_id = ? AND service_name = ? AND flag_name = ?')
      .run(freshAdd.id, service, flag).changes;
    insertGflag.run(freshAdd.id, service, flag, value, reason, addTs, nowIso);
    gflagCount += 1 - displaced;
    insertGflagChange.run(freshAdd.id, service, flag, null, value, 'added', reason, addTs, new Date(addMs).toISOString());
    gflagChangeCount++;
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
    workloadRows,
    gflags: gflagCount,
    gflagChanges: gflagChangeCount,
  };
}

module.exports = { seedCohesity, buildClusterList, drTargetFor };
