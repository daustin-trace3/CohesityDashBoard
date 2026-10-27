// Cohesity evidence: a cluster (nodes, its own open alerts, protection runs,
// replication per target) or a protected object (group, last good backup,
// newest run). Reads the tables the Cohesity poller fills.
const u = require('./util');

const platform = 'cohesity';

function clusterById(db, id) {
  return u.one(db, 'SELECT * FROM clusters WHERE id = ? LIMIT 1', id);
}

/** Cluster id from a "c<clusterId>:<alertId>" source key. */
function clusterIdOfKey(key) {
  const m = /^c(\d+):/.exec(String(key || ''));
  return m ? Number(m[1]) : null;
}

function findSubject(db, ctx, names) {
  for (const n of names) {
    const cl = u.one(db, 'SELECT * FROM clusters WHERE lower(name) = lower(?) LIMIT 1', n);
    if (cl) return { kind: 'cluster', cluster: cl, name: cl.name };
    const obj = u.one(db, `SELECT * FROM cohesity_objects WHERE lower(name) = lower(?)
      ORDER BY COALESCE(last_backup_ms, 0) DESC, captured_at DESC LIMIT 1`, n);
    if (obj) return { kind: 'object', obj, name: obj.name, cluster: clusterById(db, obj.cluster_id) };
  }
  for (const a of u.alertsFor(ctx, platform)) {
    const cl = clusterById(db, clusterIdOfKey(a.source_key));
    if (cl) return { kind: 'cluster', cluster: cl, name: cl.name };
  }
  return null;
}

function replicationLines(db, cl, facts) {
  const rows = u.all(db, `SELECT target_cluster_name, status, start_time, end_time, lag_seconds FROM replication_runs
    WHERE cluster_id = ? ORDER BY start_time DESC LIMIT 80`, cl.id);
  const seen = new Set();
  const lines = [];
  for (const r of rows) {
    const t = r.target_cluster_name || 'unknown target';
    if (seen.has(t) || seen.size >= 3) continue;
    seen.add(t);
    const lagMin = r.lag_seconds != null ? Math.round(r.lag_seconds / 60) : null;
    lines.push(`Replication ${cl.name} -> ${t}: newest run ${r.status || 'unknown'} ${u.fmtT(r.end_time || r.start_time)}${lagMin != null ? `, lag ${u.minutesText(lagMin)}` : ''}`);
    if (!facts.replication) facts.replication = { kind: 'cohesity', lagMinutes: lagMin, status: r.status || null };
  }
  return lines;
}

