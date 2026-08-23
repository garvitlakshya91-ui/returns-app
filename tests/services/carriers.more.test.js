// Additional carrier-adapter coverage: live-path error branches, address
// defaulting, tracking/drop-off shapes, and the abstract base class.
// Every live path uses a mocked global.fetch — nothing touches the network.

const CarrierAdapter = require('../../app/services/carriers/CarrierAdapter');
const ShippoAdapter = require('../../app/services/carriers/ShippoAdapter');
const ShipEngineAdapter = require('../../app/services/carriers/ShipEngineAdapter');
const RoyalMailAdapter = require('../../app/services/carriers/RoyalMailAdapter');
const InPostAdapter = require('../../app/services/carriers/InPostAdapter');
const EvriAdapter = require('../../app/services/EvriAdapter');

const DAY = 24 * 60 * 60 * 1000;

const FULL_ARGS = {
  senderAddress: { name: 'Jane', line1: '1 Test St', city: 'London', postcode: 'EC1A 1BB', country: 'GB', phone: '0123', email: 'jane@x.com', state: 'LDN' },
  recipientAddress: { name: 'Warehouse', line1: '2 Depot Rd', city: 'Leeds', postcode: 'LS1 1AA', country: 'GB' },
  weight: 0.5,
};

const originalFetch = global.fetch;
afterEach(() => {
  global.fetch = originalFetch;
});

function okJson(body) {
  return { ok: true, json: async () => body };
}

// ─── CarrierAdapter (abstract base) ──────────────────────────────────────────

describe('CarrierAdapter base class', () => {
  it('stores the config it is constructed with', () => {
    const cfg = { credentials: { apiKey: 'k' }, settings: { live: true } };
    expect(new CarrierAdapter(cfg).config).toBe(cfg);
  });

  it('rejects every abstract async method with "Not implemented"', async () => {
    const base = new CarrierAdapter({});
    await expect(base.generateLabel({})).rejects.toThrow('Not implemented');
    await expect(base.getTrackingStatus('X')).rejects.toThrow('Not implemented');
    await expect(base.getDropoffLocations({ postcode: 'GL1' })).rejects.toThrow('Not implemented');
  });

  it('throws synchronously from the carrierName getter', () => {
    const base = new CarrierAdapter({});
    expect(() => base.carrierName).toThrow('Not implemented');
  });

  it('lets subclasses override the contract', async () => {
    class Fake extends CarrierAdapter {
      get carrierName() { return 'fake'; }
      async generateLabel() { return { trackingCode: 'F1' }; }
    }
    const f = new Fake({});
    expect(f.carrierName).toBe('fake');
    await expect(f.generateLabel({})).resolves.toEqual({ trackingCode: 'F1' });
    // Non-overridden methods still fall through to the base behaviour.
    await expect(f.getTrackingStatus('F1')).rejects.toThrow('Not implemented');
  });
});

// ─── ShippoAdapter ───────────────────────────────────────────────────────────

