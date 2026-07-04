const { installPrismaMock, installShopifyMock, fakeReturn, fakeShop, fakeReturnItem } = require('../helpers');
const { encrypt } = require('../../app/utils/encryption');

let prisma;
let shopifyClient;
let RefundService;
let eventBus;
const { REFUND_PROCESSED } = require('../../app/events/emitters');

beforeEach(() => {
  jest.resetModules();
  prisma = installPrismaMock();
  shopifyClient = installShopifyMock();

  // ExchangeService is required via lazy require inside RefundService; stub it
  jest.doMock('../../app/services/ExchangeService', () => ({
    createExchange: jest.fn().mockResolvedValue({ type: 'EXCHANGE', draftOrderId: 'do_1' }),
  }));

  RefundService = require('../../app/services/RefundService');
  eventBus = require('../../app/events/eventBus');
});

function ret(overrides = {}) {
  return fakeReturn({
    shop: fakeShop({ shopifyToken: encrypt('shpat_fake_token') }),
    items: [fakeReturnItem({ quantity: 1, unitPrice: 50 })],
    totalValue: 50,
    returnFee: 0,
    ...overrides,
  });
}

describe('RefundService.processRefund — dispatch', () => {
  it('throws when the return record is missing', async () => {
    prisma.return.findUnique.mockResolvedValue(null);
    await expect(RefundService.processRefund('missing')).rejects.toThrow(/not found/);
  });

  it('throws when the return is already PROCESSED', async () => {
    prisma.return.findUnique.mockResolvedValue(ret({ status: 'PROCESSED' }));
    await expect(RefundService.processRefund('ret_test_1')).rejects.toThrow(/already processed/);
  });

  it('throws for an unknown resolution', async () => {
    prisma.return.findUnique.mockResolvedValue(ret({ resolution: 'WAT' }));
    await expect(RefundService.processRefund('ret_test_1')).rejects.toThrow(/Unknown resolution/);
  });
});

