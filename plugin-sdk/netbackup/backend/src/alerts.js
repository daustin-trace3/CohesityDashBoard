// Alert-email collector contribution (manifest hook `collectAlerts`, host
// contract landed 2026-08-03 — see backend/core/registry.js
// getAlertCollectors() and backend/services/alertNotifier.js). Ported from
// the built-in collectNetbackupIssues() in backend/services/alertNotifier.js.
function toIso(value) {
  if (value == null) return null;
  if (typeof value === 'number') return new Date(value).toISOString();
  const d = new Date(value);
  if (!Number.isNaN(d.getTime())) return d.toISOString();
  return String(value);
}

/** Open NetBackup computed issues — issues.reconcileIssueHistory keeps
 *  netbackup_issue_history current with a stable issue_key per issue, and
 *  resolving drops the row out of this query (which is what ends reminders). */
function collectAlerts(coreApi) {
  const rows = coreApi.db.prepare(`
    SELECT i.issue_key AS issueKey, i.severity, i.message,
           i.first_seen AS firstSeen, i.last_seen AS lastSeen,
           COALESCE(s.name, i.source, 'estate') AS sourceName
    FROM netbackup_issue_history i LEFT JOIN netbackup_sources s ON i.source_id = s.id
    WHERE i.status = 'open'
  `).all();
  return rows.map((r) => ({
    sourceKey: `nb:${r.issueKey}`,
    severity: String(r.severity || '').toLowerCase(),
    host: r.sourceName,
    message: r.message || '',
    firstSeen: toIso(r.firstSeen),
    lastSeen: toIso(r.lastSeen),
  }));
}

module.exports = { collectAlerts };
