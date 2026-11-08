// Okta Management API sync (2026-11-06, IDP-CONTRACT section 6). For every
// provider with mgmt_kind = 'okta' and a saved token: pull the members of each
// LINKED group (groups.provider = 'idp'), upsert them as idp users, replace
// their source = 'idp' memberships and, when asked, deactivate users no longer
// in any linked group. Admin-added (local) and AD memberships are never touched.
// Shape follows services/directorySync.js.

const db = require('../db/database');
const logger = require('../utils/logger');
const { isDemo } = require('./demoMode');
const idpProviders = require('./idpProviders');
const idpProvision = require('./idpProvision');
const okta = require('./idpOktaApi');

const running = new Set(); // providerId as a string
let timer = null;

function runKey(providerId) { return String(providerId); }
function isRunning(providerId) { return running.has(runKey(providerId)); }

/** Call a db.transaction function in IMMEDIATE mode when it supports it. */
function imm(fn, ...args) { return typeof fn.immediate === 'function' ? fn.immediate(...args) : fn(...args); }

function mgmtReady(provider) {
  return !!provider && provider.mgmt_kind === 'okta' && !!provider.mgmt_base_url && !!idpProviders.getSecret(provider, 'mgmt_token');
}

function logStart(providerId, trigger) {
  const now = new Date().toISOString();
  return db.prepare("INSERT INTO idp_sync_log (provider_id, started_at, trigger, status) VALUES (?, ?, ?, 'running')")
    .run(providerId, now, trigger).lastInsertRowid;
}

function logFinish(id, status, counts, message) {
  db.prepare(`
    UPDATE idp_sync_log SET finished_at = ?, status = ?, groups_synced = ?, users_seen = ?, users_created = ?,
      users_updated = ?, users_deactivated = ?, message = ? WHERE id = ?
  `).run(new Date().toISOString(), status, counts.groups, counts.seen, counts.created, counts.updated, counts.deactivated, message || null, id);
}

function setProviderStatus(providerId, status, error) {
  db.prepare('UPDATE idp_providers SET mgmt_last_sync_at = ?, mgmt_last_status = ?, mgmt_last_error = ? WHERE id = ?')
    .run(new Date().toISOString(), status, error || null, providerId);
}

function snapshotLedger(provider, linked) {
  try {
    const configLedger = require('./configLedger');
    const ids = linked.map((g) => g.id);
    const byGroup = new Map(linked.map((g) => [g.name, []]));
    if (ids.length) {
      const rows = db.prepare(`
        SELECT g.name AS group_name, u.username FROM user_groups ug
        JOIN groups g ON g.id = ug.group_id JOIN users u ON u.id = ug.user_id
        WHERE ug.source = 'idp' AND g.provider = 'idp' AND g.idp_provider_id = ?
      `).all(provider.id);
      for (const r of rows) {
        if (!byGroup.has(r.group_name)) byGroup.set(r.group_name, []);
        byGroup.get(r.group_name).push(r.username);
      }
    }
    configLedger.recordSnapshot({
      platform: 'directory', scope: 'idp-group-membership', system: provider.name,
      items: [...byGroup.entries()].map(([group, members]) => ({ item: group, value: JSON.stringify(members.sort()) })),
    });
  } catch (err) { logger.warn(`[idp] change ledger snapshot failed: ${err.message}`); }
}

/**
 * Full sync of one provider. Returns the result, or { skipped, reason } when
 * the provider has no Management API or a run is already going.
 */
