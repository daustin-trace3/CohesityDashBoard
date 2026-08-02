// AWS poller — one scheduled task per registered account (framework
// per-source model, like vCenter/NetBackup). Every cycle: EC2 + EBS + per-
// instance CloudWatch metrics, Lightsail + its metrics/snapshots, ECS
// clusters/services + CloudWatch metrics, Bedrock usage (CloudWatch AWS/
// Bedrock). Cost Explorer and S3 (each with its own CloudWatch calls) are
// daily-gated behind last_cost_capture_at / last_s3_capture_at so we never
// burn more than one $0.01 Cost Explorer call per ~20h.
const db = require('../db/database');
const { createPoller } = require('../core/pollerFramework');
const awsApi = require('./awsApi');
const { reconcileIssueHistory } = require('./awsIssues');
const logger = require('../utils/logger');

const safeMsg = (e) => e?.response ? `HTTP ${e.response.status}` : (e?.message || String(e));
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
async function degradeGracefully(account, label, fn, fallback) {
  try {
    return await fn();
  } catch (err) {
    if (isDegradable(err)) {
      logger.warn(`[AwsPoller] ${account.name}: ${label} unavailable (${err.name || 'error'}): ${safeMsg(err)}`);
      return fallback;
    }
    throw err;
  }
}

async function collectEc2(account) {
  const instances = await awsApi.fetchEc2Instances(account);
  const volumes = await awsApi.fetchEbsVolumes(account);
  let metrics = new Map();
  try {
    metrics = await awsApi.fetchEc2Metrics(account, instances.map((i) => i.instanceId));
  } catch (err) {
    logger.warn(`[AwsPoller] ${account.name}: EC2 CloudWatch metrics failed: ${safeMsg(err)}`);
  }
  for (const i of instances) {
    const m = metrics.get(i.instanceId);
    i.cpuUtil = m?.cpuUtil ?? null;
    i.statusCheck = m?.statusCheck ?? null;
  }
  return { instances, volumes };
}

async function collectLightsail(account) {
  let instances;
  try {
    instances = await awsApi.fetchLightsailInstances(account);
  } catch (err) {
    // Lightsail has no endpoint in some regions (e.g. us-west-1) — the SDK
    // surfaces that as a DNS ENOTFOUND. Treat as "service not offered here".
    if (String(err.code || '').includes('ENOTFOUND') || String(err.message || '').includes('ENOTFOUND')) {
      logger.debug(`[AwsPoller] ${account.name}: Lightsail unavailable in ${account.region}: ${safeMsg(err)}`);
      return [];
    }
    throw err;
  }
  for (const i of instances) {
    try {
      i.cpuUtil = await awsApi.fetchLightsailMetric(account, i.name);
    } catch (err) {
      logger.debug(`[AwsPoller] ${account.name}: Lightsail metric failed for ${i.name}: ${safeMsg(err)}`);
      i.cpuUtil = null;
    }
    try {
      const snap = await awsApi.fetchLightsailSnapshots(account, i.name);
      i.snapshotCount = snap.count;
      i.latestSnapshotAt = snap.latestAt;
    } catch (err) {
      logger.debug(`[AwsPoller] ${account.name}: Lightsail snapshots failed for ${i.name}: ${safeMsg(err)}`);
      i.snapshotCount = null;
      i.latestSnapshotAt = null;
    }
  }
  return instances;
}

async function collectEcs(account) {
  const clusters = await awsApi.fetchEcsClusters(account);
  const services = [];
  for (const c of clusters) {
    let svcs = [];
    try {
      svcs = await awsApi.fetchEcsServices(account, c.clusterArn);
    } catch (err) {
      logger.warn(`[AwsPoller] ${account.name}: ECS services failed for ${c.clusterName}: ${safeMsg(err)}`);
      continue;
    }
    let metrics = new Map();
    try {
      metrics = await awsApi.fetchEcsServiceMetrics(account, c.clusterName, svcs.map((s) => s.serviceName));
    } catch (err) {
      logger.debug(`[AwsPoller] ${account.name}: ECS service metrics failed for ${c.clusterName}: ${safeMsg(err)}`);
    }
    for (const s of svcs) {
      const m = metrics.get(s.serviceName);
      services.push({ ...s, clusterName: c.clusterName, cpuUtil: m?.cpuUtil ?? null, memoryUtil: m?.memoryUtil ?? null });
    }
  }
  return { clusters, services };
}

