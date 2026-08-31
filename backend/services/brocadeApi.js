// Brocade SANnav Management Portal REST API client (contract §2/§4, ground
// truth in the scratchpad NOTES files). Session-based auth: login sends
// username/password as HEADERS, gets back a sessionId, which is then sent
// RAW (no Bearer/Basic prefix) in the Authorization header on every
// subsequent call. Sessions are cached per source id in-memory and
// re-authenticated once on a 401. Every parser is tolerant: docs disagree
// with reality on live appliances, numbers may arrive as strings, envelope
// casing varies per endpoint — never throw on a malformed/missing field.
const axios = require('axios');
const https = require('https');
const { decrypt } = require('./encryption');
const logger = require('../utils/logger');

// ── Credentials / client plumbing ───────────────────────────────────────────

function creds(source) {
  // Unsaved candidates (test connection) may carry a plaintext password;
  // registered rows carry password_enc.
  if (source.password != null) return { username: source.username, password: source.password };
  if (!source.password_enc) return { username: source.username, password: null };
  try {
    return { username: source.username, password: decrypt(source.password_enc) };
  } catch {
    return { username: source.username, password: null };
  }
}

function baseUrl(source) {
  const port = source.port || 443;
  return `https://${source.host}:${port}`;
}

function httpClient(source, timeout) {
  return axios.create({
    baseURL: baseUrl(source),
    timeout,
    httpsAgent: new https.Agent({ rejectUnauthorized: !!source.verify_ssl }),
    validateStatus: () => true,
    // SANnav 415s requests without an explicit JSON Content-Type — even the
    // body-less login POST (live finding 2026-08-31; the doc samples carry
    // Content-Type on every call).
    headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
  });
}

// sourceId -> sessionId (in-memory; best-effort logout on poller shutdown).
const sessionCache = new Map();

function errMsg(err) {
  if (err?.response) {
    const d = err.response.data;
    const msg = (d && (d.errorMessage || d.message || d.detailedErrorMessage)) || null;
    return `HTTP ${err.response.status}${msg ? `: ${msg}` : ''}`;
  }
  return err?.message || String(err);
}

async function login(source, timeout = 60000) {
  const { username, password } = creds(source);
  const client = httpClient(source, timeout);
  // Empty-object body (not null): axios strips Content-Type from body-less
  // POSTs, and SANnav rejects those with 415.
  const res = await client.post('/external-api/v1/login/', {}, {
    headers: { username: username || '', password: password || '' },
  });
  if (res.status !== 200 || !res.data?.sessionId) {
    const err = new Error(`login failed: HTTP ${res.status}`);
    err.response = res;
    throw err;
  }
  sessionCache.set(source.id, res.data.sessionId);
  return res.data.sessionId;
}

/**
 * Performs an authenticated request. Caches the session per source id;
 * re-logs-in once on a 401 and retries. `source.id` is required to cache —
 * unsaved test candidates (no id) log in fresh every call.
 */
async function authedRequest(source, { method = 'GET', path, params, data, headers, timeout = 60000 } = {}) {
  const client = httpClient(source, timeout);
  let sessionId = source.id != null ? sessionCache.get(source.id) : null;
  if (!sessionId) sessionId = await login(source, timeout);

  const doRequest = (sid) => client.request({
    method, url: path, params, data,
    headers: { Authorization: sid, ...(headers || {}) },
  });

  let res = await doRequest(sessionId);
  if (res.status === 401) {
    sessionId = await login(source, timeout);
    res = await doRequest(sessionId);
  }
  if (res.status < 200 || res.status >= 300) {
    const err = new Error(`HTTP ${res.status}`);
    err.response = res;
    throw err;
  }
  return res.data;
}

async function logout(source) {
  const sessionId = source.id != null ? sessionCache.get(source.id) : null;
  if (!sessionId) return;
  try {
    const client = httpClient(source, 10000);
    await client.post('/external-api/v1/logout/', {}, { headers: { Authorization: sessionId } });
  } catch { /* best-effort */ }
  if (source.id != null) sessionCache.delete(source.id);
}

