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
  feature_custom_dashboards_enabled: '0',
  ops_overview_style: 'classic',
  netbackup_success_warn_pct: '90',
  netbackup_storage_warn_pct: '20',
  netbackup_stale_backup_hours: '48',
  netbackup_entitled_tb: '0',
  aws_cost_spike_pct: '30',
  aws_rds_storage_warn_pct: '15',
  proxmox_storage_warn_pct: '85',
  proxmox_storage_crit_pct: '95',
  proxmox_backup_stale_days: '3',
  proxmox_cert_warn_days: '30',
  proxmox_snapshot_age_days: '30',
  aws_finops_metric: 'amortized',
  aws_finops_tag_keys: '[]',
  aws_finops_linked_accounts: 'auto',
  aws_finops_anomaly_pct: '30',
  aws_finops_anomaly_floor_usd: '5',
  aws_finops_anomaly_baseline_days: '7',
  aws_finops_anomaly_clear_days: '2',
  aws_finops_sp_util_warn_pct: '80',
  aws_finops_sp_expiry_warn_days: '30',
  aws_price_gp2_to_gp3_per_gb: '0.02',
  aws_price_ebs_gp2_per_gb: '0.10',
  aws_price_ebs_gp3_per_gb: '0.08',
  aws_price_nat_gateway_month: '32.85',
  aws_finops_digest_enabled: '0',
  aws_finops_digest_recipients: '',
  aws_finops_digest_weekday: '1',
  platform_brocade_enabled: '0',
  brocade_health_warn_score: '70',
  brocade_health_crit_score: '50',
  brocade_cert_warn_days: '60',
  brocade_event_storm_count: '10',
  brocade_event_retention_days: '30',
  brocade_port_stats_retention_days: '14',
  bluecat_low_free_warn: '20',
  bluecat_low_free_pct: '10',
  platform_logicmonitor_enabled: '0',
  lm_if_util_warn_pct: '80',
  lm_if_err_warn: '100',
  lm_if_flap_warn: '3',
  lm_dead_grace_min: '10',
  lm_alert_storm_count: '50',
  lm_alert_retention_days: '90',
  lm_new_device_days: '3',
  lm_interface_history_days: '30',
  lm_check_history_days: '30',
  lm_check_baseline_days: '7',
  lm_check_baseline_min_samples: '24',
  lm_check_latency_k: '3',
  lm_check_latency_floor_ms: '5',
  lm_check_latency_min_ms: '20',
  lm_check_loss_min_pct: '2',
  lm_check_loss_crit_pct: '20',
  lm_check_location_fold: '3',
  lm_check_data_calls_per_tick: '200',
  lm_site_group_roots: 'Network,Sites,Locations,Branch',
  lm_site_property: 'site',
  lm_site_from_hostname: '1',
  lm_path_max_hops: '6',
  lm_shadow_enabled: '1',
  lm_circuit_sat_pct: '80',
  lm_circuit_crit_pct: '95',
  lm_circuit_sat_days: '7',
  lm_if_baseline_days: '7',
  lm_if_baseline_min_samples: '48',
  lm_if_anomaly_k: '4',
  lm_if_anomaly_util_min_pct: '20',
  lm_if_anomaly_err_min: '5',
  lm_backup_overlay_util_pct: '70',
  lm_wan_overrides: '',
  lm_webhook_rate_per_min: '600',
  dns_server: '',
  cohesity_alert_window_days: '5',
  cohesity_run_history_days: '90',
  cohesity_run_retention_days: '0',
  netbackup_job_history_days: '30',
  poller_calls_in_flight: '4',
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
  alert_email_platforms: '{"cohesity":true,"pure":true,"netapp":true,"zerto":true,"vcenter":true,"dell":true,"aria":true,"netbackup":true,"aws":true,"proxmox":true,"brocade":true,"bluecat":true,"logicmonitor":true}',
  alert_email_reminder_hours: '24',
  service_status_ai_enabled: '1',
  service_status_analyses_per_minute: '3',
  service_status_dedupe_minutes: '60',
  service_status_mode: 'platform',
  service_status_stale_minutes: '120',
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
    llmProvider: getSetting('llm_provider') || 'auto',
    llmCustomEndpoint: getSetting('llm_custom_endpoint') || '',
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
    platformBrocadeEnabled: getSetting('platform_brocade_enabled') === '1',
    platformLogicmonitorEnabled: getSetting('platform_logicmonitor_enabled') === '1',
    featureCustomDashboardsEnabled: getSetting('feature_custom_dashboards_enabled') === '1',
    opsOverviewStyle: getSetting('ops_overview_style') || 'classic',
    dnsServer: getSetting('dns_server') || '',
    cohesityAlertWindowDays: getCohesityAlertWindowDays(),
    cohesityRunHistoryDays: getCohesityRunHistoryDays(),
    cohesityRunRetentionDays: getCohesityRunRetentionDays(),
    netbackupJobHistoryDays: getNetbackupJobHistoryDays(),
    pollerCallsInFlight: require('../core/concurrency').callsInFlight(null),
  };
}

