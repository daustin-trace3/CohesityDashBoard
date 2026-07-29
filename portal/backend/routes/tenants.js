const express = require('express');
const db = require('../db');
const { encrypt, decrypt } = require('../services/encryption');
const { refreshTenant, fetchSummary } = require('../services/rollup');

const router = express.Router();

function validUrl(value) {
  try {
    const u = new URL(String(value));
    return u.protocol === 'http:' || u.protocol === 'https:';
  } catch {
    return false;
  }
}

function publicTenant(row) {
  let summary = null;
  try { summary = row.summary_json ? JSON.parse(row.summary_json) : null; } catch { /* corrupt cache */ }
  return {
    id: row.id,
    name: row.name,
    url: row.url,
    hasApiKey: !!row.api_key_encrypted,
    notes: row.notes,
    enabled: !!row.enabled,
    createdAt: row.created_at,
    lastFetchAt: row.last_fetch_at,
    lastFetchOk: row.last_fetch_ok === null ? null : !!row.last_fetch_ok,
    lastFetchError: row.last_fetch_error,
    summary,
  };
}

router.get('/', (req, res) => {
  const rows = db.prepare('SELECT * FROM tenants ORDER BY name').all();
  res.json({ tenants: rows.map(publicTenant) });
});

router.post('/', (req, res) => {
  const { name, url, apiKey, notes, enabled } = req.body || {};
  const cleanName = String(name || '').trim();
  const cleanUrl = String(url || '').trim().replace(/\/+$/, '');
  if (!cleanName || !cleanUrl) return res.status(400).json({ error: 'name and url are required.' });
  if (!validUrl(cleanUrl)) return res.status(400).json({ error: 'url must be a valid http(s) URL.' });
  if (db.prepare('SELECT id FROM tenants WHERE name = ? OR url = ?').get(cleanName, cleanUrl)) {
    return res.status(409).json({ error: 'A tenant with that name or URL already exists.' });
  }
  const now = new Date().toISOString();
  const info = db.prepare(`
    INSERT INTO tenants (name, url, api_key_encrypted, notes, enabled, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(cleanName, cleanUrl, apiKey ? encrypt(String(apiKey)) : null, String(notes || ''), enabled === false ? 0 : 1, now, now);
  const row = db.prepare('SELECT * FROM tenants WHERE id = ?').get(info.lastInsertRowid);
  refreshTenant(row).catch(() => {});
  res.json({ tenant: publicTenant(row) });
});

/** PUT /:id — apiKey is keep-if-blank. */
router.put('/:id', (req, res) => {
  const row = db.prepare('SELECT * FROM tenants WHERE id = ?').get(req.params.id);
  if (!row) return res.status(404).json({ error: 'Tenant not found.' });

  const { name, url, apiKey, notes, enabled } = req.body || {};
  const cleanName = name !== undefined ? String(name).trim() : row.name;
  const cleanUrl = url !== undefined ? String(url).trim().replace(/\/+$/, '') : row.url;
  if (!cleanName || !cleanUrl) return res.status(400).json({ error: 'name and url are required.' });
  if (!validUrl(cleanUrl)) return res.status(400).json({ error: 'url must be a valid http(s) URL.' });
  const dup = db.prepare('SELECT id FROM tenants WHERE (name = ? OR url = ?) AND id != ?').get(cleanName, cleanUrl, row.id);
  if (dup) return res.status(409).json({ error: 'A tenant with that name or URL already exists.' });

  db.prepare(`
    UPDATE tenants SET name = ?, url = ?, api_key_encrypted = ?, notes = ?, enabled = ?, updated_at = ?
    WHERE id = ?
  `).run(
    cleanName,
    cleanUrl,
    apiKey ? encrypt(String(apiKey)) : row.api_key_encrypted,
    notes !== undefined ? String(notes) : row.notes,
    enabled === undefined ? row.enabled : (enabled ? 1 : 0),
    new Date().toISOString(),
    row.id
  );
  const updated = db.prepare('SELECT * FROM tenants WHERE id = ?').get(row.id);
  refreshTenant(updated).catch(() => {});
  res.json({ tenant: publicTenant(updated) });
});

router.delete('/:id', (req, res) => {
  const row = db.prepare('SELECT * FROM tenants WHERE id = ?').get(req.params.id);
  if (!row) return res.status(404).json({ error: 'Tenant not found.' });
  db.prepare('DELETE FROM tenants WHERE id = ?').run(row.id);
  res.json({ ok: true });
});

router.post('/:id/refresh', async (req, res) => {
  const row = db.prepare('SELECT * FROM tenants WHERE id = ?').get(req.params.id);
  if (!row) return res.status(404).json({ error: 'Tenant not found.' });
  const result = await refreshTenant(row);
  res.json({ ...result, tenant: publicTenant(db.prepare('SELECT * FROM tenants WHERE id = ?').get(row.id)) });
});

router.post('/refresh-all', async (req, res) => {
  const rows = db.prepare('SELECT * FROM tenants WHERE enabled = 1').all();
  await Promise.allSettled(rows.map((t) => refreshTenant(t)));
  res.json({ tenants: db.prepare('SELECT * FROM tenants ORDER BY name').all().map(publicTenant) });
});

/** POST /test { url, apiKey, id? } — id fills blanks from the stored tenant. */
router.post('/test', async (req, res) => {
  const { url, apiKey, id } = req.body || {};
  let testUrl = String(url || '').trim().replace(/\/+$/, '');
  let testKey = apiKey ? String(apiKey) : null;
  if (id) {
    const row = db.prepare('SELECT * FROM tenants WHERE id = ?').get(id);
    if (row) {
      if (!testUrl) testUrl = row.url;
      if (!testKey && row.api_key_encrypted) testKey = decrypt(row.api_key_encrypted);
    }
  }
  if (!testUrl || !validUrl(testUrl)) return res.status(400).json({ error: 'A valid http(s) url is required.' });
  try {
    const summary = await fetchSummary(testUrl, testKey);
    res.json({
      ok: true,
      platforms: summary.platforms.length,
      objects: summary.totals?.objects ?? 0,
      generatedAt: summary.generatedAt,
    });
  } catch (err) {
    const status = err.response?.status;
    res.status(502).json({
      ok: false,
      error: status
        ? `Instance responded HTTP ${status}${status === 401 || status === 403 ? ' — check the API key' : ''}`
        : (err.message || 'unreachable'),
    });
  }
});

module.exports = router;
