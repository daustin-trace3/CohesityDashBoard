// Computed LogicMonitor issues (shared by routes, the manifest hooks and the
// poller) plus their lifecycle history, eonIssues.js model exactly. LM's own
// alerts are passed through separately by the manifest's collectAlerts; these
// are the ICC-derived rules from contract section 7: portal reachability,
// collector health, dead devices, interface trends, alert storms, new devices
// and the check rules from logicmonitorChecks. Issue identity is
// `type|source|target`.
const db = require('../db/database');
const { getSetting } = require('./settings');
const checks = require('./logicmonitorChecks');
const { hasSdt, compareBuildStr } = require('./logicmonitorApi');
const lmPath = require('./logicmonitorPath');

// Every /config key (contract section 9), clamped on read.
const THRESHOLD_DEFS = {
  lm_if_util_warn_pct: { def: 80, min: 50, max: 100, label: 'Interface utilization warning (%)' },
  lm_if_err_warn: { def: 100, min: 1, max: 100000, label: 'Interface errors in 24 h warning' },
  lm_if_flap_warn: { def: 3, min: 1, max: 100, label: 'Interface status changes in 24 h warning' },
  lm_dead_grace_min: { def: 10, min: 0, max: 1440, label: 'Dead device grace (minutes)' },
  lm_alert_storm_count: { def: 50, min: 5, max: 10000, label: 'Alert storm (alerts in 15 min)' },
  lm_alert_retention_days: { def: 30, min: 1, max: 365, label: 'Cleared alert retention (days)' },
  lm_new_device_days: { def: 3, min: 0, max: 30, label: 'New device notice (days)' },
  lm_interface_history_days: { def: 30, min: 7, max: 90, label: 'Interface history retention (days)' },
  ...checks.CHECK_THRESHOLD_DEFS,
  // Round 3 (sites, path, suppression, circuits, interface baselines, webhook).
  lm_site_group_roots: { type: 'text', def: 'Network,Sites,Locations,Branch', maxLength: 500, label: 'Site group roots (comma list)' },
  lm_site_property: { type: 'text', def: 'site', maxLength: 120, label: 'Site device property name' },
  lm_site_from_hostname: { def: 1, min: 0, max: 1, bool: true, label: 'Derive site from hostname prefix' },
  lm_path_max_hops: { def: 6, min: 2, max: 12, label: 'Path hops from a server to the WAN edge' },
  lm_shadow_enabled: { def: 1, min: 0, max: 1, bool: true, label: 'Suppress alerts shadowed by an upstream failure' },
  lm_circuit_sat_pct: { def: 80, min: 50, max: 100, label: 'Circuit saturation p95 warning (%)' },
  lm_circuit_crit_pct: { def: 95, min: 60, max: 100, label: 'Circuit daily peak critical (%)' },
  lm_circuit_sat_days: { def: 7, min: 1, max: 30, label: 'Circuit saturation window (days)' },
  lm_if_baseline_days: { def: 7, min: 3, max: 30, label: 'Interface baseline window (days)' },
  lm_if_baseline_min_samples: { def: 48, min: 12, max: 2000, label: 'Minimum history samples per interface baseline' },
  lm_if_anomaly_k: { def: 4, min: 1, max: 10, label: 'Interface anomaly k (x MAD)' },
  lm_if_anomaly_util_min_pct: { def: 20, min: 1, max: 100, label: 'Interface utilization anomaly minimum (%)' },
  lm_if_anomaly_err_min: { def: 5, min: 1, max: 100000, label: 'Interface error anomaly minimum' },
  lm_backup_overlay_util_pct: { def: 70, min: 30, max: 100, label: 'Backup window port utilization (%)' },
  lm_wan_overrides: { type: 'text', def: '', maxLength: 2000, label: 'WAN circuit overrides (device:port, prefix ! to exclude)' },
  lm_webhook_rate_per_min: { def: 600, min: 60, max: 6000, label: 'Webhook rate limit (per minute)' },
};

