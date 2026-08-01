// Custom dashboards CRUD (phase 2) — private per-owner saved dashboards.
// Widget data access is NOT checked here: dataset RBAC is enforced per-viewer
// at render time by /api/datasets/:id/query, so saving a widget never grants
// anything. Reachable to any authenticated caller, scoped to the owner.
const express = require('express');
const db = require('../db/database');
const catalog = require('../services/datasetCatalog');

const router = express.Router();

const CHART_TYPES = new Set(['table', 'bar', 'line', 'pie', 'stat']);
const MAX_WIDGETS = 20;
const MAX_WIDGETS_JSON = 100 * 1024;

function ownerKey(req) {
  const auth = req.auth || {};
  if (auth.kind === 'session' && auth.user && auth.user.id != null) return `user:${auth.user.id}`;
  if (auth.kind === 'service' && auth.name) return `service:${auth.name}`;
  return 'anonymous';
}

function validateName(name) {
  if (typeof name !== 'string' || !name.trim() || name.length > 120) {
    return 'name must be a non-empty string (max 120 chars)';
  }
  return null;
}

function validateWidgets(widgets) {
  if (!Array.isArray(widgets)) return 'widgets must be an array';
  if (widgets.length > MAX_WIDGETS) return `max ${MAX_WIDGETS} widgets per dashboard`;
  for (const w of widgets) {
    if (!w || typeof w !== 'object') return 'each widget must be an object';
    if (!CHART_TYPES.has(w.chartType)) return `invalid chartType '${String(w.chartType)}'`;
    if (typeof w.datasetId !== 'string' || !catalog.getDataset(w.datasetId)) {
      return `unknown dataset '${String(w.datasetId)}'`;
    }
    if (w.title != null && (typeof w.title !== 'string' || w.title.length > 120)) {
      return 'widget title must be a string (max 120 chars)';
    }
    if (w.query != null && (typeof w.query !== 'object' || Array.isArray(w.query))) {
      return 'widget query must be an object';
    }
  }
  if (JSON.stringify(widgets).length > MAX_WIDGETS_JSON) return 'widgets payload too large';
  return null;
}

function toSummary(row) {
  let count = 0;
  try { count = JSON.parse(row.widgets).length; } catch { count = 0; }
  return { id: row.id, name: row.name, widgetCount: count, updated_at: row.updated_at };
}

function loadOwned(req, res) {
  const row = db.prepare('SELECT * FROM user_dashboards WHERE id = ?').get(req.params.id);
  if (!row || row.owner !== ownerKey(req)) {
    res.status(404).json({ error: 'dashboard_not_found' });
    return null;
  }
  return row;
}

router.get('/', (req, res) => {
  const rows = db
    .prepare('SELECT * FROM user_dashboards WHERE owner = ? ORDER BY updated_at DESC')
    .all(ownerKey(req));
  res.json({ dashboards: rows.map(toSummary) });
});

router.post('/', (req, res) => {
  const { name, widgets = [] } = req.body || {};
  const err = validateName(name) || validateWidgets(widgets);
  if (err) return res.status(400).json({ error: 'invalid_dashboard', message: err });
  const now = new Date().toISOString();
  const info = db
    .prepare('INSERT INTO user_dashboards (owner, name, widgets, created_at, updated_at) VALUES (?, ?, ?, ?, ?)')
    .run(ownerKey(req), name.trim(), JSON.stringify(widgets), now, now);
  res.status(201).json({ id: info.lastInsertRowid, name: name.trim() });
});

router.get('/:id', (req, res) => {
  const row = loadOwned(req, res);
  if (!row) return;
  let widgets = [];
  try { widgets = JSON.parse(row.widgets); } catch { widgets = []; }
  res.json({ id: row.id, name: row.name, widgets, updated_at: row.updated_at });
});

router.put('/:id', (req, res) => {
  const row = loadOwned(req, res);
  if (!row) return;
  const { name = row.name, widgets } = req.body || {};
  const err = validateName(name) || (widgets !== undefined ? validateWidgets(widgets) : null);
  if (err) return res.status(400).json({ error: 'invalid_dashboard', message: err });
  db.prepare('UPDATE user_dashboards SET name = ?, widgets = ?, updated_at = ? WHERE id = ?').run(
    name.trim(),
    widgets !== undefined ? JSON.stringify(widgets) : row.widgets,
    new Date().toISOString(),
    row.id
  );
  res.json({ ok: true });
});

router.delete('/:id', (req, res) => {
  const row = loadOwned(req, res);
  if (!row) return;
  db.prepare('DELETE FROM user_dashboards WHERE id = ?').run(row.id);
  res.json({ ok: true });
});

module.exports = router;
