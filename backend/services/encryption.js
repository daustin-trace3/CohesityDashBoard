const crypto = require('crypto');

const ALGORITHM = 'aes-256-gcm';
const KEY_LENGTH = 32;

// One key per tenant (docs/MULTI-TENANT-DESIGN.md, decision 4): the default
// tenant keeps the install's master key, so credentials saved before
// multi-tenancy still decrypt; every other tenant gets a key derived from
// the master key and its id, so a tenant database copied into another
// tenant's slot cannot be decrypted. A seeding or worker process names its
// tenant with ICC_TENANT.
const derived = new Map();
function getKey() {
  const hexKey = process.env.ENCRYPTION_KEY;
  if (!hexKey || hexKey.length !== 64) {
    throw new Error('ENCRYPTION_KEY must be a 64-character hex string (32 bytes)');
  }
  const master = Buffer.from(hexKey, 'hex');
  const tenantId = process.env.ICC_TENANT || require('../core/tenantScoped').resolveTenantId();
  if (tenantId === 'default') return master;
  let key = derived.get(tenantId);
  if (!key) {
    key = Buffer.from(crypto.hkdfSync('sha256', master, 'icc-tenant-key', tenantId, KEY_LENGTH));
    derived.set(tenantId, key);
  }
  return key;
}

/**
 * Encrypts plaintext using AES-256-GCM.
 * Returns a JSON string containing iv, authTag, and ciphertext (all hex-encoded).
 */
function encrypt(plaintext) {
  const key = getKey();
  const iv = crypto.randomBytes(12); // 96-bit IV for GCM
  const cipher = crypto.createCipheriv(ALGORITHM, key, iv);

  const encrypted = Buffer.concat([
    cipher.update(plaintext, 'utf8'),
    cipher.final()
  ]);

  const authTag = cipher.getAuthTag();

  return JSON.stringify({
    iv: iv.toString('hex'),
    authTag: authTag.toString('hex'),
    ciphertext: encrypted.toString('hex')
  });
}

/**
 * Decrypts a JSON string produced by encrypt().
 * Returns the original plaintext string.
 */
function decrypt(encryptedJson) {
  const key = getKey();
  const { iv, authTag, ciphertext } = JSON.parse(encryptedJson);

  const decipher = crypto.createDecipheriv(
    ALGORITHM,
    key,
    Buffer.from(iv, 'hex')
  );
  decipher.setAuthTag(Buffer.from(authTag, 'hex'));

  const decrypted = Buffer.concat([
    decipher.update(Buffer.from(ciphertext, 'hex')),
    decipher.final()
  ]);

  return decrypted.toString('utf8');
}

module.exports = { encrypt, decrypt, getKey };
