// LogicMonitor DataSource metric collector (round 8). One catalog-driven tier
// ('logicmonitor-metrics', every metrics_poll_minutes): for each device
// DataSource the catalog knows, one data call, datapoints matched to canonical
// metric keys, the LAST non-null sample per instance and metric into
// lm_ds_metrics, optional history into lm_ds_metrics_history. Datapoint names
// are UNVERIFIED (no live portal here): the first un-narrowed call per
// DataSource learns the dataPoints array, the matched raw names are kept in
// lm_sources.features_json (dsColumns, dsUnmatched), later calls narrow with
// the `datapoints` param.
//
// Candidate rows come from lm_device_datasources, which has no stale column
// (the table is delete-and-reinsert per device refresh), so "not stale" is
// enforced on the device join only.
const db = require('../db/database');
const lmApi = require('./logicmonitorApi');
const { catalogFor, cleanInstanceKey, DEFAULT_MAX_INSTANCES, CATALOG_VERSION } = require('./logicmonitorCatalog');
const logger = require('../utils/logger');
const lmRaw = require('./logicmonitorRaw');
const { mapLimit, callsInFlight } = require('../core/concurrency');

const safeMsg = (e) => lmApi.errMsg(e);
const nowSec = () => Math.floor(Date.now() / 1000);

// getThreshold throws for a key the issues module does not define yet; fall
// back to the contract default so the collector never depends on load order.
const THRESHOLD_FALLBACK = { lm_metrics_data_calls_per_tick: 300, lm_raw_calls_per_tick: 600, lm_ds_history_days: 14 };
function threshold(key) {
  try {
    return require('./logicmonitorIssues').getThreshold(key);
  } catch {
    return THRESHOLD_FALLBACK[key];
  }
}

const cellNum = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : (typeof v === 'string' && v.trim() !== '' && Number.isFinite(Number(v)) ? Number(v) : null));

function parseJson(v, fallback) {
  if (v == null || v === '') return fallback;
  try { return JSON.parse(v); } catch { return fallback; }
}

function readFeatures(sourceId) {
  const row = db.prepare('SELECT features_json FROM lm_sources WHERE id = ?').get(sourceId);
  return parseJson(row?.features_json, {}) || {};
}

/** Same contract as the poller's mergeFeatures (kept local so this module
 *  does not require the poller, which requires this module). */
function mergeFeatures(sourceId, patch) {
  const cur = readFeatures(sourceId);
  const next = { ...cur, ...patch };
  if (JSON.stringify(cur) === JSON.stringify(next)) return cur;
  db.prepare('UPDATE lm_sources SET features_json = ? WHERE id = ?').run(JSON.stringify(next), sourceId);
  return next;
}

// -- Pure parsing ----------------------------------------------------------------

/** First datapoint name matched by a metric def. A def's `match` is a RegExp,
 *  or an array of RegExps in priority order (all names are tried against the
 *  first regex before the second one is considered). Names in `claimed` are
 *  skipped; among hits the shortest name wins. */
function matchDatapoint(names, matcher, claimed = null) {
  const list = Array.isArray(matcher) ? matcher : [matcher];
  const free = claimed ? names.filter((n) => !claimed.has(n)) : names;
  for (const rx of list) {
    // Shortest hit wins: "RxPower" over "RxPowerLowWarn", "CPU5min" over
    // "CPU5minAverage"; ties keep LM's order.
    const hits = free.filter((n) => rx.test(n));
    if (hits.length) return hits.reduce((a, b) => (b.length < a.length ? b : a));
  }
  return null;
}

/** mem_pct is percent USED. A datapoint that reads as "free" is inverted. */
const isFreeDatapoint = (metric, raw) => metric === 'mem_pct' && /free/i.test(raw || '') && !/used/i.test(raw || '');

