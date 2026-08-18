// Plugin registry + request dispatcher (contract C4).
const { buildCoreApi } = require('./coreApi');
const { runMigrations } = require('./migrations');
const datasetCatalog = require('../services/datasetCatalog');

const PLUGIN_API_VERSION = 1;

const RESERVED_IDS = new Set([
  'license', 'licensing', 'settings', 'poller', 'dns', 'import', 'insights',
  'advisor', 'ai-audit', 'analytics', 'governance', 'dashboard', 'helios',
  'alerts', 'metrics', 'hardware', 'clusters', 'replication', 'plugins',
  'auth', 'users', 'datasets', 'user-dashboards',
]);

const ID_PATTERN = /^[a-z0-9-]+$/;

const plugins = new Map(); // id -> { manifest, router, status, error, enabled }

let coreApiRef = null;
let initialized = false;
let isEntitledOverride = null;

/** Default entitlement check (contract C9.5): cohesity is always entitled;
 *  otherwise ask services/license.getEntitlements() (lazily required — that
 *  module is built in a parallel work package and may not exist yet). */
function defaultIsEntitled(id) {
  if (id === 'cohesity') return true;
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
}

function upsertPluginRow(entry) {
  const db = coreApiRef && coreApiRef.db;
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
    if (Array.isArray(manifest.datasets) && manifest.datasets.length) {
      datasetCatalog.registerDatasets(entry.id, manifest.datasets);
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
  if (entry.status === 'active' && entry.enabled) seedRoleGrants(entry.id);
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
  };
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
    .filter((e) => e.enabled && e.status !== 'error' && typeof e.manifest.server360 === 'function')
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
 * Phase 1 manifest-driven core hooks (2026-08-03): seeds Operator/Viewer
 * role_grants for a plugin id the first time it's enabled, mirroring the
 * per-platform INSERTs core migrations v4+ write (contract: idempotent via
 * INSERT OR IGNORE + the role_grants UNIQUE constraint, so re-enabling never
 * duplicates). Never throws — a DB hiccup here must not block enabling.
 */
function seedRoleGrants(id) {
  const db = coreApiRef && coreApiRef.db;
  if (!db) return;
  try {
    const now = new Date().toISOString();
    const getGroupId = db.prepare('SELECT id FROM groups WHERE name = ?');
    const insertGrant = db.prepare(
      'INSERT OR IGNORE INTO role_grants (subject_type, subject_id, permission, created_at) VALUES (?, ?, ?, ?)'
    );
    const grants = { Operator: `${id}:*:*`, Viewer: `${id}:*:view` };
    for (const [groupName, permission] of Object.entries(grants)) {
      const row = getGroupId.get(groupName);
      if (row) insertGrant.run('group', row.id, permission, now);
    }
  } catch (err) {
    const logger = coreApiRef && coreApiRef.logger;
    const msg = `[registry] failed to seed role grants for '${id}':`;
    if (logger) logger.error(msg, err.message);
    else console.error(msg, err.message);
  }
}

/** Refused (returns false, no state change) when turning ON a plugin that
 *  isn't entitled (contract C9.5). Disabling is always allowed. */
function setEnabled(id, enabled) {
  const entry = plugins.get(id);
  if (!entry) return false;
  if (enabled && !isEntitled(id)) return false;
  entry.enabled = !!enabled;
  upsertPluginRow(entry);
  if (entry.enabled) seedRoleGrants(id);
  return true;
}

/**
 * Phase 1 manifest-driven core hooks (2026-08-03): a plugin manifest may
 * optionally export opsSummary/collectAlerts/searchCategories/metricsHistory
 * so ANY plugin (installed or built-in) contributes to the ops landing page,
 * alert-email collector, global search, and poller-status metrics history —
 * surfaces that were previously hardcoded per-platform lists in core. Only
 * enabled, non-errored plugins contribute; callers still wrap each call in
 * try/catch so one bad plugin degrades a single surface, never the request.
 */
function getOpsSummaryProviders() {
  return Array.from(plugins.values())
    .filter((e) => e.enabled && e.status !== 'error' && typeof e.manifest.opsSummary === 'function')
    .map((e) => ({
      id: e.id,
      name: e.manifest.name,
      color: e.manifest.color || null,
      run: () => e.manifest.opsSummary(coreApiRef),
    }));
}

function getAlertCollectors() {
  return Array.from(plugins.values())
    .filter((e) => e.enabled && e.status !== 'error' && typeof e.manifest.collectAlerts === 'function')
    .map((e) => ({ id: e.id, collect: () => e.manifest.collectAlerts(coreApiRef) }));
}

/** Flat array of category objects (search.js's own shape), plugin manifests
 *  declaring `searchCategories` merged after the static built-in list. */
function getSearchCategoryContributors() {
  return Array.from(plugins.values())
    .filter((e) => e.enabled && e.status !== 'error' && Array.isArray(e.manifest.searchCategories))
    .flatMap((e) => e.manifest.searchCategories);
}

/** { [pluginId]: { arraysTable, metricsTable, arrayIdColumn } } for plugins
 *  declaring a well-formed `metricsHistory` static config. */
function getMetricsHistoryContributors() {
  const out = {};
  for (const e of plugins.values()) {
    if (!e.enabled || e.status === 'error') continue;
    const cfg = e.manifest.metricsHistory;
    if (cfg && cfg.arraysTable && cfg.metricsTable && cfg.arrayIdColumn) out[e.id] = cfg;
  }
  return out;
}

/** [{id, name}] for enabled plugins that declare collectAlerts — drives the
 *  notification-settings platform toggle list and its default-on gate. */
function getAlertPlatformPlugins() {
  return Array.from(plugins.values())
    .filter((e) => e.enabled && e.status !== 'error' && typeof e.manifest.collectAlerts === 'function')
    .map((e) => ({ id: e.id, name: e.manifest.name }));
}

/**
 * Dispatches directly to plugin `id`'s router (WP0: used by the legacy-alias
 * shim in app.js to forward to a registry-installed 'cohesity' pack once one
 * exists, without going through the `/api/:pluginId` param resolution).
 * Same fall-through/disabled/error semantics as dispatch() below.
 */
function dispatchTo(id, req, res, next) {
  const entry = plugins.get(id);
  if (!entry) return next();
  if (!entry.enabled) return res.status(404).json({ error: 'platform_disabled' });
  if (entry.status === 'error') return res.status(503).json({ error: 'platform_error' });
  return entry.router(req, res, next);
}

/** Express middleware mounted at `/api/:pluginId`. */
function dispatch(req, res, next) {
  return dispatchTo(req.params.pluginId, req, res, next);
}

/** Test-only: clears in-memory registry state between test cases. */
function _reset() {
  for (const id of plugins.keys()) datasetCatalog.unregisterNamespace(id);
  plugins.clear();
  coreApiRef = null;
  initialized = false;
  isEntitledOverride = null;
}

module.exports = {
  PLUGIN_API_VERSION,
  RESERVED_IDS,
  init,
  registerPlugin,
  getPlugin,
  getPollerHandle,
  listPlugins,
  getServer360Providers,
  getOpsSummaryProviders,
  getAlertCollectors,
  getSearchCategoryContributors,
  getMetricsHistoryContributors,
  getAlertPlatformPlugins,
  setEnabled,
  isEntitled,
  setIsEntitledFn,
  dispatch,
  dispatchTo,
  _reset,
};
