const prisma = require('../config/database');
const eventBus = require('../events/eventBus');
const { RETURN_CREATED } = require('../events/emitters');
const { computeReturnFeeForItems } = require('../utils/fees');
const { PLAN_LIMITS } = require('../middleware/planGating');

// Return statuses that still hold units of an order (see ReturnValidation).
const CLAIMING_STATUSES = ['REQUESTED', 'APPROVED', 'LABEL_SENT', 'IN_TRANSIT', 'RECEIVED', 'INSPECTING'];

class QuantityExceededError extends Error {
  constructor(title) {
    super(`Only part of "${title}" can still be returned — another return already covers the rest`);
    this.code = 'QUANTITY_EXCEEDED';
    this.status = 409;
  }
}

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
    // Items that already carry the fees of the policy that matched them
    // (from ReturnValidation) use those; anything else uses the shop default.
    const needDefault = !Array.isArray(items) || items.some((i) => !i.policyFees);
    const policy = needDefault
      ? await prisma.returnPolicy.findFirst({ where: { shopId, isActive: true }, orderBy: { isDefault: 'desc' } })
      : null;
    return computeReturnFeeForItems(items, policy?.fees);
  }

  /**
   * Create a new return request from the customer portal.
   */
  static async createReturn({ shopId, shopifyOrderId, shopifyOrderName, customerEmail, customerName, items, resolution, currency }) {
    const totalValue = Math.round(items.reduce((sum, item) => sum + item.unitPrice * item.quantity, 0) * 100) / 100;

    const returnFee = await ReturnService.quoteFee(shopId, items);

    const shop = await prisma.shop.findUnique({ where: { id: shopId } });
    if (!shop) throw new Error(`Shop ${shopId} not found`);
    const limit = (PLAN_LIMITS[shop.plan] || PLAN_LIMITS.FREE).returnsPerMonth;

    // Everything that must not race runs in one transaction holding a
    // per-order lock: two submissions for the same order are serialised, so
    // the second sees the first's claim on the units. The quota slot is
    // reserved in the same transaction and rolls back with it.
    const returnRecord = await prisma.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`returnflow:order:${shopifyOrderId}`}))`;

      const limited = items.filter((i) => Number.isFinite(i.refundableQuantity));
      if (limited.length > 0) {
        const open = await tx.return.findMany({
          where: { shopId, shopifyOrderId, status: { in: CLAIMING_STATUSES } },
          include: { items: true },
        });
        const claimed = {};
        for (const ret of open) {
          for (const it of ret.items) claimed[it.shopifyLineItemId] = (claimed[it.shopifyLineItemId] || 0) + it.quantity;
        }
        for (const item of limited) {
          if ((claimed[item.lineItemId] || 0) + item.quantity > item.refundableQuantity) {
            throw new QuantityExceededError(item.productTitle);
          }
        }
      }

      // Reserve a slot in the monthly quota atomically: the increment only
      // happens while the count is still under the limit.
      const reserved = await tx.shop.updateMany({
        where: { id: shopId, ...(Number.isFinite(limit) ? { returnCount: { lt: limit } } : {}) },
        data: { returnCount: { increment: 1 } },
      });
      if (reserved.count === 0) throw new QuotaExceededError(limit, shop.plan);

      return tx.return.create({
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
    });

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
ReturnService.QuantityExceededError = QuantityExceededError;

module.exports = ReturnService;
