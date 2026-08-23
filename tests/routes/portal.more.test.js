// Additional behavioural coverage for the public customer portal API.
// Complements tests/routes/portal.test.js (which covers the basic 400/404/201
// paths) — this file focuses on eligibility filtering, payload pass-through,
// error paths, photo uploads, presigned URLs and drop-off lookup.
const request = require('supertest');
const express = require('express');
const { installPrismaMock, installShopifyMock, fakeShop, fakeReturn, fakeReturnItem } = require('../helpers');
const { encrypt } = require('../../app/utils/encryption');

let app;
let prisma;
let shopifyClient;
let policyEngine;
let returnService;
let storage;
let labelService;
let dropoffAdapter;

// Tiny valid-enough PNG header; multer never inspects content so any bytes work,
// but keep it image-shaped for realism.
const PNG = Buffer.from('89504e470d0a1a0a0000000d49484452', 'hex');

function orderNode(overrides = {}) {
  return {
    id: 'gid://shopify/Order/1001',
    name: '#1001',
    email: 'jane@x.com',
    createdAt: '2026-01-01T00:00:00Z',
    displayFulfillmentStatus: 'FULFILLED',
    fulfillments: [{ createdAt: '2026-01-05T00:00:00Z' }],
    lineItems: { edges: [] },
    ...overrides,
  };
}

function lineItem(overrides = {}) {
  return {
    id: 'gid://shopify/LineItem/1',
    title: 'Wool jumper',
    variantTitle: 'M / Navy',
    quantity: 1,
    sku: 'WJ-M-NAV',
    originalUnitPriceSet: { shopMoney: { amount: '47.50' } },
    image: { url: 'https://cdn/x.jpg' },
    product: {
      id: 'gid://shopify/Product/1',
      tags: ['knitwear'],
      collections: { edges: [{ node: { handle: 'winter' } }] },
    },
    variant: { id: 'gid://shopify/ProductVariant/1' },
    ...overrides,
  };
}

beforeEach(() => {
  jest.resetModules();

  jest.doMock('../../app/middleware/rateLimiter', () => ({
    portalLimiter: (req, res, next) => next(),
    lookupLimiter: (req, res, next) => next(),
    createReturnLimiter: (req, res, next) => next(),
    adminLimiter: (req, res, next) => next(),
  }));

  prisma = installPrismaMock();
  shopifyClient = installShopifyMock();

  policyEngine = {
    evaluateEligibility: jest.fn().mockResolvedValue({ eligible: true, policy: {}, resolutions: {}, fees: null }),
  };
  jest.doMock('../../app/services/PolicyEngine', () => policyEngine);

  returnService = {
    createReturn: jest.fn().mockImplementation(async (args) => ({ id: 'ret_new', returnFee: 0, ...args })),
  };
  jest.doMock('../../app/services/ReturnService', () => returnService);

  storage = {
    uploadReturnPhoto: jest.fn().mockImplementation(async (buf, mime, returnId) => ({
      key: `returns/${returnId}/photos/k`,
      url: `https://r2.test/returns/${returnId}/photos/k`,
    })),
    getPresignedUploadUrl: jest.fn().mockResolvedValue({
      uploadUrl: 'https://r2.test/presigned',
      key: 'returns/r1/photos/abc.png',
      publicUrl: 'https://cdn.test/returns/r1/photos/abc.png',
    }),
  };
  jest.doMock('../../app/services/StorageService', () => storage);

  dropoffAdapter = {
    getDropoffLocations: jest.fn().mockResolvedValue([
      { id: 'loc1', name: 'Corner Shop', address: '1 High St', lat: 51.8, lng: -2.2, distance: 0.3, type: 'parcelshop' },
    ]),
  };
  labelService = { getCarrierAdapter: jest.fn(() => dropoffAdapter) };
  jest.doMock('../../app/services/LabelService', () => labelService);

  app = express();
  app.use(express.json());
  app.use('/api/portal', require('../../app/routes/api/portal'));
});

function primeShopLookup(overrides = {}) {
  prisma.shop.findFirst.mockResolvedValue(fakeShop({
    shopifyToken: encrypt('shpat_x'),
    policies: [],
    ...overrides,
  }));
}

