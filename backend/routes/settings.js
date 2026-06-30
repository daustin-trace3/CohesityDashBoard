const express = require('express');
const { getAiSettings, setSetting } = require('../services/settings');

const router = express.Router();

/** GET /api/settings — current AI settings. */
router.get('/', (req, res, next) => {
  try {
    res.json(getAiSettings());
  } catch (err) {
    next(err);
  }
});

/** PUT /api/settings — update AI settings. */
router.put('/', (req, res, next) => {
  try {
    const { llmEstateContext, llmFlagUnprotected } = req.body || {};
    if (llmEstateContext !== undefined) {
      setSetting('llm_estate_context', String(llmEstateContext).slice(0, 4000));
    }
    if (llmFlagUnprotected !== undefined) {
      setSetting('llm_flag_unprotected', llmFlagUnprotected ? '1' : '0');
    }
    res.json(getAiSettings());
  } catch (err) {
    next(err);
  }
});

module.exports = router;
