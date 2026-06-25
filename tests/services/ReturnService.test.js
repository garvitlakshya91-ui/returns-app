const { installPrismaMock, fakeReturn, fakeReturnItem } = require('../helpers');

let prisma;
let ReturnService;
let eventBus;
const { RETURN_CREATED } = require('../../app/events/emitters');

beforeEach(() => {
  jest.resetModules();
  prisma = installPrismaMock();
  ReturnService = require('../../app/services/ReturnService');
  eventBus = require('../../app/events/eventBus');
});

describe('ReturnService.createReturn', () => {
  it('computes totalValue from items and creates the return', async () => {
    const created = fakeReturn({ totalValue: 95.0 });
    prisma.return.create.mockResolvedValue(created);
    prisma.shop.update.mockResolvedValue({});

    const result = await ReturnService.createReturn({
      shopId: 'shop_test_1',
      shopifyOrderId: 'gid://shopify/Order/1',
      shopifyOrderName: '#1001',
      customerEmail: 'jane@example.com',
      customerName: 'Jane',
      items: [
        { lineItemId: 'li1', productTitle: 'Item A', quantity: 2, unitPrice: 25.0, reason: 'doesnt_fit' },
        { lineItemId: 'li2', productTitle: 'Item B', quantity: 1, unitPrice: 45.0, reason: 'damaged' },
      ],
      resolution: 'REFUND',
    });

    const createArgs = prisma.return.create.mock.calls[0][0];
    expect(createArgs.data.totalValue).toBe(95.0);
    expect(createArgs.data.items.create).toHaveLength(2);
    expect(result).toEqual(created);
  });

  it('computes returnFee from the default policy and the items reasons', async () => {
    prisma.returnPolicy.findFirst.mockResolvedValue({
      fees: { changedMind: 3, doesntFit: 1, damaged: 0 },
    });
    prisma.return.create.mockResolvedValue(fakeReturn());
    prisma.shop.update.mockResolvedValue({});

    await ReturnService.createReturn({
      shopId: 'shop_test_1',
      shopifyOrderId: 'o1',
      shopifyOrderName: '#1',
      customerEmail: 'e@x.com',
      customerName: 'E',
      items: [
        { lineItemId: 'li1', productTitle: 'A', quantity: 1, unitPrice: 20, reason: 'doesnt_fit' },
        { lineItemId: 'li2', productTitle: 'B', quantity: 1, unitPrice: 20, reason: 'changed_mind' },
      ],
      resolution: 'REFUND',
    });

    // Max fee across reasons (changed_mind = 3) is applied once per return.
    expect(prisma.return.create.mock.calls[0][0].data.returnFee).toBe(3);
  });

  it('defaults returnFee to 0 when no policy / fees are configured', async () => {
    prisma.returnPolicy.findFirst.mockResolvedValue(null);
    prisma.return.create.mockResolvedValue(fakeReturn());
    prisma.shop.update.mockResolvedValue({});

    await ReturnService.createReturn({
      shopId: 'shop_test_1',
      shopifyOrderId: 'o1',
      shopifyOrderName: '#1',
      customerEmail: 'e@x.com',
      customerName: 'E',
      items: [{ lineItemId: 'li', productTitle: 'X', quantity: 1, unitPrice: 10, reason: 'changed_mind' }],
      resolution: 'REFUND',
    });

    expect(prisma.return.create.mock.calls[0][0].data.returnFee).toBe(0);
  });

  it('increments the shop returnCount', async () => {
    prisma.return.create.mockResolvedValue(fakeReturn());
    prisma.shop.update.mockResolvedValue({});

    await ReturnService.createReturn({
      shopId: 'shop_test_1',
      shopifyOrderId: 'o1',
      shopifyOrderName: '#1',
      customerEmail: 'e@x.com',
      customerName: 'E',
      items: [{ lineItemId: 'li', productTitle: 'X', quantity: 1, unitPrice: 10, reason: 'other' }],
      resolution: 'REFUND',
    });

    expect(prisma.shop.update).toHaveBeenCalledWith({
      where: { id: 'shop_test_1' },
      data: { returnCount: { increment: 1 } },
    });
  });

  it('emits RETURN_CREATED with returnId and shopId', async () => {
    const created = fakeReturn({ id: 'ret_new' });
    prisma.return.create.mockResolvedValue(created);
    prisma.shop.update.mockResolvedValue({});

    const spy = jest.spyOn(eventBus, 'emit');

    await ReturnService.createReturn({
      shopId: 'shop_test_1',
      shopifyOrderId: 'o1',
      shopifyOrderName: '#1',
      customerEmail: 'e@x.com',
      customerName: 'E',
      items: [{ lineItemId: 'li', productTitle: 'X', quantity: 1, unitPrice: 10, reason: 'other' }],
      resolution: 'REFUND',
    });

    expect(spy).toHaveBeenCalledWith(RETURN_CREATED, {
      returnId: 'ret_new',
      shopId: 'shop_test_1',
    });
  });
});

describe('ReturnService.getReturn', () => {
  it('scopes findFirst by shopId', async () => {
    prisma.return.findFirst.mockResolvedValue(fakeReturn());
    await ReturnService.getReturn('ret_test_1', 'shop_test_1');
    expect(prisma.return.findFirst).toHaveBeenCalledWith({
      where: { id: 'ret_test_1', shopId: 'shop_test_1' },
      include: expect.any(Object),
    });
  });

  it('returns null when not found', async () => {
    prisma.return.findFirst.mockResolvedValue(null);
    expect(await ReturnService.getReturn('x', 'y')).toBeNull();
  });
});

describe('ReturnService.listReturns', () => {
  it('filters by status when provided', async () => {
    prisma.return.findMany.mockResolvedValue([]);
    prisma.return.count.mockResolvedValue(0);
    await ReturnService.listReturns('shop_test_1', { status: 'APPROVED' });
    expect(prisma.return.findMany).toHaveBeenCalledWith(expect.objectContaining({
      where: { shopId: 'shop_test_1', status: 'APPROVED' },
    }));
  });

  it('paginates with skip and take', async () => {
    prisma.return.findMany.mockResolvedValue([]);
    prisma.return.count.mockResolvedValue(0);
    await ReturnService.listReturns('shop_test_1', { page: 3, limit: 10 });
    expect(prisma.return.findMany).toHaveBeenCalledWith(expect.objectContaining({
      skip: 20, take: 10,
    }));
  });

  it('returns total alongside results', async () => {
    prisma.return.findMany.mockResolvedValue([fakeReturn()]);
    prisma.return.count.mockResolvedValue(42);
    const result = await ReturnService.listReturns('shop_test_1');
    expect(result.total).toBe(42);
    expect(result.returns).toHaveLength(1);
  });
});
