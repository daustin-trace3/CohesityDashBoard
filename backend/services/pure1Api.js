const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const axios = require('axios');
const logger = require('../utils/logger');
const { getSetting, setSetting } = require('./settings');
const { encrypt, decrypt } = require('./encryption');
const { isDemo } = require('./demoMode');
const demoFixtures = require('../demo/pure1Fixtures');

// Pure1 cloud REST client (fleet-wide, read-only).
//
// Auth: OAuth2 token-exchange. We sign a short JWT with the RSA private key
// whose PUBLIC half is registered against the Pure1 Application ID, exchange it
// at /oauth2/1.0/token for a Bearer access token, then call /api/1.latest/*.
//
// CRITICAL: the JWT header must NOT include a `kid` (Pure1 resolves the key
// from `iss`). Payload is only { iss, iat, exp }. Matches Pure's official
// pure_token_factory.py exactly.
//
// Configuration precedence: values saved via the Settings UI (app_settings,
// private key encrypted) take priority, falling back to PURE1_APIKEY /
// dashboard_private.pem so pre-existing env/file setups keep working.

const HOST = 'https://api.pure1.purestorage.com';
const API = '/api/1.latest';
const KEY_PATH = path.join(__dirname, '..', 'data', 'dashboard_private.pem');

const DEFAULT_CACHE_TTL_MIN = 10;
const DEFAULT_WARN_PCT = 75;
const DEFAULT_CRIT_PCT = 90;
const DEFAULT_POLL_INTERVAL_MIN = 15;

const CAPACITY_METRICS = [
  'array_total_capacity',
  'array_volume_space',
  'array_shared_space',
  'array_snapshot_space',
  'array_system_space',
  'array_replication_space',
  'array_data_reduction',
];

const PERF_METRICS = [
  'array_read_iops',
  'array_write_iops',
  'array_read_latency_us',
  'array_write_latency_us',
  'array_read_bandwidth',
  'array_write_bandwidth',
];

let tokenCache = null; // { token, expiresAt }
let overviewCache = null; // { data, fetchedAt }
let alertsCache = null;   // { data, fetchedAt }
let enrichmentCache = null; // { data, fetchedAt }

