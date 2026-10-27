'use strict';

// Ops Agent observations: sustained-signal episodes over metrics the pollers
// already store. An observer (small data-plus-functions object) samples one
// kind of subject; this engine keeps one episode per subject and runs the
// state machine
//
//   watching -> degrading -> critical -> closed
//
// driven by sample counts (the poll interval is the clock), the same shape as
// the LogicMonitor latency watch. A watching episode opens nothing (it
// shows only in the watch list); a degrading or critical
// one is handed to the agent as an ordinary item (collectItems) so it triages
// and emails like an alert.
// An episode that closes without ever being promoted is a one-off; enough
// one-offs on one subject inside the pattern window raise a pattern item.
//
// The engine knows nothing about vCenter. Built-ins load from a static list
// (the compiled build has no directory scan); packs add observers through
// manifest.agentObservers (registry.getAgentObserverProviders).

const db = require('../../db/database');
const logger = require('../../utils/logger');
const { pruneInBatches } = require('../../core/dbPrune');
const { getSetting, getObservationSettings } = require('../settings');

const SERIES_CAP = 48;
const STALE_MS = 6 * 3600000;
const OPEN_STATES = ['watching', 'degrading', 'critical'];

const BUILTIN_FILES = [
  () => require('./observers/vcenter'),
];

const builtins = new Map();
let builtinsLoaded = false;

const REQUIRED_FN = ['thresholds', 'sample'];

function validObserver(o) {
  return o && typeof o === 'object' && typeof o.id === 'string' && o.id && typeof o.platform === 'string'
    && typeof o.issueType === 'string' && REQUIRED_FN.every((f) => typeof o[f] === 'function');
}

function registerBuiltins() {
  if (builtinsLoaded) return builtins.size;
  builtinsLoaded = true;
  for (const load of BUILTIN_FILES) {
    try {
      for (const o of (load().observers || [])) {
        if (validObserver(o)) builtins.set(o.id, { ...o, source: 'builtin' });
      }
    } catch (err) { logger.error(`[Observations] built-in observer file failed to load: ${err.message}`); }
  }
  return builtins.size;
}

/** Every observer: built-ins plus whatever enabled packs declare right now. */
function allObservers() {
  registerBuiltins();
  const out = new Map(builtins);
  try {
    // Lazy: the registry is not needed until a pack could exist.
    const providers = require('../../core/registry').getAgentObserverProviders();
    for (const p of providers) {
      for (const raw of p.observers) {
        const id = String(raw && raw.id || '').startsWith(`${p.id}:`) ? raw.id : `${p.id}:${raw && raw.id}`;
        const o = { ...raw, id, source: p.id };
        if (validObserver(o)) out.set(id, o);
      }
    }
  } catch (err) { logger.warn(`[Observations] pack observers unavailable: ${err.message}`); }
  return out;
}

function getObserver(id) { return allObservers().get(id) || null; }

function listObservers(settings = getObservationSettings()) {
  const off = new Set(settings.disabledIds || []);
  return Array.from(allObservers().values()).map((o) => ({
    id: o.id, platform: o.platform, label: o.label || o.id, kind: o.kind || 'sustained', unit: o.unit || '',
    issueType: o.issueType, description: o.description || '', enabled: !off.has(o.id), source: o.source,
  }));
}

// ---------------------------------------------------------------------------
// helpers

const parseJson = (s, dflt) => { try { return s ? JSON.parse(s) : dflt; } catch { return dflt; } };
const ms = (iso) => { const t = Date.parse(iso); return Number.isFinite(t) ? t : null; };
const round1 = (n) => Math.round(n * 10) / 10;

function classify(value, t) {
  if (value >= t.crit) return 'severe';
  if (value >= t.warn) return 'elevated';
  return 'normal';
}

/** Minutes the condition has been up: open episodes count from the current
 *  elevated run (or the promotion), closed ones from open to the last
 *  elevated sample. */
