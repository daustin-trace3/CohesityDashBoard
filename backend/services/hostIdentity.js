// Cross-platform host identity (LogicMonitor round 9, WP3, 2026-10-16).
//
// One on-demand index over every ICC platform table that names a machine:
// names, FQDN short forms, IPv4 addresses, MAC addresses, serial numbers and
// Dell service tags. The LogicMonitor link builder resolves far ends against it
// (description grammar, LLDP/CDP neighbours), serverPath falls back to it when
// the vCenter lookups miss, and the discovery report counts what it knows.
//
// No new table: the index is rebuilt from the platform tables and cached for
// 60 s per db handle. Every reader is wrapped in try and probes its columns
// with PRAGMA table_info, because several columns are added by other round 9
// work (vcenter_hosts.serial / service_tag / uuid, dell_devices.idrac_mac /
// os_hostname, table cohesity_nodes) and may be absent on a given install.
// All of those column and table names are UNVERIFIED against live data.
//
// ref = { platform, platforms, refKey, label, kind, names, ips, macs, serials,
//         route, alsoKnownAs, ...platform extras }
// refKey is the lower-cased primary name. LM topology rows store it in
// dst_ref and serverPath matches it against the identity name set, so it has
// to stay a name (the pre-round 9 dst_ref was the lower-cased inventory name).

const IPV4 = /^\d{1,3}(\.\d{1,3}){3}$/;
const CACHE_MS = 60 * 1000;

const cache = new WeakMap();

const norm = (s) => String(s == null ? '' : s).trim().toLowerCase();
/** Short host name; IPv4 literals are never shortened. */
const shortName = (s) => { const n = norm(s); return IPV4.test(n) ? n : n.split('.')[0]; };
/** Lower, "(serial)" tail stripped, domain kept. */
const stripParen = (s) => norm(s).replace(/\s*\([^)]*\)\s*$/, '').trim();
/** Lower, "(serial)" tail stripped, domain stripped (IPv4 untouched). */
const canonName = (s) => shortName(stripParen(s));

/** aa:bb:cc:dd:ee:ff from aa:bb:.., aa-bb-.., aabb.ccdd.eeff or 12 bare hex; null otherwise. */
function normMac(s) {
  const raw = String(s == null ? '' : s).trim().toLowerCase();
  if (!raw) return null;
  const hex = raw.replace(/[:\-.]/g, '');
  if (!/^[0-9a-f]{12}$/.test(hex)) return null;
  if (/[^0-9a-f:\-.]/.test(raw)) return null;
  return hex.match(/../g).join(':');
}

