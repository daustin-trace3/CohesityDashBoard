const { isDemo } = require('../services/demoMode');

// Matches manual poll-trigger endpoints by path suffix, not by a hardcoded
// platform list — covers both built-in routers and future plugins:
//   POST .../refresh                (aria, ariaops, aws, dell, proxmox,
//                                     vcenter, gflags, licensing, views,
//                                     workloads, zerto, ...)
//   POST .../poll                   (netapp, pure)
//   POST .../trigger, .../trigger/:id   (poller)
const REFRESH_OR_POLL_RE = /\/(refresh|poll)$/i;
const TRIGGER_RE = /\/trigger(\/[^/]+)?$/i;

// A public demo signs visitors in with a documented admin account. Anything
// that makes the server open a connection to an address the visitor chose
// would turn the demo host into a way into the network it sits on, so in demo
// mode none of these run:
//   POST .../test, .../fos-test     connection tests (every platform, SMTP, AD)
//   GET  .../probe[/...]            live vendor calls with stored credentials
//   POST /dns/resolve               reverse lookups against the local resolver
//   any write under /directory      AD servers, bind account, imports
const CONNECTION_TEST_RE = /\/(fos-)?test$/i;
const PROBE_RE = /\/probe(\/|$)/i;

const DEMO_USERNAME = 'demo';

function demoOutboundBlocked(req) {
  if (req.method === 'POST' && CONNECTION_TEST_RE.test(req.path)) return true;
  if (req.method === 'GET' && PROBE_RE.test(req.path)) return true;
  if (req.method === 'POST' && /^\/dns\/resolve$/i.test(req.path)) return true;
  if (req.method !== 'GET' && /^\/directory(\/|$)/i.test(req.path)) return true;
  return false;
}

/** The shared demo sign-in must keep working for the next visitor: nobody
 *  changes its password, deactivates or deletes it, and sign-in stays on. */
function demoAccountProtected(req) {
  if (req.method === 'POST' && /^\/auth\/disable$/i.test(req.path)) return true;
  const m = /^\/users\/(\d+)$/.exec(req.path);
  if (!m || (req.method !== 'PUT' && req.method !== 'DELETE')) return false;
  try {
    const db = require('../db/database');
    const row = db.prepare('SELECT username FROM users WHERE id = ?').get(Number(m[1]));
    if (!row || String(row.username).toLowerCase() !== DEMO_USERNAME) return false;
  } catch {
    return false;
  }
  if (req.method === 'DELETE') return true;
  const b = req.body || {};
  return !!b.password || b.isActive === false || b.groupIds !== undefined;
}

/**
 * Demo mode (DASHBOARD_DEMO=1) serves static seeded fixtures. Manual
 * "Refresh"-style endpoints call pollers directly and are NOT covered by the
 * background-poller isDemo() guards (server.js, pollerProcess.js), so in
 * demo mode they would poll fictional demo hosts, fail, and wipe seeded
 * inventory via delete-then-insert. Short-circuit them here, before any
 * route can run, so this works for installed plugins too.
 */
function demoPollGuard(req, res, next) {
  if (!isDemo()) return next();
  if (req.method === 'POST' && (REFRESH_OR_POLL_RE.test(req.path) || TRIGGER_RE.test(req.path))) {
    return res.json({ triggered: false, demo: true, message: 'Demo mode — data is static; live polling is disabled.' });
  }
  if (demoOutboundBlocked(req)) {
    return res.status(403).json({ ok: false, demo: true, error: 'Demo mode: this instance does not open connections to other systems.', message: 'Demo mode: this instance does not open connections to other systems.' });
  }
  if (demoAccountProtected(req)) {
    return res.status(403).json({ demo: true, error: 'Demo mode: the shared demo sign-in cannot be changed.' });
  }
  next();
}

module.exports = demoPollGuard;
module.exports.demoOutboundBlocked = demoOutboundBlocked;
module.exports.demoAccountProtected = demoAccountProtected;