describe('POST /api/portal/lookup — shop resolution & Shopify query', () => {
  it('finds the shop by the exact myshopify domain for the slug (no substring match), only among installed shops, with active policies', async () => {
    prisma.shop.findFirst.mockResolvedValue(null);
    const res = await request(app).post('/api/portal/lookup').send({ email: 'jane@x.com', orderNumber: '#1001', shopSlug: 'test-shop' });

    expect(res.status).toBe(404);
    expect(prisma.shop.findFirst).toHaveBeenCalledWith({
      where: { shopifyDomain: 'test-shop.myshopify.com', shopifyToken: { not: '' } },
      include: { policies: { where: { isActive: true } } },
    });
    const where = prisma.shop.findFirst.mock.calls[0][0].where;
    expect(where.shopifyDomain).not.toHaveProperty('contains');
  });

  it('normalises the slug: trims, lower-cases and strips a trailing .myshopify.com', async () => {
    prisma.shop.findFirst.mockResolvedValue(null);
    await request(app).post('/api/portal/lookup').send({ email: 'jane@x.com', orderNumber: '#1001', shopSlug: '  Returns-HJPU8CSZ.myshopify.com ' });

    expect(prisma.shop.findFirst).toHaveBeenCalledWith(expect.objectContaining({
      where: { shopifyDomain: 'returns-hjpu8csz.myshopify.com', shopifyToken: { not: '' } },
    }));
  });

  it('rejects a slug that is not a plain domain label (e.g. path traversal) with 404 and no DB call', async () => {
    for (const shopSlug of ['../etc', 'evil.com', 'a b', '-leading', 'x_y']) {
      const res = await request(app).post('/api/portal/lookup').send({ email: 'jane@x.com', orderNumber: '#1001', shopSlug });
      expect(res.status).toBe(404);
      expect(res.body).toEqual({ error: 'Shop not found' });
    }
    expect(prisma.shop.findFirst).not.toHaveBeenCalled();
  });

  it('queries Shopify with the decrypted token and a quoted name+email search string (leading # stripped)', async () => {
    primeShopLookup();
    shopifyClient.request.mockResolvedValue({ data: { orders: { edges: [] } } });

    await request(app).post('/api/portal/lookup').send({ email: 'jane@x.com', orderNumber: '#1008', shopSlug: 'test-shop' });

    const shopifyMod = shopifyClient.__module;
    expect(shopifyMod.clients.Graphql).toHaveBeenCalledWith({
      session: { shop: 'test-shop.myshopify.com', accessToken: 'shpat_x' },
    });
    const [query, opts] = shopifyClient.request.mock.calls[0];
    expect(query).toMatch(/orders\(first: 1, query: \$query\)/);
    expect(opts.variables.query).toBe('name:"1008" email:"jane@x.com"');
    expect(opts.variables.query).toContain('name:"1008"');
  });

  it('escapes double quotes and backslashes inside the search values so input cannot break out of the quoting', async () => {
    primeShopLookup();
    shopifyClient.request.mockResolvedValue({ data: { orders: { edges: [] } } });

    await request(app).post('/api/portal/lookup').send({ email: 'ja"ne@x.com', orderNumber: '10\\01" OR status:any', shopSlug: 'test-shop' });

    const [, opts] = shopifyClient.request.mock.calls[0];
    expect(opts.variables.query).toBe('name:"10\\\\01\\" OR status:any" email:"ja\\"ne@x.com"');
  });

  it('404 (not a crash) when the matched order has a null email', async () => {
    primeShopLookup();
    shopifyClient.request.mockResolvedValue({
      data: { orders: { edges: [{ node: orderNode({ email: null, lineItems: { edges: [{ node: lineItem() }] } }) }] } },
    });

    const res = await request(app).post('/api/portal/lookup').send({ email: 'jane@x.com', orderNumber: '#1001', shopSlug: 'test-shop' });
    expect(res.status).toBe(404);
    expect(res.body).toEqual({ error: 'Order not found. Please check your email and order number.' });
    expect(policyEngine.evaluateEligibility).not.toHaveBeenCalled();
  });

  it('500 when the stored token cannot be decrypted (ShopToken throws)', async () => {
    primeShopLookup({ shopifyToken: 'not-a-valid-ciphertext' });
    const res = await request(app).post('/api/portal/lookup').send({ email: 'jane@x.com', orderNumber: '#1001', shopSlug: 'test-shop' });
    expect(res.status).toBe(500);
    expect(res.body.error).toBe('Failed to look up order');
    expect(shopifyClient.request).not.toHaveBeenCalled();
  });

  it('500 when the Shopify GraphQL call rejects', async () => {
    primeShopLookup();
    shopifyClient.request.mockRejectedValue(new Error('Shopify 503'));
    const res = await request(app).post('/api/portal/lookup').send({ email: 'jane@x.com', orderNumber: '#1001', shopSlug: 'test-shop' });
    expect(res.status).toBe(500);
    expect(res.body).toEqual({ error: 'Failed to look up order' });
  });

  it('500 when the database lookup throws', async () => {
    prisma.shop.findFirst.mockRejectedValue(new Error('db down'));
    const res = await request(app).post('/api/portal/lookup').send({ email: 'jane@x.com', orderNumber: '#1001', shopSlug: 'test-shop' });
    expect(res.status).toBe(500);
  });
});

