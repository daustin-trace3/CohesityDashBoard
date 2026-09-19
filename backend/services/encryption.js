const crypto = require('crypto');

const ALGORITHM = 'aes-256-gcm';
const KEY_LENGTH = 32;

function getKey() {
  const hexKey = process.env.ENCRYPTION_KEY;
  if (!hexKey || hexKey.length !== 64) {
    throw new Error('ENCRYPTION_KEY must be a 64-character hex string (32 bytes)');
  }
  return Buffer.from(hexKey, 'hex');
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

  // GCM accepts truncated tags unless told otherwise; a 4 byte tag can be
  // forged with about 2^32 tries. Only the full 16 byte tag is accepted.
  const tag = Buffer.from(authTag, 'hex');
  if (tag.length !== 16) throw new Error('Invalid ciphertext: bad authentication tag length');
  const decipher = crypto.createDecipheriv(
    ALGORITHM,
    key,
    Buffer.from(iv, 'hex'),
    { authTagLength: 16 }
  );
  decipher.setAuthTag(tag);

  const decrypted = Buffer.concat([
    decipher.update(Buffer.from(ciphertext, 'hex')),
    decipher.final()
  ]);

  return decrypted.toString('utf8');
}

module.exports = { encrypt, decrypt, getKey };
