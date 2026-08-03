// NetBackup API client (built blind — no live NetBackup to validate against;
// every fetcher below is failure-tolerant per the build contract). Upstream
// is NetBackup 11.x's JSON:API-flavored REST API, base
// `https://<host>:<port>/netbackup` for a primary server, or the tenant's
// full base URL for Alta SaaS (source_type = 'alta', auth_mode = 'apikey').
const axios = require('axios');
const https = require('https');
const { decrypt } = require('./encryption');
const logger = require('../utils/logger');

const ACCEPT_HEADER = 'application/vnd.netbackup+json;version=12.0';
const SESSION_TTL_MS = 20 * 60 * 1000;
const sessions = new Map(); // sessionKey -> { token, fetchedAt }

const safeMsg = (e) => (e?.response ? `HTTP ${e.response.status}` : (e?.message || String(e)));

/** Accept either camelCase (request bodies) or snake_case (DB rows) fields. */
function normSource(s) {
  return {
    id: s.id,
    name: s.name,
    host: s.host,
    port: s.port || 1556,
    sourceType: s.source_type || s.sourceType || 'primary',
    authMode: s.auth_mode || s.authMode || 'password',
    username: s.username,
    domainName: s.domain_name ?? s.domainName ?? null,
    domainType: s.domain_type ?? s.domainType ?? null,
    sslVerify: s.ssl_verify !== undefined ? !!s.ssl_verify : !!s.sslVerify,
    password: s.password,
    apiKey: s.apiKey ?? s.api_key,
    encrypted_credentials: s.encrypted_credentials,
  };
}

function creds(source) {
  if (source.password) return { password: source.password };
  if (source.apiKey) return { apiKey: source.apiKey };
  if (source.encrypted_credentials) return JSON.parse(decrypt(source.encrypted_credentials));
  return {};
}

function baseUrl(source) {
  if (source.sourceType === 'alta') return String(source.host).replace(/\/+$/, '');
  return `https://${source.host}:${source.port || 1556}/netbackup`;
}

function baseClient(source, headers = {}) {
  return axios.create({
    baseURL: baseUrl(source),
    timeout: 60000,
    headers: { Accept: ACCEPT_HEADER, ...headers },
    httpsAgent: new https.Agent({ rejectUnauthorized: !!source.sslVerify }),
  });
}

const sessionKey = (source) => (source.id != null ? source.id : `test-${source.host}`);

/** Password-mode login, cached ~20 min per source. Apikey mode never logs in. */
async function login(source, force = false) {
  const key = sessionKey(source);
  const cached = sessions.get(key);
  if (!force && cached && Date.now() - cached.fetchedAt < SESSION_TTL_MS) return cached.token;
  const { password } = creds(source);
  const body = { userName: source.username, password };
  if (source.domainName) body.domainName = source.domainName;
  if (source.domainType) body.domainType = source.domainType;
  const { data } = await baseClient(source).post('/login', body);
  const token = data?.token;
  if (!token) throw new Error('NetBackup login returned no token');
  sessions.set(key, { token, fetchedAt: Date.now() });
  return token;
}

function invalidateSession(sourceId) {
  sessions.delete(sourceId);
}

/**
 * Authenticated request with the two documented fallbacks: a 401 (password
 * mode only) re-logs-in and retries once; a 406 retries once with a wildcard
 * Accept header instead of the versioned media type.
 */
async function apiRequest(rawSource, method, path, opts = {}) {
  const source = normSource(rawSource);
  const authValueFor = async (force = false) => (
    source.authMode === 'apikey' ? creds(source).apiKey : login(source, force)
  );
  let authValue = await authValueFor();
  const doCall = (val, accept) => baseClient(source, { Authorization: val, Accept: accept })
    .request({ method, url: path, params: opts.params, data: opts.data });

  try {
    return await doCall(authValue, ACCEPT_HEADER);
  } catch (err) {
    if (err.response?.status === 401 && source.authMode !== 'apikey') {
      try {
        authValue = await authValueFor(true);
        return await doCall(authValue, ACCEPT_HEADER);
      } catch (err2) {
        err = err2;
      }
    }
    if (err.response?.status === 406) {
      return doCall(authValue, '*/*');
    }
    throw err;
  }
}

