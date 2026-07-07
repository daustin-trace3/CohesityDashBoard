const express = require('express');
const { getLicenseStatus, applyExtension, activateKey, checkRenewal } = require('../services/license');

const router = express.Router();

/** GET /api/license/status — always reachable, even when the app is locked. */
router.get('/status', (req, res) => {
  res.json(getLicenseStatus());
});

/** POST /api/license/renew — ask the vendor renewal endpoint right now. */
router.post('/renew', async (req, res, next) => {
  try {
    res.json(await checkRenewal({ force: true }));
  } catch (err) {
    next(err);
  }
});

/** POST /api/license/activate — paste a CDBL key on the license page; persists to .env and unlocks live. */
router.post('/activate', (req, res) => {
  const { key } = req.body || {};
  if (!key) return res.status(400).json({ error: 'key is required.' });
  const result = activateKey(String(key));
  if (result.error) return res.status(400).json({ error: result.error });
  res.json(result.status);
});

/** POST /api/license/extension — paste a CDBX extension cert (air-gapped renewal). */
router.post('/extension', (req, res) => {
  const { cert } = req.body || {};
  if (!cert) return res.status(400).json({ error: 'cert is required.' });
  const result = applyExtension(String(cert));
  if (result.error) return res.status(400).json({ error: result.error });
  res.json(result.status);
});

module.exports = router;
