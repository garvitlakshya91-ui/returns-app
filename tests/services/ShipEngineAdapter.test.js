const ShipEngineAdapter = require('../../app/services/carriers/ShipEngineAdapter');

const LABEL_ARGS = {
  senderAddress: { name: 'Jane', line1: '1 Test St', city: 'San Jose', state: 'CA', postcode: '95128', country: 'US' },
  recipientAddress: { name: 'Warehouse', line1: '2 Depot Rd', city: 'Austin', state: 'TX', postcode: '78756', country: 'US' },
  weight: 0.5,
};

describe('ShipEngineAdapter — basics', () => {
  it('defaults carrierName to shipengine, honouring a carrierLabel override', () => {
    expect(new ShipEngineAdapter({}).carrierName).toBe('shipengine');
    expect(new ShipEngineAdapter({ settings: { carrierLabel: 'royalmail' } }).carrierName).toBe('royalmail');
  });
});

describe('ShipEngineAdapter — simulation mode (default)', () => {
  it('produces a simulated label without hitting the network', async () => {
    global.fetch = jest.fn();
    const label = await new ShipEngineAdapter({}).generateLabel(LABEL_ARGS);
    expect(global.fetch).not.toHaveBeenCalled();
    expect(label.simulated).toBe(true);
    expect(label.trackingCode).toMatch(/^SE[A-F0-9]+$/);
  });

  it('stays in simulation when live is set but carrierId is missing', async () => {
    global.fetch = jest.fn();
    const adapter = new ShipEngineAdapter({ credentials: { apiKey: 'TEST_x' }, settings: { live: true } });
    const label = await adapter.generateLabel(LABEL_ARGS);
    expect(global.fetch).not.toHaveBeenCalled();
    expect(label.simulated).toBe(true);
  });
});

describe('ShipEngineAdapter — live mode', () => {
  function live() {
    return new ShipEngineAdapter({
      credentials: { apiKey: 'TEST_key' },
      settings: { live: true, carrierId: 'se-123', serviceCode: 'usps_priority_mail' },
    });
  }

  it('POSTs a return label to /v1/labels with the API-Key header', async () => {
    global.fetch = jest.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        label_id: 'se-label-1',
        tracking_number: '1Z999AA10123456784',
        shipment_cost: { amount: 6.5, currency: 'usd' },
        label_download: { pdf: 'https://api.shipengine.com/v1/downloads/x/label.pdf' },
      }),
    });

    const label = await live().generateLabel(LABEL_ARGS);

    const [url, opts] = global.fetch.mock.calls[0];
    expect(url).toBe('https://api.shipengine.com/v1/labels');
    expect(opts.method).toBe('POST');
    expect(opts.headers['API-Key']).toBe('TEST_key');

    const sent = JSON.parse(opts.body);
    expect(sent.shipment.is_return_label).toBe(true);
    expect(sent.shipment.carrier_id).toBe('se-123');
    expect(sent.shipment.packages[0].weight).toEqual({ value: 500, unit: 'gram' });
    expect(sent.shipment.ship_to.postal_code).toBe('78756'); // warehouse is the destination

    expect(label.trackingCode).toBe('1Z999AA10123456784');
    expect(label.labelUrl).toContain('label.pdf');
    expect(label.cost).toBe(6.5);
  });

  it('throws on a non-2xx ShipEngine response', async () => {
    global.fetch = jest.fn().mockResolvedValue({ ok: false, status: 400, text: async () => 'bad request' });
    await expect(live().generateLabel(LABEL_ARGS)).rejects.toThrow(/ShipEngine label create failed \(400\)/);
  });
});