// ── Tolerant parsing helpers ────────────────────────────────────────────────

/** Tries multiple candidate keys (envelope casing varies per endpoint) and
 *  returns the first array found, else []. */
function pick(obj, ...keys) {
  if (!obj || typeof obj !== 'object') return [];
  for (const k of keys) {
    if (Array.isArray(obj[k])) return obj[k];
  }
  return [];
}

function numOrNull(v) {
  if (v == null || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function strOrNull(v) {
  if (v == null) return null;
  const s = String(v).trim();
  return s === '' ? null : s;
}

function jsonOrNull(v) {
  if (v == null) return null;
  try { return JSON.stringify(v); } catch { return null; }
}

const safeArr = (v) => (Array.isArray(v) ? v : []);

// ── About / testConnection ──────────────────────────────────────────────────

async function fetchAbout(source, timeout) {
  const d = await authedRequest(source, { path: '/external-api/v1/about/', timeout });
  return {
    version: strOrNull(d?.version),
    build: strOrNull(d?.build),
    generatedOn: strOrNull(d?.generatedOn),
    productBrandName: strOrNull(d?.productBrandName),
    oemName: strOrNull(d?.oemName),
  };
}

async function testConnection(candidate) {
  // Login is the actual connection test. /about/ only exists on SANnav 2.3.1+
  // (live finding: a pre-2.3.1 server 404s it after a perfectly good login),
  // so treat the version lookup as best-effort decoration, never a failure.
  try {
    await login(candidate, 15000);
  } catch (err) {
    return { ok: false, error: errMsg(err) };
  }
  try {
    const about = await fetchAbout(candidate, 15000);
    return { ok: true, version: about.version, oemName: about.oemName };
  } catch (err) {
    return {
      ok: true,
      version: null,
      oemName: null,
      note: `login ok; /about/ unavailable (${errMsg(err)}) — SANnav older than 2.3.1?`,
    };
  }
}

// ── Inventory: fabrics (no pagination) ──────────────────────────────────────

function parseFabric(f) {
  const add = f.additionalAttributes || {};
  return {
    sannavId: numOrNull(f.id),
    guid: strOrNull(add.guid ?? f.guid),
    name: strOrNull(f.name),
    principalSwitchWwn: strOrNull(f.principalSwitchWwn),
    seedSwitchWwn: strOrNull(f.seedSwitchWwn),
    seedSwitchIp: strOrNull(f.seedSwitchIpAddress),
    seedSwitchName: strOrNull(f.seedSwitchName),
    seedSwitchFirmware: strOrNull(f.seedSwitchFirmwareVersion),
    status: numOrNull(f.status),
    health: strOrNull(f.health),
    switchCount: numOrNull(f.switchCount),
    activeZonesetName: strOrNull(f.activeZonesetName),
    managed: numOrNull(f.managed),
    virtualFabricId: numOrNull(f.virtualFabricId),
    managementState: numOrNull(add.managementState),
    lastFabricChanged: strOrNull(f.lastFabricChanged),
    rawJson: jsonOrNull(f),
  };
}

async function fetchFabrics(source, timeout) {
  const d = await authedRequest(source, {
    path: '/external-api/v1/inventory/fabrics/', params: { basicOnly: 0 }, timeout,
  });
  return pick(d, 'fabrics', 'Fabrics').map(parseFabric);
}

// ── Inventory: switches (paginated, lowercase scope/value) ─────────────────

function parseSwitch(s) {
  const add = s.additionalAttributes || {};
  return {
    sannavId: numOrNull(s.id),
    wwn: strOrNull(s.wwn),
    name: strOrNull(s.name),
    physicalSwitchWwn: strOrNull(s.physicalSwitchWwn),
    ipAddress: strOrNull(s.ipAddress),
    model: strOrNull(s.model),
    modelNumber: strOrNull(s.modelNumber),
    firmwareVersion: strOrNull(s.firmwareVersion),
    serialNumber: strOrNull(s.switchSerialNumber),
    fabricName: strOrNull(s.fabricName),
    principalSwitchWwn: strOrNull(s.principalSwitchWwn),
    domainId: numOrNull(s.domainId),
    role: strOrNull(s.role),
    state: strOrNull(s.state),
    status: strOrNull(s.status),
    operationalStatus: strOrNull(s.operationalStatus),
    health: strOrNull(s.health),
    statusReason: strOrNull(s.statusReason),
    isMissing: numOrNull(s.missing) ? 1 : 0,
    monitored: numOrNull(s.monitored),
    discoveredPortCount: numOrNull(s.discoveredPortCount),
    maxPort: numOrNull(s.maxPort),
    switchMode: numOrNull(s.switchMode),
    managementState: numOrNull(add.managementState),
    eosStatus: numOrNull(add.eosStatus),
    maintenanceMode: numOrNull(add.maintenanceMode),
    tlsCertExpiryMs: numOrNull(s.tlsCertExpiryDate),
    trufosStatus: numOrNull(s.truFosStatus),
    virtualFabricId: numOrNull(s.virtualFabricId),
    chassisType: numOrNull(add.chassisType),
    vendor: strOrNull(add.vendor),
    rawJson: jsonOrNull(s),
  };
}

async function paginatedFetch(source, { path, params, arrayKeys, timeout, numOfRecords = 1000 }) {
  const out = [];
  let startIndex = 0;
  for (let i = 0; i < 500; i++) {
    const d = await authedRequest(source, {
      path, params: { ...params, startIndex, numOfRecords }, timeout,
    });
    const rows = pick(d, ...arrayKeys);
    out.push(...rows);
    const notReturned = numOrNull(d?.numOfEntitiesNotReturned) || 0;
    const nextIndex = numOrNull(d?.startIndexToUse);
    if (!notReturned || nextIndex == null || nextIndex === startIndex) break;
    startIndex = nextIndex;
  }
  return out;
}

async function fetchSwitches(source, timeout) {
  const raw = await paginatedFetch(source, {
    path: '/external-api/v1/inventory/switches/', params: { basicOnly: 1 },
    arrayKeys: ['switches'], timeout,
  });
  return raw.map(parseSwitch);
}

// ── Inventory: switch ports (paginated, capital Scope/Value) ───────────────

function parseSwitchPort(p) {
  return {
    sannavId: numOrNull(p.id),
    wwn: strOrNull(p.wwn),
    switchWwn: strOrNull(p.physicalSwitchWwn ?? p.virtualSwitchWwn),
    switchName: strOrNull(p.switchName),
    name: strOrNull(p.name),
    slotNumber: numOrNull(p.slotNumber),
    portNumber: numOrNull(p.portNumber),
    portIndex: numOrNull(p.portIndex),
    portId: strOrNull(p.portId),
    type: strOrNull(p.type),
    state: strOrNull(p.state),
    status: strOrNull(p.status),
    health: strOrNull(p.health),
    calculatedStatus: strOrNull(p.calculatedStatus),
    statusMessage: strOrNull(p.statusMessage),
    speed: strOrNull(p.speed),
    speedType: numOrNull(p.speedType),
    maxPortSpeed: numOrNull(p.maxPortSpeed),
    remoteDevice: strOrNull(p.remoteDevice),
    remotePortWwn: strOrNull(p.remotePortWwn),
    remoteNodeWwn: strOrNull(p.remoteNodeWwn),
    connectedDeviceType: strOrNull(p.connectedDeviceType),
    trunked: numOrNull(p.trunked),
    trunkMaster: numOrNull(p.trunkMaster),
    fenced: numOrNull(p.fenced),
    blocked: numOrNull(p.blocked),
    persistentDisable: numOrNull(p.persistentDisable),
    isMissing: numOrNull(p.missing) ? 1 : 0,
    monitored: numOrNull(p.monitored),
    occupied: numOrNull(p.occupied),
    licensed: numOrNull(p.licensed),
    lastUpdateMs: numOrNull(p.lastUpdate),
    activeZoneCount: numOrNull(p.activeZoneCount),
    zoneAlias: strOrNull(p.zoneAlias),
    fabricName: strOrNull(p.fabricName),
    virtualFabricId: numOrNull(p.virtualFabricId),
  };
}

async function fetchSwitchPorts(source, timeout) {
  const raw = await paginatedFetch(source, {
    path: '/external-api/v1/inventory/switchports/', params: { basicOnly: 1 },
    arrayKeys: ['switchPorts'], timeout,
  });
  return raw.map(parseSwitchPort);
}

// ── Inventory: device ports (paginated, capital DevicePorts key) ───────────

function parseDevicePort(p) {
  return {
    sannavId: numOrNull(p.id),
    wwn: strOrNull(p.wwn),
    deviceNodeWwn: strOrNull(p.deviceNodeWwn),
    symbolicName: strOrNull(p.symbolicName),
    deviceSymbolicName: strOrNull(p.deviceSymbolicName),
    vendor: strOrNull(p.vendor),
    portRole: strOrNull(p.portRole),
    type: strOrNull(p.type),
    fabricName: strOrNull(p.fabricName),
    switchWwn: strOrNull(p.switchWwn),
    switchName: strOrNull(p.switchName),
    switchPortWwn: strOrNull(p.switchPortWwn),
    switchPortName: strOrNull(p.switchPortName),
    slotNumber: numOrNull(p.slotNumber),
    portNumber: numOrNull(p.portNumber ?? p.number),
    portId: strOrNull(p.portId),
    enclosureId: numOrNull(p.deviceEnclosureId),
    enclosureGuid: strOrNull(p.deviceEnclosureGuid),
    enclosureName: strOrNull(p.deviceEnclosureName),
    fdmiHostName: strOrNull(p.fdmiHostName),
    activeZones: jsonOrNull(safeArr(p.activeZones)),
    activeZoneCount: numOrNull(p.activeZoneCount),
    activeZonesetName: strOrNull(p.activeZonesetName),
    zoneAlias: strOrNull(p.zoneAlias),
    isMissing: numOrNull(p.missing) ? 1 : 0,
    speed: strOrNull(p.speed),
  };
}

async function fetchDevicePorts(source, timeout) {
  const raw = await paginatedFetch(source, {
    path: '/external-api/v1/inventory/deviceports/', params: { basicOnly: 1 },
    arrayKeys: ['DevicePorts', 'devicePorts'], timeout,
  });
  return raw.map(parseDevicePort);
}

// ── Inventory: enclosures (paginated, capital Enclosures key, basicOnly=0) ─

function parseEnclosure(e) {
  return {
    sannavId: numOrNull(e.id),
    guid: strOrNull(e.guid),
    name: strOrNull(e.name),
    type: strOrNull(e.type),
    hostName: strOrNull(e.hostName),
    ipAddress: strOrNull(e.ipAddress),
    vendor: strOrNull(e.vendor),
    model: strOrNull(e.model),
    health: strOrNull(e.health),
    location: strOrNull(e.location),
    contact: strOrNull(e.contact),
    tags: strOrNull(e.tags),
    rawJson: jsonOrNull(e),
  };
}

async function fetchEnclosures(source, timeout) {
  const raw = await paginatedFetch(source, {
    path: '/external-api/v1/inventory/enclosures/', params: { basicOnly: 0 },
    arrayKeys: ['Enclosures', 'enclosures'], timeout,
  });
  return raw.map(parseEnclosure);
}

// ── Inventory: chassis (no pagination, capital Scope/Value) ────────────────

function parseChassis(c) {
  const add = c.additionalAttributes || {};
  return {
    wwn: strOrNull(c.wwn),
    name: strOrNull(c.name),
    ipAddress: strOrNull(c.ipAddress),
    modelNumber: strOrNull(c.modelNumber),
    firmware: strOrNull(c.firmware),
    serialNumber: strOrNull(c.switchSerialNumber),
    partNumber: strOrNull(c.partNumber),
    vendor: strOrNull(c.vendor),
    maxPort: numOrNull(c.maxPort),
    numVirtualSwitches: numOrNull(c.numVirtualSwitches),
    maxVirtualSwitches: numOrNull(c.maxVirtualSwitches),
    tlsCertExpiryMs: numOrNull(c.tlsCertExpiryDate),
    switchId: numOrNull(c.switchId),
    mapsEnabled: numOrNull(add.mapsEnabled),
    callhomeEnabled: numOrNull(add.callhomeEnabled),
    snmpRegistered: numOrNull(add.snmpRegistered),
    syslogRegistered: numOrNull(add.syslogRegistered),
    rawJson: jsonOrNull(c),
  };
}

async function fetchChassis(source, timeout) {
  const d = await authedRequest(source, { path: '/external-api/v1/inventory/chassis/', timeout });
  return pick(d, 'chassis').map(parseChassis);
}

// ── Health summary (bare array, double-encoded contributors) ───────────────

function parseHealthEntry(h) {
  let computationMs = null;
  try {
    const ms = Date.parse(h.computationTime);
    if (Number.isFinite(ms)) computationMs = ms;
  } catch { /* ignore */ }
  const contributors = safeArr(h.contributors).map((c) => {
    let detail = null;
    if (typeof c.descriptionDetail === 'string') {
      try { detail = JSON.parse(c.descriptionDetail); } catch { detail = c.descriptionDetail; }
    } else {
      detail = c.descriptionDetail ?? null;
    }
    return { contributorType: c.contributorType ?? c.ContributorType ?? null, score: numOrNull(c.score), descriptionDetail: detail };
  });
  return {
    entityName: strOrNull(h.fabricName ?? h.switchName ?? h.hostName ?? h.storageName),
    entityGuid: strOrNull(h.fabricGUID ?? h.switchGUID ?? h.hostGUID ?? h.storageGUID),
    entityWwn: strOrNull(h.switchWWN ?? h.principalSwitchWWN),
    entityIp: strOrNull(h.switchIPAddress ?? h.hostIPAddress ?? h.seedSwitchIP),
    fid: numOrNull(h.fid ?? h.switchFid),
    fabricName: strOrNull(h.fabricName),
    score: numOrNull(h.score),
    status: strOrNull(h.status),
    computationTime: strOrNull(h.computationTime),
    computationMs,
    contributorsJson: jsonOrNull(contributors),
  };
}

async function fetchHealthSummary(source, inventoryItem, timeout) {
  const d = await authedRequest(source, {
    method: 'POST', path: '/external-api/v1/healthsummary/healthsummarydetails/',
    data: { inventoryItem }, timeout,
  });
  const arr = Array.isArray(d) ? d : safeArr(d?.data);
  return arr.map((h) => ({ ...parseHealthEntry(h), entityType: inventoryItem }));
}

// ── FCR topology ─────────────────────────────────────────────────────────

async function fetchFcrTopology(source, timeout) {
  try {
    const d = await authedRequest(source, { path: '/external-api/v1/fcr/topology/', timeout });
    return pick(d, 'topology').map((t) => ({
      backboneFabricId: numOrNull(t.backboneFabricID),
      backboneSwitches: safeArr(t.backboneSwitch).map((bs) => ({
        backboneIpAddress: strOrNull(bs.backboneIPAddress),
        backboneSwitchWwn: strOrNull(bs.backboneSwitchWwn),
        edgeFabrics: safeArr(bs.EdgeFabric ?? bs.edgeFabric),
      })),
    }));
  } catch (err) {
    if (err?.response?.status === 404) return [];
    throw err;
  }
}

// ── FOS proxy (zoning) — hyphenated FOS-native keys ─────────────────────────

async function fosProxyGet(source, { switchIp, vfId, uri, timeout = 30000 }) {
  const d = await authedRequest(source, {
    method: 'POST', path: '/external-api/v1/fos/rest/',
    data: { switch: switchIp, vfId: vfId ?? -1, method: 'GET', uri },
    timeout,
  });
  if (d?.error) {
    const e = safeArr(d.error)[0] || {};
    throw new Error(e['error-message'] || 'FOS proxy error');
  }
  if (d?.errorMessage) throw new Error(d.detailedErrorMessage || d.errorMessage);
  return d?.Response || d?.response || {};
}

function entryNames(memberEntry, key) {
  if (!memberEntry) return [];
  const v = memberEntry[key];
  if (Array.isArray(v)) return v;
  if (v == null) return [];
  return [v];
}

async function fetchEffectiveZoneConfig(source, { switchIp, vfId, timeout }) {
  const resp = await fosProxyGet(source, { switchIp, vfId, uri: '/running/brocade-zone/effective-configuration', timeout });
  const ec = resp['effective-configuration'] || {};
  const zones = safeArr(ec['enabled-zone']).map((z) => ({
    zoneName: strOrNull(z['zone-name']),
    zoneType: numOrNull(z['zone-type']),
    zoneTypeString: strOrNull(z['zone-type-string']),
    members: entryNames(z['member-entry'], 'entry-name'),
  }));
  return {
    cfgName: strOrNull(ec['cfg-name']),
    defaultZoneAccess: numOrNull(ec['default-zone-access']),
    checksum: strOrNull(ec.checksum),
    dbMax: numOrNull(ec['db-max']),
    dbAvail: numOrNull(ec['db-avail']),
    dbCommitted: numOrNull(ec['db-committed']),
    zones,
  };
}

async function fetchDefinedZoneConfig(source, { switchIp, vfId, timeout }) {
  const resp = await fosProxyGet(source, { switchIp, vfId, uri: '/running/brocade-zone/defined-configuration', timeout });
  const dc = resp['defined-configuration'] || {};
  const configs = safeArr(dc.cfg).map((c) => ({
    cfgName: strOrNull(c['cfg-name']),
    memberZones: entryNames(c['member-zone'], 'zone-name'),
  }));
  const zones = safeArr(dc.zone).map((z) => ({
    zoneName: strOrNull(z['zone-name']),
    zoneType: numOrNull(z['zone-type']),
    zoneTypeString: strOrNull(z['zone-type-string']),
    members: entryNames(z['member-entry'], 'entry-name'),
  }));
  const aliases = safeArr(dc.alias).map((a) => ({
    aliasName: strOrNull(a['alias-name']),
    members: entryNames(a['member-entry'], 'alias-entry-name'),
  }));
  return { configs, zones, aliases };
}

// ── FOS proxy (port IO statistics) — addendum 1, hyphenated FOS-native keys.
// This URI is outside SANnav's tested list; a live server may 400 with
// 'Invalid REST URI' (FOS-native error shape). isUnsupportedUriError lets
// callers distinguish that from a transient/real failure. ────────────────

function isUnsupportedUriError(err) {
  const data = err?.response?.data;
  let text = '';
  if (data) {
    if (Array.isArray(data.error)) text += data.error.map((e) => e['error-message'] || '').join(' ');
    if (data.errorMessage) text += ` ${data.errorMessage}`;
    if (data.detailedErrorMessage) text += ` ${data.detailedErrorMessage}`;
    if (data.message) text += ` ${data.message}`;
  }
  text += ` ${err?.message || ''}`;
  return /invalid rest uri/i.test(text);
}

async function fetchPortStats(source, { switchIp, vfId, timeout = 30000 } = {}) {
  const resp = await fosProxyGet(source, { switchIp, vfId, uri: '/running/brocade-interface/fibrechannel-statistics', timeout });
  const rows = pick(resp, 'fibrechannel-statistics', 'Fibrechannel-Statistics', 'fibrechannelStatistics', 'FibrechannelStatistics');
  return rows.map((r) => ({
    name: strOrNull(r.name),
    inFrames: numOrNull(r['in-frames']),
    outFrames: numOrNull(r['out-frames']),
    inOctets: numOrNull(r['in-octets']),
    outOctets: numOrNull(r['out-octets']),
    crcErrors: numOrNull(r['crc-errors']),
    invalidWords: numOrNull(r['invalid-transmission-words']),
  }));
}

// ── Fault events (v2, opaque cursor pagination, <=2h windows) ──────────────

function parseEvent(e) {
  const ackedRaw = e.acknowledged;
  const acked = ackedRaw === 'Yes' || ackedRaw === true || ackedRaw === 1 || ackedRaw === '1' ? 1 : 0;
  const severity = strOrNull(e.severity);
  return {
    eventId: strOrNull(e.eventID),
    severity,
    severityNorm: severity ? severity.toLowerCase() : null,
    eventCategory: strOrNull(e.eventCategory),
    sourceName: strOrNull(e.sourceName),
    sourceAddress: strOrNull(e.sourceAddress),
    sourceType: strOrNull(e.sourceType),
    sourceWwn: strOrNull(e.sourceWwn),
    fabricName: strOrNull(e.fabricName),
    messageId: strOrNull(e.messageId),
    origin: strOrNull(e.origin),
    module: strOrNull(e.module),
    description: strOrNull(e.description),
    eventCount: numOrNull(e.eventCount),
    firstOccurredMs: numOrNull(e.firstOccurenceHostTime),
    lastOccurredMs: numOrNull(e.lastOccurrenceHostTime),
    acknowledged: acked,
    ackBy: strOrNull(e.ackBy),
    ackNotes: strOrNull(e.ackNotes),
    ackedTimeMs: numOrNull(e.ackedTime),
    productName: strOrNull(e.productName),
    productAddress: strOrNull(e.productAddress),
    portWwn: strOrNull(e.portWwn),
  };
}

async function fetchEventsPage(source, { startTime, endTime, pageSize = 1000, startIndex = 0, nextPageIndex = null, timeout = 30000 }) {
  const d = await authedRequest(source, {
    method: 'POST', path: '/external-api/v2/fault/events/',
    data: { startTime, endTime, pageSize, startIndex, nextPageIndex },
    timeout,
  });
  return {
    events: safeArr(d?.events).map(parseEvent),
    nextPageIndex: d?.nextPageIndex ?? null,
    totalRecords: numOrNull(d?.totalRecords),
  };
}

async function ackEvents(source, eventIds, notes) {
  return authedRequest(source, {
    method: 'POST', path: '/external-api/v1/fault/events/acknowledge',
    data: { eventIdentifiers: eventIds, eventNotes: notes || '' },
  });
}

async function unackEvents(source, eventIds, notes) {
  return authedRequest(source, {
    method: 'POST', path: '/external-api/v1/fault/events/unacknowledge',
    data: { eventIdentifiers: eventIds, eventNotes: notes || '' },
  });
}

// ── Governance extras (hourly) ──────────────────────────────────────────────

async function fetchPasswordPolicy(source, timeout) {
  const d = await authedRequest(source, { path: '/external-api/v1/rbac/passwordpolicy/', timeout });
  return d || null;
}

async function fetchUsers(source, timeout) {
  const d = await authedRequest(source, { path: '/external-api/v1/usermgmt/users', timeout });
  return safeArr(d);
}

async function fetchGroups(source, timeout) {
  const d = await authedRequest(source, { path: '/external-api/v1/usermgmt/groups', timeout });
  return safeArr(d);
}

async function fetchRoles(source, timeout) {
  const d = await authedRequest(source, { path: '/external-api/v1/usermgmt/roles', timeout });
  return safeArr(d);
}

async function fetchAors(source, timeout) {
  const d = await authedRequest(source, { path: '/external-api/v1/usermgmt/aors', timeout });
  return safeArr(d);
}

module.exports = {
  login,
  logout,
  authedRequest,
  errMsg,
  testConnection,
  fetchAbout,
  fetchFabrics,
  fetchSwitches,
  fetchSwitchPorts,
  fetchDevicePorts,
  fetchEnclosures,
  fetchChassis,
  fetchHealthSummary,
  fetchFcrTopology,
  fetchEffectiveZoneConfig,
  fetchDefinedZoneConfig,
  fetchPortStats,
  isUnsupportedUriError,
  fetchEventsPage,
  ackEvents,
  unackEvents,
  fetchPasswordPolicy,
  fetchUsers,
  fetchGroups,
  fetchRoles,
  fetchAors,
  // exported for reuse/testing
  pick, numOrNull, strOrNull, jsonOrNull, safeArr,
  _sessionCache: sessionCache,
};
