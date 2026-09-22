// Puts every API request inside its tenant (docs/MULTI-TENANT-DESIGN.md,
// decision 2). The tenant comes from the request itself, never from the
// session, so two browser tabs can show two tenants:
//   /api/t/<tenant>/...      path form, for people and scripts
//   x-icc-tenant: <tenant>   header form, added by the frontend from the page
//                            URL; plugin bundles call fetch('/api/...') on
//                            their own and get the header from the host's
//                            fetch wrapper, so packs need no change
// The path form wins when both are present. With one tenant a request that
// names none runs as that tenant; from the second tenant on it is refused.
// Membership (may this caller enter this tenant) is checked in phase 2 once
// accounts live in the global database.
const { runAsTenant } = require('../core/tenantContext');
const registry = require('../core/tenantRegistry');

const PATH_FORM = /^\/t\/([^/?]+)(\/.*|\?.*|)$/;
const ID_FORM = /^[a-z0-9][a-z0-9-]{1,38}[a-z0-9]$/;

function tenantScope(req, res, next) {
  let tenantId = null;
  const m = req.url.match(PATH_FORM);
  if (m) {
    tenantId = m[1];
    req.url = m[2] && m[2].startsWith('/') ? m[2] : `/${m[2] || ''}`;
  } else if (req.headers['x-icc-tenant']) {
    tenantId = String(req.headers['x-icc-tenant']);
  }

  if (!tenantId) {
    // Signing in and listing tenants are install-wide: a browser that has not
    // picked a tenant yet must still be able to do both. Everything else
    // needs a tenant once there is more than one.
    const installWide = /^[/](auth|tenants)([/?]|$)/.test(req.url);
    if (registry.isStrict() && !installWide) {
      return res.status(400).json({ error: 'This install has more than one tenant. Name the tenant in the request path (/api/t/<tenant>/...) or the x-icc-tenant header.' });
    }
    tenantId = registry.DEFAULT_TENANT;
  }

  if (!ID_FORM.test(tenantId) || !registry.getTenant(tenantId)) {
    return res.status(404).json({ error: 'Unknown tenant' });
  }

  req.tenantId = tenantId;
  res.setHeader('x-icc-tenant', tenantId);
  return runAsTenant(tenantId, () => next());
}

module.exports = tenantScope;
