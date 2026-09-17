// App Service Status: catalog of usage-id tags, the watched list, the board
// and per-app detail. Reads are open to any authenticated caller (same as
// /api/service-status); changing the watched list needs admin:settings:manage.
const express = require('express');
const svc = require('../services/appServiceStatus');
const { requirePermission } = require('../middleware/requirePermission');

const router = express.Router();
const manage = requirePermission('admin:settings:manage');

router.get('/board', (req, res, next) => {
  try {
    res.json(svc.getBoard());
  } catch (err) {
    next(err);
  }
});

router.post('/evaluate', manage, (req, res, next) => {
  try {
    svc.evaluateAll();
    res.json(svc.getBoard());
  } catch (err) {
    next(err);
  }
});

router.get('/usage-ids', (req, res, next) => {
  try {
    res.json({ usageIds: svc.listUsageIds({ q: req.query.q, limit: req.query.limit }) });
  } catch (err) {
    next(err);
  }
});

router.get('/watch', (req, res, next) => {
  try {
    res.json({ watch: svc.listWatch() });
  } catch (err) {
    next(err);
  }
});

router.post('/watch', manage, (req, res, next) => {
  try {
    const { usageId, label } = req.body || {};
    if (!usageId || typeof usageId !== 'string' || !usageId.trim()) {
      return res.status(400).json({ error: 'usageId is required' });
    }
    if (label !== undefined && label !== null && typeof label !== 'string') {
      return res.status(400).json({ error: 'label must be a string' });
    }
    const row = svc.addWatch({ usageId, label, user: req.auth?.user?.username || null });
    res.status(201).json(row);
  } catch (err) {
    if (err.status) return res.status(err.status).json({ error: err.message });
    next(err);
  }
});

router.put('/watch/:usageId', manage, (req, res, next) => {
  try {
    const { label } = req.body || {};
    if (label !== undefined && label !== null && typeof label !== 'string') {
      return res.status(400).json({ error: 'label must be a string' });
    }
    const row = svc.updateWatch(req.params.usageId, { label });
    if (!row) return res.status(404).json({ error: 'usage-id is not watched' });
    res.json(row);
  } catch (err) {
    next(err);
  }
});

router.delete('/watch/:usageId', manage, (req, res, next) => {
  try {
    if (!svc.removeWatch(req.params.usageId)) return res.status(404).json({ error: 'usage-id is not watched' });
    res.status(204).end();
  } catch (err) {
    next(err);
  }
});

router.get('/apps/:usageId', (req, res, next) => {
  try {
    res.json(svc.evaluate(req.params.usageId));
  } catch (err) {
    next(err);
  }
});

module.exports = router;
