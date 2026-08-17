// Aria Automation (vRA 8.x on-prem) API client. Doug has no live vRA to test
// against, so every upstream response shape below is UNVERIFIED — fetchers
// parse defensively (optional chaining, String()/Number() coercion) and the
// probe route (router.js) exists specifically to see the real shapes against
// a live instance. Auth is a two-step exchange: CSP gateway login gets a
// long-lived refresh token, then /iaas/api/login trades it for a short-lived
// bearer used on every other call.
//
// DEVIATION FROM THE BUILT-IN: the original (backend/services/ariaApi.js)
// uses axios, which is not available to a bundled plugin (esbuild has no
// axios to bundle from plugin-sdk's dependency tree). Re-implemented on
// Node's built-in `https` module (plugin-sdk/dell/backend/src/api.js's
// rawRequest pattern), with GET/POST JSON support. Every function now
// threads `coreApi` through for decrypt/logging instead of requiring host
// modules directly. Behavior preserved verbatim: the CSP login ?access_token
// flag quirk, the cspAuthToken fallback when no refresh_token comes back,
// cached-bearer/refresh-token reuse (~20 min TTL), the /health 404-tolerant
// reachability probe (only network-level failures count as unreachable),
// deployment fetch cap of 2000, deployment-resources cap of 300, and
// ssl_verify -> rejectUnauthorized.
const https = require('https');
const tls = require('tls');
const { URLSearchParams } = require('url');

const API_VERSION = '2021-07-15';
const SESSION_TTL_MS = 20 * 60 * 1000;
const sessions = new Map(); // row.id -> { refreshToken, bearer, fetchedAt }

function creds(row, coreApi) {
  const password = row.password ? row.password : JSON.parse(coreApi.encryption.decrypt(row.encrypted_credentials)).password;
  return { username: row.username, password, domain: row.domain || undefined };
}

/** Raw HTTPS call against a vRA appliance. Resolves with { status, data, headers }.
 *  Rejects with an Error carrying `.response = { status, data, headers }`. */
function rawRequest(row, { method = 'GET', path, params, data, headers = {}, timeout = 60000 } = {}) {
  return new Promise((resolve, reject) => {
    const qs = new URLSearchParams();
    for (const [k, v] of Object.entries(params || {})) {
      if (v !== undefined && v !== null) qs.set(k, String(v));
    }
    const query = qs.toString();
    const reqPath = `${path}${query ? `${path.includes('?') ? '&' : '?'}${query}` : ''}`;
    const body = data !== undefined ? JSON.stringify(data) : undefined;
    const reqHeaders = { ...headers };
    if (body !== undefined) {
      reqHeaders['Content-Type'] = 'application/json';
      reqHeaders['Content-Length'] = Buffer.byteLength(body);
    }

    const req = https.request(
      {
        hostname: row.host,
        port: 443,
        path: reqPath,
        method,
        timeout,
        rejectUnauthorized: !!row.ssl_verify,
        headers: reqHeaders,
      },
      (res) => {
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
      }
    );
    req.on('timeout', () => { req.destroy(); reject(new Error('Request timed out')); });
    req.on('error', (err) => reject(err));
    if (body !== undefined) req.write(body);
    req.end();
  });
}

async function cspLogin(row, coreApi) {
  const { username, password, domain } = creds(row, coreApi);
  // The ?access_token flag asks the CSP gateway for a refresh_token; without
  // it, on-prem vRA returns only a cspAuthToken (seen live 2026-07-28).
  const { data } = await rawRequest(row, {
    method: 'POST', path: '/csp/gateway/am/api/login?access_token',
    data: { username, password, ...(domain ? { domain } : {}) },
  });
  return data || {};
}

async function iaasLogin(row, refreshToken) {
  const { data } = await rawRequest(row, { method: 'POST', path: '/iaas/api/login', data: { refreshToken } });
  const token = data?.token;
  if (!token) throw new Error('Aria iaas login returned no token');
  return token;
}

