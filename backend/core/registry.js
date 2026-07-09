// Plugin registry + request dispatcher (contract C4).
const { buildCoreApi } = require('./coreApi');
const { runMigrations } = require('./migrations');

const PLUGIN_API_VERSION = 1;

const RESERVED_IDS = new Set([
  'license', 'licensing', 'settings', 'poller', 'dns', 'import', 'insights',
  'advisor', 'ai-audit', 'analytics', 'governance', 'dashboard', 'helios',
  'alerts', 'metrics', 'hardware', 'clusters', 'replication', 'plugins',
  'auth', 'users',
]);

const ID_PATTERN = /^[a-z0-9-]+$/;

const plugins = new Map(); // id -> { manifest, router, status, error, enabled }

let coreApiRef = null;
let initialized = false;

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

function setEnabled(id, enabled) {
  const entry = plugins.get(id);
  if (!entry) return false;
  entry.enabled = !!enabled;
  upsertPluginRow(entry);
  return true;
}

/** Express middleware mounted at `/api/:pluginId`. */
function dispatch(req, res, next) {
  const entry = plugins.get(req.params.pluginId);
  if (!entry) return next();
  if (!entry.enabled) return res.status(404).json({ error: 'platform_disabled' });
  if (entry.status === 'error') return res.status(503).json({ error: 'platform_error' });
  return entry.router(req, res, next);
}

/** Test-only: clears in-memory registry state between test cases. */
function _reset() {
  plugins.clear();
  coreApiRef = null;
  initialized = false;
}

module.exports = {
  PLUGIN_API_VERSION,
  RESERVED_IDS,
  init,
  registerPlugin,
  getPlugin,
  getPollerHandle,
  listPlugins,
  setEnabled,
  dispatch,
  _reset,
};
