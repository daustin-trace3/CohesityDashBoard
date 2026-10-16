// Server 360 contribution (host manifest hook, 2026-08-03): when the ops
// Server 360 page pivots on a name, the host calls server360(coreApi, ctx)
// on every enabled installed plugin and renders the returned DISPLAY-READY
// section generically. This file supplies the Rubrik backup posture for any
// matching protected object, with a deep link into the plugin's Object 360.

const ACCENT = '#00B388';

const fmtBytes = (b) => {
  if (b == null) return '—';
  if (b >= 1e12) return `${(b / 1e12).toLocaleString(undefined, { maximumFractionDigits: 2 })} TB`;
  if (b >= 1e9) return `${(b / 1e9).toLocaleString(undefined, { maximumFractionDigits: 1 })} GB`;
  if (b >= 1e6) return `${(b / 1e6).toLocaleString(undefined, { maximumFractionDigits: 1 })} MB`;
  return `${Number(b).toLocaleString()} B`;
};

const runTone = (s) => (s === 'Succeeded' ? 'ok' : s === 'Failed' ? 'crit' : s ? 'warn' : 'neutral');

const fmtAgo = (ms) => {
  const d = Math.floor((Date.now() - ms) / 86400000);
  return d < 1 ? 'today' : d === 1 ? '1d ago' : `${d}d ago`;
};

function server360(coreApi, { names }) {
  const nameList = (names || []).map((n) => String(n).toLowerCase()).filter(Boolean);
  if (!nameList.length) return null;
  const ph = nameList.map(() => '?').join(',');

  const objects = coreApi.db
    .prepare(
      `SELECT o.*, c.name AS cluster_name
       FROM rubrik_protected_objects o
       JOIN rubrik_clusters c ON c.id = o.cluster_id
       WHERE lower(o.name) IN (${ph})`
    )
    .all(...nameList);
  if (!objects.length) return null;

  const lastRunStmt = coreApi.db.prepare(
    `SELECT status, start_ms FROM rubrik_protection_runs
     WHERE object_name = ? AND run_type = 'Backup'
     ORDER BY start_ms DESC LIMIT 1`
  );
  const alertStmt = coreApi.db.prepare(
    `SELECT COUNT(*) AS total, SUM(CASE WHEN severity = 'critical' THEN 1 ELSE 0 END) AS critical
     FROM rubrik_alerts WHERE object_name = ? AND resolved = 0 AND dismissed = 0`
  );
  const pairStmt = coreApi.db.prepare(
    'SELECT target_cluster, status, lag_seconds FROM rubrik_replication_pairs WHERE source_cluster = ?'
  );

  const groups = objects.map((o) => {
    const lastRun = lastRunStmt.get(o.name);
    const stale = lastRun && Date.now() - lastRun.start_ms > 7 * 86400000;
    const facts = [
      { label: 'Object', value: `${o.name} (${o.type})` },
      { label: 'SLA Domain', value: o.sla_domain || '—' },
      { label: 'Cluster', value: o.cluster_name },
      { label: 'Compliance', value: o.compliant ? 'Compliant' : 'Non-compliant', tone: o.compliant ? 'ok' : 'crit' },
      lastRun
        ? {
            label: 'Last Backup',
            value: `${lastRun.status} · ${new Date(lastRun.start_ms).toLocaleDateString()} · ${fmtAgo(lastRun.start_ms)}`,
            tone: stale && lastRun.status === 'Succeeded' ? 'warn' : runTone(lastRun.status),
          }
        : { label: 'Last Backup', value: '—' },
      { label: 'Local / Archived', value: `${fmtBytes(o.local_storage_bytes)} / ${fmtBytes(o.archived_bytes)}` },
    ];

    const lines = [];
    const alerts = alertStmt.get(o.name);
    if (alerts && alerts.total > 0) {
      lines.push(`${alerts.total} open alert(s)${alerts.critical ? ` · ${alerts.critical} critical` : ''}`);
    }
    const pair = pairStmt.get(o.cluster_name);
    if (pair) {
      const lag = pair.lag_seconds < 60 ? `${pair.lag_seconds}s` : `${Math.round(pair.lag_seconds / 60)}m`;
      lines.push(`replicates to ${pair.target_cluster} · ${pair.status} · lag ${lag}`);
    }
    lines.push(`${o.snapshot_count ?? 0} snapshots · next ${o.next_snapshot_at ? String(o.next_snapshot_at).slice(0, 10) : '—'}`);

    return {
      facts,
      lines,
      link: { label: 'Open Object 360 →', href: `/rubrik/object-360?name=${encodeURIComponent(o.name)}` },
    };
  });

  return { title: 'Backup (Rubrik)', chip: { label: 'Rubrik', color: ACCENT }, groups };
}

function server360Suggest(coreApi, q) {
  const term = String(q || '').trim();
  if (term.length < 2) return [];
  const pattern = `%${term.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
  return coreApi.db
    .prepare(`SELECT DISTINCT name FROM rubrik_protected_objects WHERE name LIKE ? ESCAPE '\\' ORDER BY name LIMIT 8`)
    .all(pattern)
    .map((r) => r.name);
}

module.exports = { server360, server360Suggest };
