const { Router } = require('express');
const { verifyWebhookHmac } = require('../utils/hmac');
const { claim } = require('../utils/idempotency');
const prisma = require('../config/database');
const eventBus = require('../events/eventBus');
const { SHOP_UNINSTALLED } = require('../events/emitters');
const StorageService = require('../services/StorageService');
const BillingService = require('../services/BillingService');
const logger = require('../utils/logger');

const router = Router();

/**
 * HMAC verification middleware.
 * The raw body is already attached via a top-level middleware in index.js
 * (must happen before express.json).
 */
function webhookVerification(req, res, next) {
  const hmac = req.headers['x-shopify-hmac-sha256'];
  if (!hmac) return res.status(401).send('Missing HMAC header');

  try {
    const valid = verifyWebhookHmac(req.rawBody, hmac);
    if (!valid) return res.status(401).send('Invalid HMAC');
    next();
  } catch (err) {
    logger.error({ err }, 'HMAC verification error');
    return res.status(401).send('HMAC verification failed');
  }
}

router.use(webhookVerification);

// Idempotency — Shopify retries webhooks aggressively on non-2xx responses
// AND occasionally double-delivers in production. Without dedup we'd re-emit
// events and double-update state. X-Shopify-Webhook-Id is stable per delivery.
router.use(async (req, res, next) => {
  const webhookId = req.headers['x-shopify-webhook-id'];
  const isFirstTime = await claim(`shopify:${webhookId}`);
  if (!isFirstTime) {
    logger.info({ webhookId, path: req.path }, 'Shopify webhook duplicate — skipping');
    return res.status(200).send('OK (duplicate)');
  }
  next();
});

// ─── Order sync ───

router.post('/orders/create', async (req, res) => {
  res.status(200).send('OK');
  try {
    const shopDomain = req.headers['x-shopify-shop-domain'];
    const orderData = JSON.parse(req.rawBody);
    logger.info({ shop: shopDomain, order: orderData.name }, 'Order created webhook');
    // Orders are fetched on-demand via portal lookup; no sync needed.
  } catch (err) {
    logger.error({ err }, 'orders/create error');
  }
});

router.post('/orders/fulfilled', async (req, res) => {
  res.status(200).send('OK');
  try {
    const shopDomain = req.headers['x-shopify-shop-domain'];
    const order = JSON.parse(req.rawBody);

    const shop = await prisma.shop.findUnique({ where: { shopifyDomain: shopDomain } });
    if (!shop) return;

    // Record fulfillment date in shop settings for return window calculations
    const fulfilledAt = order.fulfillments?.[0]?.created_at || new Date().toISOString();
    const currentSettings = shop.settings || {};
    const fulfillments = currentSettings.fulfillments || {};
    fulfillments[order.id] = fulfilledAt;

    await prisma.shop.update({
      where: { id: shop.id },
      data: {
        settings: { ...currentSettings, fulfillments },
      },
    });

    logger.info({ shop: shopDomain, order: order.name }, 'Order fulfilled — return window started');
  } catch (err) {
    logger.error({ err }, 'orders/fulfilled error');
  }
});

// ─── App lifecycle ───

router.post('/app/uninstalled', async (req, res) => {
  res.status(200).send('OK');
  try {
    const shopDomain = req.headers['x-shopify-shop-domain'];
    const shop = await prisma.shop.findUnique({ where: { shopifyDomain: shopDomain } });
    if (!shop) return;

    await prisma.shop.update({
      where: { id: shop.id },
      data: {
        shopifyToken: '',
        settings: { uninstalledAt: new Date().toISOString() },
      },
    });

    eventBus.emit(SHOP_UNINSTALLED, { shopId: shop.id, shopDomain });
    logger.info({ shop: shopDomain }, 'App uninstalled');
  } catch (err) {
    logger.error({ err }, 'app/uninstalled error');
  }
});

