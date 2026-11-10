// Which platforms a caller may see. The rail, the Ops Monitor tiles and the
// Service Status board all read this so a user with no grant on a platform
// never sees it, not even as an empty tile (Doug, 2026-11-10).
const { hasPermission } = require('./rbac');

/** True when the grants allow viewing the platform as a whole (the rail rule). */
function canViewPlatform(grants, platformId) {
  return hasPermission(grants || [], `${platformId}:*:view`);
}

/** Keep the rows whose platform id the caller may view. `idOf` picks the id off a row. */
function filterByGrants(rows, grants, idOf = (r) => r.id) {
  return (rows || []).filter((r) => canViewPlatform(grants, idOf(r)));
}

function grantsOf(req) {
  return (req && req.auth && req.auth.grants) || [];
}

/** True when the caller holds a view grant on at least one of the platform ids. */
function canViewAnyOf(grants, platformIds) {
  return (platformIds || []).some((id) => canViewPlatform(grants, id));
}

/** The caller's Ops level: 'manage', 'view' or null. Rollup pages need no ops
 *  grant; the Ops Agent, Estate Advisor and acting routes do. */
function opsLevel(grants) {
  if (hasPermission(grants || [], 'ops:*:manage')) return 'manage';
  if (hasPermission(grants || [], 'ops:*:view')) return 'view';
  return null;
}

/** Express middleware: 403 unless the caller holds ops:*:<level>. */
function requireOps(level) {
  const required = `ops:*:${level}`;
  return (req, res, next) => {
    if (hasPermission(grantsOf(req), required)) return next();
    return res.status(403).json({ error: 'forbidden', required });
  };
}

module.exports = { canViewPlatform, canViewAnyOf, filterByGrants, grantsOf, opsLevel, requireOps };
