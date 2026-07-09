require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });

const logger = require('./utils/logger');
const { createApp } = require('./app');
const { initPoller } = require('./services/poller');
const { initPurePoller } = require('./services/purePoller');
const { initNetAppPoller } = require('./services/netappPoller');
const { initLicensing } = require('./services/licensing');
const { initLicense, getLicenseStatus } = require('./services/license');

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
    initPoller();
    initPurePoller();
    initNetAppPoller();
    initLicensing();
    initLicense();
  });
}

module.exports = app;
