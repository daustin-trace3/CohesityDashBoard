// AWS routes. Mounted by the plugin dispatcher at /api/aws — paths are
// relative. Registration CRUD stores secretAccessKey AES-encrypted;
// access_key_id is plaintext (shown in UI). A row with blank creds falls
// back to server .env (AWS_ACCESS_KEY_ID/AWS_SECRET_ACCESS_KEY) — credSource
// reports which. All responses are camelCase.
const express = require('express');
const { body, param, query, validationResult } = require('express-validator');
const db = require('../db/database');
const { encrypt } = require('../services/encryption');
const { setSetting } = require('../services/settings');
const awsApi = require('../services/awsApi');
const { awsPoller, getHealthLastCheckedAt, HEALTH_SERVICES, isElected } = require('../services/awsPoller');
const { costSpikePct, rdsStorageWarnPct, computeIssues } = require('../services/awsIssues');
const awsAdvisor = require('../services/advisors/awsAdvisor');

const router = express.Router();

const validate = (req, res, next) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) return res.status(400).json({ error: 'Invalid parameters', details: errors.array() });
  next();
};

const publicAccount = (row) => ({
  id: row.id, name: row.name, accessKeyId: row.access_key_id, region: row.region,
  pollingIntervalMinutes: row.polling_interval_minutes,
  lastPollStatus: row.last_poll_status, lastPollError: row.last_poll_error, lastPollAt: row.last_poll_at,
  credSource: awsApi.credSource(row),
});

// ── Accounts CRUD ────────────────────────────────────────────────────────────

/** GET /api/aws/accounts — registered accounts (never the secret). */
router.get('/accounts', (req, res, next) => {
  try {
    res.json(db.prepare('SELECT * FROM aws_accounts ORDER BY name').all().map(publicAccount));
  } catch (err) { next(err); }
});

/** POST /api/aws/accounts — register an account; creds optional (env mode). */
router.post('/accounts', [
  body('name').isString().trim().notEmpty().isLength({ max: 120 }),
  body('accessKeyId').optional({ nullable: true }).isString().trim().isLength({ max: 128 }),
  body('secretAccessKey').optional({ nullable: true }).isString().isLength({ max: 256 }),
  body('region').optional().isString().trim().isLength({ max: 32 }),
  body('pollingIntervalMinutes').optional().isInt({ min: 5, max: 1440 }).toInt(),
], validate, (req, res, next) => {
  try {
    const { name } = req.body;
    const dup = db.prepare('SELECT id FROM aws_accounts WHERE name = ?').get(name.trim());
    if (dup) return res.status(409).json({ error: 'duplicate' });
    const accessKeyId = req.body.accessKeyId?.trim() || null;
    const encryptedCreds = req.body.secretAccessKey
      ? encrypt(JSON.stringify({ secretAccessKey: req.body.secretAccessKey })) : null;
    const info = db.prepare(`
      INSERT INTO aws_accounts (name, access_key_id, encrypted_credentials, region, polling_interval_minutes)
      VALUES (?, ?, ?, ?, ?)
    `).run(name.trim(), accessKeyId, encryptedCreds, req.body.region?.trim() || 'us-east-2',
      req.body.pollingIntervalMinutes || 10);
    const row = db.prepare('SELECT * FROM aws_accounts WHERE id = ?').get(info.lastInsertRowid);
    awsPoller.schedule(row);
    awsPoller.trigger(row).catch(() => {});
    res.status(201).json(publicAccount(row));
  } catch (err) { next(err); }
});

/** PUT /api/aws/accounts/:id — update (creds optional; blank keeps stored). */
router.put('/accounts/:id', [
  param('id').isInt().toInt(),
  body('name').optional().isString().trim().notEmpty().isLength({ max: 120 }),
  body('accessKeyId').optional({ nullable: true }).isString().trim().isLength({ max: 128 }),
  body('secretAccessKey').optional({ nullable: true }).isString().isLength({ max: 256 }),
  body('region').optional().isString().trim().isLength({ max: 32 }),
  body('pollingIntervalMinutes').optional().isInt({ min: 5, max: 1440 }).toInt(),
], validate, (req, res, next) => {
  try {
    const row = db.prepare('SELECT * FROM aws_accounts WHERE id = ?').get(req.params.id);
    if (!row) return res.status(404).json({ error: 'Account not found.' });
    const b = req.body;
    if (b.name && b.name.trim() !== row.name) {
      const dup = db.prepare('SELECT id FROM aws_accounts WHERE name = ? AND id != ?').get(b.name.trim(), row.id);
      if (dup) return res.status(409).json({ error: 'duplicate' });
    }
    db.prepare(`
      UPDATE aws_accounts SET
        name = ?, access_key_id = ?, encrypted_credentials = ?, region = ?,
        polling_interval_minutes = ?, updated_at = datetime('now')
      WHERE id = ?
    `).run(
      b.name?.trim() || row.name,
      b.accessKeyId !== undefined ? (b.accessKeyId?.trim() || null) : row.access_key_id,
      b.secretAccessKey ? encrypt(JSON.stringify({ secretAccessKey: b.secretAccessKey })) : row.encrypted_credentials,
      b.region?.trim() || row.region,
      b.pollingIntervalMinutes || row.polling_interval_minutes,
      row.id
    );
    const updated = db.prepare('SELECT * FROM aws_accounts WHERE id = ?').get(row.id);
    awsPoller.schedule(updated);
    res.json(publicAccount(updated));
  } catch (err) { next(err); }
});

/** DELETE /api/aws/accounts/:id — unregister (CASCADE clears inventory). */
router.delete('/accounts/:id', [param('id').isInt().toInt()], validate, (req, res, next) => {
  try {
    const row = db.prepare('SELECT * FROM aws_accounts WHERE id = ?').get(req.params.id);
    if (!row) return res.status(404).json({ error: 'Account not found.' });
    awsPoller.cancel(row.id);
    db.prepare('DELETE FROM aws_accounts WHERE id = ?').run(row.id);
    res.json({ deleted: true });
  } catch (err) { next(err); }
});

