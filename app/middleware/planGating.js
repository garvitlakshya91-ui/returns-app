const prisma = require('../config/database');

// Monthly quotas run on a 30-day cycle from billingCycleStart (set when a
// paid plan activates). A shop with no start, or one whose cycle has ended,
// starts a fresh cycle before its count is checked.
const CYCLE_MS = 30 * 24 * 60 * 60 * 1000;

function cycleExpired(shop) {
  return !shop.billingCycleStart || (Date.now() - new Date(shop.billingCycleStart).getTime()) >= CYCLE_MS;
}

/** Reset the shop's monthly count when its cycle has ended. Returns the shop to use. */
async function rollCycle(shop) {
  if (!cycleExpired(shop)) return shop;
  const fresh = await prisma.shop.update({
    where: { id: shop.id },
    data: { returnCount: 0, billingCycleStart: new Date() },
  });
  return fresh || { ...shop, returnCount: 0, billingCycleStart: new Date() };
}

const PLAN_LIMITS = {
  FREE: { returnsPerMonth: 30, carriers: 1, exchanges: false, analytics: false },
  STARTER: { returnsPerMonth: 150, carriers: 3, exchanges: true, analytics: false },
  GROWTH: { returnsPerMonth: Infinity, carriers: 10, exchanges: true, analytics: true },
  PRO: { returnsPerMonth: Infinity, carriers: 10, exchanges: true, analytics: true },
};

/**
 * Loads a shop from req.body.shopId (or req.params.shopId) and attaches it as
 * req.shop / req.shopId — used on public portal routes where there's no
 * Shopify session to populate req.shop via verifyShopifySession.
 */
async function loadShopFromBody(req, res, next) {
  const shopId = req.body?.shopId || req.params?.shopId;
  if (!shopId) {
    return res.status(400).json({ error: 'shopId is required' });
  }
  try {
    const shop = await prisma.shop.findUnique({ where: { id: shopId } });
    if (!shop) return res.status(404).json({ error: 'Shop not found' });
    req.shop = shop;
    req.shopId = shop.id;
    next();
  } catch (err) {
    return res.status(500).json({ error: 'Failed to load shop' });
  }
}

/**
 * Middleware to check if the shop's plan allows a specific feature.
 * Requires req.shop to be set (by verifyShopifySession or loadShopFromBody).
 * Usage: router.post('/returns', planGate('createReturn'), handler)
 */
function planGate(feature) {
  return async (req, res, next) => {
    let shop = req.shop;
    if (!shop) {
      return res.status(401).json({ error: 'Shop not authenticated' });
    }

    const limits = PLAN_LIMITS[shop.plan] || PLAN_LIMITS.FREE;

    if (feature === 'createReturn' && Number.isFinite(limits.returnsPerMonth)) {
      try {
        shop = await rollCycle(shop);
        req.shop = shop;
      } catch (err) {
        return res.status(500).json({ error: 'Failed to check plan usage' });
      }
    }

    // Fast path. The count that actually enforces the limit is the atomic
    // reservation in ReturnService.createReturn, so two requests arriving
    // together cannot both slip under it.
    if (feature === 'createReturn' && shop.returnCount >= limits.returnsPerMonth) {
      return res.status(403).json({
        error: 'Monthly return limit reached',
        limit: limits.returnsPerMonth,
        plan: shop.plan,
        upgradeRequired: true,
      });
    }

    if (feature === 'exchanges' && !limits.exchanges) {
      return res.status(403).json({
        error: 'Exchanges require Starter plan or higher',
        plan: shop.plan,
        upgradeRequired: true,
      });
    }

    if (feature === 'analytics' && !limits.analytics) {
      return res.status(403).json({
        error: 'Full analytics require Growth plan or higher',
        plan: shop.plan,
        upgradeRequired: true,
      });
    }

    req.planLimits = limits;
    next();
  };
}

module.exports = { planGate, loadShopFromBody, rollCycle, cycleExpired, PLAN_LIMITS, CYCLE_MS };
