// Alert-email collector contribution (manifest hook `collectAlerts`, host
// contract landed 2026-08-03 — see backend/core/registry.js
// getAlertCollectors() and backend/services/alertNotifier.js). Ported from
// the built-in collectProxmoxIssues() in backend/services/alertNotifier.js.
function toIso(value) {
  if (value == null) return null;
  if (typeof value === 'number') return new Date(value).toISOString();
  const d = new Date(value);
  if (!Number.isNaN(d.getTime())) return d.toISOString();
  return String(value);
}

/** Open Proxmox VE computed issues — issues.reconcileIssueHistory keeps
 *  proxmox_issue_history current with a stable issue_key per issue, and
 *  resolving drops the row out of this query (which is what ends reminders).
 *  LEFT JOIN so issue rows with a NULL source_id (estate-wide issues) still
 *  surface instead of being dropped. */
function collectAlerts(coreApi) {
  const rows = coreApi.db.prepare(`
    SELECT i.issue_key AS issueKey, COALESCE(s.name, i.source, 'estate') AS server,
           i.severity, i.message, i.first_seen AS firstSeen, i.last_seen AS lastSeen
    FROM proxmox_issue_history i LEFT JOIN proxmox_servers s ON i.source_id = s.id
    WHERE i.status = 'open'
  `).all();
  return rows.map((r) => ({
    sourceKey: `px:${r.issueKey}`,
    severity: String(r.severity || '').toLowerCase(),
    host: r.server,
    message: r.message || '',
    firstSeen: toIso(r.firstSeen),
    lastSeen: toIso(r.lastSeen),
  }));
}

module.exports = { collectAlerts };
