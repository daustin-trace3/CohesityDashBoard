// Computed Nutanix issues (shared by routes and the poller) plus their
// lifecycle history, mirroring vcenterIssues.js. Issue identity is
// `type|source|target` — stable across polls even as the message text
// changes. computeRpoCompliance() is also consumed directly by
// GET /nutanix/protection (contract: rpoCompliance array).
const db = require('../db/database');
const { getSetting } = require('./settings');

function clampedInt(key, def, min, max) {
  const n = Number(getSetting(key));
  return Number.isFinite(n) && n >= min && n <= max ? Math.round(n) : def;
}

const containerWarnPct = () => clampedInt('nutanix_container_warn_pct', 85, 1, 100);
const containerCritPct = () => clampedInt('nutanix_container_crit_pct', 95, 1, 100);
const clusterWarnPct = () => clampedInt('nutanix_cluster_warn_pct', 80, 1, 100);
const clusterCritPct = () => clampedInt('nutanix_cluster_crit_pct', 90, 1, 100);
const rpoGracePct = () => clampedInt('nutanix_rpo_grace_pct', 50, 0, 500);
const runwayWarnDays = () => clampedInt('nutanix_runway_warn_days', 90, 1, 3650);

const pct = (used, cap) => (cap > 0 && used != null ? (used / cap) * 100 : null);

/**
 * Best-effort RPO compliance: for each source with at least one protection
 * policy carrying an RPO, compare each protected VM's most recent recovery
 * point/snapshot age against the source's tightest policy RPO. Nutanix has
 * no direct VM->policy join surfaced by the read-only APIs used here, so this
 * is deliberately conservative (source-wide tightest RPO) rather than
 * inventing a mapping. Capped at 20 rows for the issues rule; the /protection
 * route may show more.
 */
function computeRpoCompliance(limit = 200) {
  const out = [];
  const sources = db.prepare('SELECT id, name FROM nutanix_sources').all();
  for (const src of sources) {
    const policies = db.prepare(
      'SELECT name, rpo_secs FROM nutanix_protection_policies WHERE source_id = ? AND rpo_secs IS NOT NULL'
    ).all(src.id);
    if (!policies.length) continue;
    const tightest = policies.reduce((min, p) => (p.rpo_secs < min.rpo_secs ? p : min), policies[0]);

    const latestByVm = new Map();
    for (const rp of db.prepare(
      `SELECT vm_uuid, vm_name, created_at_ts FROM nutanix_recovery_points
       WHERE source_id = ? AND vm_uuid IS NOT NULL ORDER BY created_at_ts DESC`
    ).all(src.id)) {
      if (!latestByVm.has(rp.vm_uuid)) latestByVm.set(rp.vm_uuid, rp);
    }

    for (const [, rp] of latestByVm) {
      if (out.length >= limit) break;
      const created = rp.created_at_ts ? new Date(rp.created_at_ts).getTime() : null;
      const ageSecs = created != null && Number.isFinite(created) ? (Date.now() - created) / 1000 : null;
      const compliant = ageSecs != null ? ageSecs <= tightest.rpo_secs * (1 + rpoGracePct() / 100) : null;
      out.push({
        source: src.name,
        vmName: rp.vm_name,
        policyName: tightest.name,
        rpoSecs: tightest.rpo_secs,
        latestRecoveryPoint: rp.created_at_ts,
        ageSecs,
        compliant,
      });
    }
  }
  return out;
}

/**
 * Current issues from the stored inventory. Every issue carries a `target`
 * (cluster/host/VM/source name) for a stable `type|source|target` identity.
 */
