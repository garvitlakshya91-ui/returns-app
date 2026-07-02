// Shop bootstrap for Shopify *managed installation*.
//
// With `use_legacy_install_flow = false` in shopify.app.toml, Shopify grants
// scopes at install time and loads the embedded app directly — the legacy
// /auth -> /auth/callback redirect never runs, so nothing creates our Shop
// row. Instead, the first authenticated API request performs a *token
// exchange*: the App Bridge session token (already signature-verified by the
// auth middleware) is exchanged for an offline access token, and the shop is
// provisioned here. See https://shopify.dev/docs/apps/build/authentication-authorization/access-tokens/token-exchange
const shopify = require('../config/shopify');
const { RequestedTokenType } = require('@shopify/shopify-api');
const prisma = require('../config/database');
const { encrypt } = require('../utils/encryption');
const eventBus = require('../events/eventBus');
const { SHOP_INSTALLED } = require('../events/emitters');
const logger = require('../utils/logger');

// The dashboard fires several API calls in parallel on first load; without
// dedup they would all race the same token exchange. One in-flight install
// per shop domain.
const inFlight = new Map();

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
      logger.info({ topic: webhook.topic }, 'Webhook registered');
    } catch (err) {
      logger.error({ err, topic: webhook.topic }, 'Failed to register webhook');
    }
  }
}

/**
 * Exchange a verified App Bridge session token for an offline access token,
 * upsert the Shop row, register webhooks and emit SHOP_INSTALLED.
 * Returns the Shop record.
 */
async function installShopFromTokenExchange(shopDomain, sessionToken) {
  if (inFlight.has(shopDomain)) return inFlight.get(shopDomain);

  const promise = (async () => {
    let exchanged;
    try {
      exchanged = await shopify.auth.tokenExchange({
        shop: shopDomain,
        sessionToken,
        requestedTokenType: RequestedTokenType.OfflineAccessToken,
      });
    } catch (err) {
      // Surface Shopify's response body — the status line alone ("403
      // Forbidden") doesn't say WHY the exchange was refused.
      logger.error({
        shopDomain,
        status: err.response?.code,
        body: err.response?.body,
        message: err.message,
      }, 'Token exchange refused by Shopify');
      throw err;
    }
    const { session } = exchanged;

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

    const shop = await prisma.shop.upsert({
      where: { shopifyDomain: shopDomain },
      update: {
        shopifyToken: encrypt(session.accessToken),
        name: shopData.name,
        email: shopData.email,
      },
      create: {
        shopifyDomain: shopDomain,
        shopifyToken: encrypt(session.accessToken),
        name: shopData.name,
        email: shopData.email,
      },
    });

    // Webhook registration must not block the merchant's first request; each
    // topic already tolerates its own failure.
    registerWebhooks(session).catch((err) =>
      logger.error({ err, shopDomain }, 'Webhook registration failed after token exchange'),
    );

    eventBus.emit(SHOP_INSTALLED, { shopId: shop.id, shopDomain });
    logger.info({ shopDomain, shopId: shop.id }, 'Shop provisioned via token exchange');
    return shop;
  })();

  inFlight.set(shopDomain, promise);
  try {
    return await promise;
  } finally {
    inFlight.delete(shopDomain);
  }
}

module.exports = { installShopFromTokenExchange, registerWebhooks };
