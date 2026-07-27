// VMware Aria Operations (vROps Suite API) client. Doug has no live vROps to
// test against, so every upstream response shape below is UNVERIFIED —
// fetchers parse defensively (optional chaining, accept either of several
// candidate field/wrapper names) and the probe route (routes/ariaops.js)
// exists specifically to see the real shapes against a live instance.
// Auth: POST /suite-api/api/auth/token/acquire -> { token, validity }, then
// header `Authorization: vRealizeOpsToken <token>` on every other call.
const axios = require('axios');
const https = require('https');
const tls = require('tls');
const { decrypt } = require('./encryption');
const logger = require('../utils/logger');

const TOKEN_TTL_MS = 25 * 60 * 1000;
const tokens = new Map(); // instance.id -> { token, fetchedAt }

function creds(row) {
  // Unsaved candidates (test connection) carry a plaintext password;
  // registered rows carry the encrypted blob.
  const password = row.password ? row.password : JSON.parse(decrypt(row.encrypted_credentials)).password;
  return { username: row.username, password, authSource: row.auth_source || undefined };
}

function baseClient(row, headers = {}) {
  return axios.create({
    baseURL: `https://${row.host}/suite-api/api`,
    timeout: 60000,
    headers: { Accept: 'application/json', ...headers },
    httpsAgent: new https.Agent({ rejectUnauthorized: !!row.ssl_verify }),
  });
}

async function acquireToken(row) {
  const { username, password, authSource } = creds(row);
  const { data } = await baseClient(row).post('/auth/token/acquire', {
    username, password, ...(authSource ? { authSource } : {}),
  });
  const token = data?.token;
  if (!token) throw new Error('Aria Operations token acquire returned no token');
  return token;
}

/** Cached token per instance (~25 min TTL). */
async function getToken(row, force = false) {
  const cached = tokens.get(row.id);
  if (!force && cached && Date.now() - cached.fetchedAt < TOKEN_TTL_MS) return cached.token;
  const token = await acquireToken(row);
  tokens.set(row.id, { token, fetchedAt: Date.now() });
  return token;
}

function invalidateSession(id) {
  tokens.delete(id);
}

/** Authenticated GET with one forced-reacquire retry on 401. */
async function aGet(row, path, params = {}) {
  let token = await getToken(row);
  const doGet = (t) => baseClient(row, { Authorization: `vRealizeOpsToken ${t}` }).get(path, { params });
  try {
    const { data } = await doGet(token);
    return data;
  } catch (err) {
    if (err.response?.status === 401) {
      token = await getToken(row, true);
      const { data } = await doGet(token);
      return data;
    }
    throw err;
  }
}

const fetchVersion = (row) => aGet(row, '/versions/current');
const fetchNodeStatus = (row) => aGet(row, '/deployment/node/status');

// Response shapes are unverified — vROps typically wraps resource lists as
// { resourceList: [...] } but some deployments use { resources: [...] }.
const unwrapResources = (d) => d?.resourceList ?? d?.resources ?? [];

/** GET /resources?resourceKind=<kind> — paged, capped at 5000 rows. */
async function fetchResourcesByKind(row, kind) {
  const pageSize = 1000;
  const cap = 5000;
  const all = [];
  for (let page = 0; all.length < cap; page++) {
    const data = await aGet(row, '/resources', { resourceKind: kind, pageSize, page });
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
async function fetchAlerts(row) {
  const pageSize = 1000;
  const cap = 5000;
  const all = [];
  for (let page = 0; all.length < cap; page++) {
    const data = await aGet(row, '/alerts', { activeOnly: true, pageSize, page });
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
async function fetchLatestStats(row, resourceIds) {
  const out = new Map();
  for (const ids of chunk(resourceIds, 50)) {
    if (!ids.length) continue;
    let data;
    try {
      const params = new URLSearchParams();
      for (const id of ids) params.append('resourceId', id);
      params.append('statKey', 'cpu|usage_average');
      params.append('statKey', 'mem|usage_average');
      data = await aGet(row, '/resources/stats/latest', params);
    } catch (err) {
      logger.debug(`[ariaopsApi] latest stats failed for a chunk (skipping): ${err.message}`);
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
async function testConnection(rowLike) {
  const testId = `test-${rowLike.host}`;
  try {
    await getToken({ id: testId, ...rowLike }, true);
    const version = await fetchVersion({ id: testId, ...rowLike }).catch(() => null);
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

module.exports = {
  getToken, invalidateSession, aGet,
  fetchVersion, fetchNodeStatus, fetchResourcesByKind, fetchAlerts, fetchLatestStats,
  fetchTlsCert, testConnection,
};
