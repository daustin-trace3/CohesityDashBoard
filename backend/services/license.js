const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const axios = require('axios');
const cron = require('node-cron');
const { getSetting, setSetting } = require('./settings');
const logger = require('../utils/logger');

/**
 * Product license validation.
 *
 * The operator puts LICENSE_KEY (CDBL-...) in .env. The key embeds
 * { id, customer, issued, expires } and is Ed25519-signed by the vendor.
 * Renewals never change the key: a signed extension certificate (CDBX-...,
 * same id, later expiry) is fetched from the vendor renewal endpoint (or
 * pasted manually for air-gapped installs) and cached in app_settings.
 * Effective expiry = max(key.exp, newest valid extension.exp).
 *
 * Enforcement: missing/invalid key blocks the app immediately; an expired
 * key gets a GRACE_DAYS banner window, then blocks.
 */

// Vendor public key — pairs with LicenseTools/keys/private.pem.
const VENDOR_PUBLIC_KEY_PEM = `-----BEGIN PUBLIC KEY-----
MCowBQYDK2VwAyEARbvY7nNulOeya+TaOP+ZVk7R4SFJ3uLkGeNeTT1opEw=
-----END PUBLIC KEY-----`;

const GRACE_DAYS = 14;
const RENEWAL_LOOKAHEAD_DAYS = 45;
const DEFAULT_RENEWAL_URL = 'http://localhost:4100';
const EXT_SETTING_KEY = 'license_extension_cert';

const publicKey = crypto.createPublicKey(VENDOR_PUBLIC_KEY_PEM);

/** Verify a CDBL/CDBX string; returns { type, payload } or null. */
function verifySigned(str) {
  const m = /^(CDBL|CDBX)-([A-Za-z0-9_-]+)\.([A-Za-z0-9_-]+)$/.exec(String(str || '').trim());
  if (!m) return null;
  try {
    if (!crypto.verify(null, Buffer.from(m[2]), publicKey, Buffer.from(m[3], 'base64url'))) return null;
    const payload = JSON.parse(Buffer.from(m[2], 'base64url').toString('utf8'));
    if (payload.v !== 1 || !payload.id || !payload.exp) return null;
    return { type: m[1], payload };
  } catch {
    return null;
  }
}

function daysBetween(fromMs, toMs) {
  return Math.floor((toMs - fromMs) / 86400000);
}

/** Full license status. Cheap enough to compute per request (Ed25519 verify is ~µs). */
function getLicenseStatus() {
  const keyStr = process.env.LICENSE_KEY || '';
  if (!keyStr.trim()) return { state: 'missing' };

  const key = verifySigned(keyStr);
  if (!key || key.type !== 'CDBL') return { state: 'invalid' };

  // Newest cached extension for this license id, if it verifies.
  let extExp = null;
  const ext = verifySigned(getSetting(EXT_SETTING_KEY) || '');
  if (ext && ext.type === 'CDBX' && ext.payload.id === key.payload.id) {
    extExp = ext.payload.exp;
  }

  const effectiveExpiry = extExp && extExp > key.payload.exp ? extExp : key.payload.exp;
  // Licenses run through the end of the expiry day.
  const expiryMs = new Date(effectiveExpiry + 'T23:59:59Z').getTime();
  const now = Date.now();
  const daysLeft = daysBetween(now, expiryMs);

  let state = 'valid';
  let graceDaysLeft = null;
  if (now > expiryMs) {
    const daysOver = daysBetween(expiryMs, now);
    if (daysOver < GRACE_DAYS) {
      state = 'grace';
      graceDaysLeft = GRACE_DAYS - daysOver;
    } else {
      state = 'blocked';
    }
  }
  return {
    state,
    licenseId: key.payload.id,
    customer: key.payload.c || null,
    issued: key.payload.iat || null,
    keyExpiry: key.payload.exp,
    effectiveExpiry,
    daysLeft: state === 'valid' ? daysLeft : 0,
    graceDaysLeft,
    renewedViaExtension: !!extExp && effectiveExpiry === extExp,
  };
}