function base64url(input) {
  const buf = Buffer.isBuffer(input) ? input : Buffer.from(String(input));
  return buf.toString('base64').replace(/=+$/, '').replace(/\+/g, '-').replace(/\//g, '_');
}

// ── Configuration (DB settings with env/file fallback) ───────────────────────

/** Pure1 Application ID: stored setting first, else PURE1_APIKEY env. */
function getAppId() {
  return getSetting('pure1_app_id') || process.env.PURE1_APIKEY || '';
}

/** RSA private key PEM: encrypted DB setting first, else the on-disk key file. */
function getPrivateKey() {
  const stored = getSetting('pure1_private_key');
  if (stored) {
    try { return decrypt(stored); } catch { /* fall through to file */ }
  }
  if (fs.existsSync(KEY_PATH)) return fs.readFileSync(KEY_PATH, 'utf8');
  const err = new Error('No Pure1 private key configured');
  err.code = 'PURE1_NO_KEY';
  throw err;
}

function hasPrivateKey() {
  return !!getSetting('pure1_private_key') || fs.existsSync(KEY_PATH);
}

function keySource() {
  if (getSetting('pure1_private_key')) return 'settings';
  if (fs.existsSync(KEY_PATH)) return 'file';
  return 'none';
}

function cacheTtlMs() {
  const min = Number(getSetting('pure1_cache_ttl_min')) || DEFAULT_CACHE_TTL_MIN;
  return Math.max(1, min) * 60 * 1000;
}

/** True when Pure1 is configured (app id present + a private key available). */
function isConfigured() {
  if (isDemo()) return true;
  return !!getAppId() && hasPrivateKey();
}

/** Derive the public key (SPKI PEM) from the configured private key. */
function getPublicKey() {
  try {
    const priv = crypto.createPrivateKey(getPrivateKey());
    return crypto.createPublicKey(priv).export({ type: 'spki', format: 'pem' }).toString();
  } catch {
    return null;
  }
}

/** Clear cached token + fleet data (call after a settings change). */
function invalidate() {
  tokenCache = null;
  overviewCache = null;
  alertsCache = null;
  enrichmentCache = null;
}

/** Build the RS256-signed JWT assertion (no kid; iss/iat/exp only). */
function buildAssertion() {
  const appId = getAppId();
  const now = Math.floor(Date.now() / 1000);
  const header = { alg: 'RS256', typ: 'JWT' };
  const payload = { iss: appId, iat: now, exp: now + 3600 };
  const signingInput = `${base64url(JSON.stringify(header))}.${base64url(JSON.stringify(payload))}`;
  const signer = crypto.createSign('RSA-SHA256');
  signer.update(signingInput);
  signer.end();
  return `${signingInput}.${base64url(signer.sign(getPrivateKey()))}`;
}

/** Exchange the JWT for a Bearer access token (cached until shortly before expiry). */
async function getAccessToken({ force = false } = {}) {
  if (!force && tokenCache && Date.now() < tokenCache.expiresAt) return tokenCache.token;
  if (!isConfigured()) {
    const err = new Error('Pure1 is not configured (missing app ID or private key)');
    err.code = 'PURE1_NOT_CONFIGURED';
    throw err;
  }
  const body = new URLSearchParams({
    grant_type: 'urn:ietf:params:oauth:grant-type:token-exchange',
    subject_token_type: 'urn:ietf:params:oauth:token-type:jwt',
    subject_token: buildAssertion(),
  });
  const { data } = await axios.post(`${HOST}/oauth2/1.0/token`, body.toString(), {
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      accept: 'application/json',
      'x-request-id': crypto.randomUUID(),
    },
    timeout: 30000,
  });
  const token = data.access_token || (data.items && data.items[0] && data.items[0].access_token);
  if (!token) throw new Error('Pure1 token exchange returned no access_token');
  // Access tokens are JWTs; cache until ~1 min before their exp.
  let expiresAt = Date.now() + 9 * 60 * 1000;
  try {
    const claims = JSON.parse(Buffer.from(token.split('.')[1], 'base64').toString('utf8'));
    if (claims.exp) expiresAt = claims.exp * 1000 - 60 * 1000;
  } catch { /* keep default */ }
  tokenCache = { token, expiresAt };
  return token;
}

/** Authenticated GET against the Pure1 API (one auto-retry on 401). */
async function apiGet(pathStr, params, { retry = true } = {}) {
  const token = await getAccessToken();
  try {
    const { data } = await axios.get(`${HOST}${API}${pathStr}`, {
      headers: { Authorization: `Bearer ${token}`, 'x-request-id': crypto.randomUUID() },
      params,
      timeout: 30000,
    });
    return data;
  } catch (err) {
    if (retry && err.response && err.response.status === 401) {
      await getAccessToken({ force: true });
      return apiGet(pathStr, params, { retry: false });
    }
    throw err;
  }
}

const quoteList = (arr) => arr.map((v) => `'${v}'`).join(',');

/** All arrays in the Pure1 fleet. */
async function fetchArrays() {
  const out = [];
  let offset = 0;
  for (;;) {
    const data = await apiGet('/arrays', { limit: 1000, offset });
    const items = data.items || [];
    out.push(...items);
    if (items.length < 1000) break;
    offset += 1000;
  }
  return out;
}

/**
 * Latest capacity datapoint per array. Returns a map keyed by array id:
 * { total, used, dataReduction, volumeSpace, sharedSpace, snapshotSpace,
 *   systemSpace, replicationSpace, capturedAt }.
 * ids are chunked to keep each metrics/history request small.
 */
