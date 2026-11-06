// LogicMonitor groups as services (round 14). Read side only: nothing here writes.
// deviceStates() rolls every non-stale device up to ok | degraded | failed from host
// status, SDT, open alerts and open computed issues; buildGroupTree() rolls those
// device states up the lm_device_groups tree; services() lists the groups the
// operator picked (app_settings lm_service_groups) with their label.
const { memoByDbState } = require('../core/dbMemo');
const { getSetting } = require('./settings');

const lmIssues = () => require('./logicmonitorIssues');

const RANK = { ok: 0, degraded: 1, failed: 2 };
const SERVICE_KEY = 'lm_service_groups';
const MAX_PICKS = 64;
const CHUNK = 400;

const parseArr = (s) => {
  if (s == null || s === '') return [];
  try { const v = JSON.parse(s); return Array.isArray(v) ? v : []; } catch { return []; }
};
// sdtStatus "none-none-none": any non-none slot means in SDT (same as routes inSdt).
function inSdt(s) {
  if (!s) return false;
  return String(s).toLowerCase().split('-').some((p) => p && p !== 'none');
}
function sqlMs(val) {
  if (!val) return null;
  const s = String(val);
  const at = Date.parse(/[TZ]/.test(s) || /[+-]\d\d:?\d\d$/.test(s) ? s : `${s.replace(' ', 'T')}Z`);
  return Number.isFinite(at) ? at : null;
}
const pad2 = (n) => String(n).padStart(2, '0');
const clip = (s, n) => {
  const t = String(s == null ? '' : s).replace(/\s+/g, ' ').trim();
  return t.length > n ? `${t.slice(0, n - 1)}.` : t;
};
function chunks(arr, n = CHUNK) {
  const out = [];
  for (let i = 0; i < arr.length; i += n) out.push(arr.slice(i, i + n));
  return out;
}

// ---- Device state ---------------------------------------------------------

function computeSourceStates(db, sourceId, nowMs) {
  const graceMs = (() => { try { return lmIssues().getThreshold('lm_dead_grace_min') * 60000; } catch { return 600000; } })();
  const srcRow = db.prepare('SELECT name FROM lm_sources WHERE id = ?').get(sourceId);
  const srcName = srcRow ? srcRow.name : null;
  const devices = db.prepare('SELECT * FROM lm_devices WHERE source_id = ? AND stale = 0').all(sourceId);

  const alertsBy = new Map();
  const alertRows = db.prepare(`
    SELECT lm_device_id, severity_norm, resource_template_name, data_point_name, instance_name, monitor_object_name
    FROM lm_alerts
    WHERE source_id = ? AND cleared = 0 AND duplicate_of IS NULL AND shadowed_by IS NULL
      AND lm_device_id IS NOT NULL AND severity_norm IN ('critical', 'warning')
    ORDER BY start_epoch DESC, id DESC
  `).all(sourceId);
  for (const a of alertRows) {
    let e = alertsBy.get(a.lm_device_id);
    if (!e) { e = { crit: [], warn: [] }; alertsBy.set(a.lm_device_id, e); }
    (a.severity_norm === 'critical' ? e.crit : e.warn).push(a.resource_template_name || a.data_point_name || a.instance_name || a.monitor_object_name || 'alert');
  }

  // Device name resolution for issue targets (same rule as logicmonitorOverview.resolveDevice).
  const devByName = new Map();
  for (const d of devices) {
    for (const n of [d.display_name, d.name]) {
      if (!n) continue;
      const k = String(n).toLowerCase();
      if (!devByName.has(k)) devByName.set(k, d);
    }
  }
  const resolveDevice = (target) => {
    const low = String(target || '').trim().toLowerCase();
    if (!low) return null;
    const whole = devByName.get(low);
    if (whole) return whole;
    for (let i = low.length - 1; i > 0; i -= 1) {
      if (low[i] !== ' ' && low[i] !== ':' && low[i] !== '/') continue;
      const d = devByName.get(low.slice(0, i));
      if (d) return d;
    }
    return null;
  };
  const issuesBy = new Map();
  if (srcName != null) {
    const issueRows = db.prepare(`
      SELECT type, target, severity FROM lm_issue_history
      WHERE status = 'open' AND source = ? AND severity IN ('critical', 'warning')
      ORDER BY id DESC
    `).all(srcName);
    for (const i of issueRows) {
      const d = resolveDevice(i.target);
      if (!d) continue;
      let e = issuesBy.get(d.lm_device_id);
      if (!e) { e = { crit: [], warn: [] }; issuesBy.set(d.lm_device_id, e); }
      (i.severity === 'critical' ? e.crit : e.warn).push(i.type);
    }
  }

  const out = new Map();
  for (const d of devices) {
    let state = 'ok';
    const reasons = [];
    const bump = (s) => { if (RANK[s] > RANK[state]) state = s; };
    const isNet = Number(d.is_network) === 1;
    let failedDead = false;

    if (d.host_status === 'dead') {
      let deadMs = null;
      if (d.deleted_time_ms != null && d.deleted_time_ms > 0) deadMs = d.deleted_time_ms;
      else {
        const at = sqlMs(d.dead_since);
        if (at != null) deadMs = nowMs - at;
      }
      // Unknown dead duration cannot be shown to sit inside the grace window, so it counts.
      if (deadMs == null || deadMs >= graceMs) {
        failedDead = true;
        bump('failed');
        const at = sqlMs(d.dead_since);
        if (at != null) { const t = new Date(at); reasons.push(`dead since ${pad2(t.getHours())}:${pad2(t.getMinutes())}`); } else reasons.push('dead');
      }
    } else if (d.host_status === 'dead-collector') {
      bump('degraded');
      reasons.push('collector down');
    }
    if (inSdt(d.sdt_status)) { bump('degraded'); reasons.push('in SDT'); }

    const al = alertsBy.get(d.lm_device_id) || { crit: [], warn: [] };
    if (al.crit.length) { bump('failed'); reasons.push(`critical alert: ${clip(al.crit[0], 60)}`); }
    if (al.warn.length) { bump('degraded'); reasons.push(`warning alert: ${clip(al.warn[0], 60)}`); }
    const is = issuesBy.get(d.lm_device_id) || { crit: [], warn: [] };
    if (is.crit.length) { bump('failed'); reasons.push(`issue ${is.crit[0]}`); }
    if (is.warn.length) { bump('degraded'); reasons.push(`issue ${is.warn[0]}`); }

    out.set(`${sourceId}:${d.lm_device_id}`, {
      state,
      reasons: reasons.slice(0, 3),
      networkCritical: state === 'failed' && isNet && failedDead,
      isNetwork: isNet,
      name: d.name,
      displayName: d.display_name,
      siteKey: d.site_key || null,
      sourceId,
      deviceId: d.lm_device_id,
      openCritAlerts: al.crit.length,
      openWarnAlerts: al.warn.length,
      openIssues: is.crit.length + is.warn.length,
    });
  }
  return out;
}

