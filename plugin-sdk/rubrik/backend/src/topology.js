// Topology Map contribution (host manifest hook `topology`, 2026-09-15).
// When /ops/topology anchors on a device, the host calls
// topology(coreApi, { query, names, ips, anchorId }) on every enabled plugin
// and merges the returned nodes/edges into the graph (host fills platform,
// color, and default status; node ids must be unique across platforms, so
// every id here carries a 'rubrik:' segment).
//
// Rubrik adds, for each protected object matching the identity names:
//   anchor -protected-by-> protection:rubrik:<SLA Domain>
//   protection -on-cluster-> cluster:rubrik:<cluster>
//   cluster -replicated-to-> cluster:rubrik:<target> (from replication pairs)

const ROUTE_OBJECT = (name) => `/rubrik/object-360?name=${encodeURIComponent(name)}`;

function topology(coreApi, { names, anchorId }) {
  const nameList = (names || []).map((n) => String(n).toLowerCase()).filter(Boolean);
  if (!nameList.length || !anchorId) return null;
  const db = coreApi.db;
  const ph = nameList.map(() => '?').join(',');

  const objects = db.prepare(
    `SELECT o.name, o.type, o.sla_domain, o.compliant, c.name AS cluster_name
     FROM rubrik_protected_objects o
     JOIN rubrik_clusters c ON c.id = o.cluster_id
     WHERE lower(o.name) IN (${ph})`
  ).all(...nameList);
  if (!objects.length) return null;

  const lastRunStmt = db.prepare(
    `SELECT status FROM rubrik_protection_runs
     WHERE object_name = ? AND run_type = 'Backup' ORDER BY start_ms DESC LIMIT 1`
  );
  const pairStmt = db.prepare(
    'SELECT target_cluster, status, lag_seconds FROM rubrik_replication_pairs WHERE source_cluster = ?'
  );

  const nodes = [];
  const edges = [];
  const seen = new Set();
  const addNode = (n) => { if (!seen.has(n.id)) { seen.add(n.id); nodes.push(n); } };

  for (const o of objects) {
    let lastRun = null;
    try { lastRun = lastRunStmt.get(o.name); } catch { /* older schema without runs */ }
    const status = lastRun?.status === 'Failed' ? 'crit' : (o.compliant ? 'ok' : 'warn');
    const sla = o.sla_domain || 'Unprotected';
    const protId = `protection:rubrik:${sla}`;
    addNode({
      id: protId, type: 'protection', tier: 'backup',
      label: sla, sublabel: `SLA Domain · ${o.type}`,
      route: ROUTE_OBJECT(o.name), status,
    });
    edges.push({ from: anchorId, to: protId, kind: 'protected-by', label: '' });

    if (o.cluster_name) {
      const clusterId = `cluster:rubrik:${o.cluster_name}`;
      addNode({
        id: clusterId, type: 'cluster', tier: 'backup',
        label: o.cluster_name, sublabel: 'Rubrik cluster', route: '/rubrik', status: 'unknown',
      });
      edges.push({ from: protId, to: clusterId, kind: 'on-cluster', label: '' });

      let pairs = [];
      try { pairs = pairStmt.all(o.cluster_name); } catch { /* table absent */ }
      for (const p of pairs) {
        if (!p.target_cluster) continue;
        const targetId = `cluster:rubrik:${p.target_cluster}`;
        addNode({
          id: targetId, type: 'cluster', tier: 'backup',
          label: p.target_cluster, sublabel: 'Replication target', route: '/rubrik/replication',
          status: p.status === 'Healthy' ? 'ok' : 'warn',
        });
        const lag = p.lag_seconds == null ? '' : (p.lag_seconds >= 3600 ? `${Math.round(p.lag_seconds / 3600)}h lag` : `${Math.round(p.lag_seconds / 60)}m lag`);
        edges.push({ from: clusterId, to: targetId, kind: 'replicated-to', label: lag });
      }
    }
  }
  return { nodes, edges };
}

module.exports = { topology };
