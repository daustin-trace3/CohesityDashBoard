// AWS routes. Mounted by the plugin dispatcher at /api/aws — paths are
// relative. Registration CRUD stores secretAccessKey AES-encrypted;
// access_key_id is plaintext (shown in UI). A row with blank creds falls
// back to server .env (AWS_ACCESS_KEY_ID/AWS_SECRET_ACCESS_KEY) — credSource
// reports which. All responses are camelCase.
const express = require('express');
const { body, param, query, validationResult } = require('express-validator');
const db = require('../db/database');
const { encrypt, decrypt } = require('../services/encryption');
const { setSetting, getSetting } = require('../services/settings');
const awsApi = require('../services/awsApi');
const { awsPoller, getHealthLastCheckedAt, HEALTH_SERVICES, isElected } = require('../services/awsPoller');
const { costSpikePct, rdsStorageWarnPct, computeIssues } = require('../services/awsIssues');
const awsAdvisor = require('../services/advisors/awsAdvisor');
const awsFinops = require('../services/awsFinops');
const { parseDateRange, rangeResponse } = require('../utils/dateRange');
const { sendCsv } = require('../utils/csv');
const { recordSnapshot } = require('../services/configLedger');
const { serviceNotes, lightsailComponent, resolveCostResource, usageTypeObjects } = require('../services/awsCostNotes');

const router = express.Router();

const validate = (req, res, next) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) return res.status(400).json({ error: 'Invalid parameters', details: errors.array() });
  next();
};

const round2 = (v) => (v == null || !Number.isFinite(Number(v)) ? null : Math.round(Number(v) * 100) / 100);

// Round 2: inventory tags and the local per-resource cost estimate. awsCostEstimate is required lazily so
// the routes load (and the inventory pages answer) even when the estimate module is not present.
const parseTags = (text) => {
  if (!text) return {};
  try { const v = JSON.parse(text); return v && typeof v === 'object' && !Array.isArray(v) ? v : {}; } catch { return {}; }
};
const utcDayStr = (offsetDays = 0) => new Date(Date.now() - offsetDays * 86400000).toISOString().slice(0, 10);
function loadCostEstimate() {
  try { return require('../services/awsCostEstimate'); } catch { return null; }
}
/** resource id -> estimate entry (30 day window, amortized); empty when the module or data is absent. */
function monthlyEstimates(kind, ids) {
  const mod = loadCostEstimate();
  if (!mod || typeof mod.estimateForResources !== 'function' || !ids.length) return new Map();
  try {
    return mod.estimateForResources(kind, ids, { fromDay: utcDayStr(29), toDay: utcDayStr(0), metric: 'amortized' }) || new Map();
  } catch { return new Map(); }
}
const estMonthly = (map, id) => {
  const e = map.get(id);
  return e && e.estMonthlyUsd != null ? round2(e.estMonthlyUsd) : null;
};

// Cost metric: unblended stays the default for the Cost Explorer routes (output unchanged when the
// param is omitted); amortized falls back to the unblended figure for rows captured before v11.
const costMetric = (req) => (req.query.metric === 'amortized' ? 'amortized' : 'unblended');
const amountExpr = (metric) => (metric === 'amortized' ? 'COALESCE(amortized_usd, amount_usd)' : 'amount_usd');
function amortizedFrom() {
  try { return db.prepare('SELECT MIN(day) AS d FROM aws_cost_daily WHERE amortized_usd IS NOT NULL').get().d || null; } catch { return null; }
}
const METRIC_VALIDATOR = query('metric').optional().isIn(['amortized', 'unblended']);

const publicAccount = (row) => ({
  id: row.id, name: row.name, accessKeyId: row.access_key_id, region: row.region, accountNumber: row.account_number || null,
  pollingIntervalMinutes: row.polling_interval_minutes,
  lastPollStatus: row.last_poll_status, lastPollError: row.last_poll_error, lastPollAt: row.last_poll_at,
  costResourcesStatus: row.cost_resources_status || null, costResourcesError: row.cost_resources_error || null,
  ...awsApi.credentialSummary(row),
});

const AUTH_MODES = ['key', 'role', 'profile'];
const ROLE_ARN_RE = /^arn:aws[a-z-]*:iam::\d{12}:role\/[\w+=,.@/-]+$/;
const SESSION_NAME_RE = /^[\w+=,.@-]{2,64}$/;

// Credential fields shared by register, update and test. Blank strings clear
// (session token, external ID, expiry); undefined leaves the stored value.
const credentialValidators = [
  body('authMode').optional().isIn(AUTH_MODES),
  body('accessKeyId').optional({ nullable: true }).isString().trim().isLength({ max: 128 }),
  body('secretAccessKey').optional({ nullable: true }).isString().isLength({ max: 256 }),
  body('sessionToken').optional({ nullable: true }).isString().isLength({ max: 4096 }),
  body('credentialExpiresAt').optional({ nullable: true }).custom((v) => v === '' || v == null || Number.isFinite(Date.parse(v)))
    .withMessage('credentialExpiresAt must be an ISO 8601 date'),
  body('roleArn').optional({ nullable: true }).custom((v) => v === '' || v == null || ROLE_ARN_RE.test(String(v).trim()))
    .withMessage('roleArn must look like arn:aws:iam::123456789012:role/Name'),
  body('externalId').optional({ nullable: true }).isString().isLength({ max: 1224 }),
  body('roleSessionName').optional({ nullable: true }).custom((v) => v === '' || v == null || SESSION_NAME_RE.test(String(v).trim()))
    .withMessage('roleSessionName: 2 to 64 characters from A-Z a-z 0-9 + = , . @ _ -'),
  body('profileName').optional({ nullable: true }).isString().trim().isLength({ max: 64 }),
  body('clearSecret').optional().isBoolean(),
];

// The stored secret blob after applying a request body to an existing row.
function nextSecretBlob(b, row) {
  if (b.clearSecret) return null;
  let current = null;
  if (row?.encrypted_credentials) {
    try { current = JSON.parse(decrypt(row.encrypted_credentials)); } catch { current = null; }
  }
  if (!b.secretAccessKey && b.sessionToken === undefined) return row?.encrypted_credentials || null;
  const blob = { secretAccessKey: b.secretAccessKey || current?.secretAccessKey || null };
  if (!blob.secretAccessKey) return null;
  // A fresh secret without a token drops the old token (a new long-lived key).
  const token = b.sessionToken !== undefined ? (b.sessionToken || null) : (b.secretAccessKey ? null : current?.sessionToken || null);
  if (token) blob.sessionToken = token;
  return encrypt(JSON.stringify(blob));
}

const nextExternalId = (b, row) => (b.externalId === undefined ? (row?.encrypted_external_id || null) : (b.externalId ? encrypt(b.externalId) : null));
const nextExpiry = (b, row) => (b.credentialExpiresAt === undefined ? (row?.credential_expires_at || null)
  : (b.credentialExpiresAt ? new Date(b.credentialExpiresAt).toISOString() : null));
const trimOr = (v, fallback) => (v === undefined ? fallback : (v && String(v).trim()) || null);

// ── Accounts CRUD ────────────────────────────────────────────────────────────

/**
 * GET /api/aws/network-circuits - LogicMonitor Direct Connect rows whose system.aws.ownerAccount equals
 * one of the registered accounts' numbers. 404 when LogicMonitor is not installed. Literal path, kept
 * ahead of every :id route.
 */
router.get('/network-circuits', (req, res, next) => {
  try {
    let cloudMod;
    let issuesMod;
    try {
      cloudMod = require('../services/logicmonitorCloud');
      issuesMod = require('../services/logicmonitorIssues');
    } catch { return res.status(404).json({ error: 'LogicMonitor is not available' }); }
    const numbers = new Set(db.prepare("SELECT account_number FROM aws_accounts WHERE account_number IS NOT NULL AND account_number <> ''").all().map((r) => String(r.account_number)));
    let rows = [];
    try { rows = cloudMod.cloudCircuits(db, issuesMod.getThresholds(), {}); } catch { rows = []; }
    res.json(rows.filter((r) => r.ownerAccount && numbers.has(String(r.ownerAccount))));
  } catch (err) { next(err); }
});

/** GET /api/aws/accounts — registered accounts (never the secret). */
router.get('/accounts', (req, res, next) => {
  try {
    res.json(db.prepare('SELECT * FROM aws_accounts ORDER BY name').all().map(publicAccount));
  } catch (err) { next(err); }
});

