const { Router } = require('express');
const shopify = require('../config/shopify');
const prisma = require('../config/database');
const { encrypt } = require('../utils/encryption');
const eventBus = require('../events/eventBus');
const { SHOP_INSTALLED } = require('../events/emitters');

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

  // Generate the auth URL and redirect
  const authUrl = await shopify.auth.begin({
    shop,
    callbackPath: '/auth/callback',
    isOnline: false, // Offline access token for background jobs
  });

  res.redirect(authUrl);
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
    const accessToken = session.accessToken;

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
        shopifyToken: encrypt(accessToken),
        name: shopData.name,
        email: shopData.email,
      },
      create: {
        shopifyDomain: shopDomain,
        shopifyToken: encrypt(accessToken),
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

/**
 * Register mandatory webhooks with Shopify via GraphQL.
 */
async function registerWebhooks(session) {
  const client = new shopify.clients.Graphql({ session });

  const webhooks = [
    { topic: 'ORDERS_CREATE', path: '/webhooks/orders/create' },
    { topic: 'ORDERS_FULFILLED', path: '/webhooks/orders/fulfilled' },
    { topic: 'APP_UNINSTALLED', path: '/webhooks/app/uninstalled' },
    { topic: 'SHOP_UPDATE', path: '/webhooks/shop/update' },
  ];

  for (const webhook of webhooks) {
    try {
      await client.request(`
        mutation webhookSubscriptionCreate($topic: WebhookSubscriptionTopic!, $webhookSubscription: WebhookSubscriptionInput!) {
          webhookSubscriptionCreate(topic: $topic, webhookSubscription: $webhookSubscription) {
            webhookSubscription {
              id
            }
            userErrors {
              field
              message
            }
          }
        }
      `, {
        variables: {
          topic: webhook.topic,
          webhookSubscription: {
            callbackUrl: `${process.env.HOST}${webhook.path}`,
            format: 'JSON',
          },
        },
      });
      console.log(`Webhook registered: ${webhook.topic}`);
    } catch (err) {
      console.error(`Failed to register webhook ${webhook.topic}:`, err.message);
    }
  }
}

module.exports = router;
