// AWS API client. One SDK v3 client per service, built per-account: stored
// credentials (encrypted_credentials -> secretAccessKey, access_key_id
// plaintext) take priority; a row with blank/NULL creds falls back to
// process.env.AWS_ACCESS_KEY_ID / AWS_SECRET_ACCESS_KEY (the "env mode" seam
// routes/aws.js reports as credSource). All fetchers are failure-tolerant:
// optional chaining, default 0/null, never throw on a missing/empty field —
// only on the underlying AWS call itself.
const { EC2Client, DescribeInstancesCommand, DescribeVolumesCommand,
  DescribeVpcsCommand, DescribeSubnetsCommand, DescribeNatGatewaysCommand,
  DescribeSecurityGroupsCommand, DescribeInternetGatewaysCommand,
} = require('@aws-sdk/client-ec2');
const {
  LightsailClient, GetInstancesCommand, GetInstanceMetricDataCommand, GetInstanceSnapshotsCommand,
  GetRelationalDatabasesCommand, GetDisksCommand, GetBucketsCommand, GetLoadBalancersCommand,
  GetDistributionsCommand, GetDomainsCommand, GetStaticIpsCommand, GetBundlesCommand,
  GetRelationalDatabaseBundlesCommand,
} = require('@aws-sdk/client-lightsail');
const {
  ECSClient, ListClustersCommand, DescribeClustersCommand, ListServicesCommand, DescribeServicesCommand,
} = require('@aws-sdk/client-ecs');
const {
  S3Client, ListBucketsCommand, GetBucketLocationCommand, GetPublicAccessBlockCommand,
  GetBucketVersioningCommand, GetBucketLifecycleConfigurationCommand,
} = require('@aws-sdk/client-s3');
const { CloudWatchClient, ListMetricsCommand, GetMetricDataCommand } = require('@aws-sdk/client-cloudwatch');
const {
  CostExplorerClient, GetCostAndUsageCommand, GetCostAndUsageWithResourcesCommand,
  GetCostForecastCommand, GetSavingsPlansUtilizationCommand, GetSavingsPlansUtilizationDetailsCommand,
  GetSavingsPlansCoverageCommand, GetReservationUtilizationCommand, GetReservationCoverageCommand,
  GetAnomalyMonitorsCommand, GetAnomaliesCommand, GetRightsizingRecommendationCommand,
  GetSavingsPlansPurchaseRecommendationCommand, ListCostAllocationTagsCommand, GetDimensionValuesCommand,
} = require('@aws-sdk/client-cost-explorer');
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
const axios = require('axios');
const { XMLParser } = require('fast-xml-parser');
const { decrypt } = require('./encryption');
const logger = require('../utils/logger');
const { fromTemporaryCredentials, fromIni } = require('@aws-sdk/credential-providers');
const { STSClient, GetCallerIdentityCommand } = require('@aws-sdk/client-sts');

const healthXmlParser = new XMLParser({ ignoreAttributes: false, removeNSPrefix: true });

// ── Credentials ─────────────────────────────────────────────────────────────
// An account authenticates one of three ways (auth_mode):
//   key      access key + secret, optionally a session token with an expiry
//            (temporary credentials from STS or Identity Center)
//   role     STS AssumeRole into role_arn (external ID, session name) from a
//            base identity: a stored key, a named profile, or the host's own
//            credential chain (instance profile, Roles Anywhere, env)
//   profile  a named profile in ~/.aws on the ICC box (SSO, credential_process)
// With nothing stored the SDK default chain applies, which is how a row with
// blank credentials picks up AWS_ACCESS_KEY_ID / AWS_SECRET_ACCESS_KEY.

// The stored blob: { secretAccessKey, sessionToken? }. Unsaved test
// candidates carry the same fields in plaintext.
function readSecret(account) {
  if (account.secretAccessKey) {
    return { secretAccessKey: account.secretAccessKey, sessionToken: account.sessionToken || null };
  }
  if (account.encrypted_credentials) {
    try {
      const c = JSON.parse(decrypt(account.encrypted_credentials));
      if (c.secretAccessKey) return { secretAccessKey: c.secretAccessKey, sessionToken: c.sessionToken || null };
    } catch (err) {
      logger.warn(`[awsApi] decrypt failed for account ${account.name || account.id}: ${err.message}`);
    }
  }
  return { secretAccessKey: null, sessionToken: null };
}

function readExternalId(account) {
  if (account.externalId !== undefined) return account.externalId || null;
  if (account.encrypted_external_id) {
    try { return decrypt(account.encrypted_external_id) || null; } catch { return null; }
  }
  return null;
}

const field = (account, camel, snake) => (account[camel] !== undefined ? account[camel] : account[snake]);
const authMode = (account) => field(account, 'authMode', 'auth_mode') || 'key';

// What the role (or the account itself) authenticates with before any AssumeRole.
function baseSource(account) {
  const keyId = field(account, 'accessKeyId', 'access_key_id');
  const { secretAccessKey, sessionToken } = readSecret(account);
  const profile = field(account, 'profileName', 'profile_name');
  const mode = authMode(account);
  if (mode !== 'profile' && keyId && secretAccessKey) return sessionToken ? 'session' : 'stored';
  if (profile) return 'profile';
  if (process.env.AWS_ACCESS_KEY_ID && process.env.AWS_SECRET_ACCESS_KEY) return 'env';
  return 'host';
}

function baseCredentials(account) {
  const src = baseSource(account);
  if (src === 'stored' || src === 'session') {
    const { secretAccessKey, sessionToken } = readSecret(account);
    const c = { accessKeyId: field(account, 'accessKeyId', 'access_key_id'), secretAccessKey };
    if (sessionToken) c.sessionToken = sessionToken;
    return c;
  }
  if (src === 'profile') return fromIni({ profile: field(account, 'profileName', 'profile_name') });
  if (src === 'env') {
    const c = { accessKeyId: process.env.AWS_ACCESS_KEY_ID, secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY };
    if (process.env.AWS_SESSION_TOKEN) c.sessionToken = process.env.AWS_SESSION_TOKEN;
    return c;
  }
  return undefined; // SDK default chain: instance profile, Roles Anywhere, ~/.aws default
}

// AssumeRole providers refresh their STS session on their own; keep one per
// saved account (and credential version) so every client shares the session.
const roleProviders = new Map();

function credentialProvider(account, region) {
  const roleArn = authMode(account) === 'role' ? field(account, 'roleArn', 'role_arn') : null;
  if (!roleArn) return baseCredentials(account);
  const cacheKey = account.id && account.secretAccessKey === undefined && account.externalId === undefined
    ? `${account.id}|${account.updated_at}|${region}` : null;
  if (cacheKey && roleProviders.has(cacheKey)) return roleProviders.get(cacheKey);
  const externalId = readExternalId(account);
  const provider = fromTemporaryCredentials({
    masterCredentials: baseCredentials(account),
    params: {
      RoleArn: roleArn,
      RoleSessionName: field(account, 'roleSessionName', 'role_session_name') || 'icc',
      ...(externalId ? { ExternalId: externalId } : {}),
      DurationSeconds: 3600,
    },
    clientConfig: { region },
  });
  if (cacheKey) {
    if (roleProviders.size > 200) roleProviders.clear();
    roleProviders.set(cacheKey, provider);
  }
  return provider;
}

