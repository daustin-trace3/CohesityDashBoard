// Rubrik demo platform v1.x routes, moved verbatim from the monolithic
// backend/src/index.js as part of the v2.0.0 file restructure. Behavior is
// byte-identical to the original inline router — only the module boundary
// changed. New v2 routes land additively in later work packages.

const http = require('http');
const https = require('https');
const { URL } = require('url');
const { isoDate, CHRONIC_NAMES } = require('./migrations');

function connectionToJson(row) {
  return {
    id: row.id,
    name: row.name,
    kind: row.kind,
    endpoint: row.endpoint,
    identity: row.identity,
    hasSecret: !!row.encrypted_credentials,
    createdAt: row.created_at,
  };
}

// Honest reachability check: HEAD to the endpoint root, falling back to GET
// if the server rejects HEAD, 5s timeout, self-signed certs tolerated. Never
// claims auth success — that's future live-polling work.
function testEndpointReachable(endpoint) {
  return new Promise((resolve) => {
    let parsed;
    try {
      parsed = new URL(endpoint);
    } catch (e) {
      resolve({ ok: false, error: 'Invalid URL' });
      return;
    }
    const lib = parsed.protocol === 'http:' ? http : https;
    const attempt = (method, onFail) => {
      const req = lib.request(
        {
          method,
          hostname: parsed.hostname,
          port: parsed.port || (parsed.protocol === 'http:' ? 80 : 443),
          path: parsed.pathname || '/',
          timeout: 5000,
          rejectUnauthorized: false,
        },
        (res) => {
          res.resume();
          resolve({ ok: true, statusCode: res.statusCode });
        }
      );
      req.on('timeout', () => {
        req.destroy();
        if (onFail) onFail('Connection timed out');
        else resolve({ ok: false, error: 'Connection timed out' });
      });
      req.on('error', (err) => {
        if (onFail) onFail(err.message);
        else resolve({ ok: false, error: err.message });
      });
      req.end();
    };
    attempt('HEAD', () => attempt('GET', (err) => resolve({ ok: false, error: err })));
  });
}

