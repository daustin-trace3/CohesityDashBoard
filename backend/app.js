const express = require('express');
const path = require('path');
const fs = require('fs');
const cors = require('cors');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');

// WP0.1: the static cohesity router requires below only exist while the
// built-in is compiled in — announce that so routes can distinguish
// "built-in present" from "stripped, plugin not yet installed" (the
// phantom-cohesity rehearsal gap). The WP-E strip removes this line with
// the requires.
require('./core/registry').markBuiltin('cohesity');
const clustersRouter = require('./routes/clusters');
const metricsRouter = require('./routes/metrics');
const alertsRouter = require('./routes/alerts');
const hardwareRouter = require('./routes/hardware');
const pollerStatusRouter = require('./routes/pollerStatus');
const pollerTriggerRouter = require('./routes/pollerTrigger');
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
const cohesityObject360Router = require('./routes/cohesityObject360');
const gflagsRouter = require('./routes/gflags');
const licenseRouter = require('./routes/license');
const releaseNotesRouter = require('./routes/releaseNotes');
const pure1Router = require('./routes/pure1');
const dnsRouter = require('./routes/dns');
const searchRouter = require('./routes/search');
const server360Router = require('./routes/server360');
const topologyRouter = require('./routes/topology');
const opsRouter = require('./routes/ops');
const serviceStatusRouter = require('./routes/serviceStatus');
const appServicesRouter = require('./routes/appServices');
const datasetsRouter = require('./routes/datasets');
const userDashboardsRouter = require('./routes/userDashboards');
const aiConfigRouter = require('./routes/aiConfig');
require('./services/coreDatasets').registerCoreDatasets();
const { getSetting } = require('./services/settings');
const authRouter = require('./routes/auth');
const usersRouter = require('./routes/users');
const directoryRouter = require('./routes/directory');
const pluginsRouter = require('./routes/plugins');
const registry = require('./core/registry');
const authenticate = require('./middleware/authenticate');
const csrf = require('./middleware/csrf');
const { requirePermission, platformPermission } = require('./middleware/requirePermission');
const requireLicense = require('./middleware/license');
const errorHandler = require('./middleware/errorHandler');
const deprecated = require('./middleware/deprecatedAlias');
const demoPollGuard = require('./middleware/demoPollGuard');

/** cohesity:<name>:view|manage — same permission for a mount and its deprecated alias (contract C8.6). */
function cohesityPermission(name) {
  return (req) => `cohesity:${name}:${req.method === 'GET' ? 'view' : 'manage'}`;
}

/**
 * WP0: table-driven legacy alias mounts (de-risking host prep for the
 * cohesity .iccplugin conversion). Each entry's forwarder prefers the
 * statically-required router (today, while cohesity is a compiled-in
 * platform) and falls back to registry.dispatchTo('cohesity', ...) — with
 * req.url rewritten to '/<name>' + req.url, matching the sub-path shape a
 * combined cohesity plugin router would expect — only once that static
 * router is removed. Zero behavior change today: the pack conversion later
 * only has to delete the static require + the `router` field below.
 */
const LEGACY_ALIASES = [
  { name: 'clusters', oldPath: '/api/clusters', newPath: '/api/cohesity/clusters', router: clustersRouter },
  { name: 'metrics', oldPath: '/api/metrics', newPath: '/api/cohesity/metrics', router: metricsRouter },
  { name: 'alerts', oldPath: '/api/alerts', newPath: '/api/cohesity/alerts', router: alertsRouter },
  { name: 'hardware', oldPath: '/api/hardware', newPath: '/api/cohesity/hardware', router: hardwareRouter },
  { name: 'helios', oldPath: '/api/helios', newPath: '/api/cohesity/helios', router: heliosRouter },
  { name: 'import', oldPath: '/api/import', newPath: '/api/cohesity/import', router: importRouter },
  { name: 'analytics', oldPath: '/api/analytics', newPath: '/api/cohesity/analytics', router: analyticsRouter },
  { name: 'replication', oldPath: '/api/replication', newPath: '/api/cohesity/replication', router: replicationRouter },
  { name: 'insights', oldPath: '/api/insights', newPath: '/api/cohesity/insights', router: insightsRouter },
  { name: 'governance', oldPath: '/api/governance', newPath: '/api/cohesity/governance', router: governanceRouter },
  { name: 'dashboard', oldPath: '/api/dashboard', newPath: '/api/cohesity/dashboard', router: dashboardRouter },
  { name: 'advisor', oldPath: '/api/advisor', newPath: '/api/cohesity/advisor', router: advisorRouter },
  { name: 'licensing', oldPath: '/api/licensing', newPath: '/api/cohesity/licensing', router: licensingRouter },
];

