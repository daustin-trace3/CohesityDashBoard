// Admin API (contract C8.7): users, groups, grants, service accounts.
// Mounted at /api/users, gated by admin:users:view|manage in app.js (GET vs
// mutating verbs) — no per-route permission checks needed here.
const express = require('express');
const crypto = require('crypto');
const db = require('../db/database');
const { hashPassword } = require('../services/authService');

const router = express.Router();

const PERMISSION_PATTERN = /^[a-z0-9*-]+:[a-z0-9*-]+:(view|manage|\*)$/;

function isSelf(req, userId) {
  return req.auth && req.auth.kind === 'session' && req.auth.user && req.auth.user.id === userId;
}

/** Active Admin-group members other than `excludeUserId`. */
function activeAdminCountExcluding(excludeUserId) {
  const row = db.prepare(`
    SELECT COUNT(DISTINCT u.id) AS c
    FROM users u
    JOIN user_groups ug ON ug.user_id = u.id
    JOIN groups g ON g.id = ug.group_id
    WHERE g.name = 'Admin' AND u.is_active = 1 AND u.id != ?
  `).get(excludeUserId);
  return row.c;
}

function isInAdminGroup(userId) {
  const row = db.prepare(`
    SELECT 1 FROM user_groups ug
    JOIN groups g ON g.id = ug.group_id
    WHERE g.name = 'Admin' AND ug.user_id = ?
  `).get(userId);
  return !!row;
}

function toUserRow(user) {
  const groups = db.prepare(`
    SELECT g.name FROM groups g
    JOIN user_groups ug ON ug.group_id = g.id
    WHERE ug.user_id = ?
    ORDER BY g.name
  `).all(user.id).map((r) => r.name);
  return {
    id: user.id,
    username: user.username,
    displayName: user.display_name,
    isActive: !!user.is_active,
    groups,
    lastLoginAt: user.last_login_at,
  };
}

function setUserGroups(userId, groupIds) {
  db.prepare('DELETE FROM user_groups WHERE user_id = ?').run(userId);
  if (!Array.isArray(groupIds)) return;
  const insert = db.prepare('INSERT OR IGNORE INTO user_groups (user_id, group_id) VALUES (?, ?)');
  for (const gid of groupIds) {
    const id = Number(gid);
    if (Number.isInteger(id)) insert.run(userId, id);
  }
}

// ── Users ────────────────────────────────────────────────────────────────

router.get('/', (req, res) => {
  const users = db.prepare('SELECT * FROM users ORDER BY username').all();
  res.json(users.map(toUserRow));
});

router.post('/', async (req, res, next) => {
  try {
    const { username, password, displayName, groupIds } = req.body || {};
    const cleanUsername = String(username || '').trim();
    if (!cleanUsername || !password) {
      return res.status(400).json({ error: 'username and password are required.' });
    }
    const existing = db.prepare('SELECT id FROM users WHERE username = ?').get(cleanUsername);
    if (existing) return res.status(409).json({ error: 'A user with that username already exists.' });

    const now = new Date().toISOString();
    const passwordHash = await hashPassword(String(password));
    const info = db.prepare(`
      INSERT INTO users (username, password_hash, display_name, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?)
    `).run(cleanUsername, passwordHash, displayName ? String(displayName) : cleanUsername, now, now);

    setUserGroups(info.lastInsertRowid, groupIds);

    const user = db.prepare('SELECT * FROM users WHERE id = ?').get(info.lastInsertRowid);
    res.status(201).json(toUserRow(user));
  } catch (err) {
    next(err);
  }
});

// Numeric-only params so /grants, /groups, /service-accounts never match :id.
router.put('/:id(\\d+)', async (req, res, next) => {
  try {
    const userId = Number(req.params.id);
    const user = db.prepare('SELECT * FROM users WHERE id = ?').get(userId);
    if (!user) return res.status(404).json({ error: 'User not found.' });

    const { displayName, password, isActive, groupIds } = req.body || {};

    if (isActive === false) {
      if (isSelf(req, userId)) {
        return res.status(400).json({ error: 'You cannot deactivate your own account.' });
      }
      if (isInAdminGroup(userId) && activeAdminCountExcluding(userId) === 0) {
        return res.status(409).json({ error: 'Cannot deactivate the last active Admin.' });
      }
    }

    const now = new Date().toISOString();
    const nextDisplayName = displayName !== undefined ? String(displayName) : user.display_name;
    const nextIsActive = isActive !== undefined ? (isActive ? 1 : 0) : user.is_active;
    const nextPasswordHash = password ? await hashPassword(String(password)) : user.password_hash;

    db.prepare(`
      UPDATE users SET display_name = ?, is_active = ?, password_hash = ?, updated_at = ?
      WHERE id = ?
    `).run(nextDisplayName, nextIsActive, nextPasswordHash, now, userId);

    if (groupIds !== undefined) setUserGroups(userId, groupIds);

    const updated = db.prepare('SELECT * FROM users WHERE id = ?').get(userId);
    res.json(toUserRow(updated));
  } catch (err) {
    next(err);
  }
});

