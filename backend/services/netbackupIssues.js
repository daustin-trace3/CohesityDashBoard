// Computed NetBackup issues (shared by routes and the poller) plus their
// lifecycle history: each poll reconciles the freshly computed issue set
// against netbackup_issue_history so every issue gets first-seen/resolved
// timestamps instead of existing only as a live snapshot (copy of the
// vcenterIssues.js / ariaIssues.js idiom).
const db = require('../db/database');
const { getSetting } = require('./settings');

function successWarnPct() {
  const n = Number(getSetting('netbackup_success_warn_pct'));
  return Number.isFinite(n) && n >= 50 && n <= 100 ? Math.round(n) : 90;
}

function storageWarnPct() {
  const n = Number(getSetting('netbackup_storage_warn_pct'));
  return Number.isFinite(n) && n >= 5 && n <= 50 ? Math.round(n) : 20;
}

function staleBackupHours() {
  const n = Number(getSetting('netbackup_stale_backup_hours'));
  return Number.isFinite(n) && n >= 12 && n <= 336 ? Math.round(n) : 48;
}

const isFailedJob = (j) => j.state === 'FAILED'
  || (['EXITED', 'DONE'].includes(j.state) && Number(j.status_code || 0) > 0);

const ACTIVE_MEDIA_STATES = new Set(['ACTIVE', 'active', 'ONLINE', 'up']);

/**
 * Current issues from the stored inventory. Every issue carries its own
 * `issue_key` (already stable across polls) plus `source_id` (used to file
 * the row against netbackup_issue_history — null only for the estate-wide
 * stale-backup rollup, which isn't scoped to one source).
 */
