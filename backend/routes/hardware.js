const express = require('express');
const { param, query, validationResult } = require('express-validator');
const db = require('../db/database');
const { fetchNodes, fetchNodesV2, fetchChassis } = require('../services/cohesityApi');
const { isDemo } = require('../services/demoMode');
const demoHardware = require('../demo/cohesityHardwareFixtures');

const router = express.Router();

function validate(req, res, next) {
  const errors = validationResult(req);
  if (!errors.isEmpty()) return res.status(400).json({ errors: errors.array() });
  next();
}

/**
 * GET /api/cohesity/hardware/nodes?clusterId=
 * Stored node identity rows (cohesity_nodes) for Server 360 and identity consumers.
 * Declared before /:clusterId so "nodes" is not parsed as a cluster id.
 */
router.get('/nodes', [query('clusterId').optional().isInt({ min: 1 })], validate, (req, res, next) => {
  try {
    const cid = req.query.clusterId ? Number(req.query.clusterId) : null;
    const rows = db.prepare(`
      SELECT n.id, n.cluster_id AS clusterId, c.name AS clusterName, n.node_id AS nodeId, n.hostname, n.ip,
             n.ips_json, n.serial, n.chassis_serial AS chassisSerial, n.model, n.role, n.status,
             n.software_version AS softwareVersion, n.captured_at
        FROM cohesity_nodes n LEFT JOIN clusters c ON c.id = n.cluster_id
       ${cid ? 'WHERE n.cluster_id = ?' : ''} ORDER BY n.cluster_id, n.node_id
    `).all(...(cid ? [cid] : []));
    res.json(rows.map(({ ips_json, captured_at, ...r }) => {
      let ips = [];
      try { ips = ips_json ? JSON.parse(ips_json) : []; } catch { /* leave empty */ }
      return { ...r, ips, capturedAt: captured_at ? new Date(captured_at).toISOString() : null };
    }));
  } catch (err) {
    next(err);
  }
});

/**
 * GET /api/hardware/:clusterId
 * Returns node and hardware information for a cluster.
 */
router.get(
  '/:clusterId',
  [param('clusterId').isInt({ min: 1 })],
  validate,
  async (req, res, next) => {
    try {
      const cluster = db.prepare('SELECT * FROM clusters WHERE id = ?').get(req.params.clusterId);
      if (!cluster) return res.status(404).json({ error: 'Cluster not found' });

      if (isDemo()) {
        return res.json(demoHardware.getHardwareForCluster(cluster.id, cluster.name));
      }

      const [nodesResult, chassisResult, nodesV2Result] = await Promise.allSettled([
        fetchNodes(cluster),
        fetchChassis(cluster),
        fetchNodesV2(cluster)
      ]);

      const nodes = nodesResult.status === 'fulfilled' ? nodesResult.value : [];
      const chassis = chassisResult.status === 'fulfilled' ? chassisResult.value : [];
      const nodesV2 = nodesV2Result.status === 'fulfilled' ? nodesV2Result.value : [];

      // Merge V2 serial/model data into V1 node objects by matching node id
      const v2ById = {};
      for (const n of nodesV2) {
        const nid = n.id ?? n.nodeId;
        if (nid != null) v2ById[String(nid)] = n;
      }
      const mergedNodes = nodes.map(node => {
        const nid = String(node.id ?? node.nodeId ?? '');
        const v2 = v2ById[nid];
        if (!v2) return node;
        // Inject V2 serial / model into the node object so the frontend can find them
        return {
          ...node,
          _v2Serial: v2.serialNumber || v2.serial || null,
          _v2Model: v2.hardwareModel || v2.model || null,
        };
      });

      res.json({ nodes: mergedNodes, chassis });
    } catch (err) {
      next(err);
    }
  }
);

/**
 * POST /api/poller/trigger/:clusterId
 * Manually trigger a poll cycle.
 */
router.post(
  '/trigger/:clusterId',
  [param('clusterId').isInt({ min: 1 })],
  validate,
  async (req, res, next) => {
    try {
      const { triggerPoll } = require('../services/poller');
      await triggerPoll(Number(req.params.clusterId));
      res.json({ success: true, message: 'Poll triggered successfully' });
    } catch (err) {
      next(err);
    }
  }
);

module.exports = router;