/** POST /api/aws/accounts/test — validate a saved account ({id}) or a candidate. */
router.post('/accounts/test', [
  body('id').optional().isInt().toInt(),
  body('accessKeyId').optional({ nullable: true }).isString(),
  body('secretAccessKey').optional({ nullable: true }).isString(),
  body('region').optional().isString(),
], validate, async (req, res) => {
  const b = req.body;
  let candidate;
  if (b.id) {
    const row = db.prepare('SELECT * FROM aws_accounts WHERE id = ?').get(b.id);
    if (!row) return res.status(404).json({ error: 'Account not found.' });
    candidate = { ...row };
    if (b.region) candidate.region = b.region;
    if (b.accessKeyId) candidate.accessKeyId = b.accessKeyId;
    if (b.secretAccessKey) candidate.secretAccessKey = b.secretAccessKey;
  } else {
    candidate = { accessKeyId: b.accessKeyId, secretAccessKey: b.secretAccessKey, region: b.region || 'us-east-2' };
  }
  const result = await awsApi.testConnection(candidate);
  res.status(result.ok ? 200 : 502).json(result);
});

/** POST /api/aws/accounts/:id/refresh — poll this account now. */
router.post('/accounts/:id/refresh', [param('id').isInt().toInt()], validate, async (req, res, next) => {
  try {
    const row = db.prepare('SELECT * FROM aws_accounts WHERE id = ?').get(req.params.id);
    if (!row) return res.status(404).json({ error: 'Account not found.' });
    await awsPoller.trigger(row);
    res.json(publicAccount(db.prepare('SELECT * FROM aws_accounts WHERE id = ?').get(row.id)));
  } catch (err) { next(err); }
});

// ── Probe (blind-build fix loop) ─────────────────────────────────────────────

const PROBE_SERVICES = ['ec2', 'ebs', 'lightsail', 'ecs', 's3', 'bedrock', 'cost', 'rds', 'lambda', 'dynamo', 'ecr', 'vpc', 'optimizer'];

function truncate(raw) {
  if (Array.isArray(raw)) return { items: raw.slice(0, 2), _count: raw.length };
  if (raw && typeof raw === 'object') {
    const out = {};
    for (const [k, v] of Object.entries(raw)) {
      if (Array.isArray(v)) out[k] = { items: v.slice(0, 2), _count: v.length };
      else out[k] = v;
    }
    return out;
  }
  return raw;
}

/** GET /api/aws/accounts/:id/probe?service= — raw-shape probe. */
router.get('/accounts/:id/probe', [
  param('id').isInt().toInt(),
  query('service').isIn(PROBE_SERVICES),
], validate, async (req, res, next) => {
  try {
    const row = db.prepare('SELECT * FROM aws_accounts WHERE id = ?').get(req.params.id);
    if (!row) return res.status(404).json({ error: 'Account not found.' });
    const service = req.query.service;
    let raw;
    switch (service) {
      case 'ec2': {
        const instances = await awsApi.fetchEc2Instances(row);
        raw = { instances };
        break;
      }
      case 'ebs': {
        const volumes = await awsApi.fetchEbsVolumes(row);
        raw = { volumes };
        break;
      }
      case 'lightsail': {
        const instances = await awsApi.fetchLightsailInstances(row);
        raw = { instances };
        break;
      }
      case 'ecs': {
        const clusters = await awsApi.fetchEcsClusters(row);
        raw = { clusters };
        break;
      }
      case 's3': {
        const buckets = await awsApi.fetchS3Buckets(row);
        raw = { buckets };
        break;
      }
      case 'bedrock': {
        const modelIds = await awsApi.fetchBedrockModelIds(row);
        raw = { modelIds };
        break;
      }
      case 'cost': {
        if (row.last_cost_capture_at && Date.now() - new Date(row.last_cost_capture_at).getTime() < 20 * 3600 * 1000) {
          const rows = db.prepare('SELECT * FROM aws_cost_daily WHERE account_id = ? ORDER BY day DESC LIMIT 50').all(row.id);
          return res.json({ service, cached: true, raw: { rows } });
        }
        const rows = await awsApi.fetchCostAndUsage(row);
        db.prepare('UPDATE aws_accounts SET last_cost_capture_at = datetime(\'now\') WHERE id = ?').run(row.id);
        raw = { rows };
        break;
      }
      case 'rds': {
        const instances = await awsApi.fetchRdsInstances(row);
        raw = { instances };
        break;
      }
      case 'lambda': {
        const functions = await awsApi.fetchLambdaFunctions(row);
        raw = { functions };
        break;
      }
      case 'dynamo': {
        const tables = await awsApi.fetchDynamoTableNames(row);
        raw = { tables };
        break;
      }
      case 'ecr': {
        const repos = await awsApi.fetchEcrRepos(row);
        raw = { repos };
        break;
      }
      case 'vpc': {
        const vpcs = await awsApi.fetchVpcs(row);
        const subnets = await awsApi.fetchSubnets(row);
        raw = { vpcs, subnets };
        break;
      }
      case 'optimizer': {
        const enrollment = await awsApi.fetchCoEnrollmentStatus(row);
        const ec2Recommendations = enrollment.status === 'Active' ? await awsApi.fetchCoEc2Recommendations(row) : [];
        raw = { enrollment, ec2Recommendations };
        break;
      }
      default:
        return res.status(400).json({ error: 'Unknown service.' });
    }
    res.json({ service, raw: truncate(raw) });
  } catch (err) { next(err); }
});

// ── Config ───────────────────────────────────────────────────────────────────

/** GET /api/aws/config — alert thresholds. */
router.get('/config', (req, res, next) => {
  try {
    res.json({ costSpikePct: costSpikePct(), rdsStorageWarnPct: rdsStorageWarnPct() });
  } catch (err) { next(err); }
});

