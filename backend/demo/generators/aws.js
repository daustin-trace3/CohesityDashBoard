// AWS scope demo data: 1 account ("Demo AWS", us-east-2), 8 EC2 instances,
// 10 EBS volumes, 2 Lightsail instances, 2 ECS clusters + 6 services, 6 S3
// buckets, 45 days of Cost Explorer data across 6 services, 30 days of
// Bedrock usage across 3 models, and 7 days of account metrics history.
// Includes deliberate trouble so the Overview issues panel demos every rule:
// an EC2 instance with a failed status check, an ECS service running under
// its desired count, yesterday's total AWS cost ~40% above the day before
// (tripping the 30% cost-spike threshold), a publicly-accessible S3 bucket,
// and unattached EBS volumes.
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

const COST_SERVICES = [
  { service: 'Amazon Elastic Compute Cloud - Compute', base: 45 },
  { service: 'Amazon Simple Storage Service', base: 8 },
  { service: 'Amazon Bedrock', base: 5 },
  { service: 'Amazon EC2 Container Service', base: 12 },
  { service: 'Amazon Lightsail', base: 3.5 },
  { service: 'AmazonCloudWatch', base: 2 },
];
const COST_DAYS = 45;
const SPIKE_MULTIPLIER = 1.4; // yesterday vs day-before -> ~40% above, trips 30% rule

