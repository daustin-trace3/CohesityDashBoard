// LogicMonitor raw DataSource ingestion (round 11, WP-R). The catalog (regex-labelled
// metrics) only reads DataSources it names; this module stores EVERY datapoint of every
// instance the metrics tier fetches, as the last non-null sample of the window, so the
// ICC database holds the whole LM picture and the catalog work queue is visible
// (lm_ds_datapoints.catalog_metric is null where the catalog has no pick).
//
// Pure of the db singleton: every function takes the database handle, so tests use their
// own. Datapoint names are whatever the portal returns; nothing here assumes a name.
const { cleanInstanceKey } = require('./logicmonitorCatalog');

// One device can carry thousands of instances of one DataSource (F5_GTM_VIPs- has 6,572 on
// a single live device). Past this many the first N by instance name are kept and the
// rest are named in raw_last_error, so a runaway DataSource cannot grow the table without
// bound or stall a tick.
const RAW_MAX_INSTANCES = 2000;
const RAW_STORE_CHUNK = 200;           // instances per write transaction

const cellNum = (v) => (typeof v === 'number' && Number.isFinite(v) ? v
  : (typeof v === 'string' && v.trim() !== '' && Number.isFinite(Number(v)) ? Number(v) : null));

/** LM renders "no data" as null or the literal text "No Data". */
const isNoData = (v) => v == null || v === '' || (typeof v === 'string' && /^\s*no\s*data\s*$/i.test(v));

const epochOf = (t, fallback) => {
  const n = cellNum(t);
  if (n == null) return fallback;
  return n > 1e11 ? Math.floor(n / 1000) : Math.floor(n);
};

function parseJson(v, fallback) {
  if (v == null || v === '') return fallback;
  try { const p = JSON.parse(v); return p == null ? fallback : p; } catch { return fallback; }
}

/** Set of "DataSource:datapoint" keys the user asked to keep history for. */
function historySetOf(source) {
  const list = parseJson(source && source.raw_history_json, []);
  return new Set(Array.isArray(list) ? list.map(String) : []);
}

/**
 * Pure: reduce one data body to the latest non-null sample per instance and datapoint.
 *   returns { names[], instances: [{ key, name, points: [{ datapoint, value, valueText, epoch, samples: [{epoch,value}] }] }], total }
 * `samples` carries every numeric sample of the window (history opt-in only reads it).
 */
function parseRawBody(body, dsName, nowEpoch) {
  const names = Array.isArray(body && body.dataPoints) ? body.dataPoints.map(String) : [];
  const out = { names, instances: [], total: 0 };
  if (!names.length || !body || typeof body.instances !== 'object' || body.instances === null) return out;
  const dsLabel = (body.dataSourceName || dsName || '');
  const byKey = new Map();
  for (const [rawKey, series] of Object.entries(body.instances)) {
    const key = cleanInstanceKey(rawKey, dsLabel);
    const values = Array.isArray(series && series.values) ? series.values : [];
    const times = Array.isArray(series && series.time) ? series.time : [];
    const points = [];
    for (let c = 0; c < names.length; c += 1) {
      let best = null;
      const samples = [];
      for (let i = 0; i < values.length; i += 1) {
        const row = values[i];
        if (!Array.isArray(row)) continue;
        const raw = row[c];
        if (isNoData(raw)) continue;
        const epoch = epochOf(times[i], nowEpoch);
        const n = cellNum(raw);
        if (n != null) samples.push({ epoch, value: n });
        if (!best || epoch >= best.epoch) best = { epoch, n, text: n == null ? String(raw).slice(0, 500) : null };
      }
      if (best) points.push({ datapoint: names[c], value: best.n, valueText: best.text, epoch: best.epoch, samples });
    }
    byKey.set(key, { key, name: key, points });
  }
  out.total = byKey.size;
  out.instances = [...byKey.values()].sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
  return out;
}

const utcDayOf = (epochSec) => new Date(epochSec * 1000).toISOString().slice(0, 10);

