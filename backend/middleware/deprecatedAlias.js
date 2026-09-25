const logger = require('../utils/logger');

const warned = new Set();
const MAX_KEYS = 200;

/** Everything that identifies who called an old path. For a browser XHR the
 *  referer names the page that made the call, which is usually enough to point
 *  at a plugin page or an old cached bundle; for a script it is the user agent
 *  and the address. */
function callerOf(req) {
  const bits = [`${req.method} ${req.originalUrl || req.url}`];
  const ip = req.ip || req.connection?.remoteAddress;
  if (ip) bits.push(`from ${ip}`);
  const referer = req.get ? req.get('referer') : null;
  if (referer) bits.push(`page ${String(referer).slice(0, 160)}`);
  const ua = req.get ? req.get('user-agent') : null;
  if (ua) bits.push(`agent ${String(ua).slice(0, 100)}`);
  return bits.join(', ');
}

/**
 * Logs one warning per old path per distinct caller per process lifetime,
 * then passes through to the router mounted at the new path (WP4: unprefixed
 * Cohesity routes moved under /api/cohesity/*; these aliases are temporary
 * compat for customer automation). This middleware runs before the permission
 * check, so an unauthenticated probe is logged too.
 */
function deprecated(oldPath, newPath) {
  return (req, res, next) => {
    const caller = callerOf(req);
    const key = `${oldPath}|${caller}`;
    if (!warned.has(key)) {
      if (warned.size >= MAX_KEYS) warned.clear();
      warned.add(key);
      logger.warn(`[deprecated] ${oldPath} → ${newPath} — old path will be removed in a future major. Caller: ${caller}`);
    }
    next();
  };
}

module.exports = deprecated;
module.exports._callerOf = callerOf;
module.exports._reset = () => warned.clear();