// createRouter must return a BARE (req, res, next) function — installed
// plugins are loaded via require() on their own dist/backend/index.cjs and
// cannot require the host's copy of express.
function createRouter(coreApi) {
  return function rubrikRouter(req, res, next) {
    if (req.method === 'GET' && req.path === '/overview') {
      const clusters = coreApi.db.prepare('SELECT * FROM rubrik_clusters ORDER BY id').all();
      const objectsTotal = coreApi.db.prepare('SELECT COUNT(*) AS n FROM rubrik_protected_objects').get().n;
      const outOfCompliance = coreApi.db
        .prepare('SELECT COUNT(*) AS n FROM rubrik_protected_objects WHERE compliant = 0')
        .get().n;
      const jobs24h = coreApi.db
        .prepare("SELECT COUNT(*) AS n FROM rubrik_jobs WHERE started_at >= datetime('now', '-24 hours')")
        .get().n;
      const failed24h = coreApi.db
        .prepare("SELECT COUNT(*) AS n FROM rubrik_jobs WHERE started_at >= datetime('now', '-24 hours') AND status = 'Failed'")
        .get().n;
      const usedBytes = clusters.reduce((sum, c) => sum + c.used_bytes, 0);
      const capacityBytes = clusters.reduce((sum, c) => sum + c.capacity_bytes, 0);

      const slaDomains = coreApi.db.prepare('SELECT * FROM rubrik_sla_domains').all();
      const weighted = slaDomains.reduce((acc, s) => acc + s.compliance_pct * s.object_count, 0);
      const weightedCount = slaDomains.reduce((acc, s) => acc + s.object_count, 0);
      const slaCompliancePct = weightedCount > 0 ? Math.round((weighted / weightedCount) * 10) / 10 : 100;

      const openAnomaly = coreApi.db
        .prepare("SELECT MAX(anomaly_probability) AS maxProb FROM rubrik_anomaly_events WHERE status = 'Open'")
        .get();
      const anomaliesOpen = coreApi.db.prepare("SELECT COUNT(*) AS n FROM rubrik_anomaly_events WHERE status = 'Open'").get().n;
      const lastDetectedAt = coreApi.db.prepare('SELECT MAX(detected_at) AS v FROM rubrik_anomaly_events').get().v;
      const overallMaxProb = coreApi.db.prepare('SELECT MAX(anomaly_probability) AS v FROM rubrik_anomaly_events').get().v;

      const huntsRunning = coreApi.db.prepare("SELECT COUNT(*) AS n FROM rubrik_threat_hunts WHERE status = 'Running'").get().n;
      const huntsCompleted7d = coreApi.db
        .prepare("SELECT COUNT(*) AS n FROM rubrik_threat_hunts WHERE status = 'Completed' AND completed_at >= datetime('now', '-7 days')")
        .get().n;
      const huntMatches = coreApi.db
        .prepare("SELECT COALESCE(SUM(matches_found), 0) AS n FROM rubrik_threat_hunts WHERE status = 'Completed'")
        .get().n;

      const replicationPairs = coreApi.db.prepare('SELECT COUNT(*) AS n FROM rubrik_replication_pairs').get().n;
      const replicationLagging = coreApi.db
        .prepare("SELECT COUNT(*) AS n FROM rubrik_replication_pairs WHERE status = 'Lagging'")
        .get().n;

      const archivalLocations = coreApi.db.prepare('SELECT COUNT(*) AS n FROM rubrik_archival_locations').get().n;
      const archivedBytes = coreApi.db.prepare('SELECT COALESCE(SUM(archived_bytes), 0) AS n FROM rubrik_archival_locations').get().n;

      const connectionsTotal = coreApi.db.prepare('SELECT COUNT(*) AS n FROM rubrik_connections').get().n;
      const connectionsRsc = coreApi.db.prepare("SELECT COUNT(*) AS n FROM rubrik_connections WHERE kind = 'rsc'").get().n;
      const connectionsCdm = coreApi.db.prepare("SELECT COUNT(*) AS n FROM rubrik_connections WHERE kind = 'cdm'").get().n;

      const minRunway = clusters.reduce((min, c) => (c.runway_days != null && c.runway_days < min ? c.runway_days : min), Infinity);
      let growth30dBytes = 0;
      for (const c of clusters) {
        const now = coreApi.db
          .prepare('SELECT used_bytes FROM rubrik_capacity_history WHERE cluster = ? ORDER BY day DESC LIMIT 1')
          .get(c.name);
        const past = coreApi.db
          .prepare("SELECT used_bytes FROM rubrik_capacity_history WHERE cluster = ? AND day <= date('now', '-30 days') ORDER BY day DESC LIMIT 1")
          .get(c.name);
        if (now && past) growth30dBytes += now.used_bytes - past.used_bytes;
      }

      res.json({
        clusters: clusters.length,
        objects: objectsTotal,
        protected: objectsTotal - outOfCompliance,
        outOfCompliance,
        jobs24h,
        failed24h,
        usedBytes,
        capacityBytes,
        slaCompliancePct,
        anomalies: {
          open: anomaliesOpen,
          lastDetectedAt,
          maxProbability: openAnomaly && openAnomaly.maxProb != null ? openAnomaly.maxProb : overallMaxProb,
        },
        threatHunts: { running: huntsRunning, completed7d: huntsCompleted7d, matches: huntMatches },
        replication: { pairs: replicationPairs, lagging: replicationLagging },
        archival: { locations: archivalLocations, archivedBytes },
        connections: { total: connectionsTotal, rsc: connectionsRsc, cdm: connectionsCdm },
        capacity: {
          usedBytes,
          capacityBytes,
          runwayDays: Number.isFinite(minRunway) ? minRunway : null,
          growth30dBytes,
        },
        ...overviewV2Additions(coreApi),
      });
      return;
    }

    if (req.method === 'GET' && req.path === '/clusters') {
      const rows = coreApi.db.prepare('SELECT * FROM rubrik_clusters ORDER BY id').all();
      res.json(
        rows.map((r) => ({
          id: r.id,
          name: r.name,
          model: r.model,
          nodes: r.nodes,
          version: r.version,
          usedBytes: r.used_bytes,
          capacityBytes: r.capacity_bytes,
          status: r.status,
          versionStatus: r.version_status,
          runwayDays: r.runway_days,
        }))
      );
      return;
    }

    if (req.method === 'GET' && req.path === '/objects') {
      const rows = coreApi.db
        .prepare(
          `SELECT o.*, c.name AS cluster_name
           FROM rubrik_protected_objects o
           JOIN rubrik_clusters c ON c.id = o.cluster_id
           ORDER BY o.id`
        )
        .all();
      res.json(
        rows.map((r) => ({
          id: r.id,
          clusterId: r.cluster_id,
          clusterName: r.cluster_name,
          name: r.name,
          type: r.type,
          slaDomain: r.sla_domain,
          lastBackupAt: r.last_backup_at,
          compliant: !!r.compliant,
          location: r.location,
          nextSnapshotAt: r.next_snapshot_at,
          snapshotCount: r.snapshot_count,
          localStorageBytes: r.local_storage_bytes,
          archivedBytes: r.archived_bytes,
        }))
      );
      return;
    }

    if (req.method === 'GET' && req.path === '/jobs') {
      const rows = coreApi.db
        .prepare(
          `SELECT j.*, c.name AS cluster_name
           FROM rubrik_jobs j
           JOIN rubrik_clusters c ON c.id = j.cluster_id
           ORDER BY j.started_at DESC, j.id DESC`
        )
        .all();
      res.json(
        rows.map((r) => ({
          id: r.id,
          clusterId: r.cluster_id,
          clusterName: r.cluster_name,
          objectName: r.object_name,
          jobType: r.job_type,
          status: r.status,
          startedAt: r.started_at,
          endedAt: r.ended_at,
          durationSeconds: r.duration_seconds,
          dataTransferredBytes: r.data_transferred_bytes,
          errorMessage: r.error_message,
        }))
      );
      return;
    }

    if (req.method === 'GET' && req.path === '/sla-domains') {
      const rows = coreApi.db.prepare('SELECT * FROM rubrik_sla_domains ORDER BY id').all();
      res.json(
        rows.map((r) => ({
          id: r.id,
          name: r.name,
          snapshotFrequency: r.snapshot_frequency,
          retention: r.retention,
          objectCount: r.object_count,
          compliancePct: r.compliance_pct,
          archivalLocation: r.archival_location,
          replicationTarget: r.replication_target,
        }))
      );
      return;
    }

    if (req.method === 'GET' && req.path === '/compliance') {
      const rows = coreApi.db
        .prepare(
          `SELECT o.name, o.type, o.sla_domain, c.name AS cluster_name
           FROM rubrik_protected_objects o
           JOIN rubrik_clusters c ON c.id = o.cluster_id
           ORDER BY o.id`
        )
        .all();
      const result = rows.map((r) => {
        const cadence = r.sla_domain === 'Bronze-7d' ? 7 : 1;
        const chronic = CHRONIC_NAMES.has(r.name);
        const days = [];
        for (let i = 0; i < 14; i++) {
          const expected = i % cadence === cadence - 1;
          let status;
          if (!expected) {
            status = 'none';
          } else {
            const missThisOne = chronic && (i === cadence - 1 || i === 13 || (cadence === 1 && i === 3));
            status = missThisOne ? 'missed' : 'ok';
          }
          days.push({ day: isoDate(i - 13), status });
        }
        return { name: r.name, type: r.type, cluster: r.cluster_name, slaDomain: r.sla_domain, days };
      });
      res.json(result);
      return;
    }

    if (req.method === 'GET' && req.path === '/capacity') {
      const clusters = coreApi.db.prepare('SELECT * FROM rubrik_clusters ORDER BY id').all();
      const out = clusters.map((c) => {
        const history = coreApi.db
          .prepare('SELECT day, used_bytes FROM rubrik_capacity_history WHERE cluster = ? ORDER BY day ASC')
          .all(c.name);
        const points = history.map((h, idx) => ({ x: idx, y: h.used_bytes }));
        const n = points.length;
        const sumX = points.reduce((s, p) => s + p.x, 0);
        const sumY = points.reduce((s, p) => s + p.y, 0);
        const sumXY = points.reduce((s, p) => s + p.x * p.y, 0);
        const sumXX = points.reduce((s, p) => s + p.x * p.x, 0);
        const denom = n * sumXX - sumX * sumX;
        let slope = denom !== 0 ? (n * sumXY - sumX * sumY) / denom : 0;
        slope = Math.max(slope, c.capacity_bytes * 0.0001);

        const lastUsed = history.length > 0 ? history[history.length - 1].used_bytes : c.used_bytes;
        const forecast = [];
        for (let i = 1; i <= 90; i++) {
          const raw = lastUsed + slope * i;
          forecast.push({ day: isoDate(i), usedBytes: Math.round(Math.min(c.capacity_bytes, raw)) });
        }
        const runwayDays = Math.max(1, Math.round((c.capacity_bytes - lastUsed) / slope));

        return {
          cluster: c.name,
          capacityBytes: c.capacity_bytes,
          series: history.map((h) => ({ day: h.day, usedBytes: h.used_bytes })),
          forecast,
          runwayDays,
          growthPerDayBytes: Math.round(slope),
        };
      });
      res.json({ clusters: out });
      return;
    }

    if (req.method === 'GET' && req.path === '/replication') {
      const pairs = coreApi.db.prepare('SELECT * FROM rubrik_replication_pairs ORDER BY id').all();
      const archival = coreApi.db.prepare('SELECT * FROM rubrik_archival_locations ORDER BY id').all();
      res.json({
        pairs: pairs.map((p) => ({
          id: p.id,
          sourceCluster: p.source_cluster,
          targetCluster: p.target_cluster,
          objects: p.objects,
          lagSeconds: p.lag_seconds,
          status: p.status,
          lastSyncAt: p.last_sync_at,
        })),
        archival: archival.map((a) => ({
          id: a.id,
          name: a.name,
          type: a.type,
          archivedBytes: a.archived_bytes,
          objectCount: a.object_count,
          status: a.status,
        })),
      });
      return;
    }

    if (req.method === 'GET' && req.path === '/security') {
      const anomalies = coreApi.db.prepare('SELECT * FROM rubrik_anomaly_events ORDER BY detected_at DESC').all();
      const hunts = coreApi.db.prepare('SELECT * FROM rubrik_threat_hunts ORDER BY started_at DESC').all();
      const openAnomalies = anomalies.filter((a) => a.status === 'Open').length;
      const quarantinedSnapshots = anomalies.filter((a) => a.snapshot_quarantined).length;
      const runningHunts = hunts.filter((h) => h.status === 'Running').length;
      const matches = hunts.reduce((sum, h) => sum + h.matches_found, 0);

      res.json({
        anomalies: anomalies.map((a) => ({
          id: a.id,
          detectedAt: a.detected_at,
          cluster: a.cluster,
          objectName: a.object_name,
          objectType: a.object_type,
          anomalyProbability: a.anomaly_probability,
          encryptionDetected: !!a.encryption_detected,
          fileChanges: a.file_changes,
          severity: a.severity,
          status: a.status,
          snapshotQuarantined: !!a.snapshot_quarantined,
        })),
        hunts: hunts.map((h) => ({
          id: h.id,
          name: h.name,
          iocType: h.ioc_type,
          status: h.status,
          startedAt: h.started_at,
          completedAt: h.completed_at,
          clustersScanned: h.clusters_scanned,
          snapshotsScanned: h.snapshots_scanned,
          objectsScanned: h.objects_scanned,
          matchesFound: h.matches_found,
        })),
        summary: { openAnomalies, quarantinedSnapshots, runningHunts, matches },
      });
      return;
    }

    if (req.method === 'GET' && req.path === '/events') {
      const days = Math.max(1, Math.min(90, parseInt(req.query && req.query.days, 10) || 7));
      const severity = req.query && req.query.severity;
      let sql = "SELECT * FROM rubrik_events WHERE at >= datetime('now', ?)";
      const params = [`-${days} days`];
      if (severity) {
        sql += ' AND severity = ?';
        params.push(severity);
      }
      sql += ' ORDER BY at DESC, id DESC LIMIT 200';
      const rows = coreApi.db.prepare(sql).all(...params);
      res.json(
        rows.map((r) => ({
          id: r.id,
          at: r.at,
          cluster: r.cluster,
          severity: r.severity,
          eventType: r.event_type,
          objectName: r.object_name,
          message: r.message,
        }))
      );
      return;
    }

    if (req.method === 'GET' && req.path === '/connections') {
      const rows = coreApi.db.prepare('SELECT * FROM rubrik_connections ORDER BY id').all();
      res.json(rows.map(connectionToJson));
      return;
    }

    if (req.method === 'POST' && req.path === '/connections') {
      const { name, kind, endpoint, identity, secret } = req.body || {};
      if (!name || !kind || !endpoint) {
        res.status(400).json({ error: 'name, kind, and endpoint are required' });
        return;
      }
      if (kind !== 'rsc' && kind !== 'cdm') {
        res.status(400).json({ error: "kind must be 'rsc' or 'cdm'" });
        return;
      }
      const encryptedCredentials = secret ? coreApi.encryption.encrypt(JSON.stringify({ secret })) : null;
      try {
        const result = coreApi.db
          .prepare(
            `INSERT INTO rubrik_connections (name, kind, endpoint, identity, encrypted_credentials)
             VALUES (?, ?, ?, ?, ?)`
          )
          .run(name, kind, endpoint, identity || null, encryptedCredentials);
        const row = coreApi.db.prepare('SELECT * FROM rubrik_connections WHERE id = ?').get(result.lastInsertRowid);
        res.status(201).json(connectionToJson(row));
      } catch (err) {
        if (err && err.code === 'SQLITE_CONSTRAINT_UNIQUE') {
          res.status(409).json({ error: 'duplicate' });
          return;
        }
        throw err;
      }
      return;
    }

    if (req.method === 'POST' && req.path === '/connections/test') {
      const { endpoint, id } = req.body || {};
      let target = endpoint;
      if (!target && id != null) {
        const row = coreApi.db.prepare('SELECT endpoint FROM rubrik_connections WHERE id = ?').get(id);
        target = row && row.endpoint;
      }
      if (!target) {
        res.status(200).json({ ok: false, error: 'No endpoint provided' });
        return;
      }
      testEndpointReachable(target).then((result) => res.json(result));
      return;
    }

    const connIdMatch = req.path.match(/^\/connections\/(\d+)$/);
    if (connIdMatch && (req.method === 'PUT' || req.method === 'DELETE')) {
      const id = Number(connIdMatch[1]);
      const existing = coreApi.db.prepare('SELECT * FROM rubrik_connections WHERE id = ?').get(id);
      if (!existing) {
        res.status(404).json({ error: 'not_found' });
        return;
      }

      if (req.method === 'DELETE') {
        coreApi.db.prepare('DELETE FROM rubrik_connections WHERE id = ?').run(id);
        res.status(204).end();
        return;
      }

      // PUT: all fields optional; blank/omitted secret KEEPS the stored one.
      const { name, kind, endpoint, identity, secret } = req.body || {};
      if (kind != null && kind !== 'rsc' && kind !== 'cdm') {
        res.status(400).json({ error: "kind must be 'rsc' or 'cdm'" });
        return;
      }
      const encryptedCredentials = secret ? coreApi.encryption.encrypt(JSON.stringify({ secret })) : existing.encrypted_credentials;
      try {
        coreApi.db
          .prepare(
            `UPDATE rubrik_connections
               SET name = ?, kind = ?, endpoint = ?, identity = ?, encrypted_credentials = ?, updated_at = CURRENT_TIMESTAMP
             WHERE id = ?`
          )
          .run(
            name != null ? name : existing.name,
            kind != null ? kind : existing.kind,
            endpoint != null ? endpoint : existing.endpoint,
            identity != null ? identity : existing.identity,
            encryptedCredentials,
            id
          );
        const row = coreApi.db.prepare('SELECT * FROM rubrik_connections WHERE id = ?').get(id);
        res.json(connectionToJson(row));
      } catch (err) {
        if (err && err.code === 'SQLITE_CONSTRAINT_UNIQUE') {
          res.status(409).json({ error: 'duplicate' });
          return;
        }
        throw err;
      }
      return;
    }

    if (addV2Routes(coreApi, req, res)) return;

    next();
  };
}

