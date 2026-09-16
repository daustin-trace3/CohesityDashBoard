// Service Status page (contract): board + per-day events + per-event AI
// analysis. Reachable to any authenticated caller, same as /api/ops.
const express = require('express');
const svc = require('../services/serviceStatus');

const router = express.Router();

router.get('/board', (req, res, next) => {
  try {
    const days = req.query.days !== undefined ? Number(req.query.days) : 30;
    res.json(svc.getBoard({ days }));
  } catch (err) {
    next(err);
  }
});

router.get('/events', (req, res, next) => {
  try {
    const { platform, date } = req.query;
    if (!platform || typeof platform !== 'string') {
      return res.status(400).json({ error: 'platform is required' });
    }
    if (!date || typeof date !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(date)) {
      return res.status(400).json({ error: 'date must be YYYY-MM-DD' });
    }
    res.json({ events: svc.listEvents({ platform, date }) });
  } catch (err) {
    next(err);
  }
});

router.get('/events/:id', (req, res, next) => {
  try {
    const event = svc.getEvent(Number(req.params.id));
    if (!event) return res.status(404).json({ error: 'Event not found.' });
    res.json(event);
  } catch (err) {
    next(err);
  }
});

router.post('/events/:id/analyze', async (req, res, next) => {
  try {
    const result = await svc.analyzeEvent(Number(req.params.id), { force: true });
    res.json(result);
  } catch (err) {
    if (err.code === 'NOT_FOUND') return res.status(404).json({ error: 'Event not found.' });
    if (err.code === 'LLM_NOT_CONFIGURED') return res.status(503).json({ error: err.message });
    if (err.code === 'LLM_RATE_LIMITED') {
      if (err.retryAfter) res.set('Retry-After', String(err.retryAfter));
      return res.status(429).json({ error: err.message, retryAfter: err.retryAfter });
    }
    if (err.code === 'LLM_REQUEST_FAILED') return res.status(502).json({ error: err.message, detail: err.detail });
    next(err);
  }
});

/** POST /sweep , manual trigger for testing/demo (the interval calls sweep()
 *  itself every minute once initServiceStatus() runs). */
router.post('/sweep', async (req, res, next) => {
  try {
    await svc.sweep();
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
