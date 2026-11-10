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

module.exports = { canViewPlatform, filterByGrants, grantsOf };
