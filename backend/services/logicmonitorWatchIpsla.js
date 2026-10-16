// IP SLA subjects for the latency watch (round 9, WP7). The state machine
// (applySample), episode persistence and the issue builder live in
// logicmonitorWatch.js; this file owns what is specific to IP SLA probes:
// which instances are subjects, where the sample series and the hour
// baselines come from, and the drift check against the frozen reference.
//
// Subject: one row of lm_ds_instances in family 'ipsla' that has an rtt_ms
// metric. subject_key = 'ipsla:<lm_ds_instances.id>:rtt_ms', subject_label =
// "<device> <instance> (<probe type>)", site_key from the device. Loss rides in
// the same episode (kind 'loss' when the loss rule fires), as it does for
// checks. Sample series = lm_ds_metrics_history (rtt_ms joined with loss_pct on
// the sample epoch); baselines = lm_ds_metric_baseline (see
// logicmonitorMetricBaselines.js).
//
// The sample rule is lmChecks.classifySample applied to ONE sample (repeated
// three times) with a lower per-hour sample minimum, because IP SLA history
// arrives every 30 minutes; two elevated samples in a row are 30 minutes and
// promote the episode, a single blip stays a one-off. Metric names
// (rtt_ms, loss_pct) come from the catalog; the datapoints behind them are
// UNVERIFIED against a live portal.
const lmChecks = require('./logicmonitorChecks');
const watch = require('./logicmonitorWatch');
const { REF_SUFFIX, MIN_SAMPLES } = require('./logicmonitorMetricBaselines');

const SAMPLE_FETCH = 40;
// IP SLA history lands every 30 minutes; look back far enough that a late
// metrics tier run does not skip samples.
const SCAN_BACK_SECONDS = 2 * 3600;
const DRIFT_MIN_HOURS = 16;
const nowSec = () => Math.floor(Date.now() / 1000);

const tableOk = (db, name) => !!db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(name);
const probeLabel = (ds) => {
  try {
    const e = require('./logicmonitorCatalog').catalogFor(ds);
    return e && e.label ? e.label : ds;
  } catch { return ds; }
};
const subjectKey = (instId) => `ipsla:${instId}:rtt_ms`;

/** Subjects of one source: [{instId, dev, hds, key, device, instance, probe, siteKey, latestEpoch}]. */
function loadSubjects(dbh, sourceId) {
  return dbh.prepare(`
    SELECT i.id AS inst_id, i.lm_device_id AS dev, i.hds_id AS hds, i.instance_key AS ikey, i.instance_name AS iname, i.datasource_name AS ds,
      d.display_name, d.name AS dname, d.site_key, m.sampled_at_epoch AS latest
    FROM lm_ds_instances i
    JOIN lm_devices d ON d.source_id = i.source_id AND d.lm_device_id = i.lm_device_id AND d.stale = 0
    JOIN lm_ds_metrics m ON m.source_id = i.source_id AND m.lm_device_id = i.lm_device_id AND m.hds_id = i.hds_id
      AND m.instance_key = i.instance_key AND m.metric = 'rtt_ms'
    WHERE i.source_id = ? AND i.family = 'ipsla' AND i.stale = 0
  `).all(sourceId).map((r) => ({
    instId: r.inst_id, dev: r.dev, hds: r.hds, key: r.ikey, ds: r.ds,
    device: r.display_name || r.dname, instance: r.iname || r.ikey, probe: probeLabel(r.ds),
    siteKey: r.site_key || null, latestEpoch: r.latest,
  }));
}

/**
 * Drive the episode state machine for every IP SLA subject of one source.
 * Same contract as the check pass: returns {opened, promoted, closed}.
 * opts.only {instId} limits the pass to one instance (demo replay).
 */