/** Back-compat shape for callers that only want a static key pair. */
function creds(account) {
  const c = baseCredentials(account);
  return c && typeof c === 'object' ? c : { accessKeyId: undefined, secretAccessKey: undefined };
}

/** 'role' | 'session' | 'stored' | 'profile' | 'env' | 'none' — never the secret itself. */
function credSource(account) {
  if (authMode(account) === 'role' && field(account, 'roleArn', 'role_arn')) return 'role';
  const src = baseSource(account);
  return src === 'host' ? 'none' : src;
}

function credentialExpired(account) {
  const at = field(account, 'credentialExpiresAt', 'credential_expires_at');
  if (!at) return false;
  const ms = Date.parse(at);
  return Number.isFinite(ms) && ms <= Date.now();
}

/** Everything the UI may show about how an account authenticates (no secrets). */
function credentialSummary(account) {
  const { sessionToken } = readSecret(account);
  return {
    authMode: authMode(account),
    credSource: credSource(account),
    baseSource: baseSource(account),
    roleArn: field(account, 'roleArn', 'role_arn') || null,
    roleSessionName: field(account, 'roleSessionName', 'role_session_name') || null,
    profileName: field(account, 'profileName', 'profile_name') || null,
    hasSessionToken: !!sessionToken,
    hasExternalId: !!readExternalId(account),
    credentialExpiresAt: field(account, 'credentialExpiresAt', 'credential_expires_at') || null,
    credentialExpired: credentialExpired(account),
  };
}

function clientConfig(account, region) {
  const cfg = { region: region || account.region || 'us-east-2' };
  const credentials = credentialProvider(account, cfg.region);
  if (credentials) cfg.credentials = credentials;
  return cfg;
}

// Friendlier text for the credential failures a customer will actually hit.
function explainAuthError(err, account) {
  const name = String(err?.name || err?.Code || '');
  const msg = err?.message || String(err);
  if (/ExpiredToken/i.test(name) || /expired/i.test(msg)) return `Credentials have expired: ${msg}`;
  if (/InvalidClientTokenId|UnrecognizedClientException/i.test(name)) {
    return `AWS did not recognise the access key${readSecret(account).sessionToken ? '' : ' (temporary keys need their session token)'}: ${msg}`;
  }
  if (/AccessDenied/i.test(name) && /AssumeRole/i.test(msg)) {
    return `sts:AssumeRole was denied: check the role trust policy and external ID. ${msg}`;
  }
  return msg;
}

const ec2Client = (account) => new EC2Client(clientConfig(account));
const lightsailClient = (account, region) => new LightsailClient(clientConfig(account, region));
const ecsClient = (account) => new ECSClient(clientConfig(account));
const s3Client = (account, region) => new S3Client(clientConfig(account, region));
const cloudwatchClient = (account, region) => new CloudWatchClient(clientConfig(account, region));
// Cost Explorer is a global service reachable only via us-east-1.
const costExplorerClient = (account) => new CostExplorerClient(clientConfig(account, 'us-east-1'));
const rdsClient = (account) => new RDSClient(clientConfig(account));
const lambdaClient = (account) => new LambdaClient(clientConfig(account));
const dynamoClient = (account) => new DynamoDBClient(clientConfig(account));
const ecrClient = (account) => new ECRClient(clientConfig(account));
const computeOptimizerClient = (account) => new ComputeOptimizerClient(clientConfig(account));

// ── EC2 ──────────────────────────────────────────────────────────────────────

