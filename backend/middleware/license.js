const { getLicenseStatus } = require('../services/license');

/**
 * Blocks API access when the product license is missing, invalid, or past
 * its grace window. /api/license/* stays reachable so the UI can show the
 * license page and accept an extension certificate.
 */
module.exports = function requireLicense(req, res, next) {
  if (req.path.startsWith('/license')) return next();
  // A global admin may still enter a suspended or unlicensed tenant to fix it
  // (decision 15); everyone else lands on the licence page.
  if (req.auth && req.auth.kind === 'session' && req.auth.user && req.auth.user.isGlobalAdmin) return next();
  const status = getLicenseStatus();
  if (status.state === 'valid' || status.state === 'grace') return next();
  res.status(403).json({
    error: 'license_required',
    state: status.state,
  });
};