describe('ShippoAdapter — live error branches', () => {
  const live = (settings = {}) => new ShippoAdapter({ credentials: { apiKey: 'shippo_test_k' }, settings: { live: true, ...settings } });

  it('throws with the HTTP status when the transaction call is non-ok, without returning a label', async () => {
    global.fetch = jest.fn()
      .mockResolvedValueOnce(okJson({ rates: [{ object_id: 'r1', amount: '3.00', servicelevel: {} }] }))
      .mockResolvedValueOnce({ ok: false, status: 502, text: async () => 'bad gateway' });
    await expect(live().generateLabel(FULL_ARGS)).rejects.toThrow('Shippo transaction failed (502)');
    expect(global.fetch).toHaveBeenCalledTimes(2);
  });

  it('still throws when the error body cannot be read (text() rejects)', async () => {
    global.fetch = jest.fn().mockResolvedValue({ ok: false, status: 500, text: async () => { throw new Error('stream closed'); } });
    await expect(live().generateLabel(FULL_ARGS)).rejects.toThrow('Shippo shipment create failed (500)');
  });

  it('throws when the shipment response has no rates key at all', async () => {
    global.fetch = jest.fn().mockResolvedValueOnce(okJson({ object_id: 'ship_1' }));
    await expect(live().generateLabel(FULL_ARGS)).rejects.toThrow(/no rates/);
    expect(global.fetch).toHaveBeenCalledTimes(1); // never tries to buy a label
  });

  it('reports the raw status when the transaction is not SUCCESS and carries no messages', async () => {
    global.fetch = jest.fn()
      .mockResolvedValueOnce(okJson({ rates: [{ object_id: 'r1', amount: '3.00', servicelevel: {} }] }))
      .mockResolvedValueOnce(okJson({ status: 'QUEUED' }));
    await expect(live().generateLabel(FULL_ARGS)).rejects.toThrow('Shippo label not created: QUEUED');
  });

  it('joins multiple Shippo messages into the error', async () => {
    global.fetch = jest.fn()
      .mockResolvedValueOnce(okJson({ rates: [{ object_id: 'r1', amount: '3.00', servicelevel: {} }] }))
      .mockResolvedValueOnce(okJson({ status: 'ERROR', messages: [{ text: 'bad postcode' }, { text: 'no phone' }] }));
    await expect(live().generateLabel(FULL_ARGS)).rejects.toThrow('bad postcode, no phone');
  });

  it('falls back to the cheapest rate when the configured service level is not offered', async () => {
    global.fetch = jest.fn()
      .mockResolvedValueOnce(okJson({ rates: [
        { object_id: 'rate_mid', amount: '4.00', provider: 'DPD', servicelevel: { token: 'dpd_std' } },
        { object_id: 'rate_cheap', amount: '2.10', provider: 'Evri', servicelevel: { token: 'evri_std' } },
        { object_id: 'rate_dear', amount: '9.99', provider: 'UPS', servicelevel: { token: 'ups_exp' } },
      ] }))
      .mockResolvedValueOnce(okJson({ status: 'SUCCESS', tracking_number: 'T', label_url: 'u' }));
    const label = await live({ servicelevelToken: 'does_not_exist' }).generateLabel(FULL_ARGS);
    expect(JSON.parse(global.fetch.mock.calls[1][1].body).rate).toBe('rate_cheap');
    expect(label.carrier).toBe('Evri');
    expect(label.cost).toBe(2.1);
  });

  it('does not mutate the order of the rates it was given when sorting', async () => {
    const rates = [
      { object_id: 'a', amount: '5', servicelevel: {} },
      { object_id: 'b', amount: '1', servicelevel: {} },
    ];
    global.fetch = jest.fn()
      .mockResolvedValueOnce(okJson({ rates }))
      .mockResolvedValueOnce(okJson({ status: 'SUCCESS', tracking_number: 'T', label_url: 'u' }));
    await live().generateLabel(FULL_ARGS);
    expect(rates.map((r) => r.object_id)).toEqual(['a', 'b']);
  });

  it('passes through qr_code_url and nulls cost when the rate amount is not numeric', async () => {
    global.fetch = jest.fn()
      .mockResolvedValueOnce(okJson({ rates: [{ object_id: 'r', amount: 'free', provider: 'X', servicelevel: { name: 'Std' } }] }))
      .mockResolvedValueOnce(okJson({ status: 'SUCCESS', tracking_number: 'T9', label_url: 'l', qr_code_url: 'https://shippo/qr.png' }));
    const label = await live().generateLabel(FULL_ARGS);
    expect(label).toMatchObject({ trackingCode: 'T9', labelUrl: 'l', qrCodeUrl: 'https://shippo/qr.png', cost: null, service: 'Std' });
  });

  it('defaults qrCodeUrl to null when Shippo omits it', async () => {
    global.fetch = jest.fn()
      .mockResolvedValueOnce(okJson({ rates: [{ object_id: 'r', amount: '1', servicelevel: {} }] }))
      .mockResolvedValueOnce(okJson({ status: 'SUCCESS', tracking_number: 'T', label_url: 'l' }));
    const label = await live().generateLabel(FULL_ARGS);
    expect(label.qrCodeUrl).toBeNull();
  });
});

