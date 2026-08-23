const { Router } = require('express');
const { verifyShopifySession } = require('../../middleware/auth');
const prisma = require('../../config/database');
const logger = require('../../utils/logger');

const router = Router();
router.use(verifyShopifySession);

// Only these fields may be set from the dashboard. shopId / id are never
// client-controlled — accepting them would let a merchant re-home a policy
// onto another tenant.
const EDITABLE = ['name', 'windowDays', 'conditions', 'resolutions', 'fees', 'isDefault', 'isActive'];

function pickEditable(body = {}) {
  const data = {};
  for (const key of EDITABLE) {
    if (body[key] !== undefined) data[key] = body[key];
  }
  if (data.windowDays !== undefined) {
    const n = Number(data.windowDays);
    data.windowDays = Number.isFinite(n) && n > 0 ? Math.round(n) : 30;
  }
  return data;
}

router.get('/', async (req, res) => {
  try {
    const policies = await prisma.returnPolicy.findMany({
      where: { shopId: req.shopId },
      orderBy: { createdAt: 'desc' },
    });
    res.json(policies);
  } catch (err) {
    logger.error({ err }, 'List policies error');
    res.status(500).json({ error: 'Failed to load policies' });
  }
});

router.post('/', async (req, res) => {
  try {
    const data = pickEditable(req.body);
    if (!data.name || !String(data.name).trim()) {
      return res.status(400).json({ error: 'name is required' });
    }

    // There can only be one default policy per shop.
    if (data.isDefault) {
      await prisma.returnPolicy.updateMany({
        where: { shopId: req.shopId, isDefault: true },
        data: { isDefault: false },
      });
    }

    const policy = await prisma.returnPolicy.create({
      data: {
        shopId: req.shopId,
        name: String(data.name).trim(),
        windowDays: data.windowDays || 30,
        conditions: data.conditions || {},
        resolutions: data.resolutions || { allowRefund: true, allowStoreCredit: true, allowExchange: false },
        fees: data.fees,
        isDefault: Boolean(data.isDefault),
        ...(data.isActive !== undefined ? { isActive: Boolean(data.isActive) } : {}),
      },
    });
    res.status(201).json(policy);
  } catch (err) {
    logger.error({ err }, 'Create policy error');
    res.status(500).json({ error: 'Failed to create policy' });
  }
});

router.put('/:id', async (req, res) => {
  try {
    const data = pickEditable(req.body);
    if (data.name !== undefined && !String(data.name).trim()) {
      return res.status(400).json({ error: 'name cannot be empty' });
    }

    if (data.isDefault) {
      await prisma.returnPolicy.updateMany({
        where: { shopId: req.shopId, isDefault: true, NOT: { id: req.params.id } },
        data: { isDefault: false },
      });
    }

    const result = await prisma.returnPolicy.updateMany({
      where: { id: req.params.id, shopId: req.shopId },
      data,
    });
    if (!result || result.count === 0) {
      return res.status(404).json({ error: 'Policy not found' });
    }
    res.json(result);
  } catch (err) {
    logger.error({ err }, 'Update policy error');
    res.status(500).json({ error: 'Failed to update policy' });
  }
});

module.exports = router;
