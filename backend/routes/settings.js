const express = require('express');
const { getAiSettings, getLicenseSettings, getPlatformSettings, setSetting } = require('../services/settings');

const router = express.Router();

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
      platformPureEnabled, platformNetappEnabled,
    } = req.body || {};
    if (llmEstateContext !== undefined) {
      setSetting('llm_estate_context', String(llmEstateContext).slice(0, 4000));
    }
    if (llmFlagUnprotected !== undefined) {
      setSetting('llm_flag_unprotected', llmFlagUnprotected ? '1' : '0');
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
    res.json({ ...getAiSettings(), ...getLicenseSettings(), ...getPlatformSettings() });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
