/**
 * WP10 (C9.1): pluginVerify.verifyPluginZip — signature, sha256, path-safety,
 * and cap enforcement. Every zip here is built in-test with yazl and signed
 * with a TEST Ed25519 keypair passed via the `publicKeyPem` override, which
 * exists precisely so production code never needs to know about test keys.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { createRequire } from 'module';
import crypto from 'crypto';
import fs from 'fs';
import os from 'os';
import path from 'path';
import yazl from 'yazl';

const require = createRequire(import.meta.url);
const { verifyPluginZip, MAX_ENTRIES } = require('../services/pluginVerify.js');

let publicKeyPem;
let privateKey;

beforeAll(() => {
  const { publicKey, privateKey: priv } = crypto.generateKeyPairSync('ed25519');
  privateKey = priv;
  publicKeyPem = publicKey.export({ type: 'spki', format: 'pem' });
});

function sha256(buf) {
  return crypto.createHash('sha256').update(buf).digest('hex');
}

function sign(buf) {
  return crypto.sign(null, buf, privateKey).toString('base64url');
}

/**
 * @param {object} opts
 * @param {object} [opts.manifestOverrides] merged onto the default manifest
 * @param {Record<string, Buffer|string>} [opts.files] extra zip entries, keyed by zip path
 * @param {boolean} [opts.skipSig] omit manifest.sig entirely
 * @param {boolean} [opts.badSig] write a syntactically valid but wrong signature
 * @param {boolean} [opts.tamperAfterSign] flip a byte in a file after hashing (breaks sha256, not sig)
 */
async function buildZip(opts = {}) {
  const files = opts.files || { 'backend/index.cjs': 'module.exports = { ok: true };' };
  const fileBufs = {};
  const fileHashes = {};
  for (const [name, content] of Object.entries(files)) {
    const buf = Buffer.isBuffer(content) ? content : Buffer.from(content);
    fileBufs[name] = buf;
    fileHashes[name] = sha256(buf);
  }

  const manifest = {
    formatVersion: 1,
    id: 'demo',
    name: 'Demo Plugin',
    version: '0.1.0',
    apiVersion: 1,
    files: fileHashes,
    ...(opts.manifestOverrides || {}),
  };

  const manifestBuf = Buffer.from(JSON.stringify(manifest), 'utf8');
  const sig = opts.badSig ? sign(Buffer.from('not the manifest')) : sign(manifestBuf);

  const zipfile = new yazl.ZipFile();
  zipfile.addBuffer(manifestBuf, 'manifest.json');
  if (!opts.skipSig) zipfile.addBuffer(Buffer.from(sig, 'utf8'), 'manifest.sig');

  for (const [name, buf] of Object.entries(fileBufs)) {
    const payload = opts.tamperAfterSign === name ? Buffer.concat([buf, Buffer.from('x')]) : buf;
    // yazl itself rejects ".."/absolute metadataPaths at addBuffer() time —
    // real attackers wouldn't build their zip with yazl, so to exercise our
    // OWN path-safety check on a traversal name we add under a safe
    // placeholder and rewrite the raw entry's file name afterward.
    if (/^\.\.\//.test(name) || /^\//.test(name)) {
      zipfile.addBuffer(payload, `backend/__placeholder_${zipfile.entries.length}__.txt`);
      zipfile.entries[zipfile.entries.length - 1].utf8FileName = Buffer.from(name, 'utf8');
    } else {
      zipfile.addBuffer(payload, name);
    }
  }

  const dest = path.join(os.tmpdir(), `icc-plugin-test-${crypto.randomUUID()}.iccplugin`);
  await new Promise((resolve, reject) => {
    zipfile.outputStream.pipe(fs.createWriteStream(dest)).on('close', resolve).on('error', reject);
    zipfile.end();
  });
  return dest;
}

describe('verifyPluginZip', () => {
  it('accepts a validly signed zip and returns the manifest + file buffers', async () => {
    const zipPath = await buildZip();
    const { manifest, files } = await verifyPluginZip(zipPath, { publicKeyPem });
    expect(manifest.id).toBe('demo');
    expect(files['backend/index.cjs'].toString()).toBe('module.exports = { ok: true };');
  });

  it('rejects a tampered file (sha256 mismatch)', async () => {
    const zipPath = await buildZip({ tamperAfterSign: 'backend/index.cjs' });
    await expect(verifyPluginZip(zipPath, { publicKeyPem })).rejects.toThrow(/sha256 mismatch/);
  });

  it('rejects a bad signature', async () => {
    const zipPath = await buildZip({ badSig: true });
    await expect(verifyPluginZip(zipPath, { publicKeyPem })).rejects.toThrow(/signature/);
  });

  it('rejects an unsigned package (missing manifest.sig)', async () => {
    const zipPath = await buildZip({ skipSig: true });
    await expect(verifyPluginZip(zipPath, { publicKeyPem })).rejects.toThrow(/unsigned/);
  });

  it('rejects a path-traversal / prefix-escape entry', async () => {
    // yauzl itself already rejects ".." entries while parsing the zip's
    // central directory (defense in depth) — our own isSafeRelativePath
    // check in pluginVerify.js is what catches prefix-escape names that
    // aren't literal ".." (see the next test), but either way the package
    // must be rejected.
    const zipPath = await buildZip({
      files: {
        'backend/index.cjs': 'module.exports = {};',
        '../../etc/evil.txt': 'nope',
      },
    });
    await expect(verifyPluginZip(zipPath, { publicKeyPem })).rejects.toThrow(/unsafe path|unlisted|relative path|absolute path/);
  });

  it('rejects an entry outside the backend/ and frontend/ prefixes', async () => {
    const zipPath = await buildZip({
      files: {
        'backend/index.cjs': 'module.exports = {};',
        'README.md': 'hello',
      },
    });
    await expect(verifyPluginZip(zipPath, { publicKeyPem })).rejects.toThrow(/unsafe path/);
  });

  it('rejects a package over the entry-count cap', async () => {
    const files = {};
    for (let i = 0; i < MAX_ENTRIES; i++) {
      files[`backend/file${i}.txt`] = `content-${i}`;
    }
    const zipPath = await buildZip({ files });
    await expect(verifyPluginZip(zipPath, { publicKeyPem })).rejects.toThrow(/entries/);
  });

  it('rejects a reserved plugin id', async () => {
    const zipPath = await buildZip({ manifestOverrides: { id: 'settings' } });
    await expect(verifyPluginZip(zipPath, { publicKeyPem })).rejects.toThrow(/reserved/);
  });
});
