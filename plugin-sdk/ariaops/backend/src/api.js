// VMware Aria Operations (vROps Suite API) client. Doug has no live vROps to
// test against, so every upstream response shape below is UNVERIFIED —
// fetchers parse defensively (optional chaining, accept either of several
// candidate field/wrapper names) and the probe route (router.js) exists
// specifically to see the real shapes against a live instance.
// Auth: POST /suite-api/api/auth/token/acquire -> { token, validity }, then
// header `Authorization: vRealizeOpsToken <token>` on every other call.
//
// DEVIATION FROM THE BUILT-IN: the original (backend/services/ariaopsApi.js)
// uses axios, which is not available to a bundled plugin (esbuild has no
// axios to bundle from plugin-sdk's dependency tree). Re-implemented on
// Node's built-in `https` module (plugin-sdk/dell/backend/src/api.js's
// rawRequest pattern), with GET/POST JSON support and query-string params.
// Every function now threads `coreApi` through for decrypt/logging instead
// of requiring host modules directly. Behavior preserved verbatim: cached
// vRealizeOpsToken sessions with a 25-min TTL, one forced-reacquire retry on
// 401, paged resource/alert fetches capped at 5000 rows, chunked latest-stats
// lookups (<=50 resourceIds/call), the raw-TLS certificate probe, and
// ssl_verify -> rejectUnauthorized.
const https = require('https');
const tls = require('tls');

const TOKEN_TTL_MS = 25 * 60 * 1000;
const tokens = new Map(); // row.id -> { token, fetchedAt }

function creds(row, coreApi) {
  // Unsaved candidates (test connection) carry a plaintext password;
  // registered rows carry the encrypted blob.
  const password = row.password ? row.password : JSON.parse(coreApi.encryption.decrypt(row.encrypted_credentials)).password;
  return { username: row.username, password, authSource: row.auth_source || undefined };
}

/** Raw HTTPS call against a vROps instance. Resolves with { status, data }.
 *  Rejects with an Error carrying `.response = { status, data }`. */
