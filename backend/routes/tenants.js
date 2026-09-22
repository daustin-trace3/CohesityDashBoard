// Tenants: what the switcher lists, and global admin management (decision 7).
// GET / is open to every authenticated caller and lists only the tenants the
// caller may enter. Everything else needs a global admin session.
const express = require('express');
const path = require('path');
const { spawn } = require('child_process');
const registry = require('../core/tenantRegistry');
const accounts = require('../core/accounts');
const pluginRegistry = require('../core/registry');
const { runAsTenant } = require('../core/tenantContext');
const { getSetting, setSetting } = require('../services/settings');
const { authEnabled, hashPassword } = require('../services/authService');
const { getLicenseStatus } = require('../services/license');
const logger = require('../utils/logger');

/** Platform ids a tenant can be given: the built-in Cohesity plus every
 *  registered platform that the install itself is entitled to. */
function installPlatforms() {
  const ids = ['cohesity'];
  for (const p of pluginRegistry.listPlugins()) if (p.status === 'active' && p.entitled !== false) ids.push(p.id);
  return [...new Set(ids)];
}

/** Writes a tenant's platform list and enable flags (decision 12). */
function applyPlatforms(tenantId, platforms) {
  const known = installPlatforms();
  const picked = platforms == null ? known : platforms.filter((id) => known.includes(id));
  runAsTenant(tenantId, () => {
    setSetting('tenant_platforms', JSON.stringify(picked));
    for (const id of known) setSetting(`platform_${id}_enabled`, picked.includes(id) ? '1' : '0');
  });
  return picked;
}

function tenantView(t) {
  return runAsTenant(t.id, () => {
    let platforms = null;
    try { platforms = JSON.parse(getSetting('tenant_platforms') || 'null'); } catch { platforms = null; }
    const license = getLicenseStatus();
    return {
      id: t.id, name: t.name, status: t.status, createdAt: t.createdAt,
      platforms: Array.isArray(platforms) ? platforms : installPlatforms(),
      license: { state: license.state, expiry: license.effectiveExpiry || null, daysLeft: license.daysLeft ?? null },
      members: accounts.membersOf(t.id).length,
    };
  });
}

/** Demo data for a demo tenant: the seeder is its own process against the
 *  tenant's file, with ICC_TENANT so credentials use the tenant's key. The
 *  seeded users are removed afterwards; accounts are global. */
