// Identity provider Management API routes (2026-11-06, IDP-CONTRACT section 3).
// Mounted at /api/idp beside routes/idp.js and gated in app.js by
// admin:users:view (GET) / admin:users:manage (mutations), the same gate as
// /api/directory: linking an Okta group is an access change.
const express = require('express');
const db = require('../db/database');
const idpProviders = require('../services/idpProviders');
const idpProvision = require('../services/idpProvision');
const idpSync = require('../services/idpSync');
const okta = require('../services/idpOktaApi');

const router = express.Router();

function toGroupRow(g) {
  const members = db.prepare('SELECT COUNT(*) c FROM user_groups WHERE group_id = ?').get(g.id).c;
  return {
    id: g.id,
    name: g.name,
    description: g.description,
    providerId: g.idp_provider_id,
    externalName: g.external_name,
    externalId: g.external_id,
    syncedAt: g.synced_at,
    memberCount: members,
  };
}

function issuerKey(provider) {
  return provider.type === 'saml' ? provider.idp_entity_id : provider.issuer;
}

/** Provider row plus an Okta client; replies and returns null when not usable. */
function withMgmt(req, res) {
  const provider = idpProviders.getProvider(Number(req.params.id));
  if (!provider) { res.status(404).json({ error: 'Identity provider not found.' }); return null; }
  const token = provider.mgmt_kind === 'okta' && provider.mgmt_base_url ? idpProviders.getSecret(provider, 'mgmt_token') : '';
  if (!token) { res.status(400).json({ error: 'Management API is not configured.' }); return null; }
  return { provider, client: okta.createClient({ baseUrl: provider.mgmt_base_url, token }) };
}

router.get('/providers/:id(\\d+)/groups', async (req, res) => {
  const ctx = withMgmt(req, res);
  if (!ctx) return;
  try {
    const groups = await ctx.client.searchGroups(String(req.query.q || ''), 200);
    const linked = db.prepare("SELECT external_id, external_name FROM groups WHERE provider = 'idp' AND idp_provider_id = ?").all(ctx.provider.id);
    const ids = new Set(linked.map((g) => g.external_id).filter(Boolean));
    const names = new Set(linked.map((g) => String(g.external_name || '').toLowerCase()));
    res.json(groups.map((g) => ({ id: g.id, name: g.name, description: g.description, linked: ids.has(g.id) || names.has(String(g.name || '').toLowerCase()) })));
  } catch (err) {
    res.status(502).json({ error: err.message });
  }
});

router.get('/providers/:id(\\d+)/users', async (req, res) => {
  const ctx = withMgmt(req, res);
  if (!ctx) return;
  try {
    const users = await ctx.client.searchUsers(String(req.query.q || ''), 50);
    const known = new Map(db.prepare('SELECT external_id, username FROM users WHERE idp_provider_id = ? AND external_id IS NOT NULL').all(ctx.provider.id).map((r) => [r.external_id, r.username]));
    const key = issuerKey(ctx.provider);
    res.json(users.map((u) => ({
      id: u.subject, login: u.username, email: u.email, displayName: u.displayName, status: u.status,
      imported: known.has(`idp:${key}:${u.subject}`) ? known.get(`idp:${key}:${u.subject}`) : null,
    })));
  } catch (err) {
    res.status(502).json({ error: err.message });
  }
});

