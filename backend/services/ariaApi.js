// Aria Automation (vRA 8.x on-prem) API client. Doug has no live vRA to test
// against, so every upstream response shape below is UNVERIFIED — fetchers
// parse defensively (optional chaining, String()/Number() coercion) and the
// probe route (routes/aria.js) exists specifically to see the real shapes
// against a live instance. Auth is a two-step exchange: CSP gateway login
// gets a long-lived refresh token, then /iaas/api/login trades it for a
// short-lived bearer used on every other call.
const axios = require('axios');
const https = require('https');
const tls = require('tls');
const { decrypt } = require('./encryption');
const logger = require('../utils/logger');

const API_VERSION = '2021-07-15';
const SESSION_TTL_MS = 20 * 60 * 1000;
const sessions = new Map(); // instance.id -> { refreshToken, bearer, fetchedAt }

function creds(row) {
  // Unsaved candidates (test connection) carry a plaintext password;
  // registered rows carry the encrypted blob.
  const password = row.password ? row.password : JSON.parse(decrypt(row.encrypted_credentials)).password;
  return { username: row.username, password, domain: row.domain || undefined };
}

function baseClient(row, headers = {}) {
  return axios.create({
    baseURL: `https://${row.host}`,
    timeout: 60000,
    headers,
    httpsAgent: new https.Agent({ rejectUnauthorized: !!row.ssl_verify }),
  });
}

async function cspLogin(row) {
  const { username, password, domain } = creds(row);
  const { data } = await baseClient(row).post('/csp/gateway/am/api/login', {
    username, password, ...(domain ? { domain } : {}),
  });
  const refreshToken = data?.refresh_token;
  if (!refreshToken) throw new Error('Aria CSP login returned no refresh_token');
  return refreshToken;
}

async function iaasLogin(row, refreshToken) {
  const { data } = await baseClient(row).post('/iaas/api/login', { refreshToken });
  const token = data?.token;
  if (!token) throw new Error('Aria iaas login returned no token');
  return token;
}

/** Full re-login: CSP gateway -> refresh token -> iaas bearer exchange. */
async function fullLogin(row) {
  const refreshToken = await cspLogin(row);
  const bearer = await iaasLogin(row, refreshToken);
  return { refreshToken, bearer, fetchedAt: Date.now() };
}

/**
 * Cached bearer per instance (~20 min TTL — vRA bearers are short-lived).
 * On expiry, re-exchange the cached refresh token first (refresh tokens are
 * valid ~90d); only fall back to a full CSP re-login if that fails.
 */
async function getBearer(row, force = false) {
  const cached = sessions.get(row.id);
  if (!force && cached && Date.now() - cached.fetchedAt < SESSION_TTL_MS) return cached.bearer;

  if (!force && cached?.refreshToken) {
    try {
      const bearer = await iaasLogin(row, cached.refreshToken);
      const next = { refreshToken: cached.refreshToken, bearer, fetchedAt: Date.now() };
      sessions.set(row.id, next);
      return next.bearer;
    } catch {
      // Refresh token stale/revoked — fall through to a full re-login.
    }
  }
  const session = await fullLogin(row);
  sessions.set(row.id, session);
  return session.bearer;
}

function invalidateSession(id) {
  sessions.delete(id);
}

/** Authenticated GET with one forced-relogin retry on 401. */
async function aGet(row, path, params = {}) {
  let token = await getBearer(row);
  const doGet = (t) => baseClient(row, { Authorization: `Bearer ${t}` }).get(path, { params });
  try {
    const { data } = await doGet(token);
    return data;
  } catch (err) {
    if (err.response?.status === 401) {
      token = await getBearer(row, true);
      const { data } = await doGet(token);
      return data;
    }
    throw err;
  }
}

const aGetV = (row, path, params = {}) => aGet(row, path, { apiVersion: API_VERSION, ...params });

// Response shapes are unverified — vRA typically wraps lists as
// { content: [...] } (Spring Data) but some endpoints use { value: [...] } or
// a bare array. Accept whichever shows up.
const unwrap = (d) => (Array.isArray(d) ? d : (d?.content ?? d?.value ?? d?.documents ?? []));

/** GET /deployment/api/deployments — paged, capped at 2000 rows total. */
async function fetchDeployments(row) {
  const size = 200;
  const cap = 2000;
  const all = [];
  for (let page = 0; all.length < cap; page++) {
    const data = await aGetV(row, '/deployment/api/deployments', { size, page });
    const items = unwrap(data);
    all.push(...items);
    if (items.length < size) break;
  }
  return all.slice(0, cap);
}

