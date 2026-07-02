const shopify = require('../config/shopify');
const prisma = require('../config/database');
const { installShopFromTokenExchange } = require('../services/shopInstall');
const { needsReauth } = require('../services/ShopToken');

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
    let shop = await prisma.shop.findUnique({
      where: { shopifyDomain: shopDomain },
    });

    // Shopify managed installation grants scopes without ever hitting the
    // legacy /auth/callback, so a freshly installed shop has no row yet —
    // and a *re*installed shop has a row whose token was cleared by the
    // app/uninstalled webhook (or an expiring token whose 90-day refresh
    // token lapsed). The session token is already signature-verified
    // above — exchange it for a fresh offline token and provision the
    // shop on the fly.
    if (!shop || needsReauth(shop)) {
      try {
        shop = await installShopFromTokenExchange(shopDomain, token);
      } catch (err) {
        console.error('Token exchange bootstrap failed:', err.message);
        return res.status(401).json({ error: 'Shop not found. Please reinstall the app.' });
      }
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