const BEDROCK_MODELS = [
  'anthropic.claude-3-sonnet-20240229-v1:0',
  'anthropic.claude-3-haiku-20240307-v1:0',
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

const USAGE_TYPES = [
  { usageType: 'BoxUsage:m5.large', base: 8 },
  { usageType: 'BoxUsage:m5.xlarge', base: 6 },
  { usageType: 'EBS:VolumeUsage.gp3', base: 4 },
  { usageType: 'NatGateway-Hours', base: 3.5 },
  { usageType: 'DataTransfer-Out-Bytes', base: 2.5 },
  { usageType: 'TimedStorage-ByteHrs', base: 2 },
  { usageType: 'Requests-Tier1', base: 1.2 },
  { usageType: 'Lambda-GB-Second', base: 0.8 },
];
const COST_USAGE_DAYS = 45;

const INSTANCE_TYPE_COSTS = [
  { instanceType: 'm5.large', base: 18 },
  { instanceType: 'm5.xlarge', base: 24 },
  { instanceType: 't3.medium', base: 4 },
];
const COST_INSTANCE_TYPE_DAYS = 45;

const HEALTH_EVENTS = [
  { feed: 'ec2-us-east-2', service: 'ec2', region: 'us-east-2', title: 'Increased API error rates for EC2 in US-EAST-2', summary: 'Between 08:00 and 08:45 UTC, some customers experienced increased error rates for EC2 API calls. The issue has been resolved.', hoursAgo: 5 },
  { feed: 's3-us-east-2', service: 's3', region: 'us-east-2', title: 'Informational message about Amazon S3', summary: 'We are investigating increased request latencies for a subset of S3 requests in the US-EAST-2 Region.', hoursAgo: 72 },
];

const RDS_INSTANCES = [
  { dbId: 'demo-prod-postgres', engine: 'postgres', engineVersion: '15.4', instanceClass: 'db.r5.large', status: 'available', multiAz: 1, allocatedGb: 200, freeStorageBytes: Math.round(200 * 1024 ** 3 * 0.45), cpuUtil: 32.1, connections: 24, backupRetentionDays: 7, latestBackupDaysAgo: 0, endpoint: 'demo-prod-postgres.abcdemo.us-east-2.rds.amazonaws.com' },
  { dbId: 'demo-analytics-mysql', engine: 'mysql', engineVersion: '8.0.35', instanceClass: 'db.m5.large', status: 'available', multiAz: 0, allocatedGb: 500, freeStorageBytes: Math.round(500 * 1024 ** 3 * 0.09), cpuUtil: 54.6, connections: 60, backupRetentionDays: 7, latestBackupDaysAgo: 0, endpoint: 'demo-analytics-mysql.abcdemo.us-east-2.rds.amazonaws.com' },
  { dbId: 'demo-staging-postgres', engine: 'postgres', engineVersion: '15.4', instanceClass: 'db.t3.medium', status: 'available', multiAz: 0, allocatedGb: 50, freeStorageBytes: Math.round(50 * 1024 ** 3 * 0.7), cpuUtil: 8.9, connections: 4, backupRetentionDays: 3, latestBackupDaysAgo: 1, endpoint: 'demo-staging-postgres.abcdemo.us-east-2.rds.amazonaws.com' },
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
      last_poll_status, last_poll_error, last_poll_at, last_cost_capture_at, last_s3_capture_at, created_at, updated_at)
    VALUES (?, ?, ?, 'us-east-2', 10, 'success', NULL,
      datetime('now', ?), datetime('now', ?), datetime('now', ?), datetime('now', '-400 days'), datetime('now', '-4 minutes'))
  `);
  insertAccount.run(
    'Demo AWS', 'AKIADEMO0000000000EX', encrypt(JSON.stringify({ secretAccessKey: 'demo-not-real-secret' })),
    '-4 minutes', '-6 hours', '-6 hours'
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
      cpu_util, snapshot_count, latest_snapshot_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now', ?))
  `);
  for (const l of LIGHTSAIL_INSTANCES) {
    insertLightsail.run(accountId, l.name, l.state, l.blueprint, l.bundle, l.az, l.publicIp,
      l.cpuUtil, l.snapshotCount, `-${l.latestSnapshotDaysAgo} days`);
  }

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

  // ── Cost Explorer: 45 days x 6 services, yesterday ~40% above day-before ──
  const insertCost = db.prepare(`
    INSERT INTO aws_cost_daily (account_id, day, service, amount_usd, currency)
    VALUES (?, date('now', ?), ?, ?, 'USD')
  `);
  const costRng = rngFor('aws-cost-daily');
  let costRows = 0;
  let dayBeforeTotal = 0;
  let yesterdayTotal = 0;
  for (let i = COST_DAYS - 1; i >= 0; i--) {
    const offset = `-${i} days`;
    for (const svc of COST_SERVICES) {
      const drift = 1 + (COST_DAYS - i) / COST_DAYS * randFloat(costRng, -0.05, 0.2, 3);
      let amount = Math.max(0.05, svc.base * drift * randFloat(costRng, 0.85, 1.15, 3));
      if (i === 1) amount *= SPIKE_MULTIPLIER;
      amount = Math.round(amount * 100) / 100;
      insertCost.run(accountId, offset, svc.service, amount);
      costRows++;
      if (i === 1) yesterdayTotal += amount;
      if (i === 2) dayBeforeTotal += amount;
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
    INSERT INTO aws_cost_usage_daily (account_id, day, usage_type, amount_usd)
    VALUES (?, date('now', ?), ?, ?)
  `);
  const usageRng = rngFor('aws-cost-usage-daily');
  let costUsageRows = 0;
  for (let i = COST_USAGE_DAYS - 1; i >= 0; i--) {
    for (const u of USAGE_TYPES) {
      const amount = Math.round(u.base * randFloat(usageRng, 0.85, 1.15, 3) * 100) / 100;
      insertCostUsage.run(accountId, `-${i} days`, u.usageType, amount);
      costUsageRows++;
    }
  }

  // ── Cost instance-type breakdown: 45 days x 3 instance types ────────────
  const insertCostInstanceType = db.prepare(`
    INSERT INTO aws_cost_instance_type_daily (account_id, day, instance_type, amount_usd)
    VALUES (?, date('now', ?), ?, ?)
  `);
  const instTypeRng = rngFor('aws-cost-instance-type-daily');
  let costInstanceTypeRows = 0;
  for (let i = COST_INSTANCE_TYPE_DAYS - 1; i >= 0; i--) {
    for (const t of INSTANCE_TYPE_COSTS) {
      const amount = Math.round(t.base * randFloat(instTypeRng, 0.85, 1.15, 3) * 100) / 100;
      insertCostInstanceType.run(accountId, `-${i} days`, t.instanceType, amount);
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
    costInstanceTypeRows,
    healthRows,
  };
}

module.exports = { seedAws };