function tableExists(dbh, name) {
  try { return !!dbh.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?").get(name); } catch { return false; }
}
function columnsOf(dbh, table) {
  try { return new Set(dbh.prepare(`PRAGMA table_info('${table}')`).all().map((c) => c.name)); } catch { return new Set(); }
}
const parseJson = (s, fallback) => {
  if (s == null || s === '') return fallback;
  try { const v = JSON.parse(s); return v == null ? fallback : v; } catch { return fallback; }
};
/** Run a SELECT built from the columns that exist; [] on any failure. */
function readRows(dbh, table, wanted, tail = '') {
  try {
    if (!tableExists(dbh, table)) return [];
    const have = columnsOf(dbh, table);
    const cols = wanted.filter((c) => have.has(c));
    if (!cols.length) return [];
    return dbh.prepare(`SELECT ${cols.join(', ')} FROM ${table} ${tail}`).all();
  } catch { return []; }
}

/**
 * Build the index. Platform order decides which ref wins an exact name two
 * platforms share: vcenter host, dell, cohesity, netapp, pure, brocade,
 * zerto, unifi, vcenter VM. A later claimant is recorded in the winner's
 * alsoKnownAs. A Dell device whose service tag equals a vCenter host serial or
 * service tag is merged into the host's ref (platforms ['vcenter', 'dell']).
 */
function build(dbh) {
  const refs = new Map();         // refKey -> ref (merged secondaries also point here)
  const byName = new Map();
  const byShort = new Map();      // short -> ref | null (ambiguous)
  const byIp = new Map();
  const byMac = new Map();
  const bySerial = new Map();

  const addName = (ref, raw) => {
    const n = norm(raw);
    if (!n || n.length < 3) return;
    if (!ref.names.includes(n)) ref.names.push(n);
    const prev = byName.get(n);
    if (!prev) byName.set(n, ref);
    else if (prev !== ref && !prev.alsoKnownAs.some((a) => a.platform === ref.platform && a.refKey === ref.refKey)) {
      prev.alsoKnownAs.push({ platform: ref.platform, refKey: ref.refKey });
    }
    const s = shortName(n);
    if (s && s !== n && s.length >= 3) {
      const p = byShort.get(s);
      if (p === undefined) byShort.set(s, ref);
      else if (p && p !== ref) byShort.set(s, null);
    }
  };
  const addIp = (ref, raw) => {
    const v = norm(raw);
    if (!IPV4.test(v)) return;
    if (!ref.ips.includes(v)) ref.ips.push(v);
    if (!byIp.has(v)) byIp.set(v, ref);
  };
  const addMac = (ref, raw) => {
    const m = normMac(raw);
    if (!m) return;
    if (!ref.macs.includes(m)) ref.macs.push(m);
    if (!byMac.has(m)) byMac.set(m, ref);
  };
  const addSerial = (ref, raw) => {
    const v = norm(raw);
    if (!v || v.length < 4) return;
    if (!ref.serials.includes(v)) ref.serials.push(v);
    if (!bySerial.has(v)) bySerial.set(v, ref);
  };
  const newRef = (platform, kind, label, route, extra = {}) => ({
    platform, platforms: [platform], refKey: norm(label), label: String(label), kind, names: [], ips: [], macs: [], serials: [],
    route, alsoKnownAs: [], ...extra,
  });
  /** Register a ref unless its refKey is taken; a taken key is recorded as alsoKnownAs on the owner. */
  const register = (ref) => {
    if (!ref.refKey) return null;
    const owner = refs.get(ref.refKey);
    if (owner) {
      if (!owner.alsoKnownAs.some((a) => a.platform === ref.platform && a.refKey === ref.refKey)) {
        owner.alsoKnownAs.push({ platform: ref.platform, refKey: ref.refKey });
      }
      return null;
    }
    refs.set(ref.refKey, ref);
    return ref;
  };
  const withIdent = (ref, { names = [], ips = [], macs = [], serials = [], host = null }) => {
    // host: a mgmt_host / vip value that may be an IP or a name.
    if (host) (IPV4.test(norm(host)) ? ips : names).push(host);
    names.forEach((n) => addName(ref, n));
    ips.forEach((v) => addIp(ref, v));
    macs.forEach((v) => addMac(ref, v));
    serials.forEach((v) => addSerial(ref, v));
    return ref;
  };

  // ---- vCenter hosts --------------------------------------------------------------
  const vcHosts = readRows(dbh, 'vcenter_hosts', ['name', 'serial', 'service_tag', 'uuid'], 'WHERE name IS NOT NULL');
  const nets = readRows(dbh, 'vcenter_networks', ['host_name', 'kind', 'ip_address', 'mac'], "WHERE host_name IS NOT NULL AND kind IN ('vmkernel', 'pnic')");
  const netsByHost = new Map();
  for (const n of nets) {
    const k = norm(n.host_name);
    if (!netsByHost.has(k)) netsByHost.set(k, []);
    netsByHost.get(k).push(n);
  }
  const hostRef = new Map(); // norm host name -> ref
  for (const h of vcHosts) {
    const ref = register(newRef('vcenter', 'host', h.name, `/vcenter/inventory?q=${encodeURIComponent(h.name)}`, { uuid: h.uuid || null }));
    if (!ref) continue;
    withIdent(ref, { names: [h.name], serials: [h.serial, h.service_tag] });
    for (const n of netsByHost.get(norm(h.name)) || []) {
      if (n.kind === 'vmkernel') addIp(ref, n.ip_address);
      if (n.kind === 'pnic') addMac(ref, n.mac);
    }
    hostRef.set(norm(h.name), ref);
  }

  // ---- Dell -----------------------------------------------------------------------
  const dellDevs = readRows(dbh, 'dell_devices', ['ome_id', 'device_id', 'name', 'service_tag', 'ip_address', 'chassis_service_tag', 'idrac_mac', 'os_hostname', 'model'], 'WHERE name IS NOT NULL OR service_tag IS NOT NULL');
  if (dellDevs.length) {
    const compKey = (r) => `${r.ome_id}:${r.device_id}`;
    const osHost = new Map();
    for (const r of readRows(dbh, 'dell_components', ['ome_id', 'device_id', 'extra'], "WHERE kind = 'os'")) {
      const h = (parseJson(r.extra, {}) || {}).hostname;
      if (h) osHost.set(compKey(r), h);
    }
    const nicMacs = new Map();
    for (const r of readRows(dbh, 'dell_components', ['ome_id', 'device_id', 'extra'], "WHERE kind = 'nic'")) {
      const list = nicMacs.get(compKey(r)) || [];
      for (const p of (parseJson(r.extra, {}) || {}).ports || []) for (const m of (p && p.macs) || []) list.push(m);
      nicMacs.set(compKey(r), list);
    }
    for (const d of dellDevs) {
      const label = d.name || d.service_tag;
      const k = compKey(d);
      const tag = norm(d.service_tag);
      const target = tag && bySerial.get(tag);
      const names = [d.name, d.os_hostname, osHost.get(k)];
      if (target && target.platform === 'vcenter') {
        // Dell server that is an ESX host: one ref, both platforms.
        if (!target.platforms.includes('dell')) target.platforms.push('dell');
        target.alsoKnownAs.push({ platform: 'dell', refKey: norm(label) });
        target.dell = { name: d.name || null, serviceTag: d.service_tag || null, model: d.model || null, chassisTag: d.chassis_service_tag || null };
        withIdent(target, { names, ips: [d.ip_address], macs: [d.idrac_mac, ...(nicMacs.get(k) || [])], serials: [d.service_tag] });
        const dk = norm(label);
        if (dk && !refs.has(dk)) refs.set(dk, target);
        continue;
      }
      const ref = register(newRef('dell', 'device', label, `/dell/devices?q=${encodeURIComponent(label)}`, {
        chassisTag: d.chassis_service_tag || null, serviceTag: d.service_tag || null,
      }));
      if (!ref) continue;
      // chassis_service_tag is shared by every blade in the chassis, so it is kept on the ref only.
      withIdent(ref, { names, ips: [d.ip_address], macs: [d.idrac_mac, ...(nicMacs.get(k) || [])], serials: [d.service_tag] });
    }
  }

  // ---- Cohesity -------------------------------------------------------------------
  const clusters = readRows(dbh, 'clusters', ['id', 'name', 'vip']);
  const clusterName = new Map(clusters.map((c) => [c.id, c.name]));
  for (const c of clusters) {
    if (!c.name) continue;
    const ref = register(newRef('cohesity', 'cluster', c.name, `/cohesity/hardware?q=${encodeURIComponent(c.name)}`, { clusterId: c.id }));
    // Helios-registered clusters keep a numeric cluster id in vip (e.g. "8803852180576369"); only an
    // IPv4 address or a host name (contains a letter) is an identity.
    const vip = c.vip != null ? String(c.vip).trim() : '';
    const vipOk = vip && (IPV4.test(vip) || /[a-z]/i.test(vip));
    if (ref) withIdent(ref, { names: [c.name], host: vipOk ? vip : null });
  }
  for (const n of readRows(dbh, 'cohesity_nodes', ['cluster_id', 'node_id', 'hostname', 'ip', 'ips_json', 'serial', 'chassis_serial'])) {
    const label = n.hostname || (n.ip ? `${clusterName.get(n.cluster_id) || 'cluster'}-${n.node_id || n.ip}` : null);
    if (!label) continue;
    const ref = register(newRef('cohesity', 'node', label, `/cohesity/hardware?q=${encodeURIComponent(label)}`, {
      clusterId: n.cluster_id, clusterName: clusterName.get(n.cluster_id) || null,
    }));
    if (!ref) continue;
    withIdent(ref, { names: [n.hostname], ips: [n.ip, ...(parseJson(n.ips_json, []) || [])], serials: [n.serial, n.chassis_serial] });
  }

  // ---- NetApp ---------------------------------------------------------------------
  const naArrays = readRows(dbh, 'netapp_arrays', ['id', 'name', 'management_ip', 'mgmt_host']);
  const naName = new Map(naArrays.map((a) => [a.id, a.name]));
  const lifsByNode = new Map();
  for (const l of readRows(dbh, 'netapp_lifs', ['array_id', 'address', 'node_name', 'port_name'], 'WHERE node_name IS NOT NULL')) {
    const k = `${l.array_id}|${norm(l.node_name)}`;
    if (!lifsByNode.has(k)) lifsByNode.set(k, []);
    lifsByNode.get(k).push(l);
  }
  for (const a of naArrays) {
    if (!a.name) continue;
    const ref = register(newRef('netapp', 'cluster', a.name, `/netapp/governance?q=${encodeURIComponent(a.name)}`, { arrayId: a.id }));
    if (ref) withIdent(ref, { names: [a.name], ips: [a.management_ip], host: a.mgmt_host });
  }
  for (const n of readRows(dbh, 'netapp_nodes', ['array_id', 'name', 'serial_number'], 'WHERE name IS NOT NULL')) {
    const ref = register(newRef('netapp', 'node', n.name, `/netapp/governance?q=${encodeURIComponent(n.name)}`, {
      arrayId: n.array_id, arrayName: naName.get(n.array_id) || null, ports: [],
    }));
    if (!ref) continue;
    withIdent(ref, { names: [n.name], serials: [n.serial_number] });
    for (const l of lifsByNode.get(`${n.array_id}|${norm(n.name)}`) || []) {
      if (l.port_name && !ref.ports.includes(l.port_name)) ref.ports.push(l.port_name);
      addIp(ref, l.address);
    }
  }

  // ---- Pure -----------------------------------------------------------------------
  const pureArrays = readRows(dbh, 'pure_arrays', ['id', 'name', 'mgmt_host']);
  const pureCtl = new Map();
  for (const c of readRows(dbh, 'pure_controllers', ['array_id', 'name'])) {
    if (!pureCtl.has(c.array_id)) pureCtl.set(c.array_id, []);
    if (c.name) pureCtl.get(c.array_id).push(c.name);
  }
  const pureIfs = new Map();
  for (const i of readRows(dbh, 'pure_network_interfaces', ['array_id', 'address', 'mac_address'])) {
    if (!pureIfs.has(i.array_id)) pureIfs.set(i.array_id, []);
    pureIfs.get(i.array_id).push(i);
  }
  for (const a of pureArrays) {
    if (!a.name) continue;
    // Controller names (CT0, CT1) are not indexed as names: they repeat on every array.
    const ref = register(newRef('pure', 'array', a.name, `/pure/hardware?q=${encodeURIComponent(a.name)}`, { arrayId: a.id, controllers: pureCtl.get(a.id) || [] }));
    if (!ref) continue;
    withIdent(ref, { names: [a.name], host: a.mgmt_host });
    for (const i of pureIfs.get(a.id) || []) { addIp(ref, i.address); addMac(ref, i.mac_address); }
  }

  // ---- Brocade --------------------------------------------------------------------
  for (const s of readRows(dbh, 'brocade_switches', ['id', 'name', 'ip_address', 'wwn', 'serial_number'], 'WHERE name IS NOT NULL')) {
    const ref = register(newRef('brocade', 'switch', s.name, `/brocade/switches?q=${encodeURIComponent(s.name)}`, { wwn: s.wwn || null }));
    if (ref) withIdent(ref, { names: [s.name], ips: [s.ip_address], serials: [s.serial_number, s.wwn] });
  }

  // ---- Zerto ----------------------------------------------------------------------
  for (const z of readRows(dbh, 'zerto_sites', ['name', 'zvm_ip'], 'WHERE name IS NOT NULL')) {
    const ref = register(newRef('zerto', 'site', z.name, `/zerto/sites?q=${encodeURIComponent(z.name)}`));
    if (ref) withIdent(ref, { names: [z.name], ips: [z.zvm_ip] });
  }

  // ---- UniFi ----------------------------------------------------------------------
  for (const u of readRows(dbh, 'unifi_devices', ['name', 'ip', 'mac', 'serial'], 'WHERE name IS NOT NULL')) {
    const ref = register(newRef('unifi', 'device', u.name, `/unifi/devices?q=${encodeURIComponent(u.name)}`));
    if (ref) withIdent(ref, { names: [u.name], ips: [u.ip], macs: [u.mac], serials: [u.serial] });
  }

  // ---- vCenter VMs (last) ---------------------------------------------------------
  const vmCols = columnsOf(dbh, 'vcenter_vms');
  for (const v of readRows(dbh, 'vcenter_vms', ['name', 'guest_hostname', 'ip_address', 'guest_nics'], 'WHERE name IS NOT NULL')) {
    const ref = register(newRef('vcenter', 'vm', v.name, `/vcenter/inventory?q=${encodeURIComponent(v.name)}`));
    if (!ref) continue;
    withIdent(ref, { names: [v.name, vmCols.has('guest_hostname') ? v.guest_hostname : null], ips: [v.ip_address] });
    // guest_nics is JSON [{ips: [...], mac?}] on this install; tolerate any other shape.
    for (const nic of parseJson(v.guest_nics, []) || []) {
      if (!nic || typeof nic !== 'object') continue;
      for (const ip of nic.ips || []) addIp(ref, ip);
      addMac(ref, nic.mac || nic.macAddress);
    }
  }

  return { byName, byShort, byIp, byMac, bySerial, refs };
}

/** Cached index; { fresh: true } rebuilds. Never throws (an empty index on failure). */
function buildIdentityIndex(dbh, { fresh = false } = {}) {
  const hit = cache.get(dbh);
  if (!fresh && hit && Date.now() - hit.at < CACHE_MS) return hit.idx;
  let idx;
  try { idx = build(dbh); } catch {
    idx = { byName: new Map(), byShort: new Map(), byIp: new Map(), byMac: new Map(), bySerial: new Map(), refs: new Map() };
  }
  cache.set(dbh, { at: Date.now(), idx });
  return idx;
}
function invalidateIdentityIndex(dbh) { if (dbh) cache.delete(dbh); }

/**
 * Resolve one token and say why not when it fails. reason: 'no-name' (blank or
 * under 3 characters), 'ambiguous' (a short name two refs share), 'unknown-name'.
 * Order: exact name, short name, IPv4, MAC, serial / service tag, FQDN short form.
 */
function explainToken(idx, token) {
  const raw = norm(token);
  if (!raw || raw.length < 3) return { ref: null, reason: 'no-name' };
  const forms = [...new Set([raw, stripParen(raw)].filter((f) => f && f.length >= 3))];
  let ambiguous = false;
  for (const f of forms) {
    const exact = idx.byName.get(f);
    if (exact) return { ref: exact, reason: null };
    if (!IPV4.test(f) && byShortHas(idx, f)) {
      const sh = idx.byShort.get(f);
      if (sh) return { ref: sh, reason: null };
      ambiguous = true;
    }
  }
  for (const f of forms) {
    if (IPV4.test(f)) {
      const ip = idx.byIp.get(f);
      if (ip) return { ref: ip, reason: null };
    }
  }
  for (const f of forms) {
    const mac = normMac(f);
    if (mac) {
      const m = idx.byMac.get(mac);
      if (m) return { ref: m, reason: null };
    }
  }
  for (const f of forms) {
    if (/^[a-z0-9]{7,20}$/.test(f)) {
      const s = idx.bySerial.get(f);
      if (s) return { ref: s, reason: null };
    }
  }
  for (const f of forms) {
    if (f.includes('.') && !IPV4.test(f)) {
      const s = f.split('.')[0];
      if (s.length >= 3) {
        const exact = idx.byName.get(s);
        if (exact) return { ref: exact, reason: null };
        if (byShortHas(idx, s)) {
          const sh = idx.byShort.get(s);
          if (sh) return { ref: sh, reason: null };
          ambiguous = true;
        }
      }
    }
  }
  return { ref: null, reason: ambiguous ? 'ambiguous' : 'unknown-name' };
}
const byShortHas = (idx, k) => idx.byShort.has(k);

function resolveToken(idx, token) { return explainToken(idx, token).ref; }

module.exports = {
  buildIdentityIndex, invalidateIdentityIndex, resolveToken, explainToken,
  normMac, canonName, stripParen, shortName,
};
