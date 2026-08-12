// UniFi API client: Integration API (`/proxy/network/integration/v1`) for
// site discovery + testConnection, and the richer Legacy API
// (`/proxy/network/api/s/{site}/...` + `/proxy/network/v2/api/site/{site}/...`)
// for devices/ports/clients/wlans/networks/rogue APs/health/events/topology.
// Auth is a single `X-API-KEY` header on every request (no session/cookie
// dance). Every parser guards every field access — a malformed/missing field
// degrades to null rather than throwing (nutanixApi.js pattern).
//
// DEVIATION FROM THE BUILT-IN: the original (backend/services/unifiApi.js)
// uses axios, which is not available to a bundled plugin (esbuild has no
// axios to bundle from plugin-sdk's dependency tree). Re-implemented on
// Node's built-in `https` module (plugin-sdk/nutanix backend client
// pattern), with GET (query-string) and POST (JSON body) support, plus a
// `buffer` response mode for the Protect snapshot proxy. Every function now
// threads `coreApi` through for decrypt/logging instead of requiring host
// modules directly.
const https = require('https');
const { URLSearchParams } = require('url');

// ── Credentials / transport plumbing ────────────────────────────────────────

function creds(source, coreApi) {
  // Unsaved candidates (test connection) carry a plaintext apiKey; registered
  // rows carry the encrypted blob.
  if (source.apiKey != null) return { apiKey: source.apiKey };
  if (source.apikey != null) return { apiKey: source.apikey };
  if (!source.encrypted_credentials) return { apiKey: null };
  try {
    const c = JSON.parse(coreApi.encryption.decrypt(source.encrypted_credentials));
    return { apiKey: c.apiKey };
  } catch {
    return { apiKey: null };
  }
}

/** Raw HTTPS call against a UniFi source. Resolves with { data, headers };
 *  `responseType: 'buffer'` skips JSON parsing and resolves data as a
 *  Buffer (Protect snapshot). Rejects with an Error carrying
 *  `.response = { status, data, headers }`. */
