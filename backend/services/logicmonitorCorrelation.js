// LogicMonitor Correlation page data (round 4, 2026-10-14): backup load on
// switch ports, replication against WAN circuits, config changes followed by
// incidents, and blame history. Every cross-platform read is guarded with
// tableExists and every public function returns empty arrays rather than
// throwing, so the page works on an install that has none of the other
// platforms. backupLoad itself lives in logicmonitorEndpoints (it shares the
// host index and port matcher) and is re-exported here.
const lmEndpoints = require('./logicmonitorEndpoints');

const issuesMod = () => require('./logicmonitorIssues');
const pathMod = () => require('./logicmonitorPath');

const norm = (s) => String(s == null ? '' : s).trim().toLowerCase();
const shortName = (s) => { const n = norm(s); return /^\d{1,3}(\.\d{1,3}){3}$/.test(n) ? n : n.split('.')[0]; };
const round1 = (v) => (v == null || !Number.isFinite(v) ? null : Math.round(v * 10) / 10);
const sqlTs = (ms) => new Date(ms).toISOString().replace('T', ' ').slice(0, 19);
const parseJson = (s, fallback) => { try { const v = JSON.parse(s); return v == null ? fallback : v; } catch { return fallback; } };

function tableExists(dbh, name) {
  try { return !!dbh.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?").get(name); } catch { return false; }
}
/** ms from an ISO string, a zoneless SQLite stamp (UTC) or null. */
function toMs(v) {
  if (v == null || v === '') return null;
  if (typeof v === 'number') return v > 1e12 ? v : v * 1000;
  const s = String(v).trim();
  if (/^\d+$/.test(s)) { const n = Number(s); return n > 1e12 ? n : n * 1000; }
  const d = new Date(/[zZ]$|[+-]\d\d:?\d\d$/.test(s) ? s : `${s.replace(' ', 'T')}Z`);
  return Number.isNaN(d.getTime()) ? null : d.getTime();
}
const iso = (ms) => (ms == null ? null : new Date(ms).toISOString());
const RUN_EPOCH = (col) => `CAST(CASE WHEN ${col} LIKE '20%' THEN strftime('%s', ${col}) ELSE ${col} END AS INTEGER)`;

// -- Sites by name (Zerto site names, Cohesity cluster names) -----------------------------

function loadSites(dbh) {
  if (!tableExists(dbh, 'lm_sites')) return [];
  try {
    const seen = new Map();
    for (const r of dbh.prepare('SELECT DISTINCT site_key, site_name FROM lm_sites WHERE site_key IS NOT NULL').all()) {
      if (!seen.has(r.site_key)) seen.set(r.site_key, { key: r.site_key, name: norm(r.site_name || r.site_key) });
    }
    return [...seen.values()];
  } catch { return []; }
}
/** The site whose name or key appears in `text` (longest name wins); null when none. */
function siteFromText(sites, text) {
  const n = norm(text);
  if (!n) return null;
  const tokens = new Set(n.split(/[^a-z0-9]+/).filter(Boolean));
  let best = null;
  for (const s of sites) {
    const byName = s.name.length >= 3 && n.includes(s.name);
    const byKey = s.key.length >= 3 && (tokens.has(s.key) || n.includes(s.key));
    if (byName || byKey) {
      const weight = Math.max(byName ? s.name.length : 0, byKey ? s.key.length : 0);
      if (!best || weight > best.weight) best = { key: s.key, weight };
    }
  }
  return best ? best.key : null;
}

// -- B2: replication against circuits ---------------------------------------------------------

const RPO_ALERT_RE = /rpo|journal|replicat/i;
const p95Of = (vals) => {
  const a = vals.filter((v) => v != null && Number.isFinite(v)).sort((x, y) => x - y);
  if (!a.length) return null;
  return a[Math.max(0, Math.ceil(a.length * 0.95) - 1)];
};
const fmtSecs = (s) => {
  const n = Math.round(Number(s) || 0);
  if (n >= 3600) return `${round1(n / 3600)} h`;
  if (n >= 60) return `${Math.round(n / 60)} min`;
  return `${n} s`;
};

/**
 * Replication trouble set against the WAN circuits (lm_interfaces.is_wan).
 * Events (all tableExists guarded): zerto_vpgs whose actual_rpo exceeds the
 * configured RPO now (window now - actual_rpo to now, kind 'zerto-rpo'),
 * zerto_alerts that mention RPO, journal or replication inside the last
 * `days` (window collection_time +/- 30 min, 'zerto-alert'), and Cohesity
 * replication_runs that did not succeed or lagged more than an hour
 * ('cohesity-replication', window start..end, open runs end now).
 * A site resolves from Zerto's protected/recovery site names or from the
 * replication target (then source) cluster name through lm_sites; a resolved
 * site's circuits are always listed, otherwise only circuits that were over
 * the line during the window are. Util is the mean of max(in, out) samples
 * inside the window; finding is 'coincident' when the p95 of those samples
 * reaches lm_circuit_sat_pct and 'possible' from 60. overlapMinutes is the
 * event window length clamped to the analysis window and now.
 * Row: {kind, subject, detail, at, until, siteKey, circuit: {deviceName, port,
 * label, siteKey}, circuitUtilPct, circuitP95Pct, overlapMinutes, finding?}.
 */
function replicationVsCircuits(dbh, { days = 7, nowMs = Date.now() } = {}) {
  const out = [];
  try {
    if (!tableExists(dbh, 'lm_interfaces') || !tableExists(dbh, 'lm_interface_history')) return out;
    const circuits = pathMod().circuitRows(dbh, { nowMs });
    if (!circuits.length) return out;
    const sat = issuesMod().getThreshold('lm_circuit_sat_pct');
    const sinceMs = nowMs - Math.max(1, Number(days) || 7) * 86400000;
    const sites = loadSites(dbh);
    const events = [];

    if (tableExists(dbh, 'zerto_vpgs')) {
      try {
        for (const v of dbh.prepare('SELECT * FROM zerto_vpgs WHERE actual_rpo IS NOT NULL AND configured_rpo IS NOT NULL AND actual_rpo > configured_rpo').all()) {
          const start = Math.max(sinceMs, nowMs - Number(v.actual_rpo) * 1000);
          const keys = [siteFromText(sites, v.protected_site), siteFromText(sites, v.recovery_site)].filter(Boolean);
          events.push({
            kind: 'zerto-rpo', subject: v.name || v.vpg_identifier,
            detail: `Actual RPO ${fmtSecs(v.actual_rpo)} against ${fmtSecs(v.configured_rpo)} configured${v.status ? `, status ${v.status}` : ''}${v.protected_site || v.recovery_site ? `, ${v.protected_site || '?'} to ${v.recovery_site || '?'}` : ''}`,
            startMs: start, endMs: nowMs, at: start, until: null, siteKeys: [...new Set(keys)],
          });
        }
      } catch { /* zerto_vpgs differs */ }
    }
    if (tableExists(dbh, 'zerto_alerts')) {
      try {
        for (const a of dbh.prepare('SELECT * FROM zerto_alerts WHERE collection_time IS NOT NULL AND description IS NOT NULL').all()) {
          const ct = toMs(a.collection_time);
          if (ct == null || ct < sinceMs || ct > nowMs + 3600000 || !RPO_ALERT_RE.test(String(a.description))) continue;
          const key = siteFromText(sites, a.site_name);
          events.push({
            kind: 'zerto-alert', subject: a.alert_type || a.alert_identifier, detail: String(a.description),
            startMs: ct - 30 * 60000, endMs: Math.min(nowMs, ct + 30 * 60000), at: ct, until: null, siteKeys: key ? [key] : [],
          });
        }
      } catch { /* zerto_alerts differs */ }
    }
    if (tableExists(dbh, 'replication_runs')) {
      try {
        const cutoff = Math.floor(sinceMs / 1000);
        const rows = dbh.prepare(`
          SELECT rr.id, rr.status, rr.lag_seconds, rr.target_cluster_name, ${RUN_EPOCH('rr.start_time')} AS s, ${RUN_EPOCH('rr.end_time')} AS e,
            c.name AS source_name, pr.job_name
          FROM replication_runs rr
          LEFT JOIN clusters c ON c.id = rr.cluster_id
          LEFT JOIN protection_runs pr ON pr.id = rr.protection_run_id
          WHERE rr.start_time IS NOT NULL AND ${RUN_EPOCH('rr.start_time')} >= ?
            AND ((rr.status IS NOT NULL AND lower(rr.status) NOT LIKE '%succe%') OR COALESCE(rr.lag_seconds, 0) > 3600)
          ORDER BY s DESC LIMIT 500
        `).all(cutoff);
        for (const r of rows) {
          if (!r.s) continue;
          const startMs = r.s * 1000;
          const endMs = r.e && r.e >= r.s ? Math.min(nowMs, r.e * 1000) : nowMs;
          const key = siteFromText(sites, r.target_cluster_name) || siteFromText(sites, r.source_name);
          events.push({
            kind: 'cohesity-replication', subject: r.job_name || r.target_cluster_name || `run ${r.id}`,
            detail: `${r.status || 'status unknown'}${r.lag_seconds != null ? `, lag ${fmtSecs(r.lag_seconds)}` : ''}${r.target_cluster_name ? `, to ${r.target_cluster_name}` : ''}`,
            startMs, endMs, at: startMs, until: r.e && r.e >= r.s ? r.e * 1000 : null, siteKeys: key ? [key] : [],
          });
        }
      } catch { /* replication_runs differs */ }
    }
    if (!events.length) return out;

    const histStmt = dbh.prepare('SELECT in_util_pct, out_util_pct FROM lm_interface_history WHERE source_id = ? AND instance_id = ? AND captured_at >= ? AND captured_at <= ?');
    const cache = new Map();
    const statsFor = (c, a, b) => {
      const ck = `${c.sourceId}:${c.instanceId}:${a}:${b}`;
      if (cache.has(ck)) return cache.get(ck);
      const vals = histStmt.all(c.sourceId, c.instanceId, sqlTs(a), sqlTs(b))
        .map((h) => Math.max(h.in_util_pct == null ? -1 : h.in_util_pct, h.out_util_pct == null ? -1 : h.out_util_pct)).filter((v) => v >= 0);
      const st = vals.length ? { mean: vals.reduce((x, y) => x + y, 0) / vals.length, p95: p95Of(vals) } : null;
      cache.set(ck, st);
      return st;
    };
    for (const ev of events) {
      if (ev.endMs <= ev.startMs) continue;
      const siteCircuits = ev.siteKeys.length ? circuits.filter((c) => ev.siteKeys.includes(c.siteKey)) : [];
      const pool = siteCircuits.length ? siteCircuits : circuits;
      for (const c of pool) {
        const st = statsFor(c, ev.startMs, ev.endMs);
        if (!st) continue;
        const finding = st.p95 >= sat ? 'coincident' : st.p95 >= 60 ? 'possible' : null;
        if (!finding && !siteCircuits.length) continue;
        const row = {
          kind: ev.kind, subject: ev.subject, detail: ev.detail, at: iso(ev.at), until: iso(ev.until),
          siteKey: ev.siteKeys[0] || null,
          circuit: { deviceName: c.deviceName, port: c.port, label: c.label, siteKey: c.siteKey || null },
          circuitUtilPct: round1(st.mean), circuitP95Pct: round1(st.p95),
          overlapMinutes: Math.max(0, Math.round((ev.endMs - ev.startMs) / 60000)),
        };
        if (finding) row.finding = finding;
        out.push(row);
      }
    }
    const rank = (r) => (r.finding === 'coincident' ? 0 : r.finding === 'possible' ? 1 : 2);
    out.sort((a, b) => rank(a) - rank(b) || b.circuitUtilPct - a.circuitUtilPct || String(b.at).localeCompare(String(a.at)));
    return out.slice(0, 500);
  } catch {
    return out.slice(0, 500);
  }
}

// -- B3: changes followed by incidents ---------------------------------------------------------

const INCIDENT_TYPES = ['device-dead', 'interface-flapping', 'interface-errors-growing', 'interface-util-anomaly',
  'interface-error-anomaly', 'latency-anomaly', 'packet-loss-anomaly', 'latency-degrading', 'loss-degrading', 'check-down', 'circuit-saturated'];
const DAY_MS = 86400000;
const ALERTS_PER_CHANGE = 5;

/**
 * config_changes rows of platform 'logicmonitor' in the last `days` followed
 * within 24 hours (never before the change) by an ICC issue of a network
 * incident type whose target names the changed device, or whose check's blame
 * hop (lm_blame_history) is that device, or by an LM alert opened on that
 * device (the five earliest per change). One row per (change, incident),
 * newest change first, capped at 500.
 */
function changesThenIncidents(dbh, { days = 14, nowMs = Date.now() } = {}) {
  const out = [];
  try {
    if (!tableExists(dbh, 'config_changes')) return out;
    const cutoff = nowMs - Math.max(1, Number(days) || 14) * DAY_MS;
    const changes = dbh.prepare("SELECT * FROM config_changes WHERE platform = 'logicmonitor' ORDER BY detected_at DESC, id DESC LIMIT 2000").all()
      .map((c) => ({ c, ms: toMs(c.detected_at) })).filter((x) => x.ms != null && x.ms >= cutoff);
    if (!changes.length) return out;

    const issuesByType = tableExists(dbh, 'lm_issue_history')
      ? dbh.prepare(`SELECT issue_key, type, target, message, first_seen FROM lm_issue_history WHERE type IN (${INCIDENT_TYPES.map(() => '?').join(',')}) ORDER BY first_seen`).all(...INCIDENT_TYPES)
        .map((r) => ({ ...r, ms: toMs(r.first_seen) })).filter((r) => r.ms != null && r.ms >= cutoff)
      : [];
    const blameDevices = new Map();
    if (issuesByType.length && tableExists(dbh, 'lm_blame_history')) {
      try {
        for (const b of dbh.prepare('SELECT issue_key, hop_device_name FROM lm_blame_history WHERE issue_key IS NOT NULL').all()) {
          if (!blameDevices.has(b.issue_key)) blameDevices.set(b.issue_key, new Set());
          blameDevices.get(b.issue_key).add(norm(b.hop_device_name));
        }
      } catch { /* no blame table */ }
    }
    const devByName = new Map();
    if (tableExists(dbh, 'lm_devices')) {
      for (const d of dbh.prepare('SELECT source_id, lm_device_id, display_name, name, site_key FROM lm_devices').all()) {
        for (const n of [d.display_name, d.name]) {
          if (!n) continue;
          const k = norm(n);
          if (!devByName.has(k)) devByName.set(k, []);
          devByName.get(k).push(d);
        }
      }
    }
    const alertStmt = tableExists(dbh, 'lm_alerts')
      ? dbh.prepare(`SELECT monitor_object_name, resource_template_name, instance_name, data_point_name, alert_value, severity_norm, start_epoch
          FROM lm_alerts WHERE source_id = ? AND lm_device_id = ? AND start_epoch >= ? AND start_epoch <= ? ORDER BY start_epoch LIMIT ${ALERTS_PER_CHANGE}`)
      : null;

    for (const { c, ms } of changes) {
      // The ledger writes system = portal (source) name and item = device, or
      // "device port" for the links scope (recordLedger in logicmonitorPoller).
      // Older or hand-written rows may carry the device in system; try the item
      // first, then its first token, then system.
      const itemNorm = norm(c.item);
      const candidates = [itemNorm, itemNorm.split(' ')[0], norm(c.system)].filter(Boolean);
      let sys = norm(c.system);
      let devs = [];
      for (const cand of candidates) {
        const hit = devByName.get(cand) || devByName.get(shortName(cand));
        if (hit && hit.length) { sys = cand; devs = hit; break; }
      }
      const siteKey = (devs.find((d) => d.site_key) || {}).site_key || null;
      const device = devs.length ? (devs[0].display_name || devs[0].name) : (itemNorm ? c.item.split(' ')[0] : c.system);
      const base = {
        changeId: c.id, system: c.system, device, scope: c.scope, item: c.item, changeType: c.change_type,
        oldValue: c.old_value, newValue: c.new_value, changedAt: iso(ms), siteKey,
      };
      const rows = [];
      for (const i of issuesByType) {
        if (i.ms < ms || i.ms > ms + DAY_MS) continue;
        const t = norm(i.target);
        const named = t === sys || t.startsWith(`${sys} `) || (shortName(t) === shortName(sys) && shortName(sys).length >= 3);
        const blamed = !named && blameDevices.has(i.issue_key) && blameDevices.get(i.issue_key).has(sys);
        if (!named && !blamed) continue;
        rows.push({ ...base, incident: { type: i.type, target: i.target, message: i.message, firstSeen: iso(i.ms), minutesAfter: Math.round((i.ms - ms) / 60000) } });
      }
      if (alertStmt) {
        for (const d of devs) {
          for (const a of alertStmt.all(d.source_id, d.lm_device_id, Math.floor(ms / 1000), Math.floor((ms + DAY_MS) / 1000))) {
            const at = Number(a.start_epoch) * 1000;
            rows.push({
              ...base,
              incident: {
                type: 'lm-alert', target: [a.monitor_object_name, a.instance_name].filter(Boolean).join(' '),
                message: [a.resource_template_name, a.data_point_name, a.alert_value != null ? `= ${a.alert_value}` : null].filter(Boolean).join(' '),
                firstSeen: iso(at), minutesAfter: Math.round((at - ms) / 60000),
              },
            });
          }
        }
      }
      out.push(...rows);
      if (out.length >= 5000) break;
    }
    out.sort((a, b) => String(b.changedAt).localeCompare(String(a.changedAt)) || a.incident.minutesAfter - b.incident.minutesAfter);
    return out.slice(0, 500);
  } catch {
    return out.slice(0, 500);
  }
}

// -- B4: blame history -----------------------------------------------------------------------------

/**
 * Insert one lm_blame_history row for a blame object ({deviceId, deviceName,
 * port, state, reason, siteKey, sourceId} as logicmonitorPath.blame returns).
 * Nothing is written for a null blame or one whose state is 'ok'. When
 * `dedupeSince` (a zoneless UTC SQLite stamp) is given, a row for the same
 * source, kind, subject_key, issue_key, hop device and hop port at or after
 * that stamp suppresses the insert. `at` overrides the default now (tests,
 * demo). Returns true when a row was written. Never throws.
 */
function recordBlame(dbh, { sourceId, kind = 'check', subject = null, subjectKey = null, checkpointLabel = null, blame = null, siteKey = null, issueKey = null, dedupeSince = null, at = null } = {}) {
  try {
    if (!blame || blame.state === 'ok' || sourceId == null || !tableExists(dbh, 'lm_blame_history')) return false;
    const hopId = blame.deviceId == null ? null : blame.deviceId;
    const hopPort = blame.port || null;
    if (dedupeSince) {
      const dup = dbh.prepare(`SELECT id FROM lm_blame_history
        WHERE source_id = ? AND kind = ? AND subject_key IS ? AND issue_key IS ? AND hop_device_id IS ? AND hop_port IS ? AND at >= ? LIMIT 1`)
        .get(sourceId, kind, subjectKey, issueKey, hopId, hopPort, dedupeSince);
      if (dup) return false;
    }
    dbh.prepare(`INSERT INTO lm_blame_history
      (source_id, at, kind, subject, subject_key, checkpoint_label, hop_device_id, hop_device_name, hop_port, hop_state, hop_reason, site_key, issue_key)
      VALUES (?, COALESCE(?, datetime('now')), ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(sourceId, at, kind, subject, subjectKey, checkpointLabel, hopId, blame.deviceName || null, hopPort, blame.state || null, blame.reason || null,
        siteKey || blame.siteKey || null, issueKey);
    return true;
  } catch {
    return false;
  }
}

function appsByHop(dbh, hopKeys, nowMs) {
  const out = new Map();
  try {
    if (!hopKeys.length || !tableExists(dbh, 'app_service_watch') || !tableExists(dbh, 'vcenter_vms')) return out;
    const watched = dbh.prepare('SELECT usage_id FROM app_service_watch').all().map((r) => r.usage_id);
    if (!watched.length) return out;
    const lp = pathMod();
    const ctx = lp.makeContext(dbh);
    const vmCols = new Set(dbh.prepare("PRAGMA table_info('vcenter_vms')").all().map((c) => c.name));
    const vmSql = `SELECT name${vmCols.has('guest_hostname') ? ', guest_hostname' : ''}${vmCols.has('ip_address') ? ', ip_address' : ''}
      FROM vcenter_vms WHERE EXISTS (SELECT 1 FROM json_each(COALESCE(tags, '[]')) jt WHERE lower(jt.value) = ?) LIMIT 40`;
    const vmStmt = dbh.prepare(vmSql);
    const cleanPort = (p) => norm(lmEndpoints.cleanPort(p)).replace(/\s+/g, '');
    const wanted = new Map(hopKeys.map((h) => [`${h.sourceId}:${h.deviceId}`, h]));
    for (const usage of watched) {
      const hit = new Set();
      for (const vm of vmStmt.all(`usage-id: ${norm(usage)}`)) {
        const names = [vm.name, vm.guest_hostname].filter(Boolean);
        const ips = vm.ip_address ? [vm.ip_address] : [];
        for (const hop of lp.pathFor(dbh, { names, ips }, { ctx })) {
          const w = wanted.get(`${hop.sourceId}:${hop.deviceId}`);
          if (!w) continue;
          const ports = [hop.inPort, hop.outPort].filter(Boolean).map((p) => cleanPort(p.display));
          if (!w.port || !ports.length || ports.includes(cleanPort(w.port))) hit.add(w.key);
        }
      }
      for (const key of hit) {
        if (!out.has(key)) out.set(key, []);
        out.get(key).push(usage);
      }
    }
  } catch { /* no app services or no path model */ }
  return out;
}

/**
 * Hops blamed in the last `days`: {hops: [{deviceId, deviceName, port, siteKey,
 * count, lastAt, firstAt, subjects: [{kind, subject, count}] (top 8),
 * appsAffected: [usage ids]}] by count desc, recent: the newest 50 rows as
 * {at, kind, subject, hopDeviceName, hopPort, hopReason, hopState}}.
 * appsAffected walks the path of every server of each watched app service
 * for the 25 busiest hops.
 */
function blameHistory(dbh, { days = 30, nowMs = Date.now() } = {}) {
  const res = { hops: [], recent: [] };
  try {
    if (!tableExists(dbh, 'lm_blame_history')) return res;
    const since = sqlTs(nowMs - Math.max(1, Number(days) || 30) * DAY_MS);
    const rows = dbh.prepare('SELECT * FROM lm_blame_history WHERE at >= ? ORDER BY at DESC, id DESC').all(since);
    const siteOf = new Map();
    if (tableExists(dbh, 'lm_devices')) {
      for (const d of dbh.prepare('SELECT source_id, lm_device_id, site_key FROM lm_devices').all()) siteOf.set(`${d.source_id}:${d.lm_device_id}`, d.site_key);
    }
    const groups = new Map();
    for (const r of rows) {
      const hopRef = r.hop_device_id != null ? `d${r.hop_device_id}` : `n${norm(r.hop_device_name)}`;
      const key = `${r.source_id}|${hopRef}|${norm(r.hop_port)}`;
      let g = groups.get(key);
      if (!g) {
        g = { key, sourceId: r.source_id, deviceId: r.hop_device_id, deviceName: r.hop_device_name, port: r.hop_port || null,
          siteKey: r.site_key || siteOf.get(`${r.source_id}:${r.hop_device_id}`) || null, count: 0, lastAt: r.at, firstAt: r.at, subj: new Map() };
        groups.set(key, g);
      }
      g.count += 1;
      if (r.at < g.firstAt) g.firstAt = r.at;
      if (r.at > g.lastAt) g.lastAt = r.at;
      if (!g.siteKey && r.site_key) g.siteKey = r.site_key;
      const sk = `${r.kind}|${r.subject}`;
      const e = g.subj.get(sk) || { kind: r.kind, subject: r.subject, count: 0 };
      e.count += 1; g.subj.set(sk, e);
    }
    const sorted = [...groups.values()].sort((a, b) => b.count - a.count || String(b.lastAt).localeCompare(String(a.lastAt)));
    const apps = appsByHop(dbh, sorted.slice(0, 25).filter((g) => g.deviceId != null).map((g) => ({ key: g.key, sourceId: g.sourceId, deviceId: g.deviceId, port: g.port })), nowMs);
    res.hops = sorted.map((g) => ({
      deviceId: g.deviceId, deviceName: g.deviceName, port: g.port, siteKey: g.siteKey, count: g.count,
      lastAt: iso(toMs(g.lastAt)), firstAt: iso(toMs(g.firstAt)),
      subjects: [...g.subj.values()].sort((a, b) => b.count - a.count || String(a.subject).localeCompare(String(b.subject))).slice(0, 8),
      appsAffected: apps.get(g.key) || [],
    }));
    res.recent = rows.slice(0, 50).map((r) => ({
      at: iso(toMs(r.at)), kind: r.kind, subject: r.subject, hopDeviceName: r.hop_device_name, hopPort: r.hop_port || null,
      hopReason: r.hop_reason || null, hopState: r.hop_state || null,
    }));
  } catch { /* leave what was built */ }
  return res;
}

// -- SnapMirror lag versus node ports (round 9, WP6) ---------------------------------------------

const SNAPMIRROR_LAG_S = 3600;
const SNAPMIRROR_FALLBACK_WINDOW_S = 6 * 3600;

/**
 * SnapMirror relationships that lag (lag_seconds above an hour, a state other
 * than snapmirrored, or healthy = 0) in the last `days`, against the switch
 * ports of the source and destination cluster nodes. The ports come from the
 * ICC endpoint rows (netapp refs, nic = node port); when the cluster has
 * intercluster LIFs the node's ports are narrowed to the LIF ports. The lag
 * window runs from captured_at minus the lag (else the last transfer end, else
 * six hours) to captured_at, bounded to the page window. Per port: mean utilization and
 * mean errors in the window against lm_interface_baseline for the window's
 * UTC hours. finding: 'saturates' (mean >= lm_backup_overlay_util_pct),
 * 'elevated' (utilization or errors above baseline + k x MAD), 'normal', or
 * 'unmapped' (no resolvable port with history for that side). Same vocabulary
 * as backupLoad. Netapp node and LIF column use is from the netapp migration
 * (name, serial_number; node_name, port_name, services); whether ONTAP fills
 * services with the string "intercluster" on a live cluster is UNVERIFIED.
 * Never throws.
 */
function snapmirrorVsPorts(dbh, { days = 7, nowMs = Date.now(), endpoints = null } = {}) {
  const out = [];
  try {
    if (!tableExists(dbh, 'netapp_snapmirror') || !tableExists(dbh, 'netapp_nodes') || !tableExists(dbh, 'netapp_arrays') || !tableExists(dbh, 'lm_interface_history')) return out;
    const issuesMod = require('./logicmonitorIssues');
    const sat = issuesMod.getThreshold('lm_backup_overlay_util_pct');
    const k = issuesMod.getThreshold('lm_if_anomaly_k');
    const epRows = endpoints || lmEndpoints.endpointsAll(dbh);
    if (!epRows.length) return out;
    // captured_at is written as ISO by some pollers and as a SQLite stamp by others, so the
    // age cutoff is applied in JS (toMs) rather than compared in SQL.
    const cutoffMs = nowMs - Math.max(1, Number(days) || 7) * DAY_MS;
    const rels = dbh.prepare(`
      SELECT m.*, a.name AS array_name FROM netapp_snapmirror m LEFT JOIN netapp_arrays a ON a.id = m.array_id
      WHERE (COALESCE(m.lag_seconds, 0) > ? OR COALESCE(m.healthy, 1) = 0
          OR (m.state IS NOT NULL AND lower(m.state) NOT IN ('snapmirrored', 'in-sync', 'insync')))
      ORDER BY m.id DESC LIMIT 2000
    `).all(SNAPMIRROR_LAG_S).filter((m) => (toMs(m.captured_at) || 0) >= cutoffMs).slice(0, 400);
    if (!rels.length) return out;

    const arrays = dbh.prepare('SELECT id, name FROM netapp_arrays').all();
    const arrayByName = new Map(arrays.map((a) => [norm(a.name), a]));
    const nodeStmt = dbh.prepare('SELECT name FROM netapp_nodes WHERE array_id = ? AND name IS NOT NULL ORDER BY name');
    const lifStmt = tableExists(dbh, 'netapp_lifs')
      ? dbh.prepare("SELECT port_name FROM netapp_lifs WHERE array_id = ? AND lower(node_name) = ? AND port_name IS NOT NULL AND lower(COALESCE(services, '')) LIKE '%intercluster%'")
      : null;
    const histStmt = dbh.prepare('SELECT in_util_pct, out_util_pct, in_errors, out_errors FROM lm_interface_history WHERE source_id = ? AND instance_id = ? AND captured_at >= ? AND captured_at <= ?');
    const baseStmt = dbh.prepare('SELECT hour_of_day, util_median, util_mad, err_median, err_mad FROM lm_interface_baseline WHERE source_id = ? AND instance_id = ?');
    const baseCache = new Map();
    const portCache = new Map();

    const portsOfCluster = (arrayId) => {
      if (portCache.has(arrayId)) return portCache.get(arrayId);
      const res = [];
      const seen = new Set();
      for (const n of nodeStmt.all(arrayId)) {
        const lifPorts = lifStmt ? new Set(lifStmt.all(arrayId, norm(n.name)).map((l) => norm(l.port_name))) : new Set();
        let sp = [];
        try { sp = lmEndpoints.serverPath(dbh, { names: [n.name] }, { endpoints: epRows }).switchPorts.filter((p) => p.instanceId != null); } catch { sp = []; }
        const narrowed = lifPorts.size ? sp.filter((p) => lifPorts.has(norm(p.nic))) : [];
        const picked = narrowed.length ? narrowed : sp;
        for (const p of picked) {
          const key = `${p.sourceId}:${p.instanceId}`;
          if (seen.has(key)) continue;
          seen.add(key);
          res.push({ ...p, node: n.name, rule: narrowed.length ? 'intercluster-lif' : 'node-ports' });
        }
      }
      portCache.set(arrayId, res);
      return res;
    };

    const seenRel = new Set();
    for (const r of rels) {
      const relKey = `${norm(r.source_path)}|${norm(r.destination_path)}|${norm(r.destination_cluster)}`;
      if (seenRel.has(relKey)) continue;
      seenRel.add(relKey);
      const capMs = toMs(r.captured_at) || nowMs;
      const lastEnd = toMs(r.last_transfer_end);
      // The lag started lag_seconds before the poll; without a lag figure the last
      // transfer end opens the window, else the last six hours.
      let startMs = Number(r.lag_seconds) > 0 ? capMs - Number(r.lag_seconds) * 1000
        : (lastEnd && lastEnd < capMs ? lastEnd : capMs - SNAPMIRROR_FALLBACK_WINDOW_S * 1000);
      startMs = Math.max(startMs, nowMs - Math.max(1, Number(days) || 7) * DAY_MS);
      const endMs = Math.max(capMs, startMs + 30 * 60000);
      const hours = new Set();
      for (let t = startMs; t <= endMs; t += 1800000) hours.add(new Date(t).getUTCHours());
      const base = {
        relationship: `${r.source_path || '?'} to ${r.destination_path || '?'}`,
        sourcePath: r.source_path || null, destinationPath: r.destination_path || null,
        sourceCluster: r.source_cluster || null, destinationCluster: r.destination_cluster || null,
        state: r.state || null, healthy: r.healthy == null ? null : Number(r.healthy) === 1,
        lagSeconds: r.lag_seconds == null ? null : Number(r.lag_seconds),
        lastTransferEnd: iso(lastEnd), lastTransferBytes: r.last_transfer_bytes == null ? null : Number(r.last_transfer_bytes),
        windowStart: iso(startMs), windowEnd: iso(endMs),
      };
      for (const side of ['source', 'destination']) {
        const clusterName = side === 'source' ? r.source_cluster : r.destination_cluster;
        let arr = clusterName ? arrayByName.get(norm(clusterName)) : null;
        // The polling array is the destination in a pull-model relationship list.
        if (!arr && side === 'destination' && r.array_id != null) arr = { id: r.array_id, name: r.array_name };
        const ports = arr ? portsOfCluster(arr.id) : [];
        let any = false;
        for (const p of ports) {
          const rows = histStmt.all(p.sourceId, p.instanceId, sqlTs(startMs), sqlTs(endMs));
          const utils = rows.map((x) => Math.max(x.in_util_pct == null ? -1 : x.in_util_pct, x.out_util_pct == null ? -1 : x.out_util_pct)).filter((v) => v >= 0);
          if (!utils.length) continue;
          any = true;
          const errs = rows.map((x) => (x.in_errors == null && x.out_errors == null ? null : (Number(x.in_errors) || 0) + (Number(x.out_errors) || 0))).filter((v) => v != null);
          const mean = utils.reduce((a, b) => a + b, 0) / utils.length;
          const errMean = errs.length ? errs.reduce((a, b) => a + b, 0) / errs.length : null;
          const bk = `${p.sourceId}:${p.instanceId}`;
          if (!baseCache.has(bk)) baseCache.set(bk, baseStmt.all(p.sourceId, p.instanceId));
          const bl = baseCache.get(bk).filter((b) => hours.has(b.hour_of_day) && b.util_median != null);
          const avg = (key) => { const v = bl.map((b) => b[key]).filter((x) => x != null); return v.length ? v.reduce((a, b) => a + b, 0) / v.length : null; };
          const bMed = avg('util_median');
          const bMad = avg('util_mad') || 0;
          const eMed = avg('err_median');
          const eMad = avg('err_mad') || 0;
          let finding = 'normal';
          if (mean >= sat) finding = 'saturates';
          else if (bMed != null && mean > bMed + k * Math.max(bMad, 2)) finding = 'elevated';
          else if (errMean != null && errMean >= 1 && errMean > (eMed == null ? 0 : eMed) + k * Math.max(eMad, 1)) finding = 'elevated';
          out.push({
            ...base, side, cluster: clusterName || (arr && arr.name) || null, node: p.node, nodePort: p.nic || null,
            sourceId: p.sourceId, deviceId: p.deviceId, deviceName: p.deviceName, instanceId: p.instanceId, port: p.port,
            meanUtilPct: round1(mean), maxUtilPct: round1(Math.max(...utils)), baselineUtilPct: round1(bMed),
            meanErrors: round1(errMean), baselineErrors: round1(eMed), portRule: p.rule, finding,
          });
        }
        if (!any) {
          out.push({ ...base, side, cluster: clusterName || (arr && arr.name) || null, node: null, nodePort: null, sourceId: null, deviceId: null,
            deviceName: null, instanceId: null, port: null, meanUtilPct: null, maxUtilPct: null, baselineUtilPct: null,
            meanErrors: null, baselineErrors: null, portRule: null, finding: 'unmapped' });
        }
      }
    }
    const rank = (x) => (x.finding === 'saturates' ? 0 : x.finding === 'elevated' ? 1 : x.finding === 'normal' ? 2 : 3);
    out.sort((a, b) => rank(a) - rank(b) || (b.lagSeconds || 0) - (a.lagSeconds || 0) || String(a.relationship).localeCompare(String(b.relationship)));
    return out.slice(0, 500);
  } catch {
    return out.slice(0, 500);
  }
}

// -- Whole page ------------------------------------------------------------------------------------------

/** GET /correlation payload. The ICC endpoint rows are built once and shared. */
function correlation(dbh, { nowMs = Date.now() } = {}) {
  let endpoints = null;
  try { endpoints = lmEndpoints.endpointsAll(dbh); } catch { endpoints = []; }
  return {
    backupLoad: lmEndpoints.backupLoad(dbh, { days: 7, nowMs, endpoints }),
    replicationVsCircuits: replicationVsCircuits(dbh, { days: 7, nowMs }),
    changesThenIncidents: changesThenIncidents(dbh, { days: 14, nowMs }),
    blameHistory: blameHistory(dbh, { days: 30, nowMs }),
    snapmirror: snapmirrorVsPorts(dbh, { days: 7, nowMs, endpoints }),
    generatedAt: new Date(nowMs).toISOString(),
  };
}

/** {backupLoad, replication, changes, blames} counts for one site (Site 360). */
function siteCounts(dbh, siteKey, sourceId = null, data = null) {
  const counts = { backupLoad: 0, replication: 0, changes: 0, blames: 0 };
  try {
    const d = data || correlation(dbh);
    const siteOf = new Map();
    if (tableExists(dbh, 'lm_devices')) {
      for (const r of dbh.prepare('SELECT source_id, lm_device_id, site_key FROM lm_devices').all()) siteOf.set(`${r.source_id}:${r.lm_device_id}`, r.site_key);
    }
    counts.backupLoad = d.backupLoad.filter((r) => siteOf.get(`${r.sourceId}:${r.deviceId}`) === siteKey).length;
    counts.replication = d.replicationVsCircuits.filter((r) => r.siteKey === siteKey || (r.circuit && r.circuit.siteKey === siteKey)).length;
    counts.changes = d.changesThenIncidents.filter((r) => r.siteKey === siteKey).length;
    counts.blames = d.blameHistory.hops.filter((h) => h.siteKey === siteKey).reduce((a, h) => a + h.count, 0);
  } catch { /* zeros */ }
  return counts;
}

module.exports = {
  backupLoad: lmEndpoints.backupLoad,
  backupLoadByPort: lmEndpoints.backupLoadByPort,
  replicationVsCircuits, changesThenIncidents, blameHistory, snapmirrorVsPorts, recordBlame,
  correlation, siteCounts,
  INCIDENT_TYPES,
};
