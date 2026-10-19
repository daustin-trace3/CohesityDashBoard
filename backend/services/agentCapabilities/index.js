// Operations Agent capabilities: the things the agent may do beyond reading
// ICC's own tables. Each capability is one file under ./capabilities (or an
// entry a plugin pack declares as manifest.agentCapabilities) and says what
// it is, how risky it is, which incidents it applies to and how to run it
// against one target. Nothing here runs itself: runPlaybook() is the single
// executor, and it is the only place the rules live:
//   - a target is always something ICC already holds (an alert host or a
//     polled source resolved to its stored address); the model never names one
//   - every capability ships with a default the customer can override per
//     tenant under Global Settings > Agent Capabilities
//   - a hard timeout and a concurrency cap on every run
//   - every run is written to ops_capability_runs with what it touched
//   - the public demo never probes anything
// The agent triages once per incident, so the playbook runs once per
// incident too, right before the model call, and its results ride in the
// evidence as liveChecks.
const { pruneInBatches } = require('../../core/dbPrune');
const fs = require('fs');
const path = require('path');
const db = require('../../db/database');
const logger = require('../../utils/logger');
const { getSetting, setSetting } = require('../settings');
const { isDemo } = require('../demoMode');
const registry = require('../../core/registry');

const SETTING_KEY = 'ops_agent_capabilities';
const RISK_CLASSES = ['read-only', 'network-probe', 'platform-api', 'action'];
const RUN_TIMEOUT_MS = 4000;      // one capability against one target
const PLAYBOOK_TIMEOUT_MS = 25000; // the whole playbook for one incident
const CONCURRENCY = 4;
const MAX_TARGETS = 6;
const RUN_LOG_DAYS = 30;

// Management ports ICC may probe per platform source. Fixed on purpose: the
// list is part of the audit story ("ICC only ever connects to these").
const SOURCE_PORTS = {
  cohesity: [443], pure: [443], netapp: [443], vcenter: [443], dell: [443], aria: [443], ariaops: [443],
  unifi: [443], brocade: [443], bluecat: [443], eon: [443], zerto: [443], logicmonitor: [443],
};
const HOST_PORTS = {
  dell: [443], vcenter: [443, 902], brocade: [22, 443], bluecat: [22, 443], unifi: [22, 443], zerto: [443, 9669],
  logicmonitor: [22, 443, 161],
};
const DEFAULT_PORTS = [443];

// ---------------------------------------------------------------------------
// Catalog
// ---------------------------------------------------------------------------

let builtins = null;
function loadBuiltins() {
  if (builtins) return builtins;
  builtins = [];
  const dir = path.join(__dirname, 'capabilities');
  for (const f of fs.readdirSync(dir).filter((n) => n.endsWith('.js')).sort()) {
    try {
      const cap = require(path.join(dir, f));
      validate(cap, f);
      builtins.push({ ...cap, source: 'built-in' });
    } catch (err) {
      logger.error(`[AgentCapabilities] ${f} not loaded: ${err.message}`);
    }
  }
  return builtins;
}

function validate(cap, where) {
  if (!cap || typeof cap !== 'object') throw new Error(`${where}: not an object`);
  if (!/^[a-z0-9_-]{2,40}$/.test(String(cap.id || ''))) throw new Error(`${where}: bad id`);
  if (!cap.label) throw new Error(`${where}: label missing`);
  if (!RISK_CLASSES.includes(cap.risk)) throw new Error(`${where}: risk must be one of ${RISK_CLASSES.join(', ')}`);
  if (cap.playbook !== false && typeof cap.run !== 'function') throw new Error(`${where}: run() missing`);
}

/** Pack-contributed capabilities, ids namespaced by pack so two packs cannot
 *  collide with each other or with a built-in. */
function packCapabilities() {
  const out = [];
  let providers = [];
  try { providers = registry.getAgentCapabilityProviders(); } catch { providers = []; }
  for (const p of providers) {
    for (const cap of p.capabilities) {
      try {
        validate(cap, `${p.id} pack`);
        // platform '*' means the capability applies to any incident target (a
        // read-only lookup keyed by host name), not only the pack's own platform.
        out.push({ ...cap, id: `${p.id}:${cap.id}`, source: p.id, platform: cap.platform === '*' ? null : (cap.platform || p.id) });
      } catch (err) {
        logger.warn(`[AgentCapabilities] pack ${p.id}: ${err.message}`);
      }
    }
  }
  return out;
}

