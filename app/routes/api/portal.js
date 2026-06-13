const { Router } = require('express');
const multer = require('multer');
const { portalLimiter, lookupLimiter } = require('../../middleware/rateLimiter');
const { planGate, loadShopFromBody, PLAN_LIMITS } = require('../../middleware/planGating');
const prisma = require('../../config/database');
const shopify = require('../../config/shopify');
const { decrypt } = require('../../utils/encryption');
const ReturnService = require('../../services/ReturnService');
const PolicyEngine = require('../../services/PolicyEngine');
const StorageService = require('../../services/StorageService');
const LabelService = require('../../services/LabelService');
const StripeService = require('../../services/StripeService');
const logger = require('../../utils/logger');

const router = Router();
router.use(portalLimiter);

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 5 * 1024 * 1024, files: 5 }, // 5MB per file, max 5
  fileFilter: (req, file, cb) => {
    const allowed = ['image/jpeg', 'image/png', 'image/webp', 'image/heic'];
    cb(null, allowed.includes(file.mimetype));
  },
});

/**
 * POST /api/portal/lookup
 * Look up a Shopify order by email + order number; return eligible items.
 */
router.post('/lookup', lookupLimiter, async (req, res) => {
  try {
    const { email, orderNumber, shopSlug } = req.body;

    if (!email || !orderNumber || !shopSlug) {
      return res.status(400).json({ error: 'email, orderNumber, and shopSlug are required' });
    }

    const shop = await prisma.shop.findFirst({
      where: {
        shopifyDomain: { contains: shopSlug },
        shopifyToken: { not: '' },
      },
      include: { policies: { where: { isActive: true } } },
    });

    if (!shop) {
      return res.status(404).json({ error: 'Shop not found' });
    }

    const accessToken = decrypt(shop.shopifyToken);
    const session = { shop: shop.shopifyDomain, accessToken };
    const client = new shopify.clients.Graphql({ session });

    const response = await client.request(`
      query lookupOrder($query: String!) {
        orders(first: 1, query: $query) {
          edges {
            node {
              id name email createdAt displayFulfillmentStatus
              fulfillments(first: 1) { createdAt }
              lineItems(first: 50) {
                edges {
                  node {
                    id title variantTitle quantity sku
                    originalUnitPriceSet { shopMoney { amount } }
                    image { url }
                    product { id }
                    variant { id }
                  }
                }
              }
            }
          }
        }
      }
    `, {
      variables: { query: `name:${orderNumber} email:${email}` },
    });

    const orders = response.data?.orders?.edges || [];
    if (orders.length === 0) {
      return res.status(404).json({ error: 'Order not found. Please check your email and order number.' });
    }

    const orderData = orders[0].node;
    if (orderData.email.toLowerCase() !== email.toLowerCase()) {
      return res.status(404).json({ error: 'Order not found. Please check your email and order number.' });
    }

    const fulfilledAt = orderData.fulfillments?.[0]?.createdAt || orderData.createdAt;
    const lineItems = orderData.lineItems.edges.map((e) => e.node);

    const eligibleItems = [];
    for (const item of lineItems) {
      const eligibility = await PolicyEngine.evaluateEligibility(shop.id, {
        price: Number(item.originalUnitPriceSet.shopMoney.amount),
        tags: [],
        collections: [],
      }, fulfilledAt);

      if (eligibility.eligible) {
        eligibleItems.push({
          id: item.id,
          lineItemId: item.id,
          productId: item.product?.id,
          variantId: item.variant?.id,
          title: item.title,
          variantTitle: item.variantTitle,
          price: Number(item.originalUnitPriceSet.shopMoney.amount),
          quantity: item.quantity,
          sku: item.sku,
          imageUrl: item.image?.url || null,
        });
      }
    }

    res.json({
      shopId: shop.id,
      shopName: shop.name,
      orderId: orderData.id,
      orderName: orderData.name,
      email: orderData.email,
      fulfillmentStatus: orderData.displayFulfillmentStatus,
      eligibleItems,
    });
  } catch (err) {
    logger.error({ err }, 'Portal lookup error');
    res.status(500).json({ error: 'Failed to look up order' });
  }
});

/**
 * POST /api/portal/returns
 * loadShopFromBody populates req.shop from body.shopId.
 * planGate('createReturn') enforces the per-plan monthly return limit.
 * Exchange resolution is then gated against the shop's plan inline.
 */
router.post('/returns', loadShopFromBody, planGate('createReturn'), async (req, res) => {
  try {
    const { shopId, items, resolution, customerEmail } = req.body;

    if (!items?.length || !resolution) {
      return res.status(400).json({ error: 'items and resolution are required' });
    }

    if (resolution === 'EXCHANGE') {
      const limits = PLAN_LIMITS[req.shop.plan] || PLAN_LIMITS.FREE;
      if (!limits.exchanges) {
        return res.status(403).json({
          error: 'Exchanges require Starter plan or higher',
          plan: req.shop.plan,
          upgradeRequired: true,
        });
      }
    }

    const returnRecord = await ReturnService.createReturn({
      shopId,
      shopifyOrderId: req.body.orderId || 'pending',
      shopifyOrderName: req.body.orderName || 'pending',
      customerEmail: customerEmail || 'unknown@email.com',
      customerName: req.body.customerName || 'Customer',
      items,
      resolution,
    });

    res.status(201).json(returnRecord);
  } catch (err) {
    logger.error({ err }, 'Create return error');
    res.status(500).json({ error: 'Failed to create return' });
  }
});

