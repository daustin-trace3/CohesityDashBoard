// Interface reads for the connector feeds (Cisco derived platform): the interface list, one interface's history
// and the compare series, with the SAME row shapes as GET /logicmonitor/interfaces, /devices/:id/interfaces/:id/history
// and /interfaces/compare in routes/logicmonitor.js, scoped to the vendor's devices. Every function takes the
// database handle (pure of the db singleton) and is read-only.
const lmLb = require('./logicmonitorLoadBalancers');
const lmPath = require('./logicmonitorPath');
const lmIssues = require('./logicmonitorIssues');
const fleet = require('./logicmonitorFleet');

const { sqlIso, likePat } = lmLb;
const isoAgo = (ms) => new Date(Date.now() - ms).toISOString();
const epochIso = (v) => {
  if (v == null || v === '' || !Number.isFinite(Number(v)) || Number(v) <= 0) return null;
  const n = Number(v);
  return new Date(n > 1e11 ? n : n * 1000).toISOString();
};

const IF_SORTS = {
  deviceName: 'device_name', displayName: 'i.display_name', statusText: 'i.status_text', speedBps: 'i.speed_bps',
  inUtilPct: 'i.in_util_pct', outUtilPct: 'i.out_util_pct', inErrors: 'i.in_errors', outErrors: 'i.out_errors',
  inDiscards: 'i.in_discards', sampledAt: 'i.sampled_at_epoch',
  maxUtil: 'MAX(COALESCE(i.in_util_pct, 0), COALESCE(i.out_util_pct, 0))',
};
const SPEED_CLASSES = {
  '<=100M': 'i.speed_bps > 0 AND i.speed_bps <= 100000000',
  '1G': 'i.speed_bps > 100000000 AND i.speed_bps <= 1000000000',
  '10G': 'i.speed_bps > 1000000000 AND i.speed_bps <= 10000000000',
  '25G+': 'i.speed_bps > 10000000000',
  unknown: '(i.speed_bps IS NULL OR i.speed_bps <= 0)',
};
const IF_STATUS_SQL = "COALESCE(i.status_text, CASE WHEN i.status IS NULL THEN 'unknown' WHEN i.status = 1 THEN 'up' WHEN i.status = 2 THEN 'down' ELSE 'other' END)";
const IF_FROM = `
  FROM lm_interfaces i
  LEFT JOIN lm_devices d ON d.source_id = i.source_id AND d.lm_device_id = i.lm_device_id
`;

function statusTextOf(r) {
  if (r.status_text) return r.status_text;
  if (r.status == null) return 'unknown';
  return Number(r.status) === 1 ? 'up' : Number(r.status) === 2 ? 'down' : 'other';
}

function interfaceOut(r) {
  const ci = lmPath.circuitInfo(r.description, r.props_json);
  return {
    instanceId: r.instance_id, sourceId: r.source_id, deviceId: r.lm_device_id, deviceName: r.device_name || null,
    displayName: r.display_name, description: r.description, ifIndex: r.if_index, status: r.status, statusText: statusTextOf(r),
    speedBps: r.speed_bps, inMbps: r.in_mbps, outMbps: r.out_mbps, inErrors: r.in_errors, outErrors: r.out_errors,
    inDiscards: r.in_discards, outDiscards: r.out_discards, inUtilPct: r.in_util_pct, outUtilPct: r.out_util_pct,
    sampledAt: epochIso(r.sampled_at_epoch), alertStatus: r.alert_status, stopMonitoring: Number(r.stop_monitoring) === 1,
    siteKey: r.site_key || null, isWan: Number(r.is_wan) === 1, wanLabel: r.wan_label || null,
    alias: ci.alias, circuitId: ci.circuitId, carrier: ci.carrier,
  };
}