function computeIssues() {
  const issues = [];
  const sources = db.prepare('SELECT * FROM nutanix_sources').all();

  for (const src of sources) {
    // Rule 1: source-unreachable
    if (src.last_poll_status === 'error') {
      issues.push({ severity: 'critical', type: 'source-unreachable', source: src.name, target: src.name,
        message: `Nutanix source ${src.name} is unreachable: ${src.last_poll_error || 'poll failed'}` });
    }
    // Rule 11: auth-degraded — poll succeeded but nothing came back (likely
    // a permission-limited credential; proxmox lesson).
    if (src.last_poll_status === 'success') {
      const clusterCount = db.prepare('SELECT COUNT(*) n FROM nutanix_clusters WHERE source_id = ?').get(src.id).n;
      const vmCount = db.prepare('SELECT COUNT(*) n FROM nutanix_vms WHERE source_id = ?').get(src.id).n;
      if (clusterCount === 0 && vmCount === 0) {
        issues.push({ severity: 'warning', type: 'auth-degraded', source: src.name, target: src.name,
          message: `Nutanix source ${src.name} polled successfully but returned 0 clusters and 0 VMs — credentials may be permission-limited` });
      }
    }
  }

  const srcName = new Map(sources.map((s) => [s.id, s.name]));

  // Rule 2 / 4 / 10: cluster-scoped resiliency, storage usage, runway.
  const clusters = db.prepare('SELECT * FROM nutanix_clusters').all();
  const clWarn = clusterWarnPct();
  const clCrit = clusterCritPct();
  const rwWarn = runwayWarnDays();
  for (const c of clusters) {
    const source = srcName.get(c.source_id) || `source ${c.source_id}`;
    if (c.ft_failures_tolerable === 0 && c.num_nodes > 1) {
      issues.push({ severity: 'critical', type: 'resiliency', source, target: c.name,
        message: `Cluster ${c.name} cannot tolerate any further node/component failure` });
    }
    const usedPct = pct(c.storage_usage_bytes, c.storage_capacity_bytes);
    if (usedPct != null && usedPct >= clWarn) {
      issues.push({ severity: usedPct >= clCrit ? 'critical' : 'warning', type: 'cluster-storage', source, target: c.name,
        message: `Cluster ${c.name} storage is ${usedPct.toFixed(1)}% used` });
    }
    if (c.runway_days != null && c.runway_days < rwWarn) {
      issues.push({ severity: 'warning', type: 'runway', source, target: c.name,
        message: `Cluster ${c.name} capacity runway is ${c.runway_days} day(s)` });
    }
    if (c.unprotected_vm_count != null && c.unprotected_vm_count > 0) {
      issues.push({ severity: 'warning', type: 'unprotected-vms', source, target: c.name,
        message: `Cluster ${c.name} has ${c.unprotected_vm_count} unprotected VM(s)` });
    }
  }

  // Rule 3: container-usage
  const ctWarn = containerWarnPct();
  const ctCrit = containerCritPct();
  for (const ct of db.prepare('SELECT * FROM nutanix_containers').all()) {
    const source = srcName.get(ct.source_id) || `source ${ct.source_id}`;
    const usedPct = pct(ct.usage_bytes, ct.capacity_bytes);
    if (usedPct != null && usedPct >= ctWarn) {
      issues.push({ severity: usedPct >= ctCrit ? 'critical' : 'warning', type: 'container-usage', source, target: ct.name,
        message: `Container ${ct.name} is ${usedPct.toFixed(1)}% used` });
    }
  }

  // Rule 5: prism-alerts — unresolved critical alerts, grouped per cluster.
  const alertCounts = db.prepare(`
    SELECT source_id, cluster_name, COUNT(*) n FROM nutanix_alerts
    WHERE severity = 'critical' AND resolved = 0 GROUP BY source_id, cluster_name
  `).all();
  for (const row of alertCounts) {
    const source = srcName.get(row.source_id) || `source ${row.source_id}`;
    const target = row.cluster_name || source;
    issues.push({ severity: 'critical', type: 'prism-alerts', source, target,
      message: `${row.n} unresolved critical alert(s) on ${target}` });
  }

  // Rule 6: host-degraded
  for (const h of db.prepare('SELECT * FROM nutanix_hosts WHERE is_degraded = 1 OR maintenance_mode = 1').all()) {
    const source = srcName.get(h.source_id) || `source ${h.source_id}`;
    const reason = h.is_degraded === 1 ? 'degraded' : 'in maintenance mode';
    issues.push({ severity: 'warning', type: 'host-degraded', source, target: h.name,
      message: `Host ${h.name} is ${reason}` });
  }

  // Rule 7: replication-stalled — in-flight replications paused or slow, plus
  // PDs with a large pending-replication backlog.
  for (const r of db.prepare('SELECT * FROM nutanix_replications').all()) {
    const source = srcName.get(r.source_id) || `source ${r.source_id}`;
    if (r.paused === 1) {
      issues.push({ severity: 'warning', type: 'replication-stalled', source, target: r.pd_name || r.replication_id,
        message: `Replication for ${r.pd_name || r.replication_id} is paused` });
    } else if (r.eta_secs != null && r.eta_secs > 86400) {
      issues.push({ severity: 'warning', type: 'replication-stalled', source, target: r.pd_name || r.replication_id,
        message: `Replication for ${r.pd_name || r.replication_id} has an ETA of ${Math.round(r.eta_secs / 3600)}h` });
    }
  }
  for (const pd of db.prepare('SELECT * FROM nutanix_pds WHERE pending_replications > 5').all()) {
    const source = srcName.get(pd.source_id) || `source ${pd.source_id}`;
    issues.push({ severity: 'warning', type: 'replication-stalled', source, target: pd.name,
      message: `Protection domain ${pd.name} has ${pd.pending_replications} pending replication(s)` });
  }

  // Rule 8: rpo-violation (cap 20 rows)
  for (const row of computeRpoCompliance(20)) {
    if (row.compliant === false) {
      issues.push({ severity: 'warning', type: 'rpo-violation', source: row.source, target: row.vmName,
        message: `VM ${row.vmName} recovery point is ${Math.round((row.ageSecs || 0) / 3600)}h old (RPO ${Math.round(row.rpoSecs / 60)}m via ${row.policyName})` });
    }
  }

  // Rule 12: move-failed
  const moveConns = db.prepare('SELECT id, name FROM nutanix_move_conns').all();
  const moveConnName = new Map(moveConns.map((c) => [c.id, c.name]));
  for (const e of db.prepare(`
    SELECT * FROM nutanix_move_events
    WHERE failure_notes IS NOT NULL AND failure_notes != ''
      AND created_at >= datetime('now', '-1 day')
  `).all()) {
    const conn = moveConnName.get(e.conn_id) || `Move connection ${e.conn_id}`;
    issues.push({ severity: 'warning', type: 'move-failed', source: conn, target: e.vm_name || e.plan_name || conn,
      message: `Move event failed for ${e.vm_name || e.plan_name || 'a VM'}: ${e.failure_notes}` });
  }
  for (const p of db.prepare(`SELECT * FROM nutanix_move_plans WHERE state = 'failed' OR migration_status = 'FAILED'`).all()) {
    const conn = moveConnName.get(p.conn_id) || `Move connection ${p.conn_id}`;
    issues.push({ severity: 'warning', type: 'move-failed', source: conn, target: p.name,
      message: `Move plan ${p.name} is in a failed state` });
  }

  const order = { critical: 0, warning: 1, info: 2 };
  return issues.sort((a, b) => order[a.severity] - order[b.severity]);
}