router.delete('/:id(\\d+)', (req, res) => {
  const userId = Number(req.params.id);
  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(userId);
  if (!user) return res.status(404).json({ error: 'User not found.' });

  if (isSelf(req, userId)) {
    return res.status(400).json({ error: 'You cannot delete your own account.' });
  }
  if (isInAdminGroup(userId) && activeAdminCountExcluding(userId) === 0) {
    return res.status(409).json({ error: 'Cannot delete the last active Admin.' });
  }

  db.prepare('DELETE FROM users WHERE id = ?').run(userId);
  res.json({ ok: true });
});

// ── Groups ───────────────────────────────────────────────────────────────

function toGroupRow(group) {
  const memberCount = db.prepare('SELECT COUNT(*) AS c FROM user_groups WHERE group_id = ?').get(group.id).c;
  const grants = db.prepare(
    "SELECT permission FROM role_grants WHERE subject_type = 'group' AND subject_id = ? ORDER BY permission"
  ).all(group.id).map((r) => r.permission);
  return {
    id: group.id,
    name: group.name,
    description: group.description,
    isSystem: !!group.is_system,
    memberCount,
    grants,
  };
}

router.get('/groups', (req, res) => {
  const groups = db.prepare('SELECT * FROM groups ORDER BY name').all();
  res.json(groups.map(toGroupRow));
});

router.post('/groups', (req, res, next) => {
  try {
    const { name, description } = req.body || {};
    const cleanName = String(name || '').trim();
    if (!cleanName) return res.status(400).json({ error: 'name is required.' });

    const now = new Date().toISOString();
    const info = db.prepare(
      'INSERT INTO groups (name, description, is_system, created_at) VALUES (?, ?, 0, ?)'
    ).run(cleanName, description ? String(description) : null, now);

    res.status(201).json(toGroupRow(db.prepare('SELECT * FROM groups WHERE id = ?').get(info.lastInsertRowid)));
  } catch (err) {
    if (err.message && err.message.includes('UNIQUE')) {
      return res.status(409).json({ error: 'A group with that name already exists.' });
    }
    next(err);
  }
});

router.put('/groups/:id', (req, res, next) => {
  try {
    const groupId = Number(req.params.id);
    const group = db.prepare('SELECT * FROM groups WHERE id = ?').get(groupId);
    if (!group) return res.status(404).json({ error: 'Group not found.' });

    const { name, description } = req.body || {};
    if (group.is_system && name !== undefined && String(name).trim() !== group.name) {
      return res.status(400).json({ error: 'System groups cannot be renamed.' });
    }

    const nextName = name !== undefined ? String(name).trim() : group.name;
    const nextDescription = description !== undefined ? String(description) : group.description;
    db.prepare('UPDATE groups SET name = ?, description = ? WHERE id = ?').run(nextName, nextDescription, groupId);

    res.json(toGroupRow(db.prepare('SELECT * FROM groups WHERE id = ?').get(groupId)));
  } catch (err) {
    next(err);
  }
});

router.delete('/groups/:id', (req, res) => {
  const groupId = Number(req.params.id);
  const group = db.prepare('SELECT * FROM groups WHERE id = ?').get(groupId);
  if (!group) return res.status(404).json({ error: 'Group not found.' });
  if (group.is_system) return res.status(400).json({ error: 'System groups cannot be deleted.' });

  db.prepare('DELETE FROM groups WHERE id = ?').run(groupId);
  res.json({ ok: true });
});

// ── Grants ───────────────────────────────────────────────────────────────

router.get('/grants', (req, res) => {
  const { subjectType, subjectId } = req.query;
  let rows;
  if (subjectType && subjectId !== undefined) {
    rows = db.prepare(
      'SELECT * FROM role_grants WHERE subject_type = ? AND subject_id = ? ORDER BY permission'
    ).all(String(subjectType), Number(subjectId));
  } else {
    rows = db.prepare('SELECT * FROM role_grants ORDER BY subject_type, subject_id, permission').all();
  }
  res.json(rows.map((r) => ({
    id: r.id,
    subjectType: r.subject_type,
    subjectId: r.subject_id,
    permission: r.permission,
  })));
});