describe('ShippoAdapter — request shaping', () => {
  const live = (settings = {}) => new ShippoAdapter({ credentials: { apiKey: 'shippo_test_k' }, settings: { live: true, ...settings } });

  function twoStepOk() {
    global.fetch = jest.fn()
      .mockResolvedValueOnce(okJson({ rates: [{ object_id: 'r', amount: '1', servicelevel: {} }] }))
      .mockResolvedValueOnce(okJson({ status: 'SUCCESS', tracking_number: 'T', label_url: 'l' }));
  }

  it('fills sensible defaults for missing address fields and maps the full address when present', async () => {
    twoStepOk();
    await live().generateLabel({ senderAddress: {}, recipientAddress: FULL_ARGS.senderAddress, weight: 1 });
    const body = JSON.parse(global.fetch.mock.calls[0][1].body);
    expect(body.address_from).toEqual({
      name: 'Customer', street1: 'N/A', city: 'N/A', state: '', zip: '', country: 'GB', phone: '', email: '',
    });
    expect(body.address_to).toEqual({
      name: 'Jane', street1: '1 Test St', city: 'London', state: 'LDN', zip: 'EC1A 1BB', country: 'GB', phone: '0123', email: 'jane@x.com',
    });
  });

  it('accepts stateProvince as an alias for state', async () => {
    twoStepOk();
    await live().generateLabel({ senderAddress: { stateProvince: 'CA' }, recipientAddress: {}, weight: 1 });
    const body = JSON.parse(global.fetch.mock.calls[0][1].body);
    expect(body.address_from.state).toBe('CA');
  });

  it('tolerates undefined addresses entirely', async () => {
    twoStepOk();
    await expect(live().generateLabel({ weight: 1 })).resolves.toMatchObject({ trackingCode: 'T' });
  });

  it('defaults a missing weight to 0.5kg and clamps tiny weights up to 0.1kg', async () => {
    twoStepOk();
    await live().generateLabel({ senderAddress: {}, recipientAddress: {} });
    expect(JSON.parse(global.fetch.mock.calls[0][1].body).parcels[0]).toMatchObject({ weight: '0.5', mass_unit: 'kg', distance_unit: 'cm' });

    twoStepOk();
    await live().generateLabel({ senderAddress: {}, recipientAddress: {}, weight: 0.01 });
    expect(JSON.parse(global.fetch.mock.calls[0][1].body).parcels[0].weight).toBe('0.1');
  });

  it('honours a baseUrl override and strips its trailing slash', async () => {
    twoStepOk();
    await live({ baseUrl: 'https://sandbox.shippo.test/' }).generateLabel(FULL_ARGS);
    expect(global.fetch.mock.calls[0][0]).toBe('https://sandbox.shippo.test/shipments/');
    expect(global.fetch.mock.calls[1][0]).toBe('https://sandbox.shippo.test/transactions/');
  });

  it('requests a PDF label synchronously for the chosen rate', async () => {
    twoStepOk();
    await live().generateLabel(FULL_ARGS);
    const txBody = JSON.parse(global.fetch.mock.calls[1][1].body);
    expect(txBody).toEqual({ rate: 'r', label_file_type: 'PDF', async: false });
    expect(global.fetch.mock.calls[1][1].headers.Authorization).toBe('ShippoToken shippo_test_k');
  });
});

