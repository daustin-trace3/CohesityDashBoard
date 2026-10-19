// Latency watch (round 9). A spike on a check location is not an incident
// until it proves itself: the first elevated sample opens an episode in state
// 'watching', which raises nothing. An episode is promoted to 'degrading'
// (a warning issue the Ops Agent sees) when it is sustained, trending up,
// severe on two samples in a row or joined by packet loss, and to 'critical'
// when the location is down or the severe condition holds. It closes after a
// run of normal samples and keeps its outcome (one-off, sustained, escalated)
// as history. Repeats of one-offs raise 'latency-pattern'; a baseline that has
// crept up against a frozen reference raises 'latency-drift'.
//
// Everything here is decided by ICC code over stored rows; no network, no
// model. The sample rule itself is lmChecks.classifySample, so the watch and
// the plain latency-anomaly issue can never disagree about what is elevated.
//
// Timestamps written here (opened_at, promoted_at, closed_at) are ISO strings
// with a zone, built in JS. Cutoffs are built in JS and bound, never
// compared with datetime('now') in SQL.
//
// IP SLA (subject_kind 'ipsla', round 9 WP7): the subject iteration, sample
// series and baseline lookups live in logicmonitorWatchIpsla.js, which feeds
// the same applySample state machine exported from here. evaluateWatch calls
// it at the end of a full (not 'only') pass through a guarded require.
const { pruneInBatches } = require('../core/dbPrune');
const lmChecks = require('./logicmonitorChecks');

const { median } = lmChecks;

const isoOf = (epoch) => new Date(epoch * 1000).toISOString();
const epochOf = (iso) => {
  const ms = Date.parse(iso);
  return Number.isFinite(ms) ? Math.floor(ms / 1000) : null;
};
const nowSec = () => Math.floor(Date.now() / 1000);
const round = (v, d = 0) => (v == null || !Number.isFinite(Number(v)) ? null : Number(Number(v).toFixed(d)));
const parseJson = (s, fallback) => {
  if (s == null || s === '') return fallback;
  try { const v = JSON.parse(s); return v == null ? fallback : v; } catch { return fallback; }
};

const STALE_WATCH_SECONDS = 6 * 3600;
const TREND_CAP = 12;
const TREND_WINDOW_SECONDS = 600;
const SCAN_BACK_SECONDS = 1800;
const SAMPLE_FETCH = 40;
const DRIFT_MIN_HOURS = 16;

const typeFor = (kind) => (kind === 'loss' ? 'loss-degrading' : 'latency-degrading');

/**
 * Issue target of an episode. Check subjects keep their label ("<check> @ <location>");
 * IP SLA subjects are labelled "<device> <instance> (<probe type>)" and the issue
 * target drops the probe type so the first token stays the device (the Ops Agent host key).
 */
const targetOf = (ep) => (ep.subject_kind === 'ipsla' ? String(ep.subject_label || '').replace(/\s+\([^()]*\)$/, '') : ep.subject_label);

/** Last `windows` values strictly increasing. */
function isRising(trend, windows) {
  if (!Array.isArray(trend) || trend.length < windows) return false;
  const tail = trend.slice(-windows);
  for (let i = 1; i < tail.length; i += 1) if (!(tail[i] > tail[i - 1])) return false;
  return true;
}

// -- Persistence ---------------------------------------------------------------

function loadEpisode(row) {
  const ep = { ...row };
  ep.trend = parseJson(row.trend_json, []);
  if (!Array.isArray(ep.trend)) ep.trend = [];
  return ep;
}

function saveEpisode(dbh, ep) {
  dbh.prepare(`
    UPDATE lm_latency_episodes SET kind = ?, state = ?, outcome = ?, promoted_at = ?, closed_at = ?, last_sample_epoch = ?,
      samples = ?, elevated_samples = ?, consecutive_normal = ?, peak_ms = ?, peak_ratio = ?, loss_max_pct = ?,
      area_over_baseline = ?, likely_hop = ?, likely_hop_device_id = ?, issue_key = ?, trend_json = ?, run_start_epoch = ?,
      severe_run = ?, severe_since_epoch = ?, promote_reason = ?, last_elevated_epoch = ?
    WHERE id = ?
  `).run(ep.kind, ep.state, ep.outcome || null, ep.promoted_at || null, ep.closed_at || null, ep.last_sample_epoch,
    ep.samples, ep.elevated_samples, ep.consecutive_normal, ep.peak_ms, ep.peak_ratio, ep.loss_max_pct,
    ep.area_over_baseline, ep.likely_hop || null, ep.likely_hop_device_id == null ? null : ep.likely_hop_device_id,
    ep.issue_key || null, JSON.stringify(ep.trend), ep.run_start_epoch == null ? null : ep.run_start_epoch,
    ep.severe_run || 0, ep.severe_since_epoch == null ? null : ep.severe_since_epoch, ep.promote_reason || null,
    ep.last_elevated_epoch == null ? null : ep.last_elevated_epoch, ep.id);
}

