// AWS API client. One SDK v3 client per service, built per-account: stored
// credentials (encrypted_credentials -> secretAccessKey, access_key_id
// plaintext) take priority; a row with blank/NULL creds falls back to
// process.env.AWS_ACCESS_KEY_ID / AWS_SECRET_ACCESS_KEY (the "env mode" seam
// router.js reports as credSource). All fetchers are failure-tolerant:
// optional chaining, default 0/null, never throw on a missing/empty field —
// only on the underlying AWS call itself.
//
// SPECIAL DISPENSATION for this plugin: the @aws-sdk/client-* packages (11 of
// them, same versions as backend/package.json) are pre-installed in
// plugin-sdk/node_modules, so esbuild bundles them into the backend .cjs —
// every @aws-sdk require below is kept VERBATIM from backend/services/
// awsApi.js. The ONLY deviation is fetchHealthRss: the built-in used axios +
// fast-xml-parser, neither of which is available to a bundled plugin
// (esbuild has nothing to resolve them from plugin-sdk's dependency tree).
// Re-implemented on Node's built-in `https` (dell/unifi rawRequest pattern)
// with a small regex-based <item> extractor — status.aws.amazon.com's feed
// is simple, unnamespaced RSS 2.0, so a full XML parser is unnecessary.
// Every function now threads `coreApi` through for decrypt/logging instead
// of requiring host modules directly.
const https = require('https');
const { EC2Client, DescribeInstancesCommand, DescribeVolumesCommand,
  DescribeVpcsCommand, DescribeSubnetsCommand, DescribeNatGatewaysCommand,
  DescribeSecurityGroupsCommand, DescribeInternetGatewaysCommand,
} = require('@aws-sdk/client-ec2');
const {
  LightsailClient, GetInstancesCommand, GetInstanceMetricDataCommand, GetInstanceSnapshotsCommand,
} = require('@aws-sdk/client-lightsail');
const {
  ECSClient, ListClustersCommand, DescribeClustersCommand, ListServicesCommand, DescribeServicesCommand,
} = require('@aws-sdk/client-ecs');
const {
  S3Client, ListBucketsCommand, GetBucketLocationCommand, GetPublicAccessBlockCommand,
  GetBucketVersioningCommand, GetBucketLifecycleConfigurationCommand,
} = require('@aws-sdk/client-s3');
const { CloudWatchClient, ListMetricsCommand, GetMetricDataCommand } = require('@aws-sdk/client-cloudwatch');
const { CostExplorerClient, GetCostAndUsageCommand } = require('@aws-sdk/client-cost-explorer');
const { RDSClient, DescribeDBInstancesCommand } = require('@aws-sdk/client-rds');
const { LambdaClient, ListFunctionsCommand } = require('@aws-sdk/client-lambda');
const {
  DynamoDBClient, ListTablesCommand, DescribeTableCommand,
} = require('@aws-sdk/client-dynamodb');
const { ECRClient, DescribeRepositoriesCommand, DescribeImagesCommand } = require('@aws-sdk/client-ecr');
const {
  ComputeOptimizerClient, GetEnrollmentStatusCommand, GetEC2InstanceRecommendationsCommand,
  GetEBSVolumeRecommendationsCommand, GetLambdaFunctionRecommendationsCommand, GetECSServiceRecommendationsCommand,
} = require('@aws-sdk/client-compute-optimizer');

/** Resolve { accessKeyId, secretAccessKey } for an account row (or unsaved candidate). */
function creds(account, coreApi) {
  // Unsaved test candidates carry a plaintext secretAccessKey.
  if (account.secretAccessKey) {
    return { accessKeyId: account.accessKeyId || account.access_key_id, secretAccessKey: account.secretAccessKey };
  }
  if (account.access_key_id && account.encrypted_credentials) {
    try {
      const c = JSON.parse(coreApi.encryption.decrypt(account.encrypted_credentials));
      if (c.secretAccessKey) return { accessKeyId: account.access_key_id, secretAccessKey: c.secretAccessKey };
    } catch (err) {
      coreApi.logger.warn(`[awsApi] decrypt failed for account ${account.name || account.id}: ${err.message}`);
    }
  }
  return { accessKeyId: process.env.AWS_ACCESS_KEY_ID, secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY };
}

/** 'stored' | 'env' | 'none' — never the secret itself. */
function credSource(account) {
  if (account.access_key_id && account.encrypted_credentials) return 'stored';
  if (process.env.AWS_ACCESS_KEY_ID && process.env.AWS_SECRET_ACCESS_KEY) return 'env';
  return 'none';
}

function clientConfig(account, coreApi, region) {
  const { accessKeyId, secretAccessKey } = creds(account, coreApi);
  const cfg = { region: region || account.region || 'us-east-2' };
  if (accessKeyId && secretAccessKey) cfg.credentials = { accessKeyId, secretAccessKey };
  return cfg;
}

const ec2Client = (account, coreApi) => new EC2Client(clientConfig(account, coreApi));
const lightsailClient = (account, coreApi) => new LightsailClient(clientConfig(account, coreApi));
const ecsClient = (account, coreApi) => new ECSClient(clientConfig(account, coreApi));
const s3Client = (account, coreApi, region) => new S3Client(clientConfig(account, coreApi, region));
const cloudwatchClient = (account, coreApi, region) => new CloudWatchClient(clientConfig(account, coreApi, region));
// Cost Explorer is a global service reachable only via us-east-1.
const costExplorerClient = (account, coreApi) => new CostExplorerClient(clientConfig(account, coreApi, 'us-east-1'));
const rdsClient = (account, coreApi) => new RDSClient(clientConfig(account, coreApi));
const lambdaClient = (account, coreApi) => new LambdaClient(clientConfig(account, coreApi));
const dynamoClient = (account, coreApi) => new DynamoDBClient(clientConfig(account, coreApi));
const ecrClient = (account, coreApi) => new ECRClient(clientConfig(account, coreApi));
const computeOptimizerClient = (account, coreApi) => new ComputeOptimizerClient(clientConfig(account, coreApi));

// ── EC2 ──────────────────────────────────────────────────────────────────────

