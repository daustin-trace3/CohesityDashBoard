// Plugin registry + request dispatcher (contract C4).
const { buildCoreApi } = require('./coreApi');
const { runMigrations } = require('./migrations');
const { memoByDbState } = require('./dbMemo');

const PLUGIN_API_VERSION = 1;

const RESERVED_IDS = new Set([
  'license', 'licensing', 'settings', 'poller', 'dns', 'import', 'insights',
  'advisor', 'ai-audit', 'analytics', 'governance', 'dashboard', 'helios',
  'alerts', 'metrics', 'hardware', 'clusters', 'replication', 'plugins',
  'auth', 'users', 'cohesity',
]);

const ID_PATTERN = /^[a-z0-9-]+$/;

// Optional manifest.category values (services/permissionCatalog.js groups the
// grants editor by them). Anything else is ignored with one warning.
const MANIFEST_CATEGORIES = ['backup', 'storage', 'virtualization', 'network', 'dr', 'other'];

const plugins = new Map(); // id -> { manifest, router, status, error, enabled }

let coreApiRef = null;
let initialized = false;
let isEntitledOverride = null;

/** Default entitlement check (contract C9.5): cohesity is always entitled;
 *  otherwise ask services/license.getEntitlements() (lazily required — that
 *  module is built in a parallel work package and may not exist yet). */
function defaultIsEntitled(id) {
  if (id === 'cohesity') return true;
  // A derived platform is entitled with the platform that owns its connector.
  const derivedFrom = plugins.get(id)?.manifest?.derivedFrom;
  if (derivedFrom && derivedFrom !== id) return defaultIsEntitled(derivedFrom);
  let getEntitlements;
  try {
    ({ getEntitlements } = require('../services/license'));
  } catch {
    getEntitlements = null;
  }
  const ent = (typeof getEntitlements === 'function' ? getEntitlements() : null) || { all: true };
  return !!(ent.all || (Array.isArray(ent.platforms) && ent.platforms.includes(id)));
}

/** Test-only: override the isEntitled check with a fn(id) => bool. Pass a
 *  falsy value to restore the default. */
function setIsEntitledFn(fn) {
  isEntitledOverride = typeof fn === 'function' ? fn : null;
}

function isEntitled(id) {
  return (isEntitledOverride || defaultIsEntitled)(id);
}

function init(overrides = {}) {
  if (initialized) return coreApiRef;
  coreApiRef = buildCoreApi(overrides);
  initialized = true;
  return coreApiRef;
}

function validateManifest(manifest) {
  if (!manifest || typeof manifest !== 'object') {
    throw new Error('plugin manifest is required');
  }
  const { id, name, apiVersion, createRouter } = manifest;

  if (typeof id !== 'string' || !ID_PATTERN.test(id)) {
    throw new Error(`invalid plugin id: ${String(id)} (must match ${ID_PATTERN})`);
  }
  if (RESERVED_IDS.has(id)) {
    throw new Error(`plugin id '${id}' is reserved`);
  }
  if (plugins.has(id)) {
    throw new Error(`plugin '${id}' is already registered`);
  }
  if (!name) {
    throw new Error(`plugin '${id}': manifest.name is required`);
  }
  if (apiVersion !== PLUGIN_API_VERSION) {
    throw new Error(
      `plugin '${id}': apiVersion ${apiVersion} does not match PLUGIN_API_VERSION ${PLUGIN_API_VERSION}`
    );
  }
  if (typeof createRouter !== 'function') {
    throw new Error(`plugin '${id}': manifest.createRouter must be a function`);
  }
  validateDerived(manifest);
  if (manifest.category !== undefined && !MANIFEST_CATEGORIES.includes(manifest.category)) {
    const msg = `[registry] plugin '${id}': manifest.category '${String(manifest.category)}' is not one of ${MANIFEST_CATEGORIES.join(', ')}; ignored`;
    const logger = coreApiRef && coreApiRef.logger;
    if (logger) logger.warn(msg); else console.warn(msg);
  }
}

/** Derived platforms (derivedFrom + vendorKeys): fed by a connector, no
 *  poller of their own. The connector must already be registered
 *  (core/feeds.js) and each vendor key belongs to one platform only. */
