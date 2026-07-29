// Session gate for every /api route except /api/auth/*. Mutating requests
// must also present the session's CSRF token.
const { validateSession } = require('../services/auth');

function parseCookie(header, name) {
  if (!header) return null;
  const match = header.split(';').map((s) => s.trim()).find((s) => s.startsWith(`${name}=`));
  return match ? decodeURIComponent(match.slice(name.length + 1)) : null;
}

const COOKIE_NAME = 'icc_portal_session';

function authenticate(req, res, next) {
  const sessionId = parseCookie(req.headers.cookie, COOKIE_NAME);
  const session = sessionId ? validateSession(sessionId) : null;
  if (!session) return res.status(401).json({ error: 'unauthorized' });

  if (!['GET', 'HEAD', 'OPTIONS'].includes(req.method) && req.headers['x-csrf-token'] !== session.csrfToken) {
    return res.status(403).json({ error: 'csrf' });
  }

  req.user = session.user;
  next();
}

module.exports = { authenticate, parseCookie, COOKIE_NAME };