async function fetchLatestCapacity(ids) {
  const result = new Map();
  const end = Date.now();
  const start = end - 4 * 24 * 3600 * 1000; // a few daily points; we keep the latest
  // Pure1 caps (metrics × resources) at 32 per request. With 7 metrics that
  // means at most 4 arrays per call.
  const CHUNK = 4;
  for (let i = 0; i < ids.length; i += CHUNK) {
    const chunk = ids.slice(i, i + CHUNK);
    let data;
    try {
      data = await apiGet('/metrics/history', {
        names: quoteList(CAPACITY_METRICS),
        resource_ids: quoteList(chunk),
        aggregation: quoteList(['avg']),
        resolution: 86400000,
        start_time: start,
        end_time: end,
      });
    } catch (err) {
      logger.error(`[Pure1] capacity history chunk failed: ${err.response && err.response.status} ${err.message}`);
      continue;
    }
    for (const series of data.items || []) {
      const res = (series.resources && series.resources[0]) || {};
      const arrId = res.id;
      if (!arrId) continue;
      const points = series.data || [];
      const last = points[points.length - 1];
      if (!last) continue;
      const [ts, value] = last;
      const entry = result.get(arrId) || { capturedAt: null };
      entry.capturedAt = Math.max(entry.capturedAt || 0, ts || 0);
      switch (series.name) {
        case 'array_total_capacity': entry.total = value; break;
        case 'array_volume_space': entry.volumeSpace = value; break;
        case 'array_shared_space': entry.sharedSpace = value; break;
        case 'array_snapshot_space': entry.snapshotSpace = value; break;
        case 'array_system_space': entry.systemSpace = value; break;
        case 'array_replication_space': entry.replicationSpace = value; break;
        case 'array_data_reduction': entry.dataReduction = value; break;
        default: break;
      }
      result.set(arrId, entry);
    }
  }
  // Physical used = volume + shared + snapshot + system + replication.
  for (const entry of result.values()) {
    entry.used = (entry.volumeSpace || 0) + (entry.sharedSpace || 0)
      + (entry.snapshotSpace || 0) + (entry.systemSpace || 0) + (entry.replicationSpace || 0);
  }
  return result;
}

/** Open (not-closed) fleet alerts, most severe first. */
async function fetchOpenAlerts(limit = 200) {
  const data = await apiGet('/alerts', {
    filter: "state='open'",
    sort: 'updated-',
    limit,
  });
  return (data.items || []).map((a) => ({
    id: a.id,
    arrayName: (a.arrays && a.arrays[0] && a.arrays[0].name) || null,
    arrayFqdn: (a.arrays && a.arrays[0] && a.arrays[0].fqdn) || null,
    severity: a.severity,
    category: a.category,
    component: a.component_name,
    componentType: a.component_type,
    summary: a.summary,
    code: a.code,
    state: a.state,
    created: a.created,
    updated: a.updated,
    knowledgeBaseUrl: a.knowledge_base_url,
  }));
}

/** User-defined array tags from Pure1, grouped by array id. */
async function fetchTags() {
  const items = [];
  let offset = 0;
  for (;;) {
    const data = await apiGet('/arrays/tags', { limit: 1000, offset });
    const page = data.items || [];
    items.push(...page);
    if (page.length < 1000) break;
    offset += 1000;
  }
  const map = new Map();
  for (const t of items) {
    const id = t.resource && t.resource.id;
    if (!id) continue;
    if (!map.has(id)) map.set(id, []);
    map.get(id).push({ key: t.key, value: t.value, namespace: t.namespace });
  }
  return map;
}

// Statuses that mean "fine" (empty slots / not-installed are not faults).
const HEALTHY_STATUSES = new Set(['ok', 'healthy', 'not_installed', 'unused', 'unknown', 'normal', '']);