function sourceIds(db, sourceId) {
  if (sourceId != null) return [Number(sourceId)];
  return db.prepare('SELECT id FROM lm_sources ORDER BY id').all().map((r) => r.id);
}

/** Map "<sourceId>:<lm_device_id>" -> { state, reasons, networkCritical, isNetwork, name, displayName, siteKey, ... }. */
function deviceStates(db, { sourceId = null } = {}) {
  const all = new Map();
  for (const sid of sourceIds(db, sourceId)) {
    const m = memoByDbState(db, `lmGroupDev|${sid}`, () => computeSourceStates(db, sid, Date.now()));
    for (const [k, v] of m) all.set(k, v);
  }
  return all;
}

// ---- Group tree -----------------------------------------------------------

function failPct() {
  try { return lmIssues().getThreshold('lm_group_fail_pct'); } catch { return 10; }
}
function failOnNetworkDead() {
  try { return lmIssues().getThreshold('lm_group_fail_on_network_dead') === 1; } catch { return true; }
}

function computeSourceTree(db, sourceId, states, pct, netRule) {
  const rows = db.prepare(`
    SELECT lm_group_id, parent_id, name, full_path, applies_to, num_of_hosts FROM lm_device_groups
    WHERE source_id = ? AND stale = 0 ORDER BY full_path, lm_group_id
  `).all(sourceId);
  const byId = new Map(rows.map((r) => [r.lm_group_id, r]));
  const isRoot = (r) => r.parent_id == null || Number(r.parent_id) === 0 || Number(r.parent_id) === r.lm_group_id;
  const parentOf = (r) => (isRoot(r) ? null : (byId.get(r.parent_id) || null));
  // A root row is not emitted; an orphan (parent row missing) is treated as a child of the root.
  const emitted = rows.filter((r) => !isRoot(r));

  const depthOf = (r) => {
    let depth = 0;
    let cur = parentOf(r);
    const seen = new Set([r.lm_group_id]);
    while (cur && !isRoot(cur) && !seen.has(cur.lm_group_id)) { seen.add(cur.lm_group_id); depth += 1; cur = parentOf(cur); }
    return depth;
  };

  // Membership: a device joins its group and every ancestor (distinct set per node).
  const members = new Map();
  const direct = new Map();
  const add = (map, gid, key) => {
    let s = map.get(gid);
    if (!s) { s = new Set(); map.set(gid, s); }
    s.add(key);
  };
  const devs = db.prepare('SELECT lm_device_id, group_ids_json FROM lm_devices WHERE source_id = ? AND stale = 0').all(sourceId);
  for (const d of devs) {
    const key = `${sourceId}:${d.lm_device_id}`;
    if (!states.has(key)) continue;
    for (const g of parseArr(d.group_ids_json)) {
      const gid = Number(g);
      let cur = byId.get(gid);
      if (!cur) continue;
      add(direct, gid, key);
      const seen = new Set();
      while (cur && !isRoot(cur) && !seen.has(cur.lm_group_id)) {
        seen.add(cur.lm_group_id);
        add(members, cur.lm_group_id, key);
        cur = parentOf(cur);
      }
    }
  }

  const nodes = [];
  const memberKeys = new Map();
  const directKeys = new Map();
  const parentIds = new Map();
  for (const r of emitted) {
    const id = `${sourceId}:${r.lm_group_id}`;
    const keys = [...(members.get(r.lm_group_id) || [])];
    const dkeys = [...(direct.get(r.lm_group_id) || [])];
    let crit = 0; let warn = 0; let ok = 0; let netDead = null;
    for (const k of keys) {
      const s = states.get(k);
      if (s.state === 'failed') { crit += 1; if (!netDead && s.networkCritical) netDead = s; } else if (s.state === 'degraded') warn += 1; else ok += 1;
    }
    const total = keys.length;
    const share = total ? (crit / total) * 100 : 0;
    const shareTxt = `${Math.round(share * 10) / 10}%`;
    let state;
    const reasons = [];
    if (total === 0) state = 'unknown';
    else if (share >= pct || (netRule && netDead)) {
      state = 'failed';
      if (netRule && netDead) reasons.push(`dead network device ${netDead.displayName || netDead.name}`);
      reasons.push(share >= pct ? `${crit} of ${total} failed (${shareTxt}, red line ${pct}%)` : `${crit} of ${total} failed (${shareTxt}, under the red line ${pct}%)`);
      if (warn) reasons.push(`${warn} degraded`);
    } else if (crit + warn > 0) {
      state = 'degraded';
      if (crit) reasons.push(`${crit} of ${total} failed (${shareTxt}, under the red line ${pct}%)`);
      if (warn) reasons.push(`${warn} degraded`);
    } else state = 'ok';
    const par = parentOf(r);
    const parentId = par && !isRoot(par) ? par.lm_group_id : null;
    const lastSeg = String(r.full_path || '').split('/').filter(Boolean).pop();
    nodes.push({
      id,
      sourceId,
      groupId: r.lm_group_id,
      parentId,
      name: r.name || lastSeg || `Group ${r.lm_group_id}`,
      fullPath: r.full_path || r.name || `Group ${r.lm_group_id}`,
      dynamic: !!(r.applies_to && String(r.applies_to).trim()),
      depth: depthOf(r),
      directDevices: dkeys.length,
      lmHosts: r.num_of_hosts == null ? null : Number(r.num_of_hosts),
      counts: { crit, warn, ok, total },
      state,
      reasons: reasons.slice(0, 3),
    });
    memberKeys.set(id, keys);
    directKeys.set(id, dkeys);
    parentIds.set(id, parentId == null ? null : `${sourceId}:${parentId}`);
  }
  return { nodes, memberKeys, directKeys, parentIds };
}

