// Per-user UI preferences, saved server side so a user gets the same view on
// every browser. One JSON object per user in the admin file (user_preferences).
// Writes go through db/adminDb so the data file's write lock is never involved.
const db = require('../db/adminDb');

const SWITCHER_MODES = ['rail', 'dropdown', 'grid'];

// key -> validator. Anything else is rejected by validatePatch.
const KEYS = {
  switcherMode: (v) => SWITCHER_MODES.includes(v),
};

function validatePatch(patch) {
  if (!patch || typeof patch !== 'object' || Array.isArray(patch)) return 'Body must be an object.';
  const keys = Object.keys(patch);
  if (!keys.length) return 'No preference given.';
  for (const k of keys) {
    if (!KEYS[k]) return `Unknown preference: ${k}.`;
    if (!KEYS[k](patch[k])) return `Invalid value for ${k}.`;
  }
  return null;
}

function getPreferences(userId) {
  if (userId == null) return {};
  try {
    const row = db.prepare('SELECT prefs_json FROM user_preferences WHERE user_id = ?').get(userId);
    if (!row) return {};
    const obj = JSON.parse(row.prefs_json);
    return obj && typeof obj === 'object' ? obj : {};
  } catch {
    return {};
  }
}

function setPreferences(userId, patch) {
  const merged = { ...getPreferences(userId), ...patch };
  db.prepare(
    `INSERT INTO user_preferences (user_id, prefs_json, updated_at) VALUES (?, ?, ?)
     ON CONFLICT(user_id) DO UPDATE SET prefs_json = excluded.prefs_json, updated_at = excluded.updated_at`
  ).run(userId, JSON.stringify(merged), new Date().toISOString());
  return merged;
}

module.exports = { SWITCHER_MODES, validatePatch, getPreferences, setPreferences };
