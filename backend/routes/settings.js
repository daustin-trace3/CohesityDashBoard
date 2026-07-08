const express = require('express');
const { getAiSettings, getLicenseSettings, getPlatformSettings, setSetting, secretSource } = require('../services/settings');
const { encrypt } = require('../services/encryption');
const { listModels } = require('../services/llmProvider');

const router = express.Router();

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
      platformPureEnabled, platformNetappEnabled, dnsServer,
    } = req.body || {};
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
    if (platformPureEnabled !== undefined) {
      setSetting('platform_pure_enabled', platformPureEnabled ? '1' : '0');
    }
    if (platformNetappEnabled !== undefined) {
      setSetting('platform_netapp_enabled', platformNetappEnabled ? '1' : '0');
    }
    if (dnsServer !== undefined) {
      setSetting('dns_server', String(dnsServer).trim().slice(0, 253));
    }
    res.json({ ...getAiSettings(), ...getLicenseSettings(), ...getPlatformSettings() });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
