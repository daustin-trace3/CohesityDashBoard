// LogicMonitor alert webhook (push ingest). Two routers are exported:
//
//   module.exports            ingest router, UNAUTHENTICATED by session: it
//                             carries its own token check. app.js mounts it
//                             after tenantScope and BEFORE authenticate/csrf:
//                               app.use('/api/logicmonitor/webhook', lmWebhook);
//                             POST /api/logicmonitor/webhook/:sourceId
//                             (tenant form: /api/t/<tenant>/logicmonitor/webhook/:sourceId)
//   module.exports.adminRouter  mounted by app.js AFTER authenticate with a
//                             method-based RBAC gate, before the plugin dispatcher:
//                               app.use('/api/logicmonitor/sources/:id', requirePermission(...), lmWebhook.adminRouter);
//                             GET    /webhook         settings view (no secret)
//                             POST   /webhook-token   issue a token, shown ONCE
//                             DELETE /webhook-token   disable the webhook
//
// Delivery contract. In LogicMonitor create a Custom HTTP Delivery integration
// (method POST, Content-Type application/json) to the URL below with the
// header x-icc-webhook-token: <token>, and this body template (also returned
// by GET /webhook as `template`):
//
//   {"status":"##ALERTSTATUS##","type":"##ALERTTYPE##","alertId":"##INTERNALID##",
//    "recurringId":"##ALERTID##","severity":"##LEVEL##","host":"##HOST##",
//    "hostId":"##HOSTID##","datasource":"##DATASOURCE##","instance":"##INSTANCE##",
//    "datapoint":"##DATAPOINT##","value":"##VALUE##","threshold":"##THRESHOLD##",
//    "startEpoch":"##STARTEPOCH##","endEpoch":"##ENDEPOCH##","message":"##MESSAGE##",
//    "ackedBy":"##ACKEDBY##","ackComment":"##ACKCOMMENT##","group":"##GROUP##"}
//
// Note the inversion from the REST names: ##INTERNALID## is the DS... id that
// the REST API calls `id` (stored as lm_alerts.lm_alert_id, the poller's upsert
// key); ##ALERTID## is the LMD... recurring id (stored as internal_id).
// ##LEVEL## is the word warning | error | critical (mapped to 2 | 3 | 4; digits
// are accepted too). status is active | acknowledged | cleared | escalated
// ('new' counts as active, 'ack' as acknowledged). The token may instead ride
// as ?token= for products that cannot set headers. Responses: 202 {accepted:true}
// or 400/401/403/413/429/503 {error}. The condition_key is built by the same
// function the poller uses, so a pushed row and a polled row for one condition
// are the same Ops Agent alert.
const crypto = require('crypto');
const express = require('express');
const rateLimit = require('express-rate-limit');
const db = require('../db/database');
const logger = require('../utils/logger');
const { getSetting, getIccBaseUrl } = require('../services/settings');
const { isDemo } = require('../services/demoMode');
const currentTenantId = () => null; // icc-phase1: single tenant, no /t/<tenant> segment

const MAX_BODY_BYTES = 64 * 1024;
const TOKEN_HEADER = 'x-icc-webhook-token';
const EVENT_RETENTION_DAYS = 7;
const RAW_CAP = 8000;
const STR_CAP = 500;

const TEMPLATE = '{"status":"##ALERTSTATUS##","type":"##ALERTTYPE##","alertId":"##INTERNALID##",'
  + '"recurringId":"##ALERTID##","severity":"##LEVEL##","host":"##HOST##",'
  + '"hostId":"##HOSTID##","datasource":"##DATASOURCE##","instance":"##INSTANCE##",'
  + '"datapoint":"##DATAPOINT##","value":"##VALUE##","threshold":"##THRESHOLD##",'
  + '"startEpoch":"##STARTEPOCH##","endEpoch":"##ENDEPOCH##","message":"##MESSAGE##",'
  + '"ackedBy":"##ACKEDBY##","ackComment":"##ACKCOMMENT##","group":"##GROUP##"}';

const sha256 = (s) => crypto.createHash('sha256').update(String(s)).digest('hex');
const str = (v) => (v == null ? null : (String(v).trim().slice(0, STR_CAP) || null));
const SQL_ISO = (val) => {
  if (!val) return null;
  const s = String(val);
  const d = new Date(/[TZ]/.test(s) || /[+-]\d\d:?\d\d$/.test(s) ? s : `${s.replace(' ', 'T')}Z`);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
};

function columnsOf(table) {
  try { return new Set(db.prepare(`PRAGMA table_info(${table})`).all().map((c) => c.name)); } catch { return new Set(); }
}
function tableExists(name) {
  try { return !!db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(name); } catch { return false; }
}

