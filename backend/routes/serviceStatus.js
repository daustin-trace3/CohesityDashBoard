// Service Status page (contract): board + per-day events + per-event AI
// analysis. Reachable to any authenticated caller, same as /api/ops.
const express = require('express');
const svc = require('../services/serviceStatus');
const { filterByGrants, grantsOf, canViewPlatform, requireOps } = require('../services/platformAccess');

const router = express.Router();

// App service events belong to the rollup (no platform grant of their own);
// every other event follows its platform's view grant.
const eventVisible = (req, platform) => platform === 'appservice' || canViewPlatform(grantsOf(req), platform);

router.get('/board', (req, res, next) => {
  try {
    const days = req.query.days !== undefined ? Number(req.query.days) : 30;
    const board = svc.getBoard({ days });
    res.json({ ...board, platforms: filterByGrants(board.platforms, grantsOf(req)) });
  } catch (err) {
    next(err);
  }
});

router.get('/services', (req, res, next) => {
  try {
    const days = req.query.days !== undefined ? Number(req.query.days) : 30;
    const board = svc.getServicesBoard({ days });
    if (!canViewPlatform(grantsOf(req), 'logicmonitor')) return res.json({ ...board, services: [], picked: 0 });
    res.json(board);
  } catch (err) {
    next(err);
  }
});

router.get('/services/:serviceId/events', (req, res, next) => {
  try {
    const { date } = req.query;
    if (!date || typeof date !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(date)) {
      return res.status(400).json({ error: 'date must be YYYY-MM-DD' });
    }
    const serviceId = String(req.params.serviceId);
    if (!svc.serviceKnown(serviceId)) return res.status(404).json({ error: 'Service not found.' });
    res.json({ events: svc.listServiceEvents({ serviceId, date }) });
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
    res.json({ events: svc.listEvents({ platform, date }).filter((e) => eventVisible(req, e.platform || platform)) });
  } catch (err) {
    next(err);
  }
});

router.get('/events/:id', (req, res, next) => {
  try {
    const event = svc.getEvent(Number(req.params.id));
    if (!event || !eventVisible(req, event.platform)) return res.status(404).json({ error: 'Event not found.' });
    res.json(event);
  } catch (err) {
    next(err);
  }
});

router.post('/events/:id/analyze', requireOps('manage'), async (req, res, next) => {
  try {
    const existing = svc.getEvent(Number(req.params.id));
    if (existing && !eventVisible(req, existing.platform)) return res.status(404).json({ error: 'Event not found.' });
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
router.post('/sweep', requireOps('manage'), async (req, res, next) => {
  try {
    await svc.sweep();
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
