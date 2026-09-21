// App Service Status: catalog of usage-id tags, the watched list, the board
// and per-app detail. Reads are open to any authenticated caller (same as
// /api/service-status); changing the watched list needs admin:settings:manage.
const express = require('express');
const svc = require('../services/appServiceStatus');
const db = require('../db/database');
const { getAuthenticatedClient } = require('../services/cohesityApi');
const { requirePermission } = require('../middleware/requirePermission');

const multer = require('multer');

const router = express.Router();
const manage = requirePermission('admin:settings:manage');
const catalogUpload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 5 * 1024 * 1024, files: 1 } });

router.get('/board', (req, res, next) => {
  try {
    res.json(svc.getBoard());
  } catch (err) {
    next(err);
  }
});

router.post('/evaluate', manage, (req, res, next) => {
  try {
    svc.evaluateAll();
    res.json(svc.getBoard());
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
    res.json(svc.evaluate(req.params.usageId));
  } catch (err) {
    next(err);
  }
});

// Live debug loop for a server whose Backup row looks wrong: what ICC stored
// for it, next to what each Cohesity cluster answers right now for the two
// searches the poller reads (objects = protection and group status,
// protected-objects = snapshot times).
router.get('/backup-probe', manage, async (req, res, next) => {
  try {
    const name = String(req.query.name || '').trim();
    if (!name) return res.status(400).json({ error: 'name is required' });
    if (process.env.DASHBOARD_DEMO === '1') return res.status(403).json({ error: 'The demo does not open outbound connections.' });
    const short = name.toLowerCase().split('.')[0];
    const stored = db.prepare(`
      SELECT o.cluster_id, c.name AS cluster_name, o.object_id, o.name, o.environment, o.is_protected,
             o.protection_groups, o.last_backup_status, o.last_backup_ms
      FROM cohesity_objects o JOIN clusters c ON c.id = o.cluster_id
      WHERE lower(o.name) = ? OR lower(o.name) LIKE ?
    `).all(name.toLowerCase(), `${short}.%`);
    const clusters = [];
    for (const clusterId of [...new Set(stored.map((r) => r.cluster_id))]) {
      const cluster = db.prepare('SELECT * FROM clusters WHERE id = ?').get(clusterId);
      const entry = { cluster: cluster.name };
      try {
        const client = await getAuthenticatedClient(cluster);
        const q = `searchString=${encodeURIComponent(short)}&count=20`;
        const objects = await client.get(`/v2/data-protect/search/objects?${q}`, { timeout: 60000 });
        entry.objects = (objects.data?.objects || []).map((o) => ({
          name: o.name, environment: o.environment, objectProtectionInfos: o.objectProtectionInfos,
        }));
        const prot = await client.get(`/v2/data-protect/search/protected-objects?${q}`, { timeout: 60000 });
        entry.protectedObjects = (prot.data?.objects || []).map((o) => ({
          id: o.id, name: o.name, environment: o.environment, latestSnapshotsInfo: o.latestSnapshotsInfo,
        }));
      } catch (err) {
        entry.error = `${err.response?.status || ''} ${err.message}`.trim();
      }
      clusters.push(entry);
    }
    res.json({ name, stored, clusters });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