function minutesOf(row) {
  const end = ms(row.last_sample_at);
  if (end == null) return 0;
  let start;
  if (row.state === 'closed') {
    const series = parseJson(row.series_json, []);
    const lastHot = [...series].reverse().find((p) => row.threshold_warn != null && p.v >= row.threshold_warn);
    const hotEnd = lastHot ? ms(lastHot.t) : null;
    start = ms(row.opened_at);
    if (hotEnd != null && start != null) return Math.max(0, Math.round((hotEnd - start) / 60000));
  } else {
    start = ms(row.elevated_run_start) ?? ms(row.promoted_at) ?? ms(row.opened_at);
  }
  return start == null ? 0 : Math.max(0, Math.round((end - start) / 60000));
}

const num = (v) => (v == null ? '?' : String(Math.round(v)));

/** The value of the sample that first crossed the line (the sample the row opened on). */
function openedValueOf(row) {
  const series = parseJson(row.series_json, []);
  const hit = series.find((p) => p.t === row.opened_at);
  const first = hit || series[0];
  return first && first.v != null ? first.v : null;
}

/** Default message for a promoted episode (contract section 4). */
function defaultMessage(o, row) {
  const ctx = parseJson(row.context_json, {});
  const unit = row.unit || '';
  const noun = o.noun || o.label || 'Subject';
  const metric = o.metric || '';
  const cap = typeof o.capacity === 'function' ? o.capacity(ctx) : null;
  const min = minutesOf(row);
  const head = `${noun} ${row.subject_label}${metric ? ` ${metric}` : ''} at ${num(row.last_value)}${unit}${cap ? ` of ${cap}` : ''}`;
  const crit = row.state === 'critical';
  const crossed = row.opened_at ? `, first over the line at ${num(openedValueOf(row))}${unit} on ${row.opened_at}` : '';
  const tail = `${crossed} (peak ${num(row.peak_value)}${unit}, warn ${num(row.threshold_warn)}${unit}, crit ${num(row.threshold_crit)}${unit})`;
  return crit ? `${head}, over the critical line for ${min} min${tail}` : `${head} for ${min} min${tail}`;
}

// ---------------------------------------------------------------------------
// state machine

function openRow(observer, s, t, nowIso) {
  const unit = observer.unit || '';
  const info = db.prepare(`
    INSERT INTO ops_observations (observer_id, platform, subject_key, subject_label, host, source_id, source_name, kind, state,
      unit, threshold_warn, threshold_crit, opened_at, samples, elevated_samples, consecutive_normal, severe_run,
      series_json, context_json, issue_key, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'watching', ?, ?, ?, ?, 0, 0, 0, 0, '[]', '{}', ?, ?)
  `).run(observer.id, observer.platform, s.subjectKey, s.label, s.host || s.label, s.sourceId ?? null, s.sourceName ?? null,
    observer.kind || 'sustained', unit, t.warn, t.crit, s.capturedAt, `obs:${observer.id}:${s.subjectKey}`, nowIso);
  return db.prepare('SELECT * FROM ops_observations WHERE id = ?').get(info.lastInsertRowid);
}

/**
 * Apply one new sample to an episode row (a plain object, mutated). Returns
 * 'promoted' | 'closed' | null.
 */
