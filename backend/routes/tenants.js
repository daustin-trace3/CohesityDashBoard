// Tenants: what the switcher lists, and global admin management (decision 7).
// GET / is open to every authenticated caller and lists only the tenants the
// caller may enter. Everything else needs a global admin session.
const express = require('express');
const registry = require('../core/tenantRegistry');
const accounts = require('../core/accounts');
const { getSetting } = require('../services/settings');
const { authEnabled } = require('../services/authService');

const router = express.Router();

function callerTenants(req) {
  const all = registry.listTenants();
  const auth = req.auth || {};
  if (auth.kind !== 'session') return all; // env key, service account or open access
  if (auth.user.isGlobalAdmin) return all;
  const mine = new Set(accounts.tenantsOf(auth.user.id));
  return all.filter((t) => mine.has(t.id));
}

function requireGlobalAdmin(req, res, next) {
  const auth = req.auth || {};
  const ok = (auth.kind === 'session' && auth.user.isGlobalAdmin)
    || (auth.kind === 'service' && auth.name === 'legacy-env-key');
  if (!ok) return res.status(403).json({ error: 'forbidden', required: 'global admin' });
  next();
}

router.get('/', (req, res) => {
  res.json({
    current: req.tenantId || null,
    tenants: callerTenants(req).map((t) => ({ id: t.id, name: t.name, status: t.status })),
  });
});

router.get('/audit', requireGlobalAdmin, (req, res) => {
  res.json({ entries: accounts.listAudit({ limit: req.query.limit, tenantId: req.query.tenant || null }) });
});

router.post('/', requireGlobalAdmin, (req, res) => {
  // Decision 11: open-access mode and more than one tenant cannot coexist.
  if (!authEnabled() || getSetting('auth_enabled') === '0') {
    return res.status(409).json({ error: 'Enable authentication before creating a second tenant.' });
  }
  const { id, name } = req.body || {};
  let tenant;
  try {
    tenant = registry.createTenant({ id: String(id || '').trim().toLowerCase(), name });
  } catch (err) {
    return res.status(400).json({ error: err.message });
  }
  accounts.audit('tenant.created', { actor: req.auth.user || null, tenantId: tenant.id, detail: { name: tenant.name } });
  res.status(201).json(tenant);
});

router.get('/:id/members', requireGlobalAdmin, (req, res) => {
  if (!registry.getTenant(req.params.id)) return res.status(404).json({ error: 'Unknown tenant' });
  res.json({ members: accounts.membersOf(req.params.id).map((u) => ({ id: u.id, username: u.username, displayName: u.display_name, isActive: !!u.is_active, isGlobalAdmin: !!u.is_global_admin })) });
});

router.post('/:id/members', requireGlobalAdmin, (req, res) => {
  const tenantId = req.params.id;
  if (!registry.getTenant(tenantId)) return res.status(404).json({ error: 'Unknown tenant' });
  const user = accounts.findUserByUsername(String((req.body || {}).username || ''));
  if (!user) return res.status(404).json({ error: 'No account with that username. Create it in a tenant first, or as a global admin.' });
  const fresh = accounts.addMember(tenantId, user.id, req.auth.user ? req.auth.user.username : 'env-key');
  accounts.audit('member.added', { actor: req.auth.user || null, tenantId, detail: { username: user.username } });
  res.status(fresh ? 201 : 200).json({ ok: true, added: fresh });
});

router.delete('/:id/members/:userId', requireGlobalAdmin, (req, res) => {
  const tenantId = req.params.id;
  if (!registry.getTenant(tenantId)) return res.status(404).json({ error: 'Unknown tenant' });
  const user = accounts.getUser(Number(req.params.userId));
  if (!user) return res.status(404).json({ error: 'Unknown user' });
  accounts.removeMember(tenantId, user.id);
  accounts.audit('member.removed', { actor: req.auth.user || null, tenantId, detail: { username: user.username } });
  res.json({ ok: true });
});

module.exports = router;
