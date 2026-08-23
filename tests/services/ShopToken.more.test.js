// Additional branch coverage for app/services/ShopToken.js:
// refresh margin, in-flight dedupe, failure surfacing, needsReauth edge cases,
// parseStored tolerance, serializeSession shape, graphqlClient wiring.
const { installPrismaMock, installShopifyMock, fakeShop } = require('../helpers');

let prisma;
let shopify;
let ShopToken;
let encrypt;
let decrypt;

beforeEach(() => {
  jest.resetModules();
  prisma = installPrismaMock();
  shopify = installShopifyMock();
  jest.doMock('../../app/utils/logger', () => ({
    info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn(),
  }));
  ShopToken = require('../../app/services/ShopToken');
  ({ encrypt, decrypt } = require('../../app/utils/encryption'));
});

function blob({ accessToken = 'tok_live', refreshToken = 'refresh_abc', expiresAt, refreshTokenExpiresAt } = {}) {
  return encrypt(JSON.stringify({ accessToken, refreshToken, expiresAt, refreshTokenExpiresAt }));
}
const inMinutes = (m) => new Date(Date.now() + m * 60 * 1000).toISOString();
const inDays = (d) => new Date(Date.now() + d * 24 * 3600 * 1000).toISOString();

function refreshedSession(accessToken = 'tok_new') {
  return {
    session: {
      accessToken,
      refreshToken: 'refresh_new',
      expires: new Date(Date.now() + 3600 * 1000),
      refreshTokenExpires: new Date(Date.now() + 90 * 24 * 3600 * 1000),
    },
  };
}

describe('serializeSession', () => {
  it('encrypts (never stores plaintext) and produces the iv:tag:ciphertext format', () => {
    const out = ShopToken.serializeSession({ accessToken: 'shpat_secret', refreshToken: 'shprt_secret' });
    expect(out.split(':')).toHaveLength(3);
    expect(out).not.toContain('shpat_secret');
    expect(out).not.toContain('shprt_secret');
    expect(JSON.parse(decrypt(out))).toEqual({
      accessToken: 'shpat_secret', refreshToken: 'shprt_secret', expiresAt: null, refreshTokenExpiresAt: null,
    });
  });

  it('normalises Date / string / epoch expiries to ISO strings', () => {
    const out = ShopToken.serializeSession({
      accessToken: 'a', refreshToken: 'r',
      expires: '2026-08-23T10:00:00.000Z',
      refreshTokenExpires: Date.UTC(2026, 10, 21),
    });
    expect(ShopToken.parseStored(out)).toEqual({
      accessToken: 'a', refreshToken: 'r',
      expiresAt: '2026-08-23T10:00:00.000Z',
      refreshTokenExpiresAt: '2026-11-21T00:00:00.000Z',
    });
  });

  it('a session without refreshToken is stored as a bare token (no JSON wrapper)', () => {
    const out = ShopToken.serializeSession({ accessToken: 'bare', expires: new Date() });
    expect(decrypt(out)).toBe('bare');
  });

  it('two serialisations of the same session differ (random IV) but decode identically', () => {
    const s = { accessToken: 'a', refreshToken: 'r' };
    const a = ShopToken.serializeSession(s);
    const b = ShopToken.serializeSession(s);
    expect(a).not.toBe(b);
    expect(ShopToken.parseStored(a)).toEqual(ShopToken.parseStored(b));
  });
});

describe('parseStored', () => {
  it('legacy bare token → accessToken with null refresh fields', () => {
    expect(ShopToken.parseStored(encrypt('shpat_legacy'))).toEqual({
      accessToken: 'shpat_legacy', refreshToken: null, expiresAt: null, refreshTokenExpiresAt: null,
    });
  });

  it('JSON blob with accessToken → parsed object as-is', () => {
    const stored = { accessToken: 'a', refreshToken: 'r', expiresAt: inMinutes(10), refreshTokenExpiresAt: inDays(1), extra: 1 };
    expect(ShopToken.parseStored(encrypt(JSON.stringify(stored)))).toEqual(stored);
  });

  it('JSON that is not a token object (no accessToken) is treated as a bare legacy token', () => {
    const weird = '{"foo":"bar"}';
    expect(ShopToken.parseStored(encrypt(weird))).toEqual({
      accessToken: weird, refreshToken: null, expiresAt: null, refreshTokenExpiresAt: null,
    });
    const num = '12345';
    expect(ShopToken.parseStored(encrypt(num))).toMatchObject({ accessToken: num, refreshToken: null });
  });

  it('throws on an undecryptable blob', () => {
    expect(() => ShopToken.parseStored('not:a:blob')).toThrow();
    expect(() => ShopToken.parseStored('garbage')).toThrow();
  });
});

