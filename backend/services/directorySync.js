// Active Directory sync (2026-09-03): pulls the members of every LINKED AD
// group (groups.provider = 'ad') into the users table and reconciles
// user_groups rows with source = 'ad'. Admin-added memberships (source
// 'local') are never touched. Permissions stay on the ICC group, so mapping
// an AD group is: link it, then grant it platform access like any group.
//
// Two entry points: runSync() on a schedule / on demand, and syncLogin() for
// one user right after a successful domain bind. Both take the write lock up
// front (BEGIN IMMEDIATE, see icc-sqlite-write-transactions).

const db = require('../db/database');
const directory = require('./directory');
const { isDemo } = require('./demoMode');
const logger = require('../utils/logger');

const AD_PASSWORD_PLACEHOLDER = '!ad';
let running = false;
let timer = null;

function linkedGroups() {
  return db.prepare("SELECT * FROM groups WHERE provider = 'ad' ORDER BY name").all();
}

/** Insert or update one AD user by objectGUID (falls back to username match). */
const upsertUserTxn = db.transaction((adUser, now) => {
  const username = adUser.sam || directory.toSam(adUser.upn);
  if (!username) return { id: null, created: false, updated: false };
  let row = adUser.guid ? db.prepare('SELECT * FROM users WHERE external_id = ?').get(adUser.guid) : null;
  if (!row) row = db.prepare('SELECT * FROM users WHERE username = ?').get(username);

  if (row && row.auth_provider === 'local') {
    // A local account with the same name is break-glass and wins; the
    // directory user is not imported over it.
    return { id: null, created: false, updated: false, conflict: username };
  }

  const isActive = adUser.disabled ? 0 : 1;
  if (!row) {
    const info = db.prepare(`
      INSERT INTO users (username, password_hash, display_name, auth_provider, is_active, created_at, updated_at,
                         external_id, upn, email, synced_at)
      VALUES (?, ?, ?, 'ad', ?, ?, ?, ?, ?, ?, ?)
    `).run(username, AD_PASSWORD_PLACEHOLDER, adUser.displayName || username, isActive, now, now,
      adUser.guid, adUser.upn || null, adUser.email || null, now);
    return { id: info.lastInsertRowid, created: true, updated: false };
  }

  const changed = row.username !== username || row.display_name !== (adUser.displayName || username)
    || row.is_active !== isActive || (row.upn || null) !== (adUser.upn || null) || (row.email || null) !== (adUser.email || null)
    || (row.external_id || null) !== (adUser.guid || null);
  db.prepare(`
    UPDATE users SET username = ?, display_name = ?, is_active = ?, updated_at = CASE WHEN ? THEN ? ELSE updated_at END,
                     external_id = ?, upn = ?, email = ?, synced_at = ?
    WHERE id = ?
  `).run(username, adUser.displayName || username, isActive, changed ? 1 : 0, now,
    adUser.guid || row.external_id, adUser.upn || null, adUser.email || null, now, row.id);
  return { id: row.id, created: false, updated: changed };
});

/** Make the user's AD-sourced memberships exactly `groupIds`. */
const setAdMembershipsTxn = db.transaction((userId, groupIds) => {
  const wanted = new Set(groupIds.map(Number));
  const current = db.prepare("SELECT group_id FROM user_groups WHERE user_id = ? AND source = 'ad'").all(userId).map((r) => r.group_id);
  const del = db.prepare("DELETE FROM user_groups WHERE user_id = ? AND group_id = ? AND source = 'ad'");
  for (const gid of current) if (!wanted.has(gid)) del.run(userId, gid);
  const ins = db.prepare("INSERT OR IGNORE INTO user_groups (user_id, group_id, source) VALUES (?, ?, 'ad')");
  for (const gid of wanted) ins.run(userId, gid);
});

function logStart(trigger) {
  const now = new Date().toISOString();
  const info = db.prepare("INSERT INTO directory_sync_log (started_at, trigger, status) VALUES (?, ?, 'running')").run(now, trigger);
  return info.lastInsertRowid;
}

function logFinish(id, status, counts, message) {
  db.prepare(`
    UPDATE directory_sync_log SET finished_at = ?, status = ?, groups_synced = ?, users_seen = ?, users_created = ?,
      users_updated = ?, users_deactivated = ?, message = ? WHERE id = ?
  `).run(new Date().toISOString(), status, counts.groups, counts.seen, counts.created, counts.updated, counts.deactivated, message || null, id);
}

/**
 * Full sync of every linked group. Returns the log row. Safe to call while a
 * previous run is still going (the second call is skipped, not queued).
 */
