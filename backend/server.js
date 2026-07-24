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
const viewsRouter = require('./routes/views');
const workloadsRouter = require('./routes/workloads');
const gflagsRouter = require('./routes/gflags');
const licenseRouter = require('./routes/license');
const pureRouter = require('./routes/pure');
const pure1Router = require('./routes/pure1');
const netappRouter = require('./routes/netapp');
const zertoRouter = require('./routes/zerto');
const vcenterRouter = require('./routes/vcenter');
const dellRouter = require('./routes/dell');
const dnsRouter = require('./routes/dns');
const opsRouter = require('./routes/ops');
const authRouter = require('./routes/auth');
const usersRouter = require('./routes/users');
const authenticate = require('./middleware/authenticate');
const csrf = require('./middleware/csrf');
const { requirePermission, platformPermission } = require('./middleware/requirePermission');
const { seedRbac } = require('./services/rbacSeed');
const requireLicense = require('./middleware/license');
const errorHandler = require('./middleware/errorHandler');
const { initPoller } = require('./services/poller');
const { initPurePoller } = require('./services/purePoller');
const { initPure1Poller } = require('./services/pure1Poller');
const { initNetAppPoller } = require('./services/netappPoller');
const { initZertoPoller } = require('./services/zertoPoller');
const { initVcenterPoller } = require('./services/vcenterPoller');
const { initDellPoller } = require('./services/dellPoller');
const { initLicensing } = require('./services/licensing');
const { initViews } = require('./services/views');
const { initGflags } = require('./services/gflags');
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

// Session/api-key/anonymous identity resolution (ported from icc-phase1).
// With auth disabled (the default until someone enables it in Users & Access)
// every request gets an anonymous *:*:* identity — behavior matches the old
// blanket requireApiKey world for browsers, while x-api-key automation and
// scoped service accounts keep working either way.
app.use('/api', authenticate);
app.use('/api', csrf);

// Product license gate — blocks everything except /api/license/* when unlicensed
app.use('/api', requireLicense);

// Fixed-section permission: Fable-dev's flat /api/<section> mounts map to
// `cohesity:<section>` (or admin:settings). GET = view, everything else = manage.
const perm = (ns, section) => requirePermission(
  (req) => `${ns}:${section}:${req.method === 'GET' ? 'view' : 'manage'}`
);

// Routes
app.use('/api/auth', authRouter);
app.use('/api/users', perm('admin', 'users'), usersRouter);
app.use('/api/license', licenseRouter);
app.use('/api/clusters', perm('cohesity', 'clusters'), clustersRouter);
app.use('/api/metrics', perm('cohesity', 'metrics'), metricsRouter);
app.use('/api/alerts', perm('cohesity', 'alerts'), alertsRouter);
app.use('/api/hardware', perm('cohesity', 'hardware'), hardwareRouter);
app.use('/api/poller', pollerRouter);
app.use('/api/helios', perm('cohesity', 'helios'), heliosRouter);
app.use('/api/import', perm('cohesity', 'import'), importRouter);
app.use('/api/analytics', perm('cohesity', 'analytics'), analyticsRouter);
app.use('/api/replication', perm('cohesity', 'replication'), replicationRouter);
app.use('/api/insights', perm('cohesity', 'insights'), insightsRouter);
app.use('/api/governance', perm('cohesity', 'governance'), governanceRouter);
app.use('/api/dashboard', perm('cohesity', 'dashboard'), dashboardRouter);
app.use('/api/settings', perm('admin', 'settings'), settingsRouter);
app.use('/api/advisor', perm('cohesity', 'advisor'), advisorRouter);
app.use('/api/ai-audit', perm('cohesity', 'ai-audit'), aiAuditRouter);
app.use('/api/licensing', perm('cohesity', 'licensing'), licensingRouter);
app.use('/api/views', perm('cohesity', 'views'), viewsRouter);
app.use('/api/workloads', perm('cohesity', 'workloads'), workloadsRouter);
app.use('/api/gflags', perm('cohesity', 'gflags'), gflagsRouter);
app.use('/api/pure', requirePermission(platformPermission('pure')), pureRouter);
app.use('/api/pure1', requirePermission(platformPermission('pure')), pure1Router);
app.use('/api/netapp', requirePermission(platformPermission('netapp')), netappRouter);
app.use('/api/zerto', requirePermission(platformPermission('zerto')), zertoRouter);
app.use('/api/vcenter', requirePermission(platformPermission('vcenter')), vcenterRouter);
app.use('/api/dell', requirePermission(platformPermission('dell')), dellRouter);
app.use('/api/dns', dnsRouter);
app.use('/api/ops', opsRouter);

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

// System groups + grants must exist before any grant editing; idempotent.
seedRbac();

app.listen(PORT, '0.0.0.0', () => {
  logger.info(`Backend listening on 0.0.0.0:${PORT} (local: http://localhost:${PORT})`);
  if (process.env.RUN_POLLERS_INLINE === 'true') {
    // Legacy single-process mode: pollers share the API event loop, so
    // heavy poll cycles can stall API responses. Prefer the separate
    // poller process (backend/pollerProcess.js).
    initPoller();
    initPurePoller();
    initPure1Poller();
    initNetAppPoller();
    initZertoPoller();
    initVcenterPoller();
    initDellPoller();
    initLicensing();
    initViews();
    initGflags();
  } else {
    logger.info('[Boot] Pollers run in the separate poller process (backend/pollerProcess.js, pm2: cohesity-poller). Set RUN_POLLERS_INLINE=true to run them in this process.');
  }
  initLicense();
});

module.exports = app;