router.post('/grants', (req, res, next) => {
  try {
    const { subjectType, subjectId, permission } = req.body || {};
    if (subjectType !== 'user' && subjectType !== 'group') {
      return res.status(400).json({ error: "subjectType must be 'user' or 'group'." });
    }
    const id = Number(subjectId);
    if (!Number.isInteger(id)) return res.status(400).json({ error: 'subjectId is required.' });
    if (!PERMISSION_PATTERN.test(String(permission || ''))) {
      return res.status(400).json({ error: 'permission must be of the form <namespace>:<section>:<view|manage|*>.' });
    }

    const now = new Date().toISOString();
    db.prepare(`
      INSERT OR IGNORE INTO role_grants (subject_type, subject_id, permission, created_at)
      VALUES (?, ?, ?, ?)
    `).run(subjectType, id, permission, now);

    res.status(201).json({ ok: true });
  } catch (err) {
    next(err);
  }
});

router.delete('/grants', (req, res) => {
  const { subjectType, subjectId, permission } = req.body || {};
  if (subjectType !== 'user' && subjectType !== 'group') {
    return res.status(400).json({ error: "subjectType must be 'user' or 'group'." });
  }
  const id = Number(subjectId);
  if (!Number.isInteger(id) || !permission) {
    return res.status(400).json({ error: 'subjectId and permission are required.' });
  }

  db.prepare(
    'DELETE FROM role_grants WHERE subject_type = ? AND subject_id = ? AND permission = ?'
  ).run(subjectType, id, String(permission));
  res.json({ ok: true });
});

// ── Service accounts ────────────────────────────────────────────────────

function toServiceAccountRow(row) {
  return {
    id: row.id,
    name: row.name,
    keyPrefix: row.key_prefix,
    permissions: JSON.parse(row.permissions),
    isActive: !!row.is_active,
    lastUsedAt: row.last_used_at,
  };
}

router.get('/service-accounts', (req, res) => {
  const rows = db.prepare('SELECT * FROM service_accounts ORDER BY name').all();
  res.json(rows.map(toServiceAccountRow));
});

router.post('/service-accounts', (req, res, next) => {
  try {
    const { name, permissions } = req.body || {};
    const cleanName = String(name || '').trim();
    if (!cleanName) return res.status(400).json({ error: 'name is required.' });
    const grants = Array.isArray(permissions) ? permissions.map(String) : [];
    if (grants.some((p) => !PERMISSION_PATTERN.test(p))) {
      return res.status(400).json({ error: 'permissions must each be of the form <namespace>:<section>:<view|manage|*>.' });
    }

    const key = `icc_${crypto.randomBytes(20).toString('hex')}`;
    const keyHash = crypto.createHash('sha256').update(key).digest('hex');
    const now = new Date().toISOString();

    const info = db.prepare(`
      INSERT INTO service_accounts (name, key_hash, key_prefix, permissions, is_active, created_at)
      VALUES (?, ?, ?, ?, 1, ?)
    `).run(cleanName, keyHash, key.slice(0, 8), JSON.stringify(grants), now);

    res.status(201).json({ ...toServiceAccountRow(db.prepare('SELECT * FROM service_accounts WHERE id = ?').get(info.lastInsertRowid)), key });
  } catch (err) {
    if (err.message && err.message.includes('UNIQUE')) {
      return res.status(409).json({ error: 'A service account with that name already exists.' });
    }
    next(err);
  }
});

router.put('/service-accounts/:id', (req, res, next) => {
  try {
    const id = Number(req.params.id);
    const row = db.prepare('SELECT * FROM service_accounts WHERE id = ?').get(id);
    if (!row) return res.status(404).json({ error: 'Service account not found.' });

    const { permissions, isActive } = req.body || {};
    let nextPermissions = row.permissions;
    if (permissions !== undefined) {
      const grants = Array.isArray(permissions) ? permissions.map(String) : [];
      if (grants.some((p) => !PERMISSION_PATTERN.test(p))) {
        return res.status(400).json({ error: 'permissions must each be of the form <namespace>:<section>:<view|manage|*>.' });
      }
      nextPermissions = JSON.stringify(grants);
    }
    const nextIsActive = isActive !== undefined ? (isActive ? 1 : 0) : row.is_active;

    db.prepare('UPDATE service_accounts SET permissions = ?, is_active = ? WHERE id = ?')
      .run(nextPermissions, nextIsActive, id);

    res.json(toServiceAccountRow(db.prepare('SELECT * FROM service_accounts WHERE id = ?').get(id)));
  } catch (err) {
    next(err);
  }
});

router.delete('/service-accounts/:id', (req, res) => {
  const id = Number(req.params.id);
  const row = db.prepare('SELECT * FROM service_accounts WHERE id = ?').get(id);
  if (!row) return res.status(404).json({ error: 'Service account not found.' });

  db.prepare('DELETE FROM service_accounts WHERE id = ?').run(id);
  res.json({ ok: true });
});

module.exports = router;
