// RefundService — money moves only through Shopify, exactly once:
//   claim → reconcile against Shopify → Shopify-calculated amount →
//   refundCreate with an idempotency key → persist what was actually refunded.

const { installPrismaMock, installShopifyMock, fakeReturn, fakeShop, fakeReturnItem } = require('../helpers');
const { encrypt } = require('../../app/utils/encryption');
const { REFUND_PROCESSED } = require('../../app/events/emitters');

let prisma;
let shopifyClient;
let RefundService;
let eventBus;
let createExchange;

function load(features = {}) {
  jest.resetModules();
  prisma = installPrismaMock();
  shopifyClient = installShopifyMock();
  jest.doMock('../../app/utils/logger', () => ({ warn: jest.fn(), info: jest.fn(), error: jest.fn(), debug: jest.fn() }));
  jest.doMock('../../app/config/features', () => ({ EXCHANGES_ENABLED: false, ...features }));
  createExchange = jest.fn().mockResolvedValue({ success: true, type: 'EXCHANGE', draftOrderId: 'do_1' });
  jest.doMock('../../app/services/ExchangeService', () => ({ createExchange }));
  RefundService = require('../../app/services/RefundService');
  eventBus = require('../../app/events/eventBus');
  prisma.return.update.mockResolvedValue({});
  prisma.return.updateMany.mockResolvedValue({ count: 1 });
  prisma.returnEvent.create.mockResolvedValue({});
}

beforeEach(() => load());

function ret(overrides = {}) {
  return fakeReturn({
    shop: fakeShop({ shopifyToken: encrypt('shpat_fake_token') }),
    items: [fakeReturnItem({ quantity: 1, unitPrice: 50 })],
    totalValue: 50,
    returnFee: 0,
    status: 'RECEIVED',
    ...overrides,
  });
}

// Shopify responses, in the order the service asks for them.
const noExisting = { data: { order: { refunds: [] } } };
const existing = (id, note, amount, lines = []) => ({ data: { order: { refunds: [{
  id, note,
  totalRefundedSet: { shopMoney: { amount: String(amount) } },
  refundLineItems: { edges: lines.map((l) => ({ node: { subtotalSet: { shopMoney: { amount: l.subtotal } }, totalTaxSet: { shopMoney: { amount: l.tax } } } })) },
}] } } });
const suggested = ({ subtotal = '50.00', tax = '0.00', max = '50.00', transactions, currency = 'GBP' } = {}) => ({
  data: {
    order: {
      currencyCode: currency,
      suggestedRefund: {
        maximumRefundableSet: { shopMoney: { amount: max } },
        subtotalSet: { shopMoney: { amount: subtotal } },
        totalTaxSet: { shopMoney: { amount: tax } },
        suggestedTransactions: transactions || [
          { kind: 'SUGGESTED_REFUND', gateway: 'shopify_payments', amountSet: { shopMoney: { amount: max } }, parentTransaction: { id: 'gid://shopify/OrderTransaction/1' } },
        ],
      },
    },
  },
});
const refunded = (amount, id = 'gid://shopify/Refund/9') => ({
  data: { refundCreate: { refund: { id, totalRefundedSet: { shopMoney: { amount: String(amount), currencyCode: 'GBP' } } }, userErrors: [] } },
});
const userErrors = (...messages) => ({ data: { refundCreate: { refund: null, userErrors: messages.map((message) => ({ message })) } } });

function primeHappyRefund(amount = 50) {
  shopifyClient.request
    .mockResolvedValueOnce(noExisting)
    .mockResolvedValueOnce(suggested())
    .mockResolvedValueOnce(refunded(amount));
}

const callQueries = () => shopifyClient.request.mock.calls.map((c) => c[0].replace(/\s+/g, ' ').trim());

