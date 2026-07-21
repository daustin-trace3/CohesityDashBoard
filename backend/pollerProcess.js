// Dedicated poller process — runs every scheduled data collector so their
// synchronous work (large JSON parses, big better-sqlite3 transactions) never
// stalls the API process's event loop. Shares the SQLite file with server.js
// via WAL; poller lifecycle state is shared through the poller_status table
// (services/pollerStatus.js). Started by pm2 as 'cohesity-poller' alongside
// 'cohesity-dashboard' (see pm2.config.js) and by `npm run dev`.
require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });

const logger = require('./utils/logger');
const { initPoller } = require('./services/poller');
const { initPurePoller } = require('./services/purePoller');
const { initPure1Poller } = require('./services/pure1Poller');
const { initNetAppPoller } = require('./services/netappPoller');
const { initZertoPoller } = require('./services/zertoPoller');
const { initLicensing } = require('./services/licensing');
const { initViews } = require('./services/views');

initPoller();
initPurePoller();
initPure1Poller();
initNetAppPoller();
initZertoPoller();
initLicensing();
initViews();
logger.info('[Poller process] All pollers scheduled (Cohesity, Pure, Pure1, NetApp, Zerto, licensing, views).');

process.on('unhandledRejection', (err) => {
  logger.error(`[Poller process] Unhandled rejection: ${err?.message || err}`);
});
