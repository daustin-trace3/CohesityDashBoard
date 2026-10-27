// NetApp evidence (ONTAP clusters): fullness of aggregates and volumes,
// SnapMirror health and lag, LIFs and nodes not up, the cluster's current
// alerts and its 30-day capacity span. netapp_alerts is rewritten each poll, so
// it shows what is open now rather than a history.
const u = require('./util');

const platform = 'netapp';

function arrayIdOfKey(key) {
  const m = /^a(\d+):/.exec(String(key || ''));
  return m ? Number(m[1]) : null;
}

function findSubject(db, ctx, names) {
  for (const n of names) {
    const arr = u.one(db, 'SELECT * FROM netapp_arrays WHERE lower(name) = lower(?) LIMIT 1', n);
    if (arr) return { arr };
    const node = u.one(db, 'SELECT array_id, name FROM netapp_nodes WHERE lower(name) = lower(?) LIMIT 1', n);
    if (node) { const a = u.one(db, 'SELECT * FROM netapp_arrays WHERE id = ?', node.array_id); if (a) return { arr: a, node: node.name }; }
    const vol = u.one(db, 'SELECT * FROM netapp_volumes WHERE lower(name) = lower(?) LIMIT 1', n);
    if (vol) { const a = u.one(db, 'SELECT * FROM netapp_arrays WHERE id = ?', vol.array_id); if (a) return { arr: a, vol }; }
  }
  for (const al of u.alertsFor(ctx, platform)) {
    const a = u.one(db, 'SELECT * FROM netapp_arrays WHERE id = ?', arrayIdOfKey(al.source_key));
    if (a) return { arr: a };
  }
  return null;
}

function run(db, ctx) {
  const sub = findSubject(db, ctx, u.subjectsFor(ctx, platform));
  if (!sub) return null;
  const arr = sub.arr;
  const facts = u.emptyFacts();
  const lines = [];

  const latest = u.one(db, 'SELECT total_bytes, used_bytes, ontap_version, read_latency_us FROM netapp_metrics_history WHERE array_id = ? ORDER BY captured_at DESC LIMIT 1', arr.id);
  const span = u.one(db, `SELECT MIN(used_bytes * 1.0 / total_bytes) lo, MAX(used_bytes * 1.0 / total_bytes) hi FROM netapp_metrics_history
    WHERE array_id = ? AND total_bytes > 0 AND captured_at >= ?`, arr.id, u.zl(Date.now() - 30 * u.DAY_MS));
  const capNow = latest ? u.pctOf(latest.used_bytes, latest.total_bytes) : null;
  const lo = span && span.lo != null ? u.round1(span.lo * 100) : null;
  const hi = span && span.hi != null ? u.round1(span.hi * 100) : null;
  facts.metric = { name: 'capacity', now: capNow, avg30d: lo != null && hi != null ? u.round1((lo + hi) / 2) : null, max30d: hi, unit: '%' };

  const aggr = u.all(db, 'SELECT name, used_percent FROM netapp_aggregates WHERE array_id = ? AND used_percent >= 80 ORDER BY used_percent DESC LIMIT 4', arr.id);
  const vols = u.all(db, `SELECT name, svm_name, used_percent FROM netapp_volumes WHERE array_id = ? AND used_percent >= 90
    ORDER BY used_percent DESC LIMIT 4`, arr.id);
  const version = (latest && latest.ontap_version) || arr.version;
  const head = `NetApp cluster ${arr.name}${version ? ` (ONTAP ${version})` : ''}`;
  const parts = [
    capNow != null ? `capacity ${u.pctText(capNow)}${lo != null ? ` (30-day ${u.pctText(lo)} to ${u.pctText(hi)})` : ''}` : null,
    aggr.length ? `aggregates over 80%: ${aggr.map((a) => `${a.name} ${u.pctText(a.used_percent)}`).join(', ')}` : 'no aggregate over 80%',
    vols.length ? `volumes over 90%: ${vols.map((v) => `${v.name} (${u.pctText(v.used_percent)})`).join(', ')}` : null,
  ];
  lines.push(`${head}: ${parts.filter(Boolean).join(', ')}`);

  if (sub.vol) {
    const v = sub.vol;
    lines.push(`Volume ${v.name}${v.svm_name ? ` on SVM ${v.svm_name}` : ''}${v.aggregate_name ? `, aggregate ${v.aggregate_name}` : ''}: ${v.state || 'state unknown'}, ${u.pctText(v.used_percent)} used${v.files_used != null && v.files_maximum ? `, inodes ${u.pctText(u.pctOf(v.files_used, v.files_maximum))}` : ''}`);
  }

  const nodesBad = u.all(db, 'SELECT name, state FROM netapp_nodes WHERE array_id = ? LIMIT 50', arr.id)
    .filter((n) => n.state && !/^(up|online|ok|healthy)$/i.test(String(n.state).trim()));
  const lifsBad = u.all(db, 'SELECT name, svm_name, state, enabled FROM netapp_lifs WHERE array_id = ? LIMIT 500', arr.id)
    .filter((l) => (l.state && /down/i.test(String(l.state))) || l.enabled === 0);
  const down = [];
  if (nodesBad.length) down.push(`nodes not up: ${nodesBad.slice(0, 6).map((n) => `${n.name} ${n.state}`).join(', ')}`);
  if (lifsBad.length) down.push(`LIFs down: ${lifsBad.slice(0, 6).map((l) => l.name).join(', ')}`);
  if (down.length) lines.push(`${arr.name} ${down.join('; ')}`);
  facts.state = nodesBad.length || lifsBad.length ? 'degraded' : 'ok';

  const mirrors = u.all(db, `SELECT source_path, destination_path, healthy, lag_seconds, transfer_state, state, last_transfer_end FROM netapp_snapmirror
    WHERE array_id = ? ORDER BY (healthy = 1) ASC, lag_seconds DESC LIMIT 4`, arr.id);
  for (const m of mirrors.slice(0, 3)) {
    const ok = m.healthy === 1 || m.healthy === true;
    lines.push(`SnapMirror ${m.source_path} -> ${m.destination_path}: lag ${u.secondsText(m.lag_seconds)}, healthy ${ok ? 'yes' : 'no'}${!ok && m.transfer_state ? ` (${m.transfer_state})` : ''}`);
  }
  if (mirrors.length) {
    const worst = mirrors[0];
    facts.replication = { kind: 'snapmirror', lagMinutes: worst.lag_seconds != null ? Math.round(worst.lag_seconds / 60) : null, status: worst.healthy === 1 ? 'healthy' : 'unhealthy' };
  }

  const alerts = u.all(db, 'SELECT severity, node_name, source, message, captured_at FROM netapp_alerts WHERE array_id = ? ORDER BY id DESC LIMIT 50', arr.id);
  if (alerts.length) {
    const by = {};
    for (const a of alerts) by[String(a.severity || 'unknown').toLowerCase()] = (by[String(a.severity || 'unknown').toLowerCase()] || 0) + 1;
    lines.push(`${alerts.length} alerts open on ${arr.name} (${Object.entries(by).map(([k, v]) => `${v} ${k}`).join(', ')})`);
    for (const a of alerts.slice(0, 3)) lines.push(`NetApp alert ${a.severity || ''}${a.node_name ? ` on ${a.node_name}` : ''}${a.source ? ` (${a.source})` : ''}: ${u.clip(a.message, 120)}`);
  }
  return u.makeBlock(platform, sub.vol ? sub.vol.name : arr.name, `NetApp cluster ${arr.name}`, lines, facts);
}

module.exports = { platform, run };
