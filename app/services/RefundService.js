const prisma = require('../config/database');
const shopify = require('../config/shopify');
const { decrypt } = require('../utils/encryption');
const eventBus = require('../events/eventBus');
const { REFUND_PROCESSED } = require('../events/emitters');
const logger = require('../utils/logger');

class RefundService {
  /**
   * Process a refund for a return via Shopify GraphQL API.
   */
  static async processRefund(returnId) {
    const returnRecord = await prisma.return.findUnique({
      where: { id: returnId },
      include: { items: true, shop: true },
    });

    if (!returnRecord) throw new Error(`Return ${returnId} not found`);
    if (returnRecord.status === 'PROCESSED') throw new Error('Return already processed');

    const shop = returnRecord.shop;
    const resolution = returnRecord.resolution;
    const totalValue = Number(returnRecord.totalValue);
    const fee = Number(returnRecord.returnFee || 0);
    // Return fees are recovered by reducing the refund (Shopify-native — no
    // off-platform charge). Never refund a negative amount if the fee somehow
    // exceeds the item value.
    const refundAmount = Math.max(0, totalValue - fee);

    // Demo / test-mode returns have no real Shopify order, so skip the Shopify
    // mutation and just mark them processed — lets merchants walk the full flow.
    if (returnRecord.shopifyOrderId === 'demo') {
      await prisma.return.update({
        where: { id: returnId },
        data: { status: 'PROCESSED', refundAmount, processedAt: new Date() },
      });
      eventBus.emit(REFUND_PROCESSED, { returnId, refundAmount, resolution });
      logger.info({ returnId, resolution, refundAmount }, 'Demo return processed (no Shopify call)');
      return { success: true, type: resolution, demo: true, amount: refundAmount };
    }

    const accessToken = decrypt(shop.shopifyToken);
    const session = { shop: shop.shopifyDomain, accessToken };
    const client = new shopify.clients.Graphql({ session });

    let result;
    switch (resolution) {
      case 'REFUND':
        result = await RefundService._processOriginalRefund(client, returnRecord, refundAmount);
        break;
      case 'STORE_CREDIT':
        result = await RefundService._processStoreCredit(client, returnRecord, refundAmount);
        break;
      case 'EXCHANGE':
        result = await RefundService._processExchange(client, returnRecord);
        break;
      default:
        throw new Error(`Unknown resolution: ${resolution}`);
    }

    await prisma.return.update({
      where: { id: returnId },
      data: {
        status: 'PROCESSED',
        refundAmount,
        processedAt: new Date(),
      },
    });

    eventBus.emit(REFUND_PROCESSED, { returnId, refundAmount, resolution });
    logger.info({ returnId, resolution, refundAmount }, 'Refund processed');
    return result;
  }

  static async _processOriginalRefund(client, returnRecord, amount) {
    const response = await client.request(`
      mutation refundCreate($input: RefundInput!) {
        refundCreate(input: $input) {
          refund {
            id
            totalRefundedSet { shopMoney { amount currencyCode } }
          }
          userErrors { field message }
        }
      }
    `, {
      variables: {
        input: {
          orderId: returnRecord.shopifyOrderId,
          note: `ReturnFlow return #${returnRecord.id}`,
          shipping: { fullRefund: false },
          refundLineItems: returnRecord.items.map((item) => ({
            lineItemId: item.shopifyLineItemId,
            quantity: item.quantity,
          })),
        },
      },
    });

    const errors = response.data?.refundCreate?.userErrors || [];
    if (errors.length > 0) {
      throw new Error(`Shopify refund error: ${errors.map((e) => e.message).join(', ')}`);
    }

    return {
      success: true,
      type: 'REFUND',
      shopifyRefundId: response.data?.refundCreate?.refund?.id,
      amount,
    };
  }

  static async _processStoreCredit(client, returnRecord, amount) {
    const response = await client.request(`
      mutation giftCardCreate($input: GiftCardCreateInput!) {
        giftCardCreate(input: $input) {
          giftCard {
            id
            lastCharacters
            balance { amount currencyCode }
          }
          userErrors { field message }
        }
      }
    `, {
      variables: {
        input: {
          initialValue: String(amount),
          note: `Store credit for return #${returnRecord.id}`,
        },
      },
    });

    const errors = response.data?.giftCardCreate?.userErrors || [];
    if (errors.length > 0) {
      throw new Error(`Gift card error: ${errors.map((e) => e.message).join(', ')}`);
    }

    const giftCard = response.data?.giftCardCreate?.giftCard;
    return {
      success: true,
      type: 'STORE_CREDIT',
      giftCardId: giftCard?.id,
      lastCharacters: giftCard?.lastCharacters,
      amount,
    };
  }

  static async _processExchange(client, returnRecord) {
    const ExchangeService = require('./ExchangeService');
    return ExchangeService.createExchange(returnRecord.id);
  }
}

module.exports = RefundService;
