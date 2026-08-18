// AWS plugin manifest.
//
// Migrations copied VERBATIM (same scope id 'aws') so an existing local
// DB's aws_* data (and its schema_migrations row) is adopted intact on
// install.
//
// HOOKS moved from core into this manifest (ported VERBATIM logic, db/
// getSetting now via coreApi):
//   - opsSummary        <- backend/routes/ops.js's awsSummary()
//   - collectAlerts     <- backend/services/alertNotifier.js's collectAwsIssues()
//   - searchCategories  <- backend/routes/search.js's 'aws-ec2'/'aws-s3'/'aws-ecs'/
//                          'aws-rds'/'aws-lambda'/'aws-dynamo' entries (ALL of them)
// No metricsHistory: the built-in manifest (backend/platforms/aws/index.js)
// never declared it, even though aws_accounts/aws_metrics_history would fit
// the shape — inventing it would be drift from the source, not fidelity.
// No server360/server360Suggest: grepped backend/routes/server360.js for
// 'aws' and found no references — the built-in never contributed to Server
// 360, so this plugin omits the hooks rather than inventing behavior.
const migrations = require('./migrations');
const { createRouter } = require('./router');
const { createAwsPoller } = require('./poller');

const num = (v) => Number(v) || 0;
const fnum = (v) => Number(v).toLocaleString('en-US');
const exception = (severity, cnt, text, link) => ({ severity, count: cnt, text, link });

// Align [{d:'YYYY-MM-DD', c}] rows to a dense last-7-days array (ops.js's spark7).
function spark7(rows) {
  const map = new Map(rows.map((r) => [r.d, num(r.c)]));
  const out = [];
  for (let i = 6; i >= 0; i--) {
    const d = new Date(Date.now() - i * 86400000).toISOString().slice(0, 10);
    out.push(map.get(d) || 0);
  }
  return out;
}

function opsSummary(coreApi) {
  const db = coreApi.db;
  const one = (sql, ...args) => db.prepare(sql).get(...args);
  const all = (sql, ...args) => db.prepare(sql).all(...args);
  const count = (sql, ...args) => num(one(sql, ...args)?.c);
  const countSafe = (sql, ...args) => { try { return count(sql, ...args); } catch { return 0; } };

  const accounts = count('SELECT COUNT(*) c FROM aws_accounts');
  if (!accounts) return null;
  const ec2Total = countSafe('SELECT COUNT(*) c FROM aws_ec2_instances');
  const ec2Running = countSafe("SELECT COUNT(*) c FROM aws_ec2_instances WHERE state = 'running'");
  const lightsailTotal = countSafe('SELECT COUNT(*) c FROM aws_lightsail_instances');
  const ecsServices = countSafe('SELECT COUNT(*) c FROM aws_ecs_services');
  const s3Buckets = countSafe('SELECT COUNT(*) c FROM aws_s3_buckets');
  const mtdRow = one("SELECT COALESCE(SUM(amount_usd), 0) c FROM aws_cost_daily WHERE day >= strftime('%Y-%m-01', 'now')");
  const mtd = num(mtdRow?.c);
  const sev = { critical: 0, warning: 0 };
  let costSpike = false;
  for (const r of all("SELECT type, severity, COUNT(*) c FROM aws_issue_history WHERE status = 'open' GROUP BY type, severity")) {
    const s = String(r.severity || '').toLowerCase();
    if (s === 'critical') sev.critical += num(r.c);
    else if (s === 'warning') sev.warning += num(r.c);
    if (r.type === 'cost-spike') costSpike = true;
  }
  const exceptions = [];
  if (sev.critical) exceptions.push(exception('critical', sev.critical, `${fnum(sev.critical)} critical issue${sev.critical === 1 ? '' : 's'}`, '/aws/alerts'));
  if (sev.warning) exceptions.push(exception('warning', sev.warning, `${fnum(sev.warning)} warning issue${sev.warning === 1 ? '' : 's'}${costSpike ? ' (cost spike)' : ''}`, '/aws/alerts'));
  return {
    objects: ec2Total + lightsailTotal + ecsServices + s3Buckets,
    headline: [
      { label: 'MTD Spend', value: `$${mtd.toFixed(2)}` },
      { label: 'EC2 Running', value: `${ec2Running}/${ec2Total}` },
    ],
    exceptions,
    spark: spark7(all(
      "SELECT date(captured_at) d, MAX(mtd_spend_usd) c FROM aws_metrics_history WHERE captured_at >= datetime('now','-7 days') GROUP BY date(captured_at)"
    )),
    sparkLabel: 'MTD spend 7d',
  };
}

const toIso = (v) => {
  if (v == null) return null;
  const d = new Date(v);
  return Number.isNaN(d.getTime()) ? String(v) : d.toISOString();
};

