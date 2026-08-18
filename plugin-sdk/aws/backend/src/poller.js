// AWS poller — one scheduled task per registered account (framework
// per-source model, like vCenter/NetBackup/Dell). Every cycle: EC2 + EBS +
// per-instance CloudWatch metrics, Lightsail + its metrics/snapshots, ECS
// clusters/services + CloudWatch metrics, Bedrock usage (CloudWatch AWS/
// Bedrock). Cost Explorer and S3 (each with its own CloudWatch calls) are
// daily-gated behind last_cost_capture_at / last_s3_capture_at so we never
// burn more than one $0.01 Cost Explorer call per ~20h.
//
// Ported from backend/services/awsPoller.js. db/logger/createPoller now come
// from coreApi rather than direct host requires; every awsApi.js fetcher call
// now threads coreApi through.
//
// Fix #0 (global-collector election): Cost Explorer and S3 ListBuckets are
// ACCOUNT-GLOBAL, not per-region, but every account row used to poll them,
// quadrupling stored data when several rows share one credential across
// regions. Only the row with the lowest id among rows sharing the same
// effective access key id ("elected") runs Cost Explorer / S3 / their
// history+grouping collectors; every other row self-heals by deleting its
// own copies each cycle instead.
//
// Module-scoped singleton: createRouter() and manifest.createPoller() are
// both called by the host registry against the same coreApi, but createRouter
// runs first and needs to reach the same poller instance for
// schedule/cancel/trigger on account CRUD. getPoller() lazily builds it if
// not yet created, and createAwsPoller() (the manifest.createPoller entry
// point) reuses it if router.js got there first (dell/unifi poller.js pattern).
const awsApi = require('./api');
const { reconcileIssueHistory } = require('./issues');

let pollerInstance = null;

const safeMsg = (e) => (e?.response ? `HTTP ${e.response.status}` : (e?.message || String(e)));
const DAILY_GATE_MS = 20 * 3600 * 1000;

function needsDaily(stamp) {
  if (!stamp) return true;
  return Date.now() - new Date(stamp).getTime() > DAILY_GATE_MS;
}

// IAM policy not yet updated for a new service, or the service has no
// regional endpoint (Lightsail ENOTFOUND lesson) — degrade to empty and warn
// once instead of failing the whole poll. Any other error still propagates.
const DEGRADE_NAMES = new Set(['AccessDenied', 'AccessDeniedException', 'UnrecognizedClientException', 'AuthorizationError']);
function isDegradable(err) {
  if (DEGRADE_NAMES.has(err?.name)) return true;
  return String(err?.code || '').includes('ENOTFOUND') || String(err?.message || '').includes('ENOTFOUND');
}
async function degradeGracefully(coreApi, account, label, fn, fallback) {
  try {
    return await fn();
  } catch (err) {
    if (isDegradable(err)) {
      coreApi.logger.warn(`[AwsPoller] ${account.name}: ${label} unavailable (${err.name || 'error'}): ${safeMsg(err)}`);
      return fallback;
    }
    throw err;
  }
}

// ── Fix #0: global-collector election ───────────────────────────────────────

/** account.access_key_id || env AWS_ACCESS_KEY_ID || '' — blank key = one shared group. */
function effectiveKeyId(account) {
  return account.access_key_id || process.env.AWS_ACCESS_KEY_ID || '';
}

/**
 * True when `account` is the lowest-id row among all aws_accounts rows
 * sharing the same effective access key id (same rule expressed in SQL).
 * The elected row is the only one allowed to run the account-global Cost
 * Explorer / S3 collectors this cycle.
 */
function isElected(coreApi, account) {
  const envKey = process.env.AWS_ACCESS_KEY_ID || '';
  const key = effectiveKeyId(account);
  const row = coreApi.db.prepare(`
    SELECT MIN(id) AS minId FROM aws_accounts
    WHERE COALESCE(NULLIF(access_key_id, ''), ?) = ?
  `).get(envKey, key);
  return (row?.minId ?? account.id) === account.id;
}

/** Idempotent self-heal for a non-elected row: clear its duplicated global-collector data. */
function cleanupNonElectedGlobalRows(coreApi, accountId) {
  const db = coreApi.db;
  db.prepare('DELETE FROM aws_cost_daily WHERE account_id = ?').run(accountId);
  db.prepare('DELETE FROM aws_cost_usage_daily WHERE account_id = ?').run(accountId);
  db.prepare('DELETE FROM aws_cost_instance_type_daily WHERE account_id = ?').run(accountId);
  db.prepare('DELETE FROM aws_s3_buckets WHERE account_id = ?').run(accountId);
  db.prepare('DELETE FROM aws_s3_size_history WHERE account_id = ?').run(accountId);
}