function validateDerived(manifest) {
  const { id, derivedFrom, vendorKeys } = manifest;
  if (derivedFrom === undefined && vendorKeys === undefined) return;
  if (typeof derivedFrom !== 'string' || !derivedFrom) {
    throw new Error(`plugin '${id}': manifest.derivedFrom must name a connector when vendorKeys is set`);
  }
  if (!require('./feeds').hasConnector(derivedFrom)) {
    throw new Error(`plugin '${id}': derivedFrom connector '${derivedFrom}' is not registered`);
  }
  if (!Array.isArray(vendorKeys) || !vendorKeys.length || vendorKeys.some((k) => typeof k !== 'string' || !k)) {
    throw new Error(`plugin '${id}': manifest.vendorKeys must be a non-empty array of strings`);
  }
  if (new Set(vendorKeys).size !== vendorKeys.length) {
    throw new Error(`plugin '${id}': manifest.vendorKeys lists a key twice`);
  }
  for (const other of plugins.values()) {
    const taken = Array.isArray(other.manifest.vendorKeys) ? other.manifest.vendorKeys : [];
    const clash = vendorKeys.find((k) => taken.includes(k));
    if (clash) throw new Error(`plugin '${id}': vendor key '${clash}' is already claimed by '${other.id}'`);
  }
  if (typeof manifest.presence !== 'function') {
    throw new Error(`plugin '${id}': a derived platform needs manifest.presence(coreApi)`);
  }
}

function upsertPluginRow(entry) {
  // plugins lives in the admin file (db/adminSplit.js).
  const db = coreApiRef && (coreApiRef.adminDb || coreApiRef.db);
  if (!db) return;
  const now = new Date().toISOString();
  db.prepare(`
    INSERT INTO plugins (id, version, schema_version, enabled, status, error, installed_at, updated_at)
    VALUES (@id, @version, 0, @enabled, @status, @error, @now, @now)
    ON CONFLICT(id) DO UPDATE SET
      version = excluded.version,
      enabled = excluded.enabled,
      status = excluded.status,
      error = excluded.error,
      updated_at = excluded.updated_at
  `).run({
    id: entry.id,
    version: entry.manifest.version || null,
    enabled: entry.enabled ? 1 : 0,
    status: entry.status,
    error: entry.error,
    now,
  });
}

/**
 * Registers a plugin manifest (contract C1). Shape/reserved-id/duplicate/
 * apiVersion problems throw synchronously — the caller decides whether that's
 * fatal. Once shape is valid, lifecycle calls (migrations, createRouter,
 * createPoller) are never allowed to crash the process: any throw there is
 * caught and recorded as status='error' on the plugin row instead.
 */
function registerPlugin(manifest) {
  validateManifest(manifest);

  const entry = {
    id: manifest.id,
    manifest,
    router: null,
    poller: null,
    status: 'active',
    error: null,
    enabled: true,
  };
  plugins.set(entry.id, entry);

  try {
    const db = coreApiRef && coreApiRef.db;
    if (db && Array.isArray(manifest.migrations) && manifest.migrations.length) {
      runMigrations(db, entry.id, manifest.migrations);
    }
    entry.router = manifest.createRouter(coreApiRef);
    if (typeof manifest.createPoller === 'function') {
      entry.poller = manifest.createPoller(coreApiRef);
    }
    entry.status = 'active';
    entry.error = null;
  } catch (err) {
    entry.status = 'error';
    entry.error = err.message;
    const logger = coreApiRef && coreApiRef.logger;
    if (logger) logger.error(`[registry] plugin '${entry.id}' failed to load:`, err.message);
    else console.error(`[registry] plugin '${entry.id}' failed to load:`, err.message);
  }

  upsertPluginRow(entry);
  return getPlugin(entry.id);
}

function toPublic(entry) {
  return {
    id: entry.id,
    name: entry.manifest.name,
    status: entry.status,
    error: entry.error,
    enabled: entry.enabled,
    entitled: isEntitled(entry.id),
    version: entry.manifest.version || null,
    color: entry.manifest.color || null,
    derived: !!entry.manifest.derivedFrom,
    derivedFrom: entry.manifest.derivedFrom || null,
  };
}

/** Drop a registered plugin (tests and pack upgrades). */
function unregisterPlugin(id) {
  const entry = plugins.get(id);
  if (!entry) return false;
  const h = entry.poller;
  if (h && typeof h.stopAll === 'function') { try { h.stopAll(); } catch { /* best effort */ } }
  plugins.delete(id);
  return true;
}

function getPlugin(id) {
  const entry = plugins.get(id);
  return entry ? toPublic(entry) : undefined;
}

