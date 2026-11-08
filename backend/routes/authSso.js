// Single sign-on entry points (OIDC authorization code, SAML 2.0 Web SSO),
// mounted at /api/auth/sso. Public like the rest of /api/auth: the IdP's
// browser redirect lands here before any session exists. Every failure ends
// as a 302 to the login page with ?error=<sso_* code>; the code is logged
// and logged, the browser sees nothing else.
const express = require('express');
const logger = require('../utils/logger');
const rateLimit = require('express-rate-limit');
const { finishLogin } = require('./auth');
const idpProviders = require('../services/idpProviders');
const idpProvision = require('../services/idpProvision');
const idpOidc = require('../services/idpOidc');
const { browserPrefix } = require('../utils/publicUrl');

const router = express.Router();

// 30/min/IP: every SSO sign-in is two or three hits (start, IdP round trip,
// callback or ACS) and a team behind one NAT shares an address, so the 5/min
// password limiter would lock them out after two logins. Brute force is not
// the threat here (the IdP holds the password); state and nonce are.
const ssoLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 30,
  skip: () => process.env.DASHBOARD_TEST_NO_RATELIMIT === '1',
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many requests, please try again later.' },
});

const DENIED_CODE = { no_access: 'sso_no_access', inactive: 'sso_inactive', jit_disabled: 'sso_jit_disabled' };

const stateStore = {
  setRequestId: (stateId, requestId) => idpProviders.setStateRequestId(stateId, requestId),
  getByRequestId: (requestId) => idpProviders.getStateByRequestId(requestId),
  consume: (stateId) => idpProviders.consumeState(stateId),
};

function saml() {
  return require('../services/idpSaml');
}

function failTo(res, slug, code, detail) {
  logger.warn(`[sso] ${slug} ${code}: ${detail || code}`);
  logger.info(`[idp] login.failed provider=${slug} code=${code}`);
  return res.redirect(302, `${browserPrefix()}/login?error=${encodeURIComponent(code)}`);
}

function codeOf(err) {
  const c = err && (err.sso || err.code);
  return typeof c === 'string' && c.startsWith('sso_') ? c : 'sso_unavailable';
}

function findEnabled(req, res) {
  const provider = idpProviders.getProviderBySlug(req.params.slug);
  if (!provider || !provider.enabled) {
    res.status(404).json({ error: 'sso_provider' });
    return null;
  }
  return provider;
}

/** Provision, open the session and send the browser on to where it was going. */
function complete(req, res, provider, identity, returnTo) {
  const result = idpProvision.provisionLogin(provider, identity);
  if (result.denied) return failTo(res, provider.slug, DENIED_CODE[result.denied] || 'sso_no_access', `denied (${result.denied}) for ${identity.username || identity.email || identity.subject}`);
  finishLogin(req, res, result.user, { idp: provider.slug });
  return res.redirect(302, `${browserPrefix()}${idpProviders.sanitizeReturnTo(returnTo)}`);
}

router.get('/:slug/start', ssoLimiter, async (req, res) => {
  const provider = findEnabled(req, res);
  if (!provider) return undefined;
  const urls = idpProviders.publicUrls(req, provider);
  const returnTo = idpProviders.sanitizeReturnTo(req.query.returnTo);
  try {
    if (provider.type === 'oidc') {
      const params = idpOidc.newAuthParams();
      const stateId = idpProviders.createState({ providerId: provider.id, kind: 'oidc', nonce: params.nonce, codeVerifier: params.codeVerifier, returnTo });
      const { url } = await idpOidc.authorizationUrl(provider, urls, stateId, params);
      return res.redirect(302, url);
    }
    const stateId = idpProviders.createState({ providerId: provider.id, kind: 'saml', returnTo });
    const url = await saml().authorizeUrl(provider, urls, idpProviders.getSecret, stateStore, stateId);
    return res.redirect(302, url);
  } catch (err) {
    return failTo(res, provider.slug, codeOf(err), `start failed: ${err.message}`);
  }
});

router.get('/:slug/callback', ssoLimiter, async (req, res) => {
  const provider = findEnabled(req, res);
  if (!provider || provider.type !== 'oidc') return provider ? res.status(404).json({ error: 'sso_provider' }) : undefined;
  const q = req.query || {};
  if (q.error) return failTo(res, provider.slug, 'sso_token', `IdP returned error ${q.error}${q.error_description ? `: ${q.error_description}` : ''}`);
  const state = idpProviders.consumeState(typeof q.state === 'string' ? q.state : '');
  if (!state || state.kind !== 'oidc' || state.provider_id !== provider.id) {
    return failTo(res, provider.slug, 'sso_state', 'missing, expired or foreign state');
  }
  if (typeof q.code !== 'string' || !q.code) return failTo(res, provider.slug, 'sso_token', 'callback carried no code');
  try {
    const urls = idpProviders.publicUrls(req, provider);
    const identity = await idpOidc.handleCallback(provider, urls, q.code, state);
    return complete(req, res, provider, identity, state.return_to);
  } catch (err) {
    return failTo(res, provider.slug, codeOf(err), err.detail || err.message);
  }
});

router.post('/:slug/acs', express.urlencoded({ extended: false, limit: '256kb' }), ssoLimiter, async (req, res) => {
  const provider = findEnabled(req, res);
  if (!provider || provider.type !== 'saml') return provider ? res.status(404).json({ error: 'sso_provider' }) : undefined;
  try {
    const urls = idpProviders.publicUrls(req, provider);
    const out = await saml().validateAcs(provider, urls, idpProviders.getSecret, stateStore, req.body || {});
    const returnTo = out.state ? out.state.return_to : '/';
    return complete(req, res, provider, out.identity, returnTo);
  } catch (err) {
    return failTo(res, provider.slug, codeOf(err), err.message);
  }
});

router.get('/:slug/metadata', ssoLimiter, (req, res) => {
  const provider = idpProviders.getProviderBySlug(req.params.slug);
  if (!provider || provider.type !== 'saml') return res.status(404).json({ error: 'sso_provider' });
  try {
    const urls = idpProviders.publicUrls(req, provider);
    res.type('application/xml').send(saml().spMetadata(provider, urls, idpProviders.getSecret));
  } catch (err) {
    logger.warn(`[sso] ${provider.slug} metadata failed: ${err.message}`);
    res.status(500).json({ error: 'metadata_failed' });
  }
});

module.exports = router;
