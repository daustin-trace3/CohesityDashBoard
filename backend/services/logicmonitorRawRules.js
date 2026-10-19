// Round 12: operator-defined raw datapoint rules. The raw store (lm_ds_values)
// holds the latest value of every datapoint of every DataSource with
// instances; a rule turns any numeric datapoint into an ICC issue without a
// catalog change. Rules live in the text setting lm_raw_rules (JSON array) and
// the issues they raise (type raw-threshold) flow through the same history,
// Alerts, Service Status and Ops Agent paths as every computed LM issue.
//
// Rule: { id, datasource, datapoint, op, value, severity, label?, instanceMatch?, deviceMatch?, enabled }

const MAX_RULES = 200;
const MAX_ISSUES_PER_RULE = 200;
const OPS = ['>', '>=', '<', '<=', '==', '!='];
const SEVERITIES = ['info', 'warning', 'critical'];

const cmp = {
  '>': (a, b) => a > b,
  '>=': (a, b) => a >= b,
  '<': (a, b) => a < b,
  '<=': (a, b) => a <= b,
  '==': (a, b) => a === b,
  '!=': (a, b) => a !== b,
};

const fmtVal = (v) => (Number.isInteger(v) ? String(v) : String(Math.round(v * 100) / 100));

function compileRegex(src) {
  if (src == null || src === '') return { ok: true, rx: null };
  if (typeof src !== 'string' || src.length > 300) return { ok: false, rx: null };
  try { return { ok: true, rx: new RegExp(src, 'i') }; } catch { return { ok: false, rx: null }; }
}

/**
 * Normalise one raw rule. Returns { rule } or { error }. Strict: used by the
 * save route and by parseRules (which drops the rows that fail).
 */
function normalizeRule(r, index = 0) {
  if (!r || typeof r !== 'object' || Array.isArray(r)) return { error: `rule ${index + 1} is not an object` };
  const datasource = typeof r.datasource === 'string' ? r.datasource.trim() : '';
  const datapoint = typeof r.datapoint === 'string' ? r.datapoint.trim() : '';
  if (!datasource || datasource.length > 200) return { error: `rule ${index + 1} needs a datasource` };
  if (!datapoint || datapoint.length > 200) return { error: `rule ${index + 1} needs a datapoint` };
  if (!OPS.includes(r.op)) return { error: `rule ${index + 1} has an unknown operator` };
  const value = typeof r.value === 'string' && r.value.trim() !== '' ? Number(r.value) : r.value;
  if (typeof value !== 'number' || !Number.isFinite(value)) return { error: `rule ${index + 1} needs a finite number as its value` };
  const severity = r.severity == null || r.severity === '' ? 'warning' : r.severity;
  if (!SEVERITIES.includes(severity)) return { error: `rule ${index + 1} has an unknown severity` };
  const im = compileRegex(r.instanceMatch);
  if (!im.ok) return { error: `rule ${index + 1} has an instance pattern that does not compile` };
  const dm = compileRegex(r.deviceMatch);
  if (!dm.ok) return { error: `rule ${index + 1} has a device pattern that does not compile` };
  const id = r.id == null || r.id === '' ? `r${index + 1}` : String(r.id).slice(0, 80);
  return {
    rule: {
      id, datasource, datapoint, op: r.op, value, severity,
      label: typeof r.label === 'string' ? r.label.trim().slice(0, 200) : '',
      instanceMatch: typeof r.instanceMatch === 'string' ? r.instanceMatch : '',
      deviceMatch: typeof r.deviceMatch === 'string' ? r.deviceMatch : '',
      enabled: r.enabled !== false && r.enabled !== 0 && r.enabled !== '0',
    },
  };
}

/** Lenient: stored text -> rules. Bad rows are dropped, never throws. */
function parseRules(text) {
  let arr;
  try { arr = typeof text === 'string' ? JSON.parse(text || '[]') : text; } catch { return []; }
  if (!Array.isArray(arr)) return [];
  const out = [];
  const seen = new Set();
  for (let i = 0; i < arr.length && out.length < MAX_RULES; i += 1) {
    const n = normalizeRule(arr[i], i);
    if (!n.rule || seen.has(n.rule.id)) continue;
    seen.add(n.rule.id);
    out.push(n.rule);
  }
  return out;
}

/** Strict: a save body list -> { rules } or { error }. */
function validateRules(list) {
  if (!Array.isArray(list)) return { error: 'rules must be an array' };
  if (list.length > MAX_RULES) return { error: `at most ${MAX_RULES} rules are allowed` };
  const out = [];
  const seen = new Set();
  for (let i = 0; i < list.length; i += 1) {
    const n = normalizeRule(list[i], i);
    if (n.error) return { error: n.error };
    if (seen.has(n.rule.id)) return { error: `rule id ${n.rule.id} is used twice` };
    seen.add(n.rule.id);
    out.push(n.rule);
  }
  return { rules: out };
}

