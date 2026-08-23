// ExchangeService — draft-order input shaping, availability-check edge cases,
// and failure paths not covered by ExchangeService.test.js.

const { installPrismaMock, installShopifyMock, fakeReturn, fakeShop, fakeReturnItem } = require('../helpers');
const { encrypt } = require('../../app/utils/encryption');
const { EXCHANGE_CREATED } = require('../../app/events/emitters');

let prisma;
let shopifyClient;
let ExchangeService;
let eventBus;

beforeEach(() => {
  jest.resetModules();
  prisma = installPrismaMock();
  shopifyClient = installShopifyMock();
  // Keep pino from spawning a pretty-print transport on every module reset.
  jest.doMock('../../app/utils/logger', () => ({ warn: jest.fn(), info: jest.fn(), error: jest.fn(), debug: jest.fn() }));
  ExchangeService = require('../../app/services/ExchangeService');
  eventBus = require('../../app/events/eventBus');
  prisma.returnItem.update.mockResolvedValue({});
});

function ret(items, overrides = {}) {
  return fakeReturn({
    shop: fakeShop({ shopifyToken: encrypt('shpat_fake_token') }),
    items,
    ...overrides,
  });
}

const V = (n) => `gid://shopify/ProductVariant/${n}`;
const node = (n, over = {}) => ({ id: V(n), availableForSale: true, inventoryQuantity: 5, displayName: `Variant ${n}`, ...over });

function mockAvailability(nodes) {
  shopifyClient.request.mockResolvedValueOnce({ data: { nodes } });
}
function mockDraftOrder(draftOrder = { id: 'gid://shopify/DraftOrder/1', name: '#D1', invoiceUrl: 'https://x/invoice', totalPriceSet: { shopMoney: { amount: '0' } } }) {
  shopifyClient.request.mockResolvedValueOnce({ data: { draftOrderCreate: { draftOrder, userErrors: [] } } });
}
const draftInput = () => shopifyClient.request.mock.calls[1][1].variables.input;