function catalog() {
  return [...loadBuiltins(), ...packCapabilities()];
}

// ---------------------------------------------------------------------------
// Settings: one JSON map { id: true|false }; a missing id takes the
// capability's own default, so a new capability lands with its declared
// posture and a pack can ship one without touching anything else.
// ---------------------------------------------------------------------------

function enabledMap() {
  try {
    const v = JSON.parse(getSetting(SETTING_KEY) || '{}');
    return v && typeof v === 'object' && !Array.isArray(v) ? v : {};
  } catch { return {}; }
}

function isEnabled(id) {
  const cap = catalog().find((c) => c.id === id);
  if (!cap) return false;
  const m = enabledMap();
  return Object.prototype.hasOwnProperty.call(m, id) ? !!m[id] : !!cap.defaultEnabled;
}

/** Save overrides for the ids given; unknown ids are dropped, nothing else is touched. */
function saveEnabled(changes) {
  if (!changes || typeof changes !== 'object') return enabledMap();
  const ids = new Set(catalog().map((c) => c.id));
  const next = enabledMap();
  for (const [id, v] of Object.entries(changes)) if (ids.has(id)) next[id] = !!v;
  setSetting(SETTING_KEY, JSON.stringify(next));
  return next;
}

/** The catalog as the settings page shows it. */
function listCapabilities() {
  const m = enabledMap();
  return catalog().map((c) => ({
    id: c.id, label: c.label, description: c.description || '', risk: c.risk, source: c.source,
    platform: c.platform || null, playbook: c.playbook !== false,
    defaultEnabled: !!c.defaultEnabled,
    enabled: Object.prototype.hasOwnProperty.call(m, c.id) ? !!m[c.id] : !!c.defaultEnabled,
  }));
}

// ---------------------------------------------------------------------------
// Targets: what an incident is about, as addresses ICC already stores
// ---------------------------------------------------------------------------

const IPV4 = /^\d{1,3}(\.\d{1,3}){3}$/;

function hostPart(value) {
  let s = String(value || '').trim();
  if (!s) return '';
  s = s.replace(/^[a-z]+:\/\//i, '').split('/')[0];
  if (!s.includes(']')) s = s.split(':')[0];
  return s;
}

function sq(sql, ...args) {
  try { return db.prepare(sql).get(...args) || null; } catch { return null; }
}

/** Address of a polled source: the host ICC itself connects to. */
function sourceAddress(platform, entityId) {
  const id = Number(entityId);
  switch (platform) {
    case 'cohesity': { const r = sq('SELECT name, vip, connection_type FROM clusters WHERE id = ?', id); return r && r.connection_type === 'direct' && r.vip ? { name: r.name, address: hostPart(r.vip) } : r ? { name: r.name, address: null, note: 'reached through Helios, no direct address stored' } : null; }
    case 'pure': { const r = sq('SELECT name, mgmt_host FROM pure_arrays WHERE id = ?', id); return r ? { name: r.name, address: hostPart(r.mgmt_host) } : null; }
    case 'netapp': { const r = sq('SELECT name, mgmt_host, management_ip FROM netapp_arrays WHERE id = ?', id); return r ? { name: r.name, address: hostPart(r.management_ip || r.mgmt_host) } : null; }
    case 'eon': { const r = sq('SELECT name, endpoint FROM eon_sources WHERE id = ?', id); return r ? { name: r.name, address: hostPart(r.endpoint) } : null; }
    case 'logicmonitor': { const r = sq('SELECT name, company FROM lm_sources WHERE id = ?', id); return r ? { name: r.name, address: r.company ? `${r.company}.logicmonitor.com` : null } : null; }
    case 'vcenter': case 'dell': case 'aria': case 'ariaops': case 'unifi': case 'brocade': case 'bluecat': {
      const table = { vcenter: 'vcenter_vcenters', dell: 'dell_ome_instances', aria: 'aria_instances', ariaops: 'ariaops_instances', unifi: 'unifi_sources', brocade: 'brocade_sources', bluecat: 'bluecat_sources' }[platform];
      const r = sq(`SELECT name, host FROM ${table} WHERE id = ?`, id);
      return r ? { name: r.name, address: hostPart(r.host) } : null;
    }
    default: return null;
  }
}

/** Address of an alert host, from the inventory table that knows it; falls
 *  back to the host string itself when it is an IP or a dotted name, because
 *  that string came from a platform ICC polls, not from the model. */
function hostAddress(platform, host) {
  const name = String(host || '').trim();
  if (!name) return null;
  const short = name.replace(/\s*\([^)]*\)\s*$/, '').split(/[\s,]/)[0];
  const lc = short.toLowerCase();
  const lookups = [
    ['dell', 'SELECT ip_address a FROM dell_devices WHERE lower(name) = ? OR lower(service_tag) = ?', [lc, lc]],
    ['vcenter', 'SELECT ip_address a FROM vcenter_vms WHERE lower(name) = ? OR lower(guest_hostname) = ?', [lc, lc]],
    ['brocade', 'SELECT ip_address a FROM brocade_switches WHERE lower(name) = ?', [lc]],
    ['bluecat', 'SELECT address a FROM bluecat_servers WHERE lower(name) = ?', [lc]],
    ['zerto', 'SELECT zvm_ip a FROM zerto_sites WHERE lower(name) = ?', [lc]],
    ['unifi', 'SELECT ip a FROM unifi_devices WHERE lower(name) = ?', [lc]],
    ['logicmonitor', "SELECT COALESCE(NULLIF(name,''), display_name) a FROM lm_devices WHERE lower(display_name) = ?", [lc]],
  ];
  // The alerting platform's own table first, then any other that knows the name.
  lookups.sort((x, y) => (x[0] === platform ? -1 : 0) - (y[0] === platform ? -1 : 0));
  for (const [, sql, args] of lookups) {
    const r = sq(sql, ...args);
    if (r && r.a) return { name: short, address: hostPart(r.a) };
  }
  if (IPV4.test(short) || short.includes('.')) return { name: short, address: short };
  return { name: short, address: null, note: 'no address on record' };
}