/**
 * Pure: map one LM data body onto an entry's metrics.
 *   learned: { metricKey: rawDatapointName } from an earlier call (or null).
 *   returns { learned, instances: [{ key, name, latest: {metric: {value, epoch,
 *   datapoint}}, samples: [{metric, value, epoch}] }], unmatched[] }
 * Learned names that are absent from this body are re-matched by regex. A
 * body with no dataPoints array maps nothing. Epochs come from the body's
 * time array (ms or s); a sample with no time takes nowEpoch.
 */
function parseDsBody(body, entry, learned = null, nowEpoch = nowSec()) {
  const names = Array.isArray(body?.dataPoints) ? body.dataPoints.map(String) : [];
  const out = { learned: {}, instances: [], unmatched: [] };
  if (!entry || !names.length) return out;
  // A datapoint is claimed by one metric only: learned names first, then the
  // catalog order, each metric matching only against names still free.
  const claimed = new Set();
  for (const [metric] of Object.entries(entry.metrics || {})) {
    const prior = learned && learned[metric];
    if (prior && names.includes(prior) && !claimed.has(prior)) { out.learned[metric] = prior; claimed.add(prior); }
  }
  for (const [metric, def] of Object.entries(entry.metrics || {})) {
    if (out.learned[metric]) continue;
    const raw = matchDatapoint(names, def.match, claimed);
    if (raw != null) { out.learned[metric] = raw; claimed.add(raw); }
  }
  out.unmatched = names.filter((n) => !claimed.has(n));
  const index = {};
  for (const [metric, raw] of Object.entries(out.learned)) index[metric] = names.indexOf(raw);

  const dsName = body?.dataSourceName || (typeof entry.match === 'string' ? entry.match : '');
  for (const [rawKey, series] of Object.entries(body?.instances || {})) {
    const key = cleanInstanceKey(rawKey, dsName);
    const values = Array.isArray(series?.values) ? series.values : [];
    const times = Array.isArray(series?.time) ? series.time : [];
    const latest = {};
    const samples = [];
    for (let i = 0; i < values.length; i += 1) {
      const row = values[i];
      if (!Array.isArray(row)) continue;
      const t = cellNum(times[i]);
      const epoch = t == null ? nowEpoch : (t > 1e11 ? Math.floor(t / 1000) : Math.floor(t));
      for (const [metric, col] of Object.entries(index)) {
        let v = cellNum(row[col]);
        if (v == null) continue;
        const raw = out.learned[metric];
        const inverted = isFreeDatapoint(metric, raw);
        if (inverted) v = Math.round((100 - v) * 1000) / 1000;
        samples.push({ metric, value: v, epoch });
        if (!latest[metric] || epoch >= latest[metric].epoch) {
          latest[metric] = { value: v, epoch, datapoint: inverted ? '100-PercentFree' : raw };
        }
      }
    }
    out.instances.push({ key, name: key, latest, samples });
  }
  return out;
}

// -- Collector -------------------------------------------------------------------

const parseDbTime = (s) => {
  if (!s) return null;
  const ms = Date.parse(String(s).includes('T') ? s : `${String(s).replace(' ', 'T')}Z`);
  return Number.isFinite(ms) ? Math.floor(ms / 1000) : null;
};

function enabledFamilies(source) {
  let raw = source.metrics_families_json;
  if (raw === undefined) raw = db.prepare('SELECT metrics_families_json FROM lm_sources WHERE id = ?').get(source.id)?.metrics_families_json;
  const list = parseJson(raw, null);
  return Array.isArray(list) ? new Set(list.map(String)) : null; // null = every family on
}

/** Raw ingestion (round 11) is on unless the source switched it off (null = on). */
const rawEnabled = (source) => source.raw_poll_enabled == null || Number(source.raw_poll_enabled) !== 0;

/** Calls per run: the source's own raw_calls_per_tick, else the estate default; sources with
 *  raw polling off keep the catalog-only cap. */
function callCap(source) {
  if (!rawEnabled(source)) return threshold('lm_metrics_data_calls_per_tick') || 300;
  const own = Number(source.raw_calls_per_tick);
  return own > 0 ? own : (threshold('lm_raw_calls_per_tick') || 600);
}