describe('availability check', () => {
  it('asks Shopify about exactly the exchange variants, in item order, skipping non-exchange items', async () => {
    prisma.return.findUnique.mockResolvedValue(ret([
      fakeReturnItem({ id: 'i1', exchangeVariantId: V(1) }),
      fakeReturnItem({ id: 'i2', exchangeVariantId: null }),   // plain refund item — not queried
      fakeReturnItem({ id: 'i3', exchangeVariantId: V(3) }),
    ]));
    mockAvailability([node(1), node(3)]);
    mockDraftOrder();
    await ExchangeService.createExchange('ret_test_1');
    expect(shopifyClient.request.mock.calls[0][0]).toMatch(/VariantAvailability/);
    expect(shopifyClient.request.mock.calls[0][1]).toEqual({ variables: { ids: [V(1), V(3)] } });
  });

  it('lists every unavailable variant in the error and never creates a draft order', async () => {
    prisma.return.findUnique.mockResolvedValue(ret([
      fakeReturnItem({ id: 'i1', exchangeVariantId: V(1) }),
      fakeReturnItem({ id: 'i2', exchangeVariantId: V(2) }),
      fakeReturnItem({ id: 'i3', exchangeVariantId: V(3) }),
    ]));
    mockAvailability([
      node(1, { inventoryQuantity: 0, displayName: 'Tee / S' }),
      node(2),
      node(3, { availableForSale: false, displayName: 'Tee / XL' }),
    ]);
    await expect(ExchangeService.createExchange('ret_test_1')).rejects.toThrow('Exchange variants out of stock: Tee / S, Tee / XL');
    expect(shopifyClient.request).toHaveBeenCalledTimes(1);
    expect(prisma.returnItem.update).not.toHaveBeenCalled();
  });

  it('treats negative inventory as out of stock', async () => {
    prisma.return.findUnique.mockResolvedValue(ret([fakeReturnItem({ exchangeVariantId: V(1) })]));
    mockAvailability([node(1, { inventoryQuantity: -2, displayName: 'Oversold' })]);
    await expect(ExchangeService.createExchange('ret_test_1')).rejects.toThrow(/Oversold/);
  });

  it('treats null nodes (variants Shopify could not resolve) as unavailable, naming the id, and never creates a draft order', async () => {
    // A deleted / wrong variant id comes back as a null node; the pre-check
    // now fails fast with the offending id instead of relying on a vaguer
    // draftOrderCreate userError later.
    prisma.return.findUnique.mockResolvedValue(ret([fakeReturnItem({ exchangeVariantId: V(404) })]));
    mockAvailability([null]);
    mockDraftOrder();
    await expect(ExchangeService.createExchange('ret_test_1')).rejects.toThrow(
      `Exchange variants out of stock: ${V(404)} (not found)`,
    );
    // Only the availability query ran — draftOrderCreate was never called
    expect(shopifyClient.request).toHaveBeenCalledTimes(1);
    expect(shopifyClient.request.mock.calls[0][0]).toMatch(/VariantAvailability/);
    expect(prisma.returnItem.update).not.toHaveBeenCalled();
  });

  it('names the missing id at the right position when a null node sits among healthy ones', async () => {
    prisma.return.findUnique.mockResolvedValue(ret([
      fakeReturnItem({ id: 'i1', exchangeVariantId: V(1) }),
      fakeReturnItem({ id: 'i2', exchangeVariantId: V(2) }),
    ]));
    mockAvailability([node(1), null]);
    mockDraftOrder();
    await expect(ExchangeService.createExchange('ret_test_1')).rejects.toThrow(`${V(2)} (not found)`);
    expect(shopifyClient.request).toHaveBeenCalledTimes(1);
  });

  it('proceeds when the availability response has no nodes array', async () => {
    prisma.return.findUnique.mockResolvedValue(ret([fakeReturnItem({ exchangeVariantId: V(1) })]));
    shopifyClient.request.mockResolvedValueOnce({ data: {} });
    mockDraftOrder();
    await expect(ExchangeService.createExchange('ret_test_1')).resolves.toMatchObject({ success: true });
  });

  it('propagates a Shopify failure on the availability query without creating a draft order', async () => {
    prisma.return.findUnique.mockResolvedValue(ret([fakeReturnItem({ exchangeVariantId: V(1) })]));
    shopifyClient.request.mockRejectedValueOnce(new Error('Throttled'));
    await expect(ExchangeService.createExchange('ret_test_1')).rejects.toThrow('Throttled');
    expect(shopifyClient.request).toHaveBeenCalledTimes(1);
  });
});

