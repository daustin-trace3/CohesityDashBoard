// Dell OpenManage Enterprise API client. Everything rides the OME REST API
// (/api, OData-flavored): X-Auth-Token sessions, $top/$skip paging via
// @odata.nextLink. The devices list is the only REQUIRED call per poll —
// every enrichment (per-device inventory, alerts, warranty, firmware
// compliance, Power Manager metrics) is isolated best-effort so one broken
// or unlicensed feature can never blank the core inventory.
const axios = require('axios');
const https = require('https');
const { decrypt } = require('./encryption');
const logger = require('../utils/logger');

const SESSION_TTL_MS = 25 * 60 * 1000;
const sessions = new Map(); // ome.id -> { token, fetchedAt }

// Power Manager plugin id is fixed across installs (Dell-published constant).
const POWER_MANAGER_PLUGIN_ID = '2F6D05BE-EE4B-4B0E-B873-C8D2F64A4625';

function creds(ome) {
  if (ome.password) return { username: ome.username, password: ome.password };
  const c = JSON.parse(decrypt(ome.encrypted_credentials));
  return { username: ome.username, password: c.password };
}

function baseClient(ome, headers = {}) {
  return axios.create({
    baseURL: `https://${ome.host}`,
    timeout: 60000,
    headers,
    httpsAgent: new https.Agent({ rejectUnauthorized: !!ome.ssl_verify }),
  });
}

/**
 * OME wraps errors as {"error":{"@Message.ExtendedInfo":[{Message, Resolution}]}}.
 * Surface that text instead of a bare "HTTP 400" — same lesson as the vCenter
 * SOAP fault parser.
 */
function omeErrorMessage(err) {
  const info = err?.response?.data?.error;
  if (!info) return null;
  const ext = Array.isArray(info['@Message.ExtendedInfo']) ? info['@Message.ExtendedInfo'] : [];
  const msg = ext.map((e) => e?.Message).filter(Boolean).join('; ') || info.message || null;
  return msg ? `OME error: ${msg}` : null;
}

function wrapError(err) {
  const msg = omeErrorMessage(err);
  if (msg) {
    const wrapped = new Error(msg);
    wrapped.response = err.response;
    return wrapped;
  }
  return err;
}

/** X-Auth-Token session, cached ~25 min per instance. */
async function getSession(ome, force = false) {
  const cached = sessions.get(ome.id);
  if (!force && cached && Date.now() - cached.fetchedAt < SESSION_TTL_MS) return cached.token;
  const { username, password } = creds(ome);
  let res;
  try {
    res = await baseClient(ome).post('/api/SessionService/Sessions', {
      UserName: username, Password: password, SessionType: 'API',
    });
  } catch (err) {
    throw wrapError(err);
  }
  const token = res.headers['x-auth-token'];
  if (!token) throw new Error('OME session login returned no X-Auth-Token');
  sessions.set(ome.id, { token, fetchedAt: Date.now() });
  return token;
}

function invalidateSession(omeId) {
  sessions.delete(omeId);
}

async function omeRequest(ome, method, path, body = null) {
  let token = await getSession(ome);
  const doReq = (t) => baseClient(ome, { 'X-Auth-Token': t })[method](path, ...(method === 'get' ? [] : [body]));
  try {
    const { data } = await doReq(token);
    return data;
  } catch (err) {
    if (err.response?.status === 401) {
      token = await getSession(ome, true);
      try {
        const { data } = await doReq(token);
        return data;
      } catch (err2) { throw wrapError(err2); }
    }
    throw wrapError(err);
  }
}

const oGet = (ome, path) => omeRequest(ome, 'get', path);
const oPost = (ome, path, body) => omeRequest(ome, 'post', path, body);

/** Drain an OData collection: follow @odata.nextLink until exhausted (cap 200 pages). */
async function oGetAll(ome, path) {
  const rows = [];
  let next = path;
  for (let page = 0; next && page < 200; page++) {
    const data = await oGet(ome, next);
    rows.push(...(data?.value || []));
    next = data?.['@odata.nextLink'] || null;
    // nextLink is server-relative ("/api/...") — axios baseURL handles it.
  }
  return rows;
}

// ── Enum maps (OME numeric ids → readable) ──────────────────────────────────
// Known-stable ids from the OME API guide; anything unmapped keeps the raw id.