function closeEpisode(ep, atEpoch) {
  ep.outcome = ep.promoted_at == null ? 'one-off' : (ep.state === 'critical' ? 'escalated' : 'sustained');
  ep.state = 'closed';
  ep.closed_at = isoOf(atEpoch);
}

// -- Engine --------------------------------------------------------------------

/** "<device> <port>, <reason>" for the blamed hop of a check location, or null. */
function hopFor(dbh, state, checkId, checkpointId, sourceId) {
  try {
    const lmPath = require('./logicmonitorPath');
    state.ctx = state.ctx || lmPath.makeContext(dbh);
    const b = lmPath.blameForCheck(dbh, checkId, checkpointId, { ctx: state.ctx, sourceId });
    if (!b) return null;
    return { text: `${b.deviceName}${b.port ? ` ${b.port}` : ''}, ${b.reason || b.state}`, deviceId: b.deviceId == null ? null : b.deviceId };
  } catch { return null; }
}

/**
 * One sample applied to one open episode. Returns 'promoted' | 'closed' | null
 * for the counters; the episode object is mutated in place.
 */
function applySample(ep, s, cls, down, t, series, hopLater) {
  const e = s.sample_epoch;
  let event = null;
  ep.samples += 1;
  ep.last_sample_epoch = e;
  const elevated = cls.level !== 'normal';
  if (elevated) {
    ep.consecutive_normal = 0;
    ep.elevated_samples += 1;
    ep.last_elevated_epoch = e;
    if (ep.run_start_epoch == null) ep.run_start_epoch = e;
    if (cls.level === 'severe') {
      ep.severe_run = (ep.severe_run || 0) + 1;
      if (ep.severe_since_epoch == null) ep.severe_since_epoch = e;
    } else { ep.severe_run = 0; ep.severe_since_epoch = null; }
    if (cls.meanRtt != null) ep.peak_ms = Math.max(ep.peak_ms == null ? 0 : ep.peak_ms, cls.meanRtt);
    if (cls.ratio != null) ep.peak_ratio = Math.max(ep.peak_ratio == null ? 0 : ep.peak_ratio, cls.ratio);
    if (cls.meanLoss != null) ep.loss_max_pct = Math.max(ep.loss_max_pct == null ? 0 : ep.loss_max_pct, cls.meanLoss);
    if (cls.meanRtt != null && ep.baseline_median != null && cls.meanRtt > ep.baseline_median) {
      ep.area_over_baseline = (ep.area_over_baseline || 0) + (cls.meanRtt - ep.baseline_median);
    }
  } else if (down) {
    ep.consecutive_normal = 0;
  } else {
    ep.consecutive_normal += 1;
    ep.run_start_epoch = null;
    ep.severe_run = 0;
    ep.severe_since_epoch = null;
  }

  // Rolling window median of the last 10 minutes of samples.
  const win = series.filter((r) => r.sample_epoch > e - TREND_WINDOW_SECONDS && r.sample_epoch <= e && r.rtt_avg_ms != null).map((r) => r.rtt_avg_ms);
  const wm = median(win);
  if (wm != null) {
    ep.trend.push(round(wm, 2));
    if (ep.trend.length > TREND_CAP) ep.trend = ep.trend.slice(-TREND_CAP);
  }

  if (ep.state === 'watching' && (elevated || down)) {
    const runMin = ep.run_start_epoch != null ? (e - ep.run_start_epoch) / 60 : 0;
    let reason = null;
    if (down) reason = 'location down';
    else if (runMin >= t.lm_watch_sustain_minutes) reason = `elevated for ${Math.round(runMin)} min`;
    else if (ep.kind === 'latency' && isRising(ep.trend, t.lm_watch_trend_windows)) reason = `rising over ${t.lm_watch_trend_windows} windows`;
    else if ((ep.kind === 'latency' && cls.loss) || (ep.kind === 'loss' && cls.latency) || (cls.loss && cls.latency)) reason = 'packet loss with latency';
    else if ((ep.severe_run || 0) >= 2) reason = `${round(cls.ratio, 1)}x baseline on two samples`;
    if (reason) {
      ep.state = 'degrading';
      ep.promoted_at = isoOf(e);
      ep.promote_reason = reason;
      event = 'promoted';
      if (!ep.likely_hop && hopLater) {
        const h = hopLater();
        if (h) { ep.likely_hop = h.text; ep.likely_hop_device_id = h.deviceId; }
      }
    }
  }
  if (ep.state === 'degrading') {
    const severeMin = ep.severe_since_epoch != null ? (e - ep.severe_since_epoch) / 60 : 0;
    if (down) { ep.state = 'critical'; ep.promote_reason = 'location down'; event = 'promoted'; }
    else if (elevated && ep.severe_since_epoch != null && severeMin >= t.lm_watch_sustain_minutes) {
      ep.state = 'critical';
      ep.promote_reason = `severe for ${Math.round(severeMin)} min`;
      event = 'promoted';
    }
  }
  if (ep.consecutive_normal >= t.lm_watch_clear_samples) {
    closeEpisode(ep, e);
    event = 'closed';
  }
  return event;
}