async function fetchEc2Instances(account, coreApi) {
  const client = ec2Client(account, coreApi);
  const instances = [];
  let nextToken;
  do {
    const resp = await client.send(new DescribeInstancesCommand({ NextToken: nextToken }));
    for (const r of resp?.Reservations || []) {
      for (const i of r?.Instances || []) {
        const nameTag = (i.Tags || []).find((t) => t.Key === 'Name');
        instances.push({
          instanceId: i.InstanceId,
          name: nameTag?.Value || null,
          state: i.State?.Name || null,
          instanceType: i.InstanceType || null,
          az: i.Placement?.AvailabilityZone || null,
          privateIp: i.PrivateIpAddress || null,
          publicIp: i.PublicIpAddress || null,
          platform: i.PlatformDetails || i.Platform || null,
          launchTime: i.LaunchTime ? new Date(i.LaunchTime).toISOString() : null,
        });
      }
    }
    nextToken = resp?.NextToken;
  } while (nextToken);
  return instances;
}

async function fetchEbsVolumes(account, coreApi) {
  const client = ec2Client(account, coreApi);
  const volumes = [];
  let nextToken;
  do {
    const resp = await client.send(new DescribeVolumesCommand({ NextToken: nextToken }));
    for (const v of resp?.Volumes || []) {
      volumes.push({
        volumeId: v.VolumeId,
        state: v.State || null,
        sizeGb: v.Size ?? null,
        volumeType: v.VolumeType || null,
        az: v.AvailabilityZone || null,
        attachedInstanceId: v.Attachments?.[0]?.InstanceId || null,
      });
    }
    nextToken = resp?.NextToken;
  } while (nextToken);
  return volumes;
}

/**
 * Per-instance CPUUtilization average + StatusCheckFailed max over the last
 * 15 minutes, via one batched GetMetricData call. Returns
 * Map(instanceId -> { cpuUtil, statusCheck }). Failure-tolerant — an empty
 * instance list or a CloudWatch error yields an empty map.
 */
async function fetchEc2Metrics(account, coreApi, instanceIds) {
  const out = new Map();
  if (!instanceIds?.length) return out;
  const client = cloudwatchClient(account, coreApi);
  const endTime = new Date();
  const startTime = new Date(endTime.getTime() - 15 * 60000);
  const queries = [];
  instanceIds.forEach((id, idx) => {
    queries.push({
      Id: `cpu${idx}`,
      MetricStat: {
        Metric: { Namespace: 'AWS/EC2', MetricName: 'CPUUtilization', Dimensions: [{ Name: 'InstanceId', Value: id }] },
        Period: 900, Stat: 'Average',
      },
      ReturnData: true,
    });
    queries.push({
      Id: `sc${idx}`,
      MetricStat: {
        Metric: { Namespace: 'AWS/EC2', MetricName: 'StatusCheckFailed', Dimensions: [{ Name: 'InstanceId', Value: id }] },
        Period: 900, Stat: 'Maximum',
      },
      ReturnData: true,
    });
  });
  // GetMetricData caps at 500 queries per call.
  for (let i = 0; i < queries.length; i += 500) {
    const chunk = queries.slice(i, i + 500);
    const resp = await client.send(new GetMetricDataCommand({
      StartTime: startTime, EndTime: endTime, MetricDataQueries: chunk,
    }));
    for (const r of resp?.MetricDataResults || []) {
      const idx = Number(r.Id.replace(/^\D+/, ''));
      const instanceId = instanceIds[idx];
      if (!instanceId) continue;
      const val = r.Values?.[0] ?? null;
      if (!out.has(instanceId)) out.set(instanceId, { cpuUtil: null, statusCheck: null });
      const entry = out.get(instanceId);
      if (r.Id.startsWith('cpu')) entry.cpuUtil = val;
      else if (r.Id.startsWith('sc')) entry.statusCheck = val != null ? (val > 0 ? 'failed' : 'ok') : null;
    }
  }
  return out;
}

// ── Lightsail ────────────────────────────────────────────────────────────────

async function fetchLightsailInstances(account, coreApi) {
  const client = lightsailClient(account, coreApi);
  const instances = [];
  let pageToken;
  do {
    const resp = await client.send(new GetInstancesCommand({ pageToken }));
    for (const i of resp?.instances || []) {
      instances.push({
        name: i.name,
        state: i.state?.name || null,
        blueprint: i.blueprintName || null,
        bundle: i.bundleId || null,
        az: i.location?.availabilityZone || null,
        publicIp: i.publicIpAddress || null,
      });
    }
    pageToken = resp?.nextPageToken;
  } while (pageToken);
  return instances;
}

/** Average CPUUtilization over the last 15 minutes, per Lightsail instance name. */
async function fetchLightsailMetric(account, coreApi, instanceName) {
  try {
    const client = lightsailClient(account, coreApi);
    const endTime = new Date();
    const startTime = new Date(endTime.getTime() - 15 * 60000);
    const resp = await client.send(new GetInstanceMetricDataCommand({
      instanceName, metricName: 'CPUUtilization',
      period: 900, startTime, endTime, unit: 'Percent', statistics: ['Average'],
    }));
    const points = resp?.metricData || [];
    if (!points.length) return null;
    points.sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp));
    return points[0]?.average ?? null;
  } catch (err) {
    coreApi.logger.debug(`[awsApi] Lightsail metric fetch failed for ${instanceName}: ${err.message}`);
    return null;
  }
}

/** { count, latestAt } for an instance's snapshots. */
async function fetchLightsailSnapshots(account, coreApi, instanceName) {
  try {
    const client = lightsailClient(account, coreApi);
    const snaps = [];
    let pageToken;
    do {
      const resp = await client.send(new GetInstanceSnapshotsCommand({ pageToken }));
      for (const s of resp?.instanceSnapshots || []) {
        if (s.fromInstanceName === instanceName) snaps.push(s);
      }
      pageToken = resp?.nextPageToken;
    } while (pageToken);
    const latest = snaps.reduce((max, s) => {
      const t = s.createdAt ? new Date(s.createdAt).getTime() : 0;
      return t > max ? t : max;
    }, 0);
    return { count: snaps.length, latestAt: latest ? new Date(latest).toISOString() : null };
  } catch (err) {
    coreApi.logger.debug(`[awsApi] Lightsail snapshot fetch failed for ${instanceName}: ${err.message}`);
    return { count: 0, latestAt: null };
  }
}

