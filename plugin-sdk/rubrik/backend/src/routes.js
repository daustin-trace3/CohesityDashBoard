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

    next();
  };
}

module.exports = { createRouter, connectionToJson, testEndpointReachable };