function interfaceFilters(q) {
  const t = lmIssues.getThresholds();
  const where = ['i.stale = 0'];
  const params = [];
  const keys = fleet.vendorKeysOf(q);
  if (keys) { where.push(`d.vendor_key IN (${keys.map(() => '?').join(',')})`); params.push(...keys); }
  if (q.q) {
    where.push("(i.display_name LIKE ? ESCAPE '\\' OR i.description LIKE ? ESCAPE '\\' OR i.instance_name LIKE ? ESCAPE '\\' OR d.display_name LIKE ? ESCAPE '\\')");
    const p = likePat(q.q);
    params.push(p, p, p, p);
  }
  if (q.deviceId != null && q.deviceId !== '') { where.push('i.lm_device_id = ?'); params.push(Number(q.deviceId)); }
  if (q.sourceId != null && q.sourceId !== '') { where.push('i.source_id = ?'); params.push(Number(q.sourceId)); }
  if (q.status) { where.push(`${IF_STATUS_SQL} = ?`); params.push(String(q.status)); }
  if (q.speedClass && SPEED_CLASSES[q.speedClass]) where.push(SPEED_CLASSES[q.speedClass]);
  if (q.vendor) { where.push("COALESCE(d.vendor, 'Unknown') = ?"); params.push(String(q.vendor)); }
  if (q.siteKey) { where.push('d.site_key = ?'); params.push(String(q.siteKey)); }
  if (String(q.wan) === '1') where.push('i.is_wan = 1');
  const since24 = isoAgo(24 * 3600 * 1000);
  switch (q.preset) {
    case 'down':
      where.push(`${IF_STATUS_SQL} = 'down' AND COALESCE(i.stop_monitoring, 0) = 0`);
      break;
    case 'hot':
      where.push('MAX(COALESCE(i.in_util_pct, 0), COALESCE(i.out_util_pct, 0)) >= ?');
      params.push(t.lm_if_util_warn_pct);
      break;
    case 'errors':
      where.push(`(SELECT COALESCE(SUM(COALESCE(h.in_errors, 0) + COALESCE(h.out_errors, 0)), 0) FROM lm_interface_history h
        WHERE h.source_id = i.source_id AND h.instance_id = i.instance_id AND datetime(h.captured_at) >= datetime(?)) > ?`);
      params.push(since24, t.lm_if_err_warn);
      break;
    case 'flapping':
      where.push(`(SELECT COUNT(*) FROM (
          SELECT h.status, LAG(h.status) OVER (ORDER BY datetime(h.captured_at), h.id) AS prev FROM lm_interface_history h
          WHERE h.source_id = i.source_id AND h.instance_id = i.instance_id AND datetime(h.captured_at) >= datetime(?)
        ) WHERE prev IS NOT NULL AND status IS NOT NULL AND status != prev) >= ?`);
      params.push(since24, t.lm_if_flap_warn);
      break;
    case 'unused':
      where.push(`${IF_STATUS_SQL} = 'up' AND (SELECT COUNT(*) FROM lm_interface_daily dd
        WHERE dd.source_id = i.source_id AND dd.instance_id = i.instance_id AND dd.day >= ?
          AND MAX(COALESCE(dd.max_in_util_pct, 0), COALESCE(dd.max_out_util_pct, 0)) < 1) >= 30`);
      params.push(new Date(Date.now() - 31 * 86400000).toISOString().slice(0, 10));
      break;
    default: break;
  }
  return { whereSql: `WHERE ${where.join(' AND ')}`, params };
}