describe('draft order input', () => {
  it('maps each exchange item to variantId + quantity and excludes non-exchange items', async () => {
    prisma.return.findUnique.mockResolvedValue(ret([
      fakeReturnItem({ id: 'i1', exchangeVariantId: V(1), quantity: 2 }),
      fakeReturnItem({ id: 'i2', exchangeVariantId: null, quantity: 1 }),
      fakeReturnItem({ id: 'i3', exchangeVariantId: V(3), quantity: 1 }),
    ], { id: 'ret_ex', customerEmail: 'buyer@example.com', returnFee: 0 }));
    mockAvailability([node(1), node(3)]);
    mockDraftOrder();

    await ExchangeService.createExchange('ret_ex');

    expect(shopifyClient.request.mock.calls[1][0]).toMatch(/draftOrderCreate/);
    expect(draftInput()).toEqual({
      lineItems: [
        { variantId: V(1), quantity: 2 },
        { variantId: V(3), quantity: 1 },
      ],
      note: 'Exchange for ReturnFlow return #ret_ex',
      email: 'buyer@example.com',
      tags: ['returnflow-exchange'],
    });
  });

  it('bills the return fee in GBP by default when the return has no currency', async () => {
    prisma.return.findUnique.mockResolvedValue(ret([fakeReturnItem({ exchangeVariantId: V(1) })], { returnFee: '3.00', currency: null }));
    mockAvailability([node(1)]);
    mockDraftOrder();
    await ExchangeService.createExchange('ret_test_1');
    const fee = draftInput().lineItems.find((li) => li.title === 'Return fee');
    expect(fee).toEqual({
      title: 'Return fee', quantity: 1, requiresShipping: false, taxable: false,
      originalUnitPriceWithCurrency: { amount: 3, currencyCode: 'GBP' },
    });
  });

  it('uses the return currency for the fee line when set', async () => {
    prisma.return.findUnique.mockResolvedValue(ret([fakeReturnItem({ exchangeVariantId: V(1) })], { returnFee: 1.25, currency: 'EUR' }));
    mockAvailability([node(1)]);
    mockDraftOrder();
    await ExchangeService.createExchange('ret_test_1');
    expect(draftInput().lineItems.at(-1).originalUnitPriceWithCurrency).toEqual({ amount: 1.25, currencyCode: 'EUR' });
  });

  it.each([null, undefined, 0, -2, 'abc'])('adds no fee line for returnFee %p', async (returnFee) => {
    prisma.return.findUnique.mockResolvedValue(ret([fakeReturnItem({ exchangeVariantId: V(1) })], { returnFee }));
    mockAvailability([node(1)]);
    mockDraftOrder();
    await ExchangeService.createExchange('ret_test_1');
    expect(draftInput().lineItems).toEqual([{ variantId: V(1), quantity: 1 }]);
  });

  it('builds the GraphQL client with the shop domain and decrypted token', async () => {
    prisma.return.findUnique.mockResolvedValue(ret([fakeReturnItem({ exchangeVariantId: V(1) })]));
    mockAvailability([node(1)]);
    mockDraftOrder();
    await ExchangeService.createExchange('ret_test_1');
    expect(shopifyClient.__module.clients.Graphql).toHaveBeenCalledWith({
      session: { shop: 'test-shop.myshopify.com', accessToken: 'shpat_fake_token' },
    });
  });

  it('throws a clear error when the shop has no stored access token, before any Shopify call', async () => {
    prisma.return.findUnique.mockResolvedValue(ret([fakeReturnItem({ exchangeVariantId: V(1) })], { shop: fakeShop({ shopifyToken: '' }) }));
    await expect(ExchangeService.createExchange('ret_test_1')).rejects.toThrow(/No Shopify access token stored/);
    expect(shopifyClient.request).not.toHaveBeenCalled();
  });
});