/**
 * Prepared daily rollup upsert (lm_ds_daily): one row per object per UTC day holding
 * samples, min, sum, max and last. Returns run(sid, dev, hds, ds, instanceKey, metric, kind, value, epoch).
 */
function dailyUpserter(dbh) {
  const st = dbh.prepare(`
    INSERT INTO lm_ds_daily (source_id, lm_device_id, hds_id, datasource_name, instance_key, metric, kind, day,
      samples, min_value, sum_value, max_value, last_value, last_epoch)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?, ?, ?)
    ON CONFLICT(source_id, lm_device_id, hds_id, instance_key, metric, day) DO UPDATE SET
      samples = samples + 1,
      min_value = min(coalesce(min_value, excluded.min_value), excluded.min_value),
      sum_value = coalesce(sum_value, 0) + excluded.sum_value,
      max_value = max(coalesce(max_value, excluded.max_value), excluded.max_value),
      datasource_name = excluded.datasource_name,
      last_value = excluded.last_value, last_epoch = excluded.last_epoch
  `);
  return (sid, dev, hds, ds, instanceKey, metric, kind, value, epoch) => {
    if (typeof value !== 'number' || !Number.isFinite(value) || !Number.isFinite(epoch)) return;
    st.run(sid, dev, hds, ds, instanceKey, metric, kind, utcDayOf(epoch), value, value, value, value, epoch);
  };
}

/** Set of "DataSource:datapoint" pairs named by enabled raw rules (opts.dailyRawKeys of storeRawBody). */
function rawRuleKeySet(rulesText) {
  const out = new Set();
  try {
    for (const r of require('./logicmonitorRawRules').parseRules(rulesText)) {
      if (r.enabled) out.add(`${r.datasource}:${r.datapoint}`);
    }
  } catch { /* no rules */ }
  return out;
}

/**
 * Store one fetched body for one device DataSource (cand = candidateRows row).
 *   opts.learned  { metric: datapoint } of the catalog picks for this DataSource (labels coverage)
 *   opts.names    Map(instanceKey -> readable name) from the instance list, optional
 *   opts.nowEpoch seconds, defaults to now
 * Replaces the hds's rows: instances the body no longer lists are deleted. Returns
 * { instances, values, capped, total }. Throws only on a database error.
 */