/** Targets for one incident: alert hosts and the sources behind poll:/stale:
 *  alerts, de-duplicated, capped. Each carries the fixed port list for its kind. */
function targetsFor(inc, alerts) {
  const out = [];
  const seen = new Set();
  const push = (t) => {
    const key = `${t.kind}:${(t.address || t.name || '').toLowerCase()}`;
    if (!t.address || seen.has(key) || out.length >= MAX_TARGETS) return;
    seen.add(key);
    out.push(t);
  };
  for (const a of alerts) {
    if (a.cleared_at) continue;
    const m = /^(poll|stale):(\d+)$/.exec(String(a.source_key || ''));
    if (m) {
      const s = sourceAddress(a.platform, m[2]);
      if (s) push({ kind: 'source', platform: a.platform, name: s.name, address: s.address, ports: SOURCE_PORTS[a.platform] || DEFAULT_PORTS, note: s.note });
      continue;
    }
    if (!a.host) continue;
    const h = hostAddress(a.platform, a.host);
    if (h) push({ kind: 'host', platform: a.platform, name: h.name, address: h.address, ports: HOST_PORTS[a.platform] || DEFAULT_PORTS, note: h.note });
  }
  return out;
}

// ---------------------------------------------------------------------------
// Executor
// ---------------------------------------------------------------------------

function withTimeout(promise, ms, what) {
  let t;
  const timer = new Promise((_, reject) => { t = setTimeout(() => reject(new Error(`${what} timed out after ${ms} ms`)), ms); });
  return Promise.race([promise, timer]).finally(() => clearTimeout(t));
}

