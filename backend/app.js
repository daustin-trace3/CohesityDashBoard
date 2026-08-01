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
const viewsRouter = require('./routes/views');
const workloadsRouter = require('./routes/workloads');
const backupHistoryRouter = require('./routes/backupHistory');
const gflagsRouter = require('./routes/gflags');
const licenseRouter = require('./routes/license');
const pure1Router = require('./routes/pure1');
const dnsRouter = require('./routes/dns');
const searchRouter = require('./routes/search');
const server360Router = require('./routes/server360');
const opsRouter = require('./routes/ops');
const datasetsRouter = require('./routes/datasets');
const userDashboardsRouter = require('./routes/userDashboards');
require('./services/coreDatasets').registerCoreDatasets();
const authRouter = require('./routes/auth');
const usersRouter = require('./routes/users');
const pluginsRouter = require('./routes/plugins');
const registry = require('./core/registry');
const authenticate = require('./middleware/authenticate');
const csrf = require('./middleware/csrf');
const { requirePermission, platformPermission } = require('./middleware/requirePermission');
const requireLicense = require('./middleware/license');
const errorHandler = require('./middleware/errorHandler');
const deprecated = require('./middleware/deprecatedAlias');

/** cohesity:<name>:view|manage — same permission for a mount and its deprecated alias (contract C8.6). */
function cohesityPermission(name) {
  return (req) => `cohesity:${name}:${req.method === 'GET' ? 'view' : 'manage'}`;
}

/**
 * Builds the Express app. `licenseGate` is injectable so tests can exercise
 * the full middleware/route chain without a signed vendor license key; the
 * production entry (server.js) always uses the real gate.
 */
