// WP0: core seam route. Returns the exact same shape as the existing
// GET /api/cohesity/insights/ai/config (routes/insights.js) — both share the
// same services/llm.isConfigured() check rather than forking the logic.
const express = require('express');
const { isConfigured } = require('../services/llm');

const router = express.Router();

/**
 * GET /api/settings/ai-config
 * Reports whether LLM analysis is available so the UI can label the action.
 */
router.get('/', (req, res) => {
  res.json({ enabled: isConfigured() });
});

module.exports = router;