describe('POST /api/portal/lookup — eligibility & response shape', () => {
  it('matches order email case-insensitively and returns the full response shape', async () => {
    primeShopLookup();
    shopifyClient.request.mockResolvedValue({
      data: { orders: { edges: [{ node: orderNode({ email: 'Jane@X.com', lineItems: { edges: [{ node: lineItem() }] } }) }] } },
    });

    const res = await request(app).post('/api/portal/lookup').send({ email: 'jane@x.com', orderNumber: '#1001', shopSlug: 'test-shop' });

    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      shopId: 'shop_test_1',
      shopName: 'Test Shop',
      orderId: 'gid://shopify/Order/1001',
      orderName: '#1001',
      email: 'Jane@X.com',
      fulfillmentStatus: 'FULFILLED',
      eligibleItems: [{
        id: 'gid://shopify/LineItem/1',
        lineItemId: 'gid://shopify/LineItem/1',
        productId: 'gid://shopify/Product/1',
        variantId: 'gid://shopify/ProductVariant/1',
        title: 'Wool jumper',
        variantTitle: 'M / Navy',
        price: 47.5,
        quantity: 1,
        sku: 'WJ-M-NAV',
        imageUrl: 'https://cdn/x.jpg',
      }],
    });
    // The response must never leak the shop's token or internal settings.
    expect(res.body).not.toHaveProperty('shopifyToken');
    expect(res.body).not.toHaveProperty('settings');
  });

  it('passes price/tags/collections and the fulfillment date to PolicyEngine for every line item', async () => {
    primeShopLookup();
    shopifyClient.request.mockResolvedValue({
      data: { orders: { edges: [{ node: orderNode({ lineItems: { edges: [{ node: lineItem() }] } }) }] } },
    });

    await request(app).post('/api/portal/lookup').send({ email: 'jane@x.com', orderNumber: '#1001', shopSlug: 'test-shop' });

    expect(policyEngine.evaluateEligibility).toHaveBeenCalledTimes(1);
    expect(policyEngine.evaluateEligibility).toHaveBeenCalledWith(
      'shop_test_1',
      { price: 47.5, tags: ['knitwear'], collections: ['winter'] },
      '2026-01-05T00:00:00Z',
    );
  });

  it('falls back to the order createdAt when the order has no fulfillments', async () => {
    primeShopLookup();
    shopifyClient.request.mockResolvedValue({
      data: { orders: { edges: [{ node: orderNode({ fulfillments: [], lineItems: { edges: [{ node: lineItem() }] } }) }] } },
    });

    await request(app).post('/api/portal/lookup').send({ email: 'jane@x.com', orderNumber: '#1001', shopSlug: 'test-shop' });

    expect(policyEngine.evaluateEligibility.mock.calls[0][2]).toBe('2026-01-01T00:00:00Z');
  });

  it('filters out line items the PolicyEngine marks ineligible', async () => {
    primeShopLookup();
    shopifyClient.request.mockResolvedValue({
      data: {
        orders: {
          edges: [{
            node: orderNode({
              lineItems: {
                edges: [
                  { node: lineItem({ id: 'li_ok', title: 'Returnable' }) },
                  { node: lineItem({ id: 'li_final', title: 'Final sale', product: { id: 'p2', tags: ['final-sale'], collections: { edges: [] } } }) },
                ],
              },
            }),
          }],
        },
      },
    });
    policyEngine.evaluateEligibility.mockImplementation(async (shopId, { tags }) => ({
      eligible: !tags.includes('final-sale'),
      reason: tags.includes('final-sale') ? 'Final sale items cannot be returned' : undefined,
    }));

    const res = await request(app).post('/api/portal/lookup').send({ email: 'jane@x.com', orderNumber: '#1001', shopSlug: 'test-shop' });

    expect(res.status).toBe(200);
    expect(res.body.eligibleItems.map((i) => i.id)).toEqual(['li_ok']);
    expect(policyEngine.evaluateEligibility).toHaveBeenCalledTimes(2);
  });

  it('returns an empty eligibleItems list (200, not 404) when nothing is eligible', async () => {
    primeShopLookup();
    shopifyClient.request.mockResolvedValue({
      data: { orders: { edges: [{ node: orderNode({ lineItems: { edges: [{ node: lineItem() }] } }) }] } },
    });
    policyEngine.evaluateEligibility.mockResolvedValue({ eligible: false, reason: 'Return window expired' });

    const res = await request(app).post('/api/portal/lookup').send({ email: 'jane@x.com', orderNumber: '#1001', shopSlug: 'test-shop' });
    expect(res.status).toBe(200);
    expect(res.body.eligibleItems).toEqual([]);
  });

  it('tolerates line items with no product/variant/image (deleted products)', async () => {
    primeShopLookup();
    shopifyClient.request.mockResolvedValue({
      data: {
        orders: {
          edges: [{
            node: orderNode({
              lineItems: { edges: [{ node: lineItem({ product: null, variant: null, image: null }) }] },
            }),
          }],
        },
      },
    });

    const res = await request(app).post('/api/portal/lookup').send({ email: 'jane@x.com', orderNumber: '#1001', shopSlug: 'test-shop' });

    expect(res.status).toBe(200);
    expect(policyEngine.evaluateEligibility).toHaveBeenCalledWith(
      'shop_test_1',
      { price: 47.5, tags: [], collections: [] },
      expect.any(String),
    );
    // undefined productId/variantId are dropped by JSON serialisation; imageUrl is an explicit null
    expect(res.body.eligibleItems[0]).not.toHaveProperty('productId');
    expect(res.body.eligibleItems[0]).not.toHaveProperty('variantId');
    expect(res.body.eligibleItems[0].imageUrl).toBeNull();
  });
});

