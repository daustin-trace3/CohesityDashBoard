// Authentication (contract C8.5): resolves req.auth from, in order, a valid
// `icc_session` cookie, the legacy env DASHBOARD_API_KEY (full access, kept
// for existing automation), or a scoped service_accounts key. Replaces the
// old blanket requireApiKey.
const crypto = require('crypto');
const db = require('../db/database');
const { validateSession } = require('../services/authService');
const { getLicenseStatus } = require('../services/license');
const { hasPermission } = require('../services/rbac');

function parseCookie(header, name) {
  if (!header) return null;
  const match = header.split(';').map((s) => s.trim()).find((s) => s.startsWith(`${name}=`));
  return match ? decodeURIComponent(match.slice(name.length + 1)) : null;
}

function timingSafeEqualStr(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  const bufA = Buffer.from(a);
  const bufB = Buffer.from(b);
  if (bufA.length !== bufB.length) return false;
  return crypto.timingSafeEqual(bufA, bufB);
}

/** Resolves an identity for the request, or null if none applies. */
function authenticateFromRequest(req) {
  const sessionId = parseCookie(req.headers.cookie, 'icc_session');
  if (sessionId) {
    const session = validateSession(sessionId);
    if (session) {
      return { kind: 'session', user: session.user, grants: session.grants, csrfToken: session.csrfToken };
    }
  }

  const apiKey = req.headers['x-api-key'];
  if (apiKey) {
    const expected = process.env.DASHBOARD_API_KEY;
    if (expected && timingSafeEqualStr(apiKey, expected)) {
      return { kind: 'service', name: 'legacy-env-key', grants: ['*:*:*'] };
    }

    const keyHash = crypto.createHash('sha256').update(apiKey).digest('hex');
    const row = db.prepare('SELECT * FROM service_accounts WHERE key_hash = ? AND is_active = 1').get(keyHash);
    if (row) {
      db.prepare('UPDATE service_accounts SET last_used_at = ? WHERE id = ?').run(new Date().toISOString(), row.id);
      let grants = [];
      try { grants = JSON.parse(row.permissions); } catch { grants = []; }
      return { kind: 'service', name: row.name, grants };
    }
  }

  return null;
}

/**
 * /api/auth/* is fully exempt — it handles its own session lookups for
 * /session and /logout. /api/license/* is exempt too (activation must work
 * pre-auth on a fresh, unlicensed install), EXCEPT a mutating request while
 * the product is actively licensed (valid/grace), which requires a real
 * identity with admin:license:manage.
 */
module.exports = function authenticate(req, res, next) {
  if (req.path === '/auth' || req.path.startsWith('/auth/')) return next();

  const isLicensePath = req.path === '/license' || req.path.startsWith('/license/');
  if (isLicensePath) {
    const mutating = req.method !== 'GET' && req.method !== 'HEAD' && req.method !== 'OPTIONS';
    const licensed = ['valid', 'grace'].includes(getLicenseStatus().state);
    if (!mutating || !licensed) return next();

    const auth = authenticateFromRequest(req);
    if (!auth) return res.status(401).json({ error: 'unauthorized' });
    if (!hasPermission(auth.grants, 'admin:license:manage')) {
      return res.status(403).json({ error: 'forbidden', required: 'admin:license:manage' });
    }
    req.auth = auth;
    return next();
  }

  const auth = authenticateFromRequest(req);
  if (!auth) return res.status(401).json({ error: 'unauthorized' });
  req.auth = auth;
  next();
};