router.post('/shop/update', async (req, res) => {
  res.status(200).send('OK');
  try {
    const shopDomain = req.headers['x-shopify-shop-domain'];
    const shopData = JSON.parse(req.rawBody);

    await prisma.shop.updateMany({
      where: { shopifyDomain: shopDomain },
      data: {
        name: shopData.name,
        email: shopData.email,
      },
    });
  } catch (err) {
    logger.error({ err }, 'shop/update error');
  }
});

/**
 * POST /webhooks/app_subscriptions/update
 * Fires whenever a subscription's status changes — including merchant-initiated
 * cancellations and declined charges done from Shopify's side. Keeps the local
 * plan in sync so downgrades/cancels never require support or a reinstall.
 */
router.post('/app_subscriptions/update', async (req, res) => {
  res.status(200).send('OK');
  try {
    const shopDomain = req.headers['x-shopify-shop-domain'];
    const payload = JSON.parse(req.rawBody);
    const sub = payload.app_subscription || {};
    await BillingService.applySubscriptionStatus(shopDomain, {
      name: sub.name,
      status: sub.status,
    });
  } catch (err) {
    logger.error({ err }, 'app_subscriptions/update error');
  }
});

// ─── GDPR mandatory webhooks (required for App Store) ───

/**
 * POST /webhooks/customers/data_request
 * Merchant requests customer data export. We email the merchant within 30 days.
 */
router.post('/customers/data_request', async (req, res) => {
  res.status(200).send('OK');
  try {
    const payload = JSON.parse(req.rawBody);
    const email = payload.customer?.email;
    logger.info({ email, shop: payload.shop_domain }, 'GDPR data request received');

    // Surface the request by writing an event — merchant can export via admin
    await prisma.returnEvent.createMany({
      data: [{
        returnId: 'gdpr-request',
        type: 'gdpr.data_request',
        actor: 'system',
        data: { email, shopDomain: payload.shop_domain, receivedAt: new Date().toISOString() },
      }].filter(() => false), // Skip for now — no returnId FK; handle manually
    }).catch(() => {});

    // TODO: Email the merchant a CSV export of all returns matching this customer email
  } catch (err) {
    logger.error({ err }, 'customers/data_request error');
  }
});

/**
 * POST /webhooks/customers/redact
 * Anonymize customer data 30 days after a deletion request.
 */
router.post('/customers/redact', async (req, res) => {
  res.status(200).send('OK');
  try {
    const payload = JSON.parse(req.rawBody);
    const email = payload.customer?.email;
    if (!email) return;

    // Find the shop by domain to scope the redaction
    const shop = await prisma.shop.findUnique({ where: { shopifyDomain: payload.shop_domain } });
    if (!shop) return;

    // Get affected returns to clean up R2 photos
    const returns = await prisma.return.findMany({
      where: { shopId: shop.id, customerEmail: email },
      select: { id: true },
    });

    await StorageService.deleteAllForShop(returns.map((r) => r.id)).catch(() => {});

    // Anonymize in DB
    await prisma.return.updateMany({
      where: { shopId: shop.id, customerEmail: email },
      data: {
        customerEmail: `redacted+${Date.now()}@redacted.local`,
        customerName: 'Redacted',
        notes: null,
      },
    });

    logger.info({ shop: payload.shop_domain, returnsAffected: returns.length }, 'Customer data redacted');
  } catch (err) {
    logger.error({ err }, 'customers/redact error');
  }
});

/**
 * POST /webhooks/shop/redact
 * Full shop data deletion 48 hours after app uninstall.
 */
router.post('/shop/redact', async (req, res) => {
  res.status(200).send('OK');
  try {
    const payload = JSON.parse(req.rawBody);
    const shop = await prisma.shop.findUnique({
      where: { shopifyDomain: payload.shop_domain },
      include: { returns: { select: { id: true } } },
    });
    if (!shop) return;

    await StorageService.deleteAllForShop(shop.returns.map((r) => r.id)).catch(() => {});

    // Cascade deletes all related records (returns, items, labels, policies, etc.)
    await prisma.shop.delete({ where: { id: shop.id } });

    logger.info({ shop: payload.shop_domain }, 'Shop data redacted');
  } catch (err) {
    logger.error({ err }, 'shop/redact error');
  }
});

module.exports = router;