async function collectBedrock(account) {
  const modelIds = await awsApi.fetchBedrockModelIds(account);
  const rows = [];
  for (const modelId of modelIds) {
    const daily = await awsApi.fetchBedrockDailyUsage(account, modelId);
    for (const d of daily) rows.push({ modelId, ...d });
  }
  return rows;
}

async function collectS3(account) {
  const buckets = await awsApi.fetchS3Buckets(account);
  const out = [];
  for (const b of buckets) {
    const region = await awsApi.fetchBucketLocation(account, b.name);
    const [publicAccessBlocked, versioning, lifecycleRules, storage] = await Promise.all([
      awsApi.fetchBucketPublicAccessBlocked(account, b.name, region),
      awsApi.fetchBucketVersioning(account, b.name, region),
      awsApi.fetchBucketLifecycleRuleCount(account, b.name, region),
      awsApi.fetchBucketStorageMetrics(account, b.name, region),
    ]);
    out.push({
      name: b.name, region, createdAtAws: b.createdAt,
      publicAccessBlocked: publicAccessBlocked ? 1 : 0, versioning, lifecycleRules,
      sizeBytes: storage.sizeBytes, objectCount: storage.objectCount,
    });
  }
  return out;
}

async function collectRds(account) {
  return degradeGracefully(account, 'RDS', async () => {
    const instances = await awsApi.fetchRdsInstances(account);
    let metrics = new Map();
    try {
      metrics = await awsApi.fetchRdsMetrics(account, instances.map((i) => i.dbId));
    } catch (err) {
      logger.debug(`[AwsPoller] ${account.name}: RDS CloudWatch metrics failed: ${safeMsg(err)}`);
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

async function collectLambda(account) {
  return degradeGracefully(account, 'Lambda', async () => {
    const functions = await awsApi.fetchLambdaFunctions(account);
    let metrics = new Map();
    try {
      metrics = await awsApi.fetchLambdaMetrics(account, functions.map((f) => f.name));
    } catch (err) {
      logger.debug(`[AwsPoller] ${account.name}: Lambda CloudWatch metrics failed: ${safeMsg(err)}`);
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

async function collectDynamo(account) {
  return degradeGracefully(account, 'DynamoDB', async () => {
    const names = await awsApi.fetchDynamoTableNames(account);
    const tables = [];
    for (const name of names) {
      try {
        tables.push(await awsApi.fetchDynamoTable(account, name));
      } catch (err) {
        logger.debug(`[AwsPoller] ${account.name}: DynamoDB DescribeTable failed for ${name}: ${safeMsg(err)}`);
      }
    }
    return tables;
  }, []);
}

async function collectEcr(account) {
  return degradeGracefully(account, 'ECR', async () => {
    const repos = await awsApi.fetchEcrRepos(account);
    for (const r of repos) {
      try {
        const images = await awsApi.fetchEcrRepoImages(account, r.name);
        r.imageCount = images.imageCount;
        r.sizeBytes = images.sizeBytes;
        r.latestPushAt = images.latestPushAt;
      } catch (err) {
        logger.debug(`[AwsPoller] ${account.name}: ECR DescribeImages failed for ${r.name}: ${safeMsg(err)}`);
        r.imageCount = null;
        r.sizeBytes = null;
        r.latestPushAt = null;
      }
    }
    return repos;
  }, []);
}

async function collectVpc(account) {
  const [vpcs, subnets, natGateways, securityGroups, internetGateways] = await Promise.all([
    degradeGracefully(account, 'VPC', () => awsApi.fetchVpcs(account), []),
    degradeGracefully(account, 'Subnets', () => awsApi.fetchSubnets(account), []),
    degradeGracefully(account, 'NAT Gateways', () => awsApi.fetchNatGateways(account), []),
    degradeGracefully(account, 'Security Groups', () => awsApi.fetchSecurityGroups(account), []),
    degradeGracefully(account, 'Internet Gateways', () => awsApi.fetchInternetGateways(account), []),
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

function appendMetricsHistory(accountId, { ec2, lightsail, ecs, s3Rows }) {
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

async function pollAccount(account) {
  try {
    const ec2 = await collectEc2(account);
    const lightsail = await collectLightsail(account);
    const ecs = await collectEcs(account);
    storeCore(account.id, { ec2, lightsail, ecs });

    const [rds, lambdaFns, dynamo, ecr, vpc] = await Promise.all([
      collectRds(account), collectLambda(account), collectDynamo(account), collectEcr(account), collectVpc(account),
    ]);
    storeR2(account.id, { rds, lambda: lambdaFns, dynamo, ecr, vpc });

    try {
      const bedrock = await collectBedrock(account);
      upsertBedrock(account.id, bedrock);
    } catch (err) {
      logger.warn(`[AwsPoller] ${account.name}: Bedrock usage collection failed: ${safeMsg(err)}`);
    }

    if (needsDaily(account.last_cost_capture_at)) {
      try {
        const cost = await awsApi.fetchCostAndUsage(account);
        upsertCost(account.id, cost);
        db.prepare('UPDATE aws_accounts SET last_cost_capture_at = datetime(\'now\') WHERE id = ?').run(account.id);
      } catch (err) {
        logger.warn(`[AwsPoller] ${account.name}: Cost Explorer capture failed: ${safeMsg(err)}`);
      }
    }

    let s3Rows = null;
    if (needsDaily(account.last_s3_capture_at)) {
      try {
        s3Rows = await collectS3(account);
        storeS3(account.id, s3Rows);
        db.prepare('UPDATE aws_accounts SET last_s3_capture_at = datetime(\'now\') WHERE id = ?').run(account.id);
      } catch (err) {
        logger.warn(`[AwsPoller] ${account.name}: S3 capture failed: ${safeMsg(err)}`);
      }
    }
    if (!s3Rows) {
      s3Rows = db.prepare('SELECT size_bytes FROM aws_s3_buckets WHERE account_id = ?').all(account.id)
        .map((r) => ({ sizeBytes: r.size_bytes }));
    }

    appendMetricsHistory(account.id, { ec2, lightsail, ecs, s3Rows });

    db.prepare(`
      UPDATE aws_accounts SET last_poll_status = 'success', last_poll_error = NULL,
        last_poll_at = datetime('now') WHERE id = ?
    `).run(account.id);
    logger.info(`[AwsPoller] ${account.name}: ${ec2.instances.length} EC2, ${lightsail.length} Lightsail, ${ecs.clusters.length} ECS cluster(s)`);
  } catch (err) {
    db.prepare(`
      UPDATE aws_accounts SET last_poll_status = 'error', last_poll_error = ?,
        last_poll_at = datetime('now') WHERE id = ?
    `).run(safeMsg(err), account.id);
    throw err;
  } finally {
    try { reconcileIssueHistory(); } catch (err) {
      logger.warn(`[AwsPoller] issue-history reconcile failed: ${err.message}`);
    }
  }
}

const awsPoller = createPoller({
  id: 'aws',
  loadSources: () => db.prepare('SELECT * FROM aws_accounts').all(),
  intervalMinutes: (a) => a.polling_interval_minutes,
  poll: pollAccount,
});

function initAwsPoller() {
  const sources = awsPoller.init();
  logger.info(`[AwsPoller] Initialized ${sources.length} AWS account(s)`);
  return awsPoller;
}

module.exports = { initAwsPoller, awsPoller, pollAccount };
