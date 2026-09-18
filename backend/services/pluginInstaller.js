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

/** -1 / 0 / 1 for dotted numeric versions; non-numeric parts compare as 0. */
function compareVersions(a, b) {
  const pa = String(a || '').split('.').map((n) => parseInt(n, 10) || 0);
  const pb = String(b || '').split('.').map((n) => parseInt(n, 10) || 0);
  for (let i = 0; i < Math.max(pa.length, pb.length); i += 1) {
    const d = (pa[i] || 0) - (pb[i] || 0);
    if (d !== 0) return d < 0 ? -1 : 1;
  }
  return 0;
}

function installedVersion(liveDir) {
  try {
    return JSON.parse(fs.readFileSync(path.join(liveDir, 'manifest.json'), 'utf8')).version || null;
  } catch {
    return null;
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
    // Every old pack stays validly signed forever, so without this check an
    // admin session (or a stolen one) could roll a platform back to a build
    // with a known hole. Downgrades need an explicit flag.
    const current = installedVersion(liveDir);
    if (current && compareVersions(manifest.version, current) < 0 && !opts.allowDowngrade) {
      fail(`plugin '${id}' ${manifest.version} is older than the installed ${current}; pass allowDowngrade to install it anyway`, 409);
    }
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

  // A built-in platform with the same id is already registered in this
  // process, so the pack cannot hot-add over it (registerPlugin would throw
  // "already registered" with the files half-installed). pluginBoot swaps the
  // built-in for the installed pack at the next boot, so keep the verified
  // files in place and report a pending restart, like a same-id upgrade.
  if (registry.getPlugin(id)) {
    return { id, pendingAction: 'restart-upgrade', hotAdded: false, replacesBuiltin: true };
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

module.exports = { upload, installPlugin, writeFiles, rmDir, BUILTIN_IDS, compareVersions };