describe('POST /api/portal/returns — pass-through & errors', () => {
  const validBody = {
    shopId: 'shop_test_1',
    orderId: 'gid://shopify/Order/1001',
    orderName: '#1001',
    customerEmail: 'jane@x.com',
    customerName: 'Jane Doe',
    items: [{ lineItemId: 'li1', productTitle: 'Tee', quantity: 1, unitPrice: 20, reason: 'doesnt_fit' }],
    resolution: 'REFUND',
  };

  it('loads the shop from body.shopId and passes every field through to ReturnService', async () => {
    prisma.shop.findUnique.mockResolvedValue(fakeShop({ plan: 'GROWTH' }));

    const res = await request(app).post('/api/portal/returns').send(validBody);

    expect(res.status).toBe(201);
    expect(prisma.shop.findUnique).toHaveBeenCalledWith({ where: { id: 'shop_test_1' } });
    expect(returnService.createReturn).toHaveBeenCalledWith({
      shopId: 'shop_test_1',
      shopifyOrderId: 'gid://shopify/Order/1001',
      shopifyOrderName: '#1001',
      customerEmail: 'jane@x.com',
      customerName: 'Jane Doe',
      items: validBody.items,
      resolution: 'REFUND',
    });
    expect(res.body).toMatchObject({ id: 'ret_new', shopId: 'shop_test_1', shopifyOrderId: 'gid://shopify/Order/1001' });
  });

  it('applies documented defaults when orderName / customerEmail / customerName are omitted', async () => {
    prisma.shop.findUnique.mockResolvedValue(fakeShop({ plan: 'GROWTH' }));
    const { orderName, customerEmail, customerName, ...minimal } = validBody;

    const res = await request(app).post('/api/portal/returns').send(minimal);

    expect(res.status).toBe(201);
    expect(returnService.createReturn).toHaveBeenCalledWith(expect.objectContaining({
      shopifyOrderName: 'unknown',
      customerEmail: 'unknown@email.com',
      customerName: 'Customer',
    }));
  });

  it('400 when items is an empty array', async () => {
    prisma.shop.findUnique.mockResolvedValue(fakeShop({ plan: 'GROWTH' }));
    const res = await request(app).post('/api/portal/returns').send({ ...validBody, items: [] });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/items and resolution/);
    expect(returnService.createReturn).not.toHaveBeenCalled();
  });

  it('validates items/resolution before orderId (orderId-less request with no items is a 400 about items)', async () => {
    prisma.shop.findUnique.mockResolvedValue(fakeShop({ plan: 'GROWTH' }));
    const res = await request(app).post('/api/portal/returns').send({ shopId: 'shop_test_1', resolution: 'REFUND' });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/items and resolution/);
  });

  it('allows EXCHANGE on STARTER (first plan with exchanges enabled)', async () => {
    prisma.shop.findUnique.mockResolvedValue(fakeShop({ plan: 'STARTER' }));
    const res = await request(app).post('/api/portal/returns').send({ ...validBody, resolution: 'EXCHANGE' });
    expect(res.status).toBe(201);
    expect(returnService.createReturn).toHaveBeenCalledWith(expect.objectContaining({ resolution: 'EXCHANGE' }));
  });

  it('treats an unknown plan as FREE and blocks exchanges', async () => {
    prisma.shop.findUnique.mockResolvedValue(fakeShop({ plan: 'LEGACY_UNKNOWN' }));
    const res = await request(app).post('/api/portal/returns').send({ ...validBody, resolution: 'EXCHANGE' });
    expect(res.status).toBe(403);
    expect(res.body).toEqual({ error: 'Exchanges require Starter plan or higher', plan: 'LEGACY_UNKNOWN', upgradeRequired: true });
    expect(returnService.createReturn).not.toHaveBeenCalled();
  });

  it('500 when ReturnService.createReturn throws', async () => {
    prisma.shop.findUnique.mockResolvedValue(fakeShop({ plan: 'GROWTH' }));
    returnService.createReturn.mockRejectedValue(new Error('boom'));
    const res = await request(app).post('/api/portal/returns').send(validBody);
    expect(res.status).toBe(500);
    expect(res.body).toEqual({ error: 'Failed to create return' });
  });

  it('500 when the shop lookup itself fails (loadShopFromBody)', async () => {
    prisma.shop.findUnique.mockRejectedValue(new Error('db down'));
    const res = await request(app).post('/api/portal/returns').send(validBody);
    expect(res.status).toBe(500);
    expect(res.body).toEqual({ error: 'Failed to load shop' });
  });
});