/**
 * Candidate device DataSources, oldest poll first. Raw mode (default): every row with
 * instances that is not the interface or neighbour tier; `entry` is the catalog entry
 * when its family is on (else null, the row is then raw-only) and `catalogEntry` is the
 * entry regardless of family. Raw off: only DataSources the catalog names, as before.
 */
function candidateRows(source) {
  const families = enabledFamilies(source);
  const raw = rawEnabled(source);
  const rows = db.prepare(`
    SELECT x.hds_id, x.lm_device_id, x.datasource_name, x.metrics_last_at, x.raw_last_at, d.display_name, d.name
    FROM lm_device_datasources x
    JOIN lm_devices d ON d.source_id = x.source_id AND d.lm_device_id = x.lm_device_id AND d.stale = 0
    WHERE x.source_id = ? AND COALESCE(x.instance_count, 0) > 0 AND COALESCE(x.stop_monitoring, 0) = 0
      AND COALESCE(x.is_interface, 0) = 0 AND COALESCE(x.is_neighbor, 0) = 0
    ORDER BY COALESCE(${raw ? 'x.raw_last_at, ' : ''}x.metrics_last_at, '') ASC, x.hds_id
  `).all(source.id);
  const out = [];
  for (const r of rows) {
    const catalogEntry = catalogFor(r.datasource_name);
    const familyOn = !!catalogEntry && !(families && !families.has(catalogEntry.family));
    if (!raw && !familyOn) continue;
    out.push({ ...r, entry: familyOn ? catalogEntry : null, catalogEntry });
  }
  return out;
}

const storeResult = db.transaction((source, cand, parsed, nowIso) => {
  const { entry } = cand;
  const sid = source.id;
  const dev = cand.lm_device_id;
  const hds = cand.hds_id;
  const max = entry.maxInstances || DEFAULT_MAX_INSTANCES;
  let instances = parsed.instances;
  if (instances.length > max) {
    logger.warn(`[LmMetrics] ${cand.display_name || dev} ${cand.datasource_name}: ${instances.length} instances, keeping ${max}`);
    instances = instances.slice(0, max);
  }
  const upInst = db.prepare(`
    INSERT INTO lm_ds_instances (source_id, lm_device_id, hds_id, datasource_name, family, instance_key, instance_name, stale, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, 0, datetime('now'))
    ON CONFLICT(source_id, lm_device_id, hds_id, instance_key) DO UPDATE SET
      datasource_name = excluded.datasource_name, family = excluded.family, instance_name = excluded.instance_name,
      stale = 0, updated_at = datetime('now')
  `);
  const getEpoch = db.prepare('SELECT sampled_at_epoch e FROM lm_ds_metrics WHERE source_id = ? AND lm_device_id = ? AND hds_id = ? AND instance_key = ? AND metric = ?');
  const upMetric = db.prepare(`
    INSERT INTO lm_ds_metrics (source_id, lm_device_id, hds_id, datasource_name, family, instance_key, metric, datapoint, value, sampled_at_epoch, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))
    ON CONFLICT(source_id, lm_device_id, hds_id, instance_key, metric) DO UPDATE SET
      datasource_name = excluded.datasource_name, family = excluded.family, datapoint = excluded.datapoint,
      value = excluded.value, sampled_at_epoch = excluded.sampled_at_epoch, updated_at = datetime('now')
  `);
  const insHist = db.prepare('INSERT INTO lm_ds_metrics_history (source_id, lm_device_id, hds_id, instance_key, metric, value, sampled_at_epoch) VALUES (?, ?, ?, ?, ?, ?, ?)');
  const seen = [];
  let written = 0;
  for (const inst of instances) {
    seen.push(inst.key);
    upInst.run(sid, dev, hds, cand.datasource_name, entry.family, inst.key, inst.name);
    for (const [metric, l] of Object.entries(inst.latest)) {
      const stored = getEpoch.get(sid, dev, hds, inst.key, metric)?.e;
      if (stored == null || l.epoch >= stored) {
        upMetric.run(sid, dev, hds, cand.datasource_name, entry.family, inst.key, metric, l.datapoint, l.value, l.epoch);
        written += 1;
      }
      if (entry.history) {
        const floor = stored == null ? -1 : stored;
        const fresh = inst.samples.filter((s) => s.metric === metric && s.epoch > floor).sort((a, b) => a.epoch - b.epoch);
        for (const s of fresh) insHist.run(sid, dev, hds, inst.key, metric, s.value, s.epoch);
      }
    }
  }
  // A body with an instances object is authoritative for this DataSource:
  // anything it no longer lists goes stale.
  if (parsed.hasInstances) {
    db.prepare(`
      UPDATE lm_ds_instances SET stale = 1, updated_at = datetime('now')
      WHERE source_id = ? AND lm_device_id = ? AND hds_id = ? AND stale = 0
        AND instance_key NOT IN (SELECT value FROM json_each(?))
    `).run(sid, dev, hds, JSON.stringify(seen));
  }
  db.prepare('UPDATE lm_device_datasources SET metrics_last_at = ?, metrics_last_error = NULL WHERE source_id = ? AND hds_id = ?')
    .run(nowIso, sid, hds);
  return written;
});

