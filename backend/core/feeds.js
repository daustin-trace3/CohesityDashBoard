// Connector feeds (derived platforms, round 1).
//
// A CONNECTOR fetches and stores rows for one data source (LogicMonitor today,
// Splunk or Datadog later). It registers named FEEDS: read-only functions
// fn(db, params) that return rows already shaped for a consumer. A derived
// platform (manifest.derivedFrom) reads ONLY through feeds, never through the
// connector's tables, so a second connector plugs in without a second design.
//
//   registerConnector('logicmonitor', { name: 'LogicMonitor', register(feeds) {
//     feeds.registerFeed('logicmonitor', 'devices', (db, params) => rows);
//   } });
//   query('logicmonitor', 'devices', { vendorKey: 'f5' });
//
// query() resolves the current tenant database through db/database.js (which
// reads core/tenantContext), the same way every other core module does.
const ID_PATTERN = /^[a-z0-9-]+$/;

const connectors = new Map(); // id -> { id, name, feeds: Map(name -> fn) }

function reservedIds() {
  // Lazy: registry requires this module back for validation.
  try { return require('./registry').RESERVED_IDS; } catch { return new Set(); }
}

function feedError(code, message) {
  const err = new Error(message);
  err.code = code;
  return err;
}

function registerFeed(connectorId, feedName, fn) {
  const c = connectors.get(connectorId);
  if (!c) throw new Error(`connector '${connectorId}' is not registered`);
  if (typeof feedName !== 'string' || !feedName) throw new Error(`connector '${connectorId}': feed name is required`);
  if (typeof fn !== 'function') throw new Error(`connector '${connectorId}': feed '${feedName}' must be a function`);
  if (c.feeds.has(feedName)) throw new Error(`connector '${connectorId}': feed '${feedName}' is already registered`);
  c.feeds.set(feedName, fn);
}

function registerConnector(id, def) {
  if (typeof id !== 'string' || !ID_PATTERN.test(id)) {
    throw new Error(`invalid connector id: ${String(id)} (must match ${ID_PATTERN})`);
  }
  if (reservedIds().has(id)) throw new Error(`connector id '${id}' is reserved`);
  if (connectors.has(id)) throw new Error(`connector '${id}' is already registered`);
  if (!def || typeof def !== 'object') throw new Error(`connector '${id}': definition is required`);
  if (!def.name) throw new Error(`connector '${id}': name is required`);
  if (typeof def.register !== 'function') throw new Error(`connector '${id}': register(feeds) must be a function`);
  const c = { id, name: def.name, feeds: new Map() };
  connectors.set(id, c);
  try {
    def.register({
      registerFeed: (feedName, fn) => registerFeed(id, feedName, fn),
    });
  } catch (err) {
    connectors.delete(id);
    throw err;
  }
}

function listConnectors() {
  return Array.from(connectors.values()).map((c) => ({ id: c.id, name: c.name, feeds: Array.from(c.feeds.keys()) }));
}

function hasConnector(id) { return connectors.has(id); }

function hasFeed(connectorId, feedName) {
  const c = connectors.get(connectorId);
  return !!(c && c.feeds.has(feedName));
}

/** Runs a feed against the current tenant database. `opts.db` overrides the
 *  database (tests). Throws { code: 'FEED_UNKNOWN' } for an unknown feed. */
function query(connectorId, feedName, params, opts) {
  const c = connectors.get(connectorId);
  const fn = c && c.feeds.get(feedName);
  if (!fn) throw feedError('FEED_UNKNOWN', `unknown feed ${String(connectorId)}.${String(feedName)}`);
  const db = (opts && opts.db) || require('../db/database');
  return fn(db, params || {});
}

/** Test-only. */
function _reset() { connectors.clear(); }

module.exports = { registerConnector, registerFeed, listConnectors, hasConnector, hasFeed, query, _reset };
