const express = require('express');
const { getAiSettings, getLicenseSettings, getPlatformSettings, getNotificationSettings, setSetting, secretSource } = require('../services/settings');
const { encrypt } = require('../services/encryption');
const { listModels } = require('../services/llmProvider');
const alertNotifier = require('../services/alertNotifier');
const registry = require('../core/registry');

const router = express.Router();

const ENCRYPTION_VALUES = new Set(['none', 'starttls', 'tls']);
const AUTH_METHOD_VALUES = new Set(['none', 'login']);
const SEVERITY_VALUES = new Set(['info', 'warning', 'critical']);

/** Apply an enable-flag toggle to the registry + (re)start/stop its poller.
 *  No-throw: the registry may not have the plugin registered (e.g. tests). */
function applyPlatformEnabled(pluginId, enabled) {
  try {
    const changed = registry.setEnabled(pluginId, enabled);
    if (!changed) return;
    const handle = registry.getPollerHandle(pluginId);
    if (!handle) return;
    if (enabled) {
      if (typeof handle.init === 'function') handle.init();
    } else if (typeof handle.stopAll === 'function') {
      handle.stopAll();
    }
  } catch (err) {
    // Never let a poller start/stop failure break the settings save.
  }
}

// Secrets managed on Settings → Credentials. Values are stored AES-256-GCM
// encrypted in app_settings and are NEVER returned by any endpoint — the UI
// only sees where each one comes from ('settings' | 'env' | 'none').
const CREDENTIALS = {
  heliosApiKey: { key: 'helios_api_key', env: 'HELIOS_API_KEY' },
  openaiToken: { key: 'openai_token', env: 'OPENAI_TOKEN' },
  githubModelsToken: { key: 'github_models_token', env: 'GITHUB_MODELS_TOKEN' },
};

function credentialStatus() {
  const out = {};
  for (const [name, c] of Object.entries(CREDENTIALS)) out[name] = secretSource(c.key, c.env);
  return out;
}

/** GET /api/settings/llm-models — chat models available from the active AI
 *  provider, for the default-model picker. */
router.get('/llm-models', async (req, res) => {
  try {
    res.json(await listModels());
  } catch (err) {
    if (err.code === 'LLM_NOT_CONFIGURED') {
      return res.status(503).json({ error: 'AI is not configured — add a token first.' });
    }
    const status = err.response?.status;
    res.status(502).json({ error: `Could not list models from the AI provider${status ? ` (HTTP ${status})` : ''}.` });
  }
});

/** GET /api/settings/credentials — source of each secret, never the value. */
router.get('/credentials', (req, res) => {
  res.json(credentialStatus());
});

/** PUT /api/settings/credentials — save (encrypt) or clear platform secrets.
 *  Body: { heliosApiKey?, openaiToken?, githubModelsToken? } — a non-empty
 *  string saves it encrypted; an empty string clears the stored value (the
 *  .env fallback, if any, then applies again). Omitted fields are untouched. */
router.put('/credentials', (req, res, next) => {
  try {
    const body = req.body || {};
    for (const [name, c] of Object.entries(CREDENTIALS)) {
      if (body[name] === undefined) continue;
      const value = String(body[name]).trim();
      setSetting(c.key, value ? encrypt(value) : '');
    }
    res.json(credentialStatus());
  } catch (err) {
    next(err);
  }
});

/** GET /api/settings — current AI + licensing settings. */
router.get('/', (req, res, next) => {
  try {
    res.json({ ...getAiSettings(), ...getLicenseSettings(), ...getPlatformSettings() });
  } catch (err) {
    next(err);
  }
});

