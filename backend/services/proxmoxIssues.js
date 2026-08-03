// Computed Proxmox issues (shared by routes and the poller) plus their
// lifecycle history: each poll reconciles the freshly computed issue set
// against proxmox_issue_history so every issue gets first-seen / resolved
// timestamps instead of existing only as a live snapshot.
const db = require('../db/database');
const { getSetting } = require('./settings');

function clampPct(key, def) {
  const n = Number(getSetting(key));
  return Number.isFinite(n) && n >= 1 && n <= 100 ? n : def;
}
function clampDays(key, def) {
  const n = Number(getSetting(key));
  return Number.isFinite(n) && n >= 1 && n <= 365 ? Math.round(n) : def;
}

const storageWarnPct = () => clampPct('proxmox_storage_warn_pct', 85);
const storageCritPct = () => clampPct('proxmox_storage_crit_pct', 95);
const backupStaleDays = () => clampDays('proxmox_backup_stale_days', 3);
const certWarnDays = () => clampDays('proxmox_cert_warn_days', 30);

/**
 * Current issues from the stored inventory. Every issue carries a `target`
 * so `type|source|target` is a stable identity across polls even as the
 * message's numbers change. `source` is the server name, `sourceId` its id.
 */
function computeIssues() {
  const issues = [];
  const servers = db.prepare('SELECT * FROM proxmox_servers').all();

  // node-offline
  const nodes = db.prepare(`
    SELECT n.*, s.name AS server_name FROM proxmox_nodes n JOIN proxmox_servers s ON s.id = n.server_id
  `).all();
  for (const n of nodes) {
    if (n.status && n.status !== 'online') {
      issues.push({
        severity: 'critical', type: 'node-offline', source: n.server_name, sourceId: n.server_id,
        target: n.name, message: `Node ${n.name} is ${n.status}`,
      });
    }
  }

  // storage-full / storage-warn
  const critPct = storageCritPct();
  const warnPct = storageWarnPct();
  const storages = db.prepare(`
    SELECT st.*, s.name AS server_name FROM proxmox_storage st JOIN proxmox_servers s ON s.id = st.server_id
  `).all();
  for (const st of storages) {
    if (!st.total_bytes || st.total_bytes <= 0 || st.used_bytes == null) continue;
    const pct = (st.used_bytes / st.total_bytes) * 100;
    const target = `${st.node}/${st.storage}`;
    if (pct >= critPct) {
      issues.push({
        severity: 'critical', type: 'storage-full', source: st.server_name, sourceId: st.server_id,
        target, message: `Storage ${target} is ${pct.toFixed(1)}% full`,
      });
    } else if (pct >= warnPct) {
      issues.push({
        severity: 'warning', type: 'storage-warn', source: st.server_name, sourceId: st.server_id,
        target, message: `Storage ${target} is ${pct.toFixed(1)}% full`,
      });
    }
  }

  // backup-failed: vzdump task failed within last 7 days.
  const failedBackups = db.prepare(`
    SELECT t.*, s.name AS server_name FROM proxmox_tasks t JOIN proxmox_servers s ON s.id = t.server_id
    WHERE t.type = 'vzdump' AND t.ended_at IS NOT NULL AND t.status IS NOT NULL AND t.status != 'OK'
      AND t.ended_at >= datetime('now', '-7 days')
  `).all();
  for (const t of failedBackups) {
    const guest = db.prepare('SELECT name FROM proxmox_guests WHERE server_id = ? AND vmid = ?')
      .get(t.server_id, Number(t.target));
    const label = guest ? `${guest.name} (${t.target})` : String(t.target);
    issues.push({
      severity: 'critical', type: 'backup-failed', source: t.server_name, sourceId: t.server_id,
      target: label, message: `Backup failed for ${label}: ${t.status}`,
    });
  }

  // backup-stale: non-template guest with no successful vzdump within N days,
  // AND at least one backup job exists for that server.
  const staleDays = backupStaleDays();
  const serversWithJobs = new Set(
    db.prepare('SELECT DISTINCT server_id FROM proxmox_backup_jobs').all().map((r) => r.server_id)
  );
  const staleCutoff = db.prepare("SELECT datetime('now', ?) AS d").get(`-${staleDays} days`).d;
  const guests = db.prepare(`
    SELECT g.*, s.name AS server_name FROM proxmox_guests g JOIN proxmox_servers s ON s.id = g.server_id
    WHERE g.is_template = 0
  `).all();
  for (const g of guests) {
    if (!serversWithJobs.has(g.server_id)) continue;
    const stale = !g.last_backup_at || g.last_backup_status !== 'OK' || g.last_backup_at < staleCutoff;
    if (stale) {
      const label = `${g.name} (${g.vmid})`;
      issues.push({
        severity: 'warning', type: 'backup-stale', source: g.server_name, sourceId: g.server_id,
        target: label, message: `${label} has no successful backup within ${staleDays} day(s)`,
      });
    }
  }

  // task-failed: non-vzdump task failed within last 24h.
  const failedTasks = db.prepare(`
    SELECT t.*, s.name AS server_name FROM proxmox_tasks t JOIN proxmox_servers s ON s.id = t.server_id
    WHERE t.type != 'vzdump' AND t.ended_at IS NOT NULL AND t.status IS NOT NULL AND t.status != 'OK'
      AND t.ended_at >= datetime('now', '-24 hours')
  `).all();
  for (const t of failedTasks) {
    const target = `${t.type} on ${t.node}`;
    issues.push({
      severity: 'warning', type: 'task-failed', source: t.server_name, sourceId: t.server_id,
      target, message: `Task ${target} failed: ${t.status}`,
    });
  }

  // cert-expiring
  const certWarn = certWarnDays();
  for (const n of nodes) {
    if (!n.cert_expires_at) continue;
    const days = (new Date(n.cert_expires_at).getTime() - Date.now()) / 86400000;
    if (Number.isFinite(days) && days < certWarn) {
      issues.push({
        severity: 'warning', type: 'cert-expiring', source: n.server_name, sourceId: n.server_id,
        target: n.name,
        message: days < 0
          ? `Node ${n.name} TLS certificate EXPIRED ${Math.abs(Math.round(days))} day(s) ago`
          : `Node ${n.name} TLS certificate expires in ${Math.round(days)} day(s)`,
      });
    }
  }

  // quorum-lost: quorate = 0 (only set when a cluster row was present).
  for (const s of servers) {
    if (s.quorate === 0) {
      issues.push({
        severity: 'critical', type: 'quorum-lost', source: s.name, sourceId: s.id,
        target: s.name, message: `Cluster ${s.name} has lost quorum`,
      });
    }
  }

  // token-permissions: poll saw >=1 403 on nodes/status, cluster/resources, or cluster/backup.
  for (const s of servers) {
    if (!s.forbidden_endpoints) continue;
    let list = [];
    try { list = JSON.parse(s.forbidden_endpoints) || []; } catch { /* ignore */ }
    if (Array.isArray(list) && list.length) {
      issues.push({
        severity: 'warning', type: 'token-permissions', source: s.name, sourceId: s.id,
        target: s.name, message: `Token for ${s.name} lacks permission for: ${list.join(', ')}`,
      });
    }
  }

  const order = { critical: 0, warning: 1, info: 2 };
  return issues.sort((a, b) => order[a.severity] - order[b.severity]);
}

