#!/usr/bin/env node
// Create (or reset the password of) a portal user non-interactively.
// Usage: node scripts/create-user.js <username> <password> [displayName]
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '..', '.env') });

const [username, password, displayName] = process.argv.slice(2);
if (!username || !password) {
  console.error('Usage: node scripts/create-user.js <username> <password> [displayName]');
  process.exit(1);
}

const db = require('../db');
const { hashPassword } = require('../services/auth');

(async () => {
  const now = new Date().toISOString();
  const hash = await hashPassword(password);
  const existing = db.prepare('SELECT id FROM users WHERE username = ?').get(username);
  if (existing) {
    db.prepare('UPDATE users SET password_hash = ?, updated_at = ? WHERE id = ?').run(hash, now, existing.id);
    console.log(`Updated password for existing user '${username}'.`);
  } else {
    db.prepare(`
      INSERT INTO users (username, password_hash, display_name, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?)
    `).run(username, hash, displayName || username, now, now);
    console.log(`Created user '${username}'.`);
  }
  process.exit(0);
})();
