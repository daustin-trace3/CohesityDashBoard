// Dedicated poller process — runs every scheduled data collector so their
// synchronous work (large JSON parses, big better-sqlite3 transactions) never
// stalls the API process's event loop. Shares the SQLite file with server.js
// via WAL; poller lifecycle state is shared through the poller_status table
// (services/pollerStatus.js). Started by pm2 as 'icc-poller' alongside
// 'icc-dashboard' (see pm2.config.js) and by `npm run dev`.
require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });

const logger = require('./utils/logger');
const registry = require('./core/registry');
// app.js announces the compiled-in Cohesity built-in for the web process.
// This process never loads app.js, and without the same announcement the
// Service Status sweep and the alert notifier, which both run here, gate
// Cohesity out: no status rows, no alert emails. The Cohesity poller is
// required just below, which is the same compiled-in condition.
registry.markBuiltin('cohesity');
const pluginBoot = require('./services/pluginBoot');
const { initPoller } = require('./services/poller');
const { initAlertNotifier } = require('./services/alertNotifier');
const { initServiceStatus } = require('./services/serviceStatus');
const { initLicensing } = require('./services/licensing');
const { initViews } = require('./services/views');
const { initGflags } = require('./services/gflags');
const { initDnsPrewarm } = require('./services/dnsResolve');
const { getPlatformSettings } = require('./services/settings');
const { isDemo } = require('./services/demoMode');
const pureManifest = require('./platforms/pure');
const netappManifest = require('./platforms/netapp');
const zertoManifest = require('./platforms/zerto');
const vcenterManifest = require('./platforms/vcenter');
const dellManifest = require('./platforms/dell');
const ariaManifest = require('./platforms/aria');
const ariaopsManifest = require('./platforms/ariaops');
const awsManifest = require('./platforms/aws');
const unifiManifest = require('./platforms/unifi');
const brocadeManifest = require('./platforms/brocade');
const bluecatManifest = require('./platforms/bluecat');

const tenantRegistry = require('./core/tenantRegistry');
const WORKER_TENANT = process.env.ICC_TENANT || null;

if (isDemo()) {
  // Demo instances never poll. Stay alive quietly so pm2 doesn't restart-loop.
  logger.info('[Poller process] Demo mode — pollers disabled, idling.');
  setInterval(() => {}, 60 * 60 * 1000);
} else if (!WORKER_TENANT && tenantRegistry.isStrict()) {
  // More than one tenant: this process only supervises, one worker process
  // per tenant (core/pollerSupervisor.js). A single-tenant install keeps
  // running its pollers in this process, exactly as before.
  const { createSupervisor } = require('./core/pollerSupervisor');
  const supervisor = createSupervisor().run();
  logger.info(`[Poller process] Supervising ${supervisor.workers().length} tenant worker(s).`);
  const shutdown = () => { supervisor.stopAll(); process.exit(0); };
  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
} else {
  // Same plugin boot sequence as server.js: swap staged upgrades before any
  // plugin backend is require()'d, then register built-ins + installed plugins.
  pluginBoot.runBootSwap();
  registry.init();
  // Everything this process does belongs to one tenant: the worker's tenant,
  // or the default tenant on a single-tenant install.
  const bootTenant = WORKER_TENANT || tenantRegistry.DEFAULT_TENANT;
  if (WORKER_TENANT && !tenantRegistry.getTenant(WORKER_TENANT)) {
    logger.error(`[Poller process] Unknown tenant ${WORKER_TENANT}; exiting.`);
    process.exit(1);
  }
  require('./core/tenantContext').enterTenantForBoot(bootTenant);
  if (WORKER_TENANT) logger.info(`[Poller process] Worker for tenant ${WORKER_TENANT}`);
  const { platformPureEnabled, platformNetappEnabled, platformZertoEnabled, platformVcenterEnabled, platformDellEnabled, platformAriaEnabled, platformAriaopsEnabled, platformAwsEnabled, platformUnifiEnabled, platformBrocadeEnabled, platformBluecatEnabled } = getPlatformSettings();
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
  registry.registerPlugin(awsManifest);
  registry.setEnabled('aws', platformAwsEnabled && registry.isEntitled('aws'));
  registry.registerPlugin(unifiManifest);
  registry.setEnabled('unifi', platformUnifiEnabled && registry.isEntitled('unifi'));
  registry.registerPlugin(brocadeManifest);
  registry.setEnabled('brocade', platformBrocadeEnabled && registry.isEntitled('brocade'));
  registry.registerPlugin(bluecatManifest);
  registry.setEnabled('bluecat', platformBluecatEnabled && registry.isEntitled('bluecat'));
  pluginBoot.scanAndRegisterInstalled();

  initPoller();
  initAlertNotifier();
  initServiceStatus();
  for (const entry of registry.listPlugins()) {
    if (!entry.enabled || entry.status !== 'active') continue;
    const handle = registry.getPollerHandle(entry.id);
    if (handle && typeof handle.init === 'function') handle.init();
  }
  initLicensing();
  initViews();
  initGflags();
  initDnsPrewarm();
  require('./core/tenantLifecycle').initRetention();
  logger.info('[Poller process] All pollers scheduled (Cohesity, plugins, licensing, views, gflags, alert notifier, DNS prewarm).');
}

process.on('unhandledRejection', (err) => {
  logger.error(`[Poller process] Unhandled rejection: ${err?.message || err}`);
});