const issueKey = (i) => `${i.type}|${i.source}|${i.target}`;

/**
 * Sync the computed issue set into proxmox_issue_history: new issues open a
 * row, still-present ones bump last_seen (message/severity refreshed), and
 * open rows whose issue is gone get resolved. Idempotent — safe to run after
 * every per-server poll. Rows resolved >90 days ago are pruned.
 */
const reconcileIssueHistory = db.transaction(() => {
  const current = new Map(computeIssues().map((i) => [issueKey(i), i]));
  const open = db.prepare("SELECT * FROM proxmox_issue_history WHERE status = 'open'").all();

  const touch = db.prepare(`
    UPDATE proxmox_issue_history SET last_seen = datetime('now'), message = ?, severity = ? WHERE id = ?
  `);
  const resolve = db.prepare(`
    UPDATE proxmox_issue_history SET status = 'resolved', resolved_at = datetime('now'), last_seen = datetime('now') WHERE id = ?
  `);
  const insert = db.prepare(`
    INSERT INTO proxmox_issue_history (issue_key, source, source_id, severity, type, target, message)
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
    if (!openKeys.has(key)) insert.run(key, i.source, i.sourceId, i.severity, i.type, i.target, i.message);
  }
  db.prepare("DELETE FROM proxmox_issue_history WHERE status = 'resolved' AND resolved_at < datetime('now', '-90 days')").run();
});

module.exports = {
  storageWarnPct, storageCritPct, backupStaleDays, certWarnDays,
  computeIssues, reconcileIssueHistory,
};
