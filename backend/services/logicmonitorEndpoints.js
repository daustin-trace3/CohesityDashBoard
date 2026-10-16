// LogicMonitor switch port to endpoint correlation (round 2, 2026-10-14).
//
// LogicMonitor's REST API has no MAC table and no endpoint-per-port call, so
// ICC builds the "what is plugged into this port" view from two sources:
//   (a) lm_topology_links rows whose far end resolved to another ICC
//       platform's host inventory (dst_platform set, not 'logicmonitor'):
//       interface descriptions and LLDP/CDP neighbour instances;
//   (b) vCenter physical NIC neighbour hints (vcenter_host_nic_neighbors,
//       CDP/LLDP as seen by each ESXi vmnic), whose switch name or address
//       resolves to an lm_devices row and whose port is matched to the
//       switch's lm_interfaces row.
// It also builds the ICC host index the topology link builder resolves far
// ends against, and the server-object path (switch ports, one hop of
// uplinks, reachability checks) used by /server-path, the topology hook and
// Server 360. Every read of a table outside lm_* is guarded; nothing here
// throws on a missing table.

const hostIdentity = require('./hostIdentity');

const IPV4 = /^\d{1,3}(\.\d{1,3}){3}$/;
const ENDPOINT_CAP = 5000;

function tableExists(dbh, name) {
  try { return !!dbh.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?").get(name); } catch { return false; }
}
function columnsOf(dbh, table) {
  try { return new Set(dbh.prepare(`PRAGMA table_info('${table}')`).all().map((c) => c.name)); } catch { return new Set(); }
}
const norm = (s) => String(s == null ? '' : s).trim().toLowerCase();
/** Short host name; IP literals are never shortened (dellVcenterUtil rule). */
const shortName = (s) => { const n = norm(s); return IPV4.test(n) ? n : n.split('.')[0]; };
const parseJson = (s, fallback) => {
  if (s == null || s === '') return fallback;
  try { const v = JSON.parse(s); return v == null ? fallback : v; } catch { return fallback; }
};
function sqlIso(val) {
  if (!val) return null;
  const s = String(val);
  const d = new Date(/[TZ]/.test(s) || /[+-]\d\d:?\d\d$/.test(s) ? s : `${s.replace(' ', 'T')}Z`);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

// -- ICC host index (C1) ---------------------------------------------------------

/**
 * Lower-cased name -> {platform, ref} over every ICC host inventory table that
 * exists. Order decides which platform wins an exact name two platforms share
 * (an ESXi host on a Dell server stays 'vcenter', the hint join keys on it).
 * Short names (before the first dot) index too, but a short name two
 * different refs share is treated as no match (dellVcenterUtil rule).
 */
function buildIccHostIndex(dbh) {
  const exact = new Map();
  const short = new Map();
  const add = (platform, raw) => {
    const ref = norm(raw);
    if (!ref || ref.length < 3) return;
    if (!exact.has(ref)) exact.set(ref, { platform, ref });
    const s = shortName(ref);
    if (s && s !== ref && s.length >= 3) {
      const prev = short.get(s);
      if (prev === undefined) short.set(s, { platform, ref });
      else if (prev && prev.ref !== ref) short.set(s, null);
    }
  };
  const read = (table, sql, platform, cols) => {
    if (!tableExists(dbh, table)) return;
    try {
      for (const r of dbh.prepare(sql).all()) for (const c of cols) if (r[c]) add(platform, r[c]);
    } catch { /* tolerate a table whose columns differ */ }
  };
  read('vcenter_hosts', 'SELECT name FROM vcenter_hosts WHERE name IS NOT NULL', 'vcenter', ['name']);
  if (tableExists(dbh, 'dell_devices')) {
    read('dell_devices', 'SELECT name FROM dell_devices WHERE name IS NOT NULL', 'dell', ['name']);
    // OME's OS hostname is what the server calls itself (dellVcenterUtil).
    if (tableExists(dbh, 'dell_components')) {
      read('dell_components', "SELECT json_extract(extra, '$.hostname') AS hostname FROM dell_components WHERE kind = 'os' AND json_valid(extra)", 'dell', ['hostname']);
    }
  }
  if (tableExists(dbh, 'vcenter_vms')) {
    const cols = columnsOf(dbh, 'vcenter_vms');
    read('vcenter_vms', `SELECT name${cols.has('guest_hostname') ? ', guest_hostname' : ''} FROM vcenter_vms WHERE name IS NOT NULL`, 'vcenter',
      cols.has('guest_hostname') ? ['name', 'guest_hostname'] : ['name']);
  }
  read('unifi_devices', 'SELECT name FROM unifi_devices WHERE name IS NOT NULL', 'unifi', ['name']);
  read('netapp_nodes', 'SELECT name FROM netapp_nodes WHERE name IS NOT NULL', 'netapp', ['name']);
  read('pure_arrays', 'SELECT name FROM pure_arrays WHERE name IS NOT NULL', 'pure', ['name']);
  return { exact, short };
}

/** Resolver over the ICC host index; tokens the LM index knows are refused
 *  so a device's own name never resolves to another platform's copy of it. */
function makeIccResolver(iccIndex, lmIndex) {
  // Round 9: an identity index (services/hostIdentity) resolves names, IPs, MACs
  // and serials; the legacy {exact, short} index keeps working for old callers.
  if (iccIndex && iccIndex.byName) {
    return (tok) => {
      const k = norm(tok);
      if (!k || k.length < 3) return null;
      if (lmIndex && (lmIndex.has(k) || lmIndex.has(shortName(k)))) return null;
      const ref = hostIdentity.resolveToken(iccIndex, k);
      return ref ? { platform: ref.platform, ref: ref.refKey, platforms: ref.platforms } : null;
    };
  }
  return (tok) => {
    const k = norm(tok);
    if (!k || k.length < 3) return null;
    if (lmIndex && (lmIndex.has(k) || lmIndex.has(shortName(k)))) return null;
    const hit = iccIndex.exact.get(k);
    if (hit) return hit;
    const s = shortName(k);
    const sh = iccIndex.short.get(s) || null;
    if (sh) return sh;
    return iccIndex.exact.get(s) || null;
  };
}

// -- Port normalisation ------------------------------------------------------------

/** Interface name as lm_interfaces.display_name is written: " [ID:n]" gone,
 *  whitespace collapsed. */
function cleanPort(p) {
  return String(p == null ? '' : p).replace(/\s*\[ID:\d+\]\s*$/i, '').replace(/\s+/g, ' ').trim();
}
/**
 * Split a port name into a two-letter alpha prefix and its slot path:
 * "GigabitEthernet1/0/12" and "Gi1/0/12" -> {prefix 'gi', path '1/0/12'},
 * "Te1/1/1" -> {'te', '1/1/1'}, "Ethernet1/5" -> {'et', '1/5'}, "12" ->
 * {'', '12'}. Two letters are enough to tell Cisco's Fa/Gi/Te/Tw/Fo/Hu apart.
 */
function portParts(p) {
  const s = cleanPort(p).replace(/\s+/g, '');
  const m = s.match(/^([A-Za-z][A-Za-z-]*)?(\d+(?:[/.:]\d+)*)$/);
  if (!m) return null;
  return { prefix: (m[1] || '').replace(/-/g, '').slice(0, 2).toLowerCase(), path: m[2].replace(/[.:]/g, '/') };
}
/**
 * Match a reported port against a switch's interfaces. Display name equality
 * first ('exact'), then the slot path with a compatible prefix ('port-number':
 * same two letters, or one side has no prefix and the path is unique).
 * Returns {iface, quality}; quality 'none' with iface null when nothing fits.
 */
function matchPort(port, ifaces) {
  const want = norm(cleanPort(port)).replace(/\s+/g, '');
  if (!want) return { iface: null, quality: 'none' };
  const exact = ifaces.find((i) => norm(cleanPort(i.display_name)).replace(/\s+/g, '') === want);
  if (exact) return { iface: exact, quality: 'exact' };
  const wp = portParts(port);
  if (!wp) return { iface: null, quality: 'none' };
  const samePath = ifaces.filter((i) => { const ip = portParts(i.display_name); return ip && ip.path === wp.path; });
  const samePrefix = samePath.filter((i) => portParts(i.display_name).prefix === wp.prefix);
  if (wp.prefix && samePrefix.length === 1) return { iface: samePrefix[0], quality: 'port-number' };
  const loose = samePath.filter((i) => !wp.prefix || !portParts(i.display_name).prefix);
  if (loose.length === 1) return { iface: loose[0], quality: 'port-number' };
  return { iface: null, quality: 'none' };
}

// -- Switch index for the vCenter hints -------------------------------------------

/** Lower name/short/ip -> lm_devices row, over network devices of every
 *  source (CDP devIds often carry a "(SERIAL)" tail, stripped on lookup). */
function buildSwitchIndex(dbh) {
  const byName = new Map();
  const byIp = new Map();
  const rows = dbh.prepare(`
    SELECT source_id, lm_device_id, display_name, name, sysname, hostname, ips_json, is_network
    FROM lm_devices WHERE stale = 0
  `).all();
  const add = (k, d) => { const key = norm(k); if (key && !byName.has(key)) byName.set(key, d); };
  for (const d of rows) {
    for (const n of [d.display_name, d.name, d.sysname, d.hostname]) {
      if (!n) continue;
      add(n, d);
      const s = shortName(n);
      if (s.length >= 3) add(s, d);
      if (IPV4.test(norm(n)) && !byIp.has(norm(n))) byIp.set(norm(n), d);
    }
    for (const ip of parseJson(d.ips_json, []) || []) if (ip && !byIp.has(norm(ip))) byIp.set(norm(ip), d);
  }
  return {
    resolve(switchName, switchAddress) {
      const raw = norm(switchName).replace(/\([^)]*\)\s*$/, '').trim();
      if (raw) {
        const hit = byName.get(raw) || byName.get(shortName(raw));
        if (hit) return hit;
      }
      const a = norm(switchAddress);
      return a ? byIp.get(a) || null : null;
    },
  };
}

// -- Endpoints (C2) -------------------------------------------------------------------

function interfaceLoader(dbh) {
  const cache = new Map();
  const stmt = dbh.prepare(`
    SELECT instance_id, display_name, status, status_text, in_util_pct, out_util_pct, in_errors, out_errors
    FROM lm_interfaces WHERE source_id = ? AND lm_device_id = ? AND stale = 0
  `);
  return (sourceId, deviceId) => {
    const k = `${sourceId}:${deviceId}`;
    if (!cache.has(k)) cache.set(k, stmt.all(sourceId, deviceId));
    return cache.get(k);
  };
}
const ifStatusText = (i) => {
  if (!i) return 'unknown';
  if (i.status_text) return i.status_text;
  if (i.status == null) return 'unknown';
  return Number(i.status) === 1 ? 'up' : Number(i.status) === 2 ? 'down' : 'other';
};
const errSum = (i) => (i && (i.in_errors != null || i.out_errors != null) ? (Number(i.in_errors) || 0) + (Number(i.out_errors) || 0) : null);

function endpointRow({ sourceId, device, port, iface, endpoint, platform, nic, protocol, confidence, lastSeen, origin, matchQuality, mac, vlan, switchName }) {
  return {
    sourceId,
    deviceId: device.lm_device_id,
    deviceName: device.display_name || device.name || null,
    port: iface ? iface.display_name : (port || null),
    instanceId: iface ? iface.instance_id : null,
    portStatusText: iface ? ifStatusText(iface) : 'unknown',
    portInUtilPct: iface ? iface.in_util_pct : null,
    portOutUtilPct: iface ? iface.out_util_pct : null,
    portErrors: errSum(iface),
    endpoint,
    endpointPlatform: platform,
    nic: nic || null,
    protocol: protocol || null,
    confidence: confidence || null,
    lastSeen,
    origin,
    matchQuality,
    mac: mac || null,
    vlan: vlan == null ? null : vlan,
    switchName: switchName || null,
  };
}

const CONF_RANK = { high: 3, medium: 2, low: 1 };
/**
 * Every endpoint row ICC can derive, newest first, capped at 5000. Optional
 * {sourceId, deviceId} narrows to one switch. Rows for the same switch port
 * and endpoint (compared by the short name, since Dell refs are short and
 * vCenter refs are FQDNs) merge into one: protocols joined with '+', the nic
 * from the hint, the higher confidence, corroborated true.
 */
function computeEndpoints(dbh, { sourceId = null, deviceId = null } = {}) {
  const out = [];
  const byKey = new Map();
  const keyOf = (r) => `${r.sourceId}|${r.deviceId}|${r.instanceId != null ? `i${r.instanceId}` : `p${norm(r.port)}`}|${shortName(r.endpoint)}`;
  const push = (row) => {
    const k = keyOf(row);
    const prev = byKey.get(k);
    if (!prev) { row.corroborated = false; byKey.set(k, row); out.push(row); return; }
    const protos = new Set(String(prev.protocol || '').split('+').filter(Boolean));
    const hintFirst = prev.origin === 'vcenter-hint' && row.origin !== 'vcenter-hint';
    const merged = hintFirst ? [row.protocol, ...protos] : [...protos, row.protocol];
    prev.protocol = [...new Set(merged.filter(Boolean))].join('+') || null;
    if (row.origin === 'vcenter-hint' && row.nic) prev.nic = row.nic;
    if (!prev.nic && row.nic) prev.nic = row.nic;
    if ((CONF_RANK[row.confidence] || 0) > (CONF_RANK[prev.confidence] || 0)) prev.confidence = row.confidence;
    if (String(row.lastSeen || '') > String(prev.lastSeen || '')) prev.lastSeen = row.lastSeen;
    if (prev.origin !== 'vcenter-hint' && row.origin === 'vcenter-hint') {
      Object.assign(prev, { origin: 'vcenter-hint', matchQuality: row.matchQuality, mac: row.mac, vlan: row.vlan, switchName: row.switchName });
    }
    prev.corroborated = true;
  };
  const loadIfaces = interfaceLoader(dbh);

  // (b) vCenter NIC neighbour hints.
  if (tableExists(dbh, 'vcenter_host_nic_neighbors')) {
    try {
      const sw = buildSwitchIndex(dbh);
      const hints = dbh.prepare(`
        SELECT host_name, nic, mac, protocol, switch_name, switch_port, switch_address, vlan, captured_at
        FROM vcenter_host_nic_neighbors ORDER BY captured_at DESC, host_name, nic
      `).all();
      for (const h of hints) {
        const dev = sw.resolve(h.switch_name, h.switch_address);
        if (!dev) continue;
        if (sourceId != null && dev.source_id !== sourceId) continue;
        if (deviceId != null && dev.lm_device_id !== deviceId) continue;
        const { iface, quality } = matchPort(h.switch_port, loadIfaces(dev.source_id, dev.lm_device_id));
        const row = endpointRow({
          sourceId: dev.source_id, device: dev, port: cleanPort(h.switch_port), iface, endpoint: h.host_name,
          platform: 'vcenter', nic: h.nic, protocol: h.protocol,
          confidence: quality === 'exact' ? 'high' : quality === 'port-number' ? 'medium' : 'low',
          lastSeen: sqlIso(h.captured_at), origin: 'vcenter-hint', matchQuality: quality,
          mac: h.mac, vlan: h.vlan, switchName: h.switch_name,
        });
        push(row);
      }
    } catch { /* hint table with a different shape: no hint rows */ }
  }

  // (a) LM links whose far end is another ICC platform's host.
  const cols = columnsOf(dbh, 'lm_topology_links');
  if (cols.has('dst_platform')) {
    const where = ["COALESCE(l.stale, 0) = 0", 'l.dst_platform IS NOT NULL', "l.dst_platform != 'logicmonitor'", 'd.is_network = 1', 'd.stale = 0'];
    const params = [];
    if (sourceId != null) { where.push('l.source_id = ?'); params.push(sourceId); }
    if (deviceId != null) { where.push('l.src_device_id = ?'); params.push(deviceId); }
    const links = dbh.prepare(`
      SELECT l.*, d.lm_device_id, d.display_name, d.name,
        i.instance_id AS i_instance_id, i.display_name AS i_display_name, i.status AS i_status, i.status_text AS i_status_text,
        i.in_util_pct AS i_in_util_pct, i.out_util_pct AS i_out_util_pct, i.in_errors AS i_in_errors, i.out_errors AS i_out_errors
      FROM lm_topology_links l
      JOIN lm_devices d ON d.source_id = l.source_id AND d.lm_device_id = l.src_device_id
      LEFT JOIN lm_interfaces i ON i.source_id = l.source_id AND i.instance_id = l.src_instance_id
      WHERE ${where.join(' AND ')}
      ORDER BY l.last_seen DESC, d.display_name, l.src_port
    `).all(...params);
    for (const l of links) {
      const iface = l.i_instance_id != null ? {
        instance_id: l.i_instance_id, display_name: l.i_display_name, status: l.i_status, status_text: l.i_status_text,
        in_util_pct: l.i_in_util_pct, out_util_pct: l.i_out_util_pct, in_errors: l.i_in_errors, out_errors: l.i_out_errors,
      } : null;
      const row = endpointRow({
        sourceId: l.source_id, device: l, port: l.src_port, iface, endpoint: l.dst_ref || norm(l.dst_name),
        platform: l.dst_platform, nic: l.dst_port, protocol: l.protocol, confidence: l.confidence,
        lastSeen: sqlIso(l.last_seen), origin: l.protocol, matchQuality: iface ? 'exact' : 'none',
      });
      push(row);
    }
  }

  out.sort((a, b) => String(b.lastSeen || '').localeCompare(String(a.lastSeen || ''))
    || String(a.deviceName || '').localeCompare(String(b.deviceName || ''))
    || String(a.port || '').localeCompare(String(b.port || ''), undefined, { numeric: true }));
  return out.slice(0, ENDPOINT_CAP);
}

const endpointsAll = (dbh) => { try { return computeEndpoints(dbh); } catch { return []; } };
const endpointsForDevice = (dbh, sourceId, lmDeviceId) => {
  try { return computeEndpoints(dbh, { sourceId: Number(sourceId), deviceId: Number(lmDeviceId) }); } catch { return []; }
};

/** {total, byPlatform: [{platform, count}], unmatchedPorts, corroborated}
 *  over merged rows. */
function endpointsSummary(rows) {
  const by = new Map();
  for (const r of rows) by.set(r.endpointPlatform, (by.get(r.endpointPlatform) || 0) + 1);
  return {
    total: rows.length,
    corroborated: rows.filter((r) => r.corroborated).length,
    byPlatform: [...by.entries()].map(([platform, count]) => ({ platform, count })).sort((a, b) => b.count - a.count || String(a.platform).localeCompare(String(b.platform))),
    unmatchedPorts: rows.filter((r) => r.origin === 'vcenter-hint' && r.matchQuality === 'none').length,
  };
}

// -- Server-object path (C3 /server-path, C4 hooks) --------------------------------

const PORT_ISSUE_TYPES = new Set(['interface-utilization-high', 'interface-errors-growing', 'interface-flapping']);

function openIssuesByTarget(dbh) {
  const map = new Map();
  try {
    for (const r of dbh.prepare("SELECT severity, type, target, message, first_seen FROM lm_issue_history WHERE status = 'open'").all()) {
      const k = norm(r.target);
      if (!map.has(k)) map.set(k, []);
      map.get(k).push({ severity: r.severity, type: r.type, message: r.message, firstSeen: sqlIso(r.first_seen) });
    }
  } catch { /* no issue history */ }
  return map;
}

/**
 * Edge status rule shared by the topology hook and Server 360: 'crit' when
 * the interface is down, 'warn' when an open utilization, errors or flapping
 * issue targets it, else 'ok' ('unknown' when ICC has no interface row).
 */
function portTone(statusText, issues) {
  if (statusText === 'down') return 'crit';
  if ((issues || []).some((i) => PORT_ISSUE_TYPES.has(i.type))) return 'warn';
  if (statusText === 'up') return 'ok';
  return 'unknown';
}

/** Resolve the anchor and its identity set from names / ips. */
function resolveAnchor(dbh, names, ips) {
  const nameSet = new Set();
  for (const n of names || []) { const k = norm(n); if (k) { nameSet.add(k); nameSet.add(shortName(k)); } }
  const ipSet = new Set((ips || []).map(norm).filter(Boolean));
  for (const n of [...nameSet]) if (IPV4.test(n)) ipSet.add(n);
  const list = [...nameSet];
  let anchor = null;
  if ((list.length || ipSet.size) && tableExists(dbh, 'vcenter_vms')) {
    try {
      const cols = columnsOf(dbh, 'vcenter_vms');
      const ph = list.map(() => '?').join(',');
      const ipList = [...ipSet];
      const ipPh = ipList.map(() => '?').join(',');
      const ipClause = ipList.length && cols.has('ip_address') ? ` OR lower(COALESCE(ip_address, '')) IN (${ipPh})` : '';
      const vm = dbh.prepare(`
        SELECT * FROM vcenter_vms WHERE lower(name) IN (${ph})${cols.has('guest_hostname') ? ` OR lower(COALESCE(guest_hostname, '')) IN (${ph})` : ''}${ipClause}
        LIMIT 1
      `).get(...list, ...(cols.has('guest_hostname') ? list : []), ...(ipClause ? ipList : []));
      if (vm) {
        anchor = { name: vm.name, kind: 'vm', hostName: vm.host_name || null };
        nameSet.add(norm(vm.name)); nameSet.add(shortName(vm.name));
        if (vm.guest_hostname) { nameSet.add(norm(vm.guest_hostname)); nameSet.add(shortName(vm.guest_hostname)); }
        if (vm.ip_address) ipSet.add(norm(vm.ip_address));
        for (const nic of parseJson(vm.guest_nics, []) || []) for (const ip of (nic && nic.ips) || []) ipSet.add(norm(ip));
      }
    } catch { /* vm inventory shape differs */ }
  }
  if (!anchor && list.length && tableExists(dbh, 'vcenter_hosts')) {
    try {
      const host = dbh.prepare('SELECT name FROM vcenter_hosts WHERE name IS NOT NULL').all()
        .find((h) => nameSet.has(norm(h.name)) || nameSet.has(shortName(h.name)));
      if (host) anchor = { name: host.name, kind: 'host', hostName: host.name };
    } catch { /* host inventory shape differs */ }
  }
  // Round 9: vCenter missed (or found an ESX host that may be a merged Dell
  // ref): ask the cross-platform identity index and widen the match set with
  // the ref's every name and address.
  if ((!anchor || anchor.kind === 'host') && (list.length || ipSet.size)) {
    try {
      const idx = hostIdentity.buildIdentityIndex(dbh);
      let ref = null;
      for (const n of list) { if (!IPV4.test(n)) { ref = hostIdentity.resolveToken(idx, n); if (ref) break; } }
      if (!ref) for (const ip of ipSet) { ref = idx.byIp.get(ip) || null; if (ref) break; }
      if (ref) {
        if (!anchor) anchor = { name: ref.label, kind: ref.platform, hostName: null };
        for (const n of ref.names) { nameSet.add(n); nameSet.add(shortName(n)); }
        for (const ip of ref.ips) ipSet.add(ip);
      }
    } catch { /* identity index unavailable: keep what vCenter found */ }
  }
  if (!anchor) anchor ={ name: (names || []).find(Boolean) || [...ipSet][0] || null, kind: 'device', hostName: null };
  nameSet.delete('');
  return { anchor, nameSet, ipSet };
}

/**
 * The server-object path: the switch ports the anchor (or, for a VM, its ESX
 * host) is plugged into, one hop of switch-to-switch uplinks from each of
 * those switches, and the reachability checks that target the anchor. Never
 * throws; every list is empty when nothing is known.
 */
function serverPath(dbh, { names = [], ips = [] } = {}, extra = {}) {
  const empty = { anchor: { name: (names || [])[0] || null, kind: 'device', hostName: null }, switchPorts: [], uplinks: [], checks: [] };
  try {
    const { anchor, nameSet, ipSet } = resolveAnchor(dbh, names, ips);
    const result = { anchor, switchPorts: [], uplinks: [], checks: [] };
    const matchSet = new Set(nameSet);
    if (anchor.hostName) { matchSet.add(norm(anchor.hostName)); matchSet.add(shortName(anchor.hostName)); }
    for (const ip of ipSet) matchSet.add(ip);
    if (!matchSet.size) return result;

    const issues = openIssuesByTarget(dbh);
    const issuesFor = (deviceName, port) => (deviceName && port ? issues.get(norm(`${deviceName} ${port}`)) || [] : []);

    // Switch ports.
    const switches = new Map();
    for (const e of (extra.endpoints || computeEndpoints(dbh))) {
      const ep = norm(e.endpoint);
      if (!matchSet.has(ep) && !matchSet.has(shortName(ep))) continue;
      const portIssues = e.instanceId != null ? issuesFor(e.deviceName, e.port) : [];
      result.switchPorts.push({
        sourceId: e.sourceId, deviceId: e.deviceId, deviceName: e.deviceName, port: e.port, instanceId: e.instanceId,
        statusText: e.portStatusText, inUtilPct: e.portInUtilPct, outUtilPct: e.portOutUtilPct, errors: e.portErrors,
        issues: portIssues, nic: e.nic, protocol: e.protocol, source: e.origin, endpoint: e.endpoint,
        endpointPlatform: e.endpointPlatform, matchQuality: e.matchQuality, tone: portTone(e.portStatusText, portIssues),
      });
      switches.set(`${e.sourceId}:${e.deviceId}`, { sourceId: e.sourceId, deviceId: e.deviceId, deviceName: e.deviceName });
    }

    // One hop of uplinks from each switch, oriented away from it.
    if (switches.size) {
      const cols = columnsOf(dbh, 'lm_topology_links');
      const lmOnly = cols.has('dst_platform') ? "(l.dst_platform = 'logicmonitor' OR (l.dst_platform IS NULL AND l.dst_device_id IS NOT NULL))" : 'l.dst_device_id IS NOT NULL';
      const stmt = dbh.prepare(`
        SELECT l.*, i.display_name AS i_name, i.status AS i_status, i.status_text AS i_status_text,
          i.in_util_pct AS i_in, i.out_util_pct AS i_out,
          sd.display_name AS src_name, dd.display_name AS dst_display
        FROM lm_topology_links l
        LEFT JOIN lm_interfaces i ON i.source_id = l.source_id AND i.instance_id = l.src_instance_id
        LEFT JOIN lm_devices sd ON sd.source_id = l.source_id AND sd.lm_device_id = l.src_device_id
        LEFT JOIN lm_devices dd ON dd.source_id = l.source_id AND dd.lm_device_id = l.dst_device_id
        WHERE l.source_id = ? AND COALESCE(l.stale, 0) = 0 AND ${lmOnly} AND (l.src_device_id = ? OR l.dst_device_id = ?)
        ORDER BY l.src_port
      `);
      const seenPair = new Set();
      for (const s of switches.values()) {
        for (const l of stmt.all(s.sourceId, s.deviceId, s.deviceId)) {
          const outbound = l.src_device_id === s.deviceId;
          const other = outbound ? l.dst_device_id : l.src_device_id;
          if (other == null || other === s.deviceId) continue;
          const pairKey = `${s.sourceId}:${[s.deviceId, other].sort((a, b) => a - b).join('-')}:${[l.src_port, l.dst_port].join('|')}`;
          if (seenPair.has(pairKey)) continue;
          seenPair.add(pairKey);
          const statusText = l.i_status_text || (l.i_status == null ? 'unknown' : Number(l.i_status) === 1 ? 'up' : Number(l.i_status) === 2 ? 'down' : 'other');
          const linkIssues = issuesFor(l.src_name, l.i_name || l.src_port);
          result.uplinks.push({
            sourceId: s.sourceId,
            from: outbound
              ? { deviceId: s.deviceId, deviceName: s.deviceName, port: l.src_port || null }
              : { deviceId: s.deviceId, deviceName: s.deviceName, port: l.dst_port || null },
            to: outbound
              ? { deviceId: other, deviceName: l.dst_display || l.dst_name || null, port: l.dst_port || null }
              : { deviceId: other, deviceName: l.src_name || null, port: l.src_port || null },
            statusText, inUtilPct: l.i_in ?? null, outUtilPct: l.i_out ?? null,
            issues: linkIssues, protocol: l.protocol, tone: portTone(statusText, linkIssues),
          });
        }
      }
    }

    // Reachability checks aimed at the anchor.
    try {
      const anchorShort = shortName(anchor.name || '');
      const checks = dbh.prepare('SELECT source_id, check_id, name, target, kind FROM lm_checks WHERE stale = 0').all()
        .filter((c) => {
          const t = norm(c.target);
          if (t && (matchSet.has(t) || matchSet.has(shortName(t)))) return true;
          return anchorShort.length >= 3 && norm(c.name).includes(anchorShort);
        });
      if (checks.length) {
        let evaluated = [];
        try { evaluated = require('./logicmonitorChecks').evaluateLocations(dbh) || []; } catch { evaluated = []; }
        const byCheck = new Map();
        for (const e of evaluated) {
          const k = `${e.sourceId}|${e.checkId}`;
          if (!byCheck.has(k)) byCheck.set(k, []);
          byCheck.get(k).push(e);
        }
        const locStmt = dbh.prepare('SELECT * FROM lm_check_locations WHERE source_id = ? AND check_id = ? AND stale = 0 ORDER BY is_overall DESC, label');
        for (const c of checks) {
          const ev = byCheck.get(`${c.source_id}|${c.check_id}`);
          const locations = ev
            ? ev.sort((a, b) => Number(b.isOverall) - Number(a.isOverall) || String(a.label).localeCompare(String(b.label))).map((e) => ({
              checkpointId: e.checkpointId, label: e.label, isOverall: !!e.isOverall, lastStatus: e.status || 'unknown',
              rttAvgMs: e.rttAvgMs ?? null, lossPct: e.lossPct ?? null, baselineRttMs: e.baselineRttMs ?? null,
              anomaly: e.anomaly || null, severity: e.severity || null,
            }))
            : locStmt.all(c.source_id, c.check_id).map((l) => ({
              checkpointId: l.checkpoint_id, label: l.label, isOverall: Number(l.is_overall) === 1, lastStatus: l.last_status || 'unknown',
              rttAvgMs: l.last_rtt_ms, lossPct: l.last_loss_pct, baselineRttMs: null,
              anomaly: l.last_status === 'down' ? 'down' : null, severity: l.last_status === 'down' ? 'critical' : null,
            }));
          result.checks.push({ sourceId: c.source_id, checkId: c.check_id, name: c.name, target: c.target, kind: c.kind, locations });
        }
      }
    } catch { /* checks unavailable */ }
    return result;
  } catch {
    return empty;
  }
}

/**
 * Switch ports a server (or VM, through its ESX host) is plugged into, for the
 * App Services network component: the switchPorts of serverPath. Each row has
 * sourceId, deviceId, deviceName, port, instanceId, statusText, inUtilPct,
 * outUtilPct, errors, issues [{severity, type, message, firstSeen}], tone
 * ('crit' | 'warn' | 'ok' | 'unknown'), nic, protocol, source, endpoint,
 * endpointPlatform. Never throws. serverPath(...).checks holds the
 * reachability checks aimed at the same host.
 */
function endpointsForHost(dbh, { names = [], ips = [] } = {}, extra = {}) {
  try { return serverPath(dbh, { names, ips }, extra).switchPorts; } catch { return []; }
}

// -- Backup window overlay (round 3, C5) --------------------------------------------------

const RUN_EPOCH = (col) => `CAST(CASE WHEN ${col} LIKE '20%' THEN strftime('%s', ${col}) ELSE ${col} END AS INTEGER)`;
const histTs = (ms) => new Date(ms).toISOString().replace('T', ' ').slice(0, 19);

/**
 * @deprecated Round 4 replaced this per-run overlay with backupLoad (one row
 * per host, window and port). Kept one more round for GET /governance.
 *
 * Cohesity protection runs of the last 7 days joined to the switch ports of
 * the hosts they back up: protection_runs.job_name -> cohesity_objects whose
 * protection_groups hold the job -> the object name through the ICC host
 * index (serverPath: a VM rides its ESX host's ports) -> the mean utilization
 * of those ports inside [start, end] from lm_interface_history, against the
 * port baseline for the hours the run spans. A row is a finding when the run
 * mean reaches lm_backup_overlay_util_pct ('saturates') or sits above the
 * baseline median by lm_if_anomaly_k x MAD ('elevated'). Capped at 500 rows.
 */
function backupWindows(dbh, { nowMs = Date.now(), endpoints = null } = {}) {
  const out = [];
  try {
    if (!tableExists(dbh, 'protection_runs') || !tableExists(dbh, 'cohesity_objects')) return out;
    const issuesMod = require('./logicmonitorIssues');
    const sat = issuesMod.getThreshold('lm_backup_overlay_util_pct');
    const k = issuesMod.getThreshold('lm_if_anomaly_k');
    const epRows = endpoints || computeEndpoints(dbh);
    if (!epRows.length) return out;
    const since = Math.floor(nowMs / 1000) - 7 * 86400;
    const runs = dbh.prepare(`
      SELECT r.id, r.cluster_id, r.job_name, r.status, ${RUN_EPOCH('r.start_time')} AS s, ${RUN_EPOCH('r.end_time')} AS e, c.name AS cluster_name
      FROM protection_runs r LEFT JOIN clusters c ON c.id = r.cluster_id
      WHERE r.start_time IS NOT NULL AND r.end_time IS NOT NULL AND ${RUN_EPOCH('r.start_time')} >= ?
      ORDER BY s DESC LIMIT 2000
    `).all(since);
    const objStmt = dbh.prepare(`
      SELECT o.name FROM cohesity_objects o
      WHERE o.cluster_id = ? AND o.name IS NOT NULL AND json_valid(COALESCE(o.protection_groups, '[]'))
        AND EXISTS (SELECT 1 FROM json_each(COALESCE(o.protection_groups, '[]')) je WHERE je.value IN (?, ?)) LIMIT 50
    `);
    const histStmt = dbh.prepare(`
      SELECT in_util_pct, out_util_pct FROM lm_interface_history WHERE source_id = ? AND instance_id = ? AND captured_at >= ? AND captured_at <= ?
    `);
    const baseStmt = dbh.prepare('SELECT hour_of_day, util_median, util_mad FROM lm_interface_baseline WHERE source_id = ? AND instance_id = ?');
    const hostPorts = new Map();
    const portsFor = (name) => {
      const key = norm(name);
      if (!hostPorts.has(key)) {
        let ports = [];
        try { ports = serverPath(dbh, { names: [name] }, { endpoints: epRows }).switchPorts.filter((p) => p.instanceId != null); } catch { ports = []; }
        hostPorts.set(key, ports);
      }
      return hostPorts.get(key);
    };
    const baseCache = new Map();
    const seen = new Set();
    for (const r of runs) {
      if (out.length >= 500) break;
      if (!r.s || !r.e || r.e <= r.s) continue;
      const job = String(r.job_name || '');
      if (!job) continue;
      const hours = new Set();
      for (let t = r.s; t <= r.e; t += 1800) hours.add(new Date(t * 1000).getUTCHours());
      hours.add(new Date(r.e * 1000).getUTCHours());
      for (const o of objStmt.all(r.cluster_id, job, `vc${job}`)) {
        for (const p of portsFor(o.name)) {
          const dedupe = `${r.id}|${p.sourceId}|${p.instanceId}`;
          if (seen.has(dedupe)) continue;
          const rows = histStmt.all(p.sourceId, p.instanceId, histTs(r.s * 1000), histTs(r.e * 1000));
          const utils = rows.map((h) => Math.max(h.in_util_pct == null ? -1 : h.in_util_pct, h.out_util_pct == null ? -1 : h.out_util_pct)).filter((v) => v >= 0);
          if (!utils.length) continue;
          const mean = utils.reduce((a, b) => a + b, 0) / utils.length;
          const bk = `${p.sourceId}:${p.instanceId}`;
          if (!baseCache.has(bk)) baseCache.set(bk, baseStmt.all(p.sourceId, p.instanceId));
          const bl = baseCache.get(bk).filter((b) => hours.has(b.hour_of_day) && b.util_median != null);
          const bMed = bl.length ? bl.reduce((a, b) => a + b.util_median, 0) / bl.length : null;
          const bMad = bl.length ? bl.reduce((a, b) => a + (b.util_mad || 0), 0) / bl.length : 0;
          let finding = null;
          if (mean >= sat) finding = 'saturates';
          else if (bMed != null && mean > bMed + k * Math.max(bMad, 2)) finding = 'elevated';
          if (!finding) continue;
          seen.add(dedupe);
          out.push({
            jobName: job, cluster: r.cluster_name || null, objectName: o.name, host: p.endpoint || null, deviceName: p.deviceName, port: p.port,
            runStart: new Date(r.s * 1000).toISOString(), runEnd: new Date(r.e * 1000).toISOString(),
            meanUtilPct: Math.round(mean * 10) / 10, baselineUtilPct: bMed == null ? null : Math.round(bMed * 10) / 10,
            status: r.status, finding, sourceId: p.sourceId, deviceId: p.deviceId, instanceId: p.instanceId,
          });
        }
      }
    }
  } catch { /* cohesity tables absent or differently shaped: no overlay */ }
  return out;
}

// -- Backup load on switch ports (round 4, B1) ---------------------------------------------

const BACKUP_MERGE_GAP_S = 15 * 60;
const MGMT_RE = /management/i;
const round1 = (v) => (v == null || !Number.isFinite(v) ? null : Math.round(v * 10) / 10);

/**
 * pnic names behind a host's management vmkernel: vmkernel rows named vmk0 or
 * on a portgroup whose name contains "Management". vcenterApi stores the
 * portgroup name in the vmkernel row's switch_name, so the vswitch is reached
 * through the portgroup row (a switch_name that already names a vswitch row is
 * used directly). Returns a Set of lower-cased pnic names, or null when any
 * step is missing.
 */
function makeVmkernelLookup(dbh) {
  const byHost = new Map();
  if (tableExists(dbh, 'vcenter_networks')) {
    try {
      for (const r of dbh.prepare("SELECT host_name, kind, name, switch_name, uplinks FROM vcenter_networks WHERE host_name IS NOT NULL AND kind IN ('vmkernel','portgroup','vswitch')").all()) {
        for (const k of new Set([norm(r.host_name), shortName(r.host_name)])) {
          if (!byHost.has(k)) byHost.set(k, []);
          byHost.get(k).push(r);
        }
      }
    } catch { /* different vcenter_networks shape */ }
  }
  return (host) => {
    const rows = byHost.get(norm(host)) || byHost.get(shortName(host)) || [];
    const vmks = rows.filter((r) => r.kind === 'vmkernel' && (norm(r.name) === 'vmk0' || MGMT_RE.test(String(r.switch_name || ''))));
    const nics = new Set();
    for (const v of vmks) {
      const sw = norm(v.switch_name);
      let vs = rows.find((r) => r.kind === 'vswitch' && norm(r.name) === sw);
      if (!vs) {
        const pg = rows.find((r) => r.kind === 'portgroup' && norm(r.name) === sw);
        if (pg) vs = rows.find((r) => r.kind === 'vswitch' && norm(r.name) === norm(pg.switch_name));
      }
      if (!vs) continue;
      for (const u of parseJson(vs.uplinks, []) || []) if (u) nics.add(norm(u));
    }
    return nics.size ? nics : null;
  };
}

/**
 * Backup traffic against the switch ports it rides, one row per (host, window,
 * port). Protection runs of the last `days` (newest 2000) map to objects
 * (cohesity_objects whose protection_groups hold the job), each object to a VM
 * and its ESX host (vcenter_vms) or to a physical server by name. Runs on one
 * host merge into a window when they overlap or start within 15 minutes of the
 * previous run's end. Ports: for a VM host, the uplinks behind the management
 * vmkernel ('vmkernel'); when any step of that chain is missing every hint
 * row of the host ('all-uplinks'); a physical server uses its endpoint rows
 * ('physical'). Per port: mean and max of max(in, out) utilization from
 * lm_interface_history inside the window, the baseline median for the window's
 * UTC hours, and a finding. A port with no history samples in the window gets
 * no row. Rows are capped at 500, saturating first.
 * A run that backs up objects on several hosts appears (with its full
 * logical_bytes) in each host's window.
 * Row: {sourceId, deviceId, deviceName, instanceId, port, host, hostPlatform,
 * windowStart, windowEnd, meanUtilPct, maxUtilPct, baselineUtilPct, finding?,
 * runs: [{jobName, cluster, objectName, status, start, end, logicalBytes,
 * sharePct}], runCount, uplinkRule}. Never throws.
 */
function backupLoad(dbh, { days = 7, nowMs = Date.now(), endpoints = null } = {}) {
  const out = [];
  try {
    if (!tableExists(dbh, 'protection_runs') || !tableExists(dbh, 'cohesity_objects') || !tableExists(dbh, 'lm_interface_history')) return out;
    const issuesMod = require('./logicmonitorIssues');
    const sat = issuesMod.getThreshold('lm_backup_overlay_util_pct');
    const k = issuesMod.getThreshold('lm_if_anomaly_k');
    const epRows = endpoints || computeEndpoints(dbh);
    if (!epRows.length) return out;
    const since = Math.floor(nowMs / 1000) - Math.max(1, Number(days) || 7) * 86400;
    const runs = dbh.prepare(`
      SELECT r.id, r.cluster_id, r.job_name, r.status, r.logical_bytes, ${RUN_EPOCH('r.start_time')} AS s, ${RUN_EPOCH('r.end_time')} AS e, c.name AS cluster_name
      FROM protection_runs r LEFT JOIN clusters c ON c.id = r.cluster_id
      WHERE r.start_time IS NOT NULL AND r.end_time IS NOT NULL AND ${RUN_EPOCH('r.start_time')} >= ?
      ORDER BY s DESC LIMIT 2000
    `).all(since);
    if (!runs.length) return out;
    const objStmt = dbh.prepare(`
      SELECT o.name FROM cohesity_objects o
      WHERE o.cluster_id = ? AND o.name IS NOT NULL AND json_valid(COALESCE(o.protection_groups, '[]'))
        AND EXISTS (SELECT 1 FROM json_each(COALESCE(o.protection_groups, '[]')) je WHERE je.value IN (?, ?)) LIMIT 50
    `);
    const vmCols = tableExists(dbh, 'vcenter_vms') ? columnsOf(dbh, 'vcenter_vms') : new Set();
    const hasGuest = vmCols.has('guest_hostname');
    const vmStmt = vmCols.has('name') && vmCols.has('host_name')
      ? dbh.prepare(`SELECT name, host_name FROM vcenter_vms WHERE lower(name) IN (?, ?)${hasGuest ? " OR lower(COALESCE(guest_hostname, '')) IN (?, ?)" : ''} LIMIT 1`)
      : null;
    const histStmt = dbh.prepare('SELECT in_util_pct, out_util_pct FROM lm_interface_history WHERE source_id = ? AND instance_id = ? AND captured_at >= ? AND captured_at <= ?');
    const baseStmt = dbh.prepare('SELECT hour_of_day, util_median, util_mad FROM lm_interface_baseline WHERE source_id = ? AND instance_id = ?');
    const vmkNics = makeVmkernelLookup(dbh);

    // object -> {host, hostPlatform, kind}
    const hostOfObj = new Map();
    const resolveObject = (name) => {
      const key = norm(name);
      if (hostOfObj.has(key)) return hostOfObj.get(key);
      let res = null;
      try {
        const vm = vmStmt ? vmStmt.get(key, shortName(key), ...(hasGuest ? [key, shortName(key)] : [])) : null;
        if (vm && vm.host_name) res = { host: vm.host_name, hostPlatform: 'vcenter', kind: 'vm' };
        else if (!vm) {
          const sp = serverPath(dbh, { names: [name] }, { endpoints: epRows });
          const first = sp.switchPorts.find((p) => p.instanceId != null);
          if (first) res = { host: name, hostPlatform: first.endpointPlatform || 'physical', kind: 'physical' };
        }
      } catch { res = null; }
      hostOfObj.set(key, res);
      return res;
    };
    const portCache = new Map();
    const portsOf = (host, kind) => {
      const ck = `${kind}|${norm(host)}`;
      if (portCache.has(ck)) return portCache.get(ck);
      let res = { ports: [], rule: kind === 'physical' ? 'physical' : 'all-uplinks' };
      try {
        const seen = new Set();
        const all = serverPath(dbh, { names: [host] }, { endpoints: epRows }).switchPorts
          .filter((p) => p.instanceId != null && !seen.has(`${p.sourceId}:${p.instanceId}`) && seen.add(`${p.sourceId}:${p.instanceId}`));
        if (kind === 'vm') {
          const nics = vmkNics(host);
          const picked = nics ? all.filter((p) => nics.has(norm(p.nic))) : [];
          res = picked.length ? { ports: picked, rule: 'vmkernel' } : { ports: all, rule: 'all-uplinks' };
        } else res = { ports: all, rule: 'physical' };
      } catch { /* leave empty */ }
      portCache.set(ck, res);
      return res;
    };

    // host -> runs
    const byHost = new Map();
    for (const r of runs) {
      if (!r.s || !r.e || r.e <= r.s) continue;
      const job = String(r.job_name || '');
      if (!job) continue;
      const perHost = new Map();
      for (const o of objStmt.all(r.cluster_id, job, `vc${job}`)) {
        const h = resolveObject(o.name);
        if (!h) continue;
        const hk = norm(h.host);
        if (!perHost.has(hk)) perHost.set(hk, { h, objects: [] });
        perHost.get(hk).objects.push(o.name);
      }
      for (const [hk, v] of perHost) {
        if (!byHost.has(hk)) byHost.set(hk, { h: v.h, runs: [] });
        byHost.get(hk).runs.push({
          jobName: job, cluster: r.cluster_name || null, objectName: [...new Set(v.objects)].slice(0, 3).join(', '),
          status: r.status || null, start: r.s, end: r.e, logicalBytes: r.logical_bytes == null ? null : Number(r.logical_bytes),
        });
      }
    }

    const baseCache = new Map();
    for (const { h, runs: hostRuns } of byHost.values()) {
      hostRuns.sort((a, b) => a.start - b.start || a.end - b.end);
      const windows = [];
      for (const r of hostRuns) {
        const cur = windows[windows.length - 1];
        if (cur && r.start <= cur.end + BACKUP_MERGE_GAP_S) { cur.runs.push(r); cur.end = Math.max(cur.end, r.end); } else windows.push({ start: r.start, end: r.end, runs: [r] });
      }
      const { ports, rule } = portsOf(h.host, h.kind);
      if (!ports.length) continue;
      for (const w of windows) {
        const total = w.runs.reduce((a, r) => a + (r.logicalBytes > 0 ? r.logicalBytes : 0), 0);
        let shares = w.runs.map((r) => (total > 0 && r.logicalBytes != null ? Math.round((r.logicalBytes / total) * 1000) / 10 : null));
        const withBytes = shares.filter((v) => v != null);
        if (withBytes.length) {
          // One decimal per run can drift off 100; the largest share absorbs it.
          const drift = Math.round((100 - withBytes.reduce((a, b) => a + b, 0)) * 10) / 10;
          if (drift !== 0) {
            let bi = -1;
            shares.forEach((v, i) => { if (v != null && (bi < 0 || v > shares[bi])) bi = i; });
            shares = shares.map((v, i) => (i === bi ? Math.round((v + drift) * 10) / 10 : v));
          }
        }
        const runOut = w.runs.map((r, i) => ({
          jobName: r.jobName, cluster: r.cluster, objectName: r.objectName, status: r.status,
          start: new Date(r.start * 1000).toISOString(), end: new Date(r.end * 1000).toISOString(),
          logicalBytes: r.logicalBytes, sharePct: shares[i],
        }));
        const hours = new Set();
        for (let t = w.start; t <= w.end; t += 1800) hours.add(new Date(t * 1000).getUTCHours());
        hours.add(new Date(w.end * 1000).getUTCHours());
        for (const p of ports) {
          const rows = histStmt.all(p.sourceId, p.instanceId, histTs(w.start * 1000), histTs(w.end * 1000));
          const utils = rows.map((x) => Math.max(x.in_util_pct == null ? -1 : x.in_util_pct, x.out_util_pct == null ? -1 : x.out_util_pct)).filter((v) => v >= 0);
          if (!utils.length) continue;
          const mean = utils.reduce((a, b) => a + b, 0) / utils.length;
          const bk = `${p.sourceId}:${p.instanceId}`;
          if (!baseCache.has(bk)) baseCache.set(bk, baseStmt.all(p.sourceId, p.instanceId));
          const bl = baseCache.get(bk).filter((b) => hours.has(b.hour_of_day) && b.util_median != null);
          const bMed = bl.length ? bl.reduce((a, b) => a + b.util_median, 0) / bl.length : null;
          const bMad = bl.length ? bl.reduce((a, b) => a + (b.util_mad || 0), 0) / bl.length : 0;
          const row = {
            sourceId: p.sourceId, deviceId: p.deviceId, deviceName: p.deviceName, instanceId: p.instanceId, port: p.port,
            host: h.host, hostPlatform: h.hostPlatform,
            windowStart: new Date(w.start * 1000).toISOString(), windowEnd: new Date(w.end * 1000).toISOString(),
            meanUtilPct: round1(mean), maxUtilPct: round1(Math.max(...utils)), baselineUtilPct: round1(bMed),
          };
          if (mean >= sat) row.finding = 'saturates';
          else if (bMed != null && mean > bMed + k * Math.max(bMad, 2)) row.finding = 'elevated';
          row.runs = runOut; row.runCount = runOut.length; row.uplinkRule = rule;
          out.push(row);
        }
      }
    }
    const rank = (r) => (r.finding === 'saturates' ? 0 : r.finding === 'elevated' ? 1 : 2);
    out.sort((a, b) => rank(a) - rank(b) || b.meanUtilPct - a.meanUtilPct || String(b.windowStart).localeCompare(String(a.windowStart)));
    return out.slice(0, 500);
  } catch {
    return out.slice(0, 500);
  }
}

/** Index of backupLoad rows by "sourceId:instanceId": {count, lastWindow (ISO of the newest window end)}. */
function backupLoadByPort(rows) {
  const m = new Map();
  for (const r of rows || []) {
    const key = `${r.sourceId}:${r.instanceId}`;
    const e = m.get(key) || { count: 0, lastWindow: null };
    e.count += 1;
    if (!e.lastWindow || String(r.windowEnd) > e.lastWindow) e.lastWindow = r.windowEnd;
    m.set(key, e);
  }
  return m;
}

/** Worst location of a check: down, then critical, then any anomaly, then
 *  the highest RTT; null when the check has no locations. */
function worstLocation(check) {
  const rank = (l) => (l.anomaly === 'down' || l.lastStatus === 'down' ? 0 : l.severity === 'critical' ? 1 : l.anomaly ? 2 : 3);
  return [...(check.locations || [])].sort((a, b) => rank(a) - rank(b) || (b.rttAvgMs || 0) - (a.rttAvgMs || 0))[0] || null;
}
/** 'crit' | 'warn' | 'ok' for a check location. */
function checkTone(l) {
  if (!l) return 'unknown';
  if (l.anomaly === 'down' || l.lastStatus === 'down' || (l.anomaly && l.severity === 'critical')) return 'crit';
  if (l.anomaly) return 'warn';
  return l.lastStatus === 'up' ? 'ok' : 'unknown';
}

module.exports = {
  buildIccHostIndex, makeIccResolver,
  cleanPort, portParts, matchPort,
  computeEndpoints, endpointsAll, endpointsForDevice, endpointsSummary,
  serverPath, portTone, worstLocation, checkTone,
  endpointsForHost, backupWindows, backupLoad, backupLoadByPort, resolveAnchor, buildSwitchIndex,
  ENDPOINT_CAP,
};
