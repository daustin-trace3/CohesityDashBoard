// vCenter stand-in for Dell Power Manager utilization. Dell servers running
// ESXi are matched to vcenter_hosts rows by the OS hostname OME reports, and
// the host quickstats supply CPU/memory percentages when no OME has the
// Power Manager plugin.
//
// vCenter names a host by whatever it was added as (usually the FQDN), while
// OME's OperatingSystem hostname is what ESXi itself reports (often the short
// name), so an exact match is tried first and a short-name match is the
// fallback. IP-literal names are never shortened, and a short name that two
// vCenter hosts share (same host name in two domains) is treated as no match
// rather than picking one at random.

const IPV4 = /^\d{1,3}(\.\d{1,3}){3}$/;

function norm(name) {
  return String(name || '').trim().toLowerCase();
}

function shortHost(name) {
  const n = norm(name);
  return IPV4.test(n) ? n : n.split('.')[0];
}

/**
 * Per-device utilization derived from vCenter quickstats.
 * Returns [{ name, hostname, cpu_util_pct, mem_util_pct }], one per matched
 * ESXi device; empty when the vCenter tables are missing or hold no stats.
 */
function vcenterHostUtilization(db) {
  const hosts = db.prepare(`
    SELECT name, cpu_mhz_used, cpu_mhz_capacity, mem_bytes_used, mem_bytes_capacity
    FROM vcenter_hosts
    WHERE name IS NOT NULL
      AND cpu_mhz_used IS NOT NULL AND cpu_mhz_capacity > 0
      AND mem_bytes_used IS NOT NULL AND mem_bytes_capacity > 0
  `).all();
  if (!hosts.length) return [];
  const exact = new Map();
  const short = new Map(); // short name -> host, or null when ambiguous
  for (const h of hosts) {
    exact.set(norm(h.name), h);
    const s = shortHost(h.name);
    short.set(s, short.has(s) ? null : h);
  }
  const rows = db.prepare(`
    SELECT COALESCE(d.name, json_extract(c.extra, '$.hostname')) AS name,
           json_extract(c.extra, '$.hostname') AS hostname
    FROM dell_components c
    LEFT JOIN dell_devices d ON d.ome_id = c.ome_id AND d.device_id = c.device_id
    WHERE c.kind = 'os' AND json_extract(c.extra, '$.hostname') IS NOT NULL
  `).all();
  const out = [];
  for (const r of rows) {
    const h = exact.get(norm(r.hostname)) || short.get(shortHost(r.hostname)) || null;
    if (!h) continue;
    out.push({
      name: r.name,
      hostname: r.hostname,
      cpu_util_pct: (h.cpu_mhz_used / h.cpu_mhz_capacity) * 100,
      mem_util_pct: (h.mem_bytes_used / h.mem_bytes_capacity) * 100,
    });
  }
  return out;
}

function hasColumns(db, table, cols) {
  try {
    const have = new Set(db.prepare(`PRAGMA table_info('${table}')`).all().map((c) => c.name));
    return cols.filter((c) => have.has(c));
  } catch { return []; }
}

/**
 * Dell device row id -> vCenter host name, joined first on the service tag
 * (vcenter_hosts.service_tag, then vcenter_hosts.serial, against
 * dell_devices.service_tag, case-insensitive), then on the OS hostname OME
 * reports (dell_devices.os_hostname, else the OS component hostname), exact
 * then short name, ambiguous short names skipped. A service tag match always
 * beats a hostname match; a host is paired with at most one device.
 * Returns { byDevice: Map<dell_devices.id, hostName>, byHost: Map<hostName, dell_devices.id> }.
 * vcenter_hosts.service_tag / serial are round 9 columns; absent columns just
 * leave the tag join empty.
 */
function dellHostLinks(db) {
  const byDevice = new Map();
  const byHost = new Map();
  try {
    const tagCols = hasColumns(db, 'vcenter_hosts', ['service_tag', 'serial']);
    const hosts = db.prepare('SELECT name' + (tagCols.length ? ', ' + tagCols.join(', ') : '') + ' FROM vcenter_hosts WHERE name IS NOT NULL').all();
    if (!hosts.length) return { byDevice, byHost };
    const osCol = hasColumns(db, 'dell_devices', ['os_hostname']).length ? 'd.os_hostname' : 'NULL';
    const devices = db.prepare(`
      SELECT d.id, d.name, d.service_tag, ${osCol} AS os_hostname,
        (SELECT json_extract(c.extra, '$.hostname') FROM dell_components c
          WHERE c.ome_id = d.ome_id AND c.device_id = d.device_id AND c.kind = 'os' LIMIT 1) AS comp_hostname
      FROM dell_devices d
    `).all();
    const link = (devId, hostName) => {
      if (byDevice.has(devId) || byHost.has(hostName)) return;
      byDevice.set(devId, hostName);
      byHost.set(hostName, devId);
    };
    const tagToHost = new Map();
    for (const h of hosts) {
      for (const c of tagCols) {
        const t = norm(h[c]);
        if (t && !tagToHost.has(t)) tagToHost.set(t, h.name);
      }
    }
    for (const d of devices) {
      const t = norm(d.service_tag);
      if (t && tagToHost.has(t)) link(d.id, tagToHost.get(t));
    }
    const exact = new Map();
    const short = new Map();
    for (const h of hosts) {
      exact.set(norm(h.name), h.name);
      const s = shortHost(h.name);
      short.set(s, short.has(s) ? null : h.name);
    }
    for (const d of devices) {
      if (byDevice.has(d.id)) continue;
      const hn = d.os_hostname || d.comp_hostname;
      if (!hn) continue;
      const host = exact.get(norm(hn)) || short.get(shortHost(hn)) || null;
      if (host) link(d.id, host);
    }
  } catch { /* vCenter or Dell tables missing: no links */ }
  return { byDevice, byHost };
}

module.exports = { vcenterHostUtilization, shortHost, dellHostLinks };
