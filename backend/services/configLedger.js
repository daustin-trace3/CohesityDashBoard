// Configuration change ledger. A poller hands in the CURRENT set of items
// for one (platform, scope, system) and the diff against the last snapshot
// becomes append-only rows in config_changes. The very first snapshot of a
// (platform, scope, system) seeds the baseline silently, so turning the
// ledger on never floods the log with "added" rows for existing config.
const db = require('../db/database');
const { getSetting } = require('./settings');
const logger = require('../utils/logger');

const RETENTION_SETTING = 'config_ledger_retention_days';

function tablesReady() {
  try { return !!db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'config_changes'").get(); }
  catch { return false; }
}

const snapshotTxn = db.transaction((platform, scope, system, items, nowIso) => {
  const existing = new Map(
    db.prepare('SELECT item, value FROM config_state WHERE platform = ? AND scope = ? AND system = ?')
      .all(platform, scope, system).map((r) => [r.item, r.value])
  );
  const hadBaseline = existing.size > 0;
  const change = db.prepare(`
    INSERT INTO config_changes (platform, scope, system, item, change_type, old_value, new_value, detected_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const upsert = db.prepare(`
    INSERT INTO config_state (platform, scope, system, item, value, updated_at)
    VALUES (?, ?, ?, ?, ?, ?)
    ON CONFLICT(platform, scope, system, item) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at
  `);
  const seen = new Set();
  let changes = 0;
  for (const it of items) {
    if (!it || !it.item) continue;
    const item = String(it.item);
    const value = it.value == null ? null : String(it.value);
    seen.add(item);
    if (!existing.has(item)) {
      if (hadBaseline) { change.run(platform, scope, system, item, 'added', null, value, nowIso); changes += 1; }
      upsert.run(platform, scope, system, item, value, nowIso);
    } else if (existing.get(item) !== value) {
      change.run(platform, scope, system, item, 'changed', existing.get(item), value, nowIso);
      upsert.run(platform, scope, system, item, value, nowIso);
      changes += 1;
    }
  }
  const drop = db.prepare('DELETE FROM config_state WHERE platform = ? AND scope = ? AND system = ? AND item = ?');
  for (const [item, value] of existing) {
    if (seen.has(item)) continue;
    change.run(platform, scope, system, item, 'removed', value, null, nowIso);
    drop.run(platform, scope, system, item);
    changes += 1;
  }
  return { changes, baseline: !hadBaseline };
});

/**
 * Snapshot the current config of one system and ledger the diff.
 * items: [{ item, value }] with `value` a STABLE string (sort arrays, use
 * JSON with fixed key order). Never throws: a ledger failure must not break
 * the poll that carries it.
 */
function recordSnapshot({ platform, scope, system, items }) {
  if (!tablesReady()) return { changes: 0, skipped: true };
  try {
    const res = snapshotTxn.immediate(platform, scope, String(system || '(unknown)'), items || [], new Date().toISOString());
    if (res.changes) logger.info(`[ConfigLedger] ${platform}/${scope} ${system}: ${res.changes} change(s) recorded`);
    const retention = Math.min(1825, Math.max(30, Number(getSetting(RETENTION_SETTING)) || 365));
    db.prepare('DELETE FROM config_changes WHERE detected_at < ?')
      .run(new Date(Date.now() - retention * 86400000).toISOString());
    return res;
  } catch (err) {
    logger.warn(`[ConfigLedger] snapshot ${platform}/${scope} ${system} failed: ${err.message}`);
    return { changes: 0, error: err.message };
  }
}

/** Ledger rows, newest first. */
function listChanges({ days = 30, platform = null, scope = null, q = null, limit = 200 } = {}) {
  if (!tablesReady()) return [];
  const where = ['detected_at >= ?'];
  const params = [new Date(Date.now() - Math.min(365, Math.max(1, days)) * 86400000).toISOString()];
  if (platform) { where.push('platform = ?'); params.push(platform); }
  if (scope) { where.push('scope = ?'); params.push(scope); }
  if (q) {
    where.push('(item LIKE ? OR system LIKE ? OR old_value LIKE ? OR new_value LIKE ?)');
    const like = `%${q}%`;
    params.push(like, like, like, like);
  }
  return db.prepare(`
    SELECT * FROM config_changes WHERE ${where.join(' AND ')}
    ORDER BY detected_at DESC LIMIT ?
  `).all(...params, Math.min(1000, Math.max(1, limit)));
}

module.exports = { recordSnapshot, listChanges };
