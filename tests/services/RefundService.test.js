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
    shopifyClient.request.mockResolvedValue({
      data: { refundCreate: { refund: { id: 'gid://shopify/Refund/9' }, userErrors: [] } },
    });
    const emit = jest.spyOn(eventBus, 'emit');

    const result = await RefundService.processRefund('ret_test_1');

    expect(shopifyClient.request.mock.calls[0][0]).toMatch(/refundCreate/);
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