function applySample(ep, s, level, st) {
  const v = s.value;
  ep.samples += 1;
  ep.last_sample_at = s.capturedAt;
  ep.last_value = v;
  const series = parseJson(ep.series_json, []);
  series.push({ t: s.capturedAt, v });
  ep.series_json = JSON.stringify(series.slice(-SERIES_CAP));
  const elevated = level !== 'normal';
  if (elevated) {
    ep.consecutive_normal = 0;
    ep.elevated_samples += 1;
    if (!ep.elevated_run_start) ep.elevated_run_start = s.capturedAt;
    ep.severe_run = level === 'severe' ? ep.severe_run + 1 : 0;
    if (ep.peak_value == null || v > ep.peak_value) { ep.peak_value = v; ep.peak_at = s.capturedAt; }
  } else {
    ep.consecutive_normal += 1;
    ep.severe_run = 0;
    ep.elevated_run_start = null;
  }

  let event = null;
  const runMin = () => Math.round(((ms(s.capturedAt) - ms(ep.elevated_run_start)) / 60000));
  if (ep.state === 'watching' && elevated) {
    const runSamples = series.filter((p) => ms(p.t) >= ms(ep.elevated_run_start)).length;
    let reason = null;
    if (runSamples >= st.sustainSamples) reason = `elevated for ${runSamples} samples (${runMin()} min)`;
    else if (ep.severe_run >= 2) reason = 'over the critical line on two samples';
    if (reason) {
      ep.state = 'degrading';
      ep.promoted_at = s.capturedAt;
      ep.promote_reason = reason;
      event = 'promoted';
    }
  }
  if (ep.state === 'degrading' && ep.severe_run >= st.sustainSamples) {
    ep.state = 'critical';
    ep.promote_reason = `severe for ${ep.severe_run} samples (${runMin()} min)`;
    event = 'promoted';
  }
  if (ep.consecutive_normal >= st.clearSamples) {
    ep.outcome = !ep.promoted_at ? 'one-off' : (ep.state === 'critical' ? 'escalated' : 'sustained');
    ep.state = 'closed';
    ep.closed_at = s.capturedAt;
    event = 'closed';
  }
  return event;
}

const UPDATE_SQL = `
  UPDATE ops_observations SET state = ?, outcome = ?, unit = ?, threshold_warn = ?, threshold_crit = ?, promoted_at = ?,
    promote_reason = ?, closed_at = ?, last_sample_at = ?, samples = ?, elevated_samples = ?, consecutive_normal = ?,
    severe_run = ?, elevated_run_start = ?, last_value = ?, peak_value = ?, peak_at = ?, series_json = ?, context_json = ?,
    issue_key = ?, source_name = ?, updated_at = ?
  WHERE id = ?
`;

function saveRow(ep, nowIso) {
  db.prepare(UPDATE_SQL).run(ep.state, ep.outcome ?? null, ep.unit, ep.threshold_warn, ep.threshold_crit, ep.promoted_at ?? null,
    ep.promote_reason ?? null, ep.closed_at ?? null, ep.last_sample_at, ep.samples, ep.elevated_samples, ep.consecutive_normal,
    ep.severe_run, ep.elevated_run_start ?? null, ep.last_value, ep.peak_value ?? null, ep.peak_at ?? null, ep.series_json,
    ep.context_json, ep.issue_key ?? null, ep.source_name ?? null, nowIso, ep.id);
}

/**
 * Pure-ish state machine over ops_observations: feed it samples, it opens,
 * advances and closes episodes. Used by evaluate() and by the demo seed
 * replay. settings is the observations block of getOpsAgentSettings();
 * thresholds is { warn, crit }. A sample counts only when its capturedAt is
 * later than the episode's last_sample_at.
 */
function ingest(observer, samples, nowIso, settings, thresholds) {
  const st = {
    sustainSamples: settings.sustainSamples ?? 3,
    clearSamples: settings.clearSamples ?? 2,
  };
  const counts = { sampled: 0, opened: 0, promoted: 0, closed: 0 };
  const ordered = (samples || [])
    .filter((s) => s && s.subjectKey && Number.isFinite(Number(s.value)) && ms(s.capturedAt) != null)
    .map((s) => ({ ...s, value: round1(Number(s.value)) }))
    .sort((a, b) => ms(a.capturedAt) - ms(b.capturedAt));
  if (!ordered.length) return counts;

  db.transaction(() => {
    const findOpen = db.prepare("SELECT * FROM ops_observations WHERE observer_id = ? AND subject_key = ? AND state != 'closed' ORDER BY id DESC LIMIT 1");
    const lastClosed = db.prepare("SELECT MAX(closed_at) AS at FROM ops_observations WHERE observer_id = ? AND subject_key = ? AND state = 'closed'");
    for (const s of ordered) {
      let ep = findOpen.get(observer.id, s.subjectKey);
      const level = classify(s.value, thresholds);
      if (!ep) {
        if (level === 'normal') continue;
        // A sample at or before the last close belongs to the finished episode.
        const lc = lastClosed.get(observer.id, s.subjectKey).at;
        if (lc && ms(s.capturedAt) <= ms(lc)) continue;
        ep = openRow(observer, s, thresholds, nowIso);
        ep.elevated_run_start = null;
        counts.opened += 1;
      } else if (ep.last_sample_at && ms(s.capturedAt) <= ms(ep.last_sample_at)) {
        continue;
      }
      ep.unit = observer.unit || ep.unit;
      ep.threshold_warn = thresholds.warn;
      ep.threshold_crit = thresholds.crit;
      ep.source_name = s.sourceName ?? ep.source_name;
      ep.context_json = JSON.stringify({ ...parseJson(ep.context_json, {}), ...(s.context || {}) });
      counts.sampled += 1;
      const event = applySample(ep, s, level, st);
      if (event === 'promoted') {
        counts.promoted += 1;
        if (!ep.issue_key) ep.issue_key = `obs:${observer.id}:${ep.subject_key}`;
      }
      if (event === 'closed') counts.closed += 1;
      saveRow(ep, nowIso);
    }
  })();
  return counts;
}

