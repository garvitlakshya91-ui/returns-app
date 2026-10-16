const eventBus = require('../eventBus');
const { SHOP_INSTALLED } = require('../emitters');
const prisma = require('../../config/database');
const logger = require('../../utils/logger');

// What a new shop starts with: 30 days, refunds and store credit, no fees.
// Without a policy every lookup says "No active return policy" and the
// merchant looks ready while customers can return nothing.
const DEFAULT_POLICY = {
  name: 'Standard returns',
  windowDays: 30,
  conditions: {},
  resolutions: { allowRefund: true, allowStoreCredit: true, allowExchange: false },
  fees: { changedMind: 0, doesntFit: 0, damaged: 0 },
  isDefault: true,
  isActive: true,
};

/** Create the default policy for a shop that has none. Returns it, or null if one existed. */
async function ensureDefaultPolicy(shopId) {
  const existing = await prisma.returnPolicy.count({ where: { shopId } });
  if (existing > 0) return null;
  const policy = await prisma.returnPolicy.create({ data: { shopId, ...DEFAULT_POLICY } });
  logger.info({ shopId, policyId: policy.id }, 'Default return policy created');
  return policy;
}

eventBus.on(SHOP_INSTALLED, async ({ shopId, shopDomain }) => {
  try {
    await ensureDefaultPolicy(shopId);
  } catch (err) {
    logger.error({ err: err.message, shopId, shopDomain }, 'Could not create the default return policy');
  }
});

module.exports = { ensureDefaultPolicy, DEFAULT_POLICY };
