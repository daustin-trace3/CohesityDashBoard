const express = require('express');
const { getLatest } = require('../services/releaseNotes');
const pkg = require('../../package.json');

const router = express.Router();

/** GET /api/release-notes — delta between the previous and current release, for the "What's New" popup. */
router.get('/', (req, res) => {
  res.json({ appVersion: pkg.version, latest: getLatest() });
});

module.exports = router;
