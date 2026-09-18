/**
 * Security regressions for the plugin lifecycle: path-shaped ids, the boot
 * swap, the purge pattern, reserved ids, the install-from-url policy and
 * downgrade refusal. Real signed zips, same convention as pluginInstall.test.js.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from 'vitest';
import { createRequire } from 'module';
import crypto from 'crypto';
import fs from 'fs';
import os from 'os';
import path from 'path';
import yazl from 'yazl';
import request from 'supertest';
import Database from 'better-sqlite3';

const require = createRequire(import.meta.url);

const registry = require('../core/registry');
const pluginSigningConfig = require('../config/pluginSigning');
const pluginBoot = require('../services/pluginBoot');
const { installPlugin, compareVersions } = require('../services/pluginInstaller');
const { createApp } = require('../app');

const API_KEY = 'test-api-key';
const ORIGINAL_PUBLIC_KEY_PEM = pluginSigningConfig.publicKeyPem;

let root;
let pluginsDir;
let privateKey;
let app;

function sha256(buf) {
  return crypto.createHash('sha256').update(buf).digest('hex');
}

async function buildZip({ id = 'demo', version = '1.0.0' } = {}) {
  const src = [
    'module.exports = {',
    '  id: ' + JSON.stringify(id) + ',',
    "  name: 'Demo Plugin',",
    '  apiVersion: 1,',
    '  migrations: [],',
    '  createRouter() {',
    '    return function router(req, res, next) { return next ? next() : res.status(404).end(); };',
    '  },',
    '};',
  ].join('\n');
  const fileBuf = Buffer.from(src, 'utf8');
  const manifest = {
    formatVersion: 1, id, name: 'Demo Plugin', version, apiVersion: 1, color: '#336699',
    files: { 'backend/index.cjs': sha256(fileBuf) },
  };
  const manifestBuf = Buffer.from(JSON.stringify(manifest), 'utf8');
  const sig = crypto.sign(null, manifestBuf, privateKey).toString('base64url');
  const zipfile = new yazl.ZipFile();
  zipfile.addBuffer(manifestBuf, 'manifest.json');
  zipfile.addBuffer(Buffer.from(sig, 'utf8'), 'manifest.sig');
  zipfile.addBuffer(fileBuf, 'backend/index.cjs');
  const dest = path.join(os.tmpdir(), 'icc-hardening-' + crypto.randomUUID() + '.iccplugin');
  await new Promise((resolve, reject) => {
    zipfile.outputStream.pipe(fs.createWriteStream(dest)).on('close', resolve).on('error', reject);
    zipfile.end();
  });
  return dest;
}

beforeAll(() => {
  const { publicKey, privateKey: priv } = crypto.generateKeyPairSync('ed25519');
  privateKey = priv;
  pluginSigningConfig.publicKeyPem = publicKey.export({ type: 'spki', format: 'pem' });
});

afterAll(() => {
  pluginSigningConfig.publicKeyPem = ORIGINAL_PUBLIC_KEY_PEM;
});

beforeEach(() => {
  // The plugins dir sits one level down so a traversal to ".." has a sentinel to hit.
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'icc-hardening-'));
  pluginsDir = path.join(root, 'plugins');
  fs.mkdirSync(pluginsDir);
  fs.writeFileSync(path.join(root, 'sentinel.txt'), 'must survive');
  process.env.ICC_PLUGINS_DIR = pluginsDir;
  registry._reset();
  registry.init();
  registry.setIsEntitledFn(() => true);
  app = createApp({ licenseGate: (req, res, next) => next() });
});

afterEach(() => {
  delete process.env.ICC_PLUGINS_DIR;
  delete process.env.PLUGIN_INSTALL_ALLOW_HTTP;
  delete process.env.PLUGIN_INSTALL_ALLOWED_HOSTS;
  fs.rmSync(root, { recursive: true, force: true });
});

describe('path-shaped plugin ids', () => {
  it('refuses dot-segment and encoded ids on every :id route and writes no marker', async () => {
    for (const id of ['%2e%2e', '%2e', '..%2f..', 'a%2fb', 'UPPER', 'a_b']) {
      const del = await request(app).delete('/api/plugins/' + id).set('x-api-key', API_KEY).send({ purgeData: true });
      expect(del.status, 'DELETE ' + id).toBe(404);
      const en = await request(app).post('/api/plugins/' + id + '/enabled').set('x-api-key', API_KEY).send({ enabled: true });
      expect(en.status, 'POST enabled ' + id).toBe(404);
      const js = await request(app).get('/api/plugins/' + id + '/bundle.js').set('x-api-key', API_KEY);
      expect(js.status, 'GET bundle ' + id).toBe(404);
    }
    expect(fs.readdirSync(pluginsDir)).toEqual([]);
    expect(fs.readdirSync(root).sort()).toEqual(['plugins', 'sentinel.txt']);
  });

  it('boot swap drops a traversal marker without deleting anything outside the plugins dir', () => {
    fs.writeFileSync(path.join(pluginsDir, '...remove'), '');
    fs.writeFileSync(path.join(pluginsDir, '...purge'), '');
    fs.writeFileSync(path.join(pluginsDir, '..remove'), '');
    fs.mkdirSync(path.join(pluginsDir, 'keepme'));
    pluginBoot.runBootSwap({ db: new Database(':memory:') });
    expect(fs.existsSync(path.join(root, 'sentinel.txt'))).toBe(true);
    expect(fs.existsSync(pluginsDir)).toBe(true);
    expect(fs.existsSync(path.join(pluginsDir, 'keepme'))).toBe(true);
    expect(fs.existsSync(path.join(pluginsDir, '...remove'))).toBe(false);
  });

  it('boot swap still processes a well-formed removal', () => {
    fs.mkdirSync(path.join(pluginsDir, 'demo'));
    fs.writeFileSync(path.join(pluginsDir, 'demo.remove'), '');
    pluginBoot.runBootSwap({ db: new Database(':memory:') });
    expect(fs.existsSync(path.join(pluginsDir, 'demo'))).toBe(false);
    expect(fs.existsSync(path.join(pluginsDir, 'demo.remove'))).toBe(false);
  });
});

describe('purgeData', () => {
  it('drops only <id>_ tables, not tables of an id that merely shares the prefix', () => {
    const db = new Database(':memory:');
    db.exec([
      'CREATE TABLE aria_instances (id INTEGER);',
      'CREATE TABLE aria_deployments (id INTEGER);',
      'CREATE TABLE ariaops_instances (id INTEGER);',
      'CREATE TABLE ariaXops (id INTEGER);',
      'CREATE TABLE schema_migrations (scope TEXT, version INTEGER);',
      'CREATE TABLE plugins (id TEXT PRIMARY KEY);',
    ].join('\n'));
    fs.mkdirSync(path.join(pluginsDir, 'aria'));
    fs.writeFileSync(path.join(pluginsDir, 'aria.remove'), '');
    fs.writeFileSync(path.join(pluginsDir, 'aria.purge'), '');
    pluginBoot.runBootSwap({ db });
    const names = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name").all().map((r) => r.name);
    expect(names).toEqual(['ariaXops', 'ariaops_instances', 'plugins', 'schema_migrations']);
  });
});

describe('reserved ids', () => {
  it('rejects a signed pack that claims a core namespace', async () => {
    for (const id of ['admin', 'ops', 'service-status', 'app-services', 'directory']) {
      const zip = await buildZip({ id });
      await expect(installPlugin(zip)).rejects.toThrow(/reserved/);
      fs.rmSync(zip, { force: true });
      expect(fs.existsSync(path.join(pluginsDir, id))).toBe(false);
    }
  });
});

describe('downgrade refusal', () => {
  it('compares dotted versions numerically', () => {
    expect(compareVersions('1.0.10', '1.0.9')).toBe(1);
    expect(compareVersions('1.0.0', '1.0')).toBe(0);
    expect(compareVersions('0.9.9', '1.0.0')).toBe(-1);
  });

  it('stages a newer version, refuses an older one unless allowDowngrade is set', async () => {
    const v2 = await buildZip({ version: '1.2.0' });
    const v3 = await buildZip({ version: '1.3.0' });
    const v1 = await buildZip({ version: '1.1.9' });
    try {
      expect(await installPlugin(v2)).toMatchObject({ id: 'demo', hotAdded: true });
      expect(await installPlugin(v3)).toMatchObject({ pendingAction: 'restart-upgrade' });
      fs.rmSync(path.join(pluginsDir, 'demo.staged'), { recursive: true, force: true });
      await expect(installPlugin(v1)).rejects.toMatchObject({ status: 409 });
      expect(fs.existsSync(path.join(pluginsDir, 'demo.staged'))).toBe(false);
      expect(await installPlugin(v1, { allowDowngrade: true })).toMatchObject({ pendingAction: 'restart-upgrade' });
    } finally {
      for (const f of [v1, v2, v3]) fs.rmSync(f, { force: true });
    }
  });
});