const HEALTH_MAP = { 1000: 'ok', 2000: 'unknown', 3000: 'warning', 4000: 'critical', 5000: 'unknown' };
const POWER_MAP = { 17: 'on', 18: 'off', 20: 'powering on', 21: 'powering off' };
const DEVICE_TYPE_FALLBACK = {
  1000: 'Server', 2000: 'Chassis', 3000: 'Storage', 4000: 'Network Iom',
  5000: 'Network Device', 6000: 'Dell Storage', 7000: 'iDRAC', 8000: 'Storage Device',
};
const ALERT_SEVERITY_MAP = { 1: 'unknown', 2: 'info', 4: 'normal', 8: 'warning', 16: 'critical' };

// ── Core inventory ──────────────────────────────────────────────────────────

/** Appliance version — best-effort (endpoint name has varied across releases). */
async function fetchApplianceInfo(ome) {
  try {
    const d = await oGet(ome, '/api/ApplicationService/Info');
    return { version: d?.Version || null };
  } catch { return { version: null }; }
}

/** Device type id → name map from the appliance itself (falls back to constants). */
async function fetchDeviceTypeMap(ome) {
  try {
    const rows = await oGetAll(ome, '/api/DeviceService/DeviceType');
    const map = {};
    for (const r of rows) if (r?.DeviceType != null && r?.Name) map[r.DeviceType] = r.Name;
    return Object.keys(map).length ? map : DEVICE_TYPE_FALLBACK;
  } catch { return DEVICE_TYPE_FALLBACK; }
}

/** All managed devices. The one call a poll cannot survive without. */
async function fetchDevices(ome, typeMap) {
  const rows = await oGetAll(ome, '/api/DeviceService/Devices?$top=500');
  return rows.map((d) => {
    const mgmt = Array.isArray(d.DeviceManagement) ? d.DeviceManagement[0] : null;
    return {
      deviceId: d.Id,
      serviceTag: d.DeviceServiceTag || d.Identifier || null,
      name: d.DeviceName || null,
      model: d.Model || null,
      deviceType: typeMap[d.Type] || String(d.Type ?? ''),
      chassisServiceTag: d.ChassisServiceTag || null,
      health: HEALTH_MAP[d.Status] || 'unknown',
      healthRaw: d.Status ?? null,
      powerState: POWER_MAP[d.PowerState] || (d.PowerState != null ? String(d.PowerState) : null),
      connectionState: d.ConnectionState === true || d.ConnectionState === 'true' ? 1
        : d.ConnectionState === false || d.ConnectionState === 'false' ? 0 : null,
      managedState: d.ManagedState != null ? String(d.ManagedState) : null,
      assetTag: d.AssetTag || null,
      ipAddress: mgmt?.NetworkAddress || null,
      firmwareVersion: mgmt?.ManagementProfile?.[0]?.Version || null,
      lastInventoryTime: d.LastInventoryTime || null,
    };
  });
}

// ── Per-device hardware inventory ───────────────────────────────────────────

const num = (v) => { const n = Number(v); return Number.isFinite(n) ? n : null; };

// OME sizes arrive either as plain byte counts or unit strings ("745.21 GB").
const SIZE_UNITS = { b: 1, bytes: 1, kb: 1024, mb: 1024 ** 2, gb: 1024 ** 3, tb: 1024 ** 4, pb: 1024 ** 5 };
const parseSize = (v) => {
  if (v == null) return null;
  if (typeof v === 'number') return Number.isFinite(v) ? Math.round(v) : null;
  const m = String(v).replace(/,/g, '').trim().match(/^([\d.]+)\s*(bytes|b|kb|mb|gb|tb|pb)?$/i);
  if (!m) return null;
  const n = parseFloat(m[1]);
  return Number.isFinite(n) ? Math.round(n * SIZE_UNITS[(m[2] || 'bytes').toLowerCase()]) : null;
};
const compHealth = (v) => {
  if (v == null) return null;
  const s = String(v).toLowerCase();
  if (['ok', 'online', 'ready', 'good', 'normal', '1000'].includes(s)) return 'ok';
  if (['warning', 'degraded', 'noncritical', '3000'].includes(s)) return 'warning';
  if (['critical', 'error', 'failed', 'offline', '4000'].includes(s)) return 'critical';
  return 'unknown';
};