// ---------------------------------------------------------------------
// v2.0.0 additions below: helpers + routes for the Cohesity-parity mirror.
// Existing v1.x routes above are untouched (byte-compatible).
// ---------------------------------------------------------------------

function alertToJson(row) {
  return {
    id: row.id,
    cluster: row.cluster,
    severity: row.severity,
    alertType: row.alert_type,
    description: row.description,
    objectName: row.object_name,
    firstSeen: row.first_seen,
    dismissed: !!row.dismissed,
    resolved: !!row.resolved,
  };
}

function sourceToJson(row) {
  return {
    id: row.id,
    name: row.name,
    cluster: row.cluster,
    sourceType: row.source_type,
    environment: row.environment,
    protectedCount: row.protected_count,
    unprotectedCount: row.unprotected_count,
    unprotectedBytes: row.unprotected_bytes,
  };
}

// Mirrors the /capacity linear-regression forecast so /report and /overview
// can reuse the same per-cluster slope without duplicating query logic.
function computeClusterForecast(coreApi, clusterRow) {
  const history = coreApi.db
    .prepare('SELECT day, used_bytes FROM rubrik_capacity_history WHERE cluster = ? ORDER BY day ASC')
    .all(clusterRow.name);
  const points = history.map((h, idx) => ({ x: idx, y: h.used_bytes }));
  const n = points.length;
  const sumX = points.reduce((s, p) => s + p.x, 0);
  const sumY = points.reduce((s, p) => s + p.y, 0);
  const sumXY = points.reduce((s, p) => s + p.x * p.y, 0);
  const sumXX = points.reduce((s, p) => s + p.x * p.x, 0);
  const denom = n * sumXX - sumX * sumX;
  let slope = denom !== 0 ? (n * sumXY - sumX * sumY) / denom : 0;
  slope = Math.max(slope, clusterRow.capacity_bytes * 0.0001);

  const lastUsed = history.length > 0 ? history[history.length - 1].used_bytes : clusterRow.used_bytes;
  const runwayDays = Math.max(1, Math.round((clusterRow.capacity_bytes - lastUsed) / slope));
  return { history, slope, lastUsed, runwayDays };
}

