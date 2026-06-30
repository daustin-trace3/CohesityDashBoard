const db = require('../db/database');

const DEFAULTS = {
  llm_estate_context: '',
  llm_flag_unprotected: '0',
};

function getSetting(key) {
  const row = db.prepare('SELECT value FROM app_settings WHERE key = ?').get(key);
  return row ? row.value : (DEFAULTS[key] ?? null);
}

function setSetting(key, value) {
  db.prepare(`
    INSERT INTO app_settings (key, value, updated_at)
    VALUES (?, ?, datetime('now'))
    ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at
  `).run(key, value == null ? '' : String(value));
}

/** Settings the UI reads/writes, in a typed shape. */
function getAiSettings() {
  return {
    llmEstateContext: getSetting('llm_estate_context') || '',
    llmFlagUnprotected: getSetting('llm_flag_unprotected') === '1',
  };
}

module.exports = { getSetting, setSetting, getAiSettings };