/** Close episodes whose subject stopped being sampled. */
function closeStale(nowIso) {
  const cutoff = new Date(ms(nowIso) - STALE_MS).toISOString();
  const rows = db.prepare("SELECT id FROM ops_observations WHERE state != 'closed' AND COALESCE(last_sample_at, opened_at) < ?").all(cutoff);
  if (!rows.length) return 0;
  const upd = db.prepare("UPDATE ops_observations SET state = 'closed', outcome = 'stale', closed_at = ?, updated_at = ? WHERE id = ?");
  db.transaction(() => { for (const r of rows) upd.run(nowIso, nowIso, r.id); })();
  return rows.length;
}

/** One tick: sample every enabled observer and advance the episodes. */
function evaluate(nowIso, settings = getObservationSettings()) {
  const totals = { sampled: 0, opened: 0, promoted: 0, closed: 0, patterns: 0, stale: 0 };
  if (!settings.enabled) return totals;
  const off = new Set(settings.disabledIds || []);
  for (const o of allObservers().values()) {
    if (off.has(o.id)) continue;
    try {
      const c = ingest(o, o.sample(db), nowIso, settings, o.thresholds(getSetting));
      for (const k of ['sampled', 'opened', 'promoted', 'closed']) totals[k] += c[k];
    } catch (err) {
      logger.error(`[Observations] observer ${o.id} failed: ${err.message}`);
    }
  }
  totals.stale = closeStale(nowIso);
  totals.patterns = patternGroups(nowIso, settings).length;
  return totals;
}

// ---------------------------------------------------------------------------
// patterns

/** Subjects holding patternMin or more one-off episodes inside the window. */
function patternGroups(nowIso, settings) {
  const since = new Date(ms(nowIso) - (settings.patternDays ?? 7) * 86400000).toISOString();
  const rows = db.prepare("SELECT * FROM ops_observations WHERE state = 'closed' AND outcome = 'one-off' AND closed_at >= ? ORDER BY closed_at").all(since);
  const groups = new Map();
  for (const r of rows) {
    const k = `${r.observer_id}|${r.subject_key}`;
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k).push(r);
  }
  return Array.from(groups.values()).filter((g) => g.length >= (settings.patternMin ?? 3));
}

function patternMessage(o, group, settings) {
  const first = group[0];
  const unit = first.unit || '';
  const noun = o.noun || o.label || 'Subject';
  const metric = o.metric ? ` ${o.metric}` : '';
  const longest = Math.max(...group.map(minutesOf));
  const peak = Math.max(...group.map((r) => r.peak_value ?? 0));
  return `${noun} ${first.subject_label}${metric} ran hot in ${group.length} short bursts in the last ${settings.patternDays ?? 7} days (longest ${longest} min, peak ${num(peak)}${unit}); each cleared on its own.`;
}

// ---------------------------------------------------------------------------
// items for the agent

