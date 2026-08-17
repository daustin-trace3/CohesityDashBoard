// Zerto Analytics SaaS API client (analytics.api.zerto.com, spec at
// docs.api.zerto.com). One account-wide credential: myZerto username/password
// exchanged at POST /v2/auth/token for a Bearer JWT used on every other call.
//
// Ported from backend/services/zertoApi.js.
//
// DEVIATION FROM THE BUILT-IN: the original uses axios, which is not
// available to a bundled plugin (esbuild has no axios to bundle from
// plugin-sdk's dependency tree). Re-implemented on Node's built-in `https`
// module (dell/unifi plugin-sdk api.js rawRequest pattern). Every function
// now threads `coreApi` through for settings/decrypt instead of requiring
// host modules (services/settings, services/encryption) directly. Behavior
// preserved verbatim: Bearer JWT cached ~45 min, re-auth once on 401, and the
// same testConnection() contract.
const https = require('https');

const DEFAULT_BASE_URL = 'https://analytics.api.zerto.com';
// The JWT lifetime is not documented; cache conservatively and re-auth on 401.
const TOKEN_TTL_MS = 45 * 60 * 1000;

let cachedToken = null; // { token, fetchedAt, username }

function getZertoConfig(coreApi) {
  const settings = coreApi.settings;
  const username = settings.getSetting('zerto_username') || process.env.ZERTO_USERNAME || '';
  let password = '';
  const stored = settings.getSetting('zerto_password');
  if (stored) {
    try { password = coreApi.encryption.decrypt(stored); } catch { password = ''; }
  }
  if (!password) password = process.env.ZERTO_PASSWORD || '';
  const baseUrl = (settings.getSetting('zerto_base_url') || DEFAULT_BASE_URL).replace(/\/+$/, '');
  return { username, password, baseUrl };
}

function zertoConfigured(coreApi) {
  const { username, password } = getZertoConfig(coreApi);
  return !!(username && password);
}

/** Raw HTTPS call against the Zerto Analytics SaaS API. Resolves with
 *  { status, data, headers }. Rejects with an Error carrying
 *  `.response = { status, data, headers }`. */
function rawRequest(baseUrl, { method = 'GET', path, params, data, headers = {}, timeout = 60000 } = {}) {
  return new Promise((resolve, reject) => {
    const url = new URL(path, baseUrl);
    if (params) {
      for (const [k, v] of Object.entries(params)) {
        if (v !== undefined && v !== null) url.searchParams.set(k, String(v));
      }
    }
    const body = data !== undefined ? JSON.stringify(data) : undefined;
    const reqHeaders = { ...headers };
    if (body !== undefined) {
      reqHeaders['Content-Type'] = 'application/json';
      reqHeaders['Content-Length'] = Buffer.byteLength(body);
    }

    const req = https.request(url, { method, timeout, headers: reqHeaders }, (res) => {
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

async function fetchToken(cfg) {
  const { data } = await rawRequest(cfg.baseUrl, {
    method: 'POST',
    path: '/v2/auth/token',
    data: { username: cfg.username, password: cfg.password },
  });
  if (!data?.token) throw new Error('Zerto auth succeeded but returned no token');
  return data.token;
}

async function getToken(cfg, force = false) {
  const fresh = cachedToken
    && cachedToken.username === cfg.username
    && (Date.now() - cachedToken.fetchedAt) < TOKEN_TTL_MS;
  if (!force && fresh) return cachedToken.token;
  const token = await fetchToken(cfg);
  cachedToken = { token, fetchedAt: Date.now(), username: cfg.username };
  return token;
}

function invalidateToken() {
  cachedToken = null;
}

/** GET a Zerto Analytics path (e.g. '/v2/monitoring/vpgs'); re-auths once on 401. */
async function zGet(coreApi, path, params = {}) {
  const cfg = getZertoConfig(coreApi);
  if (!cfg.username || !cfg.password) throw new Error('Zerto Analytics credentials are not configured');
  let token = await getToken(cfg);
  const doGet = (t) => rawRequest(cfg.baseUrl, {
    method: 'GET', path, params, headers: { Authorization: `Bearer ${t}`, accept: 'application/json' },
  });
  try {
    const { data } = await doGet(token);
    return data;
  } catch (err) {
    if (err.response?.status === 401) {
      token = await getToken(cfg, true);
      const { data } = await doGet(token);
      return data;
    }
    throw err;
  }
}

// ── Monitoring fetchers ──────────────────────────────────────────────────────

/** Account-level aggregations (healthy/warned/erroneous VPG counts, ...). */
const fetchAccountStats = (coreApi) => zGet(coreApi, '/v2/monitoring/');

/** All sites (siteDetails[]): name, type, version, zvmIp, connectionStatus... */
const fetchSites = async (coreApi) => (await zGet(coreApi, '/v2/monitoring/sites')) || [];

/** Sites topology (siteTopology[]): adds per-site vras[] + directed site links. */
const fetchSitesTopology = async (coreApi) => (await zGet(coreApi, '/v2/monitoring/sites', { format: 'topology' })) || [];

/** All VPGs: { vpgs: [...], healthyVpgsCount, warnedVpgsCount, erroneousVpgsCount }. */
const fetchVpgs = async (coreApi) => (await zGet(coreApi, '/v2/monitoring/vpgs')) || { vpgs: [] };

/** All alerts (alert[]): type, severity Warning|Error, description, site, entityType. */
const fetchAlerts = async (coreApi) => (await zGet(coreApi, '/v2/monitoring/alerts')) || [];

/** All protected VMs: identifier, name, provisioned/usedStorageMb, vpgs[], zorg. */
const fetchProtectedVms = async (coreApi) => (await zGet(coreApi, '/v2/monitoring/protected-vms')) || [];

// v3, not v2 — /v2/licenses reports usedVMsCount 0 and no site breakdown.
const fetchLicenses = async (coreApi) => (await zGet(coreApi, '/v3/licenses')) || [];

/**
 * Validate credentials (optionally an unsaved candidate set) by authenticating
 * and pulling the site list. Returns { ok, sites?, error? } — never throws.
 */
async function testConnection(coreApi, candidate = null) {
  const saved = getZertoConfig(coreApi);
  const cfg = {
    baseUrl: candidate?.baseUrl?.replace(/\/+$/, '') || saved.baseUrl,
    username: candidate?.username || saved.username,
    password: candidate?.password || saved.password,
  };
  if (!cfg.username || !cfg.password) return { ok: false, error: 'Username and password are required.' };
  try {
    const token = await fetchToken(cfg);
    const { data } = await rawRequest(cfg.baseUrl, {
      method: 'GET', path: '/v2/monitoring/sites', headers: { Authorization: `Bearer ${token}`, accept: 'application/json' },
    });
    const sites = Array.isArray(data) ? data : [];
    return { ok: true, sites: sites.length };
  } catch (err) {
    const status = err.response?.status;
    const error = status === 401 ? 'Authentication failed — check the myZerto username and password.'
      : (err.response?.data?.message || err.message);
    return { ok: false, error };
  }
}

module.exports = {
  getZertoConfig, zertoConfigured, zGet, invalidateToken,
  fetchAccountStats, fetchSites, fetchSitesTopology, fetchVpgs, fetchAlerts, fetchProtectedVms,
  fetchLicenses,
  testConnection,
};