function buildTransactions(coreApi) {
  const db = coreApi.db;

  const upsertS3SizeHistory = db.transaction((accountId, buckets) => {
    const stmt = db.prepare(`
      INSERT INTO aws_s3_size_history (account_id, bucket_name, day, size_bytes, object_count)
      VALUES (?, ?, date('now'), ?, ?)
      ON CONFLICT(account_id, bucket_name, day) DO UPDATE SET
        size_bytes = excluded.size_bytes, object_count = excluded.object_count
    `);
    for (const b of buckets) stmt.run(accountId, b.name, b.sizeBytes, b.objectCount);
  });

  const upsertRdsStorageHistory = db.transaction((accountId, instances) => {
    const stmt = db.prepare(`
      INSERT INTO aws_rds_storage_history (account_id, db_id, day, free_storage_bytes, allocated_gb)
      VALUES (?, ?, date('now'), ?, ?)
      ON CONFLICT(account_id, db_id, day) DO UPDATE SET
        free_storage_bytes = excluded.free_storage_bytes, allocated_gb = excluded.allocated_gb
    `);
    for (const i of instances) {
      if (i.freeStorageBytes != null) stmt.run(accountId, i.dbId, i.freeStorageBytes, i.allocatedGb);
    }
  });

  const upsertCostUsageType = db.transaction((accountId, rows) => {
    const stmt = db.prepare(`
      INSERT INTO aws_cost_usage_daily (account_id, day, usage_type, amount_usd)
      VALUES (?, ?, ?, ?)
      ON CONFLICT(account_id, day, usage_type) DO UPDATE SET amount_usd = excluded.amount_usd
    `);
    for (const r of rows) stmt.run(accountId, r.day, r.usageType, r.amountUsd);
  });

  const upsertCostInstanceType = db.transaction((accountId, rows) => {
    const stmt = db.prepare(`
      INSERT INTO aws_cost_instance_type_daily (account_id, day, instance_type, amount_usd)
      VALUES (?, ?, ?, ?)
      ON CONFLICT(account_id, day, instance_type) DO UPDATE SET amount_usd = excluded.amount_usd
    `);
    for (const r of rows) stmt.run(accountId, r.day, r.instanceType, r.amountUsd);
  });

  const upsertHealthEvents = db.transaction((feed, service, region, events) => {
    const stmt = db.prepare(`
      INSERT INTO aws_health_events (feed, service, region, title, summary, published_at, fetched_at)
      VALUES (?, ?, ?, ?, ?, ?, datetime('now'))
      ON CONFLICT(feed, title, published_at) DO UPDATE SET
        summary = excluded.summary, fetched_at = datetime('now')
    `);
    for (const e of events) stmt.run(feed, service, region, e.title, e.summary, e.publishedAt);
  });

  const upsertBedrock = db.transaction((accountId, rows) => {
    const stmt = db.prepare(`
      INSERT INTO aws_bedrock_usage (account_id, model_id, day, invocations, input_tokens, output_tokens, avg_latency_ms)
      VALUES (?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(account_id, model_id, day) DO UPDATE SET
        invocations = excluded.invocations, input_tokens = excluded.input_tokens,
        output_tokens = excluded.output_tokens, avg_latency_ms = excluded.avg_latency_ms
    `);
    for (const r of rows) {
      stmt.run(accountId, r.modelId, r.day, r.invocations, r.inputTokens, r.outputTokens, r.avgLatencyMs);
    }
  });

  const upsertCost = db.transaction((accountId, rows) => {
    const stmt = db.prepare(`
      INSERT INTO aws_cost_daily (account_id, day, service, amount_usd)
      VALUES (?, ?, ?, ?)
      ON CONFLICT(account_id, day, service) DO UPDATE SET amount_usd = excluded.amount_usd
    `);
    for (const r of rows) stmt.run(accountId, r.day, r.service, r.amountUsd);
  });

  const storeS3 = db.transaction((accountId, buckets) => {
    db.prepare('DELETE FROM aws_s3_buckets WHERE account_id = ?').run(accountId);
    const stmt = db.prepare(`
      INSERT INTO aws_s3_buckets (account_id, name, region, size_bytes, object_count,
        public_access_blocked, versioning, lifecycle_rules, created_at_aws)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    for (const b of buckets) {
      stmt.run(accountId, b.name, b.region, b.sizeBytes, b.objectCount,
        b.publicAccessBlocked, b.versioning, b.lifecycleRules, b.createdAtAws);
    }
  });

  const storeCore = db.transaction((accountId, { ec2, lightsail, ecs }) => {
    db.prepare('DELETE FROM aws_ec2_instances WHERE account_id = ?').run(accountId);
    const ec2Stmt = db.prepare(`
      INSERT INTO aws_ec2_instances (account_id, instance_id, name, state, instance_type, az,
        private_ip, public_ip, platform, launch_time, cpu_util, status_check)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    for (const i of ec2.instances) {
      ec2Stmt.run(accountId, i.instanceId, i.name, i.state, i.instanceType, i.az,
        i.privateIp, i.publicIp, i.platform, i.launchTime, i.cpuUtil, i.statusCheck);
    }

    db.prepare('DELETE FROM aws_ebs_volumes WHERE account_id = ?').run(accountId);
    const ebsStmt = db.prepare(`
      INSERT INTO aws_ebs_volumes (account_id, volume_id, state, size_gb, volume_type, az, attached_instance_id)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `);
    for (const v of ec2.volumes) {
      ebsStmt.run(accountId, v.volumeId, v.state, v.sizeGb, v.volumeType, v.az, v.attachedInstanceId);
    }

    db.prepare('DELETE FROM aws_lightsail_instances WHERE account_id = ?').run(accountId);
    const lsStmt = db.prepare(`
      INSERT INTO aws_lightsail_instances (account_id, name, state, blueprint, bundle, az,
        public_ip, cpu_util, snapshot_count, latest_snapshot_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    for (const i of lightsail) {
      lsStmt.run(accountId, i.name, i.state, i.blueprint, i.bundle, i.az,
        i.publicIp, i.cpuUtil, i.snapshotCount, i.latestSnapshotAt);
    }

    db.prepare('DELETE FROM aws_ecs_clusters WHERE account_id = ?').run(accountId);
    const clStmt = db.prepare(`
      INSERT INTO aws_ecs_clusters (account_id, cluster_arn, cluster_name, status, running_tasks,
        pending_tasks, service_count, container_instances)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `);
    for (const c of ecs.clusters) {
      clStmt.run(accountId, c.clusterArn, c.clusterName, c.status, c.runningTasks,
        c.pendingTasks, c.serviceCount, c.containerInstances);
    }

    db.prepare('DELETE FROM aws_ecs_services WHERE account_id = ?').run(accountId);
    const svcStmt = db.prepare(`
      INSERT INTO aws_ecs_services (account_id, cluster_name, service_name, status, desired_count,
        running_count, pending_count, launch_type, cpu_util, memory_util)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    for (const s of ecs.services) {
      svcStmt.run(accountId, s.clusterName, s.serviceName, s.status, s.desiredCount,
        s.runningCount, s.pendingCount, s.launchType, s.cpuUtil, s.memoryUtil);
    }
  });

  const storeR2 = db.transaction((accountId, { rds, lambda, dynamo, ecr, vpc }) => {
    db.prepare('DELETE FROM aws_rds_instances WHERE account_id = ?').run(accountId);
    const rdsStmt = db.prepare(`
      INSERT INTO aws_rds_instances (account_id, db_id, engine, engine_version, instance_class, status,
        multi_az, allocated_gb, free_storage_bytes, cpu_util, connections, backup_retention_days,
        latest_backup_at, endpoint)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    for (const i of rds) {
      rdsStmt.run(accountId, i.dbId, i.engine, i.engineVersion, i.instanceClass, i.status,
        i.multiAz ? 1 : 0, i.allocatedGb, i.freeStorageBytes, i.cpuUtil, i.connections,
        i.backupRetentionDays, i.latestBackupAt, i.endpoint);
    }

    db.prepare('DELETE FROM aws_lambda_functions WHERE account_id = ?').run(accountId);
    const lambdaStmt = db.prepare(`
      INSERT INTO aws_lambda_functions (account_id, name, runtime, memory_mb, timeout_s, code_size_bytes,
        last_modified, invocations_24h, errors_24h, avg_duration_ms)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    for (const f of lambda) {
      lambdaStmt.run(accountId, f.name, f.runtime, f.memoryMb, f.timeoutS, f.codeSizeBytes,
        f.lastModified, f.invocations24h, f.errors24h, f.avgDurationMs);
    }

    db.prepare('DELETE FROM aws_dynamo_tables WHERE account_id = ?').run(accountId);
    const dynamoStmt = db.prepare(`
      INSERT INTO aws_dynamo_tables (account_id, name, status, billing_mode, item_count, size_bytes,
        read_capacity, write_capacity)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `);
    for (const t of dynamo) {
      dynamoStmt.run(accountId, t.name, t.status, t.billingMode, t.itemCount, t.sizeBytes,
        t.readCapacity, t.writeCapacity);
    }

    db.prepare('DELETE FROM aws_ecr_repos WHERE account_id = ?').run(accountId);
    const ecrStmt = db.prepare(`
      INSERT INTO aws_ecr_repos (account_id, name, image_count, size_bytes, scan_on_push, latest_push_at)
      VALUES (?, ?, ?, ?, ?, ?)
    `);
    for (const r of ecr) {
      ecrStmt.run(accountId, r.name, r.imageCount, r.sizeBytes, r.scanOnPush ? 1 : 0, r.latestPushAt);
    }

    db.prepare('DELETE FROM aws_vpcs WHERE account_id = ?').run(accountId);
    const vpcStmt = db.prepare(`
      INSERT INTO aws_vpcs (account_id, vpc_id, name, cidr, state, is_default, subnet_count,
        nat_gateway_count, security_group_count, igw)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    for (const v of vpc.vpcs) {
      vpcStmt.run(accountId, v.vpcId, v.name, v.cidr, v.state, v.isDefault ? 1 : 0,
        v.subnetCount, v.natGatewayCount, v.securityGroupCount, v.igw);
    }

    db.prepare('DELETE FROM aws_subnets WHERE account_id = ?').run(accountId);
    const subnetStmt = db.prepare(`
      INSERT INTO aws_subnets (account_id, subnet_id, vpc_id, name, cidr, az, available_ips, public)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `);
    for (const s of vpc.subnets) {
      subnetStmt.run(accountId, s.subnetId, s.vpcId, s.name, s.cidr, s.az, s.availableIps, s.public ? 1 : 0);
    }
  });

  const storeOptimizer = db.transaction((accountId, coEnrollment, rows) => {
    db.prepare('DELETE FROM aws_optimizer_recommendations WHERE account_id = ?').run(accountId);
    const stmt = db.prepare(`
      INSERT OR REPLACE INTO aws_optimizer_recommendations
        (account_id, source, resource_type, resource_id, resource_name, region, finding,
         current_config, recommended_config, reason, est_monthly_savings_usd)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    for (const r of rows) {
      stmt.run(accountId, r.source, r.resourceType, r.resourceId, r.resourceName ?? null, r.region ?? null,
        r.finding ?? null, r.currentConfig ?? null, r.recommendedConfig ?? null, r.reason ?? null,
        r.estMonthlySavingsUsd ?? null);
    }
    db.prepare("UPDATE aws_accounts SET last_optimizer_capture_at = datetime('now'), co_enrollment = ? WHERE id = ?")
      .run(coEnrollment, accountId);
  });

  return {
    upsertS3SizeHistory, upsertRdsStorageHistory, upsertCostUsageType, upsertCostInstanceType,
    upsertHealthEvents, upsertBedrock, upsertCost, storeS3, storeCore, storeR2, storeOptimizer,
  };
}

// ── AWS Service Health RSS (module-level, not per-account) ─────────────────

const HEALTH_GATE_MS = 15 * 60 * 1000;
const HEALTH_SERVICES = ['ec2', 's3', 'rds', 'lambda', 'dynamodb', 'ecs'];
let lastHealthFetchAt = null;

/** ISO timestamp of the last health-RSS sweep, or null before the first one. */
function getHealthLastCheckedAt() {
  return lastHealthFetchAt;
}

/** Guarded module-level sweep across every distinct account region × HEALTH_SERVICES. */
async function maybeCollectHealth(coreApi, txns) {
  if (lastHealthFetchAt && Date.now() - new Date(lastHealthFetchAt).getTime() < HEALTH_GATE_MS) return;
  lastHealthFetchAt = new Date().toISOString();
  const db = coreApi.db;
  const regions = db.prepare('SELECT DISTINCT region FROM aws_accounts WHERE region IS NOT NULL').all().map((r) => r.region);
  for (const region of regions) {
    for (const service of HEALTH_SERVICES) {
      try {
        const events = await awsApi.fetchHealthRss(coreApi, service, region);
        if (events.length) txns.upsertHealthEvents(`${service}-${region}`, service, region, events);
      } catch (err) {
        coreApi.logger.debug(`[AwsPoller] health RSS sweep failed for ${service}-${region}: ${safeMsg(err)}`);
      }
    }
  }
  db.prepare("DELETE FROM aws_health_events WHERE fetched_at < datetime('now', '-90 days')").run();
}

async function collectEc2(coreApi, account) {
  const instances = await awsApi.fetchEc2Instances(account, coreApi);
  const volumes = await awsApi.fetchEbsVolumes(account, coreApi);
  let metrics = new Map();
  try {
    metrics = await awsApi.fetchEc2Metrics(account, coreApi, instances.map((i) => i.instanceId));
  } catch (err) {
    coreApi.logger.warn(`[AwsPoller] ${account.name}: EC2 CloudWatch metrics failed: ${safeMsg(err)}`);
  }
  for (const i of instances) {
    const m = metrics.get(i.instanceId);
    i.cpuUtil = m?.cpuUtil ?? null;
    i.statusCheck = m?.statusCheck ?? null;
  }
  return { instances, volumes };
}

async function collectLightsail(coreApi, account) {
  let instances;
  try {
    instances = await awsApi.fetchLightsailInstances(account, coreApi);
  } catch (err) {
    // Lightsail has no endpoint in some regions (e.g. us-west-1) — the SDK
    // surfaces that as a DNS ENOTFOUND. Treat as "service not offered here".
    if (String(err.code || '').includes('ENOTFOUND') || String(err.message || '').includes('ENOTFOUND')) {
      coreApi.logger.debug(`[AwsPoller] ${account.name}: Lightsail unavailable in ${account.region}: ${safeMsg(err)}`);
      return [];
    }
    throw err;
  }
  for (const i of instances) {
    try {
      i.cpuUtil = await awsApi.fetchLightsailMetric(account, coreApi, i.name);
    } catch (err) {
      coreApi.logger.debug(`[AwsPoller] ${account.name}: Lightsail metric failed for ${i.name}: ${safeMsg(err)}`);
      i.cpuUtil = null;
    }
    try {
      const snap = await awsApi.fetchLightsailSnapshots(account, coreApi, i.name);
      i.snapshotCount = snap.count;
      i.latestSnapshotAt = snap.latestAt;
    } catch (err) {
      coreApi.logger.debug(`[AwsPoller] ${account.name}: Lightsail snapshots failed for ${i.name}: ${safeMsg(err)}`);
      i.snapshotCount = null;
      i.latestSnapshotAt = null;
    }
  }
  return instances;
}

async function collectEcs(coreApi, account) {
  const clusters = await awsApi.fetchEcsClusters(account, coreApi);
  const services = [];
  for (const c of clusters) {
    let svcs = [];
    try {
      svcs = await awsApi.fetchEcsServices(account, coreApi, c.clusterArn);
    } catch (err) {
      coreApi.logger.warn(`[AwsPoller] ${account.name}: ECS services failed for ${c.clusterName}: ${safeMsg(err)}`);
      continue;
    }
    let metrics = new Map();
    try {
      metrics = await awsApi.fetchEcsServiceMetrics(account, coreApi, c.clusterName, svcs.map((s) => s.serviceName));
    } catch (err) {
      coreApi.logger.debug(`[AwsPoller] ${account.name}: ECS service metrics failed for ${c.clusterName}: ${safeMsg(err)}`);
    }
    for (const s of svcs) {
      const m = metrics.get(s.serviceName);
      services.push({ ...s, clusterName: c.clusterName, cpuUtil: m?.cpuUtil ?? null, memoryUtil: m?.memoryUtil ?? null });
    }
  }
  return { clusters, services };
}

async function collectBedrock(coreApi, account) {
  const modelIds = await awsApi.fetchBedrockModelIds(account, coreApi);
  const rows = [];
  for (const modelId of modelIds) {
    const daily = await awsApi.fetchBedrockDailyUsage(account, coreApi, modelId);
    for (const d of daily) rows.push({ modelId, ...d });
  }
  return rows;
}

async function collectS3(coreApi, account) {
  const buckets = await awsApi.fetchS3Buckets(account, coreApi);
  const out = [];
  for (const b of buckets) {
    const region = await awsApi.fetchBucketLocation(account, coreApi, b.name);
    const [publicAccessBlocked, versioning, lifecycleRules, storage] = await Promise.all([
      awsApi.fetchBucketPublicAccessBlocked(account, coreApi, b.name, region),
      awsApi.fetchBucketVersioning(account, coreApi, b.name, region),
      awsApi.fetchBucketLifecycleRuleCount(account, coreApi, b.name, region),
      awsApi.fetchBucketStorageMetrics(account, coreApi, b.name, region),
    ]);
    out.push({
      name: b.name, region, createdAtAws: b.createdAt,
      publicAccessBlocked: publicAccessBlocked ? 1 : 0, versioning, lifecycleRules,
      sizeBytes: storage.sizeBytes, objectCount: storage.objectCount,
    });
  }
  return out;
}

async function collectRds(coreApi, account) {
  return degradeGracefully(coreApi, account, 'RDS', async () => {
    const instances = await awsApi.fetchRdsInstances(account, coreApi);
    let metrics = new Map();
    try {
      metrics = await awsApi.fetchRdsMetrics(account, coreApi, instances.map((i) => i.dbId));
    } catch (err) {
      coreApi.logger.debug(`[AwsPoller] ${account.name}: RDS CloudWatch metrics failed: ${safeMsg(err)}`);
    }
    for (const i of instances) {
      const m = metrics.get(i.dbId);
      i.freeStorageBytes = m?.freeStorageBytes ?? null;
      i.cpuUtil = m?.cpuUtil ?? null;
      i.connections = m?.connections ?? null;
    }
    return instances;
  }, []);
}

async function collectLambda(coreApi, account) {
  return degradeGracefully(coreApi, account, 'Lambda', async () => {
    const functions = await awsApi.fetchLambdaFunctions(account, coreApi);
    let metrics = new Map();
    try {
      metrics = await awsApi.fetchLambdaMetrics(account, coreApi, functions.map((f) => f.name));
    } catch (err) {
      coreApi.logger.debug(`[AwsPoller] ${account.name}: Lambda CloudWatch metrics failed: ${safeMsg(err)}`);
    }
    for (const f of functions) {
      const m = metrics.get(f.name);
      f.invocations24h = m?.invocations24h ?? null;
      f.errors24h = m?.errors24h ?? null;
      f.avgDurationMs = m?.avgDurationMs ?? null;
    }
    return functions;
  }, []);
}

async function collectDynamo(coreApi, account) {
  return degradeGracefully(coreApi, account, 'DynamoDB', async () => {
    const names = await awsApi.fetchDynamoTableNames(account, coreApi);
    const tables = [];
    for (const name of names) {
      try {
        tables.push(await awsApi.fetchDynamoTable(account, coreApi, name));
      } catch (err) {
        coreApi.logger.debug(`[AwsPoller] ${account.name}: DynamoDB DescribeTable failed for ${name}: ${safeMsg(err)}`);
      }
    }
    return tables;
  }, []);
}

async function collectEcr(coreApi, account) {
  return degradeGracefully(coreApi, account, 'ECR', async () => {
    const repos = await awsApi.fetchEcrRepos(account, coreApi);
    for (const r of repos) {
      try {
        const images = await awsApi.fetchEcrRepoImages(account, coreApi, r.name);
        r.imageCount = images.imageCount;
        r.sizeBytes = images.sizeBytes;
        r.latestPushAt = images.latestPushAt;
      } catch (err) {
        coreApi.logger.debug(`[AwsPoller] ${account.name}: ECR DescribeImages failed for ${r.name}: ${safeMsg(err)}`);
        r.imageCount = null;
        r.sizeBytes = null;
        r.latestPushAt = null;
      }
    }
    return repos;
  }, []);
}

// ── Optimizer (Compute Optimizer + local heuristics) ────────────────────────

async function collectComputeOptimizer(coreApi, account) {
  return degradeGracefully(coreApi, account, 'Compute Optimizer', async () => {
    const enrollment = await awsApi.fetchCoEnrollmentStatus(account, coreApi);
    let rows = [];
    if (enrollment.status === 'Active') {
      const [ec2, ebs, lambdaRecs, ecs] = await Promise.all([
        degradeGracefully(coreApi, account, 'CO EC2 recommendations', () => awsApi.fetchCoEc2Recommendations(account, coreApi), []),
        degradeGracefully(coreApi, account, 'CO EBS recommendations', () => awsApi.fetchCoEbsRecommendations(account, coreApi), []),
        degradeGracefully(coreApi, account, 'CO Lambda recommendations', () => awsApi.fetchCoLambdaRecommendations(account, coreApi), []),
        degradeGracefully(coreApi, account, 'CO ECS recommendations', () => awsApi.fetchCoEcsRecommendations(account, coreApi), []),
      ]);
      rows = [
        ...ec2.map((r) => ({ ...r, resourceType: 'ec2' })),
        ...ebs.map((r) => ({ ...r, resourceType: 'ebs' })),
        ...lambdaRecs.map((r) => ({ ...r, resourceType: 'lambda' })),
        ...ecs.map((r) => ({ ...r, resourceType: 'ecs' })),
      ];
    }
    return { status: enrollment.status || 'Inactive', rows };
  }, { status: 'denied', rows: [] });
}

const PREV_GEN_MAP = { t2: 't3', m3: 'm5', m4: 'm5', c3: 'c5', c4: 'c5', r3: 'r5', r4: 'r5' };
const PREV_GEN_RE = /^(t2|m3|m4|c3|c4|r3|r4)\./;

/**
 * Local savings heuristics computed from OUR tables for one account row —
 * gp2-to-gp3, ebs-unattached, stopped-ec2-ebs, prev-gen-type, nat-gateway-
 * consolidation always run; s3-no-lifecycle only when `elected` (S3 rows
 * only live on the elected row, see Fix #0 above).
 */
function computeHeuristicRecommendations(coreApi, accountId, elected) {
  const db = coreApi.db;
  const rows = [];

  const volumes = db.prepare('SELECT volume_id, state, size_gb, volume_type, az FROM aws_ebs_volumes WHERE account_id = ?').all(accountId);
  for (const v of volumes) {
    if (v.volume_type === 'gp2') {
      rows.push({
        source: 'heuristic', resourceType: 'ebs', resourceId: v.volume_id, resourceName: null, region: v.az,
        finding: 'gp2-to-gp3', currentConfig: 'gp2', recommendedConfig: 'gp3',
        reason: 'gp2 volume type costs more than gp3 for equivalent performance',
        estMonthlySavingsUsd: (v.size_gb || 0) * 0.02,
      });
    }
    if (v.state === 'available') {
      const perGb = v.volume_type === 'gp2' ? 0.10 : 0.08;
      rows.push({
        source: 'heuristic', resourceType: 'ebs', resourceId: v.volume_id, resourceName: null, region: v.az,
        finding: 'ebs-unattached', currentConfig: v.volume_type, recommendedConfig: 'delete or snapshot-and-delete',
        reason: 'volume is unattached and still billed',
        estMonthlySavingsUsd: (v.size_gb || 0) * perGb,
      });
    }
  }

  const instances = db.prepare('SELECT instance_id, state, instance_type, az FROM aws_ec2_instances WHERE account_id = ?').all(accountId);
  for (const i of instances) {
    if (i.state === 'stopped') {
      const attached = db.prepare(
        'SELECT SUM(size_gb) AS s FROM aws_ebs_volumes WHERE account_id = ? AND attached_instance_id = ?'
      ).get(accountId, i.instance_id);
      const sizeGb = attached?.s || 0;
      if (sizeGb > 0) {
        rows.push({
          source: 'heuristic', resourceType: 'ec2', resourceId: i.instance_id, resourceName: null, region: i.az,
          finding: 'stopped-ec2-ebs', currentConfig: i.instance_type, recommendedConfig: null,
          reason: 'stopped instance still pays for attached EBS',
          estMonthlySavingsUsd: sizeGb * 0.08,
        });
      }
    }
    const m = i.instance_type ? String(i.instance_type).match(PREV_GEN_RE) : null;
    if (m) {
      rows.push({
        source: 'heuristic', resourceType: 'ec2', resourceId: i.instance_id, resourceName: null, region: i.az,
        finding: 'prev-gen-type', currentConfig: i.instance_type,
        recommendedConfig: i.instance_type.replace(m[1], PREV_GEN_MAP[m[1]]),
        reason: 'previous-generation instance type', estMonthlySavingsUsd: null,
      });
    }
  }

  const vpcs = db.prepare('SELECT vpc_id, nat_gateway_count FROM aws_vpcs WHERE account_id = ?').all(accountId);
  for (const v of vpcs) {
    if ((v.nat_gateway_count || 0) > 1) {
      rows.push({
        source: 'heuristic', resourceType: 'vpc', resourceId: v.vpc_id, resourceName: null, region: null,
        finding: 'nat-gateway-consolidation', currentConfig: `${v.nat_gateway_count} NAT gateways`,
        recommendedConfig: 'consolidate to 1 NAT gateway',
        reason: 'multiple NAT gateways ~$32.85/mo each',
        estMonthlySavingsUsd: (v.nat_gateway_count - 1) * 32.85,
      });
    }
  }

  if (elected) {
    const buckets = db.prepare('SELECT name, region, lifecycle_rules, size_bytes FROM aws_s3_buckets WHERE account_id = ?').all(accountId);
    for (const b of buckets) {
      if ((b.lifecycle_rules || 0) === 0 && (b.size_bytes || 0) > 50 * 1024 ** 3) {
        rows.push({
          source: 'heuristic', resourceType: 's3', resourceId: b.name, resourceName: b.name, region: b.region,
          finding: 's3-no-lifecycle', currentConfig: 'no lifecycle rules', recommendedConfig: 'add lifecycle/IA transition',
          reason: 'bucket over 50GB has no lifecycle rules configured',
          estMonthlySavingsUsd: null,
        });
      }
    }
  }

  return rows;
}

async function collectVpc(coreApi, account) {
  const [vpcs, subnets, natGateways, securityGroups, internetGateways] = await Promise.all([
    degradeGracefully(coreApi, account, 'VPC', () => awsApi.fetchVpcs(account, coreApi), []),
    degradeGracefully(coreApi, account, 'Subnets', () => awsApi.fetchSubnets(account, coreApi), []),
    degradeGracefully(coreApi, account, 'NAT Gateways', () => awsApi.fetchNatGateways(account, coreApi), []),
    degradeGracefully(coreApi, account, 'Security Groups', () => awsApi.fetchSecurityGroups(account, coreApi), []),
    degradeGracefully(coreApi, account, 'Internet Gateways', () => awsApi.fetchInternetGateways(account, coreApi), []),
  ]);
  const countBy = (rows) => {
    const m = new Map();
    for (const r of rows) if (r.vpcId) m.set(r.vpcId, (m.get(r.vpcId) || 0) + 1);
    return m;
  };
  const subnetCounts = countBy(subnets);
  const natCounts = countBy(natGateways);
  const sgCounts = countBy(securityGroups);
  const igwCounts = countBy(internetGateways);
  for (const v of vpcs) {
    v.subnetCount = subnetCounts.get(v.vpcId) || 0;
    v.natGatewayCount = natCounts.get(v.vpcId) || 0;
    v.securityGroupCount = sgCounts.get(v.vpcId) || 0;
    v.igw = igwCounts.get(v.vpcId) || 0;
  }
  return { vpcs, subnets };
}

function appendMetricsHistory(coreApi, accountId, { ec2, lightsail, ecs, s3Rows }) {
  const db = coreApi.db;
  const ec2Running = ec2.instances.filter((i) => i.state === 'running').length;
  const ec2Stopped = ec2.instances.filter((i) => i.state === 'stopped').length;
  const ec2Alarmed = ec2.instances.filter((i) => i.state === 'running' && i.statusCheck === 'failed').length;
  const lightsailRunning = lightsail.filter((i) => i.state === 'running').length;
  const ecsDegraded = ecs.services.filter((s) => s.status === 'ACTIVE' && (s.runningCount ?? 0) < (s.desiredCount ?? 0)).length;
  const s3TotalBytes = (s3Rows || []).reduce((n, b) => n + (b.sizeBytes || 0), 0);
  const mtd = db.prepare(`
    SELECT SUM(amount_usd) AS s FROM aws_cost_daily
    WHERE account_id = ? AND day >= date('now', 'start of month')
  `).get(accountId);
  db.prepare(`
    INSERT INTO aws_metrics_history (account_id, ec2_running, ec2_stopped, ec2_alarmed, lightsail_running,
      ecs_services, ecs_degraded, s3_total_bytes, s3_buckets, mtd_spend_usd)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(accountId, ec2Running, ec2Stopped, ec2Alarmed, lightsailRunning,
    ecs.services.length, ecsDegraded, s3TotalBytes || null, (s3Rows || []).length || null, mtd?.s ?? null);
  db.prepare("DELETE FROM aws_metrics_history WHERE account_id = ? AND captured_at < datetime('now', '-365 days')").run(accountId);
}

async function pollAccount(coreApi, txns, account) {
  const db = coreApi.db;
  try {
    try {
      await maybeCollectHealth(coreApi, txns);
    } catch (err) {
      coreApi.logger.debug(`[AwsPoller] health RSS sweep failed: ${safeMsg(err)}`);
    }

    const ec2 = await collectEc2(coreApi, account);
    const lightsail = await collectLightsail(coreApi, account);
    const ecs = await collectEcs(coreApi, account);
    txns.storeCore(account.id, { ec2, lightsail, ecs });

    const [rds, lambdaFns, dynamo, ecr, vpc] = await Promise.all([
      collectRds(coreApi, account), collectLambda(coreApi, account), collectDynamo(coreApi, account),
      collectEcr(coreApi, account), collectVpc(coreApi, account),
    ]);
    txns.storeR2(account.id, { rds, lambda: lambdaFns, dynamo, ecr, vpc });

    txns.upsertRdsStorageHistory(account.id, rds);
    db.prepare("DELETE FROM aws_rds_storage_history WHERE account_id = ? AND day < date('now', '-365 days')").run(account.id);

    try {
      const bedrock = await collectBedrock(coreApi, account);
      txns.upsertBedrock(account.id, bedrock);
    } catch (err) {
      coreApi.logger.warn(`[AwsPoller] ${account.name}: Bedrock usage collection failed: ${safeMsg(err)}`);
    }

    const elected = isElected(coreApi, account);
    let s3Rows = null;

    if (elected) {
      if (needsDaily(account.last_cost_capture_at)) {
        try {
          const cost = await awsApi.fetchCostAndUsage(account, coreApi);
          txns.upsertCost(account.id, cost);
          const usageTypeCost = await awsApi.fetchCostByUsageType(account, coreApi);
          txns.upsertCostUsageType(account.id, usageTypeCost);
          const instanceTypeCost = await awsApi.fetchCostByInstanceType(account, coreApi);
          txns.upsertCostInstanceType(account.id, instanceTypeCost.filter((r) => r.instanceType && r.instanceType !== 'NoInstanceType'));
          db.prepare("UPDATE aws_accounts SET last_cost_capture_at = datetime('now') WHERE id = ?").run(account.id);
        } catch (err) {
          coreApi.logger.warn(`[AwsPoller] ${account.name}: Cost Explorer capture failed: ${safeMsg(err)}`);
        }
      }

      if (needsDaily(account.last_s3_capture_at)) {
        try {
          s3Rows = await collectS3(coreApi, account);
          txns.storeS3(account.id, s3Rows);
          txns.upsertS3SizeHistory(account.id, s3Rows);
          db.prepare("UPDATE aws_accounts SET last_s3_capture_at = datetime('now') WHERE id = ?").run(account.id);
        } catch (err) {
          coreApi.logger.warn(`[AwsPoller] ${account.name}: S3 capture failed: ${safeMsg(err)}`);
        }
      }
      if (!s3Rows) {
        s3Rows = db.prepare('SELECT size_bytes FROM aws_s3_buckets WHERE account_id = ?').all(account.id)
          .map((r) => ({ sizeBytes: r.size_bytes }));
      }
      db.prepare("DELETE FROM aws_s3_size_history WHERE account_id = ? AND day < date('now', '-365 days')").run(account.id);
    } else {
      // Non-elected row: another account with the same credential owns Cost
      // Explorer / S3 this cycle — self-heal any previously duplicated data.
      cleanupNonElectedGlobalRows(coreApi, account.id);
      s3Rows = [];
    }

    if (needsDaily(account.last_optimizer_capture_at)) {
      try {
        const co = await collectComputeOptimizer(coreApi, account);
        const heuristics = computeHeuristicRecommendations(coreApi, account.id, elected);
        const rows = [...co.rows.map((r) => ({ ...r, source: 'compute-optimizer' })), ...heuristics];
        txns.storeOptimizer(account.id, co.status, rows);
      } catch (err) {
        coreApi.logger.warn(`[AwsPoller] ${account.name}: Optimizer capture failed: ${safeMsg(err)}`);
      }
    }

    appendMetricsHistory(coreApi, account.id, { ec2, lightsail, ecs, s3Rows });

    db.prepare(`
      UPDATE aws_accounts SET last_poll_status = 'success', last_poll_error = NULL,
        last_poll_at = datetime('now') WHERE id = ?
    `).run(account.id);
    coreApi.logger.info(`[AwsPoller] ${account.name}: ${ec2.instances.length} EC2, ${lightsail.length} Lightsail, ${ecs.clusters.length} ECS cluster(s)`);
  } catch (err) {
    db.prepare(`
      UPDATE aws_accounts SET last_poll_status = 'error', last_poll_error = ?,
        last_poll_at = datetime('now') WHERE id = ?
    `).run(safeMsg(err), account.id);
    throw err;
  } finally {
    try { reconcileIssueHistory(coreApi); } catch (err) {
      coreApi.logger.warn(`[AwsPoller] issue-history reconcile failed: ${err.message}`);
    }
  }
}

function buildPoller(coreApi) {
  const txns = buildTransactions(coreApi);
  return coreApi.createPoller({
    id: 'aws',
    loadSources: () => coreApi.db.prepare('SELECT * FROM aws_accounts').all(),
    intervalMinutes: (a) => a.polling_interval_minutes,
    poll: (account) => pollAccount(coreApi, txns, account),
  });
}

/** Shared singleton instance poller (schedule/cancel/trigger/init/stopAll),
 *  built lazily on first access regardless of whether createRouter or
 *  manifest.createPoller reaches it first. */
function getPoller(coreApi) {
  if (!pollerInstance) pollerInstance = buildPoller(coreApi);
  return pollerInstance;
}

/** Manifest createPoller(coreApi) entry point. On a demo instance ONLY, this
 *  regenerates the fixture estate first (demoSeed.js), so demo timestamps
 *  stay relative to boot, and the poller NEVER actually polls (fixture
 *  accounts carry fake keys — real polling would just error-loop). Real
 *  instances never seed. Returns a handle mirroring the built-in's
 *  createPoller() shape. */
function createAwsPoller(coreApi) {
  if (process.env.DASHBOARD_DEMO === '1') {
    const seedDemo = () => {
      try {
        const { seedAwsDemo } = require('./demoSeed');
        const r = seedAwsDemo(coreApi);
        coreApi.logger.info(`[AwsPoller] demo estate seeded: ${r.accounts} account(s), ${r.ec2} EC2, ${r.s3} S3 bucket(s)`);
        return r;
      } catch (err) {
        coreApi.logger.warn(`[AwsPoller] demo seed failed: ${err.message}`);
        return null;
      }
    };
    seedDemo();
    return {
      init: () => { coreApi.logger.info('[AwsPoller] demo mode — polling disabled, fixtures only'); return []; },
      stopAll: () => {},
      trigger: () => { seedDemo(); return Promise.resolve(); },
      schedule: () => {},
      cancel: () => {},
      taskCount: () => 0,
    };
  }

  const awsPoller = getPoller(coreApi);

  return {
    init: () => {
      const sources = awsPoller.init();
      coreApi.logger.info(`[AwsPoller] Initialized ${sources.length} AWS account(s)`);
      return sources;
    },
    stopAll: () => awsPoller.stopAll(),
    trigger: (accountOrId) => {
      const account = typeof accountOrId === 'object'
        ? accountOrId
        : coreApi.db.prepare('SELECT * FROM aws_accounts WHERE id = ?').get(accountOrId);
      return account ? awsPoller.trigger(account) : Promise.resolve();
    },
    schedule: (account) => awsPoller.schedule(account),
    cancel: (accountId) => awsPoller.cancel(accountId),
    taskCount: () => awsPoller.taskCount(),
  };
}

module.exports = {
  createAwsPoller, getPoller, pollAccount,
  isElected, cleanupNonElectedGlobalRows,
  getHealthLastCheckedAt, HEALTH_SERVICES,
  collectComputeOptimizer, computeHeuristicRecommendations,
};