function storeRawBody(dbh, source, cand, body, nowIso, opts = {}) {
  const nowEpoch = opts.nowEpoch || Math.floor(Date.now() / 1000);
  const sid = source.id;
  const dev = cand.lm_device_id;
  const hds = cand.hds_id;
  const ds = cand.datasource_name;
  const parsed = parseRawBody(body, ds, nowEpoch);
  const hasInstances = !!body && typeof body.instances === 'object' && body.instances !== null;
  const history = historySetOf(source);
  const learnedByDp = new Map(Object.entries(opts.learned || {}).map(([metric, dp]) => [dp, metric]));
  let instances = parsed.instances;
  let capped = 0;
  if (instances.length > RAW_MAX_INSTANCES) {
    capped = instances.length;
    instances = instances.slice(0, RAW_MAX_INSTANCES);
  }

  const upVal = dbh.prepare(`
    INSERT INTO lm_ds_values (source_id, lm_device_id, hds_id, datasource_name, instance_key, instance_name, datapoint, value, value_text, sampled_at_epoch, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(source_id, lm_device_id, hds_id, instance_key, datapoint) DO UPDATE SET
      datasource_name = excluded.datasource_name, instance_name = excluded.instance_name, value = excluded.value,
      value_text = excluded.value_text, sampled_at_epoch = excluded.sampled_at_epoch, updated_at = excluded.updated_at
  `);
  const insHist = dbh.prepare('INSERT INTO lm_ds_metrics_history (source_id, lm_device_id, hds_id, instance_key, metric, value, sampled_at_epoch) VALUES (?, ?, ?, ?, ?, ?, ?)');
  // Daily history only for datapoints a raw rule names (opts.dailyRawKeys, built once per sweep).
  const dailyKeys = opts.dailyRawKeys instanceof Set ? opts.dailyRawKeys : null;
  const upDaily = dailyKeys && dailyKeys.size ? dailyUpserter(dbh) : null;
  const getStored = upDaily ? dbh.prepare('SELECT sampled_at_epoch e FROM lm_ds_values WHERE source_id = ? AND lm_device_id = ? AND hds_id = ? AND instance_key = ? AND datapoint = ?') : null;

  // Every history floor of this (source, device, hds) in one read, before any
  // write lock is taken. Key: instance_key + '|' + metric.
  const floors = new Map();
  if (history.size) {
    for (const r of dbh.prepare('SELECT instance_key, metric, MAX(sampled_at_epoch) e FROM lm_ds_metrics_history WHERE source_id = ? AND lm_device_id = ? AND hds_id = ? GROUP BY instance_key, metric').all(sid, dev, hds)) {
      floors.set(`${r.instance_key}|${r.metric}`, r.e);
    }
  }

  const storeChunk = dbh.transaction((chunk) => {
    let n = 0;
    for (const inst of chunk) {
      const name = (opts.names && opts.names.get(inst.key)) || inst.name;
      for (const p of inst.points) {
        const rollDaily = upDaily && p.value != null && dailyKeys.has(`${ds}:${p.datapoint}`);
        const prevEpoch = rollDaily ? getStored.get(sid, dev, hds, inst.key, p.datapoint)?.e : null;
        upVal.run(sid, dev, hds, ds, inst.key, name, p.datapoint, p.value, p.valueText, p.epoch, nowIso);
        n += 1;
        if (rollDaily && (prevEpoch == null || p.epoch > prevEpoch)) {
          upDaily(sid, dev, hds, ds, inst.key, p.datapoint, 'raw', p.value, p.epoch);
        }
        if (p.value != null && history.has(`${ds}:${p.datapoint}`)) {
          const metric = `raw:${p.datapoint}`;
          const floor = floors.get(`${inst.key}|${metric}`);
          const fresh = p.samples.filter((s) => floor == null || s.epoch > floor).sort((a, b) => a.epoch - b.epoch);
          for (const s of fresh) insHist.run(sid, dev, hds, inst.key, metric, s.value, s.epoch);
        }
      }
    }
    return n;
  });
  // Chunked so the write lock is released between 200-instance slices; a
  // 5,000-instance DataSource used to hold it for the whole body.
  let values = 0;
  for (let i = 0; i < instances.length; i += RAW_STORE_CHUNK) {
    values += storeChunk(instances.slice(i, i + RAW_STORE_CHUNK));
  }
  dbh.transaction(() => {
    if (hasInstances) {
      dbh.prepare(`
        DELETE FROM lm_ds_values WHERE source_id = ? AND lm_device_id = ? AND hds_id = ?
          AND instance_key NOT IN (SELECT value FROM json_each(?))
      `).run(sid, dev, hds, JSON.stringify(instances.map((i) => i.key)));
    }
    refreshDatapoints(dbh, sid, ds, learnedByDp, nowIso);
    dbh.prepare('UPDATE lm_device_datasources SET raw_last_at = ?, raw_last_error = ? WHERE source_id = ? AND hds_id = ?')
      .run(nowIso, capped ? `capped ${capped} to ${RAW_MAX_INSTANCES}` : null, sid, hds);
  })();
  return { instances: instances.length, values, capped, total: parsed.total };
}

