import crypto from 'node:crypto';
import { readJson, writeJson } from './store.js';

const FILE = 'apikey.json';

export function getApiKey() {
  const data = readJson(FILE, null);
  return data?.key || null;
}

export function regenerateApiKey() {
  const key = 'sk-bridge-' + crypto.randomBytes(24).toString('hex');
  writeJson(FILE, { key, createdAt: new Date().toISOString() });
  return key;
}

export function ensureApiKey() {
  return getApiKey() || regenerateApiKey();
}

// Constant-time comparison to avoid leaking the key via timing.
export function verifyApiKey(candidate) {
  const key = getApiKey();
  if (!key || !candidate) return false;
  const a = Buffer.from(key);
  const b = Buffer.from(candidate);
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}