/** Link an Okta group: creates an ICC group (provider 'idp') matched by Okta group name. */
router.post('/providers/:id(\\d+)/links', (req, res, next) => {
  try {
    const provider = idpProviders.getProvider(Number(req.params.id));
    if (!provider) return res.status(404).json({ error: 'Identity provider not found.' });
    const oktaName = String(req.body?.name || '').trim();
    if (!oktaName) return res.status(400).json({ error: 'name is required.' });
    const groupId = String(req.body?.groupId || '').trim() || null;

    const dup = db.prepare("SELECT * FROM groups WHERE provider = 'idp' AND idp_provider_id = ? AND (LOWER(external_name) = LOWER(?) OR (? IS NOT NULL AND external_id = ?))")
      .get(provider.id, oktaName, groupId, groupId);
    if (dup) return res.status(409).json({ error: 'That group is already linked.', group: toGroupRow(dup) });

    let name = String(req.body?.iccName || '').trim() || oktaName;
    if (db.prepare('SELECT 1 FROM groups WHERE name = ?').get(name)) name = `${name} (${provider.name})`;
    if (db.prepare('SELECT 1 FROM groups WHERE name = ?').get(name)) {
      return res.status(409).json({ error: `A group named "${name}" already exists. Choose another name.` });
    }
    const now = new Date().toISOString();
    const info = db.prepare(`
      INSERT INTO groups (name, description, is_system, created_at, provider, external_id, external_name, idp_provider_id)
      VALUES (?, ?, 0, ?, 'idp', ?, ?, ?)
    `).run(name, `${provider.name} group ${oktaName}`, now, groupId, oktaName, provider.id);
    const row = db.prepare('SELECT * FROM groups WHERE id = ?').get(info.lastInsertRowid);
    if (provider.mgmt_kind === 'okta') idpSync.runSync(provider.id, 'link').catch(() => {});
    res.status(201).json(toGroupRow(row));
  } catch (err) {
    next(err);
  }
});

/** Unlink: removes the ICC group, its grants and memberships. Users stay. */
router.delete('/links/:groupId(\\d+)', (req, res) => {
  const id = Number(req.params.groupId);
  const g = db.prepare("SELECT * FROM groups WHERE id = ? AND provider = 'idp'").get(id);
  if (!g) return res.status(404).json({ error: 'Linked group not found.' });
  db.transaction(() => {
    db.prepare("DELETE FROM role_grants WHERE subject_type = 'group' AND subject_id = ?").run(id);
    db.prepare('DELETE FROM groups WHERE id = ?').run(id);
  }).immediate();
  res.json({ ok: true });
});

/** Add one identity-provider user by name (pinned), with optional local group picks. */
router.post('/providers/:id(\\d+)/users', async (req, res, next) => {
  try {
    const provider = idpProviders.getProvider(Number(req.params.id));
    if (!provider) return res.status(404).json({ error: 'Identity provider not found.' });
    const oktaUserId = String(req.body?.oktaUserId || '').trim();
    const email = String(req.body?.email || '').trim();
    if (!oktaUserId && !email) return res.status(400).json({ error: 'email or oktaUserId is required.' });

    let identity;
    const token = provider.mgmt_kind === 'okta' && provider.mgmt_base_url ? idpProviders.getSecret(provider, 'mgmt_token') : '';
    if (token) {
      const client = okta.createClient({ baseUrl: provider.mgmt_base_url, token });
      let u;
      try { u = await client.getUser(oktaUserId || email); } catch (err) { return res.status(502).json({ error: err.message }); }
      if (!u) return res.status(404).json({ error: 'Okta user not found.' });
      if (!u.active) return res.status(400).json({ error: 'That account is not active in Okta.' });
      identity = u;
    } else {
      const e = email.toLowerCase();
      identity = { subject: e, email, username: e, displayName: email, groups: [], groupIds: [], active: true };
    }
    const groupIds = Array.isArray(req.body?.groupIds) ? req.body.groupIds : [];
    const user = idpProvision.importUser(provider, identity, groupIds);
    const groups = db.prepare('SELECT g.name FROM groups g JOIN user_groups ug ON ug.group_id = g.id WHERE ug.user_id = ? ORDER BY g.name').all(user.id).map((r) => r.name);
    res.status(201).json({ id: user.id, username: user.username, displayName: user.display_name, isActive: !!user.is_active, provider: user.auth_provider, email: user.email, groups, lastLoginAt: user.last_login_at });
  } catch (err) {
    if (err.status) return res.status(err.status).json({ error: err.message });
    next(err);
  }
});

router.post('/providers/:id(\\d+)/sync', async (req, res) => {
  const id = Number(req.params.id);
  if (!idpProviders.getProvider(id)) return res.status(404).json({ error: 'Identity provider not found.' });
  const result = await idpSync.runSync(id, 'manual');
  res.status(result.skipped ? 409 : result.status === 'error' ? 502 : 200).json(result);
});

router.get('/providers/:id(\\d+)/sync/status', (req, res) => {
  const id = Number(req.params.id);
  res.json({ running: idpSync.isRunning(id), runs: idpSync.lastRuns(id, 10) });
});

module.exports = router;
