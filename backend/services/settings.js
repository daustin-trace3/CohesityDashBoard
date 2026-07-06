const db = require('../db/database');

const DEFAULTS = {
  llm_estate_context: '',
  llm_flag_unprotected: '0',
  license_entitled_dataprotect_tib: '0',
  license_entitled_replica_tib: '0',
  license_entitled_smartfiles_tib: '0',
  license_expiry: '',
  license_edition: '',
  platform_pure_enabled: '0',
  platform_netapp_enabled: '0',
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

/** Per-license-type entitlement the operator enters manually. Values are
 *  decimal TB (Cohesity licenses in TB); the *_tib setting keys are legacy
 *  names kept so previously stored values survive. */
function getLicenseSettings() {
  return {
    entitled: {
      dataProtect: Number(getSetting('license_entitled_dataprotect_tib')) || 0,
      replica: Number(getSetting('license_entitled_replica_tib')) || 0,
      smartFiles: Number(getSetting('license_entitled_smartfiles_tib')) || 0,
    },
    licenseExpiry: getSetting('license_expiry') || '',
    licenseEdition: getSetting('license_edition') || '',
  };
}

/** Which vendor platform tabs are shown in the UI. Cohesity is always on;
 *  Pure/NetApp are hidden until their integrations are configured. */
function getPlatformSettings() {
  return {
    platformPureEnabled: getSetting('platform_pure_enabled') === '1',
    platformNetappEnabled: getSetting('platform_netapp_enabled') === '1',
  };
}

module.exports = { getSetting, setSetting, getAiSettings, getLicenseSettings, getPlatformSettings };
