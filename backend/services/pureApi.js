const axios = require('axios');
const https = require('https');
const crypto = require('crypto');
const { decrypt } = require('./encryption');

// Pure FlashArray REST 2.x client.
//
// Auth: OAuth2 JWT-bearer (API client). We sign a short-lived JWT with the
// array's RSA private key (RS256, kid = key_id), exchange it at
// /oauth2/1.0/token for a Bearer access token, then call /api/2.x/* with it.
//
// Access tokens are cached in-memory per array until shortly before expiry.
// The negotiated REST version is discovered once per array from /api/api_version.

const tokenCache = new Map();   // arrayId -> { token, expiresAt }
const versionCache = new Map(); // arrayId -> { version, expiresAt }

const TOKEN_SKEW_MS = 60 * 1000;          // refresh a minute early
const TOKEN_MAX_TTL_MS = 50 * 60 * 1000;  // never cache longer than 50 min
const VERSION_TTL_MS = 6 * 60 * 60 * 1000; // re-check supported version every 6h

function base64url(input) {
  const buf = Buffer.isBuffer(input) ? input : Buffer.from(String(input));
  return buf.toString('base64').replace(/=+$/, '').replace(/\+/g, '-').replace(/\//g, '_');
}

/** Normalize a user-entered host into an https origin with no trailing slash. */
function normalizeHost(host) {
  let h = String(host || '').trim().replace(/\/+$/, '');
  if (!/^https?:\/\//i.test(h)) h = `https://${h}`;
  return h;
}

function agentFor(array) {
  return new https.Agent({ rejectUnauthorized: !!array.ssl_verify });
}

/** Build and RS256-sign the JWT assertion used for the token exchange. */
function buildAssertion(array, privateKey) {
  const now = Math.floor(Date.now() / 1000);
  const header = { alg: 'RS256', typ: 'JWT', kid: array.key_id };
  const payload = {
    iss: array.issuer || array.client_id,
    aud: array.client_id,
    sub: array.username,
    iat: now,
    exp: now + 300, // assertion valid 5 min; the granted token lives longer
  };
  const signingInput = `${base64url(JSON.stringify(header))}.${base64url(JSON.stringify(payload))}`;
  const signer = crypto.createSign('RSA-SHA256');
  signer.update(signingInput);
  signer.end();
  const signature = signer.sign(privateKey);
  return `${signingInput}.${base64url(signature)}`;
}

function getCredentials(array) {
  return JSON.parse(decrypt(array.encrypted_credentials));
}

function getPrivateKey(array) {
  const creds = getCredentials(array);
  if (!creds.privateKey) {
    const err = new Error('No private key stored for this array');
    err.code = 'PURE_NO_KEY';
    throw err;
  }
  return creds.privateKey;
}

function getApiToken(array) {
  const creds = getCredentials(array);
  if (!creds.apiToken) {
    const err = new Error('No API token stored for this array');
    err.code = 'PURE_NO_TOKEN';
    throw err;
  }
  return creds.apiToken;
}

/** Exchange a signed JWT for a Bearer access token (cached per array). */
async function getAccessToken(array, { force = false } = {}) {
  if (!force) {
    const cached = tokenCache.get(array.id);
    if (cached && Date.now() < cached.expiresAt) return cached.token;
  }

  const privateKey = getPrivateKey(array);
  const assertion = buildAssertion(array, privateKey);
  const host = normalizeHost(array.mgmt_host);

  const body = new URLSearchParams({
    grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
    subject_token: assertion,
    subject_token_type: 'urn:ietf:params:oauth:token-type:jwt',
  });

  const resp = await axios.post(`${host}/oauth2/1.0/token`, body.toString(), {
    httpsAgent: agentFor(array),
    timeout: 30000,
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
  });

  const token = resp.data && resp.data.access_token;
  if (!token) {
    const err = new Error('Token endpoint returned no access_token');
    err.code = 'PURE_AUTH_FAILED';
    throw err;
  }

  // FlashArray reports expires_in in milliseconds; guard against seconds too.
  const rawExpiry = Number(resp.data.expires_in) || 0;
  const ttlMs = rawExpiry > 100000 ? rawExpiry : rawExpiry * 1000;
  const effectiveTtl = Math.min(ttlMs || TOKEN_MAX_TTL_MS, TOKEN_MAX_TTL_MS);
  tokenCache.set(array.id, { token, expiresAt: Date.now() + effectiveTtl - TOKEN_SKEW_MS });
  return token;
}

/**
 * Exchange a per-user API token for an x-auth-token session (cached per array).
 * Used by the simpler token-based auth method (no key pair).
 */
async function getSessionToken(array, { force = false } = {}) {
  if (!force) {
    const cached = tokenCache.get(array.id);
    if (cached && Date.now() < cached.expiresAt) return cached.token;
  }

  const apiToken = getApiToken(array);
  const version = await getApiVersion(array);
  const host = normalizeHost(array.mgmt_host);

  const resp = await axios.post(`${host}/api/${version}/login`, null, {
    httpsAgent: agentFor(array),
    timeout: 30000,
    headers: { 'api-token': apiToken },
  });

  const xauth = resp.headers['x-auth-token'];
  if (!xauth) {
    const err = new Error('Login endpoint returned no x-auth-token');
    err.code = 'PURE_AUTH_FAILED';
    throw err;
  }

  // Session tokens idle-expire (~30 min default on Purity); refresh at 25 min.
  tokenCache.set(array.id, { token: xauth, expiresAt: Date.now() + 25 * 60 * 1000 });
  return xauth;
}

/** Build the auth header for whichever method this array uses. */
async function authHeaders(array, { force = false } = {}) {
  if (array.auth_method === 'token') {
    const token = await getSessionToken(array, { force });
    return { 'x-auth-token': token };
  }
  const token = await getAccessToken(array, { force });
  return { Authorization: `Bearer ${token}` };
}

/** Discover the highest supported REST 2.x version for the array (cached). */
async function getApiVersion(array) {
  const cached = versionCache.get(array.id);
  if (cached && Date.now() < cached.expiresAt) return cached.version;

  const host = normalizeHost(array.mgmt_host);
  const resp = await axios.get(`${host}/api/api_version`, {
    httpsAgent: agentFor(array),
    timeout: 15000,
  });
  const versions = (resp.data && resp.data.version) || [];
  const v2 = versions
    .filter((v) => /^2\./.test(v))
    .sort((a, b) => parseFloat(a) - parseFloat(b));
  const version = v2.length ? v2[v2.length - 1] : '2.0';
  versionCache.set(array.id, { version, expiresAt: Date.now() + VERSION_TTL_MS });
  return version;
}

/** Authenticated GET against /api/<version><path>. Retries once on 401. */
async function apiGet(array, path, params, { _retry = false } = {}) {
  const headers = await authHeaders(array);
  const version = await getApiVersion(array);
  const host = normalizeHost(array.mgmt_host);
  try {
    const resp = await axios.get(`${host}/api/${version}${path}`, {
      httpsAgent: agentFor(array),
      timeout: 30000,
      params,
      headers,
    });
    return resp.data;
  } catch (err) {
    if (err?.response?.status === 401 && !_retry) {
      tokenCache.delete(array.id);
      const fresh = await authHeaders(array, { force: true });
      try {
        const resp = await axios.get(`${host}/api/${version}${path}`, {
          httpsAgent: agentFor(array),
          timeout: 30000,
          params,
          headers: fresh,
        });
        return resp.data;
      } catch (err2) {
        throw err2;
      }
    }
    throw err;
  }
}

// ── High-level fetchers ──────────────────────────────────────────────────────

/** Array-level capacity + performance (single object each). */
async function fetchArrayInfo(array) {
  const [arrays, perf] = await Promise.all([
    apiGet(array, '/arrays'),
    apiGet(array, '/arrays/performance').catch(() => ({ items: [] })),
  ]);
  return {
    info: (arrays.items && arrays.items[0]) || null,
    performance: (perf.items && perf.items[0]) || null,
  };
}

async function fetchAlerts(array) {
  const data = await apiGet(array, '/alerts', { filter: "state='open'", limit: 1000 });
  return data.items || [];
}

async function fetchVolumes(array) {
  const data = await apiGet(array, '/volumes', { limit: 5000, destroyed: false });
  return data.items || [];
}

async function fetchHosts(array) {
  const data = await apiGet(array, '/hosts', { limit: 5000 });
  return data.items || [];
}

/**
 * Validate connectivity + credentials. Returns a small summary on success.
 * Accepts a full array row (with encrypted_credentials) OR a transient object
 * carrying a raw `privateKey` / `apiToken` (used by the pre-save test flow).
 */
async function testConnection(array) {
  const probe = { ...array };

  if (!probe.encrypted_credentials) {
    const { encrypt } = require('./encryption');
    const creds = {};
    if (array.privateKey) creds.privateKey = array.privateKey;
    if (array.apiToken) creds.apiToken = array.apiToken;
    probe.encrypted_credentials = encrypt(JSON.stringify(creds));
    probe.id = probe.id || `probe-${Date.now()}`;
  }

  // Infer the method when the caller didn't state one explicitly.
  if (!probe.auth_method) probe.auth_method = array.apiToken ? 'token' : 'client';

  const version = await getApiVersion(probe);
  await authHeaders(probe, { force: true });
  const arrays = await apiGet(probe, '/arrays');
  const info = (arrays.items && arrays.items[0]) || {};

  // Don't leak a probe token in the cache under a fake id.
  if (String(probe.id).startsWith('probe-')) {
    tokenCache.delete(probe.id);
    versionCache.delete(probe.id);
  }

  return {
    ok: true,
    restVersion: version,
    arrayName: info.name || null,
    purityVersion: info.version || info.os || null,
  };
}

function invalidate(arrayId) {
  tokenCache.delete(arrayId);
  versionCache.delete(arrayId);
}

module.exports = {
  normalizeHost,
  getAccessToken,
  getSessionToken,
  getApiVersion,
  apiGet,
  fetchArrayInfo,
  fetchAlerts,
  fetchVolumes,
  fetchHosts,
  testConnection,
  invalidate,
};
