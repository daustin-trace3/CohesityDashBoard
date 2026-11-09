// LogicMonitor fleet hygiene for the derived platforms (Cisco, F5): software version spread, availability
// from lm_device_daily, alert noise and mean time to clear, and reboots. Pure of the db singleton (every
// function takes the database handle) and read-only. Also exports the small device loader the other
// analytics modules share.

const DAY_MS = 86400000;
const dayOfMs = (ms) => new Date(ms).toISOString().slice(0, 10);
const r1 = (v) => (v == null || !Number.isFinite(v) ? null : Math.round(v * 10) / 10);
const r2 = (v) => (v == null || !Number.isFinite(v) ? null : Math.round(v * 100) / 100);

const tableExists = (dbh, name) => {
  try { return !!dbh.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?").get(name); } catch { return false; }
};

/** Vendor keys a feed call covers: the key itself, plus meraki under cisco when includeMeraki is set. null = every vendor. */
function vendorKeysOf(p = {}) {
  if (Array.isArray(p.vendorKeys) && p.vendorKeys.length) return p.vendorKeys.map(String);
  if (!p.vendorKey) return null;
  const keys = [String(p.vendorKey)];
  if (p.vendorKey === 'cisco' && (p.includeMeraki === true || p.includeMeraki === 'true' || p.includeMeraki === 1 || p.includeMeraki === '1')) keys.push('meraki');
  return keys;
}

/**
 * Non-stale devices of the vendor scope as a Map "sourceId:deviceId" -> { sourceId, deviceId, device, site, siteKey,
 * model, version, vendorKey, vendorKind, hostStatus }. p: vendorKey(s), includeMeraki, deviceId, sourceId.
 */
function loadDevices(dbh, p = {}) {
  const where = ['d.stale = 0'];
  const args = [];
  const keys = vendorKeysOf(p);
  if (keys) { where.push(`d.vendor_key IN (${keys.map(() => '?').join(',')})`); args.push(...keys); }
  if (p.deviceId != null && p.deviceId !== '') { where.push('d.lm_device_id = ?'); args.push(Number(p.deviceId)); }
  if (p.sourceId != null && p.sourceId !== '') { where.push('d.source_id = ?'); args.push(Number(p.sourceId)); }
  const out = new Map();
  for (const d of dbh.prepare(`
    SELECT d.source_id, d.lm_device_id, d.display_name, d.name, d.model, d.version, d.vendor_key, d.vendor_kind, d.site_key, d.host_status,
      COALESCE(s.site_name, d.site_key) site
    FROM lm_devices d LEFT JOIN lm_sites s ON s.source_id = d.source_id AND s.site_key = d.site_key
    WHERE ${where.join(' AND ')}
  `).all(...args)) {
    out.set(`${d.source_id}:${d.lm_device_id}`, {
      sourceId: d.source_id, deviceId: d.lm_device_id, device: d.display_name || d.name, site: d.site || null, siteKey: d.site_key || null,
      model: d.model || null, version: d.version || null, vendorKey: d.vendor_key || null, vendorKind: d.vendor_kind || null, hostStatus: d.host_status || null,
    });
  }
  return out;
}

const median = (arr) => {
  const a = arr.filter((v) => v != null && Number.isFinite(v)).sort((x, y) => x - y);
  if (!a.length) return null;
  const m = Math.floor(a.length / 2);
  return a.length % 2 ? a[m] : (a[m - 1] + a[m]) / 2;
};

/**
 * Software version spread per vendor kind and model: rows { vendorKind, model, version, devices, dominant }, plus
 * the outliers (devices on a non-dominant version of a model that has a dominant one).
 */
function versionSpread(dbh, p = {}) {
  const devs = [...loadDevices(dbh, p).values()];
  const groups = new Map(); // kind|model -> Map(version -> [dev])
  for (const d of devs) {
    const k = `${d.vendorKind || ''}|${d.model || 'Unknown'}`;
    let g = groups.get(k);
    if (!g) { g = new Map(); groups.set(k, g); }
    const v = d.version || 'unknown';
    if (!g.has(v)) g.set(v, []);
    g.get(v).push(d);
  }
  const versions = [];
  const outliers = [];
  for (const [k, g] of groups) {
    const [vendorKind, model] = k.split('|');
    let top = null; let topN = 0;
    for (const [v, list] of g) if (list.length > topN || (list.length === topN && String(v) < String(top))) { top = v; topN = list.length; }
    for (const [v, list] of g) {
      versions.push({ vendorKind: vendorKind || null, model, version: v, devices: list.length, dominant: v === top });
      if (v !== top && g.size > 1) {
        for (const d of list) outliers.push({ sourceId: d.sourceId, deviceId: d.deviceId, device: d.device, site: d.site, vendorKind: d.vendorKind, model, version: v, dominantVersion: top });
      }
    }
  }
  versions.sort((a, b) => String(a.model).localeCompare(String(b.model)) || b.devices - a.devices);
  outliers.sort((a, b) => String(a.model).localeCompare(String(b.model)) || String(a.device).localeCompare(String(b.device)));
  return { versions, outliers };
}

/**
 * Availability over the last `days` days from lm_device_daily. SDT days are excluded. Per device { device, site, days,
 * normalDays, deadDays, sdtDays, availabilityPct } and a per site rollup { site, devices, availabilityPct, worstDevice }.
 */
function availability(dbh, p = {}) {
  const empty = { devices: [], sites: [] };
  if (!tableExists(dbh, 'lm_device_daily')) return empty;
  const days = Math.min(365, Math.max(1, Number(p.days) || 30));
  const devs = loadDevices(dbh, p);
  if (!devs.size) return empty;
  const since = dayOfMs(Date.now() - days * DAY_MS);
  const acc = new Map();
  for (const r of dbh.prepare('SELECT source_id, lm_device_id, day, samples, dead_samples, dead_collector_samples, sdt_samples FROM lm_device_daily WHERE day >= ?').iterate(since)) {
    const k = `${r.source_id}:${r.lm_device_id}`;
    if (!devs.has(k)) continue;
    let a = acc.get(k);
    if (!a) { a = { days: 0, normal: 0, dead: 0, sdt: 0, samples: 0, up: 0 }; acc.set(k, a); }
    a.days += 1;
    if ((r.sdt_samples || 0) > 0) { a.sdt += 1; continue; }
    const bad = (r.dead_samples || 0) + (r.dead_collector_samples || 0);
    if (bad > 0) a.dead += 1; else a.normal += 1;
    a.samples += r.samples || 0;
    a.up += Math.max(0, (r.samples || 0) - bad);
  }
  const devices = [];
  for (const [k, a] of acc) {
    const d = devs.get(k);
    devices.push({
      sourceId: d.sourceId, deviceId: d.deviceId, device: d.device, site: d.site, days: a.days, normalDays: a.normal, deadDays: a.dead, sdtDays: a.sdt,
      availabilityPct: a.samples ? r2((a.up * 100) / a.samples) : null, _s: a.samples, _u: a.up,
    });
  }
  devices.sort((a, b) => (a.availabilityPct ?? 101) - (b.availabilityPct ?? 101) || String(a.device).localeCompare(String(b.device)));
  const bySite = new Map();
  for (const d of devices) {
    const key = d.site || 'Unassigned';
    let s = bySite.get(key);
    if (!s) { s = { site: key, devices: 0, s: 0, u: 0, worst: null }; bySite.set(key, s); }
    s.devices += 1; s.s += d._s; s.u += d._u;
    if (d.availabilityPct != null && (!s.worst || d.availabilityPct < s.worst.availabilityPct)) s.worst = d;
  }
  const sites = [...bySite.values()].map((s) => ({
    site: s.site, devices: s.devices, availabilityPct: s.s ? r2((s.u * 100) / s.s) : null, worstDevice: s.worst ? s.worst.device : null,
  })).sort((a, b) => (a.availabilityPct ?? 101) - (b.availabilityPct ?? 101));
  for (const d of devices) { delete d._s; delete d._u; }
  return { devices, sites };
}

/**
 * Alert noise over `days`: byDataSource and byDevice with alert counts and the median minutes a cleared alert took
 * to clear, and repeatOffenders (same device and alert type, 3 or more in 7 days: the Ops Agent's repeat rule).
 * Alerts that duplicate a feed ICC polls directly and alerts shadowed by a parent are left out.
 */
function alertNoise(dbh, p = {}) {
  const out = { byDataSource: [], byDevice: [], repeatOffenders: [] };
  if (!tableExists(dbh, 'lm_alerts')) return out;
  const days = Math.min(365, Math.max(1, Number(p.days) || 30));
  const devs = loadDevices(dbh, p);
  if (!devs.size) return out;
  const cutoff = Math.floor((Date.now() - days * DAY_MS) / 1000);
  const cut7 = Math.floor((Date.now() - 7 * DAY_MS) / 1000);
  const rows = dbh.prepare(`
    SELECT source_id, lm_device_id, resource_template_name ds, severity_norm sev, start_epoch s, end_epoch e, cleared
    FROM lm_alerts WHERE start_epoch >= ? AND duplicate_of IS NULL AND lm_device_id IS NOT NULL
      AND (shadowed_by IS NULL OR shadowed_by IN ('', 'null', '[]'))
  `).all(cutoff);
  const byDs = new Map(); const byDev = new Map(); const rep = new Map();
  const bump = (map, key, init, a) => {
    let x = map.get(key);
    if (!x) { x = { ...init, alerts: 0, critical: 0, clear: [] }; map.set(key, x); }
    x.alerts += 1;
    if (a.sev === 'critical') x.critical += 1;
    if (a.cleared === 1 && a.e && a.s && a.e >= a.s) x.clear.push((a.e - a.s) / 60);
    return x;
  };
  for (const a of rows) {
    const d = devs.get(`${a.source_id}:${a.lm_device_id}`);
    if (!d) continue;
    const ds = a.ds || 'unknown';
    bump(byDs, ds, { name: ds }, a);
    bump(byDev, `${d.sourceId}:${d.deviceId}`, { sourceId: d.sourceId, deviceId: d.deviceId, device: d.device, site: d.site }, a);
    if (a.s >= cut7) {
      const k = `${d.sourceId}:${d.deviceId}|${ds}`;
      const x = rep.get(k) || { device: d.device, site: d.site, type: ds, count7d: 0 };
      x.count7d += 1; rep.set(k, x);
    }
  }
  const fin = (x) => { const o = { ...x, medianMinutesToClear: x.clear.length ? r1(median(x.clear)) : null }; delete o.clear; return o; };
  out.byDataSource = [...byDs.values()].map(fin).sort((a, b) => b.alerts - a.alerts).slice(0, 25);
  out.byDevice = [...byDev.values()].map(fin).sort((a, b) => b.alerts - a.alerts).slice(0, 25);
  out.repeatOffenders = [...rep.values()].filter((x) => x.count7d >= 3).sort((a, b) => b.count7d - a.count7d).slice(0, 50);
  return out;
}

/** Reboot findings (lm_trend_findings kind reboot) with their event days: [{ device, site, count, events }]. */
function reboots(dbh, p = {}) {
  if (!tableExists(dbh, 'lm_trend_findings')) return [];
  const days = Math.min(365, Math.max(1, Number(p.days) || 90));
  const cut = dayOfMs(Date.now() - days * DAY_MS);
  const devs = loadDevices(dbh, p);
  const out = [];
  for (const r of dbh.prepare("SELECT source_id, lm_device_id, detail_json FROM lm_trend_findings WHERE kind = 'reboot'").all()) {
    const d = devs.get(`${r.source_id}:${r.lm_device_id}`);
    if (!d) continue;
    let ev = [];
    try { ev = (JSON.parse(r.detail_json).events || []).filter((e) => e.day >= cut); } catch { ev = []; }
    if (ev.length) out.push({ sourceId: d.sourceId, deviceId: d.deviceId, device: d.device, site: d.site, count: ev.length, events: ev });
  }
  return out.sort((a, b) => b.count - a.count);
}

module.exports = { vendorKeysOf, loadDevices, versionSpread, availability, alertNoise, reboots, median, tableExists };