// ── ECS ──────────────────────────────────────────────────────────────────────

async function fetchEcsClusters(account, coreApi) {
  const client = ecsClient(account, coreApi);
  const arns = [];
  let nextToken;
  do {
    const resp = await client.send(new ListClustersCommand({ nextToken }));
    arns.push(...(resp?.clusterArns || []));
    nextToken = resp?.nextToken;
  } while (nextToken);
  if (!arns.length) return [];
  const clusters = [];
  for (let i = 0; i < arns.length; i += 100) {
    const chunk = arns.slice(i, i + 100);
    const resp = await client.send(new DescribeClustersCommand({ clusters: chunk }));
    for (const c of resp?.clusters || []) {
      clusters.push({
        clusterArn: c.clusterArn,
        clusterName: c.clusterName || null,
        status: c.status || null,
        runningTasks: c.runningTasksCount ?? null,
        pendingTasks: c.pendingTasksCount ?? null,
        serviceCount: c.activeServicesCount ?? null,
        containerInstances: c.registeredContainerInstancesCount ?? null,
      });
    }
  }
  return clusters;
}

/** Services for one cluster, batched ≤10 ARNs per DescribeServices call. */
async function fetchEcsServices(account, coreApi, clusterArn) {
  const client = ecsClient(account, coreApi);
  const arns = [];
  let nextToken;
  do {
    const resp = await client.send(new ListServicesCommand({ cluster: clusterArn, nextToken }));
    arns.push(...(resp?.serviceArns || []));
    nextToken = resp?.nextToken;
  } while (nextToken);
  if (!arns.length) return [];
  const services = [];
  for (let i = 0; i < arns.length; i += 10) {
    const chunk = arns.slice(i, i + 10);
    const resp = await client.send(new DescribeServicesCommand({ cluster: clusterArn, services: chunk }));
    for (const s of resp?.services || []) {
      services.push({
        serviceName: s.serviceName || null,
        status: s.status || null,
        desiredCount: s.desiredCount ?? null,
        runningCount: s.runningCount ?? null,
        pendingCount: s.pendingCount ?? null,
        launchType: s.launchType || s.capacityProviderStrategy?.[0]?.capacityProvider || null,
      });
    }
  }
  return services;
}

/** Per-service CPU/MemoryUtilization average over the last 15 minutes, AWS/ECS namespace. */
async function fetchEcsServiceMetrics(account, coreApi, clusterName, serviceNames) {
  const out = new Map();
  if (!serviceNames?.length) return out;
  try {
    const client = cloudwatchClient(account, coreApi);
    const endTime = new Date();
    const startTime = new Date(endTime.getTime() - 15 * 60000);
    const queries = [];
    serviceNames.forEach((name, idx) => {
      for (const [prefix, metric] of [['cpu', 'CPUUtilization'], ['mem', 'MemoryUtilization']]) {
        queries.push({
          Id: `${prefix}${idx}`,
          MetricStat: {
            Metric: {
              Namespace: 'AWS/ECS', MetricName: metric,
              Dimensions: [{ Name: 'ClusterName', Value: clusterName }, { Name: 'ServiceName', Value: name }],
            },
            Period: 900, Stat: 'Average',
          },
          ReturnData: true,
        });
      }
    });
    for (let i = 0; i < queries.length; i += 500) {
      const chunk = queries.slice(i, i + 500);
      const resp = await client.send(new GetMetricDataCommand({ StartTime: startTime, EndTime: endTime, MetricDataQueries: chunk }));
      for (const r of resp?.MetricDataResults || []) {
        const idx = Number(r.Id.replace(/^\D+/, ''));
        const name = serviceNames[idx];
        if (!name) continue;
        if (!out.has(name)) out.set(name, { cpuUtil: null, memoryUtil: null });
        const entry = out.get(name);
        const val = r.Values?.[0] ?? null;
        if (r.Id.startsWith('cpu')) entry.cpuUtil = val;
        else if (r.Id.startsWith('mem')) entry.memoryUtil = val;
      }
    }
  } catch (err) {
    coreApi.logger.debug(`[awsApi] ECS service metrics fetch failed for cluster ${clusterName}: ${err.message}`);
  }
  return out;
}

// ── S3 ───────────────────────────────────────────────────────────────────────

async function fetchS3Buckets(account, coreApi) {
  const client = s3Client(account, coreApi);
  const resp = await client.send(new ListBucketsCommand({}));
  return (resp?.Buckets || []).map((b) => ({ name: b.Name, createdAt: b.CreationDate ? new Date(b.CreationDate).toISOString() : null }));
}

async function fetchBucketLocation(account, coreApi, bucketName) {
  try {
    const client = s3Client(account, coreApi);
    const resp = await client.send(new GetBucketLocationCommand({ Bucket: bucketName }));
    return resp?.LocationConstraint || 'us-east-1';
  } catch (err) {
    coreApi.logger.debug(`[awsApi] GetBucketLocation failed for ${bucketName}: ${err.message}`);
    return 'us-east-1';
  }
}

async function fetchBucketPublicAccessBlocked(account, coreApi, bucketName, region) {
  try {
    const client = s3Client(account, coreApi, region);
    const resp = await client.send(new GetPublicAccessBlockCommand({ Bucket: bucketName }));
    const cfg = resp?.PublicAccessBlockConfiguration;
    return !!(cfg?.BlockPublicAcls && cfg?.BlockPublicPolicy && cfg?.IgnorePublicAcls && cfg?.RestrictPublicBuckets);
  } catch (err) {
    if (err.name === 'NoSuchPublicAccessBlockConfiguration') return false;
    coreApi.logger.debug(`[awsApi] GetPublicAccessBlock failed for ${bucketName}: ${err.message}`);
    return false;
  }
}

async function fetchBucketVersioning(account, coreApi, bucketName, region) {
  try {
    const client = s3Client(account, coreApi, region);
    const resp = await client.send(new GetBucketVersioningCommand({ Bucket: bucketName }));
    return resp?.Status || 'Disabled';
  } catch (err) {
    coreApi.logger.debug(`[awsApi] GetBucketVersioning failed for ${bucketName}: ${err.message}`);
    return 'Disabled';
  }
}

