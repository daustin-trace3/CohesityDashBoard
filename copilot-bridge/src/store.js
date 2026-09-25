import fs from 'node:fs';
import path from 'node:path';
import { config, ensureDataDir } from './config.js';

// Read a JSON file (relative to the data dir), returning `fallback` on any error.
export function readJson(file, fallback) {
  try {
    const full = path.join(config.dataDir, file);
    if (!fs.existsSync(full)) return fallback;
    return JSON.parse(fs.readFileSync(full, 'utf8'));
  } catch {
    return fallback;
  }
}

// Atomically write a JSON file (relative to the data dir).
export function writeJson(file, data) {
  ensureDataDir();
  const full = path.join(config.dataDir, file);
  fs.mkdirSync(path.dirname(full), { recursive: true });
  const tmp = `${full}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2));
  fs.renameSync(tmp, full);
}
