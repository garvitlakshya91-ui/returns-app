const { encrypt, decrypt } = require('../../app/utils/encryption');

describe('utils/encryption', () => {
  it('round-trips a plaintext string', () => {
    const plain = 'shpat_some_real_looking_token_1234567890';
    const cipher = encrypt(plain);
    expect(cipher).not.toBe(plain);
    expect(decrypt(cipher)).toBe(plain);
  });

  it('produces different ciphertexts for the same plaintext (random IV)', () => {
    const c1 = encrypt('hello');
    const c2 = encrypt('hello');
    expect(c1).not.toBe(c2);
    expect(decrypt(c1)).toBe('hello');
    expect(decrypt(c2)).toBe('hello');
  });

  it('produces ciphertext in iv:tag:ciphertext format with hex parts', () => {
    const cipher = encrypt('x');
    const parts = cipher.split(':');
    expect(parts).toHaveLength(3);
    expect(parts[0]).toMatch(/^[0-9a-f]{32}$/); // 16-byte IV → 32 hex
    expect(parts[1]).toMatch(/^[0-9a-f]{32}$/); // 16-byte auth tag → 32 hex
    expect(parts[2]).toMatch(/^[0-9a-f]+$/);
  });

  it('handles empty string', () => {
    expect(decrypt(encrypt(''))).toBe('');
  });

  it('handles UTF-8 multi-byte content', () => {
    const plain = 'héllo wörld — 你好 🌍';
    expect(decrypt(encrypt(plain))).toBe(plain);
  });

  it('throws on tampered ciphertext (auth tag check)', () => {
    const cipher = encrypt('important');
    const [iv, tag, ct] = cipher.split(':');
    const flipped = ct.slice(0, -2) + (ct.slice(-2) === '00' ? 'ff' : '00');
    expect(() => decrypt(`${iv}:${tag}:${flipped}`)).toThrow();
  });

  it('throws when ENCRYPTION_KEY is the wrong length', () => {
    const orig = process.env.ENCRYPTION_KEY;
    process.env.ENCRYPTION_KEY = 'short';
    expect(() => encrypt('x')).toThrow(/32-byte hex/);
    process.env.ENCRYPTION_KEY = orig;
  });
});
