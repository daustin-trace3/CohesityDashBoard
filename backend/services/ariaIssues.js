// Computed Aria issues (shared by routes and the poller) plus their lifecycle
// history: each poll reconciles the freshly computed issue set against
// aria_issue_history so every issue gets first-seen/resolved timestamps
// instead of existing only as a live snapshot (copy of vcenterIssues.js).
const db = require('../db/database');
const { getSetting } = require('./settings');

function leaseWarnDays() {
  const n = Number(getSetting('aria_lease_warn_days'));
  return Number.isFinite(n) && n >= 1 && n <= 60 ? Math.round(n) : 7;
}

function certWarnDays() {
  const n = Number(getSetting('aria_cert_warn_days'));
  return Number.isFinite(n) && n >= 1 && n <= 365 ? Math.round(n) : 30;
}

function requestFailLookbackHours() {
  const n = Number(getSetting('aria_request_fail_lookback_hours'));
  return Number.isFinite(n) && n >= 1 && n <= 168 ? Math.round(n) : 24;
}

// Health-state strings observed across vRA endpoint types are unverified —
// treat anything that looks affirmative as healthy and everything else
// (present, non-null) as unhealthy. A missing/null state is unknown, not
// flagged.
const HEALTHY_STATES = new Set(['ok', 'up', 'healthy', 'connected', 'active', 'available']);
const isUnhealthy = (state) => state != null && state !== '' && !HEALTHY_STATES.has(String(state).toLowerCase());

const FAILED_STATUSES = /fail/i;

/**
 * Current issues from the stored inventory. Every issue carries a `target`
 * (deployment/endpoint/instance name, or an aggregate label) so
 * `type|instance|target` is a stable identity across polls even as the
 * message's numbers change.
 */
