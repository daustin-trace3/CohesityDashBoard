// AWS poller — one scheduled task per registered account (framework
// per-source model, like vCenter/NetBackup). Every cycle: EC2 + EBS + per-
// instance CloudWatch metrics, Lightsail + its metrics/snapshots, ECS
// clusters/services + CloudWatch metrics, Bedrock usage (CloudWatch AWS/
// Bedrock). Cost Explorer and S3 (each with its own CloudWatch calls) are
// daily-gated behind last_cost_capture_at / last_s3_capture_at so we never
// burn more than one $0.01 Cost Explorer call per ~20h.
//
// Fix #0 (global-collector election): Cost Explorer and S3 ListBuckets are
// ACCOUNT-GLOBAL, not per-region, but every account row used to poll them,
// quadrupling stored data when several rows share one credential across
// regions (Doug's live setup: 4 regions, 1 account). Only the row with the
// lowest id among rows sharing the same effective access key id ("elected")
// runs Cost Explorer / S3 / their history+grouping collectors; every other
// row self-heals by deleting its own copies each cycle instead. RDS storage
// history and the AWS Service Health RSS feeds are unaffected (regional /
// estate-wide respectively) and run for every account (health is additionally
// module-level throttled to once per 15 minutes regardless of account count).
const { pruneInBatches } = require('../core/dbPrune');
const db = require('../db/database');
const { createPoller } = require('../core/pollerFramework');
const { mapLimit, valuesOrThrow, callsInFlight } = require('../core/concurrency');
const awsApi = require('./awsApi');
const { getSetting } = require('./settings');
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

