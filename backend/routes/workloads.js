const express = require('express');
const { query, validationResult } = require('express-validator');
const db = require('../db/database');
const { getWorkloads, getWorkloadTrends, refreshAllWorkloads } = require('../services/workloads');

const router = express.Router();

/** GET /api/cohesity/workloads — latest per-cluster workload breakdown + estate rollup. */
router.get('/', (req, res, next) => {
  try {
    res.json(getWorkloads());
  } catch (err) {
    next(err);
  }
});

/** GET /api/cohesity/workloads/trends?clusterId=&environment=&days= — daily trend series. */
router.get('/trends', [
  query('clusterId').optional().isInt({ min: 1 }).toInt(),
  query('environment').optional().isString().trim().isLength({ max: 64 }),
  query('days').optional().isInt({ min: 7, max: 730 }).toInt(),
], (req, res, next) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) return res.status(400).json({ error: 'Invalid parameters', details: errors.array() });
  try {
    res.json(getWorkloadTrends({
      clusterId: req.query.clusterId ?? null,
      environment: req.query.environment || null,
      days: req.query.days ?? 90,
    }));
  } catch (err) {
    next(err);
  }
});

/**
 * GET /api/cohesity/workloads/sources — per-object inventory from the object
 * search, plus a per-environment rollup for the workload-type chips.
 */
router.get('/sources', (req, res, next) => {
  try {
    const objects = db.prepare(`
      SELECT o.*, c.name AS cluster_name
      FROM cohesity_objects o
      JOIN clusters c ON c.id = o.cluster_id
      ORDER BY c.name, o.name
    `).all().map((o) => ({
      ...o,
      protection_groups: o.protection_groups ? JSON.parse(o.protection_groups) : [],
      policy_names: o.policy_names ? JSON.parse(o.policy_names) : [],
    }));
    const byEnv = {};
    for (const o of objects) {
      const e = (byEnv[o.environment] ||= { environment: o.environment, total: 0, protected: 0, logicalBytes: 0 });
      e.total += 1;
      if (o.is_protected) e.protected += 1;
      e.logicalBytes += o.logical_bytes || 0;
    }
    res.json({
      objects,
      environments: Object.values(byEnv).sort((a, b) => b.total - a.total),
      capturedAt: objects[0]?.captured_at || null,
    });
  } catch (err) {
    next(err);
  }
});

/** POST /api/cohesity/workloads/refresh — force a snapshot on every cluster now. */
router.post('/refresh', async (req, res, next) => {
  try {
    const results = await refreshAllWorkloads();
    res.json({ results, ...getWorkloads() });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
