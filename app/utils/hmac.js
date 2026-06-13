const crypto = require('crypto');

/**
 * Verify Shopify webhook HMAC signature.
 * Shopify sends the HMAC in the X-Shopify-Hmac-Sha256 header.
 * The body must be the raw request body (Buffer).
 */
function verifyWebhookHmac(rawBody, hmacHeader) {
  const secret = process.env.SHOPIFY_API_SECRET;
  if (!secret) throw new Error('SHOPIFY_API_SECRET not configured');

  const computed = crypto
    .createHmac('sha256', secret)
    .update(rawBody, 'utf8')
    .digest('base64');

  return crypto.timingSafeEqual(
    Buffer.from(computed),
    Buffer.from(hmacHeader)
  );
}

module.exports = { verifyWebhookHmac };
