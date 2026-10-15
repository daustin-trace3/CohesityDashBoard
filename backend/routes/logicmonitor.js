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
  const n = parseInt(v, 10);
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

function safeIssues() {
  return lmIssues().computeIssues() || [];
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
        polling_interval_minutes, interface_poll_minutes, group_filter_json, interface_categories_json, site_rule_json)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      name, company, mode, encrypt(JSON.stringify(creds)),
      b.verifySsl === false ? 0 : 1, b.enabled === false ? 0 : 1,
      b.pollingIntervalMinutes || 5, b.interfacePollMinutes || 15,
      JSON.stringify(Array.isArray(b.groupFilter) ? b.groupFilter : []),
      Array.isArray(b.interfaceCategories) ? JSON.stringify(b.interfaceCategories) : null,
      siteRuleIn(b.siteRule),
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
        interface_categories_json = ?, features_json = ?, rate_limit_json = ?, site_rule_json = ?
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
      FROM lm_alerts WHERE cleared = 0
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
      SELECT COALESCE(resource_template_name, 'Unknown') name, COUNT(*) count FROM lm_alerts WHERE cleared = 0
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
      FROM lm_alerts WHERE cleared = 0
    `).get();
    res.json({ items: rows.map(alertOut), total, page, limit, counts });
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
  const devices = db.prepare('SELECT source_id, lm_device_id, site_key, host_status, is_network FROM lm_devices WHERE stale = 0 AND site_key IS NOT NULL').all();
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
    return {
      siteKey: st.site_key, siteName: st.site_name || st.site_key, source: st.source_name, sourceId: st.source_id,
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
  query('siteKey').optional().matches(/^[a-z0-9-]{1,80}$/),
  query('state').optional().isIn(['ok', 'warning', 'critical']),
], validate, (req, res, next) => {
  try {
    let rows = lmPath().circuitRows(db, { sourceId: req.query.sourceId != null ? req.query.sourceId : null, siteKey: req.query.siteKey || null });
    if (req.query.state) rows = rows.filter((r) => r.state === req.query.state);
    res.json(rows);
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
    if (r.isInterface) collected = 'instances + metrics';
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
  for (const r of ifRows) {
    const ci = lmPath().circuitInfo(r.description, r.props_json);
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

  const topologyUnmatched = db.prepare(`
    SELECT d.display_name AS device_name, i.display_name, i.description, l.src_device_id, l.src_instance_id
    FROM lm_topology_links l
    LEFT JOIN lm_devices d ON d.source_id = l.source_id AND d.lm_device_id = l.src_device_id
    LEFT JOIN lm_interfaces i ON i.source_id = l.source_id AND i.instance_id = l.src_instance_id
    WHERE l.dst_device_id IS NULL AND l.dst_platform IS NULL AND COALESCE(l.stale, 0) = 0
    ORDER BY d.display_name, i.display_name
  `).all().map((r) => ({ deviceId: r.src_device_id, instanceId: r.src_instance_id, deviceName: r.device_name, displayName: r.display_name, description: r.description }));

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
    uplinkRule: r.uplinkRule, runCount: r.runCount,
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
};

router.get('/correlation', (req, res, next) => {
  try { res.json(lmCorrelation().correlation(db)); } catch (err) { next(err); }
});

router.get('/correlation.csv', [query('section').isIn(Object.keys(CORRELATION_CSV))], validate, (req, res, next) => {
  try {
    sendCsv(res, `correlation-${req.query.section}`, CORRELATION_CSV[req.query.section](lmCorrelation().correlation(db)));
  } catch (err) { next(err); }
});

// ---- Issues, history, trends, SDT, topology --------------------------------

router.get('/issues', (req, res, next) => {
  try { res.json({ issues: safeIssues() }); } catch (err) { next(err); }
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
    const hours = TREND_RANGES[req.query.range || '24h'];
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
    res.json({
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

const configPayload = () => ({ thresholds: allThresholds(), ranges: buildRanges(), labels: buildLabels() });

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
        if (!(typeof v === 'number' ? Number.isInteger(v) : /^-?\d+$/.test(String(v).trim()))) { bad.push({ path: key, msg: 'must be an integer' }); continue; }
        writes.push([key, String(clampTo(key, v))]);
      }
    }
    if (bad.length) return res.status(400).json({ error: 'Invalid parameters', details: bad });
    for (const [k, v] of writes) setSetting(k, v);
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
