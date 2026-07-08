const express = require('express');
const { param, query, validationResult } = require('express-validator');
const db = require('../db/database');
const { computeInsights } = require('../services/insights');
const { analyzeClusterWithLLM, getCachedClusterAnalysis, isConfigured, MODES } = require('../services/llm');

const router = express.Router();

function validate(req, res, next) {
  const errors = validationResult(req);
  if (!errors.isEmpty()) return res.status(400).json({ errors: errors.array() });
  next();
}

function resolveMode(req) {
  const m = req.query.mode;
  return MODES.includes(m) ? m : 'system';
}

/**
 * GET /api/insights
 * Rule-based prioritized insights across capacity, availability, alerts,
 * data protection, replication, and governance. Pure SQLite reads — fast.
 */
router.get('/', (req, res, next) => {
  try {
    res.json(computeInsights());
  } catch (err) {
    next(err);
  }
});

/**
 * GET /api/insights/ai/config
 * Reports whether LLM analysis is available so the UI can label the action.
 */
router.get('/ai/config', (req, res) => {
  res.json({ enabled: isConfigured() });
});

/**
 * GET /api/insights/ai/:clusterId?mode=alerts|system
 * Returns the cached LLM analysis for a cluster + mode, if one exists.
 */
router.get(
  '/ai/:clusterId',
  [param('clusterId').isInt({ min: 1 }), query('mode').optional().isIn(MODES)],
  validate,
  (req, res, next) => {
    try {
      const cached = getCachedClusterAnalysis(req.params.clusterId, resolveMode(req));
      res.json({ enabled: isConfigured(), analysis: cached });
    } catch (err) {
      next(err);
    }
  }
);

/**
 * POST /api/insights/ai/:clusterId?mode=alerts|system
 * Runs an on-demand LLM analysis for the cluster in the given mode and caches it.
 */
router.post(
  '/ai/:clusterId',
  [param('clusterId').isInt({ min: 1 }), query('mode').optional().isIn(MODES)],
  validate,
  async (req, res, next) => {
    try {
      const cluster = db.prepare('SELECT id FROM clusters WHERE id = ?').get(req.params.clusterId);
      if (!cluster) return res.status(404).json({ error: 'Cluster not found.' });

      const result = await analyzeClusterWithLLM(req.params.clusterId, resolveMode(req));
      res.json(result);
    } catch (err) {
      if (err.code === 'LLM_NOT_CONFIGURED') {
        return res.status(503).json({ error: 'AI analysis is not configured. Add an OpenAI or GitHub Models token under Settings → Credentials.' });
      }
      if (err.code === 'LLM_RATE_LIMITED') {
        if (err.retryAfter) res.set('Retry-After', String(err.retryAfter));
        return res.status(429).json({ error: err.message, retryAfter: err.retryAfter });
      }
      if (err.code === 'CLUSTER_NOT_FOUND') {
        return res.status(404).json({ error: 'Cluster not found.' });
      }
      if (err.code === 'LLM_REQUEST_FAILED' || err.code === 'LLM_EMPTY') {
        return res.status(502).json({ error: err.message });
      }
      next(err);
    }
  }
);

module.exports = router;
