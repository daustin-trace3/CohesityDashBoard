'use strict';

/**
 * LogicMonitor ERI topology resolution (round 10, WP-A).
 *
 * LogicMonitor writes its own neighbour discovery onto every interface
 * instance as one auto property:
 *
 *   predef.externalResourceID =
 *     interface:<local mac>,cdp-interface:<name[(serial)]>--<remote port>,lldp-interface:<chassis mac>--<remote port>
 *
 * The tokens describe the interface's OWN device (sysname, serial, chassis MAC,
 * port), not a neighbour (proven on the live portal). They feed an identity
 * index (buildIdentityIndex); the neighbour side comes from the CDP_Neighbors
 * and LLDP_Neighbors instances, resolved by resolveNeighbor: identity index
 * first (exact, with the remote port), then the LM device index, then the ICC
 * resolver. Neighbours nothing resolves are kept as unmonitored neighbours
 * (lm_unmonitored_neighbors) and raised as one folded info issue per source.
 *
 * The token grammar is taken from the first live portal (CGSandBox). The
 * property sits in props.auto there; this reader also accepts system and
 * custom maps and the demo's [{name, value}] array shape.
 */

const hostIdentity = require('./hostIdentity');

const ERI_KEY = 'predef.externalResourceID';
const norm = (s) => String(s == null ? '' : s).trim().toLowerCase();
const normMac = hostIdentity.normMac;
const IPV4 = /^\d{1,3}(\.\d{1,3}){3}$/;
const BARE_MAC = /^[0-9a-f]{12}$/;

function parseJson(v, fallback) {
  if (v == null || v === '') return fallback;
  try { return JSON.parse(v); } catch { return fallback; }
}

/** Domain-stripped lower-case name, "(serial)" removed. IPv4 literals stay whole. */
function shortOf(name) {
  const bare = norm(name).replace(/\s*\([^)]*\)?\s*$/, '').trim();
  return IPV4.test(bare) ? bare : bare.split('.')[0];
}

/**
 * Parse the property string. Tolerates missing tokens, several cdp or lldp
 * tokens, upper-case MACs and a token without a port. MACs come back as
 * aa:bb:cc:dd:ee:ff; a chassis token that is not a MAC keeps chassisMac null.
 */
function parseEri(text) {
  const out = { localMac: null, cdp: [], lldp: [] };
  if (text == null || text === '') return out;
  for (const rawTok of String(text).split(',')) {
    const m = rawTok.trim().match(/^(cdp-interface|lldp-interface|interface):(.*)$/i);
    if (!m) continue;
    const kind = m[1].toLowerCase();
    let body = m[2].trim();
    let port = null;
    const cut = body.lastIndexOf('--');
    if (cut >= 0) { port = body.slice(cut + 2).trim() || null; body = body.slice(0, cut).trim(); }
    if (kind === 'interface') {
      if (!out.localMac) out.localMac = normMac(body);
    } else if (kind === 'cdp-interface') {
      const sm = body.match(/\(([^()]*)\)?\s*$/);
      const serial = sm && sm[1].trim() ? sm[1].trim() : null;
      const name = body.replace(/\s*\([^)]*\)?\s*$/, '').trim();
      const lower = name.toLowerCase();
      const domain = lower.includes('.') && !IPV4.test(lower) ? lower.slice(lower.indexOf('.') + 1) : null;
      out.cdp.push({ name, shortName: shortOf(name), domain, serial, port, raw: body });
    } else {
      out.lldp.push({ chassisMac: normMac(body), chassisRaw: body, port });
    }
  }
  return out;
}

/** The ERI string of one interface props_json (object with auto/system/custom, or the demo array). */
function extractEriText(propsJson) {
  const props = typeof propsJson === 'string' ? parseJson(propsJson, null) : propsJson;
  if (!props) return null;
  if (Array.isArray(props)) {
    const hit = props.find((p) => p && p.name === ERI_KEY);
    return hit && hit.value ? String(hit.value) : null;
  }
  for (const scope of ['auto', 'system', 'custom']) {
    const v = props[scope] && props[scope][ERI_KEY];
    if (v) return String(v);
  }
  return props[ERI_KEY] ? String(props[ERI_KEY]) : null;
}

const tableExists = (dbh, name) => !!dbh.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(name);

/**
 * Identity index of one source (all sources when sourceId is null), built from the
 * interface ERIs. The ERI of an interface describes that interface's OWN device:
 * its sysname and serial (cdp token), its chassis MAC (lldp token), its port, and
 * the interface MAC. So a neighbour seen elsewhere (CDP_Neighbors, LLDP_Neighbors)
 * resolves to a monitored device by sysname, serial or chassis MAC, and the remote
 * port resolves to that device's interface by "<identity>|<port>".
 */