async function fetchBucketLifecycleRuleCount(account, coreApi, bucketName, region) {
  try {
    const client = s3Client(account, coreApi, region);
    const resp = await client.send(new GetBucketLifecycleConfigurationCommand({ Bucket: bucketName }));
    return (resp?.Rules || []).length;
  } catch (err) {
    if (err.name === 'NoSuchLifecycleConfiguration') return 0;
    coreApi.logger.debug(`[awsApi] GetBucketLifecycleConfiguration failed for ${bucketName}: ${err.message}`);
    return 0;
  }
}

/** { sizeBytes, objectCount } — newest AWS/S3 daily datapoint over the last 3 days. */
async function fetchBucketStorageMetrics(account, coreApi, bucketName, region) {
  try {
    const client = cloudwatchClient(account, coreApi, region);
    const endTime = new Date();
    const startTime = new Date(endTime.getTime() - 3 * 86400000);
    const resp = await client.send(new GetMetricDataCommand({
      StartTime: startTime, EndTime: endTime,
      MetricDataQueries: [
        {
          Id: 'size',
          MetricStat: {
            Metric: {
              Namespace: 'AWS/S3', MetricName: 'BucketSizeBytes',
              Dimensions: [{ Name: 'BucketName', Value: bucketName }, { Name: 'StorageType', Value: 'StandardStorage' }],
            },
            Period: 86400, Stat: 'Average',
          },
          ReturnData: true,
        },
        {
          Id: 'objects',
          MetricStat: {
            Metric: {
              Namespace: 'AWS/S3', MetricName: 'NumberOfObjects',
              Dimensions: [{ Name: 'BucketName', Value: bucketName }, { Name: 'StorageType', Value: 'AllStorageTypes' }],
            },
            Period: 86400, Stat: 'Average',
          },
          ReturnData: true,
        },
      ],
    }));
    const byId = new Map((resp?.MetricDataResults || []).map((r) => [r.Id, r]));
    const newest = (r) => {
      if (!r?.Timestamps?.length) return null;
      let bestIdx = 0;
      for (let i = 1; i < r.Timestamps.length; i++) if (new Date(r.Timestamps[i]) > new Date(r.Timestamps[bestIdx])) bestIdx = i;
      return r.Values?.[bestIdx] ?? null;
    };
    return { sizeBytes: newest(byId.get('size')), objectCount: newest(byId.get('objects')) };
  } catch (err) {
    coreApi.logger.debug(`[awsApi] S3 CloudWatch metrics failed for ${bucketName}: ${err.message}`);
    return { sizeBytes: null, objectCount: null };
  }
}

// ── Bedrock (via CloudWatch AWS/Bedrock namespace) ────────────────────────────

/** Distinct ModelId dimension values reporting under AWS/Bedrock. */
async function fetchBedrockModelIds(account, coreApi) {
  try {
    const client = cloudwatchClient(account, coreApi);
    const resp = await client.send(new ListMetricsCommand({ Namespace: 'AWS/Bedrock' }));
    const ids = new Set();
    for (const m of resp?.Metrics || []) {
      const dim = (m.Dimensions || []).find((d) => d.Name === 'ModelId');
      if (dim?.Value) ids.add(dim.Value);
    }
    return [...ids];
  } catch (err) {
    coreApi.logger.debug(`[awsApi] Bedrock ListMetrics failed: ${err.message}`);
    return [];
  }
}

/**
 * Daily Invocations(Sum)/InputTokenCount(Sum)/OutputTokenCount(Sum)/
 * InvocationLatency(Average) for one ModelId, last 30 days.
 * Returns [{ day, invocations, inputTokens, outputTokens, avgLatencyMs }].
 */
async function fetchBedrockDailyUsage(account, coreApi, modelId) {
  try {
    const client = cloudwatchClient(account, coreApi);
    const endTime = new Date();
    const startTime = new Date(endTime.getTime() - 30 * 86400000);
    const dims = [{ Name: 'ModelId', Value: modelId }];
    const resp = await client.send(new GetMetricDataCommand({
      StartTime: startTime, EndTime: endTime,
      MetricDataQueries: [
        { Id: 'inv', MetricStat: { Metric: { Namespace: 'AWS/Bedrock', MetricName: 'Invocations', Dimensions: dims }, Period: 86400, Stat: 'Sum' }, ReturnData: true },
        { Id: 'intok', MetricStat: { Metric: { Namespace: 'AWS/Bedrock', MetricName: 'InputTokenCount', Dimensions: dims }, Period: 86400, Stat: 'Sum' }, ReturnData: true },
        { Id: 'outtok', MetricStat: { Metric: { Namespace: 'AWS/Bedrock', MetricName: 'OutputTokenCount', Dimensions: dims }, Period: 86400, Stat: 'Sum' }, ReturnData: true },
        { Id: 'lat', MetricStat: { Metric: { Namespace: 'AWS/Bedrock', MetricName: 'InvocationLatency', Dimensions: dims }, Period: 86400, Stat: 'Average' }, ReturnData: true },
      ],
    }));
    const byId = new Map((resp?.MetricDataResults || []).map((r) => [r.Id, r]));
    const byDay = new Map();
    const merge = (id, key) => {
      const r = byId.get(id);
      if (!r) return;
      (r.Timestamps || []).forEach((ts, idx) => {
        const day = new Date(ts).toISOString().slice(0, 10);
        if (!byDay.has(day)) byDay.set(day, { day, invocations: null, inputTokens: null, outputTokens: null, avgLatencyMs: null });
        byDay.get(day)[key] = r.Values?.[idx] ?? null;
      });
    };
    merge('inv', 'invocations');
    merge('intok', 'inputTokens');
    merge('outtok', 'outputTokens');
    merge('lat', 'avgLatencyMs');
    return [...byDay.values()];
  } catch (err) {
    coreApi.logger.debug(`[awsApi] Bedrock GetMetricData failed for ${modelId}: ${err.message}`);
    return [];
  }
}

// ── Cost Explorer ────────────────────────────────────────────────────────────

