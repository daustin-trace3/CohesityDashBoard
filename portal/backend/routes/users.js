const express = require('express');
const db = require('../db');
const { hashPassword, toPublicUser } = require('../services/auth');

const router = express.Router();

router.get('/', (req, res) => {
  const rows = db.prepare('SELECT * FROM users ORDER BY username').all();
  res.json({ users: rows.map(toPublicUser) });
});

router.post('/', async (req, res, next) => {
  try {
    const { username, password, displayName } = req.body || {};
    const cleanUsername = String(username || '').trim();
    if (!cleanUsername || !password) {
      return res.status(400).json({ error: 'username and password are required.' });
    }
    if (db.prepare('SELECT id FROM users WHERE username = ?').get(cleanUsername)) {
      return res.status(409).json({ error: 'A user with that username already exists.' });
    }
    const now = new Date().toISOString();
    const info = db.prepare(`
      INSERT INTO users (username, password_hash, display_name, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?)
    `).run(cleanUsername, await hashPassword(String(password)), String(displayName || cleanUsername), now, now);
    res.json({ user: toPublicUser(db.prepare('SELECT * FROM users WHERE id = ?').get(info.lastInsertRowid)) });
  } catch (err) {
    next(err);
  }
});

router.put('/:id', async (req, res, next) => {
  try {
    const user = db.prepare('SELECT * FROM users WHERE id = ?').get(req.params.id);
    if (!user) return res.status(404).json({ error: 'User not found.' });

    const { displayName, password, isActive } = req.body || {};
    if (isActive === false && user.id === req.user.id) {
      return res.status(400).json({ error: 'You cannot deactivate your own account.' });
    }
    const now = new Date().toISOString();
    if (displayName !== undefined) {
      db.prepare('UPDATE users SET display_name = ?, updated_at = ? WHERE id = ?').run(String(displayName), now, user.id);
    }
    if (password) {
      db.prepare('UPDATE users SET password_hash = ?, updated_at = ? WHERE id = ?').run(await hashPassword(String(password)), now, user.id);
    }
    if (isActive !== undefined) {
      db.prepare('UPDATE users SET is_active = ?, updated_at = ? WHERE id = ?').run(isActive ? 1 : 0, now, user.id);
    }
    res.json({ user: toPublicUser(db.prepare('SELECT * FROM users WHERE id = ?').get(user.id)) });
  } catch (err) {
    next(err);
  }
});

router.delete('/:id', (req, res) => {
  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(req.params.id);
  if (!user) return res.status(404).json({ error: 'User not found.' });
  if (user.id === req.user.id) return res.status(400).json({ error: 'You cannot delete your own account.' });
  const count = db.prepare('SELECT COUNT(*) AS c FROM users').get().c;
  if (count <= 1) return res.status(400).json({ error: 'Cannot delete the last user.' });
  db.prepare('DELETE FROM users WHERE id = ?').run(user.id);
  res.json({ ok: true });
});

module.exports = router;