function blank() { return { generatedAt: new Date().toISOString(), nodes: [], summary: { groups: 0, failed: 0, degraded: 0, ok: 0, unknown: 0, devices: { crit: 0, warn: 0, ok: 0, total: 0 } } }; }

/**
 * { generatedAt, nodes, summary }. Also carries non-enumerable helpers:
 * membersOf(nodeId, { direct }) -> device keys, childrenOf(nodeId), descendantsOf(nodeId),
 * node(nodeId), states (the device state Map).
 */
function buildGroupTree(db, { sourceId = null } = {}) {
  const pct = failPct();
  const netRule = failOnNetworkDead();
  const states = new Map();
  const nodes = [];
  const memberKeys = new Map();
  const directKeys = new Map();
  const parentIds = new Map();
  for (const sid of sourceIds(db, sourceId)) {
    const part = memoByDbState(db, `lmGroups|${sid}|${pct}|${netRule ? 1 : 0}`, () => {
      const st = memoByDbState(db, `lmGroupDev|${sid}`, () => computeSourceStates(db, sid, Date.now()));
      return { st, tree: computeSourceTree(db, sid, st, pct, netRule) };
    });
    for (const [k, v] of part.st) states.set(k, v);
    nodes.push(...part.tree.nodes);
    for (const [k, v] of part.tree.memberKeys) memberKeys.set(k, v);
    for (const [k, v] of part.tree.directKeys) directKeys.set(k, v);
    for (const [k, v] of part.tree.parentIds) parentIds.set(k, v);
  }
  const summary = blank().summary;
  summary.groups = nodes.length;
  for (const n of nodes) summary[n.state] += 1;
  for (const s of states.values()) {
    summary.devices.total += 1;
    if (s.state === 'failed') summary.devices.crit += 1; else if (s.state === 'degraded') summary.devices.warn += 1; else summary.devices.ok += 1;
  }
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const out = { generatedAt: new Date().toISOString(), nodes, summary };
  const hide = (name, value) => Object.defineProperty(out, name, { value, enumerable: false });
  hide('states', states);
  hide('node', (id) => byId.get(id) || null);
  hide('membersOf', (id, opts = {}) => (opts.direct ? directKeys : memberKeys).get(id) || []);
  hide('childrenOf', (id) => nodes.filter((n) => parentIds.get(n.id) === id));
  hide('descendantsOf', (id) => {
    const res = [];
    const walk = (cur, seen) => {
      for (const c of nodes) {
        if (parentIds.get(c.id) === cur && !seen.has(c.id)) { seen.add(c.id); res.push(c); walk(c.id, seen); }
      }
    };
    walk(id, new Set([id]));
    return res;
  });
  return out;
}

