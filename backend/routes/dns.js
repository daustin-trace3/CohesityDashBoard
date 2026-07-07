const express = require('express');
const dns = require('dns');
const net = require('net');
const { body, validationResult } = require('express-validator');
const { getSetting } = require('../services/settings');

const router = express.Router();

// ip -> { name, at } cache (1h TTL). Negative results cached too (name=null).
const cache = new Map();
const TTL_MS = 60 * 60 * 1000;
const MAX_IPS = 1000;

function validate(req, res, next) {
  const errors = validationResult(req);
  if (!errors.isEmpty()) return res.status(400).json({ errors: errors.array() });
  next();
}

/** Build a resolver pointed at the configured DNS server (if any). */
async function buildResolver() {
  const server = String(getSetting('dns_server') || '').trim();
  const resolver = new dns.Resolver({ timeout: 3000, tries: 1 });
  if (!server) return { resolver, server: '' };
  let serverIp = server;
  if (!net.isIP(server)) {
    // The setting is a hostname — resolve it to an IP first (system resolver).
    try {
      const { address } = await dns.promises.lookup(server);
      serverIp = address;
    } catch {
      return { resolver, server: '', error: `Could not resolve DNS server host "${server}"` };
    }
  }
  try {
    resolver.setServers([serverIp]);
  } catch {
    return { resolver, server: '', error: 'Invalid DNS server address' };
  }
  return { resolver, server: serverIp };
}

function reverse(resolver, ip) {
  return new Promise((resolve) => {
    resolver.reverse(ip, (err, names) => resolve(err || !names || !names.length ? null : names[0]));
  });
}

// GET /api/dns/status — whether a DNS server is configured
router.get('/status', (req, res) => {
  const server = String(getSetting('dns_server') || '').trim();
  res.json({ configured: !!server, server });
});

// POST /api/dns/resolve  { ips: string[] }  ->  { map: { ip: hostname|null } }
router.post(
  '/resolve',
  [body('ips').isArray({ min: 1, max: MAX_IPS })],
  validate,
  async (req, res, next) => {
    try {
      const ips = [...new Set(req.body.ips.map(String).filter((ip) => net.isIP(ip)))];
      if (!ips.length) return res.json({ map: {}, configured: false });

      const now = Date.now();
      const map = {};
      const toLookup = [];
      for (const ip of ips) {
        const c = cache.get(ip);
        if (c && now - c.at < TTL_MS) map[ip] = c.name;
        else toLookup.push(ip);
      }

      if (toLookup.length) {
        const { resolver } = await buildResolver();
        await Promise.all(toLookup.map(async (ip) => {
          let name = null;
          try { name = await reverse(resolver, ip); } catch { name = null; }
          cache.set(ip, { name, at: now });
          map[ip] = name;
        }));
      }

      res.json({ map, configured: !!String(getSetting('dns_server') || '').trim() });
    } catch (err) {
      next(err);
    }
  }
);

module.exports = router;