/** Recompute the estate datapoint catalog rows of one DataSource from the stored values. */
function refreshDatapoints(dbh, sourceId, dsName, learnedByDp, nowIso) {
  const rows = dbh.prepare(`
    SELECT datapoint, COUNT(DISTINCT lm_device_id) devices, COUNT(DISTINCT lm_device_id || ':' || hds_id || ':' || instance_key) instances,
      MAX(CASE WHEN value IS NOT NULL THEN 1 ELSE 0 END) numeric
    FROM lm_ds_values WHERE source_id = ? AND datasource_name = ? GROUP BY datapoint
  `).all(sourceId, dsName);
  const up = dbh.prepare(`
    INSERT INTO lm_ds_datapoints (source_id, datasource_name, datapoint, devices, instances, numeric, first_seen, last_seen, catalog_metric)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(source_id, datasource_name, datapoint) DO UPDATE SET
      devices = excluded.devices, instances = excluded.instances, numeric = excluded.numeric,
      last_seen = excluded.last_seen, catalog_metric = excluded.catalog_metric
  `);
  for (const r of rows) up.run(sourceId, dsName, r.datapoint, r.devices, r.instances, r.numeric, nowIso, nowIso, learnedByDp.get(r.datapoint) || null);
  // A datapoint no stored value carries any more leaves the catalog.
  dbh.prepare(`
    DELETE FROM lm_ds_datapoints WHERE source_id = ? AND datasource_name = ?
      AND datapoint NOT IN (SELECT value FROM json_each(?))
  `).run(sourceId, dsName, JSON.stringify(rows.map((r) => r.datapoint)));
}

// -- Read side (routes) -----------------------------------------------------------

const sqlIso = (val) => {
  if (!val) return null;
  const str = String(val);
  const d = new Date(/[TZ]/.test(str) ? str : `${str.replace(' ', 'T')}Z`);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
};
const epochIso = (e) => (e == null || !Number.isFinite(Number(e)) || Number(e) <= 0 ? null : new Date(Number(e) * 1000).toISOString());
const likePat = (q) => `%${String(q).replace(/[%_\\]/g, '\\$&')}%`;

/** One device's DataSources with what the raw store holds for each. */
function deviceDatasources(dbh, catalog, sourceId, deviceId) {
  const stored = new Map();
  for (const r of dbh.prepare(`
    SELECT v.hds_id, COUNT(DISTINCT v.datapoint) datapoints, COUNT(DISTINCT v.instance_key) instances,
      COUNT(DISTINCT CASE WHEN p.catalog_metric IS NOT NULL THEN v.datapoint END) picks
    FROM lm_ds_values v
    LEFT JOIN lm_ds_datapoints p ON p.source_id = v.source_id AND p.datasource_name = v.datasource_name AND p.datapoint = v.datapoint
    WHERE v.source_id = ? AND v.lm_device_id = ? GROUP BY v.hds_id
  `).all(sourceId, deviceId)) stored.set(r.hds_id, r);
  return dbh.prepare(`
    SELECT hds_id, datasource_name, datasource_display_name, instance_count, is_interface, is_neighbor, raw_last_at, raw_last_error
    FROM lm_device_datasources WHERE source_id = ? AND lm_device_id = ? ORDER BY datasource_name
  `).all(sourceId, deviceId).map((x) => {
    const e = catalog.catalogFor(x.datasource_name);
    const st = stored.get(x.hds_id);
    return {
      hdsId: x.hds_id, datasourceName: x.datasource_name, displayName: x.datasource_display_name || x.datasource_name,
      instanceCount: x.instance_count || 0, family: e ? e.family : null,
      isInterface: !!x.is_interface, isNeighbor: !!x.is_neighbor,
      rawLastAt: sqlIso(x.raw_last_at), rawLastError: x.raw_last_error || null,
      datapoints: st ? st.datapoints : 0, instances: st ? st.instances : 0,
      coveragePct: st && st.datapoints ? Math.round((st.picks / st.datapoints) * 1000) / 10 : null,
    };
  });
}

