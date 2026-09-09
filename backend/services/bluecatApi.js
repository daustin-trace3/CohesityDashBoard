// BlueCat Address Manager (BAM) v2 API client. Base
// https://{host}:{port}/api/v2. Login is a session exchange (POST
// /sessions -> basicAuthenticationCredentials); every subsequent call sends
// `Authorization: Basic <that value verbatim>` + `Accept: application/hal+json`.
// Session is cached in memory per source id and refreshed on 401 or within 5
// minutes of the stated expiry (aria/nutanix session-cache pattern). No BAM
// is reachable during this build — every parser null-guards and tolerates a
// missing/renamed field rather than throwing (contract: blind build).
const axios = require('axios');
const https = require('https');
const { decrypt } = require('./encryption');
const logger = require('../utils/logger');

const sessions = new Map(); // source.id -> { basicAuthCredentials, expiresAt }
const REFRESH_MARGIN_MS = 5 * 60 * 1000;

// ── Credentials / client plumbing ───────────────────────────────────────────

function creds(source) {
  // Unsaved candidates (test connection) carry a plaintext username/password;
  // registered rows carry the encrypted blob.
  if (source.username != null && source.password != null) {
    return { username: source.username, password: source.password };
  }
  if (!source.encrypted_credentials) return { username: null, password: null };
  try {
    const c = JSON.parse(decrypt(source.encrypted_credentials));
    return { username: c.username || null, password: c.password || null };
  } catch {
    return { username: null, password: null };
  }
}

function baseUrl(source) {
  const port = source.port || 443;
  return `https://${source.host}:${port}`;
}

function rawClient(source, timeout = 30000) {
  return axios.create({
    baseURL: `${baseUrl(source)}/api/v2`,
    timeout,
    httpsAgent: new https.Agent({ rejectUnauthorized: !!source.ssl_verify }),
    validateStatus: (s) => s >= 200 && s < 500,
  });
}

// ── Parsing helpers (failure-tolerant) ──────────────────────────────────────

