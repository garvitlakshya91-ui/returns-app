const { installPrismaMock, fakeShop } = require('../helpers');

let prisma;
let planGate;
let loadShopFromBody;
let PLAN_LIMITS;

beforeEach(() => {
  jest.resetModules();
  prisma = installPrismaMock();
  ({ planGate, loadShopFromBody, PLAN_LIMITS } = require('../../app/middleware/planGating'));
});

function res() {
  return {
    statusCode: 200,
    payload: null,
    status(c) { this.statusCode = c; return this; },
    json(o) { this.payload = o; return this; },
  };
}

describe('PLAN_LIMITS shape', () => {
  it('declares all four plans', () => {
    expect(Object.keys(PLAN_LIMITS).sort()).toEqual(['FREE', 'GROWTH', 'PRO', 'STARTER']);
  });

  it('FREE allows 30 returns/mo, no exchanges, no analytics', () => {
    expect(PLAN_LIMITS.FREE.returnsPerMonth).toBe(30);
    expect(PLAN_LIMITS.FREE.exchanges).toBe(false);
    expect(PLAN_LIMITS.FREE.analytics).toBe(false);
  });

  it('STARTER allows exchanges but not analytics', () => {
    expect(PLAN_LIMITS.STARTER.exchanges).toBe(true);
    expect(PLAN_LIMITS.STARTER.analytics).toBe(false);
  });

  it('GROWTH and PRO have unlimited returns and full analytics', () => {
    expect(PLAN_LIMITS.GROWTH.returnsPerMonth).toBe(Infinity);
    expect(PLAN_LIMITS.GROWTH.analytics).toBe(true);
    expect(PLAN_LIMITS.PRO.analytics).toBe(true);
  });
});

describe('planGate("createReturn")', () => {
  it('rejects with 401 when req.shop is missing', () => {
    const r = res(); const next = jest.fn();
    planGate('createReturn')({}, r, next);
    expect(r.statusCode).toBe(401);
    expect(next).not.toHaveBeenCalled();
  });

  it('allows when shop is under the monthly limit', () => {
    const r = res(); const next = jest.fn();
    planGate('createReturn')({ shop: fakeShop({ plan: 'FREE', returnCount: 5 }) }, r, next);
    expect(next).toHaveBeenCalled();
  });

  it('rejects with 403 + upgradeRequired when at the FREE limit', () => {
    const r = res(); const next = jest.fn();
    planGate('createReturn')({ shop: fakeShop({ plan: 'FREE', returnCount: 30 }) }, r, next);
    expect(r.statusCode).toBe(403);
    expect(r.payload).toMatchObject({ upgradeRequired: true, plan: 'FREE' });
    expect(next).not.toHaveBeenCalled();
  });

  it('respects STARTER cap of 150', () => {
    const r = res(); const next = jest.fn();
    planGate('createReturn')({ shop: fakeShop({ plan: 'STARTER', returnCount: 150 }) }, r, next);
    expect(r.statusCode).toBe(403);
  });

  it('GROWTH and PRO are never capped', () => {
    const r1 = res(); const r2 = res();
    const n1 = jest.fn(); const n2 = jest.fn();
    planGate('createReturn')({ shop: fakeShop({ plan: 'GROWTH', returnCount: 1_000_000 }) }, r1, n1);
    planGate('createReturn')({ shop: fakeShop({ plan: 'PRO', returnCount: 1_000_000 }) }, r2, n2);
    expect(n1).toHaveBeenCalled();
    expect(n2).toHaveBeenCalled();
  });
});

describe('planGate("exchanges")', () => {
  it('blocks FREE', () => {
    const r = res(); const next = jest.fn();
    planGate('exchanges')({ shop: fakeShop({ plan: 'FREE' }) }, r, next);
    expect(r.statusCode).toBe(403);
    expect(r.payload.error).toMatch(/Starter/);
    expect(next).not.toHaveBeenCalled();
  });

  it('allows STARTER, GROWTH, PRO', () => {
    for (const plan of ['STARTER', 'GROWTH', 'PRO']) {
      const r = res(); const next = jest.fn();
      planGate('exchanges')({ shop: fakeShop({ plan }) }, r, next);
      expect(next).toHaveBeenCalled();
    }
  });
});

describe('planGate("analytics")', () => {
  it('blocks FREE and STARTER', () => {
    for (const plan of ['FREE', 'STARTER']) {
      const r = res(); const next = jest.fn();
      planGate('analytics')({ shop: fakeShop({ plan }) }, r, next);
      expect(r.statusCode).toBe(403);
      expect(r.payload.error).toMatch(/Growth/);
    }
  });

  it('allows GROWTH and PRO', () => {
    for (const plan of ['GROWTH', 'PRO']) {
      const r = res(); const next = jest.fn();
      planGate('analytics')({ shop: fakeShop({ plan }) }, r, next);
      expect(next).toHaveBeenCalled();
    }
  });
});

describe('loadShopFromBody', () => {
  it('returns 400 when neither body.shopId nor params.shopId is set', async () => {
    const r = res(); const next = jest.fn();
    await loadShopFromBody({ body: {}, params: {} }, r, next);
    expect(r.statusCode).toBe(400);
    expect(next).not.toHaveBeenCalled();
  });

  it('returns 404 when the shop is not in DB', async () => {
    prisma.shop.findUnique.mockResolvedValue(null);
    const r = res(); const next = jest.fn();
    await loadShopFromBody({ body: { shopId: 'missing' }, params: {} }, r, next);
    expect(r.statusCode).toBe(404);
    expect(next).not.toHaveBeenCalled();
  });

  it('attaches req.shop / req.shopId and calls next', async () => {
    const shop = fakeShop({ id: 'shop_abc' });
    prisma.shop.findUnique.mockResolvedValue(shop);
    const req = { body: { shopId: 'shop_abc' }, params: {} };
    const next = jest.fn();
    await loadShopFromBody(req, res(), next);
    expect(next).toHaveBeenCalled();
    expect(req.shop).toBe(shop);
    expect(req.shopId).toBe('shop_abc');
  });

  it('falls back to params.shopId when body has none', async () => {
    const shop = fakeShop({ id: 'shop_from_params' });
    prisma.shop.findUnique.mockResolvedValue(shop);
    const req = { body: undefined, params: { shopId: 'shop_from_params' } };
    const next = jest.fn();
    await loadShopFromBody(req, res(), next);
    expect(next).toHaveBeenCalled();
  });

  it('returns 500 when Prisma throws', async () => {
    prisma.shop.findUnique.mockRejectedValue(new Error('db dead'));
    const r = res(); const next = jest.fn();
    await loadShopFromBody({ body: { shopId: 'x' }, params: {} }, r, next);
    expect(r.statusCode).toBe(500);
  });
});
