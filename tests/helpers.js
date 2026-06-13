// Shared helpers for tests. Provides:
//   - prismaMock: chainable mock for every Prisma model used in code
//   - shopifyMock: mock GraphQL client
//   - stripeMock: mock Stripe SDK
//   - resetAllMocks(): clear all mock impls + reset module registry
//
// Tests opt into mocking by calling installMocks() at the top of each file.

const prismaMockFactory = () => ({
  shop: {
    findUnique: jest.fn(),
    findFirst: jest.fn(),
    upsert: jest.fn(),
    update: jest.fn(),
    updateMany: jest.fn(),
    delete: jest.fn(),
    findMany: jest.fn(),
  },
  return: {
    create: jest.fn(),
    findUnique: jest.fn(),
    findFirst: jest.fn(),
    findMany: jest.fn(),
    update: jest.fn(),
    updateMany: jest.fn(),
    count: jest.fn(),
    aggregate: jest.fn(),
  },
  returnItem: {
    update: jest.fn(),
    groupBy: jest.fn(),
  },
  returnLabel: {
    create: jest.fn(),
  },
  returnPolicy: {
    findMany: jest.fn(),
    create: jest.fn(),
    updateMany: jest.fn(),
  },
  carrierConfig: {
    findMany: jest.fn(),
    findUnique: jest.fn(),
    upsert: jest.fn(),
    deleteMany: jest.fn(),
  },
  returnEvent: {
    create: jest.fn(),
    createMany: jest.fn(),
  },
  analyticsSnapshot: {
    upsert: jest.fn(),
  },
  $disconnect: jest.fn(),
});

const shopifyClientMock = () => ({
  request: jest.fn(),
});

const shopifyAuthMock = () => ({
  begin: jest.fn().mockResolvedValue('https://shop.myshopify.com/admin/oauth/authorize?fake'),
  callback: jest.fn(),
});

const shopifySessionMock = () => ({
  decodeSessionToken: jest.fn(),
});

function installShopifyMock() {
  const clientInstance = shopifyClientMock();
  const auth = shopifyAuthMock();
  const session = shopifySessionMock();
  const mod = {
    auth,
    session,
    clients: {
      Graphql: jest.fn().mockImplementation(() => clientInstance),
    },
    __clientInstance: clientInstance,
  };
  jest.doMock('../app/config/shopify', () => mod);
  // Returning the client by default to preserve the existing call sites that
  // do `client = installShopifyMock()` — but expose the full module for tests
  // that need .auth / .session.
  clientInstance.auth = auth;
  clientInstance.session = session;
  clientInstance.__module = mod;
  return clientInstance;
}

function installPrismaMock() {
  const instance = prismaMockFactory();
  jest.doMock('../app/config/database', () => instance);
  return instance;
}

function installStripeMock() {
  const instance = {
    checkout: {
      sessions: {
        create: jest.fn(),
      },
    },
    webhooks: {
      constructEvent: jest.fn(),
    },
  };
  jest.doMock('stripe', () => jest.fn().mockImplementation(() => instance));
  return instance;
}

function installResendMock() {
  const sendMock = jest.fn().mockResolvedValue({ id: 'msg_test' });
  jest.doMock('resend', () => ({
    Resend: jest.fn().mockImplementation(() => ({
      emails: { send: sendMock },
    })),
  }));
  return { send: sendMock };
}

function installRedisMock() {
  jest.doMock('../app/config/redis', () => ({
    getRedis: () => null, // forces in-memory fallback
  }));
}

function installQueueMock() {
  const addMock = jest.fn().mockResolvedValue({ id: 'job_test' });
  jest.doMock('../app/jobs/queue', () => ({
    QUEUE_NAMES: {
      GENERATE_LABEL: 'generate-label',
      SEND_EMAIL: 'send-email',
      PROCESS_REFUND: 'process-refund',
      AGGREGATE_ANALYTICS: 'aggregate-analytics',
    },
    getQueue: jest.fn(() => ({ add: addMock })),
    createWorker: jest.fn(),
  }));
  return { add: addMock };
}

function installAllMocks() {
  installRedisMock();
  installQueueMock();
  return {
    prisma: installPrismaMock(),
    shopifyClient: installShopifyMock(),
    stripe: installStripeMock(),
    resend: installResendMock(),
  };
}

function fakeShop(overrides = {}) {
  return {
    id: 'shop_test_1',
    shopifyDomain: 'test-shop.myshopify.com',
    shopifyToken: '00:00:00', // placeholder; tests usually mock decrypt
    name: 'Test Shop',
    email: 'test@shop.com',
    plan: 'FREE',
    currency: 'GBP',
    settings: {},
    returnCount: 0,
    billingCycleStart: null,
    createdAt: new Date('2026-01-01'),
    updatedAt: new Date('2026-01-01'),
    ...overrides,
  };
}

function fakeReturn(overrides = {}) {
  return {
    id: 'ret_test_1',
    shopId: 'shop_test_1',
    shopifyOrderId: 'gid://shopify/Order/1',
    shopifyOrderName: '#1001',
    customerEmail: 'jane@example.com',
    customerName: 'Jane Doe',
    status: 'REQUESTED',
    resolution: 'REFUND',
    totalValue: 47.5,
    currency: 'GBP',
    returnFee: null,
    refundAmount: null,
    notes: null,
    createdAt: new Date('2026-01-15'),
    updatedAt: new Date('2026-01-15'),
    processedAt: null,
    items: [],
    label: null,
    events: [],
    shop: fakeShop(),
    ...overrides,
  };
}

function fakeReturnItem(overrides = {}) {
  return {
    id: 'item_test_1',
    returnId: 'ret_test_1',
    shopifyLineItemId: 'gid://shopify/LineItem/1',
    shopifyProductId: 'gid://shopify/Product/1',
    shopifyVariantId: 'gid://shopify/ProductVariant/1',
    productTitle: 'Wool jumper',
    variantTitle: 'M / Navy',
    sku: 'WJ-M-NAV',
    quantity: 1,
    unitPrice: 47.5,
    reason: 'doesnt_fit',
    reasonDetail: null,
    photoUrls: [],
    condition: null,
    disposition: null,
    exchangeVariantId: null,
    exchangeOrderId: null,
    ...overrides,
  };
}

module.exports = {
  installAllMocks,
  installPrismaMock,
  installShopifyMock,
  installStripeMock,
  installResendMock,
  installRedisMock,
  installQueueMock,
  fakeShop,
  fakeReturn,
  fakeReturnItem,
};