/** Text settings (site roots, WAN overrides): a trimmed string, capped. */
function getTextSetting(key) {
  const d = THRESHOLD_DEFS[key];
  if (!d || d.type !== 'text') throw new Error(`unknown LogicMonitor text setting ${key}`);
  let raw;
  try { raw = getSetting(key); } catch { raw = null; }
  if (raw == null) return d.def;
  return String(raw).trim().slice(0, d.maxLength);
}

function getThreshold(key) {
  const d = THRESHOLD_DEFS[key];
  if (!d) throw new Error(`unknown LogicMonitor threshold ${key}`);
  if (d.type === 'text') return getTextSetting(key);
  let raw;
  try { raw = getSetting(key); } catch { raw = null; }
  if (raw == null || raw === '') return d.def;
  const n = Number(raw);
  if (!Number.isFinite(n)) return d.def;
  return Math.min(d.max, Math.max(d.min, Math.round(n)));
}

function getThresholds() {
  const out = {};
  for (const k of Object.keys(THRESHOLD_DEFS)) out[k] = getThreshold(k);
  return out;
}

/** -1 / 0 / 1 on the first two dotted parts ("39.005" vs "41.000"). */
const compareBuild = (a, b) => compareBuildStr(a, b);
const isBehind = (build, mgd) => !!(build && mgd && compareBuildStr(build, mgd) < 0);

function parseJson(v, fallback) {
  if (v == null || v === '') return fallback;
  try { return JSON.parse(v); } catch { return fallback; }
}

const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;