const issueKey = (i) => `${i.type}|${i.source}|${i.target}`;

/**
 * Sync the computed issue set into nutanix_issue_history: new issues open a
 * row, still-present ones bump last_seen, and open rows whose issue is gone
 * get resolved. Idempotent — safe to run after every poll. Rows resolved
 * >90 days ago are pruned.
 */
const reconcileIssueHistory = db.transaction(() => {
  const current = new Map(computeIssues().map((i) => [issueKey(i), i]));
  const open = db.prepare("SELECT * FROM nutanix_issue_history WHERE status = 'open'").all();

  const touch = db.prepare(`
    UPDATE nutanix_issue_history SET last_seen = datetime('now'), message = ?, severity = ? WHERE id = ?
  `);
  const resolve = db.prepare(`
    UPDATE nutanix_issue_history SET status = 'resolved', resolved_at = datetime('now'), last_seen = datetime('now') WHERE id = ?
  `);
  const insert = db.prepare(`
    INSERT INTO nutanix_issue_history (issue_key, source, severity, type, target, message)
    VALUES (?, ?, ?, ?, ?, ?)
  `);

  const openKeys = new Set();
  for (const row of open) {
    const cur = current.get(row.issue_key);
    if (cur) {
      openKeys.add(row.issue_key);
      touch.run(cur.message, cur.severity, row.id);
    } else {
      resolve.run(row.id);
    }
  }
  for (const [key, i] of current) {
    if (!openKeys.has(key)) insert.run(key, i.source, i.severity, i.type, i.target, i.message);
  }
  db.prepare("DELETE FROM nutanix_issue_history WHERE status = 'resolved' AND resolved_at < datetime('now', '-90 days')").run();
});

module.exports = {
  containerWarnPct, containerCritPct, clusterWarnPct, clusterCritPct, rpoGracePct, runwayWarnDays,
  computeIssues, computeRpoCompliance, reconcileIssueHistory,
};
