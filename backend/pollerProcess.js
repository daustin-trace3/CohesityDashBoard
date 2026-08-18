// Dedicated poller process — runs every scheduled data collector so their
// synchronous work (large JSON parses, big better-sqlite3 transactions) never
// stalls the API process's event loop. Shares the SQLite file with server.js
// via WAL; poller lifecycle state is shared through the poller_status table
// (services/pollerStatus.js). Started by pm2 as 'icc-poller' alongside
// 'icc-dashboard' (see pm2.config.js) and by `npm run dev`.
require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });

const logger = require('./utils/logger');
const registry = require('./core/registry');
const pluginBoot = require('./services/pluginBoot');
const { initPoller } = require('./services/poller');
const { initAlertNotifier } = require('./services/alertNotifier');
const { initLicensing } = require('./services/licensing');
const { initViews } = require('./services/views');
const { initGflags } = require('./services/gflags');
const { initDnsPrewarm } = require('./services/dnsResolve');
const { isDemo } = require('./services/demoMode');

if (isDemo()) {
  // Demo instances never poll. Stay alive quietly so pm2 doesn't restart-loop.
  logger.info('[Poller process] Demo mode — pollers disabled, idling.');
  setInterval(() => {}, 60 * 60 * 1000);
} else {
  // Same plugin boot sequence as server.js: swap staged upgrades before any
  // plugin backend is require()'d, then register built-ins + installed plugins.
  pluginBoot.runBootSwap();
  registry.init();
  pluginBoot.scanAndRegisterInstalled();

  initPoller();
  initAlertNotifier();
  for (const entry of registry.listPlugins()) {
    if (!entry.enabled || entry.status !== 'active') continue;
    const handle = registry.getPollerHandle(entry.id);
    if (handle && typeof handle.init === 'function') handle.init();
  }
  initLicensing();
  initViews();
  initGflags();
  initDnsPrewarm();
  logger.info('[Poller process] All pollers scheduled (Cohesity, plugins, licensing, views, gflags, alert notifier, DNS prewarm).');
}

process.on('unhandledRejection', (err) => {
  logger.error(`[Poller process] Unhandled rejection: ${err?.message || err}`);
});
