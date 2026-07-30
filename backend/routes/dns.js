const express = require('express');
const { body, validationResult } = require('express-validator');
const { getSetting } = require('../services/settings');
const { resolveIps } = require('../services/dnsResolve');

const router = express.Router();

const MAX_IPS = 5000;

function validate(req, res, next) {
  const errors = validationResult(req);
  if (!errors.isEmpty()) return res.status(400).json({ errors: errors.array() });
  next();
}

// GET /api/dns/status — whether a DNS server is configured
router.get('/status', (req, res) => {
  const server = String(getSetting('dns_server') || '').trim();
  res.json({ configured: !!server, server });
});

// POST /api/dns/resolve  { ips: string[] }  ->  { map: { ip: hostname|null } }
// Served from the SQLite dns_cache (pre-warmed by the poller process);
// only cold/expired IPs trigger live reverse lookups.
router.post(
  '/resolve',
  [body('ips').isArray({ min: 1, max: MAX_IPS })],
  validate,
  async (req, res, next) => {
    try {
      const map = await resolveIps(req.body.ips);
      res.json({ map, configured: !!String(getSetting('dns_server') || '').trim() });
    } catch (err) {
      next(err);
    }
  }
);

module.exports = router;
