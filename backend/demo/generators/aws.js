// AWS scope demo data: 1 account ("Demo AWS", us-east-2), 8 EC2 instances,
// 10 EBS volumes, 2 Lightsail instances, 2 ECS clusters + 6 services, 6 S3
// buckets, 45 days of Cost Explorer data across 6 services, 30 days of
// Bedrock usage across 3 models, and 7 days of account metrics history.
// Includes deliberate trouble so the Overview issues panel demos every rule:
// an EC2 instance with a failed status check, an ECS service running under
// its desired count, yesterday's total AWS cost ~40% above the day before
// (tripping the 30% cost-spike threshold), a publicly-accessible S3 bucket,
// and unattached EBS volumes.
// FinOps round (2026-10-27): amortized cost beside unblended, a Savings Plan line, per-model Bedrock
// billing services with token usage quantities, tag allocation (Environment, Team), Savings Plan
// utilization and coverage, two plans, anomalies, forecasts, budgets, recommendation lifecycle and
// capability status. Everything is relative to now and rewritten (DELETE then INSERT) on each seed.
const { randInt, randFloat, pick, chance, rngFor } = require('./core');

const EC2_INSTANCES = [
  { instanceId: 'i-0aaa1111demo01', name: 'web-01', state: 'running', instanceType: 'm5.large', az: 'us-east-2a', privateIp: '10.20.1.11', publicIp: '3.18.100.11', platform: null, launchDaysAgo: 240, cpuUtil: 22.4, statusCheck: 'ok' },
  { instanceId: 'i-0aaa2222demo02', name: 'web-02', state: 'running', instanceType: 'm5.large', az: 'us-east-2b', privateIp: '10.20.2.12', publicIp: '3.18.100.12', platform: null, launchDaysAgo: 240, cpuUtil: 18.1, statusCheck: 'ok' },
  { instanceId: 'i-0aaa3333demo03', name: 'app-01', state: 'running', instanceType: 'm5.xlarge', az: 'us-east-2a', privateIp: '10.20.1.21', publicIp: null, platform: null, launchDaysAgo: 180, cpuUtil: 61.7, statusCheck: 'ok' },
  { instanceId: 'i-0aaa4444demo04', name: 'app-02', state: 'running', instanceType: 'm5.xlarge', az: 'us-east-2c', privateIp: '10.20.3.22', publicIp: null, platform: null, launchDaysAgo: 180, cpuUtil: 55.3, statusCheck: 'failed: instance status check' },
  { instanceId: 'i-0aaa5555demo05', name: 'db-01', state: 'running', instanceType: 'r5.large', az: 'us-east-2a', privateIp: '10.20.1.31', publicIp: null, platform: null, launchDaysAgo: 300, cpuUtil: 44.9, statusCheck: 'ok' },
  { instanceId: 'i-0aaa6666demo06', name: 'batch-worker-01', state: 'stopped', instanceType: 't3.medium', az: 'us-east-2b', privateIp: '10.20.2.41', publicIp: null, platform: null, launchDaysAgo: 90, cpuUtil: null, statusCheck: 'not-applicable' },
  { instanceId: 'i-0aaa7777demo07', name: 'batch-worker-02', state: 'stopped', instanceType: 't3.medium', az: 'us-east-2b', privateIp: '10.20.2.42', publicIp: null, platform: null, launchDaysAgo: 90, cpuUtil: null, statusCheck: 'not-applicable' },
  { instanceId: 'i-0aaa8888demo08', name: 'jenkins-ci', state: 'running', instanceType: 't3.large', az: 'us-east-2c', privateIp: '10.20.3.51', publicIp: '3.18.100.51', platform: null, launchDaysAgo: 400, cpuUtil: 12.6, statusCheck: 'ok' },
];

const EBS_VOLUMES = [
  { volumeId: 'vol-0bbb1111demo01', state: 'in-use', sizeGb: 100, volumeType: 'gp3', az: 'us-east-2a', attachedInstanceId: 'i-0aaa1111demo01' },
  { volumeId: 'vol-0bbb2222demo02', state: 'in-use', sizeGb: 50, volumeType: 'gp3', az: 'us-east-2b', attachedInstanceId: 'i-0aaa2222demo02' },
  { volumeId: 'vol-0bbb3333demo03', state: 'in-use', sizeGb: 200, volumeType: 'gp3', az: 'us-east-2a', attachedInstanceId: 'i-0aaa3333demo03' },
  { volumeId: 'vol-0bbb4444demo04', state: 'in-use', sizeGb: 200, volumeType: 'gp3', az: 'us-east-2c', attachedInstanceId: 'i-0aaa4444demo04' },
  { volumeId: 'vol-0bbb5555demo05', state: 'in-use', sizeGb: 500, volumeType: 'io2', az: 'us-east-2a', attachedInstanceId: 'i-0aaa5555demo05' },
  { volumeId: 'vol-0bbb6666demo06', state: 'in-use', sizeGb: 50, volumeType: 'gp3', az: 'us-east-2b', attachedInstanceId: 'i-0aaa6666demo06' },
  { volumeId: 'vol-0bbb7777demo07', state: 'in-use', sizeGb: 50, volumeType: 'gp3', az: 'us-east-2b', attachedInstanceId: 'i-0aaa7777demo07' },
  { volumeId: 'vol-0bbb8888demo08', state: 'available', sizeGb: 20, volumeType: 'gp3', az: 'us-east-2a', attachedInstanceId: null },
  { volumeId: 'vol-0bbb9999demo09', state: 'available', sizeGb: 100, volumeType: 'gp2', az: 'us-east-2b', attachedInstanceId: null },
  { volumeId: 'vol-0bbba000demo10', state: 'available', sizeGb: 8, volumeType: 'gp3', az: 'us-east-2c', attachedInstanceId: null },
];

const LIGHTSAIL_INSTANCES = [
  { name: 'static-site-01', state: 'running', blueprint: 'nginx', bundle: 'micro_3_0', az: 'us-east-2a', publicIp: '18.220.10.20', cpuUtil: 6.2, snapshotCount: 3, latestSnapshotDaysAgo: 2 },
  { name: 'wp-blog-01', state: 'running', blueprint: 'wordpress', bundle: 'small_3_0', az: 'us-east-2b', publicIp: '18.220.10.21', cpuUtil: 14.8, snapshotCount: 5, latestSnapshotDaysAgo: 1 },
];

const ECS_CLUSTERS = [
  { clusterArn: 'arn:aws:ecs:us-east-2:100200300400:cluster/prod-cluster', clusterName: 'prod-cluster', status: 'ACTIVE', runningTasks: 10, pendingTasks: 0, serviceCount: 4, containerInstances: 3 },
  { clusterArn: 'arn:aws:ecs:us-east-2:100200300400:cluster/batch-cluster', clusterName: 'batch-cluster', status: 'ACTIVE', runningTasks: 2, pendingTasks: 0, serviceCount: 2, containerInstances: 1 },
];

const ECS_SERVICES = [
  { clusterName: 'prod-cluster', serviceName: 'api-service', status: 'ACTIVE', desiredCount: 3, runningCount: 3, pendingCount: 0, launchType: 'FARGATE', cpuUtil: 40.2, memoryUtil: 55.1 },
  { clusterName: 'prod-cluster', serviceName: 'worker-service', status: 'ACTIVE', desiredCount: 3, runningCount: 1, pendingCount: 0, launchType: 'FARGATE', cpuUtil: 70.5, memoryUtil: 60.3 },
  { clusterName: 'prod-cluster', serviceName: 'web-service', status: 'ACTIVE', desiredCount: 2, runningCount: 2, pendingCount: 0, launchType: 'FARGATE', cpuUtil: 30.1, memoryUtil: 45.6 },
  { clusterName: 'prod-cluster', serviceName: 'cache-service', status: 'ACTIVE', desiredCount: 1, runningCount: 1, pendingCount: 0, launchType: 'EC2', cpuUtil: 20.4, memoryUtil: 35.9 },
  { clusterName: 'batch-cluster', serviceName: 'nightly-etl', status: 'ACTIVE', desiredCount: 1, runningCount: 1, pendingCount: 0, launchType: 'FARGATE', cpuUtil: 15.2, memoryUtil: 25.7 },
  { clusterName: 'batch-cluster', serviceName: 'report-gen', status: 'ACTIVE', desiredCount: 1, runningCount: 1, pendingCount: 0, launchType: 'FARGATE', cpuUtil: 10.9, memoryUtil: 20.4 },
];

const S3_BUCKETS = [
  { name: 'demo-aws-app-assets', region: 'us-east-2', sizeBytes: 45 * 1024 ** 3, objectCount: 12000, publicAccessBlocked: 1, versioning: 'Enabled', lifecycleRules: 2, createdDaysAgo: 400 },
  { name: 'demo-aws-logs-archive', region: 'us-east-2', sizeBytes: 900 * 1024 ** 3, objectCount: 500000, publicAccessBlocked: 1, versioning: 'Suspended', lifecycleRules: 3, createdDaysAgo: 380 },
  { name: 'demo-aws-backups', region: 'us-east-2', sizeBytes: Math.round(2.4 * 1024 ** 4), objectCount: 8000, publicAccessBlocked: 1, versioning: 'Enabled', lifecycleRules: 1, createdDaysAgo: 360 },
  { name: 'demo-aws-static-site', region: 'us-east-1', sizeBytes: Math.round(1.2 * 1024 ** 3), objectCount: 340, publicAccessBlocked: 0, versioning: 'Disabled', lifecycleRules: 0, createdDaysAgo: 200 },
  { name: 'demo-aws-terraform-state', region: 'us-east-2', sizeBytes: 12 * 1024 ** 2, objectCount: 45, publicAccessBlocked: 1, versioning: 'Enabled', lifecycleRules: 0, createdDaysAgo: 300 },
  { name: 'demo-aws-data-lake', region: 'us-east-2', sizeBytes: Math.round(5.6 * 1024 ** 4), objectCount: 2100000, publicAccessBlocked: 1, versioning: 'Disabled', lifecycleRules: 4, createdDaysAgo: 250 },
];

