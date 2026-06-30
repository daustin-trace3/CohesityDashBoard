/**
 * Short-lived HTTP caching for read-only GET endpoints.
 *
 * Express already emits weak ETags for JSON bodies, so conditional requests
 * (If-None-Match) return 304 automatically. Adding a small `max-age` lets the
 * browser serve repeat loads straight from its cache (no round-trip) and then
 * revalidate cheaply once the window expires. Data refreshes on the poll
 * interval (default 15m), so a few seconds of staleness is harmless.
 *
 * Usage: router.get('/', cacheControl(30), handler)
 */
function cacheControl(seconds = 30) {
  return (req, res, next) => {
    res.set('Cache-Control', `private, max-age=${seconds}, must-revalidate`);
    next();
  };
}

module.exports = cacheControl;
