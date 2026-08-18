// Installable signed plugins: list/install/enable/remove + frontend bundle
// serving (contract C9.3). Permissions are applied per-route here rather
// than as one blanket app.js guard, since /frontend-manifest is reachable to
// any authenticated user and /:id/bundle.js is gated by the plugin's own
// namespace, not admin:plugins:*.
const express = require('express');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const axios = require('axios');
const { requirePermission } = require('../middleware/requirePermission');
const registry = require('../core/registry');
const pluginBoot = require('../services/pluginBoot');
const { upload, installPlugin, BUILTIN_IDS } = require('../services/pluginInstaller');

const router = express.Router();

const MAX_DOWNLOAD_BYTES = 100 * 1024 * 1024;

/** Streams `url` to a temp file, enforcing a 100MB cap and a 60s timeout.
 *  Trusts the marketplace's signature verification (installPlugin) rather
 *  than the URL shape, so no `.iccplugin` extension is required here. */
async function downloadToTemp(url) {
  const dest = path.join(os.tmpdir(), `icc-plugin-url-${crypto.randomUUID()}.iccplugin`);
  const response = await axios.get(url, {
    responseType: 'stream',
    timeout: 60000,
    maxRedirects: 5,
  });

  const declaredLength = Number(response.headers['content-length']);
  if (declaredLength && declaredLength > MAX_DOWNLOAD_BYTES) {
    response.data.destroy();
    const err = new Error('download exceeds 100MB limit');
    err.status = 400;
    throw err;
  }

  await new Promise((resolve, reject) => {
    let total = 0;
    let settled = false;
    const writeStream = fs.createWriteStream(dest);

    response.data.on('data', (chunk) => {
      total += chunk.length;
      if (total > MAX_DOWNLOAD_BYTES && !settled) {
        settled = true;
        response.data.destroy();
        writeStream.destroy();
        reject(Object.assign(new Error('download exceeds 100MB limit'), { status: 400 }));
      }
    });
    response.data.on('error', (err) => { if (!settled) { settled = true; reject(err); } });
    writeStream.on('error', (err) => { if (!settled) { settled = true; reject(err); } });
    writeStream.on('finish', () => { if (!settled) { settled = true; resolve(); } });
    response.data.pipe(writeStream);
  });

  return dest;
}

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

/** Cohesity is semi-core (not a registry plugin) but its enable flag works
 *  the same way — surface it as a synthetic built-in row so the merged
 *  Platforms page covers every platform. */
function cohesityRow() {
  const { getSetting } = require('../services/settings');
  return {
    id: 'cohesity',
    name: 'Cohesity',
    version: null,
    source: 'builtin',
    status: 'active',
    error: null,
    enabled: String(getSetting('platform_cohesity_enabled') ?? '1') !== '0',
    hasFrontend: false,
    pendingAction: 'none',
    entitled: true,
  };
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

  // WP0: the synthetic cohesityRow() is only injected while cohesity isn't a
  // real registry plugin row — a real installed cohesity row wins once one
  // exists (mirrors the frontend-manifest-wins philosophy). Today registry
  // never has id 'cohesity', so this is byte-identical to before.
  const hasCohesityPlugin = list.some((e) => e.id === 'cohesity');
  const syntheticCohesity = !hasCohesityPlugin && registry.isBuiltinPresent('cohesity');
  res.json([...(syntheticCohesity ? [cohesityRow()] : []), ...list]);
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

/** POST /api/plugins/install-from-url { url } — downloads an .iccplugin from
 *  a marketplace (or any http(s) host) and installs it, same success shape
 *  as /install. Extension-agnostic: trust is the Ed25519 signature check
 *  inside installPlugin, not the URL. */
router.post('/install-from-url', requirePermission('admin:plugins:manage'), async (req, res) => {
  const url = req.body && req.body.url;
  if (typeof url !== 'string' || !/^https?:\/\//i.test(url)) {
    return res.status(400).json({ error: 'url must be an http(s) URL' });
  }

  let tmpPath;
  try {
    tmpPath = await downloadToTemp(url);
    const result = await installPlugin(tmpPath);
    res.json(result);
  } catch (err) {
    if (err.isAxiosError) {
      return res.status(502).json({ error: `failed to download plugin: ${err.message}` });
    }
    res.status(err.status || 400).json({ error: err.message });
  } finally {
    if (tmpPath) fs.rm(tmpPath, { force: true }, () => {});
  }
});

/** POST /api/plugins/:id/enabled — flips the platform_<id>_enabled setting
 *  and the registry state, starting/stopping the poller (mirrors
 *  routes/settings.js applyPlatformEnabled for pure/netapp). */
router.post('/:id/enabled', requirePermission('admin:plugins:manage'), (req, res) => {
  const { id } = req.params;
  // WP0: the semi-core cohesity branch only applies while cohesity isn't a
  // real registry plugin — once one is registered, it flows through the
  // normal registry-managed branch below like any other plugin.
  if (id === 'cohesity' && !registry.getPlugin('cohesity') && registry.isBuiltinPresent('cohesity')) {
    // Semi-core: only the setting exists (nav/API gating); no registry entry
    // or registry-managed poller to flip.
    const wantEnabled = !!(req.body && req.body.enabled);
    const { setSetting } = require('../services/settings');
    setSetting('platform_cohesity_enabled', wantEnabled ? '1' : '0');
    return res.json({ ...cohesityRow(), enabled: wantEnabled });
  }
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