function computeIssues({ nowMs = Date.now() } = {}) {
  const t = getThresholds();
  const issues = [];
  const sources = db.prepare('SELECT * FROM lm_sources').all();
  if (!sources.length) return issues;
  const srcName = new Map(sources.map((s) => [s.id, s.name]));

  // source-unreachable
  for (const s of sources) {
    if (s.last_poll_status === 'error') {
      issues.push({ severity: 'critical', type: 'source-unreachable', source: s.name, target: s.name,
        message: `LogicMonitor portal ${s.name} (${s.company}.logicmonitor.com) is unreachable: ${s.last_poll_error || 'poll failed'}` });
    }
  }

  // collector-down (one incident per collector; its dead-collector devices
  // raise nothing of their own) and collector-build-behind.
  const devicesOnCollector = db.prepare('SELECT COUNT(*) n FROM lm_devices WHERE source_id = ? AND collector_id = ? AND stale = 0');
  for (const c of db.prepare('SELECT * FROM lm_collectors WHERE stale = 0').all()) {
    const source = srcName.get(c.source_id);
    const target = c.hostname || c.description || `collector ${c.collector_id}`;
    if (c.is_down && !c.in_sdt) {
      const n = devicesOnCollector.get(c.source_id, c.collector_id).n;
      issues.push({ severity: 'critical', type: 'collector-down', source, target,
        message: `Collector ${target} is down; ${plural(n, 'device')} on it are not being monitored${c.acked ? ' (acknowledged in LogicMonitor)' : ''}` });
    }
  }
  for (const s of sources) {
    const mgd = parseJson(s.features_json, {})?.collectorMgd;
    if (!mgd) continue;
    for (const c of db.prepare('SELECT * FROM lm_collectors WHERE source_id = ? AND stale = 0').all(s.id)) {
      if (isBehind(c.build, mgd)) {
        const target = c.hostname || c.description || `collector ${c.collector_id}`;
        issues.push({ severity: 'info', type: 'collector-build-behind', source: s.name, target,
          message: `Collector ${target} runs build ${c.build}, below the required release ${mgd}; LogicMonitor will force the upgrade` });
      }
    }
  }

  // device-dead. Network devices and check targets are critical, others
  // warning; SDT suppresses; grace from deleted_time_ms (time dead, ms) when
  // LM sends it, else from when ICC first saw it dead.
  const checkTargets = new Set(db.prepare('SELECT lower(target) t FROM lm_checks WHERE stale = 0 AND target IS NOT NULL').all().map((r) => r.t));
  const graceMs = t.lm_dead_grace_min * 60000;
  const deadList = [];
  for (const d of db.prepare("SELECT * FROM lm_devices WHERE stale = 0 AND host_status = 'dead'").all()) {
    if (hasSdt(d.sdt_status)) continue;
    let deadMs = null;
    if (d.deleted_time_ms != null && d.deleted_time_ms > 0) deadMs = d.deleted_time_ms;
    else if (d.dead_since) {
      const at = Date.parse(String(d.dead_since).includes('T') ? d.dead_since : `${String(d.dead_since).replace(' ', 'T')}Z`);
      if (Number.isFinite(at)) deadMs = nowMs - at;
    }
    if (deadMs == null || deadMs < graceMs) continue;
    deadList.push({ d, deadMs });
  }
  // Dependency suppression: a dead device behind a dead switch or a down
  // uplink is a consequence, not a root cause. The culprit gets "+N".
  const shadowOn = t.lm_shadow_enabled === 1;
  const shadowedDead = new Map();
  const deadBehind = new Map();
  if (shadowOn && deadList.length) {
    const pctx = lmPath.makeContext(db);
    for (const { d } of deadList) {
      const cause = lmPath.shadowCause(db, pctx, d.source_id, d.lm_device_id);
      if (!cause) continue;
      shadowedDead.set(`${d.source_id}:${d.lm_device_id}`, cause);
      const ck = `${cause.sourceId}:${cause.deviceId}`;
      deadBehind.set(ck, (deadBehind.get(ck) || 0) + 1);
    }
  }
  const alertShadows = shadowOn ? shadowedAlertCounts(db) : new Map();
  for (const { d, deadMs } of deadList) {
    const names = [d.display_name, d.name, d.hostname, ...parseJson(d.ips_json, [])].filter(Boolean).map((x) => String(x).toLowerCase());
    const isTarget = names.some((n) => checkTargets.has(n));
    const target = d.display_name || d.name;
    const mins = Math.round(deadMs / 60000);
    const since = mins >= 120 ? `${Math.round(mins / 60)} h` : `${mins} min`;
    let message = `${target}${d.role && d.role !== 'other' ? ` (${d.role})` : ''} is not responding to its collector for ${since}`;
    let severity = d.is_network || isTarget ? 'critical' : 'warning';
    const cause = shadowedDead.get(`${d.source_id}:${d.lm_device_id}`);
    if (cause) {
      message += ` (shadowed by ${cause.deviceName}${cause.port ? ` ${cause.port}` : ''})`;
      severity = 'info';
    } else {
      const n = (deadBehind.get(`${d.source_id}:${d.lm_device_id}`) || 0) + (alertShadows.get(`${d.source_id}:${d.lm_device_id}`) || 0);
      if (n) message += ` +${n} downstream shadowed`;
    }
    issues.push({ severity, type: 'device-dead', source: srcName.get(d.source_id), target, message });
  }

  // device-in-sdt
  for (const d of db.prepare("SELECT source_id, display_name, name, sdt_status FROM lm_devices WHERE stale = 0 AND sdt_status IS NOT NULL AND sdt_status != '' AND sdt_status != 'none-none-none'").all()) {
    if (!hasSdt(d.sdt_status)) continue;
    const target = d.display_name || d.name;
    issues.push({ severity: 'info', type: 'device-in-sdt', source: srcName.get(d.source_id), target,
      message: `${target} is in scheduled downtime (${d.sdt_status})` });
  }

  // Interface trend rules over history.
  const dayAgo = new Date(nowMs - 86400000).toISOString().replace('T', ' ').slice(0, 19);
  const hist = db.prepare(`
    SELECT h.source_id, h.instance_id, h.captured_at, h.status, h.in_errors, h.out_errors, h.in_util_pct, h.out_util_pct
    FROM lm_interface_history h
    JOIN lm_interfaces i ON i.source_id = h.source_id AND i.instance_id = h.instance_id
    WHERE h.captured_at >= ? AND i.stale = 0 AND COALESCE(i.stop_monitoring, 0) = 0
    ORDER BY h.source_id, h.instance_id, h.captured_at DESC, h.id DESC
  `).all(dayAgo);
  const byInst = new Map();
  for (const r of hist) {
    const k = `${r.source_id}|${r.instance_id}`;
    if (!byInst.has(k)) byInst.set(k, []);
    byInst.get(k).push(r);
  }
  if (byInst.size) {
    const ifBaselines = new Map();
    try {
      for (const b of db.prepare('SELECT * FROM lm_interface_baseline WHERE hour_of_day = ?').all(new Date(nowMs).getUTCHours())) {
        ifBaselines.set(`${b.source_id}|${b.instance_id}`, b);
      }
    } catch { /* baselines not built yet */ }
    const ifInfo = db.prepare(`
      SELECT i.display_name, i.instance_name, d.display_name AS device_name, d.name AS device_alt
      FROM lm_interfaces i LEFT JOIN lm_devices d ON d.source_id = i.source_id AND d.lm_device_id = i.lm_device_id
      WHERE i.source_id = ? AND i.instance_id = ?
    `);
    for (const [k, rows] of byInst) {
      const [sid, iid] = k.split('|').map(Number);
      const info = ifInfo.get(sid, iid) || {};
      const target = `${info.device_name || info.device_alt || 'device'} ${info.display_name || info.instance_name || iid}`;
      const source = srcName.get(sid);
      const last3 = rows.slice(0, 3);
      const maxUtil = (r) => Math.max(r.in_util_pct ?? -1, r.out_util_pct ?? -1);
      if (last3.length === 3 && last3.every((r) => maxUtil(r) >= t.lm_if_util_warn_pct)) {
        issues.push({ severity: 'warning', type: 'interface-utilization-high', source, target,
          message: `${target} at ${Math.round(maxUtil(last3[0]))}% utilization for the last 3 samples (threshold ${t.lm_if_util_warn_pct}%)` });
      }
      // Baseline anomalies (hour of day median and MAD), only where the
      // static threshold has not already fired for this interface.
      const bl = ifBaselines.get(`${sid}|${iid}`);
      if (bl && last3.length === 3) {
        const meanOf = (fn) => last3.reduce((sum, r) => sum + fn(r), 0) / 3;
        const alreadyHigh = issues.some((x) => x.type === 'interface-utilization-high' && x.target === target && x.source === source);
        const mu = meanOf((r) => Math.max(r.in_util_pct ?? 0, r.out_util_pct ?? 0));
        if (!alreadyHigh && bl.util_median != null
          && mu > bl.util_median + t.lm_if_anomaly_k * Math.max(bl.util_mad || 0, 2) && mu > t.lm_if_anomaly_util_min_pct) {
          issues.push({ severity: 'warning', type: 'interface-util-anomaly', source, target,
            message: `${target} at ${Math.round(mu)}% utilization, baseline ${Math.round(bl.util_median)} +/- ${Math.round(bl.util_mad || 0)}% for this hour` });
        }
        const me = meanOf((r) => (r.in_errors || 0) + (r.out_errors || 0));
        if (bl.err_median != null
          && me > bl.err_median + t.lm_if_anomaly_k * Math.max(bl.err_mad || 0, 1) && me > t.lm_if_anomaly_err_min) {
          issues.push({ severity: 'warning', type: 'interface-error-anomaly', source, target,
            message: `${target} logging ${Math.round(me)} errors per sample, baseline ${Math.round(bl.err_median)} +/- ${Math.round(bl.err_mad || 0)} for this hour` });
        }
      }
      const errs = (r) => (r.in_errors || 0) + (r.out_errors || 0);
      const errSum = rows.reduce((s, r) => s + errs(r), 0);
      if (errSum > t.lm_if_err_warn && last3.length === 3 && last3.every((r) => errs(r) > 0)) {
        issues.push({ severity: 'warning', type: 'interface-errors-growing', source, target,
          message: `${target} logged ${Math.round(errSum)} errors in 24 h and is still erroring` });
      }
      let flaps = 0;
      let prev = null;
      for (const r of [...rows].reverse()) {
        if (r.status == null) continue;
        if (prev != null && r.status !== prev) flaps += 1;
        prev = r.status;
      }
      if (flaps >= t.lm_if_flap_warn) {
        issues.push({ severity: 'warning', type: 'interface-flapping', source, target,
          message: `${target} changed status ${flaps} times in 24 h` });
      }
    }
  }

  // circuit-saturated (WAN circuits, round 3).
  try {
    for (const c of lmPath.circuitRows(db, { nowMs })) {
      if (c.satState === 'ok') continue;
      const target = `${c.deviceName} ${c.port}`;
      const peak = Math.max(c.p95InPct ?? 0, c.p95OutPct ?? 0);
      issues.push({ severity: c.satState === 'critical' ? 'critical' : 'warning', type: 'circuit-saturated', source: srcName.get(c.sourceId), target,
        message: `WAN circuit ${target}${c.label ? ` (${c.label})` : ''} p95 ${Math.round(peak)}% over ${t.lm_circuit_sat_days} days${c.satState === 'critical' ? `, daily peak at or above ${t.lm_circuit_crit_pct}% for ${c.critDays} days running` : ''}${c.maxDailyPct != null ? ` (highest daily peak ${Math.round(c.maxDailyPct)}%)` : ''}` });
    }
  } catch { /* circuit metrics unavailable */ }

  // alert-storm
  const stormSince = Math.floor(nowMs / 1000) - 900;
  for (const r of db.prepare('SELECT source_id, COUNT(*) n FROM lm_alerts WHERE start_epoch >= ? GROUP BY source_id').all(stormSince)) {
    if (r.n > t.lm_alert_storm_count) {
      const source = srcName.get(r.source_id);
      issues.push({ severity: 'info', type: 'alert-storm', source, target: source,
        message: `${r.n} LogicMonitor alerts opened on ${source} in the last 15 minutes` });
    }
  }

  // Check rules (site reachability).
  try {
    issues.push(...checks.evaluateAnomalies(db, { nowMs }));
  } catch { /* a check evaluation fault must not hide the other issues */ }

  // device-new, with the bootstrap guard: a portal whose first successful
  // poll is younger than the window would flag its whole inventory.
  if (t.lm_new_device_days > 0) {
    const windowMs = t.lm_new_device_days * 86400000;
    const cutoff = new Date(nowMs - windowMs).toISOString().replace('T', ' ').slice(0, 19);
    for (const s of sources) {
      const first = db.prepare('SELECT MIN(captured_at) t FROM lm_metrics_history WHERE source_id = ?').get(s.id)?.t;
      if (!first || first > cutoff) continue;
      for (const d of db.prepare('SELECT display_name, name, role, first_seen FROM lm_devices WHERE source_id = ? AND stale = 0 AND first_seen >= ?').all(s.id, cutoff)) {
        const target = d.display_name || d.name;
        issues.push({ severity: 'info', type: 'device-new', source: s.name, target,
          message: `${target}${d.role && d.role !== 'other' ? ` (${d.role})` : ''} was added to LogicMonitor on ${String(d.first_seen).slice(0, 10)}` });
      }
    }
  }

  const order = { critical: 0, warning: 1, info: 2 };
  return issues.sort((a, b) => order[a.severity] - order[b.severity]);
}

