const { installPrismaMock } = require('../helpers');

let prisma;
let PolicyEngine;

beforeEach(() => {
  jest.resetModules();
  prisma = installPrismaMock();
  PolicyEngine = require('../../app/services/PolicyEngine');
});

function policy(overrides = {}) {
  return {
    id: 'pol_1',
    shopId: 'shop_test_1',
    name: 'Default',
    windowDays: 30,
    conditions: {},
    resolutions: { allowRefund: true, allowStoreCredit: true, allowExchange: false },
    fees: null,
    isDefault: true,
    isActive: true,
    ...overrides,
  };
}

describe('PolicyEngine.evaluateEligibility', () => {
  it('returns ineligible when shop has no policies', async () => {
    prisma.returnPolicy.findMany.mockResolvedValue([]);
    const result = await PolicyEngine.evaluateEligibility('shop_test_1', { price: 50 }, new Date().toISOString());
    expect(result).toEqual({ eligible: false, reason: 'No active return policy' });
  });

  it('returns eligible when default policy matches and window is open', async () => {
    prisma.returnPolicy.findMany.mockResolvedValue([policy()]);
    const fulfilledAt = new Date(Date.now() - 5 * 86400000).toISOString();
    const result = await PolicyEngine.evaluateEligibility('shop_test_1', { price: 50 }, fulfilledAt);
    expect(result.eligible).toBe(true);
    expect(result.policy.id).toBe('pol_1');
  });

  it('returns ineligible when fulfillment is older than windowDays', async () => {
    prisma.returnPolicy.findMany.mockResolvedValue([policy({ windowDays: 30 })]);
    const fulfilledAt = new Date(Date.now() - 60 * 86400000).toISOString();
    const result = await PolicyEngine.evaluateEligibility('shop_test_1', { price: 50 }, fulfilledAt);
    expect(result.eligible).toBe(false);
    expect(result.reason).toMatch(/30 days/);
  });

  it('passes through resolutions and fees', async () => {
    const fees = { changedMind: 2.5, doesntFit: 0 };
    prisma.returnPolicy.findMany.mockResolvedValue([policy({ fees })]);
    const fulfilledAt = new Date().toISOString();
    const result = await PolicyEngine.evaluateEligibility('shop_test_1', { price: 50 }, fulfilledAt);
    expect(result.fees).toEqual(fees);
    expect(result.resolutions.allowRefund).toBe(true);
  });
});

describe('PolicyEngine.matchesConditions', () => {
  it('matches when conditions is null/undefined', () => {
    expect(PolicyEngine.matchesConditions(null, { price: 10 })).toBe(true);
    expect(PolicyEngine.matchesConditions(undefined, { price: 10 })).toBe(true);
  });

  it('rejects when price below minPrice', () => {
    expect(PolicyEngine.matchesConditions({ minPrice: 20 }, { price: 10 })).toBe(false);
  });

  it('rejects when price above maxPrice', () => {
    expect(PolicyEngine.matchesConditions({ maxPrice: 5 }, { price: 10 })).toBe(false);
  });

  it('accepts when price within bounds', () => {
    expect(PolicyEngine.matchesConditions({ minPrice: 5, maxPrice: 50 }, { price: 25 })).toBe(true);
  });

  it('matches productTags by intersection', () => {
    expect(PolicyEngine.matchesConditions(
      { productTags: ['sale', 'final'] },
      { tags: ['sale'], price: 10 },
    )).toBe(true);
  });

  it('rejects when productTags has no overlap', () => {
    expect(PolicyEngine.matchesConditions(
      { productTags: ['final'] },
      { tags: ['sale'], price: 10 },
    )).toBe(false);
  });

  it('matches collections by intersection', () => {
    expect(PolicyEngine.matchesConditions(
      { collections: ['winter-2026'] },
      { collections: ['winter-2026', 'sale'], price: 10 },
    )).toBe(true);
  });
});
