// Computed vCenter issues (shared by routes and the poller) plus their
// lifecycle history: each poll reconciles the freshly computed issue set
// against vcenter_issue_history so every issue gets first-seen / resolved
// timestamps instead of existing only as a live snapshot.
const db = require('../db/database');
const { getSetting } = require('./settings');

const DS_USED_WARN_PCT = 80;
const CLUSTER_FREE_WARN_PCT = 20;

// Cert warning window is operator-configurable (vCenter Settings page);
// critical stays at 14 days, clamped down if the warning window is shorter.
function certWarnDays() {
  const n = Number(getSetting('vcenter_cert_warn_days'));
  return Number.isFinite(n) && n >= 1 && n <= 365 ? Math.round(n) : 60;
}

const dsUsedPct = (d) => (d.capacity_bytes > 0 ? (1 - d.free_bytes / d.capacity_bytes) * 100 : null);

/**
 * Current issues from the stored inventory. Every issue carries a `target`
 * (host/datastore/cluster name) so `type|vcenter|target` is a stable identity
 * across polls even as the message's numbers change.
 */
function computeIssues() {
  const issues = [];
  for (const vc of db.prepare('SELECT * FROM vcenter_vcenters').all()) {
    if (vc.last_poll_status === 'error') {
      issues.push({ severity: 'critical', type: 'vcenter-unreachable', vcenter: vc.name, target: vc.name,
        message: `vCenter ${vc.name} is unreachable: ${vc.last_poll_error || 'poll failed'}` });
    }
  }
  const hosts = db.prepare(`
    SELECT h.*, v.name AS vcenter_name FROM vcenter_hosts h JOIN vcenter_vcenters v ON v.id = h.vcenter_id
  `).all();
  for (const h of hosts) {
    if (h.connection_state && h.connection_state !== 'CONNECTED') {
      issues.push({ severity: 'critical', type: 'host-down', vcenter: h.vcenter_name, target: h.name,
        message: `Host ${h.name} is ${String(h.connection_state).toLowerCase().replace(/_/g, ' ')}` });
    } else if (h.in_maintenance === 1) {
      issues.push({ severity: 'info', type: 'host-maintenance', vcenter: h.vcenter_name, target: h.name,
        message: `Host ${h.name} is in maintenance mode` });
    }
  }
  const datastores = db.prepare(`
    SELECT d.*, v.name AS vcenter_name FROM vcenter_datastores d JOIN vcenter_vcenters v ON v.id = d.vcenter_id
  `).all();
  for (const d of datastores) {
    const used = dsUsedPct(d);
    if (used != null && used > DS_USED_WARN_PCT) {
      issues.push({ severity: used > 90 ? 'critical' : 'warning', type: 'datastore-usage', vcenter: d.vcenter_name, target: d.name,
        message: `Datastore ${d.name} is ${used.toFixed(1)}% full` });
    }
  }
  const clusters = db.prepare(`
    SELECT c.*, v.name AS vcenter_name FROM vcenter_clusters c JOIN vcenter_vcenters v ON v.id = c.vcenter_id
  `).all();
  for (const c of clusters) {
    for (const [label, cap, used] of [
      ['CPU', c.cpu_mhz_capacity, c.cpu_mhz_used],
      ['memory', c.mem_bytes_capacity, c.mem_bytes_used],
    ]) {
      if (cap > 0 && used != null) {
        const freePct = (1 - used / cap) * 100;
        if (freePct < CLUSTER_FREE_WARN_PCT) {
          issues.push({ severity: freePct < 10 ? 'critical' : 'warning', type: 'cluster-capacity',
            vcenter: c.vcenter_name, target: `${c.name}:${label}`,
            message: `Cluster ${c.name} has ${freePct.toFixed(1)}% ${label} headroom left` });
        }
      }
    }
  }
  const certWarn = certWarnDays();
  const certCrit = Math.min(14, certWarn);
  for (const cert of db.prepare(`
    SELECT c.*, v.name AS vcenter_name FROM vcenter_certs c JOIN vcenter_vcenters v ON v.id = c.vcenter_id
  `).all()) {
    if (!cert.valid_to) continue;
    const days = (new Date(cert.valid_to).getTime() - Date.now()) / 86400000;
    if (Number.isFinite(days) && days < certWarn) {
      issues.push({
        severity: days < certCrit ? 'critical' : 'warning', type: 'cert-expiry',
        vcenter: cert.vcenter_name, target: cert.vcenter_name,
        message: days < 0
          ? `vCenter ${cert.vcenter_name} TLS certificate EXPIRED ${Math.abs(Math.round(days))} day(s) ago`
          : `vCenter ${cert.vcenter_name} TLS certificate expires in ${Math.round(days)} day(s)`,
      });
    }
  }
  const order = { critical: 0, warning: 1, info: 2 };
  return issues.sort((a, b) => order[a.severity] - order[b.severity]);
}

const issueKey = (i) => `${i.type}|${i.vcenter}|${i.target}`;

/**
 * Sync the computed issue set into vcenter_issue_history: new issues open a
 * row, still-present ones bump last_seen (message/severity refreshed), and
 * open rows whose issue is gone get resolved. Idempotent — safe to run after
 * every per-vCenter poll. Rows resolved >90 days ago are pruned.
 */
const reconcileIssueHistoryTxn = db.transaction(() => {
  const current = new Map(computeIssues().map(i => [issueKey(i), i]));
  const open = db.prepare("SELECT * FROM vcenter_issue_history WHERE status = 'open'").all();

  const touch = db.prepare(`
    UPDATE vcenter_issue_history SET last_seen = datetime('now'), message = ?, severity = ? WHERE id = ?
  `);
  const resolve = db.prepare(`
    UPDATE vcenter_issue_history SET status = 'resolved', resolved_at = datetime('now'), last_seen = datetime('now') WHERE id = ?
  `);
  const insert = db.prepare(`
    INSERT INTO vcenter_issue_history (issue_key, vcenter, severity, type, target, message)
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
    if (!openKeys.has(key)) insert.run(key, i.vcenter, i.severity, i.type, i.target, i.message);
  }
  db.prepare("DELETE FROM vcenter_issue_history WHERE status = 'resolved' AND resolved_at < datetime('now', '-90 days')").run();
});

// Run as BEGIN IMMEDIATE so the write lock is taken up front — a deferred
// read→write upgrade in WAL fails as SQLITE_BUSY (snapshot) when the other
// process writes mid-transaction, and that error ignores busy_timeout.
const reconcileIssueHistory = () => reconcileIssueHistoryTxn.immediate();

module.exports = {
  DS_USED_WARN_PCT, CLUSTER_FREE_WARN_PCT, certWarnDays,
  computeIssues, reconcileIssueHistory,
};
