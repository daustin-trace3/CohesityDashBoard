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
      return res.status(503).json({ error: 'AI analysis is not configured. Add an OpenAI or GitHub Models token under Settings → Credentials.' });
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

/** POST /api/advisor/:report/email - ad-hoc send of the cached report via
 *  the alert SMTP server (user-clicked, never scheduled; like the SMTP test
 *  button it needs host + from, not the notifications enable switch). */
router.post('/:report/email', [param('report').isString()], validate, async (req, res) => {
  try {
    const key = reportKey(req.params.report);
    if (!REPORTS.includes(key)) return res.status(404).json({ error: 'Unknown report.' });
    const cached = getCachedReport(key);
    if (!cached) return res.status(404).json({ error: 'No generated report to send. Run the report first.' });
    const { getNotificationSettings } = require('../services/settings');
    const { sendCachedReportEmail } = require('../services/platformAdvisor');
    const config = getNotificationSettings();
    if (!config.smtpHost || !config.smtpFrom) {
      return res.status(409).json({ error: 'SMTP is not configured. Set at least the server and from address under Global Settings > Alert Notifications.' });
    }
    const to = String((req.body && req.body.recipients) || '').trim() || config.smtpRecipients;
    if (!to) return res.status(400).json({ error: 'No recipients. Enter addresses or set default alert recipients in Global Settings.' });
    await sendCachedReportEmail({ platformLabel: 'Cohesity', noun: key.replace(/_/g, ' '), cached, config, to });
    res.json({ ok: true, to });
  } catch (err) {
    res.status(502).json({ error: `Email failed: ${err.message}` });
  }
});

module.exports = router;