describe('needsReauth', () => {
  it('true for null shop / empty token / undecryptable blob', () => {
    expect(ShopToken.needsReauth(null)).toBe(true);
    expect(ShopToken.needsReauth(undefined)).toBe(true);
    expect(ShopToken.needsReauth(fakeShop({ shopifyToken: '' }))).toBe(true);
    expect(ShopToken.needsReauth(fakeShop({ shopifyToken: null }))).toBe(true);
    expect(ShopToken.needsReauth(fakeShop({ shopifyToken: 'deadbeef:garbage:zz' }))).toBe(true);
  });

  it('false for expiring tokens whose refresh token has no recorded expiry', () => {
    expect(ShopToken.needsReauth(fakeShop({ shopifyToken: blob({ refreshTokenExpiresAt: null }) }))).toBe(false);
  });

  it('false when the refresh token is still valid even if the access token itself is expired', () => {
    expect(ShopToken.needsReauth(fakeShop({
      shopifyToken: blob({ expiresAt: inMinutes(-120), refreshTokenExpiresAt: inDays(30) }),
    }))).toBe(false);
  });

  it('true once the refresh token expiry is reached (boundary inclusive)', () => {
    const now = Date.now();
    jest.spyOn(Date, 'now').mockReturnValue(now);
    const exact = new Date(now).toISOString();
    expect(ShopToken.needsReauth(fakeShop({ shopifyToken: blob({ refreshTokenExpiresAt: exact }) }))).toBe(true);
    expect(ShopToken.needsReauth(fakeShop({ shopifyToken: blob({ refreshTokenExpiresAt: new Date(now + 1000).toISOString() }) }))).toBe(false);
    Date.now.mockRestore();
  });
});

describe('getAccessToken — refresh margin', () => {
  it('throws a descriptive error when no token is stored (names the shop)', async () => {
    await expect(ShopToken.getAccessToken(fakeShop({ shopifyToken: '' })))
      .rejects.toThrow('No Shopify access token stored for test-shop.myshopify.com');
    await expect(ShopToken.getAccessToken(null)).rejects.toThrow('unknown shop');
    expect(shopify.auth.tokenExchange).not.toHaveBeenCalled();
  });

  it('does NOT refresh when more than 5 minutes remain', async () => {
    shopify.auth.refreshToken = jest.fn();
    const shop = fakeShop({ shopifyToken: blob({ expiresAt: inMinutes(6), refreshTokenExpiresAt: inDays(30) }) });
    await expect(ShopToken.getAccessToken(shop)).resolves.toBe('tok_live');
    expect(shopify.auth.refreshToken).not.toHaveBeenCalled();
    expect(prisma.shop.update).not.toHaveBeenCalled();
  });

  it('refreshes when within the 5-minute margin even though the token is not yet expired', async () => {
    shopify.auth.refreshToken = jest.fn().mockResolvedValue(refreshedSession('tok_early'));
    prisma.shop.update.mockResolvedValue({});
    const shop = fakeShop({ id: 'shop_m', shopifyToken: blob({ expiresAt: inMinutes(4), refreshTokenExpiresAt: inDays(30) }) });
    await expect(ShopToken.getAccessToken(shop)).resolves.toBe('tok_early');
    expect(shopify.auth.refreshToken).toHaveBeenCalledWith({ shop: 'test-shop.myshopify.com', refreshToken: 'refresh_abc' });
    expect(prisma.shop.update).toHaveBeenCalledWith({
      where: { id: 'shop_m' },
      data: { shopifyToken: expect.any(String) },
    });
  });

  it('refreshes when expiresAt is missing on an expiring token (treated as already expired)', async () => {
    shopify.auth.refreshToken = jest.fn().mockResolvedValue(refreshedSession('tok_noexp'));
    prisma.shop.update.mockResolvedValue({});
    const shop = fakeShop({ shopifyToken: blob({ expiresAt: null, refreshTokenExpiresAt: inDays(30) }) });
    await expect(ShopToken.getAccessToken(shop)).resolves.toBe('tok_noexp');
    expect(shopify.auth.refreshToken).toHaveBeenCalledTimes(1);
  });

  it('persists the refreshed pair encrypted with ISO expiries', async () => {
    const resp = refreshedSession('tok_new');
    shopify.auth.refreshToken = jest.fn().mockResolvedValue(resp);
    prisma.shop.update.mockResolvedValue({});
    const shop = fakeShop({ shopifyToken: blob({ expiresAt: inMinutes(1), refreshTokenExpiresAt: inDays(30) }) });
    await ShopToken.getAccessToken(shop);
    const saved = prisma.shop.update.mock.calls[0][0].data.shopifyToken;
    expect(saved).not.toContain('tok_new');
    expect(ShopToken.parseStored(saved)).toEqual({
      accessToken: 'tok_new',
      refreshToken: 'refresh_new',
      expiresAt: resp.session.expires.toISOString(),
      refreshTokenExpiresAt: resp.session.refreshTokenExpires.toISOString(),
    });
  });
});