const BEDROCK_OPUS_SERVICE = 'Claude Opus 4.6 (Amazon Bedrock Edition)';
const BEDROCK_SONNET_SERVICE = 'Claude Sonnet 4.6 (Amazon Bedrock Edition)';
const SP_SERVICE = 'Savings Plans for AWS Compute usage';
const COST_SERVICES = [
  { service: 'Amazon Elastic Compute Cloud - Compute', base: 45 },
  { service: 'Amazon Simple Storage Service', base: 8 },
  { service: BEDROCK_OPUS_SERVICE, base: 6 },
  { service: BEDROCK_SONNET_SERVICE, base: 3 },
  { service: SP_SERVICE, base: 15 },
  { service: 'Amazon EC2 Container Service', base: 12 },
  { service: 'Amazon Lightsail', base: 3.5 },
  { service: 'EC2 - Other', base: 7.5 },
  { service: 'Amazon Relational Database Service', base: 10 },
  { service: 'AWS Lambda', base: 0.8 },
  { service: 'AmazonCloudWatch', base: 2 },
];
const COST_DAYS = 45;
const SPIKE_MULTIPLIER = 1.4; // yesterday vs day-before -> ~40% above, trips 30% rule

const BEDROCK_MODELS = [
  'us.anthropic.claude-opus-4-6-v1',
  'us.anthropic.claude-sonnet-4-6-v1',
  'amazon.titan-text-express-v1',
];
const BEDROCK_DAYS = 30;
const METRICS_HISTORY_DAYS = 7;

const S3_HISTORY_BUCKETS = ['demo-aws-app-assets', 'demo-aws-logs-archive', 'demo-aws-backups'];
const S3_JUMP_BUCKET = 'demo-aws-logs-archive';
const S3_JUMP_AT_DAY = 30;
const S3_JUMP_FACTOR = 1.35;
const S3_HISTORY_DAYS = 90;

const RDS_HISTORY_DB = 'demo-analytics-mysql';
const RDS_HISTORY_DAYS = 30;

// Each usage type carries its Cost Explorer service so the By Service rows can be drilled into.
const COMPUTE_SERVICE = 'Amazon Elastic Compute Cloud - Compute';
const S3_SERVICE = 'Amazon Simple Storage Service';
const LIGHTSAIL_SERVICE = 'Amazon Lightsail';
const RDS_SERVICE = 'Amazon Relational Database Service';
const LAMBDA_SERVICE = 'AWS Lambda';
const USAGE_TYPES = [
  { service: COMPUTE_SERVICE, usageType: 'USE2-BoxUsage:m5.large', base: 8 },
  { service: COMPUTE_SERVICE, usageType: 'USE2-BoxUsage:m5.xlarge', base: 6 },
  { service: 'EC2 - Other', usageType: 'USE2-EBS:VolumeUsage.gp3', base: 4 },
  { service: 'EC2 - Other', usageType: 'USE2-NatGateway-Hours', base: 3.5 },
  { service: COMPUTE_SERVICE, usageType: 'USE2-DataTransfer-Out-Bytes', base: 2.5 },
  { service: S3_SERVICE, usageType: 'USE2-TimedStorage-ByteHrs', base: 2 },
  { service: S3_SERVICE, usageType: 'USE2-Requests-Tier1', base: 1.2 },
  { service: LAMBDA_SERVICE, usageType: 'USE2-Lambda-GB-Second', base: 0.8 },
  // Lightsail sums to the seeded 3.5 a day for 'Amazon Lightsail'.
  { service: LIGHTSAIL_SERVICE, usageType: 'USE2-BundleUsage:2GB', base: 2 },
  { service: LIGHTSAIL_SERVICE, usageType: 'USE2-DatabaseUsage:1GB', base: 1 },
  { service: LIGHTSAIL_SERVICE, usageType: 'USE2-LoadBalancerUsage', base: 0.5 },
];
const BEDROCK_BILLING = [
  { service: BEDROCK_OPUS_SERVICE, price: { input: 15, output: 75, cacheRead: 1.5, cacheWrite: 18.75 } },
  { service: BEDROCK_SONNET_SERVICE, price: { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 } },
];
const BEDROCK_TOKEN_KINDS = [
  { id: 'cacheRead', usage: 'CacheReadInput', share: 0.45 },
  { id: 'cacheWrite', usage: 'CacheWriteInput', share: 0.2 },
  { id: 'input', usage: 'Input', share: 0.1 },
  { id: 'output', usage: 'Output', share: 0.25 },
];
const COST_RESOURCE_DAYS = 14;
const LIGHTSAIL_DB_ARN = 'arn:aws:lightsail:us-east-2:893373391538:RelationalDatabase/demo-ls-db-01';
const COST_USAGE_DAYS = 45;

const INSTANCE_TYPE_COSTS = [
  { instanceType: 'm5.large', base: 18 },
  { instanceType: 'm5.xlarge', base: 24 },
  { instanceType: 't3.medium', base: 4 },
];
const COST_INSTANCE_TYPE_DAYS = 45;

const OPTIMIZER_RECOMMENDATIONS = [
  { source: 'compute-optimizer', resourceType: 'ec2', resourceId: 'i-0aaa4444demo04', resourceName: 'app-02', region: 'us-east-2', finding: 'Overprovisioned', currentConfig: 'm5.xlarge', recommendedConfig: 'm5.large', reason: 'CPU and memory utilization consistently underused over the last 14 days', savingsUsd: 45.00 },
  { source: 'compute-optimizer', resourceType: 'ec2', resourceId: 'i-0aaa8888demo08', resourceName: 'jenkins-ci', region: 'us-east-2', finding: 'Overprovisioned', currentConfig: 't3.large', recommendedConfig: 't3.medium', reason: 'CPU utilization consistently underused over the last 14 days', savingsUsd: 15.50 },
  { source: 'compute-optimizer', resourceType: 'ebs', resourceId: 'vol-0bbb5555demo05', resourceName: 'vol-0bbb5555demo05', region: 'us-east-2', finding: 'NotOptimized', currentConfig: 'io2, 500 GiB', recommendedConfig: 'gp3, 500 GiB', reason: 'Provisioned IOPS exceed observed usage', savingsUsd: 62.00 },
  { source: 'compute-optimizer', resourceType: 'lambda', resourceId: 'demo-nightly-etl', resourceName: 'demo-nightly-etl', region: 'us-east-2', finding: 'Overprovisioned', currentConfig: '1024 MB', recommendedConfig: '512 MB', reason: 'Memory allocation exceeds peak usage', savingsUsd: 3.20 },
  { source: 'compute-optimizer', resourceType: 'ecs', resourceId: 'prod-cluster/worker-service', resourceName: 'worker-service', region: 'us-east-2', finding: 'Underprovisioned', currentConfig: '0.5 vCPU / 1 GB', recommendedConfig: '1 vCPU / 2 GB', reason: 'CPU utilization consistently above target during peak', savingsUsd: null },
  { source: 'heuristic', resourceType: 'ebs', resourceId: 'vol-0bbb9999demo09', resourceName: 'vol-0bbb9999demo09', region: 'us-east-2', finding: 'gp2-to-gp3', currentConfig: 'gp2, 100 GiB', recommendedConfig: 'gp3', reason: 'gp3 is cheaper and faster than gp2 at the same size', savingsUsd: 2.00 },
  { source: 'heuristic', resourceType: 'ebs', resourceId: 'vol-0bbb8888demo08', resourceName: 'vol-0bbb8888demo08', region: 'us-east-2', finding: 'ebs-unattached', currentConfig: 'gp3, 20 GiB, available', recommendedConfig: 'delete or snapshot-and-delete', reason: 'Volume has been unattached', savingsUsd: 1.60 },
  { source: 'heuristic', resourceType: 'ebs', resourceId: 'vol-0bbba000demo10', resourceName: 'vol-0bbba000demo10', region: 'us-east-2', finding: 'ebs-unattached', currentConfig: 'gp3, 8 GiB, available', recommendedConfig: 'delete or snapshot-and-delete', reason: 'Volume has been unattached', savingsUsd: 0.64 },
  { source: 'heuristic', resourceType: 'ec2', resourceId: 'i-0aaa6666demo06', resourceName: 'batch-worker-01', region: 'us-east-2', finding: 'stopped-ec2-ebs', currentConfig: 'stopped, 1 attached volume', recommendedConfig: 'terminate or snapshot-and-delete attached volumes', reason: 'stopped instance still pays for attached EBS', savingsUsd: 4.00 },
  { source: 'heuristic', resourceType: 'vpc', resourceId: 'vpc-0demo1111prod', resourceName: 'demo-prod-vpc', region: 'us-east-2', finding: 'nat-gateway-consolidation', currentConfig: '2 NAT gateways', recommendedConfig: '1 NAT gateway', reason: 'multiple NAT gateways ~$32.85/mo each', savingsUsd: 32.85 },
];