/** PUT /api/aws/config — save alert thresholds. */
router.put('/config', [
  body('costSpikePct').isInt({ min: 5, max: 500 }).toInt(),
  body('rdsStorageWarnPct').optional().isInt({ min: 5, max: 50 }).toInt(),
], validate, (req, res, next) => {
  try {
    setSetting('aws_cost_spike_pct', String(req.body.costSpikePct));
    if (req.body.rdsStorageWarnPct !== undefined) setSetting('aws_rds_storage_warn_pct', String(req.body.rdsStorageWarnPct));
    res.json({ costSpikePct: costSpikePct(), rdsStorageWarnPct: rdsStorageWarnPct() });
  } catch (err) { next(err); }
});

// ── Health (AWS Service Health RSS) ─────────────────────────────────────────

/** GET /api/aws/health — recent events across every monitored feed, last 7 days. */
router.get('/health', (req, res, next) => {
  try {
    const rows = db.prepare(`
      SELECT service, region, title, summary, published_at FROM aws_health_events
      WHERE published_at >= datetime('now', '-7 days')
      ORDER BY published_at DESC LIMIT 50
    `).all();
    const recentEvents = db.prepare(`
      SELECT COUNT(*) AS n FROM aws_health_events WHERE published_at >= datetime('now', '-24 hours')
    `).get().n || 0;
    const regions = db.prepare('SELECT DISTINCT region FROM aws_accounts ORDER BY region').all().map((r) => r.region);
    const active = db.prepare(`
      SELECT service, region, MAX(published_at) AS last_event_at,
             (SELECT title FROM aws_health_events e2
              WHERE e2.service = e.service AND e2.region = e.region
              ORDER BY e2.published_at DESC LIMIT 1) AS title
      FROM aws_health_events e
      WHERE published_at >= datetime('now', '-24 hours')
      GROUP BY service, region
    `).all();
    const activeMap = new Map(active.map((a) => [`${a.service}|${a.region}`, a]));
    const matrix = HEALTH_SERVICES.map((service) => {
      const regionCells = regions.map((region) => {
        const ev = activeMap.get(`${service}|${region}`);
        return {
          region,
          status: ev ? 'event' : 'ok',
          title: ev ? ev.title : null,
          publishedAt: ev ? ev.last_event_at : null,
        };
      });
      return { service, degraded: regionCells.some((c) => c.status === 'event'), regions: regionCells };
    }).sort((a, b) => (b.degraded - a.degraded) || a.service.localeCompare(b.service));
    res.json({
      operational: recentEvents === 0,
      lastChecked: getHealthLastCheckedAt(),
      regions,
      matrix,
      events: rows.map((r) => ({
        service: r.service, region: r.region, title: r.title, summary: r.summary, publishedAt: r.published_at,
      })),
    });
  } catch (err) { next(err); }
});

// ── Issues ───────────────────────────────────────────────────────────────────

/** GET /api/aws/issues — computed issues (Alerts feed). */
router.get('/issues', (req, res, next) => {
  try {
    res.json({
      issues: computeIssues().map((i) => ({
        severity: i.severity, type: i.type, account: i.account, target: i.target, message: i.message,
      })),
    });
  } catch (err) { next(err); }
});

/** GET /api/aws/issue-history — bare array of issue lifecycle rows. */
router.get('/issue-history', (req, res, next) => {
  try {
    const rows = db.prepare(`
      SELECT h.*, COALESCE(a.name, h.account, 'estate') AS resolved_account
      FROM aws_issue_history h LEFT JOIN aws_accounts a ON a.id = h.account_id
      ORDER BY CASE h.status WHEN 'open' THEN 0 ELSE 1 END, h.last_seen DESC
    `).all();
    res.json(rows.map((r) => ({
      id: r.id, issueKey: r.issue_key, account: r.resolved_account, severity: r.severity, type: r.type,
      target: r.target, message: r.message, status: r.status, firstSeen: r.first_seen,
      lastSeen: r.last_seen, resolvedAt: r.resolved_at,
    })));
  } catch (err) { next(err); }
});

// ── Overview ─────────────────────────────────────────────────────────────────

