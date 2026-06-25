const prisma = require('../config/database');
const eventBus = require('../events/eventBus');
const { RETURN_CREATED } = require('../events/emitters');
const { computeReturnFee } = require('../utils/fees');

class ReturnService {
  /**
   * Create a new return request from the customer portal.
   */
  static async createReturn({ shopId, shopifyOrderId, shopifyOrderName, customerEmail, customerName, items, resolution }) {
    const totalValue = items.reduce((sum, item) => sum + item.unitPrice * item.quantity, 0);

    // Compute the return fee from the shop's default active policy. The fee is
    // never charged to the buyer directly (Shopify prohibits off-platform
    // payments) — it's deducted from the refund / store credit, or added to the
    // exchange's Shopify draft order at process time.
    const policy = await prisma.returnPolicy.findFirst({
      where: { shopId, isActive: true },
      orderBy: { isDefault: 'desc' },
    });
    const returnFee = computeReturnFee(policy?.fees, items);

    const returnRecord = await prisma.return.create({
      data: {
        shopId,
        shopifyOrderId,
        shopifyOrderName,
        customerEmail,
        customerName,
        totalValue,
        returnFee,
        resolution,
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

    // Increment shop return count
    await prisma.shop.update({
      where: { id: shopId },
      data: { returnCount: { increment: 1 } },
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

module.exports = ReturnService;
