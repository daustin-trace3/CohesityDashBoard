// RBAC enforcement middleware (contract C8.5): a factory that checks
// req.auth.grants (set by middleware/authenticate.js) against a required
// permission string, plus the standard platformPermission(ns) mapping used
// by the plugin dispatcher and simple platform mounts.
const { hasPermission } = require('../services/rbac');

/**
 * @param {string | ((req: import('express').Request) => string)} nsOrFn
 *   Either a fixed permission string or a function that computes one from
 *   the request (e.g. to vary by method or route param).
 */
function requirePermission(nsOrFn) {
  return (req, res, next) => {
    const required = typeof nsOrFn === 'function' ? nsOrFn(req) : nsOrFn;
    const grants = (req.auth && req.auth.grants) || [];
    if (!hasPermission(grants, required)) {
      return res.status(403).json({ error: 'forbidden', required });
    }
    next();
  };
}

/**
 * Standard mapping: `<ns>:<firstPathSegment>:<view|manage>`, GET is view,
 * everything else is manage. `ns` may itself be a function of req (e.g. the
 * dispatcher passes req.params.pluginId).
 * @param {string | ((req: import('express').Request) => string)} nsOrFn
 */
function platformPermission(nsOrFn) {
  return (req) => {
    const ns = typeof nsOrFn === 'function' ? nsOrFn(req) : nsOrFn;
    const section = req.path.split('/').filter(Boolean)[0] || '*';
    const level = req.method === 'GET' ? 'view' : 'manage';
    return `${ns}:${section}:${level}`;
  };
}

module.exports = { requirePermission, platformPermission };
