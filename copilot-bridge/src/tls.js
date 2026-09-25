import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { config } from './config.js';

const TLS_DIR = path.join(config.dataDir, 'tls');
const PFX_PATH = path.join(TLS_DIR, 'bridge.pfx');
const META_PATH = path.join(TLS_DIR, 'meta.json');

// Non-internal, non-loopback IPv4 addresses of this host.
export function lanIPv4() {
  const out = [];
  for (const addrs of Object.values(os.networkInterfaces())) {
    for (const a of addrs || []) {
      if (a.family === 'IPv4' && !a.internal) out.push(a.address);
    }
  }
  return out;
}

// Returns TLS options for https.createServer: { pfx, passphrase } or { key, cert }.
export function ensureTls(sanList) {
  fs.mkdirSync(TLS_DIR, { recursive: true });

  // 1) Explicit PEM cert/key via env.
  if (config.tlsCertPath && config.tlsKeyPath) {
    return { cert: fs.readFileSync(config.tlsCertPath), key: fs.readFileSync(config.tlsKeyPath) };
  }
  // 2) Explicit PFX via env.
  if (config.tlsPfxPath) {
    return { pfx: fs.readFileSync(config.tlsPfxPath), passphrase: config.tlsPfxPass || undefined };
  }
  // 3) Previously generated self-signed PFX.
  if (fs.existsSync(PFX_PATH) && fs.existsSync(META_PATH)) {
    const meta = JSON.parse(fs.readFileSync(META_PATH, 'utf8'));
    return { pfx: fs.readFileSync(PFX_PATH), passphrase: meta.passphrase };
  }
  // 4) Generate a fresh self-signed PFX.
  const passphrase = crypto.randomBytes(24).toString('hex');
  generatePfx(sanList, passphrase);
  fs.writeFileSync(
    META_PATH,
    JSON.stringify({ passphrase, createdAt: new Date().toISOString(), san: sanList }, null, 2)
  );
  return { pfx: fs.readFileSync(PFX_PATH), passphrase };
}

function generatePfx(sanList, passphrase) {
  const script = path.join(config.rootDir, 'scripts', 'gen-cert.ps1');
  execFileSync(
    'powershell',
    ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', script,
      '-PfxPath', PFX_PATH, '-Password', passphrase, '-DnsNames', sanList.join(',')],
    { stdio: 'inherit' }
  );
}
