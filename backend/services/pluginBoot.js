// Installed-plugin boot lifecycle (contract C9.3): swaps in staged upgrades /
// processes removals BEFORE any plugin is require()'d, then scans the
// plugins dir and registers whatever is left with the registry.
const fs = require('fs');
const path = require('path');

const ID_PATTERN = /^[a-z0-9-]+$/;

function getPluginsDir() {
  return process.env.ICC_PLUGINS_DIR || path.join(__dirname, '..', 'plugins');
}

function rmDir(dir) {
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* best-effort */ }
}

function rmFile(file) {
  try { fs.rmSync(file, { force: true }); } catch { /* best-effort */ }
}

/** Drops a purged plugin's tables (LIKE '<id>_%'), its schema_migrations
 *  rows, and its plugins-table row. Never throws — a purge failure should
 *  not block boot. */
function purgePluginData(db, id) {
  try {
    // "_" is a single-character wildcard in LIKE: unescaped, purging 'aria'
    // also matched every ariaops_* table and 'pure' every pure1_* table.
    // Plugin ids are [a-z0-9-] so only the separator needs escaping.
    const rows = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name LIKE ? ESCAPE '!'")
      .all(`${id.replace(/[!%_]/g, '!$&')}!_%`);
    const run = db.transaction(() => {
      for (const row of rows) {
        db.prepare(`DROP TABLE IF EXISTS "${row.name}"`).run();
      }
      db.prepare('DELETE FROM schema_migrations WHERE scope = ?').run(id);
      db.prepare('DELETE FROM plugins WHERE id = ?').run(id);
    });
    run();
  } catch (err) {
    const logger = require('../utils/logger');
    logger.error(`[pluginBoot] purge of plugin '${id}' data failed:`, err.message);
  }
}

/** Processes plugins/<id>.remove (+ optional <id>.purge) and plugins/<id>.staged
 *  markers left by the installer/uninstaller, in that order — removals
 *  first, then staged upgrades — before any plugin backend is require()'d. */
function runBootSwap({ db } = {}) {
  const pluginsDir = getPluginsDir();
  if (!fs.existsSync(pluginsDir)) return;

  const entries = fs.readdirSync(pluginsDir);

  for (const entry of entries) {
    if (!entry.endsWith('.remove')) continue;
    const id = entry.slice(0, -'.remove'.length);
    // The id becomes a path that is deleted recursively. A marker named
    // "...remove" yields id ".." and would delete the parent of the plugins
    // dir, so anything that is not a plain plugin id is dropped untouched.
    if (!ID_PATTERN.test(id)) {
      rmFile(path.join(pluginsDir, entry));
      continue;
    }
    const purgeMarker = path.join(pluginsDir, `${id}.purge`);
    const purge = fs.existsSync(purgeMarker);

    if (purge) {
      const database = db || require('../db/database');
      purgePluginData(database, id);
    }

    rmDir(path.join(pluginsDir, id));
    rmDir(path.join(pluginsDir, `${id}.staged`));
    rmFile(path.join(pluginsDir, entry));
    rmFile(purgeMarker);
  }

  const remaining = fs.readdirSync(pluginsDir);
  for (const entry of remaining) {
    if (!entry.endsWith('.staged')) continue;
    const id = entry.slice(0, -'.staged'.length);
    if (!ID_PATTERN.test(id)) continue;
    rmDir(path.join(pluginsDir, id));
    fs.renameSync(path.join(pluginsDir, entry), path.join(pluginsDir, id));
  }
}

/** Scans plugins/<id>/backend/index.cjs, require()s + registers each with
 *  the registry, and applies enabled = app_settings flag AND entitled.
 *  A single bad plugin never blocks the others or the boot sequence. */
function scanAndRegisterInstalled({ registry, settings } = {}) {
  const reg = registry || require('../core/registry');
  const settingsSvc = settings || require('../services/settings');
  const logger = require('../utils/logger');
  const pluginsDir = getPluginsDir();
  if (!fs.existsSync(pluginsDir)) return;

  const ids = fs.readdirSync(pluginsDir, { withFileTypes: true })
    .filter((d) => d.isDirectory() && !d.name.endsWith('.staged'))
    .map((d) => d.name);

  for (const id of ids) {
    const indexPath = path.join(pluginsDir, id, 'backend', 'index.cjs');
    if (!fs.existsSync(indexPath)) continue;

    let pluginModule;
    try {
      const resolved = require.resolve(path.resolve(indexPath));
      delete require.cache[resolved];
      pluginModule = require(resolved);
    } catch (err) {
      logger.error(`[pluginBoot] plugin '${id}' failed to load backend/index.cjs:`, err.message);
      continue;
    }

    try {
      const manifestPath = path.join(pluginsDir, id, 'manifest.json');
      const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
      pluginModule.version = pluginModule.version || manifest.version;
      pluginModule.color = pluginModule.color || manifest.color;
    } catch { /* cosmetic only — version/color simply won't show */ }

    // An installed pack shadows a same-id built-in platform module: the
    // built-in registered first, so drop it and let the pack take the id.
    // Without this the pack's backend was rejected ('already registered')
    // while its frontend bundle still served, leaving the built-in routes
    // and a null version behind the plugin's pages.
    if (reg.getPlugin(id) && typeof reg.unregisterPlugin === 'function') {
      reg.unregisterPlugin(id);
      logger.info(`[pluginBoot] installed plugin '${id}' ${pluginModule.version || ''} replaces the built-in module`.trim());
    }

    try {
      reg.registerPlugin(pluginModule);
    } catch (err) {
      logger.error(`[pluginBoot] plugin '${id}' failed to register:`, err.message);
      continue;
    }

    const enabledSetting = settingsSvc.getSetting(`platform_${id}_enabled`) === '1';
    const entitled = reg.isEntitled(id);
    reg.setEnabled(id, enabledSetting && entitled);
  }
}

module.exports = { getPluginsDir, runBootSwap, scanAndRegisterInstalled, purgePluginData };
