// LogicMonitor network path model (round 3): tiers, the upstream path from a
// server or device to the WAN edge, hop health, blame, and the WAN circuit
// metrics. Everything is derived from stored lm_* tables plus the endpoint
// correlation in logicmonitorEndpoints; nothing here calls the portal.
//
// Tier rank (lm_devices.tier, recomputed daily and on demand): firewall and
// router 4 (WAN edge), switch named *core* 3, switch named *dist* / *agg* or
// with links to 3 or more switches 2, any other switch 1 (wireless and load
// balancers also 1), non-network devices NULL. Upstream from a device D is
// the far end of D's links whose tier is higher; ties go to the device with
// more links, then the lower id. When several links reach the chosen far
// device the healthiest wins, so a down LAG member never reads as the path.
const lmEndpoints = require('./logicmonitorEndpoints');

const issuesMod = () => require('./logicmonitorIssues');
const checksMod = () => require('./logicmonitorChecks');

const IPV4 = /^\d{1,3}(\.\d{1,3}){3}$/;
const norm = (s) => String(s == null ? '' : s).trim().toLowerCase();
const parseJson = (s, fallback) => {
  if (s == null || s === '') return fallback;
  try { const v = JSON.parse(s); return v == null ? fallback : v; } catch { return fallback; }
};
function tableExists(dbh, name) {
  try { return !!dbh.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?").get(name); } catch { return false; }
}
function sqlIso(val) {
  if (!val) return null;
  const s = String(val);
  const d = new Date(/[TZ]/.test(s) || /[+-]\d\d:?\d\d$/.test(s) ? s : `${s.replace(' ', 'T')}Z`);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}
const epochIso = (v) => (v == null || !Number.isFinite(Number(v)) || Number(v) <= 0 ? null : new Date(Number(v) * 1000).toISOString());
const sqlTs = (ms) => new Date(ms).toISOString().replace('T', ' ').slice(0, 19);
const threshold = (key, fallback) => { try { return issuesMod().getThreshold(key); } catch { return fallback; } };

const PORT_ISSUE_TYPES = new Set(['interface-errors-growing', 'interface-flapping', 'interface-utilization-high',
  'interface-util-anomaly', 'interface-error-anomaly']);

// -- Tiers ---------------------------------------------------------------------------

/** Tier rank for one network device given how many switches it links to. */
function tierValue(d, switchNeighbors = 0) {
  if (Number(d.is_network) !== 1) return null;
  const role = d.role;
  if (role === 'router' || role === 'firewall') return 4;
  if (role === 'switch') {
    const nm = norm(d.display_name || d.name);
    if (nm.includes('core')) return 3;
    if (/dist|agg/.test(nm) || switchNeighbors >= 3) return 2;
    return 1;
  }
  return 1;
}

const LM_LINKS_SQL = `
  SELECT source_id, src_device_id, src_instance_id, src_port, dst_device_id, dst_port, protocol
  FROM lm_topology_links
  WHERE COALESCE(stale, 0) = 0 AND dst_device_id IS NOT NULL AND src_device_id IS NOT NULL
    AND (dst_platform = 'logicmonitor' OR dst_platform IS NULL)
`;

/** Recompute lm_devices.tier for one portal (or all). Returns rows updated. */
function computeTiers(dbh, sourceId = null) {
  let updated = 0;
  try {
    const where = sourceId != null ? 'WHERE source_id = ? AND stale = 0' : 'WHERE stale = 0';
    const args = sourceId != null ? [sourceId] : [];
    const devs = dbh.prepare(`SELECT source_id, lm_device_id, display_name, name, role, is_network, tier FROM lm_devices ${where}`).all(...args);
    const role = new Map(devs.map((d) => [`${d.source_id}:${d.lm_device_id}`, d.role]));
    const nbrs = new Map();
    const add = (sid, a, b) => {
      if (role.get(`${sid}:${b}`) !== 'switch') return;
      const k = `${sid}:${a}`;
      if (!nbrs.has(k)) nbrs.set(k, new Set());
      nbrs.get(k).add(b);
    };
    for (const l of dbh.prepare(LM_LINKS_SQL).all()) {
      if (sourceId != null && l.source_id !== sourceId) continue;
      add(l.source_id, l.src_device_id, l.dst_device_id);
      add(l.source_id, l.dst_device_id, l.src_device_id);
    }
    const upd = dbh.prepare('UPDATE lm_devices SET tier = ? WHERE source_id = ? AND lm_device_id = ?');
    dbh.transaction(() => {
      for (const d of devs) {
        const t = tierValue(d, (nbrs.get(`${d.source_id}:${d.lm_device_id}`) || new Set()).size);
        if (t !== d.tier) { upd.run(t, d.source_id, d.lm_device_id); updated += 1; }
      }
    })();
  } catch { /* missing tables: nothing to rank */ }
  return updated;
}

// -- Context: lazy, cached reads for one pass --------------------------------------------

function makeContext(dbh, { endpoints = null } = {}) {
  const cache = { devices: null, endpoints, issues: null };
  const memo = (name, fn) => {
    const m = new Map();
    return (...a) => { const k = a.join(':'); if (!m.has(k)) m.set(k, fn(...a)); return m.get(k); };
  };
  const stmts = {};
  const prep = (key, sql) => { if (!stmts[key]) stmts[key] = dbh.prepare(sql); return stmts[key]; };
  const ctx = {
    db: dbh,
    maxHops: threshold('lm_path_max_hops', 6),
    endpoints() {
      if (!cache.endpoints) { try { cache.endpoints = lmEndpoints.endpointsAll(dbh); } catch { cache.endpoints = []; } }
      return cache.endpoints;
    },
    devices() {
      if (!cache.devices) {
        cache.devices = new Map();
        try {
          for (const d of dbh.prepare(`
            SELECT source_id, lm_device_id, display_name, name, sysname, hostname, ips_json, host_status, dead_since, role,
              is_network, tier, site_key, site_name, collector_id FROM lm_devices WHERE stale = 0
          `).all()) cache.devices.set(`${d.source_id}:${d.lm_device_id}`, d);
        } catch { /* no inventory */ }
      }
      return cache.devices;
    },
    device(sid, did) { return ctx.devices().get(`${sid}:${did}`) || null; },
    ifaces: memo('ifaces', (sid, did) => {
      try {
        return prep('ifaces', `SELECT instance_id, display_name, description, status, status_text, in_util_pct, out_util_pct
          FROM lm_interfaces WHERE source_id = ? AND lm_device_id = ? AND stale = 0`).all(sid, did);
      } catch { return []; }
    }),
    links: memo('links', (sid, did) => {
      try {
        return prep('links', `${LM_LINKS_SQL} AND source_id = ? AND (src_device_id = ? OR dst_device_id = ?) ORDER BY src_port`).all(sid, did, did);
      } catch { return []; }
    }),
    alerts: memo('alerts', (sid, did) => {
      try {
        return prep('alerts', `SELECT severity, start_epoch, resource_template_name, instance_name, data_point_name, instance_id
          FROM lm_alerts WHERE source_id = ? AND lm_device_id = ? AND cleared = 0 AND COALESCE(sdted, 0) = 0 AND shadowed_by IS NULL
          ORDER BY severity DESC, start_epoch`).all(sid, did);
      } catch { return []; }
    }),
    openIssues() {
      if (!cache.issues) {
        cache.issues = new Map();
        try {
          for (const r of dbh.prepare("SELECT severity, type, target, message, first_seen FROM lm_issue_history WHERE status = 'open'").all()) {
            const k = norm(r.target);
            if (!cache.issues.has(k)) cache.issues.set(k, []);
            cache.issues.get(k).push({ severity: r.severity, type: r.type, message: r.message, firstSeen: sqlIso(r.first_seen) });
          }
        } catch { /* no issue history */ }
      }
      return cache.issues;
    },
    downSince: memo('downSince', (sid, instanceId) => {
      try {
        const rows = prep('downSince', 'SELECT status, captured_at FROM lm_interface_history WHERE source_id = ? AND instance_id = ? ORDER BY captured_at DESC, id DESC LIMIT 400').all(sid, instanceId);
        let since = null;
        for (const r of rows) { if (r.status === 2) since = r.captured_at; else break; }
        return sqlIso(since);
      } catch { return null; }
    }),
    /** Tier of a device: the stored rank, else the rule on the fly. */
    tier(sid, did) {
      const d = ctx.device(sid, did);
      if (!d) return 0;
      if (d.tier != null) return d.tier;
      const nb = new Set();
      for (const l of ctx.links(sid, did)) {
        const far = l.src_device_id === did ? l.dst_device_id : l.src_device_id;
        const f = ctx.device(sid, far);
        if (f && f.role === 'switch') nb.add(far);
      }
      return tierValue(d, nb.size) || 0;
    },
  };
  return ctx;
}

// -- Hops ----------------------------------------------------------------------------------

function portObj(iface, fallbackDisplay) {
  if (iface) {
    const st = iface.status_text || (iface.status == null ? 'unknown' : Number(iface.status) === 1 ? 'up' : Number(iface.status) === 2 ? 'down' : 'other');
    return { instanceId: iface.instance_id, display: iface.display_name, statusText: st };
  }
  return fallbackDisplay ? { instanceId: null, display: lmEndpoints.cleanPort(fallbackDisplay), statusText: 'unknown' } : null;
}

/** Best upstream step from device did, or null. */
function upstream(ctx, sid, did, visited) {
  const cur = ctx.tier(sid, did);
  const byFar = new Map();
  for (const l of ctx.links(sid, did)) {
    const outbound = l.src_device_id === did;
    const far = outbound ? l.dst_device_id : l.src_device_id;
    if (far === did || visited.has(`${sid}:${far}`)) continue;
    if (!ctx.device(sid, far)) continue;
    if (ctx.tier(sid, far) <= cur) continue;
    if (!byFar.has(far)) byFar.set(far, []);
    byFar.get(far).push({ l, outbound });
  }
  if (!byFar.size) return null;
  const ranked = [...byFar.keys()].sort((a, b) => ctx.tier(sid, b) - ctx.tier(sid, a)
    || ctx.links(sid, b).length - ctx.links(sid, a).length || a - b);
  const far = ranked[0];
  const farIfaces = ctx.ifaces(sid, far);
  const ownIfaces = ctx.ifaces(sid, did);
  const options = byFar.get(far).map(({ l, outbound }) => {
    if (outbound) {
      const own = ownIfaces.find((i) => i.instance_id === l.src_instance_id) || null;
      const farIf = l.dst_port ? lmEndpoints.matchPort(l.dst_port, farIfaces).iface : null;
      return { outPort: portObj(own, l.src_port), farPort: portObj(farIf, l.dst_port) };
    }
    const farIf = farIfaces.find((i) => i.instance_id === l.src_instance_id) || null;
    const own = l.dst_port ? lmEndpoints.matchPort(l.dst_port, ownIfaces).iface : null;
    return { outPort: portObj(own, l.dst_port), farPort: portObj(farIf, l.src_port) };
  });
  const rank = (o) => (o.outPort && o.outPort.statusText === 'down' ? 2 : o.outPort && o.outPort.statusText === 'up' ? 0 : 1);
  options.sort((a, b) => rank(a) - rank(b) || String(a.outPort && a.outPort.display).localeCompare(String(b.outPort && b.outPort.display), undefined, { numeric: true }));
  return { farId: far, outPort: options[0].outPort, farPort: options[0].farPort };
}

/**
 * Health of one hop: {state: 'ok'|'warning'|'critical', reason, since, kind,
 * port}. kind is 'dead' | 'port-down' | 'alert' | 'issue' | null; the
 * dependency suppression only trusts 'dead' and 'port-down'.
 */
// A device-level alert (CPU, memory, Host Status) names a datasource
// instance, not a port; only interface datasources put their instance into
// the blame's port field so the UI never reads "via core-01 CPU-1".
const IF_DS = /^(SNMP_Network_Interfaces|snmp64_If-|snmpIf-)/i;
const alertPort = (a) => (a && a.instance_name && IF_DS.test(String(a.resource_template_name || '')) ? a.instance_name : null);

function hopHealth(dbh, hop, ctx = null) {
  const c = ctx || makeContext(dbh);
  const ok = { state: 'ok', reason: null, since: null, kind: null, port: null };
  try {
    const dev = c.device(hop.sourceId, hop.deviceId);
    const name = hop.deviceName || (dev && (dev.display_name || dev.name)) || `device ${hop.deviceId}`;
    if (dev && dev.host_status === 'dead') {
      return { state: 'critical', reason: `${name} is not responding to its collector`, since: sqlIso(dev.dead_since), kind: 'dead', port: null };
    }
    const ports = [hop.outPort, hop.inPort].filter(Boolean);
    for (const p of ports) {
      if (p.statusText === 'down') {
        return { state: 'critical', reason: `port ${p.display} on ${name} is down`, since: p.instanceId != null ? c.downSince(hop.sourceId, p.instanceId) : null, kind: 'port-down', port: p.display };
      }
    }
    const alerts = c.alerts(hop.sourceId, hop.deviceId);
    const crit = alerts.find((a) => Number(a.severity) >= 4);
    if (crit) {
      return {
        state: 'critical',
        reason: `LogicMonitor critical alert on ${name}: ${[crit.resource_template_name, crit.instance_name, crit.data_point_name].filter(Boolean).join(' ')}`.trim(),
        since: epochIso(crit.start_epoch), kind: 'alert', port: alertPort(crit),
      };
    }
    for (const p of ports) {
      const found = (c.openIssues().get(norm(`${name} ${p.display}`)) || []).find((i) => PORT_ISSUE_TYPES.has(i.type));
      if (found) return { state: 'warning', reason: found.message, since: found.firstSeen, kind: 'issue', port: p.display };
    }
    const warn = alerts.find((a) => Number(a.severity) === 3);
    if (warn) {
      return {
        state: 'warning',
        reason: `LogicMonitor error alert on ${name}: ${[warn.resource_template_name, warn.instance_name, warn.data_point_name].filter(Boolean).join(' ')}`.trim(),
        since: epochIso(warn.start_epoch), kind: 'alert', port: alertPort(warn),
      };
    }
    return ok;
  } catch {
    return ok;
  }
}

/** Walk upstream from a starting device; returns hops with health attached. */
function buildChain(dbh, ctx, start, chainNo) {
  const hops = [];
  const visited = new Set();
  let cur = start;
  while (cur && hops.length < ctx.maxHops) {
    const dev = ctx.device(cur.sourceId, cur.deviceId);
    if (!dev) break;
    visited.add(`${cur.sourceId}:${cur.deviceId}`);
    const tier = ctx.tier(cur.sourceId, cur.deviceId);
    const hop = {
      sourceId: cur.sourceId, deviceId: cur.deviceId, deviceName: dev.display_name || dev.name, siteKey: dev.site_key || null,
      tier, inPort: cur.inPort || null, outPort: null, chain: chainNo, health: null,
    };
    const up = tier >= 4 ? null : upstream(ctx, cur.sourceId, cur.deviceId, visited);
    hop.outPort = up ? up.outPort : null;
    hop.health = hopHealth(dbh, hop, ctx);
    hops.push(hop);
    cur = up ? { sourceId: cur.sourceId, deviceId: up.farId, inPort: up.farPort } : null;
  }
  return hops;
}

/** LM devices (network only when asked) matching names or ips. */
function findLmDevices(ctx, names, ips, networkOnly = true) {
  const nameSet = new Set();
  for (const n of names || []) { const k = norm(n); if (k) { nameSet.add(k); if (!IPV4.test(k)) nameSet.add(k.split('.')[0]); } }
  const ipSet = new Set((ips || []).map(norm).filter(Boolean));
  for (const n of [...nameSet]) if (IPV4.test(n)) ipSet.add(n);
  const out = [];
  for (const d of ctx.devices().values()) {
    if (networkOnly && Number(d.is_network) !== 1) continue;
    const own = [d.display_name, d.name, d.sysname, d.hostname].map(norm).filter(Boolean);
    const dips = parseJson(d.ips_json, []) || [];
    if (own.some((o) => nameSet.has(o) || (!IPV4.test(o) && o.split('.')[0].length >= 3 && nameSet.has(o.split('.')[0])) || ipSet.has(o))
      || dips.some((ip) => ipSet.has(norm(ip)))) out.push(d);
  }
  return out;
}

/**
 * Ordered hops from the anchor's switch port(s) upstream to the first router
 * or firewall, at most lm_path_max_hops per chain. anchor {names, ips}: a
 * server, VM, ESX host or an LM network device itself. A dual homed server
 * yields one chain per switch port, chains concatenated in order (each hop
 * carries chain and its own position in `chain`/`pos`). [] when ICC knows
 * nothing about the anchor.
 */
function pathFor(dbh, anchor = {}, opts = {}) {
  try {
    const ctx = opts.ctx || makeContext(dbh);
    const names = anchor.names || [];
    const ips = anchor.ips || [];
    const starts = [];
    const seen = new Set();
    const sp = lmEndpoints.serverPath(dbh, { names, ips }, { endpoints: ctx.endpoints() });
    for (const p of sp.switchPorts) {
      const k = `${p.sourceId}:${p.deviceId}:${p.instanceId != null ? p.instanceId : p.port}`;
      if (seen.has(k) || !ctx.device(p.sourceId, p.deviceId)) continue;
      seen.add(k);
      starts.push({ sourceId: p.sourceId, deviceId: p.deviceId, inPort: portObj({ instance_id: p.instanceId, display_name: p.port, status_text: p.statusText }, p.port) });
    }
    if (!starts.length) {
      for (const d of findLmDevices(ctx, names, ips, true).slice(0, 2)) starts.push({ sourceId: d.source_id, deviceId: d.lm_device_id, inPort: null });
    }
    const out = [];
    let chainNo = 0;
    for (const s of starts.slice(0, 4)) {
      const chain = buildChain(dbh, ctx, s, chainNo);
      chain.forEach((h, i) => { h.pos = i; });
      out.push(...chain);
      chainNo += 1;
    }
    out.forEach((h, i) => { h.hopIndex = i; });
    return out;
  } catch {
    return [];
  }
}

const portOfHop = (hop) => (hop.health && hop.health.port) || (hop.inPort && hop.inPort.display) || (hop.outPort && hop.outPort.display) || null;
const blameFromHop = (hop, extra = {}) => ({
  deviceName: hop.deviceName, deviceId: hop.deviceId, sourceId: hop.sourceId, port: portOfHop(hop),
  state: hop.health.state, reason: hop.health.reason, since: hop.health.since, hopIndex: hop.hopIndex,
  kind: hop.health.kind, siteKey: hop.siteKey, chain: hop.chain, ...extra,
});

/** The hop to blame: the first critical hop, else the first warning hop. */
function blame(path) {
  const hops = Array.isArray(path) ? path : [];
  const hop = hops.find((h) => h.health && h.health.state === 'critical') || hops.find((h) => h.health && h.health.state === 'warning');
  return hop ? blameFromHop(hop) : null;
}

/** Highest-tier non-WAN device of a site (its core or distribution), else its router. */
function siteTopDevice(ctx, sourceId, siteKey) {
  const cands = [...ctx.devices().values()].filter((d) => d.source_id === sourceId && Number(d.is_network) === 1 && d.site_key === siteKey);
  cands.sort((a, b) => ((ctx.tier(sourceId, a.lm_device_id) >= 4 ? -1 : 1) * 10 + ctx.tier(sourceId, a.lm_device_id))
    - ((ctx.tier(sourceId, b.lm_device_id) >= 4 ? -1 : 1) * 10 + ctx.tier(sourceId, b.lm_device_id)) || 0);
  const switches = cands.filter((d) => ctx.tier(sourceId, d.lm_device_id) < 4);
  const pick = (switches.length ? switches : cands).sort((a, b) => ctx.tier(sourceId, b.lm_device_id) - ctx.tier(sourceId, a.lm_device_id)
    || ctx.links(sourceId, b.lm_device_id).length - ctx.links(sourceId, a.lm_device_id).length || a.lm_device_id - b.lm_device_id)[0];
  return pick || null;
}

/**
 * Blame for one check: the path to the check target plus, for an internal
 * check, the path from the collector's site toward the WAN. The worst hop on
 * either side wins, critical before warning, then the hop nearest the target.
 * Returns {deviceName, port, state, reason, since, hopIndex, side} or null.
 */
function blameForCheck(dbh, checkId, checkpointId = null, opts = {}) {
  try {
    const ctx = opts.ctx || makeContext(dbh);
    const check = dbh.prepare(`SELECT * FROM lm_checks WHERE check_id = ? ${opts.sourceId != null ? 'AND source_id = ?' : ''} ORDER BY stale ASC LIMIT 1`)
      .get(...[checkId, ...(opts.sourceId != null ? [opts.sourceId] : [])]);
    if (!check) return null;
    const target = String(check.target || '').trim();
    const tHops = target ? pathFor(dbh, { names: [target], ips: IPV4.test(target) ? [target] : [] }, { ctx }) : [];
    let sHops = [];
    if (Number(check.is_internal) === 1) {
      const loc = checkpointId != null
        ? dbh.prepare('SELECT collector_id FROM lm_check_locations WHERE source_id = ? AND check_id = ? AND checkpoint_id = ?').get(check.source_id, check.check_id, checkpointId)
        : null;
      const col = loc && loc.collector_id != null
        ? dbh.prepare('SELECT hostname, description, site_key FROM lm_collectors WHERE source_id = ? AND collector_id = ?').get(check.source_id, loc.collector_id)
        : null;
      if (col && col.site_key) {
        const top = siteTopDevice(ctx, check.source_id, col.site_key);
        if (top) {
          sHops = buildChain(dbh, ctx, { sourceId: top.source_id, deviceId: top.lm_device_id, inPort: null }, 0);
          sHops.forEach((h, i) => { h.pos = i; h.hopIndex = i; });
        }
      }
    }
    const cands = [];
    for (const h of tHops) if (h.health.state !== 'ok') cands.push({ hop: h, side: 'target', dist: h.hopIndex });
    for (const h of sHops) if (h.health.state !== 'ok') cands.push({ hop: h, side: 'source', dist: 1000 + (sHops.length - 1 - h.hopIndex) });
    if (!cands.length) return null;
    const rank = (c) => (c.hop.health.state === 'critical' ? 0 : 1);
    cands.sort((a, b) => rank(a) - rank(b) || a.dist - b.dist);
    return blameFromHop(cands[0].hop, { side: cands[0].side });
  } catch {
    return null;
  }
}

/** " Likely hop: <device> <port>, <reason> since <time>" or ''. */
function likelyHopText(b) {
  if (!b) return '';
  const when = b.since ? ` since ${new Date(b.since).toISOString().slice(0, 16).replace('T', ' ')} UTC` : '';
  return ` Likely hop: ${b.deviceName}${b.port ? ` ${b.port}` : ''}, ${b.reason || b.state}${when}`;
}

// -- Dependency suppression ------------------------------------------------------------------

/**
 * Why the alerts of one device are noise: the nearest hop above it whose
 * health is critical because the device is dead or the facing port is down.
 * Returns {sourceId, deviceId, deviceName, port, reason} or null.
 */
function shadowCause(dbh, ctx, sourceId, deviceId) {
  try {
    const dev = ctx.device(sourceId, deviceId);
    if (!dev) return null;
    let hops;
    if (Number(dev.is_network) === 1) {
      hops = buildChain(dbh, ctx, { sourceId, deviceId, inPort: null }, 0).slice(1);
    } else {
      const names = [dev.display_name, dev.name, dev.hostname].filter(Boolean);
      const ips = parseJson(dev.ips_json, []) || [];
      hops = pathFor(dbh, { names, ips }, { ctx });
    }
    for (const hop of hops) {
      const h = hop.health;
      if (h.state === 'critical' && (h.kind === 'dead' || h.kind === 'port-down')) {
        return { sourceId: hop.sourceId, deviceId: hop.deviceId, deviceName: hop.deviceName, port: h.kind === 'port-down' ? h.port : null, reason: h.kind === 'dead' ? 'dead' : 'port-down' };
      }
    }
  } catch { /* no cause */ }
  return null;
}

// -- WAN circuits ---------------------------------------------------------------------------------

const WAN_RE = /\b(wan|circuit|mpls|isp|carrier|zayo|lumen|att|verizon|comcast|cogent|internet|uplink to isp)\b/i;
const LINKISH_RE = /\bto\s|uplink|->/i;
const cleanPortKey = (p) => norm(lmEndpoints.cleanPort(p)).replace(/\s+/g, '');

// Circuit reference in free text: "CID: 12/ABCD/345678", "Circuit ID 4471-XY", "ckt# BBEC.123456".
const CID_TEXT_RE = /\b(?:cid|ckt(?:\s*id)?|circuit(?:\s*(?:id|ref|no|number))?)\s*[:#=-]?\s*([A-Za-z0-9][A-Za-z0-9./_:-]{3,})/i;
const CID_KEY_RE = /(circuit[._ -]?(id|ref|no|number)?$|\.cid$|^cid$|ckt)/i;
const CARRIER_KEY_RE = /(carrier|provider|isp|telco)$/i;
const CARRIER_RE = /\b(at&t|att|verizon|lumen|centurylink|level ?3|zayo|cogent|comcast|spectrum|charter|cox|windstream|frontier|gtt|bt|colt|vodafone|telstra|ntt|orange|tata|virgin media|openreach|megaport|equinix)\b/i;

/**
 * Circuit reference for one interface: {circuitId, carrier, alias, source}.
 * Instance custom properties win, then auto properties, then the ifAlias /
 * description text. props is lm_interfaces.props_json ({auto, system, custom}).
 */
function circuitInfo(description, props) {
  const p = typeof props === 'string' ? parseJson(props, {}) : (props || {});
  const alias = (p.auto && p.auto['auto.interface.alias']) || null;
  let circuitId = null; let carrier = null; let source = null;
  for (const [scope, map] of [['custom', p.custom], ['auto', p.auto]]) {
    for (const [k, v] of Object.entries(map || {})) {
      if (v == null || String(v).trim() === '') continue;
      if (!circuitId && CID_KEY_RE.test(k)) { circuitId = String(v).trim(); source = `${scope}:${k}`; }
      if (!carrier && CARRIER_KEY_RE.test(k)) carrier = String(v).trim();
    }
  }
  for (const text of [alias, description]) {
    if (!text) continue;
    if (!circuitId) {
      const m = CID_TEXT_RE.exec(text);
      // Carrier IDs always carry a digit; this skips "WAN circuit Lumen".
      if (m && /\d/.test(m[1])) { circuitId = m[1].replace(/[.,;:]+$/, ''); source = text === alias ? 'ifAlias' : 'description'; }
    }
    if (!carrier) {
      const c = CARRIER_RE.exec(text);
      if (c) carrier = c[1];
    }
  }
  return { circuitId, carrier, alias, source };
}

/** Parse lm_wan_overrides: "dev:port,!dev:port" -> [{device, port, exclude}]. */
function parseWanOverrides(text) {
  return String(text || '').split(',').map((x) => x.trim()).filter(Boolean).map((x) => {
    const exclude = x.startsWith('!');
    const body = exclude ? x.slice(1) : x;
    const i = body.indexOf(':');
    if (i <= 0) return null;
    return { device: norm(body.slice(0, i)), port: cleanPortKey(body.slice(i + 1)), exclude };
  }).filter((o) => o && o.port);
}

/** Mark lm_interfaces.is_wan by rule for one portal (or all). Returns {marked}. */
function computeCircuits(dbh, sourceId = null) {
  let marked = 0;
  try {
    const overrides = parseWanOverrides(issuesMod().getTextSetting('lm_wan_overrides'));
    const where = sourceId != null ? 'AND i.source_id = ?' : '';
    const args = sourceId != null ? [sourceId] : [];
    const rows = dbh.prepare(`
      SELECT i.source_id, i.instance_id, i.display_name, i.description, i.props_json, d.display_name AS dev_name, d.name AS dev_alt, d.role,
        EXISTS (SELECT 1 FROM lm_topology_links l WHERE l.source_id = i.source_id AND l.src_instance_id = i.instance_id
          AND COALESCE(l.stale, 0) = 0 AND l.dst_device_id IS NULL AND l.dst_platform IS NULL) AS unresolved
      FROM lm_interfaces i JOIN lm_devices d ON d.source_id = i.source_id AND d.lm_device_id = i.lm_device_id
      WHERE i.stale = 0 AND d.stale = 0 ${where}
    `).all(...args);
    const upd = dbh.prepare('UPDATE lm_interfaces SET is_wan = ?, wan_reason = ?, wan_label = ? WHERE source_id = ? AND instance_id = ?');
    dbh.transaction(() => {
      dbh.prepare(`UPDATE lm_interfaces SET is_wan = 0, wan_reason = NULL, wan_label = NULL WHERE is_wan != 0 ${sourceId != null ? 'AND source_id = ?' : ''}`).run(...args);
      for (const r of rows) {
        const dev = norm(r.dev_name);
        const alt = norm(r.dev_alt);
        const port = cleanPortKey(r.display_name);
        const ov = overrides.filter((o) => o.port === port && (o.device === dev || o.device === alt));
        if (ov.some((o) => o.exclude)) continue;
        let reason = null;
        if (ov.length) reason = 'override';
        else if (r.role === 'router' || r.role === 'firewall') {
          if (r.description && WAN_RE.test(r.description)) reason = 'carrier-description';
          else if (r.role === 'router' && r.unresolved && r.description && LINKISH_RE.test(r.description)) reason = 'unresolved-uplink';
        }
        if (!reason && circuitInfo(r.description, r.props_json).circuitId) reason = 'circuit-id';
        if (!reason) continue;
        upd.run(1, reason, r.description || `${r.dev_name || r.dev_alt} ${r.display_name}`, r.source_id, r.instance_id);
        marked += 1;
      }
    })();
  } catch { /* nothing to mark */ }
  return { marked };
}

const p95 = (arr) => {
  const a = arr.filter((v) => v != null && Number.isFinite(v)).sort((x, y) => x - y);
  if (!a.length) return null;
  return a[Math.min(a.length - 1, Math.max(0, Math.ceil(0.95 * a.length) - 1))];
};
const round1 = (v) => (v == null ? null : Math.round(v * 10) / 10);

/** Longest run of consecutive calendar days in a sorted list of YYYY-MM-DD. */
function longestDayRun(days) {
  let best = 0; let run = 0; let prev = null;
  for (const d of days) {
    const t = Date.parse(`${d}T00:00:00Z`);
    run = prev != null && t - prev === 86400000 ? run + 1 : 1;
    prev = t;
    if (run > best) best = run;
  }
  return best;
}

/**
 * One row per WAN circuit (lm_interfaces.is_wan = 1) with p95 utilization over
 * lm_circuit_sat_days, the daily peak, headroom, 24 h errors and flaps, the
 * busiest UTC hour and a state. satState is the saturation rule alone
 * (warning at p95 >= lm_circuit_sat_pct, critical at a daily peak >=
 * lm_circuit_crit_pct on 3 consecutive days); state also turns critical when
 * the circuit is down.
 */
function circuitRows(dbh, { sourceId = null, siteKey = null, nowMs = Date.now() } = {}) {
  const out = [];
  try {
    const satPct = threshold('lm_circuit_sat_pct', 80);
    const critPct = threshold('lm_circuit_crit_pct', 95);
    const days = threshold('lm_circuit_sat_days', 7);
    const where = ['i.is_wan = 1', 'i.stale = 0', 'd.stale = 0'];
    const args = [];
    if (sourceId != null) { where.push('i.source_id = ?'); args.push(sourceId); }
    if (siteKey) { where.push('d.site_key = ?'); args.push(siteKey); }
    const wans = dbh.prepare(`
      SELECT i.*, d.display_name AS dev_name, d.name AS dev_alt, d.site_key, d.site_name
      FROM lm_interfaces i JOIN lm_devices d ON d.source_id = i.source_id AND d.lm_device_id = i.lm_device_id
      WHERE ${where.join(' AND ')} ORDER BY d.display_name, i.display_name
    `).all(...args);
    if (!wans.length) return out;
    const winStart = sqlTs(nowMs - days * 86400000);
    const dayAgo = sqlTs(nowMs - 86400000);
    const dailyFrom = new Date(nowMs - Math.max(days, 3) * 86400000).toISOString().slice(0, 10);
    const histStmt = dbh.prepare('SELECT status, in_util_pct, out_util_pct, in_errors, out_errors, captured_at FROM lm_interface_history WHERE source_id = ? AND instance_id = ? AND captured_at >= ? ORDER BY captured_at, id');
    const dailyStmt = dbh.prepare('SELECT day, max_in_util_pct, max_out_util_pct FROM lm_interface_daily WHERE source_id = ? AND instance_id = ? AND day >= ? ORDER BY day');
    for (const w of wans) {
      const hist = histStmt.all(w.source_id, w.instance_id, winStart);
      const daily = dailyStmt.all(w.source_id, w.instance_id, dailyFrom);
      const p95In = p95(hist.map((h) => h.in_util_pct));
      const p95Out = p95(hist.map((h) => h.out_util_pct));
      const peak = (r) => Math.max(r.max_in_util_pct == null ? -1 : r.max_in_util_pct, r.max_out_util_pct == null ? -1 : r.max_out_util_pct);
      const sinceDay = new Date(nowMs - days * 86400000).toISOString().slice(0, 10);
      const peaks = daily.filter((r) => r.day >= sinceDay).map(peak).filter((v) => v >= 0);
      const maxDailyPct = peaks.length ? Math.max(...peaks) : null;
      const critRun = longestDayRun(daily.filter((r) => peak(r) >= critPct).map((r) => r.day));
      const last24 = hist.filter((h) => h.captured_at >= dayAgo);
      let flaps = 0; let prev = null;
      for (const h of last24) { if (h.status == null) continue; if (prev != null && h.status !== prev) flaps += 1; prev = h.status; }
      const byHour = new Map();
      for (const h of hist) {
        const u = Math.max(h.in_util_pct == null ? -1 : h.in_util_pct, h.out_util_pct == null ? -1 : h.out_util_pct);
        if (u < 0) continue;
        const hr = new Date(`${h.captured_at.replace(' ', 'T')}Z`).getUTCHours();
        const e = byHour.get(hr) || { sum: 0, n: 0 };
        e.sum += u; e.n += 1; byHour.set(hr, e);
      }
      let busiestHour = null; let busiest = -1;
      for (const [hr, e] of byHour) { if (e.sum / e.n > busiest) { busiest = e.sum / e.n; busiestHour = hr; } }
      const hi = Math.max(p95In == null ? -1 : p95In, p95Out == null ? -1 : p95Out);
      let satState = 'ok';
      if (hi >= satPct) satState = 'warning';
      if (critRun >= 3) satState = 'critical';
      const statusText = w.status_text || (w.status == null ? 'unknown' : Number(w.status) === 1 ? 'up' : Number(w.status) === 2 ? 'down' : 'other');
      const down = statusText === 'down' && Number(w.stop_monitoring) !== 1;
      const ci = circuitInfo(w.description, w.props_json);
      out.push({
        circuitId: ci.circuitId, carrier: ci.carrier, alias: ci.alias, circuitIdSource: ci.source,
        sourceId: w.source_id, deviceId: w.lm_device_id, deviceName: w.dev_name || w.dev_alt, siteKey: w.site_key || null, siteName: w.site_name || null,
        instanceId: w.instance_id, port: w.display_name, label: w.wan_label || w.description || `${w.dev_name || w.dev_alt} ${w.display_name}`,
        wanReason: w.wan_reason, speedBps: w.speed_bps, statusText, inUtilPct: w.in_util_pct, outUtilPct: w.out_util_pct,
        p95InPct: round1(p95In), p95OutPct: round1(p95Out), maxDailyPct: round1(maxDailyPct),
        headroomPct: hi >= 0 ? round1(Math.max(0, 100 - hi)) : null,
        errors24h: Math.round(last24.reduce((s, h) => s + (h.in_errors || 0) + (h.out_errors || 0), 0)),
        flaps24h: flaps, busiestHour, critDays: critRun, satState, state: down ? 'critical' : satState,
      });
    }
  } catch { /* no circuits */ }
  return out;
}

/** Hour-of-day profile (UTC) and the last 30 daily rows of one circuit; null when unknown. */
function circuitProfile(dbh, instanceId, sourceId = null) {
  try {
    const row = dbh.prepare(`SELECT source_id FROM lm_interfaces WHERE instance_id = ? ${sourceId != null ? 'AND source_id = ?' : ''} LIMIT 1`)
      .get(...[instanceId, ...(sourceId != null ? [sourceId] : [])]);
    if (!row) return null;
    const hist = dbh.prepare('SELECT in_util_pct, out_util_pct, captured_at FROM lm_interface_history WHERE source_id = ? AND instance_id = ?').all(row.source_id, instanceId);
    const hours = Array.from({ length: 24 }, (_, hour) => ({ hour, sIn: 0, nIn: 0, sOut: 0, nOut: 0, maxIn: null, maxOut: null }));
    for (const h of hist) {
      const e = hours[new Date(`${h.captured_at.replace(' ', 'T')}Z`).getUTCHours()];
      if (h.in_util_pct != null) { e.sIn += h.in_util_pct; e.nIn += 1; e.maxIn = e.maxIn == null ? h.in_util_pct : Math.max(e.maxIn, h.in_util_pct); }
      if (h.out_util_pct != null) { e.sOut += h.out_util_pct; e.nOut += 1; e.maxOut = e.maxOut == null ? h.out_util_pct : Math.max(e.maxOut, h.out_util_pct); }
    }
    const daily = dbh.prepare('SELECT * FROM lm_interface_daily WHERE source_id = ? AND instance_id = ? ORDER BY day DESC LIMIT 30').all(row.source_id, instanceId).reverse()
      .map((d) => ({
        day: d.day, samples: d.samples, maxInPct: d.max_in_util_pct, maxOutPct: d.max_out_util_pct,
        avgInPct: d.avg_in_util_pct, avgOutPct: d.avg_out_util_pct, flaps: d.flaps, errorsSum: d.errors_sum,
      }));
    return {
      hours: hours.map((e) => ({ hour: e.hour, avgInPct: e.nIn ? round1(e.sIn / e.nIn) : null, avgOutPct: e.nOut ? round1(e.sOut / e.nOut) : null, maxInPct: round1(e.maxIn), maxOutPct: round1(e.maxOut) })),
      daily,
    };
  } catch {
    return null;
  }
}

// -- Read-only helpers for the Ops Agent (evidence and capabilities) ----------------------------

const hhmm = (sqlStamp) => String(sqlStamp || '').slice(11, 16);
const num0 = (v) => (v == null || !Number.isFinite(Number(v)) ? '-' : String(Math.round(Number(v) * 10) / 10));

/**
 * Last 60 minutes of lm_interface_history for the host's switch ports, with
 * the baseline for the current UTC hour. Database only. Returns {text, ports}.
 */
function portHistoryText(dbh, anchor, { nowMs = Date.now(), ctx = null } = {}) {
  try {
    const c = ctx || makeContext(dbh);
    const sp = lmEndpoints.serverPath(dbh, anchor, { endpoints: c.endpoints() });
    const ports = sp.switchPorts.filter((p) => p.instanceId != null).slice(0, 4);
    if (!ports.length) return { text: 'no switch port known for this host', ports: [] };
    const since = sqlTs(nowMs - 3600000);
    const hour = new Date(nowMs).getUTCHours();
    const lines = [];
    for (const p of ports) {
      const rows = dbh.prepare('SELECT captured_at, status, in_util_pct, out_util_pct, in_errors, out_errors FROM lm_interface_history WHERE source_id = ? AND instance_id = ? AND captured_at >= ? ORDER BY captured_at DESC, id DESC LIMIT 8')
        .all(p.sourceId, p.instanceId, since).reverse();
      const bl = dbh.prepare('SELECT util_median, util_mad, err_median FROM lm_interface_baseline WHERE source_id = ? AND instance_id = ? AND hour_of_day = ?').get(p.sourceId, p.instanceId, hour);
      lines.push(`${p.deviceName} ${p.port} (${p.statusText}${p.nic ? `, ${p.nic}` : ''}): ${rows.length ? '' : 'no samples in the last hour'}${bl && bl.util_median != null ? `baseline this hour ${num0(bl.util_median)} +/- ${num0(bl.util_mad)}%` : ''}`.trim());
      for (const r of rows) {
        lines.push(`  ${hhmm(r.captured_at)} UTC ${r.status === 2 ? 'down' : r.status === 1 ? 'up' : 'status ' + (r.status == null ? '?' : r.status)} in ${num0(r.in_util_pct)}% out ${num0(r.out_util_pct)}% errors ${num0((r.in_errors || 0) + (r.out_errors || 0))}`);
      }
    }
    return { text: lines.join('\n'), ports: ports.length };
  } catch {
    return { text: 'port history unavailable', ports: 0 };
  }
}

/** Effective SDTs on the host's device, its switches' devices and its site's devices. */
function sdtLookup(dbh, anchor, { siteKey = null, nowMs = Date.now(), ctx = null } = {}) {
  const out = [];
  try {
    const c = ctx || makeContext(dbh);
    const keys = new Map(); // "source:device" -> scope label
    for (const d of findLmDevices(c, anchor.names || [], anchor.ips || [], false)) keys.set(`${d.source_id}:${d.lm_device_id}`, { scope: 'device', name: d.display_name || d.name });
    const sp = lmEndpoints.serverPath(dbh, anchor, { endpoints: c.endpoints() });
    for (const p of sp.switchPorts) if (!keys.has(`${p.sourceId}:${p.deviceId}`)) keys.set(`${p.sourceId}:${p.deviceId}`, { scope: 'switch', name: p.deviceName });
    const stmt = dbh.prepare('SELECT * FROM lm_sdts WHERE source_id = ? AND stale = 0 AND lm_device_id = ? AND (is_effective = 1 OR (start_ms <= ? AND end_ms >= ?))');
    for (const [k, v] of keys) {
      const [sid, did] = k.split(':').map(Number);
      for (const r of stmt.all(sid, did, nowMs, nowMs)) out.push({ scope: v.scope, name: v.name, until: r.end_ms ? new Date(r.end_ms).toISOString() : null, comment: r.comment || null });
    }
    if (siteKey) {
      const rows = dbh.prepare(`
        SELECT DISTINCT d.display_name, s.end_ms, s.comment FROM lm_sdts s JOIN lm_devices d ON d.source_id = s.source_id AND d.lm_device_id = s.lm_device_id
        WHERE s.stale = 0 AND d.stale = 0 AND d.site_key = ? AND (s.is_effective = 1 OR (s.start_ms <= ? AND s.end_ms >= ?)) LIMIT 20
      `).all(siteKey, nowMs, nowMs);
      for (const r of rows) {
        if (out.some((o) => o.name === r.display_name)) continue;
        out.push({ scope: 'site', name: r.display_name, until: r.end_ms ? new Date(r.end_ms).toISOString() : null, comment: r.comment || null });
      }
    }
  } catch { /* none */ }
  return out;
}

/** Plain text for a path: one line per hop, then the blame. */
function pathText(path) {
  const hops = Array.isArray(path) ? path : [];
  if (!hops.length) return 'no network path known for this host';
  const lines = hops.map((h) => `hop ${h.hopIndex + 1}${h.chain ? ` (chain ${h.chain + 1})` : ''}: ${h.deviceName} tier ${h.tier || '?'}`
    + `${h.inPort ? ` in ${h.inPort.display} ${h.inPort.statusText}` : ''}${h.outPort ? ` out ${h.outPort.display} ${h.outPort.statusText}` : ''}`
    + ` - ${h.health.state}${h.health.reason ? `: ${h.health.reason}` : ''}`);
  const b = blame(hops);
  lines.push(b ? `blame:${likelyHopText(b)}` : 'blame: no unhealthy hop');
  return lines.join('\n');
}

module.exports = {
  portHistoryText, sdtLookup, pathText,
  PORT_ISSUE_TYPES, WAN_RE,
  tierValue, computeTiers, makeContext, hopHealth, pathFor, blame, blameForCheck, likelyHopText, shadowCause,
  buildChain, findLmDevices, portObj,
  computeCircuits, parseWanOverrides, circuitRows, circuitProfile, p95, longestDayRun, circuitInfo,
};