// A service the account does not use, has not enabled, or is denied by an
// SCP must not fail the whole poll: log it, note it in the poll status and
// carry on with the next service. Only credential failures (an expired or
// unrecognised key, a refused AssumeRole) still fail the account, because
// every following call would fail the same way.
const CREDENTIAL_ERROR_RE = /ExpiredToken|InvalidClientTokenId|UnrecognizedClientException|SignatureDoesNotMatch|InvalidSignature|AuthFailure|CredentialsProviderError/i;
function isCredentialError(err) {
  const name = String(err?.name || err?.Code || '');
  const msg = String(err?.message || '');
  if (CREDENTIAL_ERROR_RE.test(name) || CREDENTIAL_ERROR_RE.test(msg)) return true;
  return /AccessDenied/i.test(name) && /AssumeRole/i.test(msg);
}
async function collectService(account, label, fn, fallback, skipped) {
  try {
    return await fn();
  } catch (err) {
    if (isCredentialError(err)) throw err;
    const reason = err?.name || err?.code || 'error';
    logger.warn(`[AwsPoller] ${account.name}: ${label} skipped (${reason}): ${safeMsg(err)}`);
    skipped.push(`${label} (${reason})`);
    return fallback;
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
function isElected(account) {
  const envKey = process.env.AWS_ACCESS_KEY_ID || '';
  const key = effectiveKeyId(account);
  const row = db.prepare(`
    SELECT MIN(id) AS minId FROM aws_accounts
    WHERE COALESCE(NULLIF(access_key_id, ''), ?) = ?
  `).get(envKey, key);
  return (row?.minId ?? account.id) === account.id;
}

/** Idempotent self-heal for a non-elected row: clear its duplicated global-collector data. */
function cleanupNonElectedGlobalRows(accountId) {
  db.prepare('DELETE FROM aws_cost_daily WHERE account_id = ?').run(accountId);
  db.prepare('DELETE FROM aws_cost_usage_daily WHERE account_id = ?').run(accountId);
  db.prepare('DELETE FROM aws_cost_instance_type_daily WHERE account_id = ?').run(accountId);
  db.prepare('DELETE FROM aws_cost_resource_daily WHERE account_id = ?').run(accountId);
  db.prepare('DELETE FROM aws_cost_resource_usage_daily WHERE account_id = ?').run(accountId);
  db.prepare('DELETE FROM aws_s3_buckets WHERE account_id = ?').run(accountId);
  db.prepare('DELETE FROM aws_s3_size_history WHERE account_id = ?').run(accountId);
}

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

// A refetched day replaces that day's legacy (service NULL) rows; days outside the fetch keep theirs.
const upsertCostUsageType = db.transaction((accountId, rows) => {
  const clearLegacy = db.prepare('DELETE FROM aws_cost_usage_daily WHERE account_id = ? AND day = ? AND service IS NULL');
  for (const day of new Set(rows.map((r) => r.day))) clearLegacy.run(accountId, day);
  const stmt = db.prepare(`
    INSERT INTO aws_cost_usage_daily (account_id, day, service, usage_type, amount_usd, amortized_usd, usage_qty, usage_unit)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(account_id, day, service, usage_type) DO UPDATE SET
      amount_usd = excluded.amount_usd, amortized_usd = excluded.amortized_usd,
      usage_qty = excluded.usage_qty, usage_unit = excluded.usage_unit
  `);
  for (const r of rows) {
    stmt.run(accountId, r.day, r.service, r.usageType, r.amountUsd, r.amortizedUsd ?? null, r.usageQty ?? null, r.usageUnit ?? null);
  }
});

const upsertCostResource = db.transaction((accountId, rows) => {
  const stmt = db.prepare(`
    INSERT INTO aws_cost_resource_daily (account_id, day, service, resource_id, amount_usd)
    VALUES (?, ?, ?, ?, ?)
    ON CONFLICT(account_id, day, service, resource_id) DO UPDATE SET amount_usd = excluded.amount_usd
  `);
  for (const r of rows) stmt.run(accountId, r.day, r.service, r.resourceId, r.amountUsd);
  db.prepare("DELETE FROM aws_cost_resource_daily WHERE day < date('now', '-90 days')").run();
});

const upsertCostResourceUsage = db.transaction((accountId, rows) => {
  const stmt = db.prepare(`
    INSERT INTO aws_cost_resource_usage_daily (account_id, day, usage_type, resource_id, amount_usd)
    VALUES (?, ?, ?, ?, ?)
    ON CONFLICT(account_id, day, usage_type, resource_id) DO UPDATE SET amount_usd = excluded.amount_usd
  `);
  for (const r of rows) stmt.run(accountId, r.day, r.usageType, r.resourceId, r.amountUsd);
  db.prepare("DELETE FROM aws_cost_resource_usage_daily WHERE day < date('now', '-90 days')").run();
});

const upsertCostInstanceType = db.transaction((accountId, rows) => {
  const stmt = db.prepare(`
    INSERT INTO aws_cost_instance_type_daily (account_id, day, instance_type, amount_usd, amortized_usd)
    VALUES (?, ?, ?, ?, ?)
    ON CONFLICT(account_id, day, instance_type) DO UPDATE SET
      amount_usd = excluded.amount_usd, amortized_usd = excluded.amortized_usd
  `);
  for (const r of rows) stmt.run(accountId, r.day, r.instanceType, r.amountUsd, r.amortizedUsd ?? null);
});

// ── AWS Service Health RSS (module-level, not per-account) ─────────────────

const HEALTH_GATE_MS = 15 * 60 * 1000;
const HEALTH_SERVICES = ['ec2', 's3', 'rds', 'lambda', 'dynamodb', 'ecs'];
let lastHealthFetchAt = null;

const upsertHealthEvents = db.transaction((feed, service, region, events) => {
  const stmt = db.prepare(`
    INSERT INTO aws_health_events (feed, service, region, title, summary, published_at, fetched_at)
    VALUES (?, ?, ?, ?, ?, ?, datetime('now'))
    ON CONFLICT(feed, title, published_at) DO UPDATE SET
      summary = excluded.summary, fetched_at = datetime('now')
  `);
  for (const e of events) stmt.run(feed, service, region, e.title, e.summary, e.publishedAt);
});

/** ISO timestamp of the last health-RSS sweep, or null before the first one. */
function getHealthLastCheckedAt() {
  return lastHealthFetchAt;
}

/** Guarded module-level sweep across every distinct account region × HEALTH_SERVICES. */
async function maybeCollectHealth() {
  if (lastHealthFetchAt && Date.now() - new Date(lastHealthFetchAt).getTime() < HEALTH_GATE_MS) return;
  lastHealthFetchAt = new Date().toISOString();
  const regions = db.prepare('SELECT DISTINCT region FROM aws_accounts WHERE region IS NOT NULL').all().map((r) => r.region);
  for (const region of regions) {
    for (const service of HEALTH_SERVICES) {
      try {
        const events = await awsApi.fetchHealthRss(service, region);
        if (events.length) upsertHealthEvents(`${service}-${region}`, service, region, events);
      } catch (err) {
        logger.debug(`[AwsPoller] health RSS sweep failed for ${service}-${region}: ${safeMsg(err)}`);
      }
    }
  }
  pruneInBatches(db, 'aws_health_events', "fetched_at < datetime('now', '-90 days')");
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

const EMPTY_LIGHTSAIL = () => ({
  instances: [], databases: [], disks: [], buckets: [], loadBalancers: [],
  distributions: [], domains: [], staticIps: [],
});

async function collectLightsail(account, skipped = [], elected = true) {
  const empty = EMPTY_LIGHTSAIL();
  let instances;
  let bundles = null;
  let dbBundles = null;
  try {
    // Bundle maps are an enrichment only: a failure leaves RAM and Windows to the instance itself.
    bundles = await awsApi.fetchLightsailBundles(account).catch((err) => {
      if (isCredentialError(err)) throw err;
      logger.debug(`[AwsPoller] ${account.name}: Lightsail bundles failed: ${safeMsg(err)}`);
      return null;
    });
    dbBundles = await awsApi.fetchLightsailDatabaseBundles(account).catch((err) => {
      if (isCredentialError(err)) throw err;
      logger.debug(`[AwsPoller] ${account.name}: Lightsail database bundles failed: ${safeMsg(err)}`);
      return null;
    });
    instances = await awsApi.fetchLightsailInstances(account, bundles);
  } catch (err) {
    // Lightsail has no endpoint in some regions (e.g. us-west-1) — the SDK
    // surfaces that as a DNS ENOTFOUND. Treat as "service not offered here".
    if (String(err.code || '').includes('ENOTFOUND') || String(err.message || '').includes('ENOTFOUND')) {
      logger.debug(`[AwsPoller] ${account.name}: Lightsail unavailable in ${account.region}: ${safeMsg(err)}`);
      return empty;
    }
    throw err;
  }
  await mapLimit(instances, callsInFlight('aws'), async (i) => {
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
  });

  // Each inventory family degrades on its own: one missing permission or endpoint skips only it.
  const family = (label, fn) => collectService(account, label, fn, [], skipped);
  const [databases, disks, buckets, loadBalancers, staticIps] = await Promise.all([
    family('Lightsail databases', () => awsApi.fetchLightsailDatabases(account, dbBundles)),
    family('Lightsail disks', () => awsApi.fetchLightsailDisks(account)),
    family('Lightsail buckets', () => awsApi.fetchLightsailBuckets(account)),
    family('Lightsail load balancers', () => awsApi.fetchLightsailLoadBalancers(account)),
    family('Lightsail static IPs', () => awsApi.fetchLightsailStaticIps(account)),
  ]);
  // Global resources (us-east-1 only): the elected account row collects them once per credential.
  let distributions = [];
  let domains = [];
  if (elected) {
    [distributions, domains] = await Promise.all([
      family('Lightsail distributions', () => awsApi.fetchLightsailDistributions(account)),
      family('Lightsail DNS zones', () => awsApi.fetchLightsailDomains(account)),
    ]);
  }
  return { instances, databases, disks, buckets, loadBalancers, distributions, domains, staticIps };
}

async function collectEcs(account) {
  const clusters = await awsApi.fetchEcsClusters(account);
  const services = [];
  const perCluster = await mapLimit(clusters, callsInFlight('aws'), async (c) => {
    const out = [];
    let svcs = [];
    try {
      svcs = await awsApi.fetchEcsServices(account, c.clusterArn);
    } catch (err) {
      logger.warn(`[AwsPoller] ${account.name}: ECS services failed for ${c.clusterName}: ${safeMsg(err)}`);
      return out;
    }
    let metrics = new Map();
    try {
      metrics = await awsApi.fetchEcsServiceMetrics(account, c.clusterName, svcs.map((s) => s.serviceName));
    } catch (err) {
      logger.debug(`[AwsPoller] ${account.name}: ECS service metrics failed for ${c.clusterName}: ${safeMsg(err)}`);
    }
    for (const s of svcs) {
      const m = metrics.get(s.serviceName);
      out.push({ ...s, clusterName: c.clusterName, cpuUtil: m?.cpuUtil ?? null, memoryUtil: m?.memoryUtil ?? null });
    }
    return out;
  });
  for (const v of valuesOrThrow(perCluster)) services.push(...v);
  return { clusters, services };
}

async function collectBedrock(account) {
  const modelIds = await awsApi.fetchBedrockModelIds(account);
  const rows = [];
  const perModel = await mapLimit(modelIds, callsInFlight('aws'), (modelId) => awsApi.fetchBedrockDailyUsage(account, modelId));
  valuesOrThrow(perModel).forEach((daily, i) => { for (const d of daily) rows.push({ modelId: modelIds[i], ...d }); });
  return rows;
}

async function collectS3(account) {
  const buckets = await awsApi.fetchS3Buckets(account);
  const perBucket = await mapLimit(buckets, callsInFlight('aws'), async (b) => {
    const region = await awsApi.fetchBucketLocation(account, b.name);
    const [publicAccessBlocked, versioning, lifecycleRules, storage] = await Promise.all([
      awsApi.fetchBucketPublicAccessBlocked(account, b.name, region),
      awsApi.fetchBucketVersioning(account, b.name, region),
      awsApi.fetchBucketLifecycleRuleCount(account, b.name, region),
      awsApi.fetchBucketStorageMetrics(account, b.name, region),
    ]);
    return {
      name: b.name, region, createdAtAws: b.createdAt,
      publicAccessBlocked: publicAccessBlocked ? 1 : 0, versioning, lifecycleRules,
      sizeBytes: storage.sizeBytes, objectCount: storage.objectCount,
    };
  });
  return valuesOrThrow(perBucket);
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
    const found = await mapLimit(names, callsInFlight('aws'), async (name) => {
      try {
        return await awsApi.fetchDynamoTable(account, name);
      } catch (err) {
        logger.debug(`[AwsPoller] ${account.name}: DynamoDB DescribeTable failed for ${name}: ${safeMsg(err)}`);
        return null;
      }
    });
    return found.map((r) => r.value).filter((t) => t != null);
  }, []);
}

async function collectEcr(account) {
  return degradeGracefully(account, 'ECR', async () => {
    const repos = await awsApi.fetchEcrRepos(account);
    await mapLimit(repos, callsInFlight('aws'), async (r) => {
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
    });
    return repos;
  }, []);
}

// ── Optimizer (Compute Optimizer + local heuristics) ────────────────────────

async function collectComputeOptimizer(account) {
  return degradeGracefully(account, 'Compute Optimizer', async () => {
    const enrollment = await awsApi.fetchCoEnrollmentStatus(account);
    let rows = [];
    if (enrollment.status === 'Active') {
      const [ec2, ebs, lambdaRecs, ecs] = await Promise.all([
        degradeGracefully(account, 'CO EC2 recommendations', () => awsApi.fetchCoEc2Recommendations(account), []),
        degradeGracefully(account, 'CO EBS recommendations', () => awsApi.fetchCoEbsRecommendations(account), []),
        degradeGracefully(account, 'CO Lambda recommendations', () => awsApi.fetchCoLambdaRecommendations(account), []),
        degradeGracefully(account, 'CO ECS recommendations', () => awsApi.fetchCoEcsRecommendations(account), []),
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

/** A price setting as a finite number, falling back to the constant the heuristics shipped with. */
function priceSetting(key, fallback) {
  const n = Number(getSetting(key));
  return Number.isFinite(n) && n >= 0 && getSetting(key) !== '' && getSetting(key) != null ? n : fallback;
}

const PREV_GEN_MAP = { t2: 't3', m3: 'm5', m4: 'm5', c3: 'c5', c4: 'c5', r3: 'r5', r4: 'r5' };
const PREV_GEN_RE = /^(t2|m3|m4|c3|c4|r3|r4)\./;

/**
 * Local savings heuristics computed from OUR tables for one account row —
 * gp2-to-gp3, ebs-unattached, stopped-ec2-ebs, prev-gen-type, nat-gateway-
 * consolidation always run; s3-no-lifecycle only when `elected` (S3 rows
 * only live on the elected row, see Fix #0 above).
 */
function computeHeuristicRecommendations(accountId, elected) {
  const rows = [];
  const gp2ToGp3PerGb = priceSetting('aws_price_gp2_to_gp3_per_gb', 0.02);
  const gp2PerGb = priceSetting('aws_price_ebs_gp2_per_gb', 0.10);
  const gp3PerGb = priceSetting('aws_price_ebs_gp3_per_gb', 0.08);
  const natPerMonth = priceSetting('aws_price_nat_gateway_month', 32.85);

  const volumes = db.prepare('SELECT volume_id, state, size_gb, volume_type, az FROM aws_ebs_volumes WHERE account_id = ?').all(accountId);
  for (const v of volumes) {
    if (v.volume_type === 'gp2') {
      rows.push({
        source: 'heuristic', resourceType: 'ebs', resourceId: v.volume_id, resourceName: null, region: v.az,
        finding: 'gp2-to-gp3', currentConfig: 'gp2', recommendedConfig: 'gp3',
        reason: 'gp2 volume type costs more than gp3 for equivalent performance',
        estMonthlySavingsUsd: (v.size_gb || 0) * gp2ToGp3PerGb,
      });
    }
    if (v.state === 'available') {
      const perGb = v.volume_type === 'gp2' ? gp2PerGb : gp3PerGb;
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
        "SELECT SUM(size_gb) AS s FROM aws_ebs_volumes WHERE account_id = ? AND attached_instance_id = ?"
      ).get(accountId, i.instance_id);
      const sizeGb = attached?.s || 0;
      if (sizeGb > 0) {
        rows.push({
          source: 'heuristic', resourceType: 'ec2', resourceId: i.instance_id, resourceName: null, region: i.az,
          finding: 'stopped-ec2-ebs', currentConfig: i.instance_type, recommendedConfig: null,
          reason: 'stopped instance still pays for attached EBS',
          estMonthlySavingsUsd: sizeGb * gp3PerGb,
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
        reason: `multiple NAT gateways ~$${natPerMonth}/mo each`,
        estMonthlySavingsUsd: (v.nat_gateway_count - 1) * natPerMonth,
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

// The Compute Optimizer and heuristic sources own their rows; the FinOps capture owns 'ce-rightsizing'
// and 'ce-savings-plan' (storeCeRecommendations), so each delete is scoped to its own sources.
const OPTIMIZER_SOURCES = ['compute-optimizer', 'heuristic'];
const CE_SOURCES = ['ce-rightsizing', 'ce-savings-plan'];

function insertOptimizerRows(accountId, rows) {
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
}

const storeOptimizerTxn = db.transaction((accountId, coEnrollment, rows) => {
  db.prepare("DELETE FROM aws_optimizer_recommendations WHERE account_id = ? AND source IN ('compute-optimizer', 'heuristic')").run(accountId);
  insertOptimizerRows(accountId, rows);
  db.prepare("UPDATE aws_accounts SET last_optimizer_capture_at = datetime('now'), co_enrollment = ? WHERE id = ?")
    .run(coEnrollment, accountId);
});

/** Replace the Compute Optimizer + heuristic rows, then track their lifecycle (open -> done when they vanish). */
function storeOptimizer(accountId, coEnrollment, rows) {
  storeOptimizerTxn(accountId, coEnrollment, rows);
  try {
    require('./awsFinops').reconcileRecommendationState(accountId, rows.map(trackedRow), { sources: OPTIMIZER_SOURCES });
  } catch (err) {
    logger.warn(`[AwsPoller] recommendation state reconcile failed: ${err.message}`);
  }
}

const trackedRow = (r) => ({
  source: r.source, finding: r.finding ?? null, resourceId: r.resourceId, estMonthlySavingsUsd: r.estMonthlySavingsUsd ?? null,
});

const storeCeRecommendationsTxn = db.transaction((accountId, rows, sources) => {
  const del = db.prepare('DELETE FROM aws_optimizer_recommendations WHERE account_id = ? AND source = ?');
  for (const source of sources) del.run(accountId, source);
  insertOptimizerRows(accountId, rows);
});

/**
 * Cost Explorer sourced recommendations (rightsizing, Savings Plan purchase), in optimizer-row shape
 * ({ source, resourceType, resourceId, resourceName, region, finding, currentConfig, recommendedConfig,
 * reason, estMonthlySavingsUsd }). Deletes only the ce-* sources, then reconciles their lifecycle state.
 * Only the sources named in `sources` are replaced (a capability that failed keeps its previous rows).
 */
function storeCeRecommendations(accountId, rows, { sources = CE_SOURCES } = {}) {
  storeCeRecommendationsTxn(accountId, rows, sources);
  try {
    require('./awsFinops').reconcileRecommendationState(accountId, rows.map(trackedRow), { sources });
  } catch (err) {
    logger.warn(`[AwsPoller] recommendation state reconcile failed: ${err.message}`);
  }
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

/** Wipe and reinsert the Lightsail inventory families (everything but instances) for one account. */
function storeLightsailInventory(accountId, ls) {
  const del = (table) => db.prepare(`DELETE FROM ${table} WHERE account_id = ?`).run(accountId);
  const prep = (sql) => db.prepare(sql);

  del('aws_lightsail_databases');
  const dbStmt = prep(`
    INSERT OR REPLACE INTO aws_lightsail_databases (account_id, name, arn, engine, engine_version, bundle,
      ram_gb, disk_gb, state, az, master_endpoint, port, backup_retention, publicly_accessible,
      latest_restorable_at, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  for (const d of ls.databases || []) {
    dbStmt.run(accountId, d.name, d.arn, d.engine, d.engineVersion, d.bundle, d.ramGb, d.diskGb, d.state,
      d.az, d.masterEndpoint, d.port, d.backupRetention, d.publiclyAccessible, d.latestRestorableAt, d.createdAt);
  }

  del('aws_lightsail_disks');
  const diskStmt = prep(`
    INSERT OR REPLACE INTO aws_lightsail_disks (account_id, name, arn, size_gb, state, attached_to,
      attachment_state, is_system_disk, iops, az, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  for (const d of ls.disks || []) {
    diskStmt.run(accountId, d.name, d.arn, d.sizeGb, d.state, d.attachedTo, d.attachmentState,
      d.isSystemDisk, d.iops, d.az, d.createdAt);
  }

  del('aws_lightsail_buckets');
  const bucketStmt = prep(`
    INSERT OR REPLACE INTO aws_lightsail_buckets (account_id, name, arn, bundle, state, object_versioning,
      read_only_access, able_to_update_bundle, url, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  for (const b of ls.buckets || []) {
    bucketStmt.run(accountId, b.name, b.arn, b.bundle, b.state, b.objectVersioning, b.readOnlyAccess,
      b.ableToUpdateBundle, b.url, b.createdAt);
  }

  del('aws_lightsail_load_balancers');
  const lbStmt = prep(`
    INSERT OR REPLACE INTO aws_lightsail_load_balancers (account_id, name, arn, dns_name, state, protocol,
      instance_port, health_check_path, attached_instances, healthy_count, unhealthy_count, tls_cert_name,
      tls_cert_attached, az, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  for (const l of ls.loadBalancers || []) {
    lbStmt.run(accountId, l.name, l.arn, l.dnsName, l.state, l.protocol, l.instancePort, l.healthCheckPath,
      l.attachedInstances, l.healthyCount, l.unhealthyCount, l.tlsCertName, l.tlsCertAttached, l.az, l.createdAt);
  }

  del('aws_lightsail_distributions');
  const distStmt = prep(`
    INSERT OR REPLACE INTO aws_lightsail_distributions (account_id, name, arn, status, is_enabled, domain_name,
      origin_name, origin_region, bundle, cert_name, alternative_domains, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  for (const d of ls.distributions || []) {
    distStmt.run(accountId, d.name, d.arn, d.status, d.isEnabled, d.domainName, d.originName, d.originRegion,
      d.bundle, d.certName, d.alternativeDomains, d.createdAt);
  }

  del('aws_lightsail_domains');
  const domStmt = prep(`
    INSERT OR REPLACE INTO aws_lightsail_domains (account_id, name, arn, entry_count, created_at)
    VALUES (?, ?, ?, ?, ?)
  `);
  for (const d of ls.domains || []) domStmt.run(accountId, d.name, d.arn, d.entryCount, d.createdAt);

  del('aws_lightsail_static_ips');
  const ipStmt = prep(`
    INSERT OR REPLACE INTO aws_lightsail_static_ips (account_id, name, arn, ip_address, is_attached,
      attached_to, az, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `);
  for (const s of ls.staticIps || []) {
    ipStmt.run(accountId, s.name, s.arn, s.ipAddress, s.isAttached, s.attachedTo, s.az, s.createdAt);
  }
}

const storeCore = db.transaction((accountId, { ec2, lightsail, ecs, lightsailInventory }) => {
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
      public_ip, cpu_util, snapshot_count, latest_snapshot_at, ram_gb, cpu_count, is_windows,
      arn, private_ip, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  for (const i of lightsail) {
    lsStmt.run(accountId, i.name, i.state, i.blueprint, i.bundle, i.az,
      i.publicIp, i.cpuUtil, i.snapshotCount, i.latestSnapshotAt,
      i.ramGb ?? null, i.cpuCount ?? null, i.isWindows ?? null, i.arn ?? null, i.privateIp ?? null, i.createdAt ?? null);
  }
  if (lightsailInventory) storeLightsailInventory(accountId, lightsailInventory);

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
    INSERT INTO aws_cost_daily (account_id, day, service, amount_usd, amortized_usd)
    VALUES (?, ?, ?, ?, ?)
    ON CONFLICT(account_id, day, service) DO UPDATE SET
      amount_usd = excluded.amount_usd, amortized_usd = excluded.amortized_usd
  `);
  for (const r of rows) stmt.run(accountId, r.day, r.service, r.amountUsd, r.amortizedUsd ?? null);
});

// -- FinOps upserts (round of 2026-10-27). The capture computes first, these only write. ----

/** Spend grouped by a tag / cost category / linked account: rows [{ day, value, service, amountUsd, amortizedUsd }]. */
const upsertCostAlloc = db.transaction((accountId, dimension, key, rows) => {
  const stmt = db.prepare(`
    INSERT INTO aws_cost_alloc_daily (account_id, day, dimension, key, value, service, amount_usd, amortized_usd)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(account_id, day, dimension, key, value, service) DO UPDATE SET
      amount_usd = excluded.amount_usd, amortized_usd = excluded.amortized_usd
  `);
  for (const r of rows) {
    stmt.run(accountId, r.day, dimension, key, r.value ?? '', r.service ?? '', r.amountUsd ?? null, r.amortizedUsd ?? null);
  }
});

const upsertSpUtilization = db.transaction((accountId, rows) => {
  const stmt = db.prepare(`
    INSERT INTO aws_sp_utilization_daily (account_id, day, utilization_pct, commitment_usd, used_usd, unused_usd,
      net_savings_usd, on_demand_equivalent_usd)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(account_id, day) DO UPDATE SET
      utilization_pct = excluded.utilization_pct, commitment_usd = excluded.commitment_usd,
      used_usd = excluded.used_usd, unused_usd = excluded.unused_usd,
      net_savings_usd = excluded.net_savings_usd, on_demand_equivalent_usd = excluded.on_demand_equivalent_usd
  `);
  for (const r of rows) {
    stmt.run(accountId, r.day, r.utilizationPct ?? null, r.commitmentUsd ?? null, r.usedUsd ?? null,
      r.unusedUsd ?? null, r.netSavingsUsd ?? null, r.onDemandEquivalentUsd ?? null);
  }
});

const upsertSpCoverage = db.transaction((accountId, rows) => {
  const stmt = db.prepare(`
    INSERT INTO aws_sp_coverage_daily (account_id, day, coverage_pct, covered_usd, on_demand_usd, total_usd)
    VALUES (?, ?, ?, ?, ?, ?)
    ON CONFLICT(account_id, day) DO UPDATE SET
      coverage_pct = excluded.coverage_pct, covered_usd = excluded.covered_usd,
      on_demand_usd = excluded.on_demand_usd, total_usd = excluded.total_usd
  `);
  for (const r of rows) stmt.run(accountId, r.day, r.coveragePct ?? null, r.coveredUsd ?? null, r.onDemandUsd ?? null, r.totalUsd ?? null);
});

const upsertRiUtilization = db.transaction((accountId, rows) => {
  const stmt = db.prepare(`
    INSERT INTO aws_ri_utilization_daily (account_id, day, utilization_pct, purchased_hours, used_hours, unused_hours, net_savings_usd)
    VALUES (?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(account_id, day) DO UPDATE SET
      utilization_pct = excluded.utilization_pct, purchased_hours = excluded.purchased_hours,
      used_hours = excluded.used_hours, unused_hours = excluded.unused_hours, net_savings_usd = excluded.net_savings_usd
  `);
  for (const r of rows) {
    stmt.run(accountId, r.day, r.utilizationPct ?? null, r.purchasedHours ?? null, r.usedHours ?? null,
      r.unusedHours ?? null, r.netSavingsUsd ?? null);
  }
});

const upsertRiCoverage = db.transaction((accountId, rows) => {
  const stmt = db.prepare(`
    INSERT INTO aws_ri_coverage_daily (account_id, day, coverage_pct, reserved_hours, on_demand_hours, total_hours)
    VALUES (?, ?, ?, ?, ?, ?)
    ON CONFLICT(account_id, day) DO UPDATE SET
      coverage_pct = excluded.coverage_pct, reserved_hours = excluded.reserved_hours,
      on_demand_hours = excluded.on_demand_hours, total_hours = excluded.total_hours
  `);
  for (const r of rows) stmt.run(accountId, r.day, r.coveragePct ?? null, r.reservedHours ?? null, r.onDemandHours ?? null, r.totalHours ?? null);
});

/** Savings Plan inventory: the details call is the whole truth for the window, so replace per account. */
const upsertSavingsPlans = db.transaction((accountId, rows) => {
  db.prepare('DELETE FROM aws_savings_plans WHERE account_id = ?').run(accountId);
  const stmt = db.prepare(`
    INSERT OR REPLACE INTO aws_savings_plans (account_id, sp_arn, sp_type, payment_option, term, hourly_commitment_usd,
      region, instance_family, start_at, end_at, utilization_pct, net_savings_usd)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  for (const r of rows) {
    stmt.run(accountId, r.spArn, r.spType ?? null, r.paymentOption ?? null, r.term ?? null, r.hourlyCommitmentUsd ?? null,
      r.region ?? null, r.instanceFamily ?? null, r.startAt ?? null, r.endAt ?? null, r.utilizationPct ?? null, r.netSavingsUsd ?? null);
  }
});

/**
 * AWS Cost Anomaly Detection rows (source 'aws'). rows come from awsApi.fetchAnomalies; monitors
 * (optional, from fetchAnomalyMonitors) name the monitor and its dimension. A row is open while it has
 * no end day; first_seen_at survives updates. ICC's own rows (source 'icc') are written by awsFinops.
 */
const upsertAnomalies = db.transaction((accountId, rows, monitors = []) => {
  const byArn = new Map((monitors || []).map((m) => [m.monitorArn, m]));
  const stmt = db.prepare(`
    INSERT INTO aws_cost_anomalies (account_id, anomaly_id, source, monitor_arn, monitor_name, scope, scope_key,
      start_day, end_day, actual_usd, expected_usd, impact_usd, impact_pct, root_causes_json, feedback, status,
      first_seen_at, last_seen_at)
    VALUES (?, ?, 'aws', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(account_id, anomaly_id) DO UPDATE SET
      monitor_arn = excluded.monitor_arn, monitor_name = excluded.monitor_name, scope = excluded.scope,
      scope_key = excluded.scope_key, start_day = excluded.start_day, end_day = excluded.end_day,
      actual_usd = excluded.actual_usd, expected_usd = excluded.expected_usd, impact_usd = excluded.impact_usd,
      impact_pct = excluded.impact_pct, root_causes_json = excluded.root_causes_json, feedback = excluded.feedback,
      status = excluded.status, last_seen_at = excluded.last_seen_at
  `);
  const nowStamp = new Date().toISOString();
  for (const r of rows) {
    const mon = byArn.get(r.monitorArn);
    const scopeKey = r.dimensionValue || r.rootCauses?.[0]?.service || mon?.name || 'account';
    const scope = String(mon?.dimension || (r.dimensionValue ? 'service' : 'custom')).toLowerCase();
    stmt.run(accountId, r.anomalyId, r.monitorArn ?? null, mon?.name ?? null, scope, scopeKey,
      r.startDay || String(new Date().toISOString().slice(0, 10)), r.endDay ?? null,
      r.actualUsd ?? null, r.expectedUsd ?? null, r.impactUsd ?? null, r.impactPct ?? null,
      JSON.stringify(r.rootCauses || []), r.feedback ?? null, r.endDay ? 'closed' : 'open', nowStamp, nowStamp);
  }
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
  pruneInBatches(db, 'aws_metrics_history', "account_id = ? AND captured_at < datetime('now', '-365 days')", [accountId]);
}

/**
 * Resource-level cost (14-day window). A sub-feature of the daily capture: a failure here is
 * recorded on the account row and never fails the account or lands in the skipped list.
 */
async function captureCostResources(account, serviceRows) {
  const setStatus = db.prepare('UPDATE aws_accounts SET cost_resources_status = ?, cost_resources_error = ? WHERE id = ?');
  if (getSetting('aws_cost_resources_enabled') === '0') {
    setStatus.run('off', null, account.id);
    return;
  }
  const maxPages = Math.min(50, Math.max(1, parseInt(getSetting('aws_cost_resources_max_pages'), 10) || 10));
  const services = [...new Set((serviceRows || []).map((r) => r.service).filter(Boolean))];
  try {
    const { rows } = await awsApi.fetchCostByResource(account, { maxPages, services });
    upsertCostResource(account.id, rows);
    const usage = await awsApi.fetchCostByResourceUsage(account, { maxPages, services });
    upsertCostResourceUsage(account.id, usage.rows);
    setStatus.run('ok', null, account.id);
  } catch (err) {
    if (isCredentialError(err)) throw err;
    setStatus.run(awsApi.classifyCostResourceError(err), String(err?.message || err).slice(0, 500), account.id);
    logger.warn(`[AwsPoller] ${account.name}: resource-level cost capture failed: ${safeMsg(err)}`);
  }
}

async function pollAccount(account) {
  // Pasted session credentials carry an expiry; once past it every call would
  // fail with ExpiredToken, so record the state and skip the round.
  // The typed expiry is advisory (issues warn on it); AWS decides whether the
  // token still works, and an ExpiredToken answer ends the round in 'error'
  // with a plain message. A wrong or wrong-zone expiry must not block polling.
  if (awsApi.credentialExpired(account)) {
    logger.warn(`[AwsPoller] ${account.name}: session credentials are past their entered expiry (${account.credential_expires_at}); polling anyway`);
  }
  try {
    // Round 10: remember the account number (STS caller identity) so LogicMonitor Direct Connect
    // rows can be tied to this account. Best effort, UNVERIFIED live.
    try {
      const num = await awsApi.fetchCallerAccount(account);
      if (num && num !== account.account_number) db.prepare('UPDATE aws_accounts SET account_number = ? WHERE id = ?').run(num, account.id);
    } catch { /* identity is optional */ }
    try {
      await maybeCollectHealth();
    } catch (err) {
      logger.debug(`[AwsPoller] health RSS sweep failed: ${safeMsg(err)}`);
    }

    // Services the account lacks are skipped, not fatal (see collectService).
    const skipped = [];
    const ec2 = await collectService(account, 'EC2', () => collectEc2(account), { instances: [], volumes: [] }, skipped);
    const lightsailInventory = await collectService(account, 'Lightsail',
      () => collectLightsail(account, skipped, isElected(account)), EMPTY_LIGHTSAIL(), skipped);
    const lightsail = lightsailInventory.instances;
    const ecs = await collectService(account, 'ECS', () => collectEcs(account), { clusters: [], services: [] }, skipped);
    storeCore(account.id, { ec2, lightsail, ecs, lightsailInventory });

    const [rds, lambdaFns, dynamo, ecr, vpc] = await Promise.all([
      collectService(account, 'RDS', () => collectRds(account), [], skipped),
      collectService(account, 'Lambda', () => collectLambda(account), [], skipped),
      collectService(account, 'DynamoDB', () => collectDynamo(account), [], skipped),
      collectService(account, 'ECR', () => collectEcr(account), [], skipped),
      collectService(account, 'VPC', () => collectVpc(account), { vpcs: [], subnets: [] }, skipped),
    ]);
    storeR2(account.id, { rds, lambda: lambdaFns, dynamo, ecr, vpc });

    upsertRdsStorageHistory(account.id, rds);
    pruneInBatches(db, 'aws_rds_storage_history', "account_id = ? AND day < date('now', '-365 days')", [account.id]);

    try {
      const bedrock = await collectBedrock(account);
      upsertBedrock(account.id, bedrock);
    } catch (err) {
      if (isCredentialError(err)) throw err;
      logger.warn(`[AwsPoller] ${account.name}: Bedrock usage collection failed: ${safeMsg(err)}`);
      skipped.push(`Bedrock (${err?.name || 'error'})`);
    }

    const elected = isElected(account);
    let s3Rows = null;

    if (elected) {
      if (needsDaily(account.last_cost_capture_at)) {
        try {
          const cost = await awsApi.fetchCostAndUsage(account);
          upsertCost(account.id, cost);
          const usageTypeCost = await awsApi.fetchCostByUsageType(account);
          upsertCostUsageType(account.id, usageTypeCost);
          const instanceTypeCost = await awsApi.fetchCostByInstanceType(account);
          upsertCostInstanceType(account.id, instanceTypeCost.filter((r) => r.instanceType && r.instanceType !== 'NoInstanceType'));
          await captureCostResources(account, cost);
          db.prepare('UPDATE aws_accounts SET last_cost_capture_at = datetime(\'now\') WHERE id = ?').run(account.id);
        } catch (err) {
          if (isCredentialError(err)) throw err;
          logger.warn(`[AwsPoller] ${account.name}: Cost Explorer capture failed: ${safeMsg(err)}`);
          skipped.push(`Cost Explorer (${err?.name || 'error'})`);
        }
      }

      if (needsDaily(account.last_s3_capture_at)) {
        try {
          s3Rows = await collectS3(account);
          storeS3(account.id, s3Rows);
          upsertS3SizeHistory(account.id, s3Rows);
          db.prepare('UPDATE aws_accounts SET last_s3_capture_at = datetime(\'now\') WHERE id = ?').run(account.id);
        } catch (err) {
          if (isCredentialError(err)) throw err;
          logger.warn(`[AwsPoller] ${account.name}: S3 capture failed: ${safeMsg(err)}`);
          skipped.push(`S3 (${err?.name || 'error'})`);
        }
      }
      if (!s3Rows) {
        s3Rows = db.prepare('SELECT size_bytes FROM aws_s3_buckets WHERE account_id = ?').all(account.id)
          .map((r) => ({ sizeBytes: r.size_bytes }));
      }
      db.prepare("DELETE FROM aws_s3_size_history WHERE account_id = ? AND day < date('now', '-365 days')").run(account.id);

      // FinOps block (forecast, commitments, anomalies, allocation, budgets, recommendations):
      // one daily stamp for the whole block, each capability degrades on its own inside it.
      if (needsDaily(account.last_finops_capture_at)) {
        try {
          await require('./awsFinops').captureFinops(account, { skipped });
        } catch (err) {
          if (isCredentialError(err)) throw err;
          logger.warn(`[AwsPoller] ${account.name}: FinOps capture failed: ${safeMsg(err)}`);
          skipped.push(`FinOps (${err?.name || 'error'})`);
        }
      }
    } else {
      // Non-elected row: another account with the same credential owns Cost
      // Explorer / S3 this cycle — self-heal any previously duplicated data.
      cleanupNonElectedGlobalRows(account.id);
      s3Rows = [];
    }

    if (needsDaily(account.last_optimizer_capture_at)) {
      try {
        const co = await collectComputeOptimizer(account);
        const heuristics = computeHeuristicRecommendations(account.id, elected);
        const rows = [...co.rows.map((r) => ({ ...r, source: 'compute-optimizer' })), ...heuristics];
        storeOptimizer(account.id, co.status, rows);
      } catch (err) {
        if (isCredentialError(err)) throw err;
        logger.warn(`[AwsPoller] ${account.name}: Optimizer capture failed: ${safeMsg(err)}`);
        skipped.push(`Compute Optimizer (${err?.name || 'error'})`);
      }
    }

    appendMetricsHistory(account.id, { ec2, lightsail, ecs, s3Rows });

    // 'partial' = the poll finished but one or more services were skipped;
    // the note lists them so Settings can show what the account lacks.
    db.prepare(`
      UPDATE aws_accounts SET last_poll_status = ?, last_poll_error = ?,
        last_poll_at = datetime('now') WHERE id = ?
    `).run(skipped.length ? 'partial' : 'success', skipped.length ? `Skipped: ${skipped.join('; ')}` : null, account.id);
    logger.info(`[AwsPoller] ${account.name}: ${ec2.instances.length} EC2, ${lightsail.length} Lightsail (${lightsailInventory.databases.length} db, ${lightsailInventory.disks.length} disks, ${lightsailInventory.buckets.length} buckets, ${lightsailInventory.loadBalancers.length} lb), ${ecs.clusters.length} ECS cluster(s)${skipped.length ? `; skipped ${skipped.join(', ')}` : ''}`);
  } catch (err) {
    db.prepare(`
      UPDATE aws_accounts SET last_poll_status = 'error', last_poll_error = ?,
        last_poll_at = datetime('now') WHERE id = ?
    `).run(err?.response ? safeMsg(err) : awsApi.explainAuthError(err, account), account.id);
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

module.exports = {
  _collectService: collectService, _isCredentialError: isCredentialError,
  initAwsPoller, awsPoller, pollAccount,
  isElected, cleanupNonElectedGlobalRows,
  upsertS3SizeHistory, upsertRdsStorageHistory, upsertCostUsageType, upsertCostInstanceType, upsertCostResource, upsertCostResourceUsage, captureCostResources,
  getHealthLastCheckedAt, HEALTH_SERVICES,
  collectComputeOptimizer, computeHeuristicRecommendations, storeOptimizer,
  needsDaily, storeCeRecommendations, upsertCost, upsertCostAlloc, upsertSpUtilization, upsertSpCoverage,
  upsertRiUtilization, upsertRiCoverage, upsertSavingsPlans, upsertAnomalies,
};
