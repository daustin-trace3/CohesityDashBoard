// Veeam Backup & Replication REST API client (Nutanix Mine sub-connection).
// OAuth2 password grant against :9419/api/v1/token, then Bearer; requires the
// x-api-version header per Veeam's REST versioning scheme. Best-effort by
// design — a Mine source's poll must succeed even when Veeam is unreachable
// (contract: "veeam error -> veeam conn last_poll_status only").
const axios = require('axios');
const https = require('https');
const { decrypt } = require('./encryption');

const API_VERSION_HEADER = '1.0-rev1';
const tokens = new Map(); // conn.id -> { token, fetchedAt }
const TOKEN_TTL_MS = 14 * 60 * 1000;

function creds(conn) {
  if (conn.password != null) return { username: conn.username, password: conn.password };
  if (!conn.encrypted_credentials) return { username: conn.username, password: null };
  try {
    const c = JSON.parse(decrypt(conn.encrypted_credentials));
    return { username: conn.username, password: c.password };
  } catch {
    return { username: conn.username, password: null };
  }
}

function baseClient(conn, headers = {}) {
  const port = conn.port || 9419;
  return axios.create({
    baseURL: `https://${conn.host}:${port}`,
    timeout: 30000,
    headers: { 'x-api-version': API_VERSION_HEADER, ...headers },
    httpsAgent: new https.Agent({ rejectUnauthorized: !!conn.ssl_verify }),
  });
}

async function login(conn) {
  const { username, password } = creds(conn);
  if (!username || !password) throw new Error('Veeam connection is missing credentials');
  const params = new URLSearchParams({ grant_type: 'password', username, password });
  const { data } = await baseClient(conn, { 'Content-Type': 'application/x-www-form-urlencoded' })
    .post('/api/v1/token', params.toString());
  const token = data?.access_token;
  if (!token) throw new Error('Veeam login returned no access token');
  return token;
}

async function getToken(conn, force = false) {
  const cached = tokens.get(conn.id);
  if (!force && cached && Date.now() - cached.fetchedAt < TOKEN_TTL_MS) return cached.token;
  const token = await login(conn);
  tokens.set(conn.id, { token, fetchedAt: Date.now() });
  return token;
}

function invalidateToken(connId) {
  tokens.delete(connId);
}

async function vReq(conn, path, params) {
  let token = await getToken(conn);
  const doCall = (t) => baseClient(conn, { Authorization: `Bearer ${t}` }).get(path, { params });
  try {
    const res = await doCall(token);
    return res.data;
  } catch (err) {
    if (err.response?.status === 401) {
      token = await getToken(conn, true);
      const res = await doCall(token);
      return res.data;
    }
    throw err;
  }
}

const safeArr = (v) => (Array.isArray(v) ? v : []);
const strOrNull = (v) => (v == null ? null : String(v));
const numOrNull = (v) => {
  if (v == null) return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};

async function fetchJobs(conn) {
  const d = await vReq(conn, '/api/v1/jobs');
  return safeArr(d?.data).map((j) => ({
    jobUid: strOrNull(j.id),
    name: strOrNull(j.name),
    type: strOrNull(j.type),
    lastResult: strOrNull(j.lastResult),
    lastRunAt: strOrNull(j.lastRun),
    description: strOrNull(j.description),
  }));
}

async function fetchRepositories(conn) {
  const d = await vReq(conn, '/api/v1/backupInfrastructure/repositories/states');
  return safeArr(d?.data).map((r) => ({
    repoUid: strOrNull(r.id ?? r.repositoryId),
    name: strOrNull(r.name),
    capacityBytes: numOrNull(r.capacityGB) != null ? numOrNull(r.capacityGB) * 1024 ** 3 : null,
    freeBytes: numOrNull(r.freeGB) != null ? numOrNull(r.freeGB) * 1024 ** 3 : null,
    usedBytes: numOrNull(r.usedSpaceGB) != null ? numOrNull(r.usedSpaceGB) * 1024 ** 3 : null,
  }));
}

async function testConnection(connLike) {
  try {
    await login(connLike);
    return { ok: true };
  } catch (err) {
    const status = err.response?.status;
    return {
      ok: false,
      error: status === 401 ? 'Authentication failed — check the Veeam username and password.'
        : (err.response?.data?.message || err.message),
    };
  } finally {
    invalidateToken(connLike.id);
  }
}

module.exports = { invalidateToken, testConnection, fetchJobs, fetchRepositories };