/** Pure: instance key -> readable name from normalized instances ("SSID: X" descriptions lose the label). */
function instanceNameMap(instances, dsName) {
  const out = new Map();
  for (const i of Array.isArray(instances) ? instances : []) {
    const key = cleanInstanceKey(i.instanceName || i.displayName || '', dsName);
    const desc = String(i.description || '').replace(/^\s*SSID:\s*/i, '').trim();
    if (key && desc) out.set(key, desc);
  }
  return out;
}

function markFailed(sourceId, hdsId, message, nowIso) {
  // metrics_last_at moves on failure too so a permanently failing DataSource
  // goes to the back of the queue instead of eating a slot every run.
  db.prepare('UPDATE lm_device_datasources SET metrics_last_at = ?, metrics_last_error = ? WHERE source_id = ? AND hds_id = ?')
    .run(nowIso, String(message).slice(0, 500), sourceId, hdsId);
}

/** Same back-of-queue rule for the raw tier: raw_last_at moves on with the error. */
function markRawFailed(sourceId, hdsId, message, nowIso) {
  db.prepare('UPDATE lm_device_datasources SET raw_last_at = ?, raw_last_error = ? WHERE source_id = ? AND hds_id = ?')
    .run(nowIso, String(message).slice(0, 500), sourceId, hdsId);
}

// A catalog correction leaves lm_ds_metrics rows written under the old pick (the Identity
// Services page kept showing mem_used kilobytes as a percent for hours after the fix). On
// a version change every stored row whose datapoint is not what the corrected catalog would
// pick from the DataSource's known datapoint list is deleted; the sweep refills the metric
// and the pages show a dash meanwhile. DataSources whose datapoint list is unknown keep
// their rows.
function purgeStaleMetrics(sourceId) {
  let purged = 0;
  try {
    const names = db.prepare('SELECT DISTINCT datasource_name FROM lm_ds_metrics WHERE source_id = ?').all(sourceId).map((r) => r.datasource_name);
    const dpStmt = db.prepare('SELECT datapoint FROM lm_ds_datapoints WHERE source_id = ? AND datasource_name = ?');
    const rowsStmt = db.prepare('SELECT id, metric, datapoint FROM lm_ds_metrics WHERE source_id = ? AND datasource_name = ?');
    const del = db.prepare('DELETE FROM lm_ds_metrics WHERE id = ?');
    const txn = db.transaction(() => {
      for (const name of names) {
        const entry = catalogFor(name);
        const dps = dpStmt.all(sourceId, name).map((r) => r.datapoint);
        if (entry && !dps.length) continue;
        let learned = {};
        if (entry) {
          try { learned = parseDsBody({ dataPoints: dps, instances: {} }, entry).learned || {}; } catch { learned = {}; }
        }
        for (const r of rowsStmt.all(sourceId, name)) {
          if (entry && learned[r.metric] && learned[r.metric] === r.datapoint) continue;
          del.run(r.id);
          purged += 1;
        }
      }
    });
    txn();
  } catch (err) {
    logger.warn(`[LmMetrics] stale metric purge skipped: ${err.message}`);
  }
  return purged;
}

