// Computed AWS issues (shared by routes and the poller) plus their lifecycle
// history: each poll reconciles the freshly computed issue set against
// aws_issue_history so every issue gets first-seen / resolved timestamps
// instead of existing only as a live snapshot. Pattern mirrors vcenterIssues.
const db = require('../db/database');
const { getSetting } = require('./settings');

function costSpikePct() {
  const n = Number(getSetting('aws_cost_spike_pct'));
  return Number.isFinite(n) && n >= 5 && n <= 500 ? Math.round(n) : 30;
}

/**
 * Current issues from the stored inventory. Every issue carries a `target`
 * so `type|account|target` is a stable identity across polls.
 */
function computeIssues() {
  const issues = [];

  const accounts = db.prepare('SELECT * FROM aws_accounts').all();
  const accountsById = new Map(accounts.map((a) => [a.id, a]));

  // 1. ec2-status-check — running instance with a failed status check.
  const ec2Rows = db.prepare(`
    SELECT e.*, a.name AS account_name FROM aws_ec2_instances e JOIN aws_accounts a ON a.id = e.account_id
  `).all();
  for (const i of ec2Rows) {
    if (i.state === 'running' && i.status_check && /failed/i.test(i.status_check)
      && !/^(ok|initializing)$/i.test(i.status_check)) {
      issues.push({
        severity: 'critical', type: 'ec2-status-check', account: i.account_name, accountId: i.account_id,
        target: i.name || i.instance_id,
        message: `EC2 instance ${i.name || i.instance_id} failed status checks (${i.status_check})`,
      });
    }
  }

  // 2. ecs-degraded — ACTIVE service with running_count < desired_count.
  const svcRows = db.prepare(`
    SELECT s.*, a.name AS account_name FROM aws_ecs_services s JOIN aws_accounts a ON a.id = s.account_id
  `).all();
  for (const s of svcRows) {
    if (s.status === 'ACTIVE' && (s.running_count ?? 0) < (s.desired_count ?? 0)) {
      const target = `${s.cluster_name}/${s.service_name}`;
      issues.push({
        severity: 'critical', type: 'ecs-degraded', account: s.account_name, accountId: s.account_id,
        target, message: `ECS service ${target} running ${s.running_count}/${s.desired_count} desired tasks`,
      });
    }
  }

  // 3. cost-spike — yesterday's total >= $1 and > day-before * (1 + pct/100).
  const pct = costSpikePct();
  for (const acc of accounts) {
    const rows = db.prepare(`
      SELECT day, SUM(amount_usd) AS total FROM aws_cost_daily
      WHERE account_id = ? AND day >= date('now', '-3 days')
      GROUP BY day ORDER BY day DESC
    `).all(acc.id);
    const byDay = new Map(rows.map((r) => [r.day, r.total || 0]));
    const yesterday = new Date(Date.now() - 86400000).toISOString().slice(0, 10);
    const dayBefore = new Date(Date.now() - 2 * 86400000).toISOString().slice(0, 10);
    const yTotal = byDay.get(yesterday);
    const dbTotal = byDay.get(dayBefore);
    if (yTotal != null && dbTotal != null && yTotal >= 1 && yTotal > dbTotal * (1 + pct / 100)) {
      issues.push({
        severity: 'warning', type: 'cost-spike', account: acc.name, accountId: acc.id,
        target: 'estate',
        message: `AWS spend spiked to $${yTotal.toFixed(2)} yesterday, up from $${dbTotal.toFixed(2)} the day before (>${pct}%)`,
      });
    }
  }

  // 4. s3-public — bucket public_access_blocked = 0.
  const bucketRows = db.prepare(`
    SELECT b.*, a.name AS account_name FROM aws_s3_buckets b JOIN aws_accounts a ON a.id = b.account_id
  `).all();
  for (const b of bucketRows) {
    if (b.public_access_blocked === 0) {
      issues.push({
        severity: 'warning', type: 's3-public', account: b.account_name, accountId: b.account_id,
        target: b.name, message: `S3 bucket ${b.name} does not block public access`,
      });
    }
  }

  // 5. ebs-unattached — volume state = 'available'.
  const volRows = db.prepare(`
    SELECT v.*, a.name AS account_name FROM aws_ebs_volumes v JOIN aws_accounts a ON a.id = v.account_id
  `).all();
  for (const v of volRows) {
    if (v.state === 'available') {
      issues.push({
        severity: 'info', type: 'ebs-unattached', account: v.account_name, accountId: v.account_id,
        target: v.volume_id, message: `EBS volume ${v.volume_id} (${v.size_gb || '?'} GB) is unattached`,
      });
    }
  }

  // 6. account-poll-error — account last_poll_status = 'error'.
  for (const acc of accounts) {
    if (acc.last_poll_status === 'error') {
      issues.push({
        severity: 'warning', type: 'account-poll-error', account: acc.name, accountId: acc.id,
        target: acc.name, message: `AWS account ${acc.name} poll failed: ${acc.last_poll_error || 'unknown error'}`,
      });
    }
  }

  void accountsById; // referenced for clarity/future use
  const order = { critical: 0, warning: 1, info: 2 };
  return issues.sort((a, b) => order[a.severity] - order[b.severity]);
}

const issueKey = (i) => `${i.type}|${i.account}|${i.target}`;

/**
 * Sync the computed issue set into aws_issue_history: new issues open a row,
 * still-present ones bump last_seen (message/severity refreshed), and open
 * rows whose issue is gone get resolved. Idempotent. Rows resolved >90 days
 * ago are pruned.
 */
const reconcileIssueHistory = db.transaction(() => {
  const current = new Map(computeIssues().map((i) => [issueKey(i), i]));
  const open = db.prepare("SELECT * FROM aws_issue_history WHERE status = 'open'").all();

  const touch = db.prepare(`
    UPDATE aws_issue_history SET last_seen = datetime('now'), message = ?, severity = ? WHERE id = ?
  `);
  const resolve = db.prepare(`
    UPDATE aws_issue_history SET status = 'resolved', resolved_at = datetime('now'), last_seen = datetime('now') WHERE id = ?
  `);
  const insert = db.prepare(`
    INSERT INTO aws_issue_history (issue_key, account_id, account, severity, type, target, message, last_seen)
    VALUES (?, ?, ?, ?, ?, ?, ?, datetime('now'))
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
    if (!openKeys.has(key)) insert.run(key, i.accountId ?? null, i.account, i.severity, i.type, i.target, i.message);
  }
  db.prepare("DELETE FROM aws_issue_history WHERE status = 'resolved' AND resolved_at < datetime('now', '-90 days')").run();
});

module.exports = { costSpikePct, computeIssues, reconcileIssueHistory };
