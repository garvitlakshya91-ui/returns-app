const { Router } = require('express');
const { verifyShopifySession } = require('../../middleware/auth');
const prisma = require('../../config/database');
const logger = require('../../utils/logger');

const router = Router();
router.use(verifyShopifySession);

router.get('/', async (req, res) => {
  try {
  const shop = await prisma.shop.findUnique({
    where: { id: req.shopId },
    select: { name: true, email: true, plan: true, currency: true, settings: true, shopifyDomain: true },
  });

  // Surface the public customer-portal URL so the dashboard setup guide can
  // show / share it. The portal is served at /portal/:shopSlug, where the slug
  // is the first label of the myshopify domain (matched in the lookup route).
  const slug = shop?.shopifyDomain ? shop.shopifyDomain.split('.')[0] : '';
  const base = (process.env.PORTAL_URL || process.env.HOST || '').replace(/\/$/, '');
  const portalUrl = base && slug ? `${base}/portal/${slug}` : '';

  res.json({ ...shop, portalUrl });
  } catch (err) {
    logger.error({ err }, 'Load settings error');
    res.status(500).json({ error: 'Failed to load settings' });
  }
});

// Keys the app itself maintains inside Shop.settings. A dashboard save must
// never overwrite them — e.g. `fulfillments` holds the per-order fulfilment
// dates the return-window check depends on.
const SYSTEM_KEYS = ['fulfillments', 'uninstalledAt'];

router.put('/', async (req, res) => {
  try {
    const incoming = req.body?.settings;
    if (!incoming || typeof incoming !== 'object' || Array.isArray(incoming)) {
      return res.status(400).json({ error: 'settings must be an object' });
    }

    // Merge into what's stored instead of replacing it wholesale, so a stale
    // dashboard snapshot can't wipe keys written since the page loaded.
    const current = await prisma.shop.findUnique({ where: { id: req.shopId }, select: { settings: true } });
    const merged = { ...(current?.settings || {}), ...incoming };
    for (const key of SYSTEM_KEYS) {
      if (current?.settings && current.settings[key] !== undefined) merged[key] = current.settings[key];
      else delete merged[key];
    }

    const shop = await prisma.shop.update({
      where: { id: req.shopId },
      data: { settings: merged },
    });
    res.json({ settings: shop.settings });
  } catch (err) {
    logger.error({ err }, 'Update settings error');
    res.status(500).json({ error: 'Failed to save settings' });
  }
});

module.exports = router;