describe('GET /api/portal/returns/:id', () => {
  it('returns the public status shape including label and recent events, without leaking internals', async () => {
    const label = { id: 'lbl1', carrier: 'evri', trackingCode: 'TRK123', labelUrl: 'https://r2/label.pdf', qrCodeUrl: null, status: 'created' };
    const events = [{ id: 'ev2', type: 'return.approved', actor: 'merchant', createdAt: '2026-01-16T00:00:00.000Z' }];
    prisma.return.findUnique.mockResolvedValue(fakeReturn({
      items: [fakeReturnItem()],
      label,
      events,
      notes: 'internal merchant note',
      refundAmount: 45,
    }));

    const res = await request(app).get('/api/portal/returns/ret_test_1');

    expect(res.status).toBe(200);
    expect(prisma.return.findUnique).toHaveBeenCalledWith({
      where: { id: 'ret_test_1' },
      include: { items: true, label: true, events: { orderBy: { createdAt: 'desc' }, take: 10 } },
    });
    expect(res.body).toMatchObject({
      id: 'ret_test_1',
      status: 'REQUESTED',
      resolution: 'REFUND',
      totalValue: 47.5,
      refundAmount: 45,
      label,
      events,
    });
    expect(res.body.items).toHaveLength(1);
    expect(res.body.items[0].productTitle).toBe('Wool jumper');
    // Internal fields are not exposed to the public endpoint
    expect(res.body).not.toHaveProperty('notes');
    expect(res.body).not.toHaveProperty('shop');
    expect(res.body).not.toHaveProperty('customerEmail');
  });

  it('serves the return when no email query is supplied (email check is optional as coded)', async () => {
    prisma.return.findUnique.mockResolvedValue(fakeReturn());
    const res = await request(app).get('/api/portal/returns/ret_test_1');
    expect(res.status).toBe(200);
    expect(res.body.id).toBe('ret_test_1');
  });

  it('500 when the database throws', async () => {
    prisma.return.findUnique.mockRejectedValue(new Error('db down'));
    const res = await request(app).get('/api/portal/returns/ret_test_1');
    expect(res.status).toBe(500);
    expect(res.body).toEqual({ error: 'Internal server error' });
  });
});