/**
 * Drive the episode state machine for every non-stale check location of one
 * source. t is the full threshold set (logicmonitorIssues.getThresholds()).
 * opts.only {checkId, checkpointId} limits the pass to one location (the demo
 * seed replays history one location at a time). Returns {opened, promoted, closed}.
 */
function evaluateWatch(dbh, source, t, nowEpoch = nowSec(), opts = {}) {
  const counts = { opened: 0, promoted: 0, closed: 0 };
  const sourceId = source.id;
  const only = opts.only || null;
  const onlyKey = only ? `check:${only.checkId}:${only.checkpointId}` : null;
  const locs = dbh.prepare(`
    SELECT l.check_id, l.checkpoint_id, l.label, l.site_key AS loc_site, c.name AS check_name, c.site_key AS check_site
    FROM lm_check_locations l
    JOIN lm_checks c ON c.source_id = l.source_id AND c.check_id = l.check_id
    WHERE l.source_id = ? AND l.stale = 0 AND c.stale = 0 AND l.is_overall = 0 AND COALESCE(c.stop_monitoring, 0) = 0
  `).all(sourceId).filter((l) => !only || (String(l.check_id) === String(only.checkId) && String(l.checkpoint_id) === String(only.checkpointId)));

  const open = new Map();
  for (const r of dbh.prepare("SELECT * FROM lm_latency_episodes WHERE source_id = ? AND subject_kind = 'check' AND state != 'closed'").all(sourceId)) {
    if (onlyKey && r.subject_key !== onlyKey) continue;
    open.set(r.subject_key, loadEpisode(r));
  }
  const lastEpoch = new Map(dbh.prepare("SELECT subject_key, MAX(last_sample_epoch) AS e FROM lm_latency_episodes WHERE source_id = ? AND subject_kind = 'check' GROUP BY subject_key")
    .all(sourceId).filter((r) => !onlyKey || r.subject_key === onlyKey).map((r) => [r.subject_key, r.e]));
  const baselines = new Map();
  const baseRows = only
    ? dbh.prepare('SELECT * FROM lm_check_baseline WHERE source_id = ? AND check_id = ? AND checkpoint_id = ?').all(sourceId, String(only.checkId), String(only.checkpointId))
    : dbh.prepare('SELECT * FROM lm_check_baseline WHERE source_id = ?').all(sourceId);
  for (const b of baseRows) {
    const k = `${b.check_id}\u0000${b.checkpoint_id}`;
    if (!baselines.has(k)) baselines.set(k, new Map());
    baselines.get(k).set(b.hour_of_day, b);
  }
  const histStmt = dbh.prepare(`
    SELECT sample_epoch, status, rtt_avg_ms, loss_pct FROM lm_check_history
    WHERE source_id = ? AND check_id = ? AND checkpoint_id = ? AND sample_epoch IS NOT NULL AND sample_epoch <= ?
    ORDER BY sample_epoch DESC LIMIT ${SAMPLE_FETCH}
  `);
  const insStmt = dbh.prepare(`
    INSERT INTO lm_latency_episodes (source_id, subject_kind, check_id, checkpoint_id, subject_key, subject_label, site_key, kind, state,
      opened_at, last_sample_epoch, samples, elevated_samples, consecutive_normal, baseline_median, baseline_mad, baseline_samples,
      peak_ms, peak_ratio, loss_max_pct, area_over_baseline, likely_hop, likely_hop_device_id, trend_json, run_start_epoch,
      severe_run, severe_since_epoch, last_elevated_epoch)
    VALUES (?, 'check', ?, ?, ?, ?, ?, ?, 'watching', ?, ?, 0, 0, 0, ?, ?, ?, NULL, NULL, NULL, 0, ?, ?, '[]', NULL, 0, NULL, NULL)
  `);
  const hopState = {};
  const seen = new Set();

  for (const l of locs) {
    const key = `check:${l.check_id}:${l.checkpoint_id}`;
    seen.add(key);
    const rowsDesc = histStmt.all(sourceId, l.check_id, l.checkpoint_id, nowEpoch);
    if (rowsDesc.length < 3) continue;
    const rows = rowsDesc.slice().reverse();
    let ep = open.get(key) || null;
    const cursor = ep ? (ep.last_sample_epoch || 0) : Math.max(lastEpoch.get(key) || 0, nowEpoch - SCAN_BACK_SECONDS);
    const bmap = baselines.get(`${l.check_id}\u0000${l.checkpoint_id}`);
    const label = `${l.check_name} @ ${l.label}`;
    const siteKey = l.loc_site || l.check_site || null;
    let dirty = false;
    for (let i = 2; i < rows.length; i += 1) {
      const s = rows[i];
      if (s.sample_epoch <= cursor) continue;
      const base = bmap ? bmap.get(new Date(s.sample_epoch * 1000).getUTCHours()) : null;
      const down = s.status === 'down';
      const cls = down
        ? { level: 'normal', kind: null, latency: false, loss: false, severity: null, meanRtt: null, meanLoss: null, ratio: null }
        : lmChecks.classifySample([rows[i], rows[i - 1], rows[i - 2]], base, t);
      if (!ep) {
        if (cls.level === 'normal') continue;
        const hop = hopFor(dbh, hopState, l.check_id, l.checkpoint_id, sourceId);
        const res = insStmt.run(sourceId, l.check_id, l.checkpoint_id, key, label, siteKey, cls.kind || 'latency', isoOf(s.sample_epoch),
          s.sample_epoch, base.rtt_median, base.rtt_mad, base.samples, hop ? hop.text : null, hop ? hop.deviceId : null);
        ep = loadEpisode(dbh.prepare('SELECT * FROM lm_latency_episodes WHERE id = ?').get(res.lastInsertRowid));
        ep.issue_key = null;
        counts.opened += 1;
        dirty = true;
      }
      const series = rows.slice(0, i + 1);
      const ev = applySample(ep, s, cls, down, t, series, () => hopFor(dbh, hopState, l.check_id, l.checkpoint_id, sourceId));
      dirty = true;
      if (ev === 'promoted') {
        counts.promoted += 1;
        ep.issue_key = null; // set below once the issue source name is known
      }
      if (ep.state === 'degrading' || ep.state === 'critical') ep.issue_key = `${typeFor(ep.kind)}|${source.name}|${label}`;
      if (ev === 'closed') {
        counts.closed += 1;
        saveEpisode(dbh, ep);
        open.delete(key);
        ep = null;
        dirty = false;
      }
    }
    if (ep && dirty) { saveEpisode(dbh, ep); open.set(key, ep); }
  }

  // Stale guard: a watching episode that has not moved for 6 hours closes as a
  // one-off; an open episode whose location left the inventory closes with the
  // outcome its state earned.
  for (const [key, ep] of open) {
    const gone = !seen.has(key);
    const frozen = ep.state === 'watching' && (ep.last_sample_epoch || 0) < nowEpoch - STALE_WATCH_SECONDS;
    if (!gone && !frozen) continue;
    closeEpisode(ep, nowEpoch);
    saveEpisode(dbh, ep);
    counts.closed += 1;
  }
  // IP SLA subjects (WP7). Skipped for a single-location replay (opts.only).
  if (!only) {
    try {
      const r = require('./logicmonitorWatchIpsla').evaluateIpsla(dbh, source, t, nowEpoch);
      counts.opened += r.opened; counts.promoted += r.promoted; counts.closed += r.closed;
    } catch (err) {
      if (err && err.code !== 'MODULE_NOT_FOUND') {
        counts.ipslaError = err.message;
        try { require('../utils/logger').warn(`[LmWatch] IP SLA pass failed for source ${source && source.id}: ${err.message}`); } catch { /* no logger */ }
      }
    }
  }
  return counts;
}