/**
 * GET /api/portal/returns/:id
 */
router.get('/returns/:id', async (req, res) => {
  try {
    const { email } = req.query;

    const returnRecord = await prisma.return.findUnique({
      where: { id: req.params.id },
      include: {
        items: true,
        label: true,
        events: { orderBy: { createdAt: 'desc' }, take: 10 },
      },
    });

    if (!returnRecord) {
      return res.status(404).json({ error: 'Return not found' });
    }

    if (email && returnRecord.customerEmail.toLowerCase() !== email.toLowerCase()) {
      return res.status(404).json({ error: 'Return not found' });
    }

    res.json({
      id: returnRecord.id,
      status: returnRecord.status,
      resolution: returnRecord.resolution,
      totalValue: returnRecord.totalValue,
      refundAmount: returnRecord.refundAmount,
      items: returnRecord.items,
      label: returnRecord.label,
      events: returnRecord.events,
      createdAt: returnRecord.createdAt,
    });
  } catch (err) {
    logger.error({ err }, 'Get return error');
    res.status(500).json({ error: 'Internal server error' });
  }
});

/**
 * POST /api/portal/returns/:id/photos
 * Proxy upload: backend accepts multipart, stores on R2.
 * Accept field: photos[] + itemId (form field)
 */
router.post('/returns/:id/photos', upload.array('photos', 5), async (req, res) => {
  try {
    const { itemId } = req.body;
    const returnRecord = await prisma.return.findUnique({
      where: { id: req.params.id },
      include: { items: true },
    });
    if (!returnRecord) return res.status(404).json({ error: 'Return not found' });

    const urls = [];
    for (const file of req.files || []) {
      const { url } = await StorageService.uploadReturnPhoto(file.buffer, file.mimetype, req.params.id);
      urls.push(url);
    }

    if (itemId) {
      const item = returnRecord.items.find((i) => i.id === itemId);
      if (item) {
        await prisma.returnItem.update({
          where: { id: itemId },
          data: { photoUrls: { push: urls } },
        });
      }
    }

    res.json({ urls });
  } catch (err) {
    logger.error({ err }, 'Photo upload error');
    res.status(500).json({ error: 'Upload failed' });
  }
});

/**
 * POST /api/portal/returns/:id/photos/presign
 * Returns a presigned R2 URL for direct browser uploads (scalable).
 */
router.post('/returns/:id/photos/presign', async (req, res) => {
  try {
    const { contentType, contentLength } = req.body;

    if (!['image/jpeg', 'image/png', 'image/webp'].includes(contentType)) {
      return res.status(400).json({ error: 'Invalid content type' });
    }
    if (contentLength > 5 * 1024 * 1024) {
      return res.status(400).json({ error: 'File too large (max 5MB)' });
    }

    const result = await StorageService.getPresignedUploadUrl({
      returnId: req.params.id,
      contentType,
      contentLength,
    });

    res.json(result);
  } catch (err) {
    logger.error({ err }, 'Presign error');
    res.status(500).json({ error: 'Failed to generate upload URL' });
  }
});

/**
 * POST /api/portal/returns/:id/pay
 * Create a Stripe Checkout Session to collect the return fee.
 * The return stays in REQUESTED until the Stripe webhook confirms payment.
 */
router.post('/returns/:id/pay', async (req, res) => {
  try {
    const returnRecord = await prisma.return.findUnique({
      where: { id: req.params.id },
    });
    if (!returnRecord) return res.status(404).json({ error: 'Return not found' });

    if (returnRecord.status !== 'REQUESTED') {
      return res.status(409).json({ error: `Return is in ${returnRecord.status} status` });
    }
    if (!returnRecord.returnFee || Number(returnRecord.returnFee) <= 0) {
      return res.status(400).json({ error: 'This return has no fee to collect' });
    }

    const portalBase = process.env.PORTAL_URL || process.env.HOST;
    const successUrl = `${portalBase}/portal/return/${returnRecord.id}?paid=1`;
    const cancelUrl = `${portalBase}/portal/return/${returnRecord.id}?paid=0`;

    const session = await StripeService.createCheckoutSession({
      returnRecord,
      successUrl,
      cancelUrl,
    });

    await prisma.returnEvent.create({
      data: {
        returnId: returnRecord.id,
        type: 'stripe.checkout_created',
        actor: 'customer',
        data: {
          sessionId: session.sessionId,
          amountPence: session.amountPence,
          createdAt: new Date().toISOString(),
        },
      },
    });

    res.json({ url: session.url, sessionId: session.sessionId });
  } catch (err) {
    logger.error({ err }, 'Stripe checkout error');
    res.status(500).json({ error: err.message || 'Failed to create checkout session' });
  }
});

/**
 * GET /api/portal/carriers/:shopId/dropoff
 */
router.get('/carriers/:shopId/dropoff', async (req, res) => {
  try {
    const { carrier = 'evri', postcode } = req.query;
    if (!postcode) return res.status(400).json({ error: 'postcode is required' });

    const shop = await prisma.shop.findUnique({
      where: { id: req.params.shopId },
      include: { carrierConfigs: true },
    });
    if (!shop) return res.status(404).json({ error: 'Shop not found' });

    const adapter = LabelService.getCarrierAdapter(shop, carrier);
    const locations = await adapter.getDropoffLocations({ postcode, limit: 5 });
    res.json({ locations });
  } catch (err) {
    logger.error({ err }, 'Dropoff lookup error');
    res.status(500).json({ error: 'Failed to find drop-off locations' });
  }
});

module.exports = router;
