// OpenID Connect authorization-code flow with PKCE (Okta and any compliant IdP).
// All outbound HTTP goes through http() so tests can serve discovery, JWKS and
// the token endpoint without a network. Errors carry an sso_* code that the
// router turns into ?error=<code> on the login page.
const crypto = require('crypto');
const axios = require('axios');
const jose = require('jose');
const db = require('../db/database');
const idpProviders = require('./idpProviders');

const DISCOVERY_TTL_MS = 24 * 60 * 60 * 1000;

class SsoError extends Error {
  constructor(code, detail) {
    super(detail || code);
    this.code = code;
    this.detail = detail || code;
  }
}

let httpFn = (opts) => axios({
  method: opts.method || 'GET',
  url: opts.url,
  headers: opts.headers,
  data: opts.data,
  timeout: opts.timeout || 10000,
  validateStatus: () => true,
  maxRedirects: 0,
  proxy: false,
}).then((r) => ({ status: r.status, headers: r.headers, data: r.data }));

function setHttp(fn) { httpFn = fn || httpFn; }
function http(opts) { return httpFn({ timeout: 10000, ...opts }); }

/** Network-level failure -> sso_unavailable. */
async function call(opts) {
  try {
    return await http(opts);
  } catch (err) {
    throw new SsoError('sso_unavailable', `${opts.method || 'GET'} ${opts.url} failed: ${err.message}`);
  }
}

const trimSlash = (s) => String(s || '').replace(/\/+$/, '');
const b64url = (buf) => buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

function okEndpoint(value) {
  try {
    const u = new URL(value);
    return u.protocol === 'https:' || (u.protocol === 'http:' && (u.hostname === '127.0.0.1' || u.hostname === 'localhost'));
  } catch { return false; }
}

/* ----------------------------------------------------------------------- */
/* Discovery                                                               */
/* ----------------------------------------------------------------------- */

async function discover(row, { force = false } = {}) {
  if (!force && row.discovery_json && row.discovery_at && Date.now() - Date.parse(row.discovery_at) < DISCOVERY_TTL_MS) {
    try { return JSON.parse(row.discovery_json); } catch { /* refetch */ }
  }
  if (!row.issuer) throw new SsoError('sso_provider', 'No issuer configured.');
  const url = `${trimSlash(row.issuer)}/.well-known/openid-configuration`;
  const res = await call({ method: 'GET', url, headers: { Accept: 'application/json' } });
  if (res.status !== 200 || !res.data || typeof res.data !== 'object') {
    throw new SsoError('sso_unavailable', `Discovery ${url} answered HTTP ${res.status}.`);
  }
  const doc = res.data;
  if (trimSlash(doc.issuer) !== trimSlash(row.issuer)) {
    throw new SsoError('sso_provider', `Discovery issuer "${doc.issuer}" does not match the configured issuer.`);
  }
  for (const k of ['authorization_endpoint', 'token_endpoint', 'jwks_uri']) {
    if (!doc[k]) throw new SsoError('sso_provider', `Discovery document has no ${k}.`);
    if (!okEndpoint(doc[k])) throw new SsoError('sso_provider', `Discovery ${k} is not an https URL.`);
  }
  if (doc.userinfo_endpoint && !okEndpoint(doc.userinfo_endpoint)) delete doc.userinfo_endpoint;
  if (row.id) {
    db.prepare('UPDATE idp_providers SET discovery_json = ?, discovery_at = ? WHERE id = ?')
      .run(JSON.stringify(doc), new Date().toISOString(), row.id);
  }
  return doc;
}

/* ----------------------------------------------------------------------- */
/* Authorization request                                                   */
/* ----------------------------------------------------------------------- */

/** Fresh nonce + PKCE verifier; the router stores them in the state row. */
function newAuthParams() {
  return { nonce: crypto.randomBytes(16).toString('hex'), codeVerifier: b64url(crypto.randomBytes(32)) };
}

/** `state` is the idp_auth_state id. Pass params from newAuthParams() when the state row already holds them. */
async function authorizationUrl(row, urls, state, params) {
  const disc = await discover(row);
  const { nonce, codeVerifier } = params || newAuthParams();
  const challenge = b64url(crypto.createHash('sha256').update(codeVerifier).digest());
  const u = new URL(disc.authorization_endpoint);
  const q = {
    response_type: 'code', client_id: row.client_id, redirect_uri: urls.redirectUri,
    scope: row.scopes || 'openid profile email groups', state, nonce,
    code_challenge: challenge, code_challenge_method: 'S256',
  };
  for (const [k, v] of Object.entries(q)) u.searchParams.set(k, v);
  return { url: u.toString(), nonce, codeVerifier };
}

/* ----------------------------------------------------------------------- */
/* Token exchange and verification                                         */
/* ----------------------------------------------------------------------- */

