// Verifies a .iccplugin zip (contract C9.1): Ed25519 signature over
// manifest.json, per-file sha256 against manifest.files, and strict path
// safety before anything is extracted to disk.
const crypto = require('crypto');
const fs = require('fs');
const yauzl = require('yauzl');
const pluginSigning = require('../config/pluginSigning');
const { RESERVED_IDS } = require('../core/registry');

const MAX_ZIP_BYTES = 50 * 1024 * 1024;
const MAX_FILE_BYTES = 20 * 1024 * 1024;
const MAX_ENTRIES = 200;
const ID_PATTERN = /^[a-z0-9-]+$/;
const ALLOWED_PREFIXES = ['backend/', 'frontend/'];

function fail(message) {
  const err = new Error(message);
  err.status = 400;
  throw err;
}

function isSafeRelativePath(name) {
  if (!name || typeof name !== 'string') return false;
  if (name.startsWith('/') || name.startsWith('\\')) return false;
  if (/^[a-zA-Z]:/.test(name)) return false; // windows absolute
  if (name.includes('\\')) return false;
  const segments = name.split('/');
  if (segments.some((seg) => seg === '..' || seg === '.' || seg === '')) return false;
  return ALLOWED_PREFIXES.some((p) => name.startsWith(p));
}

function openZip(zipPath) {
  return new Promise((resolve, reject) => {
    yauzl.open(zipPath, { lazyEntries: true, autoClose: false }, (err, zipfile) => {
      if (err) return reject(err);
      resolve(zipfile);
    });
  });
}

function readEntryBuffer(zipfile, entry) {
  return new Promise((resolve, reject) => {
    zipfile.openReadStream(entry, (err, stream) => {
      if (err) return reject(err);
      const chunks = [];
      let total = 0;
      stream.on('data', (chunk) => {
        total += chunk.length;
        if (total > MAX_FILE_BYTES) {
          stream.destroy();
          reject(Object.assign(new Error(`zip entry '${entry.fileName}' exceeds the ${MAX_FILE_BYTES} byte per-file cap`), { status: 400 }));
          return;
        }
        chunks.push(chunk);
      });
      stream.on('end', () => resolve(Buffer.concat(chunks)));
      stream.on('error', reject);
    });
  });
}

/** Lists every entry in the zip (no decompression), enforcing the entry-count
 *  cap as it goes. Directory entries (trailing '/') are skipped. */
function listEntries(zipfile) {
  return new Promise((resolve, reject) => {
    const entries = new Map();
    let count = 0;
    let settled = false;

    const settle = (fn, arg) => {
      if (settled) return;
      settled = true;
      fn(arg);
    };

    zipfile.on('entry', (entry) => {
      if (entry.fileName.endsWith('/')) {
        zipfile.readEntry();
        return;
      }
      count += 1;
      if (count > MAX_ENTRIES) {
        settle(reject, Object.assign(new Error(`zip has more than ${MAX_ENTRIES} entries`), { status: 400 }));
        return;
      }
      if (entry.uncompressedSize > MAX_FILE_BYTES) {
        settle(reject, Object.assign(new Error(`zip entry '${entry.fileName}' exceeds the ${MAX_FILE_BYTES} byte per-file cap`), { status: 400 }));
        return;
      }
      entries.set(entry.fileName, entry);
      zipfile.readEntry();
    });
    zipfile.on('end', () => settle(resolve, entries));
    zipfile.on('error', (err) => settle(reject, err));
    zipfile.readEntry();
  });
}

/**
 * @param {string} zipPath absolute path to a .iccplugin file already on disk
 * @param {{publicKeyPem?: string}} [opts] test override for the signing key
 * @returns {Promise<{manifest: object, files: Record<string, Buffer>}>}
 */
async function verifyPluginZip(zipPath, opts = {}) {
  const stat = fs.statSync(zipPath);
  if (stat.size > MAX_ZIP_BYTES) fail(`plugin package exceeds the ${MAX_ZIP_BYTES} byte cap`);

  const zipfile = await openZip(zipPath);
  try {
    const entries = await listEntries(zipfile);

    const manifestEntry = entries.get('manifest.json');
    const sigEntry = entries.get('manifest.sig');
    if (!manifestEntry || !sigEntry) fail('plugin package is unsigned (missing manifest.json or manifest.sig)');

    const manifestBuf = await readEntryBuffer(zipfile, manifestEntry);
    const sigBuf = await readEntryBuffer(zipfile, sigEntry);

    const publicKeyPem = (opts && opts.publicKeyPem) || pluginSigning.publicKeyPem;
    const publicKey = crypto.createPublicKey(publicKeyPem);
    let sigOk = false;
    try {
      const sig = Buffer.from(sigBuf.toString('utf8').trim(), 'base64url');
      sigOk = crypto.verify(null, manifestBuf, publicKey, sig);
    } catch {
      sigOk = false;
    }
    if (!sigOk) fail('plugin package signature verification failed');

    let manifest;
    try {
      manifest = JSON.parse(manifestBuf.toString('utf8'));
    } catch {
      fail('manifest.json is not valid JSON');
    }

    if (manifest.formatVersion !== 1) fail(`unsupported manifest formatVersion: ${manifest.formatVersion}`);
    if (typeof manifest.id !== 'string' || !ID_PATTERN.test(manifest.id)) fail(`invalid plugin id: ${String(manifest.id)}`);
    if (RESERVED_IDS.has(manifest.id)) fail(`plugin id '${manifest.id}' is reserved`);
    if (!manifest.name) fail('manifest.name is required');
    if (manifest.apiVersion !== 1) fail(`unsupported manifest apiVersion: ${manifest.apiVersion}`);
    if (typeof manifest.version !== 'string' || !manifest.version) fail('manifest.version is required');
    if (!manifest.files || typeof manifest.files !== 'object') fail('manifest.files is required');

    const declaredPaths = Object.keys(manifest.files);
    const files = {};

    for (const [fileName, entry] of entries) {
      if (fileName === 'manifest.json' || fileName === 'manifest.sig') continue;
      if (!isSafeRelativePath(fileName)) fail(`unsafe path in plugin package: ${fileName}`);
      if (!Object.prototype.hasOwnProperty.call(manifest.files, fileName)) {
        fail(`plugin package contains an unlisted file: ${fileName}`);
      }
      const buf = await readEntryBuffer(zipfile, entry);
      const sha256 = crypto.createHash('sha256').update(buf).digest('hex');
      if (sha256 !== manifest.files[fileName]) fail(`sha256 mismatch for ${fileName} (tampered or corrupt package)`);
      files[fileName] = buf;
    }

    for (const declared of declaredPaths) {
      if (!Object.prototype.hasOwnProperty.call(files, declared)) {
        fail(`manifest.files lists '${declared}' but it is missing from the package`);
      }
    }

    return { manifest, files };
  } finally {
    try { zipfile.close(); } catch { /* already closed */ }
  }
}

module.exports = { verifyPluginZip, MAX_ZIP_BYTES, MAX_FILE_BYTES, MAX_ENTRIES };
