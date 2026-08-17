// Dell OpenManage Enterprise API client. Everything rides the OME REST API
// (/api, OData-flavored): X-Auth-Token sessions, $top/$skip paging via
// @odata.nextLink. The devices list is the only REQUIRED call per poll —
// every enrichment (per-device inventory, alerts, warranty, firmware
// compliance, Power Manager metrics) is isolated best-effort so one broken
// or unlicensed feature can never blank the core inventory.
//
// DEVIATION FROM THE BUILT-IN: the original (backend/services/dellOmeApi.js)
// uses axios, which is not available to a bundled plugin (esbuild has no
// axios to bundle from plugin-sdk's dependency tree). Re-implemented on
// Node's built-in `https` module (plugin-sdk/unifi backend/src/api.js's
// rawRequest pattern), with GET/POST JSON support. Every function now
// threads `coreApi` through for decrypt/logging instead of requiring host
// modules directly. Behavior preserved verbatim: X-Auth-Token sessions with
// a 25-min TTL, OData paging via @odata.nextLink, $top/$skip paging,
// per-feature best-effort isolation, the fixed Power Manager plugin id, and
// ssl_verify -> rejectUnauthorized.
const https = require('https');
const { URLSearchParams } = require('url');

const SESSION_TTL_MS = 25 * 60 * 1000;
const sessions = new Map(); // ome.id -> { token, fetchedAt }

// Power Manager plugin id is fixed across installs (Dell-published constant).
const POWER_MANAGER_PLUGIN_ID = '2F6D05BE-EE4B-4B0E-B873-C8D2F64A4625';

function creds(ome, coreApi) {
  if (ome.password) return { username: ome.username, password: ome.password };
  const c = JSON.parse(coreApi.encryption.decrypt(ome.encrypted_credentials));
  return { username: ome.username, password: c.password };
}

/** Raw HTTPS call against an OME appliance. Resolves with { status, data, headers }.
 *  Rejects with an Error carrying `.response = { status, data, headers }`. */