async function runOne(cap, target, ctx) {
  const started = Date.now();
  const rec = { capability: cap.id, label: cap.label, risk: cap.risk, target: { kind: target.kind, platform: target.platform, name: target.name, address: target.address }, at: new Date(started).toISOString() };
  try {
    const r = await withTimeout(Promise.resolve(cap.run(target, ctx)), RUN_TIMEOUT_MS, `${cap.id} on ${target.name}`);
    rec.ok = r && r.ok !== false;
    rec.summary = (r && r.summary) || (rec.ok ? 'ok' : 'failed');
    rec.data = r && r.data !== undefined ? r.data : null;
  } catch (err) {
    rec.ok = false;
    rec.summary = err.message;
    rec.data = null;
  }
  rec.durationMs = Date.now() - started;
  try {
    db.prepare('INSERT INTO ops_capability_runs (incident_id, capability, risk, target_kind, platform, target_name, target_address, ok, summary, result_json, ran_at, duration_ms) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
      .run(ctx.incidentId ?? null, cap.id, cap.risk, target.kind, target.platform, target.name, target.address, rec.ok ? 1 : 0, String(rec.summary).slice(0, 500), JSON.stringify(rec.data), rec.at, rec.durationMs);
  } catch (err) {
    logger.warn(`[AgentCapabilities] run log not written: ${err.message}`);
  }
  return rec;
}

/** Run every enabled playbook capability that applies, against every target
 *  the incident resolves to. Never throws; returns { ran, skipped, results }. */
async function runPlaybook(inc, alerts, { evidence = null } = {}) {
  if (isDemo()) return { ran: false, skipped: 'demo mode: the agent never probes anything from the public demo', results: [] };
  const caps = catalog().filter((c) => c.playbook !== false && isEnabled(c.id));
  if (!caps.length) return { ran: false, skipped: 'no capability is switched on', results: [] };
  const targets = targetsFor(inc, alerts);
  const ctx = { incidentId: inc.id, incident: inc, alerts, evidence, logger };
  const jobs = [];
  for (const cap of caps) {
    for (const t of targets) {
      if (cap.platform && cap.platform !== t.platform) continue;
      if (typeof cap.appliesTo === 'function') { try { if (!cap.appliesTo(t, ctx)) continue; } catch { continue; } }
      jobs.push([cap, t]);
    }
  }
  if (!jobs.length) {
    const why = targets.length ? 'nothing applied to these targets' : 'no target with a stored address';
    return { ran: false, skipped: why, results: [], unresolved: unresolvedNotes(inc, alerts) };
  }
  const results = [];
  let i = 0;
  const worker = async () => { while (i < jobs.length) { const [cap, t] = jobs[i++]; results.push(await runOne(cap, t, ctx)); } };
  try {
    await withTimeout(Promise.all(Array.from({ length: Math.min(CONCURRENCY, jobs.length) }, worker)), PLAYBOOK_TIMEOUT_MS, 'live checks');
  } catch (err) {
    logger.warn(`[AgentCapabilities] ${err.message}; ${results.length} of ${jobs.length} checks completed`);
  }
  try { pruneInBatches(db, 'ops_capability_runs', 'ran_at < ?', [new Date(Date.now() - RUN_LOG_DAYS * 86400000).toISOString()]); } catch { /* best effort */ }
  logger.info(`[OpsAgent] ACTION live checks: incident #${inc.id}, ${results.length} check(s) on ${targets.length} target(s): ${results.map((r) => `${r.capability} ${r.target.name} ${r.ok ? 'ok' : 'FAILED'}`).join('; ')}`);
  return { ran: true, results, unresolved: unresolvedNotes(inc, alerts) };
}

/** Hosts and sources that could not be given an address, so the triage can say so. */
function unresolvedNotes(inc, alerts) {
  const notes = [];
  const seen = new Set();
  for (const a of alerts) {
    if (a.cleared_at) continue;
    const m = /^(poll|stale):(\d+)$/.exec(String(a.source_key || ''));
    const r = m ? sourceAddress(a.platform, m[2]) : (a.host ? hostAddress(a.platform, a.host) : null);
    if (r && !r.address && !seen.has(r.name)) { seen.add(r.name); notes.push(`${r.name}: ${r.note || 'no address'}`); }
  }
  return notes;
}

/** Recent runs for the settings page audit table. */
function listRuns({ limit = 50, incidentId = null } = {}) {
  const where = incidentId ? 'WHERE incident_id = ?' : '';
  const args = incidentId ? [incidentId, limit] : [limit];
  return db.prepare(`SELECT id, incident_id incidentId, capability, risk, target_kind targetKind, platform, target_name targetName, target_address targetAddress, ok, summary, ran_at ranAt, duration_ms durationMs FROM ops_capability_runs ${where} ORDER BY id DESC LIMIT ?`)
    .all(...args).map((r) => ({ ...r, ok: !!r.ok }));
}

/** Test hook: swap the built-in list. */
function _setBuiltins(list) { builtins = list; }

module.exports = {
  catalog, listCapabilities, isEnabled, saveEnabled, enabledMap, targetsFor, runPlaybook, listRuns,
  sourceAddress, hostAddress, hostPart, RISK_CLASSES, SETTING_KEY, _setBuiltins,
};