function computeIssues() {
  const issues = [];

  for (const s of db.prepare('SELECT * FROM netbackup_sources').all()) {
    if (s.last_poll_status === 'error') {
      issues.push({
        issue_key: `poll-error:${s.id}`, source_id: s.id, severity: 'critical', host: s.name,
        source: s.name, type: 'poll-error', target: s.name,
        message: `NetBackup source ${s.name} is unreachable: ${s.last_poll_error || 'poll failed'}`,
      });
    }
  }

  const jobs24h = db.prepare(`
    SELECT j.*, s.name AS source_name FROM netbackup_jobs j
    JOIN netbackup_sources s ON s.id = j.source_id
    WHERE j.started_at >= datetime('now', '-1 day')
  `).all();

  const byPolicy = new Map();
  const bySource = new Map();
  for (const j of jobs24h) {
    if (!bySource.has(j.source_id)) bySource.set(j.source_id, { source_id: j.source_id, source_name: j.source_name, total: 0, failed: 0 });
    const sg = bySource.get(j.source_id);
    sg.total += 1;
    if (isFailedJob(j)) sg.failed += 1;

    if (!j.policy_name) continue;
    const key = `${j.source_id}|${j.policy_name}`;
    if (!byPolicy.has(key)) byPolicy.set(key, { source_id: j.source_id, source_name: j.source_name, policy_name: j.policy_name, total: 0, failed: 0 });
    const pg = byPolicy.get(key);
    pg.total += 1;
    if (isFailedJob(j)) pg.failed += 1;
  }

  for (const g of byPolicy.values()) {
    if (g.failed < 1) continue;
    const allFailed = g.failed === g.total;
    issues.push({
      issue_key: `job-failures:${g.source_id}:${g.policy_name}`, source_id: g.source_id,
      source: g.source_name, type: 'job-failures', target: g.policy_name,
      severity: (g.failed >= 3 || allFailed) ? 'critical' : 'warning', host: g.source_name,
      message: `Policy ${g.policy_name} had ${g.failed} of ${g.total} job(s) fail in the last 24h`,
    });
  }

  const successWarn = successWarnPct();
  for (const g of bySource.values()) {
    if (g.total === 0) continue;
    const rate = ((g.total - g.failed) / g.total) * 100;
    if (rate < successWarn) {
      issues.push({
        issue_key: `success-rate:${g.source_id}`, source_id: g.source_id,
        source: g.source_name, type: 'success-rate', target: g.source_name,
        severity: rate < 70 ? 'critical' : 'warning', host: g.source_name,
        message: `${g.source_name} 24h job success rate is ${rate.toFixed(1)}% (${g.failed} of ${g.total} failed)`,
      });
    }
  }

  const storageWarn = storageWarnPct();
  const storageUnits = db.prepare(`
    SELECT u.*, s.name AS source_name FROM netbackup_storage_units u JOIN netbackup_sources s ON s.id = u.source_id
  `).all();
  for (const u of storageUnits) {
    if (!(u.capacity_bytes > 0) || u.free_bytes == null) continue;
    const freePct = (u.free_bytes / u.capacity_bytes) * 100;
    if (freePct < storageWarn) {
      issues.push({
        issue_key: `storage-low:${u.source_id}:${u.name}`, source_id: u.source_id,
        source: u.source_name, type: 'storage-low', target: u.name,
        severity: freePct < 10 ? 'critical' : 'warning', host: u.source_name,
        message: `Storage unit ${u.name} has ${freePct.toFixed(1)}% free space`,
      });
    }
  }
  const diskPools = db.prepare(`
    SELECT p.*, s.name AS source_name FROM netbackup_disk_pools p JOIN netbackup_sources s ON s.id = p.source_id
  `).all();
  for (const p of diskPools) {
    if (!(p.total_capacity_bytes > 0) || p.available_capacity_bytes == null) continue;
    const freePct = (p.available_capacity_bytes / p.total_capacity_bytes) * 100;
    if (freePct < storageWarn) {
      issues.push({
        issue_key: `storage-low:${p.source_id}:${p.name}`, source_id: p.source_id,
        source: p.source_name, type: 'storage-low', target: p.name,
        severity: freePct < 10 ? 'critical' : 'warning', host: p.source_name,
        message: `Disk pool ${p.name} has ${freePct.toFixed(1)}% free space`,
      });
    }
  }

  const mediaServers = db.prepare(`
    SELECT m.*, s.name AS source_name FROM netbackup_media_servers m JOIN netbackup_sources s ON s.id = m.source_id
  `).all();
  for (const m of mediaServers) {
    if (m.state != null && !ACTIVE_MEDIA_STATES.has(m.state)) {
      issues.push({
        issue_key: `media-server-down:${m.source_id}:${m.name}`, source_id: m.source_id,
        source: m.source_name, type: 'media-server-down', target: m.name,
        severity: 'warning', host: m.source_name,
        message: `Media server ${m.name} state is ${m.state}`,
      });
    }
  }

  const staleHours = staleBackupHours();
  const clientRows = db.prepare(`
    SELECT j.source_id, s.name AS source_name, j.client_name,
      MAX(CASE WHEN j.state != 'FAILED' AND NOT (j.state IN ('EXITED', 'DONE') AND COALESCE(j.status_code, 0) > 0)
                THEN j.started_at END) AS last_success
    FROM netbackup_jobs j JOIN netbackup_sources s ON s.id = j.source_id
    WHERE j.client_name IS NOT NULL
    GROUP BY j.source_id, j.client_name
  `).all();
  const staleClients = clientRows.filter((c) => {
    if (!c.last_success) return true;
    return (Date.now() - new Date(c.last_success).getTime()) / 3600000 > staleHours;
  }).sort((a, b) => (a.last_success || '').localeCompare(b.last_success || ''));

  const worst = staleClients.slice(0, 25);
  for (const c of worst) {
    issues.push({
      issue_key: `stale-backup:${c.source_id}:${c.client_name}`, source_id: c.source_id,
      source: c.source_name, type: 'stale-backup', target: c.client_name,
      severity: 'warning', host: c.source_name,
      message: c.last_success
        ? `Client ${c.client_name} has had no successful backup in over ${staleHours}h (last success ${c.last_success})`
        : `Client ${c.client_name} has no recorded successful backup`,
    });
  }
  if (staleClients.length > 25) {
    const remaining = staleClients.length - 25;
    issues.push({
      issue_key: 'stale-backup-summary:all', source_id: null,
      source: 'estate', type: 'stale-backup-summary', target: 'estate',
      severity: 'warning', host: 'estate',
      message: `${remaining} additional client(s) have stale backups beyond the top 25 shown`,
    });
  }

  const alerts = db.prepare(`
    SELECT a.*, s.name AS source_name FROM netbackup_alerts a JOIN netbackup_sources s ON s.id = a.source_id
  `).all();
  for (const a of alerts) {
    const sev = String(a.severity || '').toLowerCase();
    let severity = null;
    if (sev === 'critical' || sev === 'error') severity = 'critical';
    else if (sev === 'warning') severity = 'warning';
    if (!severity) continue;
    issues.push({
      issue_key: `upstream-alert:${a.source_id}:${a.alert_id}`, source_id: a.source_id,
      source: a.source_name, type: 'upstream-alert', target: String(a.alert_id),
      severity, host: a.source_name,
      message: a.message || `Upstream alert ${a.alert_id}`,
    });
  }

  // Appliance hardware connections are a separate connection type
  // (netbackup_appliance_conns) — not scoped to a netbackup_sources row, so
  // source_id stays NULL per the estate-wide null pattern above.
  for (const c of db.prepare('SELECT * FROM netbackup_appliance_conns').all()) {
    if (c.last_poll_status === 'error') {
      issues.push({
        issue_key: `appliance-poll-error:${c.id}`, source_id: null, severity: 'critical', host: c.name,
        source: c.name, type: 'appliance-poll-error', target: c.name,
        message: `NetBackup appliance ${c.name} is unreachable: ${c.last_poll_error || 'poll failed'}`,
      });
    }
  }

  const hwRows = db.prepare(`
    SELECT h.*, c.name AS conn_name FROM netbackup_appliance_hw h
    JOIN netbackup_appliance_conns c ON c.id = h.conn_id
    WHERE h.status IN ('warning', 'critical')
  `).all();
  for (const h of hwRows) {
    issues.push({
      issue_key: `appliance-hw:${h.conn_id}:${h.component_type}:${h.component_name}`, source_id: null,
      source: h.conn_name, type: 'appliance-hw', target: `${h.component_type} ${h.component_name}`,
      severity: h.status, host: h.conn_name,
      message: `${h.conn_name} ${h.component_type} ${h.component_name} is ${h.status}${h.state_raw ? ` (${h.state_raw})` : ''}`,
    });
  }

  const order = { critical: 0, warning: 1, info: 2 };
  return issues.sort((a, b) => order[a.severity] - order[b.severity]);
}