function seedDemoData(tenantId) {
  return new Promise((resolve) => {
    const script = path.join(__dirname, '..', 'demo', 'seedDemo.js');
    const child = spawn(process.execPath, [script, registry.tenantDbPath(tenantId)], {
      env: { ...process.env, ICC_TENANT: tenantId, DASHBOARD_DB_PATH: registry.tenantDbPath(tenantId), DASHBOARD_DEMO: '1' },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let out = '';
    child.stdout.on('data', (d) => { out += d; });
    child.stderr.on('data', (d) => { out += d; });
    child.on('exit', (code) => {
      try {
        runAsTenant(tenantId, () => {
          const tdb = require('../db/database');
          tdb.prepare('DELETE FROM users').run();
        });
      } catch (err) { logger.error(`[tenants] could not clear seeded users for ${tenantId}: ${err.message}`); }
      resolve({ ok: code === 0, output: out.slice(-2000) });
    });
  });
}

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

/** Everything a global admin sees per tenant, plus what a new one may get. */
router.get('/manage', requireGlobalAdmin, (req, res) => {
  res.json({
    platforms: installPlatforms(),
    tenants: registry.listTenants().map(tenantView),
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
  // Tenant setup (decision 15): name, platforms, first admin, optional demo
  // data. The first admin is an existing account (linked) or a new one.
  const { id, name, platforms, admin, seedDemo } = req.body || {};
  if (platforms !== undefined && !Array.isArray(platforms)) return res.status(400).json({ error: 'platforms must be a list of platform ids' });
  if (admin && (!admin.username || typeof admin.username !== 'string')) return res.status(400).json({ error: 'admin.username is required when admin is given' });
  let adminAccount = null;
  if (admin) {
    adminAccount = accounts.findUserByUsername(admin.username.trim());
    if (!adminAccount && !admin.password) return res.status(400).json({ error: `No account named ${admin.username.trim()}; give admin.password to create it.` });
  }
  let tenant;
  try {
    tenant = registry.createTenant({ id: String(id || '').trim().toLowerCase(), name });
  } catch (err) {
    return res.status(400).json({ error: err.message });
  }
  const actor = req.auth.user || null;
  const picked = applyPlatforms(tenant.id, platforms === undefined ? null : platforms);
  accounts.audit('tenant.created', { actor, tenantId: tenant.id, detail: { name: tenant.name, platforms: picked } });

  (async () => {
    if (admin) {
      if (!adminAccount) {
        adminAccount = accounts.createUser({ username: admin.username.trim(), passwordHash: await hashPassword(String(admin.password)), displayName: admin.displayName ? String(admin.displayName) : admin.username.trim() });
        accounts.audit('account.created', { actor, tenantId: tenant.id, detail: { username: adminAccount.username, by: 'tenant-setup' } });
      }
      accounts.addMember(tenant.id, adminAccount.id, actor ? actor.username : 'env-key', { defaultGroup: false });
      runAsTenant(tenant.id, () => {
        const tdb = require('../db/database');
        const adminGroup = tdb.prepare("SELECT id FROM groups WHERE name = 'Admin'").get();
        if (adminGroup) tdb.prepare('INSERT OR IGNORE INTO user_groups (user_id, group_id) VALUES (?, ?)').run(adminAccount.id, adminGroup.id);
      });
      accounts.audit('member.added', { actor, tenantId: tenant.id, detail: { username: adminAccount.username, role: 'Admin' } });
    }
    let seeded = null;
    if (seedDemo) {
      seeded = await seedDemoData(tenant.id);
      accounts.audit('tenant.seeded', { actor, tenantId: tenant.id, detail: { ok: seeded.ok } });
      if (adminAccount) accounts.addMember(tenant.id, adminAccount.id, 'tenant-setup', { defaultGroup: false });
    }
    res.status(201).json({ ...tenantView(registry.getTenant(tenant.id)), seeded: seeded ? seeded.ok : null });
  })().catch((err) => res.status(500).json({ error: err.message }));
});

/** Name, status (active or suspended) and platform list of a tenant. */
router.put('/:id', requireGlobalAdmin, (req, res) => {
  const tenant = registry.getTenant(req.params.id);
  if (!tenant) return res.status(404).json({ error: 'Unknown tenant' });
  const { name, status, platforms } = req.body || {};
  const actor = req.auth.user || null;
  if (status !== undefined) {
    if (!['active', 'suspended'].includes(status)) return res.status(400).json({ error: "status must be 'active' or 'suspended'" });
    if (tenant.id === registry.DEFAULT_TENANT && status === 'suspended') return res.status(400).json({ error: 'The default tenant cannot be suspended.' });
    registry.globalDb.prepare('UPDATE tenants SET status = ? WHERE id = ?').run(status, tenant.id);
    accounts.audit(status === 'suspended' ? 'tenant.suspended' : 'tenant.resumed', { actor, tenantId: tenant.id });
  }
  if (name !== undefined) {
    const label = String(name).trim();
    if (!label) return res.status(400).json({ error: 'name is required' });
    registry.globalDb.prepare('UPDATE tenants SET name = ? WHERE id = ?').run(label, tenant.id);
  }
  if (platforms !== undefined) {
    if (!Array.isArray(platforms)) return res.status(400).json({ error: 'platforms must be a list of platform ids' });
    const picked = applyPlatforms(tenant.id, platforms);
    accounts.audit('tenant.platforms', { actor, tenantId: tenant.id, detail: { platforms: picked } });
  }
  res.json(tenantView(registry.getTenant(tenant.id)));
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