/** { items, total, page, limit }: the GET /logicmonitor/interfaces answer for the vendor's devices. */
function interfaceList(dbh, p = {}) {
  const { whereSql, params } = interfaceFilters(p);
  const total = dbh.prepare(`SELECT COUNT(*) n ${IF_FROM} ${whereSql}`).get(...params).n;
  const limit = Math.min(500, Math.max(1, parseInt(p.limit, 10) || 50));
  const page = Math.max(1, parseInt(p.page, 10) || 1);
  const sortCol = IF_SORTS[p.sort] || 'device_name';
  const dir = p.dir === 'desc' ? 'DESC' : 'ASC';
  const rows = dbh.prepare(`
    SELECT i.*, d.display_name AS device_name, d.site_key AS site_key ${IF_FROM} ${whereSql}
    ORDER BY ${sortCol} ${dir} NULLS LAST, d.display_name, i.if_index, i.instance_id LIMIT ? OFFSET ?
  `).all(...params, limit, (page - 1) * limit);
  return { items: rows.map(interfaceOut), total, page, limit };
}

const historyPoint = (h) => ({
  at: sqlIso(h.captured_at), status: h.status, inMbps: h.in_mbps, outMbps: h.out_mbps, inErrors: h.in_errors,
  outErrors: h.out_errors, inDiscards: h.in_discards, outDiscards: h.out_discards, inUtilPct: h.in_util_pct, outUtilPct: h.out_util_pct,
});
function interfacePoints(dbh, sourceId, instanceId, hours) {
  return dbh.prepare(`
    SELECT * FROM lm_interface_history WHERE source_id = ? AND instance_id = ? AND datetime(captured_at) >= datetime(?)
    ORDER BY datetime(captured_at) ASC, id ASC
  `).all(sourceId, instanceId, isoAgo(hours * 3600 * 1000)).map(historyPoint);
}

/** { points, daily } for one interface (hours default 24, max 2160); empty arrays when the interface is unknown. */
function interfaceHistory(dbh, p = {}) {
  const instanceId = Number(p.instanceId); const deviceId = Number(p.deviceId);
  if (!Number.isFinite(instanceId) || !Number.isFinite(deviceId)) return { points: [], daily: [] };
  const args = [instanceId, deviceId];
  let extra = '';
  if (p.sourceId != null && p.sourceId !== '') { extra = ' AND source_id = ?'; args.push(Number(p.sourceId)); }
  const iface = dbh.prepare(`SELECT source_id FROM lm_interfaces WHERE instance_id = ? AND lm_device_id = ?${extra} LIMIT 1`).get(...args);
  if (!iface) return { points: [], daily: [] };
  const hours = Math.min(2160, Math.max(1, parseInt(p.hours, 10) || 24));
  const daily = dbh.prepare('SELECT * FROM lm_interface_daily WHERE source_id = ? AND instance_id = ? ORDER BY day DESC LIMIT 30')
    .all(iface.source_id, instanceId).reverse().map((d) => ({
      day: d.day, maxInUtilPct: d.max_in_util_pct, maxOutUtilPct: d.max_out_util_pct, flaps: d.flaps, errorsSum: d.errors_sum,
    }));
  return { points: interfacePoints(dbh, iface.source_id, instanceId, hours), daily };
}

/** { series } for 2 to 8 interface instance ids (ids array or comma string). */
function interfaceCompare(dbh, p = {}) {
  const raw = Array.isArray(p.ids) ? p.ids : String(p.ids || '').split(',');
  const ids = [...new Set(raw.map(Number).filter(Number.isFinite))].slice(0, 8);
  const hours = Math.min(2160, Math.max(1, parseInt(p.hours, 10) || 24));
  const series = [];
  for (const id of ids) {
    const args = [id];
    let extra = '';
    if (p.sourceId != null && p.sourceId !== '') { extra = ' AND i.source_id = ?'; args.push(Number(p.sourceId)); }
    const i = dbh.prepare(`SELECT i.*, d.display_name AS device_name, d.site_key AS site_key ${IF_FROM} WHERE i.instance_id = ?${extra} LIMIT 1`).get(...args);
    if (!i) continue;
    series.push({ instanceId: id, deviceName: i.device_name, displayName: i.display_name, points: interfacePoints(dbh, i.source_id, id, hours) });
  }
  return { series };
}

module.exports = { interfaceList, interfaceHistory, interfaceCompare, interfaceOut };