/** GET /api/aws/overview — estate rollup + computed issue counts. */
router.get('/overview', [query('accountId').optional().isInt().toInt()], validate, (req, res, next) => {
  try {
    const accountCount = db.prepare('SELECT COUNT(*) AS n FROM aws_accounts').get().n;

    // Optional region scope: filter inventory/issues to one account row. Cost
    // and health stay account-global (Cost Explorer has no region dimension);
    // S3 rows all live on the elected row, so they scope by bucket region.
    const fAcct = req.query.accountId || null;
    const fRow = fAcct ? db.prepare('SELECT id, name, region FROM aws_accounts WHERE id = ?').get(fAcct) : null;
    const W = fRow ? ' WHERE account_id = ?' : '';
    const A = fRow ? ' AND account_id = ?' : '';
    const args = fRow ? [fRow.id] : [];

    const ec2Agg = db.prepare(`
      SELECT COUNT(*) AS total,
        SUM(CASE WHEN state = 'running' THEN 1 ELSE 0 END) AS running,
        SUM(CASE WHEN state = 'stopped' THEN 1 ELSE 0 END) AS stopped,
        SUM(CASE WHEN state = 'running' AND status_check LIKE '%failed%' THEN 1 ELSE 0 END) AS alarmed
      FROM aws_ec2_instances${W}
    `).get(...args);

    const lsAgg = db.prepare(`
      SELECT COUNT(*) AS total, SUM(CASE WHEN state = 'running' THEN 1 ELSE 0 END) AS running
      FROM aws_lightsail_instances${W}
    `).get(...args);

    const ecsAgg = db.prepare(`SELECT COUNT(*) AS clusters FROM aws_ecs_clusters${W}`).get(...args);
    const svcAgg = db.prepare(`
      SELECT COUNT(*) AS services,
        SUM(CASE WHEN status = 'ACTIVE' AND running_count < desired_count THEN 1 ELSE 0 END) AS degraded
      FROM aws_ecs_services${W}
    `).get(...args);

    const s3Agg = fRow
      ? db.prepare(`
          SELECT COUNT(*) AS buckets, SUM(size_bytes) AS totalSizeBytes, SUM(object_count) AS totalObjects
          FROM aws_s3_buckets WHERE region = ?
        `).get(fRow.region)
      : db.prepare(`
          SELECT COUNT(*) AS buckets, SUM(size_bytes) AS totalSizeBytes, SUM(object_count) AS totalObjects
          FROM aws_s3_buckets
        `).get();

    const today = new Date().toISOString().slice(0, 10);
    const yesterday = new Date(Date.now() - 86400000).toISOString().slice(0, 10);
    const dayBefore = new Date(Date.now() - 2 * 86400000).toISOString().slice(0, 10);
    const monthStart = `${today.slice(0, 7)}-01`;
    const mtdUsd = db.prepare('SELECT SUM(amount_usd) AS s FROM aws_cost_daily WHERE day >= ?').get(monthStart).s || 0;
    const prevDayUsd = db.prepare('SELECT SUM(amount_usd) AS s FROM aws_cost_daily WHERE day = ?').get(yesterday).s || 0;
    const dayBeforeUsd = db.prepare('SELECT SUM(amount_usd) AS s FROM aws_cost_daily WHERE day = ?').get(dayBefore).s || 0;
    const deltaPct = dayBeforeUsd > 0 ? ((prevDayUsd - dayBeforeUsd) / dayBeforeUsd) * 100 : null;
    const topServices = db.prepare(`
      SELECT service, SUM(amount_usd) AS mtdUsd FROM aws_cost_daily WHERE day >= ?
      GROUP BY service ORDER BY mtdUsd DESC LIMIT 6
    `).all(monthStart);

    const bedrockAgg = db.prepare(`
      SELECT SUM(invocations) AS invocations30d, SUM(input_tokens) AS inputTokens30d, SUM(output_tokens) AS outputTokens30d
      FROM aws_bedrock_usage WHERE day >= date('now', '-30 days')${A}
    `).get(...args);

    const allIssues = computeIssues();
    const issues = fRow ? allIssues.filter((i) => i.account === fRow.name) : allIssues;
    const issueCounts = { critical: 0, warning: 0, info: 0 };
    for (const i of issues) issueCounts[i.severity] = (issueCounts[i.severity] || 0) + 1;

    const rdsAgg = db.prepare(`
      SELECT COUNT(*) AS total, SUM(CASE WHEN status = 'available' THEN 1 ELSE 0 END) AS available
      FROM aws_rds_instances${W}
    `).get(...args);
    const rdsPct = rdsStorageWarnPct();
    const rdsStorageLow = db.prepare(`
      SELECT COUNT(*) AS n FROM aws_rds_instances
      WHERE status = 'available' AND allocated_gb > 0 AND free_storage_bytes IS NOT NULL
        AND free_storage_bytes < (allocated_gb * 1073741824 * ? / 100)${A}
    `).get(rdsPct, ...args).n;

    const lambdaAgg = db.prepare(`SELECT COUNT(*) AS total, SUM(errors_24h) AS errors24h FROM aws_lambda_functions${W}`).get(...args);

    const dynamoAgg = db.prepare(`SELECT COUNT(*) AS total, SUM(size_bytes) AS sizeBytes FROM aws_dynamo_tables${W}`).get(...args);
    const ecrAgg = db.prepare(`SELECT COUNT(*) AS repos FROM aws_ecr_repos${W}`).get(...args);
    const vpcAgg = db.prepare(`SELECT COUNT(*) AS vpcs, SUM(nat_gateway_count) AS natGateways FROM aws_vpcs${W}`).get(...args);

    const healthRecent24h = db.prepare(`
      SELECT COUNT(*) AS n FROM aws_health_events WHERE published_at >= datetime('now', '-24 hours')
    `).get().n || 0;

    const accountsDetail = db.prepare('SELECT id, name, region, last_poll_status, last_poll_at FROM aws_accounts ORDER BY name').all()
      .map((r) => ({ id: r.id, name: r.name, region: r.region, lastPollStatus: r.last_poll_status, lastPollAt: r.last_poll_at }));

    const unattachedEbs = db.prepare(`SELECT COUNT(*) AS n FROM aws_ebs_volumes WHERE state = 'available'${A}`).get(...args).n || 0;
    const natGatewaysTotal = db.prepare(`SELECT SUM(nat_gateway_count) AS n FROM aws_vpcs${W}`).get(...args).n || 0;

    // Post-fix-#0 aws_cost_daily only carries the elected credential's rows, so a plain SUM is correct.
    const moverRows = db.prepare(`
      SELECT service,
        SUM(CASE WHEN day = ? THEN amount_usd ELSE 0 END) AS lastUsd,
        SUM(CASE WHEN day = ? THEN amount_usd ELSE 0 END) AS prevUsd
      FROM aws_cost_daily WHERE day IN (?, ?)
      GROUP BY service
    `).all(yesterday, dayBefore, yesterday, dayBefore);
    const topMovers = moverRows.map((r) => ({
      service: r.service, prevUsd: r.prevUsd || 0, lastUsd: r.lastUsd || 0, deltaUsd: (r.lastUsd || 0) - (r.prevUsd || 0),
    })).sort((a, b) => Math.abs(b.deltaUsd) - Math.abs(a.deltaUsd)).slice(0, 5);

    res.json({
      accounts: accountCount,
      ec2: { total: ec2Agg.total || 0, running: ec2Agg.running || 0, stopped: ec2Agg.stopped || 0, alarmed: ec2Agg.alarmed || 0 },
      lightsail: { total: lsAgg.total || 0, running: lsAgg.running || 0 },
      ecs: { clusters: ecsAgg.clusters || 0, services: svcAgg.services || 0, degraded: svcAgg.degraded || 0 },
      s3: { buckets: s3Agg.buckets || 0, totalSizeBytes: s3Agg.totalSizeBytes || 0, totalObjects: s3Agg.totalObjects || 0 },
      cost: {
        mtdUsd, prevDayUsd, dayBeforeUsd, deltaPct,
        topServices: topServices.map((r) => ({ service: r.service, mtdUsd: r.mtdUsd })),
      },
      bedrock: {
        invocations30d: bedrockAgg.invocations30d || 0,
        inputTokens30d: bedrockAgg.inputTokens30d || 0,
        outputTokens30d: bedrockAgg.outputTokens30d || 0,
      },
      issues: issueCounts,
      rds: { total: rdsAgg.total || 0, available: rdsAgg.available || 0, storageLow: rdsStorageLow || 0 },
      lambda: { total: lambdaAgg.total || 0, errors24h: lambdaAgg.errors24h || 0 },
      dynamo: { total: dynamoAgg.total || 0, sizeBytes: dynamoAgg.sizeBytes || 0 },
      ecr: { repos: ecrAgg.repos || 0 },
      vpc: { vpcs: vpcAgg.vpcs || 0, natGateways: vpcAgg.natGateways || 0 },
      health: { operational: healthRecent24h === 0, recentEvents: healthRecent24h },
      accountsDetail,
      estate: { unattachedEbs, natGateways: natGatewaysTotal, topMovers },
    });
  } catch (err) { next(err); }
});