async function fetchEc2Instances(account) {
  const client = ec2Client(account);
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

async function fetchEbsVolumes(account) {
  const client = ec2Client(account);
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
async function fetchEc2Metrics(account, instanceIds) {
  const out = new Map();
  if (!instanceIds?.length) return out;
  const client = cloudwatchClient(account);
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

const isoOrNull = (d) => {
  if (!d) return null;
  const t = new Date(d);
  return Number.isNaN(t.getTime()) ? null : t.toISOString();
};
const flag = (v) => (v == null ? null : (v ? 1 : 0));

/** Map bundleId -> { ramGb, cpuCount, diskGb, isWindows } from GetBundles. UNVERIFIED live. */
async function fetchLightsailBundles(account) {
  const client = lightsailClient(account);
  const out = new Map();
  let pageToken;
  do {
    const resp = await client.send(new GetBundlesCommand({ pageToken, includeInactive: true }));
    for (const b of resp?.bundles || []) {
      if (!b.bundleId) continue;
      const platforms = (b.supportedPlatforms || []).map((p) => String(p).toUpperCase());
      out.set(b.bundleId, {
        ramGb: b.ramSizeInGb ?? null,
        cpuCount: b.cpuCount ?? null,
        diskGb: b.diskSizeInGb ?? null,
        isWindows: /win/i.test(b.bundleId) || (platforms.includes('WINDOWS') && !platforms.includes('LINUX_UNIX')),
      });
    }
    pageToken = resp?.nextPageToken;
  } while (pageToken);
  return out;
}

/** Map bundleId -> { ramGb, cpuCount, diskGb } from GetRelationalDatabaseBundles. UNVERIFIED live. */
async function fetchLightsailDatabaseBundles(account) {
  const client = lightsailClient(account);
  const out = new Map();
  let pageToken;
  do {
    const resp = await client.send(new GetRelationalDatabaseBundlesCommand({ pageToken, includeInactive: true }));
    for (const b of resp?.bundles || []) {
      if (!b.bundleId) continue;
      out.set(b.bundleId, {
        ramGb: b.ramSizeInGb ?? null,
        cpuCount: b.cpuCount ?? null,
        diskGb: b.diskSizeInGb ?? null,
        isWindows: false,
      });
    }
    pageToken = resp?.nextPageToken;
  } while (pageToken);
  return out;
}

async function fetchLightsailInstances(account, bundles) {
  const client = lightsailClient(account);
  const instances = [];
  let pageToken;
  do {
    const resp = await client.send(new GetInstancesCommand({ pageToken }));
    for (const i of resp?.instances || []) {
      const bundle = bundles?.get?.(i.bundleId) || null;
      const blueprintText = `${i.blueprintId || ''} ${i.blueprintName || ''}`;
      instances.push({
        name: i.name,
        state: i.state?.name || null,
        blueprint: i.blueprintName || null,
        bundle: i.bundleId || null,
        az: i.location?.availabilityZone || null,
        publicIp: i.publicIpAddress || null,
        privateIp: i.privateIpAddress || null,
        arn: i.arn || null,
        createdAt: isoOrNull(i.createdAt),
        ramGb: i.hardware?.ramSizeInGb ?? bundle?.ramGb ?? null,
        cpuCount: i.hardware?.cpuCount ?? bundle?.cpuCount ?? null,
        isWindows: (bundle?.isWindows || /win/i.test(i.bundleId || '') || /windows/i.test(blueprintText)) ? 1 : 0,
      });
    }
    pageToken = resp?.nextPageToken;
  } while (pageToken);
  return instances;
}

async function fetchLightsailDatabases(account, dbBundles) {
  const client = lightsailClient(account);
  const rows = [];
  let pageToken;
  do {
    const resp = await client.send(new GetRelationalDatabasesCommand({ pageToken }));
    for (const d of resp?.relationalDatabases || []) {
      const bundleId = d.relationalDatabaseBundleId || null;
      const bundle = dbBundles?.get?.(bundleId) || null;
      rows.push({
        name: d.name,
        arn: d.arn || null,
        engine: d.engine || null,
        engineVersion: d.engineVersion || null,
        bundle: bundleId,
        ramGb: d.hardware?.ramSizeInGb ?? bundle?.ramGb ?? null,
        diskGb: d.hardware?.diskSizeInGb ?? bundle?.diskGb ?? null,
        state: d.state || null,
        az: d.location?.availabilityZone || d.secondaryAvailabilityZone || null,
        masterEndpoint: d.masterEndpoint?.address || null,
        port: d.masterEndpoint?.port ?? null,
        backupRetention: flag(d.backupRetentionEnabled),
        publiclyAccessible: flag(d.publiclyAccessible),
        latestRestorableAt: isoOrNull(d.latestRestorableTime),
        createdAt: isoOrNull(d.createdAt),
      });
    }
    pageToken = resp?.nextPageToken;
  } while (pageToken);
  return rows;
}

async function fetchLightsailDisks(account) {
  const client = lightsailClient(account);
  const rows = [];
  let pageToken;
  do {
    const resp = await client.send(new GetDisksCommand({ pageToken }));
    for (const d of resp?.disks || []) {
      const attached = d.isAttached === true || d.attachmentState === 'attached';
      rows.push({
        name: d.name,
        arn: d.arn || null,
        sizeGb: d.sizeInGb ?? null,
        state: d.state || null,
        attachedTo: d.attachedTo || null,
        attachmentState: d.attachmentState || (attached ? 'attached' : 'detached'),
        isSystemDisk: flag(d.isSystemDisk),
        iops: d.iops ?? null,
        az: d.location?.availabilityZone || null,
        createdAt: isoOrNull(d.createdAt),
      });
    }
    pageToken = resp?.nextPageToken;
  } while (pageToken);
  return rows;
}

async function fetchLightsailBuckets(account) {
  const client = lightsailClient(account);
  const rows = [];
  let pageToken;
  do {
    const resp = await client.send(new GetBucketsCommand({ pageToken }));
    for (const b of resp?.buckets || []) {
      rows.push({
        name: b.name,
        arn: b.arn || null,
        bundle: b.bundleId || null,
        state: b.state?.code || null,
        objectVersioning: b.objectVersioning || null,
        readOnlyAccess: b.accessRules?.getObject === 'public' ? 1 : 0,
        ableToUpdateBundle: flag(b.ableToUpdateBundle),
        url: b.url || null,
        createdAt: isoOrNull(b.createdAt),
      });
    }
    pageToken = resp?.nextPageToken;
  } while (pageToken);
  return rows;
}

async function fetchLightsailLoadBalancers(account) {
  const client = lightsailClient(account);
  const rows = [];
  let pageToken;
  do {
    const resp = await client.send(new GetLoadBalancersCommand({ pageToken }));
    for (const l of resp?.loadBalancers || []) {
      const health = l.instanceHealthSummary || [];
      const certs = l.tlsCertificateSummaries || [];
      rows.push({
        name: l.name,
        arn: l.arn || null,
        dnsName: l.dnsName || null,
        state: l.state || null,
        protocol: l.protocol || null,
        instancePort: l.instancePort ?? null,
        healthCheckPath: l.healthCheckPath || null,
        attachedInstances: JSON.stringify(health.map((h) => h.instanceName).filter(Boolean)),
        healthyCount: health.filter((h) => h.instanceHealth === 'healthy').length,
        unhealthyCount: health.filter((h) => h.instanceHealth === 'unhealthy').length,
        tlsCertName: certs[0]?.name || null,
        tlsCertAttached: certs.length ? (certs.some((c) => c.isAttached) ? 1 : 0) : 0,
        // Load balancers report availabilityZone 'all'; the region is the useful location.
        az: (l.location?.availabilityZone && l.location.availabilityZone !== 'all' ? l.location.availabilityZone : l.location?.regionName) || null,
        createdAt: isoOrNull(l.createdAt),
      });
    }
    pageToken = resp?.nextPageToken;
  } while (pageToken);
  return rows;
}

// Distributions and DNS zones are global Lightsail resources served only from us-east-1.
async function fetchLightsailDistributions(account) {
  const client = lightsailClient(account, 'us-east-1');
  const rows = [];
  let pageToken;
  do {
    const resp = await client.send(new GetDistributionsCommand({ pageToken }));
    for (const d of resp?.distributions || []) {
      rows.push({
        name: d.name,
        arn: d.arn || null,
        status: d.status || null,
        isEnabled: flag(d.isEnabled),
        domainName: d.domainName || null,
        originName: d.origin?.name || null,
        originRegion: d.origin?.regionName || null,
        bundle: d.bundleId || null,
        certName: d.certificateName || null,
        alternativeDomains: JSON.stringify(d.alternativeDomainNames || []),
        createdAt: isoOrNull(d.createdAt),
      });
    }
    pageToken = resp?.nextPageToken;
  } while (pageToken);
  return rows;
}

async function fetchLightsailDomains(account) {
  const client = lightsailClient(account, 'us-east-1');
  const rows = [];
  let pageToken;
  do {
    const resp = await client.send(new GetDomainsCommand({ pageToken }));
    for (const d of resp?.domains || []) {
      rows.push({
        name: d.name,
        arn: d.arn || null,
        entryCount: (d.domainEntries || []).length,
        createdAt: isoOrNull(d.createdAt),
      });
    }
    pageToken = resp?.nextPageToken;
  } while (pageToken);
  return rows;
}

async function fetchLightsailStaticIps(account) {
  const client = lightsailClient(account);
  const rows = [];
  let pageToken;
  do {
    const resp = await client.send(new GetStaticIpsCommand({ pageToken }));
    for (const s of resp?.staticIps || []) {
      rows.push({
        name: s.name,
        arn: s.arn || null,
        ipAddress: s.ipAddress || null,
        isAttached: s.isAttached ? 1 : 0,
        attachedTo: s.attachedTo || null,
        az: s.location?.availabilityZone || s.location?.regionName || null,
        createdAt: isoOrNull(s.createdAt),
      });
    }
    pageToken = resp?.nextPageToken;
  } while (pageToken);
  return rows;
}

/** Average CPUUtilization over the last 15 minutes, per Lightsail instance name. */
async function fetchLightsailMetric(account, instanceName) {
  try {
    const client = lightsailClient(account);
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
    logger.debug(`[awsApi] Lightsail metric fetch failed for ${instanceName}: ${err.message}`);
    return null;
  }
}

/** { count, latestAt } for an instance's snapshots. */
async function fetchLightsailSnapshots(account, instanceName) {
  try {
    const client = lightsailClient(account);
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
    logger.debug(`[awsApi] Lightsail snapshot fetch failed for ${instanceName}: ${err.message}`);
    return { count: 0, latestAt: null };
  }
}

// ── ECS ──────────────────────────────────────────────────────────────────────

async function fetchEcsClusters(account) {
  const client = ecsClient(account);
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
async function fetchEcsServices(account, clusterArn) {
  const client = ecsClient(account);
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
async function fetchEcsServiceMetrics(account, clusterName, serviceNames) {
  const out = new Map();
  if (!serviceNames?.length) return out;
  try {
    const client = cloudwatchClient(account);
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
    logger.debug(`[awsApi] ECS service metrics fetch failed for cluster ${clusterName}: ${err.message}`);
  }
  return out;
}

// ── S3 ───────────────────────────────────────────────────────────────────────

async function fetchS3Buckets(account) {
  const client = s3Client(account);
  const resp = await client.send(new ListBucketsCommand({}));
  return (resp?.Buckets || []).map((b) => ({ name: b.Name, createdAt: b.CreationDate ? new Date(b.CreationDate).toISOString() : null }));
}

async function fetchBucketLocation(account, bucketName) {
  try {
    const client = s3Client(account);
    const resp = await client.send(new GetBucketLocationCommand({ Bucket: bucketName }));
    return resp?.LocationConstraint || 'us-east-1';
  } catch (err) {
    logger.debug(`[awsApi] GetBucketLocation failed for ${bucketName}: ${err.message}`);
    return 'us-east-1';
  }
}

async function fetchBucketPublicAccessBlocked(account, bucketName, region) {
  try {
    const client = s3Client(account, region);
    const resp = await client.send(new GetPublicAccessBlockCommand({ Bucket: bucketName }));
    const cfg = resp?.PublicAccessBlockConfiguration;
    return !!(cfg?.BlockPublicAcls && cfg?.BlockPublicPolicy && cfg?.IgnorePublicAcls && cfg?.RestrictPublicBuckets);
  } catch (err) {
    if (err.name === 'NoSuchPublicAccessBlockConfiguration') return false;
    logger.debug(`[awsApi] GetPublicAccessBlock failed for ${bucketName}: ${err.message}`);
    return false;
  }
}

async function fetchBucketVersioning(account, bucketName, region) {
  try {
    const client = s3Client(account, region);
    const resp = await client.send(new GetBucketVersioningCommand({ Bucket: bucketName }));
    return resp?.Status || 'Disabled';
  } catch (err) {
    logger.debug(`[awsApi] GetBucketVersioning failed for ${bucketName}: ${err.message}`);
    return 'Disabled';
  }
}

async function fetchBucketLifecycleRuleCount(account, bucketName, region) {
  try {
    const client = s3Client(account, region);
    const resp = await client.send(new GetBucketLifecycleConfigurationCommand({ Bucket: bucketName }));
    return (resp?.Rules || []).length;
  } catch (err) {
    if (err.name === 'NoSuchLifecycleConfiguration') return 0;
    logger.debug(`[awsApi] GetBucketLifecycleConfiguration failed for ${bucketName}: ${err.message}`);
    return 0;
  }
}

/** { sizeBytes, objectCount } — newest AWS/S3 daily datapoint over the last 3 days. */
async function fetchBucketStorageMetrics(account, bucketName, region) {
  try {
    const client = cloudwatchClient(account, region);
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
    logger.debug(`[awsApi] S3 CloudWatch metrics failed for ${bucketName}: ${err.message}`);
    return { sizeBytes: null, objectCount: null };
  }
}

// ── Bedrock (via CloudWatch AWS/Bedrock namespace) ────────────────────────────

/** Distinct ModelId dimension values reporting under AWS/Bedrock. */
async function fetchBedrockModelIds(account) {
  try {
    const client = cloudwatchClient(account);
    const resp = await client.send(new ListMetricsCommand({ Namespace: 'AWS/Bedrock' }));
    const ids = new Set();
    for (const m of resp?.Metrics || []) {
      const dim = (m.Dimensions || []).find((d) => d.Name === 'ModelId');
      if (dim?.Value) ids.add(dim.Value);
    }
    return [...ids];
  } catch (err) {
    logger.debug(`[awsApi] Bedrock ListMetrics failed: ${err.message}`);
    return [];
  }
}

/**
 * Daily Invocations(Sum)/InputTokenCount(Sum)/OutputTokenCount(Sum)/
 * InvocationLatency(Average) for one ModelId, last 30 days.
 * Returns [{ day, invocations, inputTokens, outputTokens, avgLatencyMs }].
 */
async function fetchBedrockDailyUsage(account, modelId) {
  try {
    const client = cloudwatchClient(account);
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
    logger.debug(`[awsApi] Bedrock GetMetricData failed for ${modelId}: ${err.message}`);
    return [];
  }
}

// ── Cost Explorer ────────────────────────────────────────────────────────────

/**
 * ONE GetCostAndUsage call ($0.01) - daily granularity, last 35 days through
 * today, grouped by SERVICE. Returns [{ day, service, amountUsd, amortizedUsd }]. Callers
 * MUST gate this behind the daily last_cost_capture_at stamp.
 */
async function fetchCostAndUsage(account) {
  const client = costExplorerClient(account);
  const end = new Date();
  const start = new Date(end.getTime() - 35 * 86400000);
  const fmt = (d) => d.toISOString().slice(0, 10);
  const rows = [];
  for await (const resp of pagedCostAndUsage(client, {
    TimePeriod: { Start: fmt(start), End: fmt(end) },
    Granularity: 'DAILY',
    Metrics: COST_METRICS,
    GroupBy: [{ Type: 'DIMENSION', Key: 'SERVICE' }],
  })) {
    for (const period of resp?.ResultsByTime || []) {
      const day = period.TimePeriod?.Start;
      for (const g of period.Groups || []) {
        const service = g.Keys?.[0] || 'Unknown';
        rows.push({ day, service, ...costAmounts(g) });
      }
    }
  }
  return rows;
}

/** Cost Explorer returns every metric in one request, so asking for both costs nothing extra. */
const COST_METRICS = ['UnblendedCost', 'AmortizedCost'];
const numOr0 = (v) => { const n = Number(v); return Number.isFinite(n) ? n : 0; };
const numOrNull = (v) => { if (v == null || v === '') return null; const n = Number(v); return Number.isFinite(n) ? n : null; };
/** { amountUsd, amortizedUsd } from a Group's Metrics (money fields arrive as strings). */
const costAmounts = (g) => ({
  amountUsd: numOr0(g.Metrics?.UnblendedCost?.Amount),
  amortizedUsd: numOrNull(g.Metrics?.AmortizedCost?.Amount),
});
const ceDay = (d) => (d instanceof Date ? d.toISOString().slice(0, 10) : String(d || '').slice(0, 10));

/**
 * GetCostAndUsage pages: a response that exceeds the service's page size carries NextPageToken
 * and the rest of the window is silently missing unless it is followed (a SERVICE + USAGE_TYPE
 * grouping on a real account truncated at 5,000 groups, 22 of 35 days). Each page is one
 * billable request; COST_PAGE_CAP bounds a runaway.
 */
const COST_PAGE_CAP = 20;
async function* pagedCostAndUsage(client, input) {
  let token;
  for (let page = 0; page < COST_PAGE_CAP; page++) {
    const resp = await client.send(new GetCostAndUsageCommand({ ...input, ...(token ? { NextPageToken: token } : {}) }));
    yield resp;
    token = resp?.NextPageToken;
    if (!token) return;
  }
}

/**
 * Shared GroupBy helper for the additional Cost Explorer groupings. Two call forms:
 *  - fetchCostAndUsageGrouped(account, 'USAGE_TYPE') - 35d DAILY window, one DIMENSION group,
 *    returns [{ day, key, amountUsd, amortizedUsd }] (the legacy form).
 *  - fetchCostAndUsageGrouped(account, { start, end, groupBy }) - start/end are YYYY-MM-DD (end
 *    exclusive) or Dates, groupBy is an array of CE GroupBy objects, e.g.
 *    [{ Type: 'TAG', Key: 'Environment' }, { Type: 'DIMENSION', Key: 'SERVICE' }]. Returns
 *    { rows: [{ day, keys: [...], amountUsd, amortizedUsd }], requests }. A TAG key comes back
 *    as 'Environment$prod' or 'Environment$' (nothing after the dollar = untagged); the caller splits.
 */
async function fetchCostAndUsageGrouped(account, groupByOrOpts) {
  const client = costExplorerClient(account);
  const opts = groupByOrOpts && typeof groupByOrOpts === 'object' ? groupByOrOpts : null;
  const end = opts?.end ? new Date(ceDay(opts.end)) : new Date();
  const start = opts?.start ? new Date(ceDay(opts.start)) : new Date(end.getTime() - 35 * 86400000);
  const groupBy = opts ? opts.groupBy : [{ Type: 'DIMENSION', Key: groupByOrOpts }];
  const rows = [];
  let requests = 0;
  const input = {
    TimePeriod: { Start: ceDay(start), End: ceDay(end) },
    Granularity: 'DAILY',
    Metrics: COST_METRICS,
    GroupBy: groupBy,
  };
  let token;
  for (let page = 0; page < COST_PAGE_CAP; page++) {
    const resp = await client.send(new GetCostAndUsageCommand({ ...input, ...(token ? { NextPageToken: token } : {}) }));
    requests++;
    for (const period of resp?.ResultsByTime || []) {
      const day = period.TimePeriod?.Start;
      for (const g of period.Groups || []) {
        const keys = (g.Keys || []).map((k) => k || 'Unknown');
        if (opts) rows.push({ day, keys, ...costAmounts(g) });
        else rows.push({ day, key: keys[0] || 'Unknown', ...costAmounts(g) });
      }
    }
    token = resp?.NextPageToken;
    if (!token) break;
  }
  return opts ? { rows, requests } : rows;
}

/**
 * [{ day, service, usageType, amountUsd, amortizedUsd, usageQty, usageUnit }] - ONE GetCostAndUsage
 * call grouped by SERVICE then USAGE_TYPE (Cost Explorer allows two groups), same window as
 * fetchCostAndUsage. UsageQuantity rides in the same request.
 */
async function fetchCostByUsageType(account) {
  const client = costExplorerClient(account);
  const end = new Date();
  const start = new Date(end.getTime() - 35 * 86400000);
  const fmt = (d) => d.toISOString().slice(0, 10);
  const rows = [];
  for await (const resp of pagedCostAndUsage(client, {
    TimePeriod: { Start: fmt(start), End: fmt(end) },
    Granularity: 'DAILY',
    Metrics: [...COST_METRICS, 'UsageQuantity'],
    GroupBy: [{ Type: 'DIMENSION', Key: 'SERVICE' }, { Type: 'DIMENSION', Key: 'USAGE_TYPE' }],
  })) {
    for (const period of resp?.ResultsByTime || []) {
      const day = period.TimePeriod?.Start;
      for (const g of period.Groups || []) {
        rows.push({
          day,
          service: g.Keys?.[0] || 'Unknown',
          usageType: g.Keys?.[1] || 'Unknown',
          ...costAmounts(g),
          usageQty: numOrNull(g.Metrics?.UsageQuantity?.Amount),
          usageUnit: g.Metrics?.UsageQuantity?.Unit || null,
        });
      }
    }
  }
  return rows;
}

/** 'ce:GetCostForecast' from "... is not authorized to perform: ce:GetCostForecast on resource ...", or null. */
function actionFromDeniedMessage(msg) {
  const m = String(msg || '').match(/perform:\s*([a-z0-9-]+:[A-Za-z0-9*]+)/);
  return m ? m[1] : null;
}

/**
 * Classify a Cost Explorer failure for the poller / UI:
 *  denied      AccessDeniedException or a "not authorized" message (IAM)
 *  not_enabled a ValidationException, or a message about a preference / opt-in / unsupported feature
 *  error       anything else
 * Denied wins over not_enabled so an IAM message that happens to mention a preference stays denied.
 */
function classifyCeError(err) {
  const msg = String(err?.message || '');
  if (err?.name === 'AccessDeniedException' || /not authorized/i.test(msg)) return 'denied';
  if (err?.name === 'ValidationException' || /enable|opt[ -]?in|preference|not supported|has not been/i.test(msg)) return 'not_enabled';
  return 'error';
}
const classifyCostResourceError = classifyCeError;

/**
 * Resource-level cost: GetCostAndUsageWithResources, DAILY, last 14 days (the API refuses older
 * starts), grouped by SERVICE then RESOURCE_ID. The API requires a Filter; the default excludes
 * Tax/Refund/Credit records, and a ValidationException about the filter is retried once with a
 * SERVICE filter built from opts.services. Each page is one billable request (stops at
 * opts.maxPages, default 10). Errors propagate; the poller classifies them.
 * Returns { rows: [{ day, service, resourceId, amountUsd }], pages }.
 */
async function fetchCostWithResources(account, opts, secondKey, rowKey) {
  const client = costExplorerClient(account);
  const maxPages = Math.max(1, opts.maxPages || 10);
  const end = new Date();
  // 13 days back: the API refuses a start earlier than 14 days ago and the day boundary is AWS's,
  // so exactly 14 could be refused depending on the hour.
  const start = new Date(end.getTime() - 13 * 86400000);
  const fmt = (d) => d.toISOString().slice(0, 10);
  const baseInput = {
    TimePeriod: { Start: fmt(start), End: fmt(end) },
    Granularity: 'DAILY',
    Metrics: ['UnblendedCost'],
    GroupBy: [{ Type: 'DIMENSION', Key: secondKey }, { Type: 'DIMENSION', Key: 'RESOURCE_ID' }],
  };
  let filter = { Not: { Dimensions: { Key: 'RECORD_TYPE', Values: ['Tax', 'Refund', 'Credit'] } } };
  let retried = false;
  const rows = [];
  let pages = 0;
  let token;
  while (pages < maxPages) {
    let resp;
    try {
      resp = await client.send(new GetCostAndUsageWithResourcesCommand({
        ...baseInput, Filter: filter, ...(token ? { NextPageToken: token } : {}),
      }));
    } catch (err) {
      const isFilterError = err?.name === 'ValidationException' && /filter/i.test(err.message || '');
      if (!retried && isFilterError && (opts.services || []).length) {
        retried = true;
        filter = { Dimensions: { Key: 'SERVICE', Values: opts.services, MatchOptions: ['EQUALS'] } };
        continue;
      }
      throw err;
    }
    pages++;
    for (const period of resp?.ResultsByTime || []) {
      const day = period.TimePeriod?.Start;
      for (const g of period.Groups || []) {
        const resourceId = g.Keys?.[1];
        if (!resourceId || resourceId === 'NoResourceId') continue;
        rows.push({
          day, [rowKey]: g.Keys?.[0] || 'Unknown', resourceId,
          amountUsd: Number(g.Metrics?.UnblendedCost?.Amount) || 0,
        });
      }
    }
    token = resp?.NextPageToken;
    if (!token) break;
  }
  return { rows, pages };
}

const fetchCostByResource = (account, opts = {}) => fetchCostWithResources(account, opts, 'SERVICE', 'service');

/** Same capture grouped by USAGE_TYPE then RESOURCE_ID: [{ day, usageType, resourceId, amountUsd }]. */
const fetchCostByResourceUsage = (account, opts = {}) => fetchCostWithResources(account, opts, 'USAGE_TYPE', 'usageType');

/** [{ day, instanceType, amountUsd }] — GroupBy DIMENSION/INSTANCE_TYPE, same window as fetchCostAndUsage. */
async function fetchCostByInstanceType(account) {
  const rows = await fetchCostAndUsageGrouped(account, 'INSTANCE_TYPE');
  return rows.map((r) => ({ day: r.day, instanceType: r.key, amountUsd: r.amountUsd, amortizedUsd: r.amortizedUsd }));
}

// -- FinOps fetchers (2026-10-27). Each returns { rows, requests } where requests counts the pages
// sent (0.01 USD each). Errors propagate; awsFinops.capability() classifies them. Money and
// percentage fields arrive as strings, hence numOr0 / numOrNull.

/** Run a paged Cost Explorer command; collect() receives each page. Token field names differ per command. */
async function cePaged(account, makeCommand, tokenIn, tokenOut, cap, collect) {
  const client = costExplorerClient(account);
  let token;
  let requests = 0;
  for (let page = 0; page < cap; page++) {
    const resp = await client.send(makeCommand(token ? { [tokenIn]: token } : {}));
    requests++;
    collect(resp);
    token = resp?.[tokenOut];
    if (!token) break;
  }
  return requests;
}

/** [{ tagKey, type, status, lastUpdatedDate }] - ListCostAllocationTags. Caller keeps Status 'Active'. */
async function fetchCostAllocationTags(account) {
  const rows = [];
  const requests = await cePaged(account,
    (extra) => new ListCostAllocationTagsCommand({ MaxResults: 1000, ...extra }), 'NextToken', 'NextToken', 5,
    (resp) => {
      for (const t of resp?.CostAllocationTags || []) {
        rows.push({ tagKey: t.TagKey || null, type: t.Type || null, status: t.Status || null, lastUpdatedDate: t.LastUpdatedDate ? String(t.LastUpdatedDate) : null });
      }
    });
  return { rows: rows.filter((r) => r.tagKey), requests };
}

/** [{ value, description }] - GetDimensionValues LINKED_ACCOUNT over the last 35 days. */
async function fetchLinkedAccountValues(account) {
  const end = new Date();
  const start = new Date(end.getTime() - 35 * 86400000);
  const rows = [];
  const requests = await cePaged(account,
    (extra) => new GetDimensionValuesCommand({
      TimePeriod: { Start: ceDay(start), End: ceDay(end) }, Dimension: 'LINKED_ACCOUNT', ...extra,
    }), 'NextPageToken', 'NextPageToken', 5,
    (resp) => {
      for (const v of resp?.DimensionValues || []) {
        if (v.Value) rows.push({ value: v.Value, description: v.Attributes?.description || null });
      }
    });
  return { rows, requests };
}

/**
 * [{ periodStart, periodEnd, meanUsd, lowerUsd, upperUsd }] - GetCostForecast, MONTHLY, 80% interval.
 * The caller skips the call when start >= end (last day of the month).
 */
async function fetchCostForecast(account, { metric = 'AMORTIZED_COST', start, end } = {}) {
  const client = costExplorerClient(account);
  const resp = await client.send(new GetCostForecastCommand({
    TimePeriod: { Start: ceDay(start), End: ceDay(end) },
    Metric: metric,
    Granularity: 'MONTHLY',
    PredictionIntervalLevel: 80,
  }));
  const rows = (resp?.ForecastResultsByTime || []).map((f) => ({
    periodStart: f.TimePeriod?.Start || null,
    periodEnd: f.TimePeriod?.End || null,
    meanUsd: numOrNull(f.MeanValue),
    lowerUsd: numOrNull(f.PredictionIntervalLowerBound),
    upperUsd: numOrNull(f.PredictionIntervalUpperBound),
  }));
  return { rows, requests: 1 };
}

/** [{ day, utilizationPct, commitmentUsd, usedUsd, unusedUsd, netSavingsUsd, onDemandEquivalentUsd }] */
async function fetchSavingsPlansUtilization(account, { start, end }) {
  const client = costExplorerClient(account);
  const resp = await client.send(new GetSavingsPlansUtilizationCommand({
    TimePeriod: { Start: ceDay(start), End: ceDay(end) }, Granularity: 'DAILY',
  }));
  const rows = (resp?.SavingsPlansUtilizationsByTime || []).map((u) => ({
    day: u.TimePeriod?.Start || null,
    utilizationPct: numOrNull(u.Utilization?.UtilizationPercentage),
    commitmentUsd: numOrNull(u.Utilization?.TotalCommitment),
    usedUsd: numOrNull(u.Utilization?.UsedCommitment),
    unusedUsd: numOrNull(u.Utilization?.UnusedCommitment),
    netSavingsUsd: numOrNull(u.Savings?.NetSavings),
    onDemandEquivalentUsd: numOrNull(u.Savings?.OnDemandCostEquivalent),
  })).filter((r) => r.day);
  return { rows, requests: 1 };
}

/** Case-insensitive attribute read from a Record<string, string>. */
function attr(attrs, ...names) {
  if (!attrs) return null;
  const wanted = names.map((n) => n.toLowerCase());
  for (const [k, v] of Object.entries(attrs)) {
    if (wanted.includes(String(k).toLowerCase()) && v != null && v !== '') return v;
  }
  return null;
}

/** [{ spArn, spType, paymentOption, term, hourlyCommitmentUsd, region, instanceFamily, startAt, endAt, utilizationPct, netSavingsUsd }] */
async function fetchSavingsPlansUtilizationDetails(account, { start, end }) {
  const rows = [];
  const requests = await cePaged(account,
    (extra) => new GetSavingsPlansUtilizationDetailsCommand({
      TimePeriod: { Start: ceDay(start), End: ceDay(end) }, ...extra,
    }), 'NextToken', 'NextToken', 5,
    (resp) => {
      for (const d of resp?.SavingsPlansUtilizationDetails || []) {
        if (!d.SavingsPlanArn) continue;
        const a = d.Attributes || {};
        rows.push({
          spArn: d.SavingsPlanArn,
          spType: attr(a, 'SavingsPlansType', 'SavingsPlanType'),
          paymentOption: attr(a, 'PaymentOption'),
          term: attr(a, 'PurchaseTerm', 'Term', 'TermInYears'),
          hourlyCommitmentUsd: numOrNull(attr(a, 'HourlyCommitment', 'HourlyCommitmentToPurchase')),
          region: attr(a, 'Region'),
          instanceFamily: attr(a, 'InstanceFamily'),
          startAt: attr(a, 'StartDateTime', 'StartTime', 'Start'),
          endAt: attr(a, 'EndDateTime', 'EndTime', 'End'),
          utilizationPct: numOrNull(d.Utilization?.UtilizationPercentage),
          netSavingsUsd: numOrNull(d.Savings?.NetSavings),
        });
      }
    });
  return { rows, requests };
}

/** [{ day, coveragePct, coveredUsd, onDemandUsd, totalUsd }] */
async function fetchSavingsPlansCoverage(account, { start, end }) {
  const rows = [];
  const requests = await cePaged(account,
    (extra) => new GetSavingsPlansCoverageCommand({
      TimePeriod: { Start: ceDay(start), End: ceDay(end) }, Granularity: 'DAILY',
      Metrics: ['SpendCoveredBySavingsPlans'], ...extra,
    }), 'NextToken', 'NextToken', 5,
    (resp) => {
      for (const c of resp?.SavingsPlansCoverages || []) {
        const day = c.TimePeriod?.Start;
        if (!day) continue;
        rows.push({
          day,
          coveragePct: numOrNull(c.Coverage?.CoveragePercentage),
          coveredUsd: numOrNull(c.Coverage?.SpendCoveredBySavingsPlans),
          onDemandUsd: numOrNull(c.Coverage?.OnDemandCost),
          totalUsd: numOrNull(c.Coverage?.TotalCost),
        });
      }
    });
  return { rows, requests };
}

/** [{ day, utilizationPct, purchasedHours, usedHours, unusedHours, netSavingsUsd }] */
async function fetchReservationUtilization(account, { start, end }) {
  const rows = [];
  const requests = await cePaged(account,
    (extra) => new GetReservationUtilizationCommand({
      TimePeriod: { Start: ceDay(start), End: ceDay(end) }, Granularity: 'DAILY', ...extra,
    }), 'NextPageToken', 'NextPageToken', 5,
    (resp) => {
      for (const u of resp?.UtilizationsByTime || []) {
        const day = u.TimePeriod?.Start;
        if (!day) continue;
        rows.push({
          day,
          utilizationPct: numOrNull(u.Total?.UtilizationPercentage),
          purchasedHours: numOrNull(u.Total?.PurchasedHours),
          usedHours: numOrNull(u.Total?.TotalActualHours),
          unusedHours: numOrNull(u.Total?.UnusedHours),
          netSavingsUsd: numOrNull(u.Total?.NetRISavings),
        });
      }
    });
  return { rows, requests };
}

/** [{ day, coveragePct, reservedHours, onDemandHours, totalHours }] */
async function fetchReservationCoverage(account, { start, end }) {
  const rows = [];
  const requests = await cePaged(account,
    (extra) => new GetReservationCoverageCommand({
      TimePeriod: { Start: ceDay(start), End: ceDay(end) }, Granularity: 'DAILY', ...extra,
    }), 'NextPageToken', 'NextPageToken', 5,
    (resp) => {
      for (const c of resp?.CoveragesByTime || []) {
        const day = c.TimePeriod?.Start;
        if (!day) continue;
        const h = c.Total?.CoverageHours;
        rows.push({
          day,
          coveragePct: numOrNull(h?.CoverageHoursPercentage),
          reservedHours: numOrNull(h?.ReservedHours),
          onDemandHours: numOrNull(h?.OnDemandHours),
          totalHours: numOrNull(h?.TotalRunningHours),
        });
      }
    });
  return { rows, requests };
}

/** [{ monitorArn, name, type, dimension }] - GetAnomalyMonitors. */
async function fetchAnomalyMonitors(account) {
  const rows = [];
  const requests = await cePaged(account,
    (extra) => new GetAnomalyMonitorsCommand({ ...extra }), 'NextPageToken', 'NextPageToken', 5,
    (resp) => {
      for (const m of resp?.AnomalyMonitors || []) {
        rows.push({ monitorArn: m.MonitorArn || null, name: m.MonitorName || null, type: m.MonitorType || null, dimension: m.MonitorDimension || null });
      }
    });
  return { rows, requests };
}

/** [{ anomalyId, startDay, endDay, monitorArn, dimensionValue, actualUsd, expectedUsd, impactUsd, impactPct, score, feedback, rootCauses }] */
async function fetchAnomalies(account, { start, end }) {
  const rows = [];
  const requests = await cePaged(account,
    (extra) => new GetAnomaliesCommand({
      DateInterval: { StartDate: ceDay(start), EndDate: ceDay(end) }, MaxResults: 100, ...extra,
    }), 'NextPageToken', 'NextPageToken', 5,
    (resp) => {
      for (const a of resp?.Anomalies || []) {
        if (!a.AnomalyId) continue;
        rows.push({
          anomalyId: a.AnomalyId,
          startDay: a.AnomalyStartDate ? String(a.AnomalyStartDate).slice(0, 10) : null,
          endDay: a.AnomalyEndDate ? String(a.AnomalyEndDate).slice(0, 10) : null,
          monitorArn: a.MonitorArn || null,
          dimensionValue: a.DimensionValue || null,
          actualUsd: numOrNull(a.Impact?.TotalActualSpend),
          expectedUsd: numOrNull(a.Impact?.TotalExpectedSpend),
          impactUsd: numOrNull(a.Impact?.TotalImpact),
          impactPct: numOrNull(a.Impact?.TotalImpactPercentage),
          score: numOrNull(a.AnomalyScore?.CurrentScore),
          feedback: a.Feedback || null,
          rootCauses: (a.RootCauses || []).map((r) => ({
            service: r.Service || null, region: r.Region || null, usageType: r.UsageType || null,
            linkedAccount: r.LinkedAccount || null, linkedAccountName: r.LinkedAccountName || null,
          })),
        });
      }
    });
  return { rows, requests };
}

/** EC2 rightsizing rows from Cost Explorer (needs the console preference, else not_enabled). */
async function fetchRightsizingRecommendations(account) {
  const rows = [];
  const requests = await cePaged(account,
    (extra) => new GetRightsizingRecommendationCommand({ Service: 'AmazonEC2', PageSize: 100, ...extra }),
    'NextPageToken', 'NextPageToken', 5,
    (resp) => {
      for (const r of resp?.RightsizingRecommendations || []) {
        const cur = r.CurrentInstance || {};
        const ec2 = cur.ResourceDetails?.EC2ResourceDetails || {};
        const action = r.RightsizingType || null;
        const target = r.ModifyRecommendationDetail?.TargetInstances?.[0];
        const savings = action === 'Terminate'
          ? numOrNull(r.TerminateRecommendationDetail?.EstimatedMonthlySavings)
          : numOrNull(target?.EstimatedMonthlySavings);
        rows.push({
          resourceId: cur.ResourceId || null,
          resourceName: cur.InstanceName || null,
          region: ec2.Region || null,
          currentType: ec2.InstanceType || null,
          action,
          recommendedType: target?.ResourceDetails?.EC2ResourceDetails?.InstanceType || null,
          estMonthlySavingsUsd: savings,
          currentMonthlyCostUsd: numOrNull(cur.MonthlyCost),
          cpuMaxPct: numOrNull(cur.ResourceUtilization?.EC2ResourceUtilization?.MaxCpuUtilizationPercentage),
        });
      }
    });
  return { rows: rows.filter((r) => r.resourceId), requests };
}

/** Compute Savings Plan purchase recommendation (1 year, no upfront, 30 day lookback). */
async function fetchSavingsPlansPurchaseRecommendation(account) {
  const client = costExplorerClient(account);
  const resp = await client.send(new GetSavingsPlansPurchaseRecommendationCommand({
    SavingsPlansType: 'COMPUTE_SP', TermInYears: 'ONE_YEAR', PaymentOption: 'NO_UPFRONT',
    LookbackPeriodInDays: 'THIRTY_DAYS', PageSize: 10,
  }));
  const rec = resp?.SavingsPlansPurchaseRecommendation || {};
  const rows = (rec.SavingsPlansPurchaseRecommendationDetails || []).map((d) => ({
    spType: rec.SavingsPlansType || 'COMPUTE_SP',
    term: rec.TermInYears || 'ONE_YEAR',
    paymentOption: rec.PaymentOption || 'NO_UPFRONT',
    hourlyCommitmentUsd: numOrNull(d.HourlyCommitmentToPurchase),
    estMonthlySavingsUsd: numOrNull(d.EstimatedMonthlySavingsAmount),
    estSavingsPct: numOrNull(d.EstimatedSavingsPercentage),
    estOnDemandCostUsd: numOrNull(d.EstimatedOnDemandCost),
    currentAvgHourlyOnDemandUsd: numOrNull(d.CurrentAverageHourlyOnDemandSpend),
    lookbackDays: 30,
  }));
  return { rows, requests: 1 };
}

// ── AWS Service Health RSS ──────────────────────────────────────────────────

const textOf = (v) => (v && typeof v === 'object' ? (v['#text'] ?? '') : (v ?? ''));

/**
 * status.aws.amazon.com/rss/<service>-<region>.rss — public, no auth. Never
 * throws: network/parse failures and 404/empty feeds (a healthy service)
 * both resolve to []. Returns [{ title, summary, publishedAt }].
 */
async function fetchHealthRss(service, region) {
  try {
    const url = `https://status.aws.amazon.com/rss/${service}-${region}.rss`;
    const resp = await axios.get(url, { timeout: 5000 });
    const parsed = healthXmlParser.parse(resp.data);
    let items = parsed?.rss?.channel?.item || [];
    if (!Array.isArray(items)) items = [items];
    return items.map((it) => ({
      title: String(textOf(it.title)),
      summary: String(textOf(it.description)).slice(0, 500),
      publishedAt: it.pubDate ? new Date(it.pubDate).toISOString() : null,
    }));
  } catch (err) {
    logger.debug(`[awsApi] health RSS fetch failed for ${service}-${region}: ${err.message}`);
    return [];
  }
}

// ── RDS ──────────────────────────────────────────────────────────────────────

async function fetchRdsInstances(account) {
  const client = rdsClient(account);
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
async function fetchRdsMetrics(account, dbIds) {
  const out = new Map();
  if (!dbIds?.length) return out;
  const client = cloudwatchClient(account);
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

async function fetchLambdaFunctions(account) {
  const client = lambdaClient(account);
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
async function fetchLambdaMetrics(account, functionNames) {
  const out = new Map();
  if (!functionNames?.length) return out;
  const client = cloudwatchClient(account);
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

async function fetchDynamoTableNames(account) {
  const client = dynamoClient(account);
  const names = [];
  let exclusiveStartTableName;
  do {
    const resp = await client.send(new ListTablesCommand({ ExclusiveStartTableName: exclusiveStartTableName }));
    names.push(...(resp?.TableNames || []));
    exclusiveStartTableName = resp?.LastEvaluatedTableName;
  } while (exclusiveStartTableName);
  return names;
}

async function fetchDynamoTable(account, name) {
  const client = dynamoClient(account);
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

async function fetchEcrRepos(account) {
  const client = ecrClient(account);
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
async function fetchEcrRepoImages(account, repositoryName) {
  const client = ecrClient(account);
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

async function fetchVpcs(account) {
  const client = ec2Client(account);
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

async function fetchSubnets(account) {
  const client = ec2Client(account);
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

async function fetchNatGateways(account) {
  const client = ec2Client(account);
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

async function fetchSecurityGroups(account) {
  const client = ec2Client(account);
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

async function fetchInternetGateways(account) {
  const client = ec2Client(account);
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
async function fetchCoEnrollmentStatus(account) {
  const client = computeOptimizerClient(account);
  const resp = await client.send(new GetEnrollmentStatusCommand({}));
  return { status: resp?.status || null, memberAccountsEnrolled: !!resp?.memberAccountsEnrolled };
}

async function fetchCoEc2Recommendations(account) {
  const client = computeOptimizerClient(account);
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

async function fetchCoEbsRecommendations(account) {
  const client = computeOptimizerClient(account);
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

async function fetchCoLambdaRecommendations(account) {
  const client = computeOptimizerClient(account);
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

async function fetchCoEcsRecommendations(account) {
  const client = computeOptimizerClient(account);
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
async function testConnection(account) {
  if (credentialExpired(account)) {
    return { ok: false, error: `Session credentials expired at ${field(account, 'credentialExpiresAt', 'credential_expires_at')}.` };
  }
  let identity = null;
  try {
    const sts = new STSClient(clientConfig(account));
    const who = await sts.send(new GetCallerIdentityCommand({}));
    identity = { account: who?.Account || null, arn: who?.Arn || null, userId: who?.UserId || null };
  } catch (err) {
    return { ok: false, error: explainAuthError(err, account), identity };
  }
  try {
    const client = ec2Client(account);
    const resp = await client.send(new DescribeInstancesCommand({ MaxResults: 5 }));
    const instanceCount = (resp?.Reservations || []).reduce((n, r) => n + (r.Instances || []).length, 0);
    return { ok: true, instanceCount, identity };
  } catch (err) {
    return { ok: false, error: explainAuthError(err, account), identity };
  }
}

/** The account number STS reports for the credentials, or null. Never throws. */
async function fetchCallerAccount(account) {
  try {
    const sts = new STSClient(clientConfig(account));
    const who = await sts.send(new GetCallerIdentityCommand({}));
    return who?.Account ? String(who.Account) : null;
  } catch { return null; }
}

module.exports = {
  fetchCallerAccount,
  creds, credSource, credentialSummary, credentialExpired, credentialProvider, explainAuthError,
  ec2Client, lightsailClient, ecsClient, s3Client, cloudwatchClient, costExplorerClient,
  rdsClient, lambdaClient, dynamoClient, ecrClient,
  fetchEc2Instances, fetchEbsVolumes, fetchEc2Metrics,
  fetchLightsailInstances, fetchLightsailMetric, fetchLightsailSnapshots,
  fetchLightsailBundles, fetchLightsailDatabaseBundles, fetchLightsailDatabases, fetchLightsailDisks,
  fetchLightsailBuckets, fetchLightsailLoadBalancers, fetchLightsailDistributions,
  fetchLightsailDomains, fetchLightsailStaticIps,
  fetchEcsClusters, fetchEcsServices, fetchEcsServiceMetrics,
  fetchS3Buckets, fetchBucketLocation, fetchBucketPublicAccessBlocked, fetchBucketVersioning,
  fetchBucketLifecycleRuleCount, fetchBucketStorageMetrics,
  fetchBedrockModelIds, fetchBedrockDailyUsage,
  fetchCostAndUsage, fetchCostAndUsageGrouped, fetchCostByUsageType, fetchCostByInstanceType, fetchCostByResource, fetchCostByResourceUsage, classifyCostResourceError, classifyCeError, actionFromDeniedMessage, pagedCostAndUsage,
  fetchCostAllocationTags, fetchLinkedAccountValues, fetchCostForecast, fetchSavingsPlansUtilization,
  fetchSavingsPlansUtilizationDetails, fetchSavingsPlansCoverage, fetchReservationUtilization,
  fetchReservationCoverage, fetchAnomalyMonitors, fetchAnomalies, fetchRightsizingRecommendations,
  fetchSavingsPlansPurchaseRecommendation,
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
