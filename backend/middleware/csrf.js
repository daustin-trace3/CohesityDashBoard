// CSRF check (contract C8.5): only applies to session-authenticated
// mutations. Service-account/env-key callers (kind !== 'session') never send
// a session cookie, so cross-site request forgery does not apply to them.
const crypto = require('crypto');

function sameToken(a, b) {
  const bufA = Buffer.from(a);
  const bufB = Buffer.from(b);
  return bufA.length === bufB.length && crypto.timingSafeEqual(bufA, bufB);
}

module.exports = function csrf(req, res, next) {
  if (!req.auth || req.auth.kind !== 'session') return next();
  if (req.method === 'GET' || req.method === 'HEAD' || req.method === 'OPTIONS') return next();

  const token = req.headers['x-csrf-token'];
  if (!token || !sameToken(String(token), String(req.auth.csrfToken || ''))) {
    return res.status(403).json({ error: 'csrf' });
  }
  next();
};