const issueKey = (i) => `${i.type}|${i.source}|${i.target}`;

// Check issues that carry a "Likely hop" tail (logicmonitorChecks). Each open
// one records its blamed hop once per (issue, hop) in lm_blame_history for the
// Correlation page; the blame is recomputed here because the issue object only
// holds the text.
const CHECK_BLAME_TYPES = new Set(['check-down', 'check-location-down', 'latency-anomaly', 'packet-loss-anomaly']);
function recordCheckBlames(current) {
  try {
    const cands = [...current.values()].filter((i) => CHECK_BLAME_TYPES.has(i.type) && /Likely hop:/.test(String(i.message || '')));
    if (!cands.length) return;
    const corr = require('./logicmonitorCorrelation');
    const ctx = lmPath.makeContext(db);
    const srcByName = new Map(db.prepare('SELECT id, name FROM lm_sources').all().map((s) => [s.name, s.id]));
    const openStmt = db.prepare("SELECT first_seen FROM lm_issue_history WHERE issue_key = ? AND status = 'open' ORDER BY id DESC LIMIT 1");
    const checkStmt = db.prepare('SELECT check_id FROM lm_checks WHERE source_id = ? AND name = ? AND stale = 0 LIMIT 1');
    const labelStmt = db.prepare('SELECT checkpoint_id FROM lm_check_locations WHERE source_id = ? AND check_id = ? AND label = ? AND stale = 0 LIMIT 1');
    const overallStmt = db.prepare('SELECT checkpoint_id FROM lm_check_locations WHERE source_id = ? AND check_id = ? AND stale = 0 ORDER BY is_overall DESC LIMIT 1');
    for (const i of cands) {
      const sid = srcByName.get(i.source);
      if (sid == null) continue;
      const at = i.type === 'check-down' ? -1 : String(i.target).lastIndexOf(' @ ');
      const checkName = at >= 0 ? String(i.target).slice(0, at) : String(i.target);
      const label = at >= 0 ? String(i.target).slice(at + 3) : null;
      const check = checkStmt.get(sid, checkName);
      if (!check) continue;
      const cp = label != null ? labelStmt.get(sid, check.check_id, label) : overallStmt.get(sid, check.check_id);
      const blame = lmPath.blameForCheck(db, check.check_id, cp ? cp.checkpoint_id : null, { ctx, sourceId: sid });
      if (!blame) continue;
      const open = openStmt.get(issueKey(i));
      corr.recordBlame(db, {
        sourceId: sid, kind: 'check', subject: checkName, subjectKey: check.check_id, checkpointLabel: label,
        blame, siteKey: blame.siteKey || null, issueKey: issueKey(i), dedupeSince: open ? open.first_seen : null,
      });
    }
  } catch { /* blame history is best effort */ }
}

