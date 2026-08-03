const { isDemo } = require('../services/demoMode');

// Matches manual poll-trigger endpoints by path suffix, not by a hardcoded
// platform list — covers both built-in routers and future plugins:
//   POST .../refresh                (aria, ariaops, aws, dell, proxmox,
//                                     vcenter, gflags, licensing, views,
//                                     workloads, zerto, netbackup, ...)
//   POST .../poll                   (netapp, pure)
//   POST .../trigger, .../trigger/:id   (poller)
const REFRESH_OR_POLL_RE = /\/(refresh|poll)$/i;
const TRIGGER_RE = /\/trigger(\/[^/]+)?$/i;

/**
 * Demo mode (DASHBOARD_DEMO=1) serves static seeded fixtures. Manual
 * "Refresh"-style endpoints call pollers directly and are NOT covered by the
 * background-poller isDemo() guards (server.js, pollerProcess.js), so in
 * demo mode they would poll fictional demo hosts, fail, and wipe seeded
 * inventory via delete-then-insert. Short-circuit them here, before any
 * route can run, so this works for installed plugins too.
 */
function demoPollGuard(req, res, next) {
  if (req.method === 'POST' && isDemo() && (REFRESH_OR_POLL_RE.test(req.path) || TRIGGER_RE.test(req.path))) {
    return res.json({ triggered: false, demo: true, message: 'Demo mode — data is static; live polling is disabled.' });
  }
  next();
}

module.exports = demoPollGuard;