describe('ShippoAdapter — tracking + drop-offs', () => {
  it('returns an in_transit tracking status with dates', async () => {
    const before = Date.now();
    const s = await new ShippoAdapter({}).getTrackingStatus('SHP1');
    expect(s.status).toBe('in_transit');
    expect(s.lastUpdate).toBeInstanceOf(Date);
    expect(s.estimatedDelivery.getTime()).toBeGreaterThanOrEqual(before + 2 * DAY - 1000);
    expect(s.trackingUrl).toBeNull();
  });

  it('returns at most one generic drop-off point regardless of limit, and none for limit 0', async () => {
    const a = new ShippoAdapter({});
    expect(await a.getDropoffLocations({ postcode: 'GL1 1AA', limit: 5 })).toHaveLength(1);
    expect(await a.getDropoffLocations({ postcode: 'GL1 1AA' })).toHaveLength(1);
    expect(await a.getDropoffLocations({ postcode: 'GL1 1AA', limit: 0 })).toHaveLength(0);
    const [loc] = await a.getDropoffLocations({ postcode: 'GL1 1AA', limit: 1 });
    expect(loc).toMatchObject({ id: 'shp-GL1 1AA-1', address: '1 High Street, GL1 1AA', type: 'Drop-off' });
  });
});

// ─── ShipEngineAdapter ───────────────────────────────────────────────────────

describe('ShipEngineAdapter — tracking + drop-offs', () => {
  it('returns an in_transit status with a ~2 day ETA', async () => {
    const before = Date.now();
    const s = await new ShipEngineAdapter({}).getTrackingStatus('SE1');
    expect(s).toMatchObject({ status: 'in_transit', location: 'Carrier network', trackingUrl: null });
    expect(s.lastUpdate).toBeInstanceOf(Date);
    expect(s.estimatedDelivery.getTime()).toBeGreaterThanOrEqual(before + 2 * DAY - 1000);
  });

  it('caps drop-offs at one and respects a zero limit', async () => {
    const a = new ShipEngineAdapter({});
    expect(await a.getDropoffLocations({ postcode: 'M1', limit: 3 })).toEqual([
      expect.objectContaining({ id: 'se-M1-1', address: '1 High Street, M1', type: 'Drop-off' }),
    ]);
    expect(await a.getDropoffLocations({ postcode: 'M1', limit: 0 })).toEqual([]);
  });
});

describe('ShipEngineAdapter — live response mapping + defaults', () => {
  const live = (settings = {}) => new ShipEngineAdapter({
    credentials: { apiKey: 'TEST_key' },
    settings: { live: true, carrierId: 'se-1', serviceCode: 'svc', ...settings },
  });

  it('falls back to the package tracking number, then label_id, and to label_download.href', async () => {
    global.fetch = jest.fn().mockResolvedValue(okJson({
      label_id: 'lbl_1',
      packages: [{ tracking_number: 'PKG123' }],
      label_download: { href: 'https://se/label' },
    }));
    const label = await live().generateLabel(FULL_ARGS);
    expect(label.trackingCode).toBe('PKG123');
    expect(label.labelUrl).toBe('https://se/label');
    expect(label.cost).toBeNull();
    expect(label.labelId).toBe('lbl_1');
    expect(label.service).toBe('svc');

    global.fetch = jest.fn().mockResolvedValue(okJson({ label_id: 'lbl_only' }));
    const bare = await live().generateLabel(FULL_ARGS);
    expect(bare.trackingCode).toBe('lbl_only');
    expect(bare.labelUrl).toBeNull();
  });

  it('applies address defaults and residential indicators (customer = yes, warehouse = no)', async () => {
    global.fetch = jest.fn().mockResolvedValue(okJson({ label_id: 'x' }));
    await live().generateLabel({ senderAddress: {}, recipientAddress: { name: 'WH', stateProvince: 'TX' } });
    const sent = JSON.parse(global.fetch.mock.calls[0][1].body).shipment;
    expect(sent.ship_from).toEqual({
      name: 'Customer', phone: '000-000-0000', address_line1: 'N/A', city_locality: 'N/A',
      state_province: '', postal_code: '', country_code: 'GB', address_residential_indicator: 'yes',
    });
    expect(sent.ship_to).toMatchObject({ name: 'WH', state_province: 'TX', address_residential_indicator: 'no' });
    // default weight 0.5kg → 500g
    expect(sent.packages[0].weight).toEqual({ value: 500, unit: 'gram' });
  });

  it('never sends a zero-gram package', async () => {
    global.fetch = jest.fn().mockResolvedValue(okJson({ label_id: 'x' }));
    await live().generateLabel({ senderAddress: {}, recipientAddress: {}, weight: 0.0001 });
    expect(JSON.parse(global.fetch.mock.calls[0][1].body).shipment.packages[0].weight.value).toBe(1);
  });

  it('honours a baseUrl override (trailing slash stripped) and still throws when the error body is unreadable', async () => {
    global.fetch = jest.fn().mockResolvedValue({ ok: false, status: 429, text: async () => { throw new Error('nope'); } });
    await expect(live({ baseUrl: 'https://api.sandbox.se/' }).generateLabel(FULL_ARGS))
      .rejects.toThrow('ShipEngine label create failed (429)');
    expect(global.fetch.mock.calls[0][0]).toBe('https://api.sandbox.se/v1/labels');
  });
});