/** PUT /api/settings — update AI + licensing + platform settings. */
router.put('/', (req, res, next) => {
  try {
    const {
      llmEstateContext, llmFlagUnprotected,
      licenseEntitledDataProtectTb, licenseEntitledReplicaTb, licenseEntitledSmartFilesTb,
      licenseExpiry, licenseEdition,
      platformCohesityEnabled, platformPureEnabled, platformNetappEnabled, platformZertoEnabled, platformVcenterEnabled, platformDellEnabled, platformAriaEnabled, platformAriaopsEnabled, platformNetbackupEnabled, platformAwsEnabled, platformProxmoxEnabled, platformBrocadeEnabled, dnsServer,
    } = req.body || {};

    // Guard: never let the last platform be turned off, or the app has no tabs.
    // Resolve each platform's post-save state (incoming value if present, else stored).
    const current = getPlatformSettings();
    const resolve = (incoming, key) => (incoming !== undefined ? !!incoming : current[key]);
    const anyEnabled = [
      resolve(platformCohesityEnabled, 'platformCohesityEnabled'),
      resolve(platformPureEnabled, 'platformPureEnabled'),
      resolve(platformNetappEnabled, 'platformNetappEnabled'),
      resolve(platformZertoEnabled, 'platformZertoEnabled'),
      resolve(platformVcenterEnabled, 'platformVcenterEnabled'),
      resolve(platformDellEnabled, 'platformDellEnabled'),
      resolve(platformAriaEnabled, 'platformAriaEnabled'),
      resolve(platformAriaopsEnabled, 'platformAriaopsEnabled'),
      resolve(platformNetbackupEnabled, 'platformNetbackupEnabled'),
      resolve(platformAwsEnabled, 'platformAwsEnabled'),
      resolve(platformProxmoxEnabled, 'platformProxmoxEnabled'),
      resolve(platformBrocadeEnabled, 'platformBrocadeEnabled'),
    ].some(Boolean);
    if (!anyEnabled) {
      return res.status(400).json({ error: 'At least one platform must remain enabled.' });
    }
    if (llmEstateContext !== undefined) {
      setSetting('llm_estate_context', String(llmEstateContext).slice(0, 4000));
    }
    if (llmFlagUnprotected !== undefined) {
      setSetting('llm_flag_unprotected', llmFlagUnprotected ? '1' : '0');
    }
    if (req.body?.llmModel !== undefined) {
      setSetting('llm_model', String(req.body.llmModel).trim().slice(0, 120));
    }
    if (req.body?.llmAnalysisTtlHours !== undefined) {
      const n = Number(req.body.llmAnalysisTtlHours);
      setSetting('llm_analysis_ttl_hours', n >= 1 && n <= 720 ? String(Math.round(n)) : '');
    }
    // Entitlements are decimal TB; the *_tib keys are legacy storage names.
    if (licenseEntitledDataProtectTb !== undefined) {
      setSetting('license_entitled_dataprotect_tib', String(Math.max(0, Number(licenseEntitledDataProtectTb) || 0)));
    }
    if (licenseEntitledReplicaTb !== undefined) {
      setSetting('license_entitled_replica_tib', String(Math.max(0, Number(licenseEntitledReplicaTb) || 0)));
    }
    if (licenseEntitledSmartFilesTb !== undefined) {
      setSetting('license_entitled_smartfiles_tib', String(Math.max(0, Number(licenseEntitledSmartFilesTb) || 0)));
    }
    if (licenseExpiry !== undefined) {
      setSetting('license_expiry', String(licenseExpiry).slice(0, 40));
    }
    if (licenseEdition !== undefined) {
      setSetting('license_edition', String(licenseEdition).slice(0, 80));
    }
    if (platformCohesityEnabled !== undefined) {
      setSetting('platform_cohesity_enabled', platformCohesityEnabled ? '1' : '0');
      applyPlatformEnabled('cohesity', !!platformCohesityEnabled);
    }
    if (platformPureEnabled !== undefined) {
      setSetting('platform_pure_enabled', platformPureEnabled ? '1' : '0');
      applyPlatformEnabled('pure', !!platformPureEnabled);
    }
    if (platformNetappEnabled !== undefined) {
      setSetting('platform_netapp_enabled', platformNetappEnabled ? '1' : '0');
      applyPlatformEnabled('netapp', !!platformNetappEnabled);
    }
    if (platformZertoEnabled !== undefined) {
      setSetting('platform_zerto_enabled', platformZertoEnabled ? '1' : '0');
      applyPlatformEnabled('zerto', !!platformZertoEnabled);
    }
    if (platformVcenterEnabled !== undefined) {
      setSetting('platform_vcenter_enabled', platformVcenterEnabled ? '1' : '0');
      applyPlatformEnabled('vcenter', !!platformVcenterEnabled);
    }
    if (platformDellEnabled !== undefined) {
      setSetting('platform_dell_enabled', platformDellEnabled ? '1' : '0');
      applyPlatformEnabled('dell', !!platformDellEnabled);
    }
    if (platformAriaEnabled !== undefined) {
      setSetting('platform_aria_enabled', platformAriaEnabled ? '1' : '0');
      applyPlatformEnabled('aria', !!platformAriaEnabled);
    }
    if (platformAriaopsEnabled !== undefined) {
      setSetting('platform_ariaops_enabled', platformAriaopsEnabled ? '1' : '0');
      applyPlatformEnabled('ariaops', !!platformAriaopsEnabled);
    }
    if (platformNetbackupEnabled !== undefined) {
      setSetting('platform_netbackup_enabled', platformNetbackupEnabled ? '1' : '0');
      applyPlatformEnabled('netbackup', !!platformNetbackupEnabled);
    }
    if (platformAwsEnabled !== undefined) {
      setSetting('platform_aws_enabled', platformAwsEnabled ? '1' : '0');
      applyPlatformEnabled('aws', !!platformAwsEnabled);
    }
    if (platformProxmoxEnabled !== undefined) {
      setSetting('platform_proxmox_enabled', platformProxmoxEnabled ? '1' : '0');
      applyPlatformEnabled('proxmox', !!platformProxmoxEnabled);
    }
    if (platformBrocadeEnabled !== undefined) {
      setSetting('platform_brocade_enabled', platformBrocadeEnabled ? '1' : '0');
      applyPlatformEnabled('brocade', !!platformBrocadeEnabled);
    }
    if (dnsServer !== undefined) {
      setSetting('dns_server', String(dnsServer).trim().slice(0, 253));
    }
    if (req.body?.featureCustomDashboardsEnabled !== undefined) {
      setSetting('feature_custom_dashboards_enabled', req.body.featureCustomDashboardsEnabled ? '1' : '0');
    }
    res.json({ ...getAiSettings(), ...getLicenseSettings(), ...getPlatformSettings() });
  } catch (err) {
    next(err);
  }
});

