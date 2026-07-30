// NetBackup Appliance hardware-monitoring API client (built blind — no live
// 52xx/53xx appliance to validate against). BYO media/primary servers are a
// documented gap: only the appliance management REST surface is targeted
// here, a separate connection type from netbackup_sources (see
// netbackup_appliance_conns). Every fetcher is failure-tolerant per the
// build contract; fetchProbe is the first-contact fix loop.
const axios = require('axios');
const https = require('https');
const { decrypt } = require('./encryption');
const logger = require('../utils/logger');

const SESSION_TTL_MS = 20 * 60 * 1000;
const sessions = new Map(); // connKey -> { token, fetchedAt }
const basicFallback = new Set(); // connKey -> login endpoint 404'd, use Basic auth

const CANDIDATE_PATHS = [
  '/api/appliance/v1.0/hardware/health',
  '/api/appliance/v1.0/monitor/hardware',
  '/api/v1.0/hardware/health',
  '/api/appliance/hardware',
];

const safeMsg = (e) => (e?.response ? `HTTP ${e.response.status}` : (e?.message || String(e)));

/** Accept either camelCase (request bodies) or snake_case (DB rows) fields. */
function normConn(c) {
  return {
    id: c.id,
    name: c.name,
    host: c.host,
    port: c.port || 443,
    username: c.username,
    sslVerify: c.ssl_verify !== undefined ? !!c.ssl_verify : !!c.sslVerify,
    password: c.password,
    encrypted_credentials: c.encrypted_credentials,
  };
}

function creds(conn) {
  if (conn.password) return { password: conn.password };
  if (conn.encrypted_credentials) return JSON.parse(decrypt(conn.encrypted_credentials));
  return {};
}

function connKey(conn) {
  return conn.id != null ? conn.id : `test-${conn.host}`;
}

function baseUrl(conn) {
  return `https://${conn.host}:${conn.port || 443}`;
}

function baseClient(conn, headers = {}) {
  return axios.create({
    baseURL: baseUrl(conn),
    timeout: 30000,
    headers: { Accept: 'application/json', ...headers },
    httpsAgent: new https.Agent({ rejectUnauthorized: !!conn.sslVerify }),
  });
}

/** Password-mode login, cached ~20 min per connection. */
async function login(conn, force = false) {
  const key = connKey(conn);
  const cached = sessions.get(key);
  if (!force && cached && Date.now() - cached.fetchedAt < SESSION_TTL_MS) return cached.token;
  const { password } = creds(conn);
  const { data } = await baseClient(conn).post('/api/appliance/v1.0/auth/login', {
    userName: conn.username, password,
  });
  const token = data?.token || data?.accessToken;
  if (!token) throw new Error('NetBackup appliance login returned no token');
  sessions.set(key, { token, fetchedAt: Date.now() });
  return token;
}

function invalidateSession(connId) {
  sessions.delete(connId);
  basicFallback.delete(connId);
}

/**
 * Authenticated request. Tries token login first; if the login endpoint
 * 404s, falls back to HTTP Basic on this and subsequent requests for the
 * connection. A 401 forces one re-login/retry (token mode only).
 */
async function apiRequest(rawConn, method, path, opts = {}) {
  const conn = normConn(rawConn);
  const key = connKey(conn);
  const { password } = creds(conn);

  if (basicFallback.has(key)) {
    return baseClient(conn, {
      Authorization: `Basic ${Buffer.from(`${conn.username}:${password}`).toString('base64')}`,
    }).request({ method, url: path, params: opts.params, data: opts.data });
  }

  let token;
  try {
    token = await login(conn);
  } catch (err) {
    if (err.response?.status === 404) {
      basicFallback.add(key);
      return baseClient(conn, {
        Authorization: `Basic ${Buffer.from(`${conn.username}:${password}`).toString('base64')}`,
      }).request({ method, url: path, params: opts.params, data: opts.data });
    }
    throw err;
  }

  try {
    return await baseClient(conn, { Authorization: `Bearer ${token}` })
      .request({ method, url: path, params: opts.params, data: opts.data });
  } catch (err) {
    if (err.response?.status === 401) {
      token = await login(conn, true);
      return baseClient(conn, { Authorization: `Bearer ${token}` })
        .request({ method, url: path, params: opts.params, data: opts.data });
    }
    throw err;
  }
}

const STATUS_OK = new Set(['ok', 'normal', 'optimal', 'green', 'good', 'online']);
const STATUS_WARN = new Set(['warning', 'degraded', 'amber', 'predictive']);
const STATUS_CRITICAL = new Set(['critical', 'failed', 'error', 'red', 'offline']);

function normalizeStatus(raw) {
  const s = String(raw ?? '').trim().toLowerCase();
  if (STATUS_OK.has(s)) return 'ok';
  if (STATUS_WARN.has(s)) return 'warning';
  if (STATUS_CRITICAL.has(s)) return 'critical';
  return 'unknown';
}

