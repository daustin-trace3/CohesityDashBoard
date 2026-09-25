// Operations Agent: incidents the agent opened, its triage, and manual
// actions. Reachable to any authenticated caller like /api/service-status;
// settings live under /api/settings (admin).
const express = require('express');
const agent = require('../services/opsAgent');

const router = express.Router();

function fail(res, err) {
  if (err.code === 'NOT_FOUND') return res.status(404).json({ error: err.message });
  if (err.code === 'LLM_NOT_CONFIGURED') return res.status(503).json({ error: err.message });
  if (err.code === 'LLM_RATE_LIMITED') return res.status(429).json({ error: err.message, retryAfter: err.retryAfter });
  if (err.code === 'SMTP_NOT_CONFIGURED' || err.code === 'NO_RECIPIENTS') return res.status(409).json({ error: err.message });
  if (err.code === 'SMTP_FAILED' || err.code === 'LLM_REQUEST_FAILED') return res.status(502).json({ error: err.message, detail: err.detail });
  return null;
}

router.get('/status', (req, res, next) => {
  try { res.json(agent.status()); } catch (err) { next(err); }
});

/** Live-update probe: tiny, uncached, safe to call every few seconds. */
router.get('/pulse', (req, res, next) => {
  try {
    res.set('Cache-Control', 'no-store');
    res.json(agent.pulse());
  } catch (err) { next(err); }
});

router.get('/incidents', (req, res, next) => {
  try {
    const state = ['open', 'resolved', 'all'].includes(req.query.state) ? req.query.state : 'open';
    const limit = Number(req.query.limit) || 100;
    res.json(agent.listIncidents({ state, limit }));
  } catch (err) { next(err); }
});

router.get('/incidents/:id', (req, res, next) => {
  try {
    const inc = agent.getIncident(Number(req.params.id));
    if (!inc) return res.status(404).json({ error: 'Incident not found.' });
    res.json(inc);
  } catch (err) { next(err); }
});

router.post('/incidents/:id/retriage', async (req, res, next) => {
  try { res.json(await agent.retriage(Number(req.params.id))); } catch (err) { if (!fail(res, err)) next(err); }
});

router.post('/incidents/:id/resend', async (req, res, next) => {
  try { res.json(await agent.resend(Number(req.params.id))); } catch (err) { if (!fail(res, err)) next(err); }
});

router.post('/incidents/:id/resolve', (req, res, next) => {
  try {
    const by = req.auth?.user?.username || req.user?.username || 'manual';
    res.json(agent.resolve(Number(req.params.id), by));
  } catch (err) { if (!fail(res, err)) next(err); }
});

/** Run one tick now, even when the agent is switched off (manual check). */
router.post('/run', async (req, res, next) => {
  try {
    const stats = await agent.runOnce({ force: true });
    res.json({ ran: Boolean(stats), stats: stats || null, status: agent.status() });
  } catch (err) { next(err); }
});

router.get('/sample-email', (req, res, next) => {
  try { res.json(agent.sampleEmail()); } catch (err) { next(err); }
});

router.post('/test-email', async (req, res, next) => {
  try { res.json(await agent.sendSampleEmail()); } catch (err) { if (!fail(res, err)) next(err); }
});

module.exports = router;
