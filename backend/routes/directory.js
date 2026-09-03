// Active Directory admin API (2026-09-03). Mounted at /api/directory and
// gated in app.js by admin:users:view (GET) / admin:users:manage (mutations),
// the same gate as /api/users since linking an AD group is an access change.
const express = require('express');
const db = require('../db/database');
const directory = require('../services/directory');
const directorySync = require('../services/directorySync');
const { encrypt } = require('../services/encryption');

const router = express.Router();

function toGroupRow(g) {
  const members = db.prepare('SELECT COUNT(*) c FROM user_groups WHERE group_id = ?').get(g.id).c;
  return {
    id: g.id,
    name: g.name,
    description: g.description,
    externalName: g.external_name,
    externalDn: g.external_dn,
    externalId: g.external_id,
    syncedAt: g.synced_at,
    memberCount: members,
  };
}

router.get('/config', (req, res) => {
  res.json({ ...directory.getConfig(), configured: directory.isEnabled(), syncRunning: directorySync.isRunning() });
});

router.put('/config', (req, res, next) => {
  try {
    const cfg = directory.saveConfig(req.body || {}, encrypt);
    res.json({ ...cfg, configured: directory.isEnabled(), syncRunning: directorySync.isRunning() });
  } catch (err) {
    next(err);
  }
});

/** Discover DCs, bind with the saved (or supplied, unsaved) account, read RootDSE. */
router.post('/test', async (req, res, next) => {
  try {
    const report = await directory.testConnection();
    res.status(report.ok ? 200 : 502).json(report);
  } catch (err) {
    next(err);
  }
});

router.get('/groups', async (req, res, next) => {
  try {
    if (!directory.isEnabled()) return res.status(400).json({ error: 'Directory is not configured.' });
    const groups = await directory.searchGroups(req.query.q || '', 500);
    const linkedDns = new Set(directorySync.linkedGroups().map((g) => String(g.external_dn || '').toLowerCase()));
    res.json(groups.map((g) => ({ ...g, linked: linkedDns.has(g.dn.toLowerCase()) })));
  } catch (err) {
    res.status(502).json({ error: err.message });
  }
});

/** Directory users by name, for the Users tab picker. */
router.get('/users', async (req, res) => {
  try {
    if (!directory.isEnabled()) return res.status(400).json({ error: 'Directory is not configured.' });
    const users = await directory.searchUsers(req.query.q || '', 50);
    const known = new Map(db.prepare("SELECT external_id, username FROM users WHERE auth_provider = 'ad' AND external_id IS NOT NULL").all().map((r) => [r.external_id, r.username]));
    res.json(users.map((u) => ({ dn: u.dn, sam: u.sam, upn: u.upn, displayName: u.displayName, email: u.email, disabled: u.disabled, imported: known.has(u.guid) ? known.get(u.guid) : null })));
  } catch (err) {
    res.status(502).json({ error: err.message });
  }
});

/** Add one directory user by name (pinned) with optional group memberships. */
router.post('/users', async (req, res, next) => {
  try {
    if (!directory.isEnabled()) return res.status(400).json({ error: 'Directory is not configured.' });
    const dn = String(req.body?.dn || '').trim();
    if (!dn) return res.status(400).json({ error: 'dn is required.' });
    const ad = await directory.getUserByDn(dn);
    if (!ad) return res.status(404).json({ error: 'Directory user not found.' });
    if (ad.disabled) return res.status(400).json({ error: 'That account is disabled in the directory.' });
    const user = directorySync.importUser(ad, Array.isArray(req.body?.groupIds) ? req.body.groupIds : []);
    const groups = db.prepare('SELECT g.name FROM groups g JOIN user_groups ug ON ug.group_id = g.id WHERE ug.user_id = ? ORDER BY g.name').all(user.id).map((r) => r.name);
    res.status(201).json({ id: user.id, username: user.username, displayName: user.display_name, isActive: !!user.is_active, provider: 'ad', email: user.email, groups, lastLoginAt: user.last_login_at });
  } catch (err) {
    if (err.status) return res.status(err.status).json({ error: err.message });
    next(err);
  }
});

router.get('/links', (req, res) => {
  res.json(directorySync.linkedGroups().map(toGroupRow));
});

/** Link an AD group: creates an ICC group (provider 'ad') named after it. */
router.post('/links', async (req, res, next) => {
  try {
    if (!directory.isEnabled()) return res.status(400).json({ error: 'Directory is not configured.' });
    const dn = String(req.body?.dn || '').trim();
    if (!dn) return res.status(400).json({ error: 'dn is required.' });
    const existing = db.prepare("SELECT * FROM groups WHERE provider = 'ad' AND LOWER(external_dn) = LOWER(?)").get(dn);
    if (existing) return res.status(409).json({ error: 'That AD group is already linked.', group: toGroupRow(existing) });

    const ad = await directory.getGroupByDn(dn);
    if (!ad) return res.status(404).json({ error: 'AD group not found.' });

    const requested = String(req.body?.name || '').trim();
    let name = requested || ad.name || ad.cn;
    if (db.prepare('SELECT 1 FROM groups WHERE name = ?').get(name)) name = `${name} (AD)`;
    if (db.prepare('SELECT 1 FROM groups WHERE name = ?').get(name)) {
      return res.status(409).json({ error: `A group named "${name}" already exists. Choose another name.` });
    }
    const now = new Date().toISOString();
    const info = db.prepare(`
      INSERT INTO groups (name, description, is_system, created_at, provider, external_id, external_dn, external_name)
      VALUES (?, ?, 0, ?, 'ad', ?, ?, ?)
    `).run(name, ad.description || `Active Directory group ${ad.name}`, now, ad.guid, ad.dn, ad.name);
    const row = db.prepare('SELECT * FROM groups WHERE id = ?').get(info.lastInsertRowid);

    // Populate right away so the admin sees members before the next schedule.
    directorySync.runSync('link').catch(() => {});
    res.status(201).json(toGroupRow(row));
  } catch (err) {
    next(err);
  }
});

/** Unlink: removes the ICC group, its grants and memberships. Users stay. */
router.delete('/links/:id(\\d+)', (req, res) => {
  const id = Number(req.params.id);
  const g = db.prepare("SELECT * FROM groups WHERE id = ? AND provider = 'ad'").get(id);
  if (!g) return res.status(404).json({ error: 'Linked group not found.' });
  db.transaction(() => {
    db.prepare("DELETE FROM role_grants WHERE subject_type = 'group' AND subject_id = ?").run(id);
    db.prepare('DELETE FROM groups WHERE id = ?').run(id);
  }).immediate();
  res.json({ ok: true });
});

router.post('/sync', async (req, res) => {
  const result = await directorySync.runSync('manual');
  res.status(result.skipped ? 409 : result.status === 'error' ? 502 : 200).json(result);
});

router.get('/sync/status', (req, res) => {
  res.json({ running: directorySync.isRunning(), runs: directorySync.lastRuns(10) });
});

module.exports = router;
