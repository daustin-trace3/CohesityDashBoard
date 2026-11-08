// Public address of this ICC as the browser (and an identity provider) sees it.
// icc_base_url wins; otherwise the address is rebuilt from the request, which
// is only right when no proxy rewrites the host (callers flag that case).
const { getIccBaseUrl } = require('../services/settings');

function firstOf(v) {
  return String(v || '').split(',')[0].trim();
}

/** { base, fromRequest } - base has no trailing slash. */
function publicBase(req) {
  const configured = getIccBaseUrl();
  if (configured) return { base: configured, fromRequest: false };
  const proto = firstOf(req && req.headers && req.headers['x-forwarded-proto']) || (req && req.protocol) || 'http';
  const host = firstOf(req && req.headers && req.headers['x-forwarded-host']) || (req && req.get && req.get('host')) || 'localhost';
  return { base: `${proto}://${host}`, fromRequest: true };
}

/** API prefix the identity provider is sent to. */
function apiPrefix() {
  return '/api';
}

/** Browser path prefix for redirects after sign-in (none on this branch). */
function browserPrefix() {
  return '';
}

module.exports = { publicBase, apiPrefix, browserPrefix };
