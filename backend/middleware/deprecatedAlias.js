const logger = require('../utils/logger');

const warned = new Set();

/**
 * Logs one warning per old path per process lifetime, then passes through
 * to the router mounted at the new path (WP4: unprefixed Cohesity routes
 * moved under /api/cohesity/*; these aliases are temporary compat for
 * customer automation).
 */
function deprecated(oldPath, newPath) {
  return (req, res, next) => {
    if (!warned.has(oldPath)) {
      warned.add(oldPath);
      logger.warn(`[deprecated] ${oldPath} → ${newPath} — old path will be removed in a future major`);
    }
    next();
  };
}

module.exports = deprecated;
