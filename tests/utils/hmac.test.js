const crypto = require('crypto');
const { verifyWebhookHmac } = require('../../app/utils/hmac');

function makeHmac(body, secret = process.env.SHOPIFY_API_SECRET) {
  return crypto.createHmac('sha256', secret).update(body, 'utf8').digest('base64');
}

describe('utils/hmac', () => {
  const body = JSON.stringify({ order_id: 1042, customer: { email: 'jane@example.com' } });

  it('returns true for a correctly signed body', () => {
    const sig = makeHmac(body);
    expect(verifyWebhookHmac(body, sig)).toBe(true);
  });

  it('returns false for a tampered body', () => {
    const sig = makeHmac(body);
    const tampered = body.replace('1042', '9999');
    expect(verifyWebhookHmac(tampered, sig)).toBe(false);
  });

  it('throws on signature length mismatch (different secret)', () => {
    // A truncated base64 sig will throw on timingSafeEqual buffer length check.
    expect(() => verifyWebhookHmac(body, 'too-short')).toThrow();
  });

  it('returns false for the wrong signature of correct length', () => {
    const sig = makeHmac(body);
    const wrong = Buffer.alloc(sig.length, 'A').toString();
    expect(verifyWebhookHmac(body, wrong)).toBe(false);
  });

  it('throws when SHOPIFY_API_SECRET is unset', () => {
    const orig = process.env.SHOPIFY_API_SECRET;
    delete process.env.SHOPIFY_API_SECRET;
    expect(() => verifyWebhookHmac(body, 'anything')).toThrow(/not configured/);
    process.env.SHOPIFY_API_SECRET = orig;
  });
});
