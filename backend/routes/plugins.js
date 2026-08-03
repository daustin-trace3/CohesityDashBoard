// Installable signed plugins: list/install/enable/remove + frontend bundle
// serving (contract C9.3). Permissions are applied per-route here rather
// than as one blanket app.js guard, since /frontend-manifest is reachable to
// any authenticated user and /:id/bundle.js is gated by the plugin's own
// namespace, not admin:plugins:*.
const express = require('express');
const fs = require('fs');
const path = require('path');
const { requirePermission } = require('../middleware/requirePermission');
const registry = require('../core/registry');
const pluginBoot = require('../services/pluginBoot');
const { upload, installPlugin, BUILTIN_IDS } = require('../services/pluginInstaller');

const router = express.Router();

function installedIds() {
  const pluginsDir = pluginBoot.getPluginsDir();
  const ids = new Set();
  try {
    for (const d of fs.readdirSync(pluginsDir, { withFileTypes: true })) {
      if (d.isDirectory() && !d.name.endsWith('.staged')) ids.add(d.name);
    }
  } catch { /* plugins dir doesn't exist yet */ }
  return ids;
}

/** GET /api/plugins — built-ins + installed, merged with on-disk pending state. */
router.get('/', requirePermission('admin:plugins:view'), (req, res) => {
  const pluginsDir = pluginBoot.getPluginsDir();
  const installed = installedIds();

  const list = registry.listPlugins().map((entry) => {
    const isInstalled = installed.has(entry.id);
    let pendingAction = 'none';
    if (fs.existsSync(path.join(pluginsDir, `${entry.id}.remove`))) pendingAction = 'restart-remove';
    else if (fs.existsSync(path.join(pluginsDir, `${entry.id}.staged`))) pendingAction = 'restart-upgrade';

    return {
      id: entry.id,
      name: entry.name,
      version: entry.version,
      source: isInstalled ? 'installed' : 'builtin',
      status: entry.status,
      error: entry.error,
      enabled: entry.enabled,
      hasFrontend: isInstalled && fs.existsSync(path.join(pluginsDir, entry.id, 'frontend', 'bundle.js')),
      pendingAction,
      entitled: entry.entitled,
    };
  });

  res.json(list);
});

/** POST /api/plugins/install — multipart field 'plugin'. Fresh id hot-adds;
 *  an existing id stages an upgrade for the next restart. */
router.post('/install', requirePermission('admin:plugins:manage'), (req, res) => {
  upload.single('plugin')(req, res, async (uploadErr) => {
    if (uploadErr) return res.status(400).json({ error: uploadErr.message });
    if (!req.file) return res.status(400).json({ error: "no file uploaded (multipart field must be 'plugin')" });

    try {
      const result = await installPlugin(req.file.path);
      res.json(result);
    } catch (err) {
      res.status(err.status || 400).json({ error: err.message });
    } finally {
      fs.rm(req.file.path, { force: true }, () => {});
    }
  });
});

/** POST /api/plugins/:id/enabled — flips the platform_<id>_enabled setting
 *  and the registry state, starting/stopping the poller (mirrors
 *  routes/settings.js applyPlatformEnabled for pure/netapp). */
router.post('/:id/enabled', requirePermission('admin:plugins:manage'), (req, res) => {
  const { id } = req.params;
  if (!registry.getPlugin(id)) return res.status(404).json({ error: `plugin '${id}' is not registered` });

  const wantEnabled = !!(req.body && req.body.enabled);
  const { setSetting } = require('../services/settings');
  setSetting(`platform_${id}_enabled`, wantEnabled ? '1' : '0');

  const changed = registry.setEnabled(id, wantEnabled);
  if (changed) {
    const handle = registry.getPollerHandle(id);
    if (handle) {
      if (wantEnabled) {
        if (typeof handle.init === 'function') handle.init();
      } else if (typeof handle.stopAll === 'function') {
        handle.stopAll();
      }
    }
  }

  const entry = registry.getPlugin(id);
  if (wantEnabled && !changed) {
    return res.status(409).json({ error: `plugin '${id}' is not entitled`, ...entry });
  }
  res.json(entry);
});

/** DELETE /api/plugins/:id { purgeData? } — installed plugins only; writes a
 *  removal marker processed at next boot (contract C9.3). */
router.delete('/:id', requirePermission('admin:plugins:manage'), (req, res) => {
  const { id } = req.params;
  if (BUILTIN_IDS.has(id)) return res.status(400).json({ error: `plugin '${id}' is a built-in platform, not an installed plugin` });

  const pluginsDir = pluginBoot.getPluginsDir();
  const liveDir = path.join(pluginsDir, id);
  if (!fs.existsSync(liveDir)) return res.status(400).json({ error: `plugin '${id}' is not installed` });

  fs.mkdirSync(pluginsDir, { recursive: true });
  fs.writeFileSync(path.join(pluginsDir, `${id}.remove`), '');
  if (req.body && req.body.purgeData) {
    fs.writeFileSync(path.join(pluginsDir, `${id}.purge`), '');
  }

  res.json({ id, pendingAction: 'restart-remove' });
});

/** GET /api/plugins/:id/bundle.js — the plugin's own namespace gates this,
 *  same as its API routes. */
router.get('/:id/bundle.js', requirePermission((req) => `${req.params.id}:*:view`), (req, res) => {
  const bundlePath = path.join(pluginBoot.getPluginsDir(), req.params.id, 'frontend', 'bundle.js');
  if (!fs.existsSync(bundlePath)) return res.status(404).end();
  // no-cache: CDNs (Cloudflare) cache .js by extension regardless of the /api
  // path, which served stale plugin bundles after upgrades. ETag revalidation
  // still gives 304s; the loader also appends ?v=<version> to bust old copies.
  res.set('Cache-Control', 'no-cache');
  res.type('text/javascript').sendFile(bundlePath);
});

/** GET /api/plugins/frontend-manifest — any authenticated caller; used by the
 *  frontend loader to inject <script> tags for installed+enabled+entitled
 *  plugins with a bundle. */
router.get('/frontend-manifest', (req, res) => {
  const pluginsDir = pluginBoot.getPluginsDir();
  const out = [];
  for (const entry of registry.listPlugins()) {
    if (!entry.enabled || !entry.entitled) continue;
    if (!fs.existsSync(path.join(pluginsDir, entry.id, 'frontend', 'bundle.js'))) continue;
    out.push({ id: entry.id, hasFrontend: true, name: entry.name, color: entry.color, version: entry.version || null });
  }
  res.json(out);
});

module.exports = router;
