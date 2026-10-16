// A new shop starts with a default return policy, or nothing is returnable.

const { installPrismaMock } = require('../helpers');
const { SHOP_INSTALLED } = require('../../app/events/emitters');

let prisma;
let eventBus;
let ensureDefaultPolicy;
let DEFAULT_POLICY;

beforeEach(() => {
  jest.resetModules();
  prisma = installPrismaMock();
  jest.doMock('../../app/utils/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
  ({ ensureDefaultPolicy, DEFAULT_POLICY } = require('../../app/events/handlers/onShopInstalled'));
  eventBus = require('../../app/events/eventBus');
});

const flush = () => new Promise((r) => setImmediate(r));

describe('onShopInstalled', () => {
  it('creates a 30-day refund + store-credit default policy for a shop with none', async () => {
    prisma.returnPolicy.count.mockResolvedValue(0);
    prisma.returnPolicy.create.mockResolvedValue({ id: 'pol_new' });

    eventBus.emit(SHOP_INSTALLED, { shopId: 'shop_new', shopDomain: 'new.myshopify.com' });
    await flush();

    expect(prisma.returnPolicy.create).toHaveBeenCalledWith({
      data: {
        shopId: 'shop_new',
        name: 'Standard returns',
        windowDays: 30,
        conditions: {},
        resolutions: { allowRefund: true, allowStoreCredit: true, allowExchange: false },
        fees: { changedMind: 0, doesntFit: 0, damaged: 0 },
        isDefault: true,
        isActive: true,
      },
    });
    expect(DEFAULT_POLICY.isDefault).toBe(true);
  });

  it('leaves an existing shop\'s policies alone on reinstall', async () => {
    prisma.returnPolicy.count.mockResolvedValue(2);
    expect(await ensureDefaultPolicy('shop_old')).toBeNull();
    expect(prisma.returnPolicy.create).not.toHaveBeenCalled();
  });

  it('a database failure is logged, never thrown into the event bus', async () => {
    prisma.returnPolicy.count.mockRejectedValue(new Error('db down'));
    const logger = require('../../app/utils/logger');
    eventBus.emit(SHOP_INSTALLED, { shopId: 'shop_x', shopDomain: 'x.myshopify.com' });
    await flush();
    expect(logger.error).toHaveBeenCalledWith(expect.objectContaining({ err: 'db down', shopId: 'shop_x' }), expect.any(String));
  });
});