/** SMTP alert-notification settings in a typed shape (contract C10.1/C10.2).
 *  smtpPassword itself is never included — only whether one is set. */
function getNotificationSettings() {
  // Merge over defaults so platforms added after a DB stored its JSON come
  // through enabled instead of silently missing (collector gate reads keys).
  const platformDefaults = { cohesity: true, pure: true, netapp: true, zerto: true, vcenter: true, dell: true, aria: true, netbackup: true, aws: true, proxmox: true, brocade: true, bluecat: true, logicmonitor: true };
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

/** Operations Agent (Ops > Operations Agent, Global Settings > Operations Agent). */
/** A numeric setting inside [min, max], or the default when it was never
 *  saved. An unset key reads as null and Number(null) is 0, which sat inside
 *  the range of every zero-allowed option, so a fresh install ran with a 0
 *  hold window, never re-notified and closed incidents the moment they went
 *  quiet instead of the documented 10 / 60 / 30 (found 2026-10-14). */
function numSetting(key, def, min, max) {
  const raw = getSetting(key);
  if (raw == null || String(raw).trim() === '') return def;
  const n = Number(raw);
  return (n >= min && n <= max) ? Math.round(n) : def;
}

function getObservationSettings() {
  let disabledIds = [];
  try {
    const raw = JSON.parse(getSetting('ops_obs_disabled_ids') || '[]');
    if (Array.isArray(raw)) disabledIds = raw.filter((x) => typeof x === 'string');
  } catch { /* unreadable list = none disabled */ }
  return {
    enabled: getSetting('ops_obs_enabled') !== '0',
    sustainSamples: numSetting('ops_obs_sustain_samples', 3, 1, 24),
    clearSamples: numSetting('ops_obs_clear_samples', 2, 1, 12),
    patternMin: numSetting('ops_obs_pattern_min', 3, 2, 10),
    patternDays: numSetting('ops_obs_pattern_days', 7, 1, 30),
    historyDays: numSetting('ops_obs_history_days', 90, 7, 365),
    disabledIds,
  };
}

function getOpsAgentSettings() {
  const sev = getSetting('ops_agent_min_severity');
  return {
    enabled: getSetting('ops_agent_enabled') === '1',
    name: (getSetting('ops_agent_name') || '').trim() || 'ICC Operations Agent',
    minSeverity: ['info', 'warning', 'error', 'critical'].includes(sev) ? sev : 'warning',
    grouping: ['platform', 'service', 'component', 'site'].includes(getSetting('ops_agent_grouping')) ? getSetting('ops_agent_grouping') : 'platform',
    holdMinutes: numSetting('ops_agent_hold_minutes', 10, 0, 120),
    // Correlation: how long after a parent fault (host, datastore, switch, site)
    // a child alert still counts as its consequence, and how close together
    // alerts on a shared component must open to fold as one. 0 turns each off.
    consequenceMinutes: numSetting('ops_agent_consequence_minutes', 30, 0, 240),
    onsetMinutes: numSetting('ops_agent_onset_minutes', 10, 0, 60),
    analysesPerHour: numSetting('ops_agent_analyses_per_hour', 20, 1, 200),
    renotifyMinutes: numSetting('ops_agent_renotify_minutes', 60, 0, 1440),
    autoResolveMinutes: numSetting('ops_agent_auto_resolve_minutes', 30, 0, 1440),
    evidenceResolve: getSetting('ops_agent_evidence_resolve') !== '0',
    // A condition that keeps coming back and keeps clearing itself is a
    // pattern, not a series of one-offs: this is how many times inside the
    // window it takes before the agent says so and asks for a person.
    patternMin: numSetting('ops_agent_pattern_min', 3, 2, 20),
    patternDays: numSetting('ops_agent_pattern_days', 14, 1, 90),
    // A repeat stays open until a person resolves it; reminders go out every
    // reminderHours until it is acknowledged; after a person resolves one, it
    // takes patternMin new occurrences inside the cooldown to make another.
    stickyRepeats: getSetting('ops_agent_sticky_repeats') !== '0',
    reminderHours: numSetting('ops_agent_reminder_hours', 24, 0, 168),
    patternCooldownDays: numSetting('ops_agent_pattern_cooldown_days', 14, 0, 90),
    // 'playbook' runs every enabled check on every target before triage;
    // 'tools' offers them to the model, which calls the ones it needs.
    capabilityMode: getSetting('ops_agent_capability_mode') === 'tools' ? 'tools' : 'playbook',
    maxToolCalls: numSetting('ops_agent_max_tool_calls', 6, 1, 12),
    // Observations: sustained-signal episodes over polled metrics
    // (services/agentObservations).
    observations: getObservationSettings(),
    emailEnabled: getSetting('ops_agent_email_enabled') !== '0',
    recipients: (getSetting('ops_agent_recipients') || '').trim(),
    // Teams is a second channel beside email (a Power Automate workflow URL,
    // stored encrypted and never returned; only whether one is set).
    teamsEnabled: getSetting('ops_agent_teams_enabled') === '1',
    teamsOnResolve: getSetting('ops_agent_teams_on_resolve') !== '0',
    teamsWebhookSet: !!getSetting('ops_agent_teams_webhook'),
    iccBaseUrl: getIccBaseUrl(),
  };
}

/** Public address of this ICC, for deep links in notifications. No trailing slash. */
function getIccBaseUrl() {
  return String(getSetting('icc_base_url') || '').trim().replace(/\/+$/, '');
}

/** Decrypted Teams workflow URL, or '' if none stored. */
function getTeamsWebhook() {
  return getSecretSetting('ops_agent_teams_webhook', null);
}

/** Service Status page (contract: critical-alert board + AI analysis cap). */
/** Cohesity alerts count only while they fired inside this many days. Open
 *  alerts nobody resolves on a cluster otherwise pile up for months (verified
 *  live 2026-09-21: 290 open criticals on one cluster, 282 older than 30 days).
 *  0 turns the window off. */
function getCohesityAlertWindowDays() {
  const n = Number(getSetting('cohesity_alert_window_days'));
  return (n >= 0 && n <= 365) ? Math.round(n) : 5;
}

/** Backup history depth per platform: how far back the poller fetches. */
function getCohesityRunHistoryDays() { return numSetting('cohesity_run_history_days', 90, 30, 365); }
/** Cohesity run retention: 0 (default) keeps every stored run; 30..3650 prunes older rows after each poll.
 *  Separate from the fetch depth on purpose: stored history is never deleted unless an admin turns this on. */
function getCohesityRunRetentionDays() {
  const raw = getSetting('cohesity_run_retention_days');
  if (raw == null || String(raw).trim() === '' || Number(raw) === 0) return 0;
  return numSetting('cohesity_run_retention_days', 0, 30, 3650);
}
function getNetbackupJobHistoryDays() { return numSetting('netbackup_job_history_days', 30, 7, 365); }

function getServiceStatusSettings() {
  const perMinute = Number(getSetting('service_status_analyses_per_minute'));
  const dedupe = Number(getSetting('service_status_dedupe_minutes'));
  const staleHours = Number(getSetting('app_service_backup_stale_hours'));
  const staleMin = Number(getSetting('service_status_stale_minutes'));
  return {
    serviceStatusMode: getSetting('service_status_mode') === 'alerts' ? 'alerts' : 'platform',
    serviceStatusStaleMinutes: (staleMin >= 10 && staleMin <= 1440) ? Math.round(staleMin) : 120,
    serviceStatusAiEnabled: getSetting('service_status_ai_enabled') !== '0',
    serviceStatusAnalysesPerMinute: (perMinute >= 1 && perMinute <= 30) ? Math.round(perMinute) : 3,
    serviceStatusDedupeMinutes: (dedupe >= 0 && dedupe <= 1440) ? Math.round(dedupe) : 60,
    // App Services page only: how old the newest Cohesity backup of a protected
    // server may be before its app shows degraded.
    appServiceBackupStaleHours: (staleHours >= 1 && staleHours <= 720) ? Math.round(staleHours) : 24,
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
  getNotificationSettings, getSmtpPassword, getServiceStatusSettings, getOpsAgentSettings, getObservationSettings, getCohesityAlertWindowDays,
  getCohesityRunHistoryDays, getCohesityRunRetentionDays, getNetbackupJobHistoryDays,
  getIccBaseUrl, getTeamsWebhook,
};