const HEALTH_EVENTS = [
  { feed: 'ec2-us-east-2', service: 'ec2', region: 'us-east-2', title: 'Increased API error rates for EC2 in US-EAST-2', summary: 'Between 08:00 and 08:45 UTC, some customers experienced increased error rates for EC2 API calls. The issue has been resolved.', hoursAgo: 5 },
  { feed: 's3-us-east-2', service: 's3', region: 'us-east-2', title: 'Informational message about Amazon S3', summary: 'We are investigating increased request latencies for a subset of S3 requests in the US-EAST-2 Region.', hoursAgo: 72 },
];

const RDS_INSTANCES = [
  { dbId: 'demo-prod-postgres', engine: 'postgres', engineVersion: '15.4', instanceClass: 'db.r5.large', status: 'available', multiAz: 1, allocatedGb: 200, freeStorageBytes: Math.round(200 * 1024 ** 3 * 0.45), cpuUtil: 32.1, connections: 24, backupRetentionDays: 7, latestBackupDaysAgo: 0, endpoint: 'demo-prod-postgres.abcdemo.us-east-2.rds.amazonaws.com' },
  { dbId: 'demo-analytics-mysql', engine: 'mysql', engineVersion: '8.0.35', instanceClass: 'db.m5.large', status: 'available', multiAz: 0, allocatedGb: 500, freeStorageBytes: Math.round(500 * 1024 ** 3 * 0.09), cpuUtil: 54.6, connections: 60, backupRetentionDays: 7, latestBackupDaysAgo: 0, endpoint: 'demo-analytics-mysql.abcdemo.us-east-2.rds.amazonaws.com' },
  { dbId: 'demo-staging-postgres', engine: 'aurora-postgresql', engineVersion: '15.4', instanceClass: 'db.t3.medium', status: 'available', multiAz: 0, allocatedGb: 50, freeStorageBytes: Math.round(50 * 1024 ** 3 * 0.7), cpuUtil: 8.9, connections: 4, backupRetentionDays: 3, latestBackupDaysAgo: 1, endpoint: 'demo-staging-postgres.abcdemo.us-east-2.rds.amazonaws.com' },
];

const LAMBDA_FUNCTIONS = [
  { name: 'demo-api-router', runtime: 'nodejs20.x', memoryMb: 256, timeoutS: 10, codeSizeBytes: 4 * 1024 ** 2, lastModifiedDaysAgo: 5, invocations24h: 84000, errors24h: 0, avgDurationMs: 45.2 },
  { name: 'demo-image-resize', runtime: 'python3.12', memoryMb: 512, timeoutS: 30, codeSizeBytes: 12 * 1024 ** 2, lastModifiedDaysAgo: 20, invocations24h: 3400, errors24h: 0, avgDurationMs: 310.5 },
  { name: 'demo-nightly-etl', runtime: 'python3.12', memoryMb: 1024, timeoutS: 300, codeSizeBytes: 30 * 1024 ** 2, lastModifiedDaysAgo: 40, invocations24h: 24, errors24h: 0, avgDurationMs: 42000 },
  { name: 'demo-webhook-handler', runtime: 'nodejs20.x', memoryMb: 128, timeoutS: 5, codeSizeBytes: 1 * 1024 ** 2, lastModifiedDaysAgo: 2, invocations24h: 15200, errors24h: 187, avgDurationMs: 22.8 },
  { name: 'demo-auth-authorizer', runtime: 'nodejs20.x', memoryMb: 128, timeoutS: 5, codeSizeBytes: 2 * 1024 ** 2, lastModifiedDaysAgo: 60, invocations24h: 92000, errors24h: 0, avgDurationMs: 12.4 },
  { name: 'demo-report-generator', runtime: 'python3.12', memoryMb: 512, timeoutS: 60, codeSizeBytes: 8 * 1024 ** 2, lastModifiedDaysAgo: 15, invocations24h: 480, errors24h: 0, avgDurationMs: 1850.3 },
];

const DYNAMO_TABLES = [
  { name: 'demo-sessions', status: 'ACTIVE', billingMode: 'PAY_PER_REQUEST', itemCount: 42000, sizeBytes: 18 * 1024 ** 2, readCapacity: null, writeCapacity: null },
  { name: 'demo-user-profiles', status: 'ACTIVE', billingMode: 'PAY_PER_REQUEST', itemCount: 8600, sizeBytes: 6 * 1024 ** 2, readCapacity: null, writeCapacity: null },
  { name: 'demo-orders', status: 'ACTIVE', billingMode: 'PROVISIONED', itemCount: 150000, sizeBytes: 210 * 1024 ** 2, readCapacity: 20, writeCapacity: 10 },
  { name: 'demo-audit-log', status: 'ACTIVE', billingMode: 'PROVISIONED', itemCount: 900000, sizeBytes: 1200 * 1024 ** 2, readCapacity: 5, writeCapacity: 5 },
];

const ECR_REPOS = [
  { name: 'demo-api-service', imageCount: 42, sizeBytes: Math.round(3.1 * 1024 ** 3), scanOnPush: 1, latestPushDaysAgo: 1 },
  { name: 'demo-worker-service', imageCount: 30, sizeBytes: Math.round(2.4 * 1024 ** 3), scanOnPush: 1, latestPushDaysAgo: 3 },
  { name: 'demo-batch-jobs', imageCount: 15, sizeBytes: Math.round(1.1 * 1024 ** 3), scanOnPush: 0, latestPushDaysAgo: 12 },
];

const VPCS = [
  { vpcId: 'vpc-0demo1111prod', name: 'demo-prod-vpc', cidr: '10.20.0.0/16', state: 'available', isDefault: 0, natGatewayCount: 2, securityGroupCount: 12, igw: 1,
    subnets: [
      { subnetId: 'subnet-0demo1111a', name: 'demo-prod-public-a', cidr: '10.20.1.0/24', az: 'us-east-2a', availableIps: 240, public: 1 },
      { subnetId: 'subnet-0demo1111b', name: 'demo-prod-public-b', cidr: '10.20.2.0/24', az: 'us-east-2b', availableIps: 238, public: 1 },
      { subnetId: 'subnet-0demo1111c', name: 'demo-prod-private-a', cidr: '10.20.11.0/24', az: 'us-east-2a', availableIps: 190, public: 0 },
      { subnetId: 'subnet-0demo1111d', name: 'demo-prod-private-b', cidr: '10.20.12.0/24', az: 'us-east-2b', availableIps: 205, public: 0 },
    ] },
  { vpcId: 'vpc-0demo2222default', name: 'default', cidr: '172.31.0.0/16', state: 'available', isDefault: 1, natGatewayCount: 0, securityGroupCount: 3, igw: 1,
    subnets: [
      { subnetId: 'subnet-0demo2222a', name: null, cidr: '172.31.0.0/20', az: 'us-east-2a', availableIps: 4090, public: 1 },
      { subnetId: 'subnet-0demo2222b', name: null, cidr: '172.31.16.0/20', az: 'us-east-2b', availableIps: 4088, public: 1 },
    ] },
];

