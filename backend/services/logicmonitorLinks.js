// LogicMonitor link bursts and per-device interface evidence (agent signals).
//
// One interface going down is a port story. Several going down inside a short
// window across more than one device is one event (a power loss, an upstream
// failure, a bad change), and the Ops Agent should see it as one. This module
// reads lm_interface_history for status transitions (1 up to 2 down), turns a
// cluster of them into a 'link-burst' issue, and builds the interface lines the
// Ops Agent evidence block carries for a device and for the estate.
//
// Everything is derived from stored rows. Cutoffs are built in JS and bound
// (history timestamps are zoneless UTC "YYYY-MM-DD HH:MM:SS").
const lmPath = require('./logicmonitorPath');

const SCAN_MARGIN_MINUTES = 30; // two interface poll intervals before the window opens
const NAME_CAP = 6;

const sqlStamp = (ms) => new Date(ms).toISOString().replace('T', ' ').slice(0, 19);
const sqlToIso = (s) => (s ? new Date(`${String(s).replace(' ', 'T')}Z`).toISOString() : null);
const shortStamp = (iso) => (iso ? `${String(iso).slice(0, 16).replace('T', ' ')} UTC` : '');

function threshold(key, fallback) {
  try {
    const v = require('./logicmonitorIssues').getThreshold(key);
    return v == null ? fallback : v;
  } catch { return fallback; }
}

/**
 * Interfaces that went down inside the window and are still down. Walks
 * lm_interface_history per interface in time order and keeps a transition from
 * status 1 to status 2 whose time is inside the window; the scan starts a
 * couple of poll intervals earlier so the row before the transition is seen.
 * Returns [{ sourceId, instanceId, deviceId, device, deviceAlt, port, at, siteKey, siteName }].
 */
function recentDownTransitions(dbh, { minutes, nowMs = Date.now() } = {}) {
  const win = minutes || threshold('lm_link_burst_minutes', 30);
  const from = sqlStamp(nowMs - win * 60000);
  const scanFrom = sqlStamp(nowMs - (win + SCAN_MARGIN_MINUTES) * 60000);
  const rows = dbh.prepare(`
    SELECT source_id, instance_id, captured_at, status FROM lm_interface_history
    WHERE captured_at >= ? AND status IS NOT NULL ORDER BY source_id, instance_id, captured_at, id
  `).all(scanFrom);
  const found = [];
  let key = null;
  let prev = null;
  let hit = null;
  const flush = () => { if (hit && prev === 2) found.push(hit); hit = null; };
  for (const r of rows) {
    const k = `${r.source_id}|${r.instance_id}`;
    if (k !== key) { flush(); key = k; prev = null; }
    if (r.status === 2 && prev === 1 && r.captured_at >= from) hit = { sourceId: r.source_id, instanceId: r.instance_id, at: r.captured_at };
    else if (r.status === 1) hit = null;
    prev = r.status;
  }
  flush();
  if (!found.length) return [];
  const info = dbh.prepare(`
    SELECT i.lm_device_id, i.display_name, i.instance_name, i.stale, i.stop_monitoring,
      d.display_name AS dev_display, d.name AS dev_name, d.site_key, d.site_name
    FROM lm_interfaces i LEFT JOIN lm_devices d ON d.source_id = i.source_id AND d.lm_device_id = i.lm_device_id
    WHERE i.source_id = ? AND i.instance_id = ?
  `);
  const out = [];
  for (const f of found) {
    const r = info.get(f.sourceId, f.instanceId);
    if (!r || r.stale || r.stop_monitoring) continue;
    const device = r.dev_display || r.dev_name;
    if (!device) continue;
    out.push({
      sourceId: f.sourceId, instanceId: f.instanceId, deviceId: r.lm_device_id, device, deviceAlt: r.dev_name || null,
      port: r.display_name || r.instance_name || String(f.instanceId), at: sqlToIso(f.at), siteKey: r.site_key || null, siteName: r.site_name || null,
    });
  }
  return out.sort((a, b) => (a.at < b.at ? -1 : a.at > b.at ? 1 : 0));
}

/** Bursts in a transition list: per source, at least `min` interfaces on at least 2 devices. */
function burstsFrom(list, min) {
  const bySource = new Map();
  for (const r of list) {
    if (!bySource.has(r.sourceId)) bySource.set(r.sourceId, []);
    bySource.get(r.sourceId).push(r);
  }
  const bursts = [];
  for (const [sourceId, items] of bySource) {
    const devices = new Set(items.map((i) => `${i.sourceId}:${i.deviceId}`));
    if (items.length < min || devices.size < 2) continue;
    const siteKeys = new Set(items.map((i) => i.siteKey || ''));
    const target = siteKeys.size === 1 && !siteKeys.has('') ? [...siteKeys][0] : 'estate';
    const siteNames = [];
    for (const i of items) {
      const s = i.siteName || i.siteKey;
      if (s && !siteNames.includes(s)) siteNames.push(s);
    }
    const names = new Set();
    for (const i of items) { names.add(String(i.device).toLowerCase()); if (i.deviceAlt) names.add(String(i.deviceAlt).toLowerCase()); }
    bursts.push({ sourceId, interfaces: items, deviceCount: devices.size, sites: siteNames, target, deviceNames: names });
  }
  return bursts;
}

/** Current bursts straight from history: [{ sourceId, interfaces, deviceCount, sites, target, deviceNames:Set }]. */
function currentBursts(dbh, { nowMs = Date.now() } = {}) {
  const minutes = threshold('lm_link_burst_minutes', 30);
  const min = threshold('lm_link_burst_min', 5);
  return burstsFrom(recentDownTransitions(dbh, { minutes, nowMs }), min);
}