// ── Data endpoints ───────────────────────────────────────────────────────────

/** GET /api/aws/ec2 — EC2 instances across all accounts. */
router.get('/ec2', (req, res, next) => {
  try {
    const rows = db.prepare(`
      SELECT e.*, a.name AS account_name FROM aws_ec2_instances e
      JOIN aws_accounts a ON a.id = e.account_id ORDER BY a.name, e.name, e.instance_id
    `).all();
    res.json({
      instances: rows.map((r) => ({
        id: r.id, instanceId: r.instance_id, name: r.name, state: r.state, instanceType: r.instance_type,
        az: r.az, privateIp: r.private_ip, publicIp: r.public_ip, platform: r.platform,
        launchTime: r.launch_time, cpuUtil: r.cpu_util, statusCheck: r.status_check, account: r.account_name,
      })),
    });
  } catch (err) { next(err); }
});

/** GET /api/aws/ebs — EBS volumes across all accounts. */
router.get('/ebs', (req, res, next) => {
  try {
    const rows = db.prepare(`
      SELECT v.*, a.name AS account_name FROM aws_ebs_volumes v
      JOIN aws_accounts a ON a.id = v.account_id ORDER BY a.name, v.volume_id
    `).all();
    res.json({
      volumes: rows.map((r) => ({
        volumeId: r.volume_id, state: r.state, sizeGb: r.size_gb, volumeType: r.volume_type,
        az: r.az, attachedInstanceId: r.attached_instance_id, account: r.account_name,
      })),
    });
  } catch (err) { next(err); }
});

/** GET /api/aws/lightsail — Lightsail instances across all accounts. */
router.get('/lightsail', (req, res, next) => {
  try {
    const rows = db.prepare(`
      SELECT i.*, a.name AS account_name FROM aws_lightsail_instances i
      JOIN aws_accounts a ON a.id = i.account_id ORDER BY a.name, i.name
    `).all();
    res.json({
      instances: rows.map((r) => ({
        name: r.name, state: r.state, blueprint: r.blueprint, bundle: r.bundle, az: r.az,
        publicIp: r.public_ip, cpuUtil: r.cpu_util, snapshotCount: r.snapshot_count,
        latestSnapshotAt: r.latest_snapshot_at, account: r.account_name,
      })),
    });
  } catch (err) { next(err); }
});

/** GET /api/aws/ecs — clusters + services across all accounts. */
router.get('/ecs', (req, res, next) => {
  try {
    const clusters = db.prepare(`
      SELECT c.*, a.name AS account_name FROM aws_ecs_clusters c
      JOIN aws_accounts a ON a.id = c.account_id ORDER BY a.name, c.cluster_name
    `).all();
    const services = db.prepare(`
      SELECT s.*, a.name AS account_name FROM aws_ecs_services s
      JOIN aws_accounts a ON a.id = s.account_id ORDER BY a.name, s.cluster_name, s.service_name
    `).all();
    res.json({
      clusters: clusters.map((r) => ({
        clusterName: r.cluster_name, status: r.status, runningTasks: r.running_tasks,
        pendingTasks: r.pending_tasks, serviceCount: r.service_count,
        containerInstances: r.container_instances, account: r.account_name,
      })),
      services: services.map((r) => ({
        clusterName: r.cluster_name, serviceName: r.service_name, status: r.status,
        desiredCount: r.desired_count, runningCount: r.running_count, pendingCount: r.pending_count,
        launchType: r.launch_type, cpuUtil: r.cpu_util, memoryUtil: r.memory_util, account: r.account_name,
      })),
    });
  } catch (err) { next(err); }
});

/** GET /api/aws/s3 — S3 buckets across all accounts. */
router.get('/s3', (req, res, next) => {
  try {
    const rows = db.prepare(`
      SELECT b.*, a.name AS account_name FROM aws_s3_buckets b
      JOIN aws_accounts a ON a.id = b.account_id ORDER BY a.name, b.name
    `).all();
    res.json({
      buckets: rows.map((r) => ({
        name: r.name, region: r.region, sizeBytes: r.size_bytes, objectCount: r.object_count,
        publicAccessBlocked: !!r.public_access_blocked, versioning: r.versioning,
        lifecycleRules: r.lifecycle_rules, createdAt: r.created_at_aws, account: r.account_name,
      })),
    });
  } catch (err) { next(err); }
});

