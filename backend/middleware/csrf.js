// CSRF check (contract C8.5): only applies to session-authenticated
// mutations. Service-account/env-key callers (kind !== 'session') never send
// a session cookie, so cross-site request forgery does not apply to them.
module.exports = function csrf(req, res, next) {
  if (!req.auth || req.auth.kind !== 'session') return next();
  if (req.method === 'GET' || req.method === 'HEAD' || req.method === 'OPTIONS') return next();

  const token = req.headers['x-csrf-token'];
  if (!token || token !== req.auth.csrfToken) {
    return res.status(403).json({ error: 'csrf' });
  }
  next();
};
