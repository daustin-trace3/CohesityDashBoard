const express = require('express');
const { listExchanges, getExchange } = require('../services/aiAudit');

const router = express.Router();

/** GET /api/ai-audit — recent AI exchanges (summaries, newest first). */
router.get('/', (req, res) => {
  res.json({ exchanges: listExchanges() });
});

/** GET /api/ai-audit/:id — full exchange: sent payload, token map, raw response. */
router.get('/:id', (req, res) => {
  const exchange = getExchange(req.params.id);
  if (!exchange) return res.status(404).json({ error: 'Exchange not found (audit trail holds the last 20 and clears on restart).' });
  res.json(exchange);
});

module.exports = router;
