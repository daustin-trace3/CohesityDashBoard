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
const { awsPoller } = require('../services/awsPoller');
const { costSpikePct, computeIssues } = require('../services/awsIssues');

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

const PROBE_SERVICES = ['ec2', 'ebs', 'lightsail', 'ecs', 's3', 'bedrock', 'cost'];

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
    res.json({ costSpikePct: costSpikePct() });
  } catch (err) { next(err); }
});

/** PUT /api/aws/config — save alert thresholds. */
router.put('/config', [
  body('costSpikePct').isInt({ min: 5, max: 500 }).toInt(),
], validate, (req, res, next) => {
  try {
    setSetting('aws_cost_spike_pct', String(req.body.costSpikePct));
    res.json({ costSpikePct: costSpikePct() });
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
router.get('/overview', (req, res, next) => {
  try {
    const accountCount = db.prepare('SELECT COUNT(*) AS n FROM aws_accounts').get().n;

    const ec2Agg = db.prepare(`
      SELECT COUNT(*) AS total,
        SUM(CASE WHEN state = 'running' THEN 1 ELSE 0 END) AS running,
        SUM(CASE WHEN state = 'stopped' THEN 1 ELSE 0 END) AS stopped,
        SUM(CASE WHEN state = 'running' AND status_check LIKE '%failed%' THEN 1 ELSE 0 END) AS alarmed
      FROM aws_ec2_instances
    `).get();

    const lsAgg = db.prepare(`
      SELECT COUNT(*) AS total, SUM(CASE WHEN state = 'running' THEN 1 ELSE 0 END) AS running
      FROM aws_lightsail_instances
    `).get();

    const ecsAgg = db.prepare('SELECT COUNT(*) AS clusters FROM aws_ecs_clusters').get();
    const svcAgg = db.prepare(`
      SELECT COUNT(*) AS services,
        SUM(CASE WHEN status = 'ACTIVE' AND running_count < desired_count THEN 1 ELSE 0 END) AS degraded
      FROM aws_ecs_services
    `).get();

    const s3Agg = db.prepare(`
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
      FROM aws_bedrock_usage WHERE day >= date('now', '-30 days')
    `).get();

    const issues = computeIssues();
    const issueCounts = { critical: 0, warning: 0, info: 0 };
    for (const i of issues) issueCounts[i.severity] = (issueCounts[i.severity] || 0) + 1;

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

/** GET /api/aws/costs?days=30 */
router.get('/costs', [query('days').optional().isInt().toInt()], validate, (req, res, next) => {
  try {
    const days = Math.min(90, Math.max(7, req.query.days || 30));
    const rows = db.prepare(`
      SELECT day, service, amount_usd FROM aws_cost_daily
      WHERE day >= date('now', ?) ORDER BY day ASC
    `).all(`-${days} days`);
    const byDay = new Map();
    for (const r of rows) {
      if (!byDay.has(r.day)) byDay.set(r.day, { day: r.day, totalUsd: 0, services: [] });
      const d = byDay.get(r.day);
      d.totalUsd += r.amount_usd || 0;
      d.services.push({ service: r.service, amountUsd: r.amount_usd || 0 });
    }
    const monthStart = `${new Date().toISOString().slice(0, 7)}-01`;
    const mtdRows = db.prepare('SELECT SUM(amount_usd) AS s FROM aws_cost_daily WHERE day >= ?').get(monthStart);
    const mtdUsd = mtdRows.s || 0;
    const yesterday = new Date(Date.now() - 86400000).toISOString().slice(0, 10);
    const dayBefore = new Date(Date.now() - 2 * 86400000).toISOString().slice(0, 10);
    const yTotal = db.prepare('SELECT SUM(amount_usd) AS s FROM aws_cost_daily WHERE day = ?').get(yesterday).s || 0;
    const dbTotal = db.prepare('SELECT SUM(amount_usd) AS s FROM aws_cost_daily WHERE day = ?').get(dayBefore).s || 0;
    const deltaPct = dbTotal > 0 ? ((yTotal - dbTotal) / dbTotal) * 100 : null;
    const byServiceMap = new Map();
    for (const r of db.prepare('SELECT service, SUM(amount_usd) AS mtdUsd FROM aws_cost_daily WHERE day >= ? GROUP BY service')
      .all(monthStart)) {
      byServiceMap.set(r.service, r.mtdUsd || 0);
    }
    res.json({
      days: [...byDay.values()],
      mtdUsd, deltaPct,
      byService: [...byServiceMap.entries()].map(([service, mtdUsd]) => ({ service, mtdUsd })).sort((a, b) => b.mtdUsd - a.mtdUsd),
    });
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

module.exports = router;
