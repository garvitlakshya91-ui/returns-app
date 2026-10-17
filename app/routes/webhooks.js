const { Router } = require('express');
const crypto = require('crypto');
const { verifyWebhookHmac } = require('../utils/hmac');
const { claim, release, complete, status } = require('../utils/idempotency');
const prisma = require('../config/database');
const eventBus = require('../events/eventBus');
const { SHOP_UNINSTALLED } = require('../events/emitters');
const StorageService = require('../services/StorageService');
const BillingService = require('../services/BillingService');
const AnalyticsService = require('../services/AnalyticsService');
const NotificationService = require('../services/NotificationService');
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
//
// The claim is a short processing lease, marked complete only when the
// response goes out as a success. So: a finished delivery is a duplicate
// for the full window; one still in progress is told to come back later;
// and if the process died mid-way, the lease lapses and the retry is
// processed instead of being dropped.
router.use(async (req, res, next) => {
  const webhookId = req.headers['x-shopify-webhook-id'];
  // No delivery id → nothing to dedup on. (Claiming the literal key
  // "shopify:undefined" would swallow every later header-less webhook.)
  if (!webhookId) return next();
  const key = `shopify:${webhookId}`;
  const isFirstTime = await claim(key);
  if (!isFirstTime) {
    if ((await status(key)) === 'processing') {
      logger.info({ webhookId, path: req.path }, 'Shopify webhook still being processed — asking for a later retry');
      return res.status(503).set('Retry-After', '60').send('Processing — retry later');
    }
    logger.info({ webhookId, path: req.path }, 'Shopify webhook duplicate — skipping');
    return res.status(200).send('OK (duplicate)');
  }
  res.on('finish', () => {
    if (res.statusCode < 300) complete(key).catch(() => {});
  });
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
        // Shopify cancels the subscription on uninstall. Dropping to FREE here
        // means a reinstall must request charge approval again (App Store
        // requirement 1.2.2) instead of resuming a paid plan nobody pays for.
        plan: 'FREE',
        // Keep the merchant's configuration (branding, warehouse address,
        // fulfilment dates) so a reinstall picks up where they left off;
        // shop/redact wipes it for real 48h later if they don't come back.
        settings: { ...(shop.settings || {}), uninstalledAt: new Date().toISOString() },
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
        ...(shopData.currency ? { currency: shopData.currency } : {}),
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
//
// shopify.app.toml sends all three compliance topics to /webhooks, with the
// topic in the X-Shopify-Topic header; the per-topic paths below are kept for
// anything registered the old way. Both reach the same handlers.

/**
 * customers/data_request — the merchant must hand the customer their data.
 * We export every return the customer has with this shop as CSV, email it
 * to the merchant, and note the request on each of those returns.
 */
async function handleCustomerDataRequest(payload) {
  const email = payload.customer?.email;
  logger.info({ email, shop: payload.shop_domain }, 'GDPR data request received');
  if (!email) return;

  const shop = await prisma.shop.findUnique({ where: { shopifyDomain: payload.shop_domain } });
  if (!shop) return;

  const returns = await prisma.return.findMany({
    where: { shopId: shop.id, customerEmail: { equals: email, mode: 'insensitive' } },
    select: { id: true },
  });
  if (returns.length > 0) {
    await prisma.returnEvent.createMany({
      data: returns.map((r) => ({
        returnId: r.id,
        type: 'gdpr.data_request',
        actor: 'system',
        data: { customerEmail: email, shopifyRequestId: payload.data_request?.id || null, receivedAt: new Date().toISOString() },
      })),
    });
  }

  const csv = await AnalyticsService.exportCsv(shop.id, { customerEmail: email });
  await NotificationService.sendEmail({
    to: shop.email,
    subject: `Customer data request: ${email}`,
    template: 'DataRequest',
    data: {
      shopName: shop.name,
      customerEmail: email,
      returnCount: returns.length,
      csv,
      requestId: payload.data_request?.id || null,
    },
  });
  logger.info({ email, shop: payload.shop_domain, returns: returns.length }, 'GDPR data request exported to merchant');
}

/**
 * Compliance work is acknowledged only once it has been done. A failure
 * answers 500 and gives the delivery's idempotency key back, so Shopify's
 * retry is processed instead of being dropped as a duplicate.
 */
async function runCompliance(req, res, topic, handler) {
  // A body that is not JSON will never become valid on retry: log it and
  // acknowledge, so Shopify does not keep resending it.
  let payload;
  try {
    payload = JSON.parse(req.rawBody);
  } catch (err) {
    logger.error({ err, topic }, 'Compliance webhook body is not JSON');
    return res.status(200).send('OK');
  }
  try {
    await handler(payload);
    res.status(200).send('OK');
  } catch (err) {
    logger.error({ err, topic }, 'Compliance webhook failed; asking Shopify to retry');
    await release(`shopify:${req.headers['x-shopify-webhook-id']}`);
    res.status(500).send('Retry');
  }
}

router.post('/customers/data_request', (req, res) => runCompliance(req, res, 'customers/data_request', handleCustomerDataRequest));

/**
 * POST /webhooks/customers/redact
 * Anonymize customer data 30 days after a deletion request.
 */
/**
 * The anonymised address for a customer is derived from their email, not
 * the clock, so a retry after a partial run can find the same returns
 * again (by the original email or the alias) and finish the job.
 */
function redactedAlias(email) {
  const hash = crypto.createHash('sha256').update(String(email).trim().toLowerCase()).digest('hex').slice(0, 16);
  return `redacted+${hash}@redacted.local`;
}

async function handleCustomerRedact(payload) {
  const email = payload.customer?.email;
  if (!email) return;

  // Find the shop by domain to scope the redaction
  const shop = await prisma.shop.findUnique({ where: { shopifyDomain: payload.shop_domain } });
  if (!shop) return;

  const alias = redactedAlias(email);
  const where = {
    shopId: shop.id,
    OR: [{ customerEmail: { equals: email, mode: 'insensitive' } }, { customerEmail: alias }],
  };
  const returns = await prisma.return.findMany({ where, select: { id: true } });
  const ids = returns.map((r) => r.id);
  if (ids.length === 0) {
    logger.info({ shop: payload.shop_domain }, 'Customer redaction: nothing held');
    return;
  }

  // Photos first, and not swallowed: if the files cannot be removed the
  // request fails (500) and Shopify retries the whole thing. Deleting again
  // is harmless.
  await StorageService.deleteAllForShop(ids);

  // Then every database change together, so a failure leaves nothing
  // half-redacted: the return, what the customer wrote on its items, the
  // photo links, and anything the timeline recorded about them.
  await prisma.$transaction([
    prisma.return.updateMany({
      where: { id: { in: ids } },
      data: { customerEmail: alias, customerName: 'Redacted', notes: null },
    }),
    prisma.returnItem.updateMany({
      where: { returnId: { in: ids } },
      data: { reasonDetail: null, photoUrls: [] },
    }),
    prisma.returnEvent.updateMany({
      where: { returnId: { in: ids } },
      data: { data: { redacted: true } },
    }),
  ]);

  logger.info({ shop: payload.shop_domain, returnsAffected: ids.length }, 'Customer data redacted');
}

router.post('/customers/redact', (req, res) => runCompliance(req, res, 'customers/redact', handleCustomerRedact));

/**
 * POST /webhooks/shop/redact
 * Full shop data deletion 48 hours after app uninstall.
 */
async function handleShopRedact(payload) {
    const shop = await prisma.shop.findUnique({
      where: { shopifyDomain: payload.shop_domain },
      include: { returns: { select: { id: true } } },
    });
    if (!shop) return;

    await StorageService.deleteAllForShop(shop.returns.map((r) => r.id)).catch(() => {});

    // Cascade deletes all related records (returns, items, labels, policies, etc.)
    await prisma.shop.delete({ where: { id: shop.id } });

    logger.info({ shop: payload.shop_domain }, 'Shop data redacted');
}

router.post('/shop/redact', (req, res) => runCompliance(req, res, 'shop/redact', handleShopRedact));

// The compliance destination configured in shopify.app.toml: one URL, the
// topic in the header.
const COMPLIANCE_HANDLERS = {
  'customers/data_request': handleCustomerDataRequest,
  'customers/redact': handleCustomerRedact,
  'shop/redact': handleShopRedact,
};

router.post('/', async (req, res) => {
  const topic = String(req.headers['x-shopify-topic'] || '').toLowerCase();
  const handler = COMPLIANCE_HANDLERS[topic];
  if (!handler) {
    logger.warn({ topic }, 'Webhook for an unhandled topic at /webhooks');
    return res.status(404).send('Unknown topic');
  }
  await runCompliance(req, res, topic, handler);
});

module.exports = router;