// ─── RoyalMailAdapter ────────────────────────────────────────────────────────

describe('RoyalMailAdapter — live response mapping + defaults', () => {
  const live = (settings = {}) => new RoyalMailAdapter({ credentials: { apiKey: 'rm_k' }, settings: { live: true, ...settings } });

  it('reads the order from data.orders when createdOrders is absent and prefers shipmentId over orderIdentifier', async () => {
    global.fetch = jest.fn().mockResolvedValue(okJson({ orders: [{ orderIdentifier: 11, shipmentId: 'SHIP-11', shippingCost: 2.5 }] }));
    const label = await live().generateLabel(FULL_ARGS);
    expect(label.trackingCode).toBe('SHIP-11');
    expect(label.cost).toBe(2.5); // falls back to shippingCost
    expect(label.orderIdentifier).toBe(11);
    expect(label.labelUrl).toBeNull();
    expect(label.qrCodeUrl).toBeNull();
  });

  it('prefers totalCost over shippingCost and nulls cost when neither is present', async () => {
    global.fetch = jest.fn().mockResolvedValue(okJson({ createdOrders: [{ orderIdentifier: 1, totalCost: 3.1, shippingCost: 2.5 }] }));
    expect((await live().generateLabel(FULL_ARGS)).cost).toBe(3.1);
    global.fetch = jest.fn().mockResolvedValue(okJson({ createdOrders: [{ orderIdentifier: 1 }] }));
    expect((await live().generateLabel(FULL_ARGS)).cost).toBeNull();
  });

  it('falls back to the generated orderReference when the response has no orders at all', async () => {
    global.fetch = jest.fn().mockResolvedValue(okJson({}));
    const label = await live().generateLabel(FULL_ARGS);
    expect(label.trackingCode).toMatch(/^RF-\d+-[0-9a-f]{6}$/);
    expect(label.orderIdentifier).toBeUndefined();
  });

  it('omits postageDetails and reports a generic service when no serviceCode is configured', async () => {
    global.fetch = jest.fn().mockResolvedValue(okJson({ createdOrders: [{ orderIdentifier: 1 }] }));
    const label = await live().generateLabel(FULL_ARGS);
    const item = JSON.parse(global.fetch.mock.calls[0][1].body).items[0];
    expect(item.postageDetails).toBeUndefined();
    expect(item.packages[0].packageFormatIdentifier).toBe('parcel');
    expect(label.service).toBe('Click & Drop');
  });

  it('uses a configured packageFormat and the service code as the reported service', async () => {
    global.fetch = jest.fn().mockResolvedValue(okJson({ createdOrders: [{ orderIdentifier: 1 }] }));
    const label = await live({ serviceCode: 'TPS48', packageFormat: 'largeLetter' }).generateLabel(FULL_ARGS);
    const item = JSON.parse(global.fetch.mock.calls[0][1].body).items[0];
    expect(item.packages[0].packageFormatIdentifier).toBe('largeLetter');
    expect(item.postageDetails).toEqual({ serviceCode: 'TPS48' });
    expect(label.service).toBe('TPS48');
  });

  it('defaults sender address fields, clamps weight to 100g, and always sends an orderDate', async () => {
    global.fetch = jest.fn().mockResolvedValue(okJson({ createdOrders: [{ orderIdentifier: 1 }] }));
    await live().generateLabel({ senderAddress: { name: 'Jane' }, recipientAddress: FULL_ARGS.recipientAddress, weight: 0.02 });
    const item = JSON.parse(global.fetch.mock.calls[0][1].body).items[0];
    expect(item.sender.address).toEqual({ fullName: 'Jane', addressLine1: 'N/A', city: 'N/A', postcode: '', countryCode: 'GB' });
    expect(item.recipient.address).toEqual({ fullName: 'Warehouse', addressLine1: '2 Depot Rd', city: 'Leeds', postcode: 'LS1 1AA', countryCode: 'GB' });
    expect(item.packages[0].weightInGrams).toBe(100);
    expect(item.orderReference).toMatch(/^RF-/);
    expect(new Date(item.orderDate).toString()).not.toBe('Invalid Date');
  });

  it('defaults the weight to 500g when none is supplied', async () => {
    global.fetch = jest.fn().mockResolvedValue(okJson({ createdOrders: [{ orderIdentifier: 1 }] }));
    await live().generateLabel({ senderAddress: {}, recipientAddress: {} });
    expect(JSON.parse(global.fetch.mock.calls[0][1].body).items[0].packages[0].weightInGrams).toBe(500);
  });

  it('still throws with the status when the error body cannot be read', async () => {
    global.fetch = jest.fn().mockResolvedValue({ ok: false, status: 503, text: async () => { throw new Error('closed'); } });
    await expect(live().generateLabel(FULL_ARGS)).rejects.toThrow('Royal Mail order create failed (503)');
  });

  it('never returns more drop-offs than it knows about, and none for limit 0', async () => {
    const a = new RoyalMailAdapter({});
    const many = await a.getDropoffLocations({ postcode: 'GL1', limit: 10 });
    expect(many).toHaveLength(2);
    expect(many.map((l) => l.type)).toEqual(['Post Office', 'Delivery Office']);
    expect(many[1].distance).toBe('0.5 miles');
    expect(await a.getDropoffLocations({ postcode: 'GL1', limit: 0 })).toEqual([]);
  });
});

