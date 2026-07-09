#!/usr/bin/env node
// Packs a built plugin (dist/) into a signed .iccplugin zip (contract C9.1).
// Usage: node pack.mjs [--dir <plugin-dir>]   (defaults to ./template)
//
// Signing key resolution: env ICC_PLUGIN_SIGNING_KEY (absolute or relative-
// to-cwd path) if set, else the default at
// ../../LicenseTools/keys/plugin-signing-private.pem relative to this file
// (plugin-sdk/ -> Dashboard/ -> CohesityDashBoard/LicenseTools/keys/...).
// NEVER commit the private key; it is not part of this repo.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ZipFile } from 'yazl';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_KEY_PATH = path.resolve(__dirname, '..', '..', 'LicenseTools', 'keys', 'plugin-signing-private.pem');

function parseArgs(argv) {
  const out = { dir: './template' };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--dir' && argv[i + 1]) {
      out.dir = argv[i + 1];
      i++;
    }
  }
  return out;
}

function sha256(buf) {
  return crypto.createHash('sha256').update(buf).digest('hex');
}

function resolveSigningKeyPath() {
  return process.env.ICC_PLUGIN_SIGNING_KEY
    ? path.resolve(process.env.ICC_PLUGIN_SIGNING_KEY)
    : DEFAULT_KEY_PATH;
}

async function main() {
  const { dir } = parseArgs(process.argv.slice(2));
  const pluginDir = path.resolve(__dirname, dir);
  const distDir = path.join(pluginDir, 'dist');
  const pluginJsonPath = path.join(pluginDir, 'plugin.json');

  if (!fs.existsSync(pluginJsonPath)) {
    throw new Error(`plugin.json not found: ${pluginJsonPath}`);
  }
  const { id, name, version, color } = JSON.parse(fs.readFileSync(pluginJsonPath, 'utf8'));
  if (!id || !name || !version) {
    throw new Error('plugin.json must define id, name, version');
  }

  const backendDistPath = path.join(distDir, 'backend', 'index.cjs');
  if (!fs.existsSync(backendDistPath)) {
    throw new Error(`missing ${backendDistPath} — run build.mjs first`);
  }
  const frontendDistPath = path.join(distDir, 'frontend', 'bundle.js');
  const hasFrontend = fs.existsSync(frontendDistPath);

  const files = {
    'backend/index.cjs': sha256(fs.readFileSync(backendDistPath)),
  };
  if (hasFrontend) {
    files['frontend/bundle.js'] = sha256(fs.readFileSync(frontendDistPath));
  }

  const manifest = {
    formatVersion: 1,
    id,
    name,
    version,
    apiVersion: 1,
    color: color || undefined,
    files,
  };
  const manifestBytes = Buffer.from(JSON.stringify(manifest, null, 2), 'utf8');

  const keyPath = resolveSigningKeyPath();
  if (!fs.existsSync(keyPath)) {
    throw new Error(`signing key not found at ${keyPath} (set ICC_PLUGIN_SIGNING_KEY to override)`);
  }
  const privateKey = fs.readFileSync(keyPath);
  const signature = crypto.sign(null, manifestBytes, privateKey);
  const signatureB64Url = signature.toString('base64url');

  const outPath = path.join(pluginDir, `${id}-${version}.iccplugin`);
  const zipFile = new ZipFile();
  zipFile.addBuffer(manifestBytes, 'manifest.json');
  zipFile.addBuffer(Buffer.from(signatureB64Url, 'utf8'), 'manifest.sig');
  zipFile.addFile(backendDistPath, 'backend/index.cjs');
  if (hasFrontend) {
    zipFile.addFile(frontendDistPath, 'frontend/bundle.js');
  }

  await new Promise((resolve, reject) => {
    const outStream = fs.createWriteStream(outPath);
    zipFile.outputStream.pipe(outStream).on('close', resolve).on('error', reject);
    zipFile.end();
  });

  console.log(`[pack] signing key: ${keyPath}`);
  console.log(`[pack] wrote ${outPath}`);
  console.log(`[pack] manifest.json sha256s:`);
  for (const [name_, hash] of Object.entries(files)) {
    console.log(`  ${name_}: ${hash}`);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