/**
 * Sync the computed issue set into netbackup_issue_history: new issues open a
 * row, still-present ones bump last_seen (message/severity refreshed), and
 * open rows whose issue is gone get resolved. Idempotent — safe to run after
 * every per-source poll. Rows resolved >90 days ago are pruned.
 */
const reconcileIssueHistoryTxn = db.transaction(() => {
  const current = new Map(computeIssues().map((i) => [i.issue_key, i]));
  const open = db.prepare("SELECT * FROM netbackup_issue_history WHERE status = 'open'").all();

  const touch = db.prepare(`
    UPDATE netbackup_issue_history SET last_seen = datetime('now'), message = ?, severity = ? WHERE id = ?
  `);
  const resolve = db.prepare(`
    UPDATE netbackup_issue_history SET status = 'resolved', resolved_at = datetime('now'), last_seen = datetime('now') WHERE id = ?
  `);
  const insert = db.prepare(`
    INSERT INTO netbackup_issue_history (source_id, issue_key, source, type, target, severity, message)
    VALUES (?, ?, ?, ?, ?, ?, ?)
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
    if (!openKeys.has(key)) insert.run(i.source_id ?? null, key, i.source ?? null, i.type ?? null, i.target ?? null, i.severity, i.message);
  }
  db.prepare("DELETE FROM netbackup_issue_history WHERE status = 'resolved' AND resolved_at < datetime('now', '-90 days')").run();
});

// Run as BEGIN IMMEDIATE so the write lock is taken up front — a deferred
// read→write upgrade in WAL fails as SQLITE_BUSY (snapshot) when the other
// process writes mid-transaction, and that error ignores busy_timeout.
const reconcileIssueHistory = () => reconcileIssueHistoryTxn.immediate();

module.exports = {
  successWarnPct, storageWarnPct, staleBackupHours,
  computeIssues, reconcileIssueHistory,
};
