// ReturnValidation — the server-side truth for return requests: ownership,
// item membership, remaining quantities, prices, policy resolutions.

const { installPrismaMock, fakeShop, fakeReturn, fakeReturnItem } = require('../helpers');

let prisma;
let request;
let policyEngine;
let ReturnValidation;

const LI1 = 'gid://shopify/LineItem/1';
const LI2 = 'gid://shopify/LineItem/2';

function lineItem(overrides = {}) {
  return {
    id: LI1,
    title: 'Wool jumper',
    variantTitle: 'M / Navy',
    sku: 'WJ-M-NAV',
    quantity: 2,
    refundableQuantity: 2,
    originalUnitPriceSet: { shopMoney: { amount: '50.00' } },
    discountedUnitPriceSet: { shopMoney: { amount: '47.50' } },
    image: { url: 'https://cdn/x.jpg' },
    product: { id: 'gid://shopify/Product/1', tags: ['knitwear'], collections: { edges: [{ node: { handle: 'winter' } }] } },
    variant: { id: 'gid://shopify/ProductVariant/1' },
    ...overrides,
  };
}

function order(overrides = {}) {
  return {
    id: 'gid://shopify/Order/1001',
    name: '#1001',
    email: 'Jane@X.com',
    currencyCode: 'GBP',
    createdAt: '2026-01-01T00:00:00Z',
    displayFulfillmentStatus: 'FULFILLED',
    fulfillments: [{ createdAt: '2026-01-05T00:00:00Z' }],
    lineItems: { edges: [{ node: lineItem() }] },
    ...overrides,
  };
}

function load(env = {}) {
  jest.resetModules();
  prisma = installPrismaMock();
  request = jest.fn().mockResolvedValue({ data: { order: order() } });
  jest.doMock('../../app/services/ShopToken', () => ({ graphqlClient: jest.fn().mockResolvedValue({ request }) }));
  policyEngine = {
    evaluateEligibility: jest.fn().mockResolvedValue({
      eligible: true, policy: { id: 'pol_1' }, resolutions: { allowRefund: true, allowStoreCredit: true, allowExchange: true },
    }),
  };
  jest.doMock('../../app/services/PolicyEngine', () => policyEngine);
  jest.doMock('../../app/config/features', () => ({ EXCHANGES_ENABLED: false, ...env }));
  prisma.return.findMany.mockResolvedValue([]);
  ReturnValidation = require('../../app/services/ReturnValidation');
}

beforeEach(() => load());

const shop = () => fakeShop();
const good = () => ({
  orderId: 'gid://shopify/Order/1001',
  customerEmail: 'jane@x.com',
  items: [{ lineItemId: LI1, quantity: 1, reason: 'doesnt_fit', reasonDetail: 'tight' }],
  resolution: 'REFUND',
});

describe('loadOrder', () => {
  it('builds items from Shopify: discounted price, remaining quantity, policy resolutions', async () => {
    const { order: o, items } = await ReturnValidation.loadOrder(shop(), 'gid://shopify/Order/1001');
    expect(o).toMatchObject({ id: 'gid://shopify/Order/1001', name: '#1001', email: 'Jane@X.com', currency: 'GBP' });
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({
      lineItemId: LI1, price: 47.5, quantity: 2, eligible: true, resolutions: ['REFUND', 'STORE_CREDIT'],
    });
    expect(policyEngine.evaluateEligibility).toHaveBeenCalledWith(
      'shop_test_1', { price: 47.5, tags: ['knitwear'], collections: ['winter'] }, '2026-01-05T00:00:00Z',
    );
  });

  it('subtracts quantities already claimed by open returns on the order', async () => {
    prisma.return.findMany.mockResolvedValue([
      fakeReturn({ status: 'APPROVED', items: [fakeReturnItem({ shopifyLineItemId: LI1, quantity: 1 })] }),
    ]);
    const { items } = await ReturnValidation.loadOrder(shop(), 'gid://shopify/Order/1001');
    expect(items[0].quantity).toBe(1);
    expect(prisma.return.findMany.mock.calls[0][0].where.status.in).not.toContain('REJECTED');
  });

  it('marks an item ineligible when nothing is left to return', async () => {
    prisma.return.findMany.mockResolvedValue([
      fakeReturn({ items: [fakeReturnItem({ shopifyLineItemId: LI1, quantity: 2 })] }),
    ]);
    const { items } = await ReturnValidation.loadOrder(shop(), 'gid://shopify/Order/1001');
    expect(items[0]).toMatchObject({ eligible: false, quantity: 0, ineligibleReason: 'Already returned', resolutions: [] });
  });

  it('only offers EXCHANGE when the policy allows it and the feature is on', async () => {
    load({ EXCHANGES_ENABLED: true });
    const { items } = await ReturnValidation.loadOrder(shop(), 'gid://shopify/Order/1001');
    expect(items[0].resolutions).toEqual(['REFUND', 'STORE_CREDIT', 'EXCHANGE']);
  });

  it('throws a 404 ValidationError when Shopify has no such order', async () => {
    request.mockResolvedValue({ data: { order: null } });
    await expect(ReturnValidation.loadOrder(shop(), 'gid://shopify/Order/9')).rejects.toMatchObject({ status: 404 });
  });
});