/** Normalizes JSON:API `{data:[...]}`, `{data:{...}}`, or a bare array into `[{id, ...attributes}]`. */
function jsonApiList(resp) {
  const body = resp?.data;
  const toRow = (item) => (item && typeof item === 'object' && 'attributes' in item
    ? { id: item.id, ...item.attributes }
    : item);
  if (Array.isArray(body)) return body.map(toRow);
  const data = body?.data;
  if (Array.isArray(data)) return data.map(toRow);
  if (data && typeof data === 'object') return [toRow(data)];
  return [];
}

/** page[limit]/page[offset] pagination, short/empty page or 20-page cap ends the loop. */
async function fetchPaginated(source, path, extraParams = {}) {
  const results = [];
  const limit = 100;
  let offset = 0;
  for (let page = 0; page < 20; page++) {
    const resp = await apiRequest(source, 'get', path, {
      params: { ...extraParams, 'page[limit]': limit, 'page[offset]': offset },
    });
    const items = jsonApiList(resp);
    if (!items.length) break;
    results.push(...items);
    if (items.length < limit) break;
    offset += limit;
  }
  return results;
}

const loggedFailures = new Set();
/**
 * Never throws: logs the first failure per (source, label) and returns null
 * to signal failure. A successful fetch that legitimately found nothing
 * returns [] — callers MUST treat null (skip store/delete) differently from
 * [] (store the empty result, clearing prior rows).
 */
async function tolerantList(source, label, fn) {
  try {
    return await fn();
  } catch (err) {
    const key = `${source.id ?? source.host}:${label}`;
    if (!loggedFailures.has(key)) {
      loggedFailures.add(key);
      logger.warn(`[netbackupApi] ${label} fetch failed for ${source.name || source.host}: ${safeMsg(err)}`);
    }
    return null;
  }
}

const isFailedState = (j) => j.state === 'FAILED'
  || (['EXITED', 'DONE'].includes(j.state) && Number(j.statusCode ?? j.status ?? 0) > 0);

/** Jobs from the last `days` days; on a 400 filter error, refetch unfiltered and cut client-side. */
async function fetchJobs(source, days = 7) {
  return tolerantList(source, 'jobs', async () => {
    const sinceIso = new Date(Date.now() - days * 86400000).toISOString();
    try {
      return await fetchPaginated(source, '/admin/jobs', { sort: '-startTime', filter: `startTime ge '${sinceIso}'` });
    } catch (err) {
      if (err.response?.status !== 400) throw err;
      const all = await fetchPaginated(source, '/admin/jobs', { sort: '-startTime' });
      return all.filter((j) => !j.startTime || new Date(j.startTime) >= new Date(sinceIso));
    }
  });
}

async function fetchPolicies(source) {
  return tolerantList(source, 'policies', async () => {
    const items = await fetchPaginated(source, '/config/policies');
    return items.map((p) => {
      const inner = p.policy && typeof p.policy === 'object' ? p.policy : p;
      const attrs = inner.policyAttributes || {};
      return {
        id: p.id,
        policyName: inner.policyName ?? null,
        policyType: inner.policyType ?? null,
        active: attrs.active !== undefined ? !!attrs.active : (inner.active === undefined ? true : !!inner.active),
        clients: inner.clients || [],
        schedules: inner.schedules || [],
        selections: inner.backupSelections?.selections || [],
      };
    });
  });
}

