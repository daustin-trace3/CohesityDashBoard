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
 * GET /api/alerts?clusterId=&severity=&resolved=
 */
router.get(
  '/',
  [
    query('clusterId').optional().isInt({ min: 1 }),
    query('severity').optional().isIn(['critical', 'warning', 'info', '']),
    query('resolved').optional().isIn(['0', '1', 'true', 'false', '']),
    query('dismissed').optional().isIn(['0', '1', 'true', 'false', ''])
  ],
  validate,
  (req, res, next) => {
    try {
      const { clusterId, severity, resolved, dismissed } = req.query;

      let sql = `
        SELECT a.*, c.name AS cluster_name
        FROM alerts a
        JOIN clusters c ON a.cluster_id = c.id
        WHERE 1=1
      `;
      const params = [];

      if (clusterId) {
        sql += ' AND a.cluster_id = ?';
        params.push(Number(clusterId));
      }
      if (severity) {
        sql += ' AND a.severity = ?';
        params.push(severity.toLowerCase());
      }
      if (resolved !== undefined && resolved !== '') {
        sql += ' AND a.resolved = ?';
        params.push(resolved === '1' || resolved === 'true' ? 1 : 0);
      }
      if (dismissed !== undefined && dismissed !== '') {
        sql += ' AND a.dismissed = ?';
        params.push(dismissed === '1' || dismissed === 'true' ? 1 : 0);
      } else {
        // Default: hide dismissed
        sql += ' AND a.dismissed = 0';
      }

      sql += ' ORDER BY a.last_updated DESC LIMIT 500';

      const alerts = db.prepare(sql).all(...params);
      res.json(alerts);
    } catch (err) {
      next(err);
    }
  }
);

/**
 * POST /api/alerts/:id/dismiss
 */
router.post(
  '/:id/dismiss',
  [param('id').isInt({ min: 1 })],
  validate,
  (req, res, next) => {
    try {
      const { id } = req.params;
      const alert = db.prepare('SELECT id FROM alerts WHERE id = ?').get(id);
      if (!alert) return res.status(404).json({ error: 'Alert not found' });

      db.prepare('UPDATE alerts SET dismissed = 1, last_updated = CURRENT_TIMESTAMP WHERE id = ?').run(id);
      res.json({ success: true });
    } catch (err) {
      next(err);
    }
  }
);

module.exports = router;
