const prisma = require('../config/database');
const eventBus = require('../events/eventBus');
const { RETURN_CREATED } = require('../events/emitters');
const { computeReturnFee } = require('../utils/fees');
const { PLAN_LIMITS } = require('../middleware/planGating');

class QuotaExceededError extends Error {
  constructor(limit, plan) {
    super('Monthly return limit reached');
    this.code = 'QUOTA_EXCEEDED';
    this.limit = limit;
    this.plan = plan;
  }
}

class ReturnService {
  /**
   * The return fee the shop's default active policy charges for these items'
   * reasons. The fee is never charged to the buyer directly (Shopify
   * prohibits off-platform payments): it is deducted from the refund / store
   * credit, or added to the exchange's Shopify draft order at process time.
   */
  static async quoteFee(shopId, items) {
    const policy = await prisma.returnPolicy.findFirst({
      where: { shopId, isActive: true },
      orderBy: { isDefault: 'desc' },
    });
    return computeReturnFee(policy?.fees, items);
  }

  /**
   * Create a new return request from the customer portal.
   */
  static async createReturn({ shopId, shopifyOrderId, shopifyOrderName, customerEmail, customerName, items, resolution, currency }) {
    const totalValue = Math.round(items.reduce((sum, item) => sum + item.unitPrice * item.quantity, 0) * 100) / 100;

    const returnFee = await ReturnService.quoteFee(shopId, items);

    // Reserve a slot in the monthly quota atomically: the increment only
    // happens while the count is still under the limit, so concurrent
    // requests cannot both get in on the last slot.
    const shop = await prisma.shop.findUnique({ where: { id: shopId } });
    if (!shop) throw new Error(`Shop ${shopId} not found`);
    const limit = (PLAN_LIMITS[shop.plan] || PLAN_LIMITS.FREE).returnsPerMonth;
    const reserved = await prisma.shop.updateMany({
      where: { id: shopId, ...(Number.isFinite(limit) ? { returnCount: { lt: limit } } : {}) },
      data: { returnCount: { increment: 1 } },
    });
    if (reserved.count === 0) throw new QuotaExceededError(limit, shop.plan);

    let returnRecord;
    try {
      returnRecord = await prisma.return.create({
      data: {
        shopId,
        shopifyOrderId,
        shopifyOrderName,
        customerEmail,
        customerName,
        totalValue,
        returnFee,
        resolution,
        // The order's currency, so refunds and displays follow the order
        // rather than assuming GBP.
        ...(currency ? { currency } : {}),
        items: {
          create: items.map((item) => ({
            shopifyLineItemId: item.lineItemId,
            shopifyProductId: item.productId,
            shopifyVariantId: item.variantId,
            productTitle: item.productTitle,
            variantTitle: item.variantTitle,
            sku: item.sku,
            quantity: item.quantity,
            unitPrice: item.unitPrice,
            reason: item.reason,
            reasonDetail: item.reasonDetail,
            photoUrls: item.photoUrls || [],
          })),
        },
      },
      include: { items: true },
    });
    } catch (err) {
      // Give the slot back if the return itself could not be saved.
      await prisma.shop.updateMany({
        where: { id: shopId, returnCount: { gt: 0 } },
        data: { returnCount: { decrement: 1 } },
      }).catch(() => {});
      throw err;
    }

    eventBus.emit(RETURN_CREATED, { returnId: returnRecord.id, shopId });

    return returnRecord;
  }

  /**
   * Get a return by ID, scoped to shop.
   */
  static async getReturn(returnId, shopId) {
    return prisma.return.findFirst({
      where: { id: returnId, shopId },
      include: { items: true, label: true, events: { orderBy: { createdAt: 'desc' } } },
    });
  }

  /**
   * List returns for a shop with optional filters.
   */
  static async listReturns(shopId, { status, page = 1, limit = 20 } = {}) {
    const where = { shopId };
    if (status) where.status = status;

    const [returns, total] = await Promise.all([
      prisma.return.findMany({
        where,
        include: { items: true, label: true },
        orderBy: { createdAt: 'desc' },
        skip: (page - 1) * limit,
        take: limit,
      }),
      prisma.return.count({ where }),
    ]);

    return { returns, total, page, limit };
  }
}

ReturnService.QuotaExceededError = QuotaExceededError;

module.exports = ReturnService;