function rateLimitPerMin() {
  const n = Number(getSetting('lm_webhook_rate_per_min'));
  return Number.isFinite(n) && n >= 60 && n <= 6000 ? Math.round(n) : 600;
}

// ---- Ingest ---------------------------------------------------------------

const ingest = express.Router();

// Keyed by tenant and source so one noisy portal cannot starve another.
const limiter = rateLimit({
  windowMs: 60 * 1000,
  limit: () => rateLimitPerMin(),
  keyGenerator: (req) => `${currentTenantId() || '-'}:${req.params.sourceId}`,
  standardHeaders: true,
  legacyHeaders: false,
  validate: false,
  message: { error: 'Too many webhook deliveries for this source, slow down.' },
});

function tokenMatches(provided, storedHash) {
  if (!provided || !storedHash) return false;
  const a = Buffer.from(sha256(provided), 'utf8');
  const b = Buffer.from(String(storedHash), 'utf8');
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

const SEVERITY_WORDS = { warning: 2, warn: 2, error: 3, critical: 4, crit: 4 };
function severityOf(v) {
  if (v == null) return null;
  const s = String(v).trim().toLowerCase();
  if (SEVERITY_WORDS[s]) return SEVERITY_WORDS[s];
  const n = Number(s);
  return Number.isInteger(n) && n >= 1 && n <= 4 ? Math.max(2, n) : null;
}
const severityNorm = (sev) => (Number(sev) >= 4 ? 'critical' : Number(sev) === 3 ? 'warning' : 'info');

function statusOf(v) {
  const s = String(v == null ? '' : v).trim().toLowerCase();
  if (s === 'active' || s === 'new') return 'active';
  if (s === 'acknowledged' || s === 'ack' || s === 'acked') return 'acknowledged';
  if (s === 'cleared' || s === 'clear' || s === 'resolved') return 'cleared';
  if (s === 'escalated' || s === 'escalation') return 'escalated';
  return null;
}

/** Epoch seconds from seconds or milliseconds (string or number); null if absent. */
function epochSec(v) {
  const n = Number(v);
  if (v == null || v === '' || !Number.isFinite(n) || n <= 0) return null;
  return n > 1e11 ? Math.floor(n / 1000) : Math.floor(n);
}

let lastPrune = 0;
function pruneEvents() {
  if (Date.now() - lastPrune < 3600000) return;
  lastPrune = Date.now();
  try {
    db.prepare('DELETE FROM lm_webhook_events WHERE received_at < ?')
      .run(new Date(Date.now() - EVENT_RETENTION_DAYS * 86400000).toISOString().replace('T', ' ').slice(0, 19));
  } catch { /* retention is best effort */ }
}

function logEvent(sourceId, ev) {
  try {
    if (!tableExists('lm_webhook_events')) return;
    db.prepare(`INSERT INTO lm_webhook_events (source_id, status, lm_alert_id, internal_id, host, accepted, error, raw_json)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)`).run(sourceId, ev.status || null, ev.alertId || null, ev.recurringId || null, ev.host || null,
      ev.accepted ? 1 : 0, ev.error || null, ev.raw ? String(ev.raw).slice(0, RAW_CAP) : null);
    pruneEvents();
  } catch (err) { logger.warn(`[LogicMonitor] webhook event log failed: ${err.message}`); }
}

/** Upsert one lm_alerts row from a validated payload. Columns that the
 *  installed schema lacks (a pre-v3 database has no `ingest`) are skipped. */
function upsertAlert(sourceId, p) {
  const have = columnsOf('lm_alerts');
  const api = require('../services/logicmonitorApi');
  const nowSec = Math.floor(Date.now() / 1000);

  let lmDeviceId = null;
  const hostId = Number(p.hostId);
  if (Number.isInteger(hostId) && hostId > 0 && tableExists('lm_devices')) {
    const d = db.prepare('SELECT lm_device_id FROM lm_devices WHERE source_id = ? AND lm_device_id = ?').get(sourceId, hostId);
    if (d) lmDeviceId = d.lm_device_id;
  }
  if (lmDeviceId == null && p.host && tableExists('lm_devices')) {
    const d = db.prepare('SELECT lm_device_id FROM lm_devices WHERE source_id = ? AND (lower(display_name) = lower(?) OR lower(name) = lower(?)) LIMIT 1').get(sourceId, p.host, p.host);
    if (d) lmDeviceId = d.lm_device_id;
  }

  const sev = severityOf(p.severity);
  const fields = {
    internal_id: str(p.recurringId),
    type: str(p.type) ? String(p.type).toLowerCase() : null,
    severity: sev,
    severity_norm: sev == null ? null : severityNorm(sev),
    lm_device_id: lmDeviceId,
    monitor_object_name: str(p.host),
    monitor_object_type: 'device',
    resource_template_name: str(p.datasource),
    instance_name: str(p.instance),
    data_point_name: str(p.datapoint),
    alert_value: str(p.value),
    threshold: str(p.threshold),
    start_epoch: epochSec(p.startEpoch),
    rule: str(p.group),
    ingest: 'webhook',
  };
  fields.condition_key = api.conditionKey(sourceId, {
    monitorObjectName: fields.monitor_object_name,
    resourceTemplateName: fields.resource_template_name,
    instanceName: fields.instance_name,
    dataPointName: fields.data_point_name,
  });
  if (p.status === 'cleared') {
    fields.cleared = 1;
    fields.closed_reason = 'cleared';
    fields.end_epoch = epochSec(p.endEpoch) || nowSec;
  } else {
    fields.cleared = 0;
    if (p.status === 'acknowledged') {
      fields.acked = 1;
      fields.acked_by = str(p.ackedBy);
      fields.ack_comment = str(p.ackComment);
      fields.acked_epoch = nowSec;
    }
  }
  fields.raw_json = JSON.stringify(p).slice(0, RAW_CAP);

  const existing = db.prepare('SELECT id FROM lm_alerts WHERE source_id = ? AND lm_alert_id = ?').get(sourceId, p.alertId);
  if (existing) {
    // Only overwrite with what this delivery actually carried.
    const sets = []; const vals = [];
    for (const [k, v] of Object.entries(fields)) {
      if (!have.has(k)) continue;
      if (v == null && !['closed_reason'].includes(k)) continue;
      sets.push(`${k} = ?`); vals.push(v);
    }
    sets.push("updated_at = datetime('now')");
    if (p.status !== 'cleared') sets.push("captured_at = datetime('now')");
    db.prepare(`UPDATE lm_alerts SET ${sets.join(', ')} WHERE id = ?`).run(...vals, existing.id);
    return { created: false };
  }
  const row = { source_id: sourceId, lm_alert_id: p.alertId, sdted: 0, acked: 0, ...fields };
  if (row.severity == null) { row.severity = 2; row.severity_norm = 'info'; }
  if (row.start_epoch == null) row.start_epoch = nowSec;
  const cols = Object.keys(row).filter((k) => have.has(k) && row[k] !== undefined);
  db.prepare(`INSERT INTO lm_alerts (${cols.join(', ')}) VALUES (${cols.map(() => '?').join(', ')})`).run(...cols.map((k) => row[k]));
  return { created: true };
}

function afterIngest() {
  try {
    const issues = require('../services/logicmonitorIssues');
    if (typeof issues.reconcileIssueHistory === 'function') issues.reconcileIssueHistory();
    if (typeof issues.computeShadows === 'function') issues.computeShadows(db);
  } catch (err) { logger.warn(`[LogicMonitor] webhook follow-up (issues/shadows) failed: ${err.message}`); }
  try { require('../services/opsAgent').wake(); } catch (err) { logger.warn(`[LogicMonitor] could not wake the Ops Agent: ${err.message}`); }
}

ingest.post('/:sourceId', limiter, (req, res, next) => {
  try {
    const sourceId = Number(req.params.sourceId);
    const len = Number(req.headers['content-length'] || 0);
    if (len > MAX_BODY_BYTES) return res.status(413).json({ error: 'Payload too large (64 KB maximum).' });
    if (isDemo()) {
      return res.status(403).json({ demo: true, error: 'Demo mode: this change is disabled. The demo resets to its baseline nightly.' });
    }
    const unauthorized = () => res.status(401).json({ error: 'Invalid webhook token.' });
    if (!Number.isInteger(sourceId) || sourceId < 1 || !tableExists('lm_sources') || !columnsOf('lm_sources').has('webhook_token_hash')) return unauthorized();
    const provided = req.headers[TOKEN_HEADER] || (typeof req.query.token === 'string' ? req.query.token : '');
    const src = db.prepare('SELECT id, webhook_enabled, webhook_token_hash FROM lm_sources WHERE id = ?').get(sourceId);
    // Compare even when the source is missing so timing does not tell them apart.
    const ok = tokenMatches(String(provided || ''), src ? src.webhook_token_hash : sha256('no-such-source'));
    if (!src || !src.webhook_enabled || !ok) return unauthorized();
    if (getSetting('platform_logicmonitor_enabled') !== '1') return res.status(503).json({ error: 'LogicMonitor is not enabled.' });

    const body = req.body;
    if (!body || typeof body !== 'object' || Array.isArray(body)) return res.status(400).json({ error: 'Expected a JSON object body (Content-Type: application/json).' });
    if (JSON.stringify(body).length > MAX_BODY_BYTES) return res.status(413).json({ error: 'Payload too large (64 KB maximum).' });

    const status = statusOf(body.status);
    const p = {
      ...body, status,
      alertId: str(body.alertId), recurringId: str(body.recurringId), host: str(body.host),
    };
    const reject = (code, error) => {
      logEvent(sourceId, { status: str(body.status), alertId: p.alertId, recurringId: p.recurringId, host: p.host, accepted: false, error, raw: JSON.stringify(body) });
      try { db.prepare('UPDATE lm_sources SET webhook_last_error = ? WHERE id = ?').run(error, sourceId); } catch { /* column absent */ }
      return res.status(code).json({ error });
    };
    if (!status) return reject(400, 'status must be one of active, acknowledged, cleared, escalated.');
    if (!p.alertId) return reject(400, 'alertId (##INTERNALID##) is required.');
    if (!p.host) return reject(400, 'host (##HOST##) is required.');

    db.transaction(() => {
      upsertAlert(sourceId, p);
      db.prepare("UPDATE lm_sources SET webhook_last_at = datetime('now'), webhook_count = COALESCE(webhook_count, 0) + 1, webhook_last_error = NULL WHERE id = ?").run(sourceId);
    })();
    logEvent(sourceId, { status, alertId: p.alertId, recurringId: p.recurringId, host: p.host, accepted: true, raw: JSON.stringify(body) });
    afterIngest();
    return res.status(202).json({ accepted: true });
  } catch (err) { return next(err); }
});

// ---- Admin (authenticated; mounted by app.js) -------------------------------

const adminRouter = express.Router({ mergeParams: true });

function sourceFor(req, res) {
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id < 1 || !tableExists('lm_sources')) { res.status(404).json({ error: 'Source not found.' }); return null; }
  const have = columnsOf('lm_sources');
  if (!have.has('webhook_token_hash')) { res.status(503).json({ error: 'LogicMonitor schema is not migrated for webhooks yet.' }); return null; }
  const row = db.prepare('SELECT * FROM lm_sources WHERE id = ?').get(id);
  if (!row) { res.status(404).json({ error: 'Source not found.' }); return null; }
  return row;
}