describe('validateCreate — request shape', () => {
  it.each([
    ['missing orderId', { orderId: undefined }, /orderId/],
    ['fabricated orderId', { orderId: 'gid://shopify/Order/evil-1' }, /orderId/],
    ['missing email', { customerEmail: undefined }, /customerEmail/],
    ['no items', { items: [] }, /items and resolution/],
    ['bad resolution', { resolution: 'CASH' }, /resolution/],
    ['negative quantity', { items: [{ lineItemId: LI1, quantity: -1, reason: 'doesnt_fit' }] }, /quantity/],
    ['zero quantity', { items: [{ lineItemId: LI1, quantity: 0, reason: 'doesnt_fit' }] }, /quantity/],
    ['fractional quantity', { items: [{ lineItemId: LI1, quantity: 1.5, reason: 'doesnt_fit' }] }, /quantity/],
    ['unknown reason', { items: [{ lineItemId: LI1, quantity: 1, reason: 'because' }] }, /reason/],
    ['duplicate item', { items: [{ lineItemId: LI1, quantity: 1, reason: 'doesnt_fit' }, { lineItemId: LI1, quantity: 1, reason: 'other' }] }, /once/],
  ])('400 on %s before any Shopify call', async (_name, patch, msg) => {
    await expect(ReturnValidation.validateCreate(shop(), { ...good(), ...patch })).rejects.toMatchObject({ status: 400, message: msg });
    expect(request).not.toHaveBeenCalled();
  });

  it('refuses EXCHANGE while the feature is off', async () => {
    await expect(ReturnValidation.validateCreate(shop(), { ...good(), resolution: 'EXCHANGE' }))
      .rejects.toMatchObject({ status: 400, message: /not available yet/ });
    expect(request).not.toHaveBeenCalled();
  });
});

describe('validateCreate — against Shopify', () => {
  it('404 when the email does not belong to the order', async () => {
    await expect(ReturnValidation.validateCreate(shop(), { ...good(), customerEmail: 'someone@else.com' }))
      .rejects.toMatchObject({ status: 404 });
  });

  it('400 when an item is not on the order', async () => {
    await expect(ReturnValidation.validateCreate(shop(), { ...good(), items: [{ lineItemId: LI2, quantity: 1, reason: 'other' }] }))
      .rejects.toMatchObject({ status: 400, message: /not on this order/ });
  });

  it('400 when asking for more than is left to return', async () => {
    await expect(ReturnValidation.validateCreate(shop(), { ...good(), items: [{ lineItemId: LI1, quantity: 3, reason: 'other' }] }))
      .rejects.toMatchObject({ status: 400, message: /Only 2/ });
  });

  it('400 when the policy says the item is not returnable', async () => {
    policyEngine.evaluateEligibility.mockResolvedValue({ eligible: false, reason: 'Return window expired (30 days)' });
    await expect(ReturnValidation.validateCreate(shop(), good()))
      .rejects.toMatchObject({ status: 400, message: /Return window expired/ });
  });

  it('400 when the policy does not allow the chosen resolution', async () => {
    policyEngine.evaluateEligibility.mockResolvedValue({
      eligible: true, policy: {}, resolutions: { allowRefund: false, allowStoreCredit: true },
    });
    await expect(ReturnValidation.validateCreate(shop(), good()))
      .rejects.toMatchObject({ status: 400, message: /cannot be returned for refund/ });
  });

  it('409 when every requested item is already covered by an open return', async () => {
    prisma.return.findMany.mockResolvedValue([
      fakeReturn({ items: [fakeReturnItem({ shopifyLineItemId: LI1, quantity: 2 })] }),
    ]);
    await expect(ReturnValidation.validateCreate(shop(), good())).rejects.toMatchObject({ status: 409 });
  });

  it('returns server-built items: Shopify prices and titles, never the client values', async () => {
    const result = await ReturnValidation.validateCreate(shop(), {
      ...good(),
      items: [{ lineItemId: LI1, quantity: 2, reason: 'damaged', reasonDetail: 'torn', unitPrice: 99999, productTitle: 'Yacht' }],
    });
    expect(result.order).toMatchObject({ id: 'gid://shopify/Order/1001', email: 'Jane@X.com', currency: 'GBP' });
    expect(result.items).toEqual([{
      lineItemId: LI1,
      productId: 'gid://shopify/Product/1',
      variantId: 'gid://shopify/ProductVariant/1',
      productTitle: 'Wool jumper',
      variantTitle: 'M / Navy',
      sku: 'WJ-M-NAV',
      quantity: 2,
      unitPrice: 47.5,
      reason: 'damaged',
      reasonDetail: 'torn',
      photoUrls: [],
    }]);
  });
});