/** Validate + store a pasted/downloaded extension cert. Returns new status or an error string. */
function applyExtension(certStr) {
  const status = getLicenseStatus();
  if (status.state === 'missing' || status.state === 'invalid') return { error: 'No valid license key configured — an extension cannot be applied.' };
  const ext = verifySigned(certStr);
  if (!ext || ext.type !== 'CDBX') return { error: 'Extension certificate is invalid (bad format or signature).' };
  if (ext.payload.id !== status.licenseId) return { error: 'Extension is for a different license id.' };
  if (ext.payload.exp <= status.effectiveExpiry) return { error: `Extension expiry ${ext.payload.exp} does not extend the current expiry ${status.effectiveExpiry}.` };
  setSetting(EXT_SETTING_KEY, String(certStr).trim());
  logger.info(`[License] Extension applied — new expiry ${ext.payload.exp}.`);
  return { status: getLicenseStatus() };
}

/**
 * Activate a key entered on the license page: verify the signature, persist
 * it to .env (so it survives restarts), and apply it to the running process
 * (so the app unlocks without a restart).
 */
const ENV_PATH = path.join(__dirname, '..', '..', '.env');

function activateKey(keyStr) {
  const trimmed = String(keyStr || '').trim();
  const key = verifySigned(trimmed);
  if (!key || key.type !== 'CDBL') return { error: 'That license key is invalid (bad format or signature). Check for copy/paste truncation.' };

  let env = '';
  try { env = fs.readFileSync(ENV_PATH, 'utf8'); } catch { /* create fresh below */ }
  const line = `LICENSE_KEY=${trimmed}`;
  if (/^LICENSE_KEY=.*$/m.test(env)) env = env.replace(/^LICENSE_KEY=.*$/m, line);
  else env += (env === '' || env.endsWith('\n') ? '' : '\n') + line + '\n';
  fs.writeFileSync(ENV_PATH, env);
  process.env.LICENSE_KEY = trimmed;
  logger.info(`[License] Key activated from the license page — "${key.payload.c}", expires ${key.payload.exp}.`);
  return { status: getLicenseStatus() };
}

/** Ask the vendor renewal endpoint for an extension. Quiet on network failure. */
async function checkRenewal({ force = false } = {}) {
  const status = getLicenseStatus();
  if (status.state === 'missing' || status.state === 'invalid') return { checked: false, reason: 'no valid key' };
  const nearExpiry = daysBetween(Date.now(), new Date(status.effectiveExpiry + 'T23:59:59Z').getTime()) <= RENEWAL_LOOKAHEAD_DAYS;
  if (!force && !nearExpiry) return { checked: false, reason: 'not near expiry' };

  const base = (process.env.LICENSE_RENEWAL_URL || DEFAULT_RENEWAL_URL).replace(/\/+$/, '');
  try {
    const { data } = await axios.get(`${base}/licenses/${status.licenseId}/extension`, { timeout: 15000, responseType: 'text' });
    const result = applyExtension(data);
    if (result.error) {
      // A same-or-older extension is normal (nothing new to renew yet).
      return { checked: true, renewed: false, reason: result.error };
    }
    return { checked: true, renewed: true, status: result.status };
  } catch (e) {
    const code = e.response?.status;
    return { checked: true, renewed: false, reason: code === 404 ? 'no renewal available yet (payment not recorded)' : `renewal server unreachable (${e.code || code || e.message})` };
  }
}

/** Startup + daily renewal polling. */
function initLicense() {
  const s = getLicenseStatus();
  if (s.state === 'missing') logger.error('[License] LICENSE_KEY is not set — the dashboard is locked until a license key is configured.');
  else if (s.state === 'invalid') logger.error('[License] LICENSE_KEY is invalid — the dashboard is locked.');
  else logger.info(`[License] ${s.customer} — ${s.state}, expires ${s.effectiveExpiry}${s.state === 'grace' ? ` (grace, ${s.graceDaysLeft}d left)` : ''}`);

  cron.schedule('30 3 * * *', () => {
    checkRenewal().then(r => { if (r.renewed) logger.info('[License] Renewed automatically via renewal server.'); });
  });
  checkRenewal().then(r => { if (r.renewed) logger.info('[License] Renewed automatically via renewal server.'); });
}

module.exports = { getLicenseStatus, applyExtension, activateKey, checkRenewal, initLicense };