/**
 * Fleet-wide health rollup + provisioned totals + serials.
 * One paginated pass each over hardware, drives and volumes, grouped by array.
 * Returns { [arrayId]: { health, unhealthy, provisioned, chassisSerial, controllerSerials } }.
 */
async function fetchEnrichment() {
  const [hardware, drives, volumes] = await Promise.all([
    fetchAllForArray('/hardware', null),
    fetchAllForArray('/drives', null),
    fetchAllForArray('/volumes', null),
  ]);
  const arrId = (item) => item.arrays && item.arrays[0] && item.arrays[0].id;
  const byArray = new Map();
  const ensure = (id) => { if (!byArray.has(id)) byArray.set(id, { statuses: [], provisioned: 0, chassisSerial: null, controllers: [] }); return byArray.get(id); };
  for (const h of hardware) {
    const id = arrId(h); if (!id) continue;
    const e = ensure(id);
    e.statuses.push(h.status);
    const type = String(h.type || '').toLowerCase();
    if (h.serial) {
      if (type === 'chassis' && !e.chassisSerial) e.chassisSerial = h.serial;
      else if (type === 'controller') e.controllers.push({ name: h.name, serial: h.serial });
    }
  }
  for (const d of drives) { const id = arrId(d); if (id) ensure(id).statuses.push(d.status); }
  for (const v of volumes) { if (v.destroyed || v.eradicated) continue; const id = arrId(v); if (id) ensure(id).provisioned += (v.provisioned || 0); }

  const out = {};
  for (const [id, info] of byArray) {
    let health = 'ok';
    let unhealthy = 0;
    for (const s of info.statuses) {
      const v = String(s || '').toLowerCase();
      if (HEALTHY_STATUSES.has(v)) continue;
      unhealthy += 1;
      if (['critical', 'failed', 'unhealthy', 'fault', 'error'].includes(v)) health = 'crit';
      else if (health !== 'crit') health = 'warn';
    }
    const controllerSerials = info.controllers
      .sort((a, b) => String(a.name).localeCompare(String(b.name)))
      .map((c) => c.serial);
    out[id] = { health, unhealthy, provisioned: info.provisioned, chassisSerial: info.chassisSerial, controllerSerials };
  }
  return out;
}

/** Cached fleet enrichment (health + provisioned). */
async function getEnrichment({ force = false } = {}) {
  if (isDemo()) return demoFixtures.getEnrichment();
  if (!force && enrichmentCache && (Date.now() - enrichmentCache.fetchedAt) < cacheTtlMs()) {
    return enrichmentCache.data;
  }
  const data = await fetchEnrichment();
  enrichmentCache = { data, fetchedAt: Date.now() };
  return data;
}

/** Merged fleet overview (arrays + latest capacity), cached per settings TTL. */
async function getOverview({ force = false } = {}) {
  if (isDemo()) return demoFixtures.getOverview();
  if (!force && overviewCache && (Date.now() - overviewCache.fetchedAt) < cacheTtlMs()) {
    return overviewCache.data;
  }
  const arrays = await fetchArrays();
  const [capacity, tagMap] = await Promise.all([
    fetchLatestCapacity(arrays.map((a) => a.id)),
    fetchTags().catch(() => new Map()),
  ]);
  const rows = arrays.map((a) => {
    const cap = capacity.get(a.id) || {};
    const total = cap.total || 0;
    const used = cap.used || 0;
    return {
      id: a.id,
      name: a.name,
      fqdn: a.fqdn,
      model: a.model,
      os: a.os,
      version: a.version,
      total,
      used,
      pctUsed: total > 0 ? (used / total) * 100 : null,
      dataReduction: cap.dataReduction || null,
      effectiveUsed: cap.dataReduction ? used * cap.dataReduction : null,
      volumeSpace: cap.volumeSpace || 0,
      snapshotSpace: cap.snapshotSpace || 0,
      sharedSpace: cap.sharedSpace || 0,
      capturedAt: cap.capturedAt || null,
      tags: tagMap.get(a.id) || [],
    };
  }).sort((a, b) => a.name.localeCompare(b.name));
  overviewCache = { data: rows, fetchedAt: Date.now() };
  return rows;
}