function buildIdentityIndex(dbh, sourceId = null) {
  const identity = {
    names: new Map(),     // short lower-case sysname -> device id
    serials: new Map(),   // lower-case serial -> device id
    chassis: new Map(),   // chassis mac -> device id
    macs: new Map(),      // local interface mac -> { deviceId, instanceId, port }
    ports: new Map(),     // "<sysname>|<port>" and "<chassis mac>|<port>" and "<serial>|<port>" -> { deviceId, instanceId, port }
    interfacesWithEri: 0,
    cdpTokens: 0,
    lldpTokens: 0,
  };
  if (!tableExists(dbh, 'lm_interfaces')) return identity;
  const ifaces = dbh.prepare(`
    SELECT lm_device_id, instance_id, display_name, props_json FROM lm_interfaces
    WHERE stale = 0 AND props_json IS NOT NULL AND props_json LIKE '%externalResourceID%' ${sourceId == null ? '' : 'AND source_id = ?'}
  `).all(...(sourceId == null ? [] : [sourceId]));
  const setOnce = (map, key, val) => { if (key && !map.has(key)) map.set(key, val); };
  const portKey = (id, port) => `${id}|${norm(port)}`;
  for (const i of ifaces) {
    const eri = parseEri(extractEriText(i.props_json));
    if (!eri.cdp.length && !eri.lldp.length && !eri.localMac) continue;
    identity.interfacesWithEri += 1;
    identity.cdpTokens += eri.cdp.length;
    identity.lldpTokens += eri.lldp.length;
    const c = eri.cdp.find((t) => t.name && t.name.trim());
    const l = eri.lldp.find((t) => t.chassisMac);
    const port = (c && c.port) || (l && l.port) || null;
    const ref = { deviceId: i.lm_device_id, instanceId: i.instance_id, port: i.display_name };
    if (c) {
      setOnce(identity.names, c.shortName, i.lm_device_id);
      if (c.serial) setOnce(identity.serials, norm(c.serial), i.lm_device_id);
    }
    if (l) setOnce(identity.chassis, l.chassisMac, i.lm_device_id);
    if (eri.localMac) setOnce(identity.macs, eri.localMac, ref);
    if (port) {
      if (c) { setOnce(identity.ports, portKey(c.shortName, port), ref); if (c.serial) setOnce(identity.ports, portKey(norm(c.serial), port), ref); }
      if (l) setOnce(identity.ports, portKey(l.chassisMac, port), ref);
    }
  }
  // Devices the portal knows by serial or by recorded MAC fill gaps the ERIs leave.
  if (tableExists(dbh, 'lm_devices')) {
    for (const d of dbh.prepare(`SELECT lm_device_id, serial, eri_json FROM lm_devices WHERE stale = 0 ${sourceId == null ? '' : 'AND source_id = ?'}`).all(...(sourceId == null ? [] : [sourceId]))) {
      if (d.serial && String(d.serial).trim()) setOnce(identity.serials, norm(d.serial), d.lm_device_id);
      for (const mac of (parseJson(d.eri_json, {}) || {}).mac || []) setOnce(identity.chassis, normMac(mac), d.lm_device_id);
    }
  }
  return identity;
}

/**
 * Resolve one neighbour (a CDP_Neighbors or LLDP_Neighbors instance) to a far end.
 * { name, serial, mac, port, selfId } describe the neighbour as the instance names it.
 * Order: ERI identity (sysname, serial, chassis MAC; confidence high, remote port
 * resolved to the far interface when known), the LM device index by name (medium),
 * the ICC identity resolver for other platforms, else unresolved.
 * Returns { dstDeviceId, dstPlatform, dstRef, dstPort, confidence, via }.
 */