/** What an incident stores about the episode that opened it (ops_incident_alerts.detail_json). */
function observationDetail(row) {
  return {
    episodeId: row.id, value: row.last_value, peak: row.peak_value ?? null, peakAt: row.peak_at ?? null,
    openedAt: row.opened_at, openedValue: openedValueOf(row), elevatedRunStart: row.elevated_run_start ?? null,
    samples: row.samples, elevatedSamples: row.elevated_samples, warn: row.threshold_warn, crit: row.threshold_crit,
    unit: row.unit || '', promoteReason: row.promote_reason ?? null, promotedAt: row.promoted_at ?? null, state: row.state,
  };
}

function collectItems(nowIso, settings = getObservationSettings()) {
  if (!settings.enabled) return [];
  const obs = allObservers();
  const off = new Set(settings.disabledIds || []);
  const items = [];
  // A watching episode is context only: it opens nothing. Only a promoted
  // (degrading or critical) episode and a pattern group reach the agent.
  const open = db.prepare("SELECT * FROM ops_observations WHERE state IN ('degrading', 'critical') ORDER BY id").all();
  const backfill = db.prepare('UPDATE ops_observations SET issue_key = ? WHERE id = ?');
  for (const ep of open) {
    const o = obs.get(ep.observer_id);
    if (!o || off.has(o.id)) continue;
    if (!ep.issue_key) {
      ep.issue_key = `obs:${ep.observer_id}:${ep.subject_key}`;
      backfill.run(ep.issue_key, ep.id);
    }
    const unit = ep.unit || '';
    const peakNote = ep.peak_value != null && Math.round(ep.peak_value) !== Math.round(ep.last_value) ? ` (peak ${num(ep.peak_value)}${unit})` : '';
    const title = `${ep.subject_label}: ${o.label || o.id} ${num(ep.last_value)}${unit}${peakNote}`;
    const message = typeof o.message === 'function' ? o.message(ep, ep.state) : defaultMessage(o, ep);
    items.push({
      platform: ep.platform, sourceKey: ep.issue_key, severity: ep.state === 'critical' ? 'critical' : 'warning',
      host: ep.host, type: o.issueType, message: message || defaultMessage(o, ep), title,
      firstSeen: ep.promoted_at, lastSeen: nowIso, kind: 'observation', observationId: ep.id,
      observation: observationDetail(ep),
    });
  }
  for (const group of patternGroups(nowIso, settings)) {
    const first = group[0];
    const o = obs.get(first.observer_id);
    if (!o || off.has(o.id)) continue;
    const newest = group[group.length - 1];
    items.push({
      platform: first.platform, sourceKey: `obs-pattern:${first.observer_id}:${first.subject_key}`, severity: 'warning',
      host: first.host, type: `${o.issueType}-pattern`, message: patternMessage(o, group, settings),
      // The newest burst, so a pattern a person already resolved only returns
      // once a burst newer than the resolution exists (groupTick suppression).
      firstSeen: newest.closed_at, lastSeen: nowIso, kind: 'observation-pattern', observationId: null,
      groupKey: `pattern:${first.observer_id}:${first.subject_key}`,
      title: `${first.subject_label}: ${o.label || o.id} bursts (${group.length} in ${settings.patternDays ?? 7} days)`,
      pattern: {
        observerId: first.observer_id, subjectKey: first.subject_key, subjectLabel: first.subject_label, count: group.length,
        bursts: group.map((r) => ({ openedAt: r.opened_at, closedAt: r.closed_at, minutes: minutesOf(r), peak: r.peak_value ?? null, unit: r.unit || '' })),
      },
    });
  }
  return items;
}

// ---------------------------------------------------------------------------
// reads for evidence, routes and the prompt