async function runSync(trigger = 'schedule') {
  if (running) return { skipped: true, reason: 'sync already running' };
  if (!directory.isEnabled()) return { skipped: true, reason: 'directory disabled or not configured' };
  running = true;
  const logId = logStart(trigger);
  const counts = { groups: 0, seen: 0, created: 0, updated: 0, deactivated: 0 };
  const conflicts = new Set();
  try {
    const groups = linkedGroups();
    const now = new Date().toISOString();
    const membershipByUser = new Map(); // userId -> Set(groupId)
    const seenUserIds = new Set();

    for (const g of groups) {
      const members = await directory.getGroupMembers(g.external_dn);
      counts.groups += 1;
      for (const m of members) {
        const r = upsertUserTxn.immediate(m, now);
        if (r.conflict) { conflicts.add(r.conflict); continue; }
        if (!r.id) continue;
        seenUserIds.add(r.id);
        if (r.created) counts.created += 1; else if (r.updated) counts.updated += 1;
        if (!membershipByUser.has(r.id)) membershipByUser.set(r.id, new Set());
        membershipByUser.get(r.id).add(g.id);
      }
      db.prepare('UPDATE groups SET synced_at = ? WHERE id = ?').run(now, g.id);
    }
    counts.seen = seenUserIds.size;
    for (const [userId, gids] of membershipByUser) setAdMembershipsTxn.immediate(userId, [...gids]);

    // AD users no longer in any linked group: drop their AD memberships and,
    // by default, deactivate them (they can no longer log in through AD
    // anyway, since the login path checks linked-group membership too).
    const cfg = directory.getConfig();
    const strays = db.prepare("SELECT id FROM users WHERE auth_provider = 'ad'").all().filter((r) => !seenUserIds.has(r.id));
    for (const s of strays) {
      setAdMembershipsTxn.immediate(s.id, []);
      if (cfg.deactivateRemoved) {
        const res = db.prepare("UPDATE users SET is_active = 0, updated_at = ? WHERE id = ? AND is_active = 1").run(now, s.id);
        counts.deactivated += res.changes;
      }
    }

    const msg = conflicts.size ? `Skipped ${conflicts.size} directory user(s) that clash with local accounts: ${[...conflicts].slice(0, 5).join(', ')}` : null;
    logFinish(logId, 'ok', counts, msg);
    logger.info(`[directory] sync ${trigger}: ${counts.groups} groups, ${counts.seen} users (${counts.created} new, ${counts.updated} updated, ${counts.deactivated} deactivated)`);
    return { id: logId, status: 'ok', ...counts, message: msg };
  } catch (err) {
    logFinish(logId, 'error', counts, err.message);
    logger.error(`[directory] sync ${trigger} failed: ${err.message}`);
    return { id: logId, status: 'error', ...counts, message: err.message };
  } finally {
    running = false;
  }
}

/**
 * After a successful domain bind: create/update the user and set their AD
 * memberships from the group DNs the DC returned. Returns the users row, or
 * null when the user belongs to no linked group (no access -> no login).
 */
function syncLogin(adUser, groupDns) {
  const now = new Date().toISOString();
  const wantDns = new Set(groupDns.map((d) => d.toLowerCase()));
  const linked = linkedGroups().filter((g) => g.external_dn && wantDns.has(g.external_dn.toLowerCase()));
  if (!linked.length) return null;
  const r = upsertUserTxn.immediate(adUser, now);
  if (!r.id) return null;
  setAdMembershipsTxn.immediate(r.id, linked.map((g) => g.id));
  return db.prepare('SELECT * FROM users WHERE id = ?').get(r.id);
}

function lastRuns(limit = 10) {
  return db.prepare('SELECT * FROM directory_sync_log ORDER BY id DESC LIMIT ?').all(limit);
}

function isRunning() { return running; }

/** Periodic sync; interval re-read from settings on each tick so a change applies without restart. */
function startScheduler() {
  if (isDemo() || timer) return;
  const tick = async () => {
    try {
      if (directory.isEnabled()) await runSync('schedule');
    } catch (err) {
      logger.error(`[directory] scheduler: ${err.message}`);
    } finally {
      const minutes = directory.getConfig().syncIntervalMinutes;
      timer = setTimeout(tick, minutes * 60000);
      if (timer.unref) timer.unref();
    }
  };
  timer = setTimeout(tick, 30000);
  if (timer.unref) timer.unref();
  logger.info('[directory] sync scheduler armed');
}

function stopScheduler() {
  if (timer) clearTimeout(timer);
  timer = null;
}

module.exports = { runSync, syncLogin, lastRuns, isRunning, startScheduler, stopScheduler, linkedGroups, AD_PASSWORD_PLACEHOLDER };
