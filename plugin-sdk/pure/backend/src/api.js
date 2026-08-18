// Pure FlashArray REST 2.x client (direct-connect arrays).
//
// Auth: OAuth2 JWT-bearer (API client method) — sign a short-lived JWT with
// the array's RSA private key (RS256, kid = key_id), exchange it at
// /oauth2/1.0/token for a Bearer access token, then call /api/2.x/* with it.
// A simpler per-user API-token method exchanges an api-token header for an
// x-auth-token session at /api/<version>/login instead.
//
// Access tokens are cached in-memory per array until shortly before expiry.
// The negotiated REST version is discovered once per array from
// /api/api_version.
//
// Ported from backend/services/pureApi.js.
//
// DEVIATION FROM THE BUILT-IN: the original uses axios, which is not
// available to a bundled plugin (esbuild has no axios to bundle from
// plugin-sdk's dependency tree). Re-implemented on Node's built-in `https`
// module (dell/zerto plugin-sdk api.js rawRequest pattern). Every function
// now threads `coreApi` through for decrypt instead of requiring
// services/encryption directly. RSA JWT signing still uses node's built-in
// `crypto` module (unaffected — always available). Behavior preserved
// verbatim: token caching TTLs, OData-flavored REST 2.x calls, 401 retry,
// ssl_verify -> rejectUnauthorized.
const https = require('https');
const crypto = require('crypto');
const { URLSearchParams } = require('url');

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

/** Raw HTTPS call against a Pure array/Pure1. Resolves with { status, data,
 *  headers }. Rejects with an Error carrying `.response = { status, data, headers }`. */
function rawRequest(hostOrOrigin, { method = 'GET', path, params, data, headers = {}, timeout = 30000, rejectUnauthorized = true, form = false } = {}) {
  return new Promise((resolve, reject) => {
    const url = new URL(path, hostOrOrigin);
    if (params) {
      for (const [k, v] of Object.entries(params)) {
        if (v !== undefined && v !== null) url.searchParams.set(k, String(v));
      }
    }
    let body;
    const reqHeaders = { ...headers };
    if (form && data) {
      body = new URLSearchParams(data).toString();
      reqHeaders['Content-Type'] = 'application/x-www-form-urlencoded';
      reqHeaders['Content-Length'] = Buffer.byteLength(body);
    } else if (data !== undefined) {
      body = JSON.stringify(data);
      reqHeaders['Content-Type'] = 'application/json';
      reqHeaders['Content-Length'] = Buffer.byteLength(body);
    }

    const req = https.request(url, { method, timeout, rejectUnauthorized, headers: reqHeaders }, (res) => {
      const chunks = [];
      res.on('data', (chunk) => chunks.push(chunk));
      res.on('end', () => {
        const raw = Buffer.concat(chunks);
        const status = res.statusCode;
        const str = raw.toString('utf8');
        let payload;
        try { payload = str ? JSON.parse(str) : null; } catch { payload = str || null; }
        if (status >= 200 && status < 300) {
          resolve({ status, data: payload, headers: res.headers });
          return;
        }
        const e = new Error(`HTTP ${status}`);
        e.response = { status, data: payload, headers: res.headers };
        reject(e);
      });
    });
    req.on('timeout', () => { req.destroy(); reject(new Error('Request timed out')); });
    req.on('error', (err) => reject(err));
    if (body !== undefined) req.write(body);
    req.end();
  });
}

