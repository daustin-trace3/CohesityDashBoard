const { isDemo } = require('../services/demoMode');

// Demo mode write lockdown. The public demo hands every visitor the shared
// admin login, so anything a write can reach, anyone on the internet can
// reach. Default-deny: in demo mode a mutating request is refused unless its
// path is one of the interactive surfaces a demo actually needs. What those
// writes change is wiped by the nightly baseline reset anyway; what this
// guard protects is the box itself: no credential or settings writes, no
// outbound connection targets (SMTP, custom AI endpoints, platform
// connection create/test = SSRF into the LAN), no account or tenant changes.
//
// Mounted after authenticate/csrf/demoPollGuard, and after tenantScope has
// stripped the /t/<tenant> prefix, so req.path here is tenant-free.
const WRITE_ALLOW = [
  /^\/auth\/(login|logout)$/,          // signing in and out
  /^\/app-services(\/|$)/,             // watch list, re-evaluate, catalog import
  /^\/ops-agent(\/|$)/,                // run now, retriage, resolve
  /^\/service-status(\/|$)/,           // per-alert analyze
  /\/(resolve|dismiss)$/,              // alert resolve/dismiss buttons
  /\/export(\.csv)?$/,                 // visible-rows exports POST their ids
];

function demoWriteGuard(req, res, next) {
  if (!isDemo()) return next();
  if (req.method === 'GET' || req.method === 'HEAD' || req.method === 'OPTIONS') return next();
  if (WRITE_ALLOW.some((re) => re.test(req.path))) return next();
  return res.status(403).json({
    demo: true,
    error: 'Demo mode: this change is disabled. The demo resets to its baseline nightly.',
  });
}

module.exports = demoWriteGuard;