/**
 * ONE GetCostAndUsage call ($0.01) — daily granularity, last 35 days through
 * today, grouped by SERVICE. Returns [{ day, service, amountUsd }]. Callers
 * MUST gate this behind the daily last_cost_capture_at stamp.
 */
async function fetchCostAndUsage(account, coreApi) {
  const client = costExplorerClient(account, coreApi);
  const end = new Date();
  const start = new Date(end.getTime() - 35 * 86400000);
  const fmt = (d) => d.toISOString().slice(0, 10);
  const resp = await client.send(new GetCostAndUsageCommand({
    TimePeriod: { Start: fmt(start), End: fmt(end) },
    Granularity: 'DAILY',
    Metrics: ['UnblendedCost'],
    GroupBy: [{ Type: 'DIMENSION', Key: 'SERVICE' }],
  }));
  const rows = [];
  for (const period of resp?.ResultsByTime || []) {
    const day = period.TimePeriod?.Start;
    for (const g of period.Groups || []) {
      const service = g.Keys?.[0] || 'Unknown';
      const amountUsd = Number(g.Metrics?.UnblendedCost?.Amount) || 0;
      rows.push({ day, service, amountUsd });
    }
  }
  return rows;
}

/**
 * Shared GroupBy helper for the two additional Cost Explorer groupings
 * (USAGE_TYPE, INSTANCE_TYPE) — same 35d DAILY window/client as
 * fetchCostAndUsage. Returns [{ day, key, amountUsd }].
 */
async function fetchCostAndUsageGrouped(account, coreApi, groupByKey) {
  const client = costExplorerClient(account, coreApi);
  const end = new Date();
  const start = new Date(end.getTime() - 35 * 86400000);
  const fmt = (d) => d.toISOString().slice(0, 10);
  const resp = await client.send(new GetCostAndUsageCommand({
    TimePeriod: { Start: fmt(start), End: fmt(end) },
    Granularity: 'DAILY',
    Metrics: ['UnblendedCost'],
    GroupBy: [{ Type: 'DIMENSION', Key: groupByKey }],
  }));
  const rows = [];
  for (const period of resp?.ResultsByTime || []) {
    const day = period.TimePeriod?.Start;
    for (const g of period.Groups || []) {
      const key = g.Keys?.[0] || 'Unknown';
      const amountUsd = Number(g.Metrics?.UnblendedCost?.Amount) || 0;
      rows.push({ day, key, amountUsd });
    }
  }
  return rows;
}

/** [{ day, usageType, amountUsd }] — GroupBy DIMENSION/USAGE_TYPE, same window as fetchCostAndUsage. */
async function fetchCostByUsageType(account, coreApi) {
  const rows = await fetchCostAndUsageGrouped(account, coreApi, 'USAGE_TYPE');
  return rows.map((r) => ({ day: r.day, usageType: r.key, amountUsd: r.amountUsd }));
}

/** [{ day, instanceType, amountUsd }] — GroupBy DIMENSION/INSTANCE_TYPE, same window as fetchCostAndUsage. */
async function fetchCostByInstanceType(account, coreApi) {
  const rows = await fetchCostAndUsageGrouped(account, coreApi, 'INSTANCE_TYPE');
  return rows.map((r) => ({ day: r.day, instanceType: r.key, amountUsd: r.amountUsd }));
}

// ── AWS Service Health RSS ──────────────────────────────────────────────────

/** Raw HTTPS GET, resolves with the response body text. DEVIATION: replaces
 *  the built-in's axios call (axios unavailable to a bundled plugin). */
function httpsGetText(url, timeout = 5000) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, { timeout }, (res) => {
      if (res.statusCode && (res.statusCode < 200 || res.statusCode >= 300)) {
        res.resume();
        reject(new Error(`HTTP ${res.statusCode}`));
        return;
      }
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    });
    req.on('timeout', () => { req.destroy(); reject(new Error('Request timed out')); });
    req.on('error', reject);
  });
}

const decodeXmlEntities = (s) => String(s)
  .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"')
  .replace(/&apos;/g, "'").replace(/&amp;/g, '&');

/** Text of a single top-level tag within one <item>...</item> block, CDATA-aware. */
function tagText(itemXml, tag) {
  const m = itemXml.match(new RegExp(`<${tag}[^>]*>([\\s\\S]*?)</${tag}>`, 'i'));
  if (!m) return '';
  const raw = m[1].trim();
  const cdata = raw.match(/^<!\[CDATA\[([\s\S]*?)\]\]>$/);
  return decodeXmlEntities(cdata ? cdata[1] : raw).trim();
}

/**
 * status.aws.amazon.com/rss/<service>-<region>.rss — public, no auth. Never
 * throws: network/parse failures and 404/empty feeds (a healthy service)
 * both resolve to []. Returns [{ title, summary, publishedAt }]. DEVIATION:
 * hand-rolled <item> extraction via regex instead of fast-xml-parser — this
 * feed is flat, unnamespaced RSS 2.0, so a full parser is unnecessary.
 */
async function fetchHealthRss(coreApi, service, region) {
  try {
    const url = `https://status.aws.amazon.com/rss/${service}-${region}.rss`;
    const body = await httpsGetText(url);
    const items = body.match(/<item\b[\s\S]*?<\/item>/gi) || [];
    return items.map((itemXml) => {
      const pubDate = tagText(itemXml, 'pubDate');
      return {
        title: tagText(itemXml, 'title'),
        summary: tagText(itemXml, 'description').slice(0, 500),
        publishedAt: pubDate ? new Date(pubDate).toISOString() : null,
      };
    });
  } catch (err) {
    coreApi.logger.debug(`[awsApi] health RSS fetch failed for ${service}-${region}: ${err.message}`);
    return [];
  }
}

// ── RDS ──────────────────────────────────────────────────────────────────────

async function fetchRdsInstances(account, coreApi) {
  const client = rdsClient(account, coreApi);
  const instances = [];
  let marker;
  do {
    const resp = await client.send(new DescribeDBInstancesCommand({ Marker: marker }));
    for (const d of resp?.DBInstances || []) {
      instances.push({
        dbId: d.DBInstanceIdentifier,
        engine: d.Engine || null,
        engineVersion: d.EngineVersion || null,
        instanceClass: d.DBInstanceClass || null,
        status: d.DBInstanceStatus || null,
        multiAz: !!d.MultiAZ,
        allocatedGb: d.AllocatedStorage ?? null,
        backupRetentionDays: d.BackupRetentionPeriod ?? null,
        latestBackupAt: d.LatestRestorableTime ? new Date(d.LatestRestorableTime).toISOString() : null,
        endpoint: d.Endpoint?.Address || null,
      });
    }
    marker = resp?.Marker;
  } while (marker);
  return instances;
}