async function pollMetrics(source) {
  const now = nowSec();
  const nowIso = new Date(now * 1000).toISOString().slice(0, 19).replace('T', ' ');
  const pollMin = Math.max(1, Number(source.metrics_poll_minutes) || 30);
  const raw = rawEnabled(source);
  const cap = callCap(source);
  const all = candidateRows(source);
  const batch = all.slice(0, cap);
  let features = readFeatures(source.id);
  // A catalog corrected since the last poll invalidates every learned map: drop
  // them so this poll relearns with the new matchers, then stamp the version.
  if (features.catalogVersion !== CATALOG_VERSION) {
    features = mergeFeatures(source.id, { dsColumns: {}, dsUnmatched: {}, catalogVersion: CATALOG_VERSION });
    const purged = purgeStaleMetrics(source.id);
    if (purged) logger.info(`[LmMetrics] ${source.name}: catalog ${CATALOG_VERSION}, purged ${purged} stored value(s) written under old picks`);
  }
  const dsColumns = { ...(features.dsColumns || {}) };
  const dsUnmatched = { ...(features.dsUnmatched || {}) };
  let ok = 0;
  let failed = 0;
  let written = 0;
  let rawDs = 0;
  let rawValues = 0;
  let lastErr = null;

  const inFlight = callsInFlight('logicmonitor');
  const startedAt = Date.now();

  const fail = (cand, err) => {
    failed += 1;
    lastErr = safeMsg(err);
    logger.warn(`[LmMetrics] ${cand.display_name || cand.lm_device_id} ${cand.datasource_name} failed: ${lastErr}`);
    try { markFailed(source.id, cand.hds_id, lastErr, nowIso); } catch { /* row may be gone */ }
    if (raw) { try { markRawFailed(source.id, cand.hds_id, lastErr, nowIso); } catch { /* row may be gone */ } }
  };

  // Network stage: only the calls run concurrently. The learned map is read here to
  // narrow the request, and the same value is carried to the store stage so the body
  // is parsed against the columns it was requested with.
  const fetchStage = async (cand) => {
    let known = cand.entry ? dsColumns[cand.datasource_name] : null;
    // A mapping learned under an older catalog (metric keys it no longer defines) is relearned.
    if (known && typeof known === 'object' && Object.keys(known).some((k) => !cand.entry.metrics[k])) known = null;
    const knownNames = known && typeof known === 'object' ? [...new Set(Object.values(known))] : [];
    // Raw mode needs every datapoint, so it never narrows the call.
    const datapoints = !raw && knownNames.length ? knownNames.join(',') : null;
    const last = parseDbTime((raw ? cand.raw_last_at : null) || cand.metrics_last_at);
    const start = Math.max(last != null ? last - 300 : 0, now - 2 * pollMin * 60);
    const body = await lmApi.fetchDsData(source, cand.lm_device_id, cand.hds_id, { start, end: now, datapoints });
    let instanceRows = null;
    if (cand.entry?.instanceNames && body && typeof body.instances === 'object' && body.instances !== null && Object.keys(body.instances).length) {
      try {
        instanceRows = await lmApi.fetchInstances(source, cand.lm_device_id, cand.hds_id);
      } catch (err) {
        logger.debug(`[LmMetrics] ${cand.display_name || cand.lm_device_id} ${cand.datasource_name} instance names: ${safeMsg(err)}`);
      }
    }
    return { body, known, datapoints, instanceRows };
  };

  // Store stage: fully synchronous (better-sqlite3), so it runs to the end between two
  // awaits of the network stage. Two bodies of one DataSource therefore never race the
  // learned map; each body is one set of statements and rows are never written per call.
  const storeStage = (cand, { body, known, datapoints, instanceRows }) => {
    let learnedForRaw = known || dsColumns[cand.datasource_name] || {};
    let names = null;
    let catalogOk = true;
    if (cand.entry) {
      try {
        const parsed = parseDsBody(body, cand.entry, known || null, now);
        parsed.hasInstances = !!body && typeof body.instances === 'object' && body.instances !== null;
        if (instanceRows && parsed.instances.length) {
          const nm = instanceNameMap(instanceRows, cand.datasource_name);
          for (const inst of parsed.instances) if (nm.has(inst.key)) inst.name = nm.get(inst.key);
        }
        if (Array.isArray(body?.dataPoints) && body.dataPoints.length && (!datapoints || raw)
          && JSON.stringify(dsColumns[cand.datasource_name]) !== JSON.stringify(parsed.learned)) {
          dsColumns[cand.datasource_name] = parsed.learned;
          dsUnmatched[cand.datasource_name] = parsed.unmatched;
          features = mergeFeatures(source.id, { dsColumns, dsUnmatched });
        }
        written += storeResult(source, cand, parsed, nowIso);
        learnedForRaw = parsed.learned;
        names = new Map(parsed.instances.map((i) => [i.key, i.name]));
      } catch (err) {
        catalogOk = false;
        lastErr = safeMsg(err);
        logger.warn(`[LmMetrics] ${cand.display_name || cand.lm_device_id} ${cand.datasource_name} failed: ${lastErr}`);
        try { markFailed(source.id, cand.hds_id, lastErr, nowIso); } catch { /* row may be gone */ }
      }
    }
    if (raw) {
      try {
        const r = lmRaw.storeRawBody(db, source, cand, body, nowIso, { learned: learnedForRaw, names, nowEpoch: now });
        rawDs += 1;
        rawValues += r.values;
      } catch (err) {
        lastErr = safeMsg(err);
        logger.warn(`[LmMetrics] ${cand.display_name || cand.lm_device_id} ${cand.datasource_name} raw store failed: ${lastErr}`);
        try { markRawFailed(source.id, cand.hds_id, lastErr, nowIso); } catch { /* row may be gone */ }
      }
    }
    // The call succeeded; a catalog parse error alone counts as failed only when raw is off.
    if (catalogOk || raw) ok += 1; else failed += 1;
  };

  await mapLimit(batch, inFlight, async (cand) => {
    let fetched;
    try {
      fetched = await fetchStage(cand);
    } catch (err) {
      fail(cand, err);
      return;
    }
    try {
      storeStage(cand, fetched);
    } catch (err) {
      fail(cand, err);
    }
  });
  if (batch.length && ok === 0) throw new Error(`metric data failed on every DataSource (${failed}): ${lastErr}`);
  if (all.length > batch.length) {
    logger.info(`[LmMetrics] ${source.name}: ${all.length - batch.length} DataSource(s) deferred to the next run (cap ${cap})`);
  }
  const seconds = Math.round((Date.now() - startedAt) / 100) / 10;
  logger.info(`[LmMetrics] ${source.name}: ${ok} DataSource(s) polled${failed ? `, ${failed} failed` : ''}, ${written} metric value(s)${raw ? `, raw: ${rawDs} DataSources, ${rawValues} values` : ''}, in flight ${inFlight}, ${seconds} s`);
  return { ok, failed, candidates: all.length, polled: batch.length, written, rawDataSources: rawDs, rawValues, inFlight, seconds };
}