// ---- Services -------------------------------------------------------------

const KEEP_UPPER = new Set(['ddi', 'wan', 'lan', 'dns', 'dhcp', 'aws', 'vpn', 'ipam', 'sdwan', 'ldap', 'ntp', 'ise', 'sql', 'api', 'nas', 'san']);

/** office-connectivity -> Office Connectivity, ddi -> DDI, ASX1_F5 -> ASX1 F5. */
function deriveLabel(name) {
  const toks = String(name == null ? '' : name).replace(/[-_]+/g, ' ').split(/\s+/).filter(Boolean);
  return toks.map((t) => {
    if (/^[A-Z0-9]{2,5}$/.test(t) && /[A-Z]/.test(t)) return t;
    if (KEEP_UPPER.has(t.toLowerCase())) return t.toUpperCase();
    return t.charAt(0).toUpperCase() + t.slice(1).toLowerCase();
  }).join(' ');
}

function readPicks() {
  let raw;
  try { raw = getSetting(SERVICE_KEY); } catch { raw = null; }
  const arr = parseArr(raw);
  const out = [];
  for (const p of arr) {
    if (!p || !Number.isInteger(p.sourceId) || !Number.isInteger(p.groupId)) continue;
    out.push({ sourceId: p.sourceId, groupId: p.groupId, label: typeof p.label === 'string' && p.label.trim() ? p.label.trim().slice(0, 60) : null });
    if (out.length >= MAX_PICKS) break;
  }
  return out;
}

/** Picked groups in pick order: [{ serviceId: "3-118", label, ...node, missing }]. */
function services(db) {
  const picks = readPicks();
  if (!picks.length) return [];
  const tree = buildGroupTree(db);
  return picks.map((p) => {
    const serviceId = `${p.sourceId}-${p.groupId}`;
    const node = tree.node(`${p.sourceId}:${p.groupId}`);
    if (!node) {
      return {
        serviceId, label: p.label || `Group ${p.groupId}`, missing: true, state: 'unknown',
        counts: { crit: 0, warn: 0, ok: 0, total: 0 }, sourceId: p.sourceId, groupId: p.groupId,
      };
    }
    return { serviceId, label: p.label || deriveLabel(node.name), ...node, missing: false };
  });
}

module.exports = { deviceStates, buildGroupTree, services, deriveLabel, readPicks, SERVICE_KEY, MAX_PICKS, chunks };
