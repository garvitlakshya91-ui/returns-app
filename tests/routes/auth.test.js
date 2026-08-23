// Legacy OAuth flow: GET /auth (begin) and GET /auth/callback (exchange code,
// persist shop with encrypted token, register webhooks, redirect to the app).
const request = require('supertest');
const express = require('express');
const { installPrismaMock, installShopifyMock, fakeShop } = require('../helpers');

let app;
let prisma;
let shopify;
let shopInstall;
let eventBus;
let ShopToken;
let consoleError;

beforeEach(() => {
  jest.resetModules();
  prisma = installPrismaMock();
  shopify = installShopifyMock();

  jest.doMock('../../app/services/shopInstall', () => ({
    registerWebhooks: jest.fn().mockResolvedValue(undefined),
    installShopFromTokenExchange: jest.fn(),
  }));
  shopInstall = require('../../app/services/shopInstall');
  eventBus = require('../../app/events/eventBus');
  ShopToken = require('../../app/services/ShopToken');

  consoleError = jest.spyOn(console, 'error').mockImplementation(() => {});

  app = express();
  app.use(require('../../app/routes/auth'));
});

afterEach(() => {
  eventBus.removeAllListeners();
  consoleError.mockRestore();
});

describe('GET /auth', () => {
  it('400 when the shop query parameter is missing', async () => {
    const res = await request(app).get('/auth');
    expect(res.status).toBe(400);
    expect(res.text).toMatch(/Missing shop parameter/);
    expect(shopify.auth.begin).not.toHaveBeenCalled();
  });

  it('begins an OFFLINE OAuth flow for the shop and lets shopify-api write the redirect', async () => {
    shopify.auth.begin.mockImplementation(async ({ rawResponse }) => {
      rawResponse.redirect(302, 'https://my-store.myshopify.com/admin/oauth/authorize?client_id=test_api_key');
    });

    const res = await request(app).get('/auth?shop=my-store.myshopify.com');

    expect(res.status).toBe(302);
    expect(res.headers.location).toMatch(/^https:\/\/my-store\.myshopify\.com\/admin\/oauth\/authorize/);
    expect(shopify.auth.begin).toHaveBeenCalledTimes(1);
    const args = shopify.auth.begin.mock.calls[0][0];
    expect(args).toMatchObject({
      shop: 'my-store.myshopify.com',
      callbackPath: '/auth/callback',
      isOnline: false,
    });
    expect(args.rawRequest).toBeDefined();
    expect(args.rawResponse).toBeDefined();
  });

  it('maps an invalid shop domain rejected by shopify-api to a 400 "Invalid shop parameter" (no redirect)', async () => {
    shopify.auth.begin.mockRejectedValue(new Error('Received invalid shop argument'));
    const res = await request(app).get('/auth?shop=not-a-shopify-domain');
    expect(res.status).toBe(400);
    expect(res.text).toMatch(/Invalid shop parameter/);
    expect(res.headers.location).toBeUndefined();
  });

  it('maps any other failure to begin the flow to a 500 "Could not start installation"', async () => {
    shopify.auth.begin.mockRejectedValue(new Error('network down'));
    const res = await request(app).get('/auth?shop=my-store.myshopify.com');
    expect(res.status).toBe(500);
    expect(res.text).toMatch(/Could not start installation/);
    expect(res.headers.location).toBeUndefined();
  });
});