/** Open AWS computed issues — reconcileIssueHistory keeps aws_issue_history
 *  current with a stable issue_key per issue, and resolving drops the row
 *  out of this query (which is what ends reminders). */
function collectAlerts(coreApi) {
  const rows = coreApi.db.prepare(`
    SELECT i.issue_key AS issueKey, COALESCE(a.name, i.account, 'estate') AS account,
           i.severity, i.message, i.first_seen AS firstSeen, i.last_seen AS lastSeen
    FROM aws_issue_history i LEFT JOIN aws_accounts a ON i.account_id = a.id
    WHERE i.status = 'open'
  `).all();
  return rows.map((r) => ({
    sourceKey: `aws:${r.issueKey}`,
    severity: String(r.severity || '').toLowerCase(),
    host: r.account,
    message: r.message || '',
    firstSeen: toIso(r.firstSeen),
    lastSeen: toIso(r.lastSeen),
  }));
}

const searchCategories = [
  {
    key: 'aws-ec2', label: 'AWS EC2 Instances', platform: 'aws', perm: 'aws:ec2:view', base: '/aws/ec2',
    sql: `SELECT COALESCE(i.name, i.instance_id) AS title, (COALESCE(i.state, '') || ' · ' || COALESCE(i.instance_type, '') || ' · ' || a.name) AS subtitle
          FROM aws_ec2_instances i JOIN aws_accounts a ON a.id = i.account_id
          WHERE COALESCE(i.name, i.instance_id) LIKE ? ESCAPE '\\' ORDER BY title LIMIT ?`,
    params: 2,
  },
  {
    key: 'aws-s3', label: 'AWS S3 Buckets', platform: 'aws', perm: 'aws:s3:view', base: '/aws/s3',
    sql: `SELECT name AS title, region AS subtitle FROM aws_s3_buckets WHERE name LIKE ? ESCAPE '\\' ORDER BY name LIMIT ?`,
  },
  {
    key: 'aws-ecs', label: 'AWS ECS Services', platform: 'aws', perm: 'aws:ecs:view', base: '/aws/ecs',
    sql: `SELECT service_name AS title, cluster_name AS subtitle FROM aws_ecs_services WHERE service_name LIKE ? ESCAPE '\\' ORDER BY service_name LIMIT ?`,
  },
  {
    key: 'aws-rds', label: 'AWS RDS Instances', platform: 'aws', perm: 'aws:rds:view', base: '/aws/rds',
    sql: `SELECT r.db_id AS title, (COALESCE(r.engine, '') || ' · ' || a.name) AS subtitle
          FROM aws_rds_instances r JOIN aws_accounts a ON a.id = r.account_id
          WHERE r.db_id LIKE ? ESCAPE '\\' ORDER BY r.db_id LIMIT ?`,
    params: 2,
  },
  {
    key: 'aws-lambda', label: 'AWS Lambda Functions', platform: 'aws', perm: 'aws:lambda:view', base: '/aws/lambda',
    sql: `SELECT l.name AS title, (COALESCE(l.runtime, '') || ' · ' || a.name) AS subtitle
          FROM aws_lambda_functions l JOIN aws_accounts a ON a.id = l.account_id
          WHERE l.name LIKE ? ESCAPE '\\' ORDER BY l.name LIMIT ?`,
    params: 2,
  },
  {
    key: 'aws-dynamo', label: 'AWS DynamoDB Tables', platform: 'aws', perm: 'aws:dynamo:view', base: '/aws/dynamo',
    sql: `SELECT d.name AS title, (COALESCE(d.status, '') || ' · ' || a.name) AS subtitle
          FROM aws_dynamo_tables d JOIN aws_accounts a ON a.id = d.account_id
          WHERE d.name LIKE ? ESCAPE '\\' ORDER BY d.name LIMIT ?`,
    params: 2,
  },
];

module.exports = {
  id: 'aws',
  name: 'Amazon Web Services',
  apiVersion: 1,
  color: '#FF9900',
  // No hardcoded version: the installer falls back to the packaged
  // manifest.json (sourced from plugin.json at pack time). A literal here
  // goes stale on upgrades and — because the bundle URL cache-buster is
  // ?v=<version> — makes CDNs serve the OLD frontend bundle forever.
  migrations,
  createRouter(coreApi) {
    return createRouter(coreApi);
  },
  createPoller(coreApi) {
    return createAwsPoller(coreApi);
  },
  statusTables: ['aws_accounts'],
  settingsFields: [],
  navSections: ['overview', 'ec2', 's3', 'optimizer', 'settings', 'advisor', 'privacy'],
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
  opsSummary,
  collectAlerts,
  searchCategories,
};
