// AWS platform manifest (ICC contract). Single-account v1 (schema carries
// account_id for future multi-account); one framework poller task per
// registered account, like vCenter/NetBackup.
const awsMigrations = require('../../db/migrations/aws');
const awsRouter = require('../../routes/aws');
const { awsPoller, initAwsPoller } = require('../../services/awsPoller');

module.exports = {
  id: 'aws',
  name: 'Amazon Web Services',
  apiVersion: 1,
  migrations: awsMigrations,
  createRouter() {
    return awsRouter;
  },
  createPoller() {
    return {
      ...awsPoller,
      init: () => initAwsPoller(),
    };
  },
  statusTables: ['aws_accounts'],
  settingsFields: [],
  navSections: ['overview', 'ec2', 's3', 'settings', 'advisor', 'privacy'],
  datasets: [
    {
      id: 'aws.ec2_instances',
      label: 'AWS EC2 Instances',
      table: 'aws_ec2_instances',
      section: 'ec2',
      defaultSort: 'name',
      columns: [
        { key: 'name', label: 'Name', type: 'string', filterable: true },
        { key: 'instance_id', label: 'Instance ID', type: 'string', filterable: true },
        { key: 'state', label: 'State', type: 'enum', filterable: true },
        { key: 'instance_type', label: 'Type', type: 'enum', filterable: true },
        { key: 'az', label: 'AZ', type: 'string', filterable: true },
        { key: 'private_ip', label: 'Private IP', type: 'string' },
        { key: 'public_ip', label: 'Public IP', type: 'string' },
        { key: 'cpu_util', label: 'CPU %', type: 'number', aggregatable: true },
        { key: 'status_check', label: 'Status Check', type: 'enum', filterable: true },
      ],
    },
    {
      id: 'aws.s3_buckets',
      label: 'AWS S3 Buckets',
      table: 'aws_s3_buckets',
      section: 'overview',
      defaultSort: 'name',
      columns: [
        { key: 'name', label: 'Bucket', type: 'string', filterable: true },
        { key: 'region', label: 'Region', type: 'enum', filterable: true },
        { key: 'size_bytes', label: 'Size', type: 'number', unit: 'bytes', aggregatable: true },
        { key: 'object_count', label: 'Objects', type: 'number', aggregatable: true },
        { key: 'public_access_blocked', label: 'Public Access Blocked', type: 'boolean', filterable: true },
        { key: 'versioning', label: 'Versioning', type: 'enum', filterable: true },
      ],
    },
    {
      id: 'aws.cost_daily',
      label: 'AWS Daily Cost',
      table: 'aws_cost_daily',
      section: 'overview',
      defaultSort: 'day',
      columns: [
        { key: 'day', label: 'Day', type: 'string', filterable: true },
        { key: 'service', label: 'Service', type: 'enum', filterable: true },
        { key: 'amount_usd', label: 'Amount', type: 'number', unit: 'usd', aggregatable: true },
      ],
    },
  ],
};