const reconcileIssueHistoryTxn = db.transaction(() => {
  const current = new Map(computeIssues().map((i) => [issueKey(i), i]));
  const open = db.prepare("SELECT * FROM lm_issue_history WHERE status = 'open'").all();

  const touch = db.prepare(`
    UPDATE lm_issue_history SET last_seen = datetime('now'), message = ?, severity = ? WHERE id = ?
  `);
  const resolve = db.prepare(`
    UPDATE lm_issue_history SET status = 'resolved', resolved_at = datetime('now'), last_seen = datetime('now') WHERE id = ?
  `);
  const insert = db.prepare(`
    INSERT INTO lm_issue_history (issue_key, source, severity, type, target, message)
    VALUES (?, ?, ?, ?, ?, ?)
  `);

  const openKeys = new Set();
  for (const row of open) {
    const cur = current.get(row.issue_key);
    if (cur) {
      openKeys.add(row.issue_key);
      touch.run(cur.message, cur.severity, row.id);
    } else {
      resolve.run(row.id);
    }
  }
  for (const [key, i] of current) {
    if (!openKeys.has(key)) insert.run(key, i.source, i.severity, i.type, i.target, i.message);
  }
  recordCheckBlames(current);
  db.prepare("DELETE FROM lm_issue_history WHERE status = 'resolved' AND resolved_at < datetime('now', '-90 days')").run();
});