const TYPE_MAP = [
  [/^disks?$/, 'disk'], [/^hdd$/, 'disk'],
  [/^raid$/, 'raid'], [/^volumegroups?$/, 'raid'],
  [/^fans?$/, 'fan'],
  [/^powersupp(ly|lies)$/, 'psu'], [/^psu$/, 'psu'], [/^power$/, 'psu'],
  [/^temperatures?$/, 'temperature'], [/^thermal$/, 'temperature'],
  [/^networks?$/, 'network'], [/^nics?$/, 'network'], [/^ethernet$/, 'network'], [/^eth$/, 'network'],
  [/^dimms?$/, 'memory'], [/^memory$/, 'memory'],
  [/^cpus?$/, 'cpu'], [/^processors?$/, 'cpu'],
  [/^fibrechannel$/, 'fc'], [/^fc$/, 'fc'], [/^hba$/, 'fc'],
  [/^batter(y|ies)$/, 'battery'], [/^bbu$/, 'battery'],
];

function canonicalType(key) {
  const k = String(key).toLowerCase();
  for (const [re, canon] of TYPE_MAP) {
    if (re.test(k)) return canon;
  }
  return null;
}

function statusFrom(item) {
  return item?.status ?? item?.state ?? item?.health ?? item?.condition ?? null;
}

function nameFrom(item, type, idx) {
  return item?.name ?? item?.componentName ?? item?.id ?? item?.slot ?? item?.location ?? `${type} ${idx + 1}`;
}

/**
 * Deep-walks an arbitrarily-shaped hardware payload for component groups
 * keyed like disk/disks/hdd, raid/volumegroup, fan/fans, etc. Any array (or
 * single object) found under a recognized key becomes normalized rows.
 */
function extractComponents(node, out, seen, depth = 0) {
  if (!node || typeof node !== 'object' || depth > 6) return;
  if (Array.isArray(node)) {
    for (const item of node) extractComponents(item, out, seen, depth + 1);
    return;
  }
  for (const [key, value] of Object.entries(node)) {
    const type = canonicalType(key);
    if (type && value != null) {
      const items = Array.isArray(value) ? value : [value];
      for (let i = 0; i < items.length; i++) {
        const item = items[i];
        if (item == null) continue;
        if (typeof item !== 'object') continue;
        out.push({
          componentType: type,
          componentName: String(nameFrom(item, type, i)),
          status: normalizeStatus(statusFrom(item)),
          stateRaw: statusFrom(item) != null ? String(statusFrom(item)) : null,
          detail: item,
        });
      }
      continue;
    }
    if (value && typeof value === 'object' && !seen.has(value)) {
      seen.add(value);
      extractComponents(value, out, seen, depth + 1);
    }
  }
}

/** Try each candidate path in order until one returns a parsable body. */
async function fetchHardware(rawConn) {
  const conn = normConn(rawConn);
  for (const path of CANDIDATE_PATHS) {
    try {
      const resp = await apiRequest(conn, 'get', path);
      if (resp?.data == null) continue;
      const out = [];
      extractComponents(resp.data, out, new Set());
      return out;
    } catch {
      // try the next candidate
    }
  }
  logger.warn(`[netbackupApplianceApi] hardware fetch failed for all candidate paths on ${conn.name || conn.host}`);
  return [];
}

/** Validate a connection (saved row or unsaved candidate). Never throws. */
async function testConnection(rawCandidate) {
  const conn = normConn(rawCandidate);
  try {
    await login(conn);
    return { ok: true };
  } catch (loginErr) {
    if (loginErr.response?.status !== 404) {
      const status = loginErr.response?.status;
      return {
        ok: false,
        error: status === 401 ? 'Authentication failed — check the appliance credentials.' : safeMsg(loginErr),
      };
    }
    for (const path of CANDIDATE_PATHS) {
      try {
        const resp = await apiRequest(conn, 'get', path);
        if (resp.status === 200) return { ok: true };
      } catch { /* try next candidate */ }
    }
    return { ok: false, error: 'No reachable appliance hardware endpoint.' };
  } finally {
    if (conn.id == null) invalidateSession(connKey(conn));
  }
}

/** Raw-shape probe across every candidate path (no early exit) — the blind-build fix loop. */
async function fetchProbe(rawConn) {
  const conn = normConn(rawConn);
  const out = [];
  for (const path of CANDIDATE_PATHS) {
    try {
      const resp = await apiRequest(conn, 'get', path);
      const body = resp?.data;
      const topLevelKeys = body && typeof body === 'object' ? Object.keys(Array.isArray(body) ? body[0] || {} : body) : [];
      const firstItem = Array.isArray(body) ? (body[0] ?? null) : body ?? null;
      out.push({ path, httpStatus: resp.status, ok: true, topLevelKeys, firstItem });
    } catch (err) {
      out.push({
        path, httpStatus: err.response?.status ?? null, ok: false, topLevelKeys: [], firstItem: null,
      });
    }
  }
  return out;
}

module.exports = {
  normConn, invalidateSession, apiRequest,
  fetchHardware, testConnection, fetchProbe, normalizeStatus,
};