/** Open fleet alerts, cached per settings TTL. */
async function getAlerts({ force = false } = {}) {
  if (isDemo()) return demoFixtures.getAlerts();
  if (!force && alertsCache && (Date.now() - alertsCache.fetchedAt) < cacheTtlMs()) {
    return alertsCache.data;
  }
  const data = await fetchOpenAlerts();
  alertsCache = { data, fetchedAt: Date.now() };
  return data;
}

function lastRefresh() {
  return {
    overview: overviewCache ? overviewCache.fetchedAt : null,
    alerts: alertsCache ? alertsCache.fetchedAt : null,
  };
}

/** Display prefs safe to expose broadly (no secrets) — used by /status. */
function getDisplayPrefs() {
  return {
    warnPct: Number(getSetting('pure1_warn_pct')) || DEFAULT_WARN_PCT,
    critPct: Number(getSetting('pure1_crit_pct')) || DEFAULT_CRIT_PCT,
    showHiddenAlerts: getSetting('pure1_show_hidden_alerts') === '1',
  };
}

// ── Settings (Pure-only config surfaced by the Settings page) ─────────────────

function maskAppId(id) {
  if (!id) return '';
  const tail = id.slice(-4);
  return `${id.split(':').slice(0, 2).join(':')}:…${tail}`;
}

/** Non-secret view of the current Pure1 configuration for the Settings UI. */
function getConfig() {
  const appId = getAppId();
  return {
    configured: isConfigured(),
    appIdSet: !!appId,
    // Full app id is never returned — the masked form is enough to verify
    // which key is in use without exposing it.
    appIdMasked: maskAppId(appId),
    appIdSource: getSetting('pure1_app_id') ? 'settings' : (process.env.PURE1_APIKEY ? 'env' : 'none'),
    hasPrivateKey: hasPrivateKey(),
    keySource: keySource(),
    publicKey: getPublicKey(),
    cacheTtlMin: Number(getSetting('pure1_cache_ttl_min')) || DEFAULT_CACHE_TTL_MIN,
    warnPct: Number(getSetting('pure1_warn_pct')) || DEFAULT_WARN_PCT,
    critPct: Number(getSetting('pure1_crit_pct')) || DEFAULT_CRIT_PCT,
    showHiddenAlerts: getSetting('pure1_show_hidden_alerts') === '1',
    pollIntervalMinutes: Number(getSetting('pure1_poll_interval_minutes')) || DEFAULT_POLL_INTERVAL_MIN,
    lastRefresh: lastRefresh(),
  };
}

/** Persist config changes. Private key is encrypted at rest. */
function setConfig(patch = {}) {
  if (patch.appId != null) setSetting('pure1_app_id', String(patch.appId).trim());
  if (patch.privateKey) {
    const pem = String(patch.privateKey).trim();
    if (!/-----BEGIN [A-Z ]*PRIVATE KEY-----/.test(pem)) {
      const err = new Error('Private key must be a PEM (BEGIN PRIVATE KEY) block');
      err.status = 400;
      throw err;
    }
    // Validate it parses as a key before storing.
    crypto.createPrivateKey(pem);
    setSetting('pure1_private_key', encrypt(pem));
  }
  if (patch.cacheTtlMin != null) {
    const n = Math.min(120, Math.max(1, Number(patch.cacheTtlMin) || DEFAULT_CACHE_TTL_MIN));
    setSetting('pure1_cache_ttl_min', String(n));
  }
  if (patch.warnPct != null) setSetting('pure1_warn_pct', String(Math.min(100, Math.max(1, Number(patch.warnPct) || DEFAULT_WARN_PCT))));
  if (patch.critPct != null) setSetting('pure1_crit_pct', String(Math.min(100, Math.max(1, Number(patch.critPct) || DEFAULT_CRIT_PCT))));
  if (patch.showHiddenAlerts != null) setSetting('pure1_show_hidden_alerts', patch.showHiddenAlerts ? '1' : '0');
  if (patch.pollIntervalMinutes != null) {
    const n = Math.min(1440, Math.max(5, Number(patch.pollIntervalMinutes) || DEFAULT_POLL_INTERVAL_MIN));
    setSetting('pure1_poll_interval_minutes', String(n));
  }
  invalidate();
  return getConfig();
}