function pruneMetricsHistory(sourceId) {
  const days = threshold('lm_ds_history_days') || 14;
  db.prepare('DELETE FROM lm_ds_metrics_history WHERE source_id = ? AND sampled_at_epoch < ?').run(sourceId, nowSec() - days * 86400);
  const old = "stale = 1 AND updated_at < datetime('now', '-7 days')";
  db.prepare(`
    DELETE FROM lm_ds_metrics WHERE source_id = ? AND EXISTS (
      SELECT 1 FROM lm_ds_instances i WHERE i.source_id = lm_ds_metrics.source_id AND i.lm_device_id = lm_ds_metrics.lm_device_id
        AND i.hds_id = lm_ds_metrics.hds_id AND i.instance_key = lm_ds_metrics.instance_key AND i.${old})
  `).run(sourceId);
  db.prepare(`DELETE FROM lm_ds_instances WHERE source_id = ? AND ${old}`).run(sourceId);
  // Raw store (round 11): values of a device DataSource the inventory no longer lists, then
  // datapoint catalog rows nothing stores any more.
  db.prepare(`
    DELETE FROM lm_ds_values WHERE source_id = ? AND NOT EXISTS (
      SELECT 1 FROM lm_device_datasources x WHERE x.source_id = lm_ds_values.source_id AND x.hds_id = lm_ds_values.hds_id)
  `).run(sourceId);
  db.prepare(`
    DELETE FROM lm_ds_datapoints WHERE source_id = ? AND NOT EXISTS (
      SELECT 1 FROM lm_ds_values v WHERE v.source_id = lm_ds_datapoints.source_id
        AND v.datasource_name = lm_ds_datapoints.datasource_name AND v.datapoint = lm_ds_datapoints.datapoint)
  `).run(sourceId);
}

