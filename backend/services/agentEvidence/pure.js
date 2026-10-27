// Pure Storage evidence (direct arrays): capacity now and over 30 days, the
// array's own alerts, hardware not ok, replication links, and a host's
// connections. Pure has no issue history table, so alert counts stand in.
const u = require('./util');

const platform = 'pure';
const OK = /^(ok|healthy|normal|connected|online|present|active|identified)$/i;

/** Array id from "a<arrayId>:<alertId>" (the synthetic pure1 keys do not match). */
function arrayIdOfKey(key) {
  const m = /^a(\d+):/.exec(String(key || ''));
  return m ? Number(m[1]) : null;
}

function findSubject(db, ctx, names) {
  for (const n of names) {
    const arr = u.one(db, 'SELECT * FROM pure_arrays WHERE lower(name) = lower(?) LIMIT 1', n);
    if (arr) return { arr, host: null };
    const h = u.one(db, 'SELECT * FROM pure_hosts WHERE lower(name) = lower(?) LIMIT 1', n);
    if (h) {
      const a = u.one(db, 'SELECT * FROM pure_arrays WHERE id = ?', h.array_id);
      if (a) return { arr: a, host: h };
    }
  }
  for (const al of u.alertsFor(ctx, platform)) {
    const a = u.one(db, 'SELECT * FROM pure_arrays WHERE id = ?', arrayIdOfKey(al.source_key));
    if (a) return { arr: a, host: null };
  }
  return null;
}

function run(db, ctx) {
  const sub = findSubject(db, ctx, u.subjectsFor(ctx, platform));
  if (!sub) return null;
  const { arr, host } = sub;
  const facts = u.emptyFacts();
  const lines = [];
  const now = Date.now();

  const latest = u.one(db, `SELECT capacity_bytes, used_bytes, purity_version, read_latency_us, write_latency_us FROM pure_metrics_history
    WHERE array_id = ? ORDER BY captured_at DESC LIMIT 1`, arr.id);
  const span = latest ? u.one(db, `SELECT MIN(used_bytes * 1.0 / capacity_bytes) lo, MAX(used_bytes * 1.0 / capacity_bytes) hi
    FROM pure_metrics_history WHERE array_id = ? AND capacity_bytes > 0 AND captured_at >= ?`, arr.id, u.zl(now - 30 * u.DAY_MS)) : null;
  const capNow = latest ? u.pctOf(latest.used_bytes, latest.capacity_bytes) : null;
  const lo = span && span.lo != null ? u.round1(span.lo * 100) : null;
  const hi = span && span.hi != null ? u.round1(span.hi * 100) : null;
  facts.metric = { name: 'capacity', now: capNow, avg30d: lo != null && hi != null ? u.round1((lo + hi) / 2) : null, max30d: hi, unit: '%' };

  const ms24 = u.windowStart(ctx);
  const ms30 = now - 30 * u.DAY_MS;
  const alerts = u.all(db, `SELECT severity, category, component_name, summary, state, created_at_ms FROM pure_alerts
    WHERE array_id = ? AND created_at_ms >= ? ORDER BY created_at_ms DESC LIMIT 300`, arr.id, ms30);
  const in24 = alerts.filter((a) => Number(a.created_at_ms) >= ms24);
  const cats24 = [...new Set(in24.map((a) => a.category).filter(Boolean))].slice(0, 3);

  const hw = [
    ...u.all(db, 'SELECT name, status FROM pure_hardware WHERE array_id = ? LIMIT 400', arr.id),
    ...u.all(db, 'SELECT name, status FROM pure_drives WHERE array_id = ? LIMIT 400', arr.id),
    ...u.all(db, 'SELECT name, status FROM pure_controllers WHERE array_id = ? LIMIT 50', arr.id),
  ].filter((r) => r.status && !OK.test(String(r.status).trim()));

  lines.push([
    `Pure array ${arr.name}${latest && latest.purity_version ? ` (purity ${latest.purity_version})` : ''}: capacity ${u.pctText(capNow)}${lo != null ? ` (30-day ${u.pctText(lo)} to ${u.pctText(hi)})` : ''}`,
    `${in24.length} alerts in 24 h${cats24.length ? ` (${cats24.join(', ')})` : ''}`,
    hw.length ? `hardware: ${hw.length} component(s) not ok (${hw.slice(0, 6).map((r) => `${r.name} ${r.status}`).join(', ')})` : 'hardware: all components ok',
  ].join(', '));
  facts.state = hw.length ? 'degraded' : 'ok';

  for (const a of in24.slice(0, 3)) lines.push(`Pure alert ${u.fmtT(a.created_at_ms)} ${a.severity || ''} ${a.category || ''}${a.component_name ? ` on ${a.component_name}` : ''}: ${u.clip(a.summary, 120)}`);
  if (alerts.length > in24.length) {
    const by = {};
    for (const a of alerts) by[a.category || 'other'] = (by[a.category || 'other'] || 0) + 1;
    lines.push(`Alerts on ${arr.name} in 30 days: ${alerts.length} (${Object.entries(by).sort((x, y) => y[1] - x[1]).slice(0, 4).map(([k, v]) => `${k} ${v}`).join(', ')})`);
  }
  facts.openedTimes30d = alerts.length || null;

  if (host) {
    const vols = u.one(db, 'SELECT COUNT(DISTINCT volume_name) n FROM pure_connections WHERE array_id = ? AND lower(host_name) = lower(?)', arr.id, host.name);
    lines.push(`Pure host ${host.name}: ${host.connection_count != null ? `${host.connection_count} connections, ` : ''}${vols ? vols.n : 0} volumes connected${host.protocol ? `, protocol ${host.protocol}` : ''}`);
  }

  const groups = u.one(db, 'SELECT COUNT(*) n, SUM(CASE WHEN replication_enabled = 1 THEN 1 ELSE 0 END) r FROM pure_protection_groups WHERE array_id = ? AND destroyed = 0', arr.id);
  const links = u.all(db, 'SELECT remote_name, status, type FROM pure_array_connections WHERE array_id = ? LIMIT 10', arr.id);
  const badLinks = links.filter((l) => l.status && !OK.test(String(l.status).trim()));
  if (groups && groups.n) {
    lines.push(`Protection on ${arr.name}: ${groups.n} protection groups (${groups.r || 0} replicating)${links.length ? `, ${links.length} replication link(s)${badLinks.length ? `, not connected: ${badLinks.slice(0, 3).map((l) => `${l.remote_name} ${l.status}`).join(', ')}` : ', all connected'}` : ''}`);
    facts.protection = { kind: 'pure', lastGoodAt: null, lastRunStatus: null };
  }
  if (links.length) facts.replication = { kind: 'pure', lagMinutes: null, status: badLinks.length ? badLinks[0].status : 'connected' };

  return u.makeBlock(platform, host ? host.name : arr.name, `Pure array ${arr.name}`, lines, facts);
}

module.exports = { platform, run };
