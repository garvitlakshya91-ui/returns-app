const { Router } = require('express');
const { verifyShopifySession } = require('../../middleware/auth');
const prisma = require('../../config/database');

const router = Router();
router.use(verifyShopifySession);

router.get('/', async (req, res) => {
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
});

router.put('/', async (req, res) => {
  const { settings } = req.body;
  const shop = await prisma.shop.update({
    where: { id: req.shopId },
    data: { settings },
  });
  res.json({ settings: shop.settings });
});

module.exports = router;