describe('POST /api/portal/returns/:id/photos', () => {
  it('404 when the return does not exist (nothing uploaded)', async () => {
    prisma.return.findUnique.mockResolvedValue(null);
    const res = await request(app)
      .post('/api/portal/returns/missing/photos')
      .attach('photos', PNG, { filename: 'a.png', contentType: 'image/png' });
    expect(res.status).toBe(404);
    expect(storage.uploadReturnPhoto).not.toHaveBeenCalled();
  });

  it('uploads each image to storage under the return id and appends urls to the matching item', async () => {
    prisma.return.findUnique.mockResolvedValue(fakeReturn({ items: [fakeReturnItem({ id: 'item_test_1' })] }));
    prisma.returnItem.update.mockResolvedValue({});

    const res = await request(app)
      .post('/api/portal/returns/ret_test_1/photos')
      .field('itemId', 'item_test_1')
      .attach('photos', PNG, { filename: 'a.png', contentType: 'image/png' })
      .attach('photos', PNG, { filename: 'b.jpg', contentType: 'image/jpeg' });

    expect(res.status).toBe(200);
    expect(storage.uploadReturnPhoto).toHaveBeenCalledTimes(2);
    expect(storage.uploadReturnPhoto).toHaveBeenNthCalledWith(1, expect.any(Buffer), 'image/png', 'ret_test_1');
    expect(storage.uploadReturnPhoto).toHaveBeenNthCalledWith(2, expect.any(Buffer), 'image/jpeg', 'ret_test_1');
    expect(res.body.urls).toEqual([
      'https://r2.test/returns/ret_test_1/photos/k',
      'https://r2.test/returns/ret_test_1/photos/k',
    ]);
    expect(prisma.returnItem.update).toHaveBeenCalledWith({
      where: { id: 'item_test_1' },
      data: { photoUrls: { push: res.body.urls } },
    });
  });

  it('does not touch an item that belongs to a different return (itemId not in this return)', async () => {
    prisma.return.findUnique.mockResolvedValue(fakeReturn({ items: [fakeReturnItem({ id: 'item_test_1' })] }));

    const res = await request(app)
      .post('/api/portal/returns/ret_test_1/photos')
      .field('itemId', 'item_from_other_return')
      .attach('photos', PNG, { filename: 'a.png', contentType: 'image/png' });

    expect(res.status).toBe(200);
    expect(res.body.urls).toHaveLength(1);
    expect(prisma.returnItem.update).not.toHaveBeenCalled();
  });

  it('silently drops files with a disallowed mimetype (fileFilter) and uploads nothing', async () => {
    prisma.return.findUnique.mockResolvedValue(fakeReturn({ items: [fakeReturnItem()] }));

    const res = await request(app)
      .post('/api/portal/returns/ret_test_1/photos')
      .field('itemId', 'item_test_1')
      .attach('photos', Buffer.from('%PDF-1.4'), { filename: 'doc.pdf', contentType: 'application/pdf' });

    expect(res.status).toBe(200);
    expect(res.body.urls).toEqual([]);
    expect(storage.uploadReturnPhoto).not.toHaveBeenCalled();
    // As coded the item is still "updated" with an empty push — a no-op write.
    expect(prisma.returnItem.update).toHaveBeenCalledWith({
      where: { id: 'item_test_1' },
      data: { photoUrls: { push: [] } },
    });
  });

  it('accepts heic and webp', async () => {
    prisma.return.findUnique.mockResolvedValue(fakeReturn());
    const res = await request(app)
      .post('/api/portal/returns/ret_test_1/photos')
      .attach('photos', PNG, { filename: 'a.heic', contentType: 'image/heic' })
      .attach('photos', PNG, { filename: 'b.webp', contentType: 'image/webp' });
    expect(res.status).toBe(200);
    expect(storage.uploadReturnPhoto).toHaveBeenCalledTimes(2);
  });

  it('rejects more than 5 files (multer limit surfaces as an error, handler never runs)', async () => {
    prisma.return.findUnique.mockResolvedValue(fakeReturn());
    let req = request(app).post('/api/portal/returns/ret_test_1/photos');
    for (let i = 0; i < 6; i++) {
      req = req.attach('photos', PNG, { filename: `p${i}.png`, contentType: 'image/png' });
    }
    const res = await req;
    expect(res.status).toBeGreaterThanOrEqual(400);
    expect(storage.uploadReturnPhoto).not.toHaveBeenCalled();
    expect(prisma.return.findUnique).not.toHaveBeenCalled();
  });

  it('rejects a single file over 5MB', async () => {
    prisma.return.findUnique.mockResolvedValue(fakeReturn());
    const big = Buffer.alloc(5 * 1024 * 1024 + 1, 1);
    const res = await request(app)
      .post('/api/portal/returns/ret_test_1/photos')
      .attach('photos', big, { filename: 'big.png', contentType: 'image/png' });
    expect(res.status).toBeGreaterThanOrEqual(400);
    expect(storage.uploadReturnPhoto).not.toHaveBeenCalled();
  });

  it('500 when storage upload fails', async () => {
    prisma.return.findUnique.mockResolvedValue(fakeReturn());
    storage.uploadReturnPhoto.mockRejectedValue(new Error('Storage not configured'));
    const res = await request(app)
      .post('/api/portal/returns/ret_test_1/photos')
      .attach('photos', PNG, { filename: 'a.png', contentType: 'image/png' });
    expect(res.status).toBe(500);
    expect(res.body).toEqual({ error: 'Upload failed' });
  });
});