/**
 * One InventoryDetails call per device returns EVERY inventory section
 * ({InventoryType, InventoryInfo}[]). Parse the sections we surface into
 * typed component rows; unknown sections are ignored.
 */
function parseInventory(deviceId, sections) {
  const comps = [];
  for (const sec of sections || []) {
    const type = sec?.InventoryType;
    const items = Array.isArray(sec?.InventoryInfo) ? sec.InventoryInfo : [];
    if (type === 'serverProcessors') {
      for (const p of items) {
        comps.push({
          deviceId, kind: 'processor',
          // ModelName carries the full CPU string ("Intel(R) Xeon(R) Gold 6252
          // CPU @ 2.10GHz"); BrandName is just the vendor ("Intel").
          name: p.ModelName || p.BrandName || null, description: p.BrandName || null,
          status: compHealth(p.Status), model: p.ModelName || null, serial: null,
          slot: p.SlotNumber || null, sizeBytes: null,
          speed: p.MaxSpeed ? `${p.MaxSpeed} MHz` : null,
          extra: { cores: num(p.NumberOfCores), enabledCores: num(p.NumberOfEnabledCores), family: p.Family ?? null },
        });
      }
    } else if (type === 'serverMemoryDevices') {
      for (const m of items) {
        comps.push({
          deviceId, kind: 'memory',
          name: m.Name || m.DeviceLocator || null, description: m.DeviceDescription || null,
          status: compHealth(m.Status), model: m.PartNumber || null, serial: m.SerialNumber || null,
          slot: m.DeviceLocator || m.BankName || null,
          // Bare integer = MB (documented); unit strings appear on some releases.
          sizeBytes: typeof m.Size === 'string' && /[a-z]/i.test(m.Size) ? parseSize(m.Size)
            : (num(m.Size) != null ? num(m.Size) * 1024 * 1024 : null),
          speed: m.Speed ? `${m.Speed} MHz` : null,
          extra: { type: m.TypeDetails || null, manufacturer: m.Manufacturer || null },
        });
      }
    } else if (type === 'serverArrayDisks') {
      for (const d of items) {
        comps.push({
          deviceId, kind: 'disk',
          name: d.ModelNumber || d.SerialNumber || null, description: d.Description || null,
          status: compHealth(d.StatusString ?? d.Status), model: d.ModelNumber || null,
          serial: d.SerialNumber || null, slot: d.SlotNumber != null ? String(d.SlotNumber) : null,
          // Size is usually a unit string; some releases leave it empty on RAID
          // members and only report used+free raid space.
          sizeBytes: parseSize(d.Size)
            ?? (parseSize(d.UsedRaidDiskSpace) != null || parseSize(d.FreeDiskSpace) != null
              ? (parseSize(d.UsedRaidDiskSpace) || 0) + (parseSize(d.FreeDiskSpace) || 0) : null),
          speed: d.BusType || null,
          extra: {
            mediaType: d.MediaType || null, busType: d.BusType || null,
            vendor: d.VendorName || null, enclosure: d.EnclosureId || null,
            usedRaid: d.UsedRaidDiskSpace ?? null, freeSpace: d.FreeDiskSpace ?? null,
            predictiveFailure: d.PredictiveFailureState ?? null,
          },
        });
      }
    } else if (type === 'serverNetworkInterfaces') {
      for (const n of items) {
        // NICs nest: { NicId, VendorName, Ports: [{ Partitions: [...] }] }
        const ports = Array.isArray(n.Ports) ? n.Ports : [];
        comps.push({
          deviceId, kind: 'nic',
          name: n.NicId || null, description: ports[0]?.ProductName || null,
          status: compHealth(ports[0]?.Status), model: null, serial: null, slot: null,
          sizeBytes: null, speed: ports[0]?.Partitions?.[0]?.CurrentMacAddress ? null : null,
          extra: {
            vendor: n.VendorName || null,
            ports: ports.map((p) => ({
              portId: p.PortId ?? null, linkStatus: p.LinkStatus ?? null, linkSpeed: p.LinkSpeed ?? null,
              macs: (p.Partitions || []).map((pt) => pt.CurrentMacAddress).filter(Boolean),
            })),
          },
        });
      }
    } else if (type === 'serverPowerSupplies') {
      for (const p of items) {
        comps.push({
          deviceId, kind: 'psu',
          name: p.Name || null, description: p.Model || null,
          status: compHealth(p.Status), model: p.Model || null, serial: p.SerialNumber || null,
          slot: p.Location || null, sizeBytes: null,
          speed: p.OutputWatts != null ? `${p.OutputWatts} W` : null,
          extra: { partNumber: p.PartNumber || null, firmware: p.FirmwareVersion || null },
        });
      }
    } else if (type === 'serverOperatingSystems') {
      for (const o of items) {
        comps.push({
          deviceId, kind: 'os',
          name: o.OsName || null, description: o.OsVersion || null,
          status: null, model: null, serial: null, slot: null, sizeBytes: null,
          speed: null, extra: { hostname: o.Hostname || null },
        });
      }
    }
  }
  return comps;
}