const CLUSTER_ENVIRONMENT = { 'rbk-prd-01': 'Production', 'rbk-dr-01': 'DR', 'rbk-dev-01': 'Development' };
const WORKLOAD_TYPE_MAP = { VM: 'VM', 'MSSQL DB': 'SQL', 'NAS Share': 'NAS', 'EC2 Instance': 'EC2' };

function addV2Routes(coreApi, req, res) {
  // --- /alerts ---
  if (req.method === 'GET' && req.path === '/alerts') {
    const q = req.query || {};
    let sql = 'SELECT * FROM rubrik_alerts WHERE 1=1';
    const params = [];
    if (q.severity) {
      sql += ' AND severity = ?';
      params.push(q.severity);
    }
    if (q.resolved != null) {
      sql += ' AND resolved = ?';
      params.push(q.resolved === 'true' || q.resolved === '1' ? 1 : 0);
    }
    if (q.dismissed != null) {
      sql += ' AND dismissed = ?';
      params.push(q.dismissed === 'true' || q.dismissed === '1' ? 1 : 0);
    }
    sql += ' ORDER BY first_seen DESC, id DESC';
    const rows = coreApi.db.prepare(sql).all(...params);
    res.json({ rows: rows.map(alertToJson) });
    return true;
  }

  const alertDismissMatch = req.path.match(/^\/alerts\/(\d+)\/dismiss$/);
  if (alertDismissMatch && req.method === 'POST') {
    const id = Number(alertDismissMatch[1]);
    coreApi.db.prepare('UPDATE rubrik_alerts SET dismissed = 1 WHERE id = ?').run(id);
    const row = coreApi.db.prepare('SELECT * FROM rubrik_alerts WHERE id = ?').get(id);
    if (!row) {
      res.status(404).json({ error: 'not_found' });
      return true;
    }
    res.json(alertToJson(row));
    return true;
  }

  const alertResolveMatch = req.path.match(/^\/alerts\/(\d+)\/resolve$/);
  if (alertResolveMatch && req.method === 'POST') {
    const id = Number(alertResolveMatch[1]);
    const { details } = req.body || {};
    coreApi.db.prepare('UPDATE rubrik_alerts SET resolved = 1, resolution_note = ? WHERE id = ?').run(details || null, id);
    const row = coreApi.db.prepare('SELECT * FROM rubrik_alerts WHERE id = ?').get(id);
    if (!row) {
      res.status(404).json({ error: 'not_found' });
      return true;
    }
    res.json(alertToJson(row));
    return true;
  }

  if (req.method === 'POST' && req.path === '/alerts/resolve') {
    const { ids, details } = req.body || {};
    const list = Array.isArray(ids) ? ids : [];
    const update = coreApi.db.prepare('UPDATE rubrik_alerts SET resolved = 1, resolution_note = ? WHERE id = ?');
    const tx = coreApi.db.transaction((idList) => {
      for (const id of idList) update.run(details || null, Number(id));
    });
    tx(list);
    res.json({ updated: list.length });
    return true;
  }

  // --- /protection ---
  if (req.method === 'GET' && req.path === '/protection') {
    const days = Math.max(1, Math.min(90, parseInt((req.query && req.query.days) || '30', 10) || 30));
    const runs = coreApi.db
      .prepare("SELECT * FROM rubrik_protection_runs WHERE day >= date('now', ?) ORDER BY day ASC")
      .all(`-${days} days`);

    const total = runs.length;
    const successCount = runs.filter((r) => r.status === 'Succeeded').length;
    const failureCount = runs.filter((r) => r.status === 'Failed').length;
    const warningCount = runs.filter((r) => r.status === 'Warning').length;
    const successRate = total > 0 ? Math.round((successCount / total) * 1000) / 10 : 100;

    const statusBreakdown = {};
    for (const r of runs) statusBreakdown[r.status] = (statusBreakdown[r.status] || 0) + 1;

    const byDayMap = new Map();
    for (const r of runs) {
      if (!byDayMap.has(r.day)) byDayMap.set(r.day, { date: r.day, success: 0, failure: 0, warning: 0 });
      const bucket = byDayMap.get(r.day);
      if (r.status === 'Succeeded') bucket.success++;
      else if (r.status === 'Failed') bucket.failure++;
      else if (r.status === 'Warning') bucket.warning++;
    }
    const byDay = Array.from(byDayMap.values()).sort((a, b) => a.date.localeCompare(b.date));

    const errorCounts = new Map();
    for (const r of runs) {
      if (!r.error_message) continue;
      errorCounts.set(r.error_message, (errorCounts.get(r.error_message) || 0) + 1);
    }
    const topErrors = Array.from(errorCounts.entries())
      .map(([errorMessage, count]) => ({ errorMessage, count }))
      .sort((a, b) => b.count - a.count)
      .slice(0, 10);

    const byJob = new Map();
    for (const r of runs) {
      const key = `${r.cluster}|${r.job_name}`;
      if (!byJob.has(key)) byJob.set(key, { cluster: r.cluster, jobName: r.job_name, runs: [] });
      byJob.get(key).runs.push(r);
    }
    const atRiskJobs = [];
    for (const { cluster, jobName, runs: jobRuns } of byJob.values()) {
      jobRuns.sort((a, b) => a.start_ms - b.start_ms);
      const last = jobRuns[jobRuns.length - 1];
      let consecutiveFailures = 0;
      for (let i = jobRuns.length - 1; i >= 0; i--) {
        if (jobRuns[i].status === 'Failed') consecutiveFailures++;
        else break;
      }
      const failures = jobRuns.filter((r) => r.status === 'Failed').length;
      const failureRate = Math.round((failures / jobRuns.length) * 1000) / 10;
      let lastSuccessMs = null;
      for (let i = jobRuns.length - 1; i >= 0; i--) {
        if (jobRuns[i].status === 'Succeeded') {
          lastSuccessMs = jobRuns[i].start_ms;
          break;
        }
      }
      const hoursSinceLastSuccess = lastSuccessMs != null ? Math.round(((Date.now() - lastSuccessMs) / 3600000) * 10) / 10 : null;
      const riskScore = Math.min(100, Math.round(consecutiveFailures * 25 + failureRate * 0.5));
      if (consecutiveFailures >= 2 || failureRate >= 20) {
        atRiskJobs.push({
          cluster,
          jobName,
          lastStatus: last.status,
          consecutiveFailures,
          failureRate,
          hoursSinceLastSuccess,
          riskScore,
          lastRunTime: last.start_ms,
        });
      }
    }
    atRiskJobs.sort((a, b) => b.riskScore - a.riskScore);

    const totalJobs = byJob.size;
    let breachedJobs = 0;
    let nearingBreachJobs = 0;
    for (const { runs: jobRuns } of byJob.values()) {
      const failures = jobRuns.filter((r) => r.status === 'Failed').length;
      const failureRate = failures / jobRuns.length;
      if (failureRate >= 0.5) breachedJobs++;
      else if (failureRate >= 0.2) nearingBreachJobs++;
    }
    const compliantJobs = totalJobs - breachedJobs - nearingBreachJobs;
    const complianceRate = totalJobs > 0 ? Math.round((compliantJobs / totalJobs) * 1000) / 10 : 100;

    res.json({
      summary: { total, successRate, failure: failureCount, warning: warningCount },
      statusBreakdown,
      byDay,
      topErrors,
      atRiskJobs,
      slaSummary: { compliantJobs, nearingBreachJobs, breachedJobs, totalJobs, complianceRate },
    });
    return true;
  }

  // --- /workloads ---
  if (req.method === 'GET' && req.path === '/workloads') {
    const objects = coreApi.db
      .prepare(
        `SELECT o.*, c.name AS cluster_name
         FROM rubrik_protected_objects o
         JOIN rubrik_clusters c ON c.id = o.cluster_id`
      )
      .all();
    const jobCounts = coreApi.db
      .prepare("SELECT cluster, object_name, COUNT(*) AS n FROM rubrik_protection_runs WHERE day >= date('now', '-30 days') GROUP BY cluster, object_name")
      .all();
    const jobCountByKey = new Map(jobCounts.map((j) => [`${j.cluster}|${j.object_name}`, j.n]));

    const byKey = new Map();
    for (const o of objects) {
      const workload = WORKLOAD_TYPE_MAP[o.type];
      if (!workload) continue;
      const key = `${o.cluster_name}|${workload}`;
      if (!byKey.has(key)) {
        byKey.set(key, {
          cluster: o.cluster_name,
          workload,
          protectedCount: 0,
          unprotectedCount: 0,
          jobCount: 0,
          protectedBytes: 0,
          logicalBytes: 0,
          physicalBytes: 0,
        });
      }
      const bucket = byKey.get(key);
      if (o.compliant) bucket.protectedCount++;
      else bucket.unprotectedCount++;
      bucket.jobCount += jobCountByKey.get(`${o.cluster_name}|${o.name}`) || 0;
      bucket.protectedBytes += o.local_storage_bytes || 0;
      bucket.logicalBytes += o.local_storage_bytes || 0;
      bucket.physicalBytes += Math.round((o.local_storage_bytes || 0) * 0.5);
    }
    const rows = Array.from(byKey.values());

    const estateRows = coreApi.db
      .prepare('SELECT * FROM rubrik_workload_history WHERE day = (SELECT MAX(day) FROM rubrik_workload_history) ORDER BY workload')
      .all();
    const jobCountByWorkload = new Map();
    for (const r of rows) jobCountByWorkload.set(r.workload, (jobCountByWorkload.get(r.workload) || 0) + r.jobCount);
    const estate = estateRows.map((r) => ({
      workload: r.workload,
      protectedCount: r.protected_count,
      unprotectedCount: r.unprotected_count,
      jobCount: jobCountByWorkload.get(r.workload) || 0,
      protectedBytes: r.protected_bytes,
      logicalBytes: r.logical_bytes,
      physicalBytes: r.physical_bytes,
    }));

    res.json({ rows, estate });
    return true;
  }

  if (req.method === 'GET' && req.path === '/workloads/trends') {
    const days = Math.max(1, Math.min(365, parseInt((req.query && req.query.days) || '90', 10) || 90));
    const workload = req.query && req.query.workload;
    let sql = "SELECT * FROM rubrik_workload_history WHERE day >= date('now', ?)";
    const params = [`-${days} days`];
    if (workload) {
      sql += ' AND workload = ?';
      params.push(workload);
    }
    sql += ' ORDER BY day ASC';
    const rows = coreApi.db.prepare(sql).all(...params);
    res.json(
      rows.map((r) => ({
        day: r.day,
        workload: r.workload,
        protectedBytes: r.protected_bytes,
        protectedCount: r.protected_count,
        logicalBytes: r.logical_bytes,
        physicalBytes: r.physical_bytes,
      }))
    );
    return true;
  }

  // --- /licensing ---
  if (req.method === 'GET' && req.path === '/licensing') {
    const TB = 1000000000000;
    const meters = coreApi.db
      .prepare('SELECT * FROM rubrik_licensing ORDER BY key')
      .all()
      .map((r) => ({
        key: r.key,
        label: r.label,
        consumedBytes: r.consumed_bytes,
        entitledTb: r.entitled_tb,
        pct: Math.round((r.consumed_bytes / (r.entitled_tb * TB)) * 1000) / 10,
        basis: r.basis,
      }));
    const clusters = coreApi.db.prepare('SELECT * FROM rubrik_clusters ORDER BY id').all();
    const byCluster = clusters.map((c) => {
      const physicalBytes = Math.round(c.used_bytes * 0.4);
      return {
        cluster: c.name,
        frontEndBytes: c.used_bytes,
        physicalBytes,
        capacityBytes: c.capacity_bytes,
        usagePercent: Math.round((c.used_bytes / c.capacity_bytes) * 1000) / 10,
        dataReduction: physicalBytes > 0 ? Math.round((c.used_bytes / physicalBytes) * 10) / 10 : 0,
      };
    });
    res.json({ capturedAt: new Date().toISOString(), meters, byCluster });
    return true;
  }

  // --- /governance ---
  if (req.method === 'GET' && req.path === '/governance') {
    const slaDomains = coreApi.db.prepare('SELECT * FROM rubrik_sla_domains ORDER BY id').all();
    const sources = coreApi.db.prepare('SELECT * FROM rubrik_sources ORDER BY id').all();
    const clusters = coreApi.db.prepare('SELECT * FROM rubrik_clusters ORDER BY id').all();

    const versionCounts = new Map();
    for (const c of clusters) versionCounts.set(c.version, (versionCounts.get(c.version) || 0) + 1);
    let dominantVersion = null;
    let dominantCount = -1;
    for (const [version, count] of versionCounts.entries()) {
      if (count > dominantCount) {
        dominantVersion = version;
        dominantCount = count;
      }
    }

    const policies = slaDomains.map((s) => ({
      name: s.name,
      cluster: null,
      retentionDays: s.retention_days,
      replicationTargets: s.replication_targets ? JSON.parse(s.replication_targets) : [],
      archivalTargets: s.archival_targets ? JSON.parse(s.archival_targets) : [],
      dataLock: !!s.datalock,
      noOffsite: !!s.no_offsite,
    }));

    res.json({
      summary: {
        policyCount: slaDomains.length,
        noOffsiteCount: slaDomains.filter((s) => s.no_offsite).length,
        totalUnprotected: sources.reduce((sum, s) => sum + s.unprotected_count, 0),
        versionSpread: versionCounts.size,
        dominantVersion,
      },
      policies,
      sources: sources.map(sourceToJson),
      versions: clusters.map((c) => ({ cluster: c.name, softwareVersion: c.version, isOutlier: c.version !== dominantVersion })),
    });
    return true;
  }

  // --- /replication/runs ---
  if (req.method === 'GET' && req.path === '/replication/runs') {
    const rows = coreApi.db.prepare('SELECT * FROM rubrik_replication_runs ORDER BY id').all();
    const total = rows.length;
    const active = rows.filter((r) => r.status === 'Active').length;
    const completed = rows.filter((r) => r.status === 'Completed').length;
    const failed = rows.filter((r) => r.status === 'Failed').length;
    res.json({
      summary: { total, active, completed, failed },
      runs: rows.map((r) => ({
        jobName: r.job_name,
        sourceCluster: r.source_cluster,
        targetCluster: r.target_cluster,
        status: r.status,
        startMs: Date.now() - r.start_ms_offset,
        logicalBytes: r.logical_bytes,
        transferredBytes: r.transferred_bytes,
        percentComplete: r.percent_complete,
      })),
    });
    return true;
  }

  // --- /backup-history ---
  if (req.method === 'GET' && req.path === '/backup-history') {
    const days = Math.max(1, Math.min(90, parseInt((req.query && req.query.days) || '30', 10) || 30));
    const q = (req.query && req.query.q) || '';
    const runs = coreApi.db
      .prepare("SELECT * FROM rubrik_protection_runs WHERE day >= date('now', ?) ORDER BY start_ms ASC")
      .all(`-${days} days`);

    const byObject = new Map();
    for (const r of runs) {
      if (q && !r.object_name.toLowerCase().includes(q.toLowerCase())) continue;
      if (!byObject.has(r.object_name)) {
        byObject.set(r.object_name, { name: r.object_name, cluster: r.cluster, groups: new Set(), runs: [] });
      }
      const bucket = byObject.get(r.object_name);
      bucket.groups.add(r.run_type);
      bucket.runs.push({
        id: r.id,
        group: r.run_type,
        status: r.status,
        runType: r.run_type,
        startMs: r.start_ms,
        durationS: r.duration_s,
        logicalBytes: r.logical_bytes,
        errorMessage: r.error_message,
      });
    }

    const servers = Array.from(byObject.values()).map((b) => ({
      name: b.name,
      cluster: b.cluster,
      groups: Array.from(b.groups),
      environment: CLUSTER_ENVIRONMENT[b.cluster] || 'Unknown',
      runs: b.runs,
    }));
    res.json({ servers });
    return true;
  }

  const runDetailMatch = req.path.match(/^\/backup-history\/run\/(\d+)\/detail$/);
  if (runDetailMatch && req.method === 'GET') {
    const id = Number(runDetailMatch[1]);
    const row = coreApi.db.prepare('SELECT * FROM rubrik_protection_runs WHERE id = ?').get(id);
    if (!row) {
      res.status(404).json({ error: 'not_found' });
      return true;
    }
    res.json({
      status: row.status,
      bytesRead: row.logical_bytes,
      warnings: row.status === 'Warning' && row.error_message ? [row.error_message] : [],
      objectSummary: `${row.object_name} (${row.cluster}) — ${row.run_type}`,
    });
    return true;
  }

  // --- /report ---
  if (req.method === 'GET' && req.path === '/report') {
    const clusters = coreApi.db.prepare('SELECT * FROM rubrik_clusters ORDER BY id').all();
    const totalCapacityBytes = clusters.reduce((sum, c) => sum + c.capacity_bytes, 0);
    const usedBytes = clusters.reduce((sum, c) => sum + c.used_bytes, 0);
    const openAlerts = coreApi.db.prepare('SELECT COUNT(*) AS n FROM rubrik_alerts WHERE resolved = 0 AND dismissed = 0').get().n;

    const runs30d = coreApi.db.prepare("SELECT status FROM rubrik_protection_runs WHERE day >= date('now', '-30 days')").all();
    const successRate30d =
      runs30d.length > 0 ? Math.round((runs30d.filter((r) => r.status === 'Succeeded').length / runs30d.length) * 1000) / 10 : 100;

    const byCluster = clusters.map((c) => {
      const physicalBytes = Math.round(c.used_bytes * 0.4);
      return {
        cluster: c.name,
        connection: 'CDM',
        usedBytes: c.used_bytes,
        capacityBytes: c.capacity_bytes,
        usagePercent: Math.round((c.used_bytes / c.capacity_bytes) * 1000) / 10,
        dataReduction: physicalBytes > 0 ? Math.round((c.used_bytes / physicalBytes) * 10) / 10 : 0,
        nodes: c.nodes,
        version: c.version,
      };
    });

    const insights = [];
    let tightest = null;
    for (const c of clusters) {
      const forecast = computeClusterForecast(coreApi, c);
      if (!tightest || forecast.runwayDays < tightest.runwayDays) tightest = { cluster: c.name, runwayDays: forecast.runwayDays };
    }
    if (tightest) {
      insights.push({
        severity: tightest.runwayDays < 60 ? 'critical' : 'warning',
        title: `${tightest.cluster} capacity runway: ${tightest.runwayDays} days`,
        recommendation: `Plan a capacity expansion or archival offload for ${tightest.cluster} before the ${tightest.runwayDays}-day runway is exhausted.`,
      });
    }
    const chronicRuns = coreApi.db
      .prepare(
        "SELECT object_name, COUNT(*) AS failures FROM rubrik_protection_runs WHERE status = 'Failed' AND day >= date('now', '-30 days') GROUP BY object_name HAVING failures >= 5 ORDER BY failures DESC"
      )
      .all();
    if (chronicRuns.length > 0) {
      insights.push({
        severity: 'critical',
        title: `Chronic backup failures on ${chronicRuns.map((r) => r.object_name).join(', ')}`,
        recommendation: 'Investigate credential/connectivity issues on the affected objects — repeated failures over 30 days indicate a persistent root cause, not a transient blip.',
      });
    }
    const openCriticalAnomaly = coreApi.db
      .prepare("SELECT * FROM rubrik_anomaly_events WHERE status = 'Open' ORDER BY anomaly_probability DESC LIMIT 1")
      .get();
    if (openCriticalAnomaly) {
      insights.push({
        severity: 'critical',
        title: `Open ransomware anomaly on ${openCriticalAnomaly.object_name}`,
        recommendation: 'Review the quarantined snapshot and threat hunt results before restoring or resuming backups for this object.',
      });
    }
    const noOffsitePolicies = coreApi.db.prepare('SELECT name FROM rubrik_sla_domains WHERE no_offsite = 1').all();
    if (noOffsitePolicies.length > 0) {
      insights.push({
        severity: 'warning',
        title: `${noOffsitePolicies.map((p) => p.name).join(', ')} SLA has no offsite replication`,
        recommendation: 'Objects on this SLA domain have no replication or archival target — a site-level failure would be unrecoverable.',
      });
    }
    const outlierClusters = clusters.filter((c) => c.software_status === 'Outdated');
    if (outlierClusters.length > 0) {
      insights.push({
        severity: 'warning',
        title: `${outlierClusters.map((c) => c.name).join(', ')} running an outdated version`,
        recommendation: 'Schedule a software upgrade to bring all clusters onto the same release and pick up the latest fixes.',
      });
    }
    if (successRate30d < 95) {
      insights.push({
        severity: successRate30d < 85 ? 'critical' : 'warning',
        title: `30-day protection success rate is ${successRate30d}%`,
        recommendation: 'Review the at-risk jobs list and prioritize remediation for the objects with the highest consecutive failure counts.',
      });
    }

    res.json({
      generatedAt: new Date().toISOString(),
      kpis: {
        totalCapacityBytes,
        usedBytes,
        clusters: clusters.length,
        clustersReporting: clusters.filter((c) => c.status === 'Connected').length,
        openAlerts,
        successRate30d,
      },
      byCluster,
      insights: insights.slice(0, 6),
    });
    return true;
  }

  // --- /sources ---
  if (req.method === 'GET' && req.path === '/sources') {
    const rows = coreApi.db.prepare('SELECT * FROM rubrik_sources ORDER BY id').all();
    const byEnv = new Map();
    for (const r of rows) {
      if (!byEnv.has(r.environment)) byEnv.set(r.environment, { environment: r.environment, protected: 0, total: 0, logicalBytes: 0 });
      const bucket = byEnv.get(r.environment);
      bucket.protected += r.protected_count;
      bucket.total += r.protected_count + r.unprotected_count;
      bucket.logicalBytes += r.unprotected_bytes + r.protected_count * 50000000000;
    }
    res.json({ sources: rows.map(sourceToJson), environments: Array.from(byEnv.values()) });
    return true;
  }

  // --- /analytics/replication ---
  if (req.method === 'GET' && req.path === '/analytics/replication') {
    const days = Math.max(1, Math.min(90, parseInt((req.query && req.query.days) || '30', 10) || 30));
    const cutoffMs = Date.now() - days * 86400000;
    const rows = coreApi.db
      .prepare('SELECT * FROM rubrik_replication_runs')
      .all()
      .filter((r) => Date.now() - r.start_ms_offset >= cutoffMs);
    const pairs = coreApi.db.prepare('SELECT * FROM rubrik_replication_pairs').all();
    const lagByPair = new Map(pairs.map((p) => [`${p.source_cluster}|${p.target_cluster}`, p.lag_seconds]));

    const total = rows.length;
    const successCount = rows.filter((r) => r.status === 'Completed').length;
    const successRate = total > 0 ? Math.round((successCount / total) * 1000) / 10 : 100;
    const totalBytesTransferred = rows.reduce((sum, r) => sum + r.transferred_bytes, 0);

    const byFlow = new Map();
    for (const r of rows) {
      const key = `${r.source_cluster}|${r.target_cluster}`;
      if (!byFlow.has(key)) {
        byFlow.set(key, {
          sourceCluster: r.source_cluster,
          targetCluster: r.target_cluster,
          runCount: 0,
          successCount: 0,
          failureCount: 0,
          totalBytesTransferred: 0,
          avgLagSeconds: lagByPair.get(key) || 0,
          longRunningCount: 0,
          lastSeen: null,
        });
      }
      const bucket = byFlow.get(key);
      bucket.runCount++;
      if (r.status === 'Completed') bucket.successCount++;
      if (r.status === 'Failed') bucket.failureCount++;
      bucket.totalBytesTransferred += r.transferred_bytes;
      if (r.status === 'Active' && r.start_ms_offset > 6 * 3600000) bucket.longRunningCount++;
      const seenMs = Date.now() - r.start_ms_offset;
      if (bucket.lastSeen == null || seenMs > bucket.lastSeen) bucket.lastSeen = seenMs;
    }
    const flows = Array.from(byFlow.values()).map((f) => ({ ...f, lastSeen: f.lastSeen != null ? new Date(f.lastSeen).toISOString() : null }));

    res.json({ summary: { total, successRate, totalBytesTransferred }, flows });
    return true;
  }

  return false;
}