/** Validate connectivity with the current (or a candidate) configuration. */
async function testConnection() {
  invalidate();
  const token = await getAccessToken({ force: true });
  const { data } = await axios.get(`${HOST}${API}/arrays`, {
    headers: { Authorization: `Bearer ${token}`, 'x-request-id': crypto.randomUUID() },
    params: { limit: 1 }, timeout: 30000,
  });
  return { ok: true, arrayCount: data.total_item_count || 0 };
}

// ── Per-array resources ──────────────────────────────────────────────────────

/** Page through a list endpoint (optionally filtered to one array). */
async function fetchAllForArray(pathStr, arrayId, extraParams = {}) {
  const out = [];
  let offset = 0;
  for (;;) {
    const params = { limit: 1000, offset, ...extraParams };
    if (arrayId) params.filter = `arrays[any].id='${arrayId}'`;
    const data = await apiGet(pathStr, params);
    const items = data.items || [];
    out.push(...items);
    if (items.length < 1000) break;
    offset += 1000;
  }
  return out;
}

/** Volumes on an array (newest first, tombstones excluded). */
async function fetchVolumes(arrayId) {
  if (isDemo()) return demoFixtures.fetchVolumes(arrayId);
  const items = await fetchAllForArray('/volumes', arrayId);
  return items
    .filter((v) => !v.destroyed && !v.eradicated)
    .map((v) => ({
      id: v.id,
      name: v.name,
      provisioned: v.provisioned,
      serial: v.serial,
      pod: v.pod && v.pod.name ? v.pod.name : (typeof v.pod === 'string' ? v.pod : null),
      source: v.source && v.source.name ? v.source.name : null,
      created: v.created,
    }))
    .sort((a, b) => (b.provisioned || 0) - (a.provisioned || 0));
}

/** Stretched pods across the fleet (ActiveCluster replication topology). */
async function fetchPods() {
  if (isDemo()) return demoFixtures.fetchPods();
  const items = await fetchAllForArray('/pods', null);
  return items.map((p) => ({
    id: p.id,
    name: p.name,
    mediator: p.mediator,
    arrays: (p.arrays || []).map((a) => ({
      id: a.id, name: a.name, status: a.status, mediatorStatus: a.mediator_status, frozenAt: a.frozen_at,
    })),
  })).sort((a, b) => a.name.localeCompare(b.name));
}

/** Hardware components + controllers + drives for one array. */
async function fetchHardware(arrayId) {
  if (isDemo()) return demoFixtures.fetchHardware(arrayId);
  const [hardware, controllers, drives] = await Promise.all([
    fetchAllForArray('/hardware', arrayId),
    fetchAllForArray('/controllers', arrayId),
    fetchAllForArray('/drives', arrayId),
  ]);
  // The /controllers endpoint carries no serial; the matching hardware
  // component (type 'controller', e.g. CT0) does — merge it in by name.
  const ctrlSerial = new Map();
  for (const h of hardware) {
    if (String(h.type).toLowerCase() === 'controller' && h.name) ctrlSerial.set(h.name, h.serial || null);
  }
  return {
    controllers: controllers.map((c) => ({
      id: c.id, name: c.name, mode: c.mode, model: c.model, status: c.status, type: c.type, version: c.version,
      serial: ctrlSerial.get(c.name) || null,
    })).sort((a, b) => String(a.name).localeCompare(String(b.name))),
    components: hardware.map((h) => ({
      id: h.id, name: h.name, type: h.type, model: h.model, serial: h.serial, slot: h.slot,
      status: h.status, speed: h.speed, temperature: h.temperature, voltage: h.voltage,
    })).sort((a, b) => String(a.name).localeCompare(String(b.name))),
    drives: drives.map((d) => ({
      id: d.id, name: d.name, capacity: d.capacity, protocol: d.protocol, status: d.status, type: d.type,
    })).sort((a, b) => String(a.name).localeCompare(String(b.name))),
  };
}

