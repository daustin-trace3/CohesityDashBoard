// Estate AI Advisor routes: cross-platform reports, mounted at /api/estate
// like /api/ops-agent (session auth from the /api middleware, no per-platform
// grant, matching the other cross-platform ops surfaces).
const express = require('express');
const { param, validationResult } = require('express-validator');
const estateAdvisor = require('../services/advisors/estateAdvisor');

const router = express.Router();

function validate(req, res, next) {
  const errors = validationResult(req);
  if (!errors.isEmpty()) return res.status(400).json({ errors: errors.array() });
  next();
}

const reportKey = (slug) => String(slug).replace(/-/g, '_');

/** GET /api/estate/advisor/:report — cached report (or null). */
router.get('/advisor/:report', [param('report').isString()], validate, (req, res, next) => {
  try {
    const key = reportKey(req.params.report);
    if (!estateAdvisor.REPORTS.includes(key)) return res.status(404).json({ error: 'Unknown report.' });
    res.json({ enabled: estateAdvisor.isConfigured(), report: estateAdvisor.getCachedReport(key) });
  } catch (err) { next(err); }
});

/** POST /api/estate/advisor/:report — (re)generate and cache. */
router.post('/advisor/:report', [param('report').isString()], validate, async (req, res, next) => {
  try {
    const key = reportKey(req.params.report);
    if (!estateAdvisor.REPORTS.includes(key)) return res.status(404).json({ error: 'Unknown report.' });
    res.json(await estateAdvisor.generateReport(key));
  } catch (err) {
    if (err.code === 'LLM_NOT_CONFIGURED') {
      return res.status(503).json({ error: 'AI analysis is not configured. Add a provider under Global Settings > AI.' });
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