describe('POST /api/portal/returns/:id/photos/presign', () => {
  it('400 for a disallowed content type', async () => {
    const res = await request(app)
      .post('/api/portal/returns/ret_test_1/photos/presign')
      .send({ contentType: 'application/pdf', contentLength: 1000 });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('Invalid content type');
    expect(storage.getPresignedUploadUrl).not.toHaveBeenCalled();
  });

  it('400 when content type is missing', async () => {
    const res = await request(app).post('/api/portal/returns/ret_test_1/photos/presign').send({ contentLength: 10 });
    expect(res.status).toBe(400);
  });

  it('400 when the file is larger than 5MB', async () => {
    const res = await request(app)
      .post('/api/portal/returns/ret_test_1/photos/presign')
      .send({ contentType: 'image/png', contentLength: 5 * 1024 * 1024 + 1 });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/max 5MB/);
  });

  it('accepts exactly 5MB and returns the presigned payload scoped to the return id', async () => {
    const res = await request(app)
      .post('/api/portal/returns/ret_test_1/photos/presign')
      .send({ contentType: 'image/jpeg', contentLength: 5 * 1024 * 1024 });

    expect(res.status).toBe(200);
    expect(storage.getPresignedUploadUrl).toHaveBeenCalledWith({
      returnId: 'ret_test_1',
      contentType: 'image/jpeg',
      contentLength: 5 * 1024 * 1024,
    });
    expect(res.body).toEqual({
      uploadUrl: 'https://r2.test/presigned',
      key: 'returns/r1/photos/abc.png',
      publicUrl: 'https://cdn.test/returns/r1/photos/abc.png',
    });
  });

  it('500 when storage is not configured / presign fails', async () => {
    storage.getPresignedUploadUrl.mockRejectedValue(new Error('Storage not configured'));
    const res = await request(app)
      .post('/api/portal/returns/ret_test_1/photos/presign')
      .send({ contentType: 'image/png', contentLength: 10 });
    expect(res.status).toBe(500);
    expect(res.body).toEqual({ error: 'Failed to generate upload URL' });
  });
});

