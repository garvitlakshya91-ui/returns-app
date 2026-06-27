const { fakeShop } = require('../helpers');
const { encrypt } = require('../../app/utils/encryption');

let LabelService;

beforeEach(() => {
  jest.resetModules();
  LabelService = require('../../app/services/LabelService');
});

describe('LabelService.getCarrierAdapter — selection', () => {
  it('returns the requested carrier when active config exists', () => {
    const shop = fakeShop({
      carrierConfigs: [
        { carrier: 'evri', isActive: true, credentials: {}, settings: {} },
        { carrier: 'royalmail', isActive: true, credentials: {}, settings: {} },
      ],
    });
    const adapter = LabelService.getCarrierAdapter(shop, 'royalmail');
    expect(adapter.carrierName).toBe('royalmail');
  });

  it('falls back to the first active config when preferredCarrier is missing', () => {
    const shop = fakeShop({
      carrierConfigs: [
        { carrier: 'inpost', isActive: true, credentials: {}, settings: {} },
      ],
    });
    const adapter = LabelService.getCarrierAdapter(shop);
    expect(adapter.carrierName).toBe('inpost');
  });

  it('defaults to Evri when no configs are present at all', () => {
    const shop = fakeShop({ carrierConfigs: [] });
    const adapter = LabelService.getCarrierAdapter(shop);
    expect(adapter.carrierName).toBe('evri');
  });

  it('skips inactive configs', () => {
    const shop = fakeShop({
      carrierConfigs: [
        { carrier: 'royalmail', isActive: false, credentials: {}, settings: {} },
        { carrier: 'inpost', isActive: true, credentials: {}, settings: {} },
      ],
    });
    const adapter = LabelService.getCarrierAdapter(shop);
    expect(adapter.carrierName).toBe('inpost');
  });

  it('decrypts stored credentials when present', () => {
    const creds = { apiKey: 'evri-secret-1' };
    const shop = fakeShop({
      carrierConfigs: [{
        carrier: 'evri',
        isActive: true,
        credentials: { encrypted: encrypt(JSON.stringify(creds)) },
        settings: {},
      }],
    });
    const adapter = LabelService.getCarrierAdapter(shop, 'evri');
    expect(adapter.config.credentials).toEqual(creds);
  });
});

describe('Mock adapter outputs', () => {
  function shopWith(carrier) {
    return fakeShop({
      carrierConfigs: [{ carrier, isActive: true, credentials: {}, settings: {} }],
    });
  }

  it('Evri mock generates a tracking code with EVR prefix', async () => {
    const adapter = LabelService.getCarrierAdapter(shopWith('evri'), 'evri');
    const label = await adapter.generateLabel({
      senderAddress: { name: 'Jane' },
      recipientAddress: { name: 'Shop' },
      weight: 1,
      dimensions: {},
    });
    expect(label.trackingCode).toMatch(/^EVR[A-F0-9]+/);
    expect(typeof label.cost).toBe('number');
  });

  it('Royal Mail simulation generates a tracked-style tracking code', async () => {
    const adapter = LabelService.getCarrierAdapter(shopWith('royalmail'), 'royalmail');
    const label = await adapter.generateLabel({});
    expect(label.trackingCode).toMatch(/^RF\d{9}GB$/);
    expect(label.simulated).toBe(true);
  });

  it('Managed (shipengine) simulates when no platform env is configured', async () => {
    delete process.env.SHIPENGINE_API_KEY;
    delete process.env.SHIPENGINE_CARRIER_ID;
    const adapter = LabelService.getCarrierAdapter(shopWith('shipengine'), 'shipengine');
    expect(adapter.carrierName).toBe('royalmail'); // default carrierLabel for UK managed labels
    const label = await adapter.generateLabel({ senderAddress: { name: 'J' }, recipientAddress: { name: 'S' }, weight: 0.5 });
    expect(label.simulated).toBe(true);
    expect(label.trackingCode).toMatch(/^SE[A-F0-9]+$/);
  });

  it('Managed (shippo) simulates when no platform env is configured', async () => {
    delete process.env.SHIPPO_API_KEY;
    const adapter = LabelService.getCarrierAdapter(shopWith('shippo'), 'shippo');
    expect(adapter.carrierName).toBe('royalmail'); // default carrierLabel for UK managed labels
    const label = await adapter.generateLabel({ senderAddress: { name: 'J' }, recipientAddress: { name: 'S' }, weight: 0.5 });
    expect(label.simulated).toBe(true);
    expect(label.trackingCode).toMatch(/^SHP[A-F0-9]+$/);
  });

  it('Managed (shipengine) goes live using the platform env account', async () => {
    process.env.SHIPENGINE_API_KEY = 'TEST_platform';
    process.env.SHIPENGINE_CARRIER_ID = 'se-999';
    process.env.SHIPENGINE_SERVICE_CODE = 'usps_priority_mail';
    global.fetch = jest.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ tracking_number: 'TRACK1', label_download: { pdf: 'http://x/label.pdf' } }),
    });
    try {
      const adapter = LabelService.getCarrierAdapter(shopWith('shipengine'), 'shipengine');
      const label = await adapter.generateLabel({ senderAddress: { name: 'J', country: 'US' }, recipientAddress: { name: 'S', country: 'US' }, weight: 0.5 });
      expect(global.fetch).toHaveBeenCalledWith('https://api.shipengine.com/v1/labels', expect.any(Object));
      expect(label.trackingCode).toBe('TRACK1');
      expect(label.labelUrl).toBe('http://x/label.pdf');
    } finally {
      delete process.env.SHIPENGINE_API_KEY;
      delete process.env.SHIPENGINE_CARRIER_ID;
      delete process.env.SHIPENGINE_SERVICE_CODE;
    }
  });

  it('Evri dropoff lookup returns three ParcelShops keyed to the postcode', async () => {
    const adapter = LabelService.getCarrierAdapter(shopWith('evri'), 'evri');
    const locs = await adapter.getDropoffLocations({ postcode: 'GL1 1DQ' });
    expect(locs).toHaveLength(3);
    expect(locs.every((l) => l.id.includes('GL11DQ'))).toBe(true);
  });

  it('Evri dropoff lookup honors the limit', async () => {
    const adapter = LabelService.getCarrierAdapter(shopWith('evri'), 'evri');
    const locs = await adapter.getDropoffLocations({ postcode: 'EC1A 1BB', limit: 2 });
    expect(locs).toHaveLength(2);
  });
});
