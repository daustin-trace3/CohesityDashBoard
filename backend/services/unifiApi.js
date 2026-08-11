// UniFi API client: Integration API (`/proxy/network/integration/v1`) for
// site discovery + testConnection, and the richer Legacy API
// (`/proxy/network/api/s/{site}/...` + `/proxy/network/v2/api/site/{site}/...`)
// for devices/ports/clients/wlans/networks/rogue APs/health/events/topology.
// Auth is a single `X-API-KEY` header on every request (no session/cookie
// dance). Every parser guards every field access — a malformed/missing field
// degrades to null rather than throwing (nutanixApi.js pattern).
const axios = require('axios');
const https = require('https');
const { decrypt } = require('./encryption');
const logger = require('../utils/logger');

// ── Credentials / client plumbing ───────────────────────────────────────────

function creds(source) {
  // Unsaved candidates (test connection) carry a plaintext apiKey; registered
  // rows carry the encrypted blob.
  if (source.apiKey != null) return { apiKey: source.apiKey };
  if (source.apikey != null) return { apiKey: source.apikey };
  if (!source.encrypted_credentials) return { apiKey: null };
  try {
    const c = JSON.parse(decrypt(source.encrypted_credentials));
    return { apiKey: c.apiKey };
  } catch {
    return { apiKey: null };
  }
}

function baseUrl(source) {
  const port = source.port || 443;
  return `https://${source.host}:${port}`;
}

function baseClient(source) {
  const { apiKey } = creds(source);
  return axios.create({
    baseURL: baseUrl(source),
    timeout: 30000,
    headers: apiKey ? { 'X-API-KEY': apiKey } : {},
    httpsAgent: new https.Agent({ rejectUnauthorized: !!source.ssl_verify }),
    validateStatus: (s) => s >= 200 && s < 300,
  });
}

const INTEGRATION_BASE = '/proxy/network/integration/v1';
const LEGACY_BASE = '/proxy/network/api';
const LEGACY_V2_BASE = '/proxy/network/v2/api';

async function integrationGet(source, path, params) {
  const client = baseClient(source);
  const res = await client.get(`${INTEGRATION_BASE}${path}`, { params });
  return res.data;
}
async function legacyGet(source, site, path, params) {
  const client = baseClient(source);
  const res = await client.get(`${LEGACY_BASE}/s/${site}${path}`, { params });
  return res.data;
}
async function legacyV2Get(source, site, path, params) {
  const client = baseClient(source);
  const res = await client.get(`${LEGACY_V2_BASE}/site/${site}${path}`, { params });
  return res.data;
}
async function legacyV2Post(source, site, path, data) {
  const client = baseClient(source);
  const res = await client.post(`${LEGACY_V2_BASE}/site/${site}${path}`, data);
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

async function fetchInfo(source) {
  const d = await integrationGet(source, '/info');
  return { applicationVersion: strOrNull(d?.applicationVersion) };
}

async function fetchSites(source) {
  const out = [];
  let offset = 0;
  const limit = 200;
  // Paginated per contract (offset/limit, limit max 200); guard against a
  // pathological server with a hard cap on iterations.
  for (let i = 0; i < 25; i++) {
    const d = await integrationGet(source, '/sites', { offset, limit });
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

async function testConnection(candidate) {
  try {
    const [sites, info] = await Promise.all([fetchSites(candidate), fetchInfo(candidate)]);
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
    };
  });
  return jsonOrNull(merged);
}

async function fetchDevices(source, site) {
  const d = await legacyGet(source, site, '/stat/device');
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

async function fetchClients(source, site) {
  const d = await legacyGet(source, site, '/stat/sta');
  return safeArr(d?.data).map(parseClient);
}

// ── Legacy API: WLANs, networks, rogue APs, IPS, health ─────────────────────

async function fetchWlans(source, site) {
  const d = await legacyGet(source, site, '/rest/wlanconf');
  return safeArr(d?.data).map((w) => ({
    wlanId: strOrNull(w._id),
    name: strOrNull(w.name),
    enabled: boolToInt(w.enabled),
    security: strOrNull(w.security),
    wpaMode: strOrNull(w.wpa_mode),
    isGuest: boolToInt(w.is_guest),
    hideSsid: boolToInt(w.hide_ssid),
  }));
}

async function fetchNetworks(source, site) {
  const d = await legacyGet(source, site, '/rest/networkconf');
  return safeArr(d?.data).map((n) => ({
    networkId: strOrNull(n._id),
    name: strOrNull(n.name),
    purpose: strOrNull(n.purpose),
    vlan: numOrNull(n.vlan),
    subnet: strOrNull(n.ip_subnet),
    enabled: boolToInt(n.enabled),
  }));
}

async function fetchRogueAps(source, site) {
  const d = await legacyGet(source, site, '/stat/rogueap');
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

async function fetchIpsSettings(source, site) {
  const d = await legacyGet(source, site, '/rest/setting/ips');
  const row = safeArr(d?.data)[0] || null;
  if (!row) return { enabled: false, categories: [], adBlocking: false, raw: null };
  const categories = safeArr(row.enabled_categories);
  const mode = strOrNull(row.ips_mode);
  const enabled = mode != null ? mode !== 'disabled' : categories.length > 0;
  return {
    enabled,
    categories,
    adBlocking: boolToInt(row.ad_blocking_enabled),
    raw: jsonOrNull(row),
  };
}

async function fetchHealth(source, site) {
  const d = await legacyGet(source, site, '/stat/health');
  return safeArr(d?.data);
}

async function fetchSystemLog(source, site) {
  const d = await legacyV2Post(source, site, '/system-log/all', { pageNumber: 0, pageSize: 200 });
  return safeArr(d?.data).map((e) => ({
    eventId: strOrNull(e.id),
    category: strOrNull(e.category),
    eventKey: strOrNull(e.key),
    eventType: strOrNull(e.event),
    message: strOrNull(e.message_raw),
    rawJson: jsonOrNull(e),
    occurredAt: occurredAtIso(e),
  }));
}

async function fetchTopology(source, site) {
  const d = await legacyV2Get(source, site, '/topology');
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
  // exported for reuse/testing
  numOrNull, strOrNull, boolToInt, jsonOrNull, occurredAtIso, errMsg,
};