// -- Issues ----------------------------------------------------------------------

const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;

/** Episode length in whole minutes, at least 1. */
function episodeMinutes(ep, endEpoch) {
  const start = epochOf(ep.opened_at);
  if (start == null || endEpoch == null) return 1;
  return Math.max(1, Math.round((endEpoch - start) / 60));
}

function degradingMessage(ep) {
  const last = ep.trend.length ? ep.trend[ep.trend.length - 1] : ep.peak_ms;
  const minutes = episodeMinutes(ep, ep.last_sample_epoch);
  const hop = ep.likely_hop ? ` Likely hop: ${ep.likely_hop}` : '';
  const why = ep.promote_reason || (ep.state === 'critical' ? 'critical' : 'sustained');
  if (ep.kind === 'loss') {
    return `Packet loss up to ${round(ep.loss_max_pct, 1)}% for ${minutes} min, ${why}.${hop}`;
  }
  const ratio = last != null && ep.baseline_median > 0 ? ` (${round(last / ep.baseline_median, 1)}x)` : '';
  return `RTT ${round(last)} ms against a ${round(ep.baseline_median)} ms baseline for ${minutes} min${ratio}, ${why}.${hop}`;
}

function hopName(text) {
  const m = /^[^\s,]+/.exec(String(text || ''));
  return m ? m[0] : null;
}

/**
 * Issue rows for computeIssues. srcName is a Map of source id to source name.
 * Open degrading and critical episodes become latency-degrading (or
 * loss-degrading); closed one-offs that repeat become latency-pattern; a
 * baseline that has risen against the frozen reference becomes latency-drift.
 */