// ─── EvriAdapter ─────────────────────────────────────────────────────────────

describe('EvriAdapter', () => {
  it('identifies itself as evri', () => {
    expect(new EvriAdapter({}).carrierName).toBe('evri');
  });

  it('produces a mock label (no network) when no API key is configured', async () => {
    global.fetch = jest.fn();
    const before = Date.now();
    const label = await new EvriAdapter({}).generateLabel(FULL_ARGS);
    expect(global.fetch).not.toHaveBeenCalled();
    expect(label.trackingCode).toMatch(/^EVR[A-F0-9]{12}$/);
    expect(label).toMatchObject({ labelUrl: null, qrCodeUrl: null, cost: 3.49, carrier: 'evri' });
    expect(label.estimatedDelivery.getTime()).toBeGreaterThanOrEqual(before + 3 * DAY - 1000);
  });

  it('generates unique tracking codes per label', async () => {
    const a = new EvriAdapter(null);
    const codes = await Promise.all([1, 2, 3].map(() => a.generateLabel(FULL_ARGS)));
    expect(new Set(codes.map((l) => l.trackingCode)).size).toBe(3);
  });

  it('selects the real path when an API key is present and reports it as not yet implemented', async () => {
    global.fetch = jest.fn();
    const a = new EvriAdapter({ credentials: { apiKey: 'evri_live' } });
    await expect(a.generateLabel(FULL_ARGS)).rejects.toThrow(/Real Evri API not yet implemented/);
    expect(global.fetch).not.toHaveBeenCalled();
  });

  it('returns a plausible tracking status from the mock cycle', async () => {
    const before = Date.now();
    const s = await new EvriAdapter({ credentials: { apiKey: 'k' } }).getTrackingStatus('EVR1');
    expect(['collected', 'in_transit', 'out_for_delivery', 'delivered']).toContain(s.status);
    expect(typeof s.location).toBe('string');
    expect(s.lastUpdate).toBeInstanceOf(Date);
    expect(s.estimatedDelivery.getTime()).toBeGreaterThanOrEqual(before + 2 * DAY - 1000);
  });

  it('returns up to three ParcelShops, honouring limit, with ids normalised from the postcode', async () => {
    const a = new EvriAdapter({});
    const all = await a.getDropoffLocations({ postcode: 'gl1 1dq' });
    expect(all).toHaveLength(3);
    expect(all.map((l) => l.id)).toEqual(['evri-GL11DQ-1', 'evri-GL11DQ-2', 'evri-GL11DQ-3']);
    expect(all[0].address).toBe('45 High Street, gl1 1dq'); // raw postcode kept in the address
    expect(all.every((l) => l.type === 'ParcelShop')).toBe(true);

    const two = await a.getDropoffLocations({ postcode: 'GL1 1DQ', limit: 2 });
    expect(two.map((l) => l.name)).toEqual(['Tesco Express', 'WHSmith']);
    expect(await a.getDropoffLocations({ postcode: 'GL1', limit: 0 })).toEqual([]);
  });

  it('does not crash when postcode is missing', async () => {
    const locs = await new EvriAdapter({}).getDropoffLocations({});
    expect(locs).toHaveLength(3);
    expect(locs[0].id).toBe('evri--1');
  });
});