async function runSync(providerId, trigger = 'schedule') {
  const provider = idpProviders.getProvider(providerId);
  if (!provider) return { skipped: true, reason: 'provider not found' };
  if (!mgmtReady(provider)) return { skipped: true, reason: 'Management API is not configured' };
  const key = runKey(providerId);
  if (running.has(key)) return { skipped: true, reason: 'sync already running' };
  running.add(key);
  const logId = logStart(providerId, trigger);
  const counts = { groups: 0, seen: 0, created: 0, updated: 0, deactivated: 0 };
  try {
    const client = okta.createClient({ baseUrl: provider.mgmt_base_url, token: idpProviders.getSecret(provider, 'mgmt_token') });
    const linked = idpProvision.linkedGroups(providerId);
    const now = new Date().toISOString();
    const membershipByUser = new Map();
    const seenUserIds = new Set();
    const notes = [];
    let incomplete = false;

    for (const g of linked) {
      let oktaId = g.external_id;
      if (!oktaId) {
        const found = await client.getGroupByName(g.external_name);
        if (!found) {
          notes.push(`Okta group "${g.external_name}" was not found`);
          incomplete = true;
          continue;
        }
        oktaId = found.id;
        db.prepare('UPDATE groups SET external_id = ? WHERE id = ?').run(oktaId, g.id);
      }
      const members = await client.groupMembers(oktaId);
      counts.groups += 1;
      for (const m of members) {
        const r = imm(idpProvision.upsertUserTxn, provider, m, now, { pinned: false });
        if (!r || !r.id) continue;
        seenUserIds.add(r.id);
        if (r.created) counts.created += 1; else if (r.updated) counts.updated += 1;
        if (!membershipByUser.has(r.id)) membershipByUser.set(r.id, new Set());
        membershipByUser.get(r.id).add(g.id);
      }
      db.prepare('UPDATE groups SET synced_at = ? WHERE id = ?').run(now, g.id);
    }
    counts.seen = seenUserIds.size;
    for (const [userId, gids] of membershipByUser) imm(idpProvision.setIdpMembershipsTxn, userId, providerId, [...gids]);

    if (incomplete) {
      notes.push('Skipped removing users because a linked group could not be read');
    } else {
      const strays = db.prepare('SELECT id FROM users WHERE idp_provider_id = ?').all(providerId).map((r) => r.id).filter((id) => !seenUserIds.has(id));
      for (const id of strays) imm(idpProvision.setIdpMembershipsTxn, id, providerId, []);
      if (provider.mgmt_deactivate_removed) counts.deactivated = idpProvision.deactivateStrays(provider, [...seenUserIds], now) || 0;
    }

    const msg = notes.length ? notes.join('. ') : null;
    logFinish(logId, 'ok', counts, msg);
    setProviderStatus(providerId, 'ok', null);
    snapshotLedger(provider, idpProvision.linkedGroups(providerId));
    logger.info(`[idp] ${provider.name} sync ${trigger}: ${counts.groups} groups, ${counts.seen} users (${counts.created} new, ${counts.updated} updated, ${counts.deactivated} deactivated)`);
    return { id: logId, status: 'ok', ...counts, message: msg };
  } catch (err) {
    logFinish(logId, 'error', counts, err.message);
    setProviderStatus(providerId, 'error', err.message);
    logger.warn(`[idp] ${provider.name} sync failed: ${err.message}`);
    return { id: logId, status: 'error', ...counts, message: err.message };
  } finally {
    running.delete(key);
  }
}

function lastRuns(providerId, limit = 10) {
  return db.prepare('SELECT * FROM idp_sync_log WHERE provider_id = ? ORDER BY id DESC LIMIT ?').all(providerId, limit);
}

function minutesSince(iso) {
  const t = Date.parse(iso || '');
  return Number.isFinite(t) ? (Date.now() - t) / 60000 : Infinity;
}

/** One scheduler pass; returns the smallest interval seen. */
async function syncTick() {
  let smallest = Infinity;
  try { idpProviders.pruneState(); } catch (err) { logger.warn(`[idp] state prune failed: ${err.message}`); }
  let providers = [];
  try { providers = db.prepare("SELECT * FROM idp_providers WHERE mgmt_kind = 'okta'").all(); } catch { return smallest; }
  for (const p of providers) {
    if (!mgmtReady(p)) continue;
    const every = Number(p.mgmt_sync_minutes) || 60;
    smallest = Math.min(smallest, every);
    if (minutesSince(p.mgmt_last_sync_at) < every - 1) continue;
    await runSync(p.id, 'schedule');
  }
  return smallest;
}

function startScheduler() {
  if (isDemo() || timer) return;
  const tick = async () => {
    let smallest = Infinity;
    try {
      smallest = await syncTick();
    } catch (err) {
      logger.error(`[idp] scheduler: ${err.message}`);
    } finally {
      const minutes = Math.min(Number.isFinite(smallest) ? smallest : 15, 15);
      timer = setTimeout(tick, Math.max(1, minutes) * 60000);
      if (timer.unref) timer.unref();
    }
  };
  timer = setTimeout(tick, 30000);
  if (timer.unref) timer.unref();
  logger.info('[idp] sync scheduler armed');
}

function stopScheduler() {
  if (timer) clearTimeout(timer);
  timer = null;
}

module.exports = { runSync, startScheduler, stopScheduler, isRunning, lastRuns, syncTick };
