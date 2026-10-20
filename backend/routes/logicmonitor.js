// LogicMonitor routes. Mounted by the plugin dispatcher at /api/logicmonitor;
// paths here are relative. Registration CRUD stores LMv1 {accessId,
// accessKey} or bearer {token} AES-encrypted (keep-if-blank on PUT; a saved
// secret only ever goes to the saved company portal, 2026-09 security rule).
// Data endpoints serve the polled lm_* tables plus computed issues. Lists
// that run to thousands of rows are server-paged {items, total, page, limit}.
// Template: routes/eon.js (CRUD, test, probe, advisor), routes/brocade.js
// (advisor error mapping, governance), routes/unifi.js (issue history).
const express = require('express');
const { body, param, query, validationResult } = require('express-validator');
const db = require('../db/database');
const { encrypt, decrypt } = require('../services/encryption');
const { getSetting, setSetting } = require('../services/settings');
const lmAdvisor = require('../services/advisors/logicmonitorAdvisor');

// WP1 modules are required lazily so a missing or failing service never
// stops the router from loading (and to stay clear of require cycles with
// the manifest).
const lmApi = () => require('../services/logicmonitorApi');
const lmIssues = () => require('../services/logicmonitorIssues');
const pollerHandle = () => require('../services/logicmonitorPoller').logicmonitorPollerHandle;
const lmEndpoints = () => require('../services/logicmonitorEndpoints');
const lmPath = () => require('../services/logicmonitorPath');
const lmEri = () => require('../services/logicmonitorEri');
const lmSites = () => require('../services/logicmonitorSites');
const lmChecks = () => require('../services/logicmonitorChecks');
const lmCorrelation = () => require('../services/logicmonitorCorrelation');

const router = express.Router();

const validate = (req, res, next) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) return res.status(400).json({ error: 'Invalid parameters', details: errors.array() });
  next();
};

// ---- Small helpers ---------------------------------------------------------

const parseJson = (s, fallback) => {
  if (s == null || s === '') return fallback;
  try { const v = JSON.parse(s); return v == null ? fallback : v; } catch { return fallback; }
};
const parseArr = (s) => { const v = parseJson(s, []); return Array.isArray(v) ? v : []; };

/** SQLite zoneless "YYYY-MM-DD HH:MM:SS" is UTC; return ISO with a zone. */
function sqlIso(val) {
  if (!val) return null;
  const s = String(val);
  const d = new Date(/[TZ]/.test(s) || /[+-]\d\d:?\d\d$/.test(s) ? s : `${s.replace(' ', 'T')}Z`);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}
/** Entity epochs are seconds; any value > 1e11 is already milliseconds. */
function epochIso(v) {
  if (v == null || v === '' || !Number.isFinite(Number(v)) || Number(v) <= 0) return null;
  const n = Number(v);
  return new Date(n > 1e11 ? n : n * 1000).toISOString();
}
const msIso = (v) => (v == null || !Number.isFinite(Number(v)) || Number(v) <= 0 ? null : new Date(Number(v)).toISOString());
const sqlMs = (val) => { const iso = sqlIso(val); return iso ? new Date(iso).getTime() : null; };
const isoAgo = (ms) => new Date(Date.now() - ms).toISOString();
const nowSec = () => Math.floor(Date.now() / 1000);
const bool = (v) => (v == null ? null : Number(v) === 1);
const likePat = (q) => `%${String(q).replace(/[%_\\]/g, '\\$&')}%`;

function tableExists(name) {
  try { return !!db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?").get(name); } catch { return false; }
}

// alertStatus "unconfirmed-critical-none": slot 1 ack, slot 2 severity.
function alertSlots(s) {
  const parts = String(s || 'none').toLowerCase().split('-');
  const sev = ['critical', 'error', 'warn'].includes(parts[1]) ? parts[1] : null;
  return { severity: sev, acked: sev ? parts[0] === 'confirmed' : false };
}
// sdtStatus "none-none-none": any non-none slot means in SDT.
function inSdt(s) {
  if (!s) return false;
  return String(s).toLowerCase().split('-').some((p) => p && p !== 'none');
}

/** Numeric compare of the first two dotted parts ('39.005' < '41.000'). */
function buildBehind(build, mgd) {
  if (!build || !mgd) return false;
  const parts = (v) => String(v).split('.').slice(0, 2).map((p) => parseInt(p, 10) || 0);
  const [a1, a2 = 0] = parts(build);
  const [b1, b2 = 0] = parts(mgd);
  return a1 < b1 || (a1 === b1 && a2 < b2);
}

/** Version compare for code levels: numeric runs compared left to right. */
function cmpVersion(a, b) {
  const pa = String(a || '').match(/\d+|[a-z]+/gi) || [];
  const pb = String(b || '').match(/\d+|[a-z]+/gi) || [];
  for (let i = 0; i < Math.max(pa.length, pb.length); i += 1) {
    const x = pa[i]; const y = pb[i];
    if (x === undefined) return -1;
    if (y === undefined) return 1;
    const nx = /^\d+$/.test(x); const ny = /^\d+$/.test(y);
    if (nx && ny) { const d = Number(x) - Number(y); if (d) return d < 0 ? -1 : 1; } else {
      const c = String(x).localeCompare(String(y)); if (c) return c;
    }
  }
  return 0;
}

function csvCell(v) {
  if (v == null) return '';
  let s = typeof v === 'object' ? JSON.stringify(v) : String(v);
  if (/^[=+@\t\r]/.test(s)) s = `'${s}`;
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}
function toCsv(rows, columns) {
  const cols = columns || (rows[0] ? Object.keys(rows[0]) : []);
  const lines = [cols.map(csvCell).join(',')];
  for (const r of rows) lines.push(cols.map((c) => csvCell(r[c])).join(','));
  return `${lines.join('\r\n')}\r\n`;
}
function sendCsv(res, name, rows, columns) {
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="logicmonitor-${name}-${new Date().toISOString().slice(0, 10)}.csv"`);
  res.send(toCsv(rows, columns));
}

// 'all' = 500 (the server-paged cap), else 1..500, default 50.
const limitValidator = query('limit').optional().custom((v) => v === 'all' || (/^\d+$/.test(String(v)) && Number(v) >= 1 && Number(v) <= 500));
function pageArgs(req) {
  const limit = req.query.limit === 'all' ? 500 : (parseInt(req.query.limit, 10) || 50);
  const page = Math.max(1, parseInt(req.query.page, 10) || 1);
  return { limit, page, offset: (page - 1) * limit };
}

// ---- Thresholds (section 9; the clamping getters live in WP1's
// logicmonitorIssues/logicmonitorChecks, this table is the route-side copy
// used to validate and clamp PUT /config and to evaluate list presets) -------

// The definitions (range, default, label, text/boolean kind) live in
// logicmonitorIssues.THRESHOLD_DEFS, the clamping getters' own table; the
// route derives its validation from it so there is one source of truth.
const defs = () => lmIssues().THRESHOLD_DEFS;
const isText = (d) => d.type === 'text';
const clampTo = (key, v) => {
  const d = defs()[key];
  const n = d.float ? Math.round(parseFloat(v) * 10) / 10 : parseInt(v, 10);
  if (!Number.isFinite(n)) return d.def;
  return Math.min(d.max, Math.max(d.min, n));
};
/** Wire form: numbers stay numbers, booleans are '1' / '0', text is a string. */
function wireValue(d, v) {
  if (isText(d)) return String(v == null ? d.def : v);
  if (d.bool) return String(Number(v) ? 1 : 0);
  return Number(v);
}
function allThresholds() {
  const g = lmIssues();
  const out = {};
  for (const [k, d] of Object.entries(defs())) out[k] = wireValue(d, g.getThreshold(k));
  return out;
}
function thr(key) { return lmIssues().getThreshold(key); }
function buildRanges() {
  return Object.fromEntries(Object.entries(defs()).map(([k, d]) => [k, isText(d)
    ? { type: 'text', maxLength: d.maxLength, default: d.def }
    : { ...(d.bool ? { type: 'boolean' } : {}), min: d.min, max: d.max, default: wireValue(d, d.def) }]));
}
const buildLabels = () => Object.fromEntries(Object.entries(defs()).map(([k, d]) => [k, d.label]));

// RULE: request paths read the reconciled lm_issue_history table (open rows);
// the issue engine runs only in the poller, inside the
// reconcile transaction. Never run the engine from a route.
function safeIssues() {
  return db.prepare(`
    SELECT issue_key, source, severity, type, target, message, first_seen, last_seen
    FROM lm_issue_history
    WHERE status = 'open'
    ORDER BY CASE severity WHEN 'critical' THEN 0 WHEN 'warning' THEN 1 WHEN 'info' THEN 2 ELSE 3 END,
             last_seen DESC
  `).all().map((r) => ({
    severity: r.severity, type: r.type, source: r.source, target: r.target, message: r.message,
    issueKey: r.issue_key, firstSeen: sqlIso(r.first_seen), lastSeen: sqlIso(r.last_seen),
  }));
}

/** ISO time of the newest open last_seen, else newest resolved_at, else null. */
function issuesAsOf() {
  const open = db.prepare(`SELECT MAX(last_seen) AS t FROM lm_issue_history WHERE status = 'open'`).get();
  if (open && open.t) return sqlIso(open.t);
  const res = db.prepare(`SELECT MAX(resolved_at) AS t FROM lm_issue_history WHERE resolved_at IS NOT NULL`).get();
  return (res && res.t) ? sqlIso(res.t) : null;
}

// ---- Public source shape (never a secret) ----------------------------------

/** Stored site_rule_json -> {roots, property, fromHostname} or null. */
function siteRuleOut(json) {
  const v = parseJson(json, null);
  if (!v || typeof v !== 'object') return null;
  const roots = Array.isArray(v.roots) ? v.roots : (Array.isArray(v.groupRoots) ? v.groupRoots : []);
  return { roots: roots.map(String), property: typeof v.property === 'string' ? v.property : '', fromHostname: v.fromHostname == null ? true : (v.fromHostname === true || v.fromHostname === 1 || v.fromHostname === '1') };
}
const siteRuleRules = [
  body('siteRule').optional({ nullable: true }).isObject(),
  body('siteRule.roots').optional().isArray({ max: 50 }),
  body('siteRule.roots.*').optional().isString().isLength({ max: 120 }),
  body('siteRule.property').optional().isString().isLength({ max: 120 }),
  body('siteRule.fromHostname').optional().isBoolean().toBoolean(),
];
/** Body siteRule -> JSON text for site_rule_json (null clears). */
function siteRuleIn(v) {
  if (v == null) return null;
  return JSON.stringify({
    roots: (Array.isArray(v.roots) ? v.roots : []).map((x) => String(x).trim()).filter(Boolean),
    property: typeof v.property === 'string' ? v.property.trim() : '',
    fromHostname: v.fromHostname == null ? true : !!v.fromHostname,
  });
}

const publicSource = (row) => {
  const features = parseJson(row.features_json, {}) || {};
  const { ifColumns, ...featuresOut } = features; // eslint-disable-line no-unused-vars
  const cats = parseJson(row.interface_categories_json, null);
  return {
    id: row.id,
    name: row.name,
    company: row.company,
    baseUrl: `https://${row.company}.logicmonitor.com`,
    authMode: row.auth_mode,
    hasCredentials: true,
    verifySsl: Number(row.verify_ssl) !== 0,
    enabled: Number(row.enabled) !== 0,
    pollingIntervalMinutes: row.polling_interval_minutes,
    interfacePollMinutes: row.interface_poll_minutes,
    metricsPollMinutes: row.metrics_poll_minutes == null ? 30 : row.metrics_poll_minutes,
    metricsFamilies: (() => { const v = parseJson(row.metrics_families_json, null); return Array.isArray(v) ? v.map(String) : null; })(),
    rawPollEnabled: row.raw_poll_enabled == null || Number(row.raw_poll_enabled) !== 0,
    rawCallsPerTick: row.raw_calls_per_tick == null ? 600 : row.raw_calls_per_tick,
    rawHistory: parseArr(row.raw_history_json).map(String),
    groupFilter: parseArr(row.group_filter_json),
    interfaceCategories: Array.isArray(cats) ? cats : null,
    features: featuresOut,
    siteRule: siteRuleOut(row.site_rule_json),
    webhookEnabled: Number(row.webhook_enabled) === 1,
    webhookLastAt: sqlIso(row.webhook_last_at),
    webhookCount: row.webhook_count || 0,
    rateLimit: parseJson(row.rate_limit_json, null),
    lastPollStatus: row.last_poll_status,
    lastPollError: row.last_poll_error,
    lastPollAt: sqlIso(row.last_poll_at),
    lastInterfacePollAt: sqlIso(row.last_interface_poll_at),
    lastInterfacePollError: row.last_interface_poll_error,
    sectionErrors: parseJson(row.section_errors, null),
    createdAt: sqlIso(row.created_at),
  };
};