/** The raw poller handle returned by manifest.createPoller (may be null/undefined). */
function getPollerHandle(id) {
  const entry = plugins.get(id);
  return entry ? entry.poller : undefined;
}

function listPlugins() {
  return Array.from(plugins.values()).map(toPublic);
}

/** Registered entries with their manifest and router, for read-only consumers
 *  such as the permission catalog (which walks built-in routers for sections). */
function listEntries() {
  return Array.from(plugins.values()).map((e) => ({
    id: e.id, manifest: e.manifest, router: e.router, status: e.status,
  }));
}

/**
 * Server 360 contributions (2026-08-03): a plugin manifest may export
 *   server360(coreApi, { query, names, ips }) -> displaySection | null
 *   server360Suggest(coreApi, q) -> [names]
 * where displaySection is display-ready:
 *   { title, chip: { label, color }, groups: [{ facts: [{label, value, tone?}],
 *     lines: [string], link: { label, href } }] }
 * Only enabled, non-errored plugins are returned; provider errors must never
 * break the host route (callers wrap each call in try/catch).
 */
function getServer360Providers() {
  return Array.from(plugins.values())
    .filter((e) => liveEntry(e) && typeof e.manifest.server360 === 'function')
    .map((e) => ({
      id: e.id,
      name: e.manifest.name,
      run: (ctx) => e.manifest.server360(coreApiRef, ctx),
      suggest: typeof e.manifest.server360Suggest === 'function'
        ? (q) => e.manifest.server360Suggest(coreApiRef, q)
        : null,
    }));
}

/**
 * Topology Map contributors (2026-09-15). A plugin manifest may export
 *   topology(coreApi, { query, names, ips, anchorId }) -> { nodes, edges } | null
 * and routes/topology.js merges the result into the anchored graph, stamping
 * platform id + manifest color and gating on <id>:objects:view.
 */
function getTopologyProviders() {
  return Array.from(plugins.values())
    .filter((e) => liveEntry(e) && typeof e.manifest.topology === 'function')
    .map((e) => ({
      id: e.id,
      name: e.manifest.name,
      color: e.manifest.color || null,
      run: (ctx) => e.manifest.topology(coreApiRef, ctx),
    }));
}

/**
 * Ops Agent contributors (LogicMonitor round 3). A plugin manifest may export
 *   incidentEvidence(coreApi, { names, ips, siteKey }) -> { title, lines[] } | null
 *   siteOf(coreApi, { names, ips }) -> { siteKey, siteName } | null
 * The agent calls the first to add network evidence to a triage and the
 * second to group alerts by site. Callers guard against throws.
 */
function getIncidentEvidenceProviders() {
  return Array.from(plugins.values())
    .filter((e) => liveEntry(e) && typeof e.manifest.incidentEvidence === 'function')
    .map((e) => ({ id: e.id, name: e.manifest.name, run: (ctx) => e.manifest.incidentEvidence(coreApiRef, ctx) }));
}

function getSiteProviders() {
  return Array.from(plugins.values())
    .filter((e) => liveEntry(e) && typeof e.manifest.siteOf === 'function')
    .map((e) => ({ id: e.id, name: e.manifest.name, run: (ctx) => e.manifest.siteOf(coreApiRef, ctx) }));
}

/** Refused (returns false, no state change) when turning ON a plugin that
 *  isn't entitled (contract C9.5). Disabling is always allowed. */
function setEnabled(id, enabled) {
  const entry = plugins.get(id);
  if (!entry) return false;
  if (enabled && !isEntitled(id)) return false;
  entry.enabled = !!enabled;
  upsertPluginRow(entry);
  return true;
}

/** Platform profiles a pack or built-in hands the Operations Agent
 *  (manifest.agentProfile, partial allowed). */
function getAgentProfileProviders() {
  return Array.from(plugins.values())
    .filter((e) => liveEntry(e) && e.manifest && e.manifest.agentProfile && typeof e.manifest.agentProfile === 'object')
    .map((e) => ({ id: e.id, profile: e.manifest.agentProfile }));
}

/** Capabilities a pack hands the Operations Agent (manifest.agentCapabilities,
 *  an array of the same shape as backend/services/agentCapabilities/capabilities/*).
 *  The agent namespaces their ids by pack id. */
function getAgentCapabilityProviders() {
  return Array.from(plugins.values())
    .filter((e) => liveEntry(e) && Array.isArray(e.manifest.agentCapabilities) && e.manifest.agentCapabilities.length)
    .map((e) => ({ id: e.id, name: e.manifest.name, capabilities: e.manifest.agentCapabilities }));
}

