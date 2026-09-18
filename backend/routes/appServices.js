// App Service Status: catalog of usage-id tags, the watched list, the board
// and per-app detail. An app is a set of vCenter VMs, so every read needs a
// vcenter grant; the SAN, storage and backup slices are other platforms' data
// and are removed for callers who do not hold those platforms (see
// redactDetail / redactBoard). Changing the watched list needs
// admin:settings:manage.
const express = require('express');
const svc = require('../services/appServiceStatus');
const { requirePermission } = require('../middleware/requirePermission');

const multer = require('multer');

const { canViewPlatform } = require('../services/rbac');

const router = express.Router();
const manage = requirePermission('admin:settings:manage');
const grantsOf = (req) => (req.auth && req.auth.grants) || [];

router.use((req, res, next) => {
  if (!canViewPlatform(grantsOf(req), 'vcenter')) {
    return res.status(403).json({ error: 'forbidden', required: 'vcenter:*:view' });
  }
  next();
});
const catalogUpload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 5 * 1024 * 1024, files: 1 } });

router.get('/board', (req, res, next) => {
  try {
    res.json(svc.redactBoard(svc.getBoard(), grantsOf(req)));
  } catch (err) {
    next(err);
  }
});

router.post('/evaluate', manage, (req, res, next) => {
  try {
    svc.evaluateAll();
    res.json(svc.redactBoard(svc.getBoard(), grantsOf(req)));
  } catch (err) {
    next(err);
  }
});

router.get('/usage-ids', (req, res, next) => {
  try {
    res.json({ usageIds: svc.listUsageIds({ q: req.query.q, limit: req.query.limit }) });
  } catch (err) {
    next(err);
  }
});

router.get('/watch', (req, res, next) => {
  try {
    res.json({ watch: svc.listWatch() });
  } catch (err) {
    next(err);
  }
});

router.post('/watch', manage, (req, res, next) => {
  try {
    const { usageId, label } = req.body || {};
    if (!usageId || typeof usageId !== 'string' || !usageId.trim()) {
      return res.status(400).json({ error: 'usageId is required' });
    }
    if (label !== undefined && label !== null && typeof label !== 'string') {
      return res.status(400).json({ error: 'label must be a string' });
    }
    const row = svc.addWatch({ usageId, label, user: req.auth?.user?.username || null });
    res.status(201).json(row);
  } catch (err) {
    if (err.status) return res.status(err.status).json({ error: err.message });
    next(err);
  }
});

router.put('/watch/:usageId', manage, (req, res, next) => {
  try {
    const { label } = req.body || {};
    if (label !== undefined && label !== null && typeof label !== 'string') {
      return res.status(400).json({ error: 'label must be a string' });
    }
    const row = svc.updateWatch(req.params.usageId, { label });
    if (!row) return res.status(404).json({ error: 'usage-id is not watched' });
    res.json(row);
  } catch (err) {
    next(err);
  }
});

router.delete('/watch/:usageId', manage, (req, res, next) => {
  try {
    if (!svc.removeWatch(req.params.usageId)) return res.status(404).json({ error: 'usage-id is not watched' });
    res.status(204).end();
  } catch (err) {
    next(err);
  }
});

// Application catalog: CSV with an ATM ID column plus optional Name, Lifecycle
// and Platform columns. Upload as multipart field "file", or send JSON { csv }.
router.get('/catalog', (req, res, next) => {
  try {
    res.json(svc.catalogSummary());
  } catch (err) {
    next(err);
  }
});

router.post('/catalog/import', manage, (req, res, next) => {
  catalogUpload.single('file')(req, res, (uploadErr) => {
    if (uploadErr) return res.status(400).json({ error: uploadErr.message });
    try {
      let text = null;
      if (req.file) {
        if (/\.xlsx?$/i.test(req.file.originalname || '')) {
          return res.status(400).json({ error: 'Save the sheet as CSV (Excel: File, Save As, CSV UTF-8) and upload that file' });
        }
        text = req.file.buffer.toString('utf8');
      } else if (req.body && typeof req.body.csv === 'string') {
        text = req.body.csv;
      }
      if (!text || !text.trim()) return res.status(400).json({ error: "no file uploaded (multipart field must be 'file')" });
      res.json(svc.importCatalog(text, { user: req.auth?.user?.username || null }));
    } catch (err) {
      if (err.status) return res.status(err.status).json({ error: err.message });
      next(err);
    }
  });
});

router.get('/apps/:usageId', (req, res, next) => {
  try {
    res.json(svc.redactDetail(svc.evaluate(req.params.usageId), grantsOf(req)));
  } catch (err) {
    next(err);
  }
});

module.exports = router;