function agentOpts(array) {
  return { rejectUnauthorized: !!array.ssl_verify };
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

function getCredentials(array, coreApi) {
  return JSON.parse(coreApi.encryption.decrypt(array.encrypted_credentials));
}

function getPrivateKey(array, coreApi) {
  const creds = getCredentials(array, coreApi);
  if (!creds.privateKey) {
    const err = new Error('No private key stored for this array');
    err.code = 'PURE_NO_KEY';
    throw err;
  }
  return creds.privateKey;
}

function getApiToken(array, coreApi) {
  const creds = getCredentials(array, coreApi);
  if (!creds.apiToken) {
    const err = new Error('No API token stored for this array');
    err.code = 'PURE_NO_TOKEN';
    throw err;
  }
  return creds.apiToken;
}

/** Exchange a signed JWT for a Bearer access token (cached per array). */
async function getAccessToken(array, coreApi, { force = false } = {}) {
  if (!force) {
    const cached = tokenCache.get(array.id);
    if (cached && Date.now() < cached.expiresAt) return cached.token;
  }

  const privateKey = getPrivateKey(array, coreApi);
  const assertion = buildAssertion(array, privateKey);
  const host = normalizeHost(array.mgmt_host);

  const resp = await rawRequest(host, {
    method: 'POST', path: '/oauth2/1.0/token', timeout: 30000, rejectUnauthorized: !!array.ssl_verify, form: true,
    data: {
      grant_type: 'urn:ietf:params:oauth:grant-type:token-exchange',
      subject_token: assertion,
      subject_token_type: 'urn:ietf:params:oauth:token-type:jwt',
    },
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
async function getSessionToken(array, coreApi, { force = false } = {}) {
  if (!force) {
    const cached = tokenCache.get(array.id);
    if (cached && Date.now() < cached.expiresAt) return cached.token;
  }

  const apiToken = getApiToken(array, coreApi);
  const version = await getApiVersion(array);
  const host = normalizeHost(array.mgmt_host);

  const resp = await rawRequest(host, {
    method: 'POST', path: `/api/${version}/login`, timeout: 30000, rejectUnauthorized: !!array.ssl_verify,
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
async function authHeaders(array, coreApi, { force = false } = {}) {
  if (array.auth_method === 'token') {
    const token = await getSessionToken(array, coreApi, { force });
    return { 'x-auth-token': token };
  }
  const token = await getAccessToken(array, coreApi, { force });
  return { Authorization: `Bearer ${token}` };
}

/** Discover the highest supported REST 2.x version for the array (cached). */
async function getApiVersion(array) {
  const cached = versionCache.get(array.id);
  if (cached && Date.now() < cached.expiresAt) return cached.version;

  const host = normalizeHost(array.mgmt_host);
  const resp = await rawRequest(host, {
    method: 'GET', path: '/api/api_version', timeout: 15000, rejectUnauthorized: !!array.ssl_verify,
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
async function apiGet(array, coreApi, path, params, { _retry = false } = {}) {
  const headers = await authHeaders(array, coreApi);
  const version = await getApiVersion(array);
  const host = normalizeHost(array.mgmt_host);
  try {
    const resp = await rawRequest(host, {
      method: 'GET', path: `/api/${version}${path}`, params, headers,
      timeout: 30000, rejectUnauthorized: !!array.ssl_verify,
    });
    return resp.data;
  } catch (err) {
    if (err?.response?.status === 401 && !_retry) {
      tokenCache.delete(array.id);
      const fresh = await authHeaders(array, coreApi, { force: true });
      const resp = await rawRequest(host, {
        method: 'GET', path: `/api/${version}${path}`, params, headers: fresh,
        timeout: 30000, rejectUnauthorized: !!array.ssl_verify,
      });
      return resp.data;
    }
    throw err;
  }
}

// ── High-level fetchers ──────────────────────────────────────────────────────

/** Array-level capacity + performance (single object each). */
async function fetchArrayInfo(array, coreApi) {
  const [arrays, perf] = await Promise.all([
    apiGet(array, coreApi, '/arrays'),
    apiGet(array, coreApi, '/arrays/performance').catch(() => ({ items: [] })),
  ]);
  return {
    info: (arrays.items && arrays.items[0]) || null,
    performance: (perf.items && perf.items[0]) || null,
  };
}

async function fetchAlerts(array, coreApi) {
  const data = await apiGet(array, coreApi, '/alerts', { filter: "state='open'", limit: 1000 });
  return data.items || [];
}

async function fetchVolumes(array, coreApi) {
  const data = await apiGet(array, coreApi, '/volumes', { limit: 5000, destroyed: false });
  return data.items || [];
}

async function fetchHosts(array, coreApi) {
  const data = await apiGet(array, coreApi, '/hosts', { limit: 5000 });
  return data.items || [];
}

/** Per-volume real-time performance (IOPS/latency/bandwidth). */
async function fetchVolumesPerformance(array, coreApi) {
  const data = await apiGet(array, coreApi, '/volumes/performance', { limit: 5000 });
  return data.items || [];
}

/** Replication partners (array-connections). */
async function fetchArrayConnections(array, coreApi) {
  const data = await apiGet(array, coreApi, '/array-connections', { limit: 1000 });
  return data.items || [];
}

/** Protection groups (snapshot/replication policy). */
async function fetchProtectionGroups(array, coreApi) {
  const data = await apiGet(array, coreApi, '/protection-groups', { limit: 2000, destroyed: false });
  return data.items || [];
}

/** Hardware components (controllers, fans, PSUs, bays, temps). */
async function fetchHardware(array, coreApi) {
  const data = await apiGet(array, coreApi, '/hardware', { limit: 5000 });
  return data.items || [];
}

/** Physical drives inventory. */
async function fetchDrives(array, coreApi) {
  const data = await apiGet(array, coreApi, '/drives', { limit: 5000 });
  return data.items || [];
}

/** Controllers (model, mode, Purity version, status). */
async function fetchControllers(array, coreApi) {
  const data = await apiGet(array, coreApi, '/controllers', { limit: 100 });
  return data.items || [];
}

/** SSL certificates (subject, key size, validity window). */
async function fetchCertificates(array, coreApi) {
  const data = await apiGet(array, coreApi, '/certificates', { limit: 100 });
  return data.items || [];
}

/** Network interfaces (eth/fc, virtual + physical). */
async function fetchNetworkInterfaces(array, coreApi) {
  const data = await apiGet(array, coreApi, '/network-interfaces', { limit: 1000 });
  return data.items || [];
}

/** Physical ports (FC WWN / iSCSI IQN / NVMe NQN). */
async function fetchPorts(array, coreApi) {
  const data = await apiGet(array, coreApi, '/ports', { limit: 1000 });
  return data.items || [];
}

/** Volume-to-host LUN connections. */
async function fetchConnections(array, coreApi) {
  const data = await apiGet(array, coreApi, '/connections', { limit: 5000 });
  return data.items || [];
}

/** Pods (ActiveCluster stretched storage / DR). */
async function fetchPods(array, coreApi) {
  const data = await apiGet(array, coreApi, '/pods', { limit: 1000, destroyed: false });
  return data.items || [];
}

/**
 * Validate connectivity + credentials. Returns a small summary on success.
 * Accepts a full array row (with encrypted_credentials) OR a transient object
 * carrying a raw `privateKey` / `apiToken` (used by the pre-save test flow).
 */
async function testConnection(array, coreApi) {
  const probe = { ...array };

  if (!probe.encrypted_credentials) {
    const creds = {};
    if (array.privateKey) creds.privateKey = array.privateKey;
    if (array.apiToken) creds.apiToken = array.apiToken;
    probe.encrypted_credentials = coreApi.encryption.encrypt(JSON.stringify(creds));
    probe.id = probe.id || `probe-${Date.now()}`;
  }

  // Infer the method when the caller didn't state one explicitly.
  if (!probe.auth_method) probe.auth_method = array.apiToken ? 'token' : 'client';

  const version = await getApiVersion(probe);
  await authHeaders(probe, coreApi, { force: true });
  const arrays = await apiGet(probe, coreApi, '/arrays');
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
  fetchVolumesPerformance,
  fetchArrayConnections,
  fetchProtectionGroups,
  fetchHardware,
  fetchDrives,
  fetchControllers,
  fetchCertificates,
  fetchNetworkInterfaces,
  fetchPorts,
  fetchConnections,
  fetchPods,
  testConnection,
  invalidate,
  rawRequest,
};