function computeWatchIssues(dbh, t, srcName) {
  const issues = [];
  const nameOf = (id) => (srcName && srcName.get ? srcName.get(id) : null) || String(id);

  const openRows = dbh.prepare("SELECT * FROM lm_latency_episodes WHERE state IN ('degrading', 'critical')").all();
  const openSubjects = new Set();
  for (const r of openRows) {
    const ep = loadEpisode(r);
    openSubjects.add(`${ep.source_id}|${ep.subject_key}`);
    issues.push({
      severity: ep.state === 'critical' ? 'critical' : 'warning', type: typeFor(ep.kind), source: nameOf(ep.source_id),
      target: targetOf(ep), message: degradingMessage(ep),
    });
  }

  // Repeating one-offs (latency episodes only: a loss-kind pattern has no issue type in this round).
  const cutoff = isoOf(nowSec() - t.lm_watch_repeat_days * 86400);
  const closed = dbh.prepare(`
    SELECT * FROM lm_latency_episodes WHERE state = 'closed' AND outcome = 'one-off' AND kind = 'latency' AND opened_at >= ? ORDER BY opened_at
  `).all(cutoff);
  const bySubject = new Map();
  for (const r of closed) {
    const k = `${r.source_id}|${r.subject_key}`;
    if (!bySubject.has(k)) bySubject.set(k, []);
    bySubject.get(k).push(r);
  }
  for (const [k, list] of bySubject) {
    if (list.length < t.lm_watch_repeat_min || openSubjects.has(k)) continue;
    const mins = list.map((r) => {
      const end = r.last_elevated_epoch != null ? r.last_elevated_epoch : r.last_sample_epoch;
      return episodeMinutes(r, end);
    });
    const ratios = list.map((r) => r.peak_ratio).filter((v) => v != null);
    const firstOpen = epochOf(list[0].opened_at);
    const spanDays = Math.max(1, Math.ceil((nowSec() - (firstOpen == null ? nowSec() : firstOpen)) / 86400));
    const hopCounts = new Map();
    for (const r of list) { const h = hopName(r.likely_hop); if (h) hopCounts.set(h, (hopCounts.get(h) || 0) + 1); }
    let topHop = null;
    for (const [h, n] of hopCounts) if (!topHop || n > topHop.n) topHop = { h, n };
    const range = (a, b, unit) => (a === b ? `${a}${unit}` : `${a}${unit} to ${b}${unit}`);
    const peaks = ratios.length ? `, peaks ${range(round(Math.min(...ratios), 1), round(Math.max(...ratios), 1), 'x')} baseline` : '';
    const hop = topHop ? `, likely hop ${topHop.h} in ${topHop.n} of ${list.length}` : '';
    issues.push({
      severity: 'warning', type: 'latency-pattern', source: nameOf(list[0].source_id), target: targetOf(list[0]),
      message: `${plural(list.length, 'spike')} in ${plural(spanDays, 'day')}, ${range(Math.min(...mins), Math.max(...mins), '')} min each${peaks}${hop}`,
    });
  }

  // Drift: live hour baselines against the frozen reference.
  try {
    const rows = dbh.prepare(`
      SELECT b.source_id, b.check_id, b.checkpoint_id, b.hour_of_day, b.rtt_median AS live, r.rtt_median AS ref
      FROM lm_check_baseline b
      JOIN lm_check_reference r ON r.source_id = b.source_id AND r.check_id = b.check_id AND r.checkpoint_id = b.checkpoint_id AND r.hour_of_day = b.hour_of_day
      WHERE b.rtt_median IS NOT NULL AND r.rtt_median IS NOT NULL AND r.rtt_median > 0
    `).all();
    const groups = new Map();
    for (const r of rows) {
      const k = `${r.source_id}\u0000${r.check_id}\u0000${r.checkpoint_id}`;
      if (!groups.has(k)) groups.set(k, { sourceId: r.source_id, checkId: r.check_id, checkpointId: r.checkpoint_id, hours: [] });
      groups.get(k).hours.push(r);
    }
    const labelStmt = dbh.prepare(`
      SELECT c.name AS check_name, l.label FROM lm_check_locations l
      JOIN lm_checks c ON c.source_id = l.source_id AND c.check_id = l.check_id
      WHERE l.source_id = ? AND l.check_id = ? AND l.checkpoint_id = ? AND l.stale = 0 AND c.stale = 0 AND l.is_overall = 0
    `);
    for (const g of groups.values()) {
      const up = g.hours.filter((h) => h.live > h.ref * (1 + t.lm_watch_drift_pct / 100));
      if (up.length < DRIFT_MIN_HOURS) continue;
      const loc = labelStmt.get(g.sourceId, g.checkId, g.checkpointId);
      if (!loc) continue;
      const pct = median(up.map((h) => (h.live / h.ref - 1) * 100));
      issues.push({
        severity: pct >= t.lm_watch_drift_crit_pct ? 'warning' : 'info', type: 'latency-drift', source: nameOf(g.sourceId),
        target: `${loc.check_name} @ ${loc.label}`,
        message: `Baseline RTT is up ${round(pct)}% against the ${t.lm_watch_reference_days}-day reference (${round(median(up.map((h) => h.ref)), 1)} ms to ${round(median(up.map((h) => h.live)), 1)} ms across ${up.length} hours)`,
      });
    }
  } catch { /* reference table not migrated */ }
  try { issues.push(...require('./logicmonitorWatchIpsla').computeIpslaDrift(dbh, t, srcName)); } catch { /* ipsla baselines not migrated */ }
  return issues;
}