/** Rows of lm_ds_values that satisfy one rule: [{ sourceId, deviceId, deviceName, instanceKey, instanceName, value, sdt }]. */
function matchRule(dbh, rule) {
  const { hasSdt } = require('./logicmonitorApi');
  const devRx = compileRegex(rule.deviceMatch).rx;
  const instRx = compileRegex(rule.instanceMatch).rx;
  const test = cmp[rule.op];
  let rows;
  try {
    rows = dbh.prepare(`
      SELECT v.source_id, v.lm_device_id, v.hds_id, v.instance_key, COALESCE(v.instance_name, i.instance_name) AS instance_name,
        v.datasource_name, v.value, d.display_name, d.name AS device_name, d.sdt_status
      FROM lm_ds_values v
      JOIN lm_devices d ON d.source_id = v.source_id AND d.lm_device_id = v.lm_device_id AND d.stale = 0
      LEFT JOIN lm_ds_instances i ON i.source_id = v.source_id AND i.lm_device_id = v.lm_device_id
        AND i.hds_id = v.hds_id AND i.instance_key = v.instance_key
      WHERE v.datasource_name = ? COLLATE NOCASE AND v.datapoint = ? COLLATE NOCASE AND v.value IS NOT NULL
        AND COALESCE(i.stale, 0) = 0
    `).all(rule.datasource, rule.datapoint);
  } catch { return []; }
  const out = [];
  const seen = new Set();
  for (const r of rows) {
    if (typeof r.value !== 'number' || !Number.isFinite(r.value)) continue;
    if (!test(r.value, rule.value)) continue;
    const deviceName = r.display_name || r.device_name;
    const key = r.source_id + ':' + r.lm_device_id + ':' + r.instance_key;
    if (seen.has(key)) continue;
    const instName = r.instance_name || r.instance_key || '';
    if (devRx && !devRx.test(deviceName)) continue;
    if (instRx && !instRx.test(instName) && !instRx.test(String(r.instance_key || ''))) continue;
    seen.add(key);
    const single = !r.instance_key || String(r.instance_key).toLowerCase() === String(r.datasource_name).toLowerCase();
    out.push({
      sourceId: r.source_id, deviceId: r.lm_device_id, deviceName,
      instanceKey: r.instance_key, instanceName: single ? '' : instName, value: r.value, sdt: hasSdt(r.sdt_status),
    });
  }
  return out;
}

const ruleName = (rule) => rule.label || `${rule.datasource}/${rule.datapoint}`;

/**
 * Issues for every enabled rule. srcName: Map sourceId -> portal name (read
 * from lm_sources when omitted). One issue per rule per device per instance;
 * a rule matching more than MAX_ISSUES_PER_RULE rows folds into one issue.
 * When two rules land on the same target the higher severity wins.
 */
function evaluate(dbh, rules, opts = {}) {
  const list = (rules || []).filter((r) => r && r.enabled !== false);
  if (!list.length) return [];
  let srcName = opts.srcName;
  if (!srcName) {
    srcName = new Map();
    try { for (const s of dbh.prepare('SELECT id, name FROM lm_sources').all()) srcName.set(s.id, s.name); } catch { /* none */ }
  }
  const order = { critical: 0, warning: 1, info: 2 };
  const byTarget = new Map();
  const put = (issue) => {
    const k = `${issue.source}|${issue.target}`;
    const prev = byTarget.get(k);
    if (!prev || order[issue.severity] < order[prev.severity]) byTarget.set(k, issue);
  };
  for (const rule of list) {
    const hits = matchRule(dbh, rule).filter((h) => !h.sdt);
    if (!hits.length) continue;
    const name = ruleName(rule);
    const cond = `${rule.op} ${fmtVal(rule.value)}`;
    if (hits.length > MAX_ISSUES_PER_RULE) {
      const first = hits.slice(0, 3).map((h) => `${h.deviceName}${h.instanceName ? ` ${h.instanceName}` : ''} ${fmtVal(h.value)}`).join(', ');
      put({
        severity: rule.severity, type: 'raw-threshold', source: srcName.get(hits[0].sourceId) || null, target: `${name} (${hits.length} instances)`,
        message: `${name} is ${cond} on ${hits.length} instances (${first}, ...)`,
      });
      continue;
    }
    for (const h of hits) {
      put({
        severity: rule.severity, type: 'raw-threshold', source: srcName.get(h.sourceId) || null,
        target: h.instanceName ? `${h.deviceName} ${h.instanceName}` : h.deviceName,
        message: `${name} is ${fmtVal(h.value)} (${cond}) on ${h.instanceName || h.deviceName}${h.instanceName ? ` of ${h.deviceName}` : ''}`,
      });
    }
  }
  return [...byTarget.values()];
}

/** Hook used by logicmonitorIssues.computeIssues. */
function rawRuleIssues(dbh, t, srcName, text) {
  return evaluate(dbh, parseRules(text), { srcName });
}

/** Settings panel preview: how many rows match a (possibly unsaved) rule and the first 20. */
function previewRule(dbh, rule) {
  const n = normalizeRule({ ...(rule || {}), enabled: true }, 0);
  if (n.error) return { error: n.error, matches: 0, sample: [] };
  const hits = matchRule(dbh, n.rule);
  return {
    matches: hits.length,
    sample: hits.slice(0, 20).map((h) => ({ deviceName: h.deviceName, instanceName: h.instanceName, value: h.value })),
  };
}

module.exports = {
  MAX_RULES, OPS, SEVERITIES, parseRules, validateRules, normalizeRule, evaluate, rawRuleIssues, previewRule, matchRule,
};