function evaluateIpsla(dbh, source, t, nowEpoch = nowSec(), opts = {}) {
  const counts = { opened: 0, promoted: 0, closed: 0 };
  if (!tableOk(dbh, 'lm_ds_instances') || !tableOk(dbh, 'lm_ds_metric_baseline') || !tableOk(dbh, 'lm_latency_episodes')) return counts;
  const sourceId = source.id;
  const onlyId = opts.only && opts.only.instId != null ? String(opts.only.instId) : null;
  const tt = { ...t, lm_check_baseline_min_samples: Math.min(t.lm_check_baseline_min_samples != null ? t.lm_check_baseline_min_samples : MIN_SAMPLES, MIN_SAMPLES) };

  const subjects = loadSubjects(dbh, sourceId).filter((s) => !onlyId || String(s.instId) === onlyId);
  const open = new Map();
  for (const r of dbh.prepare("SELECT * FROM lm_latency_episodes WHERE source_id = ? AND subject_kind = 'ipsla' AND state != 'closed'").all(sourceId)) {
    open.set(r.subject_key, watch.loadEpisode(r));
  }
  const lastEpoch = new Map(dbh.prepare("SELECT subject_key, MAX(last_sample_epoch) AS e FROM lm_latency_episodes WHERE source_id = ? AND subject_kind = 'ipsla' GROUP BY subject_key")
    .all(sourceId).map((r) => [r.subject_key, r.e]));

  const baselines = new Map();
  for (const b of dbh.prepare("SELECT * FROM lm_ds_metric_baseline WHERE source_id = ? AND metric IN ('rtt_ms', 'loss_pct')").all(sourceId)) {
    const k = `${b.lm_device_id}|${b.hds_id}|${b.instance_key}`;
    if (!baselines.has(k)) baselines.set(k, new Map());
    const hours = baselines.get(k);
    const row = hours.get(b.hour_of_day) || { samples: 0, rtt_median: null, rtt_mad: null, loss_median: null, loss_mad: null };
    if (b.metric === 'rtt_ms') { row.rtt_median = b.median; row.rtt_mad = b.mad; row.samples = b.samples; }
    else { row.loss_median = b.median; row.loss_mad = b.mad; }
    hours.set(b.hour_of_day, row);
  }

  const histStmt = dbh.prepare(`
    SELECT metric, value, sampled_at_epoch AS e FROM lm_ds_metrics_history
    WHERE source_id = ? AND lm_device_id = ? AND hds_id = ? AND instance_key = ? AND metric = ? AND sampled_at_epoch <= ?
    ORDER BY sampled_at_epoch DESC LIMIT ${SAMPLE_FETCH}
  `);
  const insStmt = dbh.prepare(`
    INSERT INTO lm_latency_episodes (source_id, subject_kind, check_id, checkpoint_id, subject_key, subject_label, site_key, kind, state,
      opened_at, last_sample_epoch, samples, elevated_samples, consecutive_normal, baseline_median, baseline_mad, baseline_samples,
      peak_ms, peak_ratio, loss_max_pct, area_over_baseline, likely_hop, likely_hop_device_id, trend_json, run_start_epoch,
      severe_run, severe_since_epoch, last_elevated_epoch)
    VALUES (?, 'ipsla', NULL, NULL, ?, ?, ?, ?, 'watching', ?, ?, 0, 0, 0, ?, ?, ?, NULL, NULL, NULL, 0, NULL, NULL, '[]', NULL, 0, NULL, NULL)
  `);
  const seen = new Set();

  for (const sub of subjects) {
    const key = subjectKey(sub.instId);
    seen.add(key);
    let ep = open.get(key) || null;
    const cursor = ep ? (ep.last_sample_epoch || 0) : Math.max(lastEpoch.get(key) || 0, nowEpoch - SCAN_BACK_SECONDS);
    // Nothing newer than the cursor and nothing open: no queries.
    if (!ep && sub.latestEpoch != null && sub.latestEpoch <= cursor) continue;
    const rttDesc = histStmt.all(sourceId, sub.dev, sub.hds, sub.key, 'rtt_ms', nowEpoch);
    if (rttDesc.length < 3) continue;
    const lossByEpoch = new Map(histStmt.all(sourceId, sub.dev, sub.hds, sub.key, 'loss_pct', nowEpoch).map((r) => [r.e, r.value]));
    const rows = rttDesc.slice().reverse().map((r) => ({ sample_epoch: r.e, rtt_avg_ms: r.value, loss_pct: lossByEpoch.has(r.e) ? lossByEpoch.get(r.e) : null, status: null }));
    const bmap = baselines.get(`${sub.dev}|${sub.hds}|${sub.key}`);
    const label = `${sub.device} ${sub.instance} (${sub.probe})`;
    const target = `${sub.device} ${sub.instance}`;
    let dirty = false;
    for (let i = 2; i < rows.length; i += 1) {
      const s = rows[i];
      if (s.sample_epoch <= cursor) continue;
      const base = bmap ? bmap.get(new Date(s.sample_epoch * 1000).getUTCHours()) : null;
      // One sample at a time: the check rule averages the last 3 samples (15 minutes), but IP SLA
      // history lands every 30 minutes, so a 3-sample mean would stretch every blip to 90 minutes.
      const cls = lmChecks.classifySample([s, s, s], base, tt);
      if (!ep) {
        if (cls.level === 'normal') continue;
        const res = insStmt.run(sourceId, key, label, sub.siteKey, cls.kind || 'latency', watch.isoOf(s.sample_epoch),
          s.sample_epoch, base.rtt_median, base.rtt_mad, base.samples);
        ep = watch.loadEpisode(dbh.prepare('SELECT * FROM lm_latency_episodes WHERE id = ?').get(res.lastInsertRowid));
        ep.issue_key = null;
        counts.opened += 1;
        dirty = true;
      }
      const ev = watch.applySample(ep, s, cls, false, tt, rows.slice(0, i + 1), null);
      dirty = true;
      if (ev === 'promoted') { counts.promoted += 1; ep.issue_key = null; }
      if (ep.state === 'degrading' || ep.state === 'critical') ep.issue_key = `${watch.typeFor(ep.kind)}|${source.name}|${target}`;
      if (ev === 'closed') {
        counts.closed += 1;
        watch.saveEpisode(dbh, ep);
        open.delete(key);
        ep = null;
        dirty = false;
      }
    }
    if (ep && dirty) { watch.saveEpisode(dbh, ep); open.set(key, ep); }
  }

  // Stale guard: frozen watching episodes and episodes whose probe left the inventory close.
  if (!onlyId) {
    for (const [key, ep] of open) {
      const gone = !seen.has(key);
      const frozen = ep.state === 'watching' && (ep.last_sample_epoch || 0) < nowEpoch - watch.STALE_WATCH_SECONDS;
      if (!gone && !frozen) continue;
      watch.closeEpisode(ep, nowEpoch);
      watch.saveEpisode(dbh, ep);
      counts.closed += 1;
    }
  }
  return counts;
}