function rawRequest(source, { method = 'GET', path, params, data, headers = {}, timeout = 30000, responseType = 'json' } = {}) {
  return new Promise((resolve, reject) => {
    const qs = new URLSearchParams();
    for (const [k, v] of Object.entries(params || {})) {
      if (v !== undefined && v !== null) qs.set(k, String(v));
    }
    const query = qs.toString();
    const reqPath = `${path}${query ? `?${query}` : ''}`;
    const body = data !== undefined ? JSON.stringify(data) : undefined;
    const reqHeaders = { ...headers };
    if (body !== undefined) {
      reqHeaders['Content-Type'] = 'application/json';
      reqHeaders['Content-Length'] = Buffer.byteLength(body);
    }
    const sslVerify = source.ssl_verify !== undefined ? source.ssl_verify : source.sslVerify;

    const req = https.request(
      {
        hostname: source.host,
        port: source.port || 443,
        path: reqPath,
        method,
        timeout,
        rejectUnauthorized: !!sslVerify,
        headers: reqHeaders,
      },
      (res) => {
        const chunks = [];
        res.on('data', (chunk) => chunks.push(chunk));
        res.on('end', () => {
          const raw = Buffer.concat(chunks);
          const status = res.statusCode;
          let payload;
          if (responseType === 'buffer') {
            payload = raw;
          } else {
            const str = raw.toString('utf8');
            try { payload = str ? JSON.parse(str) : null; } catch { payload = str || null; }
          }
          if (status >= 200 && status < 300) {
            resolve({ data: payload, headers: res.headers });
            return;
          }
          const msg = responseType === 'buffer' ? `HTTP ${status}` : (payload?.message || payload?.data?.message || `HTTP ${status}`);
          const e = new Error(msg);
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

async function apiRequest(source, coreApi, opts) {
  const { apiKey } = creds(source, coreApi);
  const headers = { ...(opts.headers || {}) };
  if (apiKey) headers['X-API-KEY'] = apiKey;
  const res = await rawRequest(source, { ...opts, headers });
  return res;
}

const INTEGRATION_BASE = '/proxy/network/integration/v1';
const LEGACY_BASE = '/proxy/network/api';
const LEGACY_V2_BASE = '/proxy/network/v2/api';

async function integrationGet(source, coreApi, path, params) {
  const res = await apiRequest(source, coreApi, { method: 'GET', path: `${INTEGRATION_BASE}${path}`, params });
  return res.data;
}
async function legacyGet(source, coreApi, site, path, params) {
  const res = await apiRequest(source, coreApi, { method: 'GET', path: `${LEGACY_BASE}/s/${site}${path}`, params });
  return res.data;
}
async function legacyPost(source, coreApi, site, path, data) {
  const res = await apiRequest(source, coreApi, { method: 'POST', path: `${LEGACY_BASE}/s/${site}${path}`, data });
  return res.data;
}
async function legacyV2Get(source, coreApi, site, path, params) {
  const res = await apiRequest(source, coreApi, { method: 'GET', path: `${LEGACY_V2_BASE}/site/${site}${path}`, params });
  return res.data;
}
async function legacyV2Post(source, coreApi, site, path, data) {
  const res = await apiRequest(source, coreApi, { method: 'POST', path: `${LEGACY_V2_BASE}/site/${site}${path}`, data });
  return res.data;
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

// Timestamps on the system-log feed are unverified per-field name — probe
// tolerantly across the candidates the UniFi ecosystem commonly uses, and
// accept either ms-epoch or ISO strings.
function occurredAtIso(row) {
  const raw = row?.timestamp ?? row?.time ?? row?.datetime ?? row?.time_ts ?? null;
  if (raw == null) return null;
  if (typeof raw === 'number' || /^\d+$/.test(String(raw))) {
    const n = Number(raw);
    if (!Number.isFinite(n) || n <= 0) return null;
    // Heuristic: treat 10-digit values as seconds, else ms.
    const ms = String(raw).length <= 10 ? n * 1000 : n;
    try { return new Date(ms).toISOString(); } catch { return null; }
  }
  const d = new Date(raw);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

// ── Integration API: site discovery + testConnection ────────────────────────

async function fetchInfo(source, coreApi) {
  const d = await integrationGet(source, coreApi, '/info');
  return { applicationVersion: strOrNull(d?.applicationVersion) };
}

async function fetchSites(source, coreApi) {
  const out = [];
  let offset = 0;
  const limit = 200;
  // Paginated per contract (offset/limit, limit max 200); guard against a
  // pathological server with a hard cap on iterations.
  for (let i = 0; i < 25; i++) {
    const d = await integrationGet(source, coreApi, '/sites', { offset, limit });
    const data = safeArr(d?.data);
    for (const s of data) {
      out.push({ id: strOrNull(s.id), internalReference: strOrNull(s.internalReference), name: strOrNull(s.name) });
    }
    const total = numOrNull(d?.totalCount) ?? data.length;
    offset += data.length;
    if (!data.length || offset >= total) break;
  }
  return out;
}

function errMsg(err) {
  return err?.response ? `HTTP ${err.response.status}${err.response.data?.message ? `: ${err.response.data.message}` : ''}` : (err?.message || String(err));
}

async function testConnection(candidate, coreApi) {
  try {
    const [sites, info] = await Promise.all([fetchSites(candidate, coreApi), fetchInfo(candidate, coreApi)]);
    return { ok: true, sites, applicationVersion: info.applicationVersion };
  } catch (err) {
    return { ok: false, error: errMsg(err) };
  }
}

// ── Legacy API: devices + ports ─────────────────────────────────────────────

function parsePort(port) {
  return {
    portIdx: numOrNull(port.port_idx),
    name: strOrNull(port.name ?? port.ifname),
    media: strOrNull(port.media),
    up: boolToInt(port.up),
    speed: numOrNull(port.speed),
    fullDuplex: boolToInt(port.full_duplex),
    isUplink: boolToInt(port.is_uplink),
    poeCapable: boolToInt(port.port_poe),
    poeEnable: boolToInt(port.poe_enable),
    poeGood: port.poe_good == null ? null : boolToInt(port.poe_good),
    poePower: numOrNull(port.poe_power),
    poeCurrent: numOrNull(port.poe_current),
    poeVoltage: numOrNull(port.poe_voltage),
    poeClass: strOrNull(port.poe_class),
    rxBytes: numOrNull(port.rx_bytes),
    txBytes: numOrNull(port.tx_bytes),
    rxErrors: numOrNull(port.rx_errors),
    txErrors: numOrNull(port.tx_errors),
    rxDropped: numOrNull(port.rx_dropped),
    txDropped: numOrNull(port.tx_dropped),
    networkName: strOrNull(port.network_name),
    speedCaps: numOrNull(port.speed_caps),
    aggregatedBy: port.aggregated_by == null ? null : boolToInt(port.aggregated_by),
  };
}

function parseDevice(d) {
  const sysStats = d['system-stats'] || {};
  const uplink = d.uplink || {};
  const ports = safeArr(d.port_table).map(parsePort);
  return {
    device: {
      mac: strOrNull(d.mac),
      deviceId: strOrNull(d._id ?? d.device_id),
      name: strOrNull(d.name),
      model: strOrNull(d.model),
      shortname: strOrNull(d.shortname),
      type: strOrNull(d.type),
      ip: strOrNull(d.ip),
      version: strOrNull(d.version),
      state: numOrNull(d.state),
      adopted: boolToInt(d.adopted),
      upgradable: boolToInt(d.upgradable),
      overheating: boolToInt(d.overheating),
      serial: strOrNull(d.serial),
      uptime: numOrNull(d.uptime),
      cpuPct: numOrNull(sysStats.cpu),
      memPct: numOrNull(sysStats.mem),
      tempsJson: Array.isArray(d.temperatures) ? jsonOrNull(d.temperatures) : null,
      satisfaction: numOrNull(d.satisfaction),
      numSta: numOrNull(d.num_sta),
      txBytes: numOrNull(d.tx_bytes),
      rxBytes: numOrNull(d.rx_bytes),
      uplinkMac: strOrNull(uplink.uplink_mac),
      uplinkPort: numOrNull(uplink.port_idx),
      uplinkType: strOrNull(uplink.type),
      radiosJson: mergedRadiosJson(d),
      isGateway: d.type === 'udm' ? 1 : 0,
      lastSeen: numOrNull(d.last_seen),
    },
    ports,
    wan1: d.wan1 || null,
    uplink: d.uplink || null,
    speedtestStatus: d['speedtest-status'] || null,
  };
}

// radio_table is config only; the live numbers (actual tx_power, num_sta,
// satisfaction, channel utilization) arrive in radio_table_stats — merge by
// interface name so the stored radios carry both.
function mergedRadiosJson(d) {
  const table = Array.isArray(d.radio_table) ? d.radio_table : [];
  const stats = Array.isArray(d.radio_table_stats) ? d.radio_table_stats : [];
  if (!table.length && !stats.length) return null;
  const statsByName = new Map(stats.map((s) => [s.name, s]));
  const names = new Set([...table.map((r) => r.name), ...stats.map((s) => s.name)]);
  const merged = [...names].map((name) => {
    const r = table.find((x) => x.name === name) || {};
    const s = statsByName.get(name) || {};
    return {
      name,
      radio: s.radio ?? r.radio ?? null,
      channel: numOrNull(s.channel ?? r.channel),
      ht: numOrNull(s.bw ?? r.ht),
      tx_power: numOrNull(s.tx_power ?? r.tx_power),
      max_txpower: numOrNull(r.max_txpower),
      tx_power_mode: strOrNull(r.tx_power_mode),
      num_sta: numOrNull(s.num_sta),
      satisfaction: s.satisfaction != null && s.satisfaction >= 0 ? numOrNull(s.satisfaction) : null,
      cu_total: numOrNull(s.cu_total),
      state: strOrNull(s.state),
      tx_retries_pct: numOrNull(s.tx_retries_pct),
      cu_self_rx: numOrNull(s.cu_self_rx),
      cu_self_tx: numOrNull(s.cu_self_tx),
    };
  });
  return jsonOrNull(merged);
}

async function fetchDevices(source, coreApi, site) {
  const d = await legacyGet(source, coreApi, site, '/stat/device');
  return safeArr(d?.data).map(parseDevice);
}

// ── Legacy API: clients ──────────────────────────────────────────────────────

function parseClient(c) {
  return {
    mac: strOrNull(c.mac),
    name: strOrNull(c.name),
    hostname: strOrNull(c.hostname),
    ip: strOrNull(c.ip),
    isWired: boolToInt(c.is_wired),
    isGuest: boolToInt(c.is_guest),
    network: strOrNull(c.network),
    essid: strOrNull(c.essid),
    apMac: strOrNull(c.ap_mac),
    swMac: strOrNull(c.sw_mac),
    swPort: numOrNull(c.sw_port),
    channel: numOrNull(c.channel),
    radio: strOrNull(c.radio),
    rssi: numOrNull(c.rssi),
    signal: numOrNull(c.signal),
    noise: numOrNull(c.noise),
    satisfaction: numOrNull(c.satisfaction),
    txRate: numOrNull(c.tx_rate),
    rxRate: numOrNull(c.rx_rate),
    wiredRateMbps: numOrNull(c.wired_rate_mbps),
    uptime: numOrNull(c.uptime),
    txBytes: numOrNull(c.tx_bytes),
    rxBytes: numOrNull(c.rx_bytes),
    oui: strOrNull(c.oui),
  };
}

async function fetchClients(source, coreApi, site) {
  const d = await legacyGet(source, coreApi, site, '/stat/sta');
  return safeArr(d?.data).map(parseClient);
}

// ── Legacy API: WLANs, networks, rogue APs, IPS, health ─────────────────────

async function fetchWlans(source, coreApi, site) {
  const d = await legacyGet(source, coreApi, site, '/rest/wlanconf');
  return safeArr(d?.data).map((w) => ({
    wlanId: strOrNull(w._id),
    name: strOrNull(w.name),
    enabled: boolToInt(w.enabled),
    security: strOrNull(w.security),
    wpaMode: strOrNull(w.wpa_mode),
    isGuest: boolToInt(w.is_guest),
    hideSsid: boolToInt(w.hide_ssid),
    postureJson: jsonOrNull({
      wpa_mode: w.wpa_mode ?? null,
      wpa3_support: w.wpa3_support ?? null,
      wpa3_transition: w.wpa3_transition ?? null,
      pmf_mode: w.pmf_mode ?? null,
      hide_ssid: w.hide_ssid ?? null,
      l2_isolation: w.l2_isolation ?? null,
      bss_transition: w.bss_transition ?? null,
      fast_roaming_enabled: w.fast_roaming_enabled ?? null,
      minrate_ng_enabled: w.minrate_ng_enabled ?? null,
    }),
  }));
}

async function fetchNetworks(source, coreApi, site) {
  const d = await legacyGet(source, coreApi, site, '/rest/networkconf');
  return safeArr(d?.data).map((n) => ({
    networkId: strOrNull(n._id),
    name: strOrNull(n.name),
    purpose: strOrNull(n.purpose),
    vlan: numOrNull(n.vlan),
    subnet: strOrNull(n.ip_subnet),
    enabled: boolToInt(n.enabled),
  }));
}

async function fetchRogueAps(source, coreApi, site) {
  const d = await legacyGet(source, coreApi, site, '/stat/rogueap');
  return safeArr(d?.data).map((r) => ({
    bssid: strOrNull(r.bssid),
    essid: strOrNull(r.essid),
    channel: numOrNull(r.channel),
    signal: numOrNull(r.signal),
    security: strOrNull(r.security),
    oui: strOrNull(r.oui),
    isRogue: boolToInt(r.is_rogue),
    lastSeen: numOrNull(r.last_seen),
  }));
}

async function fetchIpsSettings(source, coreApi, site) {
  const d = await legacyGet(source, coreApi, site, '/rest/setting/ips');
  const row = safeArr(d?.data)[0] || null;
  if (!row) {
    return {
      enabled: false, categories: [], adBlocking: false, raw: null,
      mode: null, honeypotEnabled: false, dnsFiltering: false, contentFiltering: false, enabledNetworks: [],
    };
  }
  const categories = safeArr(row.enabled_categories);
  const mode = strOrNull(row.ips_mode);
  const enabled = mode != null ? mode !== 'disabled' : categories.length > 0;
  return {
    enabled,
    categories,
    adBlocking: !!row.ad_blocking_enabled,
    raw: jsonOrNull(row),
    mode,
    honeypotEnabled: !!row.honeypot_enabled,
    dnsFiltering: !!row.dns_filtering,
    contentFiltering: !!row.content_filtering_blocking_page_enabled,
    enabledNetworks: Array.isArray(row.enabled_networks) ? row.enabled_networks : (row.enabled_networks ? [row.enabled_networks] : []),
  };
}

async function fetchHealth(source, coreApi, site) {
  const d = await legacyGet(source, coreApi, site, '/stat/health');
  return safeArr(d?.data);
}

// ── WiFi/Security round: firewall/traffic rules + hourly usage reports ──────

function parseFirewallRule(kind, r) {
  return {
    kind,
    ruleId: strOrNull(r._id ?? r.id),
    ruleset: strOrNull(r.ruleset),
    ruleIndex: numOrNull(r.rule_index ?? r.index),
    name: strOrNull(r.name ?? r.description),
    action: strOrNull(r.action),
    enabled: boolToInt(r.enabled),
    protocol: strOrNull(r.protocol),
    src: strOrNull(r.src_address ?? r.matching_target),
    dst: strOrNull(r.dst_address),
    logging: boolToInt(r.logging),
    rawJson: jsonOrNull(r),
  };
}

// Each surface (legacy firewallrule / v2 trafficrules) is fetched
// independently so a missing/unsupported one degrades to an empty array
// rather than dropping the other kind.
async function fetchFirewallRules(source, coreApi, site) {
  let firewall = [];
  let traffic = [];
  try {
    const d = await legacyGet(source, coreApi, site, '/rest/firewallrule');
    firewall = safeArr(d?.data).map((r) => parseFirewallRule('firewall', r));
  } catch { /* tolerate missing/unsupported */ }
  try {
    const d = await legacyV2Get(source, coreApi, site, '/trafficrules');
    traffic = safeArr(d).map((r) => parseFirewallRule('traffic', r));
  } catch { /* tolerate missing/unsupported */ }
  return { firewall, traffic };
}

// Not called by the poller — route-side live fetch (§ROUTES /wifi history),
// cached in-memory by the caller. scope is 'site' or 'ap'. Deviation flag
// (WP-A): uses a short 8s timeout instead of the poller's 30s — this call
// blocks an in-flight HTTP response (GET /wifi), so a slow/unreachable
// controller must not hang the page load for up to 30s per source.
async function fetchHourlyReport(source, coreApi, site, scope, hours) {
  const attrs = scope === 'ap' ? ['bytes', 'num_sta', 'time'] : ['bytes', 'wlan_bytes', 'num_sta', 'wlan-num_sta', 'time'];
  const end = Date.now();
  const start = end - hours * 3600 * 1000;
  const d = await legacyPostTimeout(source, coreApi, site, `/stat/report/hourly.${scope}`, { attrs, start, end }, 8000);
  return safeArr(d?.data);
}

async function legacyPostTimeout(source, coreApi, site, path, data, timeout) {
  const res = await apiRequest(source, coreApi, { method: 'POST', path: `${LEGACY_BASE}/s/${site}${path}`, data, timeout });
  return res.data;
}

// message_raw is a template ("{SRC_CLIENT} was blocked from accessing {DST_IP}…")
// with the real values in a parallel `parameters` object whose entries are either
// plain strings or objects ({id: mac, ip, name, hostname, …}) — substitute them.
function renderLogMessage(e) {
  const raw = e?.message_raw ?? e?.message ?? null;
  if (!raw) return null;
  const params = e?.parameters && typeof e.parameters === 'object' ? e.parameters : {};
  return String(raw).replace(/\{([A-Za-z0-9_]+)\}/g, (match, key) => {
    const v = params[key];
    if (v == null) return match;
    if (typeof v === 'object') {
      const label = v.name || v.hostname || v.essid || v.ip || v.id || null;
      const ip = v.ip && v.ip !== label ? ` (${v.ip})` : '';
      return label ? `${label}${ip}` : match;
    }
    return String(v);
  });
}

async function fetchSystemLog(source, coreApi, site) {
  const d = await legacyV2Post(source, coreApi, site, '/system-log/all', { pageNumber: 0, pageSize: 200 });
  return safeArr(d?.data).map((e) => ({
    eventId: strOrNull(e.id),
    category: strOrNull(e.category),
    eventKey: strOrNull(e.key),
    eventType: strOrNull(e.event),
    message: strOrNull(renderLogMessage(e)),
    rawJson: jsonOrNull(e),
    occurredAt: occurredAtIso(e),
  }));
}

// ── Protect integration API (same X-API-KEY, /proxy/protect/integration/v1) ──
// Not every controller runs Protect — callers treat a failed/404 fetch as
// "Protect not present" and skip, never as a poll error.
const PROTECT_BASE = '/proxy/protect/integration/v1';

async function protectGet(source, coreApi, path) {
  const res = await apiRequest(source, coreApi, { method: 'GET', path: `${PROTECT_BASE}${path}` });
  return res.data;
}

async function fetchProtect(source, coreApi) {
  const info = await protectGet(source, coreApi, '/meta/info');
  const cameras = safeArr(await protectGet(source, coreApi, '/cameras')).map((c) => ({
    cameraId: strOrNull(c.id),
    modelKey: strOrNull(c.modelKey) || 'camera',
    name: strOrNull(c.name),
    mac: strOrNull(c.mac),
    state: strOrNull(c.state),
    isMicEnabled: boolToInt(c.isMicEnabled),
    videoMode: strOrNull(c.videoMode),
    hdrType: strOrNull(c.hdrType),
    smartDetectJson: jsonOrNull(c.smartDetectSettings?.objectTypes || c.featureFlags?.smartDetectTypes || null),
    hasPackageCamera: boolToInt(c.hasPackageCamera),
  }));
  let chimes = [];
  try {
    chimes = safeArr(await protectGet(source, coreApi, '/chimes')).map((c) => ({
      cameraId: strOrNull(c.id), modelKey: strOrNull(c.modelKey) || 'chime', name: strOrNull(c.name),
      mac: strOrNull(c.mac), state: strOrNull(c.state), isMicEnabled: null, videoMode: null,
      hdrType: null, smartDetectJson: null, hasPackageCamera: null,
    }));
  } catch { /* chimes endpoint optional */ }
  let nvr = null;
  try {
    const n = await protectGet(source, coreApi, '/nvrs');
    nvr = n ? {
      name: strOrNull(n.name),
      armMode: n.armMode || null,
      doorbell: n.doorbellSettings ? { defaultMessage: strOrNull(n.doorbellSettings.defaultMessageText) } : null,
    } : null;
  } catch { /* nvr endpoint optional */ }
  return {
    applicationVersion: strOrNull(info?.applicationVersion),
    cameras: cameras.concat(chimes),
    nvr,
  };
}

async function fetchCameraSnapshot(source, coreApi, cameraId) {
  const res = await apiRequest(source, coreApi, {
    method: 'GET',
    path: `${PROTECT_BASE}/cameras/${encodeURIComponent(cameraId)}/snapshot`,
    responseType: 'buffer',
  });
  return { contentType: res.headers['content-type'] || 'image/jpeg', body: res.data };
}

async function fetchTopology(source, coreApi, site) {
  const d = await legacyV2Get(source, coreApi, site, '/topology');
  return {
    vertices: safeArr(d?.vertices),
    edges: safeArr(d?.edges),
    hasUnknownSwitch: boolToInt(d?.has_unknown_switch),
  };
}

module.exports = {
  fetchInfo,
  fetchSites,
  testConnection,
  fetchDevices,
  fetchClients,
  fetchWlans,
  fetchNetworks,
  fetchRogueAps,
  fetchIpsSettings,
  fetchHealth,
  fetchSystemLog,
  fetchTopology,
  fetchProtect,
  fetchCameraSnapshot,
  fetchFirewallRules,
  fetchHourlyReport,
  // exported for reuse/testing
  numOrNull, strOrNull, boolToInt, jsonOrNull, occurredAtIso, errMsg,
};
