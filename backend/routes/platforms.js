// GET /api/platforms: which platforms are switched on, for any signed-in
// caller. The rail used to read this off GET /api/settings, which needs
// admin:settings:view, so a non-admin never learned which platforms were
// enabled and saw only the default tab (CG box, 2026-11-10). No secrets or
// thresholds here, only on/off flags and the derived platform rows.
const express = require('express');
const { getPlatformSettings } = require('../services/settings');
const registry = require('../core/registry');

const router = express.Router();

function derivedPlatformRows() {
  try {
    return registry.listDerived().map((d) => ({
      id: d.id, label: d.label, derivedFrom: d.derivedFrom, enabled: d.enabled, present: d.present, matchedDevices: d.matchedDevices,
    }));
  } catch { return []; }
}

router.get('/', (req, res, next) => {
  try {
    res.json({
      ...getPlatformSettings(),
      derivedPlatforms: derivedPlatformRows(),
    });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
