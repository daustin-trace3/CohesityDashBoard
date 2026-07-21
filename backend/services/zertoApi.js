// Zerto Analytics SaaS API client (analytics.api.zerto.com, spec at
// docs.api.zerto.com). One account-wide credential: myZerto username/password
// exchanged at POST /v2/auth/token for a Bearer JWT used on every other call.
const axios = require('axios');
const { getSetting } = require('./settings');
const { decrypt } = require('./encryption');
const logger = require('../utils/logger');

const DEFAULT_BASE_URL = 'https://analytics.api.zerto.com';
// The JWT lifetime is not documented; cache conservatively and re-auth on 401.
const TOKEN_TTL_MS = 45 * 60 * 1000;

function getZertoConfig() {
  const username = getSetting('zerto_username') || process.env.ZERTO_USERNAME || '';
  let password = '';
  const stored = getSetting('zerto_password');
  if (stored) {
    try { password = decrypt(stored); } catch { password = ''; }
  }
  if (!password) password = process.env.ZERTO_PASSWORD || '';
  const baseUrl = (getSetting('zerto_base_url') || DEFAULT_BASE_URL).replace(/\/+$/, '');
  return { username, password, baseUrl };
}

function zertoConfigured() {
  const { username, password } = getZertoConfig();
  return !!(username && password);
}

let cachedToken = null; // { token, fetchedAt, username }

async function fetchToken(cfg) {
  const { data } = await axios.post(`${cfg.baseUrl}/v2/auth/token`, {
    username: cfg.username,
    password: cfg.password,
  }, { timeout: 30000, headers: { 'Content-Type': 'application/json' } });
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
async function zGet(path, params = {}) {
  const cfg = getZertoConfig();
  if (!cfg.username || !cfg.password) throw new Error('Zerto Analytics credentials are not configured');
  let token = await getToken(cfg);
  const doGet = (t) => axios.get(`${cfg.baseUrl}${path}`, {
    timeout: 60000,
    params,
    headers: { Authorization: `Bearer ${t}`, accept: 'application/json' },
  });
  try {
    const { data } = await doGet(token);
    return data;
  } catch (err) {
    if (err.response?.status === 401) {
      logger.debug('[ZertoApi] 401 — refreshing token and retrying');
      token = await getToken(cfg, true);
      const { data } = await doGet(token);
      return data;
    }
    throw err;
  }
}

// ── Monitoring fetchers ──────────────────────────────────────────────────────

/** Account-level aggregations (healthy/warned/erroneous VPG counts, ...). */
const fetchAccountStats = () => zGet('/v2/monitoring/');

/** All sites (siteDetails[]): name, type, version, zvmIp, connectionStatus... */
const fetchSites = async () => (await zGet('/v2/monitoring/sites')) || [];

/** Sites topology (siteTopology[]): adds per-site vras[] + directed site links. */
const fetchSitesTopology = async () => (await zGet('/v2/monitoring/sites', { format: 'topology' })) || [];

/** All VPGs: { vpgs: [...], healthyVpgsCount, warnedVpgsCount, erroneousVpgsCount }. */
const fetchVpgs = async () => (await zGet('/v2/monitoring/vpgs')) || { vpgs: [] };

/** All alerts (alert[]): type, severity Warning|Error, description, site, entityType. */
const fetchAlerts = async () => (await zGet('/v2/monitoring/alerts')) || [];

/** All protected VMs: identifier, name, provisioned/usedStorageMb, vpgs[], zorg. */
const fetchProtectedVms = async () => (await zGet('/v2/monitoring/protected-vms')) || [];

/**
 * Validate credentials (optionally an unsaved candidate set) by authenticating
 * and pulling the site list. Returns { ok, sites?, error? } — never throws.
 */
async function testConnection(candidate = null) {
  const saved = getZertoConfig();
  const cfg = {
    baseUrl: candidate?.baseUrl?.replace(/\/+$/, '') || saved.baseUrl,
    username: candidate?.username || saved.username,
    password: candidate?.password || saved.password,
  };
  if (!cfg.username || !cfg.password) return { ok: false, error: 'Username and password are required.' };
  try {
    const token = await fetchToken(cfg);
    const { data } = await axios.get(`${cfg.baseUrl}/v2/monitoring/sites`, {
      timeout: 30000,
      headers: { Authorization: `Bearer ${token}`, accept: 'application/json' },
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
  testConnection,
};