describe('getAccessToken — in-flight dedupe', () => {
  it('two concurrent callers share one refresh request and both get the new token', async () => {
    let resolveRefresh;
    shopify.auth.refreshToken = jest.fn(() => new Promise((r) => { resolveRefresh = r; }));
    prisma.shop.update.mockResolvedValue({});
    const shop = fakeShop({ id: 'shop_c', shopifyToken: blob({ expiresAt: inMinutes(0), refreshTokenExpiresAt: inDays(30) }) });

    const p1 = ShopToken.getAccessToken(shop);
    const p2 = ShopToken.getAccessToken(shop);
    const p3 = ShopToken.getAccessToken({ ...shop }); // different object, same shop id
    expect(shopify.auth.refreshToken).toHaveBeenCalledTimes(1);

    resolveRefresh(refreshedSession('tok_shared'));
    await expect(Promise.all([p1, p2, p3])).resolves.toEqual(['tok_shared', 'tok_shared', 'tok_shared']);
    expect(shopify.auth.refreshToken).toHaveBeenCalledTimes(1);
    expect(prisma.shop.update).toHaveBeenCalledTimes(1);
  });

  it('the in-flight slot is released after completion (a later expired call refreshes again)', async () => {
    shopify.auth.refreshToken = jest.fn().mockResolvedValue(refreshedSession('tok_1'));
    prisma.shop.update.mockResolvedValue({});
    const shop = fakeShop({ id: 'shop_c', shopifyToken: blob({ expiresAt: inMinutes(0), refreshTokenExpiresAt: inDays(30) }) });
    await ShopToken.getAccessToken(shop);
    await ShopToken.getAccessToken(shop); // caller still holds the stale row
    expect(shopify.auth.refreshToken).toHaveBeenCalledTimes(2);
  });

  it('different shops refresh independently', async () => {
    shopify.auth.refreshToken = jest.fn().mockResolvedValue(refreshedSession('tok_x'));
    prisma.shop.update.mockResolvedValue({});
    const a = fakeShop({ id: 'shop_a', shopifyDomain: 'a.myshopify.com', shopifyToken: blob({ expiresAt: inMinutes(0), refreshTokenExpiresAt: inDays(30) }) });
    const b = fakeShop({ id: 'shop_b', shopifyDomain: 'b.myshopify.com', shopifyToken: blob({ expiresAt: inMinutes(0), refreshTokenExpiresAt: inDays(30) }) });
    await Promise.all([ShopToken.getAccessToken(a), ShopToken.getAccessToken(b)]);
    expect(shopify.auth.refreshToken).toHaveBeenCalledTimes(2);
    expect(shopify.auth.refreshToken).toHaveBeenCalledWith(expect.objectContaining({ shop: 'a.myshopify.com' }));
    expect(shopify.auth.refreshToken).toHaveBeenCalledWith(expect.objectContaining({ shop: 'b.myshopify.com' }));
  });
});

