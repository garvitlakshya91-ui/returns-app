const { Router } = require('express');
const shopify = require('../config/shopify');
const prisma = require('../config/database');
const eventBus = require('../events/eventBus');
const { SHOP_INSTALLED } = require('../events/emitters');
const { registerWebhooks } = require('../services/shopInstall');
const { serializeSession } = require('../services/ShopToken');

const router = Router();

/**
 * GET /auth
 * Start the Shopify OAuth flow. Redirect merchant to Shopify's authorization page.
 */
router.get('/auth', async (req, res) => {
  const shop = req.query.shop;
  if (!shop) {
    return res.status(400).send('Missing shop parameter');
  }

  try {
    // shopify-api v13 writes the redirect to res itself when given
    // rawRequest/rawResponse — don't call res.redirect() afterwards.
    await shopify.auth.begin({
      shop,
      callbackPath: '/auth/callback',
      isOnline: false, // Offline access token for background jobs
      rawRequest: req,
      rawResponse: res,
    });
  } catch (err) {
    // An unparseable shop domain is a client error, not a server one.
    if (!res.headersSent) {
      const status = /shop|domain/i.test(err.message || '') ? 400 : 500;
      res.status(status).send(status === 400 ? 'Invalid shop parameter' : 'Could not start installation');
    }
  }
});

/**
 * GET /auth/callback
 * Shopify redirects here after merchant authorizes. Exchange code for access token.
 */
router.get('/auth/callback', async (req, res) => {
  try {
    const callback = await shopify.auth.callback({
      rawRequest: req,
      rawResponse: res,
    });

    const { session } = callback;
    const shopDomain = session.shop;
    const storedToken = serializeSession(session);

    // Fetch shop details via GraphQL
    const client = new shopify.clients.Graphql({ session });
    const shopDataResponse = await client.request(`
      query {
        shop {
          name
          email
          myshopifyDomain
        }
      }
    `);

    const shopData = shopDataResponse.data.shop;

    // Upsert the shop record with encrypted token
    const shop = await prisma.shop.upsert({
      where: { shopifyDomain: shopDomain },
      update: {
        shopifyToken: storedToken,
        name: shopData.name,
        email: shopData.email,
      },
      create: {
        shopifyDomain: shopDomain,
        shopifyToken: storedToken,
        name: shopData.name,
        email: shopData.email,
      },
    });

    // Register webhooks
    await registerWebhooks(session);

    // Emit install event
    eventBus.emit(SHOP_INSTALLED, { shopId: shop.id, shopDomain });

    // Redirect to embedded app in Shopify Admin
    const host = req.query.host;
    res.redirect(`/?shop=${shopDomain}&host=${host}`);
  } catch (err) {
    console.error('OAuth callback error:', err);
    res.status(500).send('Error completing OAuth. Please try installing again.');
  }
});

module.exports = router;