function resolveNeighbor(identity, deviceIndex, resolver, { name = null, serial = null, mac = null, port = null, selfId = null } = {}) {
  const rawName = String(name == null ? '' : name).trim();
  const sm = rawName.match(/\(([^()]*)\)?\s*$/);
  const serialN = norm(serial || (sm ? sm[1] : ''));
  const short = shortOf(rawName);
  const macN = normMac(mac) || normMac(rawName);
  const unresolved = { dstDeviceId: null, dstPlatform: null, dstRef: null, dstPort: port || null, confidence: 'low', via: null };

  if (identity) {
    let id = null;
    let key = null;
    if (short && identity.names.has(short)) { id = identity.names.get(short); key = short; }
    if ((id == null || id === selfId) && serialN && identity.serials.has(serialN)) { id = identity.serials.get(serialN); key = serialN; }
    if ((id == null || id === selfId) && macN && identity.chassis.has(macN)) { id = identity.chassis.get(macN); key = macN; }
    let remote = null;
    if ((id == null || id === selfId) && macN && identity.macs.has(macN)) { remote = identity.macs.get(macN); id = remote.deviceId; key = null; }
    if (id != null && id !== selfId) {
      if (port && key) remote = identity.ports.get(`${key}|${norm(port)}`) || null;
      return { dstDeviceId: id, dstPlatform: 'logicmonitor', dstRef: null, dstPort: (remote && remote.port) || port || null, confidence: 'high', via: 'eri' };
    }
  }

  const k = rawName.toLowerCase().replace(/\s*\([^)]*\)?\s*$/, '').trim();
  if (k && deviceIndex) {
    let id = deviceIndex.get(k);
    if (id == null && k.includes('.') && !IPV4.test(k)) id = deviceIndex.get(k.split('.')[0]);
    if (id != null && id !== selfId) {
      return { dstDeviceId: id, dstPlatform: 'logicmonitor', dstRef: null, dstPort: port || null, confidence: 'medium', via: 'name' };
    }
  }

  if (resolver) {
    const hit = (rawName && resolver(rawName)) || (serialN && resolver(serialN)) || (macN && resolver(macN)) || null;
    if (hit && hit.platform) {
      return { dstDeviceId: null, dstPlatform: hit.platform, dstRef: hit.ref, dstPort: port || null, confidence: port || serialN ? 'high' : 'medium', via: 'icc' };
    }
  }
  return unresolved;
}

/**
 * Retained for the poller call site: ERI tokens no longer produce links (they
 * describe the interface's own device). Returns no rows plus the identity index
 * and the token counts the discovery payload reports.
 */
function buildEriLinks(dbh, sourceId) {
  const identity = buildIdentityIndex(dbh, sourceId);
  return {
    rows: [], cdp: 0, lldp: 0, resolved: 0, identity,
    interfacesWithEri: identity.interfacesWithEri, cdpTokens: identity.cdpTokens, lldpTokens: identity.lldpTokens,
  };
}

/**
 * Upsert lm_unmonitored_neighbors for one source from this build's unresolved
 * neighbour-instance link rows (cdp and lldp) and mark rows that no longer appear
 * stale. One row per distinct neighbour identity. Skips blank tokens and bare
 * 12-hex cdp names (the live portal shows ' ' and 'e4a41ca6bffa').
 */
function refreshUnmonitored(dbh, sourceId, rows) {
  if (!tableExists(dbh, 'lm_unmonitored_neighbors')) return 0;
  const found = new Map();
  for (const r of rows) {
    if (r.dstDeviceId != null || r.dstPlatform != null) continue;
    let key;
    let name;
    if (r.protocol === 'cdp') {
      key = norm(r.kindKey != null ? r.kindKey : shortOf(r.dstName));
      if (!key || key.length < 2 || BARE_MAC.test(key)) continue;
      name = String(r.dstName || '').replace(/\s*\([^)]*\)?\s*$/, '').trim() || key;
    } else if (r.protocol === 'lldp') {
      key = r.kindKey != null ? r.kindKey : (normMac(r.dstName) || norm(r.dstName));
      if (!key || !String(key).trim()) continue;
      name = key;
    } else continue;
    const k = `${r.protocol}|${key}`;
    const e = found.get(k) || { key, name, kind: r.protocol, ports: 0, devices: new Set(), sampleDevice: r.srcDeviceId, samplePort: r.srcPort };
    e.ports += 1;
    e.devices.add(r.srcDeviceId);
    found.set(k, e);
  }
  const up = dbh.prepare(`
    INSERT INTO lm_unmonitored_neighbors (source_id, neighbor_key, neighbor_name, kind, ports_seen, devices_seen, first_seen, last_seen,
      sample_src_device_id, sample_src_port, stale)
    VALUES (?, ?, ?, ?, ?, ?, datetime('now'), datetime('now'), ?, ?, 0)
    ON CONFLICT(source_id, neighbor_key) DO UPDATE SET neighbor_name = excluded.neighbor_name, kind = excluded.kind,
      ports_seen = excluded.ports_seen, devices_seen = excluded.devices_seen, last_seen = datetime('now'),
      sample_src_device_id = excluded.sample_src_device_id, sample_src_port = excluded.sample_src_port, stale = 0
  `);
  dbh.prepare('UPDATE lm_unmonitored_neighbors SET stale = 1 WHERE source_id = ?').run(sourceId);
  for (const e of found.values()) up.run(sourceId, e.key, e.name, e.kind, e.ports, e.devices.size, e.sampleDevice, e.samplePort);
  return found.size;
}