function numOrNull(v) {
  if (v == null || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function strOrNull(v) {
  return v == null ? null : String(v);
}

function boolToInt(v) {
  return v ? 1 : 0;
}

function jsonOrNull(v) {
  if (v == null) return null;
  try {
    return JSON.stringify(v);
  } catch {
    return null;
  }
}

const safeArr = (v) => (Array.isArray(v) ? v : []);

function errMsg(err) {
  if (err?.response) {
    const body = err.response.data;
    const msg = body?.message || body?.reason || body?.code;
    return `HTTP ${err.response.status}${msg ? `: ${msg}` : ''}`;
  }
  return err?.message || String(err);
}

function errCode(err) {
  return err?.response?.data?.code || null;
}

// ── Session management ──────────────────────────────────────────────────────

async function login(source) {
  const { username, password } = creds(source);
  if (!username || !password) throw new Error('BlueCat source has no usable credentials');
  const client = rawClient(source);
  const res = await client.post('/sessions', { username, password });
  if (res.status >= 400) {
    const err = new Error(errMsg({ response: res }));
    err.response = res;
    throw err;
  }
  const data = res.data || {};
  const basicAuthCredentials = data.basicAuthenticationCredentials;
  if (!basicAuthCredentials) throw new Error('BlueCat login returned no basicAuthenticationCredentials');
  let expiresAt = null;
  if (data.apiTokenExpirationDateTime) {
    const t = new Date(data.apiTokenExpirationDateTime).getTime();
    if (Number.isFinite(t)) expiresAt = t;
  }
  return {
    basicAuthCredentials,
    apiToken: data.apiToken || null,
    readOnly: !!data.readOnly,
    expiresAt,
    fetchedAt: Date.now(),
  };
}

async function getSession(source, force = false) {
  const cached = sessions.get(source.id);
  if (!force && cached) {
    const nearExpiry = cached.expiresAt != null && Date.now() >= cached.expiresAt - REFRESH_MARGIN_MS;
    if (!nearExpiry) return cached;
  }
  const session = await login(source);
  if (source.id != null) sessions.set(source.id, session);
  return session;
}

function invalidateSession(sourceId) {
  sessions.delete(sourceId);
}

async function logout(source) {
  try {
    const session = sessions.get(source.id);
    if (!session) return;
    const client = rawClient(source);
    await client.patch('/sessions/current', { state: 'LOGGED_OUT' }, {
      headers: { Authorization: `Basic ${session.basicAuthCredentials}`, Accept: 'application/hal+json' },
    });
  } catch { /* best-effort */ } finally {
    invalidateSession(source.id);
  }
}

// ── Low-level request with 401 retry + fields fallback ──────────────────────

async function request(source, method, path, { params, data, timeout = 30000, retriedAuth = false } = {}) {
  const session = await getSession(source);
  const client = rawClient(source, timeout);
  const res = await client.request({
    method, url: path, params, data,
    headers: { Authorization: `Basic ${session.basicAuthCredentials}`, Accept: 'application/hal+json' },
  });
  if (res.status === 401 && !retriedAuth) {
    const code = res.data?.code;
    if (code === 'InvalidAuthorizationToken' || code == null) {
      await getSession(source, true);
      return request(source, method, path, { params, data, timeout, retriedAuth: true });
    }
  }
  if (res.status >= 400) {
    const err = new Error(errMsg({ response: res }));
    err.response = res;
    throw err;
  }
  return res.data;
}

const apiGet = (source, path, opts) => request(source, 'get', path, opts);

/** GET with a `fields` param, retrying once WITHOUT fields on a 400 (a field
 *  name may not exist on this BAM version). */
async function getWithFieldsFallback(source, path, params, timeout) {
  try {
    return await apiGet(source, path, { params, timeout });
  } catch (err) {
    if (err.response?.status === 400 && params?.fields) {
      logger.warn(`[BluecatApi] ${path} 400'd with fields=${params.fields}, retrying without fields`);
      const { fields, ...rest } = params;
      return apiGet(source, path, { params: rest, timeout });
    }
    throw err;
  }
}

const MAX_PAGE_ROWS = 200000;

/** offset/limit pager. `count` in the response is the PAGE size, not a
 *  total — loop until count < limit or the row cap is hit. */
async function pagedGet(source, path, { filter, fields, limit = 1000, timeout = 30000, cap = MAX_PAGE_ROWS } = {}) {
  const out = [];
  let offset = 0;
  for (;;) {
    const params = { offset, limit };
    if (filter) params.filter = filter;
    if (fields) params.fields = fields;
    const d = fields
      ? await getWithFieldsFallback(source, path, params, timeout)
      : await apiGet(source, path, { params, timeout });
    const rows = safeArr(d?.data);
    out.push(...rows);
    const count = numOrNull(d?.count) ?? rows.length;
    offset += rows.length;
    if (!rows.length || count < limit || out.length >= cap) {
      if (out.length >= cap) logger.warn(`[BluecatApi] ${path} capped at ${cap} rows`);
      break;
    }
  }
  return out;
}

// ── Version / configurations ────────────────────────────────────────────────

async function fetchVersion(source, timeout) {
  try {
    const d = await apiGet(source, '/settings', { params: { filter: "type:'SystemSettings'" }, timeout });
    return strOrNull(safeArr(d?.data)[0]?.version);
  } catch {
    return null;
  }
}

async function fetchConfigurations(source, timeout) {
  const rows = await pagedGet(source, '/configurations', { fields: 'id,name', timeout });
  return rows.map((c) => ({ id: numOrNull(c.id), name: strOrNull(c.name) }));
}

async function fetchViews(source, configId, timeout) {
  const rows = await pagedGet(source, `/configurations/${configId}/views`, { timeout });
  return rows.map((v) => ({
    id: numOrNull(v.id),
    name: strOrNull(v.name),
    configurationId: numOrNull(v.configuration?.id ?? configId),
    configurationName: strOrNull(v.configuration?.name),
  }));
}

// ── Zones / records ──────────────────────────────────────────────────────────

function parseZone(z) {
  return {
    id: numOrNull(z.id),
    type: strOrNull(z.type),
    name: strOrNull(z.name),
    absoluteName: strOrNull(z.absoluteName),
    viewId: numOrNull(z.view?.id),
    configurationId: numOrNull(z.configuration?.id),
    deploymentEnabled: z.deploymentEnabled != null ? boolToInt(z.deploymentEnabled) : (z.deployable != null ? boolToInt(z.deployable) : null),
    dynamicUpdateEnabled: z.dynamicUpdateEnabled != null ? boolToInt(z.dynamicUpdateEnabled) : null,
    signed: z.signed != null ? boolToInt(z.signed) : (z.signingPolicy ? 1 : null),
    upHref: strOrNull(z._links?.up?.href),
    raw: z,
  };
}

async function fetchZones(source, timeout) {
  const rows = await pagedGet(source, '/zones', { limit: 1000, timeout });
  return rows.map(parseZone);
}

function deriveRrType(r) {
  const type = r.type || '';
  if (type === 'HostRecord') {
    const addrs = recordAddresses(r);
    const hasV6 = addrs.some((a) => a.address.includes(':'));
    return hasV6 ? 'AAAA' : 'A';
  }
  if (type === 'AliasRecord') return 'CNAME';
  if (type === 'GenericRecord') return strOrNull(r.recordType) || 'GENERIC';
  return type.replace(/Record$/, '') || null;
}

/** Host record addresses arrive inline (`addresses`, POST echoes and some
 *  builds) or under `_embedded.addresses` (fields=embed(addresses), the HAL
 *  contract). Read both; entries may be objects or bare strings. */
function recordAddresses(r) {
  const out = [];
  const seen = new Set();
  for (const a of [...safeArr(r.addresses), ...safeArr(r._embedded?.addresses)]) {
    const address = typeof a === 'string' ? a : strOrNull(a?.address);
    if (!address || seen.has(address)) continue;
    seen.add(address);
    out.push({ address, state: typeof a === 'object' && a ? strOrNull(a.state) : null, type: typeof a === 'object' && a ? strOrNull(a.type) : null });
  }
  return out;
}

function deriveRdata(r) {
  const type = r.type || '';
  if (type === 'HostRecord') {
    const addrs = recordAddresses(r).map((a) => a.address);
    return addrs.length ? addrs.join(',') : null;
  }
  if (type === 'AliasRecord' || type === 'MXRecord' || type === 'SRVRecord') {
    return strOrNull(r.linkedRecord?.absoluteName);
  }
  if (type === 'GenericRecord') return strOrNull(r.rdata);
  if (type === 'TXTRecord') return strOrNull(r.text ?? r.rdata);
  return strOrNull(r.rdata);
}

function parseRecord(r) {
  const upHref = strOrNull(r._links?.up?.href);
  const zoneId = upHref ? numOrNull((upHref.match(/\/zones\/(\d+)/) || [])[1]) : null;
  return {
    id: numOrNull(r.id),
    type: strOrNull(r.type),
    name: strOrNull(r.name),
    absoluteName: strOrNull(r.absoluteName),
    zoneId,
    viewId: numOrNull(r.view?.id),
    rrType: deriveRrType(r),
    rdata: deriveRdata(r),
    ttl: numOrNull(r.ttl),
    addresses: recordAddresses(r),
    comment: strOrNull(r.comment),
  };
}

async function fetchResourceRecords(source, timeout) {
  const fields = 'id,type,name,absoluteName,ttl,comment,recordType,rdata,linkedRecord,embed(addresses)';
  const rows = await pagedGet(source, '/resourceRecords', { fields, limit: 1000, timeout });
  return rows.map(parseRecord);
}

/** searchRecords ladder (routes/bluecat.js /records/lookup): filter search ->
 *  root search -> address lookup -> failure. Never throws — returns
 *  {ok:false, error}. */
async function searchRecords(source, q, timeout = 15000) {
  const escaped = String(q).replace(/'/g, "''");
  try {
    const d = await apiGet(source, '/resourceRecords', {
      params: { filter: `absoluteName:contains('${escaped}') or name:contains('${escaped}')`, limit: 200 },
      timeout,
    });
    return { ok: true, method: 'flat', results: safeArr(d?.data) };
  } catch (err) {
    if (err.response?.status !== 400 || errCode(err) !== 'InvalidFilterField') {
      // fall through to the next rung regardless of the specific reason
    }
  }
  try {
    const d = await apiGet(source, '/api/v2', { params: { filter: `name:contains('${escaped}')`, limit: 200 }, timeout });
    return { ok: true, method: 'root', results: safeArr(d?.data) };
  } catch { /* fall through */ }
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(String(q))) {
    try {
      const addrs = await apiGet(source, '/addresses', { params: { filter: `address:eq('${escaped}')` }, timeout });
      const addr = safeArr(addrs?.data)[0];
      if (addr?.id) {
        const recs = await apiGet(source, `/addresses/${addr.id}/resourceRecords`, { timeout });
        return { ok: true, method: 'address', results: safeArr(recs?.data) };
      }
    } catch (err) {
      return { ok: false, error: errMsg(err) };
    }
  }
  return { ok: false, error: 'no matching records' };
}

// ── Blocks / networks / ranges / addresses ──────────────────────────────────

function prefixOf(range) {
  if (!range) return null;
  const m = String(range).match(/\/(\d{1,3})$/);
  return m ? Number(m[1]) : null;
}

function ipVersionOf(range) {
  if (!range) return null;
  return String(range).includes(':') ? 6 : 4;
}

function parseBlock(b) {
  const upHref = strOrNull(b._links?.up?.href);
  const parentBlockId = upHref ? numOrNull((upHref.match(/\/blocks\/(\d+)/) || [])[1]) : null;
  return {
    id: numOrNull(b.id),
    type: strOrNull(b.type),
    name: strOrNull(b.name),
    range: strOrNull(b.range),
    prefix: prefixOf(b.range),
    ipVersion: ipVersionOf(b.range),
    configurationId: numOrNull(b.configuration?.id),
    parentBlockId,
    locationName: strOrNull(b.location?.name),
    usage: b.usagePercentage != null ? { usagePercentage: b.usagePercentage } : null,
  };
}

async function fetchBlocks(source, timeout) {
  const rows = await pagedGet(source, '/blocks', { limit: 1000, timeout });
  return rows.map(parseBlock);
}

function capacityForPrefix(prefix, ipVersion) {
  if (ipVersion === 6 || prefix == null) return null;
  if (prefix === 32) return 1;
  if (prefix === 31) return 2;
  if (prefix < 0 || prefix > 30) return null;
  return Math.pow(2, 32 - prefix) - 2;
}

function parseNetwork(n) {
  const upHref = strOrNull(n._links?.up?.href);
  const blockId = upHref ? numOrNull((upHref.match(/\/blocks\/(\d+)/) || [])[1]) : null;
  const prefix = prefixOf(n.range);
  const ipVersion = ipVersionOf(n.range);
  let gatewayRaw = null;
  if (n.gateway != null) gatewayRaw = typeof n.gateway === 'object' ? strOrNull(n.gateway.address) : strOrNull(n.gateway);
  return {
    id: numOrNull(n.id),
    type: strOrNull(n.type),
    name: strOrNull(n.name),
    range: strOrNull(n.range),
    prefix,
    ipVersion,
    capacity: capacityForPrefix(prefix, ipVersion),
    gatewayBam: gatewayRaw,
    configurationId: numOrNull(n.configuration?.id),
    blockId,
    locationName: strOrNull(n.location?.name),
    defaultViewId: numOrNull(n.defaultView?.id),
    pingBeforeAssign: n.pingBeforeAssignmentEnabled != null ? boolToInt(n.pingBeforeAssignmentEnabled) : (n.pingBeforeAssignEnabled != null ? boolToInt(n.pingBeforeAssignEnabled) : null),
    lowWaterMark: numOrNull(n.lowWaterMark),
    highWaterMark: numOrNull(n.highWaterMark),
    usage: n.usage && typeof n.usage === 'object' ? n.usage : null,
    raw: n,
  };
}

async function fetchNetworks(source, timeout) {
  const rows = await pagedGet(source, '/networks', { limit: 1000, timeout });
  return rows.map(parseNetwork);
}

/** Usage probe (contract section 5): GET /networks?fields=id,range,usage&limit=1
 *  — if data[0].usage is an object, every network of this source reports
 *  utilization via the `usage` block rather than needing enumeration. */
async function probeNetworkUsage(source, timeout) {
  try {
    const d = await getWithFieldsFallback(source, '/networks', { fields: 'id,range,usage', limit: 1 }, timeout);
    const first = safeArr(d?.data)[0];
    return !!(first && first.usage && typeof first.usage === 'object');
  } catch {
    return false;
  }
}

function parseRange(r) {
  let startIp = null;
  let endIp = null;
  let size = null;
  const raw = strOrNull(r.range);
  if (raw) {
    const dash = raw.match(/^([\da-fA-F.:]+)\s*-\s*([\da-fA-F.:]+)$/);
    const cidr = raw.match(/^([\da-fA-F.:]+)\/(\d{1,3})$/);
    if (dash) {
      startIp = dash[1];
      endIp = dash[2];
      const a = ipv4ToInt(startIp);
      const b = ipv4ToInt(endIp);
      if (a != null && b != null && b >= a) size = b - a + 1;
    } else if (cidr) {
      startIp = cidr[1];
      const prefix = Number(cidr[2]);
      size = ipVersionOf(raw) === 4 && prefix <= 32 ? Math.pow(2, 32 - prefix) : null;
    }
  }
  const upHref = strOrNull(r._links?.up?.href);
  const networkId = upHref ? numOrNull((upHref.match(/\/networks\/(\d+)/) || [])[1]) : null;
  return {
    id: numOrNull(r.id),
    type: strOrNull(r.type),
    name: strOrNull(r.name),
    range: raw,
    startIp,
    endIp,
    size,
    networkId,
  };
}

function ipv4ToInt(ip) {
  if (typeof ip !== 'string') return null;
  const parts = ip.split('.');
  if (parts.length !== 4) return null;
  let n = 0;
  for (const p of parts) {
    const v = Number(p);
    if (!Number.isInteger(v) || v < 0 || v > 255) return null;
    n = n * 256 + v;
  }
  return n;
}

/** Ranges of one network. Every row under /networks/{id}/ranges is a DHCP
 *  range whatever its type string (9.5 docs: DHCPv4Range; 9.6 may use
 *  IPv4DHCPRange), so no type filter here. */
async function fetchRanges(source, networkId, timeout) {
  const rows = await pagedGet(source, `/networks/${networkId}/ranges`, { limit: 1000, timeout });
  return rows.map(parseRange).map((r) => ({ ...r, networkId: r.networkId ?? networkId }));
}

/** All DHCP ranges of the BAM in one paged call (flat collection); each row
 *  carries networkId from _links.up. Preferred over one call per network. */
async function fetchAllRanges(source, timeout) {
  const rows = await pagedGet(source, '/ranges', { limit: 1000, timeout });
  return rows.map(parseRange).filter((r) => /DHCP/i.test(r.type || '') || r.networkId != null);
}

const ADDRESS_STATES = "STATIC,RESERVED,DHCP_RESERVED,DHCP_ALLOCATED,DHCP_ABANDONED,DHCP_EXCLUDED,DHCP_LEASED,GATEWAY".split(',');

function parseAddress(a) {
  let mac = null;
  if (a.macAddress != null) mac = typeof a.macAddress === 'object' ? strOrNull(a.macAddress.address) : strOrNull(a.macAddress);
  return {
    id: numOrNull(a.id),
    address: strOrNull(a.address),
    state: strOrNull(a.state),
    name: strOrNull(a.name),
    mac,
    deviceId: numOrNull(a.device?.id),
  };
}

/** Filtered address fetch for a network (contract: NEVER call unfiltered
 *  unless the network prefix is >= /22). Falls back state:in -> state:ne ->
 *  unfiltered (guarded by prefix). */
async function fetchNetworkAddresses(source, networkId, prefix, timeout) {
  const fields = 'id,address,state,name,macAddress';
  try {
    const filter = `state:in('${ADDRESS_STATES.join("','")}')`;
    const rows = await pagedGet(source, `/networks/${networkId}/addresses`, { filter, fields, limit: 1000, timeout });
    return rows.map(parseAddress);
  } catch (err) {
    logger.warn(`[BluecatApi] addresses state:in filter failed for network ${networkId}: ${errMsg(err)}`);
  }
  try {
    const filter = "state:ne('UNASSIGNED')";
    const rows = await pagedGet(source, `/networks/${networkId}/addresses`, { filter, fields, limit: 1000, timeout });
    return rows.map(parseAddress);
  } catch (err) {
    logger.warn(`[BluecatApi] addresses state:ne filter failed for network ${networkId}: ${errMsg(err)}`);
  }
  if (prefix != null && prefix >= 22) {
    const rows = await pagedGet(source, `/networks/${networkId}/addresses`, { fields, limit: 1000, timeout });
    return rows.map(parseAddress);
  }
  throw new Error(`no usable address filter for network ${networkId} (prefix ${prefix})`);
}

// ── Devices / servers / roles / deployments ─────────────────────────────────

function parseDevice(d) {
  return {
    id: numOrNull(d.id),
    configurationId: numOrNull(d.configuration?.id),
    name: strOrNull(d.name),
    deviceType: strOrNull(d.deviceType?.name),
    deviceSubtype: strOrNull(d.deviceSubtype?.name),
    description: strOrNull(d.description),
    addresses: safeArr(d._embedded?.addresses).map((a) => ({ address: strOrNull(a.address), state: strOrNull(a.state) })),
    raw: d,
  };
}

async function fetchDevices(source, configId, timeout) {
  try {
    const rows = await pagedGet(source, `/configurations/${configId}/devices`, { fields: 'embed(addresses)', limit: 1000, timeout });
    return rows.map(parseDevice);
  } catch (err) {
    logger.warn(`[BluecatApi] devices embed(addresses) failed for config ${configId}: ${errMsg(err)}`);
    const rows = await pagedGet(source, `/configurations/${configId}/devices`, { limit: 1000, timeout });
    const parsed = rows.map(parseDevice);
    // Fallback: per-device addresses call for the first 500 only.
    for (const dv of parsed.slice(0, 500)) {
      try {
        const addrs = await apiGet(source, `/devices/${dv.id}/addresses`, { timeout });
        dv.addresses = safeArr(addrs?.data).map((a) => ({ address: strOrNull(a.address), state: strOrNull(a.state) }));
      } catch { /* tolerate per-device failure */ }
    }
    return parsed;
  }
}

function parseServer(s) {
  return {
    id: numOrNull(s.id),
    configurationId: numOrNull(s.configuration?.id),
    name: strOrNull(s.name),
    profile: strOrNull(s.profile),
    connected: s.connected != null ? boolToInt(s.connected) : (s.state != null ? (String(s.state).toUpperCase() === 'RUNNING' || String(s.state).toUpperCase() === 'CONNECTED' ? 1 : 0) : null),
    state: strOrNull(s.state),
    address: strOrNull(s.address ?? s.defaultInterfaceAddress ?? s.fullHostName),
    version: strOrNull(s.version),
    interfaces: safeArr(s._embedded?.interfaces).map((i) => ({ type: strOrNull(i.type), managementAddress: strOrNull(i.managementAddress), address: strOrNull(i.address) })),
    raw: s,
  };
}

async function fetchServers(source, timeout) {
  try {
    const rows = await pagedGet(source, '/servers', { fields: 'embed(interfaces)', limit: 1000, timeout });
    return rows.map(parseServer);
  } catch (err) {
    logger.warn(`[BluecatApi] servers embed(interfaces) failed: ${errMsg(err)}`);
    const rows = await pagedGet(source, '/servers', { limit: 1000, timeout });
    return rows.map(parseServer);
  }
}

function parseDeploymentRole(r) {
  const upHref = strOrNull(r._links?.up?.href);
  return {
    id: numOrNull(r.id),
    type: strOrNull(r.type),
    roleType: strOrNull(r.roleType),
    serverId: numOrNull(r.server?.id),
    serverInterfaceId: numOrNull(r.serverInterface?.id),
    serverInterfaceName: strOrNull(r.serverInterface?.name),
    serverGroup: strOrNull(r.serverGroup?.name),
    upHref,
  };
}

async function fetchDeploymentRoles(source, timeout) {
  const rows = await pagedGet(source, '/deploymentRoles', { limit: 1000, timeout });
  return rows.map(parseDeploymentRole);
}

async function fetchLatestDeployment(source, serverId, timeout) {
  try {
    const d = await apiGet(source, `/servers/${serverId}/deployments`, { params: { orderBy: 'desc(id)', limit: 1 }, timeout });
    const row = safeArr(d?.data)[0];
    if (!row) return null;
    return { state: strOrNull(row.state), status: strOrNull(row.status), message: strOrNull(row.message), id: numOrNull(row.id) };
  } catch {
    return null;
  }
}

// ── testConnection ───────────────────────────────────────────────────────────

async function testConnection(candidate) {
  try {
    invalidateSession(candidate.id);
    const version = await fetchVersion(candidate, 15000);
    const configurations = await fetchConfigurations(candidate, 15000);
    return { ok: true, bamVersion: version, configurations };
  } catch (err) {
    return { ok: false, error: errMsg(err) };
  } finally {
    invalidateSession(candidate.id);
  }
}

// ── Small promise pool (no new npm deps) ────────────────────────────────────

async function promisePool(items, concurrency, worker) {
  const results = new Array(items.length);
  let next = 0;
  async function runner() {
    for (;;) {
      const i = next++;
      if (i >= items.length) return;
      results[i] = await worker(items[i], i);
    }
  }
  const runners = Array.from({ length: Math.max(1, Math.min(concurrency, items.length || 1)) }, runner);
  await Promise.all(runners);
  return results;
}

module.exports = {
  errMsg, errCode,
  numOrNull, strOrNull, boolToInt, jsonOrNull,
  login, getSession, invalidateSession, logout,
  apiGet, pagedGet, getWithFieldsFallback,
  fetchVersion, fetchConfigurations, fetchViews,
  fetchZones, fetchResourceRecords, searchRecords,
  fetchBlocks, fetchNetworks, probeNetworkUsage, fetchRanges, fetchAllRanges, fetchNetworkAddresses,
  fetchDevices, fetchServers, fetchDeploymentRoles, fetchLatestDeployment,
  testConnection,
  promisePool,
  capacityForPrefix, prefixOf, ipVersionOf,
};
