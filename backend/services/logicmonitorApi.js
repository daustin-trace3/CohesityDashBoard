// LogicMonitor REST API v3 client (https://<company>.logicmonitor.com/santaba/rest).
// Every call sends X-Version: 3. Auth per source is LMv1 (HMAC over METHOD +
// epochMs + body + resourcePath, hex digest, then base64 of the hex text) or a
// bearer token. Lists are {total, searchId, items}; total can be NEGATIVE while
// LM does not know the count yet, so paging stops on a short page, never on
// offset >= total. Rate-limit headers are read on every reply and kept per
// source and endpoint family. Blind build 2026-10-14: no live portal was
// reachable, so every parser null-guards and every mapping marked UNVERIFIED
// in the icc-logicmonitor-platform-plan references is probe-first.
const axios = require('axios');
const https = require('https');
const crypto = require('crypto');
const { decrypt } = require('./encryption');
const logger = require('../utils/logger');
// icc-phase1: single tenant, one plain Map for the install (keeps the _map() accessor feat's TenantMap has).
const tenantMap = () => { const m = new Map(); m._map = () => m; return m; };

const PAGE_SIZE = 1000;
const ALERT_OFFSET_CAP = 10000;
const DATA_SPACING_MS = 150;
const LOW_REMAINING = 5;
const CREDS_REJECTED = 'credentials rejected (check token, role and host clock)';

const rateState = tenantMap(); // `${sourceId}|${family}` -> {limit, remaining, window, at}
const lastDataCall = tenantMap(); // sourceId -> ms

let sleepFn = (ms) => new Promise((r) => setTimeout(r, ms));
/** Test seam: replace the sleep used for rate-limit waits and data spacing. */
function _setSleep(fn) { sleepFn = typeof fn === 'function' ? fn : ((ms) => new Promise((r) => setTimeout(r, ms))); }
let transport = null;
/** Test seam: replace the HTTP transport with fn(config) -> {status, data, headers}. */
function _setTransport(fn) { transport = typeof fn === 'function' ? fn : null; }

// -- Parsing helpers --------------------------------------------------------

