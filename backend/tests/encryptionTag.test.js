import { describe, it, expect } from 'vitest';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const { encrypt, decrypt } = require('../services/encryption');

describe('encryption', () => {
  it('round-trips and rejects a tampered or truncated authentication tag', () => {
    const blob = encrypt('s3cret-value');
    expect(decrypt(blob)).toBe('s3cret-value');
    const parsed = JSON.parse(blob);
    const truncated = JSON.stringify({ ...parsed, authTag: parsed.authTag.slice(0, 8) });
    expect(() => decrypt(truncated)).toThrow();
    const flipped = JSON.stringify({ ...parsed, authTag: (parsed.authTag[0] === '0' ? '1' : '0') + parsed.authTag.slice(1) });
    expect(() => decrypt(flipped)).toThrow();
  });
});