function rawRequest(row, { method = 'GET', path, params, data, headers = {}, timeout = 60000 } = {}) {
  return new Promise((resolve, reject) => {
    const qs = new URLSearchParams();
    if (params instanceof URLSearchParams) {
      for (const [k, v] of params.entries()) qs.append(k, v);
    } else {
      for (const [k, v] of Object.entries(params || {})) {
        if (v !== undefined && v !== null) qs.set(k, String(v));
      }
    }
    const query = qs.toString();
    const reqPath = `/suite-api/api${path}${query ? `${path.includes('?') ? '&' : '?'}${query}` : ''}`;
    const body = data !== undefined ? JSON.stringify(data) : undefined;
    const reqHeaders = { Accept: 'application/json', ...headers };
    if (body !== undefined) {
      reqHeaders['Content-Type'] = 'application/json';
      reqHeaders['Content-Length'] = Buffer.byteLength(body);
    }

    const req = https.request(
      {
        hostname: row.host,
        port: row.port || 443,
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
            resolve({ status, data: payload });
            return;
          }
          const e = new Error(`HTTP ${status}`);
          e.response = { status, data: payload };
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

async function acquireToken(row, coreApi) {
  const { username, password, authSource } = creds(row, coreApi);
  const { data } = await rawRequest(row, {
    method: 'POST', path: '/auth/token/acquire',
    data: { username, password, ...(authSource ? { authSource } : {}) },
  });
  const token = data?.token;
  if (!token) throw new Error('Aria Operations token acquire returned no token');
  return token;
}

/** Cached token per instance (~25 min TTL). */
async function getToken(row, coreApi, force = false) {
  const cached = tokens.get(row.id);
  if (!force && cached && Date.now() - cached.fetchedAt < TOKEN_TTL_MS) return cached.token;
  const token = await acquireToken(row, coreApi);
  tokens.set(row.id, { token, fetchedAt: Date.now() });
  return token;
}

function invalidateSession(id) {
  tokens.delete(id);
}

/** Authenticated GET with one forced-reacquire retry on 401. */
async function aGet(row, coreApi, path, params = {}) {
  let token = await getToken(row, coreApi);
  const doGet = (t) => rawRequest(row, { method: 'GET', path, params, headers: { Authorization: `vRealizeOpsToken ${t}` } });
  try {
    const { data } = await doGet(token);
    return data;
  } catch (err) {
    if (err.response?.status === 401) {
      token = await getToken(row, coreApi, true);
      const { data } = await doGet(token);
      return data;
    }
    throw err;
  }
}

const fetchVersion = (row, coreApi) => aGet(row, coreApi, '/versions/current');
const fetchNodeStatus = (row, coreApi) => aGet(row, coreApi, '/deployment/node/status');

// Response shapes are unverified — vROps typically wraps resource lists as
// { resourceList: [...] } but some deployments use { resources: [...] }.
const unwrapResources = (d) => d?.resourceList ?? d?.resources ?? [];

/** GET /resources?resourceKind=<kind> — paged, capped at 5000 rows. */
async function fetchResourcesByKind(row, coreApi, kind) {
  const pageSize = 1000;
  const cap = 5000;
  const all = [];
  for (let page = 0; all.length < cap; page++) {
    const data = await aGet(row, coreApi, '/resources', { resourceKind: kind, pageSize, page });
    const items = unwrapResources(data);
    all.push(...items);
    const total = data?.pageInfo?.totalCount;
    if (items.length < pageSize) break;
    if (total != null && all.length >= total) break;
  }
  return all.slice(0, cap);
}

const unwrapAlerts = (d) => (Array.isArray(d) ? d : (d?.alerts ?? []));

/** GET /alerts?activeOnly=true — capped at 5000. */
async function fetchAlerts(row, coreApi) {
  const pageSize = 1000;
  const cap = 5000;
  const all = [];
  for (let page = 0; all.length < cap; page++) {
    const data = await aGet(row, coreApi, '/alerts', { activeOnly: true, pageSize, page });
    const items = unwrapAlerts(data);
    all.push(...items);
    if (items.length < pageSize) break;
  }
  return all.slice(0, cap);
}

function chunk(arr, size) {
  const out = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

/**
 * GET /resources/stats/latest?resourceId=...&statKey=cpu|usage_average&statKey=mem|usage_average
 * Chunked at <=50 resourceIds per call. Returns a Map keyed by resourceId to
 * { cpuPct, memPct, capturedAt } — the last data point per statKey.
 */
async function fetchLatestStats(row, coreApi, resourceIds) {
  const out = new Map();
  for (const ids of chunk(resourceIds, 50)) {
    if (!ids.length) continue;
    let data;
    try {
      const params = new URLSearchParams();
      for (const id of ids) params.append('resourceId', id);
      params.append('statKey', 'cpu|usage_average');
      params.append('statKey', 'mem|usage_average');
      data = await aGet(row, coreApi, '/resources/stats/latest', params);
    } catch (err) {
      coreApi.logger.debug(`[ariaopsApi] latest stats failed for a chunk (skipping): ${err.message}`);
      continue;
    }
    const values = data?.values ?? [];
    for (const v of values) {
      const resourceId = v?.resourceId;
      if (!resourceId) continue;
      const statList = v?.['stat-list']?.stat ?? [];
      let cpuPct = null;
      let memPct = null;
      let capturedAt = null;
      for (const s of statList) {
        const key = s?.statKey?.key;
        const values2 = s?.data;
        if (!Array.isArray(values2) || !values2.length) continue;
        const last = values2[values2.length - 1];
        const timestamps = s?.timestamps;
        const lastTs = Array.isArray(timestamps) ? timestamps[timestamps.length - 1] : null;
        if (key === 'cpu|usage_average') cpuPct = Number(last);
        else if (key === 'mem|usage_average') memPct = Number(last);
        if (lastTs != null) capturedAt = lastTs;
      }
      out.set(String(resourceId), { cpuPct, memPct, capturedAt });
    }
  }
  return out;
}

/**
 * TLS certificate off the raw handshake (host:443) — vROps has no documented
 * cert-management REST endpoint, so this reads the socket's peer certificate
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

/** Validate an Aria Operations instance (saved row or unsaved candidate). Never throws. */
async function testConnection(rowLike, coreApi) {
  const testId = `test-${rowLike.host}`;
  try {
    await getToken({ id: testId, ...rowLike }, coreApi, true);
    const version = await fetchVersion({ id: testId, ...rowLike }, coreApi).catch(() => null);
    tokens.delete(testId);
    return { ok: true, version: version?.releaseName || version?.apiVersion || version?.humanReadable || undefined };
  } catch (err) {
    tokens.delete(testId);
    const status = err.response?.status;
    return {
      ok: false,
      error: status === 401 ? 'Authentication failed — check the Aria Operations username, password and auth source.'
        : (err.response?.data?.message || err.message),
    };
  }
}

function errMsg(e) {
  return e?.response ? `HTTP ${e.response.status}` : (e?.message || String(e));
}

module.exports = {
  getToken, invalidateSession, aGet,
  fetchVersion, fetchNodeStatus, fetchResourcesByKind, fetchAlerts, fetchLatestStats,
  fetchTlsCert, testConnection, errMsg,
};
