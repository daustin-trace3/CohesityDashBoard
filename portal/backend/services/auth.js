// Portal auth: argon2 passwords, DB-backed sessions, first-run claim token.
// Mirrors the ICC instance auth service, minus RBAC — every portal user has
// full access in v1.
const argon2 = require('argon2');
const crypto = require('crypto');
const db = require('../db');

const SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const REFRESH_THRESHOLD_MS = 6 * 24 * 60 * 60 * 1000;

const generateToken = (bytes) => crypto.randomBytes(bytes).toString('hex');

async function hashPassword(password) {
  return argon2.hash(password, { type: argon2.argon2id });
}

async function verifyPassword(hash, password) {
  try { return await argon2.verify(hash, password); } catch { return false; }
}

function toPublicUser(row) {
  if (!row) return null;
  return {
    id: row.id,
    username: row.username,
    displayName: row.display_name,
    isActive: !!row.is_active,
    createdAt: row.created_at,
    lastLoginAt: row.last_login_at,
  };
}

function createSession(userId) {
  const id = generateToken(32);
  const csrfToken = generateToken(32);
  const now = new Date();
  const expiresAt = new Date(now.getTime() + SESSION_TTL_MS);
  db.prepare(`
    INSERT INTO auth_sessions (id, user_id, csrf_token, created_at, expires_at, last_seen_at)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(id, userId, csrfToken, now.toISOString(), expiresAt.toISOString(), now.toISOString());
  return { id, csrfToken };
}

function validateSession(sessionId) {
  const session = db.prepare('SELECT * FROM auth_sessions WHERE id = ?').get(sessionId);
  if (!session) return null;

  const now = new Date();
  const expiresAt = new Date(session.expires_at);
  if (expiresAt.getTime() <= now.getTime()) {
    db.prepare('DELETE FROM auth_sessions WHERE id = ?').run(sessionId);
    return null;
  }

  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(session.user_id);
  if (!user || !user.is_active) {
    db.prepare('DELETE FROM auth_sessions WHERE id = ?').run(sessionId);
    return null;
  }

  if (expiresAt.getTime() - now.getTime() < REFRESH_THRESHOLD_MS) {
    db.prepare('UPDATE auth_sessions SET expires_at = ?, last_seen_at = ? WHERE id = ?')
      .run(new Date(now.getTime() + SESSION_TTL_MS).toISOString(), now.toISOString(), sessionId);
  } else {
    db.prepare('UPDATE auth_sessions SET last_seen_at = ? WHERE id = ?').run(now.toISOString(), sessionId);
  }

  return { user: toPublicUser(user), csrfToken: session.csrf_token };
}

function destroySession(sessionId) {
  db.prepare('DELETE FROM auth_sessions WHERE id = ?').run(sessionId);
}

// --- First-run claim token ---
let claimToken = null;

const userCount = () => db.prepare('SELECT COUNT(*) AS c FROM users').get().c;

function bootClaimTokenCheck() {
  if (userCount() !== 0) return;
  claimToken = generateToken(16);
  console.warn(`[portal-auth] No users exist. First-run setup claim token: ${claimToken}  (enter it at /login to create the admin account)`);
}

function getClaimToken() {
  return userCount() === 0 ? claimToken : null;
}

db.prepare('DELETE FROM auth_sessions WHERE expires_at <= ?').run(new Date().toISOString());
bootClaimTokenCheck();

module.exports = {
  hashPassword,
  verifyPassword,
  createSession,
  validateSession,
  destroySession,
  getClaimToken,
  toPublicUser,
};
