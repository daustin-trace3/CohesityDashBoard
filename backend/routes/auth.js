// Auth HTTP surface (contract C8.4). Mounted at /api/auth and fully exempt
// from middleware/authenticate.js — these endpoints are how a caller gets
// (or checks) a session in the first place.
const express = require('express');
const rateLimit = require('express-rate-limit');
const db = require('../db/database');
const {
  hashPassword,
  verifyPassword,
  createSession,
  validateSession,
  destroySession,
  getClaimToken,
} = require('../services/authService');
const { resolveGrants } = require('../services/rbac');

const router = express.Router();

const COOKIE_NAME = 'icc_session';
const COOKIE_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000; // 7 days

// 5/min/IP on login + setup — brute-force guard.
const authLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 5,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many requests, please try again later.' },
});

function parseCookie(header, name) {
  if (!header) return null;
  const match = header.split(';').map((s) => s.trim()).find((s) => s.startsWith(`${name}=`));
  return match ? decodeURIComponent(match.slice(name.length + 1)) : null;
}

function setSessionCookie(req, res, sessionId) {
  res.cookie(COOKIE_NAME, sessionId, {
    httpOnly: true,
    sameSite: 'lax',
    path: '/',
    secure: !!req.secure,
    maxAge: COOKIE_MAX_AGE_MS,
  });
}

function clearSessionCookie(req, res) {
  res.clearCookie(COOKIE_NAME, { httpOnly: true, sameSite: 'lax', path: '/', secure: !!req.secure });
}

function userPayload(user, grants) {
  return {
    id: user.id,
    username: user.username,
    displayName: user.displayName !== undefined ? user.displayName : user.display_name,
    permissions: grants,
  };
}

/** GET /api/auth/setup-status */
router.get('/setup-status', (req, res) => {
  const count = db.prepare('SELECT COUNT(*) AS c FROM users').get().c;
  res.json({ needsSetup: count === 0 });
});

/** POST /api/auth/setup { token, username, password } — creates the first admin. */
router.post('/setup', authLimiter, async (req, res, next) => {
  try {
    const { token, username, password } = req.body || {};
    const count = db.prepare('SELECT COUNT(*) AS c FROM users').get().c;
    if (count !== 0) return res.status(403).json({ error: 'Setup has already been completed.' });

    const expected = getClaimToken();
    if (!expected || !token || token !== expected) {
      return res.status(403).json({ error: 'Invalid or expired setup token.' });
    }
    const cleanUsername = String(username || '').trim();
    if (!cleanUsername || !password) {
      return res.status(400).json({ error: 'username and password are required.' });
    }

    const now = new Date().toISOString();
    const passwordHash = await hashPassword(String(password));
    const info = db.prepare(`
      INSERT INTO users (username, password_hash, display_name, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?)
    `).run(cleanUsername, passwordHash, cleanUsername, now, now);

    const adminGroup = db.prepare("SELECT id FROM groups WHERE name = 'Admin'").get();
    if (adminGroup) {
      db.prepare('INSERT OR IGNORE INTO user_groups (user_id, group_id) VALUES (?, ?)')
        .run(info.lastInsertRowid, adminGroup.id);
    }

    const user = db.prepare('SELECT * FROM users WHERE id = ?').get(info.lastInsertRowid);
    const session = createSession(user.id);
    setSessionCookie(req, res, session.id);

    const grants = resolveGrants(db, user.id);
    res.json({ user: userPayload(user, grants) });
  } catch (err) {
    next(err);
  }
});

/** POST /api/auth/login { username, password } */
router.post('/login', authLimiter, async (req, res, next) => {
  try {
    const { username, password } = req.body || {};
    const invalid = () => res.status(401).json({ error: 'Invalid username or password.' });
    if (!username || !password) return invalid();

    const user = db.prepare('SELECT * FROM users WHERE username = ?').get(String(username));
    if (!user || !user.is_active) return invalid();

    const ok = await verifyPassword(user.password_hash, String(password));
    if (!ok) return invalid();

    db.prepare('UPDATE users SET last_login_at = ? WHERE id = ?').run(new Date().toISOString(), user.id);

    const session = createSession(user.id);
    setSessionCookie(req, res, session.id);

    const grants = resolveGrants(db, user.id);
    res.json({ user: userPayload(user, grants) });
  } catch (err) {
    next(err);
  }
});

/** POST /api/auth/logout — requires a valid session. */
router.post('/logout', (req, res) => {
  const sessionId = parseCookie(req.headers.cookie, COOKIE_NAME);
  const session = sessionId ? validateSession(sessionId) : null;
  if (!session) return res.status(401).json({ error: 'unauthorized' });

  destroySession(sessionId);
  clearSessionCookie(req, res);
  res.json({ ok: true });
});

/** GET /api/auth/session */
router.get('/session', (req, res) => {
  const sessionId = parseCookie(req.headers.cookie, COOKIE_NAME);
  const session = sessionId ? validateSession(sessionId) : null;
  if (!session) return res.status(401).json({ error: 'unauthorized' });

  res.json({
    user: userPayload(session.user, session.grants),
    csrfToken: session.csrfToken,
  });
});

module.exports = router;
