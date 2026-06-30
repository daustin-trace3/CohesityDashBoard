const express = require('express');
const { getDashboardSnapshot } = require('../services/snapshot');

const router = express.Router();

/**
 * GET /api/dashboard/snapshot
 * Returns the pre-computed dashboard payload (last poll), served from cache.
 */
router.get('/snapshot', (req, res, next) => {
  try {
    const snapshot = getDashboardSnapshot();
    if (!snapshot) return res.status(503).json({ error: 'Snapshot unavailable.' });
    res.json(snapshot);
  } catch (err) {
    next(err);
  }
});

module.exports = router;