/** GET /api/aws/bedrock — usage across all accounts + 30d totals. */
router.get('/bedrock', (req, res, next) => {
  try {
    const rows = db.prepare(`
      SELECT model_id, day, invocations, input_tokens, output_tokens, avg_latency_ms
      FROM aws_bedrock_usage WHERE day >= date('now', '-30 days') ORDER BY day, model_id
    `).all();
    const totals = db.prepare(`
      SELECT SUM(invocations) AS invocations30d, SUM(input_tokens) AS inputTokens30d, SUM(output_tokens) AS outputTokens30d
      FROM aws_bedrock_usage WHERE day >= date('now', '-30 days')
    `).get();
    res.json({
      models: rows.map((r) => ({
        modelId: r.model_id, day: r.day, invocations: r.invocations, inputTokens: r.input_tokens,
        outputTokens: r.output_tokens, avgLatencyMs: r.avg_latency_ms,
      })),
      totals: {
        invocations30d: totals.invocations30d || 0,
        inputTokens30d: totals.inputTokens30d || 0,
        outputTokens30d: totals.outputTokens30d || 0,
      },
    });
  } catch (err) { next(err); }
});

/** GET /api/aws/costs?days=30&accountId= — accountId is an optional additive filter. */
router.get('/costs', [
  query('days').optional().isInt().toInt(),
  query('accountId').optional().isInt().toInt(),
], validate, (req, res, next) => {
  try {
    const days = Math.min(365, Math.max(7, req.query.days || 30));
    const accountId = req.query.accountId;
    const acctSql = accountId ? 'AND account_id = ?' : '';
    const acctArg = accountId ? [accountId] : [];
    const rows = db.prepare(`
      SELECT day, service, amount_usd FROM aws_cost_daily
      WHERE day >= date('now', ?) ${acctSql} ORDER BY day ASC
    `).all(`-${days} days`, ...acctArg);
    const byDay = new Map();
    for (const r of rows) {
      if (!byDay.has(r.day)) byDay.set(r.day, { day: r.day, totalUsd: 0, services: [] });
      const d = byDay.get(r.day);
      d.totalUsd += r.amount_usd || 0;
      d.services.push({ service: r.service, amountUsd: r.amount_usd || 0 });
    }
    const monthStart = `${new Date().toISOString().slice(0, 7)}-01`;
    const mtdRows = db.prepare(`SELECT SUM(amount_usd) AS s FROM aws_cost_daily WHERE day >= ? ${acctSql}`).get(monthStart, ...acctArg);
    const mtdUsd = mtdRows.s || 0;
    const yesterday = new Date(Date.now() - 86400000).toISOString().slice(0, 10);
    const dayBefore = new Date(Date.now() - 2 * 86400000).toISOString().slice(0, 10);
    const yTotal = db.prepare(`SELECT SUM(amount_usd) AS s FROM aws_cost_daily WHERE day = ? ${acctSql}`).get(yesterday, ...acctArg).s || 0;
    const dbTotal = db.prepare(`SELECT SUM(amount_usd) AS s FROM aws_cost_daily WHERE day = ? ${acctSql}`).get(dayBefore, ...acctArg).s || 0;
    const deltaPct = dbTotal > 0 ? ((yTotal - dbTotal) / dbTotal) * 100 : null;
    const byServiceMap = new Map();
    for (const r of db.prepare(`SELECT service, SUM(amount_usd) AS mtdUsd FROM aws_cost_daily WHERE day >= ? ${acctSql} GROUP BY service`)
      .all(monthStart, ...acctArg)) {
      byServiceMap.set(r.service, r.mtdUsd || 0);
    }
    res.json({
      days: [...byDay.values()],
      mtdUsd, deltaPct,
      byService: [...byServiceMap.entries()].map(([service, mtdUsd]) => ({ service, mtdUsd })).sort((a, b) => b.mtdUsd - a.mtdUsd),
    });
  } catch (err) { next(err); }
});

/** GET /api/aws/costs/usage-types?days=30&accountId= — explains "EC2 - Other" style line items. */
router.get('/costs/usage-types', [
  query('days').optional().isInt().toInt(),
  query('accountId').optional().isInt().toInt(),
  query('day').optional().matches(/^\d{4}-\d{2}-\d{2}$/),
], validate, (req, res, next) => {
  try {
    const days = Math.min(90, Math.max(7, req.query.days || 30));
    const accountId = req.query.accountId;
    const acctSql = accountId ? 'AND account_id = ?' : '';
    const acctArg = accountId ? [accountId] : [];
    const daySql = req.query.day ? 'AND day = ?' : "AND day >= date('now', ?)";
    const dayArg = req.query.day ? [req.query.day] : [`-${days} days`];
    const rows = db.prepare(`
      SELECT usage_type, SUM(amount_usd) AS total_usd FROM aws_cost_usage_daily
      WHERE 1=1 ${daySql} ${acctSql}
      GROUP BY usage_type ORDER BY total_usd DESC LIMIT 40
    `).all(...dayArg, ...acctArg);
    res.json({ rows: rows.map((r) => ({ usageType: r.usage_type, totalUsd: r.total_usd || 0 })) });
  } catch (err) { next(err); }
});

/** GET /api/aws/costs/instance-types?days=30&accountId= */
router.get('/costs/instance-types', [
  query('days').optional().isInt().toInt(),
  query('accountId').optional().isInt().toInt(),
], validate, (req, res, next) => {
  try {
    const days = Math.min(90, Math.max(7, req.query.days || 30));
    const accountId = req.query.accountId;
    const acctSql = accountId ? 'AND account_id = ?' : '';
    const acctArg = accountId ? [accountId] : [];
    const rows = db.prepare(`
      SELECT instance_type, SUM(amount_usd) AS total_usd FROM aws_cost_instance_type_daily
      WHERE day >= date('now', ?) ${acctSql}
      GROUP BY instance_type ORDER BY total_usd DESC
    `).all(`-${days} days`, ...acctArg);
    const runSql = accountId ? 'AND account_id = ?' : '';
    const runArg = accountId ? [accountId] : [];
    res.json({
      rows: rows.map((r) => {
        const running = db.prepare(`
          SELECT COUNT(*) AS n FROM aws_ec2_instances WHERE instance_type = ? AND state = 'running' ${runSql}
        `).get(r.instance_type, ...runArg).n || 0;
        return {
          instanceType: r.instance_type, totalUsd: r.total_usd || 0, runningCount: running,
          estPerInstanceUsd: running > 0 ? (r.total_usd || 0) / running : null,
        };
      }),
    });
  } catch (err) { next(err); }
});