function computeIssues() {
  const issues = [];
  const instances = db.prepare('SELECT * FROM aria_instances').all();

  for (const inst of instances) {
    if (inst.last_poll_status === 'error') {
      issues.push({
        severity: 'error', type: 'instance-unreachable', instance: inst.name, target: inst.name,
        message: `Aria instance ${inst.name} is unreachable: ${inst.last_poll_error || 'poll failed'}`,
      });
    }
  }

  const endpoints = db.prepare(`
    SELECT e.*, i.name AS instance_name FROM aria_endpoints e
    JOIN aria_instances i ON i.id = e.instance_id
  `).all();
  for (const e of endpoints) {
    if (isUnhealthy(e.health_state)) {
      issues.push({
        severity: 'error', type: 'endpoint-unhealthy', instance: e.instance_name, target: e.name || e.endpoint_id,
        message: `${e.kind === 'cloud-account' ? 'Cloud account' : 'Integration'} ${e.name || e.endpoint_id} is ${e.health_state}`,
      });
    }
  }

  const deployments = db.prepare(`
    SELECT d.*, i.name AS instance_name FROM aria_deployments d
    JOIN aria_instances i ON i.id = d.instance_id
  `).all();
  const leaseWarn = leaseWarnDays();
  for (const d of deployments) {
    if (d.status && FAILED_STATUSES.test(d.status)) {
      issues.push({
        severity: 'warning', type: 'deployment-failed', instance: d.instance_name, target: d.name || d.deployment_id,
        message: `Deployment ${d.name || d.deployment_id} is ${d.status}`,
      });
    }
    if (d.lease_expire_at) {
      const days = (new Date(d.lease_expire_at).getTime() - Date.now()) / 86400000;
      if (Number.isFinite(days) && days <= leaseWarn) {
        issues.push({
          severity: 'warning', type: 'lease-expiring', instance: d.instance_name, target: d.name || d.deployment_id,
          message: days < 0
            ? `Deployment ${d.name || d.deployment_id} lease EXPIRED ${Math.abs(Math.round(days))} day(s) ago`
            : `Deployment ${d.name || d.deployment_id} lease expires in ${Math.round(days)} day(s)`,
        });
      }
    }
  }

  const certWarn = certWarnDays();
  for (const inst of instances) {
    if (!inst.cert_valid_to) continue;
    const days = (new Date(inst.cert_valid_to).getTime() - Date.now()) / 86400000;
    if (Number.isFinite(days) && days <= certWarn) {
      issues.push({
        severity: 'warning', type: 'cert-expiring', instance: inst.name, target: inst.name,
        message: days < 0
          ? `Aria instance ${inst.name} TLS certificate EXPIRED ${Math.abs(Math.round(days))} day(s) ago`
          : `Aria instance ${inst.name} TLS certificate expires in ${Math.round(days)} day(s)`,
      });
    }
  }

  const catalogSources = db.prepare(`
    SELECT c.*, i.name AS instance_name FROM aria_catalog_sources c
    JOIN aria_instances i ON i.id = c.instance_id
  `).all();
  for (const c of catalogSources) {
    if (c.last_import_errors) {
      issues.push({
        severity: 'warning', type: 'catalog-import-errors', instance: c.instance_name, target: c.name || c.source_id,
        message: `Catalog source ${c.name || c.source_id} had import errors: ${c.last_import_errors}`,
      });
    }
  }

  const lookbackHours = requestFailLookbackHours();
  const failedRuns = db.prepare(`
    SELECT r.kind, i.name AS instance_name, COUNT(*) AS n
    FROM aria_runs r JOIN aria_instances i ON i.id = r.instance_id
    WHERE r.status IS NOT NULL AND r.status LIKE '%FAIL%'
      AND r.captured_at >= datetime('now', ?)
    GROUP BY r.instance_id, r.kind
  `).all(`-${lookbackHours} hours`);
  for (const r of failedRuns) {
    issues.push({
      severity: 'warning', type: 'runs-failed', instance: r.instance_name, target: r.kind,
      message: `${r.n} ${r.kind} run(s) failed in the last ${lookbackHours}h`,
    });
  }

  const pendingApprovals = db.prepare(`
    SELECT i.name AS instance_name, COUNT(*) AS n
    FROM aria_approvals a JOIN aria_instances i ON i.id = a.instance_id
    WHERE a.status LIKE '%PENDING%'
    GROUP BY a.instance_id
  `).all();
  for (const a of pendingApprovals) {
    if (a.n > 0) {
      issues.push({
        severity: 'info', type: 'approvals-pending', instance: a.instance_name, target: 'approvals',
        message: `${a.n} approval(s) pending`,
      });
    }
  }

  const order = { error: 0, warning: 1, info: 2 };
  return issues.sort((a, b) => order[a.severity] - order[b.severity]);
}

const issueKey = (i) => `${i.type}|${i.instance}|${i.target}`;

/**
 * Sync the computed issue set into aria_issue_history: new issues open a row,
 * still-present ones bump last_seen (message/severity refreshed), and open
 * rows whose issue is gone get resolved. Idempotent — safe to run after every
 * per-instance poll. Rows resolved >90 days ago are pruned.
 */
const reconcileIssueHistory = db.transaction(() => {
  const current = new Map(computeIssues().map((i) => [issueKey(i), i]));
  const open = db.prepare("SELECT * FROM aria_issue_history WHERE status = 'open'").all();

  const touch = db.prepare(`
    UPDATE aria_issue_history SET last_seen = datetime('now'), message = ?, severity = ? WHERE id = ?
  `);
  const resolve = db.prepare(`
    UPDATE aria_issue_history SET status = 'resolved', resolved_at = datetime('now'), last_seen = datetime('now') WHERE id = ?
  `);
  const insert = db.prepare(`
    INSERT INTO aria_issue_history (issue_key, instance, severity, type, target, message)
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
    if (!openKeys.has(key)) insert.run(key, i.instance, i.severity, i.type, i.target, i.message);
  }
  db.prepare("DELETE FROM aria_issue_history WHERE status = 'resolved' AND resolved_at < datetime('now', '-90 days')").run();
});

module.exports = {
  leaseWarnDays, certWarnDays, requestFailLookbackHours,
  computeIssues, reconcileIssueHistory,
};
