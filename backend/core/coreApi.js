// Builds the frozen coreApi surface handed to every plugin's
// createRouter/createPoller (contract C2). Defaults to the app's real
// singletons; tests can pass overrides.
//
// `createPoller` is exposed lazily: backend/core/pollerFramework.js is being
// built in a parallel work package and may not exist yet when this module is
// first required. Accessing the getter (not just requiring coreApi.js) is
// what triggers the require, so WP1 does not depend on WP2 landing first.
function buildCoreApi(overrides = {}) {
  const db = overrides.db || require('../db/database');
  // Admin file connection (db/adminSplit.js): the plugins table and any other
  // admin table write goes here. A test that overrides db gets that same handle.
  const adminDb = overrides.adminDb || overrides.db || require('../db/adminDb');
  const logger = overrides.logger || require('../utils/logger');
  const settings = overrides.settings || require('../services/settings');
  const encryption = overrides.encryption || require('../services/encryption');
  const pollerStatus = overrides.pollerStatus || require('../services/pollerStatus');

  const api = {
    db,
    adminDb,
    logger,
    settings,
    encryption,
    pollerStatus,
    get createPoller() {
      if (overrides.createPoller) return overrides.createPoller;
      return require('./pollerFramework').createPoller;
    },
    get advisor() {
      if (overrides.advisor) return overrides.advisor;
      return require('../services/platformAdvisor'); // { createPlatformAdvisor, linReg, parseUtcMs, fmtBytes }
    },
    get feeds() {
      if (overrides.feeds) return overrides.feeds;
      const f = require('./feeds');
      return Object.freeze({ query: f.query, hasFeed: f.hasFeed, listConnectors: f.listConnectors });
    },
    get platforms() {
      // Derived-platform presence for packs (round 1, 2026-11-05 model): a pack
      // that owns LogicMonitor rows asks which derived platform claims a vendor
      // key. Read-only views over core/registry; a pack guards for an older host.
      if (overrides.platforms) return overrides.platforms;
      const r = require('./registry');
      return Object.freeze({
        isPresent: r.isPresent, isDerived: r.isDerived, presenceOf: r.presenceOf,
        derivedPlatformFor: r.derivedPlatformFor, listDerived: r.listDerived,
      });
    },
    get retention() {
      if (overrides.retention) return overrides.retention;
      const r = require('./retention');
      return Object.freeze({ BUCKETS: r.BUCKETS, days: r.days, resolve: r.resolve, prune: r.prune, agePredicate: r.agePredicate });
    },
    get anonymizer() {
      if (overrides.anonymizer) return overrides.anonymizer;
      return require('../services/anonymizer'); // { createAnonymizer, PROMPT_NOTE }
    },
  };

  return Object.freeze(api);
}

module.exports = { buildCoreApi };