describe('GET /auth/callback', () => {
  const session = {
    id: 'offline_my-store.myshopify.com',
    shop: 'my-store.myshopify.com',
    accessToken: 'shpat_offline_token',
    refreshToken: 'shprt_refresh',
    expires: new Date('2026-08-23T12:00:00Z'),
    refreshTokenExpires: new Date('2026-11-21T12:00:00Z'),
  };

  function happyPath() {
    shopify.auth.callback.mockResolvedValue({ session });
    shopify.request.mockResolvedValue({
      data: { shop: { name: 'My Store', email: 'owner@my-store.com', myshopifyDomain: 'my-store.myshopify.com' } },
    });
    prisma.shop.upsert.mockResolvedValue(fakeShop({ id: 'shop_cb', shopifyDomain: 'my-store.myshopify.com' }));
  }

  it('stores the shop with an encrypted token, registers webhooks, emits SHOP_INSTALLED and redirects into the app', async () => {
    happyPath();
    const { SHOP_INSTALLED } = require('../../app/events/emitters');
    const installed = jest.fn();
    eventBus.on(SHOP_INSTALLED, installed);

    const res = await request(app).get('/auth/callback?shop=my-store.myshopify.com&host=aG9zdA&code=abc&state=xyz');

    expect(shopify.auth.callback).toHaveBeenCalledWith(expect.objectContaining({
      rawRequest: expect.anything(),
      rawResponse: expect.anything(),
    }));

    // Shop details fetched with the freshly-issued session
    expect(shopify.__module.clients.Graphql).toHaveBeenCalledWith({ session });
    expect(shopify.request).toHaveBeenCalledWith(expect.stringContaining('myshopifyDomain'));

    // Upsert keyed by domain; token is never stored in plaintext
    expect(prisma.shop.upsert).toHaveBeenCalledTimes(1);
    const upsert = prisma.shop.upsert.mock.calls[0][0];
    expect(upsert.where).toEqual({ shopifyDomain: 'my-store.myshopify.com' });
    expect(upsert.create).toMatchObject({
      shopifyDomain: 'my-store.myshopify.com',
      name: 'My Store',
      email: 'owner@my-store.com',
    });
    expect(upsert.update).toMatchObject({ name: 'My Store', email: 'owner@my-store.com' });
    for (const blob of [upsert.create.shopifyToken, upsert.update.shopifyToken]) {
      expect(blob).not.toContain('shpat_offline_token');
      expect(blob).not.toContain('shprt_refresh');
      expect(ShopToken.parseStored(blob)).toMatchObject({
        accessToken: 'shpat_offline_token',
        refreshToken: 'shprt_refresh',
        expiresAt: '2026-08-23T12:00:00.000Z',
        refreshTokenExpiresAt: '2026-11-21T12:00:00.000Z',
      });
    }

    expect(shopInstall.registerWebhooks).toHaveBeenCalledWith(session);
    expect(installed).toHaveBeenCalledWith({ shopId: 'shop_cb', shopDomain: 'my-store.myshopify.com' });

    expect(res.status).toBe(302);
    expect(res.headers.location).toBe('/?shop=my-store.myshopify.com&host=aG9zdA');
  });

  it('stores a legacy non-expiring session as a bare encrypted token', async () => {
    happyPath();
    shopify.auth.callback.mockResolvedValue({
      session: { shop: 'my-store.myshopify.com', accessToken: 'shpat_legacy' },
    });
    await request(app).get('/auth/callback?shop=my-store.myshopify.com&host=h');
    const blob = prisma.shop.upsert.mock.calls[0][0].create.shopifyToken;
    expect(blob).not.toContain('shpat_legacy');
    expect(ShopToken.parseStored(blob)).toEqual({
      accessToken: 'shpat_legacy', refreshToken: null, expiresAt: null, refreshTokenExpiresAt: null,
    });
  });

  it('500 with a friendly message when shopify-api rejects the callback (bad state / HMAC)', async () => {
    shopify.auth.callback.mockRejectedValue(new Error('Invalid OAuth callback'));
    const res = await request(app).get('/auth/callback?shop=my-store.myshopify.com&code=bad');
    expect(res.status).toBe(500);
    expect(res.text).toMatch(/Error completing OAuth/);
    expect(prisma.shop.upsert).not.toHaveBeenCalled();
    expect(shopInstall.registerWebhooks).not.toHaveBeenCalled();
    expect(consoleError).toHaveBeenCalledWith('OAuth callback error:', expect.any(Error));
  });

  it('500 and no webhooks/event when the shop upsert fails', async () => {
    happyPath();
    prisma.shop.upsert.mockRejectedValue(new Error('db down'));
    const { SHOP_INSTALLED } = require('../../app/events/emitters');
    const installed = jest.fn();
    eventBus.on(SHOP_INSTALLED, installed);

    const res = await request(app).get('/auth/callback?shop=my-store.myshopify.com&host=h');
    expect(res.status).toBe(500);
    expect(shopInstall.registerWebhooks).not.toHaveBeenCalled();
    expect(installed).not.toHaveBeenCalled();
  });

  it('500 when the shop GraphQL lookup fails (token is not persisted without shop details)', async () => {
    happyPath();
    shopify.request.mockRejectedValue(new Error('GraphQL 401'));
    const res = await request(app).get('/auth/callback?shop=my-store.myshopify.com&host=h');
    expect(res.status).toBe(500);
    expect(prisma.shop.upsert).not.toHaveBeenCalled();
  });
});
