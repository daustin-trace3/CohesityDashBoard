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
  // The ?access_token flag asks the CSP gateway for a refresh_token; without
  // it, on-prem vRA returns only a cspAuthToken (seen live 2026-07-28).
  const { data } = await baseClient(row).post('/csp/gateway/am/api/login?access_token', {
    username, password, ...(domain ? { domain } : {}),
  });
  return data || {};
}

async function iaasLogin(row, refreshToken) {
  const { data } = await baseClient(row).post('/iaas/api/login', { refreshToken });
  const token = data?.token;
  if (!token) throw new Error('Aria iaas login returned no token');
  return token;
}

/** Full re-login: CSP gateway -> refresh token -> iaas bearer exchange.
 * Falls back to using cspAuthToken directly as the bearer when the gateway
 * returns no refresh_token even with ?access_token. */
async function fullLogin(row) {
  const login = await cspLogin(row);
  if (login.refresh_token) {
    const bearer = await iaasLogin(row, login.refresh_token);
    return { refreshToken: login.refresh_token, bearer, fetchedAt: Date.now() };
  }
  if (login.cspAuthToken || login.access_token) {
    return { refreshToken: null, bearer: login.cspAuthToken || login.access_token, fetchedAt: Date.now() };
  }
  throw new Error(`Aria CSP login returned no usable token (keys: ${Object.keys(login).join(', ') || 'none'})`);
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
const unwrap = (d) => {
  if (Array.isArray(d)) return d;
  const inner = d?.content ?? d?.value ?? d?.documents ?? [];
  if (Array.isArray(inner)) return inner;
  // Code Stream returns `documents` as an OBJECT keyed by id, not an array
  // (seen live in prod 2026-07-28: "pipelineExecutions is not iterable").
  if (inner && typeof inner === 'object') return Object.values(inner);
  return [];
};

/** GET /deployment/api/deployments — paged, capped at 2000 rows total. */
async function fetchDeployments(row, cap = 2000) {
  const size = Math.min(200, cap);
  const all = [];
  for (let page = 0; all.length < cap; page++) {
    const data = await aGetV(row, '/deployment/api/deployments', { size, page });
    const items = unwrap(data);
    all.push(...items);
    if (items.length < size) break;
  }
  return all.slice(0, cap);
}

/**
 * Child resources for each deployment (machine names, IPs). One request per
 * deployment, capped, sequential — shapes unverified: resources may expose
 * IPs at properties.address / properties.networks[].address / networks[].
 */
async function fetchDeploymentResources(row, deployments) {
  const CAP_DEPLOYMENTS = 300;
  const out = [];
  for (const dep of (deployments || []).slice(0, CAP_DEPLOYMENTS)) {
    const depId = dep.id || dep.deploymentId;
    if (!depId) continue;
    let items;
    try {
      items = unwrap(await aGetV(row, `/deployment/api/deployments/${encodeURIComponent(depId)}/resources`, { size: 100 }));
    } catch {
      continue; // per-deployment failures shouldn't sink the section
    }
    for (const r of items) {
      const props = r.properties || {};
      const ips = new Set();
      if (props.address) ips.add(String(props.address));
      for (const n of (Array.isArray(props.networks) ? props.networks : [])) {
        if (n?.address) ips.add(String(n.address));
      }
      for (const n of (Array.isArray(r.networks) ? r.networks : [])) {
        if (n?.address) ips.add(String(n.address));
      }
      out.push({
        deploymentId: String(depId),
        resourceId: r.id != null ? String(r.id) : null,
        // properties.resourceName is the actual machine name (vRA UI "Resource
        // Name", e.g. w283328); r.name is the blueprint component label
        // (Cloud_vSphere_Machine_1) — verified live 2026-07-28.
        name: props.resourceName || props.hostName || r.name || null,
        type: r.type || null,
        state: r.state || r.syncStatus || null,
        ipAddresses: [...ips],
      });
    }
  }
  return out;
}

/**
 * Requests are per-deployment only: the global /deployment/api/requests 400s
 * with "Required request parameter 'deploymentId'" (verified live 2026-07-28).
 * Walk the most recently updated deployments for an activity feed.
 */
async function fetchRequests(row, deployments, depCap = 50) {
  const recent = [...(deployments || [])]
    .sort((a, b) => String(b?.lastUpdatedAt || '').localeCompare(String(a?.lastUpdatedAt || '')))
    .slice(0, depCap);
  const out = [];
  for (const dep of recent) {
    const depId = dep?.id;
    if (!depId) continue;
    try {
      const items = unwrap(await aGetV(row, `/deployment/api/deployments/${encodeURIComponent(depId)}/requests`, { size: 20 }));
      for (const r of items) out.push({ ...r, deploymentId: r?.deploymentId ?? String(depId) });
    } catch { /* per-deployment failures shouldn't sink the feed */ }
  }
  return out;
}
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
async function fetchFabricImages(row, cap = 2000) {
  const top = Math.min(200, cap);
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

/**
 * Blueprints (Cloud Assembly templates) with their image references. The list
 * endpoint omits YAML content, so each blueprint is fetched individually
 * (capped at 200) and its content scanned for `image:` property values —
 * these are image MAPPING names, the indirection blueprints use. A blueprint
 * whose content fetch fails still appears, with refs null.
 */
async function fetchBlueprints(row, detailCap = 200) {
  const list = unwrap(await aGetV(row, '/blueprint/api/blueprints', { size: 100 }));
  const capped = list.slice(0, detailCap);
  const out = [];
  for (const b of capped) {
    let imageRefs = null;
    try {
      const detail = await aGetV(row, `/blueprint/api/blueprints/${b?.id}`);
      const content = detail?.content ?? detail?.blueprint ?? '';
      if (typeof content === 'string' && content) {
        const refs = new Set();
        for (const m of content.matchAll(/^\s*image:\s*['"]?([^\s'"#]+)/gm)) refs.add(m[1]);
        // Parameterized refs (image: '${input.x}') can't be traced to a
        // specific image — drop them (live blueprints produced refs of "${").
        imageRefs = [...refs].filter((v) => !v.includes('${'));
      }
    } catch { /* keep the blueprint row, refs unknown */ }
    out.push({ ...b, imageRefs });
  }
  return out;
}

const fetchAbxRuns = async (row) => unwrap(await aGet(row, '/abx/api/resources/action-runs', { $top: 100 }));
const fetchPipelineExecutions = async (row) => unwrap(await aGet(row, '/pipeline/api/executions', { $top: 100 }));
/** approval-requests 404s on some builds (seen live) — fall back to /approvals. */
const fetchApprovals = async (row) => {
  try {
    return unwrap(await aGetV(row, '/approval/api/approval-requests', { size: 100 }));
  } catch (err) {
    if (err.response?.status !== 404) throw err;
    return unwrap(await aGetV(row, '/approval/api/approvals', { size: 100 }));
  }
};
const fetchAbout = async (row) => aGetV(row, '/iaas/api/about');

/** Reachability probe via GET /health (no auth). Only LB/VIP deployments
 *  actually serve /health — single-node appliances 404 it (seen live
 *  2026-07-28) — so ANY HTTP response counts as reachable; only network-level
 *  failures (DNS, refused, timeout) throw "unreachable". */
async function fetchHealth(row) {
  try {
    await baseClient(row).get('/health');
  } catch (err) {
    if (!err.response) throw err;
  }
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
    // vRA error bodies vary (message / serverMessage / HTML) — pass through a
    // snippet of whatever came back so failures are diagnosable from the UI.
    const body = err.response?.data;
    const detail = body == null ? null
      : (typeof body === 'string' ? body : JSON.stringify(body)).slice(0, 300);
    const hop = err.config?.url ? ` at ${err.config.url}` : '';
    // vIDM rejects bad credentials with an OAuth-style 400 invalid_grant,
    // not a 401 — treat both as an auth failure.
    const authFail = status === 401 || (status === 400 && /invalid_grant/i.test(detail || ''));
    return {
      ok: false,
      error: authFail ? 'Authentication failed — check the Aria username, password and domain. AD/LDAP accounts: bare username + the identity-source domain exactly as vRA’s login page lists it; local accounts: leave domain empty.'
        : status ? `vRA responded ${status}${hop}${detail ? ` — ${detail}` : ''}`
          : err.message,
    };
  }
}

module.exports = {
  getBearer, invalidateSession, aGet, aGetV, unwrap,
  fetchDeployments, fetchDeploymentResources, fetchRequests, fetchCloudAccounts, fetchIntegrations,
  fetchProjects, fetchCatalogSources, fetchFabricImages, fetchImageProfiles,
  fetchFlavorProfiles, fetchBlueprints, fetchAbxRuns, fetchPipelineExecutions,
  fetchApprovals, fetchAbout, fetchHealth, fetchTlsCert, testConnection,
};
