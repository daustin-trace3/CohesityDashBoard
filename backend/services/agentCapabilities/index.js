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
const agentProfiles = require('../agentProfiles');
const hostIdentity = require('../hostIdentity');

const SETTING_KEY = 'ops_agent_capabilities';
const RISK_CLASSES = ['read-only', 'network-probe', 'platform-api', 'action'];
const RUN_TIMEOUT_MS = 4000;      // one capability against one target (a capability may set its own timeoutMs)
const PLAYBOOK_TIMEOUT_MS = 25000; // the whole playbook for one incident
const CONCURRENCY = 4;
const MAX_TARGETS = 6;
const RUN_LOG_DAYS = 30;

// Which ports ICC probes comes from the platform profile (agentProfiles):
// defaults shipped with ICC, a pack's manifest.agentProfile, or the customer's
// own map under Global Settings > Platform profiles. A profile never adds a
// target, only says which ports to try on targets the incident already names.

// ---------------------------------------------------------------------------
// Catalog
// ---------------------------------------------------------------------------

let builtins = null;
function loadBuiltins() {
  if (builtins) return builtins;
  builtins = [];
  // Static requires so a bundler carries the files; keep sorted by file name.
  const files = {
    'brocade_port_stats.js': () => require('./capabilities/brocade_port_stats.js'),
    'cohesity_run_detail.js': () => require('./capabilities/cohesity_run_detail.js'),
    'dell_hardware_log.js': () => require('./capabilities/dell_hardware_log.js'),
    'dns.js': () => require('./capabilities/dns.js'),
    'history_slice.js': () => require('./capabilities/history_slice.js'),
    'ping.js': () => require('./capabilities/ping.js'),
    'pure_perf_now.js': () => require('./capabilities/pure_perf_now.js'),
    'repoll.js': () => require('./capabilities/repoll.js'),
    'tcp_port.js': () => require('./capabilities/tcp_port.js'),
    'tls.js': () => require('./capabilities/tls.js'),
    'vcenter_events_live.js': () => require('./capabilities/vcenter_events_live.js'),
    'zerto_events_live.js': () => require('./capabilities/zerto_events_live.js'),
  };
  for (const f of Object.keys(files).sort()) {
    try {
      const cap = files[f]();
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
  if (cap.timeoutMs !== undefined && !(Number.isFinite(cap.timeoutMs) && cap.timeoutMs >= 500 && cap.timeoutMs <= 20000)) throw new Error(`${where}: timeoutMs must be 500 to 20000`);
  if (cap.params !== undefined && !(cap.params && typeof cap.params === 'object' && cap.params.properties && typeof cap.params.properties === 'object')) throw new Error(`${where}: params needs a properties object`);
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
    deepOnly: !!c.deepOnly, timeoutMs: c.timeoutMs || RUN_TIMEOUT_MS,
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
  // [platform, sql, args, kind]. kind picks the port list: an ESX host and a VM
  // guest each have their own, every other inventory row is a device.
  const lookups = [
    ['dell', 'SELECT ip_address a FROM dell_devices WHERE lower(name) = ? OR lower(service_tag) = ?', [lc, lc], 'device'],
    ['vcenter', "SELECT name a FROM vcenter_hosts WHERE lower(name) = ? OR lower(substr(name, 1, instr(name || '.', '.') - 1)) = ?", [lc, lc], 'esx'],
    ['vcenter', 'SELECT ip_address a, guest_os os FROM vcenter_vms WHERE lower(name) = ? OR lower(guest_hostname) = ?', [lc, lc], 'vm'],
    ['brocade', 'SELECT ip_address a FROM brocade_switches WHERE lower(name) = ?', [lc], 'device'],
    ['bluecat', 'SELECT address a FROM bluecat_servers WHERE lower(name) = ?', [lc], 'device'],
    ['zerto', 'SELECT zvm_ip a FROM zerto_sites WHERE lower(name) = ?', [lc], 'device'],
    ['unifi', 'SELECT ip a FROM unifi_devices WHERE lower(name) = ?', [lc], 'device'],
    ['logicmonitor', "SELECT COALESCE(NULLIF(name,''), display_name) a FROM lm_devices WHERE lower(display_name) = ?", [lc], 'device'],
  ];
  // The alerting platform's own table first, then any other that knows the name.
  lookups.sort((x, y) => (x[0] === platform ? -1 : 0) - (y[0] === platform ? -1 : 0));
  for (const [via, sql, args, kind] of lookups) {
    const r = sq(sql, ...args);
    if (r && r.a) return { name: short, address: hostPart(r.a), kind, via, osFamily: kind === 'vm' ? agentProfiles.osFamilyOf(r.os) : undefined };
  }
  if (IPV4.test(short) || short.includes('.')) return { name: short, address: short, kind: 'device', via: platform };
  return { name: short, address: null, note: 'no address on record', kind: 'device', via: platform };
}

const SOURCE_TABLES = {
  cohesity: 'clusters', vcenter: 'vcenter_vcenters', hyperv: 'hyperv_sources', dell: 'dell_ome_instances',
  brocade: 'brocade_sources', logicmonitor: 'lm_sources', pure: 'pure_arrays', netapp: 'netapp_arrays',
};

/** { platform, id, row } for a polled source: the stored row the platform API module takes. Zerto has
 *  no source row (its configuration is global), so it gets none. The row carries credentials
 *  (encrypted) and is therefore NOT enumerable: it never reaches a JSON dump of the target. */
function sourceRef(platform, entityId) {
  const table = SOURCE_TABLES[platform];
  const ref = { platform, id: Number(entityId) };
  if (!table) return ref;
  const row = sq(`SELECT * FROM ${table} WHERE id = ?`, ref.id);
  Object.defineProperty(ref, 'row', { value: row, enumerable: false, writable: true, configurable: true });
  return ref;
}

/** Targets for one incident: alert hosts and the sources behind poll:/stale:
 *  alerts, de-duplicated, capped. Each carries the port list the platform
 *  profile gives for its kind: portEntries ({ port, label, expect }) for
 *  tcp_port, and ports (the same port numbers) for the other capabilities. */
function targetsFor(inc, alerts) {
  const out = [];
  const seen = new Set();
  let idx = null;
  try { idx = hostIdentity.buildIdentityIndex(db); } catch { idx = null; }
  const push = (t) => {
    const key = `${t.kind}:${(t.address || t.name || '').toLowerCase()}`;
    if (!t.address || seen.has(key) || out.length >= MAX_TARGETS) return;
    seen.add(key);
    // identity: what the host identity index makes of the name (platforms that know it).
    // Used by the platform-api capabilities to pick their own row; absent when nothing matches.
    if (idx) {
      try {
        const { ref } = hostIdentity.explainToken(idx, t.name);
        if (ref) t.identity = { ref, platforms: [...ref.platforms] };
      } catch { /* identity is optional */ }
    }
    out.push(t);
  };
  for (const a of alerts) {
    if (a.cleared_at) continue;
    const m = /^(poll|stale):(\d+)$/.exec(String(a.source_key || ''));
    if (m) {
      const s = sourceAddress(a.platform, m[2]);
      if (s) {
        const portEntries = agentProfiles.portsForTarget({ platform: a.platform, kind: 'source' });
        const t = { kind: 'source', platform: a.platform, name: s.name, address: s.address, ports: portEntries.map((e) => e.port), portEntries, note: s.note };
        t.source = sourceRef(a.platform, m[2]);
        push(t);
      }
      continue;
    }
    if (!a.host) continue;
    const h = hostAddress(a.platform, a.host);
    if (h) {
      const portEntries = agentProfiles.portsForTarget({ platform: h.via || a.platform, kind: h.kind || 'device', osFamily: h.osFamily });
      push({ kind: 'host', hostKind: h.kind || 'device', osFamily: h.osFamily, platform: a.platform, name: h.name, address: h.address, ports: portEntries.map((e) => e.port), portEntries, note: h.note });
    }
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

async function runOne(cap, target, ctx, args = {}) {
  const started = Date.now();
  const requestedBy = ctx.requestedBy || 'playbook';
  const rec = { capability: cap.id, label: cap.label, risk: cap.risk, requestedBy, target: { kind: target.kind, platform: target.platform, name: target.name, address: target.address }, at: new Date(started).toISOString() };
  try {
    const timeoutMs = cap.timeoutMs || RUN_TIMEOUT_MS;
    const r = await withTimeout(Promise.resolve(cap.run(target, ctx, args || {})), timeoutMs, `${cap.id} on ${target.name}`);
    // null from a capability means "nothing applies here" (history_slice with no mapped metric):
    // skipped, not a failure, and not worth an audit row.
    if (r === null) return null;
    rec.ok = r && r.ok !== false;
    rec.summary = (r && r.summary) || (rec.ok ? 'ok' : 'failed');
    rec.data = r && r.data !== undefined ? r.data : null;
  } catch (err) {
    rec.ok = false;
    rec.summary = err.message;
    rec.data = null;
  }
  rec.durationMs = Date.now() - started;
  if (ctx.reason) rec.reason = String(ctx.reason).slice(0, 200);
  try {
    db.prepare('INSERT INTO ops_capability_runs (incident_id, capability, risk, target_kind, platform, target_name, target_address, ok, summary, result_json, ran_at, duration_ms, requested_by, reason) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
      .run(ctx.incidentId ?? null, cap.id, cap.risk, target.kind, target.platform, target.name, target.address, rec.ok ? 1 : 0, String(rec.summary).slice(0, 500), JSON.stringify(rec.data), rec.at, rec.durationMs, requestedBy, rec.reason || null);
  } catch (err) {
    logger.warn(`[AgentCapabilities] run log not written: ${err.message}`);
  }
  return rec;
}

/** Run every enabled playbook capability that applies, against every target
 *  the incident resolves to. Never throws; returns { ran, skipped, results }. */
async function runPlaybook(inc, alerts, { evidence = null, deep = false } = {}) {
  const demo = isDemo();
  // The public demo never probes anything. A capability that only reads ICC's own database
  // (localOnly) is the one exception: it never leaves the box.
  const caps = catalog().filter((c) => c.playbook !== false && isEnabled(c.id) && (deep || !c.deepOnly) && (!demo || c.localOnly));
  if (demo && !caps.length) return { ran: false, skipped: 'demo mode: the agent never probes anything from the public demo', results: [] };
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
    if (demo) return { ran: false, skipped: 'demo mode: the agent never probes anything from the public demo', results: [] };
    const why = targets.length ? 'nothing applied to these targets' : 'no target with a stored address';
    return { ran: false, skipped: why, results: [], unresolved: unresolvedNotes(inc, alerts) };
  }
  const results = [];
  let i = 0;
  const worker = async () => { while (i < jobs.length) { const [cap, t] = jobs[i++]; const rec = await runOne(cap, t, ctx); if (rec) results.push(rec); } };
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
  return db.prepare(`SELECT id, incident_id incidentId, capability, risk, target_kind targetKind, platform, target_name targetName, target_address targetAddress, ok, summary, ran_at ranAt, duration_ms durationMs, requested_by requestedBy, reason FROM ops_capability_runs ${where} ORDER BY id DESC LIMIT ?`)
    .all(...args).map((r) => ({ ...r, ok: !!r.ok }));
}

/** Test hook: swap the built-in list. */
function _setBuiltins(list) { builtins = list; }

module.exports = {
  catalog, listCapabilities, isEnabled, saveEnabled, enabledMap, targetsFor, runPlaybook, listRuns,
  sourceAddress, hostAddress, hostPart, RISK_CLASSES, SETTING_KEY, _setBuiltins,
  runOne, withTimeout, unresolvedNotes, PLAYBOOK_TIMEOUT_MS, RUN_TIMEOUT_MS,
};