// -- Reference -------------------------------------------------------------------

/**
 * Weekly frozen reference: median RTT and loss per check location and UTC
 * hour over the reference window, EXCLUDING the newest 7 days, so a slow
 * degradation inside the live baseline window cannot hide in it. Rewrites the
 * source's rows. Skipped (returns {skipped: true}) when the newest row is
 * younger than 6 days, unless opts.force. Returns {written}.
 */
function computeReference(dbh, sourceId, t, opts = {}) {
  const nowMs = opts.nowMs != null ? opts.nowMs : Date.now();
  if (!opts.force) {
    const newest = dbh.prepare('SELECT MAX(computed_at) AS c FROM lm_check_reference WHERE source_id = ?').get(sourceId);
    const at = newest && newest.c ? Date.parse(newest.c) : null;
    if (at != null && Number.isFinite(at) && nowMs - at < 6 * 86400000) return { skipped: true, written: 0 };
  }
  const nowS = Math.floor(nowMs / 1000);
  const to = nowS - 7 * 86400;
  const from = nowS - t.lm_watch_reference_days * 86400;
  const minSamples = t.lm_check_baseline_min_samples != null ? t.lm_check_baseline_min_samples : 24;
  const groups = new Map();
  const stmt = dbh.prepare(`
    SELECT check_id, checkpoint_id, sample_epoch, rtt_avg_ms, loss_pct FROM lm_check_history
    WHERE source_id = ? AND sample_epoch >= ? AND sample_epoch < ? AND rtt_avg_ms IS NOT NULL
  `);
  for (const r of stmt.iterate(sourceId, from, to)) {
    const hour = new Date(r.sample_epoch * 1000).getUTCHours();
    const k = `${r.check_id}\u0000${r.checkpoint_id}\u0000${hour}`;
    let g = groups.get(k);
    if (!g) { g = { checkId: r.check_id, checkpointId: r.checkpoint_id, hour, rtt: [], loss: [] }; groups.set(k, g); }
    g.rtt.push(r.rtt_avg_ms);
    g.loss.push(r.loss_pct);
  }
  const computedAt = new Date(nowMs).toISOString();
  let written = 0;
  dbh.transaction(() => {
    dbh.prepare('DELETE FROM lm_check_reference WHERE source_id = ?').run(sourceId);
    const ins = dbh.prepare(`
      INSERT INTO lm_check_reference (source_id, check_id, checkpoint_id, hour_of_day, samples, rtt_median, loss_median, computed_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `);
    for (const g of groups.values()) {
      if (g.rtt.length < minSamples) continue;
      ins.run(sourceId, g.checkId, g.checkpointId, g.hour, g.rtt.length, median(g.rtt), median(g.loss), computedAt);
      written += 1;
    }
  })();
  return { skipped: false, written };
}

// -- Plain-English reason for an episode state -----------------------------------------

const numText = (v, d = 1) => (v == null || !Number.isFinite(Number(v)) ? null : String(Number(Number(v).toFixed(d))));

/** Measurement lines shared by every state: peak, baseline and how many samples were elevated. */
function measureLines(ep) {
  const lines = [];
  const peak = numText(ep.peak_ms);
  const ratio = numText(ep.peak_ratio, 1);
  const base = numText(ep.baseline_median);
  if (ep.kind === 'loss') {
    lines.push(`Peak loss ${numText(ep.loss_max_pct) == null ? 'unknown' : `${numText(ep.loss_max_pct)}%`}`);
  } else if (peak != null) {
    const against = base != null && ratio != null ? `, ${ratio}x the baseline of ${base} ms (${ep.baseline_samples == null ? 'unknown' : ep.baseline_samples} samples)` : '';
    lines.push(`Peak ${peak} ms${against}`);
  } else {
    lines.push('No peak recorded yet');
  }
  if (ep.kind !== 'loss' && numText(ep.loss_max_pct) != null && Number(ep.loss_max_pct) > 0) lines.push(`Packet loss up to ${numText(ep.loss_max_pct)}%`);
  lines.push(`${ep.elevated_samples == null ? 0 : ep.elevated_samples} of ${ep.samples == null ? 0 : ep.samples} samples elevated since ${ep.opened_at || 'unknown'}`);
  return lines;
}

let whyCache = null;
/** Current watch thresholds for the `why` text; cached 30 s so list routes do not reread settings per row. */
function whyThresholds() {
  const now = Date.now();
  if (whyCache && now - whyCache.at < 30000) return whyCache.t;
  let t = {};
  try { t = require('./logicmonitorIssues').getThresholds(); } catch { /* defaults */ }
  whyCache = { at: now, t };
  return t;
}

