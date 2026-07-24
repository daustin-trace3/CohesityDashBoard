// Auth service (contract C8.3): password hashing, hand-rolled sessions
// (no express-session), and the first-run claim token.
const argon2 = require('argon2');
const crypto = require('crypto');
const db = require('../db/database');
const logger = require('../utils/logger');
const { resolveGrants } = require('./rbac');

const SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000; // 7 days
const REFRESH_THRESHOLD_MS = 6 * 24 * 60 * 60 * 1000; // sliding refresh once <6d left

function generateToken(bytes) {
  return crypto.randomBytes(bytes).toString('hex');
}

async function hashPassword(password) {
  return argon2.hash(password, { type: argon2.argon2id });
}

async function verifyPassword(hash, password) {
  try {
    return await argon2.verify(hash, password);
  } catch {
    return false;
  }
}

function toPublicUser(row) {
  if (!row) return null;
  return {
    id: row.id,
    username: row.username,
    displayName: row.display_name,
    authProvider: row.auth_provider,
    isActive: !!row.is_active,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    lastLoginAt: row.last_login_at,
  };
}

/**
 * @param {number} userId
 * @returns {{id: string, csrfToken: string}}
 */
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

/**
 * Validates a session id, lazily deleting it if expired or its user was
 * deactivated/removed. Sliding refresh extends expiry back to +7d once
 * fewer than 6 days remain.
 * @param {string} sessionId
 * @returns {{user: object, grants: string[], csrfToken: string} | null}
 */
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

  const remainingMs = expiresAt.getTime() - now.getTime();
  if (remainingMs < REFRESH_THRESHOLD_MS) {
    const newExpiresAt = new Date(now.getTime() + SESSION_TTL_MS);
    db.prepare('UPDATE auth_sessions SET expires_at = ?, last_seen_at = ? WHERE id = ?')
      .run(newExpiresAt.toISOString(), now.toISOString(), sessionId);
  } else {
    db.prepare('UPDATE auth_sessions SET last_seen_at = ? WHERE id = ?').run(now.toISOString(), sessionId);
  }

  const grants = resolveGrants(db, user.id);
  return { user: toPublicUser(user), grants, csrfToken: session.csrf_token };
}

function destroySession(sessionId) {
  db.prepare('DELETE FROM auth_sessions WHERE id = ?').run(sessionId);
}

function pruneExpired() {
  db.prepare('DELETE FROM auth_sessions WHERE expires_at <= ?').run(new Date().toISOString());
}

// --- Claim token (contract C8.3) ---
let claimToken = null;
let claimTokenGenerated = false;

function userCount() {
  return db.prepare('SELECT COUNT(*) AS c FROM users').get().c;
}

function bootClaimTokenCheck() {
  if (claimTokenGenerated) return;
  if (userCount() !== 0) return;
  claimTokenGenerated = true;
  claimToken = generateToken(16);
  logger.warn(`[auth] No users exist. First-run setup claim token: ${claimToken}  (enter it at /login to create the admin account)`);
}

/**
 * @returns {string | null} the claim token, only while no users exist yet.
 */
function getClaimToken() {
  return userCount() === 0 ? claimToken : null;
}

// Boot-time work, run once when the module first loads: prune stale
// sessions and generate the first-run claim token if needed.
pruneExpired();
bootClaimTokenCheck();

/**
 * Whether authentication is required (contract: optional-auth mode).
 * Explicit app_settings `auth_enabled` ('0'/'1') wins; unset defaults to
 * enabled only when users exist — a fresh install runs open-access until
 * someone enables auth, an established install keeps requiring login.
 */
function authEnabled() {
  const { getSetting } = require('./settings');
  const v = getSetting('auth_enabled');
  if (v === '0') return false;
  if (v === '1') return true;
  return userCount() > 0;
}

/** The identity every request gets while auth is disabled. */
function anonymousAuth() {
  return { kind: 'anonymous', name: 'open-access', grants: ['*:*:*'] };
}

module.exports = {
  hashPassword,
  verifyPassword,
  createSession,
  validateSession,
  destroySession,
  pruneExpired,
  getClaimToken,
  authEnabled,
  anonymousAuth,
};
