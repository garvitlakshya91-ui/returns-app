const prisma = require('../config/database');
const shopify = require('../config/shopify');
const { decrypt } = require('../utils/encryption');
const eventBus = require('../events/eventBus');
const { EXCHANGE_CREATED } = require('../events/emitters');
const logger = require('../utils/logger');

class ExchangeService {
  /**
   * Create a Shopify Draft Order for the exchange variants on a return.
   * Returns { draftOrderId, draftOrderName, invoiceUrl }.
   */
  static async createExchange(returnId) {
    const returnRecord = await prisma.return.findUnique({
      where: { id: returnId },
      include: { items: true, shop: true },
    });
    if (!returnRecord) throw new Error(`Return ${returnId} not found`);

    const exchangeItems = returnRecord.items.filter((item) => item.exchangeVariantId);
    if (exchangeItems.length === 0) {
      throw new Error('No exchange variants specified on any return item');
    }

    const accessToken = decrypt(returnRecord.shop.shopifyToken);
    const session = { shop: returnRecord.shop.shopifyDomain, accessToken };
    const client = new shopify.clients.Graphql({ session });

    await ExchangeService._assertVariantsAvailable(client, exchangeItems);

    const lineItems = exchangeItems.map((item) => ({
      variantId: item.exchangeVariantId,
      quantity: item.quantity,
    }));

    // Add the return fee as a custom line item on the draft order so the buyer
    // pays it through Shopify checkout (compliant) rather than an external
    // processor. Refund/store-credit returns net the fee off the refund
    // instead; exchanges have no refund to deduct from, so we bill it here.
    const fee = Number(returnRecord.returnFee || 0);
    if (fee > 0) {
      lineItems.push({
        title: 'Return fee',
        quantity: 1,
        requiresShipping: false,
        taxable: false,
        originalUnitPriceWithCurrency: {
          amount: fee,
          currencyCode: returnRecord.currency || 'GBP',
        },
      });
    }

    const response = await client.request(`
      mutation draftOrderCreate($input: DraftOrderInput!) {
        draftOrderCreate(input: $input) {
          draftOrder {
            id
            name
            invoiceUrl
            totalPriceSet { shopMoney { amount } }
          }
          userErrors { field message }
        }
      }
    `, {
      variables: {
        input: {
          lineItems,
          note: `Exchange for ReturnFlow return #${returnRecord.id}`,
          email: returnRecord.customerEmail,
          tags: ['returnflow-exchange'],
        },
      },
    });

    const errors = response.data?.draftOrderCreate?.userErrors || [];
    if (errors.length > 0) {
      throw new Error(`Draft order error: ${errors.map((e) => e.message).join(', ')}`);
    }

    const draftOrder = response.data?.draftOrderCreate?.draftOrder;

    for (const item of exchangeItems) {
      await prisma.returnItem.update({
        where: { id: item.id },
        data: { exchangeOrderId: draftOrder?.id },
      });
    }

    eventBus.emit(EXCHANGE_CREATED, {
      returnId,
      draftOrderId: draftOrder?.id,
      draftOrderName: draftOrder?.name,
    });
    logger.info({ returnId, draftOrderId: draftOrder?.id }, 'Exchange draft order created');

    return {
      success: true,
      type: 'EXCHANGE',
      draftOrderId: draftOrder?.id,
      draftOrderName: draftOrder?.name,
      invoiceUrl: draftOrder?.invoiceUrl,
    };
  }

  /**
   * Reject the exchange if any selected variant is out of stock or unavailable.
   * Shopify will create the draft order anyway with inventory <= 0, so we
   * pre-check rather than discovering at checkout time.
   */
  static async _assertVariantsAvailable(client, exchangeItems) {
    const variantIds = exchangeItems.map((i) => i.exchangeVariantId).filter(Boolean);
    if (variantIds.length === 0) return;

    const response = await client.request(`
      query VariantAvailability($ids: [ID!]!) {
        nodes(ids: $ids) {
          ... on ProductVariant {
            id
            availableForSale
            inventoryQuantity
            displayName
          }
        }
      }
    `, { variables: { ids: variantIds } });

    const unavailable = (response.data?.nodes || []).filter(
      (n) => n && (!n.availableForSale || n.inventoryQuantity <= 0),
    );

    if (unavailable.length > 0) {
      const names = unavailable.map((n) => n.displayName).join(', ');
      throw new Error(`Exchange variants out of stock: ${names}`);
    }
  }
}

module.exports = ExchangeService;
