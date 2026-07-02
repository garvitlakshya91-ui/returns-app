const { installPrismaMock, installShopifyMock, fakeShop } = require('../helpers');

let prisma;
let shopify;
let ShopToken;
let encrypt;

beforeEach(() => {
  jest.resetModules();
  prisma = installPrismaMock();
  shopify = installShopifyMock();
  ShopToken = require('../../app/services/ShopToken');
  ({ encrypt } = require('../../app/utils/encryption'));
});

function expiringBlob({ accessToken = 'tok_live', minutesUntilExpiry = 30, refreshDays = 60 } = {}) {
  return encrypt(JSON.stringify({
    accessToken,
    refreshToken: 'refresh_abc',
    expiresAt: new Date(Date.now() + minutesUntilExpiry * 60 * 1000).toISOString(),
    refreshTokenExpiresAt: new Date(Date.now() + refreshDays * 24 * 3600 * 1000).toISOString(),
  }));
}

describe('ShopToken', () => {
  it('serializeSession stores expiring sessions as JSON and legacy as bare token', () => {
    const expiring = ShopToken.serializeSession({
      accessToken: 'a',
      refreshToken: 'r',
      expires: new Date(),
      refreshTokenExpires: new Date(),
    });
    expect(ShopToken.parseStored(expiring)).toMatchObject({ accessToken: 'a', refreshToken: 'r' });

    const legacy = ShopToken.serializeSession({ accessToken: 'bare_token' });
    expect(ShopToken.parseStored(legacy)).toMatchObject({ accessToken: 'bare_token', refreshToken: null });
  });

  it('getAccessToken returns a legacy token without refreshing', async () => {
    const shop = fakeShop({ shopifyToken: encrypt('legacy_token') });
    await expect(ShopToken.getAccessToken(shop)).resolves.toBe('legacy_token');
    expect(shopify.auth.tokenExchange).not.toHaveBeenCalled();
  });

  it('getAccessToken returns a still-fresh expiring token without refreshing', async () => {
    const shop = fakeShop({ shopifyToken: expiringBlob({ minutesUntilExpiry: 30 }) });
    await expect(ShopToken.getAccessToken(shop)).resolves.toBe('tok_live');
  });

  it('getAccessToken refreshes an expired token and persists the new pair', async () => {
    const shop = fakeShop({ shopifyToken: expiringBlob({ minutesUntilExpiry: 1 }) });
    shopify.auth.refreshToken = jest.fn().mockResolvedValue({
      session: {
        accessToken: 'tok_new',
        refreshToken: 'refresh_new',
        expires: new Date(Date.now() + 3600 * 1000),
        refreshTokenExpires: new Date(Date.now() + 90 * 24 * 3600 * 1000),
      },
    });
    prisma.shop.update.mockResolvedValue({});

    await expect(ShopToken.getAccessToken(shop)).resolves.toBe('tok_new');
    expect(shopify.auth.refreshToken).toHaveBeenCalledWith({
      shop: shop.shopifyDomain,
      refreshToken: 'refresh_abc',
    });
    const saved = prisma.shop.update.mock.calls[0][0];
    expect(ShopToken.parseStored(saved.data.shopifyToken)).toMatchObject({
      accessToken: 'tok_new',
      refreshToken: 'refresh_new',
    });
  });

  it('clears the stored token when refresh fails so the next request re-auths', async () => {
    const shop = fakeShop({ shopifyToken: expiringBlob({ minutesUntilExpiry: 0 }) });
    shopify.auth.refreshToken = jest.fn().mockRejectedValue(new Error('invalid_grant'));
    prisma.shop.update.mockResolvedValue({});

    await expect(ShopToken.getAccessToken(shop)).rejects.toThrow('invalid_grant');
    expect(prisma.shop.update).toHaveBeenCalledWith(expect.objectContaining({
      data: { shopifyToken: '' },
    }));
  });

  it('needsReauth: false for legacy + fresh expiring, true for missing or dead refresh token', () => {
    expect(ShopToken.needsReauth(fakeShop({ shopifyToken: encrypt('legacy') }))).toBe(false);
    expect(ShopToken.needsReauth(fakeShop({ shopifyToken: expiringBlob() }))).toBe(false);
    expect(ShopToken.needsReauth(fakeShop({ shopifyToken: '' }))).toBe(true);
    expect(ShopToken.needsReauth(fakeShop({ shopifyToken: expiringBlob({ refreshDays: -1 }) }))).toBe(true);
  });
});
