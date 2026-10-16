// Site reachability: LogicMonitor ping and web check data (legacy Websites and
// LM Uptime) mapped to ICC rows, per-hour baselines (median and MAD) and the
// anomaly rules from contract section 6. ICC code decides every anomaly; no
// model is involved. Column names in check data are UNVERIFIED (LM does not
// publish them), so columns are learned at runtime from the response's
// dataPoints array and matched by name, never by position
// (references/ping-web-checks.md sections 2.3, 3.1 and 10).
const { getSetting } = require('./settings');

// -- Thresholds (clamped settings, vcenter cert pattern) ----------------------

const CHECK_THRESHOLD_DEFS = {
  lm_check_history_days: { def: 30, min: 7, max: 90, label: 'Check history retention (days)' },
  lm_check_baseline_days: { def: 7, min: 3, max: 30, label: 'Baseline window (days)' },
  lm_check_baseline_min_samples: { def: 24, min: 6, max: 500, label: 'Minimum samples per baseline hour' },
  lm_check_latency_k: { def: 3, min: 1, max: 10, label: 'Latency anomaly k (x MAD)' },
  lm_check_latency_floor_ms: { def: 5, min: 1, max: 100, label: 'Latency MAD floor (ms)' },
  lm_check_latency_min_ms: { def: 20, min: 1, max: 1000, label: 'Latency anomaly minimum (ms)' },
  lm_check_loss_min_pct: { def: 2, min: 0, max: 100, label: 'Packet loss anomaly minimum (%)' },
  lm_check_loss_crit_pct: { def: 20, min: 1, max: 100, label: 'Packet loss critical (%)' },
  lm_check_location_fold: { def: 3, min: 2, max: 50, label: 'Checks per location before folding' },
  lm_check_data_calls_per_tick: { def: 200, min: 10, max: 2000, label: 'Check data calls per poll' },
};

function clampedInt(key, def, min, max) {
  let raw;
  try { raw = getSetting(key); } catch { raw = null; }
  if (raw == null || raw === '') return def;
  const n = Number(raw);
  if (!Number.isFinite(n)) return def;
  return Math.min(max, Math.max(min, Math.round(n)));
}

function checkThreshold(key) {
  const d = CHECK_THRESHOLD_DEFS[key];
  if (!d) throw new Error(`unknown LogicMonitor check threshold ${key}`);
  return clampedInt(key, d.def, d.min, d.max);
}

function checkThresholds() {
  const out = {};
  for (const k of Object.keys(CHECK_THRESHOLD_DEFS)) out[k] = checkThreshold(k);
  return out;
}

// -- Column learning ------------------------------------------------------------

// Candidate names, compared after lower-casing and dropping non-alphanumerics.
// The contract's lists come first; the names the research found in print
// (Collector javadoc sendPkts/recdPkts/minRTT/maxRTT/avgRTT, web
// fullPageLoadTime) are added.
const CHECK_COLUMN_CANDIDATES = {
  rttAvg: ['rtavg', 'avgrtt', 'roundtriptime', 'rtt', 'rttavg', 'averagertt', 'pingavgrtt'],
  rttMin: ['rtmin', 'minrtt', 'rttmin'],
  rttMax: ['rtmax', 'maxrtt', 'rttmax'],
  loss: ['loss', 'packetloss', 'pctloss', 'percentloss', 'losspct', 'packetlosspercent'],
  sent: ['sent', 'sentpkts', 'sendpkts', 'sentpackets', 'packetssent', 'sentcount'],
  recv: ['recv', 'recdpkts', 'recvpkts', 'received', 'receivedpkts', 'receivedpackets', 'packetsreceived', 'recvcount'],
  response: ['totaltime', 'responsetime', 'totalresponsetime', 'fullpageloadtime'],
  status: ['status', 'overallstatus', 'checkpointstatus'],
};
// Columns whose presence marks the Overall checkpoint.
const OVERALL_MARKERS = ['totalsmcount', 'failsmcount', 'reportlsmepoch', 'reportsmepoch', 'overallstatus'];

