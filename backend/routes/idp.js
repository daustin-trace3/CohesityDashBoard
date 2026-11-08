// Identity provider admin API, mounted at /api/idp behind the admin:users gate
// (same gate as /api/directory: attaching a provider is an access change).
// Group linking, user import and sync live in routes/idpSync.js.
const express = require('express');
const logger = require('../utils/logger');
const idpProviders = require('../services/idpProviders');
const idpOidc = require('../services/idpOidc');

const router = express.Router();

function saml() {
  return require('../services/idpSaml');
}

function sendError(res, err, next) {
  if (err && err.status) return res.status(err.status).json({ error: err.error || err.message, field: err.field });
  return next(err);
}

function audit(req, action, row) {
  const actor = req.auth && req.auth.user && req.auth.user.username;
  logger.info(`[idp] ${action} provider=${row.slug} type=${row.type} by=${actor || 'unknown'}`);
}

router.get('/providers', (req, res, next) => {
  try { res.json(idpProviders.listProviders(req)); } catch (err) { next(err); }
});

router.post('/providers', (req, res, next) => {
  try {
    const row = idpProviders.createProvider(req.body || {});
    audit(req, 'idp.created', row);
    res.status(201).json(idpProviders.toPublic(row, req));
  } catch (err) { sendError(res, err, next); }
});

router.post('/providers/import-metadata', async (req, res, next) => {
  try {
    const { url, xml } = req.body || {};
    let text = xml ? String(xml) : '';
    if (!text && url) {
      let u;
      try { u = new URL(String(url)); } catch { return res.status(400).json({ error: 'The metadata URL is not valid.', field: 'url' }); }
      const local = u.protocol === 'http:' && (u.hostname === '127.0.0.1' || u.hostname === 'localhost');
      if (u.protocol !== 'https:' && !local) return res.status(400).json({ error: 'The metadata URL must start with https://.', field: 'url' });
      let r;
      try {
        r = await idpOidc.http({ method: 'GET', url: u.toString(), headers: { Accept: 'application/samlmetadata+xml, application/xml, text/xml' }, timeout: 10000 });
      } catch (err) {
        return res.status(502).json({ error: `Could not fetch the metadata: ${err.message}`, field: 'url' });
      }
      if (r.status !== 200) return res.status(502).json({ error: `The metadata URL answered HTTP ${r.status}.`, field: 'url' });
      text = typeof r.data === 'string' ? r.data : String(r.data || '');
    }
    if (!text) return res.status(400).json({ error: 'Give a metadata url or xml.' });
    res.json(saml().importMetadata(text));
  } catch (err) { sendError(res, err, next); }
});

router.get('/providers/:id(\\d+)', (req, res) => {
  const row = idpProviders.getProvider(req.params.id);
  if (!row) return res.status(404).json({ error: 'Provider not found.' });
  res.json(idpProviders.toPublic(row, req));
});

router.put('/providers/:id(\\d+)', (req, res, next) => {
  try {
    const row = idpProviders.updateProvider(req.params.id, req.body || {});
    audit(req, 'idp.updated', row);
    res.json(idpProviders.toPublic(row, req));
  } catch (err) { sendError(res, err, next); }
});

router.delete('/providers/:id(\\d+)', (req, res, next) => {
  try {
    const row = idpProviders.getProvider(req.params.id);
    if (!row) return res.status(404).json({ error: 'Provider not found.' });
    idpProviders.deleteProvider(row.id);
    audit(req, 'idp.deleted', row);
    res.json({ ok: true });
  } catch (err) { sendError(res, err, next); }
});

router.post('/providers/:id(\\d+)/test', async (req, res, next) => {
  try {
    const row = idpProviders.getProvider(req.params.id);
    if (!row) return res.status(404).json({ error: 'Provider not found.' });
    let report;
    try {
      report = row.type === 'oidc' ? await idpOidc.testProvider(row) : await saml().testProvider(row, idpOidc.http);
    } catch (err) {
      report = { ok: false, checks: [{ name: 'Test', ok: false, detail: err.message }] };
    }
    const failed = report.checks.filter((c) => !c.ok).map((c) => `${c.name}: ${c.detail}`).join('; ');
    idpProviders.markTested(row.id, report.ok, failed);
    res.status(report.ok ? 200 : 502).json(report);
  } catch (err) { sendError(res, err, next); }
});

module.exports = router;
