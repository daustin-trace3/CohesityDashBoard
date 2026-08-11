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
  const logger = overrides.logger || require('../utils/logger');
  const settings = overrides.settings || require('../services/settings');
  const encryption = overrides.encryption || require('../services/encryption');
  const pollerStatus = overrides.pollerStatus || require('../services/pollerStatus');

  const api = {
    db,
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
    get anonymizer() {
      if (overrides.anonymizer) return overrides.anonymizer;
      return require('../services/anonymizer'); // { createAnonymizer, PROMPT_NOTE }
    },
  };

  return Object.freeze(api);
}

module.exports = { buildCoreApi };