function createApp({ licenseGate = requireLicense } = {}) {
  const app = express();

  // Behind a reverse proxy, X-Forwarded-For must be trusted or
  // express-rate-limit throws ERR_ERL_UNEXPECTED_X_FORWARDED_FOR and keys
  // every client on the proxy's IP. Opt-in via TRUST_PROXY: a hop count
  // ("1"), "true" (= 1 hop), or an express value like "loopback"/CIDR.
  // Default off so direct-exposed deployments can't spoof client IPs.
  const trustProxy = (process.env.TRUST_PROXY || '').trim();
  if (trustProxy) {
    app.set('trust proxy', trustProxy === 'true' ? 1 : (Number(trustProxy) || trustProxy));
  }

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

  // Authentication (contract C8.5): session cookie, env API key, or a scoped
  // service-account key. Replaces the old blanket x-api-key check. /api/auth/*
  // and (mostly) /api/license/* are exempt — see middleware/authenticate.js.
  app.use('/api', authenticate);
  app.use('/api', csrf);

  // Product license gate — blocks everything except /api/license/* when unlicensed
  app.use('/api', licenseGate);

  // Routes
  app.use('/api/auth', authRouter);
  app.use('/api/license', licenseRouter);
  app.use(
    '/api/users',
    requirePermission((req) => `admin:users:${req.method === 'GET' ? 'view' : 'manage'}`),
    usersRouter
  );

  // Cohesity routes — mounted under /api/cohesity/* (WP4). New mounts first,
  // then deprecated aliases at the old unprefixed paths for back-compat with
  // existing customer automation; both must keep working. Each mount and its
  // alias require the SAME cohesity:<name>:view|manage permission (C8.6).
  app.use('/api/cohesity/clusters', requirePermission(cohesityPermission('clusters')), clustersRouter);
  app.use('/api/cohesity/metrics', requirePermission(cohesityPermission('metrics')), metricsRouter);
  app.use('/api/cohesity/alerts', requirePermission(cohesityPermission('alerts')), alertsRouter);
  app.use('/api/cohesity/hardware', requirePermission(cohesityPermission('hardware')), hardwareRouter);
  app.use('/api/cohesity/helios', requirePermission(cohesityPermission('helios')), heliosRouter);
  app.use('/api/cohesity/import', requirePermission(cohesityPermission('import')), importRouter);
  app.use('/api/cohesity/analytics', requirePermission(cohesityPermission('analytics')), analyticsRouter);
  app.use('/api/cohesity/replication', requirePermission(cohesityPermission('replication')), replicationRouter);
  app.use('/api/cohesity/insights', requirePermission(cohesityPermission('insights')), insightsRouter);
  app.use('/api/cohesity/governance', requirePermission(cohesityPermission('governance')), governanceRouter);
  app.use('/api/cohesity/dashboard', requirePermission(cohesityPermission('dashboard')), dashboardRouter);
  app.use('/api/cohesity/advisor', requirePermission(cohesityPermission('advisor')), advisorRouter);
  app.use('/api/cohesity/licensing', requirePermission(cohesityPermission('licensing')), licensingRouter);
  app.use('/api/cohesity/views', requirePermission(cohesityPermission('views')), viewsRouter);
  app.use('/api/cohesity/workloads', requirePermission(cohesityPermission('workloads')), workloadsRouter);
  // Same data domain as workloads (objects + runs), so it shares that permission.
  app.use('/api/cohesity/backup-history', requirePermission(cohesityPermission('workloads')), backupHistoryRouter);
  app.use('/api/cohesity/gflags', requirePermission(cohesityPermission('gflags')), gflagsRouter);

  app.use('/api/clusters', deprecated('/api/clusters', '/api/cohesity/clusters'), requirePermission(cohesityPermission('clusters')), clustersRouter);
  app.use('/api/metrics', deprecated('/api/metrics', '/api/cohesity/metrics'), requirePermission(cohesityPermission('metrics')), metricsRouter);
  app.use('/api/alerts', deprecated('/api/alerts', '/api/cohesity/alerts'), requirePermission(cohesityPermission('alerts')), alertsRouter);
  app.use('/api/hardware', deprecated('/api/hardware', '/api/cohesity/hardware'), requirePermission(cohesityPermission('hardware')), hardwareRouter);
  app.use('/api/helios', deprecated('/api/helios', '/api/cohesity/helios'), requirePermission(cohesityPermission('helios')), heliosRouter);
  app.use('/api/import', deprecated('/api/import', '/api/cohesity/import'), requirePermission(cohesityPermission('import')), importRouter);
  app.use('/api/analytics', deprecated('/api/analytics', '/api/cohesity/analytics'), requirePermission(cohesityPermission('analytics')), analyticsRouter);
  app.use('/api/replication', deprecated('/api/replication', '/api/cohesity/replication'), requirePermission(cohesityPermission('replication')), replicationRouter);
  app.use('/api/insights', deprecated('/api/insights', '/api/cohesity/insights'), requirePermission(cohesityPermission('insights')), insightsRouter);
  app.use('/api/governance', deprecated('/api/governance', '/api/cohesity/governance'), requirePermission(cohesityPermission('governance')), governanceRouter);
  app.use('/api/dashboard', deprecated('/api/dashboard', '/api/cohesity/dashboard'), requirePermission(cohesityPermission('dashboard')), dashboardRouter);
  app.use('/api/advisor', deprecated('/api/advisor', '/api/cohesity/advisor'), requirePermission(cohesityPermission('advisor')), advisorRouter);
  app.use('/api/licensing', deprecated('/api/licensing', '/api/cohesity/licensing'), requirePermission(cohesityPermission('licensing')), licensingRouter);

  // /api/poller/status is reachable to any authenticated caller; every other
  // poller endpoint (manual trigger) requires cohesity:poller:manage.
  app.use('/api/poller', (req, res, next) => {
    if (req.path === '/status') return next();
    return requirePermission(() => 'cohesity:poller:manage')(req, res, next);
  }, pollerRouter);

  app.use(
    '/api/settings',
    requirePermission((req) => `admin:settings:${req.method === 'GET' ? 'view' : 'manage'}`),
    settingsRouter
  );
  app.use('/api/ai-audit', requirePermission(() => 'admin:ai-audit:view'), aiAuditRouter);
  // Plugins router applies permissions per-route itself (admin:plugins:view|
  // manage for most routes, the plugin's own namespace for bundle.js, no
  // gate for frontend-manifest) — no blanket guard here.
  app.use('/api/plugins', pluginsRouter);
  // Seam: Pure1 cloud stays a static mount — the dispatcher only serves
  // /api/<pluginId>/*, and pure1 is a second mount alongside the 'pure'
  // plugin's own /api/pure/*. Folds in once its frontend paths migrate
  // under /pure in a later WP.
  app.use('/api/pure1', requirePermission(platformPermission('pure')), pure1Router);
  // /api/dns is reachable to any authenticated caller (no permission gate).
  app.use('/api/dns', dnsRouter);
  // Estate-wide entity search — per-category RBAC happens inside the handler.
  app.use('/api/search', searchRouter);
  // Server 360 correlated view — per-section RBAC inside the handler.
  app.use('/api/server360', server360Router);
  // Cross-platform ops summary (landing page) — read-only rollup, reachable
  // to any authenticated caller like /api/poller/status.
  app.use('/api/ops', opsRouter);
  // Dataset catalog (custom dashboards) — per-dataset RBAC inside the handler.
  // Must mount before the plugin dispatcher below.
  app.use('/api/datasets', datasetsRouter);
  // Saved custom dashboards — owner-scoped CRUD; widget data access is
  // enforced per-viewer by /api/datasets at render time.
  app.use('/api/user-dashboards', userDashboardsRouter);

  // Plugin dispatcher — resolves the registry at request time. Falls through
  // to the static routes above (which still win while the registry is empty)
  // via next() for any pluginId the registry doesn't know about.
  app.use(
    '/api/:pluginId',
    requirePermission(platformPermission((req) => req.params.pluginId)),
    registry.dispatch
  );

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
    // Build beacon: changes whenever a new build lands in dist (no restart
    // needed — stat per request). The SPA polls this and offers a reload.
    app.get('/api/app-version', (req, res) => {
      try {
        const st = fs.statSync(path.join(distPath, 'index.html'));
        res.setHeader('Cache-Control', 'no-store');
        res.json({ version: `${Math.round(st.mtimeMs)}-${st.size}` });
      } catch {
        res.json({ version: null });
      }
    });
    // index.html must revalidate every load or deploys strand browsers on old
    // hashed bundles; the hashed assets themselves are immutable.
    app.use(express.static(distPath, {
      setHeaders: (res, filePath) => {
        if (filePath.endsWith('.html')) {
          res.setHeader('Cache-Control', 'no-cache');
        } else if (filePath.includes(`${path.sep}assets${path.sep}`)) {
          res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
        }
      },
    }));
    app.get('*', (req, res) => {
      res.setHeader('Cache-Control', 'no-cache');
      res.sendFile(path.join(distPath, 'index.html'));
    });
  }

  // Error handler must be last
  app.use(errorHandler);

  return app;
}

module.exports = { createApp };