/** Issue rows for computeIssues. srcName is a Map of source id to name. */
function linkBurstIssues(dbh, t, srcName, nowMs = Date.now()) {
  const minutes = t.lm_link_burst_minutes;
  const bursts = burstsFrom(recentDownTransitions(dbh, { minutes, nowMs }), t.lm_link_burst_min);
  return bursts.map((b) => {
    const list = b.interfaces.slice(0, NAME_CAP).map((i) => `${i.device} ${i.port}`).join(', ');
    const more = b.interfaces.length > NAME_CAP ? `, and ${b.interfaces.length - NAME_CAP} more` : '';
    return {
      severity: 'critical', type: 'link-burst', source: (srcName && srcName.get ? srcName.get(b.sourceId) : null) || String(b.sourceId), target: b.target,
      message: `${b.interfaces.length} interfaces went down in the last ${minutes} min on ${b.deviceCount} devices${b.sites.length ? ` (sites ${b.sites.join(', ')})` : ''}: ${list}${more}`,
    };
  });
}

const hasOpenBurst = (dbh) => !!dbh.prepare("SELECT 1 FROM lm_issue_history WHERE status = 'open' AND type = 'link-burst' LIMIT 1").get();

/** "Links down estate-wide in the last N min: X on Y devices (sites)" while a link-burst issue is open, else null. */
function estateBurstLine(dbh, { nowMs = Date.now() } = {}) {
  try {
    if (!hasOpenBurst(dbh)) return null;
    const bursts = currentBursts(dbh, { nowMs });
    if (!bursts.length) return null;
    const n = bursts.reduce((s, b) => s + b.interfaces.length, 0);
    const m = bursts.reduce((s, b) => s + b.deviceCount, 0);
    const sites = [...new Set(bursts.flatMap((b) => b.sites))];
    return `Links down estate-wide in the last ${threshold('lm_link_burst_minutes', 30)} min: ${n} on ${m} devices${sites.length ? ` (${sites.join(', ')})` : ''}`;
  } catch { return null; }
}

const COUNT_TYPES = {
  flapping: ['interface-flapping'],
  errors: ['interface-errors-growing', 'interface-error-anomaly'],
};

/**
 * One evidence line for a device row (lm_devices columns source_id, lm_device_id, display_name, name):
 * "Interfaces on <device>: N down now (<names, down since>), M flapping in 24 h, K with errors rising,
 * J open LM interface alerts". Null when every count is 0.
 */
function deviceInterfaceLines(dbh, device) {
  try {
    if (!device) return [];
    const label = device.display_name || device.name;
    const sid = device.source_id;
    const down = dbh.prepare(`
      SELECT instance_id, display_name, instance_name FROM lm_interfaces
      WHERE source_id = ? AND lm_device_id = ? AND stale = 0 AND COALESCE(stop_monitoring, 0) = 0 AND (status = 2 OR status_text = 'down')
      ORDER BY display_name
    `).all(sid, device.lm_device_id);
    const ctx = lmPath.makeContext(dbh);
    const downText = down.slice(0, 4).map((r) => {
      const since = ctx.downSince(sid, r.instance_id);
      return `${r.display_name || r.instance_name}${since ? ` since ${shortStamp(since)}` : ''}`;
    });
    if (down.length > 4) downText.push(`${down.length - 4} more`);
    const prefixes = [device.display_name, device.name].filter(Boolean).map((n) => `${String(n).toLowerCase()} `);
    const ofDevice = (target) => prefixes.some((p) => String(target || '').toLowerCase().startsWith(p));
    const open = dbh.prepare("SELECT type, target FROM lm_issue_history WHERE status = 'open' AND type LIKE 'interface-%'").all().filter((r) => ofDevice(r.target));
    const flapping = open.filter((r) => COUNT_TYPES.flapping.includes(r.type)).length;
    const errors = open.filter((r) => COUNT_TYPES.errors.includes(r.type)).length;
    const alerts = dbh.prepare(`
      SELECT COUNT(*) n FROM lm_alerts WHERE source_id = ? AND lm_device_id = ? AND cleared = 0 AND duplicate_of IS NULL
        AND (resource_template_name GLOB 'Network Interfaces*' OR resource_template_name GLOB 'SNMP_Network_Interfaces*')
    `).get(sid, device.lm_device_id).n;
    if (!down.length && !flapping && !errors && !alerts) return [];
    return [`Interfaces on ${label}: ${down.length} down now${downText.length ? ` (${downText.join(', ')})` : ''}, ${flapping} flapping in 24 h, ${errors} with errors rising, ${alerts} open LM interface alerts`];
  } catch { return []; }
}

/** Open LM interface-DataSource alerts on the devices of a site (the site line suffix). */
function siteInterfaceAlertCount(dbh, sourceId, siteKey) {
  try {
    return dbh.prepare(`
      SELECT COUNT(*) n FROM lm_alerts a JOIN lm_devices d ON d.source_id = a.source_id AND d.lm_device_id = a.lm_device_id
      WHERE a.source_id = ? AND d.site_key = ? AND d.stale = 0 AND a.cleared = 0 AND a.duplicate_of IS NULL
        AND (a.resource_template_name GLOB 'Network Interfaces*' OR a.resource_template_name GLOB 'SNMP_Network_Interfaces*')
    `).get(sourceId, siteKey).n;
  } catch { return 0; }
}

module.exports = {
  recentDownTransitions, burstsFrom, currentBursts, linkBurstIssues, estateBurstLine, deviceInterfaceLines, hasOpenBurst, siteInterfaceAlertCount,
};
