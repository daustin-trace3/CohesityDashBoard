const express = require('express');
const { getViews, refreshViews } = require('../services/views');

const router = express.Router();

/** GET /api/cohesity/views — cached inventory of views across all Helios clusters. */
router.get('/', (req, res, next) => {
  try {
    res.json(getViews());
  } catch (err) {
    next(err);
  }
});

/** POST /api/cohesity/views/refresh — force a fresh pull from Helios. */
router.post('/refresh', async (req, res, next) => {
  try {
    const result = await refreshViews();
    if (!result.ok) {
      const error = result.reason === 'no_key'
        ? 'Views data is unavailable — the Helios API key is not configured (Settings → Credentials).'
        : 'Views refresh failed — Helios returned no data. Previous inventory kept.';
      return res.status(503).json({ error });
    }
    res.json(getViews());
  } catch (err) {
    next(err);
  }
});

module.exports = router;