/** Roll component rows up to per-device summary columns (sockets/cores/mem/disk). */
function summarizeComponents(comps) {
  const byDevice = new Map();
  for (const c of comps) {
    let s = byDevice.get(c.deviceId);
    if (!s) { s = { cpuCount: 0, coreCount: 0, memoryBytes: 0, diskBytes: 0 }; byDevice.set(c.deviceId, s); }
    if (c.kind === 'processor') { s.cpuCount += 1; s.coreCount += c.extra?.cores || 0; }
    if (c.kind === 'memory') s.memoryBytes += c.sizeBytes || 0;
    if (c.kind === 'disk') s.diskBytes += c.sizeBytes || 0;
  }
  return byDevice;
}

async function fetchDeviceInventory(ome, deviceId) {
  const data = await oGet(ome, `/api/DeviceService/Devices(${deviceId})/InventoryDetails`);
  return parseInventory(deviceId, data?.value || []);
}

// ── Alerts ──────────────────────────────────────────────────────────────────

/**
 * Newest maxPages*500 alerts, newest first. Incremental dedupe happens at
 * store time via the unique (ome_id, alert_id) index, so overlap is free and
 * the flaky TimeStamp $filter (broken on several OME builds) is avoided.
 */
async function fetchAlerts(ome, maxPages = 4) {
  const rows = [];
  let next = '/api/AlertService/Alerts?$top=500&$orderby=TimeStamp desc';
  for (let page = 0; next && page < maxPages; page++) {
    const data = await oGet(ome, next);
    rows.push(...(data?.value || []));
    next = data?.['@odata.nextLink'] || null;
  }
  return rows.map((a) => ({
    alertId: a.Id,
    severity: ALERT_SEVERITY_MAP[a.SeverityType] || (a.SeverityName ? String(a.SeverityName).toLowerCase() : 'unknown'),
    status: a.StatusName ? String(a.StatusName).toLowerCase() : (a.StatusType != null ? String(a.StatusType) : null),
    category: a.CategoryName || null,
    subcategory: a.SubCategoryName || null,
    message: a.Message || null,
    deviceName: a.AlertDeviceName || null,
    serviceTag: a.AlertDeviceIdentifier || null,
    createdAt: a.TimeStamp || null,
  }));
}

// ── Warranty ────────────────────────────────────────────────────────────────

async function fetchWarranties(ome) {
  const rows = await oGetAll(ome, '/api/WarrantyService/Warranties?$top=500');
  return rows.map((w) => ({
    deviceId: w.DeviceId ?? null,
    serviceTag: w.DeviceIdentifier || null,
    deviceModel: w.DeviceModel || null,
    deviceType: w.DeviceType != null ? String(w.DeviceType) : null,
    serviceLevel: w.ServiceLevelDescription || w.ServiceLevelCode || null,
    startDate: w.StartDate || null,
    endDate: w.EndDate || null,
    daysRemaining: w.DaysRemaining != null ? num(w.DaysRemaining) : null,
  }));
}

// ── Firmware compliance ─────────────────────────────────────────────────────

