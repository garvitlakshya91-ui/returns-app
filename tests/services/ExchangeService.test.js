const { installPrismaMock, installShopifyMock, fakeReturn, fakeShop, fakeReturnItem } = require('../helpers');
const { encrypt } = require('../../app/utils/encryption');

let prisma;
let shopifyClient;
let ExchangeService;
let eventBus;
const { EXCHANGE_CREATED } = require('../../app/events/emitters');

beforeEach(() => {
  jest.resetModules();
  prisma = installPrismaMock();
  shopifyClient = installShopifyMock();
  ExchangeService = require('../../app/services/ExchangeService');
  eventBus = require('../../app/events/eventBus');
});

function ret(items, overrides = {}) {
  return fakeReturn({
    shop: fakeShop({ shopifyToken: encrypt('shpat_fake_token') }),
    items,
    ...overrides,
  });
}

describe('ExchangeService.createExchange', () => {
  it('throws when no items carry an exchangeVariantId', async () => {
    prisma.return.findUnique.mockResolvedValue(ret([fakeReturnItem({ exchangeVariantId: null })]));
    await expect(ExchangeService.createExchange('ret_test_1'))
      .rejects.toThrow(/No exchange variants/);
  });

  it('throws when the return is missing', async () => {
    prisma.return.findUnique.mockResolvedValue(null);
    await expect(ExchangeService.createExchange('missing')).rejects.toThrow(/not found/);
  });

  it('rejects when a variant is out of stock', async () => {
    prisma.return.findUnique.mockResolvedValue(ret([
      fakeReturnItem({ exchangeVariantId: 'gid://shopify/ProductVariant/9', quantity: 1 }),
    ]));
    shopifyClient.request.mockResolvedValueOnce({
      data: {
        nodes: [
          { id: 'gid://shopify/ProductVariant/9', availableForSale: true, inventoryQuantity: 0, displayName: 'Sold Out Tee / M' },
        ],
      },
    });
    await expect(ExchangeService.createExchange('ret_test_1'))
      .rejects.toThrow(/Sold Out Tee/);
  });

  it('rejects when availableForSale is false', async () => {
    prisma.return.findUnique.mockResolvedValue(ret([
      fakeReturnItem({ exchangeVariantId: 'gid://shopify/ProductVariant/9', quantity: 1 }),
    ]));
    shopifyClient.request.mockResolvedValueOnce({
      data: {
        nodes: [
          { id: 'gid://shopify/ProductVariant/9', availableForSale: false, inventoryQuantity: 10, displayName: 'Discontinued' },
        ],
      },
    });
    await expect(ExchangeService.createExchange('ret_test_1'))
      .rejects.toThrow(/Discontinued/);
  });

  it('creates a draft order, updates exchangeOrderId, and emits EXCHANGE_CREATED', async () => {
    prisma.return.findUnique.mockResolvedValue(ret([
      fakeReturnItem({ id: 'item_x', exchangeVariantId: 'gid://shopify/ProductVariant/9', quantity: 1 }),
    ]));
    shopifyClient.request
      .mockResolvedValueOnce({
        data: {
          nodes: [
            { id: 'gid://shopify/ProductVariant/9', availableForSale: true, inventoryQuantity: 10, displayName: 'OK Tee' },
          ],
        },
      })
      .mockResolvedValueOnce({
        data: {
          draftOrderCreate: {
            draftOrder: {
              id: 'gid://shopify/DraftOrder/100',
              name: '#D1001',
              invoiceUrl: 'https://shop.myshopify.com/admin/draft_orders/100/invoice',
              totalPriceSet: { shopMoney: { amount: '0.00' } },
            },
            userErrors: [],
          },
        },
      });
    prisma.returnItem.update.mockResolvedValue({});
    const emit = jest.spyOn(eventBus, 'emit');

    const result = await ExchangeService.createExchange('ret_test_1');

    expect(result.draftOrderId).toBe('gid://shopify/DraftOrder/100');
    expect(result.draftOrderName).toBe('#D1001');
    expect(result.invoiceUrl).toContain('/invoice');
    expect(prisma.returnItem.update).toHaveBeenCalledWith({
      where: { id: 'item_x' },
      data: { exchangeOrderId: 'gid://shopify/DraftOrder/100' },
    });
    expect(emit).toHaveBeenCalledWith(EXCHANGE_CREATED, expect.objectContaining({
      returnId: 'ret_test_1',
      draftOrderId: 'gid://shopify/DraftOrder/100',
    }));
  });

  it('adds the return fee as a custom draft-order line item when fee > 0', async () => {
    prisma.return.findUnique.mockResolvedValue(ret([
      fakeReturnItem({ id: 'item_x', exchangeVariantId: 'gid://shopify/ProductVariant/9', quantity: 1 }),
    ], { returnFee: 2.5, currency: 'GBP' }));
    shopifyClient.request
      .mockResolvedValueOnce({
        data: { nodes: [{ id: 'gid://shopify/ProductVariant/9', availableForSale: true, inventoryQuantity: 10, displayName: 'OK Tee' }] },
      })
      .mockResolvedValueOnce({
        data: {
          draftOrderCreate: {
            draftOrder: { id: 'gid://shopify/DraftOrder/100', name: '#D1001', invoiceUrl: 'https://x/invoice', totalPriceSet: { shopMoney: { amount: '2.50' } } },
            userErrors: [],
          },
        },
      });
    prisma.returnItem.update.mockResolvedValue({});

    await ExchangeService.createExchange('ret_test_1');

    // Second request is the draftOrderCreate mutation; inspect its variables.
    const draftCall = shopifyClient.request.mock.calls[1];
    const lineItems = draftCall[1].variables.input.lineItems;
    const feeLine = lineItems.find((li) => li.title === 'Return fee');
    expect(feeLine).toBeDefined();
    expect(feeLine.originalUnitPriceWithCurrency).toEqual({ amount: 2.5, currencyCode: 'GBP' });
  });

  it('does NOT add a fee line item when fee is 0', async () => {
    prisma.return.findUnique.mockResolvedValue(ret([
      fakeReturnItem({ id: 'item_x', exchangeVariantId: 'gid://shopify/ProductVariant/9', quantity: 1 }),
    ], { returnFee: 0 }));
    shopifyClient.request
      .mockResolvedValueOnce({
        data: { nodes: [{ id: 'gid://shopify/ProductVariant/9', availableForSale: true, inventoryQuantity: 10, displayName: 'OK Tee' }] },
      })
      .mockResolvedValueOnce({
        data: { draftOrderCreate: { draftOrder: { id: 'd', name: '#D1', invoiceUrl: 'u', totalPriceSet: { shopMoney: { amount: '0.00' } } }, userErrors: [] } },
      });
    prisma.returnItem.update.mockResolvedValue({});

    await ExchangeService.createExchange('ret_test_1');

    const lineItems = shopifyClient.request.mock.calls[1][1].variables.input.lineItems;
    expect(lineItems.some((li) => li.title === 'Return fee')).toBe(false);
  });

  it('throws when draftOrderCreate returns userErrors', async () => {
    prisma.return.findUnique.mockResolvedValue(ret([
      fakeReturnItem({ exchangeVariantId: 'gid://shopify/ProductVariant/9', quantity: 1 }),
    ]));
    shopifyClient.request
      .mockResolvedValueOnce({
        data: { nodes: [{ id: 'gid://shopify/ProductVariant/9', availableForSale: true, inventoryQuantity: 5, displayName: 'X' }] },
      })
      .mockResolvedValueOnce({
        data: { draftOrderCreate: { userErrors: [{ field: 'lineItems', message: 'invalid variantId' }] } },
      });
    await expect(ExchangeService.createExchange('ret_test_1'))
      .rejects.toThrow(/invalid variantId/);
  });
});
