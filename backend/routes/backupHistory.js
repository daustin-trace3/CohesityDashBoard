const express = require('express');
const { query, validationResult } = require('express-validator');
const db = require('../db/database');

const router = express.Router();

function validate(req, res, next) {
  const errors = validationResult(req);
  if (!errors.isEmpty()) return res.status(400).json({ errors: errors.array() });
  next();
}

// protection_runs.start_time/end_time hold epoch seconds (pollers before May
// 2026) or ISO strings (current) — normalize to epoch seconds in SQL.
const startEpoch = "CAST(CASE WHEN pr.start_time LIKE '20%' THEN strftime('%s', pr.start_time) ELSE pr.start_time END AS INTEGER)";
const endEpoch = "CAST(CASE WHEN pr.end_time LIKE '20%' THEN strftime('%s', pr.end_time) ELSE pr.end_time END AS INTEGER)";

/**
 * GET /api/cohesity/backup-history?q=<server>&days=30
 * Per-server day-by-day backup history: matches cohesity_objects by name,
 * follows each object's protection groups to their runs on the same cluster,
 * and attaches replication legs. Group-run granularity — a day is "protected"
 * when the object's group(s) ran that day.
 */
router.get(
  '/',
  [
    query('q').optional().isString().trim().isLength({ max: 200 }),
    query('days').optional().isInt({ min: 1, max: 31 }),
  ],
  validate,
  (req, res, next) => {
    try {
      const q = String(req.query.q || '').trim();
      const days = Math.min(Number(req.query.days) || 30, 31);
      const cutoff = Math.floor(Date.now() / 1000) - days * 86400;

      const objectCols = `
        SELECT o.id, o.name, o.environment, o.object_type, o.os_type, o.source_name,
               o.is_protected, o.protection_groups, o.policy_names,
               o.last_backup_status, o.sla_violated, o.logical_bytes,
               o.cluster_id, c.name AS cluster_name
        FROM cohesity_objects o
        JOIN clusters c ON c.id = o.cluster_id`;

      let objects;
      if (q.length >= 2) {
        const pattern = `%${q.replace(/[%_\\]/g, (c) => `\\${c}`)}%`;
        objects = db.prepare(`
          ${objectCols}
          WHERE o.name LIKE ? ESCAPE '\\'
          ORDER BY o.name, c.name
          LIMIT 50
        `).all(pattern);
      } else {
        // Browse mode (no/short query): first 25 protected servers A→Z, with
        // every registration row for those names so the merge works.
        const names = db.prepare(`
          SELECT DISTINCT name FROM cohesity_objects
          WHERE is_protected = 1 AND protection_groups IS NOT NULL
          ORDER BY name COLLATE NOCASE LIMIT 25
        `).all().map((r) => r.name);
        objects = names.length ? db.prepare(`
          ${objectCols}
          WHERE o.name IN (${names.map(() => '?').join(',')})
          ORDER BY o.name, c.name
        `).all(...names) : [];
      }

      const repStmt = db.prepare(`
        SELECT target_cluster_name, status, logical_bytes, lag_seconds
        FROM replication_runs WHERE protection_run_id = ?
      `);

      // The same server is often registered on several clusters while its
      // group runs on one — merge to ONE row per server name, with each run
      // labeled by the cluster it actually ran on.
      const byName = new Map();
      for (const o of objects) {
        let groups = [];
        try { groups = JSON.parse(o.protection_groups || '[]'); } catch { /* malformed */ }
        let policies = [];
        try { policies = JSON.parse(o.policy_names || '[]'); } catch { /* malformed */ }
        const key = o.name.toLowerCase();
        if (!byName.has(key)) {
          byName.set(key, {
            name: o.name,
            clusters: new Set(),
            groupClusters: new Map(), // group -> Set(cluster_id)
            clusterNames: new Map(), // cluster_id -> name
            environment: o.environment,
            objectType: o.object_type,
            osType: o.os_type,
            sourceName: o.source_name,
            isProtected: false,
            policies: new Set(),
            lastBackupStatus: o.last_backup_status,
            slaViolated: o.sla_violated == null ? null : !!o.sla_violated,
            logicalBytes: o.logical_bytes,
          });
        }
        const s = byName.get(key);
        s.clusters.add(o.cluster_name);
        s.clusterNames.set(o.cluster_id, o.cluster_name);
        s.isProtected = s.isProtected || !!o.is_protected;
        s.environment = s.environment || o.environment;
        s.osType = s.osType || o.os_type;
        for (const g of groups) {
          if (!s.groupClusters.has(g)) s.groupClusters.set(g, new Set());
          s.groupClusters.get(g).add(o.cluster_id);
        }
        for (const p of policies) s.policies.add(p);
      }

      const servers = [...byName.values()].map((s) => {
        const runs = [];
        for (const [group, clusterIds] of s.groupClusters) {
          const ids = [...clusterIds];
          // v1 run history sometimes names the job with the vCenter's 'vc'
          // prefix while the v2 object inventory reports the group without it
          // (e.g. runs 'vcsnx2gcpra-OraOS' vs group 'snx2gcpra-OraOS') —
          // match both forms.
          const rows = db.prepare(`
            SELECT pr.id, pr.cluster_id, pr.run_type, pr.status,
                   ${startEpoch} AS start_epoch, ${endEpoch} AS end_epoch,
                   pr.error_code, pr.error_message, pr.logical_bytes
            FROM protection_runs pr
            WHERE pr.cluster_id IN (${ids.map(() => '?').join(',')})
              AND pr.job_name IN (?, ?) AND ${startEpoch} >= ?
            ORDER BY start_epoch ASC
          `).all(...ids, group, `vc${group}`, cutoff);
          for (const r of rows) {
            runs.push({
              id: r.id,
              group,
              clusterName: s.clusterNames.get(r.cluster_id) || null,
              runType: r.run_type,
              status: r.status,
              startMs: r.start_epoch ? r.start_epoch * 1000 : null,
              endMs: r.end_epoch ? r.end_epoch * 1000 : null,
              logicalBytes: r.logical_bytes,
              errorCode: r.error_code,
              errorMessage: r.error_message,
              replication: repStmt.all(r.id).map((x) => ({
                targetCluster: x.target_cluster_name,
                status: x.status,
                logicalBytes: x.logical_bytes,
                lagSeconds: x.lag_seconds,
              })),
            });
          }
        }
        runs.sort((a, b) => (a.startMs || 0) - (b.startMs || 0));
        return {
          name: s.name,
          clusters: [...s.clusters],
          sourceName: s.sourceName,
          environment: s.environment,
          objectType: s.objectType,
          osType: s.osType,
          isProtected: s.isProtected,
          groups: [...s.groupClusters.keys()],
          policies: [...s.policies],
          lastBackupStatus: s.lastBackupStatus,
          slaViolated: s.slaViolated,
          logicalBytes: s.logicalBytes,
          runs,
        };
      }).sort(q.length >= 2
        ? (a, b) => (b.runs.length - a.runs.length) || a.name.localeCompare(b.name)
        : (a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }));

      res.json({ query: q, days, browse: q.length < 2, servers });
    } catch (err) {
      next(err);
    }
  }
);

module.exports = router;
