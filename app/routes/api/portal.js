const { Router } = require('express');
const multer = require('multer');
const { portalLimiter, lookupLimiter, createReturnLimiter } = require('../../middleware/rateLimiter');
const { planGate, loadShopFromBody, PLAN_LIMITS } = require('../../middleware/planGating');
const prisma = require('../../config/database');
const shopify = require('../../config/shopify');
const ShopToken = require('../../services/ShopToken');
const ReturnService = require('../../services/ReturnService');
const ReturnValidation = require('../../services/ReturnValidation');
const StorageService = require('../../services/StorageService');
const LabelService = require('../../services/LabelService');
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

// Shopify search syntax: wrap a user-supplied value in double quotes, escaping
// any quotes/backslashes inside it, and strip a leading '#' from order numbers.
function quote(value) {
  const v = String(value ?? '').trim().replace(/^#/, '').replace(/[\\"]/g, '\\$&');
  return `"${v}"`;
}

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

    // The slug is the first label of the myshopify domain (see settings.js).
    // Match the exact domain — a substring match could resolve a short slug
    // like "shop" to an arbitrary other merchant's store.
    const slug = String(shopSlug).trim().toLowerCase().replace(/\.myshopify\.com$/, '');
    if (!/^[a-z0-9][a-z0-9-]*$/.test(slug)) {
      return res.status(404).json({ error: 'Shop not found' });
    }
    const shop = await prisma.shop.findFirst({
      where: {
        shopifyDomain: `${slug}.myshopify.com`,
        shopifyToken: { not: '' },
      },
      include: { policies: { where: { isActive: true } } },
    });

    if (!shop) {
      return res.status(404).json({ error: 'Shop not found' });
    }

    const accessToken = await ShopToken.getAccessToken(shop);
    const session = { shop: shop.shopifyDomain, accessToken };
    const client = new shopify.clients.Graphql({ session });

    // Find the order by number + email, then load everything about it
    // through the same path the create step uses, so what the customer is
    // shown is exactly what the server will accept.
    const response = await client.request(`
      query lookupOrder($query: String!) {
        orders(first: 1, query: $query) {
          edges { node { id email } }
        }
      }
    `, {
      // Quote both values so spaces / search operators in user input can't
      // change the meaning of the query.
      variables: { query: `name:${quote(orderNumber)} email:${quote(email)}` },
    });

    const orders = response.data?.orders?.edges || [];
    if (orders.length === 0) {
      return res.status(404).json({ error: 'Order not found. Please check your email and order number.' });
    }

    const found = orders[0].node;
    if ((found.email || '').toLowerCase() !== String(email).trim().toLowerCase()) {
      return res.status(404).json({ error: 'Order not found. Please check your email and order number.' });
    }

    const { order, items } = await ReturnValidation.loadOrder(shop, found.id);

    res.json({
      shopId: shop.id,
      shopName: shop.name,
      orderId: order.id,
      orderName: order.name,
      email: order.email,
      currency: order.currency,
      fulfillmentStatus: order.fulfillmentStatus,
      // Only items the customer can still return, with how many and which
      // resolutions their policy allows.
      eligibleItems: items.filter((i) => i.eligible).map(({ eligible, ineligibleReason, policyId, ...item }) => item),
      features: { exchanges: ReturnValidation.EXCHANGES_ENABLED },
    });
  } catch (err) {
    if (err instanceof ReturnValidation.ValidationError) {
      return res.status(err.status).json({ error: err.message });
    }
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
router.post('/returns', createReturnLimiter, loadShopFromBody, planGate('createReturn'), async (req, res) => {
  try {
    const { shopId, items, resolution, customerEmail, orderId } = req.body;

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

    // Nothing from the browser is trusted beyond "which items, how many,
    // why, and what outcome": ownership, eligibility, remaining quantities,
    // prices and titles all come from Shopify and our own records.
    const validated = await ReturnValidation.validateCreate(req.shop, {
      orderId, customerEmail, items, resolution,
    });

    const returnRecord = await ReturnService.createReturn({
      shopId,
      shopifyOrderId: validated.order.id,
      shopifyOrderName: validated.order.name,
      customerEmail: validated.order.email,
      customerName: req.body.customerName ? String(req.body.customerName).slice(0, 200) : 'Customer',
      currency: validated.order.currency,
      items: validated.items,
      resolution,
    });

    res.status(201).json(returnRecord);
  } catch (err) {
    if (err instanceof ReturnValidation.ValidationError) {
      return res.status(err.status).json({ error: err.message });
    }
    if (err.code === 'QUOTA_EXCEEDED') {
      return res.status(403).json({ error: err.message, limit: err.limit, plan: err.plan, upgradeRequired: true });
    }
    logger.error({ err }, 'Create return error');
    res.status(500).json({ error: 'Failed to create return' });
  }
});

/**
 * GET /api/portal/shops/:slug/branding
 * What the merchant set under "Customise your portal", for the portal to
 * show. Public, like the portal itself; nothing private is returned.
 */
router.get('/shops/:slug/branding', async (req, res) => {
  try {
    const slug = String(req.params.slug || '').trim().toLowerCase().replace(/\.myshopify\.com$/, '');
    if (!/^[a-z0-9][a-z0-9-]*$/.test(slug)) return res.status(404).json({ error: 'Shop not found' });
    const shop = await prisma.shop.findFirst({
      where: { shopifyDomain: `${slug}.myshopify.com`, shopifyToken: { not: '' } },
      select: { name: true, email: true, settings: true },
    });
    if (!shop) return res.status(404).json({ error: 'Shop not found' });
    const s = shop.settings || {};
    res.json({
      name: shop.name,
      heading: typeof s.portalHeading === 'string' && s.portalHeading.trim() ? s.portalHeading.trim().slice(0, 120) : null,
      primaryColor: typeof s.primaryColor === 'string' && /^#[0-9a-fA-F]{6}$/.test(s.primaryColor) ? s.primaryColor : null,
      supportEmail: typeof s.supportEmail === 'string' && s.supportEmail.includes('@') ? s.supportEmail : null,
      logoUrl: typeof s.logoUrl === 'string' && /^https:\/\//i.test(s.logoUrl) ? s.logoUrl : null,
    });
  } catch (err) {
    logger.error({ err }, 'Branding lookup error');
    res.status(500).json({ error: 'Failed to load branding' });
  }
});

/**
 * POST /api/portal/quote
 * The return fee the shop's policy would charge for these reasons, so the
 * customer sees it before submitting. Reads nothing from Shopify.
 */
router.post('/quote', loadShopFromBody, async (req, res) => {
  try {
    const items = Array.isArray(req.body.items) ? req.body.items : [];
    const fee = await ReturnService.quoteFee(req.shop.id, items);
    res.json({ fee, currency: req.shop.currency || 'GBP' });
  } catch (err) {
    logger.error({ err }, 'Quote error');
    res.status(500).json({ error: 'Failed to quote return fee' });
  }
});

/**
 * Load a return for a customer-facing route. The customer proves it is
 * theirs with the email the return was made under; an id alone is not
 * enough to see photos, labels or events. Returns null (and sends 404)
 * when the return is missing or the email does not match.
 */
async function loadCustomerReturn(req, res, email, include = {}) {
  const clean = typeof email === 'string' ? email.trim().toLowerCase() : '';
  if (!clean) {
    res.status(400).json({ error: 'email is required' });
    return null;
  }
  const returnRecord = await prisma.return.findUnique({ where: { id: req.params.id }, include });
  if (!returnRecord || returnRecord.customerEmail.toLowerCase() !== clean) {
    res.status(404).json({ error: 'Return not found' });
    return null;
  }
  return returnRecord;
}

/**
 * GET /api/portal/returns/:id?email=
 */
router.get('/returns/:id', async (req, res) => {
  try {
    const returnRecord = await loadCustomerReturn(req, res, req.query.email, {
      items: true,
      label: true,
      events: { orderBy: { createdAt: 'desc' }, take: 10 },
    });
    if (!returnRecord) return;

    res.json({
      id: returnRecord.id,
      status: returnRecord.status,
      resolution: returnRecord.resolution,
      currency: returnRecord.currency,
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
    const returnRecord = await loadCustomerReturn(req, res, req.body.email, { items: true });
    if (!returnRecord) return;

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
    if (!Number.isInteger(contentLength) || contentLength <= 0) {
      return res.status(400).json({ error: 'contentLength must be the file size in bytes' });
    }
    if (contentLength > 5 * 1024 * 1024) {
      return res.status(400).json({ error: 'File too large (max 5MB)' });
    }

    const returnRecord = await loadCustomerReturn(req, res, req.body.email);
    if (!returnRecord) return;

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
