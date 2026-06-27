const ShippoAdapter = require('../../app/services/carriers/ShippoAdapter');

const LABEL_ARGS = {
  senderAddress: { name: 'Jane', line1: '1 Test St', city: 'London', postcode: 'EC1A 1BB', country: 'GB' },
  recipientAddress: { name: 'Warehouse', line1: '2 Depot Rd', city: 'London', postcode: 'SW1A 1AA', country: 'GB' },
  weight: 0.5,
};

describe('ShippoAdapter — basics', () => {
  it('defaults carrierName to shippo, honouring a carrierLabel override', () => {
    expect(new ShippoAdapter({}).carrierName).toBe('shippo');
    expect(new ShippoAdapter({ settings: { carrierLabel: 'royalmail' } }).carrierName).toBe('royalmail');
  });
});

describe('ShippoAdapter — simulation mode (default)', () => {
  it('produces a simulated label without hitting the network', async () => {
    global.fetch = jest.fn();
    const label = await new ShippoAdapter({}).generateLabel(LABEL_ARGS);
    expect(global.fetch).not.toHaveBeenCalled();
    expect(label.simulated).toBe(true);
    expect(label.trackingCode).toMatch(/^SHP[A-F0-9]+$/);
  });

  it('stays in simulation when live is set but no token is present', async () => {
    global.fetch = jest.fn();
    const label = await new ShippoAdapter({ settings: { live: true } }).generateLabel(LABEL_ARGS);
    expect(global.fetch).not.toHaveBeenCalled();
    expect(label.simulated).toBe(true);
  });
});

describe('ShippoAdapter — live mode (shipment → rate → transaction)', () => {
  function live() {
    return new ShippoAdapter({ credentials: { apiKey: 'shippo_test_abc' }, settings: { live: true } });
  }

  it('creates a return shipment, buys the cheapest rate, and returns the label', async () => {
    global.fetch = jest.fn()
      // 1) POST /shipments/ → rates
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          object_id: 'ship_1',
          rates: [
            { object_id: 'rate_premium', amount: '6.50', provider: 'Royal Mail', servicelevel: { name: 'Tracked 24', token: 'rm_24' } },
            { object_id: 'rate_cheap', amount: '3.20', provider: 'Evri', servicelevel: { name: 'Standard', token: 'evri_std' } },
          ],
        }),
      })
      // 2) POST /transactions/ → label
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ status: 'SUCCESS', tracking_number: 'H00CC123', label_url: 'https://shippo/label.pdf' }),
      });

    const label = await live().generateLabel(LABEL_ARGS);

    expect(global.fetch).toHaveBeenCalledTimes(2);
    const [shipUrl, shipOpts] = global.fetch.mock.calls[0];
    expect(shipUrl).toBe('https://api.goshippo.com/shipments/');
    expect(shipOpts.headers.Authorization).toBe('ShippoToken shippo_test_abc');
    expect(JSON.parse(shipOpts.body).extra.is_return).toBe(true);

    const txBody = JSON.parse(global.fetch.mock.calls[1][1].body);
    expect(global.fetch.mock.calls[1][0]).toBe('https://api.goshippo.com/transactions/');
    expect(txBody.rate).toBe('rate_cheap'); // cheapest rate chosen

    expect(label.trackingCode).toBe('H00CC123');
    expect(label.labelUrl).toBe('https://shippo/label.pdf');
    expect(label.cost).toBe(3.2);
    expect(label.carrier).toBe('Evri');
  });

  it('honours a configured service level over the cheapest rate', async () => {
    global.fetch = jest.fn()
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ rates: [
          { object_id: 'rate_premium', amount: '6.50', provider: 'Royal Mail', servicelevel: { token: 'rm_24' } },
          { object_id: 'rate_cheap', amount: '3.20', provider: 'Evri', servicelevel: { token: 'evri_std' } },
        ] }),
      })
      .mockResolvedValueOnce({ ok: true, json: async () => ({ status: 'SUCCESS', tracking_number: 'T1', label_url: 'u' }) });

    const adapter = new ShippoAdapter({ credentials: { apiKey: 'k' }, settings: { live: true, servicelevelToken: 'rm_24' } });
    await adapter.generateLabel(LABEL_ARGS);
    expect(JSON.parse(global.fetch.mock.calls[1][1].body).rate).toBe('rate_premium');
  });

  it('throws when the shipment call fails', async () => {
    global.fetch = jest.fn().mockResolvedValue({ ok: false, status: 401, text: async () => 'unauthorized' });
    await expect(live().generateLabel(LABEL_ARGS)).rejects.toThrow(/Shippo shipment create failed \(401\)/);
  });

  it('throws when there are no rates', async () => {
    global.fetch = jest.fn().mockResolvedValueOnce({ ok: true, json: async () => ({ rates: [] }) });
    await expect(live().generateLabel(LABEL_ARGS)).rejects.toThrow(/no rates/);
  });

  it('throws when the transaction does not succeed', async () => {
    global.fetch = jest.fn()
      .mockResolvedValueOnce({ ok: true, json: async () => ({ rates: [{ object_id: 'r', amount: '3', servicelevel: {} }] }) })
      .mockResolvedValueOnce({ ok: true, json: async () => ({ status: 'ERROR', messages: [{ text: 'invalid address' }] }) });
    await expect(live().generateLabel(LABEL_ARGS)).rejects.toThrow(/invalid address/);
  });
});