/** Rows for the Governance page and CSV, newest first. */
function unmonitoredRows(dbh) {
  if (!tableExists(dbh, 'lm_unmonitored_neighbors')) return [];
  return dbh.prepare(`
    SELECT n.*, s.name AS source_name, d.display_name AS sample_device
    FROM lm_unmonitored_neighbors n
    LEFT JOIN lm_sources s ON s.id = n.source_id
    LEFT JOIN lm_devices d ON d.source_id = n.source_id AND d.lm_device_id = n.sample_src_device_id
    WHERE COALESCE(n.stale, 0) = 0
    ORDER BY n.first_seen DESC, n.ports_seen DESC, n.neighbor_name
  `).all().map((r) => ({
    sourceId: r.source_id, sourceName: r.source_name, key: r.neighbor_key, name: r.neighbor_name, kind: r.kind,
    portsSeen: r.ports_seen, devicesSeen: r.devices_seen, firstSeen: isoOf(r.first_seen), lastSeen: isoOf(r.last_seen),
    sampleDevice: r.sample_device || null, sampleDeviceId: r.sample_src_device_id, samplePort: r.sample_src_port,
  }));
}

function isoOf(v) {
  if (!v) return null;
  const s = String(v);
  return /[zZ]|[+-]\d\d:?\d\d$/.test(s) ? s : `${s.replace(' ', 'T')}Z`;
}

/** One folded info issue per source with unmonitored neighbours (never per neighbour). */
function unmonitoredNeighborIssues(dbh, t, srcName) {
  if (!tableExists(dbh, 'lm_unmonitored_neighbors')) return [];
  const out = [];
  const bySource = new Map();
  for (const r of dbh.prepare('SELECT * FROM lm_unmonitored_neighbors WHERE COALESCE(stale, 0) = 0 ORDER BY ports_seen DESC, neighbor_name').all()) {
    if (!bySource.has(r.source_id)) bySource.set(r.source_id, []);
    bySource.get(r.source_id).push(r);
  }
  for (const [sid, list] of bySource) {
    const source = srcName.get(sid);
    if (!source) continue;
    const top = list.slice(0, 3).map((r) => r.neighbor_name).join(', ');
    out.push({
      severity: 'info', type: 'unmonitored-neighbor', source, target: source,
      message: `${list.length} device${list.length === 1 ? '' : 's'} seen by CDP/LLDP ${list.length === 1 ? 'is' : 'are'} not monitored (top: ${top})`,
    });
  }
  return out;
}

/** Discovery block: interfaces with an ERI, token counts, resolved and unresolved links. */
function eriSummary(dbh) {
  const out = {
    interfacesWithEri: 0, cdpTokens: 0, lldpTokens: 0, identityNames: 0, identitySerials: 0, identityChassis: 0,
    neighborsResolvedByEri: 0, unmonitored: 0, resolved: 0, unresolved: 0,
  };
  const sources = tableExists(dbh, 'lm_sources') ? dbh.prepare('SELECT id FROM lm_sources').all() : [];
  for (const s of sources) {
    const idn = buildIdentityIndex(dbh, s.id);
    out.interfacesWithEri += idn.interfacesWithEri;
    out.cdpTokens += idn.cdpTokens;
    out.lldpTokens += idn.lldpTokens;
    out.identityNames += idn.names.size;
    out.identitySerials += idn.serials.size;
    out.identityChassis += idn.chassis.size;
  }
  if (tableExists(dbh, 'lm_unmonitored_neighbors')) {
    out.unmonitored = dbh.prepare('SELECT COUNT(*) n FROM lm_unmonitored_neighbors WHERE COALESCE(stale, 0) = 0').get().n;
  }
  // Identity-index resolutions are the only cdp/lldp links that are LM-resolved with confidence high
  // (name-index matches are medium, ICC matches carry no device id).
  out.neighborsResolvedByEri = dbh.prepare("SELECT COUNT(*) n FROM lm_topology_links WHERE COALESCE(stale, 0) = 0 AND protocol IN ('cdp', 'lldp') AND dst_device_id IS NOT NULL AND confidence = 'high'").get().n;
  const cols = new Set(dbh.prepare("PRAGMA table_info('lm_topology_links')").all().map((c) => c.name));
  const where = "COALESCE(stale, 0) = 0 AND protocol IN ('cdp', 'lldp')";
  if (cols.has('dst_platform')) {
    out.resolved = dbh.prepare(`SELECT COUNT(*) n FROM lm_topology_links WHERE ${where} AND (dst_device_id IS NOT NULL OR dst_platform IS NOT NULL)`).get().n;
    out.unresolved = dbh.prepare(`SELECT COUNT(*) n FROM lm_topology_links WHERE ${where} AND dst_device_id IS NULL AND dst_platform IS NULL`).get().n;
  }
  return out;
}

module.exports = {
  parseEri, extractEriText, buildIdentityIndex, resolveNeighbor, buildEriLinks, refreshUnmonitored, unmonitoredRows, unmonitoredNeighborIssues, eriSummary,
};
