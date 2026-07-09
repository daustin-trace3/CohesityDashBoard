/**
 * WP10 (C9.3): end-to-end install lifecycle through the real HTTP routes —
 * hot-add, dispatch, listing, enable/disable, and remove-on-boot. The demo
 * plugin zip is built in-test with yazl and signed with a TEST Ed25519
 * keypair; the signing public key is swapped in-place on the shared
 * backend/config/pluginSigning.js module (the same seam pluginVerify.js
 * reads lazily), since installPlugin/verifyPluginZip never accept a test
 * key override in production call paths.
 *
 * Loaded via createRequire so app.js, core/registry.js, services/pluginBoot.js
 * and services/pluginInstaller.js all resolve to the SAME module instances
 * (see the equivalent note in tests/platformPlugins.test.js).
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { createRequire } from 'module';
import crypto from 'crypto';
import fs from 'fs';
import os from 'os';
import path from 'path';
import yazl from 'yazl';
import request from 'supertest';

const require = createRequire(import.meta.url);

const registry = require('../core/registry');
const pluginBoot = require('../services/pluginBoot');
const pluginSigningConfig = require('../config/pluginSigning');
const { createApp } = require('../app');

const API_KEY = 'test-api-key';
const ORIGINAL_PUBLIC_KEY_PEM = pluginSigningConfig.publicKeyPem;

let pluginsDir;
let privateKey;
let app;

function sha256(buf) {
  return crypto.createHash('sha256').update(buf).digest('hex');
}

async function buildDemoZip({ id = 'demo', version = '0.1.0', indexSrc } = {}) {
  const src = indexSrc || `
    module.exports = {
      id: ${JSON.stringify(id)},
      name: 'Demo Plugin',
      apiVersion: 1,
      migrations: [
        { version: 1, up(db) { db.exec('CREATE TABLE IF NOT EXISTS ${id}_items (id INTEGER PRIMARY KEY)'); } },
      ],
      statusTables: ['${id}_items'],
      createRouter(coreApi) {
        return function router(req, res, next) {
          if (req.method === 'GET' && req.path === '/ping') return res.json({ ok: true });
          return next ? next() : res.status(404).end();
        };
      },
    };
  `;
  const fileBuf = Buffer.from(src, 'utf8');
  const manifest = {
    formatVersion: 1,
    id,
    name: 'Demo Plugin',
    version,
    apiVersion: 1,
    color: '#336699',
    files: { 'backend/index.cjs': sha256(fileBuf) },
  };
  const manifestBuf = Buffer.from(JSON.stringify(manifest), 'utf8');
  const sig = crypto.sign(null, manifestBuf, privateKey).toString('base64url');

  const zipfile = new yazl.ZipFile();
  zipfile.addBuffer(manifestBuf, 'manifest.json');
  zipfile.addBuffer(Buffer.from(sig, 'utf8'), 'manifest.sig');
  zipfile.addBuffer(fileBuf, 'backend/index.cjs');

  const dest = path.join(os.tmpdir(), `icc-demo-plugin-${crypto.randomUUID()}.iccplugin`);
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
  pluginsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'icc-plugins-test-'));
  process.env.ICC_PLUGINS_DIR = pluginsDir;

  registry._reset();
  registry.init();
  registry.setIsEntitledFn(() => true);

  app = createApp({ licenseGate: (req, res, next) => next() });
});

afterAll(() => {
  delete process.env.ICC_PLUGINS_DIR;
});

describe('plugin install lifecycle', () => {
  it('installs a fresh signed plugin (hot-add), dispatches it, lists it, toggles enabled, then removes on boot', async () => {
    const zipPath = await buildDemoZip();
    const authed = (method, url) => request(app)[method](url).set('x-api-key', API_KEY);

    // POST /api/plugins/install -> hot-add
    const installRes = await authed('post', '/api/plugins/install').attach('plugin', zipPath, 'demo-0.1.0.iccplugin');
    expect(installRes.status).toBe(200);
    expect(installRes.body).toMatchObject({ id: 'demo', hotAdded: true });

    // GET /api/demo/ping -> dispatcher hot-serves it immediately
    const pingRes = await authed('get', '/api/demo/ping');
    expect(pingRes.status).toBe(200);
    expect(pingRes.body).toEqual({ ok: true });

    // GET /api/plugins -> shows it, installed, with version
    const listRes = await authed('get', '/api/plugins');
    expect(listRes.status).toBe(200);
    const demoEntry = listRes.body.find((p) => p.id === 'demo');
    expect(demoEntry).toMatchObject({ source: 'installed', version: '0.1.0', enabled: true, entitled: true });

    // POST /api/plugins/demo/enabled { enabled: false } -> dispatch now 404s
    const disableRes = await authed('post', '/api/plugins/demo/enabled').send({ enabled: false });
    expect(disableRes.status).toBe(200);
    const disabledPing = await authed('get', '/api/demo/ping');
    expect(disabledPing.status).toBe(404);
    expect(disabledPing.body).toEqual({ error: 'platform_disabled' });

    // POST /api/plugins/demo/enabled { enabled: true } -> back to 200
    const enableRes = await authed('post', '/api/plugins/demo/enabled').send({ enabled: true });
    expect(enableRes.status).toBe(200);
    const reenabledPing = await authed('get', '/api/demo/ping');
    expect(reenabledPing.status).toBe(200);

    // DELETE /api/plugins/demo -> restart-remove marker
    const deleteRes = await authed('delete', '/api/plugins/demo').send({ purgeData: true });
    expect(deleteRes.status).toBe(200);
    expect(deleteRes.body).toEqual({ id: 'demo', pendingAction: 'restart-remove' });
    expect(fs.existsSync(path.join(pluginsDir, 'demo.remove'))).toBe(true);
    expect(fs.existsSync(path.join(pluginsDir, 'demo.purge'))).toBe(true);

    // Simulate a restart: boot swap processes the removal, then a fresh scan
    // finds nothing left to register.
    pluginBoot.runBootSwap();
    registry._reset();
    registry.init();
    registry.setIsEntitledFn(() => true);
    pluginBoot.scanAndRegisterInstalled();

    expect(registry.getPlugin('demo')).toBeUndefined();
    expect(fs.existsSync(path.join(pluginsDir, 'demo'))).toBe(false);
  });

  it('installing an id that already exists stages an upgrade instead of hot-adding', async () => {
    const authed = (method, url) => request(app)[method](url).set('x-api-key', API_KEY);

    const firstZip = await buildDemoZip({ version: '0.1.0' });
    const firstRes = await authed('post', '/api/plugins/install').attach('plugin', firstZip, 'demo-0.1.0.iccplugin');
    expect(firstRes.body.hotAdded).toBe(true);

    const secondZip = await buildDemoZip({ version: '0.2.0' });
    const secondRes = await authed('post', '/api/plugins/install').attach('plugin', secondZip, 'demo-0.2.0.iccplugin');
    expect(secondRes.status).toBe(200);
    expect(secondRes.body).toEqual({ id: 'demo', pendingAction: 'restart-upgrade', hotAdded: false });

    // Live version is still 0.1.0 until the next boot swap.
    const listRes = await authed('get', '/api/plugins');
    const demoEntry = listRes.body.find((p) => p.id === 'demo');
    expect(demoEntry.version).toBe('0.1.0');
    expect(demoEntry.pendingAction).toBe('restart-upgrade');

    pluginBoot.runBootSwap();
    registry._reset();
    registry.init();
    registry.setIsEntitledFn(() => true);
    pluginBoot.scanAndRegisterInstalled();

    expect(registry.getPlugin('demo').version).toBe('0.2.0');
  });

  it('rejects an install claiming a built-in platform id', async () => {
    const zipPath = await buildDemoZip({ id: 'pure' });
    const res = await request(app).post('/api/plugins/install').set('x-api-key', API_KEY).attach('plugin', zipPath, 'pure-0.1.0.iccplugin');
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/built-in/);
  });

  it('a plugin that is not entitled is registered but stays disabled', async () => {
    registry.setIsEntitledFn((id) => id !== 'demo');
    const zipPath = await buildDemoZip();
    const res = await request(app).post('/api/plugins/install').set('x-api-key', API_KEY).attach('plugin', zipPath, 'demo-0.1.0.iccplugin');
    expect(res.status).toBe(200);
    expect(res.body.hotAdded).toBe(true);

    const listRes = await request(app).get('/api/plugins').set('x-api-key', API_KEY);
    const demoEntry = listRes.body.find((p) => p.id === 'demo');
    expect(demoEntry.entitled).toBe(false);
    expect(demoEntry.enabled).toBe(false);
  });
});