describe('after draftOrderCreate', () => {
  it('stamps the draft order id on every exchange item (and only those) and emits EXCHANGE_CREATED once', async () => {
    prisma.return.findUnique.mockResolvedValue(ret([
      fakeReturnItem({ id: 'i1', exchangeVariantId: V(1) }),
      fakeReturnItem({ id: 'i2', exchangeVariantId: null }),
      fakeReturnItem({ id: 'i3', exchangeVariantId: V(3) }),
    ]));
    mockAvailability([node(1), node(3)]);
    mockDraftOrder({ id: 'gid://shopify/DraftOrder/55', name: '#D55', invoiceUrl: 'https://x/55/invoice' });
    const emit = jest.spyOn(eventBus, 'emit');

    const result = await ExchangeService.createExchange('ret_test_1');

    expect(prisma.returnItem.update).toHaveBeenCalledTimes(2);
    expect(prisma.returnItem.update.mock.calls.map((c) => c[0])).toEqual([
      { where: { id: 'i1' }, data: { exchangeOrderId: 'gid://shopify/DraftOrder/55' } },
      { where: { id: 'i3' }, data: { exchangeOrderId: 'gid://shopify/DraftOrder/55' } },
    ]);
    const events = emit.mock.calls.filter(([name]) => name === EXCHANGE_CREATED);
    expect(events).toHaveLength(1);
    expect(events[0][1]).toEqual({ returnId: 'ret_test_1', draftOrderId: 'gid://shopify/DraftOrder/55', draftOrderName: '#D55' });
    expect(result).toEqual({
      success: true, type: 'EXCHANGE', draftOrderId: 'gid://shopify/DraftOrder/55', draftOrderName: '#D55', invoiceUrl: 'https://x/55/invoice',
    });
  });

  it('on userErrors: no item is updated and no event is emitted', async () => {
    prisma.return.findUnique.mockResolvedValue(ret([fakeReturnItem({ id: 'i1', exchangeVariantId: V(1) })]));
    mockAvailability([node(1)]);
    shopifyClient.request.mockResolvedValueOnce({
      data: { draftOrderCreate: { draftOrder: null, userErrors: [{ field: 'email', message: 'Email is invalid' }, { field: 'x', message: 'Other' }] } },
    });
    const emit = jest.spyOn(eventBus, 'emit');
    await expect(ExchangeService.createExchange('ret_test_1')).rejects.toThrow('Draft order error: Email is invalid, Other');
    expect(prisma.returnItem.update).not.toHaveBeenCalled();
    expect(emit).not.toHaveBeenCalledWith(EXCHANGE_CREATED, expect.anything());
  });

  it('propagates a network failure on draftOrderCreate without touching items', async () => {
    prisma.return.findUnique.mockResolvedValue(ret([fakeReturnItem({ id: 'i1', exchangeVariantId: V(1) })]));
    mockAvailability([node(1)]);
    shopifyClient.request.mockRejectedValueOnce(new Error('502 Bad Gateway'));
    await expect(ExchangeService.createExchange('ret_test_1')).rejects.toThrow('502 Bad Gateway');
    expect(prisma.returnItem.update).not.toHaveBeenCalled();
  });

  it('propagates a failure while stamping items (so the caller does not mark the return processed)', async () => {
    prisma.return.findUnique.mockResolvedValue(ret([fakeReturnItem({ id: 'i1', exchangeVariantId: V(1) })]));
    mockAvailability([node(1)]);
    mockDraftOrder();
    prisma.returnItem.update.mockRejectedValueOnce(new Error('db write failed'));
    const emit = jest.spyOn(eventBus, 'emit');
    await expect(ExchangeService.createExchange('ret_test_1')).rejects.toThrow('db write failed');
    expect(emit).not.toHaveBeenCalledWith(EXCHANGE_CREATED, expect.anything());
  });

  it('rejects a success response whose draftOrder object is missing instead of stamping undefined ids', async () => {
    prisma.return.findUnique.mockResolvedValue(ret([fakeReturnItem({ id: 'i1', exchangeVariantId: V(1) })]));
    mockAvailability([node(1)]);
    shopifyClient.request.mockResolvedValueOnce({ data: { draftOrderCreate: { userErrors: [] } } });
    const emit = jest.spyOn(eventBus, 'emit');
    await expect(ExchangeService.createExchange('ret_test_1')).rejects.toThrow('Draft order error: Shopify returned no draft order');
    expect(prisma.returnItem.update).not.toHaveBeenCalled();
    expect(emit).not.toHaveBeenCalledWith(EXCHANGE_CREATED, expect.anything());
  });

  it('rejects a draftOrder that has no id the same way', async () => {
    prisma.return.findUnique.mockResolvedValue(ret([fakeReturnItem({ id: 'i1', exchangeVariantId: V(1) })]));
    mockAvailability([node(1)]);
    shopifyClient.request.mockResolvedValueOnce({ data: { draftOrderCreate: { draftOrder: { name: '#D1' }, userErrors: [] } } });
    await expect(ExchangeService.createExchange('ret_test_1')).rejects.toThrow('Shopify returned no draft order');
    expect(prisma.returnItem.update).not.toHaveBeenCalled();
  });

  it('loads the return with items and shop in one query', async () => {
    prisma.return.findUnique.mockResolvedValue(null);
    await expect(ExchangeService.createExchange('ret_9')).rejects.toThrow('Return ret_9 not found');
    expect(prisma.return.findUnique).toHaveBeenCalledWith({ where: { id: 'ret_9' }, include: { items: true, shop: true } });
  });
});