/** Observers a pack hands the Operations Agent (manifest.agentObservers, an
 *  array of the same shape as services/agentObservations/observers/*).
 *  The engine namespaces their ids by pack id. */
function getAgentObserverProviders() {
  return Array.from(plugins.values())
    .filter((e) => liveEntry(e) && Array.isArray(e.manifest.agentObservers) && e.manifest.agentObservers.length)
    .map((e) => ({ id: e.id, name: e.manifest.name, observers: e.manifest.agentObservers }));
}

/** Derived platforms (manifest.derivedFrom): fed by a connector through
 *  core/feeds.js, no poller of their own. */
function isDerived(id) {
  const entry = plugins.get(id);
  return !!(entry && entry.manifest.derivedFrom);
}

/** Matched device count of a derived platform, from manifest.presence(coreApi).
 *  Memoized per database state; 0 on any throw so a broken feed hides the
 *  platform instead of breaking a request. */
function presenceOf(id) {
  const entry = plugins.get(id);
  if (!entry || !entry.manifest.derivedFrom || typeof entry.manifest.presence !== 'function') return 0;
  try {
    const db = (coreApiRef && coreApiRef.db) || require('../db/database');
    const n = memoByDbState(db, `presence:${id}`, () => Number(entry.manifest.presence(coreApiRef)) || 0);
    return n > 0 ? n : 0;
  } catch {
    return 0;
  }
}

/** True for every platform that is not derived, and for a derived platform
 *  with at least one matched device. */
function isPresent(id) {
  if (!isDerived(id)) return true;
  const from = plugins.get(id).manifest.derivedFrom;
  if (plugins.has(from) && !plugins.get(from).enabled) return false;
  return presenceOf(id) > 0;
}

/** Enabled, loaded without error and (derived) present. */
function liveEntry(e) {
  return e.enabled && e.status !== 'error' && isPresent(e.id);
}

/** The derived platform that claims a connector vendor key, or null. */
function derivedPlatformFor(vendorKey) {
  for (const e of plugins.values()) {
    if (!Array.isArray(e.manifest.vendorKeys) || !e.manifest.vendorKeys.includes(vendorKey)) continue;
    if (e.status === 'active' && e.enabled && isPresent(e.id)) return e.id;
  }
  return null;
}

/** Every derived platform with its state (settings and Platforms admin rows). */
function listDerived() {
  return Array.from(plugins.values())
    .filter((e) => e.manifest.derivedFrom)
    .map((e) => {
      const matched = presenceOf(e.id);
      return {
        id: e.id,
        label: e.manifest.name,
        derivedFrom: e.manifest.derivedFrom,
        vendorKeys: Array.isArray(e.manifest.vendorKeys) ? e.manifest.vendorKeys.slice() : [],
        enabled: e.enabled && e.status !== 'error',
        present: matched > 0,
        matchedDevices: matched,
      };
    });
}

/** Express middleware mounted at `/api/:pluginId`. */
function dispatch(req, res, next) {
  const entry = plugins.get(req.params.pluginId);
  if (!entry) return next();
  if (!entry.enabled) return res.status(404).json({ error: 'platform_disabled' });
  if (isDerived(entry.id) && !isPresent(entry.id)) {
    return res.status(404).json({ error: 'platform_absent', derivedFrom: entry.manifest.derivedFrom });
  }
  if (entry.status === 'error') return res.status(503).json({ error: 'platform_error' });
  return entry.router(req, res, next);
}

/** Test-only: clears in-memory registry state between test cases. */
function _reset() {
  plugins.clear();
  coreApiRef = null;
  initialized = false;
  isEntitledOverride = null;
}

module.exports = {
  PLUGIN_API_VERSION,
  RESERVED_IDS,
  isDerived,
  isPresent,
  presenceOf,
  derivedPlatformFor,
  listDerived,
  init,
  registerPlugin,
  getPlugin,
  getPollerHandle,
  listPlugins,
  listEntries,
  MANIFEST_CATEGORIES,
  getServer360Providers,
  getTopologyProviders,
  getIncidentEvidenceProviders,
  getSiteProviders,
  getAgentCapabilityProviders,
  getAgentObserverProviders,
  getAgentProfileProviders,
  unregisterPlugin,
  setEnabled,
  isEntitled,
  setIsEntitledFn,
  dispatch,
  _reset,
};
