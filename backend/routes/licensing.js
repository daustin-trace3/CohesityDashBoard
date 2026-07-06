const express = require('express');
const { param } = require('express-validator');
const { getLicensing, getViewDetail, refreshLicensing } = require('../services/licensing');

const router = express.Router();

/** GET /api/licensing — current entitlement vs consumed FETB, per system. */
router.get('/', (req, res, next) => {
  try {
    res.json(getLicensing());
  } catch (err) {
    next(err);
  }
});

/** GET /api/licensing/views/:systemId — per-view detail for one system. */
router.get('/views/:systemId', [param('systemId').isString().isLength({ max: 64 })], (req, res, next) => {
  try {
    res.json(getViewDetail(req.params.systemId));
  } catch (err) {
    next(err);
  }
});

/** POST /api/licensing/refresh — force a fresh pull from Helios. */
router.post('/refresh', async (req, res, next) => {
  try {
    const result = await refreshLicensing();
    if (!result.ok) {
      const error = result.reason === 'no_key'
        ? 'Licensing data is unavailable — HELIOS_API_KEY is not configured.'
        : 'Licensing refresh failed — Helios returned no data. Previous figures kept.';
      return res.status(503).json({ error });
    }
    res.json({ ...getLicensing(), refreshFailedSources: result.failed || [] });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
