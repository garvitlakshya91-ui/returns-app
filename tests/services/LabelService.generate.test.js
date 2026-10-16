// End-to-end (mocked I/O) tests for LabelService.generateLabel — the main flow
// that the approve handler and the generate-label worker both call.
//
// Mocks: prisma (helpers), ShopToken.graphqlClient (address lookup),
// StorageService (R2), BillingService (managed-label usage charge),
// global.fetch (label PDF re-host). Carrier adapters are real unless a test
// explicitly swaps one in via jest.doMock.

const { installPrismaMock, fakeShop, fakeReturn, fakeReturnItem } = require('../helpers');
const { encrypt } = require('../../app/utils/encryption');
const { LABEL_GENERATED, LABEL_FAILED } = require('../../app/events/emitters');

let prisma;
let LabelService;
let eventBus;
let shopifyRequest;
let storage;
let billing;
let qrcode;
const savedEnv = {};
const ENV_KEYS = ['R2_ACCOUNT_ID', 'R2_PUBLIC_URL', 'SHIPPO_API_KEY', 'SHIPENGINE_API_KEY', 'SHIPENGINE_CARRIER_ID'];

const shopifyAddressResponse = {
  data: {
    shop: {
      billingAddress: {
        address1: '12 Warehouse Way', address2: 'Unit 4', city: 'Manchester',
        zip: 'M1 2AB', provinceCode: null, countryCodeV2: 'GB', phone: '0161 000 000',
      },
    },
    order: {
      shippingAddress: {
        name: 'Jane Customer', address1: '1 Customer Close', address2: '', city: 'Leeds',
        zip: 'LS1 1AA', provinceCode: null, countryCodeV2: 'GB', phone: '07000 000000',
      },
    },
  },
};

const ADAPTER_MODULES = [
  '../../app/services/carriers/ShippoAdapter',
  '../../app/services/carriers/ShipEngineAdapter',
  '../../app/services/carriers/RoyalMailAdapter',
  '../../app/services/carriers/InPostAdapter',
];

function installMocks() {
  prisma = installPrismaMock();
  // Silence pino (and skip its pino-pretty worker thread) — keeps the suite fast.
  jest.doMock('../../app/utils/logger', () => ({
    info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn(), child: jest.fn(() => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() })),
  }));
  // jest.doMock factories outlive resetModules(); make sure an adapter mocked by
  // one test does not leak into the next.
  ADAPTER_MODULES.forEach((m) => jest.dontMock(m));
  // Real QR rendering (qrcode + pngjs) is re-JIT'd after every resetModules and
  // costs ~1s/test; we assert on what is encoded, not on the PNG bytes.
  qrcode = {
    toDataURL: jest.fn().mockResolvedValue('data:image/png;base64,QVJfVEVTVA=='),
    toBuffer: jest.fn().mockResolvedValue(Buffer.from('fake-png')),
  };
  jest.doMock('qrcode', () => qrcode);
  // The label row is the lock: create() writes the pending row, update() fills it in.
  prisma.returnLabel.create = jest.fn().mockImplementation(async ({ data }) => ({ id: 'lbl_new', ...data }));
  prisma.returnLabel.update = jest.fn().mockImplementation(async ({ where, data }) => ({ id: where.id, returnId: 'ret_lbl_1', ...data }));
  prisma.returnLabel.delete = jest.fn().mockResolvedValue({});
  prisma.returnEvent.create = jest.fn().mockResolvedValue({});
  prisma.return.update = jest.fn().mockResolvedValue({});

  shopifyRequest = jest.fn().mockResolvedValue(shopifyAddressResponse);
  jest.doMock('../../app/services/ShopToken', () => ({
    graphqlClient: jest.fn().mockResolvedValue({ request: shopifyRequest }),
  }));

  storage = {
    upload: jest.fn().mockResolvedValue({ key: 'returns/x/qr/1.png', url: 'https://cdn.test/returns/x/qr/1.png' }),
    uploadLabel: jest.fn().mockResolvedValue({ key: 'returns/x/labels/1.pdf', url: 'https://cdn.test/returns/x/labels/1.pdf' }),
  };
  jest.doMock('../../app/services/StorageService', () => storage);

  billing = {
    LABEL_FEE_GBP: 0.5,
    recordLabelCharge: jest.fn().mockResolvedValue('gid://shopify/AppUsageRecord/1'),
    managedLabelBilling: jest.fn().mockResolvedValue({ allowed: true, devStore: false, reason: null, lineItemId: 'li_1' }),
  };
  jest.doMock('../../app/services/BillingService', () => billing);
}

function load() {
  LabelService = require('../../app/services/LabelService');
  eventBus = require('../../app/events/eventBus');
}

function shopWith(carrierConfigs, overrides = {}) {
  return fakeShop({
    shopifyToken: encrypt('shpat_fake'),
    carrierConfigs,
    ...overrides,
  });
}

