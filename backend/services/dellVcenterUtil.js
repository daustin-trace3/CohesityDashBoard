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

module.exports = { vcenterHostUtilization, shortHost };
