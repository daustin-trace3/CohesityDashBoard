const db = require('../db/database');
const { decrypt } = require('./encryption');

const DEFAULTS = {
  llm_estate_context: '',
  llm_flag_unprotected: '0',
  llm_model: '',
  llm_analysis_ttl_hours: '',
  license_entitled_dataprotect_tib: '0',
  license_entitled_replica_tib: '0',
  license_entitled_smartfiles_tib: '0',
  license_expiry: '',
  license_edition: '',
  platform_cohesity_enabled: '1',
  platform_pure_enabled: '0',
  platform_netapp_enabled: '0',
  platform_zerto_enabled: '0',
  platform_vcenter_enabled: '0',
  platform_dell_enabled: '0',
  dell_warranty_warn_days: '90',
  platform_aria_enabled: '0',
  aria_lease_warn_days: '7',
  aria_cert_warn_days: '30',
  aria_request_fail_lookback_hours: '24',
  platform_ariaops_enabled: '0',
  zerto_poll_interval_minutes: '15',
  pure1_poll_interval_minutes: '15',
  vcenter_cert_warn_days: '60',
  platform_netbackup_enabled: '0',
  feature_custom_dashboards_enabled: '0',
  netbackup_success_warn_pct: '90',
  netbackup_storage_warn_pct: '20',
  netbackup_stale_backup_hours: '48',
  netbackup_entitled_tb: '0',
  platform_aws_enabled: '0',
  aws_cost_spike_pct: '30',
  aws_rds_storage_warn_pct: '15',
  platform_proxmox_enabled: '0',
  proxmox_storage_warn_pct: '85',
  proxmox_storage_crit_pct: '95',
  proxmox_backup_stale_days: '3',
  proxmox_cert_warn_days: '30',
  proxmox_snapshot_age_days: '30',
  platform_brocade_enabled: '0',
  brocade_health_warn_score: '70',
  brocade_health_crit_score: '50',
  brocade_cert_warn_days: '60',
  brocade_event_storm_count: '10',
  brocade_event_retention_days: '30',
  brocade_port_stats_retention_days: '14',
  dns_server: '',
  smtp_enabled: '0',
  smtp_host: '',
  smtp_port: '587',
  smtp_encryption: 'starttls',
  smtp_auth_method: 'login',
  smtp_username: '',
  smtp_password: '',
  smtp_from: '',
  smtp_recipients: '',
  alert_email_min_severity: 'warning',
  alert_email_platforms: '{"cohesity":true,"pure":true,"netapp":true,"zerto":true,"vcenter":true,"dell":true,"aria":true,"netbackup":true,"aws":true,"proxmox":true,"brocade":true}',
  alert_email_reminder_hours: '24',
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

/**
 * Resolve a secret: encrypted app_settings value first, then the env var.
 * Same precedence the AIQUM and Pure1 credentials already use.
 */
function getSecretSetting(key, envVar) {
  const stored = getSetting(key);
  if (stored) {
    try {
      const v = decrypt(stored);
      if (v) return v;
    } catch { /* bad/re-keyed ciphertext — fall through to env */ }
  }
  return (envVar && process.env[envVar]) || '';
}

/** Where a secret comes from, for UI status (never the value itself). */
function secretSource(key, envVar) {
  if (getSetting(key)) return 'settings';
  if (envVar && process.env[envVar]) return 'env';
  return 'none';
}

function getHeliosApiKey() {
  return getSecretSetting('helios_api_key', 'HELIOS_API_KEY');
}

/** Settings the UI reads/writes, in a typed shape. */
function getAiSettings() {
  return {
    llmEstateContext: getSetting('llm_estate_context') || '',
    llmFlagUnprotected: getSetting('llm_flag_unprotected') === '1',
    llmModel: getSetting('llm_model') || '',
    llmAnalysisTtlHours: getAnalysisTtlHours(),
  };
}

/** Cached-analysis staleness window: DB setting → env → 24h. */
function getAnalysisTtlHours() {
  const stored = Number(getSetting('llm_analysis_ttl_hours'));
  if (stored >= 1 && stored <= 720) return stored;
  return Number(process.env.LLM_ANALYSIS_TTL_HOURS) || 24;
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

/** Which vendor platform tabs are shown in the UI. Cohesity defaults on but can
 *  be disabled; Pure/NetApp are hidden until their integrations are configured. */
function getPlatformSettings() {
  return {
    platformCohesityEnabled: getSetting('platform_cohesity_enabled') !== '0',
    platformPureEnabled: getSetting('platform_pure_enabled') === '1',
    platformNetappEnabled: getSetting('platform_netapp_enabled') === '1',
    platformZertoEnabled: getSetting('platform_zerto_enabled') === '1',
    platformVcenterEnabled: getSetting('platform_vcenter_enabled') === '1',
    platformDellEnabled: getSetting('platform_dell_enabled') === '1',
    platformAriaEnabled: getSetting('platform_aria_enabled') === '1',
    platformAriaopsEnabled: getSetting('platform_ariaops_enabled') === '1',
    platformNetbackupEnabled: getSetting('platform_netbackup_enabled') === '1',
    platformAwsEnabled: getSetting('platform_aws_enabled') === '1',
    platformProxmoxEnabled: getSetting('platform_proxmox_enabled') === '1',
    platformBrocadeEnabled: getSetting('platform_brocade_enabled') === '1',
    featureCustomDashboardsEnabled: getSetting('feature_custom_dashboards_enabled') === '1',
    dnsServer: getSetting('dns_server') || '',
  };
}

/** SMTP alert-notification settings in a typed shape (contract C10.1/C10.2).
 *  smtpPassword itself is never included — only whether one is set. */
function getNotificationSettings() {
  // Merge over defaults so platforms added after a DB stored its JSON come
  // through enabled instead of silently missing (collector gate reads keys).
  const platformDefaults = { cohesity: true, pure: true, netapp: true, zerto: true, vcenter: true, dell: true, aria: true, netbackup: true, aws: true, proxmox: true, brocade: true };
  let alertPlatforms;
  try {
    alertPlatforms = { ...platformDefaults, ...JSON.parse(getSetting('alert_email_platforms')) };
  } catch {
    alertPlatforms = { ...platformDefaults };
  }
  return {
    smtpEnabled: getSetting('smtp_enabled') === '1',
    smtpHost: getSetting('smtp_host') || '',
    smtpPort: Number(getSetting('smtp_port')) || 587,
    smtpEncryption: getSetting('smtp_encryption') || 'starttls',
    smtpAuthMethod: getSetting('smtp_auth_method') || 'login',
    smtpUsername: getSetting('smtp_username') || '',
    smtpPasswordSet: !!getSetting('smtp_password'),
    smtpFrom: getSetting('smtp_from') || '',
    smtpRecipients: getSetting('smtp_recipients') || '',
    alertMinSeverity: getSetting('alert_email_min_severity') || 'warning',
    alertPlatforms: Object.fromEntries(
      Object.keys(platformDefaults).map((k) => [k, alertPlatforms[k] !== false])
    ),
    reminderHours: Number(getSetting('alert_email_reminder_hours')) || 0,
  };
}

/** Decrypted SMTP password, or '' if none stored. */
function getSmtpPassword() {
  const stored = getSetting('smtp_password');
  if (!stored) return '';
  try {
    return decrypt(stored) || '';
  } catch {
    return '';
  }
}

module.exports = {
  getSetting, setSetting, getSecretSetting, secretSource, getHeliosApiKey,
  getAnalysisTtlHours, getAiSettings, getLicenseSettings, getPlatformSettings,
  getNotificationSettings, getSmtpPassword,
};