/** GET /api/settings/notifications — SMTP + alert-email config. Password is
 *  never returned, only smtpPasswordSet. */
router.get('/notifications', (req, res, next) => {
  try {
    res.json(getNotificationSettings());
  } catch (err) {
    next(err);
  }
});

/** PUT /api/settings/notifications — same write-only-secret convention as
 *  /credentials: smtpPassword non-empty saves encrypted, '' clears, omitted
 *  is untouched. */
router.put('/notifications', (req, res, next) => {
  try {
    const body = req.body || {};

    if (body.smtpPort !== undefined) {
      const port = Number(body.smtpPort);
      if (!Number.isInteger(port) || port < 1 || port > 65535) {
        return res.status(400).json({ error: 'smtpPort must be an integer between 1 and 65535' });
      }
    }
    if (body.smtpEncryption !== undefined && !ENCRYPTION_VALUES.has(body.smtpEncryption)) {
      return res.status(400).json({ error: "smtpEncryption must be one of 'none', 'starttls', 'tls'" });
    }
    if (body.smtpAuthMethod !== undefined && !AUTH_METHOD_VALUES.has(body.smtpAuthMethod)) {
      return res.status(400).json({ error: "smtpAuthMethod must be one of 'none', 'login'" });
    }
    if (body.alertMinSeverity !== undefined && !SEVERITY_VALUES.has(body.alertMinSeverity)) {
      return res.status(400).json({ error: "alertMinSeverity must be one of 'info', 'warning', 'critical'" });
    }
    if (body.reminderHours !== undefined) {
      const hours = Number(body.reminderHours);
      if (!Number.isInteger(hours) || hours < 0 || hours > 168) {
        return res.status(400).json({ error: 'reminderHours must be an integer between 0 and 168' });
      }
    }

    if (body.smtpEnabled !== undefined) setSetting('smtp_enabled', body.smtpEnabled ? '1' : '0');
    if (body.smtpHost !== undefined) setSetting('smtp_host', String(body.smtpHost).trim().slice(0, 253));
    if (body.smtpPort !== undefined) setSetting('smtp_port', String(Math.round(Number(body.smtpPort))));
    if (body.smtpEncryption !== undefined) setSetting('smtp_encryption', body.smtpEncryption);
    if (body.smtpAuthMethod !== undefined) setSetting('smtp_auth_method', body.smtpAuthMethod);
    if (body.smtpUsername !== undefined) setSetting('smtp_username', String(body.smtpUsername).trim().slice(0, 253));
    if (body.smtpPassword !== undefined) {
      const value = String(body.smtpPassword);
      setSetting('smtp_password', value ? encrypt(value) : '');
    }
    if (body.smtpFrom !== undefined) setSetting('smtp_from', String(body.smtpFrom).trim().slice(0, 253));
    if (body.smtpRecipients !== undefined) setSetting('smtp_recipients', String(body.smtpRecipients).trim().slice(0, 2000));
    if (body.alertMinSeverity !== undefined) setSetting('alert_email_min_severity', body.alertMinSeverity);
    if (body.alertPlatforms !== undefined) {
      // current always carries every known platform key (defaults-merged in
      // getNotificationSettings), so iterate it instead of hardcoding the list.
      const current = getNotificationSettings().alertPlatforms;
      const merged = {};
      for (const key of Object.keys(current)) {
        merged[key] = body.alertPlatforms[key] !== undefined ? !!body.alertPlatforms[key] : current[key];
      }
      setSetting('alert_email_platforms', JSON.stringify(merged));
    }
    if (body.reminderHours !== undefined) setSetting('alert_email_reminder_hours', String(Math.round(Number(body.reminderHours))));

    res.json(getNotificationSettings());
  } catch (err) {
    next(err);
  }
});

/** POST /api/settings/notifications/test — send a test email using the
 *  saved SMTP config, without waiting for the cron cycle. */
router.post('/notifications/test', async (req, res) => {
  try {
    await alertNotifier.sendTestEmail();
    res.json({ ok: true });
  } catch (err) {
    if (err.code === 'SMTP_NOT_CONFIGURED') {
      return res.status(400).json({ error: err.message });
    }
    res.status(502).json({ error: err.message });
  }
});

module.exports = router;
