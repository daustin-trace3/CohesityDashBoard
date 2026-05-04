const express = require('express');
const { param, validationResult } = require('express-validator');
const db = require('../db/database');
const { fetchNodes, fetchNodesV2, fetchChassis } = require('../services/cohesityApi');

const router = express.Router();

function validate(req, res, next) {
  const errors = validationResult(req);
  if (!errors.isEmpty()) return res.status(400).json({ errors: errors.array() });
  next();
}

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
