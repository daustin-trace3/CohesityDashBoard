const express = require('express');
const rateLimit = require('express-rate-limit');
const db = require('../db');
const {
  hashPassword, verifyPassword, createSession, validateSession,
  destroySession, getClaimToken, toPublicUser,
} = require('../services/auth');
const { parseCookie, COOKIE_NAME } = require('../middleware/authenticate');

const router = express.Router();
const COOKIE_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;

const authLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 5,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many requests, please try again later.' },
});

function setSessionCookie(req, res, sessionId) {
  res.cookie(COOKIE_NAME, sessionId, {
    httpOnly: true,
    sameSite: 'lax',
    path: '/',
    secure: !!req.secure,
    maxAge: COOKIE_MAX_AGE_MS,
  });
}

router.get('/setup-status', (req, res) => {
  const count = db.prepare('SELECT COUNT(*) AS c FROM users').get().c;
  res.json({ needsSetup: count === 0 });
});

/** POST /setup { token, username, password } — creates the first portal admin. */
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

    const user = db.prepare('SELECT * FROM users WHERE id = ?').get(info.lastInsertRowid);
    const session = createSession(user.id);
    setSessionCookie(req, res, session.id);
    res.json({ user: toPublicUser(user) });
  } catch (err) {
    next(err);
  }
});

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
    res.json({ user: toPublicUser(user) });
  } catch (err) {
    next(err);
  }
});

router.post('/logout', (req, res) => {
  const sessionId = parseCookie(req.headers.cookie, COOKIE_NAME);
  const session = sessionId ? validateSession(sessionId) : null;
  if (!session) return res.status(401).json({ error: 'unauthorized' });
  destroySession(sessionId);
  res.clearCookie(COOKIE_NAME, { httpOnly: true, sameSite: 'lax', path: '/', secure: !!req.secure });
  res.json({ ok: true });
});

router.get('/session', (req, res) => {
  const sessionId = parseCookie(req.headers.cookie, COOKIE_NAME);
  const session = sessionId ? validateSession(sessionId) : null;
  if (!session) return res.status(401).json({ error: 'unauthorized' });
  res.json({ user: session.user, csrfToken: session.csrfToken });
});

module.exports = router;