// -- Route-facing helpers ----------------------------------------------------------

/** Latest values for one device and family, grouped per instance:
 *  [{ datasource_name, hds_id, instance_key, instance_name, metrics: { metric: { value, datapoint, epoch } } }] */
function latestFor(sourceId, deviceId, family) {
  const rows = db.prepare(`
    SELECT m.datasource_name, m.hds_id, m.instance_key, m.metric, m.datapoint, m.value, m.sampled_at_epoch, i.instance_name
    FROM lm_ds_metrics m
    LEFT JOIN lm_ds_instances i ON i.source_id = m.source_id AND i.lm_device_id = m.lm_device_id
      AND i.hds_id = m.hds_id AND i.instance_key = m.instance_key
    WHERE m.source_id = ? AND m.lm_device_id = ? AND m.family = ? AND COALESCE(i.stale, 0) = 0
    ORDER BY m.datasource_name, m.instance_key, m.metric
  `).all(sourceId, deviceId, family);
  const groups = new Map();
  for (const r of rows) {
    const k = `${r.hds_id}\u0000${r.instance_key}`;
    if (!groups.has(k)) {
      groups.set(k, {
        datasource_name: r.datasource_name, hds_id: r.hds_id, instance_key: r.instance_key,
        instance_name: r.instance_name || r.instance_key, metrics: {},
      });
    }
    groups.get(k).metrics[r.metric] = { value: r.value, datapoint: r.datapoint, epoch: r.sampled_at_epoch };
  }
  return [...groups.values()];
}

/** Series for one instance metric, oldest first: [{ epoch, value }]. */
function historyFor(sourceId, deviceId, hdsId, instanceKey, metric, hours = 24) {
  const since = nowSec() - Math.max(1, Number(hours) || 24) * 3600;
  return db.prepare(`
    SELECT sampled_at_epoch epoch, value FROM lm_ds_metrics_history
    WHERE source_id = ? AND lm_device_id = ? AND hds_id = ? AND instance_key = ? AND metric = ? AND sampled_at_epoch >= ?
    ORDER BY sampled_at_epoch
  `).all(sourceId, deviceId, hdsId, instanceKey, metric, since);
}

module.exports = {
  purgeStaleMetrics,
  pollMetrics, pruneMetricsHistory, parseDsBody, latestFor, historyFor,
  // test seams
  candidateRows, matchDatapoint, instanceNameMap, rawEnabled, callCap,
};