/**
 * Latest 15-minute FreeStorageSpace/CPUUtilization/DatabaseConnections
 * datapoint per DB instance, via one batched GetMetricData call. Returns
 * Map(dbId -> { freeStorageBytes, cpuUtil, connections }).
 */
async function fetchRdsMetrics(account, coreApi, dbIds) {
  const out = new Map();
  if (!dbIds?.length) return out;
  const client = cloudwatchClient(account, coreApi);
  const endTime = new Date();
  const startTime = new Date(endTime.getTime() - 15 * 60000);
  const metrics = [['fs', 'FreeStorageSpace', 'Average'], ['cpu', 'CPUUtilization', 'Average'], ['conn', 'DatabaseConnections', 'Average']];
  const queries = [];
  dbIds.forEach((id, idx) => {
    for (const [prefix, metricName, stat] of metrics) {
      queries.push({
        Id: `${prefix}${idx}`,
        MetricStat: {
          Metric: { Namespace: 'AWS/RDS', MetricName: metricName, Dimensions: [{ Name: 'DBInstanceIdentifier', Value: id }] },
          Period: 900, Stat: stat,
        },
        ReturnData: true,
      });
    }
  });
  for (let i = 0; i < queries.length; i += 500) {
    const chunk = queries.slice(i, i + 500);
    const resp = await client.send(new GetMetricDataCommand({ StartTime: startTime, EndTime: endTime, MetricDataQueries: chunk }));
    for (const r of resp?.MetricDataResults || []) {
      const idx = Number(r.Id.replace(/^\D+/, ''));
      const dbId = dbIds[idx];
      if (!dbId) continue;
      if (!out.has(dbId)) out.set(dbId, { freeStorageBytes: null, cpuUtil: null, connections: null });
      const entry = out.get(dbId);
      const val = r.Values?.[0] ?? null;
      if (r.Id.startsWith('fs')) entry.freeStorageBytes = val;
      else if (r.Id.startsWith('cpu')) entry.cpuUtil = val;
      else if (r.Id.startsWith('conn')) entry.connections = val;
    }
  }
  return out;
}

// ── Lambda ───────────────────────────────────────────────────────────────────

async function fetchLambdaFunctions(account, coreApi) {
  const client = lambdaClient(account, coreApi);
  const functions = [];
  let marker;
  do {
    const resp = await client.send(new ListFunctionsCommand({ Marker: marker }));
    for (const f of resp?.Functions || []) {
      functions.push({
        name: f.FunctionName,
        runtime: f.Runtime || null,
        memoryMb: f.MemorySize ?? null,
        timeoutS: f.Timeout ?? null,
        codeSizeBytes: f.CodeSize ?? null,
        lastModified: f.LastModified ? new Date(f.LastModified).toISOString() : null,
      });
    }
    marker = resp?.NextMarker;
  } while (marker);
  return functions;
}

/**
 * Invocations(Sum)/Errors(Sum)/Duration(Average) over the last 24h, per
 * Lambda function name, via one batched GetMetricData call. Returns
 * Map(name -> { invocations24h, errors24h, avgDurationMs }).
 */
async function fetchLambdaMetrics(account, coreApi, functionNames) {
  const out = new Map();
  if (!functionNames?.length) return out;
  const client = cloudwatchClient(account, coreApi);
  const endTime = new Date();
  const startTime = new Date(endTime.getTime() - 24 * 3600000);
  const metrics = [['inv', 'Invocations', 'Sum'], ['err', 'Errors', 'Sum'], ['dur', 'Duration', 'Average']];
  const queries = [];
  functionNames.forEach((name, idx) => {
    for (const [prefix, metricName, stat] of metrics) {
      queries.push({
        Id: `${prefix}${idx}`,
        MetricStat: {
          Metric: { Namespace: 'AWS/Lambda', MetricName: metricName, Dimensions: [{ Name: 'FunctionName', Value: name }] },
          Period: 86400, Stat: stat,
        },
        ReturnData: true,
      });
    }
  });
  for (let i = 0; i < queries.length; i += 500) {
    const chunk = queries.slice(i, i + 500);
    const resp = await client.send(new GetMetricDataCommand({ StartTime: startTime, EndTime: endTime, MetricDataQueries: chunk }));
    for (const r of resp?.MetricDataResults || []) {
      const idx = Number(r.Id.replace(/^\D+/, ''));
      const name = functionNames[idx];
      if (!name) continue;
      if (!out.has(name)) out.set(name, { invocations24h: null, errors24h: null, avgDurationMs: null });
      const entry = out.get(name);
      const val = r.Values?.[0] ?? null;
      if (r.Id.startsWith('inv')) entry.invocations24h = val;
      else if (r.Id.startsWith('err')) entry.errors24h = val;
      else if (r.Id.startsWith('dur')) entry.avgDurationMs = val;
    }
  }
  return out;
}

// ── DynamoDB ─────────────────────────────────────────────────────────────────

async function fetchDynamoTableNames(account, coreApi) {
  const client = dynamoClient(account, coreApi);
  const names = [];
  let exclusiveStartTableName;
  do {
    const resp = await client.send(new ListTablesCommand({ ExclusiveStartTableName: exclusiveStartTableName }));
    names.push(...(resp?.TableNames || []));
    exclusiveStartTableName = resp?.LastEvaluatedTableName;
  } while (exclusiveStartTableName);
  return names;
}

async function fetchDynamoTable(account, coreApi, name) {
  const client = dynamoClient(account, coreApi);
  const resp = await client.send(new DescribeTableCommand({ TableName: name }));
  const t = resp?.Table;
  return {
    name,
    status: t?.TableStatus || null,
    billingMode: t?.BillingModeSummary?.BillingMode || 'PROVISIONED',
    itemCount: t?.ItemCount ?? null,
    sizeBytes: t?.TableSizeBytes ?? null,
    readCapacity: t?.ProvisionedThroughput?.ReadCapacityUnits ?? null,
    writeCapacity: t?.ProvisionedThroughput?.WriteCapacityUnits ?? null,
  };
}

