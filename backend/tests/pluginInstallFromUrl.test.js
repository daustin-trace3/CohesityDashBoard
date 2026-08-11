/**
 * WP3: POST /api/plugins/install-from-url — same install lifecycle as
 * pluginInstall.test.js but sourced from a URL instead of a multipart
 * upload. Follows that file's convention of real signed zips + real HTTP
 * rather than mocking axios/installPlugin, using a throwaway local HTTP
 * server (http.createServer) as the "marketplace" the route downloads from.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from 'vitest';
import { createRequire } from 'module';
import crypto from 'crypto';
import fs from 'fs';
import http from 'http';
import os from 'os';
import path from 'path';
import yazl from 'yazl';
import request from 'supertest';

const require = createRequire(import.meta.url);

const registry = require('../core/registry');
const pluginSigningConfig = require('../config/pluginSigning');
const { createApp } = require('../app');

const API_KEY = 'test-api-key';
const ORIGINAL_PUBLIC_KEY_PEM = pluginSigningConfig.publicKeyPem;

let pluginsDir;
let privateKey;
let app;
let server;
let serverUrl;
let serveBuffer = null;
let serveStatus = 200;

function sha256(buf) {
  return crypto.createHash('sha256').update(buf).digest('hex');
}

async function buildDemoZip({ id = 'demo', version = '0.1.0' } = {}) {
  const src = `
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

  const dest = path.join(os.tmpdir(), `icc-demo-plugin-url-${crypto.randomUUID()}.iccplugin`);
  const chunks = [];
  await new Promise((resolve, reject) => {
    zipfile.outputStream.on('data', (c) => chunks.push(c));
    zipfile.outputStream.pipe(fs.createWriteStream(dest)).on('close', resolve).on('error', reject);
    zipfile.end();
  });
  return { dest, buf: Buffer.concat(chunks) };
}

beforeAll(async () => {
  const { publicKey, privateKey: priv } = crypto.generateKeyPairSync('ed25519');
  privateKey = priv;
  pluginSigningConfig.publicKeyPem = publicKey.export({ type: 'spki', format: 'pem' });

  server = http.createServer((req, res) => {
    if (serveStatus !== 200) {
      res.writeHead(serveStatus);
      return res.end('not found');
    }
    res.writeHead(200, { 'Content-Type': 'application/octet-stream' });
    res.end(serveBuffer);
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const addr = server.address();
  serverUrl = `http://127.0.0.1:${addr.port}`;
});

afterAll(async () => {
  pluginSigningConfig.publicKeyPem = ORIGINAL_PUBLIC_KEY_PEM;
  await new Promise((resolve) => server.close(resolve));
});

beforeEach(() => {
  pluginsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'icc-plugins-url-test-'));
  process.env.ICC_PLUGINS_DIR = pluginsDir;

  registry._reset();
  registry.init();
  registry.setIsEntitledFn(() => true);

  app = createApp({ licenseGate: (req, res, next) => next() });
  serveStatus = 200;
  serveBuffer = null;
});

afterEach(() => {
  delete process.env.ICC_PLUGINS_DIR;
});

describe('POST /api/plugins/install-from-url', () => {
  it('rejects a non-string url', async () => {
    const res = await request(app)
      .post('/api/plugins/install-from-url')
      .set('x-api-key', API_KEY)
      .send({ url: 12345 });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/http\(s\)/);
  });

  it('rejects a non-http(s) scheme', async () => {
    const res = await request(app)
      .post('/api/plugins/install-from-url')
      .set('x-api-key', API_KEY)
      .send({ url: 'ftp://example.com/plugin.iccplugin' });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/http\(s\)/);
  });

  it('surfaces a download failure as an error status', async () => {
    serveStatus = 404;
    const res = await request(app)
      .post('/api/plugins/install-from-url')
      .set('x-api-key', API_KEY)
      .send({ url: `${serverUrl}/missing.iccplugin` });
    expect(res.status).toBeGreaterThanOrEqual(400);
    expect(res.body.error).toBeTypeOf('string');
  });

  it('downloads and installs a plugin from an arbitrary URL (no .iccplugin extension required)', async () => {
    const { buf } = await buildDemoZip();
    serveBuffer = buf;

    const authed = (method, url) => request(app)[method](url).set('x-api-key', API_KEY);

    const installRes = await authed('post', '/api/plugins/install-from-url').send({ url: `${serverUrl}/download` });
    expect(installRes.status).toBe(200);
    expect(installRes.body).toMatchObject({ id: 'demo', hotAdded: true });

    const pingRes = await authed('get', '/api/demo/ping');
    expect(pingRes.status).toBe(200);
    expect(pingRes.body).toEqual({ ok: true });

    // Temp download file must have been cleaned up.
    const leftovers = fs.readdirSync(os.tmpdir()).filter((f) => f.startsWith('icc-plugin-url-'));
    expect(leftovers).toEqual([]);
  });
});