async function fetchStorageUnits(source) {
  return tolerantList(source, 'storageUnits', async () => {
    const items = await fetchPaginated(source, '/storage/storage-units');
    return items.map((u) => ({
      id: u.id,
      name: u.name ?? null,
      storageUnitType: u.storageUnitType ?? null,
      diskPool: u.diskPool ?? null,
      mediaServerName: u.mediaServerName ?? null,
      maxConcurrentJobs: u.maxConcurrentJobs ?? null,
      capacityBytes: u.totalCapacityBytes ?? u.capacityBytes ?? null,
      freeBytes: u.freeCapacityBytes ?? u.freeSpaceBytes ?? null,
      usedBytes: u.usedCapacityBytes ?? null,
    }));
  });
}

async function fetchDiskPools(source) {
  return tolerantList(source, 'diskPools', async () => {
    const items = await fetchPaginated(source, '/storage/disk-pools');
    return items.map((d) => ({
      id: d.id,
      name: d.name ?? null,
      serverType: d.serverType ?? null,
      status: d.status ?? null,
      totalCapacityBytes: d.totalCapacityBytes ?? null,
      usedCapacityBytes: d.usedCapacityBytes ?? null,
      availableCapacityBytes: d.availableCapacityBytes ?? null,
      volumeCount: d.volumeCount ?? null,
    }));
  });
}

async function fetchMediaServers(source) {
  return tolerantList(source, 'mediaServers', async () => {
    const items = await fetchPaginated(source, '/config/media-servers');
    return items.map((m) => ({
      id: m.id,
      name: m.mediaServerName ?? m.name ?? null,
      state: m.state ?? m.status ?? null,
      version: m.version ?? null,
    }));
  });
}

function classifyAppliance(h) {
  const blob = `${h.hostType || ''} ${h.hardwareDescription || ''} ${h.applianceModel || ''}`.toLowerCase();
  if (blob.includes('flex')) return 'flex';
  if (/appliance|nba|52\d\d|53\d\d/i.test(`${h.applianceModel || ''} ${h.hardwareDescription || ''}`)) return 'appliance';
  return 'byo';
}

async function fetchHosts(source) {
  return tolerantList(source, 'hosts', async () => {
    const items = await fetchPaginated(source, '/config/hosts');
    return items.map((h) => ({
      id: h.id,
      name: h.hostName ?? h.name ?? null,
      hostType: h.hostType ?? null,
      applianceType: classifyAppliance(h),
      model: h.applianceModel ?? null,
      serialNumber: h.serialNumber ?? null,
      osType: h.osType ?? null,
      osVersion: h.osVersion ?? null,
      cpuArchitecture: h.cpuArchitecture ?? null,
      nbuVersion: h.nbuVersion ?? h.version ?? null,
      raw: h,
    }));
  });
}

/** `/manage/notifications` first, `/admin/alerts` fallback; both 404/501 -> empty. */
async function fetchAlerts(source) {
  return tolerantList(source, 'alerts', async () => {
    let items;
    try {
      items = await fetchPaginated(source, '/manage/notifications');
    } catch (err) {
      if (![404, 501].includes(err.response?.status)) throw err;
      try {
        items = await fetchPaginated(source, '/admin/alerts');
      } catch (err2) {
        if ([404, 501].includes(err2.response?.status)) return [];
        throw err2;
      }
    }
    return items.map((a) => ({
      alertId: String(a.id ?? a.alertId ?? ''),
      severity: a.severity ?? a.priority ?? null,
      category: a.notificationType ?? a.category ?? null,
      message: a.message ?? a.description ?? null,
      occurredAt: a.createdDateTime ?? a.occurredDateTime ?? null,
    })).filter((a) => a.alertId);
  });
}

/** `/storage/slps` first, `/config/slps` fallback; both 404/501 -> empty. */
async function fetchSlps(source) {
  return tolerantList(source, 'slps', async () => {
    let items;
    try {
      items = await fetchPaginated(source, '/storage/slps');
    } catch (err) {
      if (![404, 501].includes(err.response?.status)) throw err;
      try {
        items = await fetchPaginated(source, '/config/slps');
      } catch (err2) {
        if ([404, 501].includes(err2.response?.status)) return [];
        throw err2;
      }
    }
    return items.map((s) => ({
      name: s.slpName ?? s.name ?? null,
      version: s.version ?? null,
      dataClassification: s.dataClassification ?? null,
      priority: s.priority ?? null,
      operations: Array.isArray(s.operations) ? s.operations : [],
    })).filter((s) => s.name);
  });
}