/** Open alerts shadowed under each culprit device: Map "source:device" -> count. */
function shadowedAlertCounts(dbh = db) {
  const out = new Map();
  try {
    for (const r of dbh.prepare(`
      SELECT source_id, json_extract(shadowed_by, '$.deviceId') AS culprit, COUNT(*) n
      FROM lm_alerts WHERE cleared = 0 AND shadowed_by IS NOT NULL AND json_valid(shadowed_by) GROUP BY source_id, culprit
    `).all()) if (r.culprit != null) out.set(`${r.source_id}:${r.culprit}`, r.n);
  } catch { /* column not migrated */ }
  return out;
}

/** An issue that computeIssues marked as a consequence of an upstream failure. */
const isShadowedIssue = (row) => !!(row && row.type === 'device-dead' && /\(shadowed by /.test(String(row.message || '')));

/**
 * Dependency suppression. For every open LM alert on a device D, when the
 * path above D (logicmonitorPath) holds a hop that is critical because the
 * device is dead or its facing port is down, store that hop in
 * lm_alerts.shadowed_by ({sourceId, deviceId, deviceName, port, reason}); the
 * flag is cleared as soon as the upstream recovers (recomputed every pass).
 * Respects lm_shadow_enabled. opts {sourceId, deviceId} narrows the pass to
 * one device (the webhook writer). Returns {shadowed, cleared, culprits}.
 */
function computeShadows(dbh = db, opts = {}) {
  const res = { shadowed: 0, cleared: 0, culprits: 0 };
  try {
    const scope = [];
    const args = [];
    if (opts.sourceId != null) { scope.push('source_id = ?'); args.push(opts.sourceId); }
    if (opts.deviceId != null) { scope.push('lm_device_id = ?'); args.push(opts.deviceId); }
    const scopeSql = scope.length ? ` AND ${scope.join(' AND ')}` : '';
    const enabled = getThreshold('lm_shadow_enabled') === 1;
    const clearStale = dbh.prepare(`UPDATE lm_alerts SET shadowed_by = NULL WHERE shadowed_by IS NOT NULL AND (cleared = 1${enabled ? '' : ' OR 1 = 1'})${scopeSql}`);
    res.cleared += clearStale.run(...args).changes;
    if (!enabled) return res;
    const rows = dbh.prepare(`SELECT id, source_id, lm_device_id, shadowed_by FROM lm_alerts WHERE cleared = 0 AND lm_device_id IS NOT NULL${scopeSql}`).all(...args);
    if (!rows.length) return res;
    const ctx = lmPath.makeContext(dbh);
    const causes = new Map();
    const upd = dbh.prepare('UPDATE lm_alerts SET shadowed_by = ? WHERE id = ?');
    const culprits = new Set();
    dbh.transaction(() => {
      for (const r of rows) {
        const k = `${r.source_id}:${r.lm_device_id}`;
        if (!causes.has(k)) causes.set(k, lmPath.shadowCause(dbh, ctx, r.source_id, r.lm_device_id));
        const c = causes.get(k);
        const next = c ? JSON.stringify({ deviceId: c.deviceId, deviceName: c.deviceName, port: c.port, reason: c.reason, sourceId: c.sourceId }) : null;
        if (c) { res.shadowed += 1; culprits.add(`${c.sourceId}:${c.deviceId}`); }
        if (next !== (r.shadowed_by || null)) {
          upd.run(next, r.id);
          if (!c) res.cleared += 1;
        }
      }
    })();
    res.culprits = culprits.size;
  } catch { /* suppression is best effort; alerts stay visible */ }
  return res;
}

// BEGIN IMMEDIATE, same rationale as unifiIssues.js. Shadows are recomputed
// first so the issue pass and collectAlerts read the same upstream picture.
const reconcileIssueHistory = () => {
  try { computeShadows(db); } catch { /* best effort */ }
  return reconcileIssueHistoryTxn.immediate();
};

module.exports = {
  THRESHOLD_DEFS, getThreshold, getThresholds, getTextSetting,
  compareBuild, isBehind,
  computeIssues, issueKey, reconcileIssueHistory,
  computeShadows, shadowedAlertCounts, isShadowedIssue,
};
