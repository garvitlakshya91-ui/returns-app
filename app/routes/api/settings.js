const { Router } = require('express');
const { verifyShopifySession } = require('../../middleware/auth');
const prisma = require('../../config/database');

const router = Router();
router.use(verifyShopifySession);

router.get('/', async (req, res) => {
  const shop = await prisma.shop.findUnique({
    where: { id: req.shopId },
    select: { name: true, email: true, plan: true, currency: true, settings: true },
  });
  res.json(shop);
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
