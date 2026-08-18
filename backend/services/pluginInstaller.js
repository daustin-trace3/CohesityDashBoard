// Handles a verified plugin zip: fresh-id hot-add, existing-id staged
// upgrade (contract C9.3).
const fs = require('fs');
const os = require('os');
const path = require('path');
const multer = require('multer');
const { verifyPluginZip } = require('./pluginVerify');
const { runMigrations } = require('../core/migrations');
const { getPluginsDir } = require('./pluginBoot');
const registry = require('../core/registry');
const { setSetting } = require('./settings');

// Plugin ids reserved for the built-in platform manifests — a zip claiming
// one of these is rejected before it ever touches disk.
// Formerly guarded pure/netapp when they were the only compiled-in platforms;
// the 2026-08 pluginization campaign converts every platform to an installable
// pack, so no id is reserved anymore. The mechanism stays for future use.
const BUILTIN_IDS = new Set([]);

const upload = multer({
  storage: multer.diskStorage({ destination: (req, file, cb) => cb(null, os.tmpdir()) }),
  limits: { fileSize: 50 * 1024 * 1024 },
});

function fail(message, status = 400) {
  const err = new Error(message);
  err.status = status;
  throw err;
}

function rmDir(dir) {
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* best-effort */ }
}

function writeFiles(dir, files) {
  for (const [relPath, buf] of Object.entries(files)) {
    const dest = path.join(dir, relPath);
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.writeFileSync(dest, buf);
  }
}

function requireFresh(absPath) {
  const resolved = require.resolve(absPath);
  delete require.cache[resolved];
  return require(resolved);
}

/**
 * @param {string} zipPath absolute path to the uploaded .iccplugin (already
 *   on disk, e.g. via multer disk storage)
 * @param {{db?: object}} [opts]
 */
async function installPlugin(zipPath, opts = {}) {
  const { manifest, files } = await verifyPluginZip(zipPath);
  const id = manifest.id;

  if (BUILTIN_IDS.has(id)) {
    fail(`plugin id '${id}' is reserved for a built-in platform`);
  }

  const pluginsDir = getPluginsDir();
  fs.mkdirSync(pluginsDir, { recursive: true });
  const liveDir = path.join(pluginsDir, id);

  if (fs.existsSync(liveDir)) {
    const stagedDir = path.join(pluginsDir, `${id}.staged`);
    rmDir(stagedDir);
    writeFiles(stagedDir, files);
    fs.writeFileSync(path.join(stagedDir, 'manifest.json'), JSON.stringify(manifest, null, 2));
    return { id, pendingAction: 'restart-upgrade', hotAdded: false };
  }

  writeFiles(liveDir, files);
  fs.writeFileSync(path.join(liveDir, 'manifest.json'), JSON.stringify(manifest, null, 2));

  let pluginModule;
  try {
    pluginModule = requireFresh(path.resolve(liveDir, 'backend', 'index.cjs'));
  } catch (err) {
    rmDir(liveDir);
    fail(`plugin '${id}' backend/index.cjs failed to load: ${err.message}`);
  }

  if (
    pluginModule.id !== manifest.id ||
    pluginModule.name !== manifest.name ||
    pluginModule.apiVersion !== manifest.apiVersion
  ) {
    rmDir(liveDir);
    fail(`plugin '${id}' backend/index.cjs does not match manifest.json`);
  }

  pluginModule.version = pluginModule.version || manifest.version;
  pluginModule.color = pluginModule.color || manifest.color;

  const db = opts.db || require('../db/database');
  try {
    runMigrations(db, id, pluginModule.migrations || []);
  } catch (err) {
    rmDir(liveDir);
    fail(`plugin '${id}' migrations failed: ${err.message}`);
  }

  registry.registerPlugin(pluginModule);

  setSetting(`platform_${id}_enabled`, '1');
  const entitled = registry.isEntitled(id);
  registry.setEnabled(id, entitled);
  if (entitled) {
    const handle = registry.getPollerHandle(id);
    if (handle && typeof handle.init === 'function') handle.init();
  }

  const entry = registry.getPlugin(id);
  return { id, status: entry ? entry.status : 'active', hotAdded: true };
}

module.exports = { upload, installPlugin, writeFiles, rmDir, BUILTIN_IDS };
