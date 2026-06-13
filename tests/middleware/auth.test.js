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

  it('returns 401 when shop is not in our DB', async () => {
    shopify.session.decodeSessionToken.mockResolvedValue({ dest: 'https://unknown.myshopify.com' });
    prisma.shop.findUnique.mockResolvedValue(null);
    const res = { status: jest.fn().mockReturnThis(), json: jest.fn().mockReturnThis() };
    const next = jest.fn();
    await verifyShopifySession({ headers: { authorization: 'Bearer abc' } }, res, next);
    expect(res.status).toHaveBeenCalledWith(401);
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ error: expect.stringMatching(/reinstall/) }));
  });

  it('attaches req.shop / req.shopId / req.shopDomain and calls next on success', async () => {
    shopify.session.decodeSessionToken.mockResolvedValue({ dest: 'https://test-shop.myshopify.com' });
    const shop = fakeShop({ id: 'shop_abc' });
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
