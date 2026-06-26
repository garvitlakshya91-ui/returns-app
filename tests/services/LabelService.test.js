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