/**
 * Why an episode is in its state, in plain words with the numbers. Pure.
 * ep is a lm_latency_episodes row (snake_case); t the threshold set (missing keys use the defaults).
 * Returns { headline, lines[] }; times stay ISO strings for the page to format.
 */
function episodeWhy(ep, t = {}) {
  const sustain = t.lm_watch_sustain_minutes != null ? t.lm_watch_sustain_minutes : 15;
  const trend = t.lm_watch_trend_windows != null ? t.lm_watch_trend_windows : 3;
  const severe = t.lm_watch_severe_ratio != null ? t.lm_watch_severe_ratio : 2;
  const clear = t.lm_watch_clear_samples != null ? t.lm_watch_clear_samples : 3;
  const kind = ep.kind === 'loss' ? 'packet loss' : 'latency';
  const lines = measureLines(ep);
  const closeRule = `Closes after ${clear} normal samples (${ep.consecutive_normal == null ? 0 : ep.consecutive_normal} so far)`;
  if (ep.state === 'watching') {
    lines.push(`Becomes degrading after ${sustain} min elevated, ${trend} rising windows, packet loss with latency, or two samples over ${severe}x the baseline`);
    return { headline: `Watching: ${kind} above baseline, not yet promoted`, lines };
  }
  if (ep.state === 'degrading') {
    lines.push(`Becomes critical when the location goes down or the severe condition (over ${severe}x the baseline, or critical loss) holds for ${sustain} min`);
    lines.push(closeRule);
    return { headline: `Degrading: ${ep.promote_reason || 'promoted'} (promoted ${ep.promoted_at || 'unknown'})`, lines };
  }
  if (ep.state === 'critical') {
    if (ep.likely_hop) lines.push(`Likely hop: ${ep.likely_hop}`);
    lines.push(closeRule);
    return { headline: `Critical: ${ep.promote_reason || 'promoted'} (promoted ${ep.promoted_at || 'unknown'})`, lines };
  }
  const meaning = {
    'one-off': 'One-off: it cleared without ever being promoted past watching.',
    sustained: 'Sustained: it reached degrading but never critical.',
    escalated: 'Escalated: it reached critical before it cleared.',
  }[ep.outcome];
  return { headline: `Closed ${ep.closed_at || 'unknown'}, outcome ${ep.outcome || 'unknown'}`, lines: [...(meaning ? [meaning] : []), ...lines.filter((l) => l.startsWith('Peak'))] };
}

// -- Summaries -----------------------------------------------------------------------

function episodeView(r, thresholds = null) {
  const openedEpoch = epochOf(r.opened_at);
  const end = r.state === 'closed'
    ? (r.last_elevated_epoch != null ? r.last_elevated_epoch : r.last_sample_epoch)
    : r.last_sample_epoch;
  return {
    id: r.id,
    sourceId: r.source_id,
    subjectKind: r.subject_kind,
    subjectKey: r.subject_key,
    checkId: r.check_id,
    checkpointId: r.checkpoint_id,
    subjectLabel: r.subject_label,
    siteKey: r.site_key,
    kind: r.kind,
    state: r.state,
    outcome: r.outcome,
    openedAt: r.opened_at,
    promotedAt: r.promoted_at,
    closedAt: r.closed_at,
    durationMin: openedEpoch != null && end != null ? Math.max(1, Math.round((end - openedEpoch) / 60)) : null,
    peakMs: round(r.peak_ms, 1),
    peakRatio: round(r.peak_ratio, 2),
    lossMaxPct: round(r.loss_max_pct, 1),
    baselineMedian: round(r.baseline_median, 1),
    likelyHop: r.likely_hop,
    promoteReason: r.promote_reason,
    why: episodeWhy(r, thresholds || whyThresholds()),
  };
}

/**
 * Episode history for a source, site, check or a list of host or check names.
 * opts {sourceId, siteKey, checkId, names, days (default 30), limit (10)}.
 * Returns {total, byOutcome:{oneOff,sustained,escalated}, byState:{watching,
 * degrading,critical,closed}, medianDurationMin, hops:[{hop,count}],
 * episodes[]} with the newest first. Never throws on a missing table.
 */