describe('RefundService.processRefund — REFUND path', () => {
  it('calls refundCreate, updates status, emits REFUND_PROCESSED', async () => {
    prisma.return.findUnique.mockResolvedValue(ret({ resolution: 'REFUND', returnFee: 0 }));
    prisma.return.update.mockResolvedValue({});
    shopifyClient.request
      .mockResolvedValueOnce({
        data: { order: { transactions: [{ id: 'gid://shopify/OrderTransaction/1', kind: 'SALE', status: 'SUCCESS', gateway: 'shopify_payments', amountSet: { shopMoney: { amount: '50.00' } } }] } },
      })
      .mockResolvedValueOnce({
        data: { refundCreate: { refund: { id: 'gid://shopify/Refund/9' }, userErrors: [] } },
      });
    const emit = jest.spyOn(eventBus, 'emit');

    const result = await RefundService.processRefund('ret_test_1');

    expect(shopifyClient.request.mock.calls[0][0]).toMatch(/orderTransactions/);
    expect(shopifyClient.request.mock.calls[1][0]).toMatch(/refundCreate/);
    // Regression: without a transactions array Shopify only restocks — no
    // money moves. The refund must be issued against the original payment.
    const input = shopifyClient.request.mock.calls[1][1].variables.input;
    expect(input.transactions).toEqual([
      expect.objectContaining({ parentId: 'gid://shopify/OrderTransaction/1', kind: 'REFUND', amount: '50' }),
    ]);
    expect(result.shopifyRefundId).toBe('gid://shopify/Refund/9');
    expect(prisma.return.update).toHaveBeenCalledWith({
      where: { id: 'ret_test_1' },
      data: expect.objectContaining({ status: 'PROCESSED', refundAmount: 50, processedAt: expect.any(Date) }),
    });
    expect(emit).toHaveBeenCalledWith(REFUND_PROCESSED, expect.objectContaining({
      returnId: 'ret_test_1', refundAmount: 50, resolution: 'REFUND',
    }));
  });

  it('subtracts returnFee from the refund amount', async () => {
    prisma.return.findUnique.mockResolvedValue(ret({ resolution: 'REFUND', returnFee: 5 }));
    prisma.return.update.mockResolvedValue({});
    shopifyClient.request.mockResolvedValue({
      data: { refundCreate: { refund: { id: 'r' }, userErrors: [] } },
    });

    await RefundService.processRefund('ret_test_1');

    expect(prisma.return.update.mock.calls[0][0].data.refundAmount).toBe(45);
  });

  it('processes demo returns without calling Shopify', async () => {
    prisma.return.findUnique.mockResolvedValue(ret({ resolution: 'REFUND', shopifyOrderId: 'demo' }));
    prisma.return.update.mockResolvedValue({});

    const result = await RefundService.processRefund('ret_test_1');

    expect(shopifyClient.request).not.toHaveBeenCalled();
    expect(result.demo).toBe(true);
    expect(prisma.return.update.mock.calls[0][0].data.status).toBe('PROCESSED');
  });

  // Regression for the Shopify review rejection: returns stored with a
  // placeholder order id ('pending') were passed straight into refundCreate,
  // which 500'd with "Invalid global id 'pending'". Any non-real order gid
  // must be processed locally, never sent to Shopify.
  it.each(['pending', 'gid://shopify/Order/demo', ''])(
    'processes returns with non-real order id %j locally, without calling Shopify',
    async (orderId) => {
      prisma.return.findUnique.mockResolvedValue(ret({ resolution: 'REFUND', shopifyOrderId: orderId }));
      prisma.return.update.mockResolvedValue({});

      const result = await RefundService.processRefund('ret_test_1');

      expect(shopifyClient.request).not.toHaveBeenCalled();
      expect(result.success).toBe(true);
      expect(prisma.return.update.mock.calls[0][0].data.status).toBe('PROCESSED');
    },
  );

  it('caps the refund transaction at the captured payment amount', async () => {
    prisma.return.findUnique.mockResolvedValue(ret({ resolution: 'REFUND', totalValue: 80 }));
    prisma.return.update.mockResolvedValue({});
    shopifyClient.request
      .mockResolvedValueOnce({
        data: { order: { transactions: [{ id: 't1', kind: 'CAPTURE', status: 'SUCCESS', gateway: 'card', amountSet: { shopMoney: { amount: '60.00' } } }] } },
      })
      .mockResolvedValueOnce({
        data: { refundCreate: { refund: { id: 'r' }, userErrors: [] } },
      });

    await RefundService.processRefund('ret_test_1');

    const input = shopifyClient.request.mock.calls[1][1].variables.input;
    expect(input.transactions[0].amount).toBe('60');
  });

  it('falls back to restock-only when no successful payment transaction exists', async () => {
    prisma.return.findUnique.mockResolvedValue(ret({ resolution: 'REFUND' }));
    prisma.return.update.mockResolvedValue({});
    shopifyClient.request
      .mockResolvedValueOnce({ data: { order: { transactions: [] } } })
      .mockResolvedValueOnce({ data: { refundCreate: { refund: { id: 'r' }, userErrors: [] } } });

    await RefundService.processRefund('ret_test_1');

    const input = shopifyClient.request.mock.calls[1][1].variables.input;
    expect(input.transactions).toBeUndefined();
  });

  it('still calls Shopify for a real order gid', async () => {
    prisma.return.findUnique.mockResolvedValue(ret({ resolution: 'REFUND', shopifyOrderId: 'gid://shopify/Order/123456789' }));
    prisma.return.update.mockResolvedValue({});
    shopifyClient.request.mockResolvedValue({
      data: { refundCreate: { refund: { id: 'r' }, userErrors: [] } },
    });

    await RefundService.processRefund('ret_test_1');
    expect(shopifyClient.request).toHaveBeenCalled();
  });

  it('never refunds a negative amount when the fee exceeds item value', async () => {
    prisma.return.findUnique.mockResolvedValue(ret({ resolution: 'REFUND', totalValue: 3, returnFee: 5 }));
    prisma.return.update.mockResolvedValue({});
    shopifyClient.request.mockResolvedValue({
      data: { refundCreate: { refund: { id: 'r' }, userErrors: [] } },
    });

    await RefundService.processRefund('ret_test_1');

    expect(prisma.return.update.mock.calls[0][0].data.refundAmount).toBe(0);
  });

  it('throws when Shopify returns userErrors', async () => {
    prisma.return.findUnique.mockResolvedValue(ret({ resolution: 'REFUND' }));
    shopifyClient.request.mockResolvedValue({
      data: { refundCreate: { userErrors: [{ field: 'orderId', message: 'invalid' }] } },
    });
    await expect(RefundService.processRefund('ret_test_1')).rejects.toThrow(/Shopify refund/);
  });
});

describe('RefundService.processRefund — STORE_CREDIT path', () => {
  it('creates a gift card and returns last 4 characters', async () => {
    prisma.return.findUnique.mockResolvedValue(ret({ resolution: 'STORE_CREDIT' }));
    prisma.return.update.mockResolvedValue({});
    shopifyClient.request.mockResolvedValue({
      data: {
        giftCardCreate: {
          giftCard: { id: 'gid://shopify/GiftCard/7', lastCharacters: '1234', balance: { amount: '50', currencyCode: 'GBP' } },
          userErrors: [],
        },
      },
    });

    const result = await RefundService.processRefund('ret_test_1');
    expect(result.type).toBe('STORE_CREDIT');
    expect(result.giftCardId).toBe('gid://shopify/GiftCard/7');
    expect(result.lastCharacters).toBe('1234');
  });

  it('throws on giftCardCreate userErrors', async () => {
    prisma.return.findUnique.mockResolvedValue(ret({ resolution: 'STORE_CREDIT' }));
    shopifyClient.request.mockResolvedValue({
      data: { giftCardCreate: { userErrors: [{ message: 'value too high' }] } },
    });
    await expect(RefundService.processRefund('ret_test_1')).rejects.toThrow(/value too high/);
  });
});

describe('RefundService.processRefund — EXCHANGE path', () => {
  it('delegates to ExchangeService.createExchange and still marks PROCESSED', async () => {
    prisma.return.findUnique.mockResolvedValue(ret({ resolution: 'EXCHANGE' }));
    prisma.return.update.mockResolvedValue({});
    const ExchangeService = require('../../app/services/ExchangeService');

    const result = await RefundService.processRefund('ret_test_1');
    expect(ExchangeService.createExchange).toHaveBeenCalledWith('ret_test_1');
    expect(result.type).toBe('EXCHANGE');
  });
});
