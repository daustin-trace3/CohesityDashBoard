// Service Status page (contract): board + per-day events + per-event AI
// analysis. Mounted without a blanket permission because it spans platforms;
// every handler filters by the caller's own platform grants instead, so a
// narrowly scoped user or API key sees only the platforms it was given.
const express = require('express');
const svc = require('../services/serviceStatus');
const { requirePermission } = require('../middleware/requirePermission');
const { canManagePlatform } = require('../services/rbac');

const router = express.Router();

const grantsOf = (req) => (req.auth && req.auth.grants) || [];

router.get('/board', (req, res, next) => {
  try {
    const days = req.query.days !== undefined ? Number(req.query.days) : 30;
    const board = svc.getBoard({ days });
    const grants = grantsOf(req);
    board.platforms = board.platforms.filter((p) => svc.canSeePlatform(grants, p.id));
    res.json(board);
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
    if (!svc.canSeePlatform(grantsOf(req), platform)) {
      return res.status(403).json({ error: 'forbidden', required: `${svc.accessNamespace(platform)}:*:view` });
    }
    res.json({ events: svc.listEvents({ platform, date }).map((e) => svc.redactEventFor(grantsOf(req), e)) });
  } catch (err) {
    next(err);
  }
});

router.get('/events/:id', (req, res, next) => {
  try {
    const event = svc.getEvent(Number(req.params.id));
    // Same 404 for "no such event" and "not yours to see": ids are sequential,
    // so a 403 would confirm which ids exist on other platforms.
    if (!event || !svc.canSeePlatform(grantsOf(req), event.platform)) {
      return res.status(404).json({ error: 'Event not found.' });
    }
    res.json(svc.redactEventFor(grantsOf(req), event));
  } catch (err) {
    next(err);
  }
});

// A manual run spends LLM budget, sends estate evidence out and overwrites the
// stored analysis, so it needs manage on the event's platform (Operators have
// it, Viewers and read-only API keys do not) and it is rate limited inside
// analyzeEvent like the background worker.
router.post('/events/:id/analyze', async (req, res, next) => {
  try {
    const id = Number(req.params.id);
    const existing = svc.getEvent(id);
    if (!existing || !svc.canSeePlatform(grantsOf(req), existing.platform)) {
      return res.status(404).json({ error: 'Event not found.' });
    }
    if (!canManagePlatform(grantsOf(req), svc.accessNamespace(existing.platform))) {
      return res.status(403).json({ error: 'forbidden', required: `${svc.accessNamespace(existing.platform)}:*:manage` });
    }
    const result = await svc.analyzeEvent(id, { force: true });
    res.json(svc.redactEventFor(grantsOf(req), result));
  } catch (err) {
    if (err.code === 'NOT_FOUND') return res.status(404).json({ error: 'Event not found.' });
    if (err.code === 'AI_DISABLED') return res.status(409).json({ error: err.message });
    if (err.code === 'ANALYZE_COOLDOWN') {
      res.set('Retry-After', String(err.retryAfter));
      return res.status(429).json({ error: err.message, retryAfter: err.retryAfter });
    }
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
router.post('/sweep', requirePermission('admin:settings:manage'), async (req, res, next) => {
  try {
    await svc.sweep();
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