/** POST /api/aws/accounts — register an account; creds optional (env mode). */
router.post('/accounts', [
  body('name').isString().trim().notEmpty().isLength({ max: 120 }),
  ...credentialValidators,
  body('region').optional().isString().trim().isLength({ max: 32 }),
  body('pollingIntervalMinutes').optional().isInt({ min: 5, max: 1440 }).toInt(),
], validate, (req, res, next) => {
  try {
    const { name } = req.body;
    const b = req.body;
    const dup = db.prepare('SELECT id FROM aws_accounts WHERE name = ?').get(name.trim());
    if (dup) return res.status(409).json({ error: 'duplicate' });
    const mode = b.authMode || 'key';
    if (mode === 'role' && !b.roleArn) return res.status(400).json({ error: 'roleArn is required for the assume-role mode.' });
    if (mode === 'profile' && !b.profileName) return res.status(400).json({ error: 'profileName is required for the profile mode.' });
    const info = db.prepare(`
      INSERT INTO aws_accounts (name, access_key_id, encrypted_credentials, region, polling_interval_minutes,
        auth_mode, role_arn, encrypted_external_id, role_session_name, profile_name, credential_expires_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(name.trim(), trimOr(b.accessKeyId, null), nextSecretBlob(b, null), b.region?.trim() || 'us-east-2',
      b.pollingIntervalMinutes || 10,
      mode, trimOr(b.roleArn, null), nextExternalId(b, null), trimOr(b.roleSessionName, null), trimOr(b.profileName, null), nextExpiry(b, null));
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
  ...credentialValidators,
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
    const mode = b.authMode || row.auth_mode || 'key';
    const roleArn = trimOr(b.roleArn, row.role_arn);
    const profileName = trimOr(b.profileName, row.profile_name);
    if (mode === 'role' && !roleArn) return res.status(400).json({ error: 'roleArn is required for the assume-role mode.' });
    if (mode === 'profile' && !profileName) return res.status(400).json({ error: 'profileName is required for the profile mode.' });
    db.prepare(`
      UPDATE aws_accounts SET
        name = ?, access_key_id = ?, encrypted_credentials = ?, region = ?,
        polling_interval_minutes = ?, auth_mode = ?, role_arn = ?, encrypted_external_id = ?,
        role_session_name = ?, profile_name = ?, credential_expires_at = ?, updated_at = datetime('now')
      WHERE id = ?
    `).run(
      b.name?.trim() || row.name,
      trimOr(b.accessKeyId, row.access_key_id),
      nextSecretBlob(b, row),
      b.region?.trim() || row.region,
      b.pollingIntervalMinutes || row.polling_interval_minutes,
      mode, roleArn, nextExternalId(b, row), trimOr(b.roleSessionName, row.role_session_name), profileName, nextExpiry(b, row),
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
  ...credentialValidators,
  body('region').optional().isString(),
], validate, async (req, res) => {
  const b = req.body;
  // Fields typed into the form override the saved row; a saved row is tested
  // as stored when nothing is typed (the secret never leaves the server).
  const typed = {};
  for (const k of ['authMode', 'accessKeyId', 'secretAccessKey', 'sessionToken', 'credentialExpiresAt', 'roleArn', 'externalId', 'roleSessionName', 'profileName']) {
    if (b[k] !== undefined && b[k] !== null && b[k] !== '') typed[k] = b[k];
  }
  let candidate;
  if (b.id) {
    const row = db.prepare('SELECT * FROM aws_accounts WHERE id = ?').get(b.id);
    if (!row) return res.status(404).json({ error: 'Account not found.' });
    candidate = { ...row, ...typed };
    if (b.region) candidate.region = b.region;
  } else {
    candidate = { authMode: 'key', region: b.region || 'us-east-2', ...typed };
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

const PROBE_SERVICES = ['ec2', 'ebs', 'lightsail', 'ecs', 's3', 'bedrock', 'cost', 'rds', 'lambda', 'dynamo', 'ecr', 'vpc', 'optimizer', 'finops'];

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

const ymd = (ms) => new Date(ms).toISOString().slice(0, 10);

/** Raw FinOps probe: runs every Cost Explorer fetcher once and reports ok / status plus a truncated sample. */
async function probeFinops(row) {
  const now = Date.now();
  const win = { start: ymd(now - 35 * 86400000), end: ymd(now) };
  const monthEnd = new Date(Date.UTC(new Date(now).getUTCFullYear(), new Date(now).getUTCMonth() + 1, 1));
  const tagKey = finopsConfig().finopsTagKeys[0] || null;
  const steps = {
    tag_keys: () => awsApi.fetchCostAllocationTags(row),
    cost_tags: tagKey
      ? () => awsApi.fetchCostAndUsageGrouped(row, { ...win, groupBy: [{ Type: 'TAG', Key: tagKey }, { Type: 'DIMENSION', Key: 'SERVICE' }] })
      : null,
    linked_accounts: () => awsApi.fetchLinkedAccountValues(row),
    forecast: () => awsApi.fetchCostForecast(row, {
      metric: finopsConfig().finopsMetric === 'unblended' ? 'UNBLENDED_COST' : 'AMORTIZED_COST',
      start: ymd(now + 86400000), end: ymd(monthEnd.getTime()),
    }),
    sp_utilization: async () => ({
      utilization: await awsApi.fetchSavingsPlansUtilization(row, win),
      details: await awsApi.fetchSavingsPlansUtilizationDetails(row, win),
    }),
    sp_coverage: () => awsApi.fetchSavingsPlansCoverage(row, win),
    ri_utilization: () => awsApi.fetchReservationUtilization(row, win),
    ri_coverage: () => awsApi.fetchReservationCoverage(row, win),
    anomalies: async () => ({
      monitors: await awsApi.fetchAnomalyMonitors(row),
      anomalies: await awsApi.fetchAnomalies(row, win),
    }),
    rightsizing: () => awsApi.fetchRightsizingRecommendations(row),
    sp_recommendation: () => awsApi.fetchSavingsPlansPurchaseRecommendation(row),
    // Round 2 feeds (comparison, savings plans, budgets, hub, pricing, idle, rds); each step resolves { result, raw }.
    ...(awsApi.finopsExtraProbeSteps ? awsApi.finopsExtraProbeSteps(row, { now }) : {}),
  };
  const out = {};
  for (const [id, fn] of Object.entries(steps)) {
    if (!fn) { out[id] = { ok: false, status: 'skipped', error: 'No cost allocation tag key is configured.' }; continue; }
    try {
      let r = await fn();
      if (r && typeof r === 'object' && !Array.isArray(r) && 'raw' in r && 'result' in r) r = r.raw ?? r.result;
      const pick = (x) => (Array.isArray(x) ? x : (x && Array.isArray(x.rows) ? x.rows : x));
      const sample = (r && !Array.isArray(r) && !Array.isArray(r.rows) && typeof r === 'object')
        ? Object.fromEntries(Object.entries(r).map(([k, v]) => [k, truncate(pick(v))]))
        : truncate(pick(r));
      out[id] = { ok: true, status: 'ok', sample };
    } catch (err) {
      let status = 'error';
      try {
        const c = awsApi.classifyCeError ? awsApi.classifyCeError(err) : null;
        status = (typeof c === 'string' ? c : c && c.status) || 'error';
      } catch { status = 'error'; }
      out[id] = { ok: false, status, error: String(err?.message || err).slice(0, 500) };
    }
  }
  return out;
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
      case 'finops': {
        // One raw page per Cost Explorer capability; never stamps or stores anything.
        return res.json({ service, raw: await probeFinops(row) });
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
const costResourcesConfig = () => ({
  costResourcesEnabled: getSetting('aws_cost_resources_enabled') !== '0',
  costResourcesMaxPages: Math.min(50, Math.max(1, parseInt(getSetting('aws_cost_resources_max_pages'), 10) || 10)),
});

const intSetting = (key, min, max, def) => {
  const n = parseInt(getSetting(key), 10);
  return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : def;
};
const floatSetting = (key, min, max, def) => {
  const n = parseFloat(getSetting(key));
  return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : def;
};
const settingList = (key) => {
  try {
    const v = JSON.parse(getSetting(key) || '[]');
    return Array.isArray(v) ? v.map(String) : [];
  } catch { return []; }
};

/** FinOps settings as camelCase, parsed and clamped (same keys the contract lists for /config). */
function finopsConfig() {
  const linked = getSetting('aws_finops_linked_accounts');
  return {
    finopsMetric: getSetting('aws_finops_metric') === 'unblended' ? 'unblended' : 'amortized',
    finopsTagKeys: settingList('aws_finops_tag_keys'),
    finopsLinkedAccounts: ['auto', 'on', 'off'].includes(linked) ? linked : 'auto',
    anomalyPct: intSetting('aws_finops_anomaly_pct', 5, 500, 30),
    anomalyFloorUsd: floatSetting('aws_finops_anomaly_floor_usd', 0, 100000, 5),
    anomalyBaselineDays: intSetting('aws_finops_anomaly_baseline_days', 3, 30, 7),
    anomalyClearDays: intSetting('aws_finops_anomaly_clear_days', 1, 14, 2),
    spUtilWarnPct: intSetting('aws_finops_sp_util_warn_pct', 1, 100, 80),
    spExpiryWarnDays: intSetting('aws_finops_sp_expiry_warn_days', 1, 365, 30),
    priceGp2ToGp3PerGb: floatSetting('aws_price_gp2_to_gp3_per_gb', 0, 10, 0.02),
    priceEbsGp2PerGb: floatSetting('aws_price_ebs_gp2_per_gb', 0, 10, 0.10),
    priceEbsGp3PerGb: floatSetting('aws_price_ebs_gp3_per_gb', 0, 10, 0.08),
    priceNatGatewayMonth: floatSetting('aws_price_nat_gateway_month', 0, 1000, 32.85),
    finopsDigestEnabled: getSetting('aws_finops_digest_enabled') === '1',
    finopsDigestRecipients: getSetting('aws_finops_digest_recipients') || '',
    finopsDigestWeekday: intSetting('aws_finops_digest_weekday', 1, 7, 1),
    tagKeysSeen: settingList('aws_finops_tag_keys_seen'),
    priceRefreshDays: intSetting('aws_price_refresh_days', 1, 90, 7),
    rightsizeCpuMaxPct: intSetting('aws_rightsize_cpu_max_pct', 1, 100, 10),
    rightsizeMinDays: intSetting('aws_rightsize_min_days', 1, 30, 7),
    comparisonEnabled: getSetting('aws_finops_comparison_enabled') !== '0',
    costCategoriesMax: intSetting('aws_finops_cost_categories_max', 0, 20, 5),
    estimateWindowDays: intSetting('aws_estimate_window_days', 7, 90, 35),
  };
}

const fullConfig = () => ({ costSpikePct: costSpikePct(), rdsStorageWarnPct: rdsStorageWarnPct(), ...costResourcesConfig(), ...finopsConfig() });

router.get('/config', (req, res, next) => {
  try {
    res.json(fullConfig());
  } catch (err) { next(err); }
});

// Body key -> [setting key, serializer]. Every FinOps key is optional on PUT.
const FINOPS_PUT = {
  finopsMetric: ['aws_finops_metric', String],
  finopsLinkedAccounts: ['aws_finops_linked_accounts', String],
  anomalyPct: ['aws_finops_anomaly_pct', String],
  anomalyFloorUsd: ['aws_finops_anomaly_floor_usd', String],
  anomalyBaselineDays: ['aws_finops_anomaly_baseline_days', String],
  anomalyClearDays: ['aws_finops_anomaly_clear_days', String],
  spUtilWarnPct: ['aws_finops_sp_util_warn_pct', String],
  spExpiryWarnDays: ['aws_finops_sp_expiry_warn_days', String],
  priceGp2ToGp3PerGb: ['aws_price_gp2_to_gp3_per_gb', String],
  priceEbsGp2PerGb: ['aws_price_ebs_gp2_per_gb', String],
  priceEbsGp3PerGb: ['aws_price_ebs_gp3_per_gb', String],
  priceNatGatewayMonth: ['aws_price_nat_gateway_month', String],
  finopsDigestEnabled: ['aws_finops_digest_enabled', (v) => (v ? '1' : '0')],
  finopsDigestRecipients: ['aws_finops_digest_recipients', (v) => String(v).trim()],
  finopsDigestWeekday: ['aws_finops_digest_weekday', String],
  priceRefreshDays: ['aws_price_refresh_days', String],
  rightsizeCpuMaxPct: ['aws_rightsize_cpu_max_pct', String],
  rightsizeMinDays: ['aws_rightsize_min_days', String],
  comparisonEnabled: ['aws_finops_comparison_enabled', (v) => (v ? '1' : '0')],
  costCategoriesMax: ['aws_finops_cost_categories_max', String],
  estimateWindowDays: ['aws_estimate_window_days', String],
};

/** PUT /api/aws/config — save alert thresholds. */
router.put('/config', [
  body('costSpikePct').isInt({ min: 5, max: 500 }).toInt(),
  body('rdsStorageWarnPct').optional().isInt({ min: 5, max: 50 }).toInt(),
  body('costResourcesEnabled').optional().isBoolean().toBoolean(),
  body('costResourcesMaxPages').optional().isInt({ min: 1, max: 50 }).toInt(),
  body('finopsMetric').optional().isIn(['amortized', 'unblended']),
  body('finopsTagKeys').optional().isArray({ max: 10 }),
  body('finopsTagKeys.*').isString().trim().isLength({ min: 1, max: 128 }),
  body('finopsLinkedAccounts').optional().isIn(['auto', 'on', 'off']),
  body('anomalyPct').optional().isInt({ min: 5, max: 500 }).toInt(),
  body('anomalyFloorUsd').optional().isFloat({ min: 0, max: 100000 }).toFloat(),
  body('anomalyBaselineDays').optional().isInt({ min: 3, max: 30 }).toInt(),
  body('anomalyClearDays').optional().isInt({ min: 1, max: 14 }).toInt(),
  body('spUtilWarnPct').optional().isInt({ min: 1, max: 100 }).toInt(),
  body('spExpiryWarnDays').optional().isInt({ min: 1, max: 365 }).toInt(),
  body('priceGp2ToGp3PerGb').optional().isFloat({ min: 0, max: 10 }).toFloat(),
  body('priceEbsGp2PerGb').optional().isFloat({ min: 0, max: 10 }).toFloat(),
  body('priceEbsGp3PerGb').optional().isFloat({ min: 0, max: 10 }).toFloat(),
  body('priceNatGatewayMonth').optional().isFloat({ min: 0, max: 1000 }).toFloat(),
  body('finopsDigestEnabled').optional().isBoolean().toBoolean(),
  body('finopsDigestRecipients').optional().isString().isLength({ max: 1000 }),
  body('finopsDigestWeekday').optional().isInt({ min: 1, max: 7 }).toInt(),
  body('priceRefreshDays').optional().isInt({ min: 1, max: 90 }).toInt(),
  body('rightsizeCpuMaxPct').optional().isInt({ min: 1, max: 100 }).toInt(),
  body('rightsizeMinDays').optional().isInt({ min: 1, max: 30 }).toInt(),
  body('comparisonEnabled').optional().isBoolean().toBoolean(),
  body('costCategoriesMax').optional().isInt({ min: 0, max: 20 }).toInt(),
  body('estimateWindowDays').optional().isInt({ min: 7, max: 90 }).toInt(),
], validate, (req, res, next) => {
  try {
    setSetting('aws_cost_spike_pct', String(req.body.costSpikePct));
    if (req.body.rdsStorageWarnPct !== undefined) setSetting('aws_rds_storage_warn_pct', String(req.body.rdsStorageWarnPct));
    if (req.body.costResourcesEnabled !== undefined) setSetting('aws_cost_resources_enabled', req.body.costResourcesEnabled ? '1' : '0');
    if (req.body.costResourcesMaxPages !== undefined) setSetting('aws_cost_resources_max_pages', String(req.body.costResourcesMaxPages));
    for (const [field, [key, ser]] of Object.entries(FINOPS_PUT)) {
      if (req.body[field] !== undefined) setSetting(key, ser(req.body[field]));
    }
    if (req.body.finopsTagKeys !== undefined) {
      const keys = [...new Set(req.body.finopsTagKeys.map((k) => String(k).trim()).filter(Boolean))];
      setSetting('aws_finops_tag_keys', JSON.stringify(keys));
    }
    res.json(fullConfig());
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

const monthBounds = (now = new Date()) => {
  const y = now.getUTCFullYear();
  const m = now.getUTCMonth();
  return { start: ymd(Date.UTC(y, m, 1)), next: ymd(Date.UTC(y, m + 1, 1)), month: ymd(Date.UTC(y, m, 1)).slice(0, 7) };
};

/** Newest stored forecast for the current month and scope; the metric column is matched loosely. */
function latestForecast(metric, scope = 'total') {
  try {
    const b = monthBounds();
    return db.prepare(`
      SELECT * FROM aws_cost_forecast
      WHERE scope = ? AND LOWER(metric) LIKE ? AND period_start >= ? AND period_start < ?
      ORDER BY generated_on DESC, id DESC LIMIT 1
    `).get(scope, `${metric}%`, b.start, b.next) || null;
  } catch { return null; }
}

/** Additive FinOps keys on GET /overview cost; null-safe on a db without the v11 tables. */
function overviewFinopsExtras() {
  const out = { forecastUsd: null, forecastSource: null, openAnomalies: 0, budgetState: { worst: null, count: 0 } };
  try {
    const fc = latestForecast(finopsConfig().finopsMetric);
    if (fc && fc.mean_usd != null) { out.forecastUsd = round2(fc.mean_usd); out.forecastSource = fc.source; }
  } catch { /* ignore */ }
  try {
    out.openAnomalies = db.prepare("SELECT COUNT(*) AS n FROM aws_cost_anomalies WHERE status = 'open' AND superseded_by IS NULL").get().n || 0;
  } catch { /* ignore */ }
  try {
    const states = db.prepare(`
      SELECT s.state FROM aws_budgets b LEFT JOIN aws_budget_status s ON s.budget_id = b.id AND s.month = ?
      WHERE b.enabled = 1
    `).all(monthBounds().month);
    if (states.length) {
      const have = states.map((r) => r.state).filter(Boolean);
      out.budgetState = {
        worst: have.includes('crit') ? 'crit' : (have.includes('warn') ? 'warn' : (have.length ? 'ok' : null)),
        count: states.length,
      };
    }
  } catch { /* ignore */ }
  return out;
}

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

    const lsCount = (table) => db.prepare(`SELECT COUNT(*) AS n FROM ${table}${W}`).get(...args).n || 0;
    const lsExtra = {
      databases: lsCount('aws_lightsail_databases'),
      disks: lsCount('aws_lightsail_disks'),
      buckets: lsCount('aws_lightsail_buckets'),
    };

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
      lightsail: { total: lsAgg.total || 0, running: lsAgg.running || 0, ...lsExtra },
      ecs: { clusters: ecsAgg.clusters || 0, services: svcAgg.services || 0, degraded: svcAgg.degraded || 0 },
      s3: { buckets: s3Agg.buckets || 0, totalSizeBytes: s3Agg.totalSizeBytes || 0, totalObjects: s3Agg.totalObjects || 0 },
      cost: {
        mtdUsd, prevDayUsd, dayBeforeUsd, deltaPct,
        topServices: topServices.map((r) => ({ service: r.service, mtdUsd: r.mtdUsd })),
        ...overviewFinopsExtras(),
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
    const est = monthlyEstimates('ec2', rows.map((r) => r.instance_id));
    res.json({
      instances: rows.map((r) => ({
        id: r.id, instanceId: r.instance_id, name: r.name, state: r.state, instanceType: r.instance_type,
        az: r.az, privateIp: r.private_ip, publicIp: r.public_ip, platform: r.platform,
        launchTime: r.launch_time, cpuUtil: r.cpu_util, statusCheck: r.status_check, account: r.account_name,
        estMonthlyUsd: estMonthly(est, r.instance_id), tags: parseTags(r.tags_json),
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
    const est = monthlyEstimates('ebs', rows.map((r) => r.volume_id));
    res.json({
      volumes: rows.map((r) => ({
        volumeId: r.volume_id, state: r.state, sizeGb: r.size_gb, volumeType: r.volume_type,
        az: r.az, attachedInstanceId: r.attached_instance_id, account: r.account_name,
        estMonthlyUsd: estMonthly(est, r.volume_id), tags: parseTags(r.tags_json),
      })),
    });
  } catch (err) { next(err); }
});

/** GET /api/aws/lightsail — Lightsail instances across all accounts (?accountId= narrows). */
router.get('/lightsail', [query('accountId').optional().isInt().toInt()], validate, (req, res, next) => {
  try {
    const accountId = req.query.accountId;
    const rows = db.prepare(`
      SELECT i.*, a.name AS account_name FROM aws_lightsail_instances i
      JOIN aws_accounts a ON a.id = i.account_id
      ${accountId ? 'WHERE i.account_id = ?' : ''} ORDER BY a.name, i.name
    `).all(...(accountId ? [accountId] : []));
    const est = monthlyEstimates('lightsail', rows.map((r) => r.name));
    res.json({
      instances: rows.map((r) => ({
        name: r.name, state: r.state, blueprint: r.blueprint, bundle: r.bundle, az: r.az,
        publicIp: r.public_ip, cpuUtil: r.cpu_util, snapshotCount: r.snapshot_count,
        latestSnapshotAt: r.latest_snapshot_at, account: r.account_name,
        ramGb: r.ram_gb ?? null, cpuCount: r.cpu_count ?? null, isWindows: !!r.is_windows,
        arn: r.arn || null, privateIp: r.private_ip || null, createdAt: r.created_at || null,
        estMonthlyUsd: estMonthly(est, r.name), tags: parseTags(r.tags_json),
      })),
    });
  } catch (err) { next(err); }
});

const jsonList = (text) => {
  try { const v = JSON.parse(text || '[]'); return Array.isArray(v) ? v : []; } catch { return []; }
};

// Lightsail inventory families: table, response key, row mapper, order column.
const LIGHTSAIL_FAMILIES = [
  ['databases', 'aws_lightsail_databases', 'databases', (r) => ({
    name: r.name, arn: r.arn, engine: r.engine, engineVersion: r.engine_version, bundle: r.bundle,
    ramGb: r.ram_gb, diskGb: r.disk_gb, state: r.state, az: r.az, endpoint: r.master_endpoint,
    port: r.port, backupRetention: !!r.backup_retention, publiclyAccessible: !!r.publicly_accessible,
    latestRestorableAt: r.latest_restorable_at, createdAt: r.created_at, account: r.account_name,
  })],
  ['disks', 'aws_lightsail_disks', 'disks', (r) => ({
    name: r.name, arn: r.arn, sizeGb: r.size_gb, state: r.state, attachedTo: r.attached_to,
    attachmentState: r.attachment_state, isSystemDisk: !!r.is_system_disk, iops: r.iops, az: r.az,
    createdAt: r.created_at, account: r.account_name,
  })],
  ['buckets', 'aws_lightsail_buckets', 'buckets', (r) => ({
    name: r.name, arn: r.arn, bundle: r.bundle, state: r.state, objectVersioning: r.object_versioning,
    publicRead: !!r.read_only_access, ableToUpdateBundle: !!r.able_to_update_bundle, url: r.url,
    createdAt: r.created_at, account: r.account_name,
  })],
  ['load-balancers', 'aws_lightsail_load_balancers', 'loadBalancers', (r) => ({
    name: r.name, arn: r.arn, dnsName: r.dns_name, state: r.state, protocol: r.protocol,
    instancePort: r.instance_port, healthCheckPath: r.health_check_path,
    attachedInstances: jsonList(r.attached_instances), healthyCount: r.healthy_count ?? 0,
    unhealthyCount: r.unhealthy_count ?? 0, tlsCertName: r.tls_cert_name,
    tlsCertAttached: !!r.tls_cert_attached, az: r.az, createdAt: r.created_at, account: r.account_name,
  })],
  ['distributions', 'aws_lightsail_distributions', 'distributions', (r) => ({
    name: r.name, arn: r.arn, status: r.status, isEnabled: !!r.is_enabled, domainName: r.domain_name,
    originName: r.origin_name, originRegion: r.origin_region, bundle: r.bundle, certName: r.cert_name,
    alternativeDomains: jsonList(r.alternative_domains), createdAt: r.created_at, account: r.account_name,
  })],
  ['domains', 'aws_lightsail_domains', 'domains', (r) => ({
    name: r.name, arn: r.arn, entryCount: r.entry_count ?? 0, createdAt: r.created_at, account: r.account_name,
  })],
  ['static-ips', 'aws_lightsail_static_ips', 'staticIps', (r) => ({
    name: r.name, arn: r.arn, ipAddress: r.ip_address, isAttached: !!r.is_attached,
    attachedTo: r.attached_to, az: r.az, createdAt: r.created_at, account: r.account_name,
  })],
];

/** GET /api/aws/lightsail/summary — counts per family plus the things worth a look. */
router.get('/lightsail/summary', [query('accountId').optional().isInt().toInt()], validate, (req, res, next) => {
  try {
    const accountId = req.query.accountId;
    const W = accountId ? ' WHERE account_id = ?' : '';
    const A = accountId ? ' AND account_id = ?' : '';
    const args = accountId ? [accountId] : [];
    const n = (sql) => db.prepare(sql).get(...args).n || 0;
    res.json({
      instances: n(`SELECT COUNT(*) AS n FROM aws_lightsail_instances${W}`),
      instancesRunning: n(`SELECT COUNT(*) AS n FROM aws_lightsail_instances WHERE state = 'running'${A}`),
      databases: n(`SELECT COUNT(*) AS n FROM aws_lightsail_databases${W}`),
      disks: n(`SELECT COUNT(*) AS n FROM aws_lightsail_disks${W}`),
      buckets: n(`SELECT COUNT(*) AS n FROM aws_lightsail_buckets${W}`),
      loadBalancers: n(`SELECT COUNT(*) AS n FROM aws_lightsail_load_balancers${W}`),
      distributions: n(`SELECT COUNT(*) AS n FROM aws_lightsail_distributions${W}`),
      domains: n(`SELECT COUNT(*) AS n FROM aws_lightsail_domains${W}`),
      staticIps: n(`SELECT COUNT(*) AS n FROM aws_lightsail_static_ips${W}`),
      unattachedDisks: n(`SELECT COUNT(*) AS n FROM aws_lightsail_disks WHERE COALESCE(is_system_disk, 0) = 0 AND COALESCE(attachment_state, '') != 'attached'${A}`),
      unattachedStaticIps: n(`SELECT COUNT(*) AS n FROM aws_lightsail_static_ips WHERE COALESCE(is_attached, 0) = 0${A}`),
      publicBuckets: n(`SELECT COUNT(*) AS n FROM aws_lightsail_buckets WHERE read_only_access = 1${A}`),
      databasesWithoutBackups: n(`SELECT COUNT(*) AS n FROM aws_lightsail_databases WHERE COALESCE(backup_retention, 0) = 0${A}`),
      loadBalancersUnhealthy: n(`SELECT COUNT(*) AS n FROM aws_lightsail_load_balancers WHERE COALESCE(unhealthy_count, 0) > 0${A}`),
    });
  } catch (err) { next(err); }
});

for (const [path, table, key, mapRow] of LIGHTSAIL_FAMILIES) {
  /** GET /api/aws/lightsail/<family> — one Lightsail inventory family (?accountId= narrows). */
  router.get(`/lightsail/${path}`, [query('accountId').optional().isInt().toInt()], validate, (req, res, next) => {
    try {
      const accountId = req.query.accountId;
      const rows = db.prepare(`
        SELECT t.*, a.name AS account_name FROM ${table} t
        JOIN aws_accounts a ON a.id = t.account_id
        ${accountId ? 'WHERE t.account_id = ?' : ''} ORDER BY a.name, t.name
      `).all(...(accountId ? [accountId] : []));
      res.json({ [key]: rows.map(mapRow) });
    } catch (err) { next(err); }
  });
}

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
    const est = monthlyEstimates('s3', rows.map((r) => r.name));
    res.json({
      buckets: rows.map((r) => ({
        name: r.name, region: r.region, sizeBytes: r.size_bytes, objectCount: r.object_count,
        publicAccessBlocked: !!r.public_access_blocked, versioning: r.versioning,
        lifecycleRules: r.lifecycle_rules, createdAt: r.created_at_aws, account: r.account_name,
        estMonthlyUsd: estMonthly(est, r.name), tags: parseTags(r.tags_json),
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

/** Resource-level cost capture state for the Cost page: the ICC toggle plus per-account status. */
function costResourcesState(accountId) {
  const rows = db.prepare(`
    SELECT id, name, cost_resources_status, cost_resources_error FROM aws_accounts
    ${accountId ? 'WHERE id = ?' : ''} ORDER BY id
  `).all(...(accountId ? [accountId] : []));
  const enabled = getSetting('aws_cost_resources_enabled') !== '0';
  // Top-level status for the Cost page: ok only when every account reports ok; otherwise the first
  // non-ok account status (denied, not_enabled, error, ...), 'off' when the capture is switched off.
  const bad = rows.find((r) => r.cost_resources_status !== 'ok');
  const status = !enabled ? 'off' : (!rows.length ? 'unknown' : (bad ? (bad.cost_resources_status || 'unknown') : 'ok'));
  return {
    enabled, status, error: bad ? (bad.cost_resources_error || null) : null,
    accounts: rows.map((r) => ({
      accountId: r.id, name: r.name, status: r.cost_resources_status || null, error: r.cost_resources_error || null,
    })),
  };
}

/** GET /api/aws/costs?days=30&accountId=&month=YYYY-MM — accountId is an optional additive filter;
 * month overrides days and returns that closed month's series instead of the rolling window. */
router.get('/costs', [
  query('days').optional().isInt().toInt(),
  query('accountId').optional().isInt().toInt(),
  query('month').optional().matches(/^\d{4}-\d{2}$/),
  METRIC_VALIDATOR,
], validate, (req, res, next) => {
  try {
    const metric = costMetric(req);
    const AMT = amountExpr(metric);
    const days = Math.min(365, Math.max(7, req.query.days || 30));
    const accountId = req.query.accountId;
    const month = req.query.month;
    const acctSql = accountId ? 'AND account_id = ?' : '';
    const acctArg = accountId ? [accountId] : [];

    const months = db.prepare(`SELECT DISTINCT substr(day, 1, 7) AS m FROM aws_cost_daily ORDER BY m DESC`).all().map((r) => r.m);

    let rows, mtdUsd, deltaPct, byServiceMap;
    if (month) {
      rows = db.prepare(`
        SELECT day, service, ${AMT} AS amount_usd FROM aws_cost_daily
        WHERE substr(day, 1, 7) = ? ${acctSql} ORDER BY day ASC
      `).all(month, ...acctArg);
      mtdUsd = db.prepare(`SELECT SUM(${AMT}) AS s FROM aws_cost_daily WHERE substr(day, 1, 7) = ? ${acctSql}`)
        .get(month, ...acctArg).s || 0;
      deltaPct = null;
      byServiceMap = new Map();
      for (const r of db.prepare(`SELECT service, SUM(${AMT}) AS mtdUsd FROM aws_cost_daily WHERE substr(day, 1, 7) = ? ${acctSql} GROUP BY service`)
        .all(month, ...acctArg)) {
        byServiceMap.set(r.service, r.mtdUsd || 0);
      }
    } else {
      rows = db.prepare(`
        SELECT day, service, ${AMT} AS amount_usd FROM aws_cost_daily
        WHERE day >= date('now', ?) ${acctSql} ORDER BY day ASC
      `).all(`-${days} days`, ...acctArg);
      const monthStart = `${new Date().toISOString().slice(0, 7)}-01`;
      mtdUsd = db.prepare(`SELECT SUM(${AMT}) AS s FROM aws_cost_daily WHERE day >= ? ${acctSql}`).get(monthStart, ...acctArg).s || 0;
      const yesterday = new Date(Date.now() - 86400000).toISOString().slice(0, 10);
      const dayBefore = new Date(Date.now() - 2 * 86400000).toISOString().slice(0, 10);
      const yTotal = db.prepare(`SELECT SUM(${AMT}) AS s FROM aws_cost_daily WHERE day = ? ${acctSql}`).get(yesterday, ...acctArg).s || 0;
      const dbTotal = db.prepare(`SELECT SUM(${AMT}) AS s FROM aws_cost_daily WHERE day = ? ${acctSql}`).get(dayBefore, ...acctArg).s || 0;
      deltaPct = dbTotal > 0 ? ((yTotal - dbTotal) / dbTotal) * 100 : null;
      byServiceMap = new Map();
      for (const r of db.prepare(`SELECT service, SUM(${AMT}) AS mtdUsd FROM aws_cost_daily WHERE day >= ? ${acctSql} GROUP BY service`)
        .all(monthStart, ...acctArg)) {
        byServiceMap.set(r.service, r.mtdUsd || 0);
      }
    }

    const byDay = new Map();
    for (const r of rows) {
      if (!byDay.has(r.day)) byDay.set(r.day, { day: r.day, totalUsd: 0, services: [] });
      const d = byDay.get(r.day);
      d.totalUsd += r.amount_usd || 0;
      d.services.push({ service: r.service, amountUsd: r.amount_usd || 0 });
    }

    // Usage types seen per service in the same window feed the per-service notes.
    const usageByService = new Map();
    const noteDaySql = month ? 'AND substr(day, 1, 7) = ?' : "AND day >= date('now', ?)";
    const noteDayArg = month ? month : `-${days} days`;
    for (const u of db.prepare(`
      SELECT DISTINCT service, usage_type FROM aws_cost_usage_daily
      WHERE service IS NOT NULL ${noteDaySql} ${acctSql}
    `).all(noteDayArg, ...acctArg)) {
      if (!usageByService.has(u.service)) usageByService.set(u.service, []);
      usageByService.get(u.service).push(u.usage_type);
    }

    res.json({
      days: [...byDay.values()],
      mtdUsd, deltaPct,
      byService: [...byServiceMap.entries()].map(([service, mtdUsd]) => ({
        service, mtdUsd,
        notes: serviceNotes(service, { db, accountId, usageTypes: usageByService.get(service) || [] }),
      })).sort((a, b) => b.mtdUsd - a.mtdUsd),
      months,
      costResources: costResourcesState(accountId),
      metric, amortizedFrom: amortizedFrom(),
    });
  } catch (err) { next(err); }
});

/** GET /api/aws/costs/usage-types?days=30&accountId=&day=&month=YYYY-MM — explains "EC2 - Other" style
 * line items. month and day are mutually exclusive; month wins if both are given. */
router.get('/costs/usage-types', [
  query('days').optional().isInt().toInt(),
  query('accountId').optional().isInt().toInt(),
  query('day').optional().matches(/^\d{4}-\d{2}-\d{2}$/),
  query('month').optional().matches(/^\d{4}-\d{2}$/),
  query('service').optional().isString().trim().isLength({ min: 1, max: 200 }),
  METRIC_VALIDATOR,
], validate, (req, res, next) => {
  try {
    const metric = costMetric(req);
    const AMT = amountExpr(metric);
    const days = Math.min(90, Math.max(7, req.query.days || 30));
    const accountId = req.query.accountId;
    const service = req.query.service;
    const acctSql = accountId ? 'AND account_id = ?' : '';
    const acctArg = accountId ? [accountId] : [];
    let daySql, dayArg;
    if (req.query.month) {
      daySql = 'AND substr(day, 1, 7) = ?';
      dayArg = [req.query.month];
    } else if (req.query.day) {
      daySql = 'AND day = ?';
      dayArg = [req.query.day];
    } else {
      daySql = "AND day >= date('now', ?)";
      dayArg = [`-${days} days`];
    }
    const svcSql = service ? 'AND service = ?' : '';
    const svcArg = service ? [service] : [];
    const rows = db.prepare(`
      SELECT service, usage_type, SUM(${AMT}) AS total_usd, SUM(usage_qty) AS usage_qty, MAX(usage_unit) AS usage_unit FROM aws_cost_usage_daily
      WHERE 1=1 ${daySql} ${acctSql} ${svcSql}
      GROUP BY service, usage_type ORDER BY total_usd DESC LIMIT 60
    `).all(...dayArg, ...acctArg, ...svcArg);
    // Exact objects from resource-level billing when captured for the window, else the derived match.
    const billingSql = `
      SELECT resource_id, SUM(amount_usd) AS total_usd FROM aws_cost_resource_usage_daily
      WHERE usage_type = ? ${daySql} ${acctSql}
      GROUP BY resource_id ORDER BY total_usd DESC
    `;
    const objectsFor = (r) => {
      let billed = [];
      try { billed = db.prepare(billingSql).all(r.usage_type, ...dayArg, ...acctArg); } catch { billed = []; }
      if (billed.length) {
        return {
          objectsMode: 'billing',
          objectCount: billed.length,
          objects: billed.slice(0, 5).map((b) => {
            const info = resolveCostResource(b.resource_id, r.service, db, accountId);
            return { resourceId: b.resource_id, label: info.label, kind: info.kind, link: info.link, totalUsd: b.total_usd || 0 };
          }),
        };
      }
      const d = usageTypeObjects(r.usage_type, r.service, db, accountId);
      return { objectsMode: 'inventory', objectCount: d.objectCount, objects: d.objects, objectsRule: d.rule };
    };
    res.json({
      rows: rows.map((r) => ({
        service: r.service || 'Unattributed (collected before service tagging)',
        usageType: r.usage_type,
        component: r.service === 'Amazon Lightsail' ? lightsailComponent(r.usage_type) : null,
        totalUsd: r.total_usd || 0,
        usageQty: r.usage_qty == null ? null : r.usage_qty,
        usageUnit: r.usage_unit || null,
        ...objectsFor(r),
      })),
      metric, amortizedFrom: amortizedFrom(),
    });
  } catch (err) { next(err); }
});

/** GET /api/aws/costs/resources?service=&accountId=&days=14&day= — resource-level cost (Cost Explorer
 * keeps 14 days). Top 100 resources by total, labelled from the ICC inventory where possible. */
router.get('/costs/resources', [
  query('service').optional().isString().trim().isLength({ min: 1, max: 200 }),
  query('usageType').optional().isString().trim().isLength({ min: 1, max: 200 }),
  query('accountId').optional().isInt().toInt(),
  query('days').optional().isInt().toInt(),
  query('day').optional().matches(/^\d{4}-\d{2}-\d{2}$/),
], validate, (req, res, next) => {
  try {
    const days = Math.min(14, Math.max(1, req.query.days || 14));
    const accountId = req.query.accountId;
    const { service, day, usageType } = req.query;
    const where = ['1=1'];
    const args = [];
    if (day) { where.push('day = ?'); args.push(day); } else { where.push("day >= date('now', ?)"); args.push(`-${days} days`); }
    if (accountId) { where.push('account_id = ?'); args.push(accountId); }
    let rows;
    if (usageType) {
      // Exact: resource ids billed under this usage type. The service comes from the usage rows.
      where.push('usage_type = ?'); args.push(usageType);
      const svc = db.prepare(`
        SELECT service FROM aws_cost_usage_daily WHERE usage_type = ? AND service IS NOT NULL
        ${accountId ? 'AND account_id = ?' : ''} ORDER BY day DESC LIMIT 1
      `).get(usageType, ...(accountId ? [accountId] : []));
      rows = db.prepare(`
        SELECT resource_id, SUM(amount_usd) AS total_usd FROM aws_cost_resource_usage_daily
        WHERE ${where.join(' AND ')}
        GROUP BY resource_id ORDER BY total_usd DESC LIMIT 100
      `).all(...args).map((r) => ({ ...r, service: svc?.service || null }));
    } else {
      if (service) { where.push('service = ?'); args.push(service); }
      rows = db.prepare(`
        SELECT service, resource_id, SUM(amount_usd) AS total_usd FROM aws_cost_resource_daily
        WHERE ${where.join(' AND ')}
        GROUP BY service, resource_id ORDER BY total_usd DESC LIMIT 100
      `).all(...args);
    }
    const end = new Date().toISOString().slice(0, 10);
    const start = day || new Date(Date.now() - days * 86400000).toISOString().slice(0, 10);
    res.json({
      rows: rows.map((r) => {
        const info = resolveCostResource(r.resource_id, r.service, db, accountId);
        return {
          resourceId: r.resource_id, label: info.label, service: r.service, kind: info.kind,
          totalUsd: r.total_usd || 0, link: info.link,
        };
      }),
      window: { start, end: day || end },
      costResources: costResourcesState(accountId),
    });
  } catch (err) { next(err); }
});

/** GET /api/aws/costs/instance-types?days=30&accountId= */
router.get('/costs/instance-types', [
  query('days').optional().isInt().toInt(),
  query('accountId').optional().isInt().toInt(),
  METRIC_VALIDATOR,
], validate, (req, res, next) => {
  try {
    const metric = costMetric(req);
    const AMT = amountExpr(metric);
    const days = Math.min(90, Math.max(7, req.query.days || 30));
    const accountId = req.query.accountId;
    const acctSql = accountId ? 'AND account_id = ?' : '';
    const acctArg = accountId ? [accountId] : [];
    const rows = db.prepare(`
      SELECT instance_type, SUM(${AMT}) AS total_usd FROM aws_cost_instance_type_daily
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
      metric, amortizedFrom: amortizedFrom(),
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
    const est = monthlyEstimates('rds', rows.map((r) => r.db_id));
    res.json({
      instances: rows.map((r) => ({
        dbId: r.db_id, engine: r.engine, engineVersion: r.engine_version, instanceClass: r.instance_class,
        status: r.status, multiAz: !!r.multi_az, allocatedGb: r.allocated_gb,
        freeStorageBytes: r.free_storage_bytes,
        freeStoragePct: r.allocated_gb ? (r.free_storage_bytes / (r.allocated_gb * 1073741824)) * 100 : null,
        cpuUtil: r.cpu_util, connections: r.connections, backupRetentionDays: r.backup_retention_days,
        latestBackupAt: r.latest_backup_at, endpoint: r.endpoint, account: r.account_name,
        estMonthlyUsd: estMonthly(est, r.db_id), tags: parseTags(r.tags_json),
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

const REC_STATUSES = ['open', 'accepted', 'dismissed', 'done'];
const REC_KEY_SQL = "(o.source || '|' || o.finding || '|' || o.resource_id)";

/** Optimizer rows joined to their lifecycle state, savings desc with nulls last. */
function recommendationRows({ accountId, source, status }) {
  const where = ['1=1'];
  const args = [];
  if (accountId) { where.push('o.account_id = ?'); args.push(accountId); }
  if (source) { where.push('o.source = ?'); args.push(source); }
  if (status && status !== 'all') { where.push("COALESCE(st.status, 'open') = ?"); args.push(status); }
  return db.prepare(`
    SELECT o.*, a.name AS account_name, st.status AS st_status, st.note AS st_note,
           st.updated_at AS st_updated_at, st.realized_usd AS st_realized_usd
    FROM aws_optimizer_recommendations o
    JOIN aws_accounts a ON a.id = o.account_id
    LEFT JOIN aws_recommendation_state st ON st.account_id = o.account_id AND st.rec_key = ${REC_KEY_SQL}
    WHERE ${where.join(' AND ')}
    ORDER BY (o.est_monthly_savings_usd IS NULL) ASC, o.est_monthly_savings_usd DESC
  `).all(...args);
}

const mapRecommendation = (r) => ({
  key: `${r.source}|${r.finding}|${r.resource_id}`,
  source: r.source, resourceType: r.resource_type, resourceId: r.resource_id, resourceName: r.resource_name,
  region: r.region, finding: r.finding, currentConfig: r.current_config, recommendedConfig: r.recommended_config,
  reason: r.reason, estMonthlySavingsUsd: r.est_monthly_savings_usd, account: r.account_name,
  effort: r.effort || null,
  restartNeeded: r.restart_needed == null ? null : !!r.restart_needed,
  rollbackPossible: r.rollback_possible == null ? null : !!r.rollback_possible,
  actionType: r.action_type || null,
  lookbackDays: r.lookback_days == null ? null : r.lookback_days,
  afterDiscounts: !!r.after_discounts,
  shadowedBy: r.shadowed_by || null,
  state: {
    status: r.st_status || 'open', note: r.st_note || null, updatedAt: r.st_updated_at || null,
    realizedUsd: r.st_realized_usd == null ? null : r.st_realized_usd,
  },
});

/**
 * Shadowing: a Compute Optimizer row whose resource Cost Optimization Hub also recommends on is shadowed
 * by the Hub (the Hub figure is after discounts); an ICC heuristic row is shadowed by either. Keyed by
 * source|finding|resource|account; returns Map(key -> shadowing source).
 */
function shadowMap(rows) {
  const hub = new Set();
  const co = new Set();
  const k = (r) => `${r.account_id}|${r.resource_id}`;
  // Only a row that carries a positive estimate can shadow: a Compute Optimizer "Optimized" row with
  // no savings says nothing about the heuristic finding on the same resource.
  for (const r of rows) {
    if (!(Number(r.est_monthly_savings_usd) > 0)) continue;
    if (r.source === 'cost-optimization-hub') hub.add(k(r));
    else if (r.source === 'compute-optimizer') co.add(k(r));
  }
  const out = new Map();
  for (const r of rows) {
    const key = `${r.source}|${r.finding}|${r.resource_id}|${r.account_id}`;
    if (r.source === 'compute-optimizer' && hub.has(k(r))) out.set(key, 'cost-optimization-hub');
    else if (r.source === 'heuristic') {
      if (hub.has(k(r))) out.set(key, 'cost-optimization-hub');
      else if (co.has(k(r))) out.set(key, 'compute-optimizer');
    }
  }
  return out;
}

/** GET /api/aws/optimizer?accountId=&status=&includeShadowed= - Compute Optimizer, Hub, heuristic and Cost Explorer recommendations, savings desc. */
router.get('/optimizer', [
  query('accountId').optional().isInt().toInt(),
  query('status').optional().isIn([...REC_STATUSES, 'all']),
  query('includeShadowed').optional().isIn(['0', '1', 'true', 'false']),
], validate, (req, res, next) => {
  try {
    const accountId = req.query.accountId;
    const status = req.query.status || 'all';
    const includeShadowed = ['1', 'true'].includes(String(req.query.includeShadowed || ''));
    const allRows = recommendationRows({ accountId, status: 'all' });
    const shadows = shadowMap(allRows);
    for (const r of allRows) r.shadowed_by = shadows.get(`${r.source}|${r.finding}|${r.resource_id}|${r.account_id}`) || null;
    const live = allRows.filter((r) => !r.shadowed_by);
    const rows = (includeShadowed ? allRows : live).filter((r) => status === 'all' || (r.st_status || 'open') === status);

    const accounts = db.prepare('SELECT * FROM aws_accounts').all();
    const electedRow = accounts.find((a) => isElected(a));
    const lastCaptureRow = accountId
      ? db.prepare('SELECT last_optimizer_capture_at AS c FROM aws_accounts WHERE id = ?').get(accountId)
      : db.prepare('SELECT MAX(last_optimizer_capture_at) AS c FROM aws_accounts').get();

    // Totals, byStatus and the savings figure never count shadowed rows (they would double count).
    const byStatus = { open: 0, accepted: 0, dismissed: 0, done: 0 };
    const sources = {};
    let savings = 0;
    for (const r of live) {
      const st = r.st_status || 'open';
      byStatus[st] = (byStatus[st] || 0) + 1;
      sources[r.source] = (sources[r.source] || 0) + 1;
      savings += r.est_monthly_savings_usd || 0;
    }
    const realized = db.prepare(`
      SELECT COALESCE(SUM(realized_usd), 0) AS s FROM aws_recommendation_state
      WHERE status = 'done' AND realized_at >= ? ${accountId ? 'AND account_id = ?' : ''}
    `).get(new Date(Date.now() - 90 * 86400000).toISOString(), ...(accountId ? [accountId] : [])).s || 0;

    res.json({
      totals: {
        count: live.length,
        estMonthlySavingsUsd: savings,
        coEnrollment: electedRow?.co_enrollment ?? null,
        lastCapture: lastCaptureRow?.c ?? null,
        byStatus,
        realized90dUsd: round2(realized) || 0,
        shadowed: allRows.length - live.length,
        sources,
      },
      recommendations: rows.map(mapRecommendation),
    });
  } catch (err) { next(err); }
});

/**
 * POST /api/aws/optimizer/state { key, status, note? } - lifecycle of one recommendation. The key is
 * source|finding|resourceId; 404 when no recommendation row carries it. A manual done books the estimate
 * as realized savings.
 */
router.post('/optimizer/state', [
  body('key').isString().isLength({ min: 1, max: 600 }),
  body('status').isIn(REC_STATUSES),
  body('note').optional({ nullable: true }).isString().isLength({ max: 500 }),
], validate, (req, res, next) => {
  try {
    const { key, status } = req.body;
    const recs = db.prepare(`
      SELECT o.account_id, o.est_monthly_savings_usd FROM aws_optimizer_recommendations o WHERE ${REC_KEY_SQL} = ?
    `).all(key);
    if (!recs.length) return res.status(404).json({ error: 'Recommendation not found.' });
    const now = new Date().toISOString();
    const user = req.user?.username || 'user';
    const write = db.transaction(() => {
      for (const rec of recs) {
        const existing = db.prepare('SELECT note FROM aws_recommendation_state WHERE account_id = ? AND rec_key = ?').get(rec.account_id, key);
        const note = req.body.note !== undefined ? (req.body.note || null) : (existing?.note ?? null);
        const done = status === 'done';
        db.prepare(`
          INSERT INTO aws_recommendation_state (account_id, rec_key, status, note, updated_by, resolved_by,
            est_monthly_savings_usd, realized_usd, realized_at, first_seen_at, last_seen_at, updated_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
          ON CONFLICT(account_id, rec_key) DO UPDATE SET
            status = excluded.status, note = excluded.note, updated_by = excluded.updated_by,
            resolved_by = excluded.resolved_by, est_monthly_savings_usd = excluded.est_monthly_savings_usd,
            realized_usd = excluded.realized_usd, realized_at = excluded.realized_at, updated_at = excluded.updated_at
        `).run(rec.account_id, key, status, note, user, done ? 'user' : null, rec.est_monthly_savings_usd,
          done ? (rec.est_monthly_savings_usd ?? 0) : null, done ? now : null, now, now, now);
      }
    });
    write();
    const row = db.prepare('SELECT * FROM aws_recommendation_state WHERE account_id = ? AND rec_key = ?').get(recs[0].account_id, key);
    res.json({
      state: {
        key, status: row.status, note: row.note || null, updatedAt: row.updated_at,
        realizedUsd: row.realized_usd == null ? null : row.realized_usd,
      },
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

// -- FinOps ------------------------------------------------------------

const finopsMetric = (req) => (['amortized', 'unblended'].includes(req.query.metric) ? req.query.metric : finopsConfig().finopsMetric);
const RANGE_VALIDATORS = [
  query('days').optional().isInt({ min: 1, max: 365 }),
  query('from').optional().matches(/^\d{4}-\d{2}-\d{2}$/),
  query('to').optional().matches(/^\d{4}-\d{2}-\d{2}$/),
  query('tz').optional().isInt({ min: -840, max: 840 }),
];

/** Parsed range, or null after answering 400. */
function rangeOf(req, res) {
  try {
    return parseDateRange(req.query, { defaultDays: 30, maxDays: 365 });
  } catch (err) {
    if (err.status === 400) { res.status(400).json({ error: err.message }); return null; }
    throw err;
  }
}
const rangeBlock = (range) => rangeResponse(range, null).range;

/** Last capture stamp and the Cost Explorer request count of that capture (resource-level cost is separate). */
function captureInfo(capabilities) {
  let lastCaptureAt = null;
  try { lastCaptureAt = db.prepare('SELECT MAX(last_finops_capture_at) AS c FROM aws_accounts').get().c || null; } catch { lastCaptureAt = null; }
  const lastCaptureRequests = (capabilities || []).filter((c) => c.capability !== 'cost_resources')
    .reduce((a, c) => a + (Number(c.requests) || 0), 0);
  return { lastCaptureAt, lastCaptureRequests };
}

/** GET /api/aws/finops/overview?metric=&accountId= */
router.get('/finops/overview', [
  METRIC_VALIDATOR,
  query('accountId').optional().isInt().toInt(),
], validate, (req, res, next) => {
  try {
    const metric = finopsMetric(req);
    const overview = awsFinops.buildFinopsOverview({ metric, accountId: req.query.accountId || null });
    const capabilities = awsFinops.capabilityRows();
    res.json({ ...overview, metric, capabilities, ...captureInfo(capabilities) });
  } catch (err) { next(err); }
});

// Allocation ----------------------------------------------------------------

function allocationKeys() {
  const cfg = finopsConfig();
  const distinct = (dimension) => {
    try { return db.prepare('SELECT DISTINCT key FROM aws_cost_alloc_daily WHERE dimension = ? AND key <> \'\' ORDER BY key').all(dimension).map((r) => r.key); } catch { return []; }
  };
  return {
    tag: [...new Set([...cfg.finopsTagKeys, ...cfg.tagKeysSeen, ...distinct('tag')])],
    cost_category: distinct('cost_category'),
    linked_account: distinct('linked_account'),
    inventory_tag: settingList('aws_inventory_tag_keys_seen'),
  };
}

const ALLOC_VALIDATORS = [
  query('dimension').optional().isIn(['tag', 'cost_category', 'linked_account', 'inventory_tag']),
  query('key').optional().isString().trim().isLength({ max: 128 }),
  METRIC_VALIDATOR,
  query('accountId').optional().isInt().toInt(),
  ...RANGE_VALIDATORS,
];

function allocationRows(dimension, key, range, metric, accountId) {
  if (dimension === 'inventory_tag') {
    const mod = loadCostEstimate();
    if (!mod || typeof mod.inventoryTagRows !== 'function') return [];
    return mod.inventoryTagRows({ key, fromDay: range.fromDay, toDay: range.toDay, metric, accountId: accountId || null }) || [];
  }
  const amt = amountExpr(metric);
  return db.prepare(`
    SELECT day, value, service, ${amt} AS usd FROM aws_cost_alloc_daily
    WHERE dimension = ? AND key = ? AND day >= ? AND day <= ?
    ORDER BY day ASC, value ASC, service ASC
  `).all(dimension, key, range.fromDay, range.toDay);
}

/** GET /api/aws/finops/allocation?dimension=&key=&days=|from=&to=&tz=&metric= */
router.get('/finops/allocation', ALLOC_VALIDATORS, validate, (req, res, next) => {
  try {
    const range = rangeOf(req, res);
    if (!range) return;
    const metric = finopsMetric(req);
    const dimension = req.query.dimension || 'tag';
    const keysAvailable = allocationKeys();
    const key = req.query.key || (keysAvailable[dimension] || [])[0] || '';
    const rows = key ? allocationRows(dimension, key, range, metric, req.query.accountId) : [];
    const costRows = db.prepare(`
      SELECT day, SUM(${amountExpr(metric)}) AS usd FROM aws_cost_daily WHERE day >= ? AND day <= ? GROUP BY day ORDER BY day ASC
    `).all(range.fromDay, range.toDay);
    const summary = awsFinops.allocationSummary({ rows, costRows });
    res.json({
      dimension, key, keysAvailable, metric, range: rangeBlock(range),
      ...summary,
      coverageGapFlag: summary.coverageGapPct != null && summary.coverageGapPct > 1,
      ...(dimension === 'inventory_tag' ? { estimated: true } : {}),
    });
  } catch (err) { next(err); }
});

/** GET /api/aws/finops/allocation/export.csv - one row per day, value and service. */
router.get('/finops/allocation/export.csv', ALLOC_VALIDATORS, validate, (req, res, next) => {
  try {
    const key = String(req.query.key || '').trim();
    if (!key) return res.status(400).json({ error: 'key is required for the allocation export.' });
    const range = rangeOf(req, res);
    if (!range) return;
    const metric = finopsMetric(req);
    const dimension = req.query.dimension || 'tag';
    const rows = allocationRows(dimension, key, range, metric, req.query.accountId);
    sendCsv(res, `aws-allocation-${key.replace(/[^\w.-]+/g, '_')}-${range.fromDay}_${range.toDay}.csv`,
      ['Day', 'Dimension', 'Key', 'Value', 'Service', `Cost USD (${metric})`],
      rows.map((r) => [r.day, dimension, key, r.value || '(unallocated)', r.service, round2(r.usd)]));
  } catch (err) { next(err); }
});

// Estimated resource cost ----------------------------------------------------

const RESOURCE_NOTE = 'Estimated by splitting billed usage types across the current inventory they name, by weight '
  + '(instance count, GB, bytes). The current inventory is applied to every day in the window. Resource-level billing '
  + 'data from AWS replaces this when enabled.';

const RESOURCE_VALIDATORS = [
  METRIC_VALIDATOR,
  query('kind').optional().isString().trim().isLength({ min: 1, max: 40 }),
  query('service').optional().isString().trim().isLength({ min: 1, max: 200 }),
  query('usageType').optional().isString().trim().isLength({ min: 1, max: 200 }),
  query('q').optional().isString().trim().isLength({ max: 200 }),
  query('accountId').optional().isInt().toInt(),
  query('limit').optional().isInt({ min: 1, max: 5000 }).toInt(),
  ...RANGE_VALIDATORS,
];

const tagsText = (tags) => Object.entries(tags || {}).map(([k, v]) => `${k}=${v}`).join('; ');

/** The estimate module, or null after answering 503 (the module is a separate file the routes load lazily). */
function estimateModule(res) {
  const mod = loadCostEstimate();
  if (!mod) { res.status(503).json({ error: 'Resource cost estimates are not available on this build.' }); return null; }
  return mod;
}

function resourceArgs(req, range, defaultLimit, maxLimit) {
  return {
    fromDay: range.fromDay, toDay: range.toDay, metric: finopsMetric(req),
    kind: req.query.kind || undefined, service: req.query.service || undefined, usageType: req.query.usageType || undefined,
    q: req.query.q || undefined, accountId: req.query.accountId || undefined,
    limit: Math.min(maxLimit, Math.max(1, req.query.limit || defaultLimit)),
  };
}

/** GET /api/aws/finops/resources?days=|from=&to=&tz=&metric=&kind=&service=&usageType=&q=&accountId=&limit= */
router.get('/finops/resources', RESOURCE_VALIDATORS, validate, (req, res, next) => {
  try {
    const range = rangeOf(req, res);
    if (!range) return;
    const mod = estimateModule(res);
    if (!mod) return;
    const args = resourceArgs(req, range, 200, 500);
    const out = mod.resourceRollup(args) || {};
    res.json({
      range: rangeBlock(range), metric: args.metric,
      totals: out.totals || { totalUsd: 0, attributedUsd: 0, unattributedUsd: 0, attributedPct: null },
      byKind: out.byKind || [], rows: out.rows || [], unattributed: out.unattributed || [],
      note: RESOURCE_NOTE, computedAt: out.computedAt || null,
    });
  } catch (err) { next(err); }
});

/** GET /api/aws/finops/resources/export.csv - same params, one row per resource. */
router.get('/finops/resources/export.csv', RESOURCE_VALIDATORS, validate, (req, res, next) => {
  try {
    const range = rangeOf(req, res);
    if (!range) return;
    const mod = estimateModule(res);
    if (!mod) return;
    const args = resourceArgs(req, range, 5000, 5000);
    const out = mod.resourceRollup(args) || {};
    sendCsv(res, `aws-resource-cost-${range.fromDay}_${range.toDay}.csv`,
      ['Kind', 'Resource', 'Label', 'Services', `Cost USD (${args.metric})`, 'Est monthly USD', 'Tags'],
      (out.rows || []).map((r) => [r.resourceKind, r.resourceId, r.label, (r.services || []).join('; '),
        round2(r.usd), round2(r.estMonthlyUsd), tagsText(r.tags)]));
  } catch (err) { next(err); }
});

/** GET /api/aws/finops/resources/series?kind=&resourceId=&days=|from=&to=&metric=&accountId= */
router.get('/finops/resources/series', [
  query('kind').isString().trim().isLength({ min: 1, max: 40 }),
  query('resourceId').isString().trim().isLength({ min: 1, max: 600 }),
  METRIC_VALIDATOR,
  query('accountId').optional().isInt().toInt(),
  ...RANGE_VALIDATORS,
], validate, (req, res, next) => {
  try {
    const range = rangeOf(req, res);
    if (!range) return;
    const mod = estimateModule(res);
    if (!mod) return;
    const metric = finopsMetric(req);
    const out = mod.resourceSeries({
      kind: req.query.kind, resourceId: req.query.resourceId, fromDay: range.fromDay, toDay: range.toDay,
      metric, accountId: req.query.accountId || undefined,
    }) || {};
    res.json({ range: rangeBlock(range), metric, kind: req.query.kind, resourceId: req.query.resourceId, rows: out.rows || [] });
  } catch (err) { next(err); }
});

// Month comparison and price catalog -------------------------------------------

/** GET /api/aws/finops/comparison - the newest stored month pair with per-service deltas and drivers. */
router.get('/finops/comparison', [query('accountId').optional().isInt().toInt()], validate, (req, res, next) => {
  try {
    const accountId = req.query.accountId || null;
    let latest = null;
    if (typeof awsFinops.comparisonLatest === 'function') {
      latest = awsFinops.comparisonLatest({ accountId });
    } else {
      const pair = db.prepare(`
        SELECT baseline_month, comparison_month, metric, MAX(captured_at) AS captured_at FROM aws_cost_comparison
        ${accountId ? 'WHERE account_id = ?' : ''}
        GROUP BY baseline_month, comparison_month, metric ORDER BY comparison_month DESC, captured_at DESC LIMIT 1
      `).get(...(accountId ? [accountId] : []));
      if (pair) {
        latest = {
          baselineMonth: pair.baseline_month, comparisonMonth: pair.comparison_month, metric: pair.metric, capturedAt: pair.captured_at,
          rows: db.prepare(`
            SELECT * FROM aws_cost_comparison WHERE baseline_month = ? AND comparison_month = ? AND metric = ?
            ${accountId ? 'AND account_id = ?' : ''} ORDER BY ABS(COALESCE(delta_usd, 0)) DESC
          `).all(pair.baseline_month, pair.comparison_month, pair.metric, ...(accountId ? [accountId] : [])),
        };
      }
    }
    const rows = ((latest && latest.rows) || []).map((r) => ({
      service: r.service,
      baselineUsd: round2(r.baselineUsd ?? r.baseline_usd),
      comparisonUsd: round2(r.comparisonUsd ?? r.comparison_usd),
      deltaUsd: round2(r.deltaUsd ?? r.delta_usd),
      deltaPct: round2(r.deltaPct ?? r.delta_pct),
      drivers: Array.isArray(r.drivers) ? r.drivers : jsonList(r.drivers_json),
    }));
    res.json({
      baselineMonth: latest?.baselineMonth || null, comparisonMonth: latest?.comparisonMonth || null,
      metric: latest?.metric || null, capturedAt: latest?.capturedAt || null, rows,
    });
  } catch (err) { next(err); }
});

/** GET /api/aws/finops/pricing - what the price catalog holds (read from the table). */
router.get('/finops/pricing', (req, res, next) => {
  try {
    const rows = db.prepare('SELECT COUNT(*) AS n FROM aws_price_catalog').get().n || 0;
    const byService = db.prepare('SELECT service_code, COUNT(*) AS n FROM aws_price_catalog GROUP BY service_code ORDER BY service_code').all()
      .map((r) => ({ serviceCode: r.service_code, n: r.n }));
    const sample = db.prepare('SELECT * FROM aws_price_catalog ORDER BY service_code, region, sku_key LIMIT 50').all().map((r) => ({
      region: r.region, serviceCode: r.service_code, skuKey: r.sku_key, unit: r.unit, priceUsd: r.price_usd,
      attributes: parseTags(r.attributes_json), capturedAt: r.captured_at,
    }));
    res.json({ refreshedAt: getSetting('aws_price_catalog_refreshed_at') || null, rows, byService, sample });
  } catch (err) { next(err); }
});

/** POST /api/aws/finops/pricing/refresh - clear the catalog and capture gates on the elected row and re-poll it. */
router.post('/finops/pricing/refresh', (req, res, next) => {
  try {
    const row = db.prepare('SELECT * FROM aws_accounts').all().find((a) => isElected(a));
    if (!row) return res.status(404).json({ error: 'No elected account to capture from.' });
    setSetting('aws_price_catalog_refreshed_at', '');
    db.prepare('UPDATE aws_accounts SET last_finops_capture_at = NULL WHERE id = ?').run(row.id);
    awsPoller.trigger(db.prepare('SELECT * FROM aws_accounts WHERE id = ?').get(row.id)).catch(() => {});
    res.status(202).json({ ok: true });
  } catch (err) { next(err); }
});

// Commitments ---------------------------------------------------------------

const mean = (arr) => {
  const v = arr.filter((x) => x != null && Number.isFinite(Number(x))).map(Number);
  return v.length ? v.reduce((a, b) => a + b, 0) / v.length : null;
};

/** GET /api/aws/finops/commitments?days=|from=&to=&tz= */
router.get('/finops/commitments', RANGE_VALIDATORS, validate, (req, res, next) => {
  try {
    const range = rangeOf(req, res);
    if (!range) return;
    const win = [range.fromDay, range.toDay];
    const spUtil = db.prepare(`
      SELECT day, utilization_pct, commitment_usd, used_usd, unused_usd, net_savings_usd FROM aws_sp_utilization_daily
      WHERE day >= ? AND day <= ? ORDER BY day ASC
    `).all(...win);
    const spCov = db.prepare(`
      SELECT day, coverage_pct, covered_usd, on_demand_usd FROM aws_sp_coverage_daily
      WHERE day >= ? AND day <= ? ORDER BY day ASC
    `).all(...win);
    const riUtil = db.prepare(`
      SELECT day, utilization_pct, purchased_hours, used_hours, unused_hours, net_savings_usd FROM aws_ri_utilization_daily
      WHERE day >= ? AND day <= ? ORDER BY day ASC
    `).all(...win);
    const riCov = db.prepare(`
      SELECT day, coverage_pct, reserved_hours, on_demand_hours, total_hours FROM aws_ri_coverage_daily
      WHERE day >= ? AND day <= ? ORDER BY day ASC
    `).all(...win);
    const now = Date.now();
    const plans = db.prepare('SELECT * FROM aws_savings_plans ORDER BY end_at ASC').all().map((p) => {
      const end = p.end_at ? Date.parse(p.end_at) : NaN;
      return {
        arn: p.sp_arn, arnTail: String(p.sp_arn || '').split('/').pop(), type: p.sp_type, term: p.term,
        paymentOption: p.payment_option, hourlyCommitmentUsd: round2(p.hourly_commitment_usd), region: p.region || null,
        instanceFamily: p.instance_family || null, startAt: p.start_at, endAt: p.end_at,
        daysToExpiry: Number.isFinite(end) ? Math.ceil((end - now) / 86400000) : null,
        utilizationPct: round2(p.utilization_pct), netSavingsUsd: round2(p.net_savings_usd),
        state: p.state || null, upfrontUsd: round2(p.upfront_usd), recurringUsd: round2(p.recurring_usd),
        productTypes: jsonList(p.product_types_json), source: p.source || 'details', description: p.description || null,
      };
    });
    const capabilities = awsFinops.capabilityRows().filter((c) => /^(sp|ri)_/.test(c.capability));
    res.json({
      range: rangeBlock(range),
      savingsPlans: {
        utilization: spUtil.map((r) => ({
          day: r.day, utilizationPct: round2(r.utilization_pct), commitmentUsd: round2(r.commitment_usd),
          usedUsd: round2(r.used_usd), unusedUsd: round2(r.unused_usd), netSavingsUsd: round2(r.net_savings_usd),
        })),
        coverage: spCov.map((r) => ({
          day: r.day, coveragePct: round2(r.coverage_pct), coveredUsd: round2(r.covered_usd), onDemandUsd: round2(r.on_demand_usd),
        })),
        plans,
        recommendations: recommendationRows({ source: 'ce-savings-plan', status: 'all' }).map(mapRecommendation),
        summary: {
          avgUtilizationPct: round2(mean(spUtil.map((r) => r.utilization_pct))),
          avgCoveragePct: round2(mean(spCov.map((r) => r.coverage_pct))),
          unusedUsd: round2(spUtil.reduce((a, r) => a + (r.unused_usd || 0), 0)),
          netSavingsUsd: round2(spUtil.reduce((a, r) => a + (r.net_savings_usd || 0), 0)),
        },
      },
      reservations: {
        utilization: riUtil.map((r) => ({
          day: r.day, utilizationPct: round2(r.utilization_pct), purchasedHours: round2(r.purchased_hours),
          usedHours: round2(r.used_hours), unusedHours: round2(r.unused_hours), netSavingsUsd: round2(r.net_savings_usd),
        })),
        coverage: riCov.map((r) => ({
          day: r.day, coveragePct: round2(r.coverage_pct), reservedHours: round2(r.reserved_hours),
          onDemandHours: round2(r.on_demand_hours), totalHours: round2(r.total_hours),
        })),
      },
      capabilities,
    });
  } catch (err) { next(err); }
});

// Anomalies -----------------------------------------------------------------

const parseJson = (text, fallback) => { try { return text ? JSON.parse(text) : fallback; } catch { return fallback; } };

/** GET /api/aws/finops/anomalies?status=&source=&days=|from=&to=&tz= */
router.get('/finops/anomalies', [
  query('status').optional().isIn(['open', 'closed', 'all']),
  query('source').optional().isIn(['aws', 'icc', 'all']),
  ...RANGE_VALIDATORS,
], validate, (req, res, next) => {
  try {
    const range = rangeOf(req, res);
    if (!range) return;
    const status = req.query.status || 'all';
    const source = req.query.source || 'all';
    // An anomaly belongs to the window when its days overlap it; an open one has no end day.
    const where = ['start_day <= ?', '(end_day IS NULL OR end_day >= ?)'];
    const args = [range.toDay, range.fromDay];
    if (status !== 'all') { where.push('status = ?'); args.push(status); }
    if (source !== 'all') { where.push('source = ?'); args.push(source); }
    const rows = db.prepare(`
      SELECT * FROM aws_cost_anomalies WHERE ${where.join(' AND ')} ORDER BY (status = 'open') DESC, start_day DESC, impact_usd DESC
    `).all(...args);
    const cfg = finopsConfig();
    res.json({
      range: rangeBlock(range),
      anomalies: rows.map((r) => ({
        id: r.id, anomalyId: r.anomaly_id, source: r.source, scope: r.scope, scopeKey: r.scope_key,
        monitorName: r.monitor_name || null, startDay: r.start_day, endDay: r.end_day,
        actualUsd: round2(r.actual_usd), expectedUsd: round2(r.expected_usd), impactUsd: round2(r.impact_usd),
        impactPct: round2(r.impact_pct), rootCauses: parseJson(r.root_causes_json, []), status: r.status,
        supersededBy: r.superseded_by || null, firstSeenAt: r.first_seen_at, lastSeenAt: r.last_seen_at,
      })),
      monitors: parseJson(getSetting('aws_finops_anomaly_monitors'), []),
      rule: { pct: cfg.anomalyPct, floorUsd: cfg.anomalyFloorUsd, baselineDays: cfg.anomalyBaselineDays, clearDays: cfg.anomalyClearDays },
      capabilities: awsFinops.capabilityRows().filter((c) => c.capability === 'anomalies'),
    });
  } catch (err) { next(err); }
});

// Budgets -------------------------------------------------------------------

const SCOPE_TYPES = ['total', 'account', 'service', 'tag'];
const AWS_BUDGET_MSG = 'This budget is managed in AWS Budgets.';

const publicBudget = (b, st) => ({
  id: b.id, name: b.name, scopeType: b.scope_type, scopeKey: b.scope_key || null, scopeValue: b.scope_value || null,
  amountUsd: round2(b.amount_usd), warnPct: b.warn_pct, critPct: b.crit_pct, forecastAlert: !!b.forecast_alert,
  enabled: !!b.enabled, notes: b.notes || null, createdAt: b.created_at, updatedAt: b.updated_at,
  source: b.source || 'icc', scopeMatch: b.scope_match || 'exact', externalName: b.external_name || null,
  timeUnit: b.time_unit || null, awsActualUsd: round2(b.aws_actual_usd), awsForecastUsd: round2(b.aws_forecast_usd),
  lastSyncedAt: b.last_synced_at || null,
  status: st ? {
    month: st.month, actualUsd: round2(st.actual_usd), forecastUsd: round2(st.forecast_usd), forecastSource: st.forecast_source || null,
    pctActual: round2(st.pct_actual), pctForecast: round2(st.pct_forecast), state: st.state,
  } : null,
});

function loadBudget(id) {
  const b = db.prepare('SELECT * FROM aws_budgets WHERE id = ?').get(id);
  if (!b) return null;
  const st = db.prepare('SELECT * FROM aws_budget_status WHERE budget_id = ? AND month = ?').get(id, monthBounds().month);
  return publicBudget(b, st);
}

/** Config ledger: the whole budget set is one snapshot, so adds, edits and deletes land as ledger rows. */
function ledgerBudgets() {
  try {
    const items = db.prepare('SELECT * FROM aws_budgets ORDER BY name').all().map((b) => ({
      item: `budget:${b.name}`,
      value: JSON.stringify({
        scopeType: b.scope_type, scopeKey: b.scope_key || null, scopeValue: b.scope_value || null, amountUsd: b.amount_usd,
        warnPct: b.warn_pct, critPct: b.crit_pct, forecastAlert: !!b.forecast_alert, enabled: !!b.enabled,
        ...(b.scope_match === 'contains' ? { scopeMatch: 'contains' } : {}),
      }),
    }));
    recordSnapshot({ platform: 'aws', scope: 'finops', system: 'budgets', items });
  } catch { /* ledger never blocks a budget write */ }
}

/** Scope rules; returns an error string or null. */
function budgetScopeError(b) {
  if (b.scopeType === 'account' && !/^\d+$/.test(String(b.scopeKey || ''))) return 'An account budget needs scopeKey set to the account id.';
  if (b.scopeType === 'service' && !String(b.scopeValue || '').trim()) return 'A service budget needs scopeValue set to the service name.';
  if (b.scopeType === 'tag' && (!String(b.scopeKey || '').trim() || !String(b.scopeValue || '').trim())) return 'A tag budget needs scopeKey (tag key) and scopeValue (tag value).';
  return null;
}

const budgetValidators = (required) => {
  const opt = (chain) => (required ? chain : chain.optional());
  return [
    opt(body('name')).isString().trim().isLength({ min: 1, max: 80 }),
    opt(body('scopeType')).isIn(SCOPE_TYPES),
    body('scopeKey').optional({ nullable: true }).isString().trim().isLength({ max: 200 }),
    body('scopeValue').optional({ nullable: true }).isString().trim().isLength({ max: 200 }),
    body('scopeMatch').optional().isIn(['exact', 'contains']),
    opt(body('amountUsd')).isFloat({ gt: 0, max: 1e9 }).toFloat(),
    body('warnPct').optional().isInt({ min: 1, max: 100 }).toInt(),
    body('critPct').optional().isInt({ min: 1, max: 1000 }).toInt(),
    body('forecastAlert').optional().isBoolean().toBoolean(),
    body('enabled').optional().isBoolean().toBoolean(),
    body('notes').optional({ nullable: true }).isString().isLength({ max: 1000 }),
  ];
};

/** GET /api/aws/finops/budgets */
router.get('/finops/budgets', (req, res, next) => {
  try {
    const month = monthBounds().month;
    const statuses = new Map(db.prepare('SELECT * FROM aws_budget_status WHERE month = ?').all(month).map((r) => [r.budget_id, r]));
    const budgets = db.prepare('SELECT * FROM aws_budgets ORDER BY name').all().map((b) => publicBudget(b, statuses.get(b.id)));
    const tagValues = {};
    for (const r of db.prepare("SELECT DISTINCT key, value FROM aws_cost_alloc_daily WHERE dimension = 'tag' AND key <> '' AND value <> '' ORDER BY key, value").all()) {
      (tagValues[r.key] = tagValues[r.key] || []).push(r.value);
    }
    res.json({
      budgets,
      scopes: {
        services: db.prepare('SELECT DISTINCT service FROM aws_cost_daily WHERE service IS NOT NULL ORDER BY service').all().map((r) => r.service),
        tagKeys: allocationKeys().tag,
        tagValues,
        accounts: db.prepare('SELECT id, name FROM aws_accounts ORDER BY name').all(),
      },
    });
  } catch (err) { next(err); }
});

/** POST /api/aws/finops/budgets */
router.post('/finops/budgets', budgetValidators(true), validate, (req, res, next) => {
  try {
    const b = req.body;
    const warnPct = b.warnPct ?? 80;
    const critPct = b.critPct ?? 100;
    if (critPct < warnPct) return res.status(400).json({ error: 'critPct must not be below warnPct.' });
    const scope = {
      scopeType: b.scopeType,
      scopeKey: b.scopeType === 'total' ? null : (b.scopeKey || null),
      scopeValue: ['service', 'tag'].includes(b.scopeType) ? (b.scopeValue || null) : null,
    };
    const scopeErr = budgetScopeError(scope);
    if (scopeErr) return res.status(400).json({ error: scopeErr });
    const scopeMatch = b.scopeMatch || 'exact';
    if (scopeMatch === 'contains' && scope.scopeType !== 'service') return res.status(400).json({ error: 'scopeMatch contains only applies to a service budget.' });
    if (db.prepare('SELECT id FROM aws_budgets WHERE name = ?').get(b.name)) return res.status(409).json({ error: 'duplicate' });
    ledgerBudgets(); // seeds the baseline silently on the first budget ever saved
    const info = db.prepare(`
      INSERT INTO aws_budgets (name, scope_type, scope_key, scope_value, scope_match, amount_usd, warn_pct, crit_pct, forecast_alert, enabled, notes,
        created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(b.name, scope.scopeType, scope.scopeKey, scope.scopeValue, scopeMatch, b.amountUsd, warnPct, critPct,
      (b.forecastAlert ?? true) ? 1 : 0, (b.enabled ?? true) ? 1 : 0, b.notes || null, new Date().toISOString(), new Date().toISOString());
    ledgerBudgets();
    awsFinops.evaluateBudgets();
    res.status(201).json({ budget: loadBudget(info.lastInsertRowid) });
  } catch (err) { next(err); }
});

/** PUT /api/aws/finops/budgets/:id */
router.put('/finops/budgets/:id', [param('id').isInt().toInt(), ...budgetValidators(false)], validate, (req, res, next) => {
  try {
    const cur = db.prepare('SELECT * FROM aws_budgets WHERE id = ?').get(req.params.id);
    if (!cur) return res.status(404).json({ error: 'Budget not found.' });
    if (cur.source === 'aws') return res.status(409).json({ error: AWS_BUDGET_MSG });
    const b = req.body;
    const merged = {
      scopeMatch: b.scopeMatch ?? cur.scope_match ?? 'exact',
      name: b.name ?? cur.name,
      scopeType: b.scopeType ?? cur.scope_type,
      scopeKey: b.scopeKey !== undefined ? (b.scopeKey || null) : cur.scope_key,
      scopeValue: b.scopeValue !== undefined ? (b.scopeValue || null) : cur.scope_value,
      amountUsd: b.amountUsd ?? cur.amount_usd,
      warnPct: b.warnPct ?? cur.warn_pct,
      critPct: b.critPct ?? cur.crit_pct,
      forecastAlert: b.forecastAlert ?? !!cur.forecast_alert,
      enabled: b.enabled ?? !!cur.enabled,
      notes: b.notes !== undefined ? (b.notes || null) : cur.notes,
    };
    if (merged.critPct < merged.warnPct) return res.status(400).json({ error: 'critPct must not be below warnPct.' });
    if (merged.scopeType === 'total') { merged.scopeKey = null; merged.scopeValue = null; }
    if (merged.scopeType === 'account') merged.scopeValue = null;
    const scopeErr = budgetScopeError(merged);
    if (scopeErr) return res.status(400).json({ error: scopeErr });
    if (merged.scopeType !== 'service') {
      if (b.scopeMatch === 'contains') return res.status(400).json({ error: 'scopeMatch contains only applies to a service budget.' });
      merged.scopeMatch = 'exact';
    }
    const dup = db.prepare('SELECT id FROM aws_budgets WHERE name = ? AND id <> ?').get(merged.name, cur.id);
    if (dup) return res.status(409).json({ error: 'duplicate' });
    ledgerBudgets();
    db.prepare(`
      UPDATE aws_budgets SET name = ?, scope_type = ?, scope_key = ?, scope_value = ?, scope_match = ?, amount_usd = ?, warn_pct = ?, crit_pct = ?,
        forecast_alert = ?, enabled = ?, notes = ?, updated_at = ? WHERE id = ?
    `).run(merged.name, merged.scopeType, merged.scopeKey, merged.scopeValue, merged.scopeMatch, merged.amountUsd, merged.warnPct, merged.critPct,
      merged.forecastAlert ? 1 : 0, merged.enabled ? 1 : 0, merged.notes, new Date().toISOString(), cur.id);
    ledgerBudgets();
    awsFinops.evaluateBudgets();
    res.json({ budget: loadBudget(cur.id) });
  } catch (err) { next(err); }
});

/** DELETE /api/aws/finops/budgets/:id */
router.delete('/finops/budgets/:id', [param('id').isInt().toInt()], validate, (req, res, next) => {
  try {
    const cur = db.prepare('SELECT id, source FROM aws_budgets WHERE id = ?').get(req.params.id);
    if (!cur) return res.status(404).json({ error: 'Budget not found.' });
    if (cur.source === 'aws') return res.status(409).json({ error: AWS_BUDGET_MSG });
    ledgerBudgets();
    db.prepare('DELETE FROM aws_budgets WHERE id = ?').run(cur.id);
    ledgerBudgets();
    res.status(204).end();
  } catch (err) { next(err); }
});

/** POST /api/aws/finops/budgets/evaluate - re-evaluate every budget now. */
router.post('/finops/budgets/evaluate', (req, res, next) => {
  try {
    const out = awsFinops.evaluateBudgets();
    res.status(202).json({ evaluated: Array.isArray(out) ? out.length : 0 });
  } catch (err) { next(err); }
});

// Forecast, unit economics, capabilities -------------------------------------

/** GET /api/aws/finops/forecast?scope=total */
router.get('/finops/forecast', [query('scope').optional().isString().trim().isLength({ min: 1, max: 200 })], validate, (req, res, next) => {
  try {
    const scope = req.query.scope || 'total';
    const metric = finopsConfig().finopsMetric;
    const b = monthBounds();
    const cur = latestForecast(metric, scope);
    const history = db.prepare(`
      SELECT generated_on, mean_usd, lower_usd, upper_usd, source FROM aws_cost_forecast
      WHERE scope = ? AND LOWER(metric) LIKE ? AND period_start >= ? AND period_start < ?
      ORDER BY generated_on ASC, id ASC
    `).all(scope, `${metric}%`, b.start, b.next);
    res.json({
      current: cur ? {
        scope, metric, periodStart: cur.period_start, periodEnd: cur.period_end, generatedOn: cur.generated_on,
        meanUsd: round2(cur.mean_usd), lowerUsd: round2(cur.lower_usd), upperUsd: round2(cur.upper_usd), source: cur.source,
      } : null,
      history: history.map((r) => ({
        generatedOn: r.generated_on, meanUsd: round2(r.mean_usd), lowerUsd: round2(r.lower_usd), upperUsd: round2(r.upper_usd), source: r.source,
      })),
    });
  } catch (err) { next(err); }
});

/** GET /api/aws/finops/unit-economics?days=|from=&to=&tz=&metric= */
router.get('/finops/unit-economics', [METRIC_VALIDATOR, ...RANGE_VALIDATORS], validate, (req, res, next) => {
  try {
    const range = rangeOf(req, res);
    if (!range) return;
    const metric = finopsMetric(req);
    const result = awsFinops.unitEconomics({ metric, from: range.fromDay, to: range.toDay });
    res.json({ range: rangeBlock(range), metric, ...result });
  } catch (err) { next(err); }
});

/** GET /api/aws/finops/capabilities - status rows, request cost and the IAM policy for what is missing. */
router.get('/finops/capabilities', (req, res, next) => {
  try {
    const capabilities = awsFinops.capabilityRows();
    const info = captureInfo(capabilities);
    const missing = awsFinops.missingActions();
    res.json({
      capabilities, ...info,
      estimatedDailyUsd: round2(info.lastCaptureRequests * 0.01),
      missingActions: missing,
      policy: { Version: '2012-10-17', Statement: [{ Effect: 'Allow', Action: missing, Resource: '*' }] },
    });
  } catch (err) { next(err); }
});

/** POST /api/aws/finops/refresh - clear the FinOps and daily cost gates on the elected row and re-poll
 * it (the cost gate too, so the resource-level capability is re-tested with the rest). */
router.post('/finops/refresh', (req, res, next) => {
  try {
    const row = db.prepare('SELECT * FROM aws_accounts').all().find((a) => isElected(a));
    if (!row) return res.status(404).json({ error: 'No elected account to capture from.' });
    db.prepare('UPDATE aws_accounts SET last_finops_capture_at = NULL, last_cost_capture_at = NULL WHERE id = ?').run(row.id);
    awsPoller.trigger(db.prepare('SELECT * FROM aws_accounts WHERE id = ?').get(row.id)).catch(() => {});
    res.status(202).json({ ok: true });
  } catch (err) { next(err); }
});

/** POST /api/aws/finops/digest/send - send the weekly FinOps digest now. */
router.post('/finops/digest/send', async (req, res, next) => {
  try {
    const out = await awsFinops.sendFinopsDigest({ force: true });
    res.status(202).json({ ok: true, recipients: (out && out.recipients) || [] });
  } catch (err) {
    if (err && (err.code === 'SMTP_NOT_CONFIGURED' || err.code === 'NO_RECIPIENTS')) {
      return res.status(503).json({ error: err.message || 'SMTP is not configured.' });
    }
    next(err);
  }
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

// Ad-hoc email of the cached advisor report (user-clicked, never scheduled).
router.post('/advisor/:report/email', awsAdvisor.emailRoute('AWS'));

module.exports = router;