/** `/licensing/capacity` first, `/admin/licensing` fallback; both 404/501 -> null. */
async function fetchLicensing(source) {
  try {
    const resp = await apiRequest(source, 'get', '/licensing/capacity');
    return resp.data ?? null;
  } catch (err) {
    if (![404, 501].includes(err.response?.status)) {
      logger.warn(`[netbackupApi] licensing fetch failed for ${source.name || source.host}: ${safeMsg(err)}`);
    }
    try {
      const resp2 = await apiRequest(source, 'get', '/admin/licensing');
      return resp2.data ?? null;
    } catch (err2) {
      if (![404, 501].includes(err2.response?.status)) {
        logger.warn(`[netbackupApi] licensing fallback fetch failed for ${source.name || source.host}: ${safeMsg(err2)}`);
      }
      return null;
    }
  }
}

/** Raw-shape probe: one capped fetch per section, for the blind-build fix loop. */
async function fetchProbe(rawSource) {
  const source = normSource(rawSource);
  const sections = {
    jobs: () => apiRequest(source, 'get', '/admin/jobs', { params: { 'page[limit]': 5, sort: '-startTime' } }),
    policies: () => apiRequest(source, 'get', '/config/policies', { params: { 'page[limit]': 5 } }),
    storageUnits: () => apiRequest(source, 'get', '/storage/storage-units', { params: { 'page[limit]': 5 } }),
    diskPools: () => apiRequest(source, 'get', '/storage/disk-pools', { params: { 'page[limit]': 5 } }),
    mediaServers: () => apiRequest(source, 'get', '/config/media-servers', { params: { 'page[limit]': 5 } }),
    hosts: () => apiRequest(source, 'get', '/config/hosts', { params: { 'page[limit]': 5 } }),
    alerts: () => apiRequest(source, 'get', '/manage/notifications', { params: { 'page[limit]': 5 } }),
    slps: () => apiRequest(source, 'get', '/storage/slps', { params: { 'page[limit]': 5 } }),
  };
  const out = {};
  for (const [name, fn] of Object.entries(sections)) {
    try {
      const resp = await fn();
      const items = jsonApiList(resp);
      out[name] = { ok: true, status: resp.status, count: items.length, firstItem: items[0] ?? null };
    } catch (err) {
      out[name] = { ok: false, status: err.response?.status ?? null, count: 0, firstItem: null, error: safeMsg(err) };
    }
  }
  return out;
}

/** Validate a source (saved row or unsaved candidate). Never throws. */
async function testConnection(rawCandidate) {
  const source = normSource(rawCandidate);
  try {
    let version = null;
    try {
      const resp = await apiRequest(source, 'get', '/ping');
      version = typeof resp.data === 'string' ? resp.data : null;
    } catch {
      await apiRequest(source, 'get', '/admin/hosts', { params: { 'page[limit]': 1 } });
    }
    return { ok: true, version };
  } catch (err) {
    const status = err.response?.status;
    return {
      ok: false,
      error: status === 401 ? 'Authentication failed — check the NetBackup credentials.' : safeMsg(err),
    };
  } finally {
    if (source.id == null) invalidateSession(sessionKey(source));
  }
}

module.exports = {
  normSource, invalidateSession, apiRequest, jsonApiList,
  fetchJobs, fetchPolicies, fetchStorageUnits, fetchDiskPools, fetchMediaServers, fetchHosts, fetchAlerts,
  fetchSlps, fetchLicensing,
  fetchProbe, testConnection, isFailedState,
};
