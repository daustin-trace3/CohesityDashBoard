const express = require('express');
const path = require('path');
const fs = require('fs');
const cors = require('cors');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');

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
const pure1Router = require('./routes/pure1');
const dnsRouter = require('./routes/dns');
const registry = require('./core/registry');
const requireApiKey = require('./middleware/auth');
const requireLicense = require('./middleware/license');
const errorHandler = require('./middleware/errorHandler');

/**
 * Builds the Express app. `licenseGate` is injectable so tests can exercise
 * the full middleware/route chain without a signed vendor license key; the
 * production entry (server.js) always uses the real gate.
 */
function createApp({ licenseGate = requireLicense } = {}) {
  const app = express();

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
  app.use('/api', licenseGate);

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
  // Seam: Pure1 cloud stays a static mount — the dispatcher only serves
  // /api/<pluginId>/*, and pure1 is a second mount alongside the 'pure'
  // plugin's own /api/pure/*. Folds in once its frontend paths migrate
  // under /pure in a later WP.
  app.use('/api/pure1', pure1Router);
  app.use('/api/dns', dnsRouter);

  // Plugin dispatcher — resolves the registry at request time. Falls through
  // to the static routes above (which still win while the registry is empty)
  // via next() for any pluginId the registry doesn't know about.
  app.use('/api/:pluginId', registry.dispatch);

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

  return app;
}

module.exports = { createApp };
