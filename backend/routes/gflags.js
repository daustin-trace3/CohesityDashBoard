const express = require('express');
const { query, validationResult } = require('express-validator');
const db = require('../db/database');
const { getGflags, getGflagChanges, refreshGflags, refreshAllGflags } = require('../services/gflags');

const router = express.Router();

const validate = (req, res, next) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) return res.status(400).json({ error: errors.array()[0].msg });
  next();
};

/** GET /api/cohesity/gflags — current gflag state across all direct clusters. */
router.get('/', (req, res, next) => {
  try {
    res.json(getGflags());
  } catch (err) { next(err); }
});

/** GET /api/cohesity/gflags/changes?clusterId=&flag=&days= — audit history. */
router.get('/changes', [
  query('clusterId').optional().isInt().toInt(),
  query('flag').optional().isString().trim(),
  query('days').optional().isInt({ min: 1, max: 3650 }).toInt(),
], validate, (req, res, next) => {
  try {
    res.json({ changes: getGflagChanges(req.query) });
  } catch (err) { next(err); }
});

/** POST /api/cohesity/gflags/refresh?clusterId= — on-demand pull (all direct
 *  clusters, or one). The scheduled poll is only daily, so support-case
 *  moments go through here. */
router.post('/refresh', [
  query('clusterId').optional().isInt().toInt(),
], validate, async (req, res, next) => {
  try {
    if (req.query.clusterId) {
      const cluster = db.prepare("SELECT * FROM clusters WHERE id = ? AND connection_type = 'direct'")
        .get(req.query.clusterId);
      if (!cluster) return res.status(404).json({ error: 'Direct-connected cluster not found.' });
      const result = await refreshGflags(cluster);
      return res.json({ results: [{ clusterId: cluster.id, name: cluster.name, ...result }] });
    }
    res.json({ results: await refreshAllGflags() });
  } catch (err) { next(err); }
});

/** GET /api/cohesity/gflags/export?clusterId=&format=csv|json — support-case
 *  export, values exactly as the cluster reported them. */
router.get('/export', [
  query('clusterId').isInt().toInt().withMessage('clusterId is required'),
  query('format').optional().isIn(['csv', 'json']),
], validate, (req, res, next) => {
  try {
    const cluster = db.prepare('SELECT id, name FROM clusters WHERE id = ?').get(req.query.clusterId);
    if (!cluster) return res.status(404).json({ error: 'Cluster not found.' });
    const rows = db.prepare(`
      SELECT service_name, flag_name, flag_value, reason, source_timestamp, captured_at
      FROM cluster_gflags WHERE cluster_id = ? ORDER BY service_name, flag_name
    `).all(cluster.id);

    const safeName = String(cluster.name).replace(/[^A-Za-z0-9._-]/g, '_');
    const date = new Date().toISOString().slice(0, 10);

    if (req.query.format === 'json') {
      res.setHeader('Content-Disposition', `attachment; filename="${safeName}-gflags-${date}.json"`);
      return res.json({ cluster: cluster.name, exportedAt: new Date().toISOString(), gflags: rows });
    }

    const esc = (v) => {
      const s = v == null ? '' : String(v);
      return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
    };
    const header = ['Service', 'Flag Name', 'Value', 'Reason', 'Set Timestamp', 'Captured At'];
    const lines = [header.map(esc).join(',')];
    for (const r of rows) {
      lines.push([r.service_name, r.flag_name, r.flag_value, r.reason,
        r.source_timestamp ?? '', r.captured_at].map(esc).join(','));
    }
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="${safeName}-gflags-${date}.csv"`);
    res.send(lines.join('\r\n'));
  } catch (err) { next(err); }
});

module.exports = router;