describe('getAccessToken — refresh failure', () => {
  it('surfaces the refresh error to every concurrent caller and clears the token once', async () => {
    let rejectRefresh;
    shopify.auth.refreshToken = jest.fn(() => new Promise((_, rej) => { rejectRefresh = rej; }));
    prisma.shop.update.mockResolvedValue({});
    const shop = fakeShop({ id: 'shop_f', shopifyToken: blob({ expiresAt: inMinutes(0), refreshTokenExpiresAt: inDays(30) }) });

    const p1 = ShopToken.getAccessToken(shop);
    const p2 = ShopToken.getAccessToken(shop);
    const boom = new Error('invalid_grant');
    rejectRefresh(boom);
    await expect(p1).rejects.toBe(boom);
    await expect(p2).rejects.toBe(boom);
    expect(prisma.shop.update).toHaveBeenCalledTimes(1);
    expect(prisma.shop.update).toHaveBeenCalledWith({ where: { id: 'shop_f' }, data: { shopifyToken: '' } });
  });

  it('still rethrows the original error when clearing the token also fails', async () => {
    shopify.auth.refreshToken = jest.fn().mockRejectedValue(new Error('invalid_grant'));
    prisma.shop.update.mockRejectedValue(new Error('db down'));
    const shop = fakeShop({ shopifyToken: blob({ expiresAt: inMinutes(0), refreshTokenExpiresAt: inDays(30) }) });
    await expect(ShopToken.getAccessToken(shop)).rejects.toThrow('invalid_grant');
  });

  it('a failure to persist the refreshed pair is treated as a refresh failure (token cleared, error thrown)', async () => {
    shopify.auth.refreshToken = jest.fn().mockResolvedValue(refreshedSession('tok_new'));
    prisma.shop.update
      .mockRejectedValueOnce(new Error('write failed'))
      .mockResolvedValueOnce({});
    const shop = fakeShop({ id: 'shop_p', shopifyToken: blob({ expiresAt: inMinutes(0), refreshTokenExpiresAt: inDays(30) }) });
    await expect(ShopToken.getAccessToken(shop)).rejects.toThrow('write failed');
    expect(prisma.shop.update).toHaveBeenLastCalledWith({ where: { id: 'shop_p' }, data: { shopifyToken: '' } });
  });
});

describe('graphqlClient', () => {
  it('builds a Graphql client with the shop domain and a (refreshed) access token', async () => {
    shopify.auth.refreshToken = jest.fn().mockResolvedValue(refreshedSession('tok_fresh'));
    prisma.shop.update.mockResolvedValue({});
    const shop = fakeShop({ shopifyDomain: 'g.myshopify.com', shopifyToken: blob({ expiresAt: inMinutes(1), refreshTokenExpiresAt: inDays(30) }) });
    const client = await ShopToken.graphqlClient(shop);
    expect(client).toBe(shopify);
    expect(shopify.__module.clients.Graphql).toHaveBeenCalledWith({
      session: { shop: 'g.myshopify.com', accessToken: 'tok_fresh' },
    });
  });

  it('uses the legacy token directly without any refresh', async () => {
    shopify.auth.refreshToken = jest.fn();
    const shop = fakeShop({ shopifyDomain: 'l.myshopify.com', shopifyToken: encrypt('legacy_tok') });
    await ShopToken.graphqlClient(shop);
    expect(shopify.auth.refreshToken).not.toHaveBeenCalled();
    expect(shopify.__module.clients.Graphql).toHaveBeenCalledWith({
      session: { shop: 'l.myshopify.com', accessToken: 'legacy_tok' },
    });
  });

  it('propagates the no-token error without constructing a client', async () => {
    await expect(ShopToken.graphqlClient(fakeShop({ shopifyToken: '' }))).rejects.toThrow(/No Shopify access token/);
    expect(shopify.__module.clients.Graphql).not.toHaveBeenCalled();
  });
});