function clusterBlock(db, ctx, sub) {
  const cl = sub.cluster;
  const facts = u.emptyFacts();
  const lines = [];
  const since = u.iso(u.windowStart(ctx));
  const nodes = u.all(db, 'SELECT hostname, status FROM cohesity_nodes WHERE cluster_id = ? LIMIT 100', cl.id);
  const bad = nodes.filter((n) => n.status && !/^(healthy|active|ok|online|up)$/i.test(String(n.status).trim()));
  const open = u.all(db, `SELECT severity, alert_type, description, first_seen FROM alerts
    WHERE cluster_id = ? AND resolved = 0 AND COALESCE(dismissed, 0) = 0 AND first_seen >= ?
    ORDER BY first_seen DESC LIMIT 100`, cl.id, since);
  const crit = open.filter((a) => /critical/i.test(String(a.severity))).length;
  lines.push([
    `Cluster ${cl.name} (vip ${cl.vip || '-'}, ${cl.connection_type || 'direct'}): ${nodes.length} nodes${bad.length ? ` (not healthy: ${bad.slice(0, 6).map((n) => `${n.hostname} ${n.status}`).join(', ')})` : ''}`,
    `${open.length} open alerts in 24 h (${crit} critical)`,
    open[0] ? `newest: ${u.clip(open[0].description, 120)}` : null,
  ].filter(Boolean).join(', '));
  for (const a of open.slice(1, 3)) lines.push(`Cluster alert ${u.fmtT(a.first_seen)} ${a.severity || ''}: ${u.clip(a.description, 120)}`);

  const month = u.all(db, `SELECT COALESCE(alert_category, alert_type, 'other') AS cat, COUNT(*) n FROM alerts
    WHERE cluster_id = ? AND first_seen >= ? GROUP BY cat ORDER BY n DESC LIMIT 4`, cl.id, u.iso(Date.now() - 30 * u.DAY_MS));
  const total = month.reduce((n, r) => n + r.n, 0);
  if (total) {
    lines.push(`Alerts on ${cl.name} in 30 days: ${total} (${month.map((r) => `${r.cat} ${r.n}`).join(', ')})`);
    facts.openedTimes30d = total;
  }
  facts.state = bad.length ? 'degraded' : 'ok';

  const runs = u.all(db, `SELECT job_name, status, start_time, error_message FROM protection_runs
    WHERE cluster_id = ? AND start_time >= ? ORDER BY start_time DESC LIMIT 200`, cl.id, since);
  const failed = runs.filter((r) => /fail|error/i.test(String(r.status)));
  if (runs.length) {
    lines.push(`Protection runs in 24 h on ${cl.name}: ${runs.length}, ${failed.length} failed${failed[0] ? `; newest failed ${failed[0].job_name} ${u.fmtT(failed[0].start_time)}: ${u.clip(failed[0].error_message || failed[0].status, 100)}` : ''}`);
    facts.protection = { kind: 'cohesity', lastGoodAt: (runs.find((r) => !/fail|error/i.test(String(r.status))) || {}).start_time || null, lastRunStatus: runs[0].status || null };
  }
  lines.push(...replicationLines(db, cl, facts));
  return u.makeBlock(platform, cl.name, `Cohesity cluster ${cl.name}`, lines, facts);
}

function objectBlock(db, ctx, sub) {
  const o = sub.obj;
  const cl = sub.cluster;
  const facts = u.emptyFacts();
  const groups = u.listOf(o.protection_groups);
  const lastGood = o.last_backup_ms ? Number(o.last_backup_ms) : null;
  let run = null;
  if (groups.length) {
    const ph = groups.slice(0, 5).map(() => '?').join(',');
    run = u.one(db, `SELECT job_name, status, start_time, error_message FROM protection_runs
      WHERE cluster_id = ? AND job_name IN (${ph}) ORDER BY start_time DESC LIMIT 1`, o.cluster_id, ...groups.slice(0, 5));
  }
  const parts = [
    `Object ${o.name}: ${groups.length ? `group ${groups.slice(0, 3).join(', ')}` : (o.is_protected ? 'protected' : 'not protected')}${cl ? ` on ${cl.name}` : ''}`,
    lastGood ? `last good backup ${u.agoText(lastGood)}` : 'no good backup recorded',
    run ? `newest run ${run.status || 'unknown'} ${u.fmtT(run.start_time)}${/fail|error/i.test(String(run.status)) && run.error_message ? `: ${u.clip(run.error_message, 100)}` : ''}` : (o.last_backup_status ? `last backup status ${o.last_backup_status}` : null),
    o.sla_violated ? 'SLA violated' : null,
  ];
  facts.state = o.is_protected ? 'protected' : 'unprotected';
  facts.protection = {
    kind: 'cohesity', lastGoodAt: lastGood ? u.iso(lastGood) : null, lastRunStatus: (run && run.status) || o.last_backup_status || null,
  };
  const lines = [parts.filter(Boolean).join(', ')];
  if (cl) lines.push(...replicationLines(db, cl, facts));
  return u.makeBlock(platform, o.name, `Cohesity object ${o.name}`, lines, facts);
}

function run(db, ctx) {
  const sub = findSubject(db, ctx, u.subjectsFor(ctx, platform));
  if (!sub) return null;
  if (sub.kind === 'object') return objectBlock(db, ctx, sub);
  return clusterBlock(db, ctx, sub);
}

module.exports = { platform, run };