/**
 * latency-drift issue rows for IP SLA probes: the live hour medians
 * (lm_ds_metric_baseline metric rtt_ms) against the frozen reference rows
 * (metric rtt_ms:ref), same 16-hour rule and thresholds as the check drift.
 */
function computeIpslaDrift(dbh, t, srcName) {
  const issues = [];
  if (!tableOk(dbh, 'lm_ds_metric_baseline')) return issues;
  const nameOf = (id) => (srcName && srcName.get ? srcName.get(id) : null) || String(id);
  const rows = dbh.prepare(`
    SELECT b.source_id, b.lm_device_id AS dev, b.hds_id AS hds, b.instance_key AS ikey, b.hour_of_day, b.median AS live, r.median AS ref
    FROM lm_ds_metric_baseline b
    JOIN lm_ds_metric_baseline r ON r.source_id = b.source_id AND r.lm_device_id = b.lm_device_id AND r.hds_id = b.hds_id
      AND r.instance_key = b.instance_key AND r.hour_of_day = b.hour_of_day AND r.metric = 'rtt_ms${REF_SUFFIX}'
    WHERE b.metric = 'rtt_ms' AND b.median IS NOT NULL AND r.median IS NOT NULL AND r.median > 0
  `).all();
  const groups = new Map();
  for (const r of rows) {
    const k = `${r.source_id}|${r.dev}|${r.hds}|${r.ikey}`;
    if (!groups.has(k)) groups.set(k, { sourceId: r.source_id, dev: r.dev, hds: r.hds, ikey: r.ikey, hours: [] });
    groups.get(k).hours.push(r);
  }
  const labelStmt = dbh.prepare(`
    SELECT i.instance_name, i.instance_key, d.display_name, d.name FROM lm_ds_instances i
    JOIN lm_devices d ON d.source_id = i.source_id AND d.lm_device_id = i.lm_device_id AND d.stale = 0
    WHERE i.source_id = ? AND i.lm_device_id = ? AND i.hds_id = ? AND i.instance_key = ? AND i.stale = 0
  `);
  const round = (v, d = 0) => Number(Number(v).toFixed(d));
  for (const g of groups.values()) {
    const up = g.hours.filter((h) => h.live > h.ref * (1 + t.lm_watch_drift_pct / 100));
    if (up.length < DRIFT_MIN_HOURS) continue;
    const loc = labelStmt.get(g.sourceId, g.dev, g.hds, g.ikey);
    if (!loc) continue;
    const pct = lmChecks.median(up.map((h) => (h.live / h.ref - 1) * 100));
    issues.push({
      severity: pct >= t.lm_watch_drift_crit_pct ? 'warning' : 'info', type: 'latency-drift', source: nameOf(g.sourceId),
      target: `${loc.display_name || loc.name} ${loc.instance_name || loc.instance_key}`,
      message: `Baseline RTT is up ${round(pct)}% against the earlier reference (${round(lmChecks.median(up.map((h) => h.ref)), 1)} ms to ${round(lmChecks.median(up.map((h) => h.live)), 1)} ms across ${up.length} hours)`,
    });
  }
  return issues;
}

module.exports = { evaluateIpsla, computeIpslaDrift, loadSubjects, subjectKey };