// ── ECR ──────────────────────────────────────────────────────────────────────

async function fetchEcrRepos(account, coreApi) {
  const client = ecrClient(account, coreApi);
  const repos = [];
  let nextToken;
  do {
    const resp = await client.send(new DescribeRepositoriesCommand({ nextToken }));
    for (const r of resp?.repositories || []) {
      repos.push({
        name: r.repositoryName,
        scanOnPush: !!r.imageScanningConfiguration?.scanOnPush,
      });
    }
    nextToken = resp?.nextToken;
  } while (nextToken);
  return repos;
}

/** { imageCount, sizeBytes, latestPushAt } — DescribeImages capped at 3 pages. */
async function fetchEcrRepoImages(account, coreApi, repositoryName) {
  const client = ecrClient(account, coreApi);
  let imageCount = 0;
  let sizeBytes = 0;
  let latestPushAt = null;
  let nextToken;
  let pages = 0;
  do {
    const resp = await client.send(new DescribeImagesCommand({ repositoryName, nextToken }));
    for (const img of resp?.imageDetails || []) {
      imageCount += 1;
      sizeBytes += img.imageSizeInBytes || 0;
      if (img.imagePushedAt) {
        const t = new Date(img.imagePushedAt).getTime();
        if (!latestPushAt || t > new Date(latestPushAt).getTime()) latestPushAt = new Date(t).toISOString();
      }
    }
    nextToken = resp?.nextToken;
    pages += 1;
  } while (nextToken && pages < 3);
  return { imageCount, sizeBytes, latestPushAt };
}

// ── VPC (via EC2 client) ─────────────────────────────────────────────────────

const nameTagOf = (tags) => (tags || []).find((t) => t.Key === 'Name')?.Value || null;

async function fetchVpcs(account, coreApi) {
  const client = ec2Client(account, coreApi);
  const vpcs = [];
  let nextToken;
  do {
    const resp = await client.send(new DescribeVpcsCommand({ NextToken: nextToken }));
    for (const v of resp?.Vpcs || []) {
      vpcs.push({
        vpcId: v.VpcId,
        name: nameTagOf(v.Tags),
        cidr: v.CidrBlock || null,
        state: v.State || null,
        isDefault: !!v.IsDefault,
      });
    }
    nextToken = resp?.NextToken;
  } while (nextToken);
  return vpcs;
}

async function fetchSubnets(account, coreApi) {
  const client = ec2Client(account, coreApi);
  const subnets = [];
  let nextToken;
  do {
    const resp = await client.send(new DescribeSubnetsCommand({ NextToken: nextToken }));
    for (const s of resp?.Subnets || []) {
      subnets.push({
        subnetId: s.SubnetId,
        vpcId: s.VpcId || null,
        name: nameTagOf(s.Tags),
        cidr: s.CidrBlock || null,
        az: s.AvailabilityZone || null,
        availableIps: s.AvailableIpAddressCount ?? null,
        public: !!s.MapPublicIpOnLaunch,
      });
    }
    nextToken = resp?.NextToken;
  } while (nextToken);
  return subnets;
}

async function fetchNatGateways(account, coreApi) {
  const client = ec2Client(account, coreApi);
  const gateways = [];
  let nextToken;
  do {
    const resp = await client.send(new DescribeNatGatewaysCommand({ NextToken: nextToken }));
    for (const g of resp?.NatGateways || []) {
      gateways.push({ vpcId: g.VpcId || null, state: g.State || null });
    }
    nextToken = resp?.NextToken;
  } while (nextToken);
  return gateways;
}

async function fetchSecurityGroups(account, coreApi) {
  const client = ec2Client(account, coreApi);
  const groups = [];
  let nextToken;
  do {
    const resp = await client.send(new DescribeSecurityGroupsCommand({ NextToken: nextToken }));
    for (const g of resp?.SecurityGroups || []) {
      groups.push({ vpcId: g.VpcId || null });
    }
    nextToken = resp?.NextToken;
  } while (nextToken);
  return groups;
}

async function fetchInternetGateways(account, coreApi) {
  const client = ec2Client(account, coreApi);
  const gateways = [];
  let nextToken;
  do {
    const resp = await client.send(new DescribeInternetGatewaysCommand({ NextToken: nextToken }));
    for (const g of resp?.InternetGateways || []) {
      for (const a of g.Attachments || []) {
        if (a.VpcId) gateways.push({ vpcId: a.VpcId });
      }
    }
    nextToken = resp?.NextToken;
  } while (nextToken);
  return gateways;
}

// ── Compute Optimizer ────────────────────────────────────────────────────────

/** ARN tail (the part after the final '/' or ':') — used as resource_id. */
const arnTail = (arn) => {
  if (!arn) return null;
  const s = String(arn);
  const slash = s.lastIndexOf('/');
  if (slash >= 0) return s.slice(slash + 1);
  const colon = s.lastIndexOf(':');
  return colon >= 0 ? s.slice(colon + 1) : s;
};

/** Region segment of an ARN (arn:aws:SERVICE:REGION:ACCOUNT:...), or null. */
const arnRegion = (arn) => (String(arn || '').split(':')[3] || null);

/** { status, memberAccountsEnrolled } from GetEnrollmentStatus — never throws (caller wraps in degradeGracefully). */
async function fetchCoEnrollmentStatus(account, coreApi) {
  const client = computeOptimizerClient(account, coreApi);
  const resp = await client.send(new GetEnrollmentStatusCommand({}));
  return { status: resp?.status || null, memberAccountsEnrolled: !!resp?.memberAccountsEnrolled };
}