function episodeSummary(dbh, opts = {}) {
  const empty = { total: 0, byOutcome: { oneOff: 0, sustained: 0, escalated: 0 }, byState: { watching: 0, degrading: 0, critical: 0, closed: 0 }, medianDurationMin: null, hops: [], episodes: [] };
  try {
    const days = opts.days != null ? opts.days : 30;
    const where = ['(opened_at >= ? OR state != \'closed\')'];
    const args = [isoOf(nowSec() - days * 86400)];
    if (opts.sourceId != null) { where.push('source_id = ?'); args.push(opts.sourceId); }
    if (opts.siteKey) { where.push('site_key = ?'); args.push(opts.siteKey); }
    if (opts.checkId != null) { where.push('check_id = ?'); args.push(String(opts.checkId)); }
    const names = (opts.names || []).map((n) => String(n || '').trim().toLowerCase()).filter(Boolean);
    if (names.length) {
      where.push(`(${names.map(() => "lower(subject_label) = ? OR lower(subject_label) LIKE ? ESCAPE '\\' OR (subject_kind = 'ipsla' AND lower(subject_label) LIKE ? ESCAPE '\\')").join(' OR ')})`);
      for (const n of names) args.push(n, `${n.replace(/[\\%_]/g, '\\$&')} @ %`, `${n.replace(/[\\%_]/g, '\\$&')} %`);
    }
    const rows = dbh.prepare(`SELECT * FROM lm_latency_episodes WHERE ${where.join(' AND ')} ORDER BY opened_at DESC`).all(...args);
    if (!rows.length) return empty;
    const out = { ...empty, byOutcome: { ...empty.byOutcome }, byState: { ...empty.byState } };
    out.total = rows.length;
    const hopCounts = new Map();
    const durations = [];
    const views = rows.map((r) => episodeView(r));
    for (let i = 0; i < rows.length; i += 1) {
      const r = rows[i];
      out.byState[r.state] = (out.byState[r.state] || 0) + 1;
      if (r.outcome === 'one-off') out.byOutcome.oneOff += 1;
      else if (r.outcome === 'sustained') out.byOutcome.sustained += 1;
      else if (r.outcome === 'escalated') out.byOutcome.escalated += 1;
      if (views[i].durationMin != null) durations.push(views[i].durationMin);
      const h = hopName(r.likely_hop);
      if (h) hopCounts.set(h, (hopCounts.get(h) || 0) + 1);
    }
    out.medianDurationMin = durations.length ? round(median(durations), 0) : null;
    out.hops = [...hopCounts].map(([hop, count]) => ({ hop, count })).sort((a, b) => b.count - a.count).slice(0, 5);
    out.episodes = views.slice(0, opts.limit || 10);
    return out;
  } catch {
    return empty;
  }
}

const shortStamp = (iso) => String(iso || '').slice(0, 16).replace('T', ' ');

/**
 * Plain-text episode history for the Ops Agent (evidence block and the
 * lm_latency_watch capability). Matches check names first, then the site.
 * opts {names, siteKey, days (30), max (6)}. Returns {lines[], summary, scope}
 * where lines is empty when there is nothing to say.
 */
function watchLines(dbh, opts = {}) {
  const days = opts.days || 30;
  const max = opts.max || 6;
  let scope = null;
  let s = null;
  const names = (opts.names || []).filter(Boolean);
  if (names.length) {
    s = episodeSummary(dbh, { names, days, limit: max - 1 });
    if (s.total) scope = names[0];
  }
  if ((!s || !s.total) && opts.siteKey) {
    s = episodeSummary(dbh, { siteKey: opts.siteKey, days, limit: max - 1 });
    if (s.total) scope = `site ${opts.siteKey}`;
  }
  if (!s || !s.total) return { lines: [], summary: null, scope: null };
  const open = s.byState.watching + s.byState.degrading + s.byState.critical;
  const summary = `${plural(s.total, 'latency episode')} in ${days} days for ${scope}: ${s.byOutcome.oneOff} one-off, ${s.byOutcome.sustained} sustained, ${s.byOutcome.escalated} escalated${open ? `, ${open} open now` : ''}${s.medianDurationMin != null ? `; median length ${s.medianDurationMin} min` : ''}${s.hops.length ? `; most often blamed hop ${s.hops[0].hop} (${s.hops[0].count})` : ''}`;
  const lines = [`Episode history: ${summary}`];
  for (const e of s.episodes.slice(0, max - 1)) {
    lines.push(`Episode ${shortStamp(e.openedAt)} UTC ${e.subjectLabel}: ${e.closedAt ? (e.outcome || 'closed') : e.state}, ${e.durationMin == null ? '?' : e.durationMin} min${e.peakRatio != null ? `, peak ${e.peakRatio}x baseline` : ''}${e.likelyHop ? `, hop ${e.likelyHop}` : ''}`);
  }
  return { lines, summary, scope };
}

/** Closed episodes older than `days` days. Returns the number removed. */
function pruneEpisodes(dbh, days = 90) {
  const cutoff = isoOf(nowSec() - days * 86400);
  return pruneInBatches(dbh, 'lm_latency_episodes', "state = 'closed' AND closed_at < ?", [cutoff]).deleted;
}

module.exports = {
  evaluateWatch, computeWatchIssues, computeReference, episodeSummary, pruneEpisodes,
  episodeView, episodeWhy, isRising, typeFor, watchLines,
  // Shared with logicmonitorWatchIpsla.js (the per-sample state machine and its persistence).
  applySample, loadEpisode, saveEpisode, closeEpisode, targetOf, isoOf, epochOf, STALE_WATCH_SECONDS,
};