async function exchangeCode(row, urls, code, codeVerifier) {
  const disc = await discover(row);
  const secret = idpProviders.getSecret(row, 'client_secret');
  const basic = Buffer.from(`${encodeURIComponent(row.client_id)}:${encodeURIComponent(secret)}`).toString('base64');
  const form = new URLSearchParams({
    grant_type: 'authorization_code', code, redirect_uri: urls.redirectUri, code_verifier: codeVerifier,
  }).toString();
  const res = await call({
    method: 'POST', url: disc.token_endpoint, data: form,
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json', Authorization: `Basic ${basic}` },
  });
  if (res.status < 200 || res.status >= 300 || !res.data || typeof res.data !== 'object') {
    const why = res.data && res.data.error ? `${res.data.error}${res.data.error_description ? `: ${res.data.error_description}` : ''}` : `HTTP ${res.status}`;
    throw new SsoError('sso_token', `Token endpoint refused the code (${why}).`);
  }
  if (!res.data.id_token) throw new SsoError('sso_token', 'Token response has no id_token.');
  return res.data;
}

async function fetchJwks(discovery) {
  const res = await call({ method: 'GET', url: discovery.jwks_uri, headers: { Accept: 'application/json' } });
  if (res.status !== 200 || !res.data || !Array.isArray(res.data.keys)) {
    throw new SsoError('sso_unavailable', `JWKS ${discovery.jwks_uri} answered HTTP ${res.status}.`);
  }
  return res.data;
}

async function verifyIdToken(row, discovery, idToken, nonce) {
  const jwks = await fetchJwks(discovery);
  let payload;
  try {
    const keySet = jose.createLocalJWKSet(jwks);
    ({ payload } = await jose.jwtVerify(idToken, keySet, {
      issuer: row.issuer, audience: row.client_id, algorithms: ['RS256'], clockTolerance: 60,
    }));
  } catch (err) {
    throw new SsoError('sso_idtoken', `ID token rejected: ${err.code || err.message}`);
  }
  if (!nonce || payload.nonce !== nonce) throw new SsoError('sso_idtoken', 'ID token nonce does not match.');
  return payload;
}

async function userinfo(discovery, accessToken) {
  if (!discovery.userinfo_endpoint) return {};
  const res = await call({
    method: 'GET', url: discovery.userinfo_endpoint,
    headers: { Authorization: `Bearer ${accessToken}`, Accept: 'application/json' },
  });
  if (res.status !== 200 || !res.data || typeof res.data !== 'object') {
    throw new SsoError('sso_token', `Userinfo answered HTTP ${res.status}.`);
  }
  return res.data;
}

/* ----------------------------------------------------------------------- */
/* Identity                                                                */
/* ----------------------------------------------------------------------- */

function asStrings(v) {
  if (v == null) return [];
  return (Array.isArray(v) ? v : [v]).map((x) => String(x)).filter(Boolean);
}

function mapIdentity(row, claims) {
  const subject = claims[row.claim_subject || 'sub'];
  const email = claims[row.claim_email || 'email'] || null;
  return {
    subject: subject == null ? '' : String(subject),
    email: email ? String(email) : null,
    username: claims.preferred_username ? String(claims.preferred_username) : (email ? String(email) : null),
    displayName: claims[row.claim_name || 'name'] ? String(claims[row.claim_name || 'name']) : null,
    groups: asStrings(claims[row.claim_groups || 'groups']),
    groupIds: [],
    active: true,
  };
}

/** Callback after the IdP redirect: code in, verified identity out. `stateRow` is the consumed state. */
async function handleCallback(row, urls, code, stateRow) {
  const disc = await discover(row);
  const tokens = await exchangeCode(row, urls, code, stateRow.code_verifier);
  const claims = await verifyIdToken(row, disc, tokens.id_token, stateRow.nonce);
  const groupClaim = row.claim_groups || 'groups';
  if (claims[groupClaim] === undefined && tokens.access_token) {
    try {
      const extra = await userinfo(disc, tokens.access_token);
      for (const [k, v] of Object.entries(extra)) if (claims[k] === undefined) claims[k] = v;
    } catch (err) {
      if (err.code === 'sso_unavailable') throw err;
      // A refused userinfo call leaves the identity without groups: access decides.
    }
  }
  const identity = mapIdentity(row, claims);
  if (!identity.subject) throw new SsoError('sso_idtoken', `ID token has no "${row.claim_subject || 'sub'}" claim.`);
  return identity;
}

/* ----------------------------------------------------------------------- */
/* Test                                                                    */
/* ----------------------------------------------------------------------- */

async function testProvider(row) {
  const checks = [];
  const add = (name, ok, detail) => checks.push({ name, ok: !!ok, detail });
  add('Client ID', !!row.client_id, row.client_id ? 'Present.' : 'No client ID saved.');
  add('Client secret', !!idpProviders.getSecret(row, 'client_secret'), row.client_secret ? 'Saved.' : 'No client secret saved.');
  let disc = null;
  try {
    disc = await discover(row, { force: true });
    add('Discovery', true, `Issuer matches; authorization and token endpoints found.`);
  } catch (err) {
    add('Discovery', false, err.detail || err.message);
  }
  if (disc) {
    try {
      const jwks = await fetchJwks(disc);
      add('Signing keys', jwks.keys.length > 0, `${jwks.keys.length} key(s) at the JWKS address.`);
    } catch (err) {
      add('Signing keys', false, err.detail || err.message);
    }
  }
  return { ok: checks.every((c) => c.ok), checks };
}

module.exports = {
  SsoError, setHttp, http, discover, newAuthParams, authorizationUrl, exchangeCode,
  verifyIdToken, userinfo, mapIdentity, handleCallback, testProvider,
};
