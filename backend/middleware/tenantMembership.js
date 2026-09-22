// May this caller be in this tenant? Runs after authenticate, inside the
// tenant context set by tenantScope (decisions 7 and 8).
// - a global admin may enter every tenant; the first entry per session and
//   tenant is written to the global audit log, and the admin gets a mirror
//   row so per-tenant tables that reference users(id) work for it
// - any other session must be a member of the tenant
// - service accounts live in the tenant database they were created in, so
//   they are in the right tenant by construction; the legacy env key and
//   open-access mode are install-wide
// /api/auth and /api/tenants are left alone: a caller with no membership in
// the tenant its URL names must still be able to sign out or find one it may
// enter.
const accounts = require('../core/accounts');

const entered = new Set(); // `${sessionId}:${tenantId}` (per process)

function parseCookie(header, name) {
  if (!header) return null;
  const match = header.split(';').map((s) => s.trim()).find((s) => s.startsWith(`${name}=`));
  return match ? decodeURIComponent(match.slice(name.length + 1)) : null;
}

module.exports = function tenantMembership(req, res, next) {
  if (req.path === '/auth' || req.path.startsWith('/auth/')) return next();
  if (req.path === '/tenants' || req.path.startsWith('/tenants/')) return next();
  const auth = req.auth;
  const tenantId = req.tenantId;
  if (!auth || !tenantId || auth.kind !== 'session') return next();

  const user = auth.user;
  if (user.isGlobalAdmin) {
    const key = `${parseCookie(req.headers.cookie, 'icc_session') || user.id}:${tenantId}`;
    if (!entered.has(key)) {
      entered.add(key);
      accounts.ensureMirrorHere(accounts.getUser(user.id));
      if (!accounts.isMember(tenantId, user.id)) {
        accounts.audit('tenant.entered', { actor: user, tenantId, detail: { as: 'global-admin' } });
      }
    }
    return next();
  }

  if (!accounts.isMember(tenantId, user.id)) {
    return res.status(403).json({ error: 'You are not a member of this tenant.', tenant: tenantId });
  }
  // A suspended tenant (decision 15): members only reach the licence page.
  const tenant = require('../core/tenantRegistry').getTenant(tenantId);
  if (tenant && tenant.status === 'suspended' && !req.path.startsWith('/license')) {
    return res.status(403).json({ error: 'license_required', state: 'suspended', tenant: tenantId });
  }
  return next();
};
