const RoyalMailAdapter = require('../../app/services/carriers/RoyalMailAdapter');

const LABEL_ARGS = {
  senderAddress: { name: 'Jane Doe', country: 'GB' },
  recipientAddress: { name: 'Wildgrove & Co.', line1: '1 Returns Centre', city: 'London', postcode: 'EC1A 1BB', country: 'GB' },
  weight: 0.5,
  dimensions: { length: 30, width: 20, height: 10 },
};

describe('RoyalMailAdapter — basics', () => {
  it('reports its carrier name', () => {
    expect(new RoyalMailAdapter({}).carrierName).toBe('royalmail');
  });

  it('returns drop-off locations capped at the limit', async () => {
    const locs = await new RoyalMailAdapter({}).getDropoffLocations({ postcode: 'GL1 1DQ', limit: 1 });
    expect(locs).toHaveLength(1);
    expect(locs[0]).toMatchObject({ type: 'Post Office' });
  });

  it('returns a tracking status with a public tracking URL', async () => {
    const status = await new RoyalMailAdapter({}).getTrackingStatus('RF123456789GB');
    expect(status.status).toBe('in_transit');
    expect(status.trackingUrl).toContain('RF123456789GB');
  });
});

describe('RoyalMailAdapter — simulation mode (default)', () => {
  it('produces a simulated RM-style label without calling the network', async () => {
    const fetchSpy = jest.fn();
    global.fetch = fetchSpy;

    const adapter = new RoyalMailAdapter({}); // no creds, no settings
    const label = await adapter.generateLabel(LABEL_ARGS);

    expect(fetchSpy).not.toHaveBeenCalled();
    expect(label.simulated).toBe(true);
    expect(label.trackingCode).toMatch(/^RF\d{9}GB$/);
    expect(label.cost).toBe(4.25);
    expect(label.labelUrl).toBeNull();
  });

  it('stays in simulation when settings.live is true but no API key is set', async () => {
    const fetchSpy = jest.fn();
    global.fetch = fetchSpy;

    const adapter = new RoyalMailAdapter({ settings: { live: true } }); // missing apiKey
    const label = await adapter.generateLabel(LABEL_ARGS);

    expect(fetchSpy).not.toHaveBeenCalled();
    expect(label.simulated).toBe(true);
  });
});

describe('RoyalMailAdapter — live mode', () => {
  function liveAdapter(extraSettings = {}) {
    return new RoyalMailAdapter({
      credentials: { apiKey: 'rm_test_key_123' },
      settings: { live: true, serviceCode: 'TPN24', ...extraSettings },
    });
  }

  it('POSTs to the Click & Drop Orders API with the API key in the Authorization header', async () => {
    global.fetch = jest.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ createdOrders: [{ orderIdentifier: 42, trackingNumber: 'AB123456789GB', totalCost: 3.95 }] }),
    });

    const label = await liveAdapter().generateLabel(LABEL_ARGS);

    expect(global.fetch).toHaveBeenCalledTimes(1);
    const [url, opts] = global.fetch.mock.calls[0];
    expect(url).toBe('https://api.parcel.royalmail.com/api/v1/orders');
    expect(opts.method).toBe('POST');
    expect(opts.headers.Authorization).toBe('rm_test_key_123');

    const sent = JSON.parse(opts.body);
    expect(sent.items[0].recipient.address.postcode).toBe('EC1A 1BB');
    expect(sent.items[0].packages[0].weightInGrams).toBe(500);
    expect(sent.items[0].postageDetails.serviceCode).toBe('TPN24');

    expect(label.trackingCode).toBe('AB123456789GB');
    expect(label.cost).toBe(3.95);
  });

  it('honours a sandbox baseUrl override from settings', async () => {
    global.fetch = jest.fn().mockResolvedValue({ ok: true, json: async () => ({ createdOrders: [{ orderIdentifier: 1 }] }) });
    await liveAdapter({ baseUrl: 'https://sandbox.parcel.royalmail.com/' }).generateLabel(LABEL_ARGS);
    expect(global.fetch.mock.calls[0][0]).toBe('https://sandbox.parcel.royalmail.com/api/v1/orders');
  });

  it('throws when the Click & Drop API returns a non-2xx response', async () => {
    global.fetch = jest.fn().mockResolvedValue({ ok: false, status: 401, text: async () => 'Unauthorized' });
    await expect(liveAdapter().generateLabel(LABEL_ARGS)).rejects.toThrow(/Royal Mail order create failed \(401\)/);
  });

  it('uses the orderIdentifier as the tracking handle when no tracking number is returned', async () => {
    global.fetch = jest.fn().mockResolvedValue({ ok: true, json: async () => ({ createdOrders: [{ orderIdentifier: 7 }] }) });
    const label = await liveAdapter().generateLabel(LABEL_ARGS);
    expect(label.trackingCode).toBe('7');
    expect(label.orderIdentifier).toBe(7);
  });

  it('falls back to the orderReference when the response is empty', async () => {
    global.fetch = jest.fn().mockResolvedValue({ ok: true, json: async () => ({ createdOrders: [{}] }) });
    const label = await liveAdapter().generateLabel(LABEL_ARGS);
    expect(label.trackingCode).toMatch(/^RF-\d+-[0-9a-f]+$/);
  });
});
