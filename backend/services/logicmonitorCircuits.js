// LogicMonitor round 13: site circuits.
//
// Four jobs, all over rows ICC already stores (no network, no model):
//   1. Role. Every circuit lm_interfaces marks is_wan = 1 is a provider circuit ('wan'), a
//      connection to another location ('site-link') or an inter-switch 'uplink'. The evidence
//      order is override, CG tag class, topology far end, label naming another site, carrier or
//      circuit id (classifyCircuitRole). computeCircuits in logicmonitorPath.js calls it.
//   2. Site WAN state. A site with one of two WAN circuits down is degraded, not down
//      (computeSiteWanState writes lm_sites.wan_*). Site links never count toward it.
//   3. Circuit event log. lm_circuit_events keeps every down / up / flap / saturation
//      transition so a drop survives the history window and carries an operator note
//      (recordCircuitTransitions).
//   4. Issues and views: site-wan-down, site-wan-degraded, circuit-down, site-link-down,
//      circuit-flapping, circuit-flap-pattern, the Site 360 payload, the circuit map and the
//      Ops Agent evidence lines.
//
// Timestamps stored here (lm_circuit_events.at) are SQLite UTC "YYYY-MM-DD HH:MM:SS", the same
// format lm_interface_history.captured_at uses; everything that leaves for the browser goes
// through isoOf so it carries a zone. Cutoffs are built in JS and bound, never compared with
// datetime('now') in SQL.
const issuesMod = () => require('./logicmonitorIssues');
const pathMod = () => require('./logicmonitorPath');

const norm = (s) => String(s == null ? '' : s).trim().toLowerCase();
const sqlTs = (ms) => new Date(ms).toISOString().replace('T', ' ').slice(0, 19);
const isoOf = (ts) => {
  if (!ts) return null;
  const s = String(ts);
  if (/[TZ]/.test(s) || /[+-]\d\d:?\d\d$/.test(s)) return s;
  return `${s.replace(' ', 'T')}Z`;
};
const parseJson = (s, fallback) => {
  if (s == null || s === '') return fallback;
  try { const v = JSON.parse(s); return v == null ? fallback : v; } catch { return fallback; }
};
const threshold = (key, fallback) => { try { return issuesMod().getThreshold(key); } catch { return fallback; } };

const ROLES = ['wan', 'site-link', 'uplink'];
// CG ifAlias tag class ("[t=<class> ...]", kept as props_json.iccClass by the poller) to role.
const TAG_ROLE = {
  dia: 'wan', mpls: 'wan', wan: 'wan', inet: 'wan', isp: 'wan',
  p2p: 'site-link', ptp: 'site-link', b2b: 'site-link', dci: 'site-link',
  upl: 'uplink',
};

const CIRCUIT_ISSUE_TYPES = new Set(['site-wan-down', 'site-wan-degraded', 'circuit-down', 'site-link-down', 'circuit-flapping', 'circuit-flap-pattern']);

// -- Role classification (pure) -------------------------------------------------------------------

const escRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * Site-name tokens for the "label names another site" rule: every site name and key of
 * length >= 2 as a case-insensitive whole-token regex, longest first (the overview's rule).
 * sites: [{siteKey, siteName}].
 */
function buildSiteTokens(sites) {
  const tokens = [];
  for (const s of sites || []) {
    const key = s.siteKey != null ? s.siteKey : s.site_key;
    const name = s.siteName != null ? s.siteName : s.site_name;
    for (const t of new Set([name, key])) {
      if (t && String(t).length >= 2) {
        tokens.push({ siteKey: key, token: String(t), re: new RegExp(`(^|[^a-z0-9])${escRe(String(t).toLowerCase())}([^a-z0-9]|$)`) });
      }
    }
  }
  return tokens.sort((a, b) => b.token.length - a.token.length);
}

/** Site key of the first site token found in free text that is not the own site; null when none. */
function farSiteFromLabel(text, tokens, ownSiteKey) {
  const hay = String(text || '').toLowerCase();
  if (!hay) return null;
  const hit = (tokens || []).find((t) => t.siteKey !== ownSiteKey && t.re.test(hay));
  return hit ? hit.siteKey : null;
}

/**
 * Role of one circuit. Evidence order, first hit wins:
 *   1 override ("device:port=wan" / "=site-link" / "=uplink")
 *   2 CG tag class (dia, mpls, wan, inet, isp = wan; p2p, ptp, b2b, dci = site-link; upl = uplink)
 *   3 topology far end (other site = site-link, same site = uplink)
 *   4 label names another site = site-link
 *   5 carrier or circuit id present = wan
 *   6 otherwise wan, reason 'assumed-wan'
 * input: { overrideRole, tagClass, ownSiteKey, topoSiteKey, labelFarSiteKey, hasCarrierOrCid, wanReason }.
 * Returns { role, farSiteKey, reason }; farSiteKey is set for site-links only.
 */
function classifyCircuitRole(input = {}) {
  const own = input.ownSiteKey || null;
  const topoFar = input.topoSiteKey && input.topoSiteKey !== own ? input.topoSiteKey : null;
  const topoSame = !!(input.topoSiteKey && own && input.topoSiteKey === own);
  const far = () => topoFar || input.labelFarSiteKey || null;
  if (input.overrideRole && ROLES.includes(input.overrideRole)) {
    return { role: input.overrideRole, farSiteKey: input.overrideRole === 'site-link' ? far() : null, reason: 'override' };
  }
  const tagRole = TAG_ROLE[norm(input.tagClass)] || null;
  if (tagRole) return { role: tagRole, farSiteKey: tagRole === 'site-link' ? far() : null, reason: `tag:${norm(input.tagClass)}` };
  if (topoFar) return { role: 'site-link', farSiteKey: topoFar, reason: 'topology' };
  if (topoSame) return { role: 'uplink', farSiteKey: null, reason: 'topology-same-site' };
  if (input.labelFarSiteKey) return { role: 'site-link', farSiteKey: input.labelFarSiteKey, reason: 'label' };
  if (input.hasCarrierOrCid) return { role: 'wan', farSiteKey: null, reason: 'carrier-or-circuit-id' };
  return { role: 'wan', farSiteKey: null, reason: 'assumed-wan' };
}

// -- Site WAN state (pure) ------------------------------------------------------------------------

/**
 * Site state from its WAN circuits: every circuit down = 'down'; some down or any flapping =
 * 'degraded'; none down = 'ok'; no WAN circuits = null.
 */
function siteWanState({ total = 0, down = 0, flapping = 0 } = {}) {
  if (!total) return null;
  if (down >= total) return 'down';
  if (down > 0 || flapping > 0) return 'degraded';
  return 'ok';
}

/** 'down' on the transition up -> down, 'up' on down -> up (LM status 1 = up, 2 = down), else null. */
function transitionEvent(prev, cur) {
  if (prev == null || cur == null || prev === cur) return null;
  if (Number(prev) === 1 && Number(cur) === 2) return 'down';
  if (Number(prev) === 2 && Number(cur) === 1) return 'up';
  return null;
}

const statusIsDown = (r) => {
  const text = r.status_text || (r.status == null ? 'unknown' : Number(r.status) === 1 ? 'up' : Number(r.status) === 2 ? 'down' : 'other');
  return text === 'down' && Number(r.stop_monitoring) !== 1;
};

/** Status changes in an ordered list of {status} rows (nulls skipped). */
function countChanges(rows) {
  let n = 0; let prev = null;
  for (const h of rows) { if (h.status == null) continue; if (prev != null && h.status !== prev) n += 1; prev = h.status; }
  return n;
}

/**
 * Edge state for a pair of sites from its site-link circuits [{state: 'ok'|'down', flaps24h}]:
 * down when every circuit is down, degraded when some are, flapping when any flaps at or above
 * the threshold and none is down, else ok.
 */
function edgeState(circuits, flapWarn = 3) {
  const list = circuits || [];
  if (!list.length) return 'ok';
  const down = list.filter((c) => c.state === 'down').length;
  if (down === list.length) return 'down';
  if (down > 0) return 'degraded';
  if (list.some((c) => (c.flaps24h || 0) >= flapWarn)) return 'flapping';
  return 'ok';
}

// -- Stored circuits (light rows) -----------------------------------------------------------------

/**
 * Circuit rows (lm_interfaces.is_wan = 1) with role, state and 24 h flap count; much cheaper than
 * logicmonitorPath.circuitRows because there is no utilisation work. Rows whose role is not yet
 * classified (before the daily computeCircuits) count as 'wan'. Uplink rows are never is_wan.
 */
function circuitLight(dbh, { sourceId = null, nowMs = Date.now(), withInfo = false } = {}) {
  const where = ['i.is_wan = 1', 'i.stale = 0', 'd.stale = 0'];
  const args = [];
  if (sourceId != null) { where.push('i.source_id = ?'); args.push(sourceId); }
  const rows = dbh.prepare(`
    SELECT i.source_id, i.instance_id, i.display_name AS port, i.description, i.wan_label, i.status, i.status_text, i.stop_monitoring,
      i.circuit_role, i.circuit_far_site_key, i.props_json, d.lm_device_id, d.display_name AS dev_name, d.name AS dev_alt, d.site_key, d.site_name
    FROM lm_interfaces i JOIN lm_devices d ON d.source_id = i.source_id AND d.lm_device_id = i.lm_device_id
    WHERE ${where.join(' AND ')} ORDER BY d.display_name, i.display_name
  `).all(...args);
  if (!rows.length) return [];
  const dayAgo = sqlTs(nowMs - 86400000);
  const hist = new Map();
  for (const h of dbh.prepare(`
    SELECT h.source_id, h.instance_id, h.status FROM lm_interface_history h
    JOIN lm_interfaces i ON i.source_id = h.source_id AND i.instance_id = h.instance_id AND i.is_wan = 1 AND i.stale = 0
    WHERE h.captured_at >= ? ${sourceId != null ? 'AND h.source_id = ?' : ''}
    ORDER BY h.source_id, h.instance_id, h.captured_at, h.id
  `).all(dayAgo, ...args)) {
    const k = `${h.source_id}|${h.instance_id}`;
    if (!hist.has(k)) hist.set(k, []);
    hist.get(k).push(h);
  }
  const siteNames = new Map();
  try {
    for (const s of dbh.prepare('SELECT source_id, site_key, site_name FROM lm_sites').all()) siteNames.set(`${s.source_id}|${s.site_key}`, s.site_name);
  } catch { /* sites not built yet */ }
  const path = withInfo ? pathMod() : null;
  const aliases = withInfo ? path.loadCarrierAliases() : null;
  return rows.map((r) => {
    const ci = withInfo ? path.circuitInfo(r.description, r.props_json, aliases) : null;
    return {
      sourceId: r.source_id, instanceId: r.instance_id, deviceId: r.lm_device_id, deviceName: r.dev_name || r.dev_alt, port: r.port,
      target: `${r.dev_name || r.dev_alt} ${r.port}`,
      siteKey: r.site_key || null, siteName: r.site_name || (r.site_key ? siteNames.get(`${r.source_id}|${r.site_key}`) : null) || null,
      role: r.circuit_role || 'wan', farSiteKey: r.circuit_far_site_key || null,
      farSiteName: r.circuit_far_site_key ? (siteNames.get(`${r.source_id}|${r.circuit_far_site_key}`) || r.circuit_far_site_key) : null,
      label: r.wan_label || r.description || `${r.dev_name || r.dev_alt} ${r.port}`,
      down: statusIsDown(r), flaps24h: countChanges(hist.get(`${r.source_id}|${r.instance_id}`) || []),
      carrier: ci ? ci.carrier : null, circuitId: ci ? ci.circuitId : null,
    };
  });
}

/** Per-site WAN counts from light rows: Map "source|siteKey" -> {sourceId, siteKey, siteName, total, down, flapping, rows}. */
function wanBySite(rows, flapWarn) {
  const out = new Map();
  for (const r of rows) {
    if (r.role !== 'wan' || !r.siteKey) continue;
    const k = `${r.sourceId}|${r.siteKey}`;
    if (!out.has(k)) out.set(k, { sourceId: r.sourceId, siteKey: r.siteKey, siteName: r.siteName, total: 0, down: 0, flapping: 0, rows: [] });
    const e = out.get(k);
    e.total += 1; e.rows.push(r);
    if (r.down) e.down += 1;
    else if (r.flaps24h >= flapWarn) e.flapping += 1;
  }
  for (const e of out.values()) e.state = siteWanState(e);
  return out;
}

/**
 * Write lm_sites.wan_* for one portal (or all). computeSites rebuilds lm_sites every tick, so
 * this runs right after it. Returns {sites, down, degraded}.
 */
function computeSiteWanState(dbh, sourceId = null, { nowMs = Date.now() } = {}) {
  const res = { sites: 0, down: 0, degraded: 0 };
  try {
    const flapWarn = threshold('lm_circuit_flap_warn', 3);
    const groups = wanBySite(circuitLight(dbh, { sourceId, nowMs }), flapWarn);
    const stamp = new Date(nowMs).toISOString();
    const reset = dbh.prepare(`UPDATE lm_sites SET wan_state = NULL, wan_total = 0, wan_down = 0, wan_flapping = 0, wan_updated_at = ?
      ${sourceId != null ? 'WHERE source_id = ?' : ''}`);
    const set = dbh.prepare('UPDATE lm_sites SET wan_state = ?, wan_total = ?, wan_down = ?, wan_flapping = ?, wan_updated_at = ? WHERE source_id = ? AND site_key = ?');
    dbh.transaction(() => {
      reset.run(stamp, ...(sourceId != null ? [sourceId] : []));
      for (const g of groups.values()) {
        set.run(g.state, g.total, g.down, g.flapping, stamp, g.sourceId, g.siteKey);
        res.sites += 1;
        if (g.state === 'down') res.down += 1;
        else if (g.state === 'degraded') res.degraded += 1;
      }
    })();
  } catch { /* lm_sites columns missing on an unmigrated database */ }
  return res;
}

// -- Circuit event log ----------------------------------------------------------------------------

/**
 * Record circuit transitions from lm_interface_history for role wan / site-link circuits:
 * 'down' and 'up' at every status change in the last 26 hours (each written once, keyed by
 * instance + event + the history sample time, so reruns add nothing), 'flap-start' when the 24 h
 * change count reaches lm_circuit_flap_warn, 'flap-stop' after a day with no change, and
 * 'saturated' / 'cleared' when the saturation state enters or leaves critical.
 * Returns {written}.
 */
function recordCircuitTransitions(dbh, sourceId = null, { nowMs = Date.now() } = {}) {
  const res = { written: 0 };
  try {
    const flapWarn = threshold('lm_circuit_flap_warn', 3);
    const circuits = circuitLight(dbh, { sourceId, nowMs }).filter((c) => c.role === 'wan' || c.role === 'site-link');
    if (!circuits.length) return res;
    const nowTs = sqlTs(nowMs);
    const dayAgo = sqlTs(nowMs - 86400000);
    const winStart = sqlTs(nowMs - 26 * 3600000);
    const hist = new Map();
    const args = sourceId != null ? [sourceId] : [];
    for (const h of dbh.prepare(`
      SELECT h.source_id, h.instance_id, h.status, h.captured_at FROM lm_interface_history h
      JOIN lm_interfaces i ON i.source_id = h.source_id AND i.instance_id = h.instance_id AND i.is_wan = 1 AND i.stale = 0
      WHERE h.captured_at >= ? ${sourceId != null ? 'AND h.source_id = ?' : ''}
      ORDER BY h.source_id, h.instance_id, h.captured_at, h.id
    `).all(winStart, ...args)) {
      const k = `${h.source_id}|${h.instance_id}`;
      if (!hist.has(k)) hist.set(k, []);
      hist.get(k).push(h);
    }
    let sat = new Map();
    try {
      sat = new Map(pathMod().circuitRows(dbh, { sourceId, nowMs }).map((r) => [`${r.sourceId}|${r.instanceId}`, r.satState]));
    } catch { /* saturation unavailable */ }
    const exists = dbh.prepare('SELECT 1 FROM lm_circuit_events WHERE source_id = ? AND instance_id = ? AND event = ? AND at = ?');
    const lastOf = (events) => dbh.prepare(`SELECT event FROM lm_circuit_events WHERE source_id = ? AND instance_id = ? AND event IN (${events.map((e) => `'${e}'`).join(',')})
      ORDER BY at DESC, id DESC LIMIT 1`);
    const lastFlap = lastOf(['flap-start', 'flap-stop']);
    const lastSat = lastOf(['saturated', 'cleared']);
    const ins = dbh.prepare(`INSERT INTO lm_circuit_events (source_id, instance_id, device_name, port, site_key, far_site_key, role, event, at, details_json)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
    const write = (c, event, at, details) => {
      ins.run(c.sourceId, c.instanceId, c.deviceName, c.port, c.siteKey, c.farSiteKey, c.role, event, at, details ? JSON.stringify(details) : null);
      res.written += 1;
    };
    dbh.transaction(() => {
      for (const c of circuits) {
        const rows = (hist.get(`${c.sourceId}|${c.instanceId}`) || []).filter((h) => h.status != null);
        let prev = null;
        for (const h of rows) {
          const ev = prev ? transitionEvent(prev.status, h.status) : null;
          if (ev && !exists.get(c.sourceId, c.instanceId, ev, h.captured_at)) write(c, ev, h.captured_at, { from: prev.status, to: h.status, label: c.label });
          prev = h;
        }
        const last24 = rows.filter((h) => h.captured_at >= dayAgo);
        const changes = countChanges(last24);
        const flap = (lastFlap.get(c.sourceId, c.instanceId) || {}).event || null;
        if (changes >= flapWarn && flap !== 'flap-start') write(c, 'flap-start', nowTs, { changes24h: changes });
        else if (changes === 0 && last24.length >= 2 && flap === 'flap-start') write(c, 'flap-stop', nowTs, { changes24h: 0 });
        const satNow = sat.get(`${c.sourceId}|${c.instanceId}`);
        if (satNow) {
          const lastS = (lastSat.get(c.sourceId, c.instanceId) || {}).event || null;
          if (satNow === 'critical' && lastS !== 'saturated') write(c, 'saturated', nowTs, null);
          else if (satNow !== 'critical' && lastS === 'saturated') write(c, 'cleared', nowTs, null);
        }
      }
    })();
  } catch (e) { require('../utils/logger').warn(`[LmCircuits] circuit event log failed: ${e.message}`); }
  return res;
}

/** Drop events older than lm_circuit_event_days. */
function pruneCircuitEvents(dbh) {
  try {
    const days = threshold('lm_circuit_event_days', 365);
    const cut = sqlTs(Date.now() - days * 86400000);
    return dbh.prepare('DELETE FROM lm_circuit_events WHERE at < ?').run(cut).changes;
  } catch { return 0; }
}

const eventOut = (e) => ({
  id: e.id, at: isoOf(e.at), event: e.event, deviceName: e.device_name, port: e.port, siteKey: e.site_key, role: e.role,
  farSiteKey: e.far_site_key, instanceId: e.instance_id, sourceId: e.source_id, note: e.note || null, notedBy: e.noted_by || null,
  notedAt: isoOf(e.noted_at), issueKey: e.issue_key || null, details: parseJson(e.details_json, null),
});

/**
 * Server-paged event list. filters: {siteKey, instanceId, event, days, q, page, pageSize}. Newest
 * first. Returns {rows, total, page, pageSize}.
 */
function listEvents(dbh, f = {}) {
  const where = [];
  const args = [];
  if (f.siteKey) { where.push('(site_key = ? OR far_site_key = ?)'); args.push(f.siteKey, f.siteKey); }
  if (f.instanceId != null) { where.push('instance_id = ?'); args.push(f.instanceId); }
  if (f.event) { where.push('event = ?'); args.push(f.event); }
  if (f.days) { where.push('at >= ?'); args.push(sqlTs(Date.now() - f.days * 86400000)); }
  if (f.q) {
    where.push("(LOWER(COALESCE(device_name, '')) LIKE ? OR LOWER(COALESCE(port, '')) LIKE ? OR LOWER(COALESCE(note, '')) LIKE ? OR LOWER(COALESCE(site_key, '')) LIKE ? OR LOWER(COALESCE(far_site_key, '')) LIKE ?)");
    const like = `%${String(f.q).toLowerCase().replace(/[%_]/g, '')}%`;
    args.push(like, like, like, like, like);
  }
  const sql = where.length ? `WHERE ${where.join(' AND ')}` : '';
  const pageSize = Math.min(5000, Math.max(1, f.pageSize || 50));
  const page = Math.max(1, f.page || 1);
  const total = dbh.prepare(`SELECT COUNT(*) n FROM lm_circuit_events ${sql}`).get(...args).n;
  const rows = dbh.prepare(`SELECT * FROM lm_circuit_events ${sql} ORDER BY at DESC, id DESC LIMIT ? OFFSET ?`)
    .all(...args, pageSize, (page - 1) * pageSize).map(eventOut);
  return { rows, total, page, pageSize };
}

/** Store (or clear with an empty string, via the caller) the operator note on one event. Returns the row or null. */
function setEventNote(dbh, id, note, by) {
  const info = dbh.prepare('UPDATE lm_circuit_events SET note = ?, noted_by = ?, noted_at = ? WHERE id = ?')
    .run(String(note).slice(0, 2000), by || null, sqlTs(Date.now()), id);
  if (!info.changes) return null;
  return eventOut(dbh.prepare('SELECT * FROM lm_circuit_events WHERE id = ?').get(id));
}

// -- Issues ---------------------------------------------------------------------------------------

/** Set of "source|instance" for circuits the generic interface-flapping rule must skip. */
function circuitInstanceSet(dbh) {
  try {
    return new Set(dbh.prepare("SELECT source_id, instance_id FROM lm_interfaces WHERE is_wan = 1 AND stale = 0 AND COALESCE(circuit_role, 'wan') IN ('wan', 'site-link')")
      .all().map((r) => `${r.source_id}|${r.instance_id}`));
  } catch { return new Set(); }
}

const pairKey = (a, b) => [a || '?', b || '?'].sort().join('|');

/** Issues for the circuit rules. t is the threshold object; srcName maps source id to name. */
function computeCircuitIssues(dbh, t, srcName, nowMs = Date.now()) {
  const issues = [];
  const flapWarn = (t && t.lm_circuit_flap_warn) || threshold('lm_circuit_flap_warn', 3);
  const flapDays = (t && t.lm_circuit_flap_days) || threshold('lm_circuit_flap_days', 3);
  const rows = circuitLight(dbh, { nowMs, withInfo: true });
  if (!rows.length) return issues;
  const groups = wanBySite(rows, flapWarn);
  const siteName = (g) => g.siteName || g.siteKey;

  for (const g of groups.values()) {
    const source = srcName.get(g.sourceId);
    if (g.state === 'down') {
      issues.push({ severity: 'critical', type: 'site-wan-down', source, target: siteName(g),
        message: `${siteName(g)} has no WAN circuit up (${g.down} of ${g.total} down)` });
    } else if (g.state === 'degraded') {
      const msg = g.down > 0
        ? `${siteName(g)} is running on ${g.total - g.down} of ${g.total} WAN circuits${g.flapping ? `, ${g.flapping} flapping` : ''}`
        : `${siteName(g)} has a flapping WAN circuit (${g.flapping} of ${g.total})`;
      issues.push({ severity: 'warning', type: 'site-wan-degraded', source, target: siteName(g), message: msg });
    }
  }
  for (const r of rows) {
    if (r.role !== 'wan' || !r.down) continue;
    const g = r.siteKey ? groups.get(`${r.sourceId}|${r.siteKey}`) : null;
    const lab = String(r.label || '').toLowerCase();
    const extra = [r.carrier && !lab.includes(String(r.carrier).toLowerCase()) ? r.carrier : null,
      r.circuitId && !lab.includes(String(r.circuitId).toLowerCase()) ? `circuit ${r.circuitId}` : null].filter(Boolean);
    const tail = !g ? '' : g.state === 'down'
      ? `; ${siteName(g)} has no WAN circuit up`
      : `; ${siteName(g)} remains reachable on ${g.total - g.down} other WAN circuit${g.total - g.down === 1 ? '' : 's'}`;
    issues.push({ severity: 'warning', type: 'circuit-down', source: srcName.get(r.sourceId), target: r.target,
      message: `WAN circuit ${r.target} (${[r.label, ...extra].join(', ')}) is down${tail}` });
  }
  // Site links, one issue per site pair with any circuit down.
  const pairs = new Map();
  for (const r of rows) {
    if (r.role !== 'site-link') continue;
    const k = `${r.sourceId}|${pairKey(r.siteKey, r.farSiteKey)}`;
    if (!pairs.has(k)) pairs.set(k, []);
    pairs.get(k).push(r);
  }
  for (const list of pairs.values()) {
    const downs = list.filter((r) => r.down);
    if (!downs.length) continue;
    const names = [list[0].siteName || list[0].siteKey || 'unknown site', list[0].farSiteName || list[0].farSiteKey || 'unknown site'].sort((a, b) => a.localeCompare(b));
    const target = `${names[0]} <-> ${names[1]}`;
    issues.push({ severity: 'warning', type: 'site-link-down', source: srcName.get(list[0].sourceId), target,
      message: `Site link ${target} is down on ${downs.map((r) => r.target).join(', ')}${list.length > downs.length ? ` (${downs.length} of ${list.length} circuits)` : ''}` });
  }
  for (const r of rows) {
    if (r.role !== 'wan' && r.role !== 'site-link') continue;
    if (r.flaps24h >= flapWarn) {
      issues.push({ severity: 'warning', type: 'circuit-flapping', source: srcName.get(r.sourceId), target: r.target,
        message: `${r.role === 'wan' ? 'WAN circuit' : 'Site link'} ${r.target} changed status ${r.flaps24h} times in 24 h` });
    }
  }
  // Flap pattern: down transitions on several distinct days of the last 7.
  try {
    const byKey = new Map(rows.filter((r) => r.role === 'wan' || r.role === 'site-link').map((r) => [`${r.sourceId}|${r.instanceId}`, r]));
    const cut = sqlTs(nowMs - 7 * 86400000);
    const agg = new Map();
    for (const e of dbh.prepare("SELECT source_id, instance_id, event, at FROM lm_circuit_events WHERE at >= ? AND event IN ('down', 'up')").all(cut)) {
      const k = `${e.source_id}|${e.instance_id}`;
      if (!byKey.has(k)) continue;
      const a = agg.get(k) || { days: new Set(), changes: 0 };
      a.changes += 1;
      if (e.event === 'down') a.days.add(String(e.at).slice(0, 10));
      agg.set(k, a);
    }
    for (const [k, a] of agg) {
      if (a.days.size < flapDays) continue;
      const r = byKey.get(k);
      issues.push({ severity: 'warning', type: 'circuit-flap-pattern', source: srcName.get(r.sourceId), target: r.target,
        message: `${r.target} flapped on ${a.days.size} of the last 7 days (${a.changes} changes), expect a failure` });
    }
  } catch { /* events table missing */ }
  return issues;
}

/**
 * Stamp issue_key on the newest unkeyed event an opened circuit issue belongs to. issue is the
 * computed issue ({type, source, target}), key its issueKey.
 */
function linkIssueToEvents(dbh, issue, key) {
  try {
    if (!CIRCUIT_ISSUE_TYPES.has(issue.type)) return 0;
    const src = dbh.prepare('SELECT id FROM lm_sources WHERE name = ?').get(issue.source);
    if (!src) return 0;
    const pick = (cond, ...a) => dbh.prepare(`UPDATE lm_circuit_events SET issue_key = ? WHERE id = (
      SELECT id FROM lm_circuit_events WHERE source_id = ? AND issue_key IS NULL AND ${cond} ORDER BY at DESC, id DESC LIMIT 1)`).run(key, src.id, ...a).changes;
    if (issue.type === 'circuit-down') return pick("event = 'down' AND (device_name || ' ' || port) = ?", issue.target);
    if (issue.type === 'circuit-flapping') return pick("event = 'flap-start' AND (device_name || ' ' || port) = ?", issue.target);
    if (issue.type === 'circuit-flap-pattern') return pick("event IN ('flap-start', 'down') AND (device_name || ' ' || port) = ?", issue.target);
    if (issue.type === 'site-wan-down' || issue.type === 'site-wan-degraded') {
      const site = dbh.prepare('SELECT site_key FROM lm_sites WHERE source_id = ? AND (site_name = ? OR site_key = ?)').get(src.id, issue.target, issue.target);
      return site ? pick("event = 'down' AND role = 'wan' AND site_key = ?", site.site_key) : 0;
    }
    if (issue.type === 'site-link-down') {
      const parts = String(issue.target).split(' <-> ');
      const keys = parts.map((p) => (dbh.prepare('SELECT site_key FROM lm_sites WHERE source_id = ? AND (site_name = ? OR site_key = ?)').get(src.id, p, p) || {}).site_key).filter(Boolean);
      if (!keys.length) return 0;
      return pick("event = 'down' AND role = 'site-link' AND (site_key IN (" + keys.map(() => '?').join(',') + ') OR far_site_key IN (' + keys.map(() => '?').join(',') + '))', ...keys, ...keys);
    }
  } catch { /* linking is best effort */ }
  return 0;
}

/** Open issue keys by target for the circuit issue types (and the saturation type). */
function openIssueMap(dbh) {
  const out = new Map();
  try {
    const order = { 'site-wan-down': 0, 'circuit-down': 1, 'site-link-down': 1, 'circuit-flapping': 2, 'circuit-flap-pattern': 3, 'site-wan-degraded': 4, 'circuit-saturated': 5 };
    for (const r of dbh.prepare("SELECT issue_key, type, target FROM lm_issue_history WHERE status = 'open' AND type IN ('site-wan-down','site-wan-degraded','circuit-down','site-link-down','circuit-flapping','circuit-flap-pattern','circuit-saturated')").all()) {
      const cur = out.get(r.target);
      if (!cur || order[r.type] < order[cur.type]) out.set(r.target, r);
    }
  } catch { /* history missing */ }
  return out;
}

// -- Views ----------------------------------------------------------------------------------------

/** Pair target text the site-link-down issue uses. */
function pairTarget(aName, bName) {
  const names = [aName || 'unknown site', bName || 'unknown site'].sort((x, y) => x.localeCompare(y));
  return `${names[0]} <-> ${names[1]}`;
}

/**
 * Site 360 circuits payload (GET /sites/:siteKey/circuits). Returns null for an unknown site.
 */
function siteCircuits(dbh, siteKey, { sourceId = null, nowMs = Date.now() } = {}) {
  const siteRow = dbh.prepare(`SELECT source_id, site_key, site_name FROM lm_sites WHERE site_key = ? ${sourceId != null ? 'AND source_id = ?' : ''} ORDER BY source_id LIMIT 1`)
    .get(siteKey, ...(sourceId != null ? [sourceId] : []));
  if (!siteRow) return null;
  const flapWarn = threshold('lm_circuit_flap_warn', 3);
  const all = pathMod().circuitRows(dbh, { sourceId: siteRow.source_id, nowMs });
  const issues = openIssueMap(dbh);
  const decorate = (c) => {
    const pt = c.role === 'site-link' ? issues.get(pairTarget(c.siteName, c.farSiteName)) : null;
    const hit = issues.get(`${c.deviceName} ${c.port}`) || pt || null;
    return { ...c, openIssueKey: hit ? hit.issue_key : null };
  };
  const own = all.filter((c) => c.siteKey === siteKey);
  const wanRows = own.filter((c) => c.role === 'wan').map(decorate);
  const links = own.filter((c) => c.role === 'site-link').map(decorate);
  // Site links monitored only from the far end still belong to this site's picture.
  const remote = all.filter((c) => c.role === 'site-link' && c.farSiteKey === siteKey && c.siteKey !== siteKey).map((c) => ({ ...decorate(c), remoteEnd: true }));
  const down = wanRows.filter((c) => c.statusText === 'down').length;
  const flapping = wanRows.filter((c) => c.statusText !== 'down' && c.flaps24h >= flapWarn).length;
  const wan = { state: siteWanState({ total: wanRows.length, down, flapping }), total: wanRows.length, down, flapping };
  const events = dbh.prepare('SELECT * FROM lm_circuit_events WHERE site_key = ? OR far_site_key = ? ORDER BY at DESC, id DESC LIMIT 50')
    .all(siteKey, siteKey).map((e) => ({
      id: e.id, at: isoOf(e.at), event: e.event, deviceName: e.device_name, port: e.port, role: e.role,
      farSiteKey: e.far_site_key, note: e.note || null, issueKey: e.issue_key || null,
    }));
  return { siteKey, siteName: siteRow.site_name || siteKey, sourceId: siteRow.source_id, wan, circuits: wanRows, siteLinks: [...links, ...remote], events };
}

/**
 * Pure builder for the circuit map. nodes: [{siteKey, siteName, tier, wanTotal, wanDown, wanFlapping,
 * devicesDead, deadDevices[], degradedDevices[], openIssues}], circuits: light rows, openIssues: Map
 * target -> {issue_key}, lastEventBy: Map "a|b" -> iso. Edges group site-link circuits per unordered pair.
 */
function buildCircuitMap({ nodes, circuits, issues = new Map(), lastEventBy = new Map(), flapWarn = 3 }) {
  const edgesByKey = new Map();
  for (const c of circuits) {
    if (c.role !== 'site-link' || !c.siteKey || !c.farSiteKey || c.siteKey === c.farSiteKey) continue;
    const [a, b] = [c.siteKey, c.farSiteKey].sort();
    const key = `${a}|${b}`;
    if (!edgesByKey.has(key)) edgesByKey.set(key, { key, a, b, circuits: [], names: new Map() });
    const e = edgesByKey.get(key);
    e.names.set(c.siteKey, c.siteName || c.siteKey);
    if (c.farSiteName) e.names.set(c.farSiteKey, c.farSiteName);
    e.circuits.push({
      instanceId: c.instanceId, deviceName: c.deviceName, port: c.port, siteKey: c.siteKey,
      state: c.down ? 'down' : 'ok', flaps24h: c.flaps24h, label: c.label,
    });
  }
  const edges = [...edgesByKey.values()].map((e) => {
    const state = edgeState(e.circuits, flapWarn);
    const nameA = e.names.get(e.a) || e.a;
    const nameB = e.names.get(e.b) || e.b;
    let issueKey = null;
    const pairIssue = issues.get(pairTarget(nameA, nameB));
    if (pairIssue) issueKey = pairIssue.issue_key;
    else {
      const bad = e.circuits.find((c) => issues.get(`${c.deviceName} ${c.port}`));
      if (bad) issueKey = issues.get(`${bad.deviceName} ${bad.port}`).issue_key;
    }
    return { key: e.key, a: e.a, b: e.b, state, circuits: e.circuits, issueKey, lastEventAt: lastEventBy.get(e.key) || null };
  }).sort((x, y) => x.key.localeCompare(y.key));
  const nodeOut = nodes.map((n) => {
    const wanState = siteWanState({ total: n.wanTotal, down: n.wanDown, flapping: n.wanFlapping });
    const edgeBad = edges.some((e) => (e.a === n.siteKey || e.b === n.siteKey) && e.state !== 'ok');
    const dead = n.devicesDead || 0;
    let worstState = 'ok';
    if (wanState === 'down') worstState = 'down';
    else if (wanState === 'degraded' || edgeBad || dead > 0 || (n.openIssues || 0) > 0) worstState = 'degraded';
    return {
      siteKey: n.siteKey, siteName: n.siteName, tier: n.tier, wanState, wanTotal: n.wanTotal || 0, wanDown: n.wanDown || 0,
      devicesDead: dead, deadDevices: (n.deadDevices || []).slice(0, 10), degradedDevices: (n.degradedDevices || []).slice(0, 10),
      openIssues: n.openIssues || 0, worstState,
    };
  });
  const wan = nodeOut.filter((n) => n.wanState).map((n) => ({ siteKey: n.siteKey, state: n.wanState, total: n.wanTotal, down: n.wanDown }));
  return { nodes: nodeOut, edges, wan };
}

/** GET /circuit-map payload. */
function circuitMap(dbh, { nowMs = Date.now(), sourceId = null } = {}) {
  const flapWarn = threshold('lm_circuit_flap_warn', 3);
  const circuits = circuitLight(dbh, { sourceId, nowMs });
  const groups = wanBySite(circuits, flapWarn);
  const sites = dbh.prepare(`SELECT source_id, site_key, site_name, device_count, network_count FROM lm_sites ${sourceId != null ? 'WHERE source_id = ?' : ''}`)
    .all(...(sourceId != null ? [sourceId] : []));
  const devices = dbh.prepare(`SELECT source_id, lm_device_id, name, display_name, site_key, host_status FROM lm_devices WHERE stale = 0 AND site_key IS NOT NULL`).all();
  const deadBy = new Map();
  for (const d of devices) {
    if (d.host_status !== 'dead') continue;
    const k = `${d.source_id}|${d.site_key}`;
    if (!deadBy.has(k)) deadBy.set(k, []);
    deadBy.get(k).push(d.display_name || d.name);
  }
  // Devices with an open warning / critical issue, by site (issue target begins with the device name).
  const degradedBy = new Map();
  const openBySite = new Map();
  try {
    const nameToDev = new Map();
    for (const d of devices) for (const n of [d.display_name, d.name]) if (n) nameToDev.set(`${d.source_id}|${String(n).toLowerCase()}`, d);
    const srcIds = new Map(dbh.prepare('SELECT id, name FROM lm_sources').all().map((s) => [s.name, s.id]));
    for (const i of dbh.prepare("SELECT source, severity, type, target FROM lm_issue_history WHERE status = 'open' AND severity IN ('warning', 'critical')").all()) {
      const sid = srcIds.get(i.source);
      if (sid == null) continue;
      const words = String(i.target || '').split(' ').filter(Boolean);
      let dev = null;
      for (let n = words.length; n >= 1 && !dev; n -= 1) dev = nameToDev.get(`${sid}|${words.slice(0, n).join(' ').toLowerCase()}`) || null;
      if (!dev) continue;
      const k = `${sid}|${dev.site_key}`;
      openBySite.set(k, (openBySite.get(k) || 0) + 1);
      if (dev.host_status === 'dead') continue;
      const nm = dev.display_name || dev.name;
      if (!degradedBy.has(k)) degradedBy.set(k, new Set());
      degradedBy.get(k).add(nm);
    }
  } catch { /* issue history missing */ }
  const topCount = Math.max(1, Math.floor(sites.length / 4));
  const byNet = [...sites].sort((a, b) => (b.network_count || 0) - (a.network_count || 0) || String(a.site_name).localeCompare(String(b.site_name)));
  const topKeys = new Set(byNet.slice(0, topCount).map((s) => `${s.source_id}|${s.site_key}`));
  const DC_NAME = /\b(dc|data ?cent(er|re))\b/i;
  const nodes = sites.map((s) => {
    const k = `${s.source_id}|${s.site_key}`;
    const g = groups.get(k);
    return {
      siteKey: s.site_key, siteName: s.site_name || s.site_key,
      tier: DC_NAME.test(String(s.site_name)) || topKeys.has(k) ? 'dc' : 'site',
      wanTotal: g ? g.total : 0, wanDown: g ? g.down : 0, wanFlapping: g ? g.flapping : 0,
      devicesDead: (deadBy.get(k) || []).length, deadDevices: deadBy.get(k) || [],
      degradedDevices: [...(degradedBy.get(k) || [])], openIssues: openBySite.get(k) || 0,
    };
  });
  const lastEventBy = new Map();
  try {
    for (const e of dbh.prepare("SELECT site_key, far_site_key, MAX(at) AS at FROM lm_circuit_events WHERE far_site_key IS NOT NULL AND role = 'site-link' GROUP BY site_key, far_site_key").all()) {
      const key = [e.site_key, e.far_site_key].sort().join('|');
      const iso = isoOf(e.at);
      if (!lastEventBy.has(key) || iso > lastEventBy.get(key)) lastEventBy.set(key, iso);
    }
  } catch { /* events table missing */ }
  return buildCircuitMap({ nodes, circuits, issues: openIssueMap(dbh), lastEventBy, flapWarn });
}

/** Overview helper: Map "source|siteKey" -> {wanState, wanTotal, wanDown, circuitsDown} from light rows. */
function overviewWan(dbh, { nowMs = Date.now() } = {}) {
  const out = new Map();
  try {
    const flapWarn = threshold('lm_circuit_flap_warn', 3);
    const rows = circuitLight(dbh, { nowMs });
    for (const g of wanBySite(rows, flapWarn).values()) out.set(`${g.sourceId}|${g.siteKey}`, { wanState: g.state, wanTotal: g.total, wanDown: g.down, circuitsDown: 0 });
    for (const r of rows) {
      if (!r.down || !r.siteKey) continue;
      const k = `${r.sourceId}|${r.siteKey}`;
      if (!out.has(k)) out.set(k, { wanState: null, wanTotal: 0, wanDown: 0, circuitsDown: 0 });
      out.get(k).circuitsDown += 1;
    }
  } catch { /* circuit tables missing */ }
  return out;
}

const fmtAt = (ts) => (ts ? String(isoOf(ts)).replace('T', ' ').slice(0, 16) + 'Z' : 'never');

/**
 * Ops Agent evidence lines for one site: WAN state, one line per WAN circuit, one line per site
 * link, the last 5 circuit events in 7 days, and a plain sentence when the site still has a WAN up.
 */
function siteCircuitEvidence(dbh, siteKey, { nowMs = Date.now() } = {}) {
  const lines = [];
  try {
    const rows = dbh.prepare('SELECT source_id, site_key, site_name FROM lm_sites WHERE site_key = ?').all(siteKey);
    const flapWarn = threshold('lm_circuit_flap_warn', 3);
    for (const st of rows) {
      const name = st.site_name || siteKey;
      const circuits = circuitLight(dbh, { sourceId: st.source_id, nowMs, withInfo: true }).filter((c) => c.siteKey === siteKey);
      const wan = circuits.filter((c) => c.role === 'wan');
      const links = circuits.filter((c) => c.role === 'site-link');
      if (!wan.length && !links.length) continue;
      const evStmt = dbh.prepare("SELECT MAX(at) AS at FROM lm_circuit_events WHERE source_id = ? AND instance_id = ? AND event = 'down'");
      const wk = sqlTs(nowMs - 7 * 86400000);
      const flap7 = dbh.prepare("SELECT COUNT(*) n FROM lm_circuit_events WHERE source_id = ? AND instance_id = ? AND event IN ('down', 'up') AND at >= ?");
      if (wan.length) {
        const up = wan.filter((c) => !c.down);
        const state = siteWanState({ total: wan.length, down: wan.length - up.length, flapping: up.filter((c) => c.flaps24h >= flapWarn).length });
        lines.push(`Site circuits: ${name}: WAN ${state}, ${up.length} of ${wan.length} WAN circuits up`);
        for (const c of wan) {
          lines.push(`WAN circuit ${c.target}: ${c.down ? 'DOWN' : 'up'}${c.carrier ? `, carrier ${c.carrier}` : ''}${c.circuitId ? `, circuit ${c.circuitId}` : ''}, flaps ${c.flaps24h} in 24 h / ${flap7.get(c.sourceId, c.instanceId, wk).n} in 7 d, last down ${fmtAt((evStmt.get(c.sourceId, c.instanceId) || {}).at)}`);
        }
        if (state === 'degraded' && up.length) lines.push(`Site remains reachable through ${up.map((c) => c.target).join(', ')}; treat as degraded, not down.`);
        else if (state === 'ok') lines.push(`Site remains reachable through ${up.map((c) => c.target).join(', ')}; every WAN circuit is up.`);
      }
      for (const c of links) {
        lines.push(`Site link ${name} <-> ${c.farSiteName || c.farSiteKey || 'unknown site'}: ${c.down ? 'DOWN' : 'up'} (${c.target}), flaps ${c.flaps24h} in 24 h`);
      }
      for (const e of dbh.prepare('SELECT event, device_name, port, at, note FROM lm_circuit_events WHERE (site_key = ? OR far_site_key = ?) AND at >= ? ORDER BY at DESC, id DESC LIMIT 5')
        .all(siteKey, siteKey, wk)) {
        lines.push(`Circuit event ${fmtAt(e.at)} ${e.device_name} ${e.port}: ${e.event}${e.note ? ` (note: ${String(e.note).slice(0, 80)})` : ''}`);
      }
    }
  } catch { /* evidence is best effort */ }
  return lines;
}

module.exports = {
  ROLES, TAG_ROLE, CIRCUIT_ISSUE_TYPES,
  buildSiteTokens, farSiteFromLabel, classifyCircuitRole,
  siteWanState, transitionEvent, edgeState, countChanges, statusIsDown,
  circuitLight, wanBySite, computeSiteWanState,
  recordCircuitTransitions, pruneCircuitEvents, listEvents, setEventNote,
  circuitInstanceSet, computeCircuitIssues, linkIssueToEvents, openIssueMap,
  pairTarget, siteCircuits, buildCircuitMap, circuitMap, overviewWan, siteCircuitEvidence, isoOf,
};
