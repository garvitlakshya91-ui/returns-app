// app/services/shopInstall.js — managed-install provisioning via token exchange
// and webhook registration. (Auth-middleware integration is covered in
// tests/middleware/auth.test.js; this file targets the service directly.)
const { installPrismaMock, installShopifyMock, fakeShop } = require('../helpers');

let prisma;
let shopify;
let logger;
let eventBus;
let ShopToken;
let shopInstall;
let RequestedTokenType;

const SHOP_QUERY = /query\s*\{\s*shop/;
const WEBHOOK_MUTATION = /webhookSubscriptionCreate/;

function happyShopify({ accessToken = 'shpat_new', refreshToken = 'shprt_new' } = {}) {
  const session = {
    shop: 'fresh.myshopify.com',
    accessToken,
    refreshToken,
    expires: new Date(Date.now() + 3600 * 1000),
    refreshTokenExpires: new Date(Date.now() + 90 * 24 * 3600 * 1000),
  };
  shopify.auth.tokenExchange.mockResolvedValue({ session });
  shopify.request.mockImplementation(async (query) => {
    if (SHOP_QUERY.test(query)) {
      return { data: { shop: { name: 'Fresh Shop', email: 'hi@fresh.com', myshopifyDomain: 'fresh.myshopify.com' } } };
    }
    if (WEBHOOK_MUTATION.test(query)) {
      return { data: { webhookSubscriptionCreate: { webhookSubscription: { id: 'gid://shopify/WebhookSubscription/1' }, userErrors: [] } } };
    }
    throw new Error(`unexpected query: ${query}`);
  });
  return session;
}

const flush = () => new Promise((r) => setImmediate(r));

beforeEach(() => {
  jest.resetModules();
  prisma = installPrismaMock();
  shopify = installShopifyMock();
  jest.doMock('../../app/utils/logger', () => ({
    info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn(),
  }));
  logger = require('../../app/utils/logger');
  eventBus = require('../../app/events/eventBus');
  ShopToken = require('../../app/services/ShopToken');
  ({ RequestedTokenType } = require('@shopify/shopify-api'));
  shopInstall = require('../../app/services/shopInstall');
});

afterEach(() => {
  eventBus.removeAllListeners();
});

describe('installShopFromTokenExchange', () => {
  it('requests an EXPIRING offline token for the shop + session token', async () => {
    happyShopify();
    prisma.shop.upsert.mockResolvedValue(fakeShop({ id: 'shop_f', shopifyDomain: 'fresh.myshopify.com' }));

    await shopInstall.installShopFromTokenExchange('fresh.myshopify.com', 'jwt.session.token');

    expect(shopify.auth.tokenExchange).toHaveBeenCalledTimes(1);
    expect(shopify.auth.tokenExchange).toHaveBeenCalledWith({
      shop: 'fresh.myshopify.com',
      sessionToken: 'jwt.session.token',
      requestedTokenType: RequestedTokenType.OfflineAccessToken,
      expiring: true,
    });
    expect(shopify.auth.tokenExchange.mock.calls[0][0].requestedTokenType)
      .toBe('urn:shopify:params:oauth:token-type:offline-access-token');
  });

  it('upserts the Shop keyed by domain with the encrypted expiring token pair and shop details', async () => {
    const session = happyShopify();
    const created = fakeShop({ id: 'shop_f', shopifyDomain: 'fresh.myshopify.com' });
    prisma.shop.upsert.mockResolvedValue(created);

    const result = await shopInstall.installShopFromTokenExchange('fresh.myshopify.com', 'jwt');
    expect(result).toBe(created);

    expect(shopify.__module.clients.Graphql).toHaveBeenCalledWith({ session });
    expect(prisma.shop.upsert).toHaveBeenCalledTimes(1);
    const upsert = prisma.shop.upsert.mock.calls[0][0];
    expect(upsert.where).toEqual({ shopifyDomain: 'fresh.myshopify.com' });
    expect(Object.keys(upsert.create).sort()).toEqual(['email', 'name', 'shopifyDomain', 'shopifyToken']);
    expect(Object.keys(upsert.update).sort()).toEqual(['email', 'name', 'shopifyToken']);
    expect(upsert.create).toMatchObject({ shopifyDomain: 'fresh.myshopify.com', name: 'Fresh Shop', email: 'hi@fresh.com' });
    expect(upsert.update).toMatchObject({ name: 'Fresh Shop', email: 'hi@fresh.com' });
    // Same blob on both branches; encrypted, not plaintext; decodes to the pair
    expect(upsert.create.shopifyToken).toBe(upsert.update.shopifyToken);
    expect(upsert.create.shopifyToken).not.toContain('shpat_new');
    expect(upsert.create.shopifyToken).not.toContain('shprt_new');
    expect(ShopToken.parseStored(upsert.create.shopifyToken)).toMatchObject({
      accessToken: 'shpat_new',
      refreshToken: 'shprt_new',
      expiresAt: session.expires.toISOString(),
      refreshTokenExpiresAt: session.refreshTokenExpires.toISOString(),
    });
    // The plan is NOT touched on (re)install — a FREE default comes from the schema
    expect(upsert.create).not.toHaveProperty('plan');
    expect(upsert.update).not.toHaveProperty('plan');
  });

  it('emits SHOP_INSTALLED with the new shop id and logs provisioning', async () => {
    happyShopify();
    prisma.shop.upsert.mockResolvedValue(fakeShop({ id: 'shop_f', shopifyDomain: 'fresh.myshopify.com' }));
    const { SHOP_INSTALLED } = require('../../app/events/emitters');
    const installed = jest.fn();
    eventBus.on(SHOP_INSTALLED, installed);

    await shopInstall.installShopFromTokenExchange('fresh.myshopify.com', 'jwt');

    expect(installed).toHaveBeenCalledWith({ shopId: 'shop_f', shopDomain: 'fresh.myshopify.com' });
    expect(logger.info).toHaveBeenCalledWith(
      { shopDomain: 'fresh.myshopify.com', shopId: 'shop_f' },
      'Shop provisioned via token exchange',
    );
  });

  it('registers the four lifecycle webhooks against HOST (fire-and-forget after upsert)', async () => {
    happyShopify();
    prisma.shop.upsert.mockResolvedValue(fakeShop({ id: 'shop_f' }));

    await shopInstall.installShopFromTokenExchange('fresh.myshopify.com', 'jwt');
    await flush(); await flush(); await flush(); await flush(); await flush();

    const mutationCalls = shopify.request.mock.calls.filter(([q]) => WEBHOOK_MUTATION.test(q));
    expect(mutationCalls).toHaveLength(4);
    const registered = mutationCalls.map(([, opts]) => [
      opts.variables.topic,
      opts.variables.webhookSubscription.callbackUrl,
      opts.variables.webhookSubscription.format,
    ]);
    expect(registered).toEqual([
      ['ORDERS_CREATE', 'https://test.local/webhooks/orders/create', 'JSON'],
      ['ORDERS_FULFILLED', 'https://test.local/webhooks/orders/fulfilled', 'JSON'],
      ['APP_UNINSTALLED', 'https://test.local/webhooks/app/uninstalled', 'JSON'],
      ['SHOP_UPDATE', 'https://test.local/webhooks/shop/update', 'JSON'],
    ]);
    expect(logger.info).toHaveBeenCalledWith({ topic: 'APP_UNINSTALLED' }, 'Webhook registered');
  });

  it('a failing webhook registration is logged per-topic and does not fail provisioning', async () => {
    happyShopify();
    shopify.request.mockImplementation(async (query) => {
      if (SHOP_QUERY.test(query)) {
        return { data: { shop: { name: 'Fresh Shop', email: 'hi@fresh.com', myshopifyDomain: 'fresh.myshopify.com' } } };
      }
      throw new Error('webhook quota exceeded');
    });
    const created = fakeShop({ id: 'shop_f' });
    prisma.shop.upsert.mockResolvedValue(created);

    await expect(shopInstall.installShopFromTokenExchange('fresh.myshopify.com', 'jwt')).resolves.toBe(created);
    await flush(); await flush(); await flush(); await flush(); await flush();

    const failures = logger.error.mock.calls.filter(([, msg]) => msg === 'Failed to register webhook');
    expect(failures).toHaveLength(4);
    expect(failures.map(([ctx]) => ctx.topic)).toEqual(['ORDERS_CREATE', 'ORDERS_FULFILLED', 'APP_UNINSTALLED', 'SHOP_UPDATE']);
  });

  it('403 refusal: logs Shopify\'s status + response body, rethrows, and never writes the shop', async () => {
    const err = new Error('Received an error response (403 Forbidden) from Shopify');
    err.response = {
      code: 403,
      statusText: 'Forbidden',
      body: { error: 'invalid_request', error_description: 'Legacy non-expiring tokens are not allowed for this app' },
    };
    shopify.auth.tokenExchange.mockRejectedValue(err);

    await expect(shopInstall.installShopFromTokenExchange('fresh.myshopify.com', 'jwt')).rejects.toBe(err);

    expect(logger.error).toHaveBeenCalledWith(
      {
        shopDomain: 'fresh.myshopify.com',
        status: 403,
        body: err.response.body,
        message: err.message,
      },
      'Token exchange refused by Shopify',
    );
    expect(shopify.request).not.toHaveBeenCalled();
    expect(prisma.shop.upsert).not.toHaveBeenCalled();
  });

  it('refusal without a response object still logs and rethrows (network error)', async () => {
    const err = new Error('ECONNRESET');
    shopify.auth.tokenExchange.mockRejectedValue(err);
    await expect(shopInstall.installShopFromTokenExchange('fresh.myshopify.com', 'jwt')).rejects.toThrow('ECONNRESET');
    expect(logger.error).toHaveBeenCalledWith(
      expect.objectContaining({ shopDomain: 'fresh.myshopify.com', status: undefined, body: undefined, message: 'ECONNRESET' }),
      'Token exchange refused by Shopify',
    );
    expect(prisma.shop.upsert).not.toHaveBeenCalled();
  });

  it('dedupes concurrent installs for the same shop into one token exchange + one upsert', async () => {
    let resolveExchange;
    shopify.auth.tokenExchange.mockImplementation(() => new Promise((r) => { resolveExchange = r; }));
    shopify.request.mockResolvedValue({
      data: { shop: { name: 'Fresh Shop', email: 'hi@fresh.com', myshopifyDomain: 'fresh.myshopify.com' } },
    });
    const created = fakeShop({ id: 'shop_f' });
    prisma.shop.upsert.mockResolvedValue(created);

    const p1 = shopInstall.installShopFromTokenExchange('fresh.myshopify.com', 'jwt-1');
    const p2 = shopInstall.installShopFromTokenExchange('fresh.myshopify.com', 'jwt-2');
    const p3 = shopInstall.installShopFromTokenExchange('fresh.myshopify.com', 'jwt-3');
    expect(shopify.auth.tokenExchange).toHaveBeenCalledTimes(1);

    resolveExchange({ session: { shop: 'fresh.myshopify.com', accessToken: 'tok', refreshToken: 'r' } });
    const results = await Promise.all([p1, p2, p3]);
    expect(results).toEqual([created, created, created]);
    expect(shopify.auth.tokenExchange).toHaveBeenCalledTimes(1);
    expect(prisma.shop.upsert).toHaveBeenCalledTimes(1);

    // Once settled, a later call starts a fresh exchange
    shopify.auth.tokenExchange.mockResolvedValue({ session: { shop: 'fresh.myshopify.com', accessToken: 'tok2' } });
    await shopInstall.installShopFromTokenExchange('fresh.myshopify.com', 'jwt-4');
    expect(shopify.auth.tokenExchange).toHaveBeenCalledTimes(2);
  });

  it('does not dedupe across different shop domains', async () => {
    happyShopify();
    prisma.shop.upsert.mockResolvedValue(fakeShop());
    await Promise.all([
      shopInstall.installShopFromTokenExchange('a.myshopify.com', 'jwt-a'),
      shopInstall.installShopFromTokenExchange('b.myshopify.com', 'jwt-b'),
    ]);
    expect(shopify.auth.tokenExchange).toHaveBeenCalledTimes(2);
    expect(prisma.shop.upsert).toHaveBeenCalledTimes(2);
  });

  it('the in-flight entry is cleared after a failure so the next attempt retries', async () => {
    shopify.auth.tokenExchange.mockRejectedValueOnce(new Error('boom'));
    await expect(shopInstall.installShopFromTokenExchange('fresh.myshopify.com', 'jwt')).rejects.toThrow('boom');

    happyShopify();
    prisma.shop.upsert.mockResolvedValue(fakeShop({ id: 'shop_f' }));
    await expect(shopInstall.installShopFromTokenExchange('fresh.myshopify.com', 'jwt')).resolves.toMatchObject({ id: 'shop_f' });
    expect(shopify.auth.tokenExchange).toHaveBeenCalledTimes(2);
  });
});

describe('registerWebhooks', () => {
  it('uses a GraphQL client bound to the given session', async () => {
    const session = { shop: 's.myshopify.com', accessToken: 'tok' };
    shopify.request.mockResolvedValue({ data: { webhookSubscriptionCreate: { webhookSubscription: { id: '1' }, userErrors: [] } } });
    await shopInstall.registerWebhooks(session);
    expect(shopify.__module.clients.Graphql).toHaveBeenCalledWith({ session });
    expect(shopify.request).toHaveBeenCalledTimes(4);
    for (const [query] of shopify.request.mock.calls) {
      expect(query).toMatch(/mutation webhookSubscriptionCreate/);
      expect(query).toMatch(/userErrors/);
    }
  });

  it('continues with the remaining topics when one fails', async () => {
    shopify.request
      .mockResolvedValueOnce({ data: {} })
      .mockRejectedValueOnce(new Error('nope'))
      .mockResolvedValue({ data: {} });
    await expect(shopInstall.registerWebhooks({ shop: 's.myshopify.com', accessToken: 'tok' })).resolves.toBeUndefined();
    expect(shopify.request).toHaveBeenCalledTimes(4);
    expect(logger.error).toHaveBeenCalledTimes(1);
    expect(logger.error).toHaveBeenCalledWith(
      expect.objectContaining({ topic: 'ORDERS_FULFILLED', err: expect.any(Error) }),
      'Failed to register webhook',
    );
  });
});