/** Strip scheme, path, ".logicmonitor.com" and slashes; null when invalid. */
function normalizeCompany(raw) {
  let c = String(raw || '').trim().toLowerCase();
  c = c.replace(/^[a-z][a-z0-9+.-]*:\/\//, '');
  c = c.split('/')[0];
  c = c.replace(/\.logicmonitor\.com\.?$/, '').replace(/\/+/g, '');
  return /^[a-z0-9][a-z0-9-]{1,62}$/i.test(c) ? c : null;
}

function savedCreds(row) {
  try { return JSON.parse(decrypt(row.encrypted_credentials)) || {}; } catch { return {}; }
}
function credsFor(mode, c) {
  return mode === 'bearer' ? { token: c.token } : { accessId: c.accessId, accessKey: c.accessKey };
}
function credsComplete(mode, c) {
  return mode === 'bearer' ? !!c.token : !!(c.accessId && c.accessKey);
}

const getSourceRow = (id) => db.prepare('SELECT * FROM lm_sources WHERE id = ?').get(id);
const notFound = (res, what = 'LogicMonitor portal') => res.status(404).json({ error: `${what} not found.` });

// ---- Sources CRUD ----------------------------------------------------------

router.get('/sources', (req, res, next) => {
  try {
    res.json(db.prepare('SELECT * FROM lm_sources ORDER BY name').all().map(publicSource));
  } catch (err) { next(err); }
});

const sourceBodyRules = (create) => [
  create ? body('name').isString().trim().notEmpty().isLength({ max: 120 })
    : body('name').optional().isString().trim().notEmpty().isLength({ max: 120 }),
  create ? body('company').isString().trim().notEmpty().isLength({ max: 253 })
    : body('company').optional().isString().trim().notEmpty().isLength({ max: 253 }),
  body('authMode').optional().isIn(['lmv1', 'bearer']),
  body('accessId').optional({ checkFalsy: true }).isString().isLength({ max: 255 }),
  body('accessKey').optional({ checkFalsy: true }).isString().isLength({ max: 1024 }),
  body('token').optional({ checkFalsy: true }).isString().isLength({ max: 4096 }),
  body('verifySsl').optional().isBoolean().toBoolean(),
  body('enabled').optional().isBoolean().toBoolean(),
  body('pollingIntervalMinutes').optional().isInt({ min: 5, max: 1440 }).toInt(),
  body('interfacePollMinutes').optional().isInt({ min: 5, max: 1440 }).toInt(),
  body('metricsPollMinutes').optional().isInt({ min: 5, max: 1440 }).toInt(),
  body('metricsFamilies').optional({ nullable: true }).isArray({ max: 20 }),
  body('metricsFamilies.*').optional().isString().custom((v) => familyIds().includes(v)),
  // Round 11 raw DataSource ingestion.
  body('rawPollEnabled').optional().isBoolean().toBoolean(),
  body('rawCallsPerTick').optional().isInt({ min: 50, max: 3000 }).toInt(),
  body('rawHistory').optional({ nullable: true }).isArray({ max: 200 }),
  body('rawHistory.*').optional().isString().isLength({ min: 3, max: 200 }).matches(/^[^:]+:[^:].*$/),
  body('groupFilter').optional({ nullable: true }).isArray({ max: 1000 }),
  body('groupFilter.*').optional().isInt({ min: 0 }).toInt(),
  body('interfaceCategories').optional({ nullable: true }).isArray({ max: 50 }),
  body('interfaceCategories.*').optional().isString().isLength({ max: 64 }),
  ...siteRuleRules,
];

router.post('/sources', sourceBodyRules(true), validate, (req, res, next) => {
  try {
    const b = req.body;
    const company = normalizeCompany(b.company);
    if (!company) return res.status(400).json({ error: 'Invalid company: use the portal subdomain, e.g. "acme" for acme.logicmonitor.com.' });
    const mode = b.authMode || 'lmv1';
    const creds = credsFor(mode, { accessId: b.accessId && String(b.accessId).trim(), accessKey: b.accessKey, token: b.token });
    if (!credsComplete(mode, creds)) {
      return res.status(400).json({ error: mode === 'bearer' ? 'A bearer token is required.' : 'Access ID and access key are both required.' });
    }
    const name = b.name.trim();
    const dup = db.prepare('SELECT id FROM lm_sources WHERE name = ? OR company = ?').get(name, company);
    if (dup) return res.status(409).json({ error: 'A LogicMonitor portal with that name or company is already registered.' });
    const info = db.prepare(`
      INSERT INTO lm_sources (name, company, auth_mode, encrypted_credentials, verify_ssl, enabled,
        polling_interval_minutes, interface_poll_minutes, group_filter_json, interface_categories_json, site_rule_json,
        metrics_poll_minutes, metrics_families_json)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      name, company, mode, encrypt(JSON.stringify(creds)),
      b.verifySsl === false ? 0 : 1, b.enabled === false ? 0 : 1,
      b.pollingIntervalMinutes || 5, b.interfacePollMinutes || 15,
      JSON.stringify(Array.isArray(b.groupFilter) ? b.groupFilter : []),
      Array.isArray(b.interfaceCategories) ? JSON.stringify(b.interfaceCategories) : null,
      siteRuleIn(b.siteRule),
      b.metricsPollMinutes || 30,
      Array.isArray(b.metricsFamilies) ? JSON.stringify(b.metricsFamilies) : null,
    );
    const row = getSourceRow(info.lastInsertRowid);
    try {
      const h = pollerHandle();
      h.schedule(row);
      Promise.resolve(h.trigger(row)).catch(() => {});
    } catch { /* poller unavailable; reconcile picks the row up */ }
    res.status(201).json(publicSource(row));
  } catch (err) { next(err); }
});

router.put('/sources/:id', [param('id').isInt().toInt(), ...sourceBodyRules(false)], validate, (req, res, next) => {
  try {
    const row = getSourceRow(req.params.id);
    if (!row) return notFound(res);
    const b = req.body;

    let company = row.company;
    if (b.company !== undefined) {
      company = normalizeCompany(b.company);
      if (!company) return res.status(400).json({ error: 'Invalid company: use the portal subdomain.' });
    }
    const companyChanged = company !== row.company;
    const mode = b.authMode || row.auth_mode || 'lmv1';
    const secretTyped = mode === 'bearer' ? !!b.token : !!b.accessKey;

    // Security rule: a changed company needs the secret typed again, so the
    // stored secret is never replayed to a new portal.
    if (companyChanged && !secretTyped) {
      return res.status(400).json({ error: 'Changing the company requires re-entering the access key or token.' });
    }

    let encryptedCredentials = row.encrypted_credentials;
    const anyCredField = b.accessId || b.accessKey || b.token || mode !== row.auth_mode;
    if (anyCredField) {
      const saved = savedCreds(row);
      const merged = mode === 'bearer'
        ? { token: b.token || saved.token }
        : { accessId: (b.accessId && String(b.accessId).trim()) || saved.accessId, accessKey: b.accessKey || saved.accessKey };
      if (!credsComplete(mode, merged)) {
        return res.status(400).json({ error: mode === 'bearer' ? 'A bearer token is required.' : 'Access ID and access key are both required.' });
      }
      encryptedCredentials = encrypt(JSON.stringify(merged));
    }

    const name = b.name ? b.name.trim() : row.name;
    const dup = db.prepare('SELECT id FROM lm_sources WHERE (name = ? OR company = ?) AND id != ?').get(name, company, row.id);
    if (dup) return res.status(409).json({ error: 'A LogicMonitor portal with that name or company is already registered.' });

    const groupFilterJson = b.groupFilter !== undefined
      ? JSON.stringify(Array.isArray(b.groupFilter) ? b.groupFilter : []) : row.group_filter_json;
    const catsJson = b.interfaceCategories !== undefined
      ? (Array.isArray(b.interfaceCategories) ? JSON.stringify(b.interfaceCategories) : null) : row.interface_categories_json;

    db.prepare(`
      UPDATE lm_sources SET name = ?, company = ?, auth_mode = ?, encrypted_credentials = ?, verify_ssl = ?,
        enabled = ?, polling_interval_minutes = ?, interface_poll_minutes = ?, group_filter_json = ?,
        interface_categories_json = ?, features_json = ?, rate_limit_json = ?, site_rule_json = ?,
        metrics_poll_minutes = ?, metrics_families_json = ?,
        raw_poll_enabled = ?, raw_calls_per_tick = ?, raw_history_json = ?
      WHERE id = ?
    `).run(
      name, company, mode, encryptedCredentials,
      b.verifySsl !== undefined ? (b.verifySsl ? 1 : 0) : row.verify_ssl,
      b.enabled !== undefined ? (b.enabled ? 1 : 0) : row.enabled,
      b.pollingIntervalMinutes || row.polling_interval_minutes,
      b.interfacePollMinutes || row.interface_poll_minutes,
      groupFilterJson, catsJson,
      companyChanged ? null : row.features_json,
      companyChanged ? null : row.rate_limit_json,
      b.siteRule !== undefined ? siteRuleIn(b.siteRule) : row.site_rule_json,
      b.metricsPollMinutes || row.metrics_poll_minutes || 30,
      b.metricsFamilies !== undefined ? (Array.isArray(b.metricsFamilies) ? JSON.stringify(b.metricsFamilies) : null) : row.metrics_families_json,
      b.rawPollEnabled !== undefined ? (b.rawPollEnabled ? 1 : 0) : (row.raw_poll_enabled == null ? 1 : row.raw_poll_enabled),
      b.rawCallsPerTick || row.raw_calls_per_tick || 600,
      b.rawHistory !== undefined ? JSON.stringify([...new Set((b.rawHistory || []).map(String))]) : row.raw_history_json,
      row.id,
    );
    if (b.siteRule !== undefined) { try { lmSites().computeSites(db, row.id); } catch { /* next poll recomputes */ } }
    if (companyChanged || anyCredField) {
      try { const api = lmApi(); if (typeof api.invalidate === 'function') api.invalidate(row.id); } catch { /* ignore */ }
    }
    const updated = getSourceRow(row.id);
    try {
      const h = pollerHandle();
      if (Number(updated.enabled) === 1) h.schedule(updated); else h.cancel(updated.id);
    } catch { /* poller unavailable */ }
    res.json(publicSource(updated));
  } catch (err) { next(err); }
});

router.delete('/sources/:id', [param('id').isInt().toInt()], validate, (req, res, next) => {
  try {
    const row = getSourceRow(req.params.id);
    if (!row) return notFound(res);
    try { pollerHandle().cancel(row.id); } catch { /* ignore */ }
    try { const api = lmApi(); if (typeof api.invalidate === 'function') api.invalidate(row.id); } catch { /* ignore */ }
    db.prepare('DELETE FROM lm_sources WHERE id = ?').run(row.id);
    // The raw store tables (round 11) carry no foreign key.
    try {
      db.prepare('DELETE FROM lm_ds_values WHERE source_id = ?').run(row.id);
      db.prepare('DELETE FROM lm_ds_datapoints WHERE source_id = ?').run(row.id);
    } catch { /* tables not migrated */ }
    res.status(204).end();
  } catch (err) { next(err); }
});

// POST /sources/:id/test - body may carry full creds even when :id does not
// exist yet (the UI posts /sources/0/test for an unsaved form). A blank
// secret tests the SAVED credentials against the SAVED company only; the
// body company is then ignored.
router.post('/sources/:id/test', [
  param('id').isInt({ min: 0 }).toInt(),
  body('company').optional().isString().trim().isLength({ max: 253 }),
  body('authMode').optional().isIn(['lmv1', 'bearer']),
  body('accessId').optional().isString().isLength({ max: 255 }),
  body('accessKey').optional().isString().isLength({ max: 1024 }),
  body('token').optional().isString().isLength({ max: 4096 }),
  body('verifySsl').optional().isBoolean().toBoolean(),
], validate, async (req, res) => {
  const b = req.body;
  const row = req.params.id ? getSourceRow(req.params.id) : null;
  let candidate;
  if (b.accessKey || b.token) {
    const mode = b.authMode || (b.token && !b.accessKey ? 'bearer' : null) || row?.auth_mode || 'lmv1';
    const company = b.company ? normalizeCompany(b.company) : row?.company;
    if (!company) return res.status(400).json({ error: 'Invalid parameters', details: [{ msg: 'a valid company is required' }] });
    let accessId = b.accessId && String(b.accessId).trim();
    if (!accessId && mode === 'lmv1' && row && company === row.company) accessId = savedCreds(row).accessId;
    const creds = credsFor(mode, { accessId, accessKey: b.accessKey, token: b.token });
    if (!credsComplete(mode, creds)) {
      return res.status(400).json({ error: 'Invalid parameters', details: [{ msg: mode === 'bearer' ? 'token required' : 'accessId and accessKey required' }] });
    }
    candidate = {
      id: row ? row.id : null,
      name: row?.name || company,
      company,
      auth_mode: mode,
      verify_ssl: b.verifySsl !== undefined ? (b.verifySsl ? 1 : 0) : (row ? row.verify_ssl : 1),
      features_json: row && company === row.company ? row.features_json : null,
      encrypted_credentials: encrypt(JSON.stringify(creds)),
      credentials: creds,
      ...creds,
    };
  } else {
    if (!row) return notFound(res);
    candidate = { ...row };
  }
  try {
    const result = await lmApi().testConnection(candidate);
    res.status(result && result.ok ? 200 : 502).json(result);
  } catch (err) {
    let msg = err && err.message;
    try { msg = lmApi().errMsg(err); } catch { /* keep message */ }
    res.status(502).json({ ok: false, message: msg || 'Connection test failed.', details: null });
  }
});

router.post('/sources/:id/poll', [param('id').isInt().toInt()], validate, (req, res, next) => {
  try {
    const row = getSourceRow(req.params.id);
    if (!row) return notFound(res);
    Promise.resolve(pollerHandle().trigger(row)).catch(() => {});
    res.status(202).json({ ok: true });
  } catch (err) { next(err); }
});

router.post('/sources/:id/poll-interfaces', [param('id').isInt().toInt()], validate, (req, res, next) => {
  try {
    const row = getSourceRow(req.params.id);
    if (!row) return notFound(res);
    Promise.resolve(pollerHandle().triggerInterfaces(row)).catch(() => {});
    res.status(202).json({ ok: true });
  } catch (err) { next(err); }
});

const IF_DS_NAMES = ['SNMP_Network_Interfaces', 'snmp64_If-', 'snmpIf-'];
const dsNameOf = (d) => d && (d.dataSourceName || d.datasourceName || d.name || '');
const matchIfDs = (d) => IF_DS_NAMES.some((n) => String(dsNameOf(d)).toLowerCase() === n.toLowerCase());

// Probe: raw shapes live against the portal through lmApi.probeGet (first
// 3 raw items per section); the first-connect fix loop. Feature discovery
// runs through the poller's probeFeatures, then the route merges what only
// the probe sees (ifDataSource, ifColumns, checkColumns) into features_json.
router.get('/sources/:id/probe', [param('id').isInt().toInt()], validate, async (req, res, next) => {
  try {
    // The demo never opens outbound connections (2026-09 rule): the probe is
    // a GET, so the write guard does not cover it; refuse here.
    if (require('../services/demoMode').isDemo()) {
      return res.status(403).json({ demo: true, error: 'Demo mode: live portal probes are disabled.' });
    }
    const row = getSourceRow(req.params.id);
    if (!row) return notFound(res);
    const api = lmApi();
    const sections = {};
    const raws = {};
    const fail = (error) => ({ ok: false, sample: null, count: null, error });
    const errText = (err) => { try { return api.errMsg(err); } catch { return (err && err.message) || 'failed'; } };
    const get = async (name, path, params) => {
      try {
        const r = await api.probeGet(row, path, params);
        sections[name] = r && typeof r === 'object' ? r : fail('empty probe result');
      } catch (err) { sections[name] = fail(errText(err)); }
      return sections[name];
    };
    const raw = async (name, fn) => {
      try {
        const data = await fn();
        raws[name] = data;
        sections[name] = { ok: true, sample: data, count: null, error: null };
      } catch (err) { sections[name] = fail(errText(err)); }
    };
    const sampleList = (s) => (s && Array.isArray(s.sample) ? s.sample : []);
    const endS = nowSec();

    const devices = await get('devices', '/device/devices', { size: 3 });
    await get('groups', '/device/groups', { size: 3 });
    await get('collectors', '/setting/collector/collectors', { size: 3 });
    await get('alerts', '/alert/alerts', { size: 3, filter: 'cleared:false' });
    await get('sdts', '/sdt/sdts', { size: 3 });
    const websites = await get('websites', '/website/websites', { size: 3 });
    await get('uptimeDevices', '/device/devices', { size: 3, filter: 'deviceType:18||deviceType:19' });

    // Interface datasource on the first network device ICC knows, else the
    // first device the probe saw.
    const known = db.prepare('SELECT lm_device_id FROM lm_devices WHERE source_id = ? AND is_network = 1 AND stale = 0 ORDER BY lm_device_id LIMIT 1').get(row.id);
    const deviceId = known ? known.lm_device_id : (sampleList(devices)[0] || {}).id;
    let ifDs = null;
    if (deviceId != null) {
      try {
        const all = await api.fetchDeviceDatasources(row, deviceId, { size: 1000, maxPages: 1 });
        const list = Array.isArray(all) ? all : [];
        const rank = (d) => IF_DS_NAMES.findIndex((n) => n.toLowerCase() === String(dsNameOf(d)).toLowerCase());
        const hits = list.filter(matchIfDs).sort((a, b) => rank(a) - rank(b));
        ifDs = hits[0] || null;
        sections.interfaceDatasource = { ok: true, sample: hits.slice(0, 3), count: hits.length, error: null };
      } catch (err) { sections.interfaceDatasource = fail(errText(err)); }
      const hdsId = ifDs && (ifDs.id ?? ifDs.hdsId ?? ifDs.hds_id);
      if (hdsId != null) {
        await raw('interfaceData', () => api.fetchDsData(row, deviceId, hdsId, { start: endS - 900, end: endS, aggregate: 'average' }));
      } else {
        sections.interfaceData = fail('no interface datasource found on the probe device');
      }
    } else {
      sections.interfaceDatasource = fail('no device to probe');
      sections.interfaceData = fail('no device to probe');
    }

    const site = sampleList(websites)[0];
    const checkpoint = site && Array.isArray(site.checkpoints) ? site.checkpoints[0] : null;
    if (site && checkpoint) {
      await raw('checkData', () => api.fetchCheckpointData(row, site.id, checkpoint.id, { start: endS - 3600, end: endS, aggregate: 'average' }));
    } else {
      sections.checkData = fail('no website check with a checkpoint to probe');
    }

    await get('admins', '/setting/admins', { size: 3 });
    await get('topology', '/topology/topologies', { size: 3 });
    const nf = db.prepare('SELECT lm_device_id FROM lm_devices WHERE source_id = ? AND enable_netflow = 1 AND stale = 0 LIMIT 1').get(row.id);
    if (nf) await get('netflow', `/device/devices/${Number(nf.lm_device_id)}/flows`, { size: 1 });
    else sections.netflow = fail('no netflow-enabled device known');
    // Size only: the swagger body is large, so the sample is dropped.
    const sw = await get('swagger', '/swagger.json', {});
    if (sw && sw.ok) sections.swagger = { ok: true, sample: null, count: null, size: sw.size ?? null, error: null };

    let discovered = null;
    try {
      const poller = require('../services/logicmonitorPoller');
      if (typeof poller.probeFeatures === 'function') discovered = await poller.probeFeatures(row);
    } catch { discovered = null; }
    const pickColumns = (d) => {
      if (!d || typeof d !== 'object') return null;
      if (Array.isArray(d.dataPoints)) return d.dataPoints;
      if (Array.isArray(d.dataPointNames)) return d.dataPointNames;
      return null;
    };
    const current = parseJson((getSourceRow(row.id) || row).features_json, {}) || {};
    const features = {
      ...current,
      ...(discovered && typeof discovered === 'object' ? discovered : {}),
      ifDataSource: ifDs ? dsNameOf(ifDs) : (current.ifDataSource ?? null),
      ifColumns: pickColumns(raws.interfaceData) || current.ifColumns || null,
      checkColumns: pickColumns(raws.checkData)
        ? { ...(current.checkColumns || {}), learned: pickColumns(raws.checkData) } : (current.checkColumns || null),
      probedAt: (discovered && discovered.probedAt) || new Date().toISOString(),
    };
    if (!discovered) {
      features.netflow = !!(sections.netflow && sections.netflow.ok);
      features.websites = !!(sections.websites && sections.websites.ok && sections.websites.count > 0);
      features.uptime = !!(sections.uptimeDevices && sections.uptimeDevices.ok && sections.uptimeDevices.count > 0);
      features.topology = !!(sections.topology && sections.topology.ok);
      if (features.config === undefined) features.config = null;
    }
    db.prepare('UPDATE lm_sources SET features_json = ? WHERE id = ?').run(JSON.stringify(features), row.id);
    res.json({ source: publicSource(getSourceRow(row.id)), sections });
  } catch (err) { next(err); }
});

router.get('/sources/:id/groups', [param('id').isInt().toInt()], validate, (req, res, next) => {
  try {
    const row = getSourceRow(req.params.id);
    if (!row) return notFound(res);
    res.json(db.prepare(`
      SELECT lm_group_id, name, full_path, parent_id, num_of_hosts FROM lm_device_groups
      WHERE source_id = ? AND stale = 0 ORDER BY full_path
    `).all(row.id).map((g) => ({
      id: g.lm_group_id, name: g.name, fullPath: g.full_path, parentId: g.parent_id, numOfHosts: g.num_of_hosts,
    })));
  } catch (err) { next(err); }
});

// ---- Shared lookups and row shapes -----------------------------------------

function lookups() {
  const groups = new Map();
  for (const g of db.prepare('SELECT source_id, lm_group_id, full_path, name FROM lm_device_groups').all()) {
    groups.set(`${g.source_id}:${g.lm_group_id}`, g.full_path || g.name);
  }
  const collectors = new Map();
  for (const c of db.prepare('SELECT source_id, collector_id, hostname, description, is_down, build FROM lm_collectors').all()) {
    collectors.set(`${c.source_id}:${c.collector_id}`, c);
  }
  const sources = new Map(db.prepare('SELECT id, name, features_json FROM lm_sources').all().map((s) => [s.id, s]));
  return { groups, collectors, sources };
}
const collectorName = (c, d) => (c ? (c.hostname || c.description) : (d && d.collector_description)) || null;

const DEVICE_SELECT = `
  SELECT d.*, s.name AS source_name,
    COALESCE(c.hostname, c.description, d.collector_description) AS collector_name,
    (SELECT COUNT(*) FROM lm_alerts a WHERE a.source_id = d.source_id AND a.lm_device_id = d.lm_device_id AND a.cleared = 0) AS open_alerts
  FROM lm_devices d
  JOIN lm_sources s ON s.id = d.source_id
  LEFT JOIN lm_collectors c ON c.source_id = d.source_id AND c.collector_id = d.collector_id
`;

function deviceOut(r, lk) {
  const slots = alertSlots(r.alert_status);
  return {
    id: r.lm_device_id,
    sourceId: r.source_id,
    sourceName: r.source_name,
    name: r.name,
    displayName: r.display_name,
    vendor: r.vendor,
    role: r.role,
    model: r.model,
    version: r.version,
    hostStatus: r.host_status,
    alertStatus: r.alert_status,
    alertSeverity: slots.severity,
    acked: slots.acked,
    inSdt: inSdt(r.sdt_status),
    collectorId: r.collector_id,
    collectorName: r.collector_name || null,
    groups: parseArr(r.group_ids_json).map((g) => lk.groups.get(`${r.source_id}:${g}`)).filter(Boolean),
    ifCount: r.if_count || 0,
    ifUp: r.if_up || 0,
    openAlerts: r.open_alerts || 0,
    uptimeSeconds: r.uptime_seconds,
    isNetwork: Number(r.is_network) === 1,
    firstSeen: sqlIso(r.first_seen),
    siteKey: r.site_key || null,
    siteName: r.site_name || null,
    tier: r.tier == null ? null : r.tier,
  };
}

function statusTextOf(r) {
  if (r.status_text) return r.status_text;
  if (r.status == null) return 'unknown';
  return Number(r.status) === 1 ? 'up' : Number(r.status) === 2 ? 'down' : 'other';
}

function interfaceOut(r) {
  const ci = lmPath().circuitInfo(r.description, r.props_json);
  return {
    instanceId: r.instance_id,
    sourceId: r.source_id,
    deviceId: r.lm_device_id,
    deviceName: r.device_name || null,
    displayName: r.display_name,
    description: r.description,
    ifIndex: r.if_index,
    status: r.status,
    statusText: statusTextOf(r),
    speedBps: r.speed_bps,
    inMbps: r.in_mbps,
    outMbps: r.out_mbps,
    inErrors: r.in_errors,
    outErrors: r.out_errors,
    inDiscards: r.in_discards,
    outDiscards: r.out_discards,
    inUtilPct: r.in_util_pct,
    outUtilPct: r.out_util_pct,
    sampledAt: epochIso(r.sampled_at_epoch),
    alertStatus: r.alert_status,
    stopMonitoring: Number(r.stop_monitoring) === 1,
    siteKey: r.site_key || null,
    isWan: Number(r.is_wan) === 1,
    wanLabel: r.wan_label || null,
    alias: ci.alias,
    circuitId: ci.circuitId,
    carrier: ci.carrier,
  };
}

function alertOut(a) {
  return {
    id: a.lm_alert_id,
    sourceId: a.source_id,
    internalId: a.internal_id,
    type: a.type,
    severity: a.severity,
    severityNorm: a.severity_norm,
    deviceId: a.lm_device_id,
    monitorObjectName: a.monitor_object_name,
    datasource: a.resource_template_name,
    instanceName: a.instance_name,
    dataPointName: a.data_point_name,
    alertValue: a.alert_value,
    threshold: a.threshold,
    startedAt: epochIso(a.start_epoch),
    endedAt: epochIso(a.end_epoch),
    acked: Number(a.acked) === 1,
    ackedBy: a.acked_by,
    ackComment: a.ack_comment,
    sdted: Number(a.sdted) === 1,
    suppressor: a.suppressor,
    cleared: Number(a.cleared) === 1,
    rule: a.rule,
    chain: a.chain,
    anomaly: Number(a.anomaly) === 1,
    conditionKey: a.condition_key,
    shadowedBy: parseJson(a.shadowed_by, null),
    duplicateOf: a.duplicate_of || null,
    ingest: a.ingest || null,
  };
}

function sdtOut(s) {
  return {
    id: s.sdt_id,
    sourceId: s.source_id,
    type: s.sdt_type,
    scheduleType: s.schedule_type,
    isEffective: Number(s.is_effective) === 1,
    startAt: msIso(s.start_ms),
    endAt: msIso(s.end_ms),
    admin: s.admin,
    comment: s.comment,
    deviceDisplayName: s.device_display_name,
    groupFullPath: s.group_full_path,
    collectorId: s.collector_id,
  };
}

/** Dead-since in epoch ms: deleted_time_ms when LM sent it, else when ICC
 *  dead_since (first observed dead by the poller), else updated_at. */
const deadSinceMs = (d) => {
  if (d.deleted_time_ms && Number(d.deleted_time_ms) > 0) return Number(d.deleted_time_ms);
  return sqlMs(d.dead_since) || sqlMs(d.updated_at);
};

function mgdFor(lk, sourceId) {
  const s = lk.sources.get(sourceId);
  const f = s ? parseJson(s.features_json, {}) || {} : {};
  return f.collectorMgd || null;
}

// ---- Checks: per-location state --------------------------------------------

/**
 * Per-location anomaly state for the reachability matrix, the section 6
 * rule evaluated on read: 'down' when the location's last status is down;
 * 'latency' when the mean RTT of the last 3 samples exceeds
 * median + k * max(MAD, floor) and the min; 'loss' when the mean loss of the
 * last 3 exceeds median + k * max(MAD, 1) and the min percent. The baseline
 * is the stored lm_check_baseline row for the current UTC hour and needs the
 * min sample count. Issues (logicmonitorChecks) stay the alerting truth.
 */
function buildChecks(sourceId) {
  const t = allThresholds();
  const hour = new Date().getUTCHours();
  const where = ['c.stale = 0'];
  const params = [];
  if (sourceId) { where.push('c.source_id = ?'); params.push(sourceId); }
  const checks = db.prepare(`SELECT c.* FROM lm_checks c WHERE ${where.join(' AND ')} ORDER BY c.name`).all(...params);
  const locStmt = db.prepare('SELECT * FROM lm_check_locations WHERE source_id = ? AND check_id = ? AND stale = 0 ORDER BY is_overall DESC, label');
  const histStmt = db.prepare(`
    SELECT rtt_avg_ms, loss_pct FROM lm_check_history WHERE source_id = ? AND check_id = ? AND checkpoint_id = ?
    ORDER BY COALESCE(sample_epoch, 0) DESC, id DESC LIMIT 3
  `);
  const baseStmt = db.prepare(`
    SELECT * FROM lm_check_baseline WHERE source_id = ? AND check_id = ? AND checkpoint_id = ? AND hour_of_day = ?
  `);
  const mean = (arr) => { const v = arr.filter((x) => typeof x === 'number' && Number.isFinite(x)); return v.length ? v.reduce((a, b) => a + b, 0) / v.length : null; };

  // WP1's evaluateLocations(db) is the shared evaluator (same rule the
  // issues use); the local evaluation below is the fallback per location.
  const evaluated = new Map();
  try {
    const ev = require('../services/logicmonitorChecks').evaluateLocations;
    if (typeof ev === 'function') {
      for (const e of ev(db) || []) evaluated.set(`${e.sourceId}|${e.checkId}|${e.checkpointId}`, e);
    }
  } catch (err) {
    // The shared evaluator failing is a defect worth seeing, not a quiet
    // downgrade: log once per request, then use the per-location fallback.
    require('../utils/logger').warn(`[LogicMonitor] evaluateLocations failed, using route fallback: ${err.message}`);
  }

  // Likely hop for an anomalous location (path model); one context per call.
  let pctx = null;
  const blameOf = (c, l, anomaly) => {
    if (!anomaly) return null;
    try {
      pctx = pctx || lmPath().makeContext(db);
      const b = lmPath().blameForCheck(db, c.check_id, l.checkpoint_id, { ctx: pctx, sourceId: c.source_id });
      return b ? { deviceName: b.deviceName, port: b.port, reason: b.reason } : null;
    } catch { return null; }
  };

  const items = [];
  for (const c of checks) {
    const locations = locStmt.all(c.source_id, c.check_id).map((l) => {
      const e = evaluated.get(`${c.source_id}|${c.check_id}|${l.checkpoint_id}`);
      if (e) {
        return {
          checkpointId: l.checkpoint_id,
          label: l.label,
          isOverall: Number(l.is_overall) === 1,
          lastStatus: e.status || l.last_status || 'unknown',
          rttAvgMs: e.rttAvgMs !== undefined ? e.rttAvgMs : l.last_rtt_ms,
          lossPct: e.lossPct !== undefined ? e.lossPct : l.last_loss_pct,
          responseMs: e.responseMs !== undefined ? e.responseMs : l.last_response_ms,
          sampleAt: epochIso(e.sampleEpoch != null ? e.sampleEpoch : l.last_sample_epoch),
          baselineRttMs: e.baselineRttMs ?? null,
          baselineLossPct: e.baselineLossPct ?? null,
          anomaly: e.anomaly || null,
          blame: blameOf(c, l, e.anomaly || null),
        };
      }
      const base = baseStmt.get(c.source_id, c.check_id, l.checkpoint_id, hour);
      const last = histStmt.all(c.source_id, c.check_id, l.checkpoint_id);
      let anomaly = null;
      if (l.last_status === 'down') anomaly = 'down';
      else if (base && (base.samples || 0) >= t.lm_check_baseline_min_samples && last.length) {
        const rtt = mean(last.map((h) => h.rtt_avg_ms));
        const loss = mean(last.map((h) => h.loss_pct));
        if (rtt != null && base.rtt_median != null
          && rtt > base.rtt_median + t.lm_check_latency_k * Math.max(base.rtt_mad || 0, t.lm_check_latency_floor_ms)
          && rtt > t.lm_check_latency_min_ms) anomaly = 'latency';
        else if (loss != null && base.loss_median != null
          && loss > base.loss_median + t.lm_check_latency_k * Math.max(base.loss_mad || 0, 1)
          && loss >= t.lm_check_loss_min_pct) anomaly = 'loss';
      }
      return {
        checkpointId: l.checkpoint_id,
        label: l.label,
        isOverall: Number(l.is_overall) === 1,
        lastStatus: l.last_status || 'unknown',
        rttAvgMs: l.last_rtt_ms,
        lossPct: l.last_loss_pct,
        responseMs: l.last_response_ms,
        sampleAt: epochIso(l.last_sample_epoch),
        baselineRttMs: base ? base.rtt_median : null,
        baselineLossPct: base ? base.loss_median : null,
        anomaly,
        blame: blameOf(c, l, anomaly),
      };
    });
    const overall = locations.find((l) => l.isOverall);
    const perLoc = locations.filter((l) => !l.isOverall);
    let state = 'ok';
    if ((overall && overall.lastStatus === 'down') || (!overall && perLoc.length && perLoc.every((l) => l.lastStatus === 'down'))) state = 'down';
    else if (locations.some((l) => l.anomaly)) state = 'degraded';
    items.push({
      checkId: c.check_id,
      sourceId: c.source_id,
      kind: c.kind,
      origin: c.origin,
      name: c.name,
      target: c.target,
      status: c.status,
      state,
      overallAlertLevel: c.overall_alert_level,
      isInternal: Number(c.is_internal) === 1,
      pollingInterval: c.polling_interval,
      locations,
    });
  }
  return items;
}

function checksMatrix(items) {
  const rows = [];
  const cols = [];
  const cells = [];
  for (const c of items) {
    cols.push({ checkId: c.checkId, name: c.name });
    for (const l of c.locations) {
      if (l.isOverall) continue;
      if (!rows.includes(l.label)) rows.push(l.label);
      cells.push({ row: l.label, col: c.checkId, rttAvgMs: l.rttAvgMs, lossPct: l.lossPct, status: l.lastStatus, anomaly: l.anomaly, blame: l.blame || null });
    }
  }
  rows.sort((a, b) => String(a).localeCompare(String(b)));
  return { rows, cols, cells };
}

function checkCounts(items) {
  const down = items.filter((c) => c.state === 'down').length;
  const degraded = items.filter((c) => c.state === 'degraded').length;
  return { total: items.length, down, degraded, ok: items.length - down - degraded };
}

// ---- Summary ---------------------------------------------------------------

/** Round 3 totals: sites, WAN circuits, saturated circuits, shadowed alerts. */
function roundThreeTotals() {
  const one = (sql) => { try { return db.prepare(sql).get().n; } catch { return 0; } };
  let saturated = 0;
  try { saturated = lmPath().circuitRows(db).filter((c) => c.satState !== 'ok').length; } catch { saturated = 0; }
  return {
    sites: one('SELECT COUNT(*) n FROM lm_sites'),
    circuits: one('SELECT COUNT(*) n FROM lm_interfaces WHERE is_wan = 1 AND stale = 0'),
    circuitsSaturated: saturated,
    shadowed: one('SELECT COUNT(*) n FROM lm_alerts WHERE cleared = 0 AND shadowed_by IS NOT NULL'),
  };
}

router.get('/summary', (req, res, next) => {
  try {
    const lk = lookups();
    const sources = db.prepare('SELECT * FROM lm_sources ORDER BY name').all().map(publicSource);
    const dev = db.prepare(`
      SELECT COUNT(*) devices,
        COALESCE(SUM(CASE WHEN is_network = 1 THEN 1 ELSE 0 END), 0) network_devices,
        COALESCE(SUM(CASE WHEN host_status = 'normal' THEN 1 ELSE 0 END), 0) normal,
        COALESCE(SUM(CASE WHEN host_status = 'dead' THEN 1 ELSE 0 END), 0) dead,
        COALESCE(SUM(CASE WHEN host_status = 'dead-collector' THEN 1 ELSE 0 END), 0) dead_collector
      FROM lm_devices WHERE stale = 0
    `).get();
    const sdtCount = db.prepare('SELECT sdt_status FROM lm_devices WHERE stale = 0').all().filter((r) => inSdt(r.sdt_status)).length;
    // Estate line on the Overview (round 2): distinct vendors, vendor+model
    // pairs and roles among live network devices.
    const estate = db.prepare(`
      SELECT COUNT(DISTINCT vendor) vendors,
        COUNT(DISTINCT COALESCE(vendor, '') || '|' || COALESCE(model, '')) models,
        COUNT(DISTINCT role) roles
      FROM lm_devices WHERE stale = 0 AND is_network = 1
    `).get();
    const ifs = db.prepare(`
      SELECT COUNT(*) total,
        COALESCE(SUM(CASE WHEN status_text = 'up' OR (status_text IS NULL AND status = 1) THEN 1 ELSE 0 END), 0) up,
        COALESCE(SUM(CASE WHEN (status_text = 'down' OR (status_text IS NULL AND status = 2)) AND COALESCE(stop_monitoring, 0) = 0 THEN 1 ELSE 0 END), 0) down
      FROM lm_interfaces WHERE stale = 0
    `).get();
    const al = db.prepare(`
      SELECT COALESCE(SUM(CASE WHEN severity_norm = 'critical' THEN 1 ELSE 0 END), 0) critical,
        COALESCE(SUM(CASE WHEN severity_norm = 'warning' THEN 1 ELSE 0 END), 0) warning,
        COALESCE(SUM(CASE WHEN severity_norm = 'info' THEN 1 ELSE 0 END), 0) info,
        COALESCE(SUM(CASE WHEN acked = 1 THEN 1 ELSE 0 END), 0) acked
      FROM lm_alerts WHERE cleared = 0 AND duplicate_of IS NULL
    `).get();
    const col = db.prepare(`
      SELECT COUNT(*) total, COALESCE(SUM(CASE WHEN is_down = 1 THEN 1 ELSE 0 END), 0) down
      FROM lm_collectors WHERE stale = 0
    `).get();
    const checks = buildChecks();
    const cc = checkCounts(checks);
    let issues = [];
    try { issues = safeIssues(); } catch { issues = []; }

    const byVendor = db.prepare(`
      SELECT COALESCE(vendor, 'Unknown') vendor, COUNT(*) count FROM lm_devices WHERE stale = 0
      GROUP BY COALESCE(vendor, 'Unknown') ORDER BY count DESC, vendor
    `).all();
    const byRole = db.prepare(`
      SELECT COALESCE(role, 'other') role, COUNT(*) count FROM lm_devices WHERE stale = 0
      GROUP BY COALESCE(role, 'other') ORDER BY count DESC, role
    `).all();
    const byHostStatus = db.prepare(`
      SELECT COALESCE(host_status, 'unknown') hostStatus, COUNT(*) count FROM lm_devices WHERE stale = 0
      GROUP BY COALESCE(host_status, 'unknown') ORDER BY count DESC
    `).all();
    const alertsByDatasource = db.prepare(`
      SELECT COALESCE(resource_template_name, 'Unknown') name, COUNT(*) count FROM lm_alerts WHERE cleared = 0 AND duplicate_of IS NULL
      GROUP BY COALESCE(resource_template_name, 'Unknown') ORDER BY count DESC, name LIMIT 10
    `).all();
    const deadDevices = db.prepare(`
      ${DEVICE_SELECT} WHERE d.stale = 0 AND d.host_status IN ('dead', 'dead-collector')
      ORDER BY CASE d.host_status WHEN 'dead' THEN 0 ELSE 1 END, d.is_network DESC, d.display_name LIMIT 10
    `).all().map((d) => ({ id: d.lm_device_id, sourceId: d.source_id, displayName: d.display_name, hostStatus: d.host_status, collector: d.collector_name || null, sinceMs: deadSinceMs(d) }));
    const hotRows = db.prepare(`
      SELECT i.*, d.display_name AS device_name FROM lm_interfaces i
      LEFT JOIN lm_devices d ON d.source_id = i.source_id AND d.lm_device_id = i.lm_device_id
      WHERE i.stale = 0 AND (i.in_util_pct IS NOT NULL OR i.out_util_pct IS NOT NULL)
      ORDER BY MAX(COALESCE(i.in_util_pct, 0), COALESCE(i.out_util_pct, 0)) DESC LIMIT 10
    `).all();
    const hotInterfaces = hotRows.map((i) => ({ instanceId: i.instance_id, deviceId: i.lm_device_id, deviceName: i.device_name, displayName: i.display_name, inUtilPct: i.in_util_pct, outUtilPct: i.out_util_pct }));

    const rank = (l) => (l.anomaly === 'down' || l.lastStatus === 'down' ? 0 : l.anomaly ? 1 : 2);
    const worstRows = checks.flatMap((c) => c.locations.map((l) => ({
      _sid: c.sourceId, _cp: l.checkpointId,
      checkId: c.checkId, checkName: c.name, checkpointLabel: l.label, rttAvgMs: l.rttAvgMs, lossPct: l.lossPct,
      status: l.lastStatus, anomaly: l.anomaly, baselineRttMs: l.baselineRttMs, blame: l.blame || null, _r: rank(l),
      _ratio: l.rttAvgMs != null && l.baselineRttMs ? l.rttAvgMs / l.baselineRttMs : 0,
    }))).sort((a, b) => a._r - b._r || (b.lossPct || 0) - (a.lossPct || 0) || b._ratio - a._ratio)
      .slice(0, 10);
    const worstLinks = worstRows.map(({ _r, _ratio, _sid, _cp, ...rest }) => rest); // eslint-disable-line no-unused-vars

    // Last 24 history rows per hot interface / worst link, one windowed query each.
    let hotInterfaceSeries = [];
    try {
      if (hotRows.length) {
        const pairs = hotRows.map(() => '(source_id = ? AND instance_id = ?)').join(' OR ');
        const rows = db.prepare(`
          SELECT source_id, instance_id, captured_at, in_util_pct, out_util_pct FROM (
            SELECT h.*, ROW_NUMBER() OVER (PARTITION BY source_id, instance_id ORDER BY datetime(captured_at) DESC, id DESC) rn
            FROM lm_interface_history h WHERE ${pairs}
          ) WHERE rn <= 24 ORDER BY datetime(captured_at) ASC
        `).all(...hotRows.flatMap((i) => [i.source_id, i.instance_id]));
        hotInterfaceSeries = hotRows.map((i) => ({
          instanceId: i.instance_id, deviceName: i.device_name, displayName: i.display_name,
          points: rows.filter((r) => r.source_id === i.source_id && r.instance_id === i.instance_id)
            .map((r) => ({ at: sqlIso(r.captured_at), utilPct: Math.max(r.in_util_pct ?? 0, r.out_util_pct ?? 0) })),
        }));
      }
    } catch { hotInterfaceSeries = []; }
    let worstLinkSeries = [];
    try {
      if (worstRows.length) {
        const pairs = worstRows.map(() => '(source_id = ? AND check_id = ? AND checkpoint_id = ?)').join(' OR ');
        const rows = db.prepare(`
          SELECT source_id, check_id, checkpoint_id, captured_at, sample_epoch, rtt_avg_ms, loss_pct FROM (
            SELECT h.*, COALESCE(sample_epoch, CAST(strftime('%s', captured_at) AS INTEGER)) ts,
              ROW_NUMBER() OVER (PARTITION BY source_id, check_id, checkpoint_id
                ORDER BY COALESCE(sample_epoch, CAST(strftime('%s', captured_at) AS INTEGER)) DESC, id DESC) rn
            FROM lm_check_history h WHERE ${pairs}
          ) WHERE rn <= 24 ORDER BY ts ASC, id ASC
        `).all(...worstRows.flatMap((w) => [w._sid, w.checkId, w._cp]));
        worstLinkSeries = worstRows.map((w) => ({
          checkId: w.checkId, checkName: w.checkName, checkpointLabel: w.checkpointLabel, baselineRttMs: w.baselineRttMs,
          points: rows.filter((r) => r.source_id === w._sid && r.check_id === w.checkId && r.checkpoint_id === w._cp)
            .map((r) => ({ at: epochIso(r.sample_epoch) || sqlIso(r.captured_at), rttAvgMs: r.rtt_avg_ms, lossPct: r.loss_pct })),
        }));
      }
    } catch { worstLinkSeries = []; }

    const collectors = db.prepare('SELECT * FROM lm_collectors WHERE stale = 0 ORDER BY is_down DESC, hostname').all().map((c) => ({
      id: c.collector_id, sourceId: c.source_id, hostname: c.hostname || c.description, isDown: Number(c.is_down) === 1,
      build: c.build, behind: buildBehind(c.build, mgdFor(lk, c.source_id)), numberOfHosts: c.number_of_hosts,
    }));

    const spark = db.prepare(`
      SELECT substr(datetime(captured_at), 1, 16) k, SUM(COALESCE(alerts_critical, 0)) ac, SUM(COALESCE(interfaces_down, 0)) idn
      FROM lm_metrics_history GROUP BY k ORDER BY k DESC LIMIT 24
    `).all().reverse();

    res.json({
      sources,
      totals: {
        devices: dev.devices, networkDevices: dev.network_devices, devicesNormal: dev.normal, devicesDead: dev.dead,
        devicesDeadCollector: dev.dead_collector, devicesInSdt: sdtCount,
        interfaces: ifs.total, interfacesUp: ifs.up, interfacesDown: ifs.down,
        alertsCritical: al.critical, alertsWarning: al.warning, alertsInfo: al.info, alertsAcked: al.acked,
        collectors: col.total, collectorsDown: col.down,
        checks: cc.total, checksDown: cc.down, checksDegraded: cc.degraded,
        openIssues: issues.length,
        vendors: estate.vendors || 0, models: estate.models || 0, roles: estate.roles || 0,
        ...roundThreeTotals(),
      },
      byVendor, byRole, byHostStatus, alertsByDatasource, deadDevices, hotInterfaces, worstLinks, hotInterfaceSeries, worstLinkSeries, collectors,
      spark: { alertsCritical: spark.map((s) => s.ac), interfacesDown: spark.map((s) => s.idn) },
      issues: issues.map((i) => ({ severity: i.severity, type: i.type, target: i.target, message: i.message })),
    });
  } catch (err) { next(err); }
});

// Round 5 Overview (option B site map): one rollup computed from stored rows.
router.get('/overview', (req, res, next) => {
  try {
    res.json(require('../services/logicmonitorOverview').buildOverview(db, {
      helpers: { buildSites, buildDataQuality, safeIssues, locState },
    }));
  } catch (err) { next(err); }
});

// ---- Devices ---------------------------------------------------------------

const DEVICE_SORTS = {
  displayName: 'd.display_name', vendor: 'd.vendor', model: 'd.model', hostStatus: 'd.host_status',
  collectorName: 'collector_name', ifCount: 'd.if_count', openAlerts: 'open_alerts', firstSeen: 'd.first_seen',
};

function deviceFilters(q) {
  const where = ['d.stale = 0'];
  const params = [];
  if (q.q) {
    where.push("(d.display_name LIKE ? ESCAPE '\\' OR d.name LIKE ? ESCAPE '\\' OR d.hostname LIKE ? ESCAPE '\\' OR d.sysname LIKE ? ESCAPE '\\' OR d.ips_json LIKE ? ESCAPE '\\')");
    const p = likePat(q.q);
    params.push(p, p, p, p, p);
  }
  if (q.vendor) { where.push("COALESCE(d.vendor, 'Unknown') = ?"); params.push(q.vendor); }
  if (q.role) { where.push("COALESCE(d.role, 'other') = ?"); params.push(q.role); }
  if (q.hostStatus) { where.push('d.host_status = ?'); params.push(q.hostStatus); }
  if (q.collectorId != null && q.collectorId !== '') { where.push('d.collector_id = ?'); params.push(Number(q.collectorId)); }
  if (q.sourceId) { where.push('d.source_id = ?'); params.push(Number(q.sourceId)); }
  if (q.siteKey) { where.push('d.site_key = ?'); params.push(String(q.siteKey)); }
  if (q.groupId != null && q.groupId !== '') {
    where.push('EXISTS (SELECT 1 FROM json_each(CASE WHEN json_valid(d.group_ids_json) THEN d.group_ids_json ELSE \'[]\' END) je WHERE CAST(je.value AS INTEGER) = ?)');
    params.push(Number(q.groupId));
  }
  if (String(q.network) === '1') where.push('d.is_network = 1');
  return { whereSql: `WHERE ${where.join(' AND ')}`, params };
}

router.get('/devices', [
  query('q').optional().isString().trim().isLength({ max: 200 }),
  query('vendor').optional().isString().trim().isLength({ max: 64 }),
  query('role').optional().isString().trim().isLength({ max: 32 }),
  query('groupId').optional().isInt(),
  query('collectorId').optional().isInt(),
  query('sourceId').optional().isInt(),
  query('hostStatus').optional().isString().trim().isLength({ max: 32 }),
  query('siteKey').optional().matches(/^[a-z0-9-]{1,80}$/),
  query('network').optional().isIn(['0', '1']),
  query('sort').optional().isIn(Object.keys(DEVICE_SORTS)),
  query('dir').optional().isIn(['asc', 'desc']),
  query('page').optional().isInt({ min: 1 }),
  limitValidator,
], validate, (req, res, next) => {
  try {
    const lk = lookups();
    const { whereSql, params } = deviceFilters(req.query);
    const total = db.prepare(`SELECT COUNT(*) n FROM lm_devices d ${whereSql}`).get(...params).n;
    const { limit, page, offset } = pageArgs(req);
    const sortCol = DEVICE_SORTS[req.query.sort] || 'd.display_name';
    const dir = req.query.dir === 'desc' ? 'DESC' : 'ASC';
    const rows = db.prepare(`${DEVICE_SELECT} ${whereSql} ORDER BY ${sortCol} ${dir} NULLS LAST, d.source_id, d.lm_device_id LIMIT ? OFFSET ?`)
      .all(...params, limit, offset);
    res.json({ items: rows.map((r) => deviceOut(r, lk)), total, page, limit });
  } catch (err) { next(err); }
});

// Literal path before /devices/:id. Dell rule: the client posts the ids it
// shows, the server never re-runs the filter.
router.post('/devices/export', [
  body('ids').isArray({ max: 5000 }),
  body('ids.*').isInt().toInt(),
  body('sourceId').optional().isInt().toInt(),
], validate, (req, res, next) => {
  try {
    const lk = lookups();
    const ids = req.body.ids;
    const out = [];
    for (let i = 0; i < ids.length; i += 500) {
      const chunk = ids.slice(i, i + 500);
      if (!chunk.length) continue;
      const params = [...chunk];
      let extra = '';
      if (req.body.sourceId) { extra = ' AND d.source_id = ?'; params.push(req.body.sourceId); }
      out.push(...db.prepare(`${DEVICE_SELECT} WHERE d.lm_device_id IN (${chunk.map(() => '?').join(',')})${extra} ORDER BY d.display_name`).all(...params));
    }
    const rows = out.map((r) => {
      const d = deviceOut(r, lk);
      return {
        displayName: d.displayName, name: d.name, portal: d.sourceName, vendor: d.vendor, role: d.role, model: d.model,
        version: d.version, hostStatus: d.hostStatus, alertSeverity: d.alertSeverity, inSdt: d.inSdt ? 'yes' : 'no',
        collector: d.collectorName, groups: d.groups.join('; '), interfacesUp: d.ifUp, interfaces: d.ifCount,
        openAlerts: d.openAlerts, firstSeen: d.firstSeen,
      };
    });
    sendCsv(res, 'devices', rows, ['displayName', 'name', 'portal', 'vendor', 'role', 'model', 'version', 'hostStatus',
      'alertSeverity', 'inSdt', 'collector', 'groups', 'interfacesUp', 'interfaces', 'openAlerts', 'firstSeen']);
  } catch (err) { next(err); }
});

function propList(s) {
  const v = parseJson(s, []);
  if (Array.isArray(v)) return v.map((p) => ({ name: p && p.name, value: p && p.value })).filter((p) => p.name != null);
  if (v && typeof v === 'object') return Object.entries(v).map(([name, value]) => ({ name, value }));
  return [];
}

function findDevice(id, sourceId) {
  const params = [id];
  let extra = '';
  if (sourceId) { extra = ' AND d.source_id = ?'; params.push(sourceId); }
  return db.prepare(`${DEVICE_SELECT} WHERE d.lm_device_id = ?${extra} ORDER BY d.stale ASC, d.source_id ASC LIMIT 1`).get(...params);
}

/** Endpoint rows plus backupRuns7d (backup load windows on the port in 7 days) and backupLastWindow (ISO or null). */
function endpointsWithBackup(rows) {
  let byPort = new Map();
  try { byPort = lmEndpoints().backupLoadByPort(lmEndpoints().backupLoad(db, { days: 7 })); } catch { byPort = new Map(); }
  return rows.map((e) => {
    const b = e.instanceId != null ? byPort.get(`${e.sourceId}:${e.instanceId}`) : null;
    return { ...e, backupRuns7d: b ? b.count : 0, backupLastWindow: b ? b.lastWindow : null };
  });
}

router.get('/devices/:id', [param('id').isInt().toInt(), query('sourceId').optional().isInt().toInt()], validate, (req, res, next) => {
  try {
    const r = findDevice(req.params.id, req.query.sourceId);
    if (!r) return notFound(res, 'Device');
    const lk = lookups();
    const eri = parseJson(r.eri_json, {}) || {};
    const device = {
      ...deviceOut(r, lk),
      description: r.description, sysinfo: r.sysinfo, sysoid: r.sysoid, sysname: r.sysname, hostname: r.hostname,
      ips: parseArr(r.ips_json), serial: r.serial, ert: r.ert, eri,
      createdAt: epochIso(r.created_epoch), updatedAt: epochIso(r.updated_epoch),
    };
    const interfaces = db.prepare(`
      SELECT i.*, ? AS device_name FROM lm_interfaces i WHERE i.source_id = ? AND i.lm_device_id = ? AND i.stale = 0
      ORDER BY i.if_index IS NULL, i.if_index, i.display_name
    `).all(r.display_name, r.source_id, r.lm_device_id).map(interfaceOut);
    const openAlerts = db.prepare('SELECT * FROM lm_alerts WHERE source_id = ? AND lm_device_id = ? AND cleared = 0 ORDER BY severity DESC, start_epoch DESC')
      .all(r.source_id, r.lm_device_id);
    const clearedAlerts = db.prepare('SELECT * FROM lm_alerts WHERE source_id = ? AND lm_device_id = ? AND cleared = 1 ORDER BY COALESCE(end_epoch, start_epoch) DESC LIMIT 50')
      .all(r.source_id, r.lm_device_id);
    const groupIds = parseArr(r.group_ids_json).map(Number).filter(Number.isFinite);
    const sdtParams = [r.source_id, r.lm_device_id, ...groupIds];
    const sdts = db.prepare(`
      SELECT * FROM lm_sdts WHERE source_id = ? AND stale = 0 AND (lm_device_id = ?${groupIds.length ? ` OR group_id IN (${groupIds.map(() => '?').join(',')})` : ''})
      ORDER BY is_effective DESC, start_ms DESC
    `).all(...sdtParams).map(sdtOut);
    const ifStatus = new Map(interfaces.map((i) => [i.instanceId, i.statusText]));
    const nameOf = db.prepare('SELECT display_name FROM lm_devices WHERE source_id = ? AND lm_device_id = ?');
    const links = db.prepare(`
      SELECT l.*, i.status_text AS src_status_text FROM lm_topology_links l
      LEFT JOIN lm_interfaces i ON i.source_id = l.source_id AND i.instance_id = l.src_instance_id
      WHERE l.source_id = ? AND COALESCE(l.stale, 0) = 0 AND (l.src_device_id = ? OR l.dst_device_id = ?)
    `).all(r.source_id, r.lm_device_id, r.lm_device_id).map((l) => {
      const outbound = l.src_device_id === r.lm_device_id;
      const status = (outbound ? ifStatus.get(l.src_instance_id) : null) || l.src_status_text || 'unknown';
      return outbound
        ? { srcPort: l.src_port, dstName: l.dst_name, dstPort: l.dst_port, dstDeviceId: l.dst_device_id, protocol: l.protocol, confidence: l.confidence, status,
          dstPlatform: l.dst_platform || (l.dst_device_id != null ? 'logicmonitor' : null), dstRef: l.dst_ref || null }
        : { srcPort: l.dst_port, dstName: (nameOf.get(r.source_id, l.src_device_id) || {}).display_name || null, dstPort: l.src_port, dstDeviceId: l.src_device_id, protocol: l.protocol, confidence: l.confidence, status,
          dstPlatform: 'logicmonitor', dstRef: null };
    });
    // Round 2: switch-to-switch uplinks with the far-end interface status,
    // and the endpoints table.
    const rawLinks = db.prepare(`
      SELECT l.*, i.status_text AS src_status_text, i.status AS src_status,
        sd.display_name AS src_name, dd.display_name AS dst_display
      FROM lm_topology_links l
      LEFT JOIN lm_interfaces i ON i.source_id = l.source_id AND i.instance_id = l.src_instance_id
      LEFT JOIN lm_devices sd ON sd.source_id = l.source_id AND sd.lm_device_id = l.src_device_id
      LEFT JOIN lm_devices dd ON dd.source_id = l.source_id AND dd.lm_device_id = l.dst_device_id
      WHERE l.source_id = ? AND COALESCE(l.stale, 0) = 0 AND (l.src_device_id = ? OR l.dst_device_id = ?)
        AND (l.dst_platform = 'logicmonitor' OR (l.dst_platform IS NULL AND l.dst_device_id IS NOT NULL))
      ORDER BY l.src_port
    `).all(r.source_id, r.lm_device_id, r.lm_device_id);
    const ifacesOf = db.prepare('SELECT instance_id, display_name, status, status_text FROM lm_interfaces WHERE source_id = ? AND lm_device_id = ? AND stale = 0');
    const uplinks = rawLinks.map((l) => {
      const outbound = l.src_device_id === r.lm_device_id;
      const srcStatus = statusTextOf({ status_text: l.src_status_text, status: l.src_status });
      if (outbound) {
        const far = l.dst_device_id != null && l.dst_port
          ? lmEndpoints().matchPort(l.dst_port, ifacesOf.all(r.source_id, l.dst_device_id)).iface : null;
        return {
          srcPort: l.src_port, dstDeviceId: l.dst_device_id, dstName: l.dst_display || l.dst_name, dstPort: l.dst_port,
          protocol: l.protocol, confidence: l.confidence, status: ifStatus.get(l.src_instance_id) || srcStatus,
          farInstanceId: far ? far.instance_id : null, farStatus: far ? statusTextOf(far) : 'unknown',
        };
      }
      const near = l.dst_port ? lmEndpoints().matchPort(l.dst_port, ifacesOf.all(r.source_id, r.lm_device_id)).iface : null;
      return {
        srcPort: l.dst_port, dstDeviceId: l.src_device_id, dstName: l.src_name, dstPort: l.src_port,
        protocol: l.protocol, confidence: l.confidence, status: near ? statusTextOf(near) : 'unknown',
        farInstanceId: l.src_instance_id, farStatus: srcStatus,
      };
    });
    const c = lk.collectors.get(`${r.source_id}:${r.collector_id}`);
    res.json({
      device,
      properties: { system: propList(r.system_props_json), auto: propList(r.auto_props_json), custom: propList(r.custom_props_json) },
      interfaces,
      alerts: [...openAlerts, ...clearedAlerts].map(alertOut),
      sdts,
      links,
      uplinks,
      endpoints: endpointsWithBackup(lmEndpoints().endpointsForDevice(db, r.source_id, r.lm_device_id)),
      collector: c ? { id: c.collector_id, hostname: collectorName(c, r), isDown: Number(c.is_down) === 1, build: c.build } : null,
    });
  } catch (err) { next(err); }
});

const historyPoint = (h) => ({
  at: sqlIso(h.captured_at), status: h.status, inMbps: h.in_mbps, outMbps: h.out_mbps, inErrors: h.in_errors,
  outErrors: h.out_errors, inDiscards: h.in_discards, outDiscards: h.out_discards, inUtilPct: h.in_util_pct, outUtilPct: h.out_util_pct,
});
function interfacePoints(sourceId, instanceId, hours) {
  return db.prepare(`
    SELECT * FROM lm_interface_history WHERE source_id = ? AND instance_id = ? AND datetime(captured_at) >= datetime(?)
    ORDER BY datetime(captured_at) ASC, id ASC
  `).all(sourceId, instanceId, isoAgo(hours * 3600 * 1000)).map(historyPoint);
}

router.get('/devices/:id/interfaces/:instanceId/history', [
  param('id').isInt().toInt(), param('instanceId').isInt().toInt(),
  query('hours').optional().isInt({ min: 1, max: 2160 }).toInt(),
  query('sourceId').optional().isInt().toInt(),
], validate, (req, res, next) => {
  try {
    const params = [req.params.instanceId, req.params.id];
    let extra = '';
    if (req.query.sourceId) { extra = ' AND source_id = ?'; params.push(req.query.sourceId); }
    const iface = db.prepare(`SELECT source_id FROM lm_interfaces WHERE instance_id = ? AND lm_device_id = ?${extra} LIMIT 1`).get(...params);
    if (!iface) return notFound(res, 'Interface');
    const hours = req.query.hours || 24;
    const daily = db.prepare(`
      SELECT * FROM lm_interface_daily WHERE source_id = ? AND instance_id = ? ORDER BY day DESC LIMIT 30
    `).all(iface.source_id, req.params.instanceId).reverse().map((d) => ({
      day: d.day, maxInUtilPct: d.max_in_util_pct, maxOutUtilPct: d.max_out_util_pct, flaps: d.flaps, errorsSum: d.errors_sum,
    }));
    res.json({ points: interfacePoints(iface.source_id, req.params.instanceId, hours), daily });
  } catch (err) { next(err); }
});

// ---- Interfaces ------------------------------------------------------------

const IF_SORTS = {
  deviceName: 'device_name', displayName: 'i.display_name', statusText: 'i.status_text', speedBps: 'i.speed_bps',
  inUtilPct: 'i.in_util_pct', outUtilPct: 'i.out_util_pct', inErrors: 'i.in_errors', outErrors: 'i.out_errors',
  inDiscards: 'i.in_discards', sampledAt: 'i.sampled_at_epoch',
  maxUtil: 'MAX(COALESCE(i.in_util_pct, 0), COALESCE(i.out_util_pct, 0))',
};
const SPEED_CLASSES = {
  '<=100M': 'i.speed_bps > 0 AND i.speed_bps <= 100000000',
  '1G': 'i.speed_bps > 100000000 AND i.speed_bps <= 1000000000',
  '10G': 'i.speed_bps > 1000000000 AND i.speed_bps <= 10000000000',
  '25G+': 'i.speed_bps > 10000000000',
  unknown: '(i.speed_bps IS NULL OR i.speed_bps <= 0)',
};
const IF_STATUS_SQL = "COALESCE(i.status_text, CASE WHEN i.status IS NULL THEN 'unknown' WHEN i.status = 1 THEN 'up' WHEN i.status = 2 THEN 'down' ELSE 'other' END)";

function interfaceFilters(q) {
  const t = allThresholds();
  const where = ['i.stale = 0'];
  const params = [];
  if (q.q) {
    where.push("(i.display_name LIKE ? ESCAPE '\\' OR i.description LIKE ? ESCAPE '\\' OR i.instance_name LIKE ? ESCAPE '\\' OR d.display_name LIKE ? ESCAPE '\\')");
    const p = likePat(q.q);
    params.push(p, p, p, p);
  }
  if (q.deviceId != null && q.deviceId !== '') { where.push('i.lm_device_id = ?'); params.push(Number(q.deviceId)); }
  if (q.sourceId) { where.push('i.source_id = ?'); params.push(Number(q.sourceId)); }
  if (q.status) { where.push(`${IF_STATUS_SQL} = ?`); params.push(q.status); }
  if (q.speedClass) where.push(SPEED_CLASSES[q.speedClass]);
  if (q.vendor) { where.push("COALESCE(d.vendor, 'Unknown') = ?"); params.push(q.vendor); }
  if (q.siteKey) { where.push('d.site_key = ?'); params.push(String(q.siteKey)); }
  if (String(q.wan) === '1') where.push('i.is_wan = 1');
  if (q.groupId != null && q.groupId !== '') {
    where.push('EXISTS (SELECT 1 FROM json_each(CASE WHEN json_valid(d.group_ids_json) THEN d.group_ids_json ELSE \'[]\' END) je WHERE CAST(je.value AS INTEGER) = ?)');
    params.push(Number(q.groupId));
  }
  const since24 = isoAgo(24 * 3600 * 1000);
  switch (q.preset) {
    case 'down':
      where.push(`${IF_STATUS_SQL} = 'down' AND COALESCE(i.stop_monitoring, 0) = 0`);
      break;
    case 'hot':
      where.push('MAX(COALESCE(i.in_util_pct, 0), COALESCE(i.out_util_pct, 0)) >= ?');
      params.push(t.lm_if_util_warn_pct);
      break;
    case 'errors':
      where.push(`(SELECT COALESCE(SUM(COALESCE(h.in_errors, 0) + COALESCE(h.out_errors, 0)), 0) FROM lm_interface_history h
        WHERE h.source_id = i.source_id AND h.instance_id = i.instance_id AND datetime(h.captured_at) >= datetime(?)) > ?`);
      params.push(since24, t.lm_if_err_warn);
      break;
    case 'flapping':
      where.push(`(SELECT COUNT(*) FROM (
          SELECT h.status, LAG(h.status) OVER (ORDER BY datetime(h.captured_at), h.id) AS prev FROM lm_interface_history h
          WHERE h.source_id = i.source_id AND h.instance_id = i.instance_id AND datetime(h.captured_at) >= datetime(?)
        ) WHERE prev IS NOT NULL AND status IS NOT NULL AND status != prev) >= ?`);
      params.push(since24, t.lm_if_flap_warn);
      break;
    case 'unused':
      where.push(`${IF_STATUS_SQL} = 'up' AND (SELECT COUNT(*) FROM lm_interface_daily dd
        WHERE dd.source_id = i.source_id AND dd.instance_id = i.instance_id AND dd.day >= ?
          AND MAX(COALESCE(dd.max_in_util_pct, 0), COALESCE(dd.max_out_util_pct, 0)) < 1) >= 30`);
      params.push(new Date(Date.now() - 31 * 86400000).toISOString().slice(0, 10));
      break;
    default: break;
  }
  return { whereSql: `WHERE ${where.join(' AND ')}`, params };
}

const IF_FROM = `
  FROM lm_interfaces i
  LEFT JOIN lm_devices d ON d.source_id = i.source_id AND d.lm_device_id = i.lm_device_id
`;
const ifQueryRules = [
  query('q').optional().isString().trim().isLength({ max: 200 }),
  query('deviceId').optional().isInt(),
  query('sourceId').optional().isInt(),
  query('status').optional().isIn(['up', 'down', 'other', 'unknown']),
  query('speedClass').optional().isIn(Object.keys(SPEED_CLASSES)),
  query('groupId').optional().isInt(),
  query('vendor').optional().isString().trim().isLength({ max: 64 }),
  query('siteKey').optional().matches(/^[a-z0-9-]{1,80}$/),
  query('wan').optional().isIn(['0', '1']),
  query('preset').optional().isIn(['down', 'hot', 'errors', 'flapping', 'unused']),
  query('sort').optional().isIn(Object.keys(IF_SORTS)),
  query('dir').optional().isIn(['asc', 'desc']),
];

router.get('/interfaces', [...ifQueryRules, query('page').optional().isInt({ min: 1 }), limitValidator], validate, (req, res, next) => {
  try {
    const { whereSql, params } = interfaceFilters(req.query);
    const total = db.prepare(`SELECT COUNT(*) n ${IF_FROM} ${whereSql}`).get(...params).n;
    const { limit, page, offset } = pageArgs(req);
    const sortCol = IF_SORTS[req.query.sort] || 'device_name';
    const dir = req.query.dir === 'desc' ? 'DESC' : 'ASC';
    const rows = db.prepare(`
      SELECT i.*, d.display_name AS device_name, d.site_key AS site_key ${IF_FROM} ${whereSql}
      ORDER BY ${sortCol} ${dir} NULLS LAST, d.display_name, i.if_index, i.instance_id LIMIT ? OFFSET ?
    `).all(...params, limit, offset);
    res.json({ items: rows.map(interfaceOut), total, page, limit });
  } catch (err) { next(err); }
});

router.get('/interfaces.csv', ifQueryRules, validate, (req, res, next) => {
  try {
    const { whereSql, params } = interfaceFilters(req.query);
    const sortCol = IF_SORTS[req.query.sort] || 'device_name';
    const dir = req.query.dir === 'desc' ? 'DESC' : 'ASC';
    const rows = db.prepare(`
      SELECT i.*, d.display_name AS device_name, d.site_key AS site_key ${IF_FROM} ${whereSql}
      ORDER BY ${sortCol} ${dir} NULLS LAST, d.display_name, i.if_index, i.instance_id LIMIT 5000
    `).all(...params).map(interfaceOut);
    sendCsv(res, 'interfaces', rows, ['deviceName', 'displayName', 'description', 'alias', 'circuitId', 'carrier', 'ifIndex', 'statusText', 'speedBps',
      'inMbps', 'outMbps', 'inUtilPct', 'outUtilPct', 'inErrors', 'outErrors', 'inDiscards', 'outDiscards', 'sampledAt', 'alertStatus', 'siteKey', 'isWan']);
  } catch (err) { next(err); }
});

router.get('/interfaces/compare', [
  query('ids').isString().matches(/^\d+(,\d+)*$/),
  query('hours').optional().isInt({ min: 1, max: 2160 }).toInt(),
  query('sourceId').optional().isInt().toInt(),
], validate, (req, res, next) => {
  try {
    const ids = [...new Set(req.query.ids.split(',').map(Number))];
    if (ids.length < 2 || ids.length > 8) return res.status(400).json({ error: 'Compare takes 2 to 8 interfaces.' });
    const hours = req.query.hours || 24;
    const series = [];
    for (const id of ids) {
      const params = [id];
      let extra = '';
      if (req.query.sourceId) { extra = ' AND i.source_id = ?'; params.push(req.query.sourceId); }
      const i = db.prepare(`SELECT i.*, d.display_name AS device_name, d.site_key AS site_key ${IF_FROM} WHERE i.instance_id = ?${extra} LIMIT 1`).get(...params);
      if (!i) continue;
      series.push({ instanceId: id, deviceName: i.device_name, displayName: i.display_name, points: interfacePoints(i.source_id, id, hours) });
    }
    res.json({ series });
  } catch (err) { next(err); }
});

// ---- Alerts ----------------------------------------------------------------

const ALERT_SORTS = {
  startedAt: 'start_epoch', severity: 'severity', monitorObjectName: 'monitor_object_name',
  datasource: 'resource_template_name', dataPointName: 'data_point_name', acked: 'acked',
};

router.get('/alerts', [
  query('severity').optional().isIn(['critical', 'warning', 'info']),
  query('cleared').optional().isIn(['0', '1', 'all']),
  query('acked').optional().isIn(['0', '1']),
  query('q').optional().isString().trim().isLength({ max: 200 }),
  query('datasource').optional().isString().trim().isLength({ max: 255 }),
  query('deviceId').optional().isInt(),
  query('sourceId').optional().isInt(),
  query('shadowed').optional().isIn(['0', '1']),
  query('duplicate').optional().isIn(['0', '1', 'all']),
  query('sort').optional().isIn(Object.keys(ALERT_SORTS)),
  query('dir').optional().isIn(['asc', 'desc']),
  query('page').optional().isInt({ min: 1 }),
  limitValidator,
], validate, (req, res, next) => {
  try {
    const q = req.query;
    const where = [];
    const params = [];
    const cleared = q.cleared || '0';
    if (cleared !== 'all') { where.push('cleared = ?'); params.push(Number(cleared)); }
    if (q.severity) { where.push('severity_norm = ?'); params.push(q.severity); }
    if (q.acked) { where.push('COALESCE(acked, 0) = ?'); params.push(Number(q.acked)); }
    if (q.datasource) { where.push('resource_template_name = ?'); params.push(q.datasource); }
    if (q.deviceId != null && q.deviceId !== '') { where.push('lm_device_id = ?'); params.push(Number(q.deviceId)); }
    if (q.sourceId) { where.push('source_id = ?'); params.push(Number(q.sourceId)); }
    if (q.shadowed === '1') where.push('shadowed_by IS NOT NULL');
    if (q.shadowed === '0') where.push('shadowed_by IS NULL');
    // Round 9: alerts that relay a feed ICC polls directly stay out unless asked for.
    if (q.duplicate === '1') where.push('duplicate_of IS NOT NULL');
    else if (q.duplicate !== 'all') where.push('duplicate_of IS NULL');
    if (q.q) {
      where.push("(monitor_object_name LIKE ? ESCAPE '\\' OR resource_template_name LIKE ? ESCAPE '\\' OR instance_name LIKE ? ESCAPE '\\' OR data_point_name LIKE ? ESCAPE '\\')");
      const p = likePat(q.q);
      params.push(p, p, p, p);
    }
    const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';
    const total = db.prepare(`SELECT COUNT(*) n FROM lm_alerts ${whereSql}`).get(...params).n;
    const { limit, page, offset } = pageArgs(req);
    const sortCol = ALERT_SORTS[q.sort] || 'start_epoch';
    const dir = q.sort ? (q.dir === 'desc' ? 'DESC' : 'ASC') : (q.dir === 'asc' ? 'ASC' : 'DESC');
    const rows = db.prepare(`SELECT * FROM lm_alerts ${whereSql} ORDER BY ${sortCol} ${dir} NULLS LAST, id ASC LIMIT ? OFFSET ?`)
      .all(...params, limit, offset);
    const counts = db.prepare(`
      SELECT COALESCE(SUM(CASE WHEN severity_norm = 'critical' THEN 1 ELSE 0 END), 0) critical,
        COALESCE(SUM(CASE WHEN severity_norm = 'warning' THEN 1 ELSE 0 END), 0) warning,
        COALESCE(SUM(CASE WHEN severity_norm = 'info' THEN 1 ELSE 0 END), 0) info,
        COALESCE(SUM(CASE WHEN acked = 1 THEN 1 ELSE 0 END), 0) acked,
        COALESCE(SUM(CASE WHEN sdted = 1 THEN 1 ELSE 0 END), 0) sdted
      FROM lm_alerts WHERE cleared = 0 AND duplicate_of IS NULL
    `).get();
    let duplicates = { total: 0, byPlatform: [] };
    try { duplicates = require('../services/logicmonitorDuplicates').duplicateSummary(db); } catch { /* no duplicate model */ }
    res.json({ items: rows.map(alertOut), total, page, limit, counts, duplicates });
  } catch (err) { next(err); }
});

// ---- Collectors ------------------------------------------------------------

router.get('/collectors', (req, res, next) => {
  try {
    const lk = lookups();
    const devStmt = db.prepare(`
      SELECT lm_device_id, display_name, host_status FROM lm_devices
      WHERE source_id = ? AND collector_id = ? AND stale = 0
      ORDER BY CASE host_status WHEN 'normal' THEN 1 ELSE 0 END, display_name LIMIT 50
    `);
    res.json(db.prepare(`
      SELECT c.*, s.name AS source_name FROM lm_collectors c JOIN lm_sources s ON s.id = c.source_id
      WHERE c.stale = 0 ORDER BY c.is_down DESC, c.hostname
    `).all().map((c) => {
      const mgd = mgdFor(lk, c.source_id);
      return {
        id: c.collector_id, sourceId: c.source_id, sourceName: c.source_name, hostname: c.hostname,
        description: c.description, groupName: c.group_name, platform: c.platform, arch: c.arch, build: c.build,
        behind: buildBehind(c.build, mgd), mgd, status: c.status, isDown: Number(c.is_down) === 1,
        acked: Number(c.acked) === 1, inSdt: Number(c.in_sdt) === 1, numberOfHosts: c.number_of_hosts,
        numberOfInstances: c.number_of_instances, uptimeSeconds: c.uptime_seconds,
        devices: devStmt.all(c.source_id, c.collector_id).map((d) => ({ id: d.lm_device_id, displayName: d.display_name, hostStatus: d.host_status })),
        ea: bool(c.ea),
      };
    }));
  } catch (err) { next(err); }
});

// ---- Checks (site reachability) --------------------------------------------

router.get('/checks', [query('sourceId').optional().isInt().toInt()], validate, (req, res, next) => {
  try {
    const items = buildChecks(req.query.sourceId);
    res.json({ items, matrix: checksMatrix(items), counts: checkCounts(items) });
  } catch (err) { next(err); }
});

router.get('/checks/:checkId/history', [
  param('checkId').isString().isLength({ min: 1, max: 128 }),
  query('checkpointId').optional().isString().isLength({ max: 128 }),
  query('hours').optional().isInt({ min: 1, max: 2160 }).toInt(),
  query('sourceId').optional().isInt().toInt(),
], validate, (req, res, next) => {
  try {
    const params = [req.params.checkId];
    let extra = '';
    if (req.query.sourceId) { extra = ' AND source_id = ?'; params.push(req.query.sourceId); }
    const check = db.prepare(`SELECT source_id FROM lm_checks WHERE check_id = ?${extra} ORDER BY stale ASC LIMIT 1`).get(...params);
    if (!check) return notFound(res, 'Check');
    let cp = req.query.checkpointId;
    if (!cp) {
      const overall = db.prepare('SELECT checkpoint_id FROM lm_check_locations WHERE source_id = ? AND check_id = ? ORDER BY is_overall DESC, label LIMIT 1')
        .get(check.source_id, req.params.checkId);
      cp = overall ? overall.checkpoint_id : null;
    }
    const hours = req.query.hours || 24;
    const sinceSec = nowSec() - hours * 3600;
    const points = db.prepare(`
      SELECT * FROM lm_check_history WHERE source_id = ? AND check_id = ? AND checkpoint_id = ?
        AND (CASE WHEN sample_epoch IS NOT NULL THEN sample_epoch >= ? ELSE datetime(captured_at) >= datetime(?) END)
      ORDER BY COALESCE(sample_epoch, 0) ASC, id ASC
    `).all(check.source_id, req.params.checkId, cp, sinceSec, isoAgo(hours * 3600 * 1000)).map((h) => ({
      at: epochIso(h.sample_epoch) || sqlIso(h.captured_at), status: h.status, rttAvgMs: h.rtt_avg_ms,
      rttMinMs: h.rtt_min_ms, rttMaxMs: h.rtt_max_ms, lossPct: h.loss_pct, responseMs: h.response_ms,
    }));
    const baseline = db.prepare(`
      SELECT * FROM lm_check_baseline WHERE source_id = ? AND check_id = ? AND checkpoint_id = ? ORDER BY hour_of_day
    `).all(check.source_id, req.params.checkId, cp).map((b) => ({
      hour: b.hour_of_day, rttMedian: b.rtt_median, rttMad: b.rtt_mad, lossMedian: b.loss_median, lossMad: b.loss_mad, samples: b.samples,
    }));
    const daily = db.prepare(`
      SELECT * FROM lm_check_daily WHERE source_id = ? AND check_id = ? AND checkpoint_id = ? ORDER BY day DESC LIMIT 30
    `).all(check.source_id, req.params.checkId, cp).reverse().map((d) => ({
      day: d.day, rttAvg: d.rtt_avg, rttP95: d.rtt_p95, lossAvg: d.loss_avg, lossMax: d.loss_max, downSamples: d.down_samples,
    }));
    res.json({ checkpointId: cp, points, baseline, daily });
  } catch (err) { next(err); }
});

// ---- Latency watch (round 9) -------------------------------------------------
// Episodes from services/logicmonitorWatch.js. The first path segment 'watch'
// is the permission section (logicmonitor:watch:view).

const lmWatch = () => require('../services/logicmonitorWatch');
const WATCH_SORTS = ['openedAt', 'durationMin', 'peakRatio', 'peakMs', 'state', 'subjectLabel', 'siteKey', 'outcome'];
const WATCH_CSV = ['id', 'checkName', 'label', 'siteKey', 'kind', 'state', 'outcome', 'openedAt', 'closedAt', 'durationMin',
  'peakMs', 'peakRatio', 'lossMaxPct', 'baselineMedian', 'likelyHop'];
const watchRules = [
  query('siteKey').optional().isString().trim().isLength({ max: 128 }),
  query('checkId').optional().isString().trim().isLength({ max: 128 }),
  query('sourceId').optional().isInt().toInt(),
  query('state').optional().isIn(['watching', 'degrading', 'critical', 'closed']),
  query('outcome').optional().isIn(['one-off', 'sustained', 'escalated']),
  query('q').optional().isString().trim().isLength({ max: 200 }),
  query('days').optional().isInt({ min: 1, max: 365 }).toInt(),
  query('sort').optional().isIn(WATCH_SORTS),
  query('dir').optional().isIn(['asc', 'desc']),
];

/** Episode rows after the filters, as route items, sorted (newest first by default). */
function watchItems(q) {
  const days = q.days || 7;
  const where = ['(e.opened_at >= ? OR e.state != \'closed\')'];
  const args = [isoAgo(days * 86400000)];
  if (q.siteKey) { where.push('e.site_key = ?'); args.push(q.siteKey); }
  if (q.checkId) { where.push('e.check_id = ?'); args.push(q.checkId); }
  if (q.sourceId) { where.push('e.source_id = ?'); args.push(q.sourceId); }
  if (q.state) { where.push('e.state = ?'); args.push(q.state); }
  if (q.outcome) { where.push('e.outcome = ?'); args.push(q.outcome); }
  const rows = db.prepare(`SELECT e.* FROM lm_latency_episodes e WHERE ${where.join(' AND ')} ORDER BY e.opened_at DESC`).all(...args);
  const w = lmWatch();
  let items = rows.map((r) => {
    const v = w.episodeView(r);
    const at = String(v.subjectLabel || '').lastIndexOf(' @ ');
    return { ...v, checkName: at >= 0 ? v.subjectLabel.slice(0, at) : v.subjectLabel, label: at >= 0 ? v.subjectLabel.slice(at + 3) : null };
  });
  if (q.q) {
    const needle = String(q.q).toLowerCase();
    items = items.filter((i) => [i.subjectLabel, i.siteKey, i.likelyHop, i.kind, i.state, i.outcome].some((x) => String(x == null ? '' : x).toLowerCase().includes(needle)));
  }
  if (q.sort && WATCH_SORTS.includes(q.sort)) {
    const dir = q.dir === 'asc' ? 1 : -1;
    items = [...items].sort((a, b) => {
      const x = a[q.sort]; const y = b[q.sort];
      if (x == null && y == null) return 0;
      if (x == null) return 1;
      if (y == null) return -1;
      return dir * (typeof x === 'number' && typeof y === 'number' ? x - y : String(x).localeCompare(String(y), undefined, { numeric: true }));
    });
  }
  return items;
}

router.get('/watch/episodes', [...watchRules, query('page').optional().isInt({ min: 1 }), limitValidator], validate, (req, res, next) => {
  try {
    const items = watchItems(req.query);
    const { limit, page, offset } = pageArgs(req);
    res.json({ items: items.slice(offset, offset + limit), total: items.length, page, limit });
  } catch (err) { next(err); }
});

router.get('/watch/episodes.csv', watchRules, validate, (req, res, next) => {
  try {
    sendCsv(res, 'latency-episodes', watchItems(req.query).slice(0, 5000), WATCH_CSV);
  } catch (err) { next(err); }
});

router.get('/watch/summary', [
  query('siteKey').optional().isString().trim().isLength({ max: 128 }),
  query('days').optional().isInt({ min: 1, max: 365 }).toInt(),
], validate, (req, res, next) => {
  try {
    const days = req.query.days || 7;
    const siteKey = req.query.siteKey || null;
    const rows = db.prepare('SELECT * FROM lm_latency_episodes WHERE (opened_at >= ? OR state != \'closed\')' + (siteKey ? ' AND site_key = ?' : ''))
      .all(...[isoAgo(days * 86400000), ...(siteKey ? [siteKey] : [])]);
    const open = { watching: 0, degrading: 0, critical: 0 };
    const closed = { oneOff: 0, sustained: 0, escalated: 0 };
    const sites = new Map();
    const subjects = new Map();
    const siteRow = (k) => {
      const key = k || '';
      if (!sites.has(key)) sites.set(key, { siteKey: k || null, siteName: null, watching: 0, degrading: 0, critical: 0, oneOff7d: 0 });
      return sites.get(key);
    };
    for (const r of rows) {
      const s = siteRow(r.site_key);
      if (r.state !== 'closed') { open[r.state] += 1; s[r.state] += 1; }
      else if (r.outcome === 'one-off') { closed.oneOff += 1; s.oneOff7d += 1; }
      else if (r.outcome === 'sustained') closed.sustained += 1;
      else if (r.outcome === 'escalated') closed.escalated += 1;
      const sk = `${r.source_id}|${r.subject_key}`;
      const sub = subjects.get(sk) || { subjectLabel: r.subject_label, siteKey: r.site_key, count: 0, oneOff: 0, sustained: 0, escalated: 0, lastOpenedAt: null, peakRatio: null, openState: null };
      sub.count += 1;
      if (r.outcome === 'one-off') sub.oneOff += 1;
      else if (r.outcome === 'sustained') sub.sustained += 1;
      else if (r.outcome === 'escalated') sub.escalated += 1;
      if (r.state !== 'closed') sub.openState = r.state;
      if (!sub.lastOpenedAt || r.opened_at > sub.lastOpenedAt) sub.lastOpenedAt = r.opened_at;
      if (r.peak_ratio != null) sub.peakRatio = Math.max(sub.peakRatio == null ? 0 : sub.peakRatio, Math.round(r.peak_ratio * 100) / 100);
      subjects.set(sk, sub);
    }
    for (const s of sites.values()) {
      if (!s.siteKey) continue;
      const site = db.prepare('SELECT site_name FROM lm_sites WHERE site_key = ? LIMIT 1').get(s.siteKey);
      s.siteName = site ? site.site_name : s.siteKey;
    }

    // Repeating and drifting subjects come from the issue rules themselves.
    const srcMap = new Map(db.prepare('SELECT id, name FROM lm_sources').all().map((s) => [s.id, s.name]));
    const watchIssues = lmWatch().computeWatchIssues(db, lmIssues().getThresholds(), srcMap);
    let siteOfTarget = null;
    if (siteKey) {
      siteOfTarget = new Map(db.prepare(`
        SELECT c.name AS n, l.label AS lab, COALESCE(l.site_key, c.site_key) AS sk FROM lm_check_locations l
        JOIN lm_checks c ON c.source_id = l.source_id AND c.check_id = l.check_id WHERE l.is_overall = 0
      `).all().map((r) => [`${r.n} @ ${r.lab}`, r.sk]));
    }
    const inSite = (i) => !siteKey || siteOfTarget.get(i.target) === siteKey;
    const repeating = watchIssues.filter((i) => i.type === 'latency-pattern' && inSite(i)).length;
    const drifting = watchIssues.filter((i) => i.type === 'latency-drift' && inSite(i)).length;

    const topSubjects = [...subjects.values()]
      .sort((a, b) => b.count - a.count || String(b.lastOpenedAt).localeCompare(String(a.lastOpenedAt)))
      .slice(0, 10);
    const bySite = [...sites.values()].filter((s) => s.siteKey)
      .sort((a, b) => (b.critical - a.critical) || (b.degrading - a.degrading) || (b.watching - a.watching) || (b.oneOff7d - a.oneOff7d));
    res.json({ days, open, closed, repeating, drifting, bySite, topSubjects });
  } catch (err) { next(err); }
});

router.get('/watch/episodes/:id', [param('id').isInt({ min: 1 }).toInt()], validate, (req, res, next) => {
  try {
    const r = db.prepare('SELECT * FROM lm_latency_episodes WHERE id = ?').get(req.params.id);
    if (!r) return notFound(res, 'Episode');
    const w = lmWatch();
    const v = w.episodeView(r);
    const at = String(v.subjectLabel || '').lastIndexOf(' @ ');
    const openedS = Math.floor(Date.parse(r.opened_at) / 1000);
    const endS = r.closed_at ? Math.floor(Date.parse(r.closed_at) / 1000) : nowSec();
    let samples = [];
    if (r.subject_kind === 'check' && Number.isFinite(openedS)) {
      samples = db.prepare(`
        SELECT sample_epoch, status, rtt_avg_ms, loss_pct FROM lm_check_history
        WHERE source_id = ? AND check_id = ? AND checkpoint_id = ? AND sample_epoch >= ? AND sample_epoch <= ?
        ORDER BY sample_epoch ASC LIMIT 2000
      `).all(r.source_id, r.check_id, r.checkpoint_id, openedS - 1800, endS)
        .map((h) => ({ at: epochIso(h.sample_epoch), status: h.status, rttAvgMs: h.rtt_avg_ms, lossPct: h.loss_pct }));
    }
    res.json({
      ...v,
      checkName: at >= 0 ? v.subjectLabel.slice(0, at) : v.subjectLabel,
      label: at >= 0 ? v.subjectLabel.slice(at + 3) : null,
      baselineMad: r.baseline_mad,
      baselineSamples: r.baseline_samples,
      areaOverBaseline: r.area_over_baseline,
      samplesCount: r.samples,
      elevatedSamples: r.elevated_samples,
      trend: parseArr(r.trend_json),
      samples,
    });
  } catch (err) { next(err); }
});

// ---- Switch ports to endpoints, server path (round 2) ------------------------

const ENDPOINT_SORTS = ['deviceName', 'port', 'endpoint', 'endpointPlatform', 'portStatusText', 'protocol', 'lastSeen'];
const endpointQueryRules = [
  query('q').optional().isString().trim().isLength({ max: 200 }),
  query('platform').optional().isString().trim().isLength({ max: 32 }),
  query('deviceId').optional().isInt().toInt(),
  query('sourceId').optional().isInt().toInt(),
  query('sort').optional().isIn(ENDPOINT_SORTS),
  query('dir').optional().isIn(['asc', 'desc']),
];

function filteredEndpoints(q) {
  const lc = (v) => String(v == null ? '' : v).toLowerCase();
  let rows = lmEndpoints().endpointsAll(db);
  if (q.platform) rows = rows.filter((r) => r.endpointPlatform === q.platform);
  if (q.deviceId != null && q.deviceId !== '') rows = rows.filter((r) => r.deviceId === Number(q.deviceId));
  if (q.sourceId) rows = rows.filter((r) => r.sourceId === Number(q.sourceId));
  if (q.q) {
    const needle = lc(q.q);
    rows = rows.filter((r) => [r.deviceName, r.port, r.endpoint, r.nic, r.switchName].some((v) => lc(v).includes(needle)));
  }
  if (q.sort && ENDPOINT_SORTS.includes(q.sort)) {
    const dir = q.dir === 'desc' ? -1 : 1;
    const k = q.sort;
    rows = [...rows].sort((a, b) => {
      const x = a[k]; const y = b[k];
      if (x == null && y == null) return 0;
      if (x == null) return 1;
      if (y == null) return -1;
      return dir * String(x).localeCompare(String(y), undefined, { numeric: true });
    });
  }
  return rows;
}

router.get('/endpoints', [...endpointQueryRules, query('page').optional().isInt({ min: 1 }), limitValidator], validate, (req, res, next) => {
  try {
    const rows = filteredEndpoints(req.query);
    const { limit, page, offset } = pageArgs(req);
    res.json({ items: rows.slice(offset, offset + limit), total: rows.length, page, limit });
  } catch (err) { next(err); }
});

router.get('/endpoints.csv', endpointQueryRules, validate, (req, res, next) => {
  try {
    sendCsv(res, 'endpoints', filteredEndpoints(req.query).slice(0, 5000), ENDPOINT_CSV);
  } catch (err) { next(err); }
});

/** The server-object path for a host or VM: switch ports, one hop of
 *  uplinks, reachability checks. ip may repeat or be comma separated. */
router.get('/server-path', [
  query('name').optional().isString().trim().isLength({ max: 255 }),
  query('ip').optional(),
], validate, (req, res, next) => {
  try {
    const name = String(req.query.name || '').trim();
    const ipRaw = Array.isArray(req.query.ip) ? req.query.ip : (req.query.ip ? [req.query.ip] : []);
    const ips = ipRaw.flatMap((v) => String(v).split(',')).map((v) => v.trim()).filter((v) => v && v.length <= 64).slice(0, 16);
    if (!name && !ips.length) return res.status(400).json({ error: 'name or ip required' });
    const names = name ? [name] : [];
    const ctx = lmPath().makeContext(db);
    const sp = lmEndpoints().serverPath(db, { names, ips }, { endpoints: ctx.endpoints() });
    const path = lmPath().pathFor(db, { names, ips }, { ctx });
    const blame = lmPath().blame(path);
    if (blame && blame.state !== 'ok') {
      // Blame history: one row per subject and hop per hour.
      const subject = (sp.anchor && sp.anchor.name) || name || ips[0] || null;
      lmCorrelation().recordBlame(db, {
        sourceId: blame.sourceId, kind: 'server', subject, subjectKey: subject ? String(subject).toLowerCase() : null,
        blame, siteKey: blame.siteKey || null, dedupeSince: new Date(Date.now() - 3600000).toISOString().replace('T', ' ').slice(0, 19),
      });
    }
    res.json({ ...sp, path, blame });
  } catch (err) { next(err); }
});

// ---- Sites (round 3) -------------------------------------------------------

const SEV_RANK = { ok: 0, warning: 1, critical: 2 };
const worseOf = (a, b) => (SEV_RANK[b] > SEV_RANK[a] ? b : a);

/** 'down' | 'degraded' | 'ok' for one evaluated check location, plus its severity. */
function locState(e) {
  if (e.anomaly === 'down' || e.status === 'down') return { state: 'down', severity: 'critical' };
  if (e.anomaly) return { state: 'degraded', severity: e.severity === 'critical' ? 'critical' : 'warning' };
  return { state: 'ok', severity: 'ok' };
}

/**
 * Site rollup rows (one per portal and site). state is the worst of: a dead
 * network device (critical, other dead devices warning), a WAN circuit's
 * state, a reachability check into or out of the site (down or a critical
 * anomaly critical, other anomalies warning) and a down collector (critical).
 */
function buildSites({ sourceId = null, siteKey = null } = {}) {
  const where = [];
  const args = [];
  if (sourceId != null) { where.push('s.source_id = ?'); args.push(sourceId); }
  if (siteKey) { where.push('s.site_key = ?'); args.push(siteKey); }
  const sites = db.prepare(`
    SELECT s.*, src.name AS source_name FROM lm_sites s JOIN lm_sources src ON src.id = s.source_id
    ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY s.site_name, s.source_id
  `).all(...args);
  if (!sites.length) return [];
  const devices = db.prepare('SELECT source_id, lm_device_id, site_key, host_status, is_network, collector_id FROM lm_devices WHERE stale = 0 AND site_key IS NOT NULL').all();
  // Round 12: every collector (sited or not) so a site can name the collectors that poll its devices.
  const allCollectors = new Map(db.prepare('SELECT source_id, collector_id, hostname, description, is_down, site_key FROM lm_collectors WHERE stale = 0').all()
    .map((c) => [`${c.source_id}:${c.collector_id}`, c]));
  const siteNames = new Map(sites.map((x) => [`${x.source_id}:${x.site_key}`, x.site_name || x.site_key]));
  const ifDown = new Map(db.prepare(`
    SELECT source_id, lm_device_id, COUNT(*) n FROM lm_interfaces
    WHERE stale = 0 AND status_text = 'down' AND COALESCE(stop_monitoring, 0) = 0 GROUP BY source_id, lm_device_id
  `).all().map((r) => [`${r.source_id}:${r.lm_device_id}`, r.n]));
  const collectors = db.prepare('SELECT source_id, collector_id, hostname, description, is_down, site_key FROM lm_collectors WHERE stale = 0 AND site_key IS NOT NULL').all();
  const checks = db.prepare('SELECT source_id, check_id, name, site_key FROM lm_checks WHERE stale = 0 AND site_key IS NOT NULL').all();
  const locSite = new Map(db.prepare('SELECT source_id, check_id, checkpoint_id, site_key FROM lm_check_locations WHERE stale = 0 AND site_key IS NOT NULL').all()
    .map((l) => [`${l.source_id}|${l.check_id}|${l.checkpoint_id}`, l.site_key]));
  let evaluated = [];
  try { evaluated = lmChecks().evaluateLocations(db); } catch { evaluated = []; }
  const evalByCheck = new Map();
  for (const e of evaluated) {
    const k = `${e.sourceId}|${e.checkId}`;
    if (!evalByCheck.has(k)) evalByCheck.set(k, []);
    evalByCheck.get(k).push(e);
  }
  let circuits = [];
  try { circuits = lmPath().circuitRows(db, { sourceId }); } catch { circuits = []; }
  let endpoints = [];
  try { endpoints = lmEndpoints().endpointsAll(db); } catch { endpoints = []; }
  const netDevs = new Map();
  for (const d of devices) if (Number(d.is_network) === 1) netDevs.set(`${d.source_id}:${d.lm_device_id}`, d.site_key);

  return sites.map((st) => {
    const devs = devices.filter((d) => d.source_id === st.source_id && d.site_key === st.site_key);
    let state = 'ok';
    const dead = devs.filter((d) => d.host_status === 'dead');
    if (dead.some((d) => Number(d.is_network) === 1)) state = 'critical';
    else if (dead.length) state = worseOf(state, 'warning');
    const circ = circuits.filter((c) => c.sourceId === st.source_id && c.siteKey === st.site_key);
    for (const c of circ) state = worseOf(state, c.state);
    const cols = collectors.filter((c) => c.source_id === st.source_id && c.site_key === st.site_key);
    if (cols.some((c) => Number(c.is_down) === 1)) state = 'critical';
    const reachabilityIn = [];
    for (const c of checks.filter((x) => x.source_id === st.source_id && x.site_key === st.site_key)) {
      const locs = (evalByCheck.get(`${c.source_id}|${c.check_id}`) || []);
      const per = locs.filter((l) => !l.isOverall);
      const pool = per.length ? per : locs;
      let worst = null;
      for (const l of pool) {
        const ls = locState(l);
        if (!worst || SEV_RANK[ls.severity] > SEV_RANK[worst.ls.severity] || (ls.severity === worst.ls.severity && (l.rttAvgMs || 0) > (worst.l.rttAvgMs || 0))) worst = { l, ls };
      }
      if (!worst) continue;
      state = worseOf(state, worst.ls.severity);
      reachabilityIn.push({ checkName: c.name, fromLabel: worst.l.label, state: worst.ls.state, rttAvgMs: worst.l.rttAvgMs, lossPct: worst.l.lossPct, anomaly: worst.l.anomaly || null });
    }
    const reachabilityOut = [];
    for (const l of evaluated) {
      if (l.sourceId !== st.source_id || locSite.get(`${l.sourceId}|${l.checkId}|${l.checkpointId}`) !== st.site_key) continue;
      const ls = locState(l);
      state = worseOf(state, ls.severity);
      reachabilityOut.push({ checkName: l.checkName, fromLabel: l.label, state: ls.state, rttAvgMs: l.rttAvgMs, lossPct: l.lossPct, anomaly: l.anomaly || null });
    }
    const polling = new Map();
    for (const d of devs) {
      if (d.collector_id == null) continue;
      polling.set(d.collector_id, (polling.get(d.collector_id) || 0) + 1);
    }
    const pollingCollectors = [...polling.entries()].map(([id, n]) => {
      if (id < 0) return { id, hostname: 'LogicMonitor cloud', siteKey: null, siteName: null, isDown: false, devices: n };
      const c = allCollectors.get(`${st.source_id}:${id}`);
      return {
        id, hostname: c ? (c.hostname || c.description || `collector ${id}`) : `collector ${id}`,
        siteKey: c ? (c.site_key || null) : null, siteName: c && c.site_key ? (siteNames.get(`${st.source_id}:${c.site_key}`) || c.site_key) : null,
        isDown: !!c && Number(c.is_down) === 1, devices: n,
      };
    }).sort((a, b) => b.devices - a.devices || String(a.hostname).localeCompare(String(b.hostname)));
    return {
      siteKey: st.site_key, siteName: st.site_name || st.site_key, source: st.source_name, sourceId: st.source_id,
      pollingCollectors,
      deviceCount: devs.length, networkCount: devs.filter((d) => Number(d.is_network) === 1).length,
      devicesDead: dead.length,
      interfacesDown: devs.reduce((n, d) => n + (ifDown.get(`${d.source_id}:${d.lm_device_id}`) || 0), 0),
      circuits: circ.map((c) => ({ deviceName: c.deviceName, port: c.port, state: c.state, p95InPct: c.p95InPct, p95OutPct: c.p95OutPct })),
      collectors: cols.map((c) => ({ id: c.collector_id, hostname: c.hostname || c.description, isDown: Number(c.is_down) === 1 })),
      reachabilityIn, reachabilityOut,
      servers: endpoints.filter((e) => netDevs.get(`${e.sourceId}:${e.deviceId}`) === st.site_key && e.sourceId === st.source_id).length,
      state,
    };
  }).sort((a, b) => SEV_RANK[b.state] - SEV_RANK[a.state] || String(a.siteName).localeCompare(String(b.siteName)));
}

router.get('/sites', [query('sourceId').optional().isInt().toInt()], validate, (req, res, next) => {
  try { res.json(buildSites({ sourceId: req.query.sourceId != null ? req.query.sourceId : null })); } catch (err) { next(err); }
});

router.get('/sites/:siteKey', [
  param('siteKey').matches(/^[a-z0-9-]{1,80}$/),
  query('sourceId').optional().isInt().toInt(),
], validate, (req, res, next) => {
  try {
    const rows = buildSites({ sourceId: req.query.sourceId != null ? req.query.sourceId : null, siteKey: req.params.siteKey });
    if (!rows.length) return notFound(res, 'Site');
    const row = rows[0];
    const lk = lookups();
    const endpoints = lmEndpoints().endpointsAll(db);
    const devices = reviewRows('AND d.site_key = ? AND d.source_id = ?', [row.siteKey, row.sourceId], endpoints, lk, newestByModel());
    const devIds = new Set(devices.map((d) => d.id));
    const downRows = db.prepare(`
      SELECT i.*, d.display_name AS device_name, d.site_key AS site_key FROM lm_interfaces i
      JOIN lm_devices d ON d.source_id = i.source_id AND d.lm_device_id = i.lm_device_id
      WHERE d.stale = 0 AND d.site_key = ? AND d.source_id = ? AND i.stale = 0 AND i.status_text = 'down' AND COALESCE(i.stop_monitoring, 0) = 0
      ORDER BY d.display_name, i.if_index LIMIT 500
    `).all(row.siteKey, row.sourceId).map(interfaceOut);
    // Open ICC issues aimed at a device, an interface of it, a collector or a check of the site.
    const names = new Set();
    for (const d of devices) { if (d.displayName) names.add(String(d.displayName).toLowerCase()); if (d.name) names.add(String(d.name).toLowerCase()); }
    for (const c of row.collectors) if (c.hostname) names.add(String(c.hostname).toLowerCase());
    for (const c of db.prepare('SELECT name FROM lm_checks WHERE source_id = ? AND site_key = ? AND stale = 0').all(row.sourceId, row.siteKey)) names.add(String(c.name).toLowerCase());
    const openIssues = db.prepare("SELECT * FROM lm_issue_history WHERE status = 'open' AND source = ? ORDER BY first_seen").all(row.source)
      .filter((r) => {
        const t = String(r.target || '').toLowerCase();
        if (names.has(t)) return true;
        for (const n of names) if (n && t.startsWith(`${n} `)) return true;
        return false;
      })
      .map((r) => ({ severity: r.severity, type: r.type, source: r.source, target: r.target, message: r.message, firstSeen: sqlIso(r.first_seen) }));
    let recentChanges = [];
    try {
      recentChanges = require('../services/configLedger').listChanges({ days: 7, platform: 'logicmonitor', limit: 1000 })
        .filter((c) => names.has(String(c.item || '').toLowerCase()))
        .slice(0, 100)
        .map((c) => ({ id: c.id, scope: c.scope, system: c.system, item: c.item, changeType: c.change_type, oldValue: c.old_value, newValue: c.new_value, detectedAt: sqlIso(c.detected_at) }));
    } catch { recentChanges = []; }
    let correlation = { backupLoad: 0, replication: 0, changes: 0, blames: 0 };
    try { correlation = lmCorrelation().siteCounts(db, row.siteKey, row.sourceId); } catch { /* zeros */ }
    res.json({
      ...row, interfacesDown: downRows, devices, openIssues, recentChanges, correlation,
      endpoints: endpoints.filter((e) => e.sourceId === row.sourceId && devIds.has(e.deviceId)).slice(0, 500),
    });
  } catch (err) { next(err); }
});

// ---- Circuits (round 3) ----------------------------------------------------

router.get('/circuits', [
  query('sourceId').optional().isInt().toInt(),
  query('cloud').optional().isIn(['0', '1']),
  query('siteKey').optional().matches(/^[a-z0-9-]{1,80}$/),
  query('state').optional().isIn(['ok', 'warning', 'critical']),
], validate, (req, res, next) => {
  try {
    let rows = lmPath().circuitRows(db, { sourceId: req.query.sourceId != null ? req.query.sourceId : null, siteKey: req.query.siteKey || null });
    if (req.query.state) rows = rows.filter((r) => r.state === req.query.state);
    // Round 9: ?cloud=1 answers {items, cloud} (AWS Direct Connect, Azure ExpressRoute). The plain
    // request stays a bare array so existing callers keep working.
    if (req.query.cloud === '1') {
      let cloud = [];
      try {
        cloud = require('../services/logicmonitorCloud').cloudCircuits(db, require('../services/logicmonitorIssues').getThresholds(), {
          sourceId: req.query.sourceId != null ? req.query.sourceId : undefined, siteKey: req.query.siteKey || null,
        });
      } catch { cloud = []; }
      return res.json({ items: rows, cloud });
    }
    res.json(rows);
  } catch (err) { next(err); }
});

// Round 12: WAN circuits whose carrier could not be read, so the settings panel can offer aliases.
// /circuits stays a bare array; the list lives here.
router.get('/circuits/unknown-carriers', (req, res, next) => {
  try {
    res.json(lmPath().circuitRows(db).filter((r) => !r.carrier).slice(0, 200)
      .map((r) => ({ deviceName: r.deviceName, port: r.port, label: r.label })));
  } catch (err) { next(err); }
});

// ---- Site circuits (round 13) ------------------------------------------------
// Roles (wan / site-link / uplink), the per-site WAN picture, the circuit event log with operator
// notes, and the site-to-site circuit map. Logic lives in services/logicmonitorCircuits.js.

const lmCircuits = () => require('../services/logicmonitorCircuits');

router.get('/sites/:siteKey/circuits', [
  param('siteKey').matches(/^[a-z0-9-]{1,80}$/),
  query('sourceId').optional().isInt().toInt(),
], validate, (req, res, next) => {
  try {
    const out = lmCircuits().siteCircuits(db, req.params.siteKey, { sourceId: req.query.sourceId != null ? req.query.sourceId : null });
    if (!out) return notFound(res, 'Site');
    res.json(out);
  } catch (err) { next(err); }
});

const circuitEventRules = [
  query('siteKey').optional().matches(/^[a-z0-9-]{1,80}$/),
  query('instanceId').optional().isInt().toInt(),
  query('event').optional().isIn(['down', 'up', 'flap-start', 'flap-stop', 'saturated', 'cleared']),
  query('days').optional().isInt({ min: 1, max: 1095 }).toInt(),
  query('q').optional().isString().trim().isLength({ max: 120 }),
];
const circuitEventFilter = (req) => ({
  siteKey: req.query.siteKey || null, instanceId: req.query.instanceId != null ? req.query.instanceId : null,
  event: req.query.event || null, days: req.query.days || 30, q: req.query.q || null,
});

router.get('/circuits/events', [
  ...circuitEventRules,
  query('page').optional().isInt({ min: 1 }).toInt(),
  query('pageSize').optional().isInt({ min: 1, max: 500 }).toInt(),
  limitValidator,
], validate, (req, res, next) => {
  try {
    const pageSize = req.query.pageSize || (req.query.limit === 'all' ? 500 : parseInt(req.query.limit, 10)) || 50;
    res.json(lmCircuits().listEvents(db, { ...circuitEventFilter(req), page: req.query.page || 1, pageSize }));
  } catch (err) { next(err); }
});

const CIRCUIT_EVENT_CSV = ['at', 'event', 'deviceName', 'port', 'role', 'siteKey', 'farSiteKey', 'note', 'notedBy', 'issueKey'];
router.get('/circuits/events.csv', circuitEventRules, validate, (req, res, next) => {
  try {
    sendCsv(res, 'circuit-events', lmCircuits().listEvents(db, { ...circuitEventFilter(req), page: 1, pageSize: 5000 }).rows, CIRCUIT_EVENT_CSV);
  } catch (err) { next(err); }
});

router.put('/circuits/events/:id/note', [
  param('id').isInt({ min: 1 }).toInt(),
  body('note').isString().trim().isLength({ min: 1, max: 2000 }),
], validate, (req, res, next) => {
  try {
    const by = req.auth?.user?.username || req.user?.username || 'unknown';
    const row = lmCircuits().setEventNote(db, req.params.id, req.body.note, by);
    if (!row) return notFound(res, 'Circuit event');
    res.json(row);
  } catch (err) { next(err); }
});

router.get('/circuit-map', [query('sourceId').optional().isInt().toInt()], validate, (req, res, next) => {
  try {
    res.json(lmCircuits().circuitMap(db, { sourceId: req.query.sourceId != null ? req.query.sourceId : null }));
  } catch (err) { next(err); }
});

// ---- Raw datapoint rules (round 12) -----------------------------------------
// Rules live in the text setting lm_raw_rules; every save re-evaluates the issues so the Issues page
// shows the result without waiting for the next tick.

const lmRawRules = () => require('../services/logicmonitorRawRules');

router.get('/raw-rules', (req, res, next) => {
  try { res.json({ rules: lmRawRules().parseRules(lmIssues().getTextSetting('lm_raw_rules')) }); } catch (err) { next(err); }
});

router.put('/raw-rules', (req, res, next) => {
  try {
    const v = lmRawRules().validateRules(req.body && req.body.rules);
    if (v.error) return res.status(400).json({ error: v.error });
    const text = JSON.stringify(v.rules);
    if (text.length > defs().lm_raw_rules.maxLength) return res.status(400).json({ error: 'the rules are too large to store' });
    setSetting('lm_raw_rules', text);
    let issues = null;
    try {
      lmIssues().reconcileIssueHistory();
      issues = db.prepare("SELECT COUNT(*) n FROM lm_issue_history WHERE type = 'raw-threshold' AND status = 'open'").get().n;
    } catch { /* the next tick will reconcile */ }
    res.json({ rules: v.rules, raw_threshold_issues: issues });
  } catch (err) { next(err); }
});

router.post('/raw-rules/preview', (req, res, next) => {
  try {
    const out = lmRawRules().previewRule(db, req.body && req.body.rule);
    if (out.error) return res.status(400).json({ error: out.error });
    res.json(out);
  } catch (err) { next(err); }
});

// Literal path before /circuits/:instanceId/profile. Mounted behind the
// platform's manage permission (POST on the circuits section).
router.post('/circuits/recompute', (req, res, next) => {
  try {
    const r = lmPath().computeCircuits(db);
    res.json({ marked: r.marked });
  } catch (err) { next(err); }
});

router.get('/circuits/:instanceId/profile', [
  param('instanceId').isInt().toInt(),
  query('sourceId').optional().isInt().toInt(),
], validate, (req, res, next) => {
  try {
    const p = lmPath().circuitProfile(db, req.params.instanceId, req.query.sourceId != null ? req.query.sourceId : null);
    if (!p) return notFound(res, 'Circuit');
    res.json(p);
  } catch (err) { next(err); }
});

// ---- Full data export and discovery ------------------------------------------
// Under /settings so the settings:view grant gates it (it includes admins).

// Time-series and raw payload tables; only exported with ?history=1.
const EXPORT_HISTORY_TABLES = new Set(['lm_interface_history', 'lm_interface_daily', 'lm_check_history', 'lm_check_daily',
  'lm_check_baseline', 'lm_interface_baseline', 'lm_metrics_history', 'lm_webhook_events', 'lm_blame_history', 'lm_issue_history']);
const SECRET_COL_RE = /credential|token|secret|password|access_?key/i;
// LM property names that carry credentials (snmp.auth, aws.accesskeyid, ise.dev.pass, ...).
const SECRET_PROP_RE = /pass|secret|token|key(id)?$|accesskey|community|snmp\.(auth|priv)|cert|credential/i;
function redactProps(v) {
  if (Array.isArray(v)) return v.map(redactProps);
  if (!v || typeof v !== 'object') return v;
  const out = {};
  for (const [k, x] of Object.entries(v)) out[k] = SECRET_PROP_RE.test(k) && (x == null || typeof x !== 'object') ? '[redacted]' : redactProps(x);
  return out;
}

function exportRows(table, withRaw) {
  const cols = db.prepare(`PRAGMA table_info('${table}')`).all().map((c) => c.name)
    .filter((c) => !SECRET_COL_RE.test(c) && (withRaw || c !== 'raw_json'));
  if (!cols.length) return [];
  return db.prepare(`SELECT ${cols.map((c) => `"${c}"`).join(', ')} FROM "${table}"`).all().map((r) => {
    for (const c of cols) if (/_json$/.test(c) && typeof r[c] === 'string') r[c] = redactProps(parseJson(r[c], r[c]));
    return r;
  });
}

/** What the portals send: vendors/roles, datasources seen per vendor, property keys, circuit coverage. */
function discoveryReport() {
  const out = {};
  out.devicesByVendorRole = db.prepare(`
    SELECT COALESCE(vendor, 'Unknown') vendor, COALESCE(role, 'unknown') role, is_network isNetwork, COUNT(*) devices
    FROM lm_devices WHERE stale = 0 GROUP BY 1, 2, 3 ORDER BY devices DESC
  `).all();
  const healthNames = lmApi().HEALTH_DATASOURCES.map((h) => h.name);
  const uptime = lmApi().UPTIME_DATASOURCES;
  out.datasources = db.prepare(`
    SELECT x.datasource_name name, MAX(x.datasource_display_name) displayName, COUNT(DISTINCT x.source_id || ':' || x.lm_device_id) devices,
      SUM(COALESCE(x.instance_count, 0)) instances, MAX(x.is_interface) isInterface, MAX(x.is_neighbor) isNeighbor,
      GROUP_CONCAT(DISTINCT COALESCE(d.vendor, 'Unknown')) vendors
    FROM lm_device_datasources x LEFT JOIN lm_devices d ON d.source_id = x.source_id AND d.lm_device_id = x.lm_device_id
    WHERE COALESCE(x.instance_count, 0) > 0
    GROUP BY x.datasource_name ORDER BY devices DESC, name
  `).all().map((r) => {
    let collected = 'inventory only';
    const cat = r.isInterface || r.isNeighbor ? null : catalogEntry(r.name);
    if (r.isInterface) collected = 'instances + metrics';
    else if (cat) collected = `metrics (${cat.family})`;
    else if (r.isNeighbor) collected = 'topology (LLDP/CDP)';
    else if (uptime.includes(r.name)) collected = 'reachability checks';
    else if (healthNames.some((n) => r.name && r.name.startsWith(n))) collected = 'alert labels only';
    return { ...r, isInterface: !!r.isInterface, isNeighbor: !!r.isNeighbor, collected };
  });
  const keyCatalog = (rows, scopes) => {
    const m = new Map();
    for (const r of rows) {
      for (const [scope, raw] of scopes(r)) {
        const map = typeof raw === 'string' ? parseJson(raw, {}) : (raw || {});
        for (const [k, v] of Object.entries(map)) {
          const key = `${scope}|${k}`;
          const e = m.get(key) || { scope, key: k, count: 0, sample: null };
          e.count += 1;
          if (e.sample == null && v != null && v !== '') e.sample = SECRET_PROP_RE.test(k) ? '[redacted]' : String(v).slice(0, 120);
          m.set(key, e);
        }
      }
    }
    return [...m.values()].sort((a, b) => b.count - a.count || a.key.localeCompare(b.key));
  };
  out.devicePropertyKeys = keyCatalog(
    db.prepare('SELECT system_props_json, auto_props_json, custom_props_json FROM lm_devices WHERE stale = 0').all(),
    (r) => [['system', r.system_props_json], ['auto', r.auto_props_json], ['custom', r.custom_props_json]],
  );
  const ifRows = db.prepare('SELECT description, props_json, is_wan FROM lm_interfaces WHERE stale = 0').all();
  out.interfacePropertyKeys = keyCatalog(ifRows, (r) => {
    const p = parseJson(r.props_json, {});
    return [['system', p.system], ['auto', p.auto], ['custom', p.custom]];
  });
  const cov = { interfaces: ifRows.length, withDescription: 0, withAlias: 0, withCircuitId: 0, wan: 0, wanWithCircuitId: 0, circuitIdSources: {} };
  const covAliases = lmPath().loadCarrierAliases();
  for (const r of ifRows) {
    const ci = lmPath().circuitInfo(r.description, r.props_json, covAliases);
    if (r.description) cov.withDescription += 1;
    if (ci.alias) cov.withAlias += 1;
    if (Number(r.is_wan) === 1) cov.wan += 1;
    if (ci.circuitId) {
      cov.withCircuitId += 1;
      if (Number(r.is_wan) === 1) cov.wanWithCircuitId += 1;
      const s = String(ci.source).split(':').slice(0, 2).join(':');
      cov.circuitIdSources[s] = (cov.circuitIdSources[s] || 0) + 1;
    }
  }
  out.circuitCoverage = cov;
  // Round 9: what the cross-platform identity index knows and how many links resolved through it.
  out.identity = (() => {
    const res = { refs: 0, byPlatform: {}, resolvedLinksByPlatform: {} };
    try {
      const idx = require('../services/hostIdentity').buildIdentityIndex(db, { fresh: true });
      const seen = new Set();
      for (const ref of idx.refs.values()) {
        if (seen.has(ref)) continue;
        seen.add(ref);
        for (const p of ref.platforms) res.byPlatform[p] = (res.byPlatform[p] || 0) + 1;
      }
      res.refs = seen.size;
      const cols = new Set(db.prepare("PRAGMA table_info('lm_topology_links')").all().map((c) => c.name));
      if (cols.has('dst_platform')) {
        for (const r of db.prepare("SELECT dst_platform p, COUNT(*) n FROM lm_topology_links WHERE COALESCE(stale, 0) = 0 AND dst_platform IS NOT NULL GROUP BY dst_platform").all()) {
          res.resolvedLinksByPlatform[r.p] = r.n;
        }
      }
    } catch { /* identity index unavailable */ }
    return res;
  })();
  // Round 11: raw DataSource ingestion state.
  try { out.raw = lmRaw().rawSummary(db, require('../services/logicmonitorMetrics')); } catch { out.raw = { enabled: false, callsPerTick: 0, candidates: 0, sweptLast24h: 0, values: 0, datapoints: 0, coveragePct: null, estSweepHours: null }; }
  // Round 12: DataSource-level coverage next to the datapoint figure (coveragePct stays the datapoint one).
  try {
    const dsAgg = db.prepare(`
      SELECT COUNT(*) total, SUM(CASE WHEN picks > 0 THEN 1 ELSE 0 END) catalogued FROM (
        SELECT datasource_name, SUM(CASE WHEN catalog_metric IS NOT NULL THEN 1 ELSE 0 END) picks FROM lm_ds_datapoints GROUP BY datasource_name
      )`).get();
    out.raw.datasourcesTotal = dsAgg.total || 0;
    out.raw.datasourcesCatalogued = dsAgg.catalogued || 0;
  } catch { out.raw.datasourcesTotal = null; out.raw.datasourcesCatalogued = null; }
  // Round 10: LogicMonitor's own neighbour discovery (predef.externalResourceID) and how much of it resolved.
  try { out.eri = lmEri().eriSummary(db); } catch { out.eri = { interfacesWithEri: 0, cdpTokens: 0, lldpTokens: 0, resolved: 0, unresolved: 0 }; }
  out.devicesWithoutDatasourceInventory = db.prepare(`
    SELECT COUNT(*) n FROM lm_devices d WHERE d.stale = 0
      AND NOT EXISTS (SELECT 1 FROM lm_device_datasources x WHERE x.source_id = d.source_id AND x.lm_device_id = d.lm_device_id)
  `).get().n;
  return out;
}

router.get('/settings/discovery', (req, res, next) => {
  try { res.json(discoveryReport()); } catch (err) { next(err); }
});

router.get('/settings/export.json', [query('history').optional().isIn(['0', '1'])], validate, (req, res, next) => {
  try {
    const withHistory = req.query.history === '1';
    const tables = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name LIKE 'lm\\_%' ESCAPE '\\' ORDER BY name").all()
      .map((t) => t.name).filter((n) => withHistory || !EXPORT_HISTORY_TABLES.has(n));
    const data = {};
    for (const t of tables) data[t] = exportRows(t, withHistory);
    if (data.lm_interfaces) {
      for (const r of data.lm_interfaces) Object.assign(r, { circuit: lmPath().circuitInfo(r.description, r.props_json) });
    }
    const payload = { exportedAt: new Date().toISOString(), history: withHistory, discovery: discoveryReport(),
      circuits: lmPath().circuitRows(db), tables: data };
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="logicmonitor-export-${new Date().toISOString().slice(0, 10)}.json"`);
    res.send(JSON.stringify(payload, null, 1));
  } catch (err) { next(err); }
});

// ---- Governance ------------------------------------------------------------

const govDevice = (d) => ({ id: d.lm_device_id, sourceId: d.source_id, displayName: d.display_name, vendor: d.vendor, role: d.role });

/** Model review rows (network devices, or a site's devices): code level
 *  against the newest seen for the vendor and model, uplinks and endpoints. */
function reviewRows(extraWhere, params, endpoints, lk, newestBy) {
  const endpointCount = new Map();
  for (const e of endpoints) endpointCount.set(`${e.sourceId}:${e.deviceId}`, (endpointCount.get(`${e.sourceId}:${e.deviceId}`) || 0) + 1);
  const uplinkCount = new Map(db.prepare(`
    SELECT source_id, src_device_id, COUNT(*) n FROM lm_topology_links
    WHERE COALESCE(stale, 0) = 0 AND (dst_platform = 'logicmonitor' OR (dst_platform IS NULL AND dst_device_id IS NOT NULL))
    GROUP BY source_id, src_device_id
  `).all().map((r) => [`${r.source_id}:${r.src_device_id}`, r.n]));
  return db.prepare(`${DEVICE_SELECT} WHERE d.stale = 0 ${extraWhere} ORDER BY d.display_name, d.source_id, d.lm_device_id`).all(...params).map((r) => {
    const d = deviceOut(r, lk);
    const newest = newestBy.get(`${r.vendor || 'Unknown'}|${r.model || 'Unknown'}`);
    const k = `${r.source_id}:${r.lm_device_id}`;
    return {
      id: d.id, sourceId: d.sourceId, sourceName: d.sourceName, displayName: d.displayName, name: d.name,
      vendor: d.vendor, model: d.model, version: d.version, role: d.role, serial: r.serial || null,
      collectorName: d.collectorName, groups: d.groups, hostStatus: d.hostStatus, ifCount: d.ifCount, ifUp: d.ifUp,
      uplinks: uplinkCount.get(k) || 0, endpoints: endpointCount.get(k) || 0,
      behind: !!(r.version && newest && cmpVersion(r.version, newest) < 0),
      firstSeen: d.firstSeen, siteKey: d.siteKey, siteName: d.siteName, tier: d.tier,
    };
  });
}

/** vendor|model -> newest version seen among live devices. */
function newestByModel() {
  const m = new Map();
  for (const l of db.prepare(`
    SELECT COALESCE(vendor, 'Unknown') vendor, COALESCE(model, 'Unknown') model, version
    FROM lm_devices WHERE stale = 0 AND version IS NOT NULL AND version != '' GROUP BY 1, 2, 3
  `).all()) {
    const k = `${l.vendor}|${l.model}`;
    if (!m.has(k) || cmpVersion(l.version, m.get(k)) > 0) m.set(k, l.version);
  }
  return m;
}

/**
 * Data quality: gaps that make the path, site and link features blind.
 * coverageScore = 100 minus weighted gap ratios, each ratio over its own
 * population: ports up without a description / up ports on network devices
 * (weight 20), switches with no LLDP or CDP datasource / switches (20),
 * network devices with no site / network devices (20), check locations with
 * no baseline / check locations (15; Overall checkpoints are excluded from
 * both sides because they never get a baseline by design), unresolved link-looking descriptions
 * / links (15), network devices with no interface datasource / network
 * devices (10). null when the estate has no network devices.
 */
function buildDataQuality() {
  const one = (sql) => { try { return db.prepare(sql).get().n; } catch { return 0; } };
  const all = (sql) => { try { return db.prepare(sql).all(); } catch { return []; } };
  const portsNoDescription = all(`
    SELECT d.display_name AS deviceName, i.display_name AS port FROM lm_interfaces i
    JOIN lm_devices d ON d.source_id = i.source_id AND d.lm_device_id = i.lm_device_id
    WHERE i.stale = 0 AND d.stale = 0 AND d.is_network = 1 AND i.status_text = 'up' AND COALESCE(i.stop_monitoring, 0) = 0
      AND (i.description IS NULL OR trim(i.description) = '') ORDER BY d.display_name, i.if_index, i.display_name LIMIT 5000
  `);
  const switchesNoNeighbors = all(`
    SELECT d.display_name AS deviceName FROM lm_devices d
    WHERE d.stale = 0 AND d.is_network = 1 AND d.role = 'switch'
      AND NOT EXISTS (SELECT 1 FROM lm_device_datasources x WHERE x.source_id = d.source_id AND x.lm_device_id = d.lm_device_id AND x.is_neighbor = 1)
    ORDER BY d.display_name
  `);
  const devicesNoSite = all("SELECT display_name AS deviceName FROM lm_devices WHERE stale = 0 AND is_network = 1 AND site_key IS NULL ORDER BY display_name");
  const checksNoBaseline = all(`
    SELECT c.name AS checkName, l.label AS label,
      (SELECT COUNT(*) FROM lm_check_history h WHERE h.source_id = l.source_id AND h.check_id = l.check_id AND h.checkpoint_id = l.checkpoint_id) AS samples
    FROM lm_check_locations l JOIN lm_checks c ON c.source_id = l.source_id AND c.check_id = l.check_id
    WHERE l.stale = 0 AND c.stale = 0 AND COALESCE(l.is_overall, 0) = 0 AND NOT EXISTS (
      SELECT 1 FROM lm_check_baseline b WHERE b.source_id = l.source_id AND b.check_id = l.check_id AND b.checkpoint_id = l.checkpoint_id)
    ORDER BY c.name, l.label
  `);
  const unresolvedLinks = one("SELECT COUNT(*) n FROM lm_topology_links WHERE COALESCE(stale, 0) = 0 AND dst_device_id IS NULL AND dst_platform IS NULL");
  const netDevices = one('SELECT COUNT(*) n FROM lm_devices WHERE stale = 0 AND is_network = 1');
  const upPorts = one("SELECT COUNT(*) n FROM lm_interfaces i JOIN lm_devices d ON d.source_id = i.source_id AND d.lm_device_id = i.lm_device_id WHERE i.stale = 0 AND d.stale = 0 AND d.is_network = 1 AND i.status_text = 'up' AND COALESCE(i.stop_monitoring, 0) = 0");
  const switches = one("SELECT COUNT(*) n FROM lm_devices WHERE stale = 0 AND is_network = 1 AND role = 'switch'");
  const locations = one('SELECT COUNT(*) n FROM lm_check_locations l JOIN lm_checks c ON c.source_id = l.source_id AND c.check_id = l.check_id WHERE l.stale = 0 AND c.stale = 0 AND COALESCE(l.is_overall, 0) = 0');
  const links = one('SELECT COUNT(*) n FROM lm_topology_links WHERE COALESCE(stale, 0) = 0');
  const noIfDs = one(`SELECT COUNT(*) n FROM lm_devices d WHERE d.stale = 0 AND d.is_network = 1 AND NOT EXISTS (
    SELECT 1 FROM lm_device_datasources x WHERE x.source_id = d.source_id AND x.lm_device_id = d.lm_device_id AND x.is_interface = 1)`);
  const ratio = (n, d) => (d > 0 ? Math.min(1, n / d) : 0);
  const gap = 20 * ratio(portsNoDescription.length, upPorts) + 20 * ratio(switchesNoNeighbors.length, switches)
    + 20 * ratio(devicesNoSite.length, netDevices) + 15 * ratio(checksNoBaseline.length, locations)
    + 15 * ratio(unresolvedLinks, links) + 10 * ratio(noIfDs, netDevices);
  return {
    portsNoDescription, switchesNoNeighbors, devicesNoSite, checksNoBaseline, unresolvedLinks,
    coverageScore: netDevices ? Math.max(0, Math.min(100, Math.round(100 - gap))) : null,
  };
}

/** Shadowed open alerts: the alert item shape plus shadowedBy {deviceId, deviceName, port, reason}. */
function shadowedAlertRows() {
  try {
    return db.prepare("SELECT * FROM lm_alerts WHERE cleared = 0 AND shadowed_by IS NOT NULL ORDER BY start_epoch DESC LIMIT 5000").all().map(alertOut);
  } catch { return []; }
}

function buildGovernance() {
  const lk = lookups();
  const levels = db.prepare(`
    SELECT COALESCE(vendor, 'Unknown') vendor, COALESCE(model, 'Unknown') model, version, COUNT(*) n
    FROM lm_devices WHERE stale = 0 AND version IS NOT NULL AND version != ''
    GROUP BY COALESCE(vendor, 'Unknown'), COALESCE(model, 'Unknown'), version
  `).all();
  const newestBy = new Map();
  for (const l of levels) {
    const k = `${l.vendor}|${l.model}`;
    if (!newestBy.has(k) || cmpVersion(l.version, newestBy.get(k)) > 0) newestBy.set(k, l.version);
  }
  const codeLevels = levels.map((l) => {
    const newest = cmpVersion(l.version, newestBy.get(`${l.vendor}|${l.model}`)) === 0;
    return { vendor: l.vendor, model: l.model, version: l.version, count: l.n, newest, behind: !newest };
  }).sort((a, b) => a.vendor.localeCompare(b.vendor) || a.model.localeCompare(b.model) || cmpVersion(b.version, a.version));

  const builds = new Map();
  for (const c of db.prepare('SELECT source_id, build FROM lm_collectors WHERE stale = 0').all()) {
    const k = c.build || 'unknown';
    const e = builds.get(k) || { build: k, count: 0, behind: false };
    e.count += 1;
    if (buildBehind(c.build, mgdFor(lk, c.source_id))) e.behind = true;
    builds.set(k, e);
  }
  const collectorBuilds = [...builds.values()].sort((a, b) => cmpVersion(b.build, a.build));

  const deadDevices = db.prepare(`
    ${DEVICE_SELECT} WHERE d.stale = 0 AND d.host_status IN ('dead', 'dead-collector')
    ORDER BY CASE d.host_status WHEN 'dead' THEN 0 ELSE 1 END, d.display_name
  `).all().map((d) => ({ id: d.lm_device_id, sourceId: d.source_id, displayName: d.display_name, hostStatus: d.host_status, collectorName: d.collector_name || null, sinceMs: deadSinceMs(d) }));

  const noInterfaceDatasource = db.prepare(`
    SELECT * FROM lm_devices d WHERE d.stale = 0 AND d.is_network = 1 AND NOT EXISTS (
      SELECT 1 FROM lm_device_datasources ds WHERE ds.source_id = d.source_id AND ds.lm_device_id = d.lm_device_id AND ds.is_interface = 1)
    ORDER BY d.display_name
  `).all().map(govDevice);
  const all = db.prepare('SELECT * FROM lm_devices WHERE stale = 0 ORDER BY display_name').all();
  const inSdtList = all.filter((d) => inSdt(d.sdt_status)).map(govDevice);
  const alertingDisabled = all.filter((d) => Number(d.disable_alerting) === 1).map(govDevice);
  // Interface-monitored network devices whose newest interface sample is
  // older than 24 h (or missing): ICC has no per-device lastDataTime.
  const notPolled24h = db.prepare(`
    SELECT d.* FROM lm_devices d WHERE d.stale = 0 AND d.is_network = 1 AND EXISTS (
      SELECT 1 FROM lm_device_datasources ds WHERE ds.source_id = d.source_id AND ds.lm_device_id = d.lm_device_id AND ds.is_interface = 1)
      AND COALESCE((SELECT MAX(i.sampled_at_epoch) FROM lm_interfaces i WHERE i.source_id = d.source_id AND i.lm_device_id = d.lm_device_id), 0) < ?
    ORDER BY d.display_name
  `).all(nowSec() - 86400).map(govDevice);

  const ackedOpenOver7d = db.prepare(`
    SELECT * FROM lm_alerts WHERE cleared = 0 AND acked = 1 AND start_epoch < ? ORDER BY start_epoch ASC
  `).all(nowSec() - 7 * 86400).map(alertOut);
  const noisyConditions = db.prepare(`
    SELECT condition_key, MAX(monitor_object_name) monitor_object_name, MAX(resource_template_name) datasource,
      MAX(data_point_name) data_point_name, COUNT(*) n
    FROM lm_alerts WHERE start_epoch >= ? GROUP BY condition_key HAVING n >= 2 ORDER BY n DESC, condition_key LIMIT 20
  `).all(nowSec() - 30 * 86400).map((r) => ({
    conditionKey: r.condition_key, monitorObjectName: r.monitor_object_name, datasource: r.datasource,
    dataPointName: r.data_point_name, count30d: r.n,
  }));
  const unrouted = db.prepare("SELECT COUNT(*) n FROM lm_alerts WHERE cleared = 0 AND COALESCE(rule, '') = ''").get().n;

  // Why a description link stayed unresolved: no name token in the text, a name
  // two ICC hosts share, or a name nothing knows (round 9, hostIdentity).
  const unmatchedReason = (() => {
    let idx = null;
    try { idx = require('../services/hostIdentity').buildIdentityIndex(db); } catch { idx = null; }
    const grammar = require('../services/logicmonitorGrammar');
    return (desc) => {
      const g = grammar.parseEndpointDescription(desc);
      const m = String(desc || '').match(/(?:^|[\s(\[])(?:uplink\s+to|link\s+to|to|->)\s*[:-]?\s*(\S+)/i);
      const tok = (g && g.host) || (m ? m[1].replace(/^[\s"'([<]+|[\s"')\]>,;.]+$/g, '') : '');
      if (!tok || tok.length < 3) return 'no-name';
      if (!idx) return 'unknown-name';
      const r = require('../services/hostIdentity').explainToken(idx, tok);
      return r.reason === 'ambiguous' ? 'ambiguous' : r.reason === 'no-name' ? 'no-name' : 'unknown-name';
    };
  })();
  const topologyUnmatched = db.prepare(`
    SELECT d.display_name AS device_name, i.display_name, i.description, l.src_device_id, l.src_instance_id
    FROM lm_topology_links l
    LEFT JOIN lm_devices d ON d.source_id = l.source_id AND d.lm_device_id = l.src_device_id
    LEFT JOIN lm_interfaces i ON i.source_id = l.source_id AND i.instance_id = l.src_instance_id
    WHERE l.dst_device_id IS NULL AND l.dst_platform IS NULL AND COALESCE(l.stale, 0) = 0
    ORDER BY d.display_name, i.display_name
  `).all().map((r) => ({ deviceId: r.src_device_id, instanceId: r.src_instance_id, deviceName: r.device_name, displayName: r.display_name, description: r.description, reason: unmatchedReason(r.description) }));

  // Model Review (round 2): every live network device with its code level,
  // uplink count (links to other LM devices) and endpoint count (switch
  // ports resolved to another ICC platform's hosts, logicmonitorEndpoints).
  const endpoints = lmEndpoints().endpointsAll(db);
  const modelReview = reviewRows('AND d.is_network = 1', [], endpoints, lk, newestBy);
  const rollup = (keyFn) => {
    const m = new Map();
    for (const r of modelReview) { const k = keyFn(r); m.set(k, (m.get(k) || 0) + 1); }
    return m;
  };
  const rollups = {
    byVendor: [...rollup((r) => r.vendor || 'Unknown')].map(([vendor, count]) => ({ vendor, count }))
      .sort((a, b) => b.count - a.count || a.vendor.localeCompare(b.vendor)),
    byRole: [...rollup((r) => r.role || 'other')].map(([role, count]) => ({ role, count }))
      .sort((a, b) => b.count - a.count || a.role.localeCompare(b.role)),
    byModel: [...rollup((r) => `${r.vendor || 'Unknown'}\u0000${r.model || 'Unknown'}`)].map(([k, count]) => {
      const [vendor, model] = k.split('\u0000');
      return { vendor, model, count };
    }).sort((a, b) => b.count - a.count || a.vendor.localeCompare(b.vendor) || a.model.localeCompare(b.model)),
  };

  const configChanges = tableExists('config_changes')
    ? db.prepare("SELECT * FROM config_changes WHERE platform = 'logicmonitor' ORDER BY detected_at DESC, id DESC LIMIT 50").all().map((c) => ({
      id: c.id, scope: c.scope, system: c.system, item: c.item, changeType: c.change_type,
      oldValue: c.old_value, newValue: c.new_value, detectedAt: sqlIso(c.detected_at),
    }))
    : [];

  return {
    codeLevels, collectorBuilds, deadDevices,
    coverage: { noInterfaceDatasource, inSdt: inSdtList, alertingDisabled, notPolled24h },
    alertHygiene: { ackedOpenOver7d, noisyConditions, unrouted },
    topologyUnmatched, configChanges,
    unmonitoredNeighbors: lmEri().unmonitoredRows(db),
    modelReview, rollups,
    endpoints, endpointsSummary: lmEndpoints().endpointsSummary(endpoints),
    shadowedAlerts: shadowedAlertRows(),
    backupWindows: lmEndpoints().backupWindows(db, { endpoints }),
    dataQuality: buildDataQuality(),
  };
}

const MODEL_REVIEW_CSV = ['displayName', 'name', 'sourceName', 'vendor', 'model', 'version', 'behind', 'role', 'serial',
  'collectorName', 'groups', 'hostStatus', 'ifUp', 'ifCount', 'uplinks', 'endpoints', 'firstSeen', 'id', 'sourceId'];
const ENDPOINT_CSV = ['deviceName', 'port', 'portStatusText', 'portInUtilPct', 'portOutUtilPct', 'portErrors', 'endpoint',
  'endpointPlatform', 'nic', 'protocol', 'confidence', 'corroborated', 'matchQuality', 'origin', 'mac', 'vlan', 'switchName', 'lastSeen',
  'instanceId', 'deviceId', 'sourceId'];

const GOV_SECTIONS = {
  codeLevels: (g) => g.codeLevels,
  collectorBuilds: (g) => g.collectorBuilds,
  deadDevices: (g) => g.deadDevices,
  noInterfaceDatasource: (g) => g.coverage.noInterfaceDatasource,
  inSdt: (g) => g.coverage.inSdt,
  alertingDisabled: (g) => g.coverage.alertingDisabled,
  notPolled24h: (g) => g.coverage.notPolled24h,
  ackedOpenOver7d: (g) => g.alertHygiene.ackedOpenOver7d,
  noisyConditions: (g) => g.alertHygiene.noisyConditions,
  topologyUnmatched: (g) => g.topologyUnmatched,
  unmonitoredNeighbors: (g) => g.unmonitoredNeighbors,
  configChanges: (g) => g.configChanges,
  modelReview: (g) => g.modelReview.map((r) => ({ ...r, groups: (r.groups || []).join('; '), behind: r.behind ? 'yes' : 'no' })),
  endpoints: (g) => g.endpoints,
  shadowedAlerts: (g) => g.shadowedAlerts.map((a) => ({
    monitorObjectName: a.monitorObjectName, datasource: a.datasource, instanceName: a.instanceName, dataPointName: a.dataPointName,
    severityNorm: a.severityNorm, startedAt: a.startedAt, upstreamDevice: a.shadowedBy && a.shadowedBy.deviceName,
    upstreamPort: a.shadowedBy && a.shadowedBy.port, reason: a.shadowedBy && a.shadowedBy.reason, id: a.id, sourceId: a.sourceId,
  })),
  backupWindows: (g) => g.backupWindows,
  portsNoDescription: (g) => g.dataQuality.portsNoDescription,
  switchesNoNeighbors: (g) => g.dataQuality.switchesNoNeighbors,
  devicesNoSite: (g) => g.dataQuality.devicesNoSite,
  checksNoBaseline: (g) => g.dataQuality.checksNoBaseline,
};
const GOV_CSV_COLUMNS = { modelReview: MODEL_REVIEW_CSV, endpoints: ENDPOINT_CSV };

router.get('/governance', (req, res, next) => {
  try { res.json(buildGovernance()); } catch (err) { next(err); }
});

router.get('/governance/unmonitored-neighbors.csv', (req, res, next) => {
  try {
    sendCsv(res, 'unmonitored-neighbors', lmEri().unmonitoredRows(db),
      ['name', 'kind', 'portsSeen', 'devicesSeen', 'firstSeen', 'lastSeen', 'sampleDevice', 'samplePort', 'sourceName', 'key']);
  } catch (err) { next(err); }
});

router.get('/governance.csv', [query('section').isIn(Object.keys(GOV_SECTIONS))], validate, (req, res, next) => {
  try {
    const rows = GOV_SECTIONS[req.query.section](buildGovernance());
    sendCsv(res, `governance-${req.query.section}`, rows, GOV_CSV_COLUMNS[req.query.section]);
  } catch (err) { next(err); }
});

// ---- Correlation (round 4) -------------------------------------------------

const CORRELATION_CSV = {
  backupLoad: (c) => c.backupLoad.map((r) => ({
    deviceName: r.deviceName, port: r.port, host: r.host, hostPlatform: r.hostPlatform, windowStart: r.windowStart, windowEnd: r.windowEnd,
    meanUtilPct: r.meanUtilPct, maxUtilPct: r.maxUtilPct, baselineUtilPct: r.baselineUtilPct, finding: r.finding || '',
    uplinkRule: r.uplinkRule, side: r.side || 'client', runCount: r.runCount,
    runs: (r.runs || []).map((x) => `${x.jobName} (${x.sharePct == null ? 'n/a' : `${x.sharePct}%`})`).join('; '),
  })),
  replicationVsCircuits: (c) => c.replicationVsCircuits.map((r) => ({
    kind: r.kind, subject: r.subject, detail: r.detail, at: r.at, until: r.until, siteKey: r.siteKey,
    circuitDevice: r.circuit && r.circuit.deviceName, circuitPort: r.circuit && r.circuit.port, circuitLabel: r.circuit && r.circuit.label,
    circuitUtilPct: r.circuitUtilPct, circuitP95Pct: r.circuitP95Pct, overlapMinutes: r.overlapMinutes, finding: r.finding || '',
  })),
  changesThenIncidents: (c) => c.changesThenIncidents.map((r) => ({
    changeId: r.changeId, device: r.device, system: r.system, scope: r.scope, item: r.item, changeType: r.changeType, oldValue: r.oldValue, newValue: r.newValue,
    changedAt: r.changedAt, siteKey: r.siteKey, incidentType: r.incident.type, incidentTarget: r.incident.target,
    incidentMessage: r.incident.message, incidentFirstSeen: r.incident.firstSeen, minutesAfter: r.incident.minutesAfter,
  })),
  blameHops: (c) => c.blameHistory.hops.map((h) => ({
    deviceName: h.deviceName, port: h.port, siteKey: h.siteKey, count: h.count, firstAt: h.firstAt, lastAt: h.lastAt,
    subjects: h.subjects.map((x) => `${x.kind}: ${x.subject} (${x.count})`).join('; '), appsAffected: h.appsAffected.join('; '),
  })),
  blameRecent: (c) => c.blameHistory.recent,
  snapmirror: (c) => (c.snapmirror || []).map((r) => ({
    relationship: r.relationship, side: r.side, cluster: r.cluster, node: r.node, nodePort: r.nodePort, deviceName: r.deviceName, port: r.port,
    state: r.state, healthy: r.healthy, lagSeconds: r.lagSeconds, windowStart: r.windowStart, windowEnd: r.windowEnd,
    meanUtilPct: r.meanUtilPct, maxUtilPct: r.maxUtilPct, baselineUtilPct: r.baselineUtilPct, meanErrors: r.meanErrors, baselineErrors: r.baselineErrors,
    portRule: r.portRule, finding: r.finding,
  })),
};

router.get('/correlation', (req, res, next) => {
  try { res.json(lmCorrelation().correlation(db)); } catch (err) { next(err); }
});

router.get('/correlation.csv', [query('section').isIn(Object.keys(CORRELATION_CSV))], validate, (req, res, next) => {
  try {
    sendCsv(res, `correlation-${req.query.section}`, CORRELATION_CSV[req.query.section](lmCorrelation().correlation(db)));
  } catch (err) { next(err); }
});

// ---- Device lookup for other platforms' popups (round 9) ---------------------

const csvList = (v, max = 20) => (Array.isArray(v) ? v : (v ? [v] : []))
  .flatMap((x) => String(x).split(',')).map((x) => x.trim()).filter((x) => x && x.length <= 255).slice(0, max);

/**
 * LogicMonitor view of one object another platform shows (a Brocade switch, a
 * Cohesity node, a NetApp cluster): the matching LM device (display name, name,
 * sysname, hostname or system IP), its open non-duplicate alerts, health, and
 * the switch ports ICC ties to the same names and addresses. 200 with
 * device: null when LM does not know the object.
 */
router.get('/lookup', [
  query('names').optional(),
  query('ips').optional(),
], validate, (req, res, next) => {
  try {
    const names = csvList(req.query.names);
    const ips = csvList(req.query.ips);
    if (!names.length && !ips.length) return res.status(400).json({ error: 'names or ips required' });
    const platform = require('../platforms/logicmonitor');
    const [dev] = platform.matchDevices(db, names, ips, 1);
    let switchPorts = [];
    try { switchPorts = lmEndpoints().serverPath(db, { names, ips }).switchPorts; } catch { switchPorts = []; }
    if (!dev) return res.json({ device: null, alerts: [], health: null, switchPorts, metrics: [], families: [] });
    const alerts = platform.openAlertsOf(db, dev, 50).map((a) => ({
      severity: a.severity_norm, datasource: a.resource_template_name, instanceName: a.instance_name, dataPointName: a.data_point_name,
      alertValue: a.alert_value, threshold: a.threshold, startedAt: epochIso(a.start_epoch), acked: Number(a.acked) === 1, sdted: Number(a.sdted) === 1,
    }));
    const dead = dev.host_status === 'dead' || dev.host_status === 'dead-collector';
    res.json({
      device: {
        id: dev.lm_device_id, sourceId: dev.source_id, displayName: dev.display_name || dev.name, name: dev.name,
        vendor: dev.vendor || null, model: dev.model || null, version: dev.version || null, siteKey: dev.site_key || null,
        collector: dev.collector_hostname || dev.collector_desc || null,
      },
      alerts,
      health: {
        hostStatus: dev.host_status || null,
        deadSince: dead && deadSinceMs(dev) ? new Date(deadSinceMs(dev)).toISOString() : null,
        alertStatus: dev.alert_status || null,
        collectorDown: !!dev.collector_down,
      },
      switchPorts,
      ...lookupMetrics(dev, req.query.family),
    });
  } catch (err) { next(err); }
});

/**
 * Round 10: the DataSource metrics LogicMonitor holds for a resolved device, newest value per
 * instance and metric (lm_ds_metrics), capped at 200 and ordered by family, DataSource and
 * instance. family narrows the list (a Cohesity page asks for 'cohesity'). Labels and units
 * come from the catalog; a metric the catalog does not know keeps its key. Never throws.
 */
function lookupMetrics(dev, familyQuery) {
  const out = { metrics: [], families: [], metricsTruncated: false };
  try {
    const cat = lmCatalog();
    const family = familyQuery ? String(familyQuery).slice(0, 40) : null;
    const rows = db.prepare(`
      SELECT m.datasource_name, m.family, m.instance_key, i.instance_name, m.metric, m.value, m.sampled_at_epoch
      FROM lm_ds_metrics m
      LEFT JOIN lm_ds_instances i ON i.source_id = m.source_id AND i.lm_device_id = m.lm_device_id
        AND i.hds_id = m.hds_id AND i.instance_key = m.instance_key
      WHERE m.source_id = ? AND m.lm_device_id = ? AND COALESCE(i.stale, 0) = 0 ${family ? 'AND m.family = ?' : ''}
      ORDER BY m.family, m.datasource_name, m.instance_key, m.metric LIMIT 200
    `).all(dev.source_id, dev.lm_device_id, ...(family ? [family] : []));
    const fams = new Set();
    for (const r of rows) {
      const entry = cat && cat.catalogFor ? cat.catalogFor(r.datasource_name) : null;
      const def = entry && entry.metrics ? entry.metrics[r.metric] : null;
      fams.add(r.family);
      out.metrics.push({
        datasource: r.datasource_name, datasourceLabel: entry ? entry.label : r.datasource_name, family: r.family,
        instanceKey: r.instance_key, instanceName: r.instance_name || r.instance_key,
        metric: r.metric, label: def ? def.label : r.metric, unit: def ? def.unit : '', kind: def ? def.kind : null,
        value: r.value, sampledAt: epochIso(r.sampled_at_epoch),
      });
    }
    out.families = [...fams];
    out.metricsTruncated = rows.length >= 200;
  } catch { /* tables absent on an older schema: no metrics */ }
  return out;
}

// ---- Endpoint summary for other platforms' pages (round 9) -------------------

const ENDPOINT_SUMMARY_PLATFORMS = ['dell', 'cohesity', 'netapp', 'pure', 'brocade', 'vcenter'];
const ENDPOINT_SUMMARY_TTL_MS = 60 * 1000;
const endpointSummaryCache = new Map(); // `${dbKey}|${platform}` -> { at, data }

/**
 * { "<refKey>": { ports, switches: [names], state } } over the endpoint rows of
 * one platform. One computeEndpoints call; a row is filed under its endpoint
 * host lower-cased and, when the identity index resolves that name, under the
 * ref key and every name of the ref. state is down when any port is down, up
 * when every port is up, else unknown.
 */
function buildEndpointSummary(platform) {
  // A row belongs to the platform when its endpoint platform matches, or when
  // the identity index resolves the endpoint to a ref that carries the platform
  // (an ESX host that is also a Dell server reaches its ports through vCenter
  // hints, so platform=dell must include it).
  let idx = null;
  let ident = null;
  try { ident = require('../services/hostIdentity'); idx = ident.buildIdentityIndex(db); } catch { idx = null; }
  const groups = new Map();
  for (const r of lmEndpoints().computeEndpoints(db)) {
    const k = String(r.endpoint || '').trim().toLowerCase();
    if (!k) continue;
    let ref = null;
    if (idx) { try { ref = ident.resolveToken(idx, k); } catch { ref = null; } }
    const refPlatforms = ref ? (Array.isArray(ref.platforms) && ref.platforms.length ? ref.platforms : [ref.platform]) : [];
    if (r.endpointPlatform !== platform && !refPlatforms.includes(platform)) continue;
    const keys = new Set([k]);
    if (ref) { keys.add(ref.refKey); for (const n of ref.names || []) keys.add(n); }
    for (const key of keys) {
      if (!groups.has(key)) groups.set(key, new Set());
      groups.get(key).add(r);
    }
  }
  const data = {};
  for (const [key, set] of groups) {
    const list = [...set];
    const states = list.map((r) => String(r.portStatusText || 'unknown').toLowerCase());
    data[key] = {
      ports: list.length,
      switches: [...new Set(list.map((r) => r.deviceName).filter(Boolean))],
      state: states.some((x) => x === 'down') ? 'down' : states.every((x) => x === 'up') ? 'up' : 'unknown',
    };
  }
  return data;
}

router.get('/endpoints/summary', [
  query('platform').isIn(ENDPOINT_SUMMARY_PLATFORMS),
], validate, (req, res, next) => {
  try {
    const platform = String(req.query.platform);
    const cacheKey = `${String(db.name || '')}|${platform}`;
    const hit = endpointSummaryCache.get(cacheKey);
    if (hit && Date.now() - hit.at < ENDPOINT_SUMMARY_TTL_MS) return res.json(hit.data);
    const data = buildEndpointSummary(platform);
    endpointSummaryCache.set(cacheKey, { at: Date.now(), data });
    res.json(data);
  } catch (err) { next(err); }
});

// ---- Issues, history, trends, SDT, topology --------------------------------

router.get('/issues', (req, res, next) => {
  try { res.json({ issues: safeIssues(), asOf: issuesAsOf() }); } catch (err) { next(err); }
});

// BARE ARRAY. Raw snake_case columns (what IssueAlertsPage reads: type,
// target, first_seen, resolved_at) plus camelCase twins, timestamps as ISO.
router.get('/issue-history', [query('days').optional().isInt({ min: 1, max: 90 }).toInt()], validate, (req, res, next) => {
  try {
    const days = req.query.days || 30;
    res.json(db.prepare(`
      SELECT * FROM lm_issue_history
      WHERE status = 'open' OR datetime(last_seen) >= datetime(?)
      ORDER BY CASE status WHEN 'open' THEN 0 ELSE 1 END, datetime(last_seen) DESC
    `).all(isoAgo(days * 86400000)).map((r) => {
      const firstSeen = sqlIso(r.first_seen);
      const lastSeen = sqlIso(r.last_seen);
      const resolvedAt = sqlIso(r.resolved_at);
      return {
        ...r, first_seen: firstSeen, last_seen: lastSeen, resolved_at: resolvedAt,
        issueKey: r.issue_key, firstSeen, lastSeen, resolvedAt,
      };
    }));
  } catch (err) { next(err); }
});

const TREND_RANGES = { '24h': 24, '7d': 168, '30d': 720 };
router.get('/trends', [query('range').optional().isIn(Object.keys(TREND_RANGES))], validate, (req, res, next) => {
  try {
    const range = req.query.range || '7d';
    const hours = TREND_RANGES[range];
    // One row per poll tick summed across portals (minute resolution), then
    // thinned to <= 200 points keeping the last row of each bucket (point in
    // time, not an average).
    const rows = db.prepare(`
      SELECT substr(datetime(captured_at), 1, 16) k, MAX(datetime(captured_at)) at,
        SUM(COALESCE(devices_normal, 0)) dn, SUM(COALESCE(devices_dead, 0)) dd, SUM(COALESCE(devices_dead_collector, 0)) ddc,
        SUM(COALESCE(interfaces_up, 0)) iu, SUM(COALESCE(interfaces_down, 0)) idn,
        SUM(COALESCE(alerts_critical, 0)) ac, SUM(COALESCE(alerts_warning, 0)) aw, SUM(COALESCE(alerts_error, 0)) ae,
        SUM(COALESCE(collectors_down, 0)) cd, SUM(COALESCE(checks_down, 0)) chd, SUM(COALESCE(checks_degraded, 0)) chg
      FROM lm_metrics_history WHERE datetime(captured_at) >= datetime(?)
      GROUP BY k ORDER BY k ASC
    `).all(isoAgo(hours * 3600 * 1000));
    const step = Math.max(1, Math.ceil(rows.length / 200));
    const picked = [];
    for (let i = step - 1; i < rows.length; i += step) picked.push(rows[i]);
    if (rows.length && picked[picked.length - 1] !== rows[rows.length - 1]) picked.push(rows[rows.length - 1]);
    // Metrics carry critical, error and warning columns; the route vocabulary
    // is critical | warning | info, so error counts as warning (severity 3)
    // and alertsInfo is not stored per tick (null).
    let extra = {};
    try { extra = require('../services/logicmonitorTrends').getTrends(db, range); } catch (err) { extra = { range, daily: null, movers: null }; }
    res.json({
      range: extra.range, daily: extra.daily, movers: extra.movers,
      points: picked.slice(-200).map((r) => ({
        at: sqlIso(r.at), devicesNormal: r.dn, devicesDead: r.dd, devicesDeadCollector: r.ddc,
        interfacesUp: r.iu, interfacesDown: r.idn, alertsCritical: r.ac, alertsWarning: r.aw + r.ae, alertsInfo: null,
        collectorsDown: r.cd, checksDown: r.chd, checksDegraded: r.chg,
      })),
    });
  } catch (err) { next(err); }
});

router.get('/sdts', (req, res, next) => {
  try {
    res.json(db.prepare('SELECT * FROM lm_sdts WHERE stale = 0 ORDER BY is_effective DESC, start_ms DESC').all().map(sdtOut));
  } catch (err) { next(err); }
});

router.get('/topology-links', [query('deviceId').optional().isInt().toInt(), query('sourceId').optional().isInt().toInt()], validate, (req, res, next) => {
  try {
    const where = ['COALESCE(l.stale, 0) = 0'];
    const params = [];
    if (req.query.deviceId != null) { where.push('(l.src_device_id = ? OR l.dst_device_id = ?)'); params.push(req.query.deviceId, req.query.deviceId); }
    if (req.query.sourceId) { where.push('l.source_id = ?'); params.push(req.query.sourceId); }
    res.json(db.prepare(`
      SELECT l.*, d.display_name AS src_device_name FROM lm_topology_links l
      LEFT JOIN lm_devices d ON d.source_id = l.source_id AND d.lm_device_id = l.src_device_id
      WHERE ${where.join(' AND ')} ORDER BY d.display_name, l.src_port
    `).all(...params).map((l) => ({
      sourceId: l.source_id, srcDeviceId: l.src_device_id, srcDeviceName: l.src_device_name, srcPort: l.src_port,
      dstDeviceId: l.dst_device_id, dstName: l.dst_name, dstPort: l.dst_port, protocol: l.protocol, confidence: l.confidence,
      dstPlatform: l.dst_platform || (l.dst_device_id != null ? 'logicmonitor' : null), dstRef: l.dst_ref || null,
    })));
  } catch (err) { next(err); }
});

// ---- Config ----------------------------------------------------------------

// Circuit map tile positions shared by everyone (round 13b): a JSON object { siteKey: { x, y } } kept as one
// app_settings text value. It is not a threshold, so it has no THRESHOLD_DEFS entry.
const MAP_LAYOUT_KEY = 'lm_circuit_map_layout';
const MAP_LAYOUT_MAX = 64 * 1024;
function mapLayoutValue() {
  try { return String(getSetting(MAP_LAYOUT_KEY) || ''); } catch { return ''; }
}
/** '' clears the layout; otherwise a JSON object of {x, y} numbers. Returns an error string or null. */
function checkMapLayout(v) {
  if (typeof v !== 'string') return 'must be a JSON string';
  if (v.length > MAP_LAYOUT_MAX) return 'must be 64 KB or less';
  if (!v.trim()) return null;
  let o;
  try { o = JSON.parse(v); } catch { return 'must be valid JSON'; }
  if (!o || typeof o !== 'object' || Array.isArray(o)) return 'must be a JSON object of site positions';
  for (const val of Object.values(o)) {
    if (!val || !Number.isFinite(val.x) || !Number.isFinite(val.y)) return 'every position needs numeric x and y';
  }
  return null;
}
const configPayload = () => ({ thresholds: allThresholds(), [MAP_LAYOUT_KEY]: mapLayoutValue(), ranges: buildRanges(), labels: buildLabels() });

router.get('/config', (req, res, next) => {
  try { res.json(configPayload()); } catch (err) { next(err); }
});

// Accepts the keys flat at the top level or under {thresholds}. Integers
// outside the range are clamped into it; a non-integer, a boolean that is not
// 0/1, or a non-string text value is a 400. Booleans take '1'/'0', 1/0 or
// true/false.
router.put('/config', (req, res, next) => {
  try {
    const src = req.body && typeof req.body.thresholds === 'object' && req.body.thresholds ? req.body.thresholds : (req.body || {});
    const bad = [];
    const writes = [];
    for (const [key, d] of Object.entries(defs())) {
      if (src[key] === undefined) continue;
      const v = src[key];
      if (isText(d)) {
        if (typeof v !== 'string' || v.length > d.maxLength) { bad.push({ path: key, msg: `must be a string up to ${d.maxLength} characters` }); continue; }
        writes.push([key, v.trim()]);
      } else if (d.bool) {
        const t = String(v).trim().toLowerCase();
        if (!['0', '1', 'true', 'false'].includes(t)) { bad.push({ path: key, msg: 'must be 0 or 1' }); continue; }
        writes.push([key, t === '1' || t === 'true' ? '1' : '0']);
      } else {
        if (d.float) {
          if (!Number.isFinite(Number(v)) || String(v).trim() === '') { bad.push({ path: key, msg: 'must be a number' }); continue; }
        } else if (!(typeof v === 'number' ? Number.isInteger(v) : /^-?\d+$/.test(String(v).trim()))) { bad.push({ path: key, msg: 'must be an integer' }); continue; }
        writes.push([key, String(clampTo(key, v))]);
      }
    }
    if (src[MAP_LAYOUT_KEY] !== undefined) {
      const why = checkMapLayout(src[MAP_LAYOUT_KEY]);
      if (why) bad.push({ path: MAP_LAYOUT_KEY, msg: why }); else writes.push([MAP_LAYOUT_KEY, src[MAP_LAYOUT_KEY].trim()]);
    }
    if (bad.length) return res.status(400).json({ error: 'Invalid parameters', details: bad });
    const circuitKeys = new Set(['lm_wan_overrides', 'lm_carrier_aliases']);
    const circuitsChanged = writes.some(([k, v]) => circuitKeys.has(k) && String(lmIssues().getTextSetting(k) || '') !== String(v));
    for (const [k, v] of writes) setSetting(k, v);
    // Round 13b: overrides and carrier aliases change circuit roles, so re-classify now instead of at the daily run.
    if (circuitsChanged) {
      try { lmPath().computeCircuits(db); require('../services/logicmonitorCircuits').computeSiteWanState(db); } catch { /* next daily run recomputes */ }
    }
    res.json(configPayload());
  } catch (err) { next(err); }
});

// ---- AI Advisor (routes/eon.js:2054-2078, plus routes/brocade.js error
// mapping so a missing provider is a 503, not a 500) -------------------------

function advisorReportKey(slug) {
  return String(slug).replace(/-/g, '_');
}

function advisorError(err, res, next) {
  if (err.code === 'LLM_NOT_CONFIGURED') {
    return res.status(503).json({ error: 'AI analysis is not configured. Set up an AI provider under Global Settings > Intelligence.' });
  }
  if (err.code === 'LLM_RATE_LIMITED') {
    if (err.retryAfter) res.set('Retry-After', String(err.retryAfter));
    return res.status(429).json({ error: err.message, retryAfter: err.retryAfter });
  }
  if (err.code === 'LLM_REQUEST_FAILED' || err.code === 'LLM_EMPTY') return res.status(502).json({ error: err.message });
  if (err.code === 'SCOPE_NOT_FOUND') return res.status(404).json({ error: 'Site not found.' });
  if (err.code === 'BAD_SCOPE') return res.status(400).json({ error: err.message });
  return next(err);
}

const SCOPE_NEEDED = { error: 'This report needs a site scope. Use /advisor/site-brief/:siteKey.', code: 'SCOPE_NEEDED' };

// Scoped Site 360 brief (routes/dell.js device-360 convention). Registered
// before every /advisor/:report path so 'site-brief' is never read as a report slug.
const siteBriefParam = param('siteKey').matches(/^[a-z0-9-]{1,80}$/);
const siteExists = (siteKey) => !!db.prepare('SELECT 1 FROM lm_sites WHERE site_key = ? LIMIT 1').get(siteKey);

router.get('/advisor/site-brief/:siteKey', [siteBriefParam], validate, (req, res, next) => {
  try {
    const scope = req.params.siteKey;
    if (!siteExists(scope)) return notFound(res, 'Site');
    res.json({ enabled: lmAdvisor.isConfigured(), report: lmAdvisor.getCachedReport('site_brief', { scope }) });
  } catch (err) { next(err); }
});
router.post('/advisor/site-brief/:siteKey', [siteBriefParam], validate, async (req, res, next) => {
  try {
    const scope = req.params.siteKey;
    if (!siteExists(scope)) return notFound(res, 'Site');
    res.json(await lmAdvisor.generateReport('site_brief', { scope }));
  } catch (err) { advisorError(err, res, next); }
});
router.post('/advisor/site-brief/:siteKey/email', [siteBriefParam], validate, (req, res, next) => {
  if (!siteExists(req.params.siteKey)) return notFound(res, 'Site');
  req.params.report = 'site_brief';
  req.body = { ...(req.body || {}), scope: req.params.siteKey };
  return lmAdvisor.emailRoute('LogicMonitor')(req, res, next);
});

// Section 9 aliases (/advisor/reports/...), registered before the template's
// /advisor/:report so 'reports' is never read as a report slug.
router.get('/advisor/reports', (req, res, next) => {
  try { res.json({ enabled: lmAdvisor.isConfigured(), reports: lmAdvisor.REPORTS }); } catch (err) { next(err); }
});
router.get('/advisor/reports/:key', [param('key').isString()], validate, (req, res, next) => {
  try {
    const key = advisorReportKey(req.params.key);
    if (!lmAdvisor.REPORTS.includes(key)) return res.status(404).json({ error: 'Unknown report.' });
    if (lmAdvisor.isScoped(key)) return res.status(400).json(SCOPE_NEEDED);
    res.json({ enabled: lmAdvisor.isConfigured(), report: lmAdvisor.getCachedReport(key) });
  } catch (err) { next(err); }
});
router.post('/advisor/reports/:key/generate', [param('key').isString()], validate, async (req, res, next) => {
  try {
    const key = advisorReportKey(req.params.key);
    if (!lmAdvisor.REPORTS.includes(key)) return res.status(404).json({ error: 'Unknown report.' });
    if (lmAdvisor.isScoped(key)) return res.status(400).json(SCOPE_NEEDED);
    res.json(await lmAdvisor.generateReport(key));
  } catch (err) { advisorError(err, res, next); }
});
router.post('/advisor/reports/:key/email', (req, res, next) => {
  req.params.report = advisorReportKey(req.params.key);
  if (lmAdvisor.isScoped(req.params.report)) return res.status(400).json(SCOPE_NEEDED);
  return lmAdvisor.emailRoute('LogicMonitor')(req, res, next);
});

/** GET /api/logicmonitor/advisor/:report - cached LogicMonitor AI Advisor report. */
router.get('/advisor/:report', [param('report').isString()], validate, (req, res, next) => {
  try {
    const key = advisorReportKey(req.params.report);
    if (!lmAdvisor.REPORTS.includes(key)) return res.status(404).json({ error: 'Unknown report.' });
    if (lmAdvisor.isScoped(key)) return res.status(400).json(SCOPE_NEEDED);
    res.json({ enabled: lmAdvisor.isConfigured(), report: lmAdvisor.getCachedReport(key) });
  } catch (err) { next(err); }
});

/** POST /api/logicmonitor/advisor/:report - (re)generate and cache a report. */
router.post('/advisor/:report', [param('report').isString()], validate, async (req, res, next) => {
  try {
    const key = advisorReportKey(req.params.report);
    if (!lmAdvisor.REPORTS.includes(key)) return res.status(404).json({ error: 'Unknown report.' });
    if (lmAdvisor.isScoped(key)) return res.status(400).json(SCOPE_NEEDED);
    res.json(await lmAdvisor.generateReport(key));
  } catch (err) { advisorError(err, res, next); }
});

// Ad-hoc email of the cached advisor report (user-clicked, never scheduled).
router.post('/advisor/:report/email', (req, res, next) => {
  if (lmAdvisor.isScoped(advisorReportKey(req.params.report))) return res.status(400).json(SCOPE_NEEDED);
  return lmAdvisor.emailRoute('LogicMonitor')(req, res, next);
});

// ---- Round 8: DataSource metrics, firewalls, load balancers -----------------
// Everything here reads lm_ds_metrics / lm_ds_instances (migration v5) written
// by the metrics tier. Enum meaning (HA states, F5 failover, availability
// colours, tunnel state) is UNVERIFIED and lives in logicmonitorIssues.

const lmCatalog = () => { try { return require('../services/logicmonitorCatalog'); } catch { return null; } };

const DEFAULT_FAMILY_LABELS = {
  firewall: 'Firewalls', loadbalancer: 'Load balancers', health: 'Device health', optics: 'Optics',
  routing: 'Routing', ipsla: 'IP SLA', voice: 'Voice', wireless: 'Wireless', cloud: 'Cloud circuits',
};
const DEFAULT_FAMILIES = Object.keys(DEFAULT_FAMILY_LABELS);
const familyIds = () => {
  const c = lmCatalog();
  return c && Array.isArray(c.FAMILIES) && c.FAMILIES.length ? c.FAMILIES.map((f) => (typeof f === 'string' ? f : f.id || f.family)) : DEFAULT_FAMILIES;
};
const familyLabel = (f) => {
  const c = lmCatalog();
  return (c && c.FAMILY_LABELS && c.FAMILY_LABELS[f]) || DEFAULT_FAMILY_LABELS[f] || f;
};
const catalogEntry = (dsName) => { const c = lmCatalog(); try { return c ? c.catalogFor(dsName) : null; } catch { return null; } };
/** {unit, kind, label} for a metric key on a DataSource, from the catalog. */
const metricMeta = (dsName, metric) => {
  const e = catalogEntry(dsName);
  const m = e && e.metrics && e.metrics[metric];
  return { unit: (m && m.unit) || '', kind: (m && m.kind) || null, label: (m && m.label) || metric };
};
const epochToIso = (e) => (e == null || !Number.isFinite(Number(e)) ? null : new Date(Number(e) * 1000).toISOString());
const rnd1 = (v) => (v == null ? null : Math.round(Number(v) * 10) / 10);

function sourceFamilies(row) {
  const v = parseJson(row.metrics_families_json, null);
  return Array.isArray(v) ? v.map(String) : null;
}

/** Raw numeric -> text for an enum with a name table; unknown values render as the number. */
const enumText = (table, v) => (v == null ? null : (table[Math.round(v)] != null ? table[Math.round(v)] : String(Math.round(v))));
// F5 sysCmSyncStatus (UNVERIFIED numbering).
const SYNC_TEXT = { 0: 'unknown', 1: 'syncing', 2: 'needs manual sync', 3: 'in sync', 4: 'changes pending', 5: 'standalone', 6: 'awaiting initial sync', 7: 'incompatible version', 8: 'partial sync' };
const availText = (v) => { const s = lmIssues().availState(v); return s === 'unknown' && v != null ? String(Math.round(v)) : s; };

// ---- /metrics/families -----------------------------------------------------

router.get('/metrics/families', (req, res, next) => {
  try {
    const sources = db.prepare('SELECT id, name, enabled, metrics_poll_minutes, metrics_families_json FROM lm_sources ORDER BY name').all();
    const fams = familyIds();
    const inv = new Map(fams.map((f) => [f, { names: new Set(), devices: new Set(), instances: 0, last: null }]));
    const rows = db.prepare(`
      SELECT x.datasource_name name, x.source_id, x.lm_device_id, COALESCE(x.instance_count, 0) n, x.metrics_last_at
      FROM lm_device_datasources x
      JOIN lm_devices d ON d.source_id = x.source_id AND d.lm_device_id = x.lm_device_id AND d.stale = 0
      WHERE COALESCE(x.instance_count, 0) > 0 AND COALESCE(x.stop_monitoring, 0) = 0
        AND COALESCE(x.is_interface, 0) = 0 AND COALESCE(x.is_neighbor, 0) = 0
    `).all();
    const famOfName = new Map();
    for (const r of rows) {
      if (!famOfName.has(r.name)) { const e = catalogEntry(r.name); famOfName.set(r.name, e ? e.family : null); }
      const f = famOfName.get(r.name);
      if (!f || !inv.has(f)) continue;
      const a = inv.get(f);
      a.names.add(r.name);
      a.devices.add(`${r.source_id}:${r.lm_device_id}`);
      a.instances += r.n;
      if (r.metrics_last_at && (!a.last || r.metrics_last_at > a.last)) a.last = r.metrics_last_at;
    }
    const collected = new Map();
    try {
      for (const r of db.prepare(`
        SELECT family, COUNT(DISTINCT source_id || ':' || lm_device_id) devices, COUNT(*) instances
        FROM lm_ds_instances WHERE stale = 0 GROUP BY family`).all()) collected.set(r.family, r);
    } catch { /* tables not migrated */ }
    const lastByFamily = new Map();
    try {
      for (const r of db.prepare('SELECT family, MAX(updated_at) last FROM lm_ds_metrics GROUP BY family').all()) lastByFamily.set(r.family, r.last);
    } catch { /* tables not migrated */ }
    res.json(fams.map((f) => {
      const a = inv.get(f);
      const c = collected.get(f);
      const perSource = sources.map((s) => {
        const fl = sourceFamilies(s);
        return { sourceId: s.id, sourceName: s.name, enabled: Number(s.enabled) !== 0 && (fl == null || fl.includes(f)) };
      });
      return {
        family: f,
        label: familyLabel(f),
        enabled: perSource.some((p) => p.enabled),
        sources: perSource,
        datasources: a.names.size,
        devices: a.devices.size,
        instances: a.instances,
        collectedDevices: c ? c.devices : 0,
        collectedInstances: c ? c.instances : 0,
        lastPollAt: sqlIso(lastByFamily.get(f) || a.last),
      };
    }));
  } catch (err) { next(err); }
});

// ---- Shared device rollups --------------------------------------------------

const FW_WHERE = `(d.role = 'firewall' OR d.vendor LIKE 'Palo Alto%' OR EXISTS (
  SELECT 1 FROM lm_ds_metrics m WHERE m.source_id = d.source_id AND m.lm_device_id = d.lm_device_id AND m.family = 'firewall'))`;
const LB_WHERE = `(d.role = 'load-balancer' OR d.vendor = 'F5' OR EXISTS (
  SELECT 1 FROM lm_ds_metrics m WHERE m.source_id = d.source_id AND m.lm_device_id = d.lm_device_id AND m.family = 'loadbalancer'))`;

function roleDevices(whereSql, q = {}) {
  const where = ['d.stale = 0', whereSql];
  const params = [];
  if (q.q) {
    where.push("(d.display_name LIKE ? ESCAPE '\\' OR d.name LIKE ? ESCAPE '\\' OR d.model LIKE ? ESCAPE '\\' OR d.ips_json LIKE ? ESCAPE '\\')");
    const p = likePat(q.q);
    params.push(p, p, p, p);
  }
  if (q.siteKey) { where.push('d.site_key = ?'); params.push(String(q.siteKey)); }
  if (q.vendor) { where.push("COALESCE(d.vendor, 'Unknown') = ?"); params.push(String(q.vendor)); }
  if (q.sourceId) { where.push('d.source_id = ?'); params.push(Number(q.sourceId)); }
  return db.prepare(`${DEVICE_SELECT} WHERE ${where.join(' AND ')} ORDER BY d.display_name, d.source_id`).all(...params);
}

/** Open computed issues that name this device (target is the device or starts with "<device> "). */
function issuesOnDevice(issues, name) {
  const n = String(name || '');
  return issues.filter((i) => {
    const t = String(i.target || '');
    return t === n || t.startsWith(`${n} `) || (t.includes(' + ') && t.split(' + ').includes(n));
  });
}
function stateFromIssues(devIssues, hasData) {
  if (devIssues.some((i) => i.severity === 'critical')) return 'critical';
  if (devIssues.some((i) => i.severity === 'warning')) return 'warning';
  return hasData ? 'ok' : 'unknown';
}
const maxEpoch = (dev) => {
  let best = null;
  for (const inst of dev.instances.values()) for (const m of Object.values(inst.m)) if (m.epoch != null && (best == null || m.epoch > best)) best = m.epoch;
  return best;
};
const sumMetric = (dev, metric) => {
  const inst = lmIssues().devInstances(dev, metric);
  return inst.length ? inst.reduce((s, i) => s + i.m[metric].value, 0) : null;
};

/** Counter growth per unit time from history (monotonic series only), summed over instances; null when unknown. */
function counterRates(metric, perSeconds, windowSec = 10800) {
  const out = new Map();
  try {
    const since = nowSec() - windowSec;
    const series = new Map();
    for (const r of db.prepare(`
      SELECT source_id, lm_device_id, hds_id, instance_key, sampled_at_epoch e, value v FROM lm_ds_metrics_history
      WHERE metric = ? AND sampled_at_epoch >= ? ORDER BY sampled_at_epoch`).all(metric, since)) {
      const k = `${r.source_id}:${r.lm_device_id}|${r.hds_id}|${r.instance_key}`;
      if (!series.has(k)) series.set(k, []);
      series.get(k).push(r);
    }
    for (const [k, pts] of series) {
      if (pts.length < 2) continue;
      let mono = true;
      for (let i = 1; i < pts.length; i += 1) if (pts[i].v < pts[i - 1].v) { mono = false; break; }
      const span = pts[pts.length - 1].e - pts[0].e;
      if (!mono || span <= 0) continue;
      const rate = ((pts[pts.length - 1].v - pts[0].v) / span) * perSeconds;
      const dk = k.split('|')[0];
      out.set(dk, (out.get(dk) || 0) + rate);
    }
  } catch { /* history table missing */ }
  return out;
}

function historySeries(sourceId, deviceId, hdsId, key, metric, hours) {
  const since = nowSec() - Math.max(1, Number(hours) || 24) * 3600;
  return db.prepare(`
    SELECT sampled_at_epoch epoch, value FROM lm_ds_metrics_history
    WHERE source_id = ? AND lm_device_id = ? AND hds_id = ? AND instance_key = ? AND metric = ? AND sampled_at_epoch >= ?
    ORDER BY sampled_at_epoch
  `).all(sourceId, deviceId, hdsId, key, metric, since);
}
/** History of the first instance of a device that carries the metric ([] when none). */
function deviceSeries(dev, metric, hours = 24) {
  const hit = lmIssues().devInstances(dev, metric)[0];
  return hit ? historySeries(dev.sourceId, dev.deviceId, hit.hds, hit.key, metric, hours) : [];
}

const devBase = (r, lk) => {
  const o = deviceOut(r, lk);
  return {
    deviceId: o.id, sourceId: o.sourceId, deviceName: o.displayName || o.name, siteKey: o.siteKey, siteName: o.siteName,
    vendor: o.vendor, model: o.model, version: o.version, hostStatus: o.hostStatus,
  };
};

// ---- Firewalls ---------------------------------------------------------------

const fwBool = (v) => (v == null ? null : Math.round(v) === 1);
// Round 12: a percent outside 0..100 is a wrong catalog pick, never shown as a number.
const pctOnly = (v) => (v == null || !Number.isFinite(Number(v)) || v < 0 || v > 100 ? null : rnd1(v));

function firewallRow(r, lk, dev, issues, rates) {
  const L = lmIssues();
  const dv = dev || { instances: new Map(), sourceId: r.source_id, deviceId: r.lm_device_id, name: r.display_name || r.name };
  const name = r.display_name || r.name;
  const haEnabledRaw = L.devVal(dv, 'ha_enabled');
  const haLocalRaw = L.devVal(dv, 'ha_local_state');
  const haPeerRaw = L.devVal(dv, 'ha_peer_state');
  const haOn = L.isHaEnabled(haEnabledRaw, haLocalRaw, haPeerRaw);
  const haLocal = L.haText(haLocalRaw);
  const haPeer = L.haText(haPeerRaw);
  const act = L.devVal(dv, 'sessions_active');
  const max = L.devVal(dv, 'sessions_max');
  let util = L.devVal(dv, 'sessions_util_pct');
  if (util == null && act != null && max) util = (act / max) * 100;
  const core = L.devMax(dv, 'core_cpu_pct');
  const mgmt = L.devVal(dv, 'mgmt_cpu_pct') ?? L.devVal(dv, 'asa_cpu_pct') ?? L.devVal(dv, 'cpu_pct');
  const mem = L.devVal(dv, 'mem_pct') ?? L.devVal(dv, 'asa_mem_pct');
  const tunnels = L.devInstances(dv, 'tunnel_state');
  let tUp = L.devVal(dv, 'tunnels_up');
  let tDown = L.devVal(dv, 'tunnels_down');
  if (tUp == null && tDown == null && tunnels.length) {
    tDown = tunnels.filter((i) => L.tunnelIsDown(i.m.tunnel_state.value)).length;
    tUp = tunnels.length - tDown;
  }
  const dk = `${r.source_id}:${r.lm_device_id}`;
  const devIssues = issuesOnDevice(issues, name);
  const hasData = dv.instances.size > 0;
  return {
    ...devBase(r, lk),
    haEnabled: hasData ? haOn : null,
    haLocalState: haLocal,
    haPeerState: haPeer,
    haLocalRaw: haLocalRaw == null ? null : Math.round(haLocalRaw),
    haPeerRaw: haPeerRaw == null ? null : Math.round(haPeerRaw),
    haText: !hasData || (haLocalRaw == null && haPeerRaw == null) ? null : (haOn ? `${haLocal || 'n/a'} / ${haPeer || 'n/a'}` : 'off'),
    sessionsActive: act,
    sessionsMax: max,
    sessionsUtilPct: pctOnly(util),
    dataplaneCpuPct: core ? pctOnly(core.value) : null,
    mgmtCpuPct: pctOnly(mgmt),
    memPct: pctOnly(mem),
    tunnelsUp: tUp,
    tunnelsDown: tDown,
    gpUsers: L.devVal(dv, 'gp_users_active'),
    configSynced: fwBool(L.devVal(dv, 'config_synced')),
    threatsPerHour: rates && rates.threats.has(dk) ? rnd1(rates.threats.get(dk)) : null,
    droppedPerMin: rates && rates.dropped.has(dk) ? rnd1(rates.dropped.get(dk)) : null,
    state: stateFromIssues(devIssues, hasData),
    sampledAt: epochToIso(maxEpoch(dv)),
  };
}

const FW_COLUMNS = ['deviceName', 'siteName', 'vendor', 'model', 'version', 'hostStatus', 'haText', 'sessionsActive', 'sessionsMax', 'sessionsUtilPct',
  'dataplaneCpuPct', 'mgmtCpuPct', 'memPct', 'tunnelsUp', 'tunnelsDown', 'gpUsers', 'configSynced', 'threatsPerHour', 'droppedPerMin', 'state', 'sampledAt'];

const dsListRules = [
  query('q').optional().isString().trim().isLength({ max: 200 }),
  query('siteKey').optional().matches(/^[a-z0-9-]{1,80}$/),
  query('vendor').optional().isString().trim().isLength({ max: 64 }),
  query('sourceId').optional().isInt().toInt(),
  query('state').optional().isIn(['critical', 'warning', 'ok', 'unknown']),
];

function firewallRows(q) {
  const lk = lookups();
  const devs = roleDevices(FW_WHERE, q);
  const index = lmIssues().loadDsIndex(db, { families: ['firewall', 'health'] });
  const issues = safeIssues();
  const rates = { threats: counterRates('threats_total', 3600), dropped: counterRates('dropped', 60) };
  let rows = devs.map((r) => firewallRow(r, lk, index.get(`${r.source_id}:${r.lm_device_id}`), issues, rates));
  if (q.state) rows = rows.filter((r) => r.state === q.state);
  return rows;
}

// Literal .csv path before /firewalls/:deviceId.
router.get('/firewalls.csv', dsListRules, validate, (req, res, next) => {
  try { sendCsv(res, 'firewalls', firewallRows(req.query), FW_COLUMNS); } catch (err) { next(err); }
});
router.get('/firewalls', dsListRules, validate, (req, res, next) => {
  try { res.json(firewallRows(req.query)); } catch (err) { next(err); }
});

const deviceParams = [param('deviceId').isInt().toInt(), query('sourceId').optional().isInt().toInt()];
/** Device row that also matches a role selector, else null. */
function roleDevice(whereSql, id, sourceId) {
  const args = [id];
  let extra = '';
  if (sourceId) { extra = ' AND d.source_id = ?'; args.push(sourceId); }
  return db.prepare(`${DEVICE_SELECT} WHERE d.lm_device_id = ? AND d.stale = 0 AND ${whereSql}${extra} ORDER BY d.source_id LIMIT 1`).get(...args) || null;
}
const rowsOf = (dev, metric) => (dev ? lmIssues().devInstances(dev, metric) : []);
const num = (inst, metric) => (inst.m[metric] ? inst.m[metric].value : null);

router.get('/firewalls/:deviceId', deviceParams, validate, (req, res, next) => {
  try {
    const r = roleDevice(FW_WHERE, req.params.deviceId, req.query.sourceId);
    if (!r) return notFound(res, 'Firewall');
    const L = lmIssues();
    const lk = lookups();
    const idx = L.loadDsIndex(db, { sourceId: r.source_id, deviceId: r.lm_device_id });
    const dev = idx.get(`${r.source_id}:${r.lm_device_id}`) || { instances: new Map(), sourceId: r.source_id, deviceId: r.lm_device_id, name: r.display_name || r.name };
    const issues = safeIssues();
    const rates = { threats: counterRates('threats_total', 3600), dropped: counterRates('dropped', 60) };
    const summary = firewallRow(r, lk, dev, issues, rates);
    const byKey = (a, b) => String(a.name).localeCompare(String(b.name));
    const ifState = (v) => (v == null ? null : (Math.round(v) === 1 ? 'up' : Math.round(v) === 0 ? 'down' : String(Math.round(v))));
    const ha = rowsOf(dev, 'ha_if_state').map((i) => ({ name: i.name, state: ifState(num(i, 'ha_if_state')), raw: num(i, 'ha_if_state') })).sort(byKey);
    const tunnels = rowsOf(dev, 'tunnel_state').map((i) => ({
      name: i.name,
      state: L.tunnelIsDown(num(i, 'tunnel_state')) ? 'down' : 'up',
      stateRaw: num(i, 'tunnel_state'),
      inBps: num(i, 'tunnel_in_bps'),
      outBps: num(i, 'tunnel_out_bps'),
    })).sort((a, b) => (a.state === b.state ? byKey(a, b) : a.state === 'down' ? -1 : 1));
    const zoneInst = [...dev.instances.values()].filter((i) => i.m.zone_sessions || i.m.zone_in_bps || i.m.zone_out_bps);
    const zones = zoneInst
      .map((i) => ({ name: i.name, inBps: num(i, 'zone_in_bps'), outBps: num(i, 'zone_out_bps'), sessions: num(i, 'zone_sessions') })).sort(byKey);
    const vsys = rowsOf(dev, 'vsys_sessions').map((i) => ({ name: i.name, sessions: num(i, 'vsys_sessions'), utilPct: rnd1(num(i, 'vsys_util_pct')) })).sort(byKey);
    const gateways = rowsOf(dev, 'gp_users_active').map((i) => ({ name: i.name, users: num(i, 'gp_users_active'), maxUsers: num(i, 'gp_users_max'), tunnels: num(i, 'gp_tunnels') })).sort(byKey);
    const logForwarding = rowsOf(dev, 'log_forwarded').map((i) => ({ name: i.name, forwarded: num(i, 'log_forwarded'), dropped: num(i, 'log_dropped') })).sort(byKey);
    const hardware = {
      disks: rowsOf(dev, 'disk_used_pct').map((i) => ({ name: i.name, usedPct: rnd1(num(i, 'disk_used_pct')) })).sort(byKey),
      psus: [...new Map([...rowsOf(dev, 'psu_state'), ...rowsOf(dev, 'psu_low_alarm'), ...rowsOf(dev, 'psu_high_alarm')].map((i) => [i.name, i])).values()].map((i) => {
        const alarm = (num(i, 'psu_low_alarm') || 0) + (num(i, 'psu_high_alarm') || 0);
        const st = num(i, 'psu_state');
        return { name: i.name, state: st != null ? st : alarm, ok: !(L.stateIsFault(st) || alarm >= 1), voltage: rnd1(num(i, 'cur_voltage')) };
      }).sort(byKey),
      temps: rowsOf(dev, 'temp_c').map((i) => ({ name: i.name, tempC: rnd1(num(i, 'temp_c')), alarm: i.m.temp_alarm ? Math.round(i.m.temp_alarm.value) !== 0 : null })).sort(byKey),
      chassisWatts: L.devVal(dev, 'chassis_watts'),
    };
    const bgp = rowsOf(dev, 'bgp_peer_state').map((i) => ({
      name: i.name, state: num(i, 'bgp_peer_state'), established: Math.round(num(i, 'bgp_peer_state')) === 6, prefixes: num(i, 'bgp_prefixes'),
    })).sort(byKey);
    const ospf = rowsOf(dev, 'ospf_nbr_state').map((i) => ({ name: i.name, state: num(i, 'ospf_nbr_state'), full: Math.round(num(i, 'ospf_nbr_state')) === 8 })).sort(byKey);
    const name = r.display_name || r.name;
    res.json({
      device: deviceOut(r, lk),
      summary,
      ha,
      tunnels,
      zones,
      vsys,
      globalProtect: {
        users: L.devVal(dev, 'gp_users_active'), maxUsers: L.devVal(dev, 'gp_users_max'), tunnels: L.devVal(dev, 'gp_tunnels'), gateways,
      },
      logForwarding,
      hardware,
      routing: { bgp, ospf },
      sessionsHistory: { utilPct: deviceSeries(dev, 'sessions_util_pct', 24), active: deviceSeries(dev, 'sessions_active', 24) },
      issues: issuesOnDevice(issues, name),
    });
  } catch (err) { next(err); }
});

// ---- Load balancers -----------------------------------------------------------

function memberName(key, pool) {
  const k = String(key || '').replace(/^\/+/, '').replace(/^Common\//i, '');
  return k.length > pool.length + 1 ? k.slice(pool.length + 1) : k;
}

function lbRow(r, lk, dev, issues, certWarn) {
  const L = lmIssues();
  const dv = dev || { instances: new Map(), sourceId: r.source_id, deviceId: r.lm_device_id, name: r.display_name || r.name };
  const name = r.display_name || r.name;
  const foRaw = L.devVal(dv, 'failover_state');
  const syncRaw = L.devVal(dv, 'sync_state');
  const pools = new Map();
  for (const i of L.devInstances(dv, 'member_avail')) {
    const p = L.poolOf(i.key);
    const e = pools.get(p) || { total: 0, down: 0 };
    e.total += 1;
    if (L.availState(i.m.member_avail.value) === 'down') e.down += 1;
    pools.set(p, e);
  }
  const wide = L.devInstances(dv, 'wideip_avail');
  const vips = L.devInstances(dv, 'vip_avail');
  const down = (list, metric) => list.filter((i) => L.availState(i.m[metric].value) === 'down').length;
  const devIssues = issuesOnDevice(issues, name);
  const hasData = dv.instances.size > 0;
  return {
    ...devBase(r, lk),
    failoverState: foRaw == null ? null : Math.round(foRaw),
    failoverText: foRaw == null ? null : L.failoverText(foRaw),
    syncState: enumText(SYNC_TEXT, syncRaw),
    cpuPct: pctOnly(L.devVal(dv, 'cpu_pct')),
    memPct: pctOnly(L.devVal(dv, 'mem_pct') ?? L.devVal(dv, 'host_mem_pct')),
    clientConnections: L.devVal(dv, 'client_connections'),
    serverConnections: L.devVal(dv, 'server_connections'),
    pools: pools.size,
    poolsDegraded: [...pools.values()].filter((e) => e.down > 0).length,
    membersTotal: [...pools.values()].reduce((s, e) => s + e.total, 0),
    membersDown: [...pools.values()].reduce((s, e) => s + e.down, 0),
    wideIps: wide.length,
    wideIpsDown: down(wide, 'wideip_avail'),
    vips: vips.length,
    vipsDown: down(vips, 'vip_avail'),
    daemonsDown: L.devInstances(dv, 'daemon_state').filter((i) => Math.round(i.m.daemon_state.value) !== 1).length
      + L.devInstances(dv, 'daemon_exit').filter((i) => i.m.daemon_exit.value != null && Math.round(i.m.daemon_exit.value) !== 0).length,
    certsExpiring: L.devInstances(dv, 'cert_days_left').filter((i) => i.m.cert_days_left.value < certWarn).length,
    state: stateFromIssues(devIssues, hasData),
    sampledAt: epochToIso(maxEpoch(dv)),
  };
}

const LB_COLUMNS = ['deviceName', 'siteName', 'vendor', 'model', 'version', 'hostStatus', 'failoverText', 'syncState', 'cpuPct', 'memPct', 'clientConnections',
  'serverConnections', 'pools', 'poolsDegraded', 'membersTotal', 'membersDown', 'wideIps', 'wideIpsDown', 'vips', 'vipsDown', 'daemonsDown', 'certsExpiring', 'state', 'sampledAt'];

const lbListRules = dsListRules.filter((x, i) => i !== 2); // no vendor filter: every row is F5

function lbRows(q) {
  const lk = lookups();
  const devs = roleDevices(LB_WHERE, q);
  const index = lmIssues().loadDsIndex(db, { families: ['loadbalancer', 'health'] });
  const issues = safeIssues();
  const certWarn = thr('lm_cert_warn_days');
  let rows = devs.map((r) => lbRow(r, lk, index.get(`${r.source_id}:${r.lm_device_id}`), issues, certWarn));
  if (q.state) rows = rows.filter((r) => r.state === q.state);
  return rows;
}

router.get('/load-balancers.csv', lbListRules, validate, (req, res, next) => {
  try { sendCsv(res, 'load-balancers', lbRows(req.query), LB_COLUMNS); } catch (err) { next(err); }
});
router.get('/load-balancers', lbListRules, validate, (req, res, next) => {
  try { res.json(lbRows(req.query)); } catch (err) { next(err); }
});

router.get('/load-balancers/:deviceId', [...deviceParams, query('page').optional().isInt({ min: 1 }), limitValidator], validate, (req, res, next) => {
  try {
    const r = roleDevice(LB_WHERE, req.params.deviceId, req.query.sourceId);
    if (!r) return notFound(res, 'Load balancer');
    const L = lmIssues();
    const lk = lookups();
    const idx = L.loadDsIndex(db, { sourceId: r.source_id, deviceId: r.lm_device_id });
    const dev = idx.get(`${r.source_id}:${r.lm_device_id}`) || { instances: new Map(), sourceId: r.source_id, deviceId: r.lm_device_id, name: r.display_name || r.name };
    const issues = safeIssues();
    const certWarn = thr('lm_cert_warn_days');
    const summary = lbRow(r, lk, dev, issues, certWarn);
    const byName = (a, b) => String(a.name).localeCompare(String(b.name));
    const availOut = (i, metric) => ({ avail: availText(num(i, metric)), availRaw: num(i, metric) });

    // Pool = instance key text before the first '/' or ':' (an assumption, see poolOf).
    const poolMap = new Map();
    for (const i of rowsOf(dev, 'member_avail')) {
      const p = L.poolOf(i.key);
      if (!poolMap.has(p)) poolMap.set(p, { pool: p, members: [], up: 0, down: 0 });
      const e = poolMap.get(p);
      const st = L.availState(num(i, 'member_avail'));
      if (st === 'down') e.down += 1; else if (st === 'up' || st === 'warn') e.up += 1;
      e.members.push({
        member: memberName(i.key, p), key: i.key, ...availOut(i, 'member_avail'),
        enabled: i.m.member_enabled ? Math.round(i.m.member_enabled.value) === 1 : null, connections: num(i, 'member_connections'),
      });
    }
    const pools = [...poolMap.values()].map((e) => ({ ...e, members: e.members.sort((a, b) => a.member.localeCompare(b.member)) }))
      .sort((a, b) => (b.down - a.down) || a.pool.localeCompare(b.pool));

    const wideIps = rowsOf(dev, 'wideip_avail').map((i) => ({ name: i.name, ...availOut(i, 'wideip_avail'), requests: num(i, 'wideip_requests') })).sort(byName);
    const vipAll = rowsOf(dev, 'vip_avail').map((i) => ({
      name: i.name, ...availOut(i, 'vip_avail'), enabled: i.m.vip_enabled ? Math.round(i.m.vip_enabled.value) === 1 : null,
    })).sort(byName);
    const { limit, page, offset } = pageArgs({ query: { page: req.query.page, limit: req.query.limit || '50' } });
    const gtmServers = rowsOf(dev, 'gtm_server_avail').map((i) => ({ name: i.name, ...availOut(i, 'gtm_server_avail') })).sort(byName);
    const datacenters = rowsOf(dev, 'dc_avail').map((i) => ({ name: i.name, ...availOut(i, 'dc_avail') })).sort(byName);
    const daemons = rowsOf(dev, 'daemon_state').map((i) => ({ name: i.name, state: Math.round(num(i, 'daemon_state')) === 1 ? 'running' : 'down', raw: num(i, 'daemon_state') }))
      .concat(rowsOf(dev, 'daemon_exit').map((i) => ({ name: i.name, state: num(i, 'daemon_exit') == null || Math.round(num(i, 'daemon_exit')) === 0 ? 'running' : 'down', raw: num(i, 'daemon_exit') })))
      .sort(byName);
    const certs = rowsOf(dev, 'cert_days_left').map((i) => ({ name: i.name, daysLeft: rnd1(num(i, 'cert_days_left')) })).sort((a, b) => a.daysLeft - b.daysLeft);
    const hardware = {
      fans: rowsOf(dev, 'fan_state').concat(rowsOf(dev, 'f5os_fan_state')).map((i) => ({ name: i.name, state: num(i, 'fan_state') ?? num(i, 'f5os_fan_state') })).sort(byName),
      psus: rowsOf(dev, 'psu_state').map((i) => ({ name: i.name, state: num(i, 'psu_state'), ok: !L.stateIsFault(num(i, 'psu_state')) })).sort(byName),
      temps: rowsOf(dev, 'temp_c').concat(rowsOf(dev, 'f5os_temp_c')).map((i) => ({ name: i.name, tempC: rnd1(num(i, 'temp_c') ?? num(i, 'f5os_temp_c')) })).sort(byName),
      filesystems: rowsOf(dev, 'fs_used_pct').map((i) => ({ name: i.name, usedPct: rnd1(num(i, 'fs_used_pct')) })).sort(byName),
      tmmMemPct: pctOnly(L.devVal(dev, 'tmm_mem_pct')),
      // F5_BigIP_Memory carries byte counts only (RealMemTotal, RealMemAvailable), so the host
      // percent is derived when the pick is absent.
      hostMemPct: pctOnly(L.devVal(dev, 'host_mem_pct') ?? (() => {
        const total = L.devVal(dev, 'mem_total_bytes');
        const avail = L.devVal(dev, 'mem_avail_bytes');
        return total > 0 && avail != null ? (100 * (1 - avail / total)) : null;
      })()),
    };
    // Round 12: F5_BigIP_Interfaces has no status datapoint and reports bytes per second; bps = bytes x 8.
    const bitsOf = (v) => (v == null ? null : Math.round(v * 8));
    const interfaces = [...new Map([...rowsOf(dev, 'if_status'), ...rowsOf(dev, 'if_in_bytes')].map((i) => [i.name, i])).values()]
      .map((i) => ({ name: i.name, status: num(i, 'if_status'), inBps: num(i, 'if_in_bps') ?? bitsOf(num(i, 'if_in_bytes')), outBps: num(i, 'if_out_bps') ?? bitsOf(num(i, 'if_out_bytes')) })).sort(byName);
    res.json({
      device: deviceOut(r, lk),
      summary,
      pools,
      wideIps,
      vips: { items: vipAll.slice(offset, offset + limit), total: vipAll.length, page, limit },
      gtmServers,
      datacenters,
      daemons,
      certs,
      hardware,
      interfaces,
      cpuHistory: deviceSeries(dev, 'cpu_pct', 24),
      connectionsHistory: { client: deviceSeries(dev, 'client_connections', 24), server: deviceSeries(dev, 'server_connections', 24) },
      issues: issuesOnDevice(issues, r.display_name || r.name),
    });
  } catch (err) { next(err); }
});

// ---- Wireless (Cisco WLC DataSources) -------------------------------------------

const WLC_WHERE = `(d.role = 'wireless' OR EXISTS (
  SELECT 1 FROM lm_ds_metrics m WHERE m.source_id = d.source_id AND m.lm_device_id = d.lm_device_id AND m.family = 'wireless'))`;
const PROFILE_KEYS = { load: 'radio_load_profile', noise: 'radio_noise_profile', interference: 'radio_interference_profile', coverage: 'radio_coverage_profile' };
const BANDS = ['2.4 GHz', '5 GHz', '5/6 GHz'];
const profileText = (v) => (v == null ? null : Math.round(v) === 1 ? 'pass' : Math.round(v) === 2 ? 'fail' : String(Math.round(v)));
const sumOf = (list, pick) => list.reduce((s, x) => s + (Number(pick(x)) || 0), 0);
const anyVal = (list, pick) => list.some((x) => pick(x) != null);
const wlcPlatform = (r) => (/C9800|9800/i.test(`${r.model || ''} ${r.sysinfo || ''}`) ? 'Catalyst 9800' : /AIR-CT|Cisco Controller/i.test(`${r.model || ''} ${r.sysinfo || ''}`) ? 'AireOS' : (r.vendor || null));

/** Radios of one controller as page rows. */
function radioRowsOf(dev, ctrl, util) {
  const L = lmIssues();
  const out = [];
  const seen = new Set();
  for (const inst of dev.instances.values()) {
    if (inst.ds !== 'Cisco_Wireless_AccessPointRadio' || seen.has(inst.key)) continue;
    seen.add(inst.key);
    const v = (k) => (inst.m[k] ? inst.m[k].value : null);
    const slot = L.slotOfRadio(inst.key);
    const disabled = L.isDisabled(v('radio_admin'));
    const oper = v('radio_oper');
    out.push({
      ...ctrl,
      radio: inst.name,
      ap: L.apOfRadio(inst.key),
      slot,
      band: L.bandOfSlot(slot),
      // Counted in totals and alerts: enabled, client-serving slot.
      counted: !disabled && L.isClientSlot(slot),
      state: disabled ? 'disabled' : L.radioIsUp(oper) ? 'up' : L.radioIsDown(oper) ? 'down' : 'unknown',
      channelUtilPct: rnd1(v('radio_util_pct')),
      rxUtilPct: rnd1(v('radio_rx_util_pct')),
      txUtilPct: rnd1(v('radio_tx_util_pct')),
      clients: v('radio_clients'),
      txPowerLevel: v('radio_tx_power'),
      loadProfile: profileText(v('radio_load_profile')),
      noiseProfile: profileText(v('radio_noise_profile')),
      interferenceProfile: profileText(v('radio_interference_profile')),
      coverageProfile: profileText(v('radio_coverage_profile')),
      hot: v('radio_util_pct') != null && v('radio_util_pct') >= util,
    });
  }
  return out;
}

/** AP ethernet ports of one controller grouped by AP name. */
function apPortsOf(dev) {
  const L = lmIssues();
  const byAp = new Map();
  for (const inst of dev.instances.values()) {
    if (inst.ds !== 'Cisco_Wireless_AccessPointInterfaces') continue;
    const v = (k) => (inst.m[k] ? inst.m[k].value : null);
    const ap = L.apOfIf(inst.key);
    if (!byAp.has(ap)) byAp.set(ap, []);
    byAp.get(ap).push({
      port: inst.key.slice(ap.length).replace(/^\s*-\s*/, '') || inst.key,
      state: v('apif_oper') == null ? null : Math.round(v('apif_oper')) === 1 ? 'up' : Math.round(v('apif_oper')) === 2 ? 'down' : String(Math.round(v('apif_oper'))),
      rxBps: v('apif_rx_bytes') == null ? null : v('apif_rx_bytes') * 8,
      txBps: v('apif_tx_bytes') == null ? null : v('apif_tx_bytes') * 8,
      inErrors: v('apif_in_errors'),
      outErrors: v('apif_out_errors'),
      inDrops: v('apif_in_drops'),
      outDrops: v('apif_out_drops'),
    });
  }
  return byAp;
}

/**
 * Everything the wireless pages read, built from one pass over the metric index:
 * controllers with their AP, radio and SSID rows. Filters: q, siteKey, sourceId.
 */
function wirelessModel(q = {}) {
  const L = lmIssues();
  const lk = lookups();
  const util = thr('lm_wlan_chan_util_warn_pct');
  const devs = roleDevices(WLC_WHERE, q);
  const index = L.loadDsIndex(db, { families: ['wireless', 'health'] });
  const missing = L.loadMissingAps(db);
  const issues = safeIssues();
  const controllers = [];
  for (const r of devs) {
    const dk = `${r.source_id}:${r.lm_device_id}`;
    const dev = index.get(dk) || { instances: new Map(), sourceId: r.source_id, deviceId: r.lm_device_id, name: r.display_name || r.name };
    const base = devBase(r, lk);
    const ctrl = { controllerId: base.deviceId, sourceId: base.sourceId, controller: base.deviceName, siteKey: base.siteKey, siteName: base.siteName };
    const radios = radioRowsOf(dev, ctrl, util);
    const ports = apPortsOf(dev);
    const radiosByAp = new Map();
    for (const rd of radios) {
      if (!radiosByAp.has(rd.ap)) radiosByAp.set(rd.ap, []);
      radiosByAp.get(rd.ap).push(rd);
    }
    const aps = L.wirelessAps(dev, missing.get(dk)).map((a) => {
      const all = radiosByAp.get(a.key) || [];
      const rs = all.filter((x) => x.counted);
      const ps = ports.get(a.key) || [];
      const utilMax = rs.reduce((mx, x) => (x.channelUtilPct != null && (mx == null || x.channelUtilPct > mx) ? x.channelUtilPct : mx), null);
      return {
        ...ctrl,
        ap: a.name,
        apKey: a.key,
        status: a.status,
        operText: a.operText,
        adminText: a.admin == null ? null : L.isDisabled(a.admin) ? 'disabled' : 'enabled',
        since: a.since || null,
        radiosTotal: rs.length,
        radiosUp: rs.filter((x) => x.state === 'up').length,
        radiosDown: rs.filter((x) => x.state === 'down').length,
        clients: anyVal(rs, (x) => x.clients) ? sumOf(rs, (x) => x.clients) : null,
        maxChannelUtilPct: utilMax,
        util24: rs.find((x) => x.slot === 0)?.channelUtilPct ?? null,
        util5: rs.find((x) => x.slot === 1)?.channelUtilPct ?? null,
        uplinkState: ps.length ? (ps.some((p) => p.state === 'up') ? 'up' : 'down') : null,
        uplinkRxBps: anyVal(ps, (p) => p.rxBps) ? sumOf(ps, (p) => p.rxBps) : null,
        uplinkTxBps: anyVal(ps, (p) => p.txBps) ? sumOf(ps, (p) => p.txBps) : null,
        uplinkErrors: anyVal(ps, (p) => p.inErrors) ? rnd1(sumOf(ps, (p) => p.inErrors) + sumOf(ps, (p) => p.outErrors)) : null,
        sampledAt: epochToIso(a.epoch),
      };
    });
    const ssids = [];
    for (const inst of dev.instances.values()) {
      if (!inst.m.ess_clients && !inst.m.ess_admin) continue;
      const v = (k) => (inst.m[k] ? inst.m[k].value : null);
      ssids.push({
        ...ctrl, ssid: inst.name, wlan: inst.key, hdsId: inst.hds,
        enabled: v('ess_admin') == null ? null : Math.round(v('ess_admin')) === 1,
        broadcast: v('ess_broadcast') == null ? null : Math.round(v('ess_broadcast')) === 1,
        clients: v('ess_clients'),
      });
    }
    const radius = L.devInstances(dev, 'radius_status').map((i) => {
      const v = (k) => (i.m[k] ? i.m[k].value : null);
      const enabled = Math.round(v('radius_status')) === 1;
      const answered = (v('radius_accepts') || 0) + (v('radius_rejects') || 0) + (v('radius_challenges') || 0);
      return {
        server: i.name, enabled, networkUsers: v('radius_network_user') == null ? null : Math.round(v('radius_network_user')) === 1,
        requests: v('radius_requests'), accepts: v('radius_accepts'), rejects: v('radius_rejects'), challenges: v('radius_challenges'),
        timeouts: v('radius_timeouts'), retransmissions: v('radius_retransmissions'), pending: v('radius_pending'),
        state: !enabled ? 'disabled' : (v('radius_timeouts') || 0) > 0 && answered === 0 ? 'unresponsive' : 'ok',
      };
    });
    const ha = L.devVal(dev, 'wlc_ha_peer_ok');
    const primary = L.devVal(dev, 'wlc_primary_unit');
    const mob = L.devVal(dev, 'wlc_mobility_status');
    const essClients = anyVal(ssids, (s) => s.clients) ? sumOf(ssids, (s) => s.clients) : null;
    const radioClients = anyVal(radios, (x) => x.clients) ? sumOf(radios, (x) => x.clients) : null;
    const counted = radios.filter((x) => x.counted);
    const upRadios = counted.filter((x) => x.state === 'up' && x.channelUtilPct != null);
    const devIssues = issuesOnDevice(issues, base.deviceName);
    const managed = aps.filter((a) => a.status !== 'disabled');
    const cpu = L.devMax(dev, 'cpu_pct');
    controllers.push({
      dev,
      r,
      issues: devIssues,
      radios,
      aps,
      ssids,
      radius,
      row: {
        ...base,
        platform: wlcPlatform(r),
        haText: ha != null ? (Math.round(ha) === 1 ? 'hot standby' : 'degraded') : primary != null ? (Math.round(primary) === 1 ? 'primary' : 'secondary') : null,
        haDegraded: ha != null && Math.round(ha) === 0,
        cpuPct: cpu ? rnd1(cpu.value) : null,
        memPct: rnd1(L.devMax(dev, 'mem_pct')?.value),
        tempC: rnd1(L.devVal(dev, 'temp_c')),
        apsTotal: managed.length,
        apsUp: managed.filter((a) => a.status === 'up' || a.status === 'downloading').length,
        apsDown: managed.filter((a) => L.apIsDown(a)).length,
        apsDisabled: aps.length - managed.length,
        apAvailablePct: (() => { const v = L.devVal(dev, 'wlc_ap_available_pct'); return v == null || v < 0 ? null : rnd1(v); })(),
        radiosTotal: counted.length,
        radiosUp: counted.filter((x) => x.state === 'up').length,
        radiosDown: counted.filter((x) => x.state === 'down').length,
        radiosDisabled: radios.filter((x) => x.state === 'disabled').length,
        radiosAux: radios.filter((x) => !L.isClientSlot(x.slot)).length,
        hotRadios: radios.filter((x) => x.hot).length,
        avgChannelUtilPct: upRadios.length ? rnd1(sumOf(upRadios, (x) => x.channelUtilPct) / upRadios.length) : null,
        clients: essClients ?? L.devVal(dev, 'wlc_clients') ?? radioClients,
        clientsMax: L.devVal(dev, 'wlc_clients_max'),
        clientUsagePct: rnd1(L.devVal(dev, 'wlc_client_usage_pct')),
        ssids: ssids.length,
        radiusServers: radius.length,
        radiusUnresponsive: radius.filter((x) => x.state === 'unresponsive').length,
        mobility: mob == null ? null : Math.round(mob) === 0 ? 'ok' : Math.round(mob) === 1 ? 'tunnels down' : 'check error',
        state: stateFromIssues(devIssues, dev.instances.size > 0),
        sampledAt: epochToIso(maxEpoch(dev)),
      },
    });
  }
  return { controllers, util };
}

/** Summed client series over WLAN instances, 30 minute buckets, last value carried forward per WLAN. */
function clientTrend(hours = 24, filter = {}) {
  const since = nowSec() - hours * 3600;
  const step = 1800;
  const where = ["metric = 'ess_clients'", 'sampled_at_epoch >= ?'];
  const args = [since];
  if (filter.sourceId) { where.push('source_id = ?'); args.push(filter.sourceId); }
  if (filter.deviceId) { where.push('lm_device_id = ?'); args.push(filter.deviceId); }
  let rows = [];
  try {
    rows = db.prepare(`SELECT source_id, lm_device_id, hds_id, instance_key, sampled_at_epoch e, value v FROM lm_ds_metrics_history WHERE ${where.join(' AND ')} ORDER BY sampled_at_epoch`).all(...args);
  } catch { return { total: [], bySeries: new Map() }; }
  const buckets = new Map();
  for (const r of rows) {
    const b = Math.floor(r.e / step) * step;
    if (!buckets.has(b)) buckets.set(b, new Map());
    buckets.get(b).set(`${r.source_id}:${r.lm_device_id}|${r.hds_id}|${r.instance_key}`, r.v);
  }
  const last = new Map();
  const total = [];
  const bySeries = new Map();
  for (const b of [...buckets.keys()].sort((a, c) => a - c)) {
    for (const [k, v] of buckets.get(b)) last.set(k, v);
    let sum = 0;
    for (const [k, v] of last) {
      sum += v;
      if (!bySeries.has(k)) bySeries.set(k, []);
      bySeries.get(k).push({ epoch: b, value: v });
    }
    total.push({ epoch: b, value: sum });
  }
  return { total, bySeries };
}

function histogram(values, edges = [0, 10, 20, 30, 40, 50, 60, 70, 80, 90]) {
  const out = edges.map((lo, i) => ({ bucket: `${lo}-${edges[i + 1] ?? 100}%`, count: 0 }));
  for (const v of values) {
    if (v == null) continue;
    let i = edges.length - 1;
    while (i > 0 && v < edges[i]) i -= 1;
    out[i].count += 1;
  }
  return out;
}

function ssidSummary(controllers) {
  const by = new Map();
  for (const c of controllers) {
    for (const s of c.ssids) {
      const k = s.ssid;
      const e = by.get(k) || { ssid: k, clients: 0, controllers: 0, enabledOn: 0, broadcast: null, hasClients: false };
      e.controllers += 1;
      if (s.enabled) e.enabledOn += 1;
      if (s.broadcast != null) e.broadcast = (e.broadcast || false) || s.broadcast;
      if (s.clients != null) { e.clients += s.clients; e.hasClients = true; }
      by.set(k, e);
    }
  }
  return [...by.values()].map(({ hasClients, ...e }) => ({ ...e, clients: hasClients ? e.clients : null })).sort((a, b) => (b.clients || 0) - (a.clients || 0));
}

const WLC_COLUMNS = ['deviceName', 'siteName', 'platform', 'model', 'version', 'hostStatus', 'haText', 'cpuPct', 'memPct', 'apsTotal', 'apsUp', 'apsDown',
  'apsDisabled', 'apAvailablePct', 'radiosTotal', 'radiosUp', 'radiosDown', 'hotRadios', 'avgChannelUtilPct', 'clients', 'clientsMax', 'clientUsagePct',
  'ssids', 'radiusServers', 'radiusUnresponsive', 'mobility', 'state', 'sampledAt'];
const AP_COLUMNS = ['ap', 'controller', 'siteName', 'status', 'operText', 'adminText', 'radiosUp', 'radiosTotal', 'clients', 'util24', 'util5',
  'maxChannelUtilPct', 'uplinkState', 'uplinkRxBps', 'uplinkTxBps', 'uplinkErrors', 'sampledAt'];
const RADIO_COLUMNS = ['radio', 'ap', 'band', 'slot', 'controller', 'siteName', 'state', 'channelUtilPct', 'rxUtilPct', 'txUtilPct', 'clients',
  'txPowerLevel', 'loadProfile', 'noiseProfile', 'interferenceProfile', 'coverageProfile'];

const wlListRules = [
  query('q').optional().isString().trim().isLength({ max: 200 }),
  query('siteKey').optional().matches(/^[a-z0-9-]{1,80}$/),
  query('sourceId').optional().isInt().toInt(),
];

router.get('/wireless/overview', wlListRules, validate, (req, res, next) => {
  try {
    const { controllers, util } = wirelessModel(req.query);
    const aps = controllers.flatMap((c) => c.aps);
    const radios = controllers.flatMap((c) => c.radios);
    const rows = controllers.map((c) => c.row);
    const managed = aps.filter((a) => a.status !== 'disabled');
    const byBand = BANDS.map((band) => {
      const rs = radios.filter((x) => x.band === band && x.counted);
      const up = rs.filter((x) => x.state === 'up' && x.channelUtilPct != null);
      return {
        band,
        radios: rs.length,
        up: rs.filter((x) => x.state === 'up').length,
        clients: anyVal(rs, (x) => x.clients) ? sumOf(rs, (x) => x.clients) : null,
        avgChannelUtilPct: up.length ? rnd1(sumOf(up, (x) => x.channelUtilPct) / up.length) : null,
        hot: rs.filter((x) => x.hot).length,
      };
    }).filter((b) => b.radios > 0);
    const bySite = new Map();
    for (const c of rows) {
      const k = c.siteName || c.siteKey || 'Unassigned';
      const e = bySite.get(k) || { site: k, controllers: 0, aps: 0, apsDown: 0, clients: 0 };
      e.controllers += 1; e.aps += c.apsTotal; e.apsDown += c.apsDown; e.clients += c.clients || 0;
      bySite.set(k, e);
    }
    const trend = clientTrend(24, { sourceId: req.query.sourceId });
    const bandsTotal = byBand.reduce((s, b) => s + (b.clients || 0), 0);
    res.json({
      totals: {
        controllers: rows.length,
        controllersDegraded: rows.filter((c) => c.state === 'critical' || c.state === 'warning').length,
        aps: managed.length,
        apsUp: managed.filter((a) => a.status === 'up' || a.status === 'downloading').length,
        apsDown: managed.filter((a) => ['down', 'silent', 'missing'].includes(a.status)).length,
        radios: radios.filter((x) => x.counted).length,
        radiosDown: radios.filter((x) => x.counted && x.state === 'down').length,
        hotRadios: radios.filter((x) => x.hot).length,
        clients: rows.some((c) => c.clients != null) ? sumOf(rows, (c) => c.clients) : null,
        ssids: ssidSummary(controllers).length,
        radiusUnresponsive: sumOf(rows, (c) => c.radiusUnresponsive),
      },
      controllers: rows,
      analytics: {
        byBand: byBand.map((b) => ({ ...b, clientSharePct: bandsTotal && b.clients != null ? rnd1((b.clients / bandsTotal) * 100) : null })),
        bySite: [...bySite.values()].sort((a, b) => b.clients - a.clients),
        bySsid: ssidSummary(controllers).slice(0, 12),
        busiestAps: [...aps].filter((a) => a.clients != null).sort((a, b) => b.clients - a.clients).slice(0, 10),
        hottestRadios: [...radios].filter((x) => x.channelUtilPct != null).sort((a, b) => b.channelUtilPct - a.channelUtilPct).slice(0, 10),
        downAps: aps.filter((a) => ['down', 'silent', 'missing'].includes(a.status)).slice(0, 50),
        channelUtilThresholdPct: util,
      },
      clientTrend: trend.total,
    });
  } catch (err) { next(err); }
});

router.get('/wireless/controllers.csv', wlListRules, validate, (req, res, next) => {
  try { sendCsv(res, 'wireless-controllers', wirelessModel(req.query).controllers.map((c) => c.row), WLC_COLUMNS); } catch (err) { next(err); }
});
router.get('/wireless/controllers', wlListRules, validate, (req, res, next) => {
  try { res.json(wirelessModel(req.query).controllers.map((c) => c.row)); } catch (err) { next(err); }
});

router.get('/wireless/controllers/:deviceId', deviceParams, validate, (req, res, next) => {
  try {
    const r = roleDevice(WLC_WHERE, req.params.deviceId, req.query.sourceId);
    if (!r) return notFound(res, 'Wireless controller');
    const c = wirelessModel({ sourceId: r.source_id }).controllers.find((x) => x.r.lm_device_id === r.lm_device_id);
    if (!c) return notFound(res, 'Wireless controller');
    const L = lmIssues();
    const dev = c.dev;
    const val = (k) => L.devVal(dev, k);
    const byBand = BANDS.map((band) => {
      const rs = c.radios.filter((x) => x.band === band && x.counted);
      const up = rs.filter((x) => x.state === 'up' && x.channelUtilPct != null);
      return { band, radios: rs.length, up: rs.filter((x) => x.state === 'up').length, down: rs.filter((x) => x.state === 'down').length,
        clients: anyVal(rs, (x) => x.clients) ? sumOf(rs, (x) => x.clients) : null, avgChannelUtilPct: up.length ? rnd1(sumOf(up, (x) => x.channelUtilPct) / up.length) : null, hot: rs.filter((x) => x.hot).length };
    }).filter((b) => b.radios > 0);
    const acct = L.devInstances(dev, 'acct_status').map((i) => ({
      server: i.name, enabled: Math.round(i.m.acct_status.value) === 1,
      requests: i.m.acct_requests ? i.m.acct_requests.value : null, responses: i.m.acct_responses ? i.m.acct_responses.value : null, timeouts: i.m.acct_timeouts ? i.m.acct_timeouts.value : null,
    }));
    const cpuSeries = deviceSeries(dev, 'cpu_pct', 24);
    const trend = clientTrend(24, { sourceId: r.source_id, deviceId: r.lm_device_id });
    res.json({
      device: deviceOut(r, lookups()),
      summary: c.row,
      bands: byBand,
      aps: c.aps,
      ssids: c.ssids.sort((a, b) => (b.clients || 0) - (a.clients || 0)),
      radius: { auth: c.radius, accounting: acct },
      connections: {
        clients: val('wlc_clients'), clientsMax: val('wlc_clients_max'), clientUsagePct: rnd1(val('wlc_client_usage_pct')),
        apsJoined: val('wlc_aps_joined'), apAssocFailedPerSec: val('wlc_ap_assoc_failed'), abnormalOfflineRate: val('wlc_abnormal_offline'),
      },
      mobility: {
        status: c.row.mobility, handoffsPerSec: val('mob_handoffs'), requestsPerSec: val('mob_handoff_requests'),
        errorsPerSec: val('mob_handoff_errors'), deniedPerSec: val('mob_handoff_denied'), droppedPerSec: val('mob_handoff_dropped'),
      },
      dhcp: {
        proxy: val('dhcp_proxy') == null ? null : Math.round(val('dhcp_proxy')) === 1, discoverPerSec: val('dhcp_discover'), offerPerSec: val('dhcp_offer'),
        ackPerSec: val('dhcp_ack'), nakPerSec: val('dhcp_nak'), txFailuresPerSec: val('dhcp_tx_failures'),
      },
      cpuHistory: cpuSeries,
      clientHistory: trend.total,
      issues: c.issues,
    });
  } catch (err) { next(err); }
});

router.get('/wireless/aps.csv', wlListRules, validate, (req, res, next) => {
  try { sendCsv(res, 'wireless-aps', wirelessModel(req.query).controllers.flatMap((c) => c.aps), AP_COLUMNS); } catch (err) { next(err); }
});
router.get('/wireless/aps', wlListRules, validate, (req, res, next) => {
  try { res.json(wirelessModel(req.query).controllers.flatMap((c) => c.aps)); } catch (err) { next(err); }
});

router.get('/wireless/ap', [
  query('controllerId').isInt().toInt(),
  query('sourceId').optional().isInt().toInt(),
  query('ap').isString().isLength({ min: 1, max: 200 }),
], validate, (req, res, next) => {
  try {
    const r = roleDevice(WLC_WHERE, req.query.controllerId, req.query.sourceId);
    if (!r) return notFound(res, 'Wireless controller');
    const c = wirelessModel({ sourceId: r.source_id }).controllers.find((x) => x.r.lm_device_id === r.lm_device_id);
    const ap = c && c.aps.find((a) => a.apKey === req.query.ap);
    if (!ap) return notFound(res, 'Access point');
    const ports = apPortsOf(c.dev).get(ap.apKey) || [];
    const radios = c.radios.filter((x) => x.ap === ap.apKey).sort((a, b) => (a.slot ?? 99) - (b.slot ?? 99));
    const pre = `${c.row.deviceName} ${ap.apKey}`;
    const issues = c.issues.filter((i) => { const t = String(i.target || ''); return t === pre || t.startsWith(`${pre}:`) || t.startsWith(`${pre} - `); });
    res.json({ ap, radios, ports, issues });
  } catch (err) { next(err); }
});

router.get('/wireless/rf.csv', wlListRules, validate, (req, res, next) => {
  try { sendCsv(res, 'wireless-radios', wirelessModel(req.query).controllers.flatMap((c) => c.radios), RADIO_COLUMNS); } catch (err) { next(err); }
});
router.get('/wireless/rf', wlListRules, validate, (req, res, next) => {
  try {
    const { controllers, util } = wirelessModel(req.query);
    const radios = controllers.flatMap((c) => c.radios);
    const bands = BANDS.map((band) => {
      const inBand = radios.filter((x) => x.band === band);
      const rs = inBand.filter((x) => x.counted);
      const up = rs.filter((x) => x.state === 'up');
      const profiles = Object.fromEntries(Object.keys(PROFILE_KEYS).map((p) => [p, rs.filter((x) => x[`${p}Profile`] === 'fail').length]));
      const power = new Map();
      for (const x of up) if (x.txPowerLevel != null) power.set(x.txPowerLevel, (power.get(x.txPowerLevel) || 0) + 1);
      return {
        band,
        radios: rs.length,
        up: up.length,
        down: rs.filter((x) => x.state === 'down').length,
        disabled: inBand.filter((x) => x.state === 'disabled').length,
        clients: anyVal(rs, (x) => x.clients) ? sumOf(rs, (x) => x.clients) : null,
        avgChannelUtilPct: up.length && anyVal(up, (x) => x.channelUtilPct) ? rnd1(sumOf(up, (x) => x.channelUtilPct) / up.filter((x) => x.channelUtilPct != null).length) : null,
        avgRxUtilPct: up.length && anyVal(up, (x) => x.rxUtilPct) ? rnd1(sumOf(up, (x) => x.rxUtilPct) / up.filter((x) => x.rxUtilPct != null).length) : null,
        avgTxUtilPct: up.length && anyVal(up, (x) => x.txUtilPct) ? rnd1(sumOf(up, (x) => x.txUtilPct) / up.filter((x) => x.txUtilPct != null).length) : null,
        hot: rs.filter((x) => x.hot).length,
        utilHistogram: histogram(up.map((x) => x.channelUtilPct)),
        txPower: [...power.entries()].sort((a, b) => a[0] - b[0]).map(([level, count]) => ({ level, count })),
        profileFailures: profiles,
      };
    }).filter((b) => b.radios > 0);
    res.json({ thresholdPct: util, bands, radios });
  } catch (err) { next(err); }
});

router.get('/wireless/ssids', wlListRules, validate, (req, res, next) => {
  try {
    const { controllers } = wirelessModel(req.query);
    const rows = controllers.flatMap((c) => c.ssids);
    const summary = ssidSummary(controllers);
    const trend = clientTrend(24, { sourceId: req.query.sourceId });
    // Per-SSID trend: WLAN series are keyed by device, hds and instance key; map them to SSID names.
    const nameOf = new Map(rows.map((s) => [`${s.sourceId}:${s.controllerId}|${s.hdsId}|${s.wlan}`, s.ssid]));
    const bySsid = new Map();
    for (const [k, pts] of trend.bySeries) {
      const name = nameOf.get(k);
      if (!name) continue;
      const cur = bySsid.get(name) || new Map();
      for (const p of pts) cur.set(p.epoch, (cur.get(p.epoch) || 0) + p.value);
      bySsid.set(name, cur);
    }
    const top = summary.slice(0, 6).map((s) => s.ssid);
    res.json({
      summary,
      rows: rows.map(({ hdsId, ...s }) => s),
      trend: {
        total: trend.total,
        bySsid: top.filter((n) => bySsid.has(n)).map((n) => ({ ssid: n, points: [...bySsid.get(n).entries()].sort((a, b) => a[0] - b[0]).map(([epoch, value]) => ({ epoch, value })) })),
      },
    });
  } catch (err) { next(err); }
});

// ---- Raw DataSource store (round 11, WP-R) ----------------------------------------
// Sections are the first path segment (devices, datasources); nothing extra.

const lmRaw = () => require('../services/logicmonitorRaw');
const rawCatalog = () => ({ catalogFor: (n) => catalogEntry(n) });

router.get('/devices/:deviceId/datasources', deviceParams, validate, (req, res, next) => {
  try {
    const r = findDevice(req.params.deviceId, req.query.sourceId);
    if (!r) return notFound(res, 'Device');
    res.json(lmRaw().deviceDatasources(db, rawCatalog(), r.source_id, r.lm_device_id));
  } catch (err) { next(err); }
});

router.get('/devices/:deviceId/datasources/:hdsId/values', [
  ...deviceParams,
  param('hdsId').isInt().toInt(),
  query('q').optional().isString().trim().isLength({ max: 200 }),
  query('page').optional().isInt({ min: 1, max: 100000 }).toInt(),
  limitValidator,
], validate, (req, res, next) => {
  try {
    const r = findDevice(req.params.deviceId, req.query.sourceId);
    if (!r) return notFound(res, 'Device');
    const limit = req.query.limit === 'all' ? 500 : (Number(req.query.limit) || 25);
    res.json(lmRaw().dsValues(db, rawCatalog(), r.source_id, r.lm_device_id, req.params.hdsId, { q: req.query.q || '', page: req.query.page || 1, limit }));
  } catch (err) { next(err); }
});

const DS_COLUMNS = ['name', 'displayName', 'family', 'devices', 'instances', 'datapoints', 'picks', 'coveragePct', 'polledDevices', 'rawLastAt'];
router.get('/datasources.csv', (req, res, next) => {
  try { sendCsv(res, 'datasources', lmRaw().estateDatasources(db, rawCatalog()), DS_COLUMNS); } catch (err) { next(err); }
});
router.get('/datasources', (req, res, next) => {
  try { res.json(lmRaw().estateDatasources(db, rawCatalog())); } catch (err) { next(err); }
});
router.get('/datasources/:name/datapoints', [param('name').isString().isLength({ min: 1, max: 200 })], validate, (req, res, next) => {
  try { res.json(lmRaw().datapointsFor(db, req.params.name)); } catch (err) { next(err); }
});

// ---- Applications and appliances (round 11, WP-X) ---------------------------------
// Sections are the first path segment (applications). Every DataSource, datapoint and
// state enum behind these rows is UNVERIFIED (blind catalog block 'apps').

const lmApps = () => require('../services/logicmonitorApps');
const APP_WHERE = `EXISTS (SELECT 1 FROM lm_ds_metrics m WHERE m.source_id = d.source_id AND m.lm_device_id = d.lm_device_id AND m.family = 'apps')`;

const appListRules = [
  ...dsListRules,
  query('kind').optional().isIn(['sql', 'splunk', 'hyperv', 'xen', 'ironport', 'emc']),
];

function appRow(r, lk, dev, issues) {
  const A = lmApps();
  const sum = dev ? A.summarize(dev) : { kinds: [], instances: 0, metrics: {}, downCount: 0 };
  const name = r.display_name || r.name;
  const devIssues = issuesOnDevice(issues, name).filter((i) => /^app-/.test(String(i.type)));
  return {
    ...devBase(r, lk),
    kinds: sum.kinds,
    kindLabels: sum.kinds.map((k) => A.KIND_BY_ID.get(k).label),
    instances: sum.instances,
    downCount: sum.downCount,
    metrics: sum.metrics,
    headline: A.headline(sum),
    openIssues: devIssues.length,
    state: stateFromIssues(devIssues, sum.instances > 0),
    sampledAt: dev ? epochToIso(maxEpoch(dev)) : null,
  };
}

const APP_COLUMNS = ['deviceName', 'siteName', 'vendor', 'model', 'kindLabels', 'instances', 'downCount', 'headline', 'openIssues', 'state', 'sampledAt'];

function applicationRows(q) {
  const lk = lookups();
  const devs = roleDevices(APP_WHERE, q);
  const index = lmIssues().loadDsIndex(db, { families: ['apps'] });
  const issues = safeIssues();
  let rows = devs.map((r) => appRow(r, lk, index.get(`${r.source_id}:${r.lm_device_id}`), issues));
  if (q.kind) rows = rows.filter((r) => r.kinds.includes(q.kind));
  if (q.state) rows = rows.filter((r) => r.state === q.state);
  return rows;
}

// Literal .csv path before /applications/:deviceId.
router.get('/applications.csv', appListRules, validate, (req, res, next) => {
  try {
    sendCsv(res, 'applications', applicationRows(req.query).map((r) => ({ ...r, kindLabels: r.kindLabels.join('; ') })), APP_COLUMNS);
  } catch (err) { next(err); }
});
router.get('/applications', appListRules, validate, (req, res, next) => {
  try { res.json(applicationRows(req.query)); } catch (err) { next(err); }
});

router.get('/applications/:deviceId', deviceParams, validate, (req, res, next) => {
  try {
    const r = roleDevice(APP_WHERE, req.params.deviceId, req.query.sourceId);
    if (!r) return notFound(res, 'Application');
    const L = lmIssues();
    const lk = lookups();
    const idx = L.loadDsIndex(db, { sourceId: r.source_id, deviceId: r.lm_device_id, families: ['apps'] });
    const dev = idx.get(`${r.source_id}:${r.lm_device_id}`) || { instances: new Map(), sourceId: r.source_id, deviceId: r.lm_device_id, name: r.display_name || r.name };
    const issues = safeIssues();
    const summary = appRow(r, lk, dev, issues);
    const CAP = 500;
    const dsMap = new Map();
    for (const inst of dev.instances.values()) {
      const dk = `${inst.hds}|${inst.ds}`;
      if (!dsMap.has(dk)) {
        const e = catalogEntry(inst.ds);
        dsMap.set(dk, { name: inst.ds, label: (e && e.label) || inst.ds, hdsId: inst.hds, instanceCount: 0, truncated: false, instances: [] });
      }
      const ds = dsMap.get(dk);
      ds.instanceCount += 1;
      if (ds.instances.length >= CAP) { ds.truncated = true; continue; }
      const metrics = {};
      for (const [mk, m] of Object.entries(inst.m)) {
        const meta = metricMeta(inst.ds, mk);
        metrics[mk] = { value: m.value, unit: meta.unit, kind: meta.kind, label: meta.label, datapoint: m.datapoint, epoch: m.epoch };
      }
      ds.instances.push({ key: inst.key, name: inst.name, metrics });
    }
    const datasources = [...dsMap.values()].sort((a, b) => a.label.localeCompare(b.label)).map((ds) => ({
      ...ds, instances: ds.instances.sort((a, b) => String(a.name).localeCompare(String(b.name))),
    }));
    const history = {};
    for (const mk of ['sql_connections', 'sql_batch_rate', 'splunk_license_used_pct', 'emc_cap_used_pct', 'hv_cpu_pct', 'esa_queue']) {
      const pts = deviceSeries(dev, mk, 24);
      if (pts.length) history[mk] = pts;
    }
    res.json({
      device: deviceOut(r, lk),
      summary,
      datasources,
      history,
      issues: issuesOnDevice(issues, r.display_name || r.name).filter((i) => /^app-/.test(String(i.type))),
    });
  } catch (err) { next(err); }
});

// ---- Voice, Zscaler and ISE (round 11, lm11-sections) ---------------------------------
// Sections are the first path segment (voice, zscaler, ise). Datapoint names and state enums
// behind these rows are UNVERIFIED; raw values travel next to every derived flag.

const lmAppliances = () => require('../services/logicmonitorAppliances');
const dsLike = (...prefixes) => prefixes.map((p) => `x.datasource_name LIKE '${p.replace(/_/g, '\\_')}%' ESCAPE '\\'`).join(' OR ');
const hasDs = (cond) => `EXISTS (SELECT 1 FROM lm_device_datasources x WHERE x.source_id = d.source_id AND x.lm_device_id = d.lm_device_id AND (${cond}))`;
const hasFamily = (fam) => `EXISTS (SELECT 1 FROM lm_ds_metrics m WHERE m.source_id = d.source_id AND m.lm_device_id = d.lm_device_id AND m.family = '${fam}')`;
const VOICE_WHERE = `(${hasDs(`${dsLike('ntm_sbc_', 'Cisco_SIP_', 'ntm_ganc_')} OR x.datasource_name = 'ISDN_Channels'`)} OR ${hasFamily('voice')})`;
const ISE_WHERE = `(${hasDs(`${dsLike('Cisco_ISE_', 'ntm_ise_', 'ntm_cisco_ise_')} OR x.datasource_name = 'ntm_deployment_nodes_status'`)})`;
const ZPA_WHERE = `(${hasDs(`${dsLike('ntm_zpa_')} OR x.datasource_name = 'Zscaler ZPA Port Exhaustion'`)} OR lower(d.name) LIKE '%zpa%')`;
const NSS_WHERE = `((d.vendor = 'Zscaler' OR lower(d.name) LIKE '%zsclr%' OR lower(d.name) LIKE '%pxy-log%' OR lower(COALESCE(d.sysinfo, '')) LIKE '%zscaler%') AND NOT ${ZPA_WHERE})`;

const emptyDv = (r) => ({ instances: new Map(), sourceId: r.source_id, deviceId: r.lm_device_id, name: r.display_name || r.name });
const FAMS_VOICE = ['voice', 'wireless'];
const FAMS_SEC = ['security', 'health', 'os'];

const voiceListRules = [...dsListRules, query('kind').optional().isIn(['sbc', 'cube', 'ganc'])];

const VOICE_BLANK = {
  healthRaw: null, healthBad: null, cpuPct: null, memPct: null, fans: null, fansBad: null, psus: null, psusBad: null, tempMaxC: null,
  pools: null, poolUtilMaxPct: null, poolSessions: null, poolFailures: null, retransmissions: null, localConnectionRaw: null,
  sipConnections: null, sipServerErrPerSec: null, sipClientErrPerSec: null, sipErrPerSec: null, sipRetries: null, isdnBusy: null,
  mobilityRaw: null, radiusCheckRaw: null, ssids: null, clients: null, radiusServers: null, radiusServersDown: null,
};

function voiceKindOf(r, dv) {
  const k = lmAppliances().voiceKind(dv);
  if (k) return k;
  const n = String(r.display_name || r.name || '');
  return /sbc/i.test(n) ? 'sbc' : /ganc/i.test(n) ? 'ganc' : 'cube';
}

function voiceRow(r, lk, dev, issues) {
  const A = lmAppliances();
  const dv = dev || emptyDv(r);
  const name = r.display_name || r.name;
  const kind = voiceKindOf(r, dv);
  const facts = kind === 'sbc' ? A.sbcFacts(dv) : kind === 'ganc' ? A.gancFacts(dv) : A.cubeFacts(db, dv);
  const devIssues = issuesOnDevice(issues, name);
  return {
    ...devBase(r, lk),
    kind,
    ...VOICE_BLANK,
    ...facts,
    openIssues: devIssues.length,
    state: stateFromIssues(devIssues, dv.instances.size > 0),
    sampledAt: epochToIso(maxEpoch(dv)),
  };
}

const VOICE_COLUMNS = ['deviceName', 'kind', 'siteName', 'vendor', 'model', 'version', 'hostStatus', 'healthRaw', 'cpuPct', 'memPct', 'fans', 'fansBad', 'psus', 'psusBad',
  'tempMaxC', 'pools', 'poolUtilMaxPct', 'poolSessions', 'poolFailures', 'retransmissions', 'sipConnections', 'sipServerErrPerSec', 'sipClientErrPerSec', 'ssids', 'clients',
  'mobilityRaw', 'radiusCheckRaw', 'radiusServers', 'radiusServersDown', 'openIssues', 'state', 'sampledAt'];

function voiceRows(q) {
  const lk = lookups();
  const devs = roleDevices(VOICE_WHERE, q);
  const index = lmIssues().loadDsIndex(db, { families: FAMS_VOICE });
  const issues = safeIssues();
  let rows = devs.map((r) => voiceRow(r, lk, index.get(`${r.source_id}:${r.lm_device_id}`), issues));
  if (q.state) rows = rows.filter((r) => r.state === q.state);
  if (q.kind) rows = rows.filter((r) => r.kind === q.kind);
  return rows;
}

// Literal .csv path before /voice/:deviceId.
router.get('/voice.csv', voiceListRules, validate, (req, res, next) => {
  try { sendCsv(res, 'voice', voiceRows(req.query), VOICE_COLUMNS); } catch (err) { next(err); }
});
router.get('/voice', voiceListRules, validate, (req, res, next) => {
  try { res.json(voiceRows(req.query)); } catch (err) { next(err); }
});

/** Every metric of the device's instances that pass `pick`, as flat rows with the catalog label and unit. */
function metricRowsOf(dev, pick, cap = 400) {
  const out = [];
  for (const i of dev.instances.values()) {
    if (!pick(i)) continue;
    for (const [mk, m] of Object.entries(i.m)) {
      const meta = metricMeta(i.ds, mk);
      out.push({ datasource: i.ds, instance: i.name, metric: mk, label: meta.label, unit: meta.unit, value: m.value, datapoint: m.datapoint });
      if (out.length >= cap) return out;
    }
  }
  return out;
}

router.get('/voice/:deviceId', deviceParams, validate, (req, res, next) => {
  try {
    const r = roleDevice(VOICE_WHERE, req.params.deviceId, req.query.sourceId);
    if (!r) return notFound(res, 'Voice device');
    const A = lmAppliances();
    const lk = lookups();
    const idx = lmIssues().loadDsIndex(db, { sourceId: r.source_id, deviceId: r.lm_device_id });
    const dev = idx.get(`${r.source_id}:${r.lm_device_id}`) || emptyDv(r);
    const issues = safeIssues();
    const summary = voiceRow(r, lk, dev, issues);
    const byKey = (a, b) => String(a.name).localeCompare(String(b.name));
    const stateOf = (i, metric) => ({ name: i.name, raw: num(i, metric), bad: A.stateBad(num(i, metric), i.m[metric].datapoint) });
    const fans = rowsOf(dev, 'sbc_fan_state').map((i) => stateOf(i, 'sbc_fan_state')).sort(byKey);
    const psus = rowsOf(dev, 'sbc_psu_state').map((i) => stateOf(i, 'sbc_psu_state')).sort(byKey);
    const temps = rowsOf(dev, 'sbc_temp_c').map((i) => ({ name: i.name, tempC: rnd1(num(i, 'sbc_temp_c')) })).sort(byKey);
    const pools = [...dev.instances.values()].filter((i) => i.m.sbc_pool_util_pct || i.m.sbc_pool_sessions || i.m.sbc_pool_failures)
      .map((i) => ({ name: i.name, utilPct: rnd1(num(i, 'sbc_pool_util_pct')), sessions: num(i, 'sbc_pool_sessions'), failures: num(i, 'sbc_pool_failures') })).sort(byKey);
    const ssids = [...dev.instances.values()].filter((i) => i.m.ess_clients || i.m.ess_admin)
      .map((i) => ({ name: i.name, clients: num(i, 'ess_clients'), adminRaw: num(i, 'ess_admin') })).sort(byKey);
    const radius = rowsOf(dev, 'radius_status').map((i) => ({
      name: i.name, enabled: Math.round(num(i, 'radius_status')) === 1, requests: num(i, 'radius_requests'), rejects: num(i, 'radius_rejects'), timeouts: num(i, 'radius_timeouts'),
    })).sort(byKey);
    const sip = metricRowsOf(dev, (i) => /^Cisco_SIP_/i.test(i.ds) || /^ISDN_Channels$/i.test(i.ds));
    res.json({
      device: deviceOut(r, lk),
      summary,
      fans,
      psus,
      temps,
      pools,
      ssids,
      radius,
      sip,
      history: { cpuPct: deviceSeries(dev, 'sbc_cpu_pct', 24), memPct: deviceSeries(dev, 'sbc_mem_pct', 24) },
      issues: issuesOnDevice(issues, r.display_name || r.name),
    });
  } catch (err) { next(err); }
});

// ---- Zscaler -----------------------------------------------------------------------------

/** Latest latency episode per check (7 day window), keyed "sourceId|checkId". */
function latestCheckEpisodes() {
  const out = new Map();
  try {
    const cutoff = new Date(Date.now() - 7 * 86400000).toISOString();
    for (const e of db.prepare(`
      SELECT source_id, check_id, state, kind, outcome, opened_at, peak_ms, loss_max_pct FROM lm_latency_episodes
      WHERE subject_kind = 'check' AND (opened_at >= ? OR state != 'closed') ORDER BY opened_at DESC
    `).all(cutoff)) {
      const k = `${e.source_id}|${e.check_id}`;
      if (!out.has(k)) out.set(k, e);
    }
  } catch { /* episodes table not migrated */ }
  return out;
}

const WORST = { down: 3, degraded: 2, ok: 1 };

/** ZSDC_ uptime checks grouped by city. */
function zscalerDataCenters(q = {}) {
  const A = lmAppliances();
  let checks = [];
  try { checks = buildChecks(q.sourceId).filter((c) => A.isZsdc(c.name)); } catch { checks = []; }
  const eps = latestCheckEpisodes();
  const groups = new Map();
  for (const c of checks) {
    const { code, city } = A.zsdcCity(c.name);
    const locs = (c.locations || []).filter((l) => !l.isOverall);
    const overall = (c.locations || []).find((l) => l.isOverall);
    const rtts = (locs.length ? locs : (c.locations || [])).map((l) => (c.kind === 'web' ? (l.responseMs ?? l.rttAvgMs) : l.rttAvgMs)).filter((v) => v != null);
    const loss = (c.locations || []).map((l) => l.lossPct).filter((v) => v != null);
    const rtt = overall && (c.kind === 'web' ? (overall.responseMs ?? overall.rttAvgMs) : overall.rttAvgMs) != null
      ? (c.kind === 'web' ? (overall.responseMs ?? overall.rttAvgMs) : overall.rttAvgMs)
      : (rtts.length ? rtts.reduce((a, b) => a + b, 0) / rtts.length : null);
    const ep = eps.get(`${c.sourceId}|${c.checkId}`);
    const item = {
      checkId: c.checkId, sourceId: c.sourceId, name: c.name, target: c.target, kind: c.kind, code, state: c.state,
      rttAvgMs: rnd1(rtt), baselineRttMs: rnd1((locs.find((l) => l.baselineRttMs != null) || {}).baselineRttMs),
      lossMaxPct: loss.length ? rnd1(Math.max(...loss)) : null,
      anomaly: (locs.find((l) => l.anomaly) || {}).anomaly || null,
      episodeState: ep ? ep.state : null, episodeOutcome: ep ? ep.outcome : null, episodeOpenedAt: ep ? ep.opened_at : null,
    };
    const key = city.toLowerCase();
    if (!groups.has(key)) groups.set(key, { city, codes: new Set(), items: [] });
    const g = groups.get(key);
    g.codes.add(code);
    g.items.push(item);
  }
  const rows = [...groups.values()].map((g) => {
    const rtts = g.items.map((i) => i.rttAvgMs).filter((v) => v != null);
    const worst = g.items.reduce((w, i) => (WORST[i.state] > WORST[w] ? i.state : w), 'ok');
    const epPick = g.items.filter((i) => i.episodeState).sort((a, b) => String(b.episodeOpenedAt).localeCompare(String(a.episodeOpenedAt)))[0];
    return {
      city: g.city,
      codes: [...g.codes].sort().join(', '),
      checks: g.items.length,
      state: worst === 'down' ? 'critical' : worst === 'degraded' ? 'warning' : 'ok',
      checkState: worst,
      rttAvgMs: rtts.length ? rnd1(rtts.reduce((a, b) => a + b, 0) / rtts.length) : null,
      rttMaxMs: rtts.length ? rnd1(Math.max(...rtts)) : null,
      lossMaxPct: g.items.map((i) => i.lossMaxPct).filter((v) => v != null).reduce((m, v) => Math.max(m, v), 0) || 0,
      episodeState: epPick ? epPick.episodeState : null,
      items: g.items.sort((a, b) => String(a.name).localeCompare(String(b.name))),
    };
  });
  rows.sort((a, b) => (WORST[b.checkState] - WORST[a.checkState]) || a.city.localeCompare(b.city));
  return rows;
}

function zscalerData(q) {
  const A = lmAppliances();
  const lk = lookups();
  const index = lmIssues().loadDsIndex(db, { families: FAMS_SEC });
  const issues = safeIssues();
  const modes = A.modeMap(index, ['connector_state', 'node_state', 'app_state']);
  let fsWarn = 85; // lm_fs_warn_pct arrives with the servers work package
  try { fsWarn = Number(thr('lm_fs_warn_pct')) || 85; } catch { fsWarn = 85; }
  const build = (r, facts) => {
    const dv = index.get(`${r.source_id}:${r.lm_device_id}`) || emptyDv(r);
    const devIssues = issuesOnDevice(issues, r.display_name || r.name);
    return {
      ...devBase(r, lk), ...facts(dv), openIssues: devIssues.length,
      state: stateFromIssues(devIssues, dv.instances.size > 0), sampledAt: epochToIso(maxEpoch(dv)),
    };
  };
  let connectors = roleDevices(ZPA_WHERE, q).map((r) => build(r, (dv) => A.zpaFacts(dv, modes)));
  let nss = roleDevices(NSS_WHERE, q).map((r) => build(r, (dv) => A.nssFacts(dv, fsWarn)));
  if (q.state) { connectors = connectors.filter((x) => x.state === q.state); nss = nss.filter((x) => x.state === q.state); }
  const dataCenters = zscalerDataCenters(q);
  return { connectors, nss, dataCenters };
}

const ZSCALER_COLUMNS = ['type', 'name', 'site', 'state', 'connectorState', 'portUsedPct', 'ntpOffset', 'cpuPct', 'memPct', 'fsUsedMaxPct', 'checks', 'rttAvgMs', 'rttMaxMs', 'lossMaxPct', 'episodeState'];
function zscalerCsvRows(data) {
  return [
    ...data.connectors.map((c) => ({
      type: 'connector', name: c.deviceName, site: c.siteName, state: c.state, connectorState: c.connectorDown ? 'down' : (c.connectorRaw == null ? '' : `raw ${c.connectorRaw}`),
      portUsedPct: c.portUsedPct, ntpOffset: c.ntpOffset,
    })),
    ...data.nss.map((n) => ({ type: 'nss', name: n.deviceName, site: n.siteName, state: n.state, cpuPct: n.cpuPct, memPct: n.memPct, fsUsedMaxPct: n.fsUsedMaxPct })),
    ...data.dataCenters.map((d) => ({
      type: 'datacenter', name: d.city, site: d.codes, state: d.state, checks: d.checks, rttAvgMs: d.rttAvgMs, rttMaxMs: d.rttMaxMs, lossMaxPct: d.lossMaxPct, episodeState: d.episodeState,
    })),
  ];
}

router.get('/zscaler.csv', dsListRules, validate, (req, res, next) => {
  try { sendCsv(res, 'zscaler', zscalerCsvRows(zscalerData(req.query)), ZSCALER_COLUMNS); } catch (err) { next(err); }
});
router.get('/zscaler', dsListRules, validate, (req, res, next) => {
  try { res.json(zscalerData(req.query)); } catch (err) { next(err); }
});

// ---- Cisco ISE ---------------------------------------------------------------------------

function iseRow(r, lk, dev, issues, modes) {
  const dv = dev || emptyDv(r);
  const name = r.display_name || r.name;
  const devIssues = issuesOnDevice(issues, name);
  return {
    ...devBase(r, lk),
    ...lmAppliances().iseFacts(dv, modes),
    openIssues: devIssues.length,
    state: stateFromIssues(devIssues, dv.instances.size > 0),
    sampledAt: epochToIso(maxEpoch(dv)),
  };
}

const ISE_COLUMNS = ['deviceName', 'siteName', 'vendor', 'model', 'version', 'hostStatus', 'sessions', 'diskUsedMaxPct', 'cpuPct', 'memPct', 'appStateRaw', 'certDaysMin',
  'nodeStateRaw', 'nodes', 'nodesDown', 'openIssues', 'state', 'sampledAt'];

function iseRows(q) {
  const lk = lookups();
  const devs = roleDevices(ISE_WHERE, q);
  const index = lmIssues().loadDsIndex(db, { families: FAMS_SEC });
  const issues = safeIssues();
  const modes = lmAppliances().modeMap(index, ['connector_state', 'node_state', 'app_state']);
  let rows = devs.map((r) => iseRow(r, lk, index.get(`${r.source_id}:${r.lm_device_id}`), issues, modes));
  if (q.state) rows = rows.filter((r) => r.state === q.state);
  return rows;
}

router.get('/ise.csv', dsListRules, validate, (req, res, next) => {
  try { sendCsv(res, 'ise', iseRows(req.query), ISE_COLUMNS); } catch (err) { next(err); }
});
router.get('/ise', dsListRules, validate, (req, res, next) => {
  try { res.json(iseRows(req.query)); } catch (err) { next(err); }
});

router.get('/ise/:deviceId', deviceParams, validate, (req, res, next) => {
  try {
    const r = roleDevice(ISE_WHERE, req.params.deviceId, req.query.sourceId);
    if (!r) return notFound(res, 'ISE node');
    const A = lmAppliances();
    const lk = lookups();
    const idxAll = lmIssues().loadDsIndex(db, { families: FAMS_SEC });
    const dev = idxAll.get(`${r.source_id}:${r.lm_device_id}`) || emptyDv(r);
    const modes = A.modeMap(idxAll, ['connector_state', 'node_state', 'app_state']);
    const issues = safeIssues();
    const summary = iseRow(r, lk, dev, issues, modes);
    const byKey = (a, b) => String(a.name).localeCompare(String(b.name));
    const certs = [
      ...rowsOf(dev, 'cert_days').map((i) => ({ name: i.name, kind: 'Certificate', daysLeft: num(i, 'cert_days') })),
      ...rowsOf(dev, 'eap_cert_days').map((i) => ({ name: i.name, kind: 'EAP certificate', daysLeft: num(i, 'eap_cert_days') })),
    ].sort((a, b) => (a.daysLeft - b.daysLeft) || byKey(a, b));
    const disks = rowsOf(dev, 'disk_used_pct').map((i) => ({ name: i.name, usedPct: rnd1(num(i, 'disk_used_pct')) })).sort((a, b) => (b.usedPct - a.usedPct) || byKey(a, b));
    const nodes = [
      ...rowsOf(dev, 'node_state').map((i) => ({ name: i.name, kind: 'Deployment node', raw: num(i, 'node_state'), down: A.readsDown(num(i, 'node_state'), modes.get('node_state')) })),
      ...rowsOf(dev, 'app_state').map((i) => ({ name: i.name, kind: 'Application', raw: num(i, 'app_state'), down: A.readsDown(num(i, 'app_state'), modes.get('app_state')) })),
    ].sort(byKey);
    res.json({
      device: deviceOut(r, lk),
      summary,
      certificates: certs,
      disks,
      nodes,
      history: { sessions: deviceSeries(dev, 'sessions', 24), cpuPct: deviceSeries(dev, 'cpu_pct', 24), memPct: deviceSeries(dev, 'mem_pct', 24) },
      issues: issuesOnDevice(issues, r.display_name || r.name),
    });
  } catch (err) { next(err); }
});

// ---- Device 360 Metrics tab -----------------------------------------------------

router.get('/devices/:deviceId/metrics', deviceParams, validate, (req, res, next) => {
  try {
    const r = findDevice(req.params.deviceId, req.query.sourceId);
    if (!r) return notFound(res, 'Device');
    const idx = lmIssues().loadDsIndex(db, { sourceId: r.source_id, deviceId: r.lm_device_id });
    const dev = idx.get(`${r.source_id}:${r.lm_device_id}`);
    const dds = new Map();
    try {
      for (const x of db.prepare('SELECT hds_id, datasource_display_name, metrics_last_at, metrics_last_error FROM lm_device_datasources WHERE source_id = ? AND lm_device_id = ?').all(r.source_id, r.lm_device_id)) dds.set(x.hds_id, x);
    } catch { /* columns not migrated */ }
    const CAP = 500;
    const famMap = new Map();
    if (dev) {
      for (const inst of dev.instances.values()) {
        if (!famMap.has(inst.family)) famMap.set(inst.family, new Map());
        const dsMap = famMap.get(inst.family);
        const dk = `${inst.hds}|${inst.ds}`;
        if (!dsMap.has(dk)) {
          const e = catalogEntry(inst.ds);
          const x = dds.get(inst.hds);
          dsMap.set(dk, {
            name: inst.ds, label: (e && e.label) || (x && x.datasource_display_name) || inst.ds, hdsId: inst.hds,
            lastAt: sqlIso(x && x.metrics_last_at), lastError: (x && x.metrics_last_error) || null, instanceCount: 0, truncated: false, instances: [], lastEpoch: null,
          });
        }
        const ds = dsMap.get(dk);
        ds.instanceCount += 1;
        const metrics = {};
        for (const [mk, m] of Object.entries(inst.m)) {
          const meta = metricMeta(inst.ds, mk);
          metrics[mk] = { value: m.value, unit: meta.unit, kind: meta.kind, label: meta.label, datapoint: m.datapoint, epoch: m.epoch };
          if (m.epoch != null && (ds.lastEpoch == null || m.epoch > ds.lastEpoch)) ds.lastEpoch = m.epoch;
        }
        if (ds.instances.length < CAP) ds.instances.push({ key: inst.key, name: inst.name, metrics });
        else ds.truncated = true;
      }
    }
    const order = familyIds();
    const families = [...famMap.entries()].sort((a, b) => order.indexOf(a[0]) - order.indexOf(b[0])).map(([family, dsMap]) => ({
      family,
      label: familyLabel(family),
      datasources: [...dsMap.values()].sort((a, b) => a.label.localeCompare(b.label)).map((ds) => {
        const { lastEpoch, ...rest } = ds;
        return { ...rest, lastAt: rest.lastAt || epochToIso(lastEpoch), instances: rest.instances.sort((a, b) => String(a.name).localeCompare(String(b.name))) };
      }),
    }));
    res.json({ families });
  } catch (err) { next(err); }
});

router.get('/metrics/history', [
  query('deviceId').isInt().toInt(),
  query('hdsId').isInt().toInt(),
  query('instanceKey').isString().isLength({ min: 1, max: 500 }),
  query('metric').isString().matches(/^[a-z0-9_]{1,64}$/),
  query('hours').optional().isInt({ min: 1, max: 168 }).toInt(),
  query('sourceId').optional().isInt().toInt(),
], validate, (req, res, next) => {
  try {
    const q = req.query;
    let sourceId = q.sourceId;
    if (sourceId == null) {
      const hit = db.prepare('SELECT source_id FROM lm_ds_metrics_history WHERE lm_device_id = ? AND hds_id = ? AND instance_key = ? AND metric = ? LIMIT 1')
        .get(q.deviceId, q.hdsId, q.instanceKey, q.metric);
      sourceId = hit ? hit.source_id : null;
    }
    if (sourceId == null) return res.json([]);
    res.json(historySeries(sourceId, q.deviceId, q.hdsId, q.instanceKey, q.metric, q.hours || 24));
  } catch (err) { next(err); }
});

// Manual metrics-tier trigger (body.sourceId, or every enabled portal). POST on
// the metrics path takes the manage permission like the other poll triggers.
function triggerMetrics(rows) {
  const h = pollerHandle();
  for (const row of rows) {
    try { Promise.resolve(typeof h.triggerMetrics === 'function' ? h.triggerMetrics(row) : h.trigger(row)).catch(() => {}); } catch { /* poller unavailable */ }
  }
}
router.post('/metrics/poll', [body('sourceId').optional({ nullable: true }).isInt().toInt()], validate, (req, res, next) => {
  try {
    let rows;
    if (req.body && req.body.sourceId != null) {
      const row = getSourceRow(req.body.sourceId);
      if (!row) return notFound(res);
      rows = [row];
    } else rows = db.prepare('SELECT * FROM lm_sources WHERE enabled = 1').all();
    triggerMetrics(rows);
    res.status(202).json({ ok: true, triggered: rows.length });
  } catch (err) { next(err); }
});
router.post('/sources/:id/poll-metrics', [param('id').isInt().toInt()], validate, (req, res, next) => {
  try {
    const row = getSourceRow(req.params.id);
    if (!row) return notFound(res);
    triggerMetrics([row]);
    res.status(202).json({ ok: true, triggered: 1 });
  } catch (err) { next(err); }
});

module.exports = router;
// Exposed for tests.
module.exports.normalizeCompany = normalizeCompany;
module.exports.buildBehind = buildBehind;
module.exports.buildDataQuality = buildDataQuality;
module.exports.buildSites = buildSites;
module.exports.lookups = lookups;
module.exports.reviewRows = reviewRows;
module.exports.newestByModel = newestByModel;
module.exports.interfaceOut = interfaceOut;
module.exports.locState = locState;
module.exports.safeIssues = safeIssues;
