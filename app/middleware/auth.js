const shopify = require('../config/shopify');
const prisma = require('../config/database');

/**
 * Middleware to verify Shopify session token for embedded app requests.
 * Attaches session and shop data to req.
 */
async function verifyShopifySession(req, res, next) {
  try {
    const authHeader = req.headers.authorization;
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      return res.status(401).json({ error: 'Missing authorization header' });
    }

    const token = authHeader.replace('Bearer ', '');

    // Verify the session token (JWT issued by Shopify App Bridge)
    const payload = await shopify.session.decodeSessionToken(token);
    const shopDomain = payload.dest.replace('https://', '');

    // Look up the shop in our database
    const shop = await prisma.shop.findUnique({
      where: { shopifyDomain: shopDomain },
    });

    if (!shop) {
      return res.status(401).json({ error: 'Shop not found. Please reinstall the app.' });
    }

    req.shopId = shop.id;
    req.shopDomain = shopDomain;
    req.shop = shop;

    next();
  } catch (err) {
    console.error('Auth middleware error:', err.message);
    return res.status(401).json({ error: 'Invalid session token' });
  }
}

module.exports = { verifyShopifySession };
