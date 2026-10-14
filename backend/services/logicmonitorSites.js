// LogicMonitor sites (round 3). A site is a lower-case slug derived per
// device, collector, check and check location, in this order (rules per
// portal in lm_sources.site_rule_json, defaults from the lm_site_* settings):
//   1. device group fullPath: the segment after a root (default Network,
//      Sites, Locations, Branch), every group of the device searched, the
//      deepest match wins ("Network/Branch/Phoenix" -> phoenix);
//   2. a device property (site, then location, then system.location) when
//      non-empty and under 40 characters;
//   3. the hostname prefix (text before the first "-", 2 to 8 characters).
// computeSites writes lm_sites plus the site_key columns and runs on every
// tier 1 tick; siteOf resolves any host name or ip to a site for the Ops
// Agent. Everything outside lm_* is tableExists guarded and nothing throws on
// a missing table.
const IPV4 = /^\d{1,3}(\.\d{1,3}){3}$/;
const DEFAULT_ROOTS = ['Network', 'Sites', 'Locations', 'Branch'];

const issues = () => require('./logicmonitorIssues');
const endpoints = () => require('./logicmonitorEndpoints');

const norm = (s) => String(s == null ? '' : s).trim().toLowerCase();
const parseJson = (s, fallback) => {
  if (s == null || s === '') return fallback;
  try { const v = JSON.parse(s); return v == null ? fallback : v; } catch { return fallback; }
};
function tableExists(dbh, name) {
  try { return !!dbh.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?").get(name); } catch { return false; }
}

/** a-z0-9 and single dashes only; null when nothing is left. */
function slug(s) {
  const k = String(s == null ? '' : s).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
  return k || null;
}

/** Site rules for one portal: site_rule_json {groupRoots, property,
 *  fromHostname} over the lm_site_* settings. */
function siteRules(sourceRow) {
  let roots; let property; let fromHostname;
  try {
    const t = issues();
    roots = String(t.getTextSetting('lm_site_group_roots')).split(',');
    property = t.getTextSetting('lm_site_property');
    fromHostname = t.getThreshold('lm_site_from_hostname') === 1;
  } catch {
    roots = DEFAULT_ROOTS; property = 'site'; fromHostname = true;
  }
  const own = parseJson(sourceRow && sourceRow.site_rule_json, null);
  if (own && typeof own === 'object') {
    const r = own.roots !== undefined ? own.roots : own.groupRoots;
    if (Array.isArray(r) && r.length) roots = r;
    else if (typeof r === 'string' && r.trim()) roots = r.split(',');
    if (typeof own.property === 'string') property = own.property;
    if (own.fromHostname != null) fromHostname = own.fromHostname === true || own.fromHostname === 1 || own.fromHostname === '1';
  }
  roots = roots.map((r) => norm(r)).filter(Boolean);
  if (!roots.length) roots = DEFAULT_ROOTS.map(norm);
  return { roots: new Set(roots), property: String(property || '').trim(), fromHostname };
}

/** Site from one group path: the segment after the deepest root segment that
 *  is not itself a root. Returns {name, depth} or null. */
function siteFromPath(fullPath, roots) {
  const segs = String(fullPath || '').split('/').map((x) => x.trim()).filter(Boolean);
  for (let i = segs.length - 2; i >= 0; i -= 1) {
    if (!roots.has(norm(segs[i]))) continue;
    const cand = segs[i + 1];
    if (cand && !roots.has(norm(cand)) && slug(cand)) return { name: cand, depth: i + 2 };
  }
  return null;
}

/** Value of the first property whose name matches one of names (exact,
 *  case-insensitive, also without a system./auto./custom. prefix). */
function propValue(json, names) {
  const v = parseJson(json, null);
  if (!v) return null;
  const pairs = Array.isArray(v) ? v.map((p) => [p && p.name, p && p.value]) : Object.entries(v);
  for (const want of names) {
    const w = norm(want);
    if (!w) continue;
    for (const [n, val] of pairs) {
      const k = norm(n);
      if (!k || val == null) continue;
      if (k === w || k.replace(/^(system|auto|custom)\./, '') === w) {
        const out = String(val).trim();
        if (out) return out;
      }
    }
  }
  return null;
}

function hostnamePrefix(name) {
  const first = String(name || '').trim().split(/\s+/)[0] || '';
  const i = first.indexOf('-');
  if (i < 0) return null;
  const pre = first.slice(0, i);
  return pre.length >= 2 && pre.length <= 8 && /^[A-Za-z0-9]+$/.test(pre) ? pre : null;
}

/**
 * One device's site: {siteKey, siteName, source} or nulls. groupPaths maps
 * the device's group ids to full paths.
 */
function deriveDeviceSite(d, groupPaths, rules) {
  let best = null;
  for (const gid of parseJson(d.group_ids_json, []) || []) {
    const hit = siteFromPath(groupPaths.get(Number(gid)), rules.roots);
    if (hit && (!best || hit.depth > best.depth)) best = hit;
  }
  if (best) return { siteKey: slug(best.name), siteName: best.name, source: 'group' };
  const names = [rules.property, 'location', 'system.location'].filter(Boolean);
  for (const json of [d.custom_props_json, d.auto_props_json, d.system_props_json]) {
    const v = propValue(json, names);
    if (v && v.length < 40 && slug(v)) return { siteKey: slug(v), siteName: v, source: 'property' };
  }
  if (rules.fromHostname) {
    const pre = hostnamePrefix(d.display_name) || hostnamePrefix(d.name);
    if (pre && slug(pre)) return { siteKey: slug(pre), siteName: pre, source: 'hostname' };
  }
  return { siteKey: null, siteName: null, source: null };
}

/**
 * Apply the site rules to devices, collectors, checks and check locations of
 * one portal (or all), then rewrite lm_sites. Returns {sites, devices,
 * devicesNoSite}.
 */
function computeSites(dbh, sourceId = null) {
  const out = { sites: 0, devices: 0, devicesNoSite: 0 };
  try {
    const sources = dbh.prepare(`SELECT * FROM lm_sources ${sourceId != null ? 'WHERE id = ?' : ''}`).all(...(sourceId != null ? [sourceId] : []));
    for (const src of sources) {
      const r = computeOneSource(dbh, src);
      out.sites += r.sites; out.devices += r.devices; out.devicesNoSite += r.devicesNoSite;
    }
  } catch { /* a missing table (partial migration) must not break the poll */ }
  return out;
}

function computeOneSource(dbh, src) {
  const rules = siteRules(src);
  const groupPaths = new Map(dbh.prepare('SELECT lm_group_id, full_path FROM lm_device_groups WHERE source_id = ? AND stale = 0').all(src.id)
    .map((g) => [Number(g.lm_group_id), g.full_path]));
  const devices = dbh.prepare('SELECT * FROM lm_devices WHERE source_id = ? AND stale = 0 ORDER BY display_name, lm_device_id').all(src.id);
  const collectors = dbh.prepare('SELECT * FROM lm_collectors WHERE source_id = ? AND stale = 0 ORDER BY hostname, collector_id').all(src.id);
  const checks = dbh.prepare('SELECT * FROM lm_checks WHERE source_id = ? AND stale = 0').all(src.id);
  const locations = dbh.prepare('SELECT source_id, check_id, checkpoint_id, collector_id FROM lm_check_locations WHERE source_id = ? AND stale = 0').all(src.id);

  const siteNames = new Map(); // key -> first display name
  const noteName = (key, name) => { if (key && !siteNames.has(key)) siteNames.set(key, name); };

  // Devices.
  const derived = new Map();
  for (const d of devices) {
    const s = deriveDeviceSite(d, groupPaths, rules);
    derived.set(d.lm_device_id, s);
    noteName(s.siteKey, s.siteName);
  }

  // Collectors: the site most of their devices share, else the hostname rule.
  const collectorSite = new Map();
  for (const c of collectors) {
    const tally = new Map();
    for (const d of devices) {
      if (d.collector_id !== c.collector_id) continue;
      const s = derived.get(d.lm_device_id);
      if (s && s.siteKey) tally.set(s.siteKey, (tally.get(s.siteKey) || 0) + 1);
    }
    let key = null;
    let best = 0;
    for (const [k, n] of tally) if (n > best || (n === best && key != null && k < key)) { key = k; best = n; }
    let name = key ? siteNames.get(key) : null;
    if (!key && rules.fromHostname) {
      const pre = hostnamePrefix(c.description) || hostnamePrefix(c.hostname);
      if (pre && slug(pre)) { key = slug(pre); name = pre; noteName(key, name); }
    }
    collectorSite.set(c.collector_id, key ? { siteKey: key, siteName: name } : { siteKey: null, siteName: null });
  }

  // Checks: the device the target names, else the first token of the name.
  const byAddr = new Map();
  for (const d of devices) {
    const s = derived.get(d.lm_device_id);
    if (!s || !s.siteKey) continue;
    const keys = [d.display_name, d.name, d.sysname, d.hostname, ...(parseJson(d.ips_json, []) || [])];
    for (const k of keys) { const n = norm(k); if (n && !byAddr.has(n)) byAddr.set(n, s); }
  }
  const checkSite = new Map();
  for (const c of checks) {
    const t = norm(c.target);
    let s = t ? (byAddr.get(t) || (IPV4.test(t) ? null : byAddr.get(t.split('.')[0]))) : null;
    if (!s && rules.fromHostname) {
      const pre = hostnamePrefix(c.name);
      if (pre && slug(pre)) { s = { siteKey: slug(pre), siteName: pre }; noteName(s.siteKey, pre); }
    }
    checkSite.set(c.check_id, s && s.siteKey ? s : { siteKey: null, siteName: null });
  }
  const internal = new Set(checks.filter((c) => Number(c.is_internal) === 1).map((c) => c.check_id));

  const nameOf = (key) => siteNames.get(key) || key;
  const txn = dbh.transaction(() => {
    const updDev = dbh.prepare('UPDATE lm_devices SET site_key = ?, site_name = ?, site_source = ? WHERE source_id = ? AND lm_device_id = ?');
    for (const d of devices) {
      const s = derived.get(d.lm_device_id);
      updDev.run(s.siteKey, s.siteKey ? nameOf(s.siteKey) : null, s.source, src.id, d.lm_device_id);
    }
    const updCol = dbh.prepare('UPDATE lm_collectors SET site_key = ?, site_name = ? WHERE source_id = ? AND collector_id = ?');
    for (const c of collectors) {
      const s = collectorSite.get(c.collector_id);
      updCol.run(s.siteKey, s.siteKey ? nameOf(s.siteKey) : null, src.id, c.collector_id);
    }
    const updChk = dbh.prepare('UPDATE lm_checks SET site_key = ?, site_name = ? WHERE source_id = ? AND check_id = ?');
    for (const c of checks) {
      const s = checkSite.get(c.check_id);
      updChk.run(s.siteKey, s.siteKey ? nameOf(s.siteKey) : null, src.id, c.check_id);
    }
    const updLoc = dbh.prepare('UPDATE lm_check_locations SET site_key = ? WHERE source_id = ? AND check_id = ? AND checkpoint_id = ?');
    for (const l of locations) {
      const key = internal.has(l.check_id) && l.collector_id != null ? (collectorSite.get(l.collector_id) || {}).siteKey || null : null;
      updLoc.run(key, src.id, l.check_id, l.checkpoint_id);
    }
    dbh.prepare('DELETE FROM lm_sites WHERE source_id = ?').run(src.id);
    const ins = dbh.prepare(`
      INSERT INTO lm_sites (source_id, site_key, site_name, device_count, network_count, collector_ids_json, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, datetime('now'))
    `);
    const keys = new Set([...siteNames.keys()]);
    for (const key of [...keys].sort()) {
      const devs = devices.filter((d) => derived.get(d.lm_device_id).siteKey === key);
      const cols = collectors.filter((c) => collectorSite.get(c.collector_id).siteKey === key).map((c) => c.collector_id);
      if (!devs.length && !cols.length) continue;
      ins.run(src.id, key, nameOf(key), devs.length, devs.filter((d) => Number(d.is_network) === 1).length, JSON.stringify(cols));
    }
  });
  txn();
  const siteCount = dbh.prepare('SELECT COUNT(*) n FROM lm_sites WHERE source_id = ?').get(src.id).n;
  return { sites: siteCount, devices: devices.length, devicesNoSite: [...derived.values()].filter((s) => !s.siteKey).length };
}

/**
 * Site of any host name or ip: an LM device (display name, name, sysname,
 * hostname, ips, short names) or, for a server the LM inventory does not
 * know, the switch its vCenter NIC hints name. Returns {sourceId, siteKey,
 * siteName} or null.
 */
function siteOf(dbh, { names = [], ips = [] } = {}) {
  try {
    const nameSet = new Set();
    for (const n of names || []) {
      const k = norm(n);
      if (!k) continue;
      nameSet.add(k);
      if (!IPV4.test(k)) nameSet.add(k.split('.')[0]);
    }
    const ipSet = new Set((ips || []).map(norm).filter(Boolean));
    for (const n of [...nameSet]) if (IPV4.test(n)) ipSet.add(n);
    if (!nameSet.size && !ipSet.size) return null;
    const rows = dbh.prepare(`
      SELECT source_id, lm_device_id, display_name, name, sysname, hostname, ips_json, site_key, site_name
      FROM lm_devices WHERE stale = 0 AND site_key IS NOT NULL
    `).all();
    const hit = (names2, ips2) => rows.find((d) => {
      const own = [d.display_name, d.name, d.sysname, d.hostname].map(norm).filter(Boolean);
      for (const o of own) {
        if (names2.has(o)) return true;
        if (!IPV4.test(o) && names2.has(o.split('.')[0]) && o.split('.')[0].length >= 3) return true;
      }
      const dips = parseJson(d.ips_json, []) || [];
      return dips.some((ip) => ips2.has(norm(ip))) || own.some((o) => ips2.has(o));
    });
    let d = hit(nameSet, ipSet);
    if (!d && tableExists(dbh, 'vcenter_host_nic_neighbors')) {
      // A server or ESX host (or a VM through its host): the switch it is plugged into.
      const ep = endpoints();
      const { anchor, nameSet: ns } = ep.resolveAnchor(dbh, names, ips);
      const hostNames = new Set([...ns, ...(anchor.hostName ? [norm(anchor.hostName), norm(anchor.hostName).split('.')[0]] : [])]);
      const hint = dbh.prepare('SELECT host_name, switch_name, switch_address FROM vcenter_host_nic_neighbors ORDER BY captured_at DESC').all()
        .find((h) => hostNames.has(norm(h.host_name)) || hostNames.has(norm(h.host_name).split('.')[0]));
      if (hint) {
        const sw = ep.buildSwitchIndex(dbh).resolve(hint.switch_name, hint.switch_address);
        if (sw) d = rows.find((x) => x.source_id === sw.source_id && x.lm_device_id === sw.lm_device_id);
      }
    }
    return d ? { sourceId: d.source_id, siteKey: d.site_key, siteName: d.site_name || d.site_key } : null;
  } catch {
    return null;
  }
}

module.exports = { slug, siteRules, siteFromPath, propValue, hostnamePrefix, deriveDeviceSite, computeSites, siteOf, DEFAULT_ROOTS };