const fetchRequests = async (row) => unwrap(await aGetV(row, '/deployment/api/requests', { size: 100 }));
const fetchCloudAccounts = async (row) => unwrap(await aGetV(row, '/iaas/api/cloud-accounts'));
const fetchIntegrations = async (row) => unwrap(await aGetV(row, '/iaas/api/integrations'));
const fetchProjects = async (row) => unwrap(await aGetV(row, '/iaas/api/projects'));

/** GET /catalog/api/admin/sources, falling back to /catalog/api/sources. */
async function fetchCatalogSources(row) {
  try {
    return unwrap(await aGetV(row, '/catalog/api/admin/sources'));
  } catch (err) {
    logger.debug(`[ariaApi] admin/sources failed for ${row.name} (${err.message}), trying /catalog/api/sources`);
    return unwrap(await aGetV(row, '/catalog/api/sources'));
  }
}

/** GET /iaas/api/fabric-images — paged with $top/$skip, capped at 2000. */
async function fetchFabricImages(row) {
  const top = 200;
  const cap = 2000;
  const all = [];
  for (let skip = 0; all.length < cap; skip += top) {
    const data = await aGetV(row, '/iaas/api/fabric-images', { $top: top, $skip: skip });
    const items = unwrap(data);
    all.push(...items);
    if (items.length < top) break;
  }
  return all.slice(0, cap);
}

const fetchImageProfiles = async (row) => unwrap(await aGetV(row, '/iaas/api/image-profiles'));
const fetchFlavorProfiles = async (row) => unwrap(await aGetV(row, '/iaas/api/flavor-profiles'));

const fetchAbxRuns = async (row) => unwrap(await aGet(row, '/abx/api/resources/action-runs', { $top: 100 }));
const fetchPipelineExecutions = async (row) => unwrap(await aGet(row, '/pipeline/api/executions', { $top: 100 }));
const fetchApprovals = async (row) => unwrap(await aGetV(row, '/approval/api/approval-requests', { size: 100 }));
const fetchAbout = async (row) => aGetV(row, '/iaas/api/about');

/** GET /health — LB reachability probe, no auth, 200 = up. Throws on failure
 *  so callers (the poller) can treat it as "instance unreachable". */
async function fetchHealth(row) {
  await baseClient(row).get('/health');
  return true;
}

/**
 * TLS certificate off the raw handshake (host:443), not a vRA REST endpoint —
 * vCenter's fetchTlsCert calls a dedicated cert-management API that vRA has
 * no documented equivalent for, so this reads the socket's peer certificate
 * directly instead. Best-effort; never assumed available.
 */
function fetchTlsCert(row) {
  return new Promise((resolve, reject) => {
    const socket = tls.connect({
      host: row.host, port: 443, servername: row.host,
      rejectUnauthorized: false, timeout: 15000,
    }, () => {
      const cert = socket.getPeerCertificate();
      socket.end();
      if (!cert || !Object.keys(cert).length) return reject(new Error('No peer certificate returned'));
      resolve({
        subject: cert.subject?.CN || cert.subject?.O || null,
        issuer: cert.issuer?.CN || cert.issuer?.O || null,
        validFrom: cert.valid_from || null,
        validTo: cert.valid_to || null,
      });
    });
    socket.on('error', reject);
    socket.on('timeout', () => { socket.destroy(); reject(new Error('TLS handshake timed out')); });
  });
}

/** Validate an Aria instance (saved row or unsaved candidate). Never throws. */
async function testConnection(rowLike) {
  try {
    const bearer = await getBearer({ id: `test-${rowLike.host}`, ...rowLike }, true);
    const deployments = await aGetV({ ...rowLike, id: `test-${rowLike.host}` }, '/deployment/api/deployments', { size: 1 })
      .then((d) => unwrap(d).length).catch(() => undefined);
    const about = await fetchAbout({ ...rowLike, id: `test-${rowLike.host}` }).catch(() => null);
    sessions.delete(`test-${rowLike.host}`);
    void bearer;
    return { ok: true, version: about?.latestApiVersion || about?.supportedApis || undefined, deployments };
  } catch (err) {
    const status = err.response?.status;
    return {
      ok: false,
      error: status === 401 ? 'Authentication failed — check the Aria username, password and domain.'
        : (err.response?.data?.message || err.message),
    };
  }
}

module.exports = {
  getBearer, invalidateSession, aGet, aGetV, unwrap,
  fetchDeployments, fetchRequests, fetchCloudAccounts, fetchIntegrations,
  fetchProjects, fetchCatalogSources, fetchFabricImages, fetchImageProfiles,
  fetchFlavorProfiles, fetchAbxRuns, fetchPipelineExecutions,
  fetchApprovals, fetchAbout, fetchHealth, fetchTlsCert, testConnection,
};