const squash = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]/g, '');

/**
 * Learn which datapoint name feeds which ICC field. kind 'ping' maps a bare
 * responsetime column to rttAvg (ping "Response Time" is the RTT graph);
 * kind 'web' maps it to response. Returns {columns: {field: name}, unmatched:
 * [names], isOverall, positional} where positional is true when no dataPoints
 * array was present (values row length only; nothing can be mapped by name).
 */
function learnCheckColumns(dataPoints, kind = 'ping', valuesRowLength = 0) {
  const names = Array.isArray(dataPoints) ? dataPoints.map(String) : [];
  if (!names.length) {
    return {
      columns: {},
      unmatched: Array.from({ length: valuesRowLength || 0 }, (_, i) => `col${i}`),
      isOverall: false,
      positional: true,
    };
  }
  const columns = {};
  const used = new Set();
  const take = (field, name) => { if (!columns[field] && !used.has(name)) { columns[field] = name; used.add(name); } };
  const candidates = { ...CHECK_COLUMN_CANDIDATES };
  if (kind === 'ping') {
    candidates.rttAvg = [...candidates.rttAvg, 'responsetime'];
    candidates.response = candidates.response.filter((n) => n !== 'responsetime');
  }
  // Pass 1: exact candidate match.
  for (const [field, list] of Object.entries(candidates)) {
    for (const cand of list) {
      const hit = names.find((n) => squash(n) === cand);
      if (hit) { take(field, hit); break; }
    }
  }
  // Pass 2: substring rules (research build rule: min, max, avg, sent/send,
  // recv/recd, status), skipping SSL status columns.
  for (const n of names) {
    if (used.has(n)) continue;
    const s = squash(n);
    if (s.includes('ssl')) continue;
    if (!columns.rttMin && s.includes('min') && (s.includes('rt') || s.includes('rtt'))) take('rttMin', n);
    else if (!columns.rttMax && s.includes('max') && (s.includes('rt') || s.includes('rtt'))) take('rttMax', n);
    else if (!columns.rttAvg && (s.includes('avgrt') || s.includes('rttavg') || (s.includes('avg') && s.includes('rtt')))) take('rttAvg', n);
    else if (!columns.loss && s.includes('loss')) take('loss', n);
    else if (!columns.sent && (s.includes('sent') || s.includes('send'))) take('sent', n);
    else if (!columns.recv && (s.includes('recv') || s.includes('recd') || s.includes('receiv'))) take('recv', n);
    else if (!columns.status && s.endsWith('status') && !s.includes('sm')) take('status', n);
  }
  const isOverall = names.some((n) => OVERALL_MARKERS.includes(squash(n)));
  return { columns, unmatched: names.filter((n) => !used.has(n)), isOverall, positional: false };
}

function num(v) {
  if (typeof v === 'number') return Number.isFinite(v) ? v : null;
  if (v == null || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) && typeof v !== 'boolean' ? n : null;
}

/** LM check status code to ICC status: 1 is okay, any other positive code is
 *  a failed check (24 threshold miss, 6 DNS, 7 timeout, 8 refused, 2 overall
 *  error); anything else unknown. */
function statusFromCode(code) {
  const n = num(code);
  if (n == null || n <= 0) return 'unknown';
  return n === 1 ? 'up' : 'down';
}

/**
 * One values row to ICC fields. learned is the learnCheckColumns result,
 * dataPoints the names array of that response. Loss comes from sent/received
 * when both exist (LM publishes no loss datapoint), else from a direct loss
 * column. Without a status column the status is derived: loss 100 -> down,
 * received > 0 -> up, else unknown.
 */
