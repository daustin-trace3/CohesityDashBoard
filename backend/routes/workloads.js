const express = require('express');
const { query, validationResult } = require('express-validator');
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
