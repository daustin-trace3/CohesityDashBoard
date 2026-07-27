const express = require('express');
const { listExchanges, getExchange, RETENTION_DAYS } = require('../services/aiAudit');

const router = express.Router();

/** GET /api/ai-audit?platform=<id> — AI exchanges (summaries, newest first). */
router.get('/', (req, res) => {
  const platform = typeof req.query.platform === 'string' && /^[a-z0-9-]+$/.test(req.query.platform)
    ? req.query.platform : undefined;
  res.json({ exchanges: listExchanges({ platform }), retentionDays: RETENTION_DAYS });
});

/** GET /api/ai-audit/:id — full exchange: sent payload, token map, raw response. */
router.get('/:id', (req, res) => {
  const exchange = getExchange(req.params.id);
  if (!exchange) return res.status(404).json({ error: `Exchange not found (audit entries are retained for ${RETENTION_DAYS} days).` });
  res.json(exchange);
});

module.exports = router;