/** Shape one row for the API, evidence and the modal. */
function describe(row, { seriesCap = 24, obs = null } = {}) {
  const o = (obs || allObservers()).get(row.observer_id);
  const series = parseJson(row.series_json, []);
  return {
    id: row.id, observerId: row.observer_id, label: o ? (o.label || o.id) : row.observer_id, platform: row.platform,
    subject: row.subject_label, subjectKey: row.subject_key, host: row.host, sourceName: row.source_name, kind: row.kind,
    state: row.state, outcome: row.outcome, unit: row.unit, value: row.last_value, peak: row.peak_value, peakAt: row.peak_at,
    thresholdWarn: row.threshold_warn, thresholdCrit: row.threshold_crit, openedAt: row.opened_at, promotedAt: row.promoted_at,
    promoteReason: row.promote_reason, closedAt: row.closed_at, lastSampleAt: row.last_sample_at, minutes: minutesOf(row),
    samples: row.samples, elevatedSamples: row.elevated_samples, series: seriesCap ? series.slice(-seriesCap) : series,
    context: parseJson(row.context_json, {}), incidentId: row.incident_id, issueKey: row.issue_key,
    openedValue: openedValueOf(row), elevatedRunStart: row.elevated_run_start ?? null,
  };
}

/** Open watching episodes, shaped like describe() with a 24 point series (status count, route, watch list). */
function watchingEpisodes({ obs = null } = {}) {
  const map = obs || allObservers();
  return db.prepare("SELECT * FROM ops_observations WHERE state = 'watching' ORDER BY id DESC").all()
    .map((r) => describe(r, { seriesCap: 24, obs: map }));
}

/**
 * Open episodes for an incident's evidence: every one whose issue_key is in
 * issueKeys (attached), plus every open one whose host matches one of hosts
 * (already normalised by the caller's hostKey). Attached first, capped.
 */
function openEpisodes({ hosts = [], issueKeys = [], hostKey = (h) => String(h || '').toLowerCase(), cap = 8 } = {}) {
  const keys = new Set(issueKeys);
  const hk = new Set(hosts);
  const rows = db.prepare("SELECT * FROM ops_observations WHERE state != 'closed' ORDER BY id").all();
  const out = [];
  for (const r of rows) {
    const attached = !!(r.issue_key && keys.has(r.issue_key));
    if (attached || (r.host && hk.has(hostKey(r.host)))) out.push({ row: r, attached });
  }
  out.sort((a, b) => Number(b.attached) - Number(a.attached));
  return out.slice(0, cap);
}

/** Closed episodes for a subject, newest first. */
function episodeHistory(subjectKey, days = 30) {
  const since = new Date(Date.now() - days * 86400000).toISOString();
  return db.prepare("SELECT * FROM ops_observations WHERE subject_key = ? AND state = 'closed' AND closed_at >= ? ORDER BY closed_at DESC").all(subjectKey, since);
}

function listEpisodes({ scope = 'active', limit = 200 } = {}) {
  const lim = Math.max(1, Math.min(1000, Number(limit) || 200));
  if (scope === 'closed') return db.prepare("SELECT * FROM ops_observations WHERE state = 'closed' ORDER BY closed_at DESC, id DESC LIMIT ?").all(lim);
  if (scope === 'all') return db.prepare('SELECT * FROM ops_observations ORDER BY id DESC LIMIT ?').all(lim);
  return db.prepare("SELECT * FROM ops_observations WHERE state != 'closed' ORDER BY CASE state WHEN 'critical' THEN 0 WHEN 'degrading' THEN 1 ELSE 2 END, id DESC LIMIT ?").all(lim);
}

function getEpisode(id) {
  return db.prepare('SELECT * FROM ops_observations WHERE id = ?').get(id) || null;
}

function prune(settings = getObservationSettings()) {
  const cutoff = new Date(Date.now() - (settings.historyDays ?? 90) * 86400000).toISOString();
  return pruneInBatches(db, 'ops_observations', "state = 'closed' AND closed_at < ?", [cutoff]);
}

module.exports = {
  registerBuiltins, listObservers, getObserver, evaluate, ingest, collectItems, openEpisodes, episodeHistory,
  listEpisodes, getEpisode, prune, watchingEpisodes, observationDetail,
  // helpers shared with the agent, routes and tests
  describe, minutesOf, defaultMessage, patternGroups, closeStale, OPEN_STATES,
};