/** Same shim mechanism as LEGACY_ALIASES, for the /api/poller trigger
 *  endpoints (cohesity-owned; not dual-mounted under /api/cohesity today). */
function aliasForwarder(name, staticRouter) {
  return (req, res, next) => {
    if (staticRouter) return staticRouter(req, res, next);
    req.url = `/${name}${req.url}`;
    return registry.dispatchTo('cohesity', req, res, next);
  };
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

  // Security headers. Scripts, connections and images are same-origin only.
  // The one external dependency is Google Fonts (Inter, JetBrains Mono,
  // Archivo), so style-src and font-src name those two hosts instead of the
  // blanket "https:" helmet ships with. style-src keeps 'unsafe-inline'
  // because React inline styles and the chart library need it.
  // HTTPS_ONLY=1 (set it wherever ICC is only ever reached over TLS, for
  // example behind a reverse proxy or tunnel) adds upgrade-insecure-requests,
  // COOP and origin-agent-cluster; on plain http those three only produce
  // console warnings, which is why they are opt-in.
  const httpsOnly = process.env.HTTPS_ONLY === '1';
  app.use(helmet({
    contentSecurityPolicy: {
      directives: {
        defaultSrc: ["'self'"],
        scriptSrc: ["'self'"],
        styleSrc: ["'self'", "'unsafe-inline'", 'https://fonts.googleapis.com'],
        fontSrc: ["'self'", 'data:', 'https://fonts.gstatic.com'],
        connectSrc: ["'self'"],
        // blob: for object-URL images (UniFi Protect camera snapshots are
        // fetched as authenticated blobs and rendered via URL.createObjectURL)
        imgSrc: ["'self'", 'data:', 'blob:'],
        workerSrc: ["'self'", 'blob:'],
        manifestSrc: ["'self'"],
        frameAncestors: ["'self'"],
        upgradeInsecureRequests: httpsOnly ? [] : null,
      }
    },
    crossOriginOpenerPolicy: httpsOnly ? { policy: 'same-origin' } : false,
    originAgentCluster: httpsOnly,
  }));
  // Helmet does not set Permissions-Policy; scanners flag its absence. ICC
  // uses none of these browser features.
  app.use((req, res, next) => {
    res.setHeader('Permissions-Policy', 'accelerometer=(), camera=(), display-capture=(), geolocation=(), gyroscope=(), magnetometer=(), microphone=(), midi=(), payment=(), usb=(), browsing-topics=()');
    next();
  });

  // CORS: the UI is served by this same process, so cross-origin access is
  // only for a developer running the Vite dev server. Localhost by default;
  // CORS_ORIGINS (comma separated) adds more. A LAN address used to be
  // hardcoded here.
  const corsOrigins = [
    'http://localhost:5173', 'http://localhost:3001', 'http://localhost:3000',
    'http://127.0.0.1:5173', 'http://127.0.0.1:3001', 'http://127.0.0.1:3000',
  ].concat(String(process.env.CORS_ORIGINS || '').split(',').map((s) => s.trim()).filter(Boolean));
  app.use(cors({
    origin: corsOrigins,
    methods: ['GET', 'POST', 'PUT', 'DELETE'],
    allowedHeaders: ['Content-Type', 'Authorization', 'x-api-key', 'x-csrf-token']
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

  // Demo mode: block manual poll-trigger endpoints (refresh/poll/trigger)
  // before any route — static Cohesity mounts, deprecated aliases, and the
  // plugin dispatcher — can run. See middleware/demoPollGuard.js.
  app.use('/api', demoPollGuard);

  // Routes
  app.use('/api/auth', authRouter);
  app.use('/api/license', licenseRouter);
  app.use(
    '/api/users',
    requirePermission((req) => `admin:users:${req.method === 'GET' ? 'view' : 'manage'}`),
    usersRouter
  );
  // Active Directory admin API: same gate as /api/users (linking a group is an access change).
  app.use(
    '/api/directory',
    requirePermission((req) => `admin:users:${req.method === 'GET' ? 'view' : 'manage'}`),
    directoryRouter
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
  // Same data domain as workloads/backup-history (objects + runs).
  app.use('/api/cohesity/object-360', requirePermission(cohesityPermission('workloads')), cohesityObject360Router);
  app.use('/api/cohesity/gflags', requirePermission(cohesityPermission('gflags')), gflagsRouter);

  for (const alias of LEGACY_ALIASES) {
    app.use(
      alias.oldPath,
      deprecated(alias.oldPath, alias.newPath),
      requirePermission(cohesityPermission(alias.name)),
      aliasForwarder(alias.name, alias.router)
    );
  }

  // /api/poller/status is reachable to any authenticated caller; every other
  // poller endpoint (manual trigger) requires cohesity:poller:manage. Split
  // into two routers (WP0, pure reorganization): status is core-owned,
  // trigger endpoints are cohesity-owned and go through the same alias-shim
  // forwarder as LEGACY_ALIASES above.
  app.use('/api/poller', pollerStatusRouter);
  app.use(
    '/api/poller',
    requirePermission(() => 'cohesity:poller:manage'),
    aliasForwarder('poller', pollerTriggerRouter)
  );

  // Mounted BEFORE the /api/settings admin gate below. It used to sit after it,
  // so the gate answered 403 first and non-admin users never saw the AI pages
  // they were entitled to (fail closed, but not what the comment promised).
  app.use('/api/settings/ai-config', aiConfigRouter);
  app.use(
    '/api/settings',
    requirePermission((req) => `admin:settings:${req.method === 'GET' ? 'view' : 'manage'}`),
    settingsRouter
  );
  // WP0 core seam: same JSON shape as GET /api/cohesity/insights/ai/config.
  // Reachable to any authenticated caller (like /api/dns) — the old cohesity
  // path only needed cohesity:insights:view, and this probe gates AI nav
  // items for EVERY user, so an admin-only permission here would hide AI
  // from non-admin viewers.
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
  // /api/release-notes is reachable to any authenticated caller (no permission gate).
  app.use('/api/release-notes', releaseNotesRouter);
  // Estate-wide entity search — per-category RBAC happens inside the handler.
  app.use('/api/search', searchRouter);
  // Server 360 correlated view — per-section RBAC inside the handler.
  app.use('/api/server360', server360Router);
  // Cross-platform Topology Map — per-section RBAC inside the handler.
  app.use('/api/topology', topologyRouter);
  // Cross-platform ops summary (landing page) — read-only rollup, reachable
  // to any authenticated caller like /api/poller/status.
  app.use('/api/ops', opsRouter);
  // Service Status page — read-only board + per-event AI analysis, reachable
  // to any authenticated caller like /api/ops.
  app.use('/api/service-status', serviceStatusRouter);
  app.use('/api/app-services', appServicesRouter);
  // Custom dashboards ship dark: both mounts 404 until the feature is
  // switched on in Global Settings → Platforms (feature_custom_dashboards_enabled).
  const requireCustomDashboards = (req, res, next) => {
    if (getSetting('feature_custom_dashboards_enabled') !== '1') {
      return res.status(404).json({ error: 'Custom dashboards are not enabled.' });
    }
    next();
  };
  // Dataset catalog (custom dashboards) — per-dataset RBAC inside the handler.
  // Must mount before the plugin dispatcher below.
  app.use('/api/datasets', requireCustomDashboards, datasetsRouter);
  // Saved custom dashboards — owner-scoped CRUD; widget data access is
  // enforced per-viewer by /api/datasets at render time.
  app.use('/api/user-dashboards', requireCustomDashboards, userDashboardsRouter);

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
    // SPA fallback for page routes only. Answering 200 with the app shell for
    // /.env, /.git/config, /backup.zip or /wp-login.php is harmless, but every
    // scanner reports it as an exposed file because the status is 200. Unknown
    // API paths, dotfiles and anything that looks like a file get a real 404.
    app.get('*', (req, res) => {
      const p = req.path;
      if (p === '/api' || p.startsWith('/api/')) return res.status(404).json({ error: 'not found' });
      if (/(^|\/)\.[^/]/.test(p) || /\.[A-Za-z0-9]{1,8}$/.test(p)) {
        return res.status(404).type('text/plain').send('Not found');
      }
      res.setHeader('Cache-Control', 'no-cache');
      res.sendFile(path.join(distPath, 'index.html'));
    });
  }

  // Error handler must be last
  app.use(errorHandler);

  return app;
}

module.exports = { createApp };
