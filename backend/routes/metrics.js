const express = require('express');
const { param, query, validationResult } = require('express-validator');
const db = require('../db/database');

const router = express.Router();

function validate(req, res, next) {
  const errors = validationResult(req);
  if (!errors.isEmpty()) return res.status(400).json({ errors: errors.array() });
  next();
}

/**
 * GET /api/metrics/:clusterId/history?days=7
 */
router.get(
  '/:clusterId/history',
  [
    param('clusterId').isInt({ min: 1 }),
    query('days').optional().isInt({ min: 1, max: 365 })
  ],
  validate,
  (req, res, next) => {
    try {
      const { clusterId } = req.params;
      const days = parseInt(req.query.days || '7', 10);

      const cluster = db.prepare('SELECT id FROM clusters WHERE id = ?').get(clusterId);
      if (!cluster) return res.status(404).json({ error: 'Cluster not found' });

      const rows = db.prepare(`
        SELECT id, cluster_id, captured_at, total_capacity_bytes, used_bytes,
               logical_bytes, data_reduction_ratio, software_version, node_count
        FROM metrics_history
        WHERE cluster_id = ?
          AND captured_at >= datetime('now', ? || ' days')
        ORDER BY captured_at ASC
      `).all(clusterId, `-${days}`);

      res.json(rows);
    } catch (err) {
      next(err);
    }
  }
);

module.exports = router;
