const crypto = require('crypto');

const ALGORITHM = 'aes-256-gcm';

function getKey() {
  const hexKey = process.env.ENCRYPTION_KEY;
  if (!hexKey || hexKey.length !== 64) {
    throw new Error('ENCRYPTION_KEY must be a 64-character hex string (32 bytes)');
  }
  return Buffer.from(hexKey, 'hex');
}

function encrypt(plaintext) {
  const key = getKey();
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv(ALGORITHM, key, iv);
  const encrypted = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const authTag = cipher.getAuthTag();
  return JSON.stringify({
    iv: iv.toString('hex'),
    authTag: authTag.toString('hex'),
    ciphertext: encrypted.toString('hex'),
  });
}

function decrypt(encryptedJson) {
  const key = getKey();
  const { iv, authTag, ciphertext } = JSON.parse(encryptedJson);
  const decipher = crypto.createDecipheriv(ALGORITHM, key, Buffer.from(iv, 'hex'));
  decipher.setAuthTag(Buffer.from(authTag, 'hex'));
  const decrypted = Buffer.concat([decipher.update(Buffer.from(ciphertext, 'hex')), decipher.final()]);
  return decrypted.toString('utf8');
}

module.exports = { encrypt, decrypt };