/** Full re-login: CSP gateway -> refresh token -> iaas bearer exchange.
 *  Falls back to using cspAuthToken directly as the bearer when the gateway
 *  returns no refresh_token even with ?access_token. */
async function fullLogin(row, coreApi) {
  const login = await cspLogin(row, coreApi);
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
async function getBearer(row, coreApi, force = false) {
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
  const session = await fullLogin(row, coreApi);
  sessions.set(row.id, session);
  return session.bearer;
}

function invalidateSession(id) {
  sessions.delete(id);
}

/** Authenticated GET with one forced-relogin retry on 401. */
async function aGet(row, coreApi, path, params = {}) {
  let token = await getBearer(row, coreApi);
  const doGet = (t) => rawRequest(row, { method: 'GET', path, params, headers: { Authorization: `Bearer ${t}` } });
  try {
    const { data } = await doGet(token);
    return data;
  } catch (err) {
    if (err.response?.status === 401) {
      token = await getBearer(row, coreApi, true);
      const { data } = await doGet(token);
      return data;
    }
    throw err;
  }
}

const aGetV = (row, coreApi, path, params = {}) => aGet(row, coreApi, path, { apiVersion: API_VERSION, ...params });

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
async function fetchDeployments(row, coreApi, cap = 2000) {
  const size = Math.min(200, cap);
  const all = [];
  for (let page = 0; all.length < cap; page++) {
    const data = await aGetV(row, coreApi, '/deployment/api/deployments', { size, page });
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
async function fetchDeploymentResources(row, coreApi, deployments) {
  const CAP_DEPLOYMENTS = 300;
  const out = [];
  for (const dep of (deployments || []).slice(0, CAP_DEPLOYMENTS)) {
    const depId = dep.id || dep.deploymentId;
    if (!depId) continue;
    let items;
    try {
      items = unwrap(await aGetV(row, coreApi, `/deployment/api/deployments/${encodeURIComponent(depId)}/resources`, { size: 100 }));
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
async function fetchRequests(row, coreApi, deployments, depCap = 50) {
  const recent = [...(deployments || [])]
    .sort((a, b) => String(b?.lastUpdatedAt || '').localeCompare(String(a?.lastUpdatedAt || '')))
    .slice(0, depCap);
  const out = [];
  for (const dep of recent) {
    const depId = dep?.id;
    if (!depId) continue;
    try {
      const items = unwrap(await aGetV(row, coreApi, `/deployment/api/deployments/${encodeURIComponent(depId)}/requests`, { size: 20 }));
      for (const r of items) out.push({ ...r, deploymentId: r?.deploymentId ?? String(depId) });
    } catch { /* per-deployment failures shouldn't sink the feed */ }
  }
  return out;
}
const fetchCloudAccounts = async (row, coreApi) => unwrap(await aGetV(row, coreApi, '/iaas/api/cloud-accounts'));
const fetchIntegrations = async (row, coreApi) => unwrap(await aGetV(row, coreApi, '/iaas/api/integrations'));
const fetchProjects = async (row, coreApi) => unwrap(await aGetV(row, coreApi, '/iaas/api/projects'));

/** GET /catalog/api/admin/sources, falling back to /catalog/api/sources. */
async function fetchCatalogSources(row, coreApi) {
  try {
    return unwrap(await aGetV(row, coreApi, '/catalog/api/admin/sources'));
  } catch (err) {
    coreApi.logger.debug(`[ariaApi] admin/sources failed for ${row.name} (${err.message}), trying /catalog/api/sources`);
    return unwrap(await aGetV(row, coreApi, '/catalog/api/sources'));
  }
}

/** GET /iaas/api/fabric-images — paged with $top/$skip, capped at 2000. */
async function fetchFabricImages(row, coreApi, cap = 2000) {
  const top = Math.min(200, cap);
  const all = [];
  for (let skip = 0; all.length < cap; skip += top) {
    const data = await aGetV(row, coreApi, '/iaas/api/fabric-images', { $top: top, $skip: skip });
    const items = unwrap(data);
    all.push(...items);
    if (items.length < top) break;
  }
  return all.slice(0, cap);
}

const fetchImageProfiles = async (row, coreApi) => unwrap(await aGetV(row, coreApi, '/iaas/api/image-profiles'));
const fetchFlavorProfiles = async (row, coreApi) => unwrap(await aGetV(row, coreApi, '/iaas/api/flavor-profiles'));

/**
 * Blueprints (Cloud Assembly templates) with their image references. The list
 * endpoint omits YAML content, so each blueprint is fetched individually
 * (capped at 200) and its content scanned for `image:` property values —
 * these are image MAPPING names, the indirection blueprints use. A blueprint
 * whose content fetch fails still appears, with refs null.
 */
async function fetchBlueprints(row, coreApi, detailCap = 200) {
  const list = unwrap(await aGetV(row, coreApi, '/blueprint/api/blueprints', { size: 100 }));
  const capped = list.slice(0, detailCap);
  const out = [];
  for (const b of capped) {
    let imageRefs = null;
    try {
      const detail = await aGetV(row, coreApi, `/blueprint/api/blueprints/${b?.id}`);
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

const fetchAbxRuns = async (row, coreApi) => unwrap(await aGet(row, coreApi, '/abx/api/resources/action-runs', { $top: 100 }));
const fetchPipelineExecutions = async (row, coreApi) => unwrap(await aGet(row, coreApi, '/pipeline/api/executions', { $top: 100 }));
/** approval-requests 404s on some builds (seen live) — fall back to /approvals. */
const fetchApprovals = async (row, coreApi) => {
  try {
    return unwrap(await aGetV(row, coreApi, '/approval/api/approval-requests', { size: 100 }));
  } catch (err) {
    if (err.response?.status !== 404) throw err;
    return unwrap(await aGetV(row, coreApi, '/approval/api/approvals', { size: 100 }));
  }
};
const fetchAbout = async (row, coreApi) => aGetV(row, coreApi, '/iaas/api/about');

/** Reachability probe via GET /health (no auth). Only LB/VIP deployments
 *  actually serve /health — single-node appliances 404 it (seen live
 *  2026-07-28) — so ANY HTTP response counts as reachable; only network-level
 *  failures (DNS, refused, timeout) throw "unreachable". */
async function fetchHealth(row) {
  try {
    await rawRequest(row, { method: 'GET', path: '/health' });
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
async function testConnection(rowLike, coreApi) {
  try {
    const probe = { id: `test-${rowLike.host}`, ...rowLike };
    const bearer = await getBearer(probe, coreApi, true);
    const deployments = await aGetV(probe, coreApi, '/deployment/api/deployments', { size: 1 })
      .then((d) => unwrap(d).length).catch(() => undefined);
    const about = await fetchAbout(probe, coreApi).catch(() => null);
    sessions.delete(probe.id);
    void bearer;
    return { ok: true, version: about?.latestApiVersion || about?.supportedApis || undefined, deployments };
  } catch (err) {
    const status = err.response?.status;
    // vRA error bodies vary (message / serverMessage / HTML) — pass through a
    // snippet of whatever came back so failures are diagnosable from the UI.
    const body = err.response?.data;
    const detail = body == null ? null
      : (typeof body === 'string' ? body : JSON.stringify(body)).slice(0, 300);
    // vIDM rejects bad credentials with an OAuth-style 400 invalid_grant,
    // not a 401 — treat both as an auth failure.
    const authFail = status === 401 || (status === 400 && /invalid_grant/i.test(detail || ''));
    return {
      ok: false,
      error: authFail ? 'Authentication failed — check the Aria username, password and domain. AD/LDAP accounts: bare username + the identity-source domain exactly as vRA’s login page lists it; local accounts: leave domain empty.'
        : status ? `vRA responded ${status}${detail ? ` — ${detail}` : ''}`
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
