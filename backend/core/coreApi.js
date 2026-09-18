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
  const encryptionImpl = overrides.encryption || require('../services/encryption');
  // Plugins encrypt and decrypt their own secrets through the host. They are
  // never handed getKey(): the raw AES key would let any pack (or anything
  // that gets code into one) decrypt every credential offline, forever.
  const encryption = Object.freeze({
    encrypt: (...a) => encryptionImpl.encrypt(...a),
    decrypt: (...a) => encryptionImpl.decrypt(...a),
  });
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
    // Outbound-connection rules shared with the built-in platforms: the host
    // blocklist (loopback, link-local, metadata) and the "a saved secret only
    // travels to the saved address" guards. Packs must tolerate an older host
    // without this key: `const net = coreApi.net || null`.
    get net() {
      const hostGuard = require('../utils/hostGuard');
      const connectionGuard = require('../utils/connectionGuard');
      return Object.freeze({
        isBlockedHost: hostGuard.isBlockedHost,
        assertSafeHost: hostGuard.assertSafeHost,
        changedTargetFields: connectionGuard.changedTargetFields,
        assertSecretOnTargetChange: connectionGuard.assertSecretOnTargetChange,
        testTarget: connectionGuard.testTarget,
      });
    },
    get anonymizer() {
      if (overrides.anonymizer) return overrides.anonymizer;
      return require('../services/anonymizer'); // { createAnonymizer, PROMPT_NOTE }
    },
  };

  return Object.freeze(api);
}

module.exports = { buildCoreApi };
