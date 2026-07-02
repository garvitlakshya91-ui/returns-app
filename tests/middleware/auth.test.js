const { installPrismaMock, installShopifyMock, fakeShop } = require('../helpers');

let prisma;
let shopify;
let verifyShopifySession;

function runMiddleware(req) {
  const res = {
    statusCode: 200,
    payload: null,
    status(code) { this.statusCode = code; return this; },
    json(obj) { this.payload = obj; return this; },
  };
  return new Promise((resolve) => {
    verifyShopifySession(req, res, () => resolve({ req, res, called: true }));
    // give the async path a tick
    setImmediate(() => resolve({ req, res, called: false }));
  });
}

beforeEach(() => {
  jest.resetModules();
  prisma = installPrismaMock();
  shopify = installShopifyMock();
  verifyShopifySession = require('../../app/middleware/auth').verifyShopifySession;
});

describe('verifyShopifySession', () => {
  it('returns 401 when Authorization header is missing', async () => {
    const res = {
      status: jest.fn().mockReturnThis(),
      json: jest.fn().mockReturnThis(),
    };
    const next = jest.fn();
    await verifyShopifySession({ headers: {} }, res, next);
    expect(res.status).toHaveBeenCalledWith(401);
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ error: expect.stringMatching(/Missing/) }));
    expect(next).not.toHaveBeenCalled();
  });

  it('returns 401 when the bearer token is malformed (no "Bearer " prefix)', async () => {
    const res = { status: jest.fn().mockReturnThis(), json: jest.fn().mockReturnThis() };
    const next = jest.fn();
    await verifyShopifySession({ headers: { authorization: 'tokenWithoutBearer' } }, res, next);
    expect(res.status).toHaveBeenCalledWith(401);
    expect(next).not.toHaveBeenCalled();
  });

  it('returns 401 when shopify.session.decodeSessionToken throws', async () => {
    shopify.session.decodeSessionToken.mockRejectedValue(new Error('bad jwt'));
    const res = { status: jest.fn().mockReturnThis(), json: jest.fn().mockReturnThis() };
    const next = jest.fn();
    await verifyShopifySession({ headers: { authorization: 'Bearer x' } }, res, next);
    expect(res.status).toHaveBeenCalledWith(401);
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ error: expect.stringMatching(/Invalid session/) }));
  });

  it('returns 401 when shop is not in our DB and token exchange fails', async () => {
    shopify.session.decodeSessionToken.mockResolvedValue({ dest: 'https://unknown.myshopify.com' });
    prisma.shop.findUnique.mockResolvedValue(null);
    shopify.auth.tokenExchange.mockRejectedValue(new Error('exchange refused'));
    const res = { status: jest.fn().mockReturnThis(), json: jest.fn().mockReturnThis() };
    const next = jest.fn();
    await verifyShopifySession({ headers: { authorization: 'Bearer abc' } }, res, next);
    expect(res.status).toHaveBeenCalledWith(401);
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ error: expect.stringMatching(/reinstall/) }));
  });

  it('provisions a fresh managed-install shop via token exchange (no /auth/callback ever ran)', async () => {
    shopify.session.decodeSessionToken.mockResolvedValue({ dest: 'https://newshop.myshopify.com' });
    prisma.shop.findUnique.mockResolvedValue(null); // fresh install: no row
    shopify.auth.tokenExchange.mockResolvedValue({
      session: { shop: 'newshop.myshopify.com', accessToken: 'offline_token_123' },
    });
    shopify.request.mockResolvedValue({
      data: { shop: { name: 'New Shop', email: 'owner@newshop.com', myshopifyDomain: 'newshop.myshopify.com' } },
    });
    const created = fakeShop({ id: 'shop_new', shopifyDomain: 'newshop.myshopify.com' });
    prisma.shop.upsert.mockResolvedValue(created);

    const req = { headers: { authorization: 'Bearer fresh_install_token' } };
    const res = { status: jest.fn().mockReturnThis(), json: jest.fn().mockReturnThis() };
    const next = jest.fn();
    await verifyShopifySession(req, res, next);

    expect(shopify.auth.tokenExchange).toHaveBeenCalledWith(expect.objectContaining({
      shop: 'newshop.myshopify.com',
      sessionToken: 'fresh_install_token',
    }));
    expect(prisma.shop.upsert).toHaveBeenCalledWith(expect.objectContaining({
      where: { shopifyDomain: 'newshop.myshopify.com' },
    }));
    expect(next).toHaveBeenCalled();
    expect(req.shop).toBe(created);
    expect(req.shopId).toBe('shop_new');
  });

  it('re-provisions a reinstalled shop whose token was cleared by app/uninstalled', async () => {
    shopify.session.decodeSessionToken.mockResolvedValue({ dest: 'https://test-shop.myshopify.com' });
    // Row exists but the uninstall webhook wiped the token
    prisma.shop.findUnique.mockResolvedValue(fakeShop({ shopifyToken: '' }));
    shopify.auth.tokenExchange.mockResolvedValue({
      session: { shop: 'test-shop.myshopify.com', accessToken: 'offline_token_456' },
    });
    shopify.request.mockResolvedValue({
      data: { shop: { name: 'Test Shop', email: 'test@shop.com', myshopifyDomain: 'test-shop.myshopify.com' } },
    });
    const refreshed = fakeShop({ shopifyToken: 'enc:new' });
    prisma.shop.upsert.mockResolvedValue(refreshed);

    const req = { headers: { authorization: 'Bearer reinstall_token' } };
    const res = { status: jest.fn().mockReturnThis(), json: jest.fn().mockReturnThis() };
    const next = jest.fn();
    await verifyShopifySession(req, res, next);

    expect(shopify.auth.tokenExchange).toHaveBeenCalled();
    expect(next).toHaveBeenCalled();
    expect(req.shop).toBe(refreshed);
  });

  it('attaches req.shop / req.shopId / req.shopDomain and calls next on success', async () => {
    shopify.session.decodeSessionToken.mockResolvedValue({ dest: 'https://test-shop.myshopify.com' });
    // A genuinely-encrypted legacy (non-expiring) token — needsReauth must
    // treat it as valid without attempting token exchange.
    const { encrypt } = require('../../app/utils/encryption');
    const shop = fakeShop({ id: 'shop_abc', shopifyToken: encrypt('legacy_offline_token') });
    prisma.shop.findUnique.mockResolvedValue(shop);

    const req = { headers: { authorization: 'Bearer good_token' } };
    const res = { status: jest.fn().mockReturnThis(), json: jest.fn().mockReturnThis() };
    const next = jest.fn();
    await verifyShopifySession(req, res, next);

    expect(next).toHaveBeenCalled();
    expect(req.shop).toBe(shop);
    expect(req.shopId).toBe('shop_abc');
    expect(req.shopDomain).toBe('test-shop.myshopify.com');
  });
});