function mapCheckRow(values, learned, dataPoints) {
  const row = Array.isArray(values) ? values : [];
  const names = Array.isArray(dataPoints) ? dataPoints.map(String) : [];
  const get = (field) => {
    const name = learned?.columns?.[field];
    if (!name) return null;
    const idx = names.indexOf(name);
    return idx >= 0 ? num(row[idx]) : null;
  };
  const sent = get('sent');
  const recv = get('recv');
  let lossPct = null;
  if (sent != null && recv != null && sent > 0) lossPct = Math.max(0, Math.min(100, (100 * (sent - recv)) / sent));
  else lossPct = get('loss');
  const statusRaw = get('status');
  let status = statusRaw != null ? statusFromCode(statusRaw) : 'unknown';
  if (statusRaw == null) {
    if (lossPct === 100) status = 'down';
    else if (recv != null && recv > 0) status = 'up';
  }
  const unmatched = {};
  for (const n of learned?.unmatched || []) {
    const idx = names.indexOf(n);
    if (idx >= 0) unmatched[n] = row[idx] ?? null;
  }
  return {
    rttAvgMs: get('rttAvg'),
    rttMinMs: get('rttMin'),
    rttMaxMs: get('rttMax'),
    lossPct,
    responseMs: get('response'),
    statusRaw,
    status,
    unmatched,
  };
}

/** Raw {time[], values[][]} to rows with sampleEpoch in seconds (any time
 *  value above 1e11 is milliseconds). Rows with no numeric cell are gaps. */
function parseCheckSeries(series, learned, dataPoints) {
  const times = Array.isArray(series?.time) ? series.time : [];
  const values = Array.isArray(series?.values) ? series.values : [];
  const out = [];
  for (let i = 0; i < values.length; i += 1) {
    const t = num(times[i]);
    if (t == null) continue;
    const row = values[i];
    if (!Array.isArray(row) || !row.some((v) => num(v) != null)) continue;
    const sampleEpoch = t > 1e11 ? Math.floor(t / 1000) : Math.floor(t);
    out.push({ sampleEpoch, raw: row, ...mapCheckRow(row, learned, dataPoints) });
  }
  return out.sort((a, b) => a.sampleEpoch - b.sampleEpoch);
}

// -- Statistics ---------------------------------------------------------------------

function median(arr) {
  const a = arr.filter((v) => v != null && Number.isFinite(v)).sort((x, y) => x - y);
  if (!a.length) return null;
  const m = Math.floor(a.length / 2);
  return a.length % 2 ? a[m] : (a[m - 1] + a[m]) / 2;
}

/** Median absolute deviation (unscaled). */
function mad(arr) {
  const m = median(arr);
  if (m == null) return null;
  return median(arr.filter((v) => v != null && Number.isFinite(v)).map((v) => Math.abs(v - m)));
}

const mean = (arr) => {
  const a = arr.filter((v) => v != null && Number.isFinite(v));
  return a.length ? a.reduce((s, v) => s + v, 0) / a.length : null;
};

// -- Baselines ------------------------------------------------------------------------

/**
 * Recompute lm_check_baseline for one source from the last `days` of history,
 * grouped by (check, checkpoint, UTC hour of day of the sample), excluding
 * the current hour. Groups with fewer than minSamples samples are not written
 * (no anomaly can be raised for them). Returns the number of rows written.
 */
