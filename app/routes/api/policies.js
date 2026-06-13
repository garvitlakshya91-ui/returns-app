const { Router } = require('express');
const { verifyShopifySession } = require('../../middleware/auth');
const prisma = require('../../config/database');

const router = Router();
router.use(verifyShopifySession);

router.get('/', async (req, res) => {
  const policies = await prisma.returnPolicy.findMany({
    where: { shopId: req.shopId },
    orderBy: { createdAt: 'desc' },
  });
  res.json(policies);
});

router.post('/', async (req, res) => {
  const { name, windowDays, conditions, resolutions, fees, isDefault } = req.body;
  const policy = await prisma.returnPolicy.create({
    data: {
      shopId: req.shopId,
      name,
      windowDays: windowDays || 30,
      conditions: conditions || {},
      resolutions: resolutions || { allowRefund: true, allowStoreCredit: true, allowExchange: false },
      fees,
      isDefault: isDefault || false,
    },
  });
  res.status(201).json(policy);
});

router.put('/:id', async (req, res) => {
  const policy = await prisma.returnPolicy.updateMany({
    where: { id: req.params.id, shopId: req.shopId },
    data: req.body,
  });
  res.json(policy);
});

module.exports = router;
