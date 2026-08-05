// Live Rubrik Security Cloud poller — one framework task per registered RSC
// connection (rubrik_connections.kind = 'rsc').
//
// Every section is fetched BEFORE anything is deleted, and a section that
// throws leaves its stored rows untouched: a failed fetch must never wipe
// inventory (the bug class fixed across five platforms in 2126f39).
//
// Mapping notes for the demo-era tables, which predate live data:
//  - rubrik_clusters.model holds the RSC cluster `type` (OnPrem / Robo / Cloud)
//  - capacity is null on DISCONNECTED clusters, so used/capacity fall back to 0
//  - rubrik_jobs is fed from activitySeriesConnection; RSC does not expose
//    per-activity byte counts there, so data_transferred_bytes stays 0
const rscApi = require('./rscApi');

let pollerInstance = null;

const isDemo = () => process.env.DASHBOARD_DEMO === '1';

function rscConnections(coreApi) {
  return coreApi.db.prepare("SELECT * FROM rubrik_connections WHERE kind = 'rsc'").all();
}

function storeClusters(db, connectionId, clusters) {
  const del = db.prepare('DELETE FROM rubrik_clusters WHERE connection_id = ?');
  const ins = db.prepare(`
    INSERT INTO rubrik_clusters
      (rsc_id, connection_id, name, model, nodes, version, used_bytes, capacity_bytes, status,
       cluster_type, connected_state, last_connection_at, estimated_runway_days, snapshot_count)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  db.transaction(() => {
    del.run(connectionId);
    for (const c of clusters) {
      ins.run(
        c.id, connectionId, c.name || '(unnamed)', c.type || 'Unknown',
        c.clusterNodeConnection?.count || 0, c.version || '',
        c.metric?.usedCapacity || 0, c.metric?.totalCapacity || 0,
        c.state?.connectedState || c.status || 'Unknown',
        c.type || null, c.state?.connectedState || null, c.lastConnectionTime || null,
        c.estimatedRunway == null ? null : Number(c.estimatedRunway),
        c.snapshotCount == null ? null : Number(c.snapshotCount),
      );
    }
  })();
}

function storeSlaDomains(db, connectionId, domains) {
  const del = db.prepare('DELETE FROM rubrik_sla_domains WHERE connection_id = ?');
  const ins = db.prepare(`
    INSERT INTO rubrik_sla_domains
      (rsc_id, connection_id, name, snapshot_frequency, retention, object_count, compliance_pct)
    VALUES (?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(name) DO UPDATE SET
      rsc_id = excluded.rsc_id, connection_id = excluded.connection_id,
      object_count = excluded.object_count, compliance_pct = excluded.compliance_pct
  `);
  db.transaction(() => {
    del.run(connectionId);
    for (const s of domains) {
      // Frequency/retention live on the schedule sub-objects, which vary by
      // SLA flavour; left unset rather than guessed until a tenant needs them.
      ins.run(s.id, connectionId, s.name || '(unnamed)', '—', '—', s.protectedObjectCount || 0, 0);
    }
  })();
}

function storeObjects(db, connectionId, vms) {
  const clusterIdFor = new Map(
    db.prepare('SELECT id, rsc_id FROM rubrik_clusters WHERE connection_id = ?').all(connectionId)
      .map((r) => [r.rsc_id, r.id])
  );
  const del = db.prepare('DELETE FROM rubrik_protected_objects WHERE connection_id = ?');
  const ins = db.prepare(`
    INSERT INTO rubrik_protected_objects
      (rsc_id, connection_id, cluster_id, name, type, sla_domain, last_backup_at, compliant)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `);
  let skipped = 0;
  db.transaction(() => {
    del.run(connectionId);
    for (const v of vms) {
      const clusterId = clusterIdFor.get(v.cluster?.id);
      // cluster_id is NOT NULL with an FK — an object whose cluster is not in
      // this connection's cluster list cannot be stored.
      if (!clusterId) { skipped += 1; continue; }
      const sla = v.effectiveSlaDomain?.name || 'UNPROTECTED';
      const protectedObj = sla !== 'UNPROTECTED' && (v.snapshotConnection?.count || 0) > 0;
      ins.run(
        v.id, connectionId, clusterId, v.name || '(unnamed)', v.objectType || 'Unknown',
        sla, v.newestSnapshot?.date || '', protectedObj ? 1 : 0,
      );
    }
  })();
  return skipped;
}

function storeJobs(db, connectionId, activity) {
  const clusterIdFor = new Map(
    db.prepare('SELECT id, rsc_id FROM rubrik_clusters WHERE connection_id = ?').all(connectionId)
      .map((r) => [r.rsc_id, r.id])
  );
  const del = db.prepare('DELETE FROM rubrik_jobs WHERE connection_id = ?');
  const ins = db.prepare(`
    INSERT INTO rubrik_jobs
      (rsc_id, connection_id, cluster_id, object_name, job_type, status, started_at, ended_at,
       duration_seconds, data_transferred_bytes, error_message)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  let skipped = 0;
  db.transaction(() => {
    del.run(connectionId);
    for (const a of activity) {
      const clusterId = clusterIdFor.get(a.clusterUuid);
      if (!clusterId) { skipped += 1; continue; }
      const started = a.startTime || a.lastUpdated || '';
      const ended = a.lastUpdated || started;
      const durationMs = started && ended ? new Date(ended).getTime() - new Date(started).getTime() : 0;
      ins.run(
        String(a.id), connectionId, clusterId, a.objectName || '(none)',
        a.lastActivityType || 'Unknown', a.lastActivityStatus || 'Unknown',
        started, ended, Number.isFinite(durationMs) ? Math.max(0, Math.round(durationMs / 1000)) : 0,
        0, a.lastActivityStatus === 'Failure' ? (a.progress || null) : null,
      );
    }
  })();
  return skipped;
}

async function pollConnection(connection, coreApi) {
  const db = coreApi.db;
  const log = (msg) => coreApi.logger.info(`[rubrik] ${connection.name}: ${msg}`);

  // Clusters first — objects and jobs key off them.
  const clusters = await rscApi.fetchClusters(coreApi, connection);
  storeClusters(db, connection.id, clusters);
  const connected = clusters.filter((c) => c.state?.connectedState === 'Connected').length;
  log(`${clusters.length} cluster(s), ${connected} connected`);

  // One capacity point per cluster per day. Disconnected clusters report no
  // metric at all, so they are skipped rather than recorded as a 0-byte day,
  // which would draw a false cliff on the capacity trend.
  const capacityRow = db.prepare(`
    INSERT INTO rubrik_capacity_history (cluster, cluster_id, day, used_bytes, captured_at)
    VALUES (?, ?, date('now'), ?, CURRENT_TIMESTAMP)
    ON CONFLICT(cluster, day) DO UPDATE SET
      used_bytes = excluded.used_bytes, cluster_id = excluded.cluster_id, captured_at = excluded.captured_at
  `);
  const idFor = new Map(
    db.prepare('SELECT id, rsc_id FROM rubrik_clusters WHERE connection_id = ?').all(connection.id)
      .map((r) => [r.rsc_id, r.id])
  );
  for (const c of clusters) {
    if (c.metric?.usedCapacity == null) continue;
    capacityRow.run(c.name, idFor.get(c.id) || null, c.metric.usedCapacity);
  }

  // Remaining sections are independent: one failing must not lose the others,
  // and must not delete what is already stored.
  const sections = [
    ['SLA domains', async () => {
      const d = await rscApi.fetchSlaDomains(coreApi, connection);
      storeSlaDomains(db, connection.id, d);
      return `${d.length} SLA domain(s)`;
    }],
    ['objects', async () => {
      const vms = await rscApi.fetchVms(coreApi, connection);
      const skipped = storeObjects(db, connection.id, vms);
      return `${vms.length - skipped} object(s)${skipped ? `, ${skipped} skipped (unknown cluster)` : ''}`;
    }],
    ['activity', async () => {
      const acts = await rscApi.fetchActivity(coreApi, connection);
      const skipped = storeJobs(db, connection.id, acts);
      return `${acts.length - skipped} activity row(s)${skipped ? `, ${skipped} skipped (no cluster)` : ''}`;
    }],
  ];

  const failures = [];
  for (const [label, run] of sections) {
    try {
      log(await run());
    } catch (err) {
      failures.push(`${label}: ${err.message}`);
      coreApi.logger.warn(`[rubrik] ${connection.name}: ${label} failed, keeping stored rows — ${err.message}`);
    }
  }

  db.prepare(`
    UPDATE rubrik_connections
       SET last_poll_status = ?, last_poll_error = ?, last_poll_at = CURRENT_TIMESTAMP
     WHERE id = ?
  `).run(failures.length ? 'error' : 'success', failures.length ? failures.join(' | ') : null, connection.id);

  if (failures.length) {
    const e = new Error(failures.join(' | '));
    e.code = 'RSC_PARTIAL';
    throw e;
  }
}

function buildPoller(coreApi) {
  return coreApi.createPoller({
    id: 'rubrik',
    loadSources: () => rscConnections(coreApi),
    intervalMinutes: (c) => c.polling_interval_minutes || 30,
    poll: (connection) => pollConnection(connection, coreApi),
  });
}

function getPoller(coreApi) {
  if (!pollerInstance) pollerInstance = buildPoller(coreApi);
  return pollerInstance;
}

/** Manifest createPoller entry point. A demo instance keeps its seeded estate
 *  and never polls, so demo numbers can't be overwritten by a live tenant. */
function createRubrikPoller(coreApi) {
  if (isDemo()) {
    coreApi.logger.info('[rubrik] Demo instance — seeded data is static, live polling disabled.');
    return { init() { return []; }, stopAll() {} };
  }
  return getPoller(coreApi);
}

module.exports = { createRubrikPoller, getPoller, pollConnection };
