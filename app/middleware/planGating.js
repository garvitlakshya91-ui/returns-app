const PLAN_LIMITS = {
  FREE: { returnsPerMonth: 30, carriers: 1, exchanges: false, analytics: false },
  STARTER: { returnsPerMonth: 150, carriers: 3, exchanges: true, analytics: false },
  GROWTH: { returnsPerMonth: Infinity, carriers: 10, exchanges: true, analytics: true },
  PRO: { returnsPerMonth: Infinity, carriers: 10, exchanges: true, analytics: true },
};

/**
 * Middleware to check if the shop's plan allows a specific feature.
 * Usage: router.post('/returns', planGate('createReturn'), handler)
 */
function planGate(feature) {
  return (req, res, next) => {
    const shop = req.shop;
    if (!shop) {
      return res.status(401).json({ error: 'Shop not authenticated' });
    }

    const limits = PLAN_LIMITS[shop.plan] || PLAN_LIMITS.FREE;

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

module.exports = { planGate, PLAN_LIMITS };