function numOrNull(v) {
  if (v == null || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}
const strOrNull = (v) => (v == null || v === '' ? null : String(v));
const boolInt = (v) => (v == null ? null : (v === true || v === 'true' || v === 1 || v === '1' ? 1 : 0));
const safeArr = (v) => (Array.isArray(v) ? v : []);
function jsonOrNull(v) {
  if (v == null) return null;
  try { return JSON.stringify(v); } catch { return null; }
}

/** customProperties / systemProperties / autoProperties are arrays of
 *  {name, value}, never maps. */
function propsToMap(arr) {
  const out = {};
  for (const p of safeArr(arr)) {
    if (p && p.name != null) out[String(p.name)] = p.value == null ? null : String(p.value);
  }
  return out;
}

// -- Company, credentials, signing -------------------------------------------

const COMPANY_RE = /^[a-z0-9][a-z0-9-]{1,62}$/i;

/** Normalise what a user typed into the portal subdomain: strips scheme,
 *  ".logicmonitor.com", any path and slashes. Returns null when invalid. */
function normalizeCompany(input) {
  if (input == null) return null;
  let s = String(input).trim().toLowerCase();
  s = s.replace(/^[a-z]+:\/\//, '');
  s = s.split('/')[0];
  s = s.replace(/\.logicmonitor\.com\.?$/, '');
  s = s.replace(/[/.]+$/, '');
  return COMPANY_RE.test(s) ? s : null;
}

const baseUrl = (company) => `https://${company}.logicmonitor.com`;
const apiRoot = (company) => `${baseUrl(company)}/santaba/rest`;

function authModeOf(source) {
  const m = source.auth_mode || source.authMode;
  return m === 'bearer' ? 'bearer' : 'lmv1';
}

function creds(source) {
  // Unsaved candidates (test connection) carry plaintext; saved rows carry the
  // encrypted JSON blob. Plaintext wins when present.
  if (source.accessId || source.accessKey || source.token) {
    return { accessId: source.accessId || null, accessKey: source.accessKey || null, token: source.token || null };
  }
  if (!source.encrypted_credentials) return { accessId: null, accessKey: null, token: null };
  try {
    const c = JSON.parse(decrypt(source.encrypted_credentials));
    return { accessId: c.accessId || null, accessKey: c.accessKey || null, token: c.token || null };
  } catch {
    return { accessId: null, accessKey: null, token: null };
  }
}

/** LMv1 Authorization header. resourcePath is the path under /santaba/rest
 *  WITHOUT the query string; bodyString is the exact bytes sent ('' for GET). */
function signLmv1(accessId, accessKey, method, resourcePath, bodyString, epochMs) {
  const epoch = String(epochMs);
  const toSign = String(method).toUpperCase() + epoch + (bodyString || '') + resourcePath;
  const hex = crypto.createHmac('sha256', accessKey).update(toSign).digest('hex');
  const sig = Buffer.from(hex, 'utf8').toString('base64');
  return `LMv1 ${accessId}:${sig}:${epoch}`;
}

function authHeader(source, method, resourcePath, bodyString) {
  const c = creds(source);
  if (authModeOf(source) === 'bearer') {
    if (!c.token) throw new Error('LogicMonitor source has no bearer token');
    return `Bearer ${c.token}`;
  }
  if (!c.accessId || !c.accessKey) throw new Error('LogicMonitor source has no LMv1 access id and key');
  return signLmv1(c.accessId, c.accessKey, method, resourcePath, bodyString, Date.now());
}

// -- Filter encoding ---------------------------------------------------------

/** Quote one filter value: strings in double quotes (inner quotes escaped),
 *  numbers bare. */
function filterValue(v) {
  if (typeof v === 'number' && Number.isFinite(v)) return String(v);
  if (typeof v === 'boolean') return String(v);
  return `"${String(v).replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
}

/** Build a filter string from [field, op, value] clauses joined by comma
 *  (AND). op is one of : !: ~ !~ > < >: <:. A value array becomes an
 *  in-field OR ("a"|"b"). */
function buildFilter(clauses) {
  return safeArr(clauses).filter(Boolean).map(([field, op, value]) => {
    const v = Array.isArray(value) ? value.map(filterValue).join('|') : filterValue(value);
    return `${field}${op}${v}`;
  }).join(',');
}

/** Percent-encode the whole filter once, then double-encode '+' (v3 rule). */
const encodeFilter = (filter) => encodeURIComponent(String(filter)).replace(/%2B/g, '%252B');

function buildQuery(params) {
  if (!params) return '';
  const parts = [];
  for (const [k, v] of Object.entries(params)) {
    if (v == null || v === '') continue;
    parts.push(`${encodeURIComponent(k)}=${k === 'filter' ? encodeFilter(v) : encodeURIComponent(String(v))}`);
  }
  return parts.length ? `?${parts.join('&')}` : '';
}

// -- Errors ------------------------------------------------------------------

function errMsg(err) {
  if (err?.lmMessage) return err.lmMessage;
  if (err?.response) {
    const body = err.response.data;
    const msg = body?.errorMessage || body?.message || body?.errmsg;
    const code = body?.errorCode != null ? ` (${body.errorCode})` : '';
    return `HTTP ${err.response.status}${msg ? `: ${msg}${code}` : code}`;
  }
  return err?.message || String(err);
}

function lmError(message, res) {
  const e = new Error(message);
  e.lmMessage = message;
  if (res) e.response = res;
  return e;
}

// -- Rate limits ---------------------------------------------------------------

/** Endpoint family key: numeric path segments collapse to {id} so
 *  /device/devices/12/devicedatasources and /device/devices/13/... share one
 *  bucket, matching LM's per-endpoint limits. */
const endpointFamily = (path) => String(path).split('?')[0].replace(/\/\d+(?=\/|$)/g, '/{id}');

function headerOf(headers, name) {
  if (!headers) return undefined;
  if (typeof headers.get === 'function') {
    const v = headers.get(name);
    if (v != null) return v;
  }
  return headers[name] ?? headers[name.toLowerCase()];
}

function recordRateLimit(sourceId, family, headers) {
  if (sourceId == null) return;
  const limit = numOrNull(headerOf(headers, 'x-rate-limit-limit'));
  const remaining = numOrNull(headerOf(headers, 'x-rate-limit-remaining'));
  const window = numOrNull(headerOf(headers, 'x-rate-limit-window'));
  if (limit == null && remaining == null && window == null) return;
  rateState.set(`${sourceId}|${family}`, { limit, remaining, window, at: Date.now() });
}

/** Latest header snapshot per endpoint family for one source:
 *  { "/device/devices": {limit, remaining, window, at (ISO)} }. */
function getRateLimitSnapshot(sourceId) {
  const out = {};
  const prefix = `${sourceId}|`;
  const map = rateState._map ? rateState._map() : null;
  if (!map) return out;
  for (const [k, v] of map.entries()) {
    if (!k.startsWith(prefix)) continue;
    out[k.slice(prefix.length)] = { limit: v.limit, remaining: v.remaining, window: v.window, at: new Date(v.at).toISOString() };
  }
  return out;
}

function invalidate(sourceId) {
  const map = rateState._map ? rateState._map() : null;
  if (map) for (const k of [...map.keys()]) if (k.startsWith(`${sourceId}|`)) map.delete(k);
  lastDataCall.delete(sourceId);
}

async function waitForBudget(sourceId, family) {
  if (sourceId == null) return;
  const st = rateState.get(`${sourceId}|${family}`);
  if (!st || st.remaining == null || st.remaining >= LOW_REMAINING) return;
  const windowMs = (st.window || 60) * 1000;
  const waitMs = st.at + windowMs - Date.now();
  if (waitMs > 0) {
    logger.info(`[LmApi] ${family}: ${st.remaining} call(s) left in the window, waiting ${Math.ceil(waitMs / 1000)} s`);
    await sleepFn(waitMs);
  }
  rateState.delete(`${sourceId}|${family}`);
}

/** Data calls are spaced DATA_SPACING_MS apart per source. */
async function paceDataCall(sourceId) {
  const key = sourceId == null ? 'adhoc' : sourceId;
  const last = lastDataCall.get(key) || 0;
  const wait = last + DATA_SPACING_MS - Date.now();
  if (wait > 0) await sleepFn(wait);
  lastDataCall.set(key, Date.now());
}

// -- Low-level request ---------------------------------------------------------

function httpClient(source, timeout) {
  return axios.create({
    timeout,
    validateStatus: () => true,
    httpsAgent: new https.Agent({ rejectUnauthorized: source.verify_ssl == null ? true : !!Number(source.verify_ssl) }),
  });
}

/**
 * One API call. path is relative to /santaba/rest (e.g. '/device/devices').
 * Signs the path without the query string. On 429 sleeps the window (60 s
 * fallback) and retries ONCE. 401 / errorCode 1401 never retries.
 */
async function request(source, method, path, { params, data, timeout = 60000, retried429 = false } = {}) {
  const company = normalizeCompany(source.company);
  if (!company) throw lmError('LogicMonitor source has no valid company subdomain');
  const family = endpointFamily(path);
  await waitForBudget(source.id, family);

  const upper = String(method).toUpperCase();
  const bodyString = data == null ? '' : (typeof data === 'string' ? data : JSON.stringify(data));
  const headers = {
    'X-Version': '3',
    Accept: 'application/json',
    Authorization: authHeader(source, upper, path, bodyString),
  };
  if (bodyString) headers['Content-Type'] = 'application/json';
  const config = {
    method: upper,
    url: `${apiRoot(company)}${path}${buildQuery(params)}`,
    headers,
    data: bodyString || undefined,
    transformRequest: [(d) => d],
  };
  const res = transport ? await transport(config) : await httpClient(source, timeout).request(config);
  recordRateLimit(source.id, family, res.headers);

  const body = res.data;
  if (res.status === 429) {
    if (retried429) throw lmError(`rate limited on ${family} (HTTP 429)`, res);
    const window = numOrNull(headerOf(res.headers, 'x-rate-limit-window')) || 60;
    logger.warn(`[LmApi] 429 on ${family}, sleeping ${window} s then retrying once`);
    await sleepFn(window * 1000);
    return request(source, method, path, { params, data, timeout, retried429: true });
  }
  if (res.status === 401 || body?.errorCode === 1401) {
    const skew = headerOf(res.headers, 'date');
    if (skew) {
      const delta = Math.round((Date.now() - Date.parse(skew)) / 1000);
      if (Number.isFinite(delta)) logger.warn(`[LmApi] 1401 from ${company}: local clock minus server Date is ${delta} s`);
    }
    throw lmError(CREDS_REJECTED, res);
  }
  if (res.status >= 400) throw lmError(errMsg({ response: res }), res);
  if (body && typeof body === 'object' && 'errmsg' in body && 'status' in body && !('items' in body)) {
    // The v1 envelope means the X-Version header was dropped somewhere.
    throw lmError('LogicMonitor answered in the v1 envelope (status/errmsg): the X-Version 3 header was lost', res);
  }
  return body;
}

// -- Pagination ------------------------------------------------------------------

/**
 * Generic offset pager. fetchPage(offset, size) -> {total, items}. Stops on a
 * short or empty page, when total > 0 and collected >= total, at maxPages, or
 * when the next offset would pass maxOffset (alerts cap at 10000). A NEGATIVE
 * total is a lower bound and never stops the loop by itself.
 * Returns {items, truncated}.
 */
async function paginateWith(fetchPage, { size = PAGE_SIZE, maxPages = 500, maxOffset = Infinity } = {}) {
  const items = [];
  let offset = 0;
  let pages = 0;
  let truncated = false;
  for (;;) {
    const page = (await fetchPage(offset, size)) || {};
    const rows = safeArr(page.items);
    items.push(...rows);
    pages += 1;
    const total = numOrNull(page.total);
    if (rows.length < size) break;
    if (total != null && total > 0 && items.length >= total) break;
    offset += rows.length;
    if (pages >= maxPages || offset >= maxOffset) { truncated = true; break; }
  }
  return { items, truncated };
}

async function paginate(source, path, { params = {}, size = PAGE_SIZE, maxPages = 500, maxOffset = Infinity, timeout } = {}) {
  return paginateWith(
    (offset, sz) => request(source, 'get', path, { params: { ...params, size: sz, offset }, timeout }),
    { size, maxPages, maxOffset },
  );
}

async function listAll(source, path, opts = {}) {
  const res = await paginate(source, path, opts);
  if (res.truncated) logger.warn(`[LmApi] ${path} truncated after ${res.items.length} item(s)`);
  return res.items;
}

// -- Classification (section 5, shared with the demo seed) -----------------------

const SYSOID_VENDORS = [
  { prefix: '.1.3.6.1.4.1.9.', vendor: 'Cisco' },
  { prefix: '.1.3.6.1.4.1.2636.', vendor: 'Juniper' },
  { prefix: '.1.3.6.1.4.1.30065.', vendor: 'Arista' },
  { prefix: '.1.3.6.1.4.1.25461.', vendor: 'Palo Alto' },
  { prefix: '.1.3.6.1.4.1.12356.', vendor: 'Fortinet' },
  { prefix: '.1.3.6.1.4.1.14823.', vendor: 'Aruba' },
  { prefix: '.1.3.6.1.4.1.47196.', vendor: 'Aruba CX' },
  { prefix: '.1.3.6.1.4.1.29671.', vendor: 'Meraki' },
  { prefix: '.1.3.6.1.4.1.41112.', vendor: 'Ubiquiti' },
  { prefix: '.1.3.6.1.4.1.1588.', vendor: 'Brocade' },
  { prefix: '.1.3.6.1.4.1.3375.', vendor: 'F5' },
  { prefix: '.1.3.6.1.4.1.8072.', vendor: 'Net-SNMP' },
  { prefix: '.1.3.6.1.4.1.311.', vendor: 'Microsoft' },
];

// Category tokens (exact, then case-insensitive prefix) to vendor.
const CATEGORY_VENDORS = [
  ['CiscoASA', 'Cisco'], ['Cisco_FTD', 'Cisco'], ['snmpCisco_Switch', 'Cisco'], ['F5Active', 'F5'], ['F5GTM', 'F5'], ['CiscoMeraki', 'Meraki'], ['CiscoCatalyst', 'Cisco'],
  ['Cisco', 'Cisco'], ['Juniper', 'Juniper'], ['Arista', 'Arista'], ['PaloAlto', 'Palo Alto'],
  ['Fortigate', 'Fortinet'], ['FortiGate', 'Fortinet'], ['ArubaCX', 'Aruba CX'], ['Aruba', 'Aruba'],
  ['Meraki', 'Meraki'], ['UbiquitiUniFi', 'Ubiquiti'], ['Ubiquiti', 'Ubiquiti'], ['Brocade', 'Brocade'],
  ['F5', 'F5'], ['Netsnmp', 'Net-SNMP'], ['Net-SNMP', 'Net-SNMP'],
];

// sysinfo first word to vendor (lower-cased word).
const SYSINFO_VENDORS = {
  cisco: 'Cisco', juniper: 'Juniper', arista: 'Arista', palo: 'Palo Alto', 'pan-os': 'Palo Alto',
  fortinet: 'Fortinet', fortigate: 'Fortinet', aruba: 'Aruba', arubaos: 'Aruba', 'arubaos-cx': 'Aruba CX',
  meraki: 'Meraki', ubiquiti: 'Ubiquiti', unifi: 'Ubiquiti', brocade: 'Brocade', f5: 'F5', 'big-ip': 'F5',
};

// predef.externalResourceType to role (case-insensitive).
const ERT_ROLES = [
  [/^firewall$/i, 'firewall'],
  [/^router$/i, 'router'],
  [/^(virtual)?switch$/i, 'switch'],
  [/^loadbalancecollector$/i, 'load-balancer'],
  // Live portals report WLC for AireOS controllers and Wireless for Catalyst 9800s.
  [/^(wlc|wireless|wirelesscontroller|accesspoint)$/i, 'wireless'],
  [/^(physicalserver|virtualmachine(resource)?|hypervisor)$/i, 'server'],
  [/^storage/i, 'storage'],
];

// Category tokens to role, first match wins. Meraki and Mist are split by
// product suffix (an MS switch is not wireless); anything else under those
// families is wireless.
const CATEGORY_ROLES = [
  [/^(CiscoASA|Cisco_FTD|PaloAlto|Fortigate|FortiGate)$/i, 'firewall'],
  [/^CiscoMerakiSwitch$/i, 'switch'],
  [/^CiscoMerakiAppliance$/i, 'firewall'],
  [/^JuniperMistSwitch$/i, 'switch'],
  [/^JuniperMistGateway$/i, 'router'],
  [/^(CiscoCatalystSwitch|ArubaCXSwitch)$/i, 'switch'],
  [/^CiscoCatalystRouter$/i, 'router'],
  [/^(F5|F5Active|F5GTM)$/i, 'load-balancer'],
  [/^CiscoUCS/i, 'server'],
  [/^(TopoSwitch|snmpCisco_Switch)$/i, 'switch'],
  [/^(UbiquitiUniFiAP|CiscoMeraki.*|JuniperMist.*|CiscoCatalystAccessPoint|CiscoCatalystWLC|ArubaAP|ArubaIAP|ArubaInstant.*|CiscoWLC)$/i, 'wireless'],
  [/^(Windows.*|Linux.*|VMware.*|Hyper-V)$/i, 'server'],
];

const SWITCH_VENDORS = new Set(['Cisco', 'Juniper', 'Arista', 'Aruba', 'Aruba CX', 'Meraki', 'Ubiquiti', 'Brocade']);
const NETWORK_ROLES = new Set(['switch', 'router', 'firewall', 'load-balancer', 'wireless']);
const ROLES = ['switch', 'router', 'firewall', 'load-balancer', 'wireless', 'server', 'storage', 'other'];

// Version regexes over system.sysinfo, first match wins. The demo seed
// builds sysinfo strings that these match.
const VERSION_PATTERNS = [
  { vendor: 'F5', re: /BIG-IP\s+(?:\S+\s+)?(\d+\.\d+(?:\.\d+)*)/i, example: 'BIG-IP 17.1.1 Build 0.0.4' },
  { vendor: 'Juniper', re: /JUNOS\s+([0-9][\w.-]*)/i, example: 'Juniper Networks, Inc. ex4300-48t, kernel JUNOS 21.4R3-S5' },
  { vendor: 'Arista', re: /EOS\s+(?:version\s+)?(\d+\.\d+[\w.]*)/i, example: 'Arista Networks EOS version 4.31.2F' },
  { vendor: 'Palo Alto', re: /PAN-OS\s+(?:version\s+)?(\d+\.\d+[\w.-]*)/i, example: 'Palo Alto Networks PA-3220 PAN-OS 10.2.9' },
  { vendor: 'Fortinet', re: /\bv(\d+\.\d+(?:\.\d+)?),?\s*build/i, example: 'FortiGate-100F v7.2.8,build1639' },
  { vendor: 'Cisco', re: /Version\s+(\d+\.\d+(?:[.(][\w.]+\)?)*[\w]*)/i, example: 'Cisco IOS Software [Cupertino], C9300 Software (CAT9K_IOSXE), Version 17.9.4a, RELEASE SOFTWARE (fc5)' },
];

function normalizeSysoid(s) {
  if (!s) return null;
  const t = String(s).trim().replace(/^\.?/, '.');
  return t.endsWith('.') ? t : `${t}.`;
}

function splitCategories(categories) {
  if (Array.isArray(categories)) return categories.map(String).map((c) => c.trim()).filter(Boolean);
  return String(categories || '').split(',').map((c) => c.trim()).filter(Boolean);
}

// Round 11: vendors a Net-SNMP sysoid or a bare category would otherwise hide. Tested on the
// categories plus sysinfo before any other rule. The NetScout, Zscaler and Oracle patterns are
// UNVERIFIED against a live portal (the PFS model string and ZscalerOS banner are guesses).
const VENDOR_HINTS = [
  [/netscout|infinistream|ngenius|\bPFS[\s-]?\d/i, 'NetScout'],
  [/zscaler/i, 'Zscaler'],
  [/acme.?packet|ntm_sbc|oracle.{0,20}(sbc|session border)/i, 'Oracle'],
];

function classifyVendor({ sysoid, categories, sysinfo } = {}) {
  const hintText = `${splitCategories(categories).join(' ')} ${sysinfo || ''}`;
  for (const [re, vendor] of VENDOR_HINTS) if (re.test(hintText)) return vendor;
  const oid = normalizeSysoid(sysoid);
  if (oid) {
    const hit = SYSOID_VENDORS.find((v) => oid.startsWith(v.prefix));
    if (hit) return hit.vendor;
  }
  const cats = splitCategories(categories);
  for (const [token, vendor] of CATEGORY_VENDORS) {
    if (cats.includes(token)) return vendor;
  }
  for (const [token, vendor] of CATEGORY_VENDORS) {
    const lt = token.toLowerCase();
    if (cats.some((c) => c.toLowerCase().startsWith(lt))) return vendor;
  }
  const first = String(sysinfo || '').trim().split(/[\s,]+/)[0];
  if (first) {
    const v = SYSINFO_VENDORS[first.toLowerCase()];
    if (v) return v;
  }
  return null;
}

function classifyRole({ ert, categories, vendor } = {}) {
  if (ert) {
    const hit = ERT_ROLES.find(([re]) => re.test(String(ert).trim()));
    if (hit) return hit[1];
  }
  const cats = splitCategories(categories);
  // Round 11: a Windows or Linux category with no network category is a server, whatever
  // topology category (TopoSwitch from LLDP) or Net-SNMP vendor rides along. Cohesity VE
  // clusters and Zscaler NSS appliances used to come out as switches.
  if (vendor !== 'F5' && cats.some((c) => /^(Windows|Linux)/i.test(c))
    && !cats.some((c) => !/^Topo/i.test(c) && CATEGORY_ROLES.some(([re, role]) => NETWORK_ROLES.has(role) && re.test(c)))) return 'server';
  for (const [re, role] of CATEGORY_ROLES) {
    if (cats.some((c) => re.test(c))) return role;
  }
  if (vendor === 'F5') return 'load-balancer';
  if (vendor && SWITCH_VENDORS.has(vendor)) return 'switch';
  return 'other';
}

const isNetworkDevice = ({ deviceType, role }) => Number(deviceType) === 0 && NETWORK_ROLES.has(role);

function parseVersion(sysinfo) {
  if (!sysinfo) return null;
  for (const p of VERSION_PATTERNS) {
    const m = String(sysinfo).match(p.re);
    if (m) return m[1];
  }
  return null;
}

const MAC_RE = /^([0-9a-f]{2}[:-]){5}[0-9a-f]{2}$|^[0-9a-f]{4}\.[0-9a-f]{4}\.[0-9a-f]{4}$|^[0-9a-f]{12}$/i;
const IPV4_RE = /^\d{1,3}(\.\d{1,3}){3}$/;

/** predef.externalResourceID into {mac, ip, fqdn}. The live encoding is
 *  UNVERIFIED (a comma list of values, or a JSON rawERIs array); both are read. */
function parseEri(value) {
  const out = { mac: [], ip: [], fqdn: [] };
  if (!value) return out;
  let tokens = [];
  const s = String(value).trim();
  if (s.startsWith('[') || s.startsWith('{')) {
    try {
      const j = JSON.parse(s);
      const arr = Array.isArray(j) ? j : safeArr(j.rawERIs);
      tokens = arr.map((e) => (e && typeof e === 'object' ? e.value : e)).filter(Boolean).map(String);
    } catch { tokens = s.split(/[,\s]+/); }
  } else {
    tokens = s.split(/[,\s]+/);
  }
  for (const t of tokens.map((x) => x.trim()).filter(Boolean)) {
    if (MAC_RE.test(t)) out.mac.push(t.toLowerCase());
    else if (IPV4_RE.test(t) || t.includes(':')) out.ip.push(t.toLowerCase());
    else out.fqdn.push(t.toLowerCase());
  }
  return out;
}

// -- Status strings ----------------------------------------------------------

/** alertStatus is three slots {confirmed|unconfirmed}-{warn|error|critical}-{sdt}
 *  or 'none'. Parsed by substring because the exact literals are UNVERIFIED. */
function parseAlertStatus(s) {
  const t = String(s || '').toLowerCase();
  if (!t || t === 'none') return { severity: null, acked: false, sdt: false };
  const severity = t.includes('critical') ? 'critical' : t.includes('error') ? 'error' : t.includes('warn') ? 'warn' : null;
  const acked = /(^|-)confirmed/.test(t) && !t.includes('unconfirmed');
  const parts = t.split('-');
  const sdt = parts.length >= 3 && parts[2] !== 'none' && parts[2] !== '';
  return { severity, acked, sdt };
}

/** sdtStatus is three slots (group, device, datasource/instance); any slot
 *  that is not 'none' means some SDT applies. */
function hasSdt(s) {
  if (!s) return false;
  return String(s).toLowerCase().split('-').some((p) => p && p !== 'none');
}

const severityNorm = (sev) => (Number(sev) >= 4 ? 'critical' : Number(sev) === 3 ? 'warning' : 'info');

/** Content-stable Ops Agent key for an LM alert; never the LM alert id. */
function conditionKey(sourceId, a) {
  return `lm:${sourceId}:${String(a.monitorObjectName || '').toLowerCase()}:${a.resourceTemplateName || ''}:${a.instanceName || ''}:${a.dataPointName || ''}`;
}

/** Epoch value to seconds: anything above 1e11 is milliseconds. */
const toEpochSeconds = (v) => {
  const n = numOrNull(v);
  if (n == null) return null;
  return n > 1e11 ? Math.floor(n / 1000) : Math.floor(n);
};

// -- Normalizers ---------------------------------------------------------------

function findProp(maps, ...names) {
  for (const name of names) {
    for (const m of maps) if (m[name] != null && m[name] !== '') return m[name];
  }
  return null;
}

function normalizeDevice(d) {
  const sys = propsToMap(d.systemProperties);
  const auto = propsToMap(d.autoProperties);
  const custom = propsToMap(d.customProperties);
  const inherited = propsToMap(d.inheritedProperties);
  const all = [sys, auto, custom, inherited];
  const sysinfo = findProp(all, 'system.sysinfo');
  const sysoid = findProp(all, 'system.sysoid');
  const categories = findProp([sys, custom, auto], 'system.categories');
  const ert = findProp(all, 'predef.externalResourceType', 'predef.externalresourcetype');
  const eriRaw = findProp(all, 'predef.externalResourceID', 'predef.externalresourceid');
  const vendor = classifyVendor({ sysoid, categories, sysinfo });
  const role = classifyRole({ ert, categories, vendor });
  const deviceType = numOrNull(d.deviceType);
  const ipsRaw = findProp(all, 'system.ips');
  const ips = ipsRaw ? String(ipsRaw).split(/[,\s]+/).map((x) => x.trim()).filter(Boolean) : [];
  const groupIds = String(d.hostGroupIds || '').split(',').map((x) => Number(x.trim())).filter((n) => Number.isFinite(n) && n > 0);
  return {
    lmDeviceId: numOrNull(d.id),
    name: strOrNull(d.name),
    displayName: strOrNull(d.displayName),
    description: strOrNull(d.description),
    deviceType,
    type: strOrNull(d.type),
    hostStatus: strOrNull(d.hostStatus),
    alertStatus: strOrNull(d.alertStatus),
    alertStatusPriority: numOrNull(d.alertStatusPriority),
    sdtStatus: strOrNull(d.sdtStatus),
    alertDisableStatus: strOrNull(d.alertDisableStatus),
    disableAlerting: boolInt(d.disableAlerting),
    groupIds,
    collectorId: numOrNull(d.currentCollectorId),
    preferredCollectorId: numOrNull(d.preferredCollectorId),
    collectorDescription: strOrNull(d.collectorDescription),
    enableNetflow: boolInt(d.enableNetflow),
    uptimeSeconds: numOrNull(d.upTimeInSeconds),
    createdEpoch: toEpochSeconds(d.createdOn),
    updatedEpoch: toEpochSeconds(d.updatedOn),
    deletedTimeMs: numOrNull(d.deletedTimeInMs),
    sysinfo,
    sysoid,
    sysname: findProp(all, 'system.sysname'),
    hostname: findProp(all, 'system.hostname'),
    // system.model and system.manufacturer are UNVERIFIED names; auto.* first.
    model: findProp(all, 'auto.endpoint.model', 'auto.model', 'system.model', 'auto.cisco.model', 'auto.f5.model'),
    vendor,
    role,
    isNetwork: isNetworkDevice({ deviceType, role }) ? 1 : 0,
    categories: categories || null,
    ips,
    version: parseVersion(sysinfo) || findProp(all, 'auto.version', 'auto.os.version.description'),
    serial: findProp(all, 'auto.serial', 'auto.endpoint.serial_number', 'auto.serialnumber', 'system.serialnumber'),
    eri: parseEri(eriRaw),
    ert: ert || null,
    systemProps: sys,
    autoProps: auto,
    customProps: custom,
    raw: d,
  };
}

function normalizeGroup(g) {
  return {
    lmGroupId: numOrNull(g.id),
    parentId: numOrNull(g.parentId),
    name: strOrNull(g.name),
    fullPath: strOrNull(g.fullPath),
    description: strOrNull(g.description),
    groupType: strOrNull(g.groupType),
    appliesTo: strOrNull(g.appliesTo),
    numOfHosts: numOrNull(g.numOfHosts),
    numOfDirectDevices: numOrNull(g.numOfDirectDevices),
    groupStatus: strOrNull(g.groupStatus),
    disableAlerting: boolInt(g.disableAlerting),
    customProps: propsToMap(g.customProperties),
  };
}

// Interface DataSource names, preferred order (current first, legacy after).
const INTERFACE_DATASOURCES = ['SNMP_Network_Interfaces', 'snmp64_If-', 'snmpIf-'];
// Neighbour DataSources (gated on the LLDP and CDP categories; datapoint and
// instance property names UNVERIFIED) read by the daily topology refresh.
const NEIGHBOR_DATASOURCES = { LLDP_Neighbors: 'lldp', CDP_Neighbors: 'cdp' };
// Vendor health DataSources (exact names from cisco-f5-modules.md) with their
// headline datapoint. v1 only labels alerts with them; no poller work.
const HEALTH_DATASOURCES = [
  { vendor: 'Cisco', name: 'Cisco_CPU_SNMP', label: 'Cisco CPU', datapoints: ['CPU1min'] },
  { vendor: 'Cisco', name: 'Cisco_MemoryPools_SNMP', label: 'Cisco memory pools', datapoints: ['PercentFree'] },
  { vendor: 'Cisco', name: 'Cisco_TemperatureSensors', label: 'Cisco temperature', datapoints: [] },
  { vendor: 'Cisco', name: 'Cisco_FRU_Power', label: 'Cisco power supplies', datapoints: ['OperatingStatus'] },
  { vendor: 'Cisco', name: 'Cisco_Catalyst_PowerOverEthernet', label: 'Cisco PoE', datapoints: ['PercentPowerUsed'] },
  { vendor: null, name: 'BGP-', label: 'BGP peers', datapoints: ['EstablishedTime'] },
  { vendor: null, name: 'OSPF_Neighbors', label: 'OSPF neighbours', datapoints: ['peerState'] },
  { vendor: 'Cisco', name: 'Cisco_EIGRP_Peers', label: 'Cisco EIGRP peers', datapoints: [] },
  { vendor: 'Cisco', name: 'Cisco_ASA_Failover', label: 'Cisco ASA failover', datapoints: [] },
  { vendor: 'F5', name: 'F5_BigIP_System', label: 'F5 system', datapoints: ['CPUUtilization', 'MemoryUsage', 'ClientCurrentConnections'] },
  { vendor: 'F5', name: 'F5_BigIP_FailoverStatus', label: 'F5 failover', datapoints: ['FailoverStatus'] },
  { vendor: 'F5', name: 'F5_BigIP_SSL_VIP_Certs', label: 'F5 VIP certificates', datapoints: ['DaysToExpiration'] },
  { vendor: 'F5', name: 'F5_BigIP_VIP_Statistics', label: 'F5 VIP statistics', datapoints: [] },
  { vendor: 'F5', name: 'F5_BigIP_PoolMemberStats', label: 'F5 pool members', datapoints: [] },
];
// LM Uptime DataSources that carry check data.
const UPTIME_DATASOURCES = ['Ping_Check_Individual', 'Ping_Check_Overall', 'Web_Check_Individual', 'Web_Check_Overall'];

function normalizeDeviceDatasource(r) {
  return {
    hdsId: numOrNull(r.id),
    datasourceId: numOrNull(r.dataSourceId),
    datasourceName: strOrNull(r.dataSourceName),
    datasourceDisplayName: strOrNull(r.dataSourceDisplayName),
    instanceCount: numOrNull(r.instanceNumber),
    monitoringInstanceCount: numOrNull(r.monitoringInstanceNumber),
    alertStatus: strOrNull(r.alertStatus),
    sdtStatus: strOrNull(r.sdtStatus),
    stopMonitoring: boolInt(r.stopMonitoring),
  };
}

const stripIdSuffix = (s) => (s == null ? null : String(s).replace(/\s*\[ID:\s*\d+\]\s*$/, ''));

function normalizeInstance(inst) {
  const auto = propsToMap(inst.autoProperties);
  const sys = propsToMap(inst.systemProperties);
  const custom = propsToMap(inst.customProperties);
  const wild = strOrNull(inst.wildValue);
  const ifIndex = wild != null && /^\d+$/.test(wild) ? Number(wild) : null;
  return {
    instanceId: numOrNull(inst.id),
    instanceName: strOrNull(inst.name),
    displayName: stripIdSuffix(inst.displayName),
    rawDisplayName: strOrNull(inst.displayName),
    description: strOrNull(inst.description) || auto['auto.interface.alias'] || sys['system.instanceDescription'] || null,
    ifIndex,
    wildValue: wild,
    stopMonitoring: boolInt(inst.stopMonitoring),
    disableAlerting: boolInt(inst.disableAlerting),
    alertStatus: strOrNull(inst.alertStatus),
    sdtStatus: strOrNull(inst.sdtStatus),
    props: { auto, system: sys, custom },
  };
}

function normalizeAlert(a, sourceId) {
  const isDevice = String(a.monitorObjectType || '').toLowerCase() === 'device';
  return {
    lmAlertId: strOrNull(a.id),
    internalId: strOrNull(a.internalId),
    type: strOrNull(a.type),
    severity: numOrNull(a.severity),
    severityNorm: severityNorm(a.severity),
    lmDeviceId: isDevice ? numOrNull(a.monitorObjectId) : null,
    monitorObjectName: strOrNull(a.monitorObjectName),
    monitorObjectType: strOrNull(a.monitorObjectType),
    resourceTemplateName: strOrNull(a.resourceTemplateName),
    resourceTemplateType: strOrNull(a.resourceTemplateType),
    instanceId: numOrNull(a.instanceId),
    instanceName: strOrNull(a.instanceName),
    instanceDescription: strOrNull(a.instanceDescription),
    dataPointName: strOrNull(a.dataPointName),
    alertValue: strOrNull(a.alertValue),
    threshold: strOrNull(a.threshold),
    clearValue: strOrNull(a.clearValue),
    startEpoch: toEpochSeconds(a.startEpoch),
    endEpoch: toEpochSeconds(a.endEpoch) || null,
    acked: boolInt(a.acked) || 0,
    ackedBy: strOrNull(a.ackedBy),
    ackComment: strOrNull(a.ackComment),
    ackedEpoch: toEpochSeconds(a.ackedEpoch) || null,
    sdted: a.sdted && typeof a.sdted === 'object' ? 1 : (boolInt(a.sdted) || 0),
    suppressor: strOrNull(a.suppressor),
    cleared: boolInt(a.cleared) || 0,
    rule: a.rule == null ? null : String(a.rule),
    ruleId: numOrNull(a.ruleId),
    chain: strOrNull(a.chain),
    anomaly: boolInt(a.anomaly),
    adAlert: boolInt(a.adAlert),
    conditionKey: conditionKey(sourceId, a),
    raw: a,
  };
}

function normalizeCollector(c) {
  return {
    collectorId: numOrNull(c.id),
    description: strOrNull(c.description),
    hostname: strOrNull(c.hostname),
    groupId: numOrNull(c.collectorGroupId),
    groupName: strOrNull(c.collectorGroupName),
    status: numOrNull(c.status),
    isDown: boolInt(c.isDown) || 0,
    acked: boolInt(c.acked) || 0,
    inSdt: boolInt(c.inSDT) || 0,
    numberOfHosts: numOrNull(c.numberOfHosts),
    numberOfInstances: numOrNull(c.numberOfInstances),
    build: strOrNull(c.build),
    platform: strOrNull(c.platform),
    arch: strOrNull(c.arch),
    size: strOrNull(c.collectorSize),
    uptimeSeconds: numOrNull(c.upTime),
    updatedEpoch: toEpochSeconds(c.updatedOn),
    createdEpoch: toEpochSeconds(c.createdOn),
    lastNotificationEpoch: toEpochSeconds(c.lastSentNotificationOn),
    backupCollectorId: numOrNull(c.backupAgentId),
    collectorDeviceId: numOrNull(c.collectorDeviceId),
    ea: boolInt(c.ea) || 0,
  };
}

function normalizeSdt(s, nowMs = Date.now()) {
  const startMs = numOrNull(s.startDateTime);
  const endMs = numOrNull(s.endDateTime);
  let effective = null;
  if (s.isEffective != null) effective = s.isEffective ? 1 : 0;
  else if ((s.sdtType || 'oneTime') === 'oneTime' && startMs != null && endMs != null) effective = startMs <= nowMs && nowMs <= endMs ? 1 : 0;
  return {
    sdtId: strOrNull(s.id),
    sdtType: strOrNull(s.type),
    scheduleType: strOrNull(s.sdtType),
    isEffective: effective,
    startMs,
    endMs,
    duration: numOrNull(s.duration),
    admin: strOrNull(s.admin),
    comment: strOrNull(s.comment),
    lmDeviceId: numOrNull(s.deviceId),
    deviceDisplayName: strOrNull(s.deviceDisplayName),
    groupId: numOrNull(s.deviceGroupId),
    groupFullPath: strOrNull(s.deviceGroupFullPath),
    collectorId: numOrNull(s.collectorId),
    datasourceName: strOrNull(s.dataSourceName),
    instanceId: numOrNull(s.dataSourceInstanceId),
    websiteId: numOrNull(s.websiteId ?? s.serviceId),
    raw: s,
  };
}

/** Ping knobs that decide pass/fail on a ping check (stored in raw_json). */
const pingKnobs = (w) => ({
  count: numOrNull(w.count),
  percentPktsNotReceiveInTime: numOrNull(w.percentPktsNotReceiveInTime),
  timeoutInMSPktsNotReceive: numOrNull(w.timeoutInMSPktsNotReceive),
});

function checkpointLocations(w, isInternal) {
  const collectors = safeArr(w.collectors);
  const byName = new Map();
  for (const c of collectors) {
    if (c?.hostname) byName.set(String(c.hostname).toLowerCase(), c);
    if (c?.description) byName.set(String(c.description).toLowerCase(), c);
  }
  return safeArr(w.checkpoints).map((cp) => {
    const geo = strOrNull(cp.geoInfo ?? cp.geoinfo);
    const smgId = numOrNull(cp.smgId);
    // smgId 0 for Overall is UNVERIFIED; geoInfo text is the second signal and
    // the datapoint set (totalSmCount / failSmCount) the third, set at data time.
    const isOverall = (geo && /overall/i.test(geo)) || smgId === 0 ? 1 : 0;
    const coll = geo ? byName.get(geo.toLowerCase()) : null;
    return {
      checkpointId: isOverall ? 'overall' : String(cp.id),
      lmCheckpointId: numOrNull(cp.id),
      label: isOverall ? 'Overall' : (coll?.hostname || geo || `checkpoint ${cp.id}`),
      smgId,
      collectorId: isInternal && coll ? numOrNull(coll.id) : null,
      isOverall,
    };
  }).filter((l) => l.lmCheckpointId != null);
}

function normalizeWebsite(w) {
  const isInternal = boolInt(w.isInternal) || 0;
  const kind = String(w.type || '').toLowerCase().includes('ping') ? 'ping' : 'web';
  return {
    checkId: `w:${w.id}`,
    lmId: numOrNull(w.id),
    kind,
    origin: 'website',
    name: strOrNull(w.name),
    target: strOrNull(w.host || w.domain),
    description: strOrNull(w.description),
    status: strOrNull(w.status),
    alertStatus: strOrNull(w.alertStatus),
    sdtStatus: strOrNull(w.sdtStatus),
    overallAlertLevel: strOrNull(w.overallAlertLevel),
    pollingInterval: numOrNull(w.pollingInterval),
    transition: numOrNull(w.transition),
    globalSmAlertCond: numOrNull(w.globalSmAlertCond),
    isInternal,
    stopMonitoring: boolInt(w.stopMonitoring),
    disableAlerting: boolInt(w.disableAlerting),
    groupId: numOrNull(w.groupId),
    testLocation: w.testLocation || null,
    collectors: safeArr(w.collectors).map((c) => ({ id: numOrNull(c.id), hostname: strOrNull(c.hostname), description: strOrNull(c.description), groupName: strOrNull(c.collectorGroupName) })),
    steps: w.steps || null,
    locations: checkpointLocations(w, isInternal),
    raw: { ...pingKnobs(w), type: w.type, id: w.id },
  };
}

/** An LM Uptime device (deviceType 18 web / 19 ping) as a check. Its
 *  locations come from its Uptime DataSource instances (daily refresh). */
function normalizeUptimeCheck(d) {
  const custom = propsToMap(d.customProperties);
  const isPing = Number(d.deviceType) === 19 || String(d.type || '').toLowerCase().includes('ping');
  return {
    checkId: `u:${d.id}`,
    lmId: numOrNull(d.id),
    kind: isPing ? 'ping' : 'web',
    origin: 'uptime',
    name: strOrNull(d.displayName || d.name),
    target: strOrNull(d.host || d.domain || custom['uptime.hostname'] || custom['uptime.url'] || d.name),
    description: strOrNull(d.description),
    status: strOrNull(d.status || d.hostStatus),
    alertStatus: strOrNull(d.alertStatus),
    sdtStatus: strOrNull(d.sdtStatus),
    overallAlertLevel: strOrNull(d.overallAlertLevel),
    pollingInterval: numOrNull(d.pollingInterval ?? custom['uptime.pollingInterval']),
    transition: numOrNull(d.transition),
    globalSmAlertCond: numOrNull(d.globalSmAlertCond),
    isInternal: boolInt(d.isInternal) || 0,
    stopMonitoring: null,
    disableAlerting: boolInt(d.disableAlerting),
    groupId: null,
    testLocation: d.testLocation || null,
    collectors: safeArr(d.collectors).map((c) => ({ id: numOrNull(c.id), hostname: strOrNull(c.hostname), description: strOrNull(c.description), groupName: strOrNull(c.collectorGroupName) })),
    steps: d.steps || null,
    locations: [],
    raw: { ...pingKnobs(d), type: d.type, deviceType: d.deviceType, id: d.id },
  };
}

const isUptimeDevice = (d) => [18, 19].includes(Number(d.deviceType)) || /^uptime(web|ping)check$/i.test(String(d.type || ''));

function normalizeAdmin(a) {
  return {
    adminId: numOrNull(a.id),
    username: strOrNull(a.username),
    email: strOrNull(a.email),
    status: strOrNull(a.status),
    roles: safeArr(a.roles).map((r) => (r && typeof r === 'object' ? r.name : r)).filter(Boolean).map(String),
    apiTokenCount: safeArr(a.apiTokens).length,
    apionly: boolInt(a.apionly) || 0,
    lastLoginEpoch: toEpochSeconds(a.lastLoginOn) || null,
    twoFa: boolInt(a.twoFAEnabled),
    createdBy: strOrNull(a.createdBy),
  };
}

function normalizeRole(r) {
  return {
    roleId: numOrNull(r.id),
    name: strOrNull(r.name),
    description: strOrNull(r.description),
    userCount: numOrNull(r.associatedUserCount),
    twoFaRequired: boolInt(r.twoFARequired),
    privileges: safeArr(r.privileges).map((p) => ({ objectType: p.objectType ?? null, objectId: p.objectId ?? null, objectName: p.objectName ?? null, operation: p.operation ?? null })),
  };
}

// -- Fetchers --------------------------------------------------------------------

const DEVICE_FIELDS = 'id,name,displayName,description,deviceType,hostStatus,alertStatus,alertStatusPriority,sdtStatus,alertDisableStatus,disableAlerting,hostGroupIds,currentCollectorId,preferredCollectorId,collectorDescription,enableNetflow,netflowCollectorId,createdOn,updatedOn,upTimeInSeconds,deletedTimeInMs,systemProperties,autoProperties,customProperties,type';
const GROUP_FIELDS = 'id,name,fullPath,parentId,description,groupType,appliesTo,numOfHosts,numOfDirectDevices,groupStatus,disableAlerting,customProperties';
const DDS_FIELDS = 'id,dataSourceId,dataSourceName,dataSourceDisplayName,instanceNumber,monitoringInstanceNumber,alertStatus,sdtStatus,stopMonitoring,status';
const INSTANCE_FIELDS = 'id,name,displayName,description,wildValue,wildValue2,stopMonitoring,disableAlerting,alertStatus,sdtStatus,customProperties,autoProperties,systemProperties';
const COLLECTOR_FIELDS = 'id,description,hostname,collectorGroupId,collectorGroupName,status,isDown,acked,inSDT,numberOfHosts,numberOfInstances,build,platform,arch,collectorSize,upTime,updatedOn,createdOn,lastSentNotificationOn,backupAgentId,enableFailBack,collectorDeviceId,ea';
const ADMIN_FIELDS = 'id,username,email,status,roles,apiTokens,apionly,lastLoginOn,twoFAEnabled,createdBy';
const ROLE_FIELDS = 'id,name,description,associatedUserCount,twoFARequired,privileges';

/**
 * Devices, paged, sort=+id. groupIds (LM group ids) scopes with
 * hostGroupIds:"a"|"b". If fields= drops the undeclared rollups (alertStatus
 * and sdtStatus, a known probe item) the list is re-read without fields=.
 */
async function fetchDevices(source, { groupIds = null, filter = null, size = PAGE_SIZE, maxPages = 500, raw = false } = {}) {
  const clauses = [];
  if (Array.isArray(groupIds) && groupIds.length) clauses.push(['hostGroupIds', ':', groupIds.map(String)]);
  const f = [filter, buildFilter(clauses)].filter(Boolean).join(',');
  const params = { sort: '+id', fields: DEVICE_FIELDS, ...(f ? { filter: f } : {}) };
  let items = (await paginate(source, '/device/devices', { params, size, maxPages })).items;
  if (items.length && items.every((d) => !('alertStatus' in d) && !('sdtStatus' in d))) {
    logger.warn('[LmApi] fields= dropped alertStatus/sdtStatus on /device/devices; re-reading full objects');
    const { fields, ...rest } = params;
    items = (await paginate(source, '/device/devices', { params: rest, size, maxPages })).items;
  }
  return raw ? items : items.map(normalizeDevice);
}

/** Uptime check devices with full objects (testLocation, checkpoints). The
 *  deviceType filter is UNVERIFIED; on error the type filter is tried. */
async function fetchUptimeDevices(source) {
  try {
    return (await paginate(source, '/device/devices', { params: { sort: '+id', filter: 'deviceType:18||deviceType:19' } })).items;
  } catch (err) {
    logger.warn(`[LmApi] deviceType filter for Uptime checks failed (${errMsg(err)}); trying type filter`);
    return (await paginate(source, '/device/devices', { params: { sort: '+id', filter: 'type:"uptimepingcheck"||type:"uptimewebcheck"' } })).items;
  }
}

const fetchGroups = async (source, { size = PAGE_SIZE, maxPages = 100 } = {}) =>
  (await listAll(source, '/device/groups', { params: { sort: '+id', fields: GROUP_FIELDS }, size, maxPages })).map(normalizeGroup);

const fetchDeviceDatasources = async (source, deviceId, { size = PAGE_SIZE, maxPages = 5, filter = null } = {}) =>
  (await listAll(source, `/device/devices/${Number(deviceId)}/devicedatasources`, { params: { fields: DDS_FIELDS, ...(filter ? { filter } : {}) }, size, maxPages })).map(normalizeDeviceDatasource);

const fetchInstances = async (source, deviceId, hdsId, { size = PAGE_SIZE, maxPages = 10 } = {}) =>
  (await listAll(source, `/device/devices/${Number(deviceId)}/devicedatasources/${Number(hdsId)}/instances`, { params: { fields: INSTANCE_FIELDS }, size, maxPages })).map(normalizeInstance);

/** Per device-datasource data: {dataSourceName, dataPoints[], instances{name:
 *  {values[][], time[]}}, nextPageParams}. Returned raw. start/end are
 *  epoch seconds. */
async function fetchDsData(source, deviceId, hdsId, { start, end, datapoints = null, aggregate = null } = {}) {
  await paceDataCall(source.id);
  return request(source, 'get', `/device/devices/${Number(deviceId)}/devicedatasources/${Number(hdsId)}/data`, {
    params: { start, end, ...(datapoints ? { datapoints } : {}), ...(aggregate ? { aggregate } : {}) },
  });
}

/** Website checkpoint raw data: {dataPoints[] (live, not in swagger), time[],
 *  values[][], nextPageParams}. Returned raw. Keep windows at or under 8 h. */
async function fetchCheckpointData(source, websiteId, checkpointId, { start, end, datapoints = null, aggregate = null } = {}) {
  await paceDataCall(source.id);
  return request(source, 'get', `/website/websites/${Number(websiteId)}/checkpoints/${Number(checkpointId)}/data`, {
    params: { start, end, ...(datapoints ? { datapoints } : {}), ...(aggregate ? { aggregate } : {}) },
  });
}

/** Open alerts (cleared:false), paged up to the 10000 offset cap. */
async function fetchOpenAlerts(source, { size = PAGE_SIZE, maxPages = 10, raw = false } = {}) {
  const res = await paginate(source, '/alert/alerts', {
    params: { needMessage: 'false', filter: 'cleared:false' }, size, maxPages, maxOffset: ALERT_OFFSET_CAP,
  });
  if (res.truncated) logger.warn(`[LmApi] open alert list truncated at ${res.items.length}`);
  return raw ? res.items : res.items.map((a) => normalizeAlert(a, source.id));
}

/** Cleared alerts that started after sinceEpoch (seconds). The 10000 offset
 *  cap is handled by splitting the startEpoch window in half on overflow. */
async function fetchClearedAlerts(source, sinceEpoch, untilEpoch = Math.floor(Date.now() / 1000), depth = 0) {
  const filter = `cleared:true,startEpoch>:${Math.floor(sinceEpoch)},startEpoch<:${Math.floor(untilEpoch)}`;
  const res = await paginate(source, '/alert/alerts', {
    params: { needMessage: 'false', filter }, size: PAGE_SIZE, maxPages: 10, maxOffset: ALERT_OFFSET_CAP,
  });
  if (res.truncated && depth < 6 && untilEpoch - sinceEpoch > 600) {
    const mid = Math.floor((sinceEpoch + untilEpoch) / 2);
    const a = await fetchClearedAlerts(source, sinceEpoch, mid, depth + 1);
    const b = await fetchClearedAlerts(source, mid, untilEpoch, depth + 1);
    return [...a, ...b];
  }
  return res.items.map((a) => normalizeAlert(a, source.id));
}

const fetchCollectors = async (source, { size = PAGE_SIZE, maxPages = 20 } = {}) =>
  (await listAll(source, '/setting/collector/collectors', { params: { fields: COLLECTOR_FIELDS }, size, maxPages })).map(normalizeCollector);

/** Collector version catalogue; returns {mgd, versions}. mgd = highest
 *  version flagged mandatory: true. */
async function fetchCollectorVersions(source) {
  const body = await request(source, 'get', '/setting/collector/collectors/versions', { params: { size: PAGE_SIZE } });
  const items = Array.isArray(body) ? body : safeArr(body?.items);
  const versions = items.map((v) => {
    const major = numOrNull(v.majorVersion);
    const minor = numOrNull(v.minorVersion);
    const version = strOrNull(v.version) || (major != null ? `${major}.${String(minor ?? 0).padStart(3, '0')}` : null);
    return { version, mandatory: !!v.mandatory, stable: !!v.stable };
  }).filter((v) => v.version);
  const mandatory = versions.filter((v) => v.mandatory).map((v) => v.version);
  mandatory.sort((a, b) => compareBuildStr(b, a));
  return { mgd: mandatory[0] || null, versions };
}

function compareBuildStr(a, b) {
  const pa = String(a || '').split('.').map((x) => Number(x) || 0);
  const pb = String(b || '').split('.').map((x) => Number(x) || 0);
  for (let i = 0; i < 2; i += 1) {
    if ((pa[i] || 0) !== (pb[i] || 0)) return (pa[i] || 0) < (pb[i] || 0) ? -1 : 1;
  }
  return 0;
}

const fetchSdts = async (source, { size = PAGE_SIZE, maxPages = 20 } = {}) => {
  const now = Date.now();
  return (await listAll(source, '/sdt/sdts', { size, maxPages })).map((s) => normalizeSdt(s, now));
};

const fetchWebsites = async (source, { size = PAGE_SIZE, maxPages = 20, raw = false } = {}) => {
  const items = await listAll(source, '/website/websites', { size, maxPages });
  return raw ? items : items.map(normalizeWebsite);
};

const fetchAdmins = async (source, { size = PAGE_SIZE, maxPages = 20 } = {}) =>
  (await listAll(source, '/setting/admins', { params: { fields: ADMIN_FIELDS }, size, maxPages })).map(normalizeAdmin);

const fetchRoles = async (source, { size = PAGE_SIZE, maxPages = 20 } = {}) =>
  (await listAll(source, '/setting/roles', { params: { fields: ROLE_FIELDS }, size, maxPages })).map(normalizeRole);

// -- Probe helpers -----------------------------------------------------------------

/** One GET for the probe route: {ok, sample, count, total, error}. Never throws. */
async function probeGet(source, path, params = {}) {
  try {
    const body = await request(source, 'get', path, { params, timeout: 30000 });
    if (body && Array.isArray(body.items)) {
      return { ok: true, sample: body.items.slice(0, 3), count: body.items.length, total: numOrNull(body.total), error: null };
    }
    let size = null;
    try { size = JSON.stringify(body).length; } catch { /* unserialisable */ }
    return { ok: true, sample: body, count: Array.isArray(body) ? body.length : null, total: null, size, error: null };
  } catch (err) {
    return { ok: false, sample: null, count: 0, total: null, error: errMsg(err) };
  }
}

// -- Test connection ----------------------------------------------------------------

async function testConnection(candidate) {
  const company = normalizeCompany(candidate.company);
  const authMode = authModeOf(candidate);
  if (!company) return { ok: false, message: 'company must be the portal subdomain, e.g. acme for acme.logicmonitor.com', details: { company: null, authMode } };
  const src = { ...candidate, company };
  let serverTime = null;
  try {
    const body = await request(src, 'get', '/device/devices', { params: { size: 1, fields: 'id' }, timeout: 20000 });
    const total = numOrNull(body?.total);
    const rateLimit = candidate.id != null ? getRateLimitSnapshot(candidate.id) : {};
    serverTime = body?.serverTime || null;
    return {
      ok: true,
      message: `Connected to ${company}.logicmonitor.com (${total == null ? 'device count unknown' : total < 0 ? `at least ${-total} devices` : `${total} device${total === 1 ? '' : 's'}`})`,
      details: {
        company,
        authMode,
        deviceCount: total == null ? null : Math.abs(total),
        rateLimit: rateLimit['/device/devices'] || null,
        version: 'v3',
        serverTime,
      },
    };
  } catch (err) {
    return { ok: false, message: errMsg(err), details: { company, authMode, deviceCount: null, rateLimit: null, version: 'v3', serverTime } };
  }
}

module.exports = {
  // constants and tables
  PAGE_SIZE, ALERT_OFFSET_CAP, CREDS_REJECTED,
  SYSOID_VENDORS, CATEGORY_VENDORS, CATEGORY_ROLES, ERT_ROLES, SWITCH_VENDORS, NETWORK_ROLES, ROLES,
  VERSION_PATTERNS, INTERFACE_DATASOURCES, UPTIME_DATASOURCES, NEIGHBOR_DATASOURCES, HEALTH_DATASOURCES,
  // helpers
  numOrNull, strOrNull, boolInt, safeArr, jsonOrNull, propsToMap, stripIdSuffix, toEpochSeconds,
  normalizeCompany, baseUrl, apiRoot, authModeOf, creds, signLmv1, authHeader,
  filterValue, buildFilter, encodeFilter, buildQuery, errMsg, endpointFamily,
  getRateLimitSnapshot, invalidate,
  request, paginateWith, paginate, listAll,
  // classification
  classifyVendor, classifyRole, isNetworkDevice, parseVersion, parseEri, splitCategories,
  parseAlertStatus, hasSdt, severityNorm, conditionKey, compareBuildStr,
  // normalizers
  normalizeDevice, normalizeGroup, normalizeDeviceDatasource, normalizeInstance, normalizeAlert,
  normalizeCollector, normalizeSdt, normalizeWebsite, normalizeUptimeCheck, isUptimeDevice,
  normalizeAdmin, normalizeRole,
  // fetchers
  fetchDevices, fetchUptimeDevices, fetchGroups, fetchDeviceDatasources, fetchInstances, fetchDsData,
  fetchCheckpointData, fetchOpenAlerts, fetchClearedAlerts, fetchCollectors, fetchCollectorVersions,
  fetchSdts, fetchWebsites, fetchAdmins, fetchRoles,
  probeGet, testConnection,
  // test seams
  _setSleep, _setTransport,
};