/** GET /api/aws/s3/history?bucket=<name>&days=90&accountId= */
router.get('/s3/history', [
  query('bucket').isString().trim().notEmpty(),
  query('days').optional().isInt().toInt(),
  query('accountId').optional().isInt().toInt(),
], validate, (req, res, next) => {
  try {
    const days = Math.min(365, Math.max(7, req.query.days || 90));
    const accountId = req.query.accountId;
    const acctSql = accountId ? 'AND account_id = ?' : '';
    const acctArg = accountId ? [accountId] : [];
    const rows = db.prepare(`
      SELECT day, size_bytes, object_count FROM aws_s3_size_history
      WHERE bucket_name = ? AND day >= date('now', ?) ${acctSql}
      ORDER BY day ASC
    `).all(req.query.bucket, `-${days} days`, ...acctArg);
    res.json({ rows: rows.map((r) => ({ day: r.day, sizeBytes: r.size_bytes, objectCount: r.object_count })) });
  } catch (err) { next(err); }
});

/** GET /api/aws/rds/history?dbId=<id>&days=90 */
router.get('/rds/history', [
  query('dbId').isString().trim().notEmpty(),
  query('days').optional().isInt().toInt(),
], validate, (req, res, next) => {
  try {
    const days = Math.min(365, Math.max(7, req.query.days || 90));
    const rows = db.prepare(`
      SELECT day, free_storage_bytes, allocated_gb FROM aws_rds_storage_history
      WHERE db_id = ? AND day >= date('now', ?)
      ORDER BY day ASC
    `).all(req.query.dbId, `-${days} days`);
    res.json({ rows: rows.map((r) => ({ day: r.day, freeStorageBytes: r.free_storage_bytes, allocatedGb: r.allocated_gb })) });
  } catch (err) { next(err); }
});

/** GET /api/aws/trends — last 30 days of estate metrics snapshots. */
router.get('/trends', (req, res, next) => {
  try {
    const rows = db.prepare(`
      SELECT captured_at, ec2_running, ecs_degraded, s3_total_bytes, mtd_spend_usd
      FROM aws_metrics_history WHERE captured_at >= datetime('now', '-30 days')
      ORDER BY captured_at ASC
    `).all();
    res.json({
      rows: rows.map((r) => ({
        capturedAt: r.captured_at, ec2Running: r.ec2_running, ecsDegraded: r.ecs_degraded,
        s3TotalBytes: r.s3_total_bytes, mtdSpendUsd: r.mtd_spend_usd,
      })),
    });
  } catch (err) { next(err); }
});

/** GET /api/aws/rds — RDS instances across all accounts. */
router.get('/rds', (req, res, next) => {
  try {
    const rows = db.prepare(`
      SELECT r.*, a.name AS account_name FROM aws_rds_instances r
      JOIN aws_accounts a ON a.id = r.account_id ORDER BY a.name, r.db_id
    `).all();
    res.json({
      instances: rows.map((r) => ({
        dbId: r.db_id, engine: r.engine, engineVersion: r.engine_version, instanceClass: r.instance_class,
        status: r.status, multiAz: !!r.multi_az, allocatedGb: r.allocated_gb,
        freeStorageBytes: r.free_storage_bytes,
        freeStoragePct: r.allocated_gb ? (r.free_storage_bytes / (r.allocated_gb * 1073741824)) * 100 : null,
        cpuUtil: r.cpu_util, connections: r.connections, backupRetentionDays: r.backup_retention_days,
        latestBackupAt: r.latest_backup_at, endpoint: r.endpoint, account: r.account_name,
      })),
    });
  } catch (err) { next(err); }
});

/** GET /api/aws/lambda — Lambda functions across all accounts. */
router.get('/lambda', (req, res, next) => {
  try {
    const rows = db.prepare(`
      SELECT f.*, a.name AS account_name FROM aws_lambda_functions f
      JOIN aws_accounts a ON a.id = f.account_id ORDER BY a.name, f.name
    `).all();
    res.json({
      functions: rows.map((r) => ({
        name: r.name, runtime: r.runtime, memoryMb: r.memory_mb, timeoutS: r.timeout_s,
        codeSizeBytes: r.code_size_bytes, lastModified: r.last_modified,
        invocations24h: r.invocations_24h, errors24h: r.errors_24h, avgDurationMs: r.avg_duration_ms,
        account: r.account_name,
      })),
    });
  } catch (err) { next(err); }
});

/** GET /api/aws/dynamo — DynamoDB tables across all accounts. */
router.get('/dynamo', (req, res, next) => {
  try {
    const rows = db.prepare(`
      SELECT t.*, a.name AS account_name FROM aws_dynamo_tables t
      JOIN aws_accounts a ON a.id = t.account_id ORDER BY a.name, t.name
    `).all();
    res.json({
      tables: rows.map((r) => ({
        name: r.name, status: r.status, billingMode: r.billing_mode, itemCount: r.item_count,
        sizeBytes: r.size_bytes, readCapacity: r.read_capacity, writeCapacity: r.write_capacity,
        account: r.account_name,
      })),
    });
  } catch (err) { next(err); }
});

/** GET /api/aws/ecr — ECR repositories across all accounts. */
router.get('/ecr', (req, res, next) => {
  try {
    const rows = db.prepare(`
      SELECT r.*, a.name AS account_name FROM aws_ecr_repos r
      JOIN aws_accounts a ON a.id = r.account_id ORDER BY a.name, r.name
    `).all();
    res.json({
      repos: rows.map((r) => ({
        name: r.name, imageCount: r.image_count, sizeBytes: r.size_bytes,
        scanOnPush: !!r.scan_on_push, latestPushAt: r.latest_push_at, account: r.account_name,
      })),
    });
  } catch (err) { next(err); }
});