// ─── InPostAdapter ───────────────────────────────────────────────────────────

describe('InPostAdapter', () => {
  it('identifies itself as inpost', () => {
    expect(new InPostAdapter({}).carrierName).toBe('inpost');
  });

  it('generates a locker-return label with an IP-prefixed tracking code', async () => {
    const before = Date.now();
    const label = await new InPostAdapter({}).generateLabel(FULL_ARGS);
    expect(label.trackingCode).toMatch(/^IP[A-F0-9]{12}$/);
    expect(label).toMatchObject({ labelUrl: null, qrCodeUrl: null, cost: 2.99, carrier: 'inpost' });
    expect(label.estimatedDelivery.getTime()).toBeGreaterThanOrEqual(before + 3 * DAY - 1000);
  });

  it('reports parcels as awaiting collection at a locker', async () => {
    const s = await new InPostAdapter({}).getTrackingStatus('IP1');
    expect(s).toMatchObject({ status: 'awaiting_collection', location: 'InPost Locker' });
    expect(s.lastUpdate).toBeInstanceOf(Date);
    expect(s.estimatedDelivery).toBeInstanceOf(Date);
  });

  it('lists 24/7 lockers near the postcode, honouring limit', async () => {
    const a = new InPostAdapter({});
    const all = await a.getDropoffLocations({ postcode: 'SW1A 1AA' });
    expect(all).toHaveLength(2);
    expect(all.every((l) => l.type === 'Locker' && l.openingHours === '24/7')).toBe(true);
    expect(all[0].id).toBe('ip-SW1A 1AA-1');
    expect(all[1].address).toContain('SW1A 1AA');

    expect(await a.getDropoffLocations({ postcode: 'SW1A 1AA', limit: 1 })).toHaveLength(1);
    expect(await a.getDropoffLocations({ postcode: 'SW1A 1AA', limit: 0 })).toEqual([]);
  });
});
