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
// 2026) or ISO strings (current) — normalize to epoch seconds in SQL. Copied
// from backupHistory.js so this route resolves runs identically.
const startEpoch = "CAST(CASE WHEN pr.start_time LIKE '20%' THEN strftime('%s', pr.start_time) ELSE pr.start_time END AS INTEGER)";
const endEpoch = "CAST(CASE WHEN pr.end_time LIKE '20%' THEN strftime('%s', pr.end_time) ELSE pr.end_time END AS INTEGER)";

/**
 * GET /api/cohesity/object-360/suggest?q=
 * Typeahead names for the Object 360 picker.
 */
router.get(
  '/suggest',
  [query('q').isString().trim().isLength({ min: 1, max: 200 })],
  validate,
  (req, res, next) => {
    try {
      const q = String(req.query.q || '').trim();
      const pattern = `%${q.replace(/[%_\\]/g, (c) => `\\${c}`)}%`;
      const rows = db.prepare(`
        SELECT DISTINCT name FROM cohesity_objects
        WHERE name LIKE ? ESCAPE '\\'
        ORDER BY name COLLATE NOCASE
        LIMIT 10
      `).all(pattern);
      res.json({ names: rows.map((r) => r.name) });
    } catch (err) {
      next(err);
    }
  }
);

/**
 * GET /api/cohesity/object-360?name=
 * Everything the estate knows about one Cohesity object: protection posture
 * on every cluster it's registered on, its groups' runs over the last 14
 * days (with replication legs), its agent(s), and unresolved cluster alerts.
 */
router.get(
  '/',
  [query('name').isString().trim().isLength({ min: 1, max: 300 })],
  validate,
  (req, res, next) => {
    try {
      const name = String(req.query.name || '').trim();

      const rows = db.prepare(`
        SELECT o.id, o.name, o.environment, o.object_type, o.os_type, o.source_name,
               o.is_protected, o.protection_groups, o.policy_names,
               o.last_backup_status, o.last_backup_ms, o.sla_violated, o.logical_bytes,
               o.cluster_id, c.name AS cluster_name
        FROM cohesity_objects o
        JOIN clusters c ON c.id = o.cluster_id
        WHERE lower(o.name) = lower(?)
        ORDER BY o.name, c.name
      `).all(name);

      if (rows.length === 0) {
        return res.json({ query: name, found: false, objects: [], runs14d: [], replication: [], agents: [], alerts: [] });
      }

      const objects = rows.map((o) => {
        let protectionGroups = [];
        try { protectionGroups = JSON.parse(o.protection_groups || '[]'); } catch { /* malformed */ }
        let policyNames = [];
        try { policyNames = JSON.parse(o.policy_names || '[]'); } catch { /* malformed */ }
        return {
          id: o.id,
          name: o.name,
          environment: o.environment,
          objectType: o.object_type,
          osType: o.os_type,
          isProtected: !!o.is_protected,
          clusterName: o.cluster_name,
          protectionGroups,
          policyNames,
          lastBackupStatus: o.last_backup_status,
          lastBackupMs: o.last_backup_ms,
          slaViolated: o.sla_violated == null ? null : !!o.sla_violated,
          logicalBytes: o.logical_bytes,
          sourceName: o.source_name,
        };
      });

      // group -> Set(cluster_id), and cluster_id -> cluster_name, across every
      // registration of this object — same fan-out backupHistory.js uses.
      const groupClusters = new Map();
      const clusterNames = new Map();
      const clusterIds = new Set();
      for (const o of rows) {
        clusterIds.add(o.cluster_id);
        clusterNames.set(o.cluster_id, o.cluster_name);
        let groups = [];
        try { groups = JSON.parse(o.protection_groups || '[]'); } catch { /* malformed */ }
        for (const g of groups) {
          if (!groupClusters.has(g)) groupClusters.set(g, new Set());
          groupClusters.get(g).add(o.cluster_id);
        }
      }

      const cutoff = Math.floor(Date.now() / 1000) - 14 * 86400;
      const repStmt = db.prepare(`
        SELECT target_cluster_name, status, logical_bytes, lag_seconds
        FROM replication_runs WHERE protection_run_id = ?
      `);

      const runs14d = [];
      const replication = [];
      for (const [group, ids] of groupClusters) {
        const idList = [...ids];
        const runRows = db.prepare(`
          SELECT pr.id, pr.cluster_id, pr.run_type, pr.status,
                 ${startEpoch} AS start_epoch, ${endEpoch} AS end_epoch,
                 pr.error_message, pr.logical_bytes
          FROM protection_runs pr
          WHERE pr.cluster_id IN (${idList.map(() => '?').join(',')})
            AND pr.job_name IN (?, ?) AND ${startEpoch} >= ?
          ORDER BY start_epoch ASC
        `).all(...idList, group, `vc${group}`, cutoff);
        for (const r of runRows) {
          runs14d.push({
            id: r.id,
            group,
            clusterName: clusterNames.get(r.cluster_id) || null,
            runType: r.run_type,
            status: r.status,
            startMs: r.start_epoch ? r.start_epoch * 1000 : null,
            endMs: r.end_epoch ? r.end_epoch * 1000 : null,
            logicalBytes: r.logical_bytes,
            errorMessage: r.error_message,
          });
          for (const leg of repStmt.all(r.id)) {
            replication.push({
              group,
              targetCluster: leg.target_cluster_name,
              status: leg.status,
              logicalBytes: leg.logical_bytes,
              lagSeconds: leg.lag_seconds,
              startMs: r.start_epoch ? r.start_epoch * 1000 : null,
            });
          }
        }
      }
      runs14d.sort((a, b) => (a.startMs || 0) - (b.startMs || 0));

      const idList = [...clusterIds];
      const agents = idList.length ? db.prepare(`
        SELECT agent_version, agent_status, upgradability, cluster_id
        FROM cohesity_agents
        WHERE cluster_id IN (${idList.map(() => '?').join(',')}) AND lower(name) = lower(?)
      `).all(...idList, name).map((a) => ({
        agentVersion: a.agent_version,
        agentStatus: a.agent_status,
        upgradability: a.upgradability,
        clusterName: clusterNames.get(a.cluster_id) || null,
      })) : [];

      const alerts = idList.length ? db.prepare(`
        SELECT id, severity, alert_type, description, cluster_id, first_seen
        FROM alerts
        WHERE cluster_id IN (${idList.map(() => '?').join(',')}) AND resolved = 0 AND dismissed = 0
        ORDER BY first_seen DESC
        LIMIT 10
      `).all(...idList).map((a) => ({
        id: a.id,
        severity: a.severity,
        alertType: a.alert_type,
        message: a.description,
        clusterName: clusterNames.get(a.cluster_id) || null,
        firstSeen: a.first_seen,
      })) : [];

      res.json({ query: name, found: true, objects, runs14d, replication, agents, alerts });
    } catch (err) {
      next(err);
    }
  }
);

module.exports = router;