function seedAws(db, { now, encrypt }) {
  void now;

  db.prepare(`
    INSERT INTO app_settings (key, value, updated_at) VALUES ('platform_aws_enabled', '1', datetime('now'))
    ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at
  `).run();

  const insertAccount = db.prepare(`
    INSERT INTO aws_accounts (name, access_key_id, encrypted_credentials, region, polling_interval_minutes,
      last_poll_status, last_poll_error, last_poll_at, last_cost_capture_at, last_s3_capture_at,
      last_optimizer_capture_at, co_enrollment, account_number, created_at, updated_at)
    VALUES (?, ?, ?, 'us-east-2', 10, 'success', NULL,
      datetime('now', ?), datetime('now', ?), datetime('now', ?), datetime('now', ?), ?, '893373391538',
      datetime('now', '-400 days'), datetime('now', '-4 minutes'))
  `);
  insertAccount.run(
    'Demo AWS', 'AKIADEMO0000000000EX', encrypt(JSON.stringify({ secretAccessKey: 'demo-not-real-secret' })),
    '-4 minutes', '-6 hours', '-6 hours', '-3 hours', 'Active'
  );
  const accountId = db.prepare("SELECT id FROM aws_accounts WHERE name = 'Demo AWS'").get().id;

  const insertEc2 = db.prepare(`
    INSERT INTO aws_ec2_instances (account_id, instance_id, name, state, instance_type, az,
      private_ip, public_ip, platform, launch_time, cpu_util, status_check)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now', ?), ?, ?)
  `);
  for (const i of EC2_INSTANCES) {
    insertEc2.run(accountId, i.instanceId, i.name, i.state, i.instanceType, i.az,
      i.privateIp, i.publicIp, i.platform, `-${i.launchDaysAgo} days`, i.cpuUtil, i.statusCheck);
  }

  const insertEbs = db.prepare(`
    INSERT INTO aws_ebs_volumes (account_id, volume_id, state, size_gb, volume_type, az, attached_instance_id)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `);
  for (const v of EBS_VOLUMES) {
    insertEbs.run(accountId, v.volumeId, v.state, v.sizeGb, v.volumeType, v.az, v.attachedInstanceId);
  }

  const insertLightsail = db.prepare(`
    INSERT INTO aws_lightsail_instances (account_id, name, state, blueprint, bundle, az, public_ip,
      cpu_util, snapshot_count, latest_snapshot_at, ram_gb, cpu_count, is_windows, arn, private_ip, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now', ?), ?, ?, 0, ?, ?, datetime('now', '-200 days'))
  `);
  for (const l of LIGHTSAIL_INSTANCES) {
    const small = l.bundle.startsWith('small');
    insertLightsail.run(accountId, l.name, l.state, l.blueprint, l.bundle, l.az, l.publicIp,
      l.cpuUtil, l.snapshotCount, `-${l.latestSnapshotDaysAgo} days`, small ? 2 : 1, small ? 1 : 2,
      `arn:aws:lightsail:us-east-2:893373391538:Instance/demo-${l.name}`, `172.26.0.${small ? 21 : 20}`);
  }

  // Lightsail inventory beyond instances: databases, disks, buckets, load balancer,
  // distribution, DNS zone and static IPs (one deliberately unhealthy of each kind).
  const insertLsDb = db.prepare(`
    INSERT INTO aws_lightsail_databases (account_id, name, arn, engine, engine_version, bundle, ram_gb, disk_gb,
      state, az, master_endpoint, port, backup_retention, publicly_accessible, latest_restorable_at, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now', '-5 minutes'), datetime('now', '-300 days'))
  `);
  insertLsDb.run(accountId, 'demo-ls-db-01', LIGHTSAIL_DB_ARN, 'mysql', '8.0.35', 'micro_2_0', 1, 40,
    'available', 'us-east-2a', 'ls-demo01.czzzdemo.us-east-2.rds.amazonaws.com', 3306, 1, 0);
  insertLsDb.run(accountId, 'demo-ls-pg-02', 'arn:aws:lightsail:us-east-2:893373391538:RelationalDatabase/demo-ls-pg-02',
    'postgres', '15.4', 'small_2_0', 2, 80, 'available', 'us-east-2b',
    'ls-demo02.czzzdemo.us-east-2.rds.amazonaws.com', 5432, 0, 0);

  const insertLsDisk = db.prepare(`
    INSERT INTO aws_lightsail_disks (account_id, name, arn, size_gb, state, attached_to, attachment_state,
      is_system_disk, iops, az, created_at)
    VALUES (?, ?, ?, ?, 'in-use', ?, ?, ?, ?, ?, datetime('now', '-200 days'))
  `);
  insertLsDisk.run(accountId, 'static-site-01-sys', 'arn:aws:lightsail:us-east-2:893373391538:Disk/demo-sys-01', 40,
    'static-site-01', 'attached', 1, 120, 'us-east-2a');
  insertLsDisk.run(accountId, 'wp-blog-01-sys', 'arn:aws:lightsail:us-east-2:893373391538:Disk/demo-sys-02', 60,
    'wp-blog-01', 'attached', 1, 180, 'us-east-2b');
  db.prepare(`
    INSERT INTO aws_lightsail_disks (account_id, name, arn, size_gb, state, attached_to, attachment_state,
      is_system_disk, iops, az, created_at)
    VALUES (?, 'scratch-disk-old', 'arn:aws:lightsail:us-east-2:893373391538:Disk/demo-scratch', 32, 'available',
      NULL, 'detached', 0, 100, 'us-east-2a', datetime('now', '-90 days'))
  `).run(accountId);

  const insertLsBucket = db.prepare(`
    INSERT INTO aws_lightsail_buckets (account_id, name, arn, bundle, state, object_versioning,
      read_only_access, able_to_update_bundle, url, created_at)
    VALUES (?, ?, ?, 'small_1_0', 'OK', ?, ?, 1, ?, datetime('now', '-150 days'))
  `);
  insertLsBucket.run(accountId, 'demo-assets-bucket', 'arn:aws:lightsail:us-east-2:893373391538:Bucket/demo-assets',
    'Enabled', 1, 'https://demo-assets-bucket.s3.us-east-2.amazonaws.com');
  insertLsBucket.run(accountId, 'demo-backups-bucket', 'arn:aws:lightsail:us-east-2:893373391538:Bucket/demo-backups',
    'Suspended', 0, 'https://demo-backups-bucket.s3.us-east-2.amazonaws.com');

  db.prepare(`
    INSERT INTO aws_lightsail_load_balancers (account_id, name, arn, dns_name, state, protocol, instance_port,
      health_check_path, attached_instances, healthy_count, unhealthy_count, tls_cert_name, tls_cert_attached,
      az, created_at)
    VALUES (?, 'demo-lb-01', 'arn:aws:lightsail:us-east-2:893373391538:LoadBalancer/demo-lb-01',
      'demo-lb-01-1234567890.us-east-2.elb.amazonaws.com', 'active', 'HTTPS', 443, '/healthz',
      ?, 1, 1, 'demo-lb-cert', 1, 'us-east-2', datetime('now', '-120 days'))
  `).run(accountId, JSON.stringify(['wp-blog-01', 'static-site-01']));

  db.prepare(`
    INSERT INTO aws_lightsail_distributions (account_id, name, arn, status, is_enabled, domain_name, origin_name,
      origin_region, bundle, cert_name, alternative_domains, created_at)
    VALUES (?, 'demo-cdn-01', 'arn:aws:lightsail:us-east-1:893373391538:Distribution/demo-cdn-01', 'Deployed', 1,
      'd1demo0000.cloudfront.net', 'demo-assets-bucket', 'us-east-2', 'small_1_0', 'demo-cdn-cert',
      ?, datetime('now', '-100 days'))
  `).run(accountId, JSON.stringify(['cdn.demo-example.com']));

  db.prepare(`
    INSERT INTO aws_lightsail_domains (account_id, name, arn, entry_count, created_at)
    VALUES (?, 'demo-example.com', 'arn:aws:lightsail:us-east-1:893373391538:Domain/demo-example.com', 6,
      datetime('now', '-250 days'))
  `).run(accountId);

  const insertLsIp = db.prepare(`
    INSERT INTO aws_lightsail_static_ips (account_id, name, arn, ip_address, is_attached, attached_to, az, created_at)
    VALUES (?, ?, ?, ?, ?, ?, 'us-east-2a', datetime('now', '-180 days'))
  `);
  insertLsIp.run(accountId, 'wp-blog-ip', 'arn:aws:lightsail:us-east-2:893373391538:StaticIp/demo-wp-ip',
    '18.220.10.21', 1, 'wp-blog-01');
  insertLsIp.run(accountId, 'spare-ip', 'arn:aws:lightsail:us-east-2:893373391538:StaticIp/demo-spare-ip',
    '18.220.10.99', 0, null);

  const insertEcsCluster = db.prepare(`
    INSERT INTO aws_ecs_clusters (account_id, cluster_arn, cluster_name, status, running_tasks,
      pending_tasks, service_count, container_instances)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `);
  for (const c of ECS_CLUSTERS) {
    insertEcsCluster.run(accountId, c.clusterArn, c.clusterName, c.status, c.runningTasks,
      c.pendingTasks, c.serviceCount, c.containerInstances);
  }

  const insertEcsService = db.prepare(`
    INSERT INTO aws_ecs_services (account_id, cluster_name, service_name, status, desired_count,
      running_count, pending_count, launch_type, cpu_util, memory_util)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  for (const s of ECS_SERVICES) {
    insertEcsService.run(accountId, s.clusterName, s.serviceName, s.status, s.desiredCount,
      s.runningCount, s.pendingCount, s.launchType, s.cpuUtil, s.memoryUtil);
  }

  const insertS3 = db.prepare(`
    INSERT INTO aws_s3_buckets (account_id, name, region, size_bytes, object_count,
      public_access_blocked, versioning, lifecycle_rules, created_at_aws)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, datetime('now', ?))
  `);
  for (const b of S3_BUCKETS) {
    insertS3.run(accountId, b.name, b.region, b.sizeBytes, b.objectCount,
      b.publicAccessBlocked, b.versioning, b.lifecycleRules, `-${b.createdDaysAgo} days`);
  }

  const insertRds = db.prepare(`
    INSERT INTO aws_rds_instances (account_id, db_id, engine, engine_version, instance_class, status,
      multi_az, allocated_gb, free_storage_bytes, cpu_util, connections, backup_retention_days,
      latest_backup_at, endpoint)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now', ?), ?)
  `);
  for (const r of RDS_INSTANCES) {
    insertRds.run(accountId, r.dbId, r.engine, r.engineVersion, r.instanceClass, r.status,
      r.multiAz, r.allocatedGb, r.freeStorageBytes, r.cpuUtil, r.connections, r.backupRetentionDays,
      `-${r.latestBackupDaysAgo} days`, r.endpoint);
  }

  const insertLambda = db.prepare(`
    INSERT INTO aws_lambda_functions (account_id, name, runtime, memory_mb, timeout_s, code_size_bytes,
      last_modified, invocations_24h, errors_24h, avg_duration_ms)
    VALUES (?, ?, ?, ?, ?, ?, datetime('now', ?), ?, ?, ?)
  `);
  for (const l of LAMBDA_FUNCTIONS) {
    insertLambda.run(accountId, l.name, l.runtime, l.memoryMb, l.timeoutS, l.codeSizeBytes,
      `-${l.lastModifiedDaysAgo} days`, l.invocations24h, l.errors24h, l.avgDurationMs);
  }

  const insertDynamo = db.prepare(`
    INSERT INTO aws_dynamo_tables (account_id, name, status, billing_mode, item_count, size_bytes,
      read_capacity, write_capacity)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `);
  for (const t of DYNAMO_TABLES) {
    insertDynamo.run(accountId, t.name, t.status, t.billingMode, t.itemCount, t.sizeBytes,
      t.readCapacity, t.writeCapacity);
  }

  const insertEcr = db.prepare(`
    INSERT INTO aws_ecr_repos (account_id, name, image_count, size_bytes, scan_on_push, latest_push_at)
    VALUES (?, ?, ?, ?, ?, datetime('now', ?))
  `);
  for (const e of ECR_REPOS) {
    insertEcr.run(accountId, e.name, e.imageCount, e.sizeBytes, e.scanOnPush, `-${e.latestPushDaysAgo} days`);
  }

  const insertVpc = db.prepare(`
    INSERT INTO aws_vpcs (account_id, vpc_id, name, cidr, state, is_default, subnet_count,
      nat_gateway_count, security_group_count, igw)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const insertSubnet = db.prepare(`
    INSERT INTO aws_subnets (account_id, subnet_id, vpc_id, name, cidr, az, available_ips, public)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `);
  let subnetRows = 0;
  for (const v of VPCS) {
    insertVpc.run(accountId, v.vpcId, v.name, v.cidr, v.state, v.isDefault, v.subnets.length,
      v.natGatewayCount, v.securityGroupCount, v.igw);
    for (const s of v.subnets) {
      insertSubnet.run(accountId, s.subnetId, v.vpcId, s.name, s.cidr, s.az, s.availableIps, s.public);
      subnetRows++;
    }
  }

  const insertOptimizer = db.prepare(`
    INSERT INTO aws_optimizer_recommendations (account_id, source, resource_type, resource_id, resource_name,
      region, finding, current_config, recommended_config, reason, est_monthly_savings_usd, captured_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now', '-3 hours'))
  `);
  for (const r of OPTIMIZER_RECOMMENDATIONS) {
    insertOptimizer.run(accountId, r.source, r.resourceType, r.resourceId, r.resourceName,
      r.region, r.finding, r.currentConfig, r.recommendedConfig, r.reason, r.savingsUsd);
  }
  const optimizerRows = OPTIMIZER_RECOMMENDATIONS.length;

  // -- Cost Explorer: 45 days x services, yesterday ~40% above day-before --
  const insertCost = db.prepare(`
    INSERT INTO aws_cost_daily (account_id, day, service, amount_usd, amortized_usd, currency)
    VALUES (?, date('now', ?), ?, ?, ?, 'USD')
  `);
  const costRng = rngFor('aws-cost-daily');
  let costRows = 0;
  let dayBeforeTotal = 0;
  let yesterdayTotal = 0;
  // Per service and day offset: { unblended, amortized }. Later blocks (usage rows, allocation,
  // budgets, forecast) read these so every table agrees.
  const svcDaily = new Map(COST_SERVICES.map((c) => [c.service, new Map()]));
  const utcDay = (i) => new Date(Date.now() - i * 86400000).toISOString().slice(0, 10);
  // Yesterday is the day-before amount times the multiplier, service by service, so the
  // spike survives any random draw (a 0.85 yesterday over a 1.15 day-before once lost it).
  const dayBeforeByService = new Map();
  for (let i = COST_DAYS - 1; i >= 0; i--) {
    const offset = `-${i} days`;
    const dayAmounts = [];
    for (const svc of COST_SERVICES) {
      const drift = 1 + (COST_DAYS - i) / COST_DAYS * randFloat(costRng, -0.05, 0.2, 3);
      let amount = Math.max(0.05, svc.base * drift * randFloat(costRng, 0.85, 1.15, 3));
      if (i === 2) dayBeforeByService.set(svc.service, amount);
      if (i === 1) amount = (dayBeforeByService.get(svc.service) || amount) * SPIKE_MULTIPLIER;
      amount = Math.round(amount * 100) / 100;
      dayAmounts.push({ service: svc.service, amount });
      if (i === 1) yesterdayTotal += amount;
      if (i === 2) dayBeforeTotal += amount;
    }
    // Amortized spreads the Savings Plan fee over compute: the plan line keeps 5% of its unblended
    // amount and the difference lands on EC2 compute, so the day total is the same in both metrics.
    const spAmount = dayAmounts.find((d) => d.service === SP_SERVICE).amount;
    const spAmortized = Math.round(spAmount * 0.05 * 100) / 100;
    const spShift = Math.round((spAmount - spAmortized) * 100) / 100;
    for (const d of dayAmounts) {
      let amortized = d.amount;
      if (d.service === SP_SERVICE) amortized = spAmortized;
      if (d.service === COMPUTE_SERVICE) amortized = Math.round((d.amount + spShift) * 100) / 100;
      insertCost.run(accountId, offset, d.service, d.amount, amortized);
      svcDaily.get(d.service).set(i, { unblended: d.amount, amortized });
      costRows++;
    }
  }

  // ── Bedrock usage: 30 days x 3 model_ids ────────────────────────────────
  const insertBedrock = db.prepare(`
    INSERT INTO aws_bedrock_usage (account_id, model_id, day, invocations, input_tokens, output_tokens, avg_latency_ms)
    VALUES (?, ?, date('now', ?), ?, ?, ?, ?)
  `);
  const bedrockRng = rngFor('aws-bedrock-usage');
  let bedrockRows = 0;
  for (let i = BEDROCK_DAYS - 1; i >= 0; i--) {
    const offset = `-${i} days`;
    for (const modelId of BEDROCK_MODELS) {
      const invocations = randInt(bedrockRng, 20, 400);
      const inputTokens = invocations * randInt(bedrockRng, 200, 1500);
      const outputTokens = invocations * randInt(bedrockRng, 100, 900);
      const avgLatencyMs = randFloat(bedrockRng, 300, 2200, 1);
      insertBedrock.run(accountId, modelId, offset, invocations, inputTokens, outputTokens, avgLatencyMs);
      bedrockRows++;
    }
  }

  // ── Metrics history: last 7 days ────────────────────────────────────────
  const insertMetrics = db.prepare(`
    INSERT INTO aws_metrics_history (account_id, captured_at, ec2_running, ec2_stopped, ec2_alarmed,
      lightsail_running, ecs_services, ecs_degraded, s3_total_bytes, s3_buckets, mtd_spend_usd)
    VALUES (?, datetime('now', ?), ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const metricsRng = rngFor('aws-metrics-history');
  const ec2Running = EC2_INSTANCES.filter((i) => i.state === 'running').length;
  const ec2Stopped = EC2_INSTANCES.filter((i) => i.state === 'stopped').length;
  const ec2Alarmed = EC2_INSTANCES.filter((i) => i.statusCheck && i.statusCheck.includes('failed')).length;
  const lightsailRunning = LIGHTSAIL_INSTANCES.filter((l) => l.state === 'running').length;
  const ecsDegraded = ECS_SERVICES.filter((s) => s.status === 'ACTIVE' && s.runningCount < s.desiredCount).length;
  const s3TotalBytes = S3_BUCKETS.reduce((acc, b) => acc + b.sizeBytes, 0);
  let metricsRows = 0;
  for (let i = METRICS_HISTORY_DAYS - 1; i >= 0; i--) {
    const mtdSpend = randFloat(metricsRng, 1200, 1800, 2);
    insertMetrics.run(accountId, `-${i} days`, ec2Running, ec2Stopped, ec2Alarmed,
      lightsailRunning, ECS_SERVICES.length, ecsDegraded, s3TotalBytes, S3_BUCKETS.length, mtdSpend);
    metricsRows++;
  }

  // ── S3 size history: 90 days x 3 buckets (steady growth; one with a jump) ─
  const insertS3History = db.prepare(`
    INSERT INTO aws_s3_size_history (account_id, bucket_name, day, size_bytes, object_count)
    VALUES (?, ?, date('now', ?), ?, ?)
  `);
  const s3HistRng = rngFor('aws-s3-size-history');
  let s3HistoryRows = 0;
  for (const bucketName of S3_HISTORY_BUCKETS) {
    const bucket = S3_BUCKETS.find((b) => b.name === bucketName);
    const dailyRate = randFloat(s3HistRng, 0.003, 0.007, 4);
    for (let i = S3_HISTORY_DAYS - 1; i >= 0; i--) {
      let size = bucket.sizeBytes / (1 + dailyRate) ** i;
      if (bucketName === S3_JUMP_BUCKET && i > S3_JUMP_AT_DAY) {
        size /= S3_JUMP_FACTOR;
      }
      size *= randFloat(s3HistRng, 0.98, 1.02, 4);
      const objectCount = Math.max(1, Math.round(bucket.objectCount * (size / bucket.sizeBytes)));
      insertS3History.run(accountId, bucketName, `-${i} days`, Math.round(size), objectCount);
      s3HistoryRows++;
    }
  }

  // ── RDS storage history: 30 days for the low-storage RDS (declining trend) ─
  const insertRdsHistory = db.prepare(`
    INSERT INTO aws_rds_storage_history (account_id, db_id, day, free_storage_bytes, allocated_gb)
    VALUES (?, ?, date('now', ?), ?, ?)
  `);
  const rdsHistRng = rngFor('aws-rds-storage-history');
  let rdsHistoryRows = 0;
  const rdsHistTarget = RDS_INSTANCES.find((r) => r.dbId === RDS_HISTORY_DB);
  for (let i = RDS_HISTORY_DAYS - 1; i >= 0; i--) {
    const declineFactor = 1 + (i / RDS_HISTORY_DAYS) * 0.6;
    const free = Math.round(rdsHistTarget.freeStorageBytes * declineFactor * randFloat(rdsHistRng, 0.97, 1.03, 4));
    insertRdsHistory.run(accountId, RDS_HISTORY_DB, `-${i} days`, free, rdsHistTarget.allocatedGb);
    rdsHistoryRows++;
  }

  // ── Cost usage-type breakdown: 45 days x 8 usage types ──────────────────
  const insertCostUsage = db.prepare(`
    INSERT INTO aws_cost_usage_daily (account_id, day, service, usage_type, amount_usd, amortized_usd, usage_qty, usage_unit)
    VALUES (?, date('now', ?), ?, ?, ?, ?, ?, ?)
  `);
  const usageRng = rngFor('aws-cost-usage-daily');
  let costUsageRows = 0;
  // Usage quantities: BoxUsage in hours (24 x running instances of the type), storage in GB-Mo, Lambda in GB-seconds.
  const runningOf = (type) => EC2_INSTANCES.filter((e) => e.state === 'running' && e.instanceType === type).length;
  const s3Gb = S3_BUCKETS.reduce((a, b) => a + b.sizeBytes, 0) / 1024 ** 3;
  const ebsGb = EBS_VOLUMES.reduce((a, v) => a + v.sizeGb, 0);
  const lambdaGbSec = LAMBDA_FUNCTIONS.reduce((a, f) => a + f.invocations24h * (f.avgDurationMs / 1000) * (f.memoryMb / 1024), 0);
  const usageQty = (u) => {
    if (u.usageType.startsWith('USE2-BoxUsage:')) return { qty: 24 * runningOf(u.usageType.split(':')[1]), unit: 'Hrs' };
    if (u.usageType === 'USE2-TimedStorage-ByteHrs') return { qty: Math.round(s3Gb / 30 * 100) / 100, unit: 'GB-Mo' };
    if (u.usageType === 'USE2-EBS:VolumeUsage.gp3') return { qty: Math.round(ebsGb / 30 * 100) / 100, unit: 'GB-Mo' };
    if (u.usageType === 'USE2-NatGateway-Hours') return { qty: 48, unit: 'Hrs' };
    if (u.usageType === 'USE2-Lambda-GB-Second') return { qty: Math.round(lambdaGbSec), unit: 'GB-Second' };
    return { qty: null, unit: null };
  };
  for (let i = COST_USAGE_DAYS - 1; i >= 0; i--) {
    for (const u of USAGE_TYPES) {
      const amount = Math.round(u.base * randFloat(usageRng, 0.85, 1.15, 3) * 100) / 100;
      const q = usageQty(u);
      insertCostUsage.run(accountId, `-${i} days`, u.service, u.usageType, amount, amount, q.qty, q.unit);
      costUsageRows++;
    }
    // Bedrock bills one service per model with token counts in millions. The four token kinds split the
    // service's own daily cost (cache reads dominate, as they do on a real bill), so cost and quantity agree.
    for (const model of BEDROCK_BILLING) {
      const day = svcDaily.get(model.service).get(i);
      for (const kind of BEDROCK_TOKEN_KINDS) {
        const amount = Math.round(day.unblended * kind.share * 100) / 100;
        const mTokens = Math.round((day.unblended * kind.share / model.price[kind.id]) * 1000) / 1000;
        insertCostUsage.run(accountId, `-${i} days`, model.service, `USE2-MP:USE2_${kind.usage}TokenCount-Units`, amount, amount, mTokens, '1M tokens');
        costUsageRows++;
      }
    }
  }

  // ── Resource-level cost: 14 days across the demo's own inventory ───────
  const insertCostResource = db.prepare(`
    INSERT INTO aws_cost_resource_daily (account_id, day, service, resource_id, amount_usd)
    VALUES (?, date('now', ?), ?, ?, ?)
  `);
  const resourceRng = rngFor('aws-cost-resource-daily');
  const LS_RAM_GB = { nano: 0.5, micro: 1, small: 2, medium: 4, large: 8, xlarge: 16 };
  const costResources = [
    ...EC2_INSTANCES.filter((e) => e.state === 'running').map((e) => ({ service: COMPUTE_SERVICE, id: e.instanceId, ut: `USE2-BoxUsage:${e.instanceType}`, base: e.instanceType === 'm5.xlarge' ? 4.6 : e.instanceType === 'r5.large' ? 3.0 : 2.1 })),
    ...S3_BUCKETS.map((b) => ({ service: S3_SERVICE, id: b.name, ut: 'USE2-TimedStorage-ByteHrs', base: Math.max(0.02, Math.min(3, b.sizeBytes / 1024 ** 4 * 0.7)) })),
    ...LIGHTSAIL_INSTANCES.map((l) => ({ service: LIGHTSAIL_SERVICE, id: l.name, ut: `USE2-BundleUsage:${LS_RAM_GB[l.bundle.split('_')[0]] || 1}GB`, base: l.bundle.startsWith('small') ? 0.8 : 0.4 })),
    { service: LIGHTSAIL_SERVICE, id: LIGHTSAIL_DB_ARN, ut: 'USE2-DatabaseUsage:1GB', base: 1 },
    ...RDS_INSTANCES.map((r) => ({ service: RDS_SERVICE, id: r.dbId, ut: `USE2-InstanceUsage:${r.instanceClass}`, base: r.instanceClass.includes('r5') ? 5.5 : r.instanceClass.includes('m5') ? 3.4 : 1.1 })),
    ...LAMBDA_FUNCTIONS.map((f) => ({ service: LAMBDA_SERVICE, id: `arn:aws:lambda:us-east-2:893373391538:function:${f.name}`, ut: 'USE2-Lambda-GB-Second', base: Math.max(0.02, f.invocations24h * f.avgDurationMs / 1e8) })),
  ];
  // Exact mapping: the same resources, per usage type (what resource-level billing returns).
  const insertCostResourceUsage = db.prepare(`
    INSERT INTO aws_cost_resource_usage_daily (account_id, day, usage_type, resource_id, amount_usd)
    VALUES (?, date('now', ?), ?, ?, ?)
  `);
  let costResourceRows = 0;
  for (let i = COST_RESOURCE_DAYS - 1; i >= 0; i--) {
    for (const r of costResources) {
      const amount = Math.round(r.base * randFloat(resourceRng, 0.85, 1.15, 3) * 100) / 100;
      insertCostResource.run(accountId, `-${i} days`, r.service, r.id, amount);
      insertCostResourceUsage.run(accountId, `-${i} days`, r.ut, r.id, amount);
      costResourceRows++;
    }
  }
  db.prepare("UPDATE aws_accounts SET cost_resources_status = 'ok', cost_resources_error = NULL WHERE id = ?").run(accountId);

  // ── Cost instance-type breakdown: 45 days x 3 instance types ────────────
  const insertCostInstanceType = db.prepare(`
    INSERT INTO aws_cost_instance_type_daily (account_id, day, instance_type, amount_usd, amortized_usd)
    VALUES (?, date('now', ?), ?, ?, ?)
  `);
  const instTypeRng = rngFor('aws-cost-instance-type-daily');
  let costInstanceTypeRows = 0;
  for (let i = COST_INSTANCE_TYPE_DAYS - 1; i >= 0; i--) {
    for (const t of INSTANCE_TYPE_COSTS) {
      const amount = Math.round(t.base * randFloat(instTypeRng, 0.85, 1.15, 3) * 100) / 100;
      insertCostInstanceType.run(accountId, `-${i} days`, t.instanceType, amount, amount);
      costInstanceTypeRows++;
    }
  }

  // ── AWS health events: one <24h old, one 3 days old ─────────────────────
  const insertHealth = db.prepare(`
    INSERT INTO aws_health_events (feed, service, region, title, summary, published_at, fetched_at)
    VALUES (?, ?, ?, ?, ?, datetime('now', ?), datetime('now'))
  `);
  let healthRows = 0;
  for (const h of HEALTH_EVENTS) {
    insertHealth.run(h.feed, h.service, h.region, h.title, h.summary, `-${h.hoursAgo} hours`);
    healthRows++;
  }

  // -- FinOps: allocation, commitments, anomalies, forecast, budgets, lifecycle, capabilities --
  // Reseed safety: every table is cleared for this account (budgets are not account scoped, so they are
  // cleared by the names this seed owns) before it is filled.
  const FINOPS_TABLES = [
    'aws_cost_alloc_daily', 'aws_sp_utilization_daily', 'aws_sp_coverage_daily', 'aws_ri_utilization_daily',
    'aws_ri_coverage_daily', 'aws_savings_plans', 'aws_cost_anomalies', 'aws_cost_forecast',
    'aws_recommendation_state', 'aws_capability_status',
  ];
  for (const t of FINOPS_TABLES) db.prepare(`DELETE FROM ${t} WHERE account_id = ?`).run(accountId);
  const DEMO_BUDGETS = ['Total AWS spend', 'Bedrock models', 'Environment dev'];
  db.prepare(`DELETE FROM aws_budgets WHERE name IN (${DEMO_BUDGETS.map(() => '?').join(',')})`).run(...DEMO_BUDGETS);
  db.prepare("DELETE FROM aws_optimizer_recommendations WHERE account_id = ? AND source = 'ce-savings-plan'").run(accountId);

  const finopsRng = rngFor('aws-finops');
  const r2 = (v) => Math.round(v * 100) / 100;
  const isoAgo = (days) => new Date(Date.now() - days * 86400000).toISOString();
  const nowIso = new Date().toISOString();

  // Tag allocation: Environment and Team split each service's daily cost, 10% left untagged.
  const ALLOC_KEYS = [
    { key: 'Environment', split: [['prod', 0.55], ['staging', 0.2], ['dev', 0.15], ['', 0.1]] },
    { key: 'Team', split: [['platform', 0.4], ['data', 0.3], ['apps', 0.2], ['', 0.1]] },
  ];
  const insertAlloc = db.prepare(`
    INSERT INTO aws_cost_alloc_daily (account_id, day, dimension, key, value, service, amount_usd, amortized_usd)
    VALUES (?, ?, 'tag', ?, ?, ?, ?, ?)
  `);
  const ALLOC_DAYS = 35;
  const monthPrefix = utcDay(0).slice(0, 7);
  let allocRows = 0;
  let devMtd = 0;
  let totalMtd = 0;
  let opusMtd = 0;
  for (let i = ALLOC_DAYS - 1; i >= 0; i--) {
    const day = utcDay(i);
    for (const [service, byDay] of svcDaily) {
      const d = byDay.get(i);
      if (!d) continue;
      for (const k of ALLOC_KEYS) {
        for (const [value, share] of k.split) {
          const unblended = r2(d.unblended * share);
          const amortized = r2(d.amortized * share);
          if (unblended === 0 && amortized === 0) continue;
          insertAlloc.run(accountId, day, k.key, value, service, unblended, amortized);
          allocRows++;
          if (k.key === 'Environment' && value === 'dev' && day.startsWith(monthPrefix)) devMtd += amortized;
        }
      }
    }
  }
  const dayTotals = [];
  for (let i = COST_DAYS - 1; i >= 0; i--) {
    let amortizedTotal = 0;
    for (const [service, byDay] of svcDaily) {
      const d = byDay.get(i);
      if (!d) continue;
      amortizedTotal += d.amortized;
      if (utcDay(i).startsWith(monthPrefix)) {
        totalMtd += d.amortized;
        if (service === BEDROCK_OPUS_SERVICE) opusMtd += d.amortized;
      }
    }
    dayTotals.push(amortizedTotal);
  }

  // Savings Plan utilization (88..97) and coverage (58..70), 35 days, commitment 72 a day.
  const insertSpUtil = db.prepare(`
    INSERT INTO aws_sp_utilization_daily (account_id, day, utilization_pct, commitment_usd, used_usd, unused_usd, net_savings_usd, on_demand_equivalent_usd)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const insertSpCov = db.prepare(`
    INSERT INTO aws_sp_coverage_daily (account_id, day, coverage_pct, covered_usd, on_demand_usd, total_usd)
    VALUES (?, ?, ?, ?, ?, ?)
  `);
  let spRows = 0;
  for (let i = ALLOC_DAYS; i >= 1; i--) {
    const day = utcDay(i);
    const util = randFloat(finopsRng, 88, 97, 2);
    const commitment = 72;
    const used = r2(commitment * util / 100);
    insertSpUtil.run(accountId, day, util, commitment, used, r2(commitment - used), r2(used * 0.28), r2(used * 1.28));
    const cov = randFloat(finopsRng, 58, 70, 2);
    const total = r2(randFloat(finopsRng, 150, 190, 2));
    const covered = r2(total * cov / 100);
    insertSpCov.run(accountId, day, cov, covered, r2(total - covered), total);
    spRows += 2;
  }
  // Reserved Instance tables stay empty: the demo account holds none.

  // Two plans, one ending in 21 days.
  const insertPlan = db.prepare(`
    INSERT INTO aws_savings_plans (account_id, sp_arn, sp_type, payment_option, term, hourly_commitment_usd, region,
      instance_family, start_at, end_at, utilization_pct, net_savings_usd, captured_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  insertPlan.run(accountId, 'arn:aws:savingsplans::893373391538:savingsplan/sp-0demo1111compute', 'ComputeSavingsPlans',
    'No Upfront', '1yr', 3.0, null, null, isoAgo(365 - 21), isoAgo(-21), 93.4, 4120.5, nowIso);
  insertPlan.run(accountId, 'arn:aws:savingsplans::893373391538:savingsplan/sp-0demo2222ec2', 'EC2InstanceSavingsPlans',
    'Partial Upfront', '3yr', 1.25, 'us-east-2', 'm5', isoAgo(300), isoAgo(-(3 * 365 - 300)), 96.1, 2210.75, nowIso);

  // Savings Plan purchase recommendation from Cost Explorer (listed on Optimizer and Commitments).
  db.prepare(`
    INSERT INTO aws_optimizer_recommendations (account_id, source, resource_type, resource_id, resource_name,
      region, finding, current_config, recommended_config, reason, est_monthly_savings_usd, captured_at)
    VALUES (?, 'ce-savings-plan', 'savings-plan', 'COMPUTE_SP|ONE_YEAR|NO_UPFRONT', 'Compute Savings Plan', NULL,
      'purchase-savings-plan', 'on-demand $2410/mo', '$1.85/h commitment',
      'Cost Explorer: 30 days of eligible on-demand compute spend', 310, datetime('now', '-6 hours'))
  `).run(accountId);

  // Anomalies: two from Cost Anomaly Detection (one open three days), one open from ICC's per-service
  // rule plus three closed ones.
  const insertAnomaly = db.prepare(`
    INSERT INTO aws_cost_anomalies (account_id, anomaly_id, source, monitor_arn, monitor_name, scope, scope_key, start_day, end_day,
      actual_usd, expected_usd, impact_usd, impact_pct, root_causes_json, status, normal_days, superseded_by, first_seen_at, last_seen_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, ?)
  `);
  const MONITOR_ARN = 'arn:aws:ce::893373391538:anomalymonitor/demo-services-monitor';
  const cause = (service, usageType, linked) => JSON.stringify([{ service, region: 'us-east-2', usageType, linkedAccount: '893373391538', linkedAccountName: linked }]);
  insertAnomaly.run(accountId, 'demo-aws-anom-opensearch', 'aws', MONITOR_ARN, 'Services monitor', 'service', 'Amazon OpenSearch Service',
    utcDay(3), null, 96.4, 41.2, 55.2, 134, cause('Amazon OpenSearch Service', 'USE2-ESInstance:r6g.large.search', 'Demo AWS'), 'open', 0, isoAgo(3), nowIso);
  insertAnomaly.run(accountId, 'demo-aws-anom-rds', 'aws', MONITOR_ARN, 'Services monitor', 'service', 'Amazon Relational Database Service',
    utcDay(18), utcDay(15), 61.0, 38.5, 22.5, 58, cause('Amazon Relational Database Service', 'USE2-RDS:StorageIOUsage', 'Demo AWS'), 'closed', 0, isoAgo(18), isoAgo(15));
  const opusDay = utcDay(1);
  const opusActual = svcDaily.get(BEDROCK_OPUS_SERVICE).get(1).amortized;
  const opusBase = svcDaily.get(BEDROCK_OPUS_SERVICE).get(2).amortized;
  insertAnomaly.run(accountId, `icc:service:${BEDROCK_OPUS_SERVICE}:${opusDay}`, 'icc', null, null, 'service', BEDROCK_OPUS_SERVICE,
    opusDay, null, r2(opusActual), r2(opusBase), r2(opusActual - opusBase), r2((opusActual - opusBase) / opusBase * 100),
    JSON.stringify([{ usageType: 'USE2-MP:USE2_CacheReadInputTokenCount-Units', usd: r2(opusActual * 0.45), baselineUsd: r2(opusBase * 0.45 * 0.8) }]),
    'open', 0, isoAgo(1), nowIso);
  const closedIcc = [
    { service: 'EC2 - Other', start: 24, end: 22, actual: 19.8, expected: 9.4 },
    { service: S3_SERVICE, start: 16, end: 14, actual: 17.2, expected: 9.1 },
    { service: 'AmazonCloudWatch', start: 9, end: 7, actual: 6.3, expected: 2.3 },
  ];
  for (const c of closedIcc) {
    insertAnomaly.run(accountId, `icc:service:${c.service}:${utcDay(c.start)}`, 'icc', null, null, 'service', c.service,
      utcDay(c.start), utcDay(c.end), c.actual, c.expected, r2(c.actual - c.expected), r2((c.actual - c.expected) / c.expected * 100),
      JSON.stringify([]), 'closed', 2, isoAgo(c.start), isoAgo(c.end));
  }

  // Forecast: 10 days of generated_on rows, Cost Explorer source, around the 14-day run rate.
  const insertForecast = db.prepare(`
    INSERT INTO aws_cost_forecast (account_id, scope, metric, period_start, period_end, generated_on, mean_usd, lower_usd, upper_usd, source)
    VALUES (?, 'total', 'amortized', ?, ?, ?, ?, ?, ?, 'ce')
  `);
  const runRate = dayTotals.slice(-14).reduce((a, b) => a + b, 0) / 14;
  for (let k = 9; k >= 0; k--) {
    const gen = utcDay(k);
    const y = Number(gen.slice(0, 4));
    const m = Number(gen.slice(5, 7));
    const start = `${gen.slice(0, 7)}-01`;
    const end = new Date(Date.UTC(y, m, 1)).toISOString().slice(0, 10);
    const daysInMonth = new Date(Date.UTC(y, m, 0)).getUTCDate();
    const mean = r2(runRate * daysInMonth * (1 + ((k % 3) - 1) * 0.01));
    insertForecast.run(accountId, start, end, gen, mean, r2(mean * 0.9), r2(mean * 1.1));
  }

  // Budgets: Total (ok), Bedrock models (crit), Environment dev (warn). Amounts follow the live month
  // to date so the states hold on any day of the month; status rows are stored as the nightly pass would.
  const insertBudget = db.prepare(`
    INSERT INTO aws_budgets (name, scope_type, scope_key, scope_value, amount_usd, warn_pct, crit_pct, forecast_alert, enabled, notes, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, 80, 100, 1, 1, ?, ?, ?)
  `);
  const insertBudgetStatus = db.prepare(`
    INSERT INTO aws_budget_status (budget_id, month, actual_usd, forecast_usd, forecast_source, pct_actual, pct_forecast, state, evaluated_at)
    VALUES (?, ?, ?, ?, 'linear', ?, ?, ?, ?)
  `);
  const dom = Number(utcDay(0).slice(8, 10));
  const dim = new Date(Date.UTC(Number(utcDay(0).slice(0, 4)), Number(utcDay(0).slice(5, 7)), 0)).getUTCDate();
  const budgetDefs = [
    { name: 'Total AWS spend', type: 'total', key: null, value: null, actual: totalMtd, amount: Math.max(5000, Math.ceil(totalMtd / 0.7 / 100) * 100), notes: 'Monthly ceiling for the whole account.' },
    { name: 'Bedrock models', type: 'service', key: null, value: BEDROCK_OPUS_SERVICE, actual: opusMtd, amount: Math.max(50, Math.round(opusMtd / 1.25)), notes: 'Opus spend against the model budget.' },
    { name: 'Environment dev', type: 'tag', key: 'Environment', value: 'dev', actual: devMtd, amount: Math.max(50, Math.round(devMtd / 0.85)), notes: 'Development spend by Environment tag.' },
  ];
  for (const b of budgetDefs) {
    const id = insertBudget.run(b.name, b.type, b.key, b.value, b.amount, b.notes, isoAgo(60), isoAgo(60)).lastInsertRowid;
    const actual = r2(b.actual);
    const forecast = r2(b.actual / Math.max(1, dom) * dim);
    const pct = r2(actual / b.amount * 100);
    const state = pct >= 100 ? 'crit' : (pct >= 80 ? 'warn' : (forecast >= b.amount ? 'forecast_warn' : 'ok'));
    insertBudgetStatus.run(id, monthPrefix, actual, forecast, pct, r2(forecast / b.amount * 100), state, nowIso);
  }

  // Recommendation lifecycle: two accepted, one dismissed, two done (one booked by hand, one by the next poll).
  const insertRecState = db.prepare(`
    INSERT INTO aws_recommendation_state (account_id, rec_key, status, note, updated_by, resolved_by, est_monthly_savings_usd,
      realized_usd, realized_at, first_seen_at, last_seen_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  insertRecState.run(accountId, 'compute-optimizer|Overprovisioned|i-0aaa4444demo04', 'accepted', 'Resize in the next change window.', 'demo', null, 45, null, null, isoAgo(12), nowIso, isoAgo(4));
  insertRecState.run(accountId, 'heuristic|nat-gateway-consolidation|vpc-0demo1111prod', 'accepted', 'Approved by platform team.', 'demo', null, 32.85, null, null, isoAgo(20), nowIso, isoAgo(6));
  insertRecState.run(accountId, 'compute-optimizer|NotOptimized|vol-0bbb5555demo05', 'dismissed', 'Database needs the provisioned IOPS.', 'demo', null, 62, null, null, isoAgo(30), nowIso, isoAgo(10));
  insertRecState.run(accountId, 'heuristic|ebs-unattached|vol-0bbbdemoold01', 'done', null, null, 'auto', 40, 40, isoAgo(21), isoAgo(45), isoAgo(22), isoAgo(21));
  insertRecState.run(accountId, 'heuristic|stopped-ec2-ebs|i-0demo-retired-01', 'done', 'Terminated and volumes deleted.', 'demo', 'user', 58, 58, isoAgo(9), isoAgo(40), isoAgo(9), isoAgo(9));

  // Capability status: everything ok except rightsizing, which needs the console preference.
  const CAPS = [
    ['tag_keys', 1], ['cost_tags', 2], ['linked_accounts', 2], ['forecast', 1], ['sp_utilization', 2], ['sp_coverage', 1],
    ['ri_utilization', 1], ['ri_coverage', 1], ['anomalies', 2], ['rightsizing', 1], ['sp_recommendation', 1],
  ];
  const insertCap = db.prepare(`
    INSERT INTO aws_capability_status (account_id, capability, status, error, requests, last_ok_at, last_checked_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `);
  for (const [id, requests] of CAPS) {
    if (id === 'rightsizing') {
      insertCap.run(accountId, id, 'not_enabled',
        'Rightsizing recommendations are not enabled for this account. Turn them on in Cost Management preferences (Recommendations, EC2 rightsizing).',
        requests, null, isoAgo(0.25));
    } else {
      insertCap.run(accountId, id, 'ok', null, requests, isoAgo(0.25), isoAgo(0.25));
    }
  }
  db.prepare('UPDATE aws_accounts SET last_finops_capture_at = datetime(\'now\', \'-6 hours\'), finops_backfill_at = datetime(\'now\', \'-300 days\') WHERE id = ?').run(accountId);
  const upsertSetting = db.prepare(`
    INSERT INTO app_settings (key, value, updated_at) VALUES (?, ?, datetime('now'))
    ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at
  `);
  upsertSetting.run('aws_finops_tag_keys', JSON.stringify(['Environment', 'Team']));
  upsertSetting.run('aws_finops_tag_keys_seen', JSON.stringify(['Environment', 'Team', 'CostCenter']));
  upsertSetting.run('aws_finops_anomaly_monitors', JSON.stringify([
    { monitorArn: MONITOR_ARN, name: 'Services monitor', type: 'DIMENSIONAL', dimension: 'SERVICE' },
  ]));
  const finops = { allocRows, spRows, plans: 2, anomalies: 6, forecasts: 10, budgets: budgetDefs.length, recStates: 5, capabilities: CAPS.length };

  // ── Issue history: one open row per demoed trouble scenario ────────────
  const accountName = 'Demo AWS';
  let issueRows = 0;
  let usedReconcile = false;
  try {
    // eslint-disable-next-line global-require
    const { reconcileIssueHistory } = require('../../services/awsIssues');
    if (typeof reconcileIssueHistory === 'function') {
      reconcileIssueHistory();
      usedReconcile = true;
      issueRows = db.prepare("SELECT COUNT(*) c FROM aws_issue_history WHERE status = 'open'").get().c;
    }
  } catch {
    usedReconcile = false;
  }

  if (!usedReconcile) {
    const insertIssue = db.prepare(`
      INSERT INTO aws_issue_history (issue_key, account_id, account, severity, type, target, message,
        status, first_seen, last_seen, resolved_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, 'open', datetime('now', ?), datetime('now', ?), NULL)
    `);
    const failedInstance = EC2_INSTANCES.find((i) => i.statusCheck && i.statusCheck.includes('failed'));
    const degradedService = ECS_SERVICES.find((s) => s.status === 'ACTIVE' && s.runningCount < s.desiredCount);
    const publicBucket = S3_BUCKETS.find((b) => b.publicAccessBlocked === 0);
    const unattachedVolumes = EBS_VOLUMES.filter((v) => v.state === 'available');
    const lowStorageRds = RDS_INSTANCES.find((r) => r.status === 'available' && r.allocatedGb > 0
      && r.freeStorageBytes < r.allocatedGb * 1073741824 * 0.15);

    const issues = [
      {
        type: 'ec2-status-check', target: failedInstance.name || failedInstance.instanceId, severity: 'critical',
        message: `Instance ${failedInstance.name} status check failed`, openedMinAgo: 90,
      },
      {
        type: 'ecs-degraded', target: `${degradedService.clusterName}/${degradedService.serviceName}`, severity: 'critical',
        message: `Service ${degradedService.serviceName} running ${degradedService.runningCount}/${degradedService.desiredCount} tasks`, openedMinAgo: 60,
      },
      {
        type: 'cost-spike', target: 'estate', severity: 'warning',
        message: `Yesterday's AWS spend ($${yesterdayTotal.toFixed(2)}) is up ${Math.round(((yesterdayTotal - dayBeforeTotal) / dayBeforeTotal) * 100)}% over the day before`,
        openedMinAgo: 30,
      },
      {
        type: 's3-public', target: publicBucket.name, severity: 'warning',
        message: `Bucket ${publicBucket.name} does not block public access`, openedMinAgo: 240,
      },
    ];
    for (const v of unattachedVolumes) {
      issues.push({
        type: 'ebs-unattached', target: v.volumeId, severity: 'info',
        message: `Volume ${v.volumeId} (${v.sizeGb} GiB) is unattached`, openedMinAgo: 480,
      });
    }
    if (lowStorageRds) {
      const pct = Math.round((lowStorageRds.freeStorageBytes / (lowStorageRds.allocatedGb * 1073741824)) * 1000) / 10;
      issues.push({
        type: 'rds-storage-low', target: lowStorageRds.dbId, severity: 'warning',
        message: `RDS instance ${lowStorageRds.dbId} has ${pct}% free storage remaining`, openedMinAgo: 120,
      });
    }

    for (const issue of issues) {
      insertIssue.run(
        `${issue.type}|${accountName}|${issue.target}`, accountId, accountName,
        issue.severity, issue.type, issue.target, issue.message,
        `-${issue.openedMinAgo} minutes`, '-4 minutes'
      );
      issueRows++;
    }
  }

  void pick;
  void chance;

  return {
    accounts: 1,
    ec2: EC2_INSTANCES.length,
    ebs: EBS_VOLUMES.length,
    lightsail: LIGHTSAIL_INSTANCES.length,
    ecsClusters: ECS_CLUSTERS.length,
    ecsServices: ECS_SERVICES.length,
    s3: S3_BUCKETS.length,
    rds: RDS_INSTANCES.length,
    lambda: LAMBDA_FUNCTIONS.length,
    dynamo: DYNAMO_TABLES.length,
    ecr: ECR_REPOS.length,
    vpcs: VPCS.length,
    subnets: subnetRows,
    costRows,
    bedrockRows,
    metricsRows,
    issueRows,
    usedReconcile,
    s3HistoryRows,
    rdsHistoryRows,
    costUsageRows,
    costResourceRows,
    costInstanceTypeRows,
    healthRows,
    optimizerRows,
    finops,
  };
}

module.exports = { seedAws };