function overviewV2Additions(coreApi) {
  const clusters = coreApi.db.prepare('SELECT * FROM rubrik_clusters ORDER BY id').all();
  const totalCapacityBytes = clusters.reduce((sum, c) => sum + c.capacity_bytes, 0);
  const usedBytes = clusters.reduce((sum, c) => sum + c.used_bytes, 0);
  const freeBytes = totalCapacityBytes - usedBytes;
  const usedPct = totalCapacityBytes > 0 ? Math.round((usedBytes / totalCapacityBytes) * 1000) / 10 : 0;
  const clustersOnline = clusters.filter((c) => c.status === 'Connected').length;

  const activeAlerts = coreApi.db.prepare('SELECT COUNT(*) AS n FROM rubrik_alerts WHERE resolved = 0 AND dismissed = 0').get().n;
  const criticalAlerts = coreApi.db
    .prepare("SELECT COUNT(*) AS n FROM rubrik_alerts WHERE resolved = 0 AND dismissed = 0 AND severity = 'critical'")
    .get().n;

  const runs7d = coreApi.db.prepare("SELECT status FROM rubrik_protection_runs WHERE day >= date('now', '-7 days')").all();
  const successRate7d = runs7d.length > 0 ? Math.round((runs7d.filter((r) => r.status === 'Succeeded').length / runs7d.length) * 1000) / 10 : 100;
  const failed7d = runs7d.filter((r) => r.status === 'Failed').length;

  const totalPhysicalBytes = clusters.reduce((sum, c) => sum + Math.round(c.used_bytes * 0.4), 0);
  const dataReduction = totalPhysicalBytes > 0 ? Math.round((usedBytes / totalPhysicalBytes) * 10) / 10 : 0;

  const capacityHistoryRows = coreApi.db
    .prepare("SELECT cluster, day, used_bytes FROM rubrik_capacity_history WHERE day >= date('now', '-90 days') ORDER BY day ASC")
    .all();
  const capacityByCluster = new Map(clusters.map((c) => [c.name, c.capacity_bytes]));
  const capacityTrend = capacityHistoryRows.map((r) => ({
    day: r.day,
    cluster: r.cluster,
    usedBytes: r.used_bytes,
    capacityBytes: capacityByCluster.get(r.cluster) || 0,
  }));

  const clusterCards = clusters.map((c) => {
    const forecast = computeClusterForecast(coreApi, c);
    const physicalBytes = Math.round(c.used_bytes * 0.4);
    const spark = forecast.history.slice(-14).map((h) => h.used_bytes);
    return {
      cluster: c.name,
      usedPct: c.capacity_bytes > 0 ? Math.round((c.used_bytes / c.capacity_bytes) * 1000) / 10 : 0,
      usedBytes: c.used_bytes,
      capacityBytes: c.capacity_bytes,
      availableBytes: c.capacity_bytes - c.used_bytes,
      savingsX: physicalBytes > 0 ? Math.round((c.used_bytes / physicalBytes) * 10) / 10 : 0,
      spark,
    };
  });

  const recentCriticalAlerts = coreApi.db
    .prepare("SELECT * FROM rubrik_alerts WHERE severity = 'critical' ORDER BY first_seen DESC LIMIT 5")
    .all()
    .map(alertToJson);

  return {
    kpis: {
      totalCapacityBytes,
      usedBytes,
      freeBytes,
      usedPct,
      clustersOnline,
      clustersTotal: clusters.length,
      activeAlerts,
      criticalAlerts,
      successRate7d,
      failed7d,
    },
    storage: { used: usedBytes, free: freeBytes, dataReduction, reporting: clustersOnline },
    capacityTrend,
    clusterCards,
    recentCriticalAlerts,
  };
}

module.exports = { createRouter, connectionToJson, testEndpointReachable, addV2Routes, overviewV2Additions, computeClusterForecast };
