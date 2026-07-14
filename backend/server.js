require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });

const express = require('express');
const path = require('path');
const fs = require('fs');
const cors = require('cors');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const logger = require('./utils/logger');

const clustersRouter = require('./routes/clusters');
const metricsRouter = require('./routes/metrics');
const alertsRouter = require('./routes/alerts');
const hardwareRouter = require('./routes/hardware');
const pollerRouter = require('./routes/poller');
const heliosRouter = require('./routes/helios');
const importRouter = require('./routes/import');
const analyticsRouter = require('./routes/analytics');
const replicationRouter = require('./routes/replication');
const insightsRouter = require('./routes/insights');
const governanceRouter = require('./routes/governance');
const dashboardRouter = require('./routes/dashboard');
const settingsRouter = require('./routes/settings');
const advisorRouter = require('./routes/advisor');
const aiAuditRouter = require('./routes/aiAudit');
const licensingRouter = require('./routes/licensing');
const licenseRouter = require('./routes/license');
const pureRouter = require('./routes/pure');
const pure1Router = require('./routes/pure1');
const netappRouter = require('./routes/netapp');
const dnsRouter = require('./routes/dns');
const requireApiKey = require('./middleware/auth');
const requireLicense = require('./middleware/license');
const errorHandler = require('./middleware/errorHandler');
const { initPoller } = require('./services/poller');
const { initPurePoller } = require('./services/purePoller');
const { initPure1Poller } = require('./services/pure1Poller');
const { initNetAppPoller } = require('./services/netappPoller');
const { initLicensing } = require('./services/licensing');
const { initLicense, getLicenseStatus } = require('./services/license');

const app = express();
const PORT = process.env.PORT || 3001;

// Security headers
// Non-HTTPS/public-IP testing: avoid forced HTTPS asset upgrades and COOP/OAC warnings; harden these behind HTTPS.
app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      upgradeInsecureRequests: null
    }
  },
  crossOriginOpenerPolicy: false,
  originAgentCluster: false
}));

// CORS — restrict to localhost origins only
app.use(cors({
  origin: [
    'http://localhost:5173',
    'http://localhost:3001',
    'http://localhost:3000',
    'http://127.0.0.1:5173',
    'http://127.0.0.1:3001',
    'http://127.0.0.1:3000',
    'http://172.17.16.113:5173',
    'http://172.17.16.113:3001',
    'http://172.17.16.113:3000'
  ],
  methods: ['GET', 'POST', 'PUT', 'DELETE'],
  allowedHeaders: ['Content-Type', 'Authorization', 'x-api-key']
}));

// Rate limiting: 1000 requests per minute per IP (dashboard loads many per-cluster requests)
const limiter = rateLimit({
  windowMs: 60 * 1000,
  max: 1000,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many requests, please try again later.' }
});
app.use('/api', limiter);

app.use(express.json({ limit: '1mb' }));

// API key authentication for all /api/ routes
app.use('/api', requireApiKey);

// Product license gate — blocks everything except /api/license/* when unlicensed
app.use('/api', requireLicense);

// Routes
app.use('/api/license', licenseRouter);
app.use('/api/clusters', clustersRouter);
app.use('/api/metrics', metricsRouter);
app.use('/api/alerts', alertsRouter);
app.use('/api/hardware', hardwareRouter);
app.use('/api/poller', pollerRouter);
app.use('/api/helios', heliosRouter);
app.use('/api/import', importRouter);
app.use('/api/analytics', analyticsRouter);
app.use('/api/replication', replicationRouter);
app.use('/api/insights', insightsRouter);
app.use('/api/governance', governanceRouter);
app.use('/api/dashboard', dashboardRouter);
app.use('/api/settings', settingsRouter);
app.use('/api/advisor', advisorRouter);
app.use('/api/ai-audit', aiAuditRouter);
app.use('/api/licensing', licensingRouter);
app.use('/api/pure', pureRouter);
app.use('/api/pure1', pure1Router);
app.use('/api/netapp', netappRouter);
app.use('/api/dns', dnsRouter);

// Health check — verifies DB connectivity
app.get('/health', (req, res) => {
  try {
    const db = require('./db/database');
    db.prepare('SELECT 1').get();
    res.json({ status: 'ok' });
  } catch (err) {
    res.status(503).json({ status: 'error', detail: 'database unavailable' });
  }
});

// Serve frontend static build in production
const distPath = path.join(__dirname, '..', 'frontend', 'dist');
if (fs.existsSync(distPath)) {
  app.use(express.static(distPath));
  app.get('*', (req, res) => {
    res.sendFile(path.join(distPath, 'index.html'));
  });
}

// Error handler must be last
app.use(errorHandler);

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

app.listen(PORT, '0.0.0.0', () => {
  logger.info(`Backend listening on 0.0.0.0:${PORT} (local: http://localhost:${PORT})`);
  initPoller();
  initPurePoller();
  initPure1Poller();
  initNetAppPoller();
  initLicensing();
  initLicense();
});

module.exports = app;
