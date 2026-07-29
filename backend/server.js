require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });

const logger = require('./utils/logger');
const registry = require('./core/registry');
const pluginBoot = require('./services/pluginBoot');
const { createApp } = require('./app');
const { initPoller } = require('./services/poller');
const { initAlertNotifier } = require('./services/alertNotifier');
const { initLicensing } = require('./services/licensing');
const { initViews } = require('./services/views');
const { initGflags } = require('./services/gflags');
const { initDnsPrewarm } = require('./services/dnsResolve');
const { initLicense, getLicenseStatus } = require('./services/license');
const { getPlatformSettings } = require('./services/settings');
const { isDemo } = require('./services/demoMode');
const authService = require('./services/authService');
const pureManifest = require('./platforms/pure');
const netappManifest = require('./platforms/netapp');
const zertoManifest = require('./platforms/zerto');
const vcenterManifest = require('./platforms/vcenter');
const dellManifest = require('./platforms/dell');
const ariaManifest = require('./platforms/aria');
const ariaopsManifest = require('./platforms/ariaops');

// Auth boot work (contract C8.3): prune stale sessions and (re-)check the
// first-run claim token. authService already runs this once at module load
// (imported transitively via ./app -> routes/auth.js), but calling it again
// here is a cheap idempotent no-op that makes the boot sequence explicit.
authService.pruneExpired();

// Swap in any staged plugin upgrades / process pending removals BEFORE any
// plugin backend is require()'d (contract C9.3).
pluginBoot.runBootSwap();

registry.init();

// Register platform plugins, then apply their enable flags (app_settings
// remains the source of truth in Phase 1 — see contract C4). Entitlement
// (C9.5) gates enabling regardless of the stored flag.
const { platformPureEnabled, platformNetappEnabled, platformZertoEnabled, platformVcenterEnabled, platformDellEnabled, platformAriaEnabled, platformAriaopsEnabled } = getPlatformSettings();
registry.registerPlugin(pureManifest);
registry.setEnabled('pure', platformPureEnabled && registry.isEntitled('pure'));
registry.registerPlugin(netappManifest);
registry.setEnabled('netapp', platformNetappEnabled && registry.isEntitled('netapp'));
registry.registerPlugin(zertoManifest);
registry.setEnabled('zerto', platformZertoEnabled && registry.isEntitled('zerto'));
registry.registerPlugin(vcenterManifest);
registry.setEnabled('vcenter', platformVcenterEnabled && registry.isEntitled('vcenter'));
registry.registerPlugin(dellManifest);
registry.setEnabled('dell', platformDellEnabled && registry.isEntitled('dell'));
registry.registerPlugin(ariaManifest);
registry.setEnabled('aria', platformAriaEnabled && registry.isEntitled('aria'));
registry.registerPlugin(ariaopsManifest);
registry.setEnabled('ariaops', platformAriaopsEnabled && registry.isEntitled('ariaops'));

// Scan and register any installed (non-built-in) plugins left in plugins/
// after the boot swap above.
pluginBoot.scanAndRegisterInstalled();

const app = createApp();
const PORT = process.env.PORT || 3001;

// Fail fast on missing/invalid required env vars
try {
  const { getKey } = require('./services/encryption');
  getKey();
} catch (e) {
  logger.error('[Fatal] ENCRYPTION_KEY validation failed:', e.message);
}
if (!process.env.DASHBOARD_API_KEY) {
  logger.error('[Fatal] DASHBOARD_API_KEY is not set — all API requests will fail.');
}
if (!require('./services/settings').getHeliosApiKey()) {
  logger.warn('Helios API key is not configured (Settings → Credentials or HELIOS_API_KEY) — Helios discovery will be unavailable.');
}
if (getLicenseStatus().state === 'missing') {
  logger.error('[Fatal] LICENSE_KEY is not set — the dashboard is locked until a license is configured.');
}

// Only listen + start pollers when run directly (pm2/node server.js).
// Tests build the app via createApp() without side effects.
if (require.main === module) {
  app.listen(PORT, '0.0.0.0', () => {
    logger.info(`Backend listening on 0.0.0.0:${PORT} (local: http://localhost:${PORT})`);
    if (isDemo()) {
      logger.info('[Demo] Demo mode — pollers disabled');
    } else if (process.env.RUN_POLLERS_INLINE === 'true') {
      // Legacy single-process mode: pollers share the API event loop, so
      // heavy poll cycles can stall API responses. Prefer the separate
      // poller process (backend/pollerProcess.js).
      initPoller();
      initAlertNotifier();
      // Start pollers only for enabled, actively-registered plugins (Cohesity's
      // poller above is not registry-managed in Phase 1 and always starts).
      for (const entry of registry.listPlugins()) {
        if (!entry.enabled || entry.status !== 'active') continue;
        const handle = registry.getPollerHandle(entry.id);
        if (handle && typeof handle.init === 'function') handle.init();
      }
      initLicensing();
      initViews();
      initGflags();
      initDnsPrewarm();
    } else {
      logger.info('[Boot] Pollers run in the separate poller process (backend/pollerProcess.js, pm2: icc-poller). Set RUN_POLLERS_INLINE=true to run them in this process.');
    }
    initLicense();
  });
}

module.exports = app;