/** Network interfaces + ports for one array. */
async function fetchConnectivity(arrayId) {
  if (isDemo()) return demoFixtures.fetchConnectivity(arrayId);
  const [nics, ports] = await Promise.all([
    fetchAllForArray('/network-interfaces', arrayId),
    fetchAllForArray('/ports', arrayId),
  ]);
  return {
    interfaces: nics.map((n) => ({
      id: n.id, name: n.name, address: n.address, netmask: n.netmask, gateway: n.gateway,
      mac: n.hwaddr, mtu: n.mtu, speed: n.speed, enabled: n.enabled,
      services: Array.isArray(n.services) ? n.services.join(', ') : n.services,
    })).sort((a, b) => String(a.name).localeCompare(String(b.name))),
    ports: ports.map((p) => ({
      id: p.id, name: p.name, wwn: p.wwn, iqn: p.iqn, nqn: p.nqn, portal: p.portal, failover: p.failover,
    })).sort((a, b) => String(a.name).localeCompare(String(b.name))),
  };
}

// ── Metric history (for charts) ──────────────────────────────────────────────

/** Choose a resolution that keeps a request under ~300 points per series. */
function resolutionForDays(days) {
  if (days <= 1) return 300000;       // 5 min
  if (days <= 7) return 3600000;      // 1 hour
  if (days <= 35) return 86400000;    // 1 day
  return 86400000;
}

/**
 * Metric history for a single array. Returns { start, end, resolution, series }
 * where series is a map { metricName: [[ts, value], ...] }.
 */
async function fetchMetricsHistory(arrayId, names, { days = 30, resolution } = {}) {
  const end = Date.now();
  const start = end - days * 24 * 3600 * 1000;
  const res = resolution || resolutionForDays(days);
  const data = await apiGet('/metrics/history', {
    names: quoteList(names),
    resource_ids: quoteList([arrayId]),
    aggregation: quoteList(['avg']),
    resolution: res,
    start_time: start,
    end_time: end,
  });
  const series = {};
  for (const item of data.items || []) {
    series[item.name] = item.data || [];
  }
  return { start, end, resolution: res, series };
}

/** Capacity trend for one array (daily). */
async function fetchCapacityHistory(arrayId, days = 30) {
  if (isDemo()) return demoFixtures.fetchCapacityHistory(arrayId, days);
  const { series, ...meta } = await fetchMetricsHistory(arrayId, CAPACITY_METRICS, { days, resolution: 86400000 });
  return { ...meta, series };
}

/** Performance trend for one array (iops/latency/bandwidth). */
async function fetchPerformanceHistory(arrayId, days = 1) {
  if (isDemo()) return demoFixtures.fetchPerformanceHistory(arrayId, days);
  return fetchMetricsHistory(arrayId, PERF_METRICS, { days });
}

module.exports = {
  isConfigured,
  getAccessToken,
  fetchArrays,
  fetchLatestCapacity,
  fetchOpenAlerts,
  getOverview,
  getAlerts,
  lastRefresh,
  fetchVolumes,
  fetchPods,
  fetchHardware,
  fetchConnectivity,
  fetchCapacityHistory,
  fetchPerformanceHistory,
  getConfig,
  setConfig,
  testConnection,
  invalidate,
  getDisplayPrefs,
  getEnrichment,
};
