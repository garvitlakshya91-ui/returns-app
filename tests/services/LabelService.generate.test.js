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
  prisma.returnLabel.create = jest.fn().mockImplementation(async ({ data }) => ({ id: 'lbl_new', ...data }));
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
      include: { shop: { include: { carrierConfigs: true } }, items: true },
    });

    expect(prisma.returnLabel.create).toHaveBeenCalledTimes(1);
    const data = prisma.returnLabel.create.mock.calls[0][0].data;
    expect(data).toMatchObject({
      returnId: 'ret_lbl_1',
      carrier: 'evri',
      dropoffType: 'ParcelShop',
      cost: 3.49,
      status: 'created',
      labelUrl: null,
    });
    expect(data.trackingCode).toMatch(/^EVR[0-9A-F]+$/);
    // No R2 → QR is an inline data URL encoding tracking + carrier + return + shop
    expect(data.qrCodeUrl).toMatch(/^data:image\/png;base64,/);
    expect(qrcode.toDataURL).toHaveBeenCalledTimes(1);
    expect(JSON.parse(qrcode.toDataURL.mock.calls[0][0])).toEqual({
      tracking: data.trackingCode,
      carrier: 'evri',
      returnId: 'ret_lbl_1',
      shop: 'test-shop.myshopify.com',
    });
    expect(qrcode.toBuffer).not.toHaveBeenCalled();
    expect(storage.upload).not.toHaveBeenCalled();

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
    expect(prisma.returnLabel.create.mock.calls[0][0].data.carrier).toBe('royalmail');
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
    expect(prisma.returnLabel.create).not.toHaveBeenCalled();
    expect(prisma.return.update).not.toHaveBeenCalled();
    expect(billing.recordLabelCharge).not.toHaveBeenCalled();
  });

  it('a DB failure on returnLabel.create also surfaces as LABEL_FAILED + rethrow (status not advanced)', async () => {
    primeReturn();
    prisma.returnLabel.create.mockRejectedValue(new Error('unique constraint returnId'));
    load();
    const failed = jest.fn();
    eventBus.on(LABEL_FAILED, failed);

    await expect(LabelService.generateLabel('ret_lbl_1')).rejects.toThrow('unique constraint returnId');
    expect(failed).toHaveBeenCalledWith({ returnId: 'ret_lbl_1', error: 'unique constraint returnId' });
    expect(prisma.return.update).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
describe('LabelService.generateLabel — R2 hosting of QR + label PDF', () => {
  const fakeAdapter = (result) => class {
    get carrierName() { return 'royalmail'; }

    async generateLabel() { return result; }
  };

  it('uploads the QR PNG to R2 and stores its public URL when R2_ACCOUNT_ID is set', async () => {
    process.env.R2_ACCOUNT_ID = 'acct';
    process.env.R2_PUBLIC_URL = 'https://cdn.test';
    primeReturn();
    load();

    await LabelService.generateLabel('ret_lbl_1');

    expect(qrcode.toBuffer).toHaveBeenCalledTimes(1);
    expect(qrcode.toDataURL).not.toHaveBeenCalled();
    expect(storage.upload).toHaveBeenCalledTimes(1);
    const [buffer, contentType, keyPrefix] = storage.upload.mock.calls[0];
    expect(Buffer.isBuffer(buffer)).toBe(true);
    expect(buffer.toString()).toBe('fake-png');
    expect(contentType).toBe('image/png');
    expect(keyPrefix).toBe('returns/ret_lbl_1/qr');
    expect(prisma.returnLabel.create.mock.calls[0][0].data.qrCodeUrl).toBe('https://cdn.test/returns/x/qr/1.png');
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
    expect(prisma.returnLabel.create.mock.calls[0][0].data.labelUrl).toBe('https://cdn.test/returns/x/labels/1.pdf');
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
    expect(prisma.returnLabel.create.mock.calls[0][0].data.labelUrl).toBe('https://carrier.example/label.pdf');
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
    expect(prisma.returnLabel.create.mock.calls[0][0].data.labelUrl).toBe('https://carrier.example/label.pdf');
  });
});

// ---------------------------------------------------------------------------
describe('LabelService.generateLabel — managed-platform billing', () => {
  const liveShippo = () => class {
    get carrierName() { return 'royalmail'; }

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
  });

  it('also bills for a platform ShipEngine label', async () => {
    jest.doMock('../../app/services/carriers/ShipEngineAdapter', () => class {
      get carrierName() { return 'royalmail'; }

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
  });
});
