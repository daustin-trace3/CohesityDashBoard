// Dataset catalog API (custom dashboards, phase 1). Per-dataset RBAC is
// enforced here at request time — fail closed per viewer, not at save time.
const express = require('express');
const db = require('../db/database');
const { hasPermission } = require('../services/rbac');
const catalog = require('../services/datasetCatalog');

const router = express.Router();

function loadVisible(req, res) {
  const ds = catalog.getDataset(req.params.id);
  if (!ds || !catalog.isAvailable(ds)) {
    res.status(404).json({ error: 'dataset_not_found' });
    return null;
  }
  const required = catalog.requiredPermission(ds);
  const grants = (req.auth && req.auth.grants) || [];
  if (!hasPermission(grants, required)) {
    res.status(403).json({ error: 'forbidden', required });
    return null;
  }
  return ds;
}

router.get('/', (req, res) => {
  const grants = (req.auth && req.auth.grants) || [];
  res.json({ datasets: catalog.listDatasets(grants) });
});

router.get('/:id', (req, res) => {
  const ds = loadVisible(req, res);
  if (!ds) return;
  res.json(catalog.listDatasets((req.auth && req.auth.grants) || []).find((d) => d.id === ds.id));
});

router.post('/:id/query', (req, res, next) => {
  const ds = loadVisible(req, res);
  if (!ds) return;
  try {
    res.json(catalog.queryDataset(db, ds.id, req.body || {}));
  } catch (err) {
    if (err instanceof catalog.DatasetQueryError) {
      return res.status(400).json({ error: 'invalid_query', message: err.message });
    }
    next(err);
  }
});

module.exports = router;
