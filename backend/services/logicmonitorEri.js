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
 * buildEriLinks turns those tokens into lm_topology_links rows (protocol cdp
 * and lldp). It resolves a CDP name against the LM device index, then the
 * serial against lm_devices.serial, then the ICC identity index; an LLDP
 * chassis MAC against every MAC the portal knows. What nothing resolves is
 * kept as an unmonitored neighbour (lm_unmonitored_neighbors) and raised as
 * one folded info issue per source.
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
 * Link rows (poller row shape) for one source. deviceIndex is the poller's
 * buildDeviceIndex map; resolver is the ICC resolver (makeIccResolver) or null.
 * Returns { rows, cdp, lldp, resolved, interfacesWithEri, cdpTokens, lldpTokens }.
 */
function buildEriLinks(dbh, sourceId, { deviceIndex = new Map(), resolver = null } = {}) {
  const ifaces = dbh.prepare(`
    SELECT lm_device_id, instance_id, display_name, props_json FROM lm_interfaces
    WHERE source_id = ? AND stale = 0 AND props_json IS NOT NULL AND props_json LIKE '%externalResourceID%'
  `).all(sourceId);
  const parsed = [];
  for (const i of ifaces) {
    const eri = parseEri(extractEriText(i.props_json));
    if (eri.cdp.length || eri.lldp.length || eri.localMac) parsed.push({ i, eri });
  }

  const serialIndex = new Map();
  const macIndex = new Map();      // full mac -> device id
  const prefixIndex = new Map();   // first five octets -> device id, or null when two devices share it
  const addMac = (mac, id, prefixToo) => {
    const m = normMac(mac);
    if (!m) return;
    if (!macIndex.has(m)) macIndex.set(m, id);
    if (prefixToo) {
      const p = m.split(':').slice(0, 5).join(':');
      if (!prefixIndex.has(p)) prefixIndex.set(p, id);
      else if (prefixIndex.get(p) !== id) prefixIndex.set(p, null);
    }
  };
  for (const d of dbh.prepare('SELECT lm_device_id, serial, eri_json FROM lm_devices WHERE source_id = ? AND stale = 0').all(sourceId)) {
    if (d.serial && String(d.serial).trim()) serialIndex.set(norm(d.serial), d.lm_device_id);
    for (const mac of (parseJson(d.eri_json, {}) || {}).mac || []) addMac(mac, d.lm_device_id, false);
  }
  // Chassis base MAC and port MACs share the OUI plus two octets on Cisco, so the
  // first five octets of any local interface MAC name the device (confidence low).
  for (const { i, eri } of parsed) addMac(eri.localMac, i.lm_device_id, true);

  const lookupName = (n) => {
    const k = norm(n).replace(/\s*\([^)]*\)?\s*$/, '').trim();
    if (!k) return null;
    let id = deviceIndex.get(k);
    if (id == null && k.includes('.') && !IPV4.test(k)) id = deviceIndex.get(k.split('.')[0]);
    return id == null ? null : id;
  };

  const best = new Map(); // `${instance}|${protocol}` -> row
  const consider = (row) => {
    const key = `${row.srcInstanceId}|${row.protocol}`;
    const had = best.get(key);
    const isRes = (r) => r.dstDeviceId != null || r.dstPlatform != null;
    if (!had || (!isRes(had) && isRes(row))) best.set(key, row);
  };
  let cdpTokens = 0;
  let lldpTokens = 0;

  for (const { i, eri } of parsed) {
    const base = { srcDeviceId: i.lm_device_id, srcInstanceId: i.instance_id, srcPort: i.display_name };
    for (const c of eri.cdp) {
      cdpTokens += 1;
      if (!c.name || !c.name.trim()) continue; // the portal shows ' ' tokens
      const bareMac = BARE_MAC.test(c.shortName) ? normMac(c.shortName) : null;
      let id = null;
      let confidence = 'medium';
      const byName = lookupName(c.name);
      const bySerial = c.serial ? serialIndex.get(norm(c.serial)) : null;
      if (bySerial != null && bySerial !== i.lm_device_id) { id = bySerial; confidence = 'high'; } else if (byName != null && byName !== i.lm_device_id) { id = byName; confidence = 'medium'; }
      if (id == null && bareMac) {
        const m = macIndex.get(bareMac);
        if (m != null && m !== i.lm_device_id) { id = m; confidence = 'high'; }
      }
      if (byName === i.lm_device_id || bySerial === i.lm_device_id) continue; // a loop back to itself
      let dstPlatform = null;
      let dstRef = null;
      if (id != null) dstPlatform = 'logicmonitor';
      else if (resolver) {
        const hit = resolver(c.name) || (c.serial ? resolver(c.serial) : null);
        if (hit) { dstPlatform = hit.platform; dstRef = hit.ref; confidence = c.serial ? 'high' : 'medium'; }
      }
      if (id == null && dstPlatform == null) confidence = 'low';
      consider({ ...base, protocol: 'cdp', dstName: c.raw || c.name, dstPort: c.port, confidence, dstDeviceId: id, dstPlatform, dstRef, kindKey: c.shortName });
    }
    for (const l of eri.lldp) {
      lldpTokens += 1;
      const label = l.chassisMac || String(l.chassisRaw || '').trim();
      if (!label) continue;
      let id = null;
      let confidence = 'high';
      if (l.chassisMac) {
        id = macIndex.has(l.chassisMac) ? macIndex.get(l.chassisMac) : null;
        if (id == null) {
          const p = prefixIndex.get(l.chassisMac.split(':').slice(0, 5).join(':'));
          if (p != null) { id = p; confidence = 'low'; }
        }
      }
      if (id === i.lm_device_id) continue;
      let dstPlatform = null;
      let dstRef = null;
      if (id != null) dstPlatform = 'logicmonitor';
      else if (resolver && l.chassisMac) {
        const hit = resolver(l.chassisMac);
        if (hit) { dstPlatform = hit.platform; dstRef = hit.ref; confidence = 'high'; }
      }
      if (id == null && dstPlatform == null) confidence = 'low';
      consider({ ...base, protocol: 'lldp', dstName: label, dstPort: l.port, confidence, dstDeviceId: id, dstPlatform, dstRef, kindKey: l.chassisMac });
    }
  }

  const rows = [...best.values()];
  const resolved = rows.filter((r) => r.dstDeviceId != null || r.dstPlatform != null).length;
  return {
    rows,
    cdp: rows.filter((r) => r.protocol === 'cdp').length,
    lldp: rows.filter((r) => r.protocol === 'lldp').length,
    resolved,
    interfacesWithEri: parsed.length,
    cdpTokens,
    lldpTokens,
  };
}

