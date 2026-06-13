const prisma = require('../config/database');

class PolicyEngine {
  /**
   * Evaluate whether an order item is eligible for return.
   * Checks against the shop's active return policies.
   */
  static async evaluateEligibility(shopId, orderItem, fulfilledAt) {
    const policies = await prisma.returnPolicy.findMany({
      where: { shopId, isActive: true },
      orderBy: { isDefault: 'desc' },
    });

    if (policies.length === 0) {
      return { eligible: false, reason: 'No active return policy' };
    }

    // Find the first matching policy
    for (const policy of policies) {
      const match = PolicyEngine.matchesConditions(policy.conditions, orderItem);
      if (match || policy.isDefault) {
        // Check return window
        const windowEnd = new Date(fulfilledAt);
        windowEnd.setDate(windowEnd.getDate() + policy.windowDays);

        if (new Date() > windowEnd) {
          return {
            eligible: false,
            reason: `Return window expired (${policy.windowDays} days)`,
            policy,
          };
        }

        return {
          eligible: true,
          policy,
          resolutions: policy.resolutions,
          fees: policy.fees,
        };
      }
    }

    return { eligible: false, reason: 'No matching policy' };
  }

  /**
   * Check if an order item matches policy conditions.
   */
  static matchesConditions(conditions, orderItem) {
    if (!conditions) return true;

    const { productTags, collections, minPrice, maxPrice } = conditions;

    if (productTags?.length && !productTags.some((tag) => orderItem.tags?.includes(tag))) {
      return false;
    }
    if (collections?.length && !collections.some((col) => orderItem.collections?.includes(col))) {
      return false;
    }
    if (minPrice != null && orderItem.price < minPrice) return false;
    if (maxPrice != null && orderItem.price > maxPrice) return false;

    return true;
  }
}

module.exports = PolicyEngine;
