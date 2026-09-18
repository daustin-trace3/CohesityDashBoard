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

const { assertSafeHost } = require('../utils/hostGuard');
const { getSetting } = require('../services/settings');

const router = express.Router();

const MAX_DOWNLOAD_BYTES = 100 * 1024 * 1024;
const DOWNLOAD_DEADLINE_MS = 120000;
const ID_PATTERN = /^[a-z0-9-]+$/;
const DEFAULT_PLUGIN_HOSTS = ['marketplace.austihome.com'];

/** Every :id route builds a filesystem path from the id, so anything that is
 *  not a plain plugin id ("..", ".", encoded separators) is refused before
 *  the handler runs. */
function requireValidId(req, res, next) {
  if (!ID_PATTERN.test(String(req.params.id || ''))) {
    return res.status(404).json({ error: 'unknown plugin' });
  }
  next();
}

/** Hosts install-from-url may download from: the marketplace plus the
 *  comma-separated plugin_install_allowed_hosts setting or
 *  PLUGIN_INSTALL_ALLOWED_HOSTS env var. "*" allows any host. */
function allowedPluginHosts() {
  const extra = `${getSetting('plugin_install_allowed_hosts') || ''},${process.env.PLUGIN_INSTALL_ALLOWED_HOSTS || ''}`;
  return DEFAULT_PLUGIN_HOSTS.concat(extra.split(',').map((h) => h.trim().toLowerCase()).filter(Boolean));
}

/** Validates one hop of a plugin download. https only (http is accepted only
 *  when PLUGIN_INSTALL_ALLOW_HTTP=1, which the test suite sets), host on the
 *  allowlist, and never a loopback, link-local or metadata address. */
async function assertDownloadUrl(rawUrl) {
  const fail = (msg) => Object.assign(new Error(msg), { status: 400 });
  let u;
  try { u = new URL(rawUrl); } catch { throw fail('url is not valid'); }
  const insecureOk = process.env.PLUGIN_INSTALL_ALLOW_HTTP === '1';
  if (u.protocol !== 'https:' && !(insecureOk && u.protocol === 'http:')) throw fail('url must be https');
  if (u.username || u.password) throw fail('url must not carry credentials');
  const hosts = allowedPluginHosts();
  if (!hosts.includes('*') && !hosts.includes(u.hostname.toLowerCase())) {
    throw fail(`host '${u.hostname}' is not an allowed plugin source`);
  }
  if (!insecureOk) await assertSafeHost(u.hostname);
  return u;
}

/** Streams `url` to a temp file, enforcing a 100MB cap and a 60s timeout.
 *  Trusts the marketplace's signature verification (installPlugin) rather
 *  than the URL shape, so no `.iccplugin` extension is required here. */
async function downloadToTemp(url) {
  const dest = path.join(os.tmpdir(), `icc-plugin-url-${crypto.randomUUID()}.iccplugin`);
  // Redirects are followed by hand so every hop is re-validated, and one
  // deadline covers the whole transfer (axios' timeout stops once headers
  // arrive, so a slow-drip body would otherwise never end).
  const controller = new AbortController();
  const deadline = setTimeout(() => controller.abort(), DOWNLOAD_DEADLINE_MS);
  let response;
  try {
    let current = (await assertDownloadUrl(url)).toString();
    for (let hop = 0; ; hop += 1) {
      response = await axios.get(current, {
        responseType: 'stream',
        timeout: 60000,
        maxRedirects: 0,
        signal: controller.signal,
        validateStatus: (s) => (s >= 200 && s < 300) || (s >= 300 && s < 400),
      });
      if (response.status < 300) break;
      response.data.destroy();
      const location = response.headers.location;
      if (!location || hop >= 3) throw Object.assign(new Error('too many redirects'), { status: 400 });
      current = (await assertDownloadUrl(new URL(location, current).toString())).toString();
    }
  } catch (err) {
    clearTimeout(deadline);
    throw err;
  }

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
  }).finally(() => clearTimeout(deadline));

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
      const allowDowngrade = String((req.body && req.body.allowDowngrade) || req.query.allowDowngrade || '') === 'true';
      const result = await installPlugin(req.file.path, { allowDowngrade });
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
    const result = await installPlugin(tmpPath, { allowDowngrade: req.body.allowDowngrade === true });
    res.json(result);
  } catch (err) {
    if (err.isAxiosError || err.name === 'CanceledError' || err.name === 'AbortError') {
      // One generic message: the axios text differs by failure type (refused,
      // timeout, TLS, DNS) and would let a caller map hosts and ports.
      return res.status(502).json({ error: 'failed to download plugin from that URL' });
    }
    res.status(err.status || 400).json({ error: err.message });
  } finally {
    if (tmpPath) fs.rm(tmpPath, { force: true }, () => {});
  }
});

/** POST /api/plugins/:id/enabled — flips the platform_<id>_enabled setting
 *  and the registry state, starting/stopping the poller (mirrors
 *  routes/settings.js applyPlatformEnabled for pure/netapp). */
router.post('/:id/enabled', requirePermission('admin:plugins:manage'), requireValidId, (req, res) => {
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
router.delete('/:id', requirePermission('admin:plugins:manage'), requireValidId, (req, res) => {
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
router.get('/:id/bundle.js', requireValidId, requirePermission((req) => `${req.params.id}:*:view`), (req, res) => {
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