/** GET /api/aws/vpc — VPCs + subnets across all accounts. */
router.get('/vpc', (req, res, next) => {
  try {
    const vpcRows = db.prepare(`
      SELECT v.*, a.name AS account_name FROM aws_vpcs v
      JOIN aws_accounts a ON a.id = v.account_id ORDER BY a.name, v.vpc_id
    `).all();
    const subnetRows = db.prepare(`
      SELECT s.*, a.name AS account_name FROM aws_subnets s
      JOIN aws_accounts a ON a.id = s.account_id ORDER BY a.name, s.subnet_id
    `).all();
    res.json({
      vpcs: vpcRows.map((r) => ({
        vpcId: r.vpc_id, name: r.name, cidr: r.cidr, state: r.state, isDefault: !!r.is_default,
        subnetCount: r.subnet_count, natGatewayCount: r.nat_gateway_count,
        securityGroupCount: r.security_group_count, igw: !!r.igw, account: r.account_name,
      })),
      subnets: subnetRows.map((r) => ({
        subnetId: r.subnet_id, vpcId: r.vpc_id, name: r.name, cidr: r.cidr, az: r.az,
        availableIps: r.available_ips, public: !!r.public, account: r.account_name,
      })),
    });
  } catch (err) { next(err); }
});

/** GET /api/aws/optimizer?accountId= — Compute Optimizer + heuristic recommendations, savings desc. */
router.get('/optimizer', [query('accountId').optional().isInt().toInt()], validate, (req, res, next) => {
  try {
    const accountId = req.query.accountId;
    const acctSql = accountId ? 'AND o.account_id = ?' : '';
    const acctArg = accountId ? [accountId] : [];
    const rows = db.prepare(`
      SELECT o.*, a.name AS account_name FROM aws_optimizer_recommendations o
      JOIN aws_accounts a ON a.id = o.account_id
      WHERE 1=1 ${acctSql}
      ORDER BY (o.est_monthly_savings_usd IS NULL) ASC, o.est_monthly_savings_usd DESC
    `).all(...acctArg);

    const accounts = db.prepare('SELECT * FROM aws_accounts').all();
    const electedRow = accounts.find((a) => isElected(a));

    const totalsRow = db.prepare(`
      SELECT COUNT(*) AS n, SUM(est_monthly_savings_usd) AS s FROM aws_optimizer_recommendations o
      WHERE 1=1 ${acctSql}
    `).get(...acctArg);
    const lastCaptureRow = accountId
      ? db.prepare('SELECT last_optimizer_capture_at AS c FROM aws_accounts WHERE id = ?').get(accountId)
      : db.prepare('SELECT MAX(last_optimizer_capture_at) AS c FROM aws_accounts').get();

    res.json({
      totals: {
        count: totalsRow.n || 0,
        estMonthlySavingsUsd: totalsRow.s || 0,
        coEnrollment: electedRow?.co_enrollment ?? null,
        lastCapture: lastCaptureRow?.c ?? null,
      },
      recommendations: rows.map((r) => ({
        source: r.source, resourceType: r.resource_type, resourceId: r.resource_id, resourceName: r.resource_name,
        region: r.region, finding: r.finding, currentConfig: r.current_config, recommendedConfig: r.recommended_config,
        reason: r.reason, estMonthlySavingsUsd: r.est_monthly_savings_usd, account: r.account_name,
      })),
    });
  } catch (err) { next(err); }
});

/** POST /api/aws/optimizer/refresh?accountId= — clear the daily gate + trigger a re-poll now. */
router.post('/optimizer/refresh', [query('accountId').optional().isInt().toInt()], validate, (req, res, next) => {
  try {
    const accountId = req.query.accountId;
    const rows = accountId
      ? db.prepare('SELECT * FROM aws_accounts WHERE id = ?').all(accountId)
      : db.prepare('SELECT * FROM aws_accounts').all();
    for (const row of rows) {
      db.prepare("UPDATE aws_accounts SET last_optimizer_capture_at = NULL WHERE id = ?").run(row.id);
      awsPoller.trigger(row).catch(() => {});
    }
    res.status(202).json({ ok: true });
  } catch (err) { next(err); }
});

// ── AI Advisor ───────────────────────────────────────────────────────────────

function advisorReportKey(slug) {
  return String(slug).replace(/-/g, '_');
}

/** GET /api/aws/advisor/:report — cached AWS FinOps AI Advisor report. */
router.get('/advisor/:report', [param('report').isString()], validate, (req, res, next) => {
  try {
    const key = advisorReportKey(req.params.report);
    if (!awsAdvisor.REPORTS.includes(key)) return res.status(404).json({ error: 'Unknown report.' });
    res.json({ enabled: awsAdvisor.isConfigured(), report: awsAdvisor.getCachedReport(key) });
  } catch (err) { next(err); }
});

/** POST /api/aws/advisor/:report — (re)generate and cache an AWS FinOps AI Advisor report. */
router.post('/advisor/:report', [param('report').isString()], validate, async (req, res, next) => {
  try {
    const key = advisorReportKey(req.params.report);
    if (!awsAdvisor.REPORTS.includes(key)) return res.status(404).json({ error: 'Unknown report.' });
    const result = await awsAdvisor.generateReport(key);
    res.json(result);
  } catch (err) {
    if (err.code === 'LLM_NOT_CONFIGURED') {
      return res.status(503).json({ error: 'AI analysis is not configured. Add an OpenAI or GitHub Models token under Settings → Credentials.' });
    }
    if (err.code === 'LLM_RATE_LIMITED') {
      if (err.retryAfter) res.set('Retry-After', String(err.retryAfter));
      return res.status(429).json({ error: err.message, retryAfter: err.retryAfter });
    }
    if (err.code === 'LLM_REQUEST_FAILED' || err.code === 'LLM_EMPTY') {
      return res.status(502).json({ error: err.message });
    }
    next(err);
  }
});

module.exports = router;