function absoluteUrl(req, sourceId) {
  const tenant = currentTenantId();
  const path = `${tenant ? `/api/t/${tenant}` : '/api'}/logicmonitor/webhook/${sourceId}`;
  const configured = getIccBaseUrl();
  if (configured) return `${configured}${path}`;
  const proto = String(req.headers['x-forwarded-proto'] || req.protocol || 'http').split(',')[0].trim();
  return `${proto}://${req.get('host')}${path}`;
}

function webhookView(req, row) {
  return {
    enabled: !!row.webhook_enabled && !!row.webhook_token_hash,
    url: absoluteUrl(req, row.id),
    header: TOKEN_HEADER,
    template: TEMPLATE,
    lastAt: SQL_ISO(row.webhook_last_at),
    count: row.webhook_count || 0,
    lastError: row.webhook_last_error || null,
  };
}

adminRouter.get('/webhook', (req, res, next) => {
  try {
    const row = sourceFor(req, res);
    if (!row) return undefined;
    return res.json(webhookView(req, row));
  } catch (err) { return next(err); }
});

adminRouter.post('/webhook-token', (req, res, next) => {
  try {
    const row = sourceFor(req, res);
    if (!row) return undefined;
    const token = crypto.randomBytes(32).toString('hex');
    db.prepare('UPDATE lm_sources SET webhook_token_hash = ?, webhook_enabled = 1, webhook_last_error = NULL WHERE id = ?').run(sha256(token), row.id);
    // The plain token is returned once and never stored.
    return res.json({ token, ...webhookView(req, { ...row, webhook_enabled: 1, webhook_token_hash: 'set', webhook_last_error: null }) });
  } catch (err) { return next(err); }
});

adminRouter.delete('/webhook-token', (req, res, next) => {
  try {
    const row = sourceFor(req, res);
    if (!row) return undefined;
    db.prepare('UPDATE lm_sources SET webhook_token_hash = NULL, webhook_enabled = 0 WHERE id = ?').run(row.id);
    return res.json({ ...webhookView(req, { ...row, webhook_enabled: 0, webhook_token_hash: null }) });
  } catch (err) { return next(err); }
});

module.exports = ingest;
module.exports.adminRouter = adminRouter;
module.exports.TEMPLATE = TEMPLATE;
module.exports.TOKEN_HEADER = TOKEN_HEADER;