/**
 * Upsert lm_unmonitored_neighbors for one source from this build's link rows and
 * mark rows that no longer appear stale. Skips blank tokens and bare MACs
 * written without colons (the live portal shows ' ' and 'e4a41ca6bffa').
 */
function refreshUnmonitored(dbh, sourceId, rows) {
  if (!tableExists(dbh, 'lm_unmonitored_neighbors')) return 0;
  const found = new Map();
  for (const r of rows) {
    if (r.dstDeviceId != null || r.dstPlatform != null) continue;
    let key;
    let name;
    if (r.protocol === 'cdp') {
      key = norm(r.kindKey);
      if (!key || key.length < 2 || BARE_MAC.test(key)) continue;
      name = String(r.dstName || '').replace(/\s*\([^)]*\)?\s*$/, '').trim() || key;
    } else if (r.protocol === 'lldp') {
      key = r.kindKey;
      if (!key) continue;
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
  const out = { interfacesWithEri: 0, cdpTokens: 0, lldpTokens: 0, resolved: 0, unresolved: 0 };
  for (const r of dbh.prepare("SELECT props_json FROM lm_interfaces WHERE stale = 0 AND props_json LIKE '%externalResourceID%'").all()) {
    const eri = parseEri(extractEriText(r.props_json));
    if (!eri.cdp.length && !eri.lldp.length && !eri.localMac) continue;
    out.interfacesWithEri += 1;
    out.cdpTokens += eri.cdp.length;
    out.lldpTokens += eri.lldp.length;
  }
  const cols = new Set(dbh.prepare("PRAGMA table_info('lm_topology_links')").all().map((c) => c.name));
  const where = "COALESCE(stale, 0) = 0 AND protocol IN ('cdp', 'lldp')";
  if (cols.has('dst_platform')) {
    out.resolved = dbh.prepare(`SELECT COUNT(*) n FROM lm_topology_links WHERE ${where} AND (dst_device_id IS NOT NULL OR dst_platform IS NOT NULL)`).get().n;
    out.unresolved = dbh.prepare(`SELECT COUNT(*) n FROM lm_topology_links WHERE ${where} AND dst_device_id IS NULL AND dst_platform IS NULL`).get().n;
  }
  return out;
}

module.exports = {
  parseEri, extractEriText, buildEriLinks, refreshUnmonitored, unmonitoredRows, unmonitoredNeighborIssues, eriSummary,
};
