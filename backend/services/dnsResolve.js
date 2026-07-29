const dns = require('dns');
const net = require('net');
const db = require('../db/database');
const { getSetting } = require('./settings');
const logger = require('../utils/logger');

/**
 * Reverse-DNS resolution with a SQLite-persisted cache shared by the API and
 * poller processes. The poller pre-warms the cache from inventory IPs
 * (initDnsPrewarm) so page-load lookups are warm DB reads instead of live
 * 3s-timeout reverse queries. Negative results are cached too (name=null).
 */

// Self-creating on require, same pattern as poller_status.
db.exec(`
  CREATE TABLE IF NOT EXISTS dns_cache (
    ip          TEXT PRIMARY KEY,
    name        TEXT,
    resolved_at TEXT NOT NULL
  )
`);

const TTL_MS = 6 * 60 * 60 * 1000;
const PREWARM_INTERVAL_MS = 30 * 60 * 1000;
const PREWARM_INITIAL_DELAY_MS = 2 * 60 * 1000;
const PREWARM_MAX_IPS = 2000;
const LOOKUP_CHUNK = 25;

const selectCached = db.prepare('SELECT name, resolved_at AS resolvedAt FROM dns_cache WHERE ip = ?');
const upsert = db.prepare(`
  INSERT INTO dns_cache (ip, name, resolved_at) VALUES (?, ?, ?)
  ON CONFLICT(ip) DO UPDATE SET name = excluded.name, resolved_at = excluded.resolved_at
`);

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

/**
 * Resolve a list of IPs to hostnames, serving fresh cache rows from SQLite
 * and reverse-resolving the rest. Returns { ip: hostname|null }.
 */
async function resolveIps(ips) {
  const valid = [...new Set(ips.map(String).filter((ip) => net.isIP(ip)))];
  const map = {};
  const now = Date.now();
  const toLookup = [];
  for (const ip of valid) {
    const row = selectCached.get(ip);
    if (row && now - Date.parse(row.resolvedAt) < TTL_MS) map[ip] = row.name;
    else toLookup.push(ip);
  }

  if (toLookup.length) {
    const { resolver } = await buildResolver();
    for (let i = 0; i < toLookup.length; i += LOOKUP_CHUNK) {
      const chunk = toLookup.slice(i, i + LOOKUP_CHUNK);
      await Promise.all(chunk.map(async (ip) => {
        let name = null;
        try { name = await reverse(resolver, ip); } catch { name = null; }
        upsert.run(ip, name, new Date().toISOString());
        map[ip] = name;
      }));
    }
  }
  return map;
}

/** Distinct inventory IPs worth pre-resolving; tables may not exist yet. */
function collectInventoryIps() {
  const queries = [
    'SELECT DISTINCT client_ip AS ip FROM netapp_nfs_clients',
    'SELECT DISTINCT server_ip AS ip FROM netapp_nfs_clients',
    'SELECT DISTINCT client_ip AS ip FROM netapp_cifs_sessions',
    'SELECT DISTINCT server_ip AS ip FROM netapp_cifs_sessions',
    'SELECT DISTINCT address AS ip FROM netapp_lifs',
    'SELECT DISTINCT address AS ip FROM pure_network_interfaces',
  ];
  const ips = new Set();
  for (const q of queries) {
    try {
      for (const row of db.prepare(q).all()) {
        if (row.ip && net.isIP(String(row.ip))) ips.add(String(row.ip));
        if (ips.size >= PREWARM_MAX_IPS) return [...ips];
      }
    } catch { /* table absent */ }
  }
  return [...ips];
}

let prewarmTimer = null;
let prewarmRunning = false;

async function prewarmOnce() {
  if (prewarmRunning) return;
  prewarmRunning = true;
  try {
    const ips = collectInventoryIps();
    if (!ips.length) return;
    const now = Date.now();
    const cold = ips.filter((ip) => {
      const row = selectCached.get(ip);
      return !row || now - Date.parse(row.resolvedAt) >= TTL_MS;
    });
    if (!cold.length) return;
    await resolveIps(cold);
    logger.info(`[DNS prewarm] Resolved ${cold.length} inventory IPs (${ips.length} known).`);
  } catch (err) {
    logger.warn(`[DNS prewarm] Failed: ${err?.message || err}`);
  } finally {
    prewarmRunning = false;
  }
}

/** Background pre-resolution of inventory IPs — run in the poller process. */
function initDnsPrewarm() {
  setTimeout(prewarmOnce, PREWARM_INITIAL_DELAY_MS);
  prewarmTimer = setInterval(prewarmOnce, PREWARM_INTERVAL_MS);
  logger.info('[DNS prewarm] Scheduled (every 30 min, first run in 2 min).');
}

function stopDnsPrewarm() {
  if (prewarmTimer) clearInterval(prewarmTimer);
  prewarmTimer = null;
}

module.exports = { resolveIps, initDnsPrewarm, stopDnsPrewarm, prewarmOnce };