function rawRequest(ome, { method = 'GET', path, params, data, headers = {}, timeout = 60000 } = {}) {
  return new Promise((resolve, reject) => {
    const qs = new URLSearchParams();
    for (const [k, v] of Object.entries(params || {})) {
      if (v !== undefined && v !== null) qs.set(k, String(v));
    }
    const query = qs.toString();
    const reqPath = `${path}${query ? `${path.includes('?') ? '&' : '?'}${query}` : ''}`;
    const body = data !== undefined ? JSON.stringify(data) : undefined;
    const reqHeaders = { ...headers };
    if (body !== undefined) {
      reqHeaders['Content-Type'] = 'application/json';
      reqHeaders['Content-Length'] = Buffer.byteLength(body);
    }

    const req = https.request(
      {
        hostname: ome.host,
        port: ome.port || 443,
        path: reqPath,
        method,
        timeout,
        rejectUnauthorized: !!ome.ssl_verify,
        headers: reqHeaders,
      },
      (res) => {
        const chunks = [];
        res.on('data', (chunk) => chunks.push(chunk));
        res.on('end', () => {
          const raw = Buffer.concat(chunks);
          const status = res.statusCode;
          const str = raw.toString('utf8');
          let payload;
          try { payload = str ? JSON.parse(str) : null; } catch { payload = str || null; }
          if (status >= 200 && status < 300) {
            resolve({ status, data: payload, headers: res.headers });
            return;
          }
          const e = new Error(`HTTP ${status}`);
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

/**
 * OME wraps errors as {"error":{"@Message.ExtendedInfo":[{Message, Resolution}]}}.
 * Surface that text instead of a bare "HTTP 400".
 */
function omeErrorMessage(err) {
  const info = err?.response?.data?.error;
  if (!info) return null;
  const ext = Array.isArray(info['@Message.ExtendedInfo']) ? info['@Message.ExtendedInfo'] : [];
  const msg = ext.map((e) => e?.Message).filter(Boolean).join('; ') || info.message || null;
  return msg ? `OME error: ${msg}` : null;
}

function errMsg(err) {
  return omeErrorMessage(err) || err?.message || String(err);
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
async function getSession(ome, coreApi, force = false) {
  const cached = sessions.get(ome.id);
  if (!force && cached && Date.now() - cached.fetchedAt < SESSION_TTL_MS) return cached.token;
  const { username, password } = creds(ome, coreApi);
  let res;
  try {
    res = await rawRequest(ome, {
      method: 'POST', path: '/api/SessionService/Sessions',
      data: { UserName: username, Password: password, SessionType: 'API' },
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

async function omeRequest(ome, coreApi, method, path, body = null) {
  let token = await getSession(ome, coreApi);
  const doReq = (t) => rawRequest(ome, { method, path, data: body ?? undefined, headers: { 'X-Auth-Token': t } });
  try {
    const { data } = await doReq(token);
    return data;
  } catch (err) {
    if (err.response?.status === 401) {
      token = await getSession(ome, coreApi, true);
      try {
        const { data } = await doReq(token);
        return data;
      } catch (err2) { throw wrapError(err2); }
    }
    throw wrapError(err);
  }
}

const oGet = (ome, coreApi, path) => omeRequest(ome, coreApi, 'GET', path);
const oPost = (ome, coreApi, path, body) => omeRequest(ome, coreApi, 'POST', path, body);

/** Drain an OData collection: follow @odata.nextLink until exhausted (cap 200 pages). */
async function oGetAll(ome, coreApi, path) {
  const rows = [];
  let next = path;
  for (let page = 0; next && page < 200; page++) {
    const data = await oGet(ome, coreApi, next);
    rows.push(...(data?.value || []));
    next = data?.['@odata.nextLink'] || null;
    // nextLink is server-relative ("/api/...") — passed straight to oGet.
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
async function fetchApplianceInfo(ome, coreApi) {
  try {
    const d = await oGet(ome, coreApi, '/api/ApplicationService/Info');
    return { version: d?.Version || null };
  } catch { return { version: null }; }
}

/** Device type id → name map from the appliance itself (falls back to constants). */
async function fetchDeviceTypeMap(ome, coreApi) {
  try {
    const rows = await oGetAll(ome, coreApi, '/api/DeviceService/DeviceType');
    const map = {};
    for (const r of rows) if (r?.DeviceType != null && r?.Name) map[r.DeviceType] = r.Name;
    return Object.keys(map).length ? map : DEVICE_TYPE_FALLBACK;
  } catch { return DEVICE_TYPE_FALLBACK; }
}

/** All managed devices. The one call a poll cannot survive without. */
async function fetchDevices(ome, coreApi, typeMap) {
  const rows = await oGetAll(ome, coreApi, '/api/DeviceService/Devices?$top=500');
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

// OME sizes arrive as unit strings ("745.21 GB") or bare numbers whose unit
// depends on the section — LIVE-CONFIRMED: serverArrayDisks / virtual-disk
// Size is a bare GB string ("223"); serverMemoryDevices Size is bare MB.
// Callers pass bareUnit for the section's implicit unit.
const SIZE_UNITS = { b: 1, bytes: 1, kb: 1024, mb: 1024 ** 2, gb: 1024 ** 3, tb: 1024 ** 4, pb: 1024 ** 5 };
const parseSize = (v, bareUnit = 'bytes') => {
  if (v == null) return null;
  if (typeof v === 'number') return Number.isFinite(v) ? Math.round(v * SIZE_UNITS[bareUnit]) : null;
  const m = String(v).replace(/,/g, '').trim().match(/^([\d.]+)\s*(bytes|b|kb|mb|gb|tb|pb)?$/i);
  if (!m) return null;
  const n = parseFloat(m[1]);
  return Number.isFinite(n) ? Math.round(n * SIZE_UNITS[(m[2] || bareUnit).toLowerCase()]) : null;
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
          sizeBytes: parseSize(d.Size, 'gb') ?? parseSize(d.Capacity, 'gb') ?? parseSize(d.DiskCapacity, 'gb')
            ?? (parseSize(d.UsedRaidDiskSpace, 'gb') != null || parseSize(d.FreeDiskSpace, 'gb') != null
              ? (parseSize(d.UsedRaidDiskSpace, 'gb') || 0) + (parseSize(d.FreeDiskSpace, 'gb') || 0) : null),
          speed: d.BusType || null,
          extra: {
            mediaType: d.MediaType || null, busType: d.BusType || null,
            vendor: d.VendorName || null, enclosure: d.EnclosureId || null,
            usedRaid: d.UsedRaidDiskSpace ?? null, freeSpace: d.FreeDiskSpace ?? null,
            predictiveFailure: d.PredictiveFailureState ?? null,
            raidStatus: d.RaidStatus ?? null,
            endurance: d.RemainingReadWriteEndurance != null ? num(d.RemainingReadWriteEndurance) : null,
            channel: d.Channel ?? null, diskId: d.Id ?? d.DiskNumber ?? null,
          },
        });
      }
    } else if (type === 'serverRaidControllers') {
      for (const c of items) {
        comps.push({
          deviceId, kind: 'raid',
          name: c.Name || c.DeviceDescription || null, description: c.DeviceDescription || null,
          status: compHealth(c.StatusTypeString ?? c.Status), model: c.Name || null,
          serial: null, slot: c.PciSlot != null ? String(c.PciSlot) : null,
          sizeBytes: null, speed: null,
          extra: { firmware: c.FirmwareVersion ?? null, driver: c.DriverVersion ?? null, cacheMb: num(c.CacheSizeInMb) },
        });
        const vds = Array.isArray(c.ServerVirtualDisks) ? c.ServerVirtualDisks
          : Array.isArray(c.VirtualDisks) ? c.VirtualDisks : [];
        for (const v of vds) {
          comps.push({
            deviceId, kind: 'vdisk',
            name: v.Name || (v.VirtualDiskId != null ? `Virtual Disk ${v.VirtualDiskId}` : null),
            description: v.RaidType || v.Layout || null,
            status: compHealth(v.State ?? v.Status), model: null, serial: null,
            slot: v.TargetId != null ? String(v.TargetId) : null,
            sizeBytes: parseSize(v.Size, 'gb'), speed: v.RaidType || v.Layout || null,
            extra: {
              controller: c.Name || null, state: v.State ?? null, mediaType: v.MediaType ?? null,
              readPolicy: v.ReadPolicy ?? null, writePolicy: v.WritePolicy ?? null,
              diskIds: v.PhysicalDiskIds ?? v.Disks ?? v.ArrayDisks ?? null,
            },
          });
        }
      }
    } else if (type === 'serverFcCards') {
      for (const f of items) {
        comps.push({
          deviceId, kind: 'fc',
          name: f.DeviceName || f.DeviceDescription || null, description: f.DeviceDescription || null,
          status: null, // LinkStatus Down is normal for unused ports — not a health signal
          model: null, serial: f.Wwpn || null, slot: f.Fqdd || null, sizeBytes: null,
          speed: f.PortSpeed ? `${Math.round(num(f.PortSpeed) / 1000)} Gb` : null,
          extra: { vendor: f.VendorName || null, wwn: f.Wwn || null, wwpn: f.Wwpn || null,
            port: f.PortNumber ?? null, linkStatus: f.LinkStatus ?? null },
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
    if (!s) { s = { cpuCount: 0, coreCount: 0, memoryBytes: 0, diskBytes: 0, vdiskBytes: 0 }; byDevice.set(c.deviceId, s); }
    if (c.kind === 'processor') { s.cpuCount += 1; s.coreCount += c.extra?.cores || 0; }
    if (c.kind === 'memory') s.memoryBytes += c.sizeBytes || 0;
    if (c.kind === 'disk') s.diskBytes += c.sizeBytes || 0;
    if (c.kind === 'vdisk') s.vdiskBytes += c.sizeBytes || 0;
  }
  for (const s of byDevice.values()) {
    if (!s.diskBytes && s.vdiskBytes) s.diskBytes = s.vdiskBytes;
    delete s.vdiskBytes;
  }
  return byDevice;
}

async function fetchDeviceInventory(ome, coreApi, deviceId) {
  const data = await oGet(ome, coreApi, `/api/DeviceService/Devices(${deviceId})/InventoryDetails`);
  return parseInventory(deviceId, data?.value || []);
}

// ── Alerts ──────────────────────────────────────────────────────────────────

/**
 * Newest maxPages*500 alerts, newest first. Incremental dedupe happens at
 * store time via the unique (ome_id, alert_id) index, so overlap is free and
 * the flaky TimeStamp $filter (broken on several OME builds) is avoided.
 */
async function fetchAlerts(ome, coreApi, maxPages = 20) {
  const fetchPages = async (start) => {
    const rows = [];
    let next = start;
    for (let page = 0; next && page < maxPages; page++) {
      const data = await oGet(ome, coreApi, next);
      rows.push(...(data?.value || []));
      next = data?.['@odata.nextLink'] || null;
    }
    return rows;
  };
  let raw;
  try {
    raw = await fetchPages('/api/AlertService/Alerts?$top=500&$orderby=TimeStamp desc');
  } catch {
    raw = await fetchPages('/api/AlertService/Alerts?$top=500');
  }
  return raw.map((a) => ({
    alertId: a.Id,
    severity: ALERT_SEVERITY_MAP[a.SeverityType] || (a.SeverityName ? String(a.SeverityName).toLowerCase() : 'unknown'),
    status: a.StatusName ? String(a.StatusName).toLowerCase() : (a.StatusType != null ? String(a.StatusType) : null),
    category: a.CategoryName || null,
    subcategory: a.SubCategoryName || null,
    messageId: a.AlertMessageId || a.MessageId || null,
    message: a.Message || null,
    deviceName: a.AlertDeviceName || null,
    serviceTag: a.AlertDeviceIdentifier || null,
    createdAt: a.TimeStamp || null,
  }));
}

/** Raw alert diagnostic: tries the ordered and unordered listings, returns
 *  each attempt's outcome and the first raw alert so the parser can be
 *  matched to the appliance's actual field names. */
async function probeAlerts(ome, coreApi) {
  const out = {};
  const attempts = [
    ['ordered', '/api/AlertService/Alerts?$top=3&$orderby=TimeStamp desc'],
    ['plain', '/api/AlertService/Alerts?$top=3'],
  ];
  for (const [key, url] of attempts) {
    try {
      const data = await oGet(ome, coreApi, url);
      out[key] = { returned: (data?.value || []).length, count: data?.['@odata.count'] ?? null, first: (data?.value || [])[0] || null };
    } catch (err) {
      out[key] = { error: errMsg(err) };
    }
  }
  return out;
}

// ── Warranty ────────────────────────────────────────────────────────────────

async function fetchWarranties(ome, coreApi) {
  const rows = await oGetAll(ome, coreApi, '/api/WarrantyService/Warranties?$top=500');
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

async function fetchFirmwareCompliance(ome, coreApi) {
  const baselines = await oGetAll(ome, coreApi, '/api/UpdateService/Baselines');
  const out = [];
  for (const b of baselines) {
    try {
      const reports = await oGetAll(ome, coreApi, `/api/UpdateService/Baselines(${b.Id})/DeviceComplianceReports`);
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
      coreApi.logger.debug(`[dellApi] compliance report failed for baseline ${b.Id}: ${errMsg(err)}`);
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
async function fetchDeviceMetrics(ome, coreApi, deviceId) {
  const data = await oPost(ome, coreApi, '/api/MetricService/Metrics', {
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
async function fetchDevicePowerThermal(ome, coreApi, deviceId) {
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
    const p = await oGet(ome, coreApi, `/api/DeviceService/Devices(${deviceId})/Power`);
    powerW = firstNum(p, ['power', 'Power', 'instantaneousPower', 'InstantaneousPower', 'instantPower']);
  } catch { /* endpoint absent on this device/OME release */ }
  try {
    const t = await oGet(ome, coreApi, `/api/DeviceService/Devices(${deviceId})/Temperature`);
    inletTempC = firstNum(t, ['instantaneousTemperature', 'InstantaneousTemperature', 'temperature', 'Temperature', 'avgTemperature']);
  } catch { /* endpoint absent */ }
  return { powerW, inletTempC };
}

/**
 * Live-shape diagnostic: raw inventory layout for one device — available
 * InventoryTypes, each combined-response section with its count + first raw
 * item, and the dedicated serverRaidControllers call (some releases omit
 * sections from the combined response). Read-only; used by the
 * /instances/:id/inventory-probe route when parsed data looks wrong.
 */
async function probeInventory(ome, coreApi, deviceId) {
  const out = { deviceId, types: null, sections: [], raidDedicated: null };
  try {
    const t = await oGet(ome, coreApi, `/api/DeviceService/Devices(${deviceId})/InventoryTypes`);
    out.types = t?.InventoryTypes || t?.value || t || null;
  } catch (err) { out.types = `unavailable: ${errMsg(err)}`; }
  try {
    const data = await oGet(ome, coreApi, `/api/DeviceService/Devices(${deviceId})/InventoryDetails`);
    for (const sec of data?.value || []) {
      const items = Array.isArray(sec?.InventoryInfo) ? sec.InventoryInfo : [];
      out.sections.push({ type: sec?.InventoryType, count: items.length, firstItem: items[0] ?? null });
    }
  } catch (err) { out.sections = `unavailable: ${errMsg(err)}`; }
  try {
    const d = await oGet(ome, coreApi, `/api/DeviceService/Devices(${deviceId})/InventoryDetails('serverRaidControllers')`);
    const items = Array.isArray(d?.InventoryInfo) ? d.InventoryInfo : [];
    out.raidDedicated = { count: items.length, firstItem: items[0] ?? null };
  } catch (err) { out.raidDedicated = `unavailable: ${errMsg(err)}`; }
  return out;
}

// ── Configuration compliance, jobs, profiles, hardware logs ─────────────────
// Built blind from the OME 3.5/3.8 API guides + Dell's own Ansible/PowerShell
// tooling; first live run against Doug's prod OME was the verification loop
// (probeAudit below dumps raw shapes when parsed data looks wrong).

// OME's @odata.nextLink drops the original query args on several builds
// (github.com/dell/OpenManage-Enterprise issue #228), so page manually with
// $top/$skip instead of trusting nextLink.
async function oGetAllSkip(ome, coreApi, path, { top = 500, maxPages = 20 } = {}) {
  const sep = path.includes('?') ? '&' : '?';
  const rows = [];
  for (let page = 0; page < maxPages; page++) {
    const data = await oGet(ome, coreApi, `${path}${sep}$top=${top}&$skip=${page * top}`);
    const batch = data?.value || [];
    rows.push(...batch);
    if (batch.length < top) break;
  }
  return rows;
}

// CIM datetime ("20170907060147.000000-300", offset in minutes) → ISO-ish UTC
// "YYYY-MM-DD HH:MM:SS". Non-CIM strings pass through unchanged.
function cimToIso(v) {
  if (v == null) return null;
  const m = String(v).match(/^(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})(?:\.\d+)?([+-]\d{1,4})?$/);
  if (!m) return String(v);
  const [, Y, Mo, D, H, Mi, S, off] = m;
  const utcMs = Date.UTC(+Y, +Mo - 1, +D, +H, +Mi, +S) - (off ? parseInt(off, 10) * 60000 : 0);
  return new Date(utcMs).toISOString().replace('T', ' ').slice(0, 19);
}

// Timestamps drift by OME build: the 3.5 guide documents CIM
// ("20170907060147.000000-300", DateFormat "CIM") but 4.x returns
// ISO-8601 with offset ("2026-08-13T19:15:29-07:00", DateFormat "GMT").
// Normalize everything to UTC "YYYY-MM-DD HH:MM:SS" so SQLite date filters
// and the retention prune compare correctly.
function normalizeTimestamp(v) {
  if (v == null) return null;
  const s = String(v);
  if (/^\d{14}/.test(s)) return cimToIso(s);
  const d = new Date(s.includes('T') || /[+-]\d{2}:?\d{2}$|Z$/.test(s) ? s : `${s.replace(' ', 'T')}Z`);
  if (!Number.isNaN(d.getTime())) return d.toISOString().replace('T', ' ').slice(0, 19);
  return s;
}

// Device-level ComplianceStatus is a string on OME ≤3.4 ("COMPLIANT") and an
// integer on 3.5+ (1 compliant / 2 noncompliant) — Dell's own modules match
// both forms, so must we.
function complianceStatusName(v) {
  const s = String(v ?? '').toUpperCase();
  if (v === 1 || s === 'COMPLIANT' || s === 'OK') return 'compliant';
  if (v === 2 || s === 'NONCOMPLIANT') return 'noncompliant';
  if (v === 3 || s === 'NOT_INVENTORIED') return 'not_inventoried';
  return v == null ? 'unknown' : `unknown (${v})`;
}

/**
 * Flatten the DeviceComplianceDetails tree (groups → sub-groups → attributes)
 * into rows for the non-compliant entries only. Group/attribute level uses a
 * THIRD status scheme (integer; 1 = compliant, anything else = drift) — the
 * ComplianceReason string is the authoritative human explanation.
 */
function flattenComplianceDetail(detail, cap = 500) {
  const out = [];
  const walk = (groups, path) => {
    for (const g of groups || []) {
      if (out.length >= cap) return;
      const gPath = [...path, g.DisplayName].filter(Boolean);
      for (const a of g.Attributes || []) {
        if (out.length >= cap) return;
        if (a.ComplianceStatus === 1) continue;
        out.push({
          group: gPath.join(' > ') || null,
          attribute: a.DisplayName || null,
          expected: a.ExpectedValue ?? null,
          current: a.Value ?? null, // current value field is "Value", not "CurrentValue"
          reason: a.ComplianceReason || null,
        });
      }
      walk(g.ComplianceSubAttributeGroups, gPath);
    }
  };
  walk(detail?.ComplianceAttributeGroups, []);
  return out;
}

/**
 * Configuration compliance: all baselines, their per-device reports, and — for
 * non-compliant devices only (capped) — the attribute-level detail of what
 * drifted and why. Baseline listing failure throws (caller treats the sweep as
 * unavailable); per-baseline/per-device failures degrade quietly.
 */
async function fetchConfigCompliance(ome, coreApi, detailCap = 100) {
  const rawBaselines = await oGetAllSkip(ome, coreApi, '/api/TemplateService/Baselines');
  const baselines = rawBaselines.map((b) => ({
    baselineId: b.Id, name: b.Name || null, description: b.Description || null,
    templateId: b.TemplateId ?? null, templateName: b.TemplateName || null,
    lastRun: b.LastRun || null,
    complianceStatus: b.ConfigComplianceSummary?.ComplianceStatus || null,
    nCritical: num(b.ConfigComplianceSummary?.NumberOfCritical),
    nWarning: num(b.ConfigComplianceSummary?.NumberOfWarning),
    nNormal: num(b.ConfigComplianceSummary?.NumberOfNormal),
    nIncomplete: num(b.ConfigComplianceSummary?.NumberOfIncomplete ?? b.ConfigComplianceSummary?.NumberOfDowngrade),
    taskId: b.TaskId ?? null,
    percentComplete: b.PercentageComplete != null ? String(b.PercentageComplete) : null,
  }));
  const reports = [];
  let detailBudget = detailCap;
  for (const b of baselines) {
    let rows = [];
    try {
      rows = await oGetAllSkip(ome, coreApi, `/api/TemplateService/Baselines(${b.baselineId})/DeviceConfigComplianceReports`);
    } catch (err) {
      coreApi.logger.debug(`[dellApi] config compliance reports failed for baseline ${b.baselineId}: ${errMsg(err)}`);
      continue;
    }
    for (const r of rows) {
      const status = complianceStatusName(r.ComplianceStatus);
      const report = {
        baselineId: b.baselineId, baselineName: b.name,
        deviceId: r.Id ?? null, // report Id IS the OME device id
        deviceName: r.DeviceName || null, serviceTag: r.ServiceTag || null,
        model: r.Model || null, status,
        inventoryTime: r.InventoryTime || null,
        detail: null,
      };
      if (status === 'noncompliant' && detailBudget > 0) {
        detailBudget -= 1;
        try {
          const d = await oGet(ome, coreApi, `/api/TemplateService/Baselines(${b.baselineId})/DeviceConfigComplianceReports(${r.Id})/DeviceComplianceDetails`);
          report.detail = flattenComplianceDetail(d);
        } catch (err) {
          coreApi.logger.debug(`[dellApi] compliance detail failed for baseline ${b.baselineId} device ${r.Id}: ${errMsg(err)}`);
        }
      }
      reports.push(report);
    }
  }
  return { baselines, reports };
}

const JOB_STATUS_MAP = {
  2020: 'Scheduled', 2030: 'Queued', 2040: 'Starting', 2050: 'Running',
  2060: 'Completed', 2070: 'Failed', 2080: 'New', 2090: 'Warning',
  2100: 'Aborted', 2101: 'Paused', 2102: 'Stopped', 2103: 'Canceled', 2200: 'NotRun',
};
const jobStatusName = (o) => o?.Name || JOB_STATUS_MAP[o?.Id ?? o] || (o != null ? String(o?.Id ?? o) : null);

/** Console Monitor > Jobs. Everything is kept (Builtin/Visible stored so the
 *  UI can default to user-relevant jobs); timestamps are appliance-local. */
async function fetchJobs(ome, coreApi) {
  const rows = await oGetAllSkip(ome, coreApi, '/api/JobService/Jobs');
  return rows.map((j) => ({
    jobId: j.Id,
    name: j.JobName || null,
    description: j.JobDescription || null,
    jobType: j.JobType?.Name || (j.JobType?.Id != null ? String(j.JobType.Id) : null),
    internal: j.JobType?.Internal === true ? 1 : 0,
    state: j.State || null,
    builtin: j.Builtin === true ? 1 : 0, // field is "Builtin" — the doc table's "BuiltIn" is a typo
    visible: j.Visible === false ? 0 : 1,
    lastRunStatusId: j.LastRunStatus?.Id ?? null,
    lastRunStatus: jobStatusName(j.LastRunStatus),
    jobStatus: jobStatusName(j.JobStatus),
    lastRun: j.LastRun || null,
    nextRun: j.NextRun || null,
    startTime: j.StartTime || null,
    endTime: j.EndTime || null,
    schedule: j.Schedule || null,
    createdBy: j.CreatedBy || null,
    targets: Array.isArray(j.Targets)
      ? j.Targets.map((t) => t?.Data).filter(Boolean).slice(0, 20).join(', ') || null
      : null,
  }));
}

// ProfileState values from Dell's shipping ome_profile.py: 0 unassigned,
// 1 assigned (auto-deploy identifier), 4 deployed; 2/3 are transitional.
const PROFILE_STATE_MAP = { 0: 'unassigned', 1: 'assigned', 2: 'assigning', 3: 'deploying', 4: 'deployed' };

/** Console Configuration > Profiles (ProfileService, OME 3.4+). */
async function fetchConfigProfiles(ome, coreApi) {
  const rows = await oGetAllSkip(ome, coreApi, '/api/ProfileService/Profiles');
  return rows.map((p) => ({
    profileId: p.Id,
    name: p.ProfileName || null,
    description: p.ProfileDescription || null,
    templateId: p.TemplateId ?? null,
    templateName: p.TemplateName || null,
    targetId: p.TargetId || null,
    targetName: p.TargetName || null,
    chassisName: p.ChassisName || null,
    state: PROFILE_STATE_MAP[p.ProfileState] || (p.ProfileState != null ? String(p.ProfileState) : null),
    // Profile LastRunStatus is a BARE integer, unlike jobs' {Id, Name} object.
    lastRunStatusId: typeof p.LastRunStatus === 'object' ? (p.LastRunStatus?.Id ?? null) : (p.LastRunStatus ?? null),
    lastRunStatus: jobStatusName(p.LastRunStatus),
    profileModified: p.ProfileModified ? 1 : 0,
    createdBy: p.CreatedBy || null,
    createdDate: p.CreatedDate || null,
    lastDeployDate: p.LastDeployDate || null,
  }));
}

// Hardware-log severity is a THIRD scheme (not alerts' 1/2/4/8/16, not the
// device 1000-health map): 1000 Info / 2000 Warning / 3000 Critical / 4000 Fatal.
const HWLOG_SEVERITY_MAP = { 1000: 'info', 2000: 'warning', 3000: 'critical', 4000: 'fatal' };

/** iDRAC Lifecycle/SEL log for one device (console device "Hardware Logs" tab).
 *  No server-side $filter — dedupe happens at store time on (device, LogId).
 *  Page size falls back 500 → 100 → unpaged: some builds cap this endpoint's
 *  $top. */
async function fetchHardwareLogs(ome, coreApi, deviceId, maxPages = 8) {
  const path = `/api/DeviceService/Devices(${deviceId})/HardwareLogs`;
  let rows;
  try {
    rows = await oGetAllSkip(ome, coreApi, path, { maxPages });
  } catch (errTop500) {
    try {
      rows = await oGetAllSkip(ome, coreApi, path, { top: 100, maxPages: maxPages * 5 });
    } catch (errTop100) {
      const data = await oGet(ome, coreApi, path); // last resort: whatever one call returns
      rows = data?.value || [];
    }
  }
  return rows.map((l) => ({
    deviceId,
    logId: l.LogId || (l.LogSequenceNumber != null ? `seq:${l.LogSequenceNumber}` : null),
    seq: num(l.LogSequenceNumber),
    severity: HWLOG_SEVERITY_MAP[l.LogSeverity] || (l.LogSeverity != null ? String(l.LogSeverity) : 'unknown'),
    category: l.LogCategory || null,
    messageId: l.LogMessageId || null,
    message: l.LogMessage || null,
    comment: l.LogComment || null,
    createdAt: normalizeTimestamp(l.LogTimestamp),
  })).filter((l) => l.logId != null);
}

/** Raw audit-domain diagnostic (compliance/jobs/profiles/hardware logs): first
 *  raw item of each listing so the parsers can be matched to the appliance's
 *  actual shapes — same role as probeInventory for the inventory parsers. */
async function probeAudit(ome, coreApi, deviceId = null) {
  const out = {};
  const attempt = async (key, fn) => {
    try { out[key] = await fn(); } catch (err) { out[key] = { error: errMsg(err) }; }
  };
  await attempt('baselines', async () => {
    const d = await oGet(ome, coreApi, '/api/TemplateService/Baselines?$top=3');
    const first = (d?.value || [])[0] || null;
    const res = { count: d?.['@odata.count'] ?? null, first };
    if (first) {
      await attempt('deviceReports', async () => {
        const r = await oGet(ome, coreApi, `/api/TemplateService/Baselines(${first.Id})/DeviceConfigComplianceReports?$top=5`);
        const rows = r?.value || [];
        const bad = rows.find((x) => complianceStatusName(x.ComplianceStatus) === 'noncompliant');
        const rep = { count: r?.['@odata.count'] ?? null, first: rows[0] || null };
        if (bad) {
          await attempt('complianceDetail', async () => oGet(ome, coreApi,
            `/api/TemplateService/Baselines(${first.Id})/DeviceConfigComplianceReports(${bad.Id})/DeviceComplianceDetails`));
        }
        return rep;
      });
    }
    return res;
  });
  await attempt('jobs', async () => {
    const d = await oGet(ome, coreApi, '/api/JobService/Jobs?$top=3');
    return { count: d?.['@odata.count'] ?? null, first: (d?.value || [])[0] || null };
  });
  await attempt('profiles', async () => {
    const d = await oGet(ome, coreApi, '/api/ProfileService/Profiles?$top=3');
    return { count: d?.['@odata.count'] ?? null, first: (d?.value || [])[0] || null };
  });
  if (deviceId != null) {
    await attempt('hardwareLogs', async () => {
      const d = await oGet(ome, coreApi, `/api/DeviceService/Devices(${deviceId})/HardwareLogs?$top=3`);
      return { count: d?.['@odata.count'] ?? null, first: (d?.value || [])[0] || null };
    });
    await attempt('hardwareLogsPage500', async () => {
      const d = await oGet(ome, coreApi, `/api/DeviceService/Devices(${deviceId})/HardwareLogs?$top=500&$skip=0`);
      return { returned: (d?.value || []).length, count: d?.['@odata.count'] ?? null };
    });
    await attempt('logSeverities', () => oGet(ome, coreApi, `/api/DeviceService/Devices(${deviceId})/LogSeverities`));
  }
  return out;
}

// ── Connection test ─────────────────────────────────────────────────────────

async function testConnection(candidate, coreApi) {
  try {
    const probe = { ...candidate, id: `test-${candidate.host}` };
    await getSession(probe, coreApi, true);
    const data = await oGet(probe, coreApi, '/api/DeviceService/Devices?$top=1');
    sessions.delete(probe.id);
    const count = data?.['@odata.count'] ?? (data?.value?.length ?? 0);
    return { ok: true, message: `Connected — ${count} managed device(s) visible.` };
  } catch (err) {
    return { ok: false, message: omeErrorMessage(err) || err.message || 'Connection failed' };
  }
}

module.exports = {
  fetchApplianceInfo, fetchDeviceTypeMap, fetchDevices, fetchDeviceInventory,
  summarizeComponents, fetchAlerts, probeAlerts, fetchWarranties, fetchFirmwareCompliance,
  fetchDeviceMetrics, fetchDevicePowerThermal, probeInventory, testConnection, invalidateSession,
  fetchConfigCompliance, fetchJobs, fetchConfigProfiles, fetchHardwareLogs, probeAudit,
  cimToIso, normalizeTimestamp, complianceStatusName, flattenComplianceDetail, errMsg,
};