function primeReturn(overrides = {}) {
  const record = fakeReturn({
    id: 'ret_lbl_1',
    shopifyOrderId: 'gid://shopify/Order/123',
    status: 'APPROVED',
    items: [fakeReturnItem({ quantity: 2 }), fakeReturnItem({ id: 'item_2', quantity: 1 })],
    shop: shopWith([{ carrier: 'evri', isActive: true, credentials: {}, settings: {} }]),
    ...overrides,
  });
  prisma.return.findUnique.mockResolvedValue(record);
  return record;
}

beforeEach(() => {
  jest.resetModules();
  ENV_KEYS.forEach((k) => {
    savedEnv[k] = process.env[k];
    delete process.env[k];
  });
  installMocks();
  global.fetch = jest.fn();
});

afterEach(() => {
  ENV_KEYS.forEach((k) => {
    if (savedEnv[k] === undefined) delete process.env[k];
    else process.env[k] = savedEnv[k];
  });
  delete global.fetch;
});

// ---------------------------------------------------------------------------
describe('LabelService.generateLabel — happy path (Evri mock adapter, no R2)', () => {
  it('loads the return with shop+carrierConfigs+items, creates the label row, marks LABEL_SENT, emits LABEL_GENERATED', async () => {
    primeReturn();
    load();
    const generated = jest.fn();
    const failed = jest.fn();
    eventBus.on(LABEL_GENERATED, generated);
    eventBus.on(LABEL_FAILED, failed);

    const label = await LabelService.generateLabel('ret_lbl_1');

    expect(prisma.return.findUnique).toHaveBeenCalledWith({
      where: { id: 'ret_lbl_1' },
      include: { shop: { include: { carrierConfigs: true } }, items: true, label: true },
    });

    // The pending row (the lock) is written before the carrier is called…
    expect(prisma.returnLabel.create).toHaveBeenCalledWith({
      data: { returnId: 'ret_lbl_1', carrier: 'evri', status: 'pending' },
    });
    // …and filled in once the label exists.
    expect(prisma.returnLabel.update).toHaveBeenCalledTimes(1);
    expect(prisma.returnLabel.update.mock.calls[0][0].where).toEqual({ id: 'lbl_new' });
    const data = prisma.returnLabel.update.mock.calls[0][0].data;
    expect(data).toMatchObject({
      carrier: 'evri',
      dropoffType: 'ParcelShop',
      cost: 3.49,
      status: 'created',
      labelUrl: null,
    });
    expect(data.trackingCode).toMatch(/^EVR[0-9A-F]+$/);
    // No carrier QR → none stored; we never make our own.
    expect(data.qrCodeUrl).toBeNull();
    expect(qrcode.toDataURL).not.toHaveBeenCalled();
    expect(qrcode.toBuffer).not.toHaveBeenCalled();
    expect(storage.upload).not.toHaveBeenCalled();
    expect(prisma.returnLabel.delete).not.toHaveBeenCalled();

    expect(prisma.return.update).toHaveBeenCalledWith({
      where: { id: 'ret_lbl_1' },
      data: { status: 'LABEL_SENT' },
    });

    expect(generated).toHaveBeenCalledWith({ returnId: 'ret_lbl_1', labelId: 'lbl_new' });
    expect(failed).not.toHaveBeenCalled();
    expect(label).toMatchObject({ id: 'lbl_new', carrier: 'evri' });
    // Evri mock/BYO carrier → never billed as a managed label
    expect(billing.recordLabelCharge).not.toHaveBeenCalled();
  });

  it('throws when the return does not exist (nothing created, nothing emitted)', async () => {
    prisma.return.findUnique.mockResolvedValue(null);
    load();
    const failed = jest.fn();
    eventBus.on(LABEL_FAILED, failed);

    await expect(LabelService.generateLabel('missing')).rejects.toThrow('Return missing not found');
    expect(prisma.returnLabel.create).not.toHaveBeenCalled();
    expect(failed).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
describe('LabelService.generateLabel — addresses + weight handed to the adapter', () => {
  it('passes real Shopify order shipping address as sender and store billing address as recipient, weight = 0.5kg per unit', async () => {
    primeReturn();
    const generateLabel = jest.fn().mockResolvedValue({ trackingCode: 'RM1', labelUrl: null, cost: 2 });
    jest.doMock('../../app/services/carriers/RoyalMailAdapter', () => class {
      get carrierName() { return 'royalmail'; }

      generateLabel(args) { return generateLabel(args); }
    });
    prisma.return.findUnique.mockResolvedValue(fakeReturn({
      id: 'ret_lbl_1',
      shopifyOrderId: 'gid://shopify/Order/123',
      customerEmail: 'jane@example.com',
      items: [fakeReturnItem({ quantity: 3 })],
      shop: shopWith([{ carrier: 'royalmail', isActive: true, credentials: {}, settings: {} }]),
    }));
    load();

    await LabelService.generateLabel('ret_lbl_1');

    // Shopify was asked for the real order (withOrder=true)
    expect(shopifyRequest).toHaveBeenCalledTimes(1);
    expect(shopifyRequest.mock.calls[0][1]).toEqual({
      variables: { orderId: 'gid://shopify/Order/123', withOrder: true },
    });

    expect(generateLabel).toHaveBeenCalledTimes(1);
    const args = generateLabel.mock.calls[0][0];
    expect(args.senderAddress).toEqual({
      name: 'Jane Customer',
      line1: '1 Customer Close',
      line2: '',
      city: 'Leeds',
      postcode: 'LS1 1AA',
      state: '',
      country: 'GB',
      phone: '07000 000000',
      email: 'jane@example.com',
    });
    expect(args.recipientAddress).toEqual({
      name: 'Test Shop',
      line1: '12 Warehouse Way',
      line2: 'Unit 4',
      city: 'Manchester',
      postcode: 'M1 2AB',
      state: '',
      country: 'GB',
      phone: '0161 000 000',
    });
    expect(args.weight).toBe(1.5);
    expect(args.dimensions).toEqual({ length: 30, width: 20, height: 10 });
    expect(prisma.returnLabel.update.mock.calls[0][0].data.carrier).toBe('royalmail');
  });

  it('merchant warehouse settings override the Shopify store address for the recipient', async () => {
    const generateLabel = jest.fn().mockResolvedValue({ trackingCode: 'RM2', labelUrl: null, cost: 2 });
    jest.doMock('../../app/services/carriers/RoyalMailAdapter', () => class {
      get carrierName() { return 'royalmail'; }

      generateLabel(args) { return generateLabel(args); }
    });
    prisma.return.findUnique.mockResolvedValue(fakeReturn({
      id: 'ret_lbl_1',
      shopifyOrderId: 'gid://shopify/Order/123',
      items: [fakeReturnItem()],
      shop: shopWith(
        [{ carrier: 'royalmail', isActive: true, credentials: {}, settings: {} }],
        { settings: { warehouseLine1: 'Unit 9 Returns Park', warehouseCity: 'Bristol', warehousePostcode: 'BS1 4DJ' } },
      ),
    }));
    load();

    await LabelService.generateLabel('ret_lbl_1');

    expect(generateLabel.mock.calls[0][0].recipientAddress).toEqual({
      name: 'Test Shop',
      line1: 'Unit 9 Returns Park',
      city: 'Bristol',
      postcode: 'BS1 4DJ',
      country: 'GB',
    });
  });

  it('falls back to placeholder addresses when the Shopify lookup fails — label generation still succeeds', async () => {
    shopifyRequest.mockRejectedValue(new Error('401 token expired'));
    const generateLabel = jest.fn().mockResolvedValue({ trackingCode: 'RM3', labelUrl: null, cost: 2 });
    jest.doMock('../../app/services/carriers/RoyalMailAdapter', () => class {
      get carrierName() { return 'royalmail'; }

      generateLabel(args) { return generateLabel(args); }
    });
    prisma.return.findUnique.mockResolvedValue(fakeReturn({
      id: 'ret_lbl_1',
      shopifyOrderId: 'gid://shopify/Order/123',
      customerName: 'Jane Doe',
      items: [fakeReturnItem()],
      shop: shopWith([{ carrier: 'royalmail', isActive: true, credentials: {}, settings: {} }]),
    }));
    load();

    await expect(LabelService.generateLabel('ret_lbl_1')).resolves.toMatchObject({ trackingCode: 'RM3' });
    const args = generateLabel.mock.calls[0][0];
    expect(args.senderAddress).toEqual({ name: 'Jane Doe', country: 'GB' });
    expect(args.recipientAddress).toMatchObject({ name: 'Test Shop', line1: '1 Returns Centre', postcode: 'EC1A 1BB' });
  });

  it('does not ask Shopify for the order when the return has a demo/non-gid order id', async () => {
    primeReturn({ shopifyOrderId: 'demo-order-1' });
    load();

    await LabelService.generateLabel('ret_lbl_1');

    expect(shopifyRequest.mock.calls[0][1]).toEqual({
      variables: { orderId: 'gid://shopify/Order/0', withOrder: false },
    });
  });
});

// ---------------------------------------------------------------------------
describe('LabelService.generateLabel — failure path', () => {
  it('emits LABEL_FAILED with the error message, rethrows, and writes nothing', async () => {
    jest.doMock('../../app/services/carriers/InPostAdapter', () => class {
      get carrierName() { return 'inpost'; }

      async generateLabel() { throw new Error('InPost API 503'); }
    });
    primeReturn({ shop: shopWith([{ carrier: 'inpost', isActive: true, credentials: {}, settings: {} }]) });
    load();
    const generated = jest.fn();
    const failed = jest.fn();
    eventBus.on(LABEL_GENERATED, generated);
    eventBus.on(LABEL_FAILED, failed);

    await expect(LabelService.generateLabel('ret_lbl_1')).rejects.toThrow('InPost API 503');

    expect(failed).toHaveBeenCalledWith({ returnId: 'ret_lbl_1', error: 'InPost API 503' });
    expect(generated).not.toHaveBeenCalled();
    // The lock was taken, then released so the merchant can retry.
    expect(prisma.returnLabel.create).toHaveBeenCalledTimes(1);
    expect(prisma.returnLabel.delete).toHaveBeenCalledWith({ where: { id: 'lbl_new' } });
    expect(prisma.returnLabel.update).not.toHaveBeenCalled();
    expect(prisma.return.update).not.toHaveBeenCalled();
    expect(billing.recordLabelCharge).not.toHaveBeenCalled();
  });

  it('a second call while a label is being generated buys nothing (unique lock row)', async () => {
    const buy = jest.fn();
    jest.doMock('../../app/services/carriers/InPostAdapter', () => class {
      get carrierName() { return 'inpost'; }

      async generateLabel(...a) { return buy(...a); }
    });
    primeReturn({ shop: shopWith([{ carrier: 'inpost', isActive: true, credentials: {}, settings: {} }]) });
    const clash = new Error('Unique constraint failed on the fields: (`returnId`)');
    clash.code = 'P2002';
    prisma.returnLabel.create.mockRejectedValue(clash);
    load();
    const failed = jest.fn();
    eventBus.on(LABEL_FAILED, failed);

    await expect(LabelService.generateLabel('ret_lbl_1')).rejects.toThrow('already being generated');
    expect(buy).not.toHaveBeenCalled();
    expect(failed).not.toHaveBeenCalled();
    expect(prisma.returnLabel.delete).not.toHaveBeenCalled();
  });

  it('returns the existing label without buying again when the return already has one', async () => {
    const buy = jest.fn();
    jest.doMock('../../app/services/carriers/InPostAdapter', () => class {
      get carrierName() { return 'inpost'; }

      async generateLabel(...a) { return buy(...a); }
    });
    const existing = { id: 'lbl_old', returnId: 'ret_lbl_1', carrier: 'inpost', trackingCode: 'IP1', status: 'created' };
    primeReturn({ label: existing, shop: shopWith([{ carrier: 'inpost', isActive: true, credentials: {}, settings: {} }]) });
    load();

    const label = await LabelService.generateLabel('ret_lbl_1');
    expect(label).toBe(existing);
    expect(buy).not.toHaveBeenCalled();
    expect(prisma.returnLabel.create).not.toHaveBeenCalled();
  });

  it('refuses while another attempt still holds the pending row', async () => {
    primeReturn({ label: { id: 'lbl_p', returnId: 'ret_lbl_1', carrier: 'evri', status: 'pending' } });
    load();
    await expect(LabelService.generateLabel('ret_lbl_1')).rejects.toThrow('already being generated');
    expect(prisma.returnLabel.create).not.toHaveBeenCalled();
  });

  it('a DB failure writing the lock row surfaces as LABEL_FAILED + rethrow (nothing bought)', async () => {
    primeReturn();
    prisma.returnLabel.create.mockRejectedValue(new Error('connection lost'));
    load();
    const failed = jest.fn();
    eventBus.on(LABEL_FAILED, failed);

    await expect(LabelService.generateLabel('ret_lbl_1')).rejects.toThrow('connection lost');
    expect(failed).toHaveBeenCalledWith({ returnId: 'ret_lbl_1', error: 'connection lost' });
    expect(prisma.return.update).not.toHaveBeenCalled();
  });

  it('a DB failure filling in the label releases the lock and reports LABEL_FAILED', async () => {
    primeReturn();
    prisma.returnLabel.update.mockRejectedValue(new Error('db down'));
    load();
    const failed = jest.fn();
    eventBus.on(LABEL_FAILED, failed);

    await expect(LabelService.generateLabel('ret_lbl_1')).rejects.toThrow('db down');
    expect(failed).toHaveBeenCalledWith({ returnId: 'ret_lbl_1', error: 'db down' });
    expect(prisma.returnLabel.delete).toHaveBeenCalledWith({ where: { id: 'lbl_new' } });
    expect(prisma.return.update).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
describe('LabelService.generateLabel — R2 hosting of QR + label PDF', () => {
  const fakeAdapter = (result) => class {
    get carrierName() { return 'royalmail'; }

    async generateLabel() { return result; }
  };

  it('keeps the QR code the carrier issued and never generates its own', async () => {
    process.env.R2_ACCOUNT_ID = 'acct';
    process.env.R2_PUBLIC_URL = 'https://cdn.test';
    jest.doMock('../../app/services/carriers/RoyalMailAdapter', () => fakeAdapter({
      trackingCode: 'RM1', labelUrl: null, qrCodeUrl: 'https://carrier.example/qr/RM1.png', cost: 2.75,
    }));
    primeReturn({ shop: shopWith([{ carrier: 'royalmail', isActive: true, credentials: {}, settings: {} }]) });
    load();

    await LabelService.generateLabel('ret_lbl_1');

    expect(prisma.returnLabel.update.mock.calls[0][0].data.qrCodeUrl).toBe('https://carrier.example/qr/RM1.png');
    expect(qrcode.toBuffer).not.toHaveBeenCalled();
    expect(qrcode.toDataURL).not.toHaveBeenCalled();
    expect(storage.upload).not.toHaveBeenCalled();
  });

  it('re-hosts a carrier label PDF on R2 (fetch → uploadLabel) and stores the R2 URL', async () => {
    process.env.R2_ACCOUNT_ID = 'acct';
    process.env.R2_PUBLIC_URL = 'https://cdn.test';
    jest.doMock('../../app/services/carriers/RoyalMailAdapter', () => fakeAdapter({
      trackingCode: 'RM-PDF', labelUrl: 'https://carrier.example/label.pdf', cost: 3,
    }));
    const pdfBytes = new Uint8Array([0x25, 0x50, 0x44, 0x46]).buffer; // %PDF
    global.fetch.mockResolvedValue({ ok: true, arrayBuffer: async () => pdfBytes });
    primeReturn({ shop: shopWith([{ carrier: 'royalmail', isActive: true, credentials: {}, settings: {} }]) });
    load();

    await LabelService.generateLabel('ret_lbl_1');

    expect(global.fetch).toHaveBeenCalledWith('https://carrier.example/label.pdf');
    expect(storage.uploadLabel).toHaveBeenCalledTimes(1);
    const [buf, returnId] = storage.uploadLabel.mock.calls[0];
    expect(Buffer.isBuffer(buf)).toBe(true);
    expect(buf.toString('latin1')).toBe('%PDF');
    expect(returnId).toBe('ret_lbl_1');
    expect(prisma.returnLabel.update.mock.calls[0][0].data.labelUrl).toBe('https://cdn.test/returns/x/labels/1.pdf');
  });

  it('keeps the carrier URL when the PDF fetch is not ok', async () => {
    process.env.R2_ACCOUNT_ID = 'acct';
    process.env.R2_PUBLIC_URL = 'https://cdn.test';
    jest.doMock('../../app/services/carriers/RoyalMailAdapter', () => fakeAdapter({
      trackingCode: 'RM-PDF', labelUrl: 'https://carrier.example/label.pdf', cost: 3,
    }));
    global.fetch.mockResolvedValue({ ok: false, status: 404, arrayBuffer: async () => new ArrayBuffer(0) });
    primeReturn({ shop: shopWith([{ carrier: 'royalmail', isActive: true, credentials: {}, settings: {} }]) });
    load();

    await LabelService.generateLabel('ret_lbl_1');

    expect(storage.uploadLabel).not.toHaveBeenCalled();
    expect(prisma.returnLabel.update.mock.calls[0][0].data.labelUrl).toBe('https://carrier.example/label.pdf');
  });

  it('falls back gracefully to the carrier URL when the re-host throws (fetch error or upload error)', async () => {
    process.env.R2_ACCOUNT_ID = 'acct';
    process.env.R2_PUBLIC_URL = 'https://cdn.test';
    jest.doMock('../../app/services/carriers/RoyalMailAdapter', () => fakeAdapter({
      trackingCode: 'RM-PDF', labelUrl: 'https://carrier.example/label.pdf', cost: 3,
    }));
    global.fetch.mockResolvedValue({ ok: true, arrayBuffer: async () => new ArrayBuffer(4) });
    storage.uploadLabel.mockRejectedValue(new Error('R2 timeout'));
    primeReturn({ shop: shopWith([{ carrier: 'royalmail', isActive: true, credentials: {}, settings: {} }]) });
    load();
    const failed = jest.fn();
    eventBus.on(LABEL_FAILED, failed);

    const label = await LabelService.generateLabel('ret_lbl_1');

    expect(label.labelUrl).toBe('https://carrier.example/label.pdf');
    expect(failed).not.toHaveBeenCalled();
    expect(prisma.return.update).toHaveBeenCalledWith({ where: { id: 'ret_lbl_1' }, data: { status: 'LABEL_SENT' } });
  });

  it('does not re-fetch a label that is already hosted on our R2 public URL', async () => {
    process.env.R2_ACCOUNT_ID = 'acct';
    process.env.R2_PUBLIC_URL = 'https://cdn.test';
    jest.doMock('../../app/services/carriers/RoyalMailAdapter', () => fakeAdapter({
      trackingCode: 'RM-PDF', labelUrl: 'https://cdn.test/returns/ret_lbl_1/labels/old.pdf', cost: 3,
    }));
    primeReturn({ shop: shopWith([{ carrier: 'royalmail', isActive: true, credentials: {}, settings: {} }]) });
    load();

    await LabelService.generateLabel('ret_lbl_1');

    expect(global.fetch).not.toHaveBeenCalled();
    expect(storage.uploadLabel).not.toHaveBeenCalled();
  });

  it('without R2 configured, never calls fetch/StorageService even when the carrier supplies a PDF URL', async () => {
    jest.doMock('../../app/services/carriers/RoyalMailAdapter', () => fakeAdapter({
      trackingCode: 'RM-PDF', labelUrl: 'https://carrier.example/label.pdf', cost: 3,
    }));
    primeReturn({ shop: shopWith([{ carrier: 'royalmail', isActive: true, credentials: {}, settings: {} }]) });
    load();

    await LabelService.generateLabel('ret_lbl_1');

    expect(global.fetch).not.toHaveBeenCalled();
    expect(storage.upload).not.toHaveBeenCalled();
    expect(storage.uploadLabel).not.toHaveBeenCalled();
    expect(prisma.returnLabel.update.mock.calls[0][0].data.labelUrl).toBe('https://carrier.example/label.pdf');
  });
});

// ---------------------------------------------------------------------------
describe('LabelService.generateLabel — managed-platform billing', () => {
  const liveShippo = () => class {
    get carrierName() { return 'royalmail'; }

    get _isLive() { return true; }

    async generateLabel() {
      return { trackingCode: 'SHP-LIVE', labelUrl: null, cost: 4.2, carrier: 'royalmail', simulated: false };
    }
  };

  it('charges postage + LABEL_FEE_GBP for a real label bought through the platform Shippo account (no merchant creds)', async () => {
    jest.doMock('../../app/services/carriers/ShippoAdapter', liveShippo);
    primeReturn({
      shopifyOrderName: '#1042',
      shop: shopWith([{ carrier: 'shippo', isActive: true, credentials: {}, settings: {} }]),
    });
    load();

    await LabelService.generateLabel('ret_lbl_1');

    expect(billing.recordLabelCharge).toHaveBeenCalledTimes(1);
    const [shopArg, charge] = billing.recordLabelCharge.mock.calls[0];
    expect(shopArg.shopifyDomain).toBe('test-shop.myshopify.com');
    expect(charge.amount).toBeCloseTo(4.7, 2); // 4.2 + 0.5 fee
    expect(charge.description).toBe('Return label royalmail #1042');
    // The charge is on the return's timeline with Shopify's usage record id.
    expect(prisma.returnEvent.create).toHaveBeenCalledWith({
      data: {
        returnId: 'ret_lbl_1', type: 'label.charged', actor: 'system',
        data: { charged: true, amount: 4.7, postage: 4.2, usageRecordId: 'gid://shopify/AppUsageRecord/1', error: null },
      },
    });
  });

  it('also bills for a platform ShipEngine label', async () => {
    jest.doMock('../../app/services/carriers/ShipEngineAdapter', () => class {
      get carrierName() { return 'royalmail'; }

      get _isLive() { return true; }

      async generateLabel() {
        return { trackingCode: 'SE-LIVE', labelUrl: null, cost: 3.1, simulated: false };
      }
    });
    primeReturn({ shop: shopWith([{ carrier: 'shipengine', isActive: true, credentials: {}, settings: {} }]) });
    load();

    await LabelService.generateLabel('ret_lbl_1');

    expect(billing.recordLabelCharge).toHaveBeenCalledTimes(1);
    expect(billing.recordLabelCharge.mock.calls[0][1].amount).toBeCloseTo(3.6, 2);
  });

  it('skips billing for a SIMULATED Shippo label (real adapter, no platform key)', async () => {
    // Real ShippoAdapter with no SHIPPO_API_KEY → simulated label with cost 4.25
    primeReturn({ shop: shopWith([{ carrier: 'shippo', isActive: true, credentials: {}, settings: {} }]) });
    load();

    const label = await LabelService.generateLabel('ret_lbl_1');

    expect(label.trackingCode).toMatch(/^SHP/);
    expect(label.cost).toBe(4.25);
    expect(billing.recordLabelCharge).not.toHaveBeenCalled();
  });

  it('skips billing when the merchant brought their own Shippo credentials (bring-your-own is not managed)', async () => {
    jest.doMock('../../app/services/carriers/ShippoAdapter', liveShippo);
    primeReturn({
      shop: shopWith([{
        carrier: 'shippo',
        isActive: true,
        credentials: { encrypted: encrypt(JSON.stringify({ apiKey: 'shippo_live_merchant' })) },
        settings: {},
      }]),
    });
    load();

    await LabelService.generateLabel('ret_lbl_1');

    expect(billing.recordLabelCharge).not.toHaveBeenCalled();
  });

  it('skips billing when the live label has zero cost', async () => {
    jest.doMock('../../app/services/carriers/ShippoAdapter', () => class {
      get carrierName() { return 'royalmail'; }

      async generateLabel() { return { trackingCode: 'FREE', labelUrl: null, cost: 0, simulated: false }; }
    });
    primeReturn({ shop: shopWith([{ carrier: 'shippo', isActive: true, credentials: {}, settings: {} }]) });
    load();

    await LabelService.generateLabel('ret_lbl_1');

    expect(billing.recordLabelCharge).not.toHaveBeenCalled();
  });

  it('a billing error is swallowed by LabelService — a throwing recordLabelCharge is logged and the label still succeeds', async () => {
    // The label is already bought and persisted by the time billing runs; a
    // usage-charge failure must not fail the label (or suppress the customer's
    // label email via LABEL_FAILED).
    jest.doMock('../../app/services/carriers/ShippoAdapter', liveShippo);
    billing.recordLabelCharge.mockRejectedValue(new Error('billing exploded'));
    primeReturn({ shop: shopWith([{ carrier: 'shippo', isActive: true, credentials: {}, settings: {} }]) });
    load();
    const logger = require('../../app/utils/logger');
    const generated = jest.fn();
    const failed = jest.fn();
    eventBus.on(LABEL_GENERATED, generated);
    eventBus.on(LABEL_FAILED, failed);

    const label = await LabelService.generateLabel('ret_lbl_1');

    expect(label).toMatchObject({ id: 'lbl_new', returnId: 'ret_lbl_1' });
    expect(billing.recordLabelCharge).toHaveBeenCalledTimes(1);
    expect(prisma.returnLabel.create).toHaveBeenCalledTimes(1);
    expect(prisma.return.update).toHaveBeenCalledTimes(1);
    expect(prisma.return.update.mock.calls[0][0].data).toMatchObject({ status: 'LABEL_SENT' });
    expect(generated).toHaveBeenCalledWith({ returnId: 'ret_lbl_1', labelId: 'lbl_new' });
    expect(failed).not.toHaveBeenCalled();
    expect(logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ err: 'billing exploded', returnId: 'ret_lbl_1' }),
      expect.stringMatching(/billing failed/i),
    );
    // …but the unrecovered postage is on record, not silently absorbed.
    expect(prisma.returnEvent.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        type: 'label.charge_failed',
        data: expect.objectContaining({ charged: false, amount: 4.7, postage: 4.2, usageRecordId: null, error: 'billing exploded' }),
      }),
    });
  });

  it('a charge Shopify quietly skips (no usage line item) is recorded as unrecovered', async () => {
    jest.doMock('../../app/services/carriers/ShippoAdapter', liveShippo);
    billing.recordLabelCharge.mockResolvedValue(null);
    primeReturn({ shop: shopWith([{ carrier: 'shippo', isActive: true, credentials: {}, settings: {} }]) });
    load();

    await LabelService.generateLabel('ret_lbl_1');

    expect(prisma.returnEvent.create.mock.calls[0][0].data).toMatchObject({
      type: 'label.charge_failed',
      data: { charged: false, usageRecordId: null, error: expect.stringMatching(/No usage line item/) },
    });
  });
});

// ---------------------------------------------------------------------------
describe('LabelService.generateLabel — managed labels are only bought when they can be charged back', () => {
  const liveShippo = (generateLabel) => () => class {
    get carrierName() { return 'royalmail'; }

    get _isLive() { return true; }

    async generateLabel(...args) { return generateLabel(...args); }
  };
  const managedShop = () => shopWith([{ carrier: 'shippo', isActive: true, credentials: {}, settings: {} }]);

  it('buys nothing, emits LABEL_FAILED and throws when the merchant cannot be charged', async () => {
    const buy = jest.fn();
    jest.doMock('../../app/services/carriers/ShippoAdapter', liveShippo(buy));
    billing.managedLabelBilling.mockResolvedValue({ allowed: false, devStore: false, reason: 'no_usage_billing', lineItemId: null });
    primeReturn({ shop: managedShop() });
    load();
    const failed = jest.fn();
    eventBus.on(LABEL_FAILED, failed);

    await expect(LabelService.generateLabel('ret_lbl_1')).rejects.toMatchObject({
      code: 'MANAGED_LABEL_BILLING',
      reason: 'no_usage_billing',
    });

    expect(buy).not.toHaveBeenCalled();
    expect(prisma.returnLabel.create).not.toHaveBeenCalled();
    expect(prisma.return.update).not.toHaveBeenCalled();
    expect(billing.recordLabelCharge).not.toHaveBeenCalled();
    expect(failed).toHaveBeenCalledWith(expect.objectContaining({ returnId: 'ret_lbl_1', code: 'MANAGED_LABEL_BILLING' }));
  });

  it('on a development store buys the label but never charges for it', async () => {
    const buy = jest.fn().mockResolvedValue({ trackingCode: 'SHP-DEV', labelUrl: null, cost: 2.71, simulated: false });
    jest.doMock('../../app/services/carriers/ShippoAdapter', liveShippo(buy));
    billing.managedLabelBilling.mockResolvedValue({ allowed: true, devStore: true, reason: null, lineItemId: null });
    primeReturn({ shop: managedShop() });
    load();

    const label = await LabelService.generateLabel('ret_lbl_1');

    expect(buy).toHaveBeenCalledTimes(1);
    expect(label.trackingCode).toBe('SHP-DEV');
    expect(billing.recordLabelCharge).not.toHaveBeenCalled();
  });

  it('does not run the billing check for a simulated label (no platform key)', async () => {
    primeReturn({ shop: managedShop() });
    load();

    await LabelService.generateLabel('ret_lbl_1');

    expect(billing.managedLabelBilling).not.toHaveBeenCalled();
  });

  it('does not run the billing check when the merchant brought their own carrier credentials', async () => {
    const buy = jest.fn().mockResolvedValue({ trackingCode: 'SHP-BYO', labelUrl: null, cost: 3, simulated: false });
    jest.doMock('../../app/services/carriers/ShippoAdapter', liveShippo(buy));
    primeReturn({
      shop: shopWith([{
        carrier: 'shippo',
        isActive: true,
        credentials: { encrypted: encrypt(JSON.stringify({ apiKey: 'shippo_live_merchant' })) },
        settings: {},
      }]),
    });
    load();

    await LabelService.generateLabel('ret_lbl_1');

    expect(billing.managedLabelBilling).not.toHaveBeenCalled();
    expect(buy).toHaveBeenCalledTimes(1);
  });
});

// ---------------------------------------------------------------------------
describe('LabelService.generateLabel — live labels need real addresses and record the booked carrier', () => {
  const liveShippo = (generateLabel) => () => class {
    get carrierName() { return 'royalmail'; }

    get _isLive() { return true; }

    async generateLabel(...args) { return generateLabel(...args); }
  };
  const managedShop = (settings = {}) => shopWith(
    [{ carrier: 'shippo', isActive: true, credentials: {}, settings: {} }],
    { settings },
  );
  const noStoreAddress = {
    data: {
      shop: { billingAddress: { address1: null, address2: null, city: null, zip: null, provinceCode: null, countryCodeV2: 'US', phone: null } },
      order: shopifyAddressResponse.data.order,
    },
  };

  it('refuses a live label when there is no returns address (no warehouse setting, no store address)', async () => {
    const buy = jest.fn();
    jest.doMock('../../app/services/carriers/ShippoAdapter', liveShippo(buy));
    shopifyRequest.mockResolvedValue(noStoreAddress);
    primeReturn({ shop: managedShop() });
    load();
    const failed = jest.fn();
    eventBus.on(LABEL_FAILED, failed);

    await expect(LabelService.generateLabel('ret_lbl_1')).rejects.toMatchObject({ code: 'LABEL_ADDRESS_MISSING' });

    expect(buy).not.toHaveBeenCalled();
    expect(prisma.returnLabel.create).not.toHaveBeenCalled();
    expect(failed).toHaveBeenCalledWith(expect.objectContaining({
      code: 'LABEL_ADDRESS_MISSING',
      error: expect.stringMatching(/returns address/i),
    }));
  });

  it('uses the warehouse address from Settings when the store has none', async () => {
    const buy = jest.fn().mockResolvedValue({ trackingCode: 'T1', labelUrl: null, cost: 2.75, carrier: 'Evri', simulated: false });
    jest.doMock('../../app/services/carriers/ShippoAdapter', liveShippo(buy));
    shopifyRequest.mockResolvedValue(noStoreAddress);
    primeReturn({ shop: managedShop({ warehouseLine1: '5 Depot Road', warehouseCity: 'Leeds', warehousePostcode: 'LS2 7EY' }) });
    load();

    await LabelService.generateLabel('ret_lbl_1');

    expect(buy).toHaveBeenCalledTimes(1);
    expect(buy.mock.calls[0][0].recipientAddress).toMatchObject({ line1: '5 Depot Road', postcode: 'LS2 7EY' });
  });

  it('refuses a live label when the order has no shipping address to collect from', async () => {
    const buy = jest.fn();
    jest.doMock('../../app/services/carriers/ShippoAdapter', liveShippo(buy));
    shopifyRequest.mockResolvedValue({ data: { shop: shopifyAddressResponse.data.shop, order: { shippingAddress: null } } });
    primeReturn({ shop: managedShop() });
    load();

    await expect(LabelService.generateLabel('ret_lbl_1')).rejects.toThrow(/no shipping address/i);
    expect(buy).not.toHaveBeenCalled();
  });

  it('still makes a simulated label with placeholder addresses (no money, no parcel)', async () => {
    shopifyRequest.mockResolvedValue(noStoreAddress);
    primeReturn({ shop: managedShop() });
    load();

    const label = await LabelService.generateLabel('ret_lbl_1');
    expect(label.trackingCode).toMatch(/^SHP/);
  });

  it('records the carrier the aggregator actually booked, not the configured default', async () => {
    const buy = jest.fn().mockResolvedValue({ trackingCode: 'H01', labelUrl: null, cost: 2.75, carrier: 'Evri', simulated: false });
    jest.doMock('../../app/services/carriers/ShippoAdapter', liveShippo(buy));
    primeReturn({ shopifyOrderName: '#1013', shop: managedShop() });
    load();

    await LabelService.generateLabel('ret_lbl_1');

    expect(prisma.returnLabel.update.mock.calls[0][0].data.carrier).toBe('evri');
    expect(billing.recordLabelCharge.mock.calls[0][1].description).toBe('Return label evri #1013');
  });

  it('maps aggregator names for Evri (hermesuk) to our carrier code', async () => {
    const buy = jest.fn().mockResolvedValue({ trackingCode: 'H01', labelUrl: null, cost: 2.75, carrier: 'hermesuk', simulated: false });
    jest.doMock('../../app/services/carriers/ShippoAdapter', liveShippo(buy));
    primeReturn({ shop: managedShop() });
    load();

    await LabelService.generateLabel('ret_lbl_1');
    expect(prisma.returnLabel.update.mock.calls[0][0].data.carrier).toBe('evri');
  });

  it('normalises a multi-word provider name', async () => {
    const buy = jest.fn().mockResolvedValue({ trackingCode: 'RM1', labelUrl: null, cost: 3.2, carrier: 'Royal Mail', simulated: false });
    jest.doMock('../../app/services/carriers/ShippoAdapter', liveShippo(buy));
    primeReturn({ shop: managedShop() });
    load();

    await LabelService.generateLabel('ret_lbl_1');
    expect(prisma.returnLabel.update.mock.calls[0][0].data.carrier).toBe('royalmail');
  });
});