// ---------------------------------------------------------------------------
describe('loading and guards', () => {
  it('loads the return with its items and shop in one query', async () => {
    prisma.return.findUnique.mockResolvedValue(null);
    await expect(RefundService.processRefund('ret_test_1')).rejects.toThrow('not found');
    expect(prisma.return.findUnique).toHaveBeenCalledWith({ where: { id: 'ret_test_1' }, include: { items: true, shop: true } });
  });

  it('refuses an already processed return before touching Shopify', async () => {
    prisma.return.findUnique.mockResolvedValue(ret({ status: 'PROCESSED' }));
    await expect(RefundService.processRefund('ret_test_1')).rejects.toThrow('already processed');
    expect(shopifyClient.request).not.toHaveBeenCalled();
  });

  it('rejects an unknown resolution before touching Shopify', async () => {
    prisma.return.findUnique.mockResolvedValue(ret({ resolution: 'KEEP_ITEM' }));
    await expect(RefundService.processRefund('ret_test_1')).rejects.toThrow('Unknown resolution');
    expect(shopifyClient.request).not.toHaveBeenCalled();
    expect(prisma.return.update).not.toHaveBeenCalled();
  });

  it('throws a clear error when the shop has no stored access token', async () => {
    prisma.return.findUnique.mockResolvedValue(ret({ shop: fakeShop({ shopifyToken: '' }) }));
    await expect(RefundService.processRefund('ret_test_1')).rejects.toThrow(/No Shopify access token stored for test-shop\.myshopify\.com/);
    expect(shopifyClient.request).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
describe('double-refund guard (claim)', () => {
  it('refuses when another attempt already holds the claim, before touching Shopify', async () => {
    prisma.return.findUnique.mockResolvedValue(ret());
    prisma.return.updateMany.mockResolvedValueOnce({ count: 0 });
    await expect(RefundService.processRefund('ret_test_1')).rejects.toThrow('already being processed');
    expect(shopifyClient.request).not.toHaveBeenCalled();
  });

  it('claims only a not-yet-processed row with no live claim', async () => {
    prisma.return.findUnique.mockResolvedValue(ret());
    primeHappyRefund();
    await RefundService.processRefund('ret_test_1');
    const claim = prisma.return.updateMany.mock.calls[0][0];
    expect(claim.where.id).toBe('ret_test_1');
    expect(claim.where.status).toEqual({ not: 'PROCESSED' });
    expect(claim.where.OR[0]).toEqual({ processedAt: null });
    expect(claim.where.OR[1].processedAt.lt).toBeInstanceOf(Date);
    expect(claim.data.processedAt).toBeInstanceOf(Date);
  });

  it('releases the claim when Shopify refuses, so the merchant can retry', async () => {
    prisma.return.findUnique.mockResolvedValue(ret());
    shopifyClient.request.mockResolvedValueOnce(noExisting).mockResolvedValueOnce(suggested()).mockResolvedValueOnce(userErrors('nope'));
    await expect(RefundService.processRefund('ret_test_1')).rejects.toThrow('nope');
    expect(prisma.return.updateMany).toHaveBeenCalledTimes(2);
    expect(prisma.return.updateMany.mock.calls[1][0].data).toEqual({ processedAt: null });
    expect(prisma.return.update).not.toHaveBeenCalled();
    expect(prisma.returnEvent.create).not.toHaveBeenCalled();
  });

  it('keeps the claim when money moved but saving the result failed', async () => {
    prisma.return.findUnique.mockResolvedValue(ret());
    primeHappyRefund();
    prisma.return.update.mockRejectedValue(new Error('db down'));
    await expect(RefundService.processRefund('ret_test_1')).rejects.toThrow('db down');
    expect(prisma.return.updateMany).toHaveBeenCalledTimes(1);
  });
});

// ---------------------------------------------------------------------------
describe('reconciliation — a refund that already exists on Shopify is never repeated', () => {
  it('finishes the paperwork from the existing refund instead of calling refundCreate', async () => {
    prisma.return.findUnique.mockResolvedValue(ret());
    shopifyClient.request.mockResolvedValueOnce(existing('gid://shopify/Refund/old', 'ReturnFlow return #ret_test_1', 45));

    const result = await RefundService.processRefund('ret_test_1');

    expect(shopifyClient.request).toHaveBeenCalledTimes(1);
    expect(callQueries()[0]).toMatch(/refunds\(first: 50\)/);
    expect(result).toMatchObject({ success: true, type: 'REFUND', shopifyRefundId: 'gid://shopify/Refund/old', amount: 45, reconciled: true });
    expect(prisma.return.update.mock.calls[0][0].data).toMatchObject({ status: 'PROCESSED', refundAmount: 45 });
    expect(prisma.returnEvent.create.mock.calls[0][0].data.data).toMatchObject({ shopifyRefundId: 'gid://shopify/Refund/old', reconciled: true });
  });

  it('ignores refunds for other returns and zero-money refunds', async () => {
    prisma.return.findUnique.mockResolvedValue(ret());
    shopifyClient.request
      .mockResolvedValueOnce({ data: { order: { refunds: [
        { id: 'r_other', note: 'ReturnFlow return #ret_other', totalRefundedSet: { shopMoney: { amount: '50.00' } } },
        { id: 'r_zero', note: 'ReturnFlow return #ret_test_1', totalRefundedSet: { shopMoney: { amount: '0.00' } } },
      ] } } })
      .mockResolvedValueOnce(suggested())
      .mockResolvedValueOnce(refunded(50));
    const result = await RefundService.processRefund('ret_test_1');
    expect(result.reconciled).toBe(false);
    expect(shopifyClient.request).toHaveBeenCalledTimes(3);
  });

  it('the stale-claim replay: credit issued, save failed, claim retaken → reconciled, not re-issued', async () => {
    prisma.return.findUnique.mockResolvedValue(ret({ resolution: 'STORE_CREDIT', refundAmount: null }));
    // First attempt: refund goes through, DB save dies.
    shopifyClient.request.mockResolvedValueOnce(noExisting).mockResolvedValueOnce(suggested()).mockResolvedValueOnce(refunded(0, 'gid://shopify/Refund/sc'));
    prisma.return.update.mockRejectedValueOnce(new Error('db down'));
    await expect(RefundService.processRefund('ret_test_1')).rejects.toThrow('db down');

    // Second attempt (claim retaken): Shopify already has the refund.
    shopifyClient.request.mockReset();
    shopifyClient.request.mockResolvedValueOnce(existing('gid://shopify/Refund/sc', 'ReturnFlow return #ret_test_1', 0, [{ subtotal: '50.00', tax: '0.00' }]));
    prisma.return.update.mockResolvedValue({});
    const result = await RefundService.processRefund('ret_test_1');

    expect(result).toMatchObject({ reconciled: true, shopifyRefundId: 'gid://shopify/Refund/sc' });
    expect(callQueries().some((q) => q.includes('refundCreate'))).toBe(false);
  });

  it('rebuilds the credited amount from the refund\'s line items when the cash total is zero and nothing was saved locally', async () => {
    prisma.return.findUnique.mockResolvedValue(ret({ resolution: 'STORE_CREDIT', refundAmount: null, returnFee: 5 }));
    shopifyClient.request.mockResolvedValueOnce(existing('gid://shopify/Refund/sc', 'ReturnFlow return #ret_test_1', 0, [{ subtotal: '40.00', tax: '8.00' }, { subtotal: '12.00', tax: '0.00' }]));

    const result = await RefundService.processRefund('ret_test_1');

    expect(result).toMatchObject({ reconciled: true, amount: 55 }); // 40 + 8 + 12 − 5 fee
    expect(prisma.return.update.mock.calls[0][0].data.refundAmount).toBe(55);
  });
});

// ---------------------------------------------------------------------------
describe('REFUND to the original payment', () => {
  it('asks Shopify what the items are worth, refunds that with an idempotency key, and records what was actually refunded', async () => {
    prisma.return.findUnique.mockResolvedValue(ret({ items: [fakeReturnItem({ shopifyLineItemId: 'gid://shopify/LineItem/1', quantity: 2 })] }));
    shopifyClient.request
      .mockResolvedValueOnce(noExisting)
      .mockResolvedValueOnce(suggested({ subtotal: '40.00', tax: '8.00', max: '48.00' }))
      .mockResolvedValueOnce(refunded(48));
    const emit = jest.spyOn(eventBus, 'emit');

    const result = await RefundService.processRefund('ret_test_1');

    const [, suggestedCall, createCall] = shopifyClient.request.mock.calls;
    expect(suggestedCall[0]).toMatch(/suggestedRefund\(refundLineItems: \$refundLineItems, refundShipping: false\)/);
    expect(suggestedCall[1].variables.refundLineItems).toEqual([{ lineItemId: 'gid://shopify/LineItem/1', quantity: 2 }]);

    expect(createCall[0]).toMatch(/refundCreate\(input: \$input\) @idempotent\(key: "[0-9a-f-]{36}"\)/);
    expect(createCall[1].variables.input).toEqual({
      orderId: 'gid://shopify/Order/1',
      note: 'ReturnFlow return #ret_test_1',
      shipping: { fullRefund: false },
      refundLineItems: [{ lineItemId: 'gid://shopify/LineItem/1', quantity: 2 }],
      transactions: [{ orderId: 'gid://shopify/Order/1', parentId: 'gid://shopify/OrderTransaction/1', kind: 'REFUND', gateway: 'shopify_payments', amount: '48' }],
    });

    expect(result).toEqual({ success: true, type: 'REFUND', shopifyRefundId: 'gid://shopify/Refund/9', amount: 48, requestedAmount: 50, reconciled: false });
    expect(prisma.return.update).toHaveBeenCalledWith({
      where: { id: 'ret_test_1' },
      data: { status: 'PROCESSED', refundAmount: 48, processedAt: expect.any(Date) },
    });
    expect(prisma.returnEvent.create.mock.calls[0][0].data).toMatchObject({
      returnId: 'ret_test_1', type: 'refund.recorded', actor: 'system',
      data: { method: 'original_payment', amount: 48, shopifyRefundId: 'gid://shopify/Refund/9', reconciled: false },
    });
    expect(emit).toHaveBeenCalledWith(REFUND_PROCESSED, { returnId: 'ret_test_1', refundAmount: 48, resolution: 'REFUND' });
  });

  it('uses the same idempotency key for the same return every time', () => {
    expect(RefundService.idempotencyKey('ret_a')).toBe(RefundService.idempotencyKey('ret_a'));
    expect(RefundService.idempotencyKey('ret_a')).not.toBe(RefundService.idempotencyKey('ret_b'));
    expect(RefundService.idempotencyKey('ret_a')).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
  });

  it('deducts the return fee from the Shopify-calculated amount', async () => {
    prisma.return.findUnique.mockResolvedValue(ret({ returnFee: 5 }));
    shopifyClient.request.mockResolvedValueOnce(noExisting).mockResolvedValueOnce(suggested()).mockResolvedValueOnce(refunded(45));
    await RefundService.processRefund('ret_test_1');
    expect(shopifyClient.request.mock.calls[2][1].variables.input.transactions[0].amount).toBe('45');
  });

  it('never refunds more than Shopify says is refundable, even if our own total is higher', async () => {
    prisma.return.findUnique.mockResolvedValue(ret({ totalValue: 100 }));
    shopifyClient.request.mockResolvedValueOnce(noExisting).mockResolvedValueOnce(suggested({ subtotal: '30.00', max: '30.00' })).mockResolvedValueOnce(refunded(30));
    const result = await RefundService.processRefund('ret_test_1');
    expect(shopifyClient.request.mock.calls[2][1].variables.input.transactions[0].amount).toBe('30');
    expect(result.amount).toBe(30);
    expect(result.requestedAmount).toBe(100);
  });

  it('never refunds a negative amount when the fee exceeds the item value', async () => {
    prisma.return.findUnique.mockResolvedValue(ret({ returnFee: 80 }));
    shopifyClient.request.mockResolvedValueOnce(noExisting).mockResolvedValueOnce(suggested()).mockResolvedValueOnce(refunded(0));
    const result = await RefundService.processRefund('ret_test_1');
    expect(shopifyClient.request.mock.calls[2][1].variables.input.transactions).toEqual([]);
    expect(result.amount).toBe(0);
  });

  it('splits the amount across several payments in proportion, never above each one\'s limit', async () => {
    prisma.return.findUnique.mockResolvedValue(ret({ totalValue: 100 }));
    shopifyClient.request
      .mockResolvedValueOnce(noExisting)
      .mockResolvedValueOnce(suggested({
        subtotal: '100.00', max: '100.00',
        transactions: [
          { kind: 'SUGGESTED_REFUND', gateway: 'gift_card', amountSet: { shopMoney: { amount: '30.00' } }, parentTransaction: { id: 'tx_gc' } },
          { kind: 'SUGGESTED_REFUND', gateway: 'shopify_payments', amountSet: { shopMoney: { amount: '70.00' } }, parentTransaction: { id: 'tx_card' } },
        ],
      }))
      .mockResolvedValueOnce(refunded(90));
    // Fee of 10 → 90 to refund: 27 + 63.
    prisma.return.findUnique.mockResolvedValue(ret({ totalValue: 100, returnFee: 10 }));
    await RefundService.processRefund('ret_test_1');
    expect(shopifyClient.request.mock.calls[2][1].variables.input.transactions).toEqual([
      expect.objectContaining({ parentId: 'tx_gc', gateway: 'gift_card', amount: '27' }),
      expect.objectContaining({ parentId: 'tx_card', gateway: 'shopify_payments', amount: '63' }),
    ]);
  });

  it('fails (and releases the claim) when Shopify has no refundable payment for a non-zero amount', async () => {
    prisma.return.findUnique.mockResolvedValue(ret());
    shopifyClient.request.mockResolvedValueOnce(noExisting).mockResolvedValueOnce(suggested({ transactions: [] }));
    await expect(RefundService.processRefund('ret_test_1')).rejects.toThrow(/No refundable payment/);
    expect(callQueries().some((q) => q.includes('refundCreate'))).toBe(false);
    expect(prisma.return.updateMany.mock.calls[1][0].data).toEqual({ processedAt: null });
  });

  it('reports failure, not success, when Shopify creates the refund but moves no money', async () => {
    prisma.return.findUnique.mockResolvedValue(ret());
    shopifyClient.request.mockResolvedValueOnce(noExisting).mockResolvedValueOnce(suggested()).mockResolvedValueOnce(refunded(0));
    await expect(RefundService.processRefund('ret_test_1')).rejects.toThrow(/moved no money/);
    expect(prisma.return.update).not.toHaveBeenCalled();
    // The refund record exists on Shopify (zero money) so the claim is released
    // for a retry, which sends the same idempotency key.
    expect(prisma.return.updateMany.mock.calls[1][0].data).toEqual({ processedAt: null });
  });

  it('joins all userErrors into the thrown message and persists nothing', async () => {
    prisma.return.findUnique.mockResolvedValue(ret());
    shopifyClient.request.mockResolvedValueOnce(noExisting).mockResolvedValueOnce(suggested()).mockResolvedValueOnce(userErrors('too much', 'already refunded'));
    await expect(RefundService.processRefund('ret_test_1')).rejects.toThrow('Shopify refund error: too much, already refunded');
    expect(prisma.return.update).not.toHaveBeenCalled();
  });

  it('a Shopify network error during the suggested-refund query aborts before refundCreate', async () => {
    prisma.return.findUnique.mockResolvedValue(ret());
    shopifyClient.request.mockResolvedValueOnce(noExisting).mockRejectedValueOnce(new Error('ECONNRESET'));
    await expect(RefundService.processRefund('ret_test_1')).rejects.toThrow('ECONNRESET');
    expect(shopifyClient.request).toHaveBeenCalledTimes(2);
    expect(prisma.return.update).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
describe('STORE_CREDIT through refundCreate (Shopify\'s required route)', () => {
  it('issues the credit as a refund method on the order, in the order currency', async () => {
    prisma.return.findUnique.mockResolvedValue(ret({ id: 'ret_sc', resolution: 'STORE_CREDIT', totalValue: 50, returnFee: 5 }));
    shopifyClient.request
      .mockResolvedValueOnce(noExisting)
      .mockResolvedValueOnce(suggested({ currency: 'USD' }))
      .mockResolvedValueOnce(refunded(0, 'gid://shopify/Refund/sc'));

    const result = await RefundService.processRefund('ret_sc');

    const createCall = shopifyClient.request.mock.calls[2];
    expect(createCall[0]).toMatch(/@idempotent/);
    expect(createCall[1].variables.input).toEqual({
      orderId: 'gid://shopify/Order/1',
      note: 'ReturnFlow return #ret_sc',
      shipping: { fullRefund: false },
      refundLineItems: [{ lineItemId: 'gid://shopify/LineItem/1', quantity: 1 }],
      refundMethods: [{ storeCreditRefund: { amount: { amount: '45', currencyCode: 'USD' } } }],
    });
    expect(createCall[1].variables.input).not.toHaveProperty('transactions');
    expect(callQueries().some((q) => q.includes('giftCardCreate'))).toBe(false);
    expect(result).toEqual({ success: true, type: 'STORE_CREDIT', shopifyRefundId: 'gid://shopify/Refund/sc', amount: 45, requestedAmount: 45, reconciled: false });
    expect(prisma.return.update.mock.calls[0][0].data).toMatchObject({ status: 'PROCESSED', refundAmount: 45 });
    expect(prisma.returnEvent.create.mock.calls[0][0].data.data.method).toBe('store_credit');
  });

  it('surfaces Shopify refusing store credit (e.g. no customer on the order) and persists nothing', async () => {
    prisma.return.findUnique.mockResolvedValue(ret({ resolution: 'STORE_CREDIT' }));
    shopifyClient.request.mockResolvedValueOnce(noExisting).mockResolvedValueOnce(suggested()).mockResolvedValueOnce(userErrors('Store credit requires a customer'));
    await expect(RefundService.processRefund('ret_test_1')).rejects.toThrow(/requires a customer/);
    expect(prisma.return.update).not.toHaveBeenCalled();
  });

  it('emits REFUND_PROCESSED with the store-credit resolution', async () => {
    prisma.return.findUnique.mockResolvedValue(ret({ resolution: 'STORE_CREDIT' }));
    shopifyClient.request.mockResolvedValueOnce(noExisting).mockResolvedValueOnce(suggested()).mockResolvedValueOnce(refunded(0));
    const emit = jest.spyOn(eventBus, 'emit');
    await RefundService.processRefund('ret_test_1');
    expect(emit).toHaveBeenCalledWith(REFUND_PROCESSED, { returnId: 'ret_test_1', refundAmount: 50, resolution: 'STORE_CREDIT' });
  });
});

// ---------------------------------------------------------------------------
describe('EXCHANGE', () => {
  it('is refused while the feature is off', async () => {
    prisma.return.findUnique.mockResolvedValue(ret({ resolution: 'EXCHANGE' }));
    await expect(RefundService.processRefund('ret_test_1')).rejects.toThrow(/not enabled/);
    expect(createExchange).not.toHaveBeenCalled();
    expect(prisma.return.update).not.toHaveBeenCalled();
  });

  it('when enabled, delegates to ExchangeService and marks PROCESSED with the fee-adjusted value', async () => {
    load({ EXCHANGES_ENABLED: true });
    prisma.return.findUnique.mockResolvedValue(ret({ resolution: 'EXCHANGE', totalValue: 30, returnFee: 0 }));
    const result = await RefundService.processRefund('ret_test_1');
    expect(createExchange).toHaveBeenCalledWith('ret_test_1');
    expect(shopifyClient.request).not.toHaveBeenCalled();
    expect(result).toMatchObject({ type: 'EXCHANGE', draftOrderId: 'do_1', amount: 30 });
    expect(prisma.return.update.mock.calls[0][0].data).toMatchObject({ status: 'PROCESSED', refundAmount: 30 });
  });

  it('when enabled, an ExchangeService failure leaves the return unprocessed', async () => {
    load({ EXCHANGES_ENABLED: true });
    prisma.return.findUnique.mockResolvedValue(ret({ resolution: 'EXCHANGE' }));
    createExchange.mockRejectedValue(new Error('variant out of stock'));
    await expect(RefundService.processRefund('ret_test_1')).rejects.toThrow('variant out of stock');
    expect(prisma.return.update).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
describe('local (non-Shopify) processing for non-real order ids', () => {
  it.each([
    ['pending'], ['gid://shopify/Order/demo'], [''], ['demo'], ['gid://shopify/Order/12abc'],
  ])('processes %p locally with the fee-adjusted amount and never calls Shopify', async (shopifyOrderId) => {
    prisma.return.findUnique.mockResolvedValue(ret({ shopifyOrderId, resolution: 'REFUND', totalValue: 50, returnFee: 5 }));
    const emit = jest.spyOn(eventBus, 'emit');
    const result = await RefundService.processRefund('ret_test_1');
    expect(shopifyClient.request).not.toHaveBeenCalled();
    expect(result).toEqual({ success: true, type: 'REFUND', demo: true, amount: 45 });
    expect(prisma.return.update.mock.calls[0][0].data).toMatchObject({ status: 'PROCESSED', refundAmount: 45 });
    expect(emit).toHaveBeenCalledWith(REFUND_PROCESSED, { returnId: 'ret_test_1', refundAmount: 45, resolution: 'REFUND' });
  });

  it('does not need a shop token for locally processed returns', async () => {
    prisma.return.findUnique.mockResolvedValue(ret({ shopifyOrderId: 'demo', shop: fakeShop({ shopifyToken: '' }) }));
    await expect(RefundService.processRefund('ret_test_1')).resolves.toMatchObject({ demo: true });
  });
});