/** One page of stored values for a device DataSource; label and unit come from the catalog for its picks. */
function dsValues(dbh, catalog, sourceId, deviceId, hdsId, { q = '', page = 1, limit = 25 } = {}) {
  const dsRow = dbh.prepare('SELECT datasource_name FROM lm_device_datasources WHERE source_id = ? AND hds_id = ?').get(sourceId, hdsId);
  const dsName = dsRow ? dsRow.datasource_name : null;
  const where = ['v.source_id = ?', 'v.lm_device_id = ?', 'v.hds_id = ?'];
  const args = [sourceId, deviceId, hdsId];
  if (q) {
    where.push("(v.instance_key LIKE ? ESCAPE '\\' OR v.instance_name LIKE ? ESCAPE '\\' OR v.datapoint LIKE ? ESCAPE '\\')");
    const pat = likePat(q);
    args.push(pat, pat, pat);
  }
  const total = dbh.prepare(`SELECT COUNT(*) n FROM lm_ds_values v WHERE ${where.join(' AND ')}`).get(...args).n;
  const lim = Math.max(1, Math.min(500, Number(limit) || 25));
  const pg = Math.max(1, Number(page) || 1);
  const rows = dbh.prepare(`
    SELECT v.instance_key, v.instance_name, v.datapoint, v.value, v.value_text, v.sampled_at_epoch, p.catalog_metric
    FROM lm_ds_values v
    LEFT JOIN lm_ds_datapoints p ON p.source_id = v.source_id AND p.datasource_name = v.datasource_name AND p.datapoint = v.datapoint
    WHERE ${where.join(' AND ')} ORDER BY v.instance_key, v.datapoint LIMIT ? OFFSET ?
  `).all(...args, lim, (pg - 1) * lim);
  const entry = dsName ? catalog.catalogFor(dsName) : null;
  const items = rows.map((r) => {
    const m = r.catalog_metric && entry && entry.metrics ? entry.metrics[r.catalog_metric] : null;
    return {
      instanceKey: r.instance_key, instanceName: r.instance_name || r.instance_key, datapoint: r.datapoint,
      value: r.value, valueText: r.value_text, sampledAt: epochIso(r.sampled_at_epoch),
      catalogMetric: r.catalog_metric || null,
      label: r.catalog_metric ? ((m && m.label) || r.catalog_metric) : null,
      unit: r.catalog_metric ? ((m && m.unit) || '') : null,
    };
  });
  return { items, total, page: pg, limit: lim };
}

/** Estate-wide: one row per DataSource name across portals. */
function estateDatasources(dbh, catalog) {
  const dps = new Map();
  for (const r of dbh.prepare(`
    SELECT datasource_name n, COUNT(*) datapoints, SUM(CASE WHEN catalog_metric IS NOT NULL THEN 1 ELSE 0 END) picks
    FROM (SELECT DISTINCT datasource_name, datapoint, catalog_metric FROM lm_ds_datapoints) GROUP BY datasource_name
  `).all()) dps.set(r.n, r);
  return dbh.prepare(`
    SELECT x.datasource_name name, MAX(x.datasource_display_name) displayName,
      COUNT(DISTINCT x.source_id || ':' || x.lm_device_id) devices, SUM(COALESCE(x.instance_count, 0)) instances,
      MAX(x.is_interface) isInterface, MAX(x.is_neighbor) isNeighbor, MAX(x.raw_last_at) rawLastAt,
      COUNT(DISTINCT CASE WHEN x.raw_last_at IS NOT NULL THEN x.source_id || ':' || x.lm_device_id END) polledDevices
    FROM lm_device_datasources x
    JOIN lm_devices d ON d.source_id = x.source_id AND d.lm_device_id = x.lm_device_id AND d.stale = 0
    WHERE COALESCE(x.instance_count, 0) > 0
    GROUP BY x.datasource_name ORDER BY instances DESC, name
  `).all().map((r) => {
    const e = catalog.catalogFor(r.name);
    const d = dps.get(r.name) || { datapoints: 0, picks: 0 };
    return {
      name: r.name, displayName: r.displayName || r.name, devices: r.devices, instances: r.instances,
      datapoints: d.datapoints, picks: d.picks || 0,
      coveragePct: d.datapoints ? Math.round(((d.picks || 0) / d.datapoints) * 1000) / 10 : null,
      family: e ? e.family : null, isInterface: !!r.isInterface, isNeighbor: !!r.isNeighbor,
      rawLastAt: sqlIso(r.rawLastAt), polledDevices: r.polledDevices,
    };
  });
}

