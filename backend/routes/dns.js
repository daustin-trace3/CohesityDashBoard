const express = require('express');
const { body, validationResult } = require('express-validator');
const { getSetting } = require('../services/settings');
const { resolveIps } = require('../services/dnsResolve');
const { hasPermission } = require('../services/rbac');

const router = express.Router();

const MAX_IPS = 5000;

function validate(req, res, next) {
  const errors = validationResult(req);
  if (!errors.isEmpty()) return res.status(400).json({ error: 'ips must be an array of 1 to 5000 addresses' });
  next();
}

// Reverse lookups go to the customer's internal DNS server, so a caller with
// no platform access at all (a zero-grant API key) gets nothing here. Pages
// that use this are platform pages; any platform view grant is enough.
router.use((req, res, next) => {
  const grants = (req.auth && req.auth.grants) || [];
  const ok = grants.some((g) => {
    const parts = String(g).split(':');
    return parts.length === 3 && parts[0] !== 'admin';
  });
  if (!ok) return res.status(403).json({ error: 'forbidden', required: '<platform>:*:view' });
  next();
});

// GET /api/dns/status: whether a DNS server is configured. The server
// address itself is a setting, shown only to callers who can view settings.
router.get('/status', (req, res) => {
  const server = String(getSetting('dns_server') || '').trim();
  const grants = (req.auth && req.auth.grants) || [];
  res.json({ configured: !!server, server: hasPermission(grants, 'admin:settings:view') ? server : '' });
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