function computeBaselines(db, sourceId, days = checkThreshold('lm_check_baseline_days'), minSamples = checkThreshold('lm_check_baseline_min_samples'), nowMs = Date.now()) {
  const hourStart = Math.floor(nowMs / 3600000) * 3600;
  const since = hourStart - days * 86400;
  const rows = db.prepare(`
    SELECT check_id, checkpoint_id, sample_epoch, rtt_avg_ms, loss_pct, response_ms
    FROM lm_check_history
    WHERE source_id = ? AND sample_epoch >= ? AND sample_epoch < ?
  `).all(sourceId, since, hourStart);
  const groups = new Map();
  for (const r of rows) {
    const hour = new Date(r.sample_epoch * 1000).getUTCHours();
    const k = `${r.check_id}\u0000${r.checkpoint_id}\u0000${hour}`;
    let g = groups.get(k);
    if (!g) { g = { checkId: r.check_id, checkpointId: r.checkpoint_id, hour, rtt: [], loss: [], resp: [], n: 0 }; groups.set(k, g); }
    g.n += 1;
    g.rtt.push(r.rtt_avg_ms);
    g.loss.push(r.loss_pct);
    g.resp.push(r.response_ms);
  }
  const computedAt = new Date(nowMs).toISOString();
  let written = 0;
  const txn = db.transaction(() => {
    db.prepare('DELETE FROM lm_check_baseline WHERE source_id = ?').run(sourceId);
    const ins = db.prepare(`
      INSERT INTO lm_check_baseline (source_id, check_id, checkpoint_id, hour_of_day, samples,
        rtt_median, rtt_mad, loss_median, loss_mad, response_median, response_mad, computed_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    for (const g of groups.values()) {
      if (g.n < minSamples) continue;
      ins.run(sourceId, g.checkId, g.checkpointId, g.hour, g.n,
        median(g.rtt), mad(g.rtt), median(g.loss), mad(g.loss), median(g.resp), mad(g.resp), computedAt);
      written += 1;
    }
  });
  txn();
  return written;
}

/**
 * Daily rollup of one UTC day (YYYY-MM-DD) for one source, written only when
 * missing. rtt_p95 is APPROXIMATE: the max of the hourly averages for that
 * day, not a true 95th percentile of raw samples.
 */
function rollupCheckDaily(db, sourceId, day) {
  const start = Math.floor(Date.parse(`${day}T00:00:00Z`) / 1000);
  const end = start + 86400;
  if (!Number.isFinite(start)) return 0;
  const rows = db.prepare(`
    SELECT check_id, checkpoint_id, sample_epoch, status, rtt_avg_ms, loss_pct, response_ms
    FROM lm_check_history WHERE source_id = ? AND sample_epoch >= ? AND sample_epoch < ?
  `).all(sourceId, start, end);
  const groups = new Map();
  for (const r of rows) {
    const k = `${r.check_id}\u0000${r.checkpoint_id}`;
    let g = groups.get(k);
    if (!g) { g = { checkId: r.check_id, checkpointId: r.checkpoint_id, n: 0, down: 0, rtt: [], loss: [], resp: [], hourly: new Map() }; groups.set(k, g); }
    g.n += 1;
    if (r.status === 'down') g.down += 1;
    g.rtt.push(r.rtt_avg_ms);
    g.loss.push(r.loss_pct);
    g.resp.push(r.response_ms);
    const h = Math.floor(r.sample_epoch / 3600);
    if (r.rtt_avg_ms != null) { const arr = g.hourly.get(h) || []; arr.push(r.rtt_avg_ms); g.hourly.set(h, arr); }
  }
  const ins = db.prepare(`
    INSERT OR IGNORE INTO lm_check_daily (source_id, check_id, checkpoint_id, day, samples, down_samples,
      rtt_avg, rtt_p95, loss_avg, loss_max, response_avg)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  let written = 0;
  db.transaction(() => {
    for (const g of groups.values()) {
      const hourlyAvgs = [...g.hourly.values()].map(mean).filter((v) => v != null);
      const lossVals = g.loss.filter((v) => v != null);
      const res = ins.run(sourceId, g.checkId, g.checkpointId, day, g.n, g.down,
        mean(g.rtt), hourlyAvgs.length ? Math.max(...hourlyAvgs) : null,
        mean(g.loss), lossVals.length ? Math.max(...lossVals) : null, mean(g.resp));
      written += res.changes;
    }
  })();
  return written;
}

// -- Evaluation -------------------------------------------------------------------------

const locationKey = (sourceId, checkId, checkpointId) => `${sourceId}|${checkId}|${checkpointId}`;
const round = (v, d = 0) => (v == null ? null : Number(Number(v).toFixed(d)));

/**
 * Classify one sample window against its hour baseline. recent is newest
 * first (only the first 3 rows are used). Returns {level, kind, latency,
 * loss, severity, meanRtt, meanLoss, ratio}: level is 'normal' | 'elevated' |
 * 'severe' (severe: loss at the critical percentage, or RTT at least
 * t.lm_watch_severe_ratio times the baseline median, 2 when t does not carry
 * the key), kind is 'loss' | 'latency' | null (loss wins when both fire, as
 * the original rule did), latency and loss say which rules fired, severity is
 * the original warning/critical verdict of the winning rule and ratio is the
 * mean RTT over the baseline median (null without both).
 */
function classifySample(recent, baseline, t) {
  const last3 = (recent || []).slice(0, 3);
  const meanRtt = mean(last3.map((r) => r.rtt_avg_ms));
  const meanLoss = mean(last3.map((r) => r.loss_pct));
  const out = { level: 'normal', kind: null, latency: false, loss: false, severity: null, meanRtt, meanLoss, ratio: null };
  if (!baseline || (baseline.samples || 0) < t.lm_check_baseline_min_samples || last3.length < 3) return out;
  if (meanRtt != null && baseline.rtt_median != null && baseline.rtt_median > 0) out.ratio = meanRtt / baseline.rtt_median;
  const k = t.lm_check_latency_k;
  let lossSeverity = null;
  let latencySeverity = null;
  if (meanLoss != null && baseline.loss_median != null) {
    const limit = baseline.loss_median + k * Math.max(baseline.loss_mad || 0, 1);
    if (meanLoss > limit && meanLoss >= t.lm_check_loss_min_pct) {
      out.loss = true;
      lossSeverity = meanLoss >= t.lm_check_loss_crit_pct ? 'critical' : 'warning';
    }
  }
  if (meanRtt != null && baseline.rtt_median != null) {
    const limit = baseline.rtt_median + k * Math.max(baseline.rtt_mad || 0, t.lm_check_latency_floor_ms);
    if (meanRtt > limit && meanRtt > t.lm_check_latency_min_ms) {
      out.latency = true;
      latencySeverity = meanRtt > 2 * baseline.rtt_median && meanRtt > 100 ? 'critical' : 'warning';
    }
  }
  if (!out.loss && !out.latency) return out;
  const severeRatio = t.lm_watch_severe_ratio != null ? t.lm_watch_severe_ratio : 2;
  out.kind = out.loss ? 'loss' : 'latency';
  out.severity = out.loss ? lossSeverity : latencySeverity;
  const severe = (out.loss && lossSeverity === 'critical') || (out.latency && out.ratio != null && out.ratio >= severeRatio);
  out.level = severe ? 'severe' : 'elevated';
  return out;
}

/**
 * Pure rule for one location: last samples (newest first) plus its baseline
 * row and thresholds -> {anomaly, severity, meanRtt, meanLoss}. anomaly is
 * null | 'latency' | 'loss' | 'down'. The sample math lives in classifySample.
 */
function evaluateLocationRule({ lastStatus, recent, baseline, t }) {
  if (lastStatus === 'down') return { anomaly: 'down', severity: 'warning', meanRtt: null, meanLoss: null };
  const c = classifySample(recent, baseline, t);
  return { anomaly: c.kind, severity: c.severity, meanRtt: c.meanRtt, meanLoss: c.meanLoss };
}

/**
 * Per-location state for every non-stale location of every non-stale check:
 * [{sourceId, sourceName, checkId, checkName, kind, isInternal, checkpointId,
 *   label, isOverall, status, rttAvgMs, lossPct, responseMs, sampleEpoch,
 *   baselineRttMs, baselineRttMad, baselineLossPct, baselineLossMad,
 *   baselineSamples, meanRttMs, meanLossPct, anomaly, severity, lmAlertOpen}]
 * The routes use this for the /checks matrix cells.
 */
function evaluateLocations(db, { nowMs = Date.now(), sourceId = null } = {}) {
  const t = checkThresholds();
  const hour = new Date(nowMs).getUTCHours();
  const locs = db.prepare(`
    SELECT l.*, c.name AS check_name, c.kind, c.is_internal, c.polling_interval, c.stop_monitoring AS check_stop,
           s.name AS source_name
    FROM lm_check_locations l
    JOIN lm_checks c ON c.source_id = l.source_id AND c.check_id = l.check_id
    JOIN lm_sources s ON s.id = l.source_id
    WHERE l.stale = 0 AND c.stale = 0 ${sourceId != null ? 'AND l.source_id = ?' : ''}
  `).all(...(sourceId != null ? [sourceId] : []));
  if (!locs.length) return [];
  const recentStmt = db.prepare(`
    SELECT sample_epoch, status, rtt_avg_ms, loss_pct FROM lm_check_history
    WHERE source_id = ? AND check_id = ? AND checkpoint_id = ? ORDER BY sample_epoch DESC LIMIT 3
  `);
  const baseStmt = db.prepare(`
    SELECT * FROM lm_check_baseline WHERE source_id = ? AND check_id = ? AND checkpoint_id = ? AND hour_of_day = ?
  `);
  // Open LM alerts on a check: website alerts carry the website name as the
  // monitored object (UNVERIFIED), Uptime checks the device name.
  const openAlertNames = new Set(db.prepare(`
    SELECT source_id, lower(monitor_object_name) n FROM lm_alerts
    WHERE cleared = 0 AND (type = 'websiteAlert' OR resource_template_name LIKE 'Ping_Check%' OR resource_template_name LIKE 'Web_Check%')
  `).all().map((r) => `${r.source_id}|${r.n}`));
  const nowSec = Math.floor(nowMs / 1000);
  const out = [];
  for (const l of locs) {
    const recent = recentStmt.all(l.source_id, l.check_id, l.checkpoint_id);
    const baseline = baseStmt.get(l.source_id, l.check_id, l.checkpoint_id, hour) || null;
    const lmAlertOpen = openAlertNames.has(`${l.source_id}|${String(l.check_name || '').toLowerCase()}`);
    // No data in 2 polling intervals: 'down' only when LM's own alert says so.
    const intervalSec = Math.max(1, l.polling_interval || 5) * 60;
    let status = l.last_status || 'unknown';
    if (!l.last_sample_epoch || nowSec - l.last_sample_epoch > 2 * intervalSec) status = lmAlertOpen ? 'down' : 'unknown';
    if (l.check_stop) status = 'unknown';
    const r = evaluateLocationRule({ lastStatus: status, recent: status === 'unknown' ? [] : recent, baseline, t });
    out.push({
      sourceId: l.source_id,
      sourceName: l.source_name,
      checkId: l.check_id,
      checkName: l.check_name,
      kind: l.kind,
      isInternal: !!l.is_internal,
      checkpointId: l.checkpoint_id,
      label: l.label,
      collectorId: l.collector_id,
      isOverall: !!l.is_overall,
      status,
      rttAvgMs: l.last_rtt_ms,
      lossPct: l.last_loss_pct,
      responseMs: l.last_response_ms,
      sampleEpoch: l.last_sample_epoch,
      baselineRttMs: baseline?.rtt_median ?? null,
      baselineRttMad: baseline?.rtt_mad ?? null,
      baselineLossPct: baseline?.loss_median ?? null,
      baselineLossMad: baseline?.loss_mad ?? null,
      baselineSamples: baseline?.samples ?? 0,
      meanRttMs: r.meanRtt,
      meanLossPct: r.meanLoss,
      anomaly: r.anomaly,
      severity: r.severity,
      lmAlertOpen,
    });
  }
  return out;
}

function fromText(loc) {
  return loc.isInternal ? `from collector ${loc.label}` : `from ${loc.label}`;
}

/**
 * Issue objects for checks: check-down, check-location-down, latency-anomaly,
 * packet-loss-anomaly and the location-degraded fold. A checkpoint label
 * shared by >= lm_check_location_fold anomalous or down checks becomes ONE
 * critical issue and the per-check issues at that label are suppressed.
 */
function evaluateAnomalies(db, opts = {}) {
  const t = checkThresholds();
  const locs = evaluateLocations(db, opts);
  const issues = [];
  // " Likely hop: ..." tail from the path model (round 3); one shared context
  // per pass, and never a reason to lose the anomaly itself.
  let pathMod = null;
  let pctx = null;
  const likely = (l) => {
    try {
      pathMod = pathMod || require('./logicmonitorPath');
      pctx = pctx || pathMod.makeContext(db);
      return pathMod.likelyHopText(pathMod.blameForCheck(db, l.checkId, l.checkpointId, { ctx: pctx, sourceId: l.sourceId }));
    } catch { return ''; }
  };
  const byCheck = new Map();
  for (const l of locs) {
    const k = `${l.sourceId}|${l.checkId}`;
    if (!byCheck.has(k)) byCheck.set(k, []);
    byCheck.get(k).push(l);
  }

  // check-down: Overall down or an open LM alert on the check.
  const downChecks = new Set();
  for (const [k, list] of byCheck) {
    const overall = list.find((l) => l.isOverall);
    const first = list[0];
    if ((overall && overall.status === 'down') || first.lmAlertOpen) {
      downChecks.add(k);
      issues.push({
        severity: 'critical', type: 'check-down', source: first.sourceName, target: first.checkName,
        message: `${first.kind === 'web' ? 'Web' : 'Ping'} check ${first.checkName} is down${overall && overall.status === 'down' ? ' (Overall)' : ''}${first.lmAlertOpen ? ', LogicMonitor alert open' : ''}${likely(overall || first)}`,
      });
    }
  }

  // Per-location candidates (not Overall, check not already down).
  const candidates = locs.filter((l) => !l.isOverall && l.anomaly && !downChecks.has(`${l.sourceId}|${l.checkId}`));
  const byLabel = new Map();
  for (const l of locs.filter((x) => !x.isOverall && x.anomaly)) {
    const key = `${l.sourceId}|${String(l.label || '').toLowerCase()}`;
    if (!byLabel.has(key)) byLabel.set(key, new Map());
    byLabel.get(key).set(l.checkId, l);
  }
  const folded = new Set();
  for (const [key, checks] of byLabel) {
    if (checks.size < t.lm_check_location_fold) continue;
    folded.add(key);
    const any = [...checks.values()][0];
    const parts = [...checks.values()].slice(0, 5).map((l) => `${l.checkName} ${l.anomaly}`);
    issues.push({
      severity: 'critical', type: 'location-degraded', source: any.sourceName, target: any.label,
      message: `${checks.size} checks ${fromText(any)} are degraded at once: ${parts.join(', ')}${checks.size > 5 ? ', ...' : ''}`,
    });
  }

  for (const l of candidates) {
    if (folded.has(`${l.sourceId}|${String(l.label || '').toLowerCase()}`)) continue;
    const target = `${l.checkName} @ ${l.label}`;
    if (l.anomaly === 'down') {
      issues.push({ severity: 'warning', type: 'check-location-down', source: l.sourceName, target,
        message: `${l.checkName} fails ${fromText(l)} while Overall is up${likely(l)}` });
    } else if (l.anomaly === 'latency') {
      issues.push({ severity: l.severity, type: 'latency-anomaly', source: l.sourceName, target,
        message: `RTT ${round(l.meanRttMs)} ms, baseline ${round(l.baselineRttMs)} +/- ${round(l.baselineRttMad)} ms, ${fromText(l)}${likely(l)}` });
    } else if (l.anomaly === 'loss') {
      issues.push({ severity: l.severity, type: 'packet-loss-anomaly', source: l.sourceName, target,
        message: `Packet loss ${round(l.meanLossPct, 1)}%, baseline ${round(l.baselineLossPct, 1)} +/- ${round(l.baselineLossMad, 1)}%, ${fromText(l)}${likely(l)}` });
    }
  }
  return issues;
}

module.exports = {
  CHECK_THRESHOLD_DEFS, CHECK_COLUMN_CANDIDATES, OVERALL_MARKERS,
  checkThreshold, checkThresholds,
  learnCheckColumns, mapCheckRow, parseCheckSeries, statusFromCode,
  median, mad, mean,
  computeBaselines, rollupCheckDaily,
  classifySample, evaluateLocationRule, evaluateLocations, evaluateAnomalies, locationKey,
};