/** Datapoint catalog rows of one DataSource with up to three sample values each. */
function datapointsFor(dbh, dsName) {
  const sample = dbh.prepare(`
    SELECT DISTINCT value v, value_text t FROM lm_ds_values
    WHERE datasource_name = ? AND datapoint = ? AND (value IS NOT NULL OR value_text IS NOT NULL) LIMIT 3
  `);
  const rows = dbh.prepare(`
    SELECT datapoint, SUM(devices) devices, SUM(instances) instances, MAX(numeric) numeric, MIN(first_seen) first_seen,
      MAX(last_seen) last_seen, MAX(catalog_metric) catalog_metric
    FROM lm_ds_datapoints WHERE datasource_name = ? GROUP BY datapoint ORDER BY datapoint
  `).all(dsName);
  return rows.map((r) => ({
    datapoint: r.datapoint, devices: r.devices, instances: r.instances, numeric: !!r.numeric,
    firstSeen: sqlIso(r.first_seen), lastSeen: sqlIso(r.last_seen), catalogMetric: r.catalog_metric || null,
    samples: sample.all(dsName, r.datapoint).map((x) => (x.v != null ? x.v : x.t)),
  }));
}

/** Discovery payload block. `metrics` supplies rawEnabled / callCap. */
function rawSummary(dbh, metrics) {
  const sources = dbh.prepare('SELECT * FROM lm_sources WHERE enabled = 1').all();
  const on = sources.filter((s) => metrics.rawEnabled(s));
  const callsPerTick = on.reduce((n, s) => n + metrics.callCap(s), 0);
  const candidates = dbh.prepare(`
    SELECT COUNT(*) n FROM lm_device_datasources x
    JOIN lm_devices d ON d.source_id = x.source_id AND d.lm_device_id = x.lm_device_id AND d.stale = 0
    WHERE COALESCE(x.instance_count, 0) > 0 AND COALESCE(x.stop_monitoring, 0) = 0
      AND COALESCE(x.is_interface, 0) = 0 AND COALESCE(x.is_neighbor, 0) = 0
  `).get().n;
  const cutoff = new Date(Date.now() - 86400000).toISOString().slice(0, 19).replace('T', ' ');
  const swept = dbh.prepare('SELECT COUNT(*) n FROM lm_device_datasources WHERE raw_last_at >= ?').get(cutoff).n;
  const dpAgg = dbh.prepare('SELECT COUNT(*) n, SUM(CASE WHEN catalog_metric IS NOT NULL THEN 1 ELSE 0 END) picks FROM lm_ds_datapoints').get();
  const minutes = on.length ? Math.max(1, Math.min(...on.map((s) => Number(s.metrics_poll_minutes) || 30))) : 30;
  return {
    enabled: on.length > 0, callsPerTick, candidates, sweptLast24h: swept,
    values: dbh.prepare('SELECT COUNT(*) n FROM lm_ds_values').get().n, datapoints: dpAgg.n,
    coveragePct: dpAgg.n ? Math.round(((dpAgg.picks || 0) / dpAgg.n) * 1000) / 10 : null,
    estSweepHours: callsPerTick ? Math.round((candidates / callsPerTick) * (minutes / 60) * 10) / 10 : null,
  };
}

module.exports = {
  RAW_MAX_INSTANCES, parseRawBody, storeRawBody, dailyUpserter, rawRuleKeySet, utcDayOf, refreshDatapoints, historySetOf, isNoData,
  deviceDatasources, dsValues, estateDatasources, datapointsFor, rawSummary,
};
