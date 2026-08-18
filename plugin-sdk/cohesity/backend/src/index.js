// Cohesity plugin manifest — WP-A (backend pack, data plane).
//
// Composition contract with WP-B (features plane) and WP-C/D (frontend):
//   - routerData.js (this pack) covers clusters/metrics/alerts/hardware/
//     helios/import/analytics/replication/dashboard/poller-trigger.
//     require('./routerFeatures') is attempted (try/catch) — if WP-B has
//     landed a routerFeatures.js exporting `{ ROUTES }` (SAME compile.js
//     route-table shape as routerData.js's ROUTES export), its entries are
//     appended to the combined table so one bare router serves both planes.
//     Until WP-B lands, only the data-plane routes are served (features
//     routes 404 — same as any unmounted path).
//   - hooks.js (opsSummary/collectAlerts/searchCategories/server360/
//     server360Suggest) is WP-B's; `let hooks = {}; try { hooks =
//     require('./hooks'); } catch {}` — spread into the manifest so this
//     pack stands alone (no hooks) until WP-B lands.
//   - poller.js's createCohesityPoller(coreApi) return value gets an
//     `initExtras` call from THIS file after `poller.init()` succeeds, IF
//     the manifest exports `initExtras(coreApi)` — WP-B's licensing/views/
//     gflags schedulers (the built-in's 3 OTHER independent schedulers,
//     never owned by the per-cluster cohesity poller) hook in there. Until
//     WP-B lands, initExtras is undefined and this is a no-op.
//   - No hardcoded `version` (installer falls back to the packaged
//     manifest.json — a literal here goes stale on upgrades and pins the
//     frontend bundle's `?v=` cache-buster forever).
const migrations = require('./migrations');
const { createDataRouter } = require('./routerData');
const { createCohesityPoller } = require('./poller');

let routerFeatures = null;
try {
  // eslint-disable-next-line global-require
  routerFeatures = require('./routerFeatures');
} catch {
  routerFeatures = null;
}

let hooks = {};
try {
  // eslint-disable-next-line global-require
  hooks = require('./hooks');
} catch {
  hooks = {};
}

const { compile } = require('./compile');

function createRouter(coreApi) {
  const dataRouter = createDataRouter(coreApi);
  if (!routerFeatures || !Array.isArray(routerFeatures.ROUTES)) {
    return dataRouter;
  }
  // Combine: data-plane routes first, then WP-B's feature routes, matched
  // against the SAME compile.js {regex, names} shape.
  const combined = routerFeatures.ROUTES.map((r) => ({
    ...r,
    handler: r.handler,
  }));
  return function cohesityRouter(req, res, next) {
    const path = req.path.length > 1 && req.path.endsWith('/') ? req.path.slice(0, -1) : req.path;
    dataRouter(req, res, (err) => {
      if (err) return next(err);
      for (const route of combined) {
        if (route.method !== req.method) continue;
        const m = route.regex.exec(path);
        if (!m) continue;
        const params = {};
        route.names.forEach((name, i) => { params[name] = decodeURIComponent(m[i + 1]); });
        req.params = params;
        Promise.resolve(route.handler(req, res, coreApi)).catch(next);
        return;
      }
      next();
    });
  };
}

function createPoller(coreApi) {
  const poller = createCohesityPoller(coreApi);
  const baseInit = poller.init;
  poller.init = (...args) => {
    const result = baseInit(...args);
    if (typeof module.exports.initExtras === 'function') {
      try {
        module.exports.initExtras(coreApi);
      } catch (err) {
        coreApi.logger.warn(`[cohesity] initExtras failed: ${err.message}`);
      }
    }
    return result;
  };
  return poller;
}

module.exports = {
  id: 'cohesity',
  name: 'Cohesity',
  apiVersion: 1,
  color: '#6CB33F',
  // No hardcoded version — see module header.
  migrations,
  createRouter,
  createPoller,
  statusTables: ['clusters'],
  navSections: [
    'overview', 'alerts', 'licensing',
    'data-protection', 'workloads', 'replication', 'views', 'governance',
    'backup-history', 'object-360', 'reporting', 'analytics', 'sources',
    'clusters', 'hardware', 'gflags',
    'privacy', 'settings',
  ],
  ...hooks,
};

// `compile` re-exported for WP-B's routerFeatures.js / hooks.js to build
// route tables against the identical {regex, names} shape this file expects.
module.exports.compile = compile;