describe('GET /api/portal/carriers/:shopId/dropoff', () => {
  it('400 when postcode is missing (no DB hit)', async () => {
    const res = await request(app).get('/api/portal/carriers/shop_test_1/dropoff?carrier=evri');
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('postcode is required');
    expect(prisma.shop.findUnique).not.toHaveBeenCalled();
  });

  it('404 when the shop does not exist', async () => {
    prisma.shop.findUnique.mockResolvedValue(null);
    const res = await request(app).get('/api/portal/carriers/nope/dropoff?postcode=GL1%201AA');
    expect(res.status).toBe(404);
    expect(labelService.getCarrierAdapter).not.toHaveBeenCalled();
  });

  it('loads the shop with its carrier configs and asks the resolved adapter for 5 locations', async () => {
    const shop = fakeShop({ carrierConfigs: [{ carrier: 'royalmail', isActive: true, credentials: {} }] });
    prisma.shop.findUnique.mockResolvedValue(shop);

    const res = await request(app).get('/api/portal/carriers/shop_test_1/dropoff?carrier=royalmail&postcode=GL1%201AA');

    expect(res.status).toBe(200);
    expect(prisma.shop.findUnique).toHaveBeenCalledWith({
      where: { id: 'shop_test_1' },
      include: { carrierConfigs: true },
    });
    expect(labelService.getCarrierAdapter).toHaveBeenCalledWith(expect.objectContaining({ id: 'shop_test_1' }), 'royalmail');
    expect(dropoffAdapter.getDropoffLocations).toHaveBeenCalledWith({ postcode: 'GL1 1AA', limit: 5 });
    expect(res.body.locations).toHaveLength(1);
    expect(res.body.locations[0]).toMatchObject({ id: 'loc1', name: 'Corner Shop' });
  });

  it('defaults the carrier to evri when none is supplied', async () => {
    prisma.shop.findUnique.mockResolvedValue(fakeShop({ carrierConfigs: [] }));
    const res = await request(app).get('/api/portal/carriers/shop_test_1/dropoff?postcode=GL1');
    expect(res.status).toBe(200);
    expect(labelService.getCarrierAdapter).toHaveBeenCalledWith(expect.anything(), 'evri');
  });

  it('500 when the carrier adapter fails', async () => {
    prisma.shop.findUnique.mockResolvedValue(fakeShop({ carrierConfigs: [] }));
    dropoffAdapter.getDropoffLocations.mockRejectedValue(new Error('Evri API timeout'));
    const res = await request(app).get('/api/portal/carriers/shop_test_1/dropoff?postcode=GL1');
    expect(res.status).toBe(500);
    expect(res.body).toEqual({ error: 'Failed to find drop-off locations' });
  });

  it('500 when no adapter can be resolved (getCarrierAdapter throws)', async () => {
    prisma.shop.findUnique.mockResolvedValue(fakeShop({ carrierConfigs: [] }));
    labelService.getCarrierAdapter.mockImplementation(() => { throw new Error('Unknown carrier: dhl'); });
    const res = await request(app).get('/api/portal/carriers/shop_test_1/dropoff?carrier=dhl&postcode=GL1');
    expect(res.status).toBe(500);
  });
});

describe('router wiring', () => {
  it('applies portalLimiter to every portal route (mounted via router.use)', async () => {
    jest.resetModules();
    const portalLimiter = jest.fn((req, res, next) => next());
    jest.doMock('../../app/middleware/rateLimiter', () => ({
      portalLimiter,
      lookupLimiter: (req, res, next) => next(),
      createReturnLimiter: (req, res, next) => next(),
      adminLimiter: (req, res, next) => next(),
    }));
    const p = installPrismaMock();
    installShopifyMock();
    jest.doMock('../../app/services/PolicyEngine', () => policyEngine);
    jest.doMock('../../app/services/ReturnService', () => returnService);
    jest.doMock('../../app/services/StorageService', () => storage);
    jest.doMock('../../app/services/LabelService', () => labelService);
    p.return.findUnique.mockResolvedValue(null);

    const localApp = express();
    localApp.use(express.json());
    localApp.use('/api/portal', require('../../app/routes/api/portal'));

    await request(localApp).get('/api/portal/returns/x');
    await request(localApp).get('/api/portal/carriers/s/dropoff');
    expect(portalLimiter).toHaveBeenCalledTimes(2);
  });
});