async function fetchCoEc2Recommendations(account, coreApi) {
  const client = computeOptimizerClient(account, coreApi);
  const out = [];
  let nextToken;
  let pages = 0;
  do {
    const resp = await client.send(new GetEC2InstanceRecommendationsCommand({ nextToken }));
    for (const r of resp?.instanceRecommendations || []) {
      const top = (r.recommendationOptions || []).find((o) => o.rank === 1) || r.recommendationOptions?.[0];
      out.push({
        resourceId: arnTail(r.instanceArn),
        region: arnRegion(r.instanceArn),
        finding: r.finding || null,
        currentConfig: r.currentInstanceType || null,
        recommendedConfig: top?.instanceType || null,
        estMonthlySavingsUsd: top?.savingsOpportunity?.estimatedMonthlySavings?.value ?? null,
        reason: (r.findingReasonCodes || []).join(', ') || null,
      });
    }
    nextToken = resp?.nextToken;
    pages += 1;
  } while (nextToken && pages < 3);
  return out;
}

async function fetchCoEbsRecommendations(account, coreApi) {
  const client = computeOptimizerClient(account, coreApi);
  const out = [];
  let nextToken;
  let pages = 0;
  do {
    const resp = await client.send(new GetEBSVolumeRecommendationsCommand({ nextToken }));
    for (const r of resp?.volumeRecommendations || []) {
      const top = (r.volumeRecommendationOptions || []).find((o) => o.rank === 1) || r.volumeRecommendationOptions?.[0];
      const cur = r.currentConfiguration;
      out.push({
        resourceId: arnTail(r.volumeArn),
        region: arnRegion(r.volumeArn),
        finding: r.finding || null,
        currentConfig: cur ? `${cur.volumeType || ''} ${cur.volumeSize ?? ''}GiB`.trim() : null,
        recommendedConfig: top?.configuration ? `${top.configuration.volumeType || ''} ${top.configuration.volumeSize ?? ''}GiB`.trim() : null,
        estMonthlySavingsUsd: top?.savingsOpportunity?.estimatedMonthlySavings?.value ?? null,
        reason: null,
      });
    }
    nextToken = resp?.nextToken;
    pages += 1;
  } while (nextToken && pages < 3);
  return out;
}

async function fetchCoLambdaRecommendations(account, coreApi) {
  const client = computeOptimizerClient(account, coreApi);
  const out = [];
  let nextToken;
  let pages = 0;
  do {
    const resp = await client.send(new GetLambdaFunctionRecommendationsCommand({ nextToken }));
    for (const r of resp?.lambdaFunctionRecommendations || []) {
      const top = (r.memorySizeRecommendationOptions || []).find((o) => o.rank === 1) || r.memorySizeRecommendationOptions?.[0];
      out.push({
        resourceId: arnTail(r.functionArn),
        region: arnRegion(r.functionArn),
        finding: r.finding || null,
        currentConfig: r.currentMemorySize != null ? `${r.currentMemorySize}MB` : null,
        recommendedConfig: top?.memorySize != null ? `${top.memorySize}MB` : null,
        estMonthlySavingsUsd: top?.savingsOpportunity?.estimatedMonthlySavings?.value ?? null,
        reason: (r.findingReasonCodes || []).join(', ') || null,
      });
    }
    nextToken = resp?.nextToken;
    pages += 1;
  } while (nextToken && pages < 3);
  return out;
}

async function fetchCoEcsRecommendations(account, coreApi) {
  const client = computeOptimizerClient(account, coreApi);
  const out = [];
  let nextToken;
  let pages = 0;
  do {
    const resp = await client.send(new GetECSServiceRecommendationsCommand({ nextToken }));
    for (const r of resp?.ecsServiceRecommendations || []) {
      const top = (r.serviceRecommendationOptions || []).find((o) => o.rank === 1) || r.serviceRecommendationOptions?.[0];
      const cur = r.currentServiceConfiguration;
      out.push({
        resourceId: arnTail(r.serviceArn),
        region: arnRegion(r.serviceArn),
        finding: r.finding || null,
        currentConfig: cur ? `${cur.cpu ?? ''} vCPU / ${cur.memory ?? ''}MB`.trim() : null,
        recommendedConfig: top ? `${top.cpu ?? ''} vCPU / ${top.memory ?? ''}MB`.trim() : null,
        estMonthlySavingsUsd: top?.savingsOpportunity?.estimatedMonthlySavings?.value ?? null,
        reason: (r.findingReasonCodes || []).join(', ') || null,
      });
    }
    nextToken = resp?.nextToken;
    pages += 1;
  } while (nextToken && pages < 3);
  return out;
}

// ── Test connection ──────────────────────────────────────────────────────────

/** Validate a saved or candidate account. Never throws. */
async function testConnection(account, coreApi) {
  try {
    const client = ec2Client(account, coreApi);
    const resp = await client.send(new DescribeInstancesCommand({ MaxResults: 5 }));
    const instanceCount = (resp?.Reservations || []).reduce((n, r) => n + (r.Instances || []).length, 0);
    return { ok: true, instanceCount };
  } catch (err) {
    return { ok: false, error: err.message || String(err) };
  }
}

module.exports = {
  creds, credSource,
  ec2Client, lightsailClient, ecsClient, s3Client, cloudwatchClient, costExplorerClient,
  rdsClient, lambdaClient, dynamoClient, ecrClient,
  fetchEc2Instances, fetchEbsVolumes, fetchEc2Metrics,
  fetchLightsailInstances, fetchLightsailMetric, fetchLightsailSnapshots,
  fetchEcsClusters, fetchEcsServices, fetchEcsServiceMetrics,
  fetchS3Buckets, fetchBucketLocation, fetchBucketPublicAccessBlocked, fetchBucketVersioning,
  fetchBucketLifecycleRuleCount, fetchBucketStorageMetrics,
  fetchBedrockModelIds, fetchBedrockDailyUsage,
  fetchCostAndUsage, fetchCostByUsageType, fetchCostByInstanceType,
  fetchHealthRss,
  fetchRdsInstances, fetchRdsMetrics,
  fetchLambdaFunctions, fetchLambdaMetrics,
  fetchDynamoTableNames, fetchDynamoTable,
  fetchEcrRepos, fetchEcrRepoImages,
  fetchVpcs, fetchSubnets, fetchNatGateways, fetchSecurityGroups, fetchInternetGateways,
  computeOptimizerClient,
  fetchCoEnrollmentStatus, fetchCoEc2Recommendations, fetchCoEbsRecommendations,
  fetchCoLambdaRecommendations, fetchCoEcsRecommendations,
  testConnection,
};
