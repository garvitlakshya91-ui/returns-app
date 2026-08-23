// RefundService — edge cases around the Shopify refund/gift-card branches:
// transaction selection, amount capping, error propagation (no partial
// state), session wiring, and the local "demo" path for each resolution.

const { installPrismaMock, installShopifyMock, fakeReturn, fakeShop, fakeReturnItem } = require('../helpers');
const { encrypt } = require('../../app/utils/encryption');
const { REFUND_PROCESSED } = require('../../app/events/emitters');

let prisma;
let shopifyClient;
let RefundService;
let eventBus;
let createExchange;

beforeEach(() => {
  jest.resetModules();
  prisma = installPrismaMock();
  shopifyClient = installShopifyMock();
  // Keep pino from spawning a pretty-print transport on every module reset.
  jest.doMock('../../app/utils/logger', () => ({ warn: jest.fn(), info: jest.fn(), error: jest.fn(), debug: jest.fn() }));
  createExchange = jest.fn().mockResolvedValue({ success: true, type: 'EXCHANGE', draftOrderId: 'do_1' });
  jest.doMock('../../app/services/ExchangeService', () => ({ createExchange }));
  RefundService = require('../../app/services/RefundService');
  eventBus = require('../../app/events/eventBus');
  prisma.return.update.mockResolvedValue({});
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

const tx = (over = {}) => ({
  id: 'gid://shopify/OrderTransaction/1', kind: 'SALE', status: 'SUCCESS', gateway: 'shopify_payments',
  amountSet: { shopMoney: { amount: '50.00' } }, ...over,
});

function mockRefundFlow(transactions, refundCreate = { refund: { id: 'gid://shopify/Refund/1' }, userErrors: [] }) {
  shopifyClient.request
    .mockResolvedValueOnce({ data: { order: { transactions } } })
    .mockResolvedValueOnce({ data: { refundCreate } });
}

const refundInput = () => shopifyClient.request.mock.calls[1][1].variables.input;

describe('REFUND — choosing the parent transaction', () => {
  it('skips AUTHORIZATION / VOID / FAILED transactions and restocks only when no SUCCESS sale exists', async () => {
    prisma.return.findUnique.mockResolvedValue(ret());
    mockRefundFlow([
      tx({ id: 'auth', kind: 'AUTHORIZATION' }),
      tx({ id: 'failed', kind: 'SALE', status: 'FAILURE' }),
      tx({ id: 'pending', kind: 'CAPTURE', status: 'PENDING' }),
      tx({ id: 'void', kind: 'VOID' }),
    ]);
    await RefundService.processRefund('ret_test_1');
    expect(refundInput().transactions).toBeUndefined();
  });

  it('uses the first successful SALE/CAPTURE, carrying its gateway through', async () => {
    prisma.return.findUnique.mockResolvedValue(ret());
    mockRefundFlow([
      tx({ id: 'auth', kind: 'AUTHORIZATION', gateway: 'paypal' }),
      tx({ id: 'cap', kind: 'CAPTURE', gateway: 'paypal', amountSet: { shopMoney: { amount: '50.00' } } }),
      tx({ id: 'sale2', kind: 'SALE', gateway: 'manual' }),
    ]);
    await RefundService.processRefund('ret_test_1');
    expect(refundInput().transactions).toEqual([{
      orderId: 'gid://shopify/Order/1', parentId: 'cap', kind: 'REFUND', gateway: 'paypal', amount: '50',
    }]);
  });

  it('refunds the full computed amount when the captured amount is unknown (no amountSet)', async () => {
    prisma.return.findUnique.mockResolvedValue(ret({ totalValue: 80 }));
    mockRefundFlow([tx({ amountSet: undefined })]);
    await RefundService.processRefund('ret_test_1');
    expect(refundInput().transactions[0].amount).toBe('80');
  });

  it('refunds the fee-adjusted amount (not the captured total) when that is lower', async () => {
    prisma.return.findUnique.mockResolvedValue(ret({ totalValue: 50, returnFee: 7.5 }));
    mockRefundFlow([tx({ amountSet: { shopMoney: { amount: '50.00' } } })]);
    await RefundService.processRefund('ret_test_1');
    expect(refundInput().transactions[0].amount).toBe('42.5');
    expect(prisma.return.update.mock.calls[0][0].data.refundAmount).toBe(42.5);
  });

  it('tolerates a transactions query that returns no order', async () => {
    prisma.return.findUnique.mockResolvedValue(ret());
    shopifyClient.request
      .mockResolvedValueOnce({ data: { order: null } })
      .mockResolvedValueOnce({ data: { refundCreate: { refund: { id: 'r' }, userErrors: [] } } });
    await expect(RefundService.processRefund('ret_test_1')).resolves.toMatchObject({ success: true, type: 'REFUND' });
    expect(refundInput().transactions).toBeUndefined();
  });

  it('queries transactions for the return’s order id', async () => {
    prisma.return.findUnique.mockResolvedValue(ret({ shopifyOrderId: 'gid://shopify/Order/987' }));
    mockRefundFlow([tx()]);
    await RefundService.processRefund('ret_test_1');
    expect(shopifyClient.request.mock.calls[0][1]).toEqual({ variables: { id: 'gid://shopify/Order/987' } });
    expect(refundInput().orderId).toBe('gid://shopify/Order/987');
  });
});

describe('REFUND — refundCreate input shaping', () => {
  it('maps every return item to a refund line item with its quantity, never refunds shipping, and notes the return id', async () => {
    prisma.return.findUnique.mockResolvedValue(ret({
      id: 'ret_xyz',
      items: [
        fakeReturnItem({ shopifyLineItemId: 'gid://shopify/LineItem/11', quantity: 2 }),
        fakeReturnItem({ shopifyLineItemId: 'gid://shopify/LineItem/12', quantity: 1 }),
      ],
    }));
    mockRefundFlow([tx()]);
    await RefundService.processRefund('ret_xyz');
    const input = refundInput();
    expect(input.refundLineItems).toEqual([
      { lineItemId: 'gid://shopify/LineItem/11', quantity: 2 },
      { lineItemId: 'gid://shopify/LineItem/12', quantity: 1 },
    ]);
    expect(input.shipping).toEqual({ fullRefund: false });
    expect(input.note).toBe('ReturnFlow return #ret_xyz');
  });

  it('builds the GraphQL client with the shop domain and the decrypted access token', async () => {
    prisma.return.findUnique.mockResolvedValue(ret());
    mockRefundFlow([tx()]);
    await RefundService.processRefund('ret_test_1');
    const Graphql = shopifyClient.__module.clients.Graphql;
    expect(Graphql).toHaveBeenCalledWith({ session: { shop: 'test-shop.myshopify.com', accessToken: 'shpat_fake_token' } });
  });

  it('handles a refundCreate response with no data at all (still marks PROCESSED, id undefined)', async () => {
    prisma.return.findUnique.mockResolvedValue(ret());
    shopifyClient.request
      .mockResolvedValueOnce({ data: { order: { transactions: [tx()] } } })
      .mockResolvedValueOnce({});
    const result = await RefundService.processRefund('ret_test_1');
    expect(result).toEqual({ success: true, type: 'REFUND', shopifyRefundId: undefined, amount: 50 });
    expect(prisma.return.update).toHaveBeenCalledTimes(1);
  });

  it('coerces Decimal-ish string values for totalValue / returnFee', async () => {
    prisma.return.findUnique.mockResolvedValue(ret({ totalValue: '60.00', returnFee: '2.50' }));
    mockRefundFlow([tx({ amountSet: { shopMoney: { amount: '100.00' } } })]);
    await RefundService.processRefund('ret_test_1');
    expect(refundInput().transactions[0].amount).toBe('57.5');
    expect(prisma.return.update.mock.calls[0][0].data.refundAmount).toBe(57.5);
  });
});

describe('failure paths leave no partial state', () => {
  it('refundCreate userErrors → throws with all messages, no DB update, no event', async () => {
    prisma.return.findUnique.mockResolvedValue(ret());
    mockRefundFlow([tx()], { userErrors: [{ field: 'a', message: 'first' }, { field: 'b', message: 'second' }] });
    const emit = jest.spyOn(eventBus, 'emit');
    await expect(RefundService.processRefund('ret_test_1')).rejects.toThrow('Shopify refund error: first, second');
    expect(prisma.return.update).not.toHaveBeenCalled();
    expect(emit).not.toHaveBeenCalledWith(REFUND_PROCESSED, expect.anything());
  });

  it('a Shopify network error on the transactions query propagates and aborts before refundCreate', async () => {
    prisma.return.findUnique.mockResolvedValue(ret());
    shopifyClient.request.mockRejectedValueOnce(new Error('ECONNRESET'));
    await expect(RefundService.processRefund('ret_test_1')).rejects.toThrow('ECONNRESET');
    expect(shopifyClient.request).toHaveBeenCalledTimes(1);
    expect(prisma.return.update).not.toHaveBeenCalled();
  });

  it('giftCardCreate userErrors are joined and nothing is persisted', async () => {
    prisma.return.findUnique.mockResolvedValue(ret({ resolution: 'STORE_CREDIT' }));
    shopifyClient.request.mockResolvedValue({ data: { giftCardCreate: { userErrors: [{ message: 'too high' }, { message: 'bad note' }] } } });
    const emit = jest.spyOn(eventBus, 'emit');
    await expect(RefundService.processRefund('ret_test_1')).rejects.toThrow('Gift card error: too high, bad note');
    expect(prisma.return.update).not.toHaveBeenCalled();
    expect(emit).not.toHaveBeenCalledWith(REFUND_PROCESSED, expect.anything());
  });

  it('ExchangeService failures propagate and the return stays unprocessed', async () => {
    prisma.return.findUnique.mockResolvedValue(ret({ resolution: 'EXCHANGE' }));
    createExchange.mockRejectedValue(new Error('Exchange variants out of stock: Tee / M'));
    await expect(RefundService.processRefund('ret_test_1')).rejects.toThrow(/out of stock/);
    expect(prisma.return.update).not.toHaveBeenCalled();
    expect(shopifyClient.request).not.toHaveBeenCalled();
  });

  it.each(['KEEP_ITEM', null, undefined])('rejects resolution %p before touching Shopify', async (resolution) => {
    prisma.return.findUnique.mockResolvedValue(ret({ resolution }));
    await expect(RefundService.processRefund('ret_test_1')).rejects.toThrow(`Unknown resolution: ${resolution}`);
    expect(shopifyClient.request).not.toHaveBeenCalled();
    expect(prisma.return.update).not.toHaveBeenCalled();
  });

  it('throws a clear error when the shop has no stored access token', async () => {
    prisma.return.findUnique.mockResolvedValue(ret({ shop: fakeShop({ shopifyToken: '' }) }));
    await expect(RefundService.processRefund('ret_test_1')).rejects.toThrow(/No Shopify access token stored for test-shop\.myshopify\.com/);
    expect(shopifyClient.request).not.toHaveBeenCalled();
  });

  it('loads the return with its items and shop in one query', async () => {
    prisma.return.findUnique.mockResolvedValue(null);
    await expect(RefundService.processRefund('ret_test_1')).rejects.toThrow();
    expect(prisma.return.findUnique).toHaveBeenCalledWith({ where: { id: 'ret_test_1' }, include: { items: true, shop: true } });
  });
});

describe('STORE_CREDIT', () => {
  it('issues the gift card for the fee-adjusted amount as a string, noting the return', async () => {
    prisma.return.findUnique.mockResolvedValue(ret({ id: 'ret_sc', resolution: 'STORE_CREDIT', totalValue: 50, returnFee: 5 }));
    shopifyClient.request.mockResolvedValue({
      data: { giftCardCreate: { giftCard: { id: 'gc_1', lastCharacters: 'ABCD', balance: { amount: '45', currencyCode: 'GBP' } }, userErrors: [] } },
    });
    const result = await RefundService.processRefund('ret_sc');
    expect(shopifyClient.request).toHaveBeenCalledTimes(1);
    expect(shopifyClient.request.mock.calls[0][0]).toMatch(/giftCardCreate/);
    expect(shopifyClient.request.mock.calls[0][1].variables.input).toEqual({
      initialValue: '45', note: 'Store credit for return #ret_sc',
    });
    expect(result).toEqual({ success: true, type: 'STORE_CREDIT', giftCardId: 'gc_1', lastCharacters: 'ABCD', amount: 45 });
    expect(prisma.return.update.mock.calls[0][0].data).toMatchObject({ status: 'PROCESSED', refundAmount: 45 });
  });

  it('copes with a success response that omits the giftCard object', async () => {
    prisma.return.findUnique.mockResolvedValue(ret({ resolution: 'STORE_CREDIT' }));
    shopifyClient.request.mockResolvedValue({ data: { giftCardCreate: { userErrors: [] } } });
    const result = await RefundService.processRefund('ret_test_1');
    expect(result).toMatchObject({ success: true, type: 'STORE_CREDIT', giftCardId: undefined, lastCharacters: undefined });
  });

  it('emits REFUND_PROCESSED with the store-credit resolution', async () => {
    prisma.return.findUnique.mockResolvedValue(ret({ resolution: 'STORE_CREDIT' }));
    shopifyClient.request.mockResolvedValue({ data: { giftCardCreate: { giftCard: { id: 'gc' }, userErrors: [] } } });
    const emit = jest.spyOn(eventBus, 'emit');
    await RefundService.processRefund('ret_test_1');
    expect(emit).toHaveBeenCalledWith(REFUND_PROCESSED, { returnId: 'ret_test_1', refundAmount: 50, resolution: 'STORE_CREDIT' });
  });
});

describe('EXCHANGE', () => {
  it('does not call Shopify directly and persists refundAmount alongside PROCESSED', async () => {
    prisma.return.findUnique.mockResolvedValue(ret({ resolution: 'EXCHANGE', totalValue: 30, returnFee: 0 }));
    const result = await RefundService.processRefund('ret_test_1');
    expect(createExchange).toHaveBeenCalledWith('ret_test_1');
    expect(shopifyClient.request).not.toHaveBeenCalled();
    expect(result).toEqual({ success: true, type: 'EXCHANGE', draftOrderId: 'do_1' });
    expect(prisma.return.update.mock.calls[0][0].data).toMatchObject({ status: 'PROCESSED', refundAmount: 30 });
  });
});

describe('local (non-Shopify) processing for non-real order ids', () => {
  it.each(['REFUND', 'STORE_CREDIT', 'EXCHANGE', 'KEEP_ITEM'])(
    'processes %s locally with the fee-adjusted amount, emitting REFUND_PROCESSED and never calling ExchangeService/Shopify',
    async (resolution) => {
      prisma.return.findUnique.mockResolvedValue(ret({ resolution, shopifyOrderId: 'demo', totalValue: 40, returnFee: 10 }));
      const emit = jest.spyOn(eventBus, 'emit');
      const result = await RefundService.processRefund('ret_test_1');
      expect(result).toEqual({ success: true, type: resolution, demo: true, amount: 30 });
      expect(shopifyClient.request).not.toHaveBeenCalled();
      expect(createExchange).not.toHaveBeenCalled();
      expect(prisma.return.update).toHaveBeenCalledWith({
        where: { id: 'ret_test_1' },
        data: { status: 'PROCESSED', refundAmount: 30, processedAt: expect.any(Date) },
      });
      expect(emit).toHaveBeenCalledWith(REFUND_PROCESSED, { returnId: 'ret_test_1', refundAmount: 30, resolution });
    },
  );

  it('does not need a shop token for locally processed returns', async () => {
    prisma.return.findUnique.mockResolvedValue(ret({ shopifyOrderId: 'pending', shop: fakeShop({ shopifyToken: '' }) }));
    await expect(RefundService.processRefund('ret_test_1')).resolves.toMatchObject({ demo: true });
  });

  it('treats a non-numeric order gid (e.g. a trailing suffix) as non-real', async () => {
    prisma.return.findUnique.mockResolvedValue(ret({ shopifyOrderId: 'gid://shopify/Order/123abc' }));
    await expect(RefundService.processRefund('ret_test_1')).resolves.toMatchObject({ demo: true });
    expect(shopifyClient.request).not.toHaveBeenCalled();
  });
});
