// Persistent audit trail of AI exchanges, so the UI can prove exactly what
// left the box (the anonymized payload) versus what stayed local (the
// token → real-name mapping). Rows are tagged with the owning platform and
// retained for 30 days (pruned on insert).

const db = require('../db/database');

const RETENTION_DAYS = 30;

/**
 * Record an outbound AI request at the moment it is sent.
 * `messages` must be the exact (already anonymized) chat messages;
 * `mappings` is the local token → real-name table (never sent).
 */
function recordExchange({ platform = 'cohesity', feature, label, model, messages, mappings }) {
  db.prepare(`DELETE FROM ai_audit_exchanges WHERE sent_at < datetime('now', '-${RETENTION_DAYS} days')`).run();
  const info = db.prepare(`
    INSERT INTO ai_audit_exchanges (platform, feature, label, model, sent_at, messages, mappings, mapped_count)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    platform, feature || null, label || null, model || null,
    new Date().toISOString(),
    JSON.stringify(messages), JSON.stringify(mappings || []), (mappings || []).length
  );
  return info.lastInsertRowid;
}

/** Attach the raw (still-tokenized) model response, as received. */
function attachResponse(id, response) {
  db.prepare('UPDATE ai_audit_exchanges SET response = ? WHERE id = ?').run(response || null, id);
}

function listExchanges({ platform } = {}) {
  const where = platform ? 'WHERE platform = ?' : '';
  const rows = db.prepare(`
    SELECT id, platform, feature, label, model, sent_at AS sentAt, mapped_count AS mappedCount,
           response IS NOT NULL AS hasResponse
    FROM ai_audit_exchanges ${where}
    ORDER BY sent_at DESC, id DESC
    LIMIT 500
  `).all(...(platform ? [platform] : []));
  return rows.map((r) => ({ ...r, hasResponse: !!r.hasResponse }));
}

function getExchange(id) {
  const row = db.prepare(`
    SELECT id, platform, feature, label, model, sent_at AS sentAt, messages, mappings, response
    FROM ai_audit_exchanges WHERE id = ?
  `).get(Number(id));
  if (!row) return null;
  return { ...row, messages: JSON.parse(row.messages), mappings: JSON.parse(row.mappings) };
}

module.exports = { recordExchange, attachResponse, listExchanges, getExchange, RETENTION_DAYS };