async function fetchFirmwareCompliance(ome) {
  const baselines = await oGetAll(ome, '/api/UpdateService/Baselines');
  const out = [];
  for (const b of baselines) {
    try {
      const reports = await oGetAll(ome, `/api/UpdateService/Baselines(${b.Id})/DeviceComplianceReports`);
      for (const r of reports) {
        const comps = Array.isArray(r.ComponentComplianceReports) ? r.ComponentComplianceReports : [];
        const bad = comps.filter((c) => String(c.UpdateAction || '').toUpperCase() !== 'EQUAL'
          && String(c.ComplianceStatus || '').toUpperCase() !== 'OK').length;
        out.push({
          baselineId: b.Id, baselineName: b.Name || null,
          deviceId: r.DeviceId ?? null, serviceTag: r.ServiceTag || null,
          deviceModel: r.DeviceModel || null,
          status: String(r.ComplianceStatus || '').toUpperCase() === 'OK' || String(r.ComplianceStatus) === 'COMPLIANT'
            ? 'compliant' : (r.ComplianceStatus ? 'noncompliant' : 'unknown'),
          noncompliantComponents: bad,
        });
      }
    } catch (err) {
      logger.debug(`[omeApi] compliance report failed for baseline ${b.Id}: ${err.message}`);
    }
  }
  return out;
}

// ── Power Manager metrics (plugin — wholly best-effort) ─────────────────────

/**
 * Instant power/thermal/utilization for one device. Throws on the first call
 * when the plugin is absent; the poller disables the sweep for the rest of
 * that poll. MetricTypes: 4 instant power, 8 instant inlet temp, 11 avg CPU
 * util, 14 avg memory util.
 */
async function fetchDeviceMetrics(ome, deviceId) {
  const data = await oPost(ome, '/api/MetricService/Metrics', {
    PluginId: POWER_MANAGER_PLUGIN_ID,
    EntityType: 0, EntityId: deviceId,
    MetricTypes: [4, 8, 11, 14],
    Duration: 0, SortOrder: 0,
  });
  const values = data?.Value || data?.value || [];
  const latestByType = new Map();
  for (const v of values) {
    const t = v?.Type ?? v?.MetricType;
    if (t != null && !latestByType.has(t)) latestByType.set(t, num(v.Value ?? v.MetricValue));
  }
  return {
    powerW: latestByType.get(4) ?? null,
    inletTempC: latestByType.get(8) ?? null,
    cpuUtilPct: latestByType.get(11) ?? null,
    memUtilPct: latestByType.get(14) ?? null,
  };
}

/**
 * Base-OME power/thermal snapshot (NO Power Manager license needed — this is
 * what the console shows under Device > Server). Field names vary slightly
 * across OME releases, so parse tolerantly. Utilization is NOT here — that
 * genuinely needs the Power Manager plugin.
 */
async function fetchDevicePowerThermal(ome, deviceId) {
  const firstNum = (obj, keys) => {
    for (const k of keys) {
      const v = num(obj?.[k]);
      if (v != null) return v;
    }
    return null;
  };
  let powerW = null;
  let inletTempC = null;
  try {
    const p = await oGet(ome, `/api/DeviceService/Devices(${deviceId})/Power`);
    powerW = firstNum(p, ['power', 'Power', 'instantaneousPower', 'InstantaneousPower', 'instantPower']);
  } catch { /* endpoint absent on this device/OME release */ }
  try {
    const t = await oGet(ome, `/api/DeviceService/Devices(${deviceId})/Temperature`);
    inletTempC = firstNum(t, ['instantaneousTemperature', 'InstantaneousTemperature', 'temperature', 'Temperature', 'avgTemperature']);
  } catch { /* endpoint absent */ }
  return { powerW, inletTempC };
}

// ── Connection test ─────────────────────────────────────────────────────────

async function testConnection(candidate) {
  try {
    const probe = { ...candidate, id: `test-${candidate.host}` };
    await getSession(probe, true);
    const data = await oGet(probe, '/api/DeviceService/Devices?$top=1');
    sessions.delete(probe.id);
    const count = data?.['@odata.count'] ?? (data?.value?.length ?? 0);
    return { ok: true, message: `Connected — ${count} managed device(s) visible.` };
  } catch (err) {
    return { ok: false, message: omeErrorMessage(err) || err.message || 'Connection failed' };
  }
}

module.exports = {
  fetchApplianceInfo, fetchDeviceTypeMap, fetchDevices, fetchDeviceInventory,
  summarizeComponents, fetchAlerts, fetchWarranties, fetchFirmwareCompliance,
  fetchDeviceMetrics, fetchDevicePowerThermal, testConnection, invalidateSession,
};
