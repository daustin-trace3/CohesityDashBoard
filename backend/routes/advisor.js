const express = require('express');
const { param, validationResult } = require('express-validator');
const { REPORTS, generateReport, getCachedReport, isConfigured } = require('../services/aiAdvisor');

const router = express.Router();

function validate(req, res, next) {
  const errors = validationResult(req);
  if (!errors.isEmpty()) return res.status(400).json({ errors: errors.array() });
  next();
}

// Map URL slug (dr-readiness) to storage key (dr_readiness).
function reportKey(slug) {
  return String(slug).replace(/-/g, '_');
}

/** GET /api/advisor/:report — cached fleet report (capacity | dr-readiness). */
router.get('/:report', [param('report').isString()], validate, (req, res, next) => {
  try {
    const key = reportKey(req.params.report);
    if (!REPORTS.includes(key)) return res.status(404).json({ error: 'Unknown report.' });
    res.json({ enabled: isConfigured(), report: getCachedReport(key) });
  } catch (err) {
    next(err);
  }
});

/** POST /api/advisor/:report — (re)generate and cache a fleet report. */
router.post('/:report', [param('report').isString()], validate, async (req, res, next) => {
  try {
    const key = reportKey(req.params.report);
    if (!REPORTS.includes(key)) return res.status(404).json({ error: 'Unknown report.' });
    const result = await generateReport(key);
    res.json(result);
  } catch (err) {
    if (err.code === 'LLM_NOT_CONFIGURED') {
      return res.status(503).json({ error: 'AI analysis is not configured. Set OPENAI_TOKEN (or GITHUB_MODELS_TOKEN) in the server environment.' });
    }
    if (err.code === 'LLM_RATE_LIMITED') {
      if (err.retryAfter) res.set('Retry-After', String(err.retryAfter));
      return res.status(429).json({ error: err.message, retryAfter: err.retryAfter });
    }
    if (err.code === 'LLM_REQUEST_FAILED' || err.code === 'LLM_EMPTY') {
      return res.status(502).json({ error: err.message });
    }
    next(err);
  }
});

module.exports = router;
