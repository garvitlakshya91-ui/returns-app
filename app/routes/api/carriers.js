const { Router } = require('express');
const { verifyShopifySession } = require('../../middleware/auth');
const prisma = require('../../config/database');
const { encrypt, decrypt } = require('../../utils/encryption');
const { PLAN_LIMITS } = require('../../middleware/planGating');
const logger = require('../../utils/logger');

const SUPPORTED_CARRIERS = ['evri', 'royalmail', 'inpost'];

const router = Router();
router.use(verifyShopifySession);

/**
 * GET /api/admin/carriers
 * List all carrier configs for the shop (credentials redacted).
 */
router.get('/', async (req, res) => {
  try {
    const configs = await prisma.carrierConfig.findMany({
      where: { shopId: req.shopId },
    });
    const safe = configs.map((c) => ({
      id: c.id,
      carrier: c.carrier,
      isActive: c.isActive,
      hasCredentials: !!c.credentials?.encrypted,
      settings: c.settings,
    }));
    res.json(safe);
  } catch (err) {
    logger.error({ err }, 'List carriers error');
    res.status(500).json({ error: 'Failed to load carriers' });
  }
});

/**
 * POST /api/admin/carriers
 * Create or update a carrier config with encrypted credentials.
 */
router.post('/', async (req, res) => {
  try {
    const { carrier, credentials, settings, isActive = true } = req.body;

    if (!SUPPORTED_CARRIERS.includes(carrier)) {
      return res.status(400).json({ error: `Unsupported carrier. Choose from: ${SUPPORTED_CARRIERS.join(', ')}` });
    }

    // Enforce the plan's active-carrier limit. We compute the set of carriers
    // that would be active *after* this change and reject if it exceeds the cap.
    const shop = await prisma.shop.findUnique({
      where: { id: req.shopId },
      select: { plan: true },
    });
    const limit = (PLAN_LIMITS[shop?.plan] || PLAN_LIMITS.FREE).carriers;
    const existing = await prisma.carrierConfig.findMany({
      where: { shopId: req.shopId },
      select: { carrier: true, isActive: true, credentials: true },
    });
    const activeSet = new Set(existing.filter((c) => c.isActive).map((c) => c.carrier));
    if (isActive) activeSet.add(carrier);
    else activeSet.delete(carrier);
    if (activeSet.size > limit) {
      return res.status(403).json({
        error: `Your ${shop?.plan || 'FREE'} plan allows ${limit} active carrier${limit > 1 ? 's' : ''}. Upgrade your plan to connect more.`,
        plan: shop?.plan || 'FREE',
        carrierLimit: limit,
      });
    }

    // Only re-encrypt when fresh credentials are supplied. This lets the
    // merchant toggle a carrier active/inactive (or tweak settings) without
    // having to re-enter their API keys — we keep whatever is already stored.
    const hasNewCreds = credentials && Object.keys(credentials).length > 0;
    const prior = existing.find((c) => c.carrier === carrier);
    const encryptedCreds = hasNewCreds
      ? { encrypted: encrypt(JSON.stringify(credentials)) }
      : (prior?.credentials || {});

    const config = await prisma.carrierConfig.upsert({
      where: { shopId_carrier: { shopId: req.shopId, carrier } },
      create: {
        shopId: req.shopId,
        carrier,
        credentials: encryptedCreds,
        settings: settings || {},
        isActive,
      },
      update: {
        credentials: encryptedCreds,
        settings: settings || {},
        isActive,
      },
    });

    res.json({
      id: config.id,
      carrier: config.carrier,
      isActive: config.isActive,
      hasCredentials: !!config.credentials?.encrypted,
    });
  } catch (err) {
    logger.error({ err }, 'Save carrier error');
    res.status(500).json({ error: 'Failed to save carrier' });
  }
});

/**
 * DELETE /api/admin/carriers/:id
 */
router.delete('/:id', async (req, res) => {
  try {
    const deleted = await prisma.carrierConfig.deleteMany({
      where: { id: req.params.id, shopId: req.shopId },
    });
    res.json({ deleted: deleted.count });
  } catch (err) {
    logger.error({ err }, 'Delete carrier error');
    res.status(500).json({ error: 'Failed to delete carrier' });
  }
});

/**
 * Helper: decrypt a shop's carrier credentials (used internally by services).
 * Exported for LabelService to consume.
 */
async function getDecryptedCredentials(shopId, carrier) {
  const config = await prisma.carrierConfig.findUnique({
    where: { shopId_carrier: { shopId, carrier } },
  });
  if (!config?.credentials?.encrypted) return null;
  try {
    return JSON.parse(decrypt(config.credentials.encrypted));
  } catch {
    return null;
  }
}

router.getDecryptedCredentials = getDecryptedCredentials;

module.exports = router;
