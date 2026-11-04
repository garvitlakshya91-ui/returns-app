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

  // Failures before any purchase are flagged `definite` so the caller can
  // release its lock; anything that may have bought postage is not.
  it('a failed shipment call is a definite failure (nothing bought)', async () => {
    global.fetch = jest.fn().mockResolvedValue({ ok: false, status: 401, text: async () => 'unauthorized' });
    await expect(live().generateLabel(LABEL_ARGS)).rejects.toMatchObject({ message: expect.stringMatching(/Shippo shipment create failed \(401\)/), definite: true });
  });

  it('no rates is a definite failure', async () => {
    global.fetch = jest.fn().mockResolvedValueOnce({ ok: true, json: async () => ({ rates: [] }) });
    await expect(live().generateLabel(LABEL_ARGS)).rejects.toMatchObject({ message: expect.stringMatching(/no rates/), definite: true });
  });

  it('a transaction Shopify reports as failed is definite', async () => {
    global.fetch = jest.fn()
      .mockResolvedValueOnce({ ok: true, json: async () => ({ rates: [{ object_id: 'r', amount: '3', servicelevel: {} }] }) })
      .mockResolvedValueOnce({ ok: true, json: async () => ({ status: 'ERROR', messages: [{ text: 'invalid address' }] }) });
    await expect(live().generateLabel(LABEL_ARGS)).rejects.toMatchObject({ message: expect.stringMatching(/invalid address/), definite: true });
  });

  it('a 4xx on the purchase is definite; a 5xx is not (the label may exist)', async () => {
    const rates = { ok: true, json: async () => ({ rates: [{ object_id: 'r', amount: '3', servicelevel: {} }] }) };
    global.fetch = jest.fn().mockResolvedValueOnce(rates).mockResolvedValueOnce({ ok: false, status: 402, text: async () => 'payment required' });
    await expect(live().generateLabel(LABEL_ARGS)).rejects.toMatchObject({ definite: true });

    global.fetch = jest.fn().mockResolvedValueOnce(rates).mockResolvedValueOnce({ ok: false, status: 503, text: async () => 'gateway' });
    const err = await live().generateLabel(LABEL_ARGS).catch((e) => e);
    expect(err.message).toMatch(/503/);
    expect(err.definite).toBeUndefined();
  });

  it('a QUEUED/WAITING transaction is polled until Shippo finishes it', async () => {
    const adapter = new ShippoAdapter({ credentials: { apiKey: 'shippo_live_x' }, settings: { live: true, pollAttempts: 3, pollDelayMs: 0 } });
    global.fetch = jest.fn()
      .mockResolvedValueOnce({ ok: true, json: async () => ({ rates: [{ object_id: 'r', amount: '3', provider: 'Evri', servicelevel: {} }] }) })
      .mockResolvedValueOnce({ ok: true, json: async () => ({ object_id: 'tx1', status: 'QUEUED' }) })
      .mockResolvedValueOnce({ ok: true, json: async () => ({ object_id: 'tx1', status: 'WAITING' }) })
      .mockResolvedValueOnce({ ok: true, json: async () => ({ object_id: 'tx1', status: 'SUCCESS', tracking_number: 'T9', label_url: 'https://shippo/l.pdf' }) });

    const label = await adapter.generateLabel(LABEL_ARGS);

    expect(label).toMatchObject({ trackingCode: 'T9', labelUrl: 'https://shippo/l.pdf', cost: 3 });
    expect(global.fetch.mock.calls[2][0]).toMatch(/\/transactions\/tx1$/);
    expect(global.fetch.mock.calls[3][0]).toMatch(/\/transactions\/tx1$/);
  });

  it('a transaction still pending after polling is NOT a definite failure: the caller keeps its lock', async () => {
    const adapter = new ShippoAdapter({ credentials: { apiKey: 'shippo_live_x' }, settings: { live: true, pollAttempts: 2, pollDelayMs: 0 } });
    global.fetch = jest.fn()
      .mockResolvedValueOnce({ ok: true, json: async () => ({ rates: [{ object_id: 'r', amount: '3', servicelevel: {} }] }) })
      .mockResolvedValue({ ok: true, json: async () => ({ object_id: 'tx1', status: 'QUEUED' }) });

    const err = await adapter.generateLabel(LABEL_ARGS).catch((e) => e);

    expect(err.message).toMatch(/still processing/);
    expect(err.definite).toBeUndefined();
    expect(err.pending).toBe(true);
    expect(err.transactionId).toBe('tx1');
    expect(global.fetch).toHaveBeenCalledTimes(4); // rates, buy, 2 polls
  });

  it('a network error (no response at all) is not definite', async () => {
    global.fetch = jest.fn().mockRejectedValue(new Error('ETIMEDOUT'));
    const err = await live().generateLabel(LABEL_ARGS).catch((e) => e);
    expect(err.message).toBe('ETIMEDOUT');
    expect(err.definite).toBeUndefined();
  });
});

describe('ShippoAdapter — findLabel (reconcile a purchase that was never saved)', () => {
  const live = () => new ShippoAdapter({ credentials: { apiKey: 'shippo_live_x' }, settings: { live: true } });

  it('tags shipments and transactions with the return id so they can be found again', async () => {
    global.fetch = jest.fn()
      .mockResolvedValueOnce({ ok: true, json: async () => ({ object_id: 's', rates: [{ object_id: 'r', amount: '2.75', provider: 'Evri', servicelevel: {} }] }) })
      .mockResolvedValueOnce({ ok: true, json: async () => ({ status: 'SUCCESS', tracking_number: 'T', label_url: 'u' }) });
    await live().generateLabel({ senderAddress: {}, recipientAddress: {}, weight: 1, dimensions: { length: 40, width: 30, height: 20 }, reference: 'ret_9' });
    const ship = JSON.parse(global.fetch.mock.calls[0][1].body);
    const tx = JSON.parse(global.fetch.mock.calls[1][1].body);
    expect(ship.metadata).toBe('returnflow:ret_9');
    expect(tx.metadata).toBe('returnflow:ret_9');
    expect(ship.parcels[0]).toMatchObject({ length: '40', width: '30', height: '20', weight: '1' });
  });

  it('finds a successful transaction by its tag, following pages, and resolves the rate', async () => {
    global.fetch = jest.fn()
      .mockResolvedValueOnce({ ok: true, json: async () => ({ results: [{ metadata: 'returnflow:other', status: 'SUCCESS' }], next: 'https://api.goshippo.com/transactions/?page=2' }) })
      .mockResolvedValueOnce({ ok: true, json: async () => ({ results: [
        { metadata: 'returnflow:ret_9', status: 'ERROR' },
        { metadata: 'returnflow:ret_9', status: 'SUCCESS', tracking_number: 'H01', label_url: 'https://shippo/l.pdf', qr_code_url: null, rate: 'rate_1' },
      ], next: null }) })
      .mockResolvedValueOnce({ ok: true, json: async () => ({ amount: '2.75', provider: 'Evri', servicelevel: { name: 'Standard' } }) });

    const found = await live().findLabel({ reference: 'ret_9' });

    expect(global.fetch.mock.calls[0][0]).toMatch(/\/transactions\/\?results=100&page=1$/);
    expect(global.fetch.mock.calls[2][0]).toMatch(/\/rates\/rate_1$/);
    expect(found).toEqual({ trackingCode: 'H01', labelUrl: 'https://shippo/l.pdf', qrCodeUrl: null, cost: 2.75, carrier: 'Evri', service: 'Standard', reconciled: true });
  });

  it('returns null when nothing matches within the page budget, and in simulation mode', async () => {
    global.fetch = jest.fn().mockResolvedValue({ ok: true, json: async () => ({ results: [], next: 'more' }) });
    expect(await live().findLabel({ reference: 'ret_9', maxPages: 2 })).toBeNull();
    expect(global.fetch).toHaveBeenCalledTimes(2);
    expect(await new ShippoAdapter({}).findLabel({ reference: 'ret_9' })).toBeNull();
  });

  it('a pending transaction for the return means "unknown" (null), never "failed"', async () => {
    global.fetch = jest.fn().mockResolvedValue({ ok: true, json: async () => ({ results: [
      { metadata: 'returnflow:ret_9', status: 'ERROR', messages: [{ text: 'first try' }] },
      { metadata: 'returnflow:ret_9', status: 'WAITING' },
    ], next: null }) });
    expect(await live().findLabel({ reference: 'ret_9' })).toBeNull();
  });

  it('reports { failed } when every transaction for the return ended in ERROR and all pages were seen', async () => {
    global.fetch = jest.fn()
      .mockResolvedValueOnce({ ok: true, json: async () => ({ results: [{ metadata: 'returnflow:ret_9', status: 'ERROR', messages: [{ text: 'invalid address' }] }], next: 'https://api.goshippo.com/transactions/?page=2' }) })
      .mockResolvedValueOnce({ ok: true, json: async () => ({ results: [{ metadata: 'returnflow:other', status: 'SUCCESS' }], next: null }) });
    expect(await live().findLabel({ reference: 'ret_9' })).toEqual({ failed: true, message: 'invalid address' });
  });

  it('does not call it failed while pages remain unscanned (an older success could exist)', async () => {
    global.fetch = jest.fn().mockResolvedValue({ ok: true, json: async () => ({ results: [{ metadata: 'returnflow:ret_9', status: 'ERROR' }], next: 'more' }) });
    expect(await live().findLabel({ reference: 'ret_9', maxPages: 2 })).toBeNull();
  });

  it('throws on an HTTP error so the caller treats the outcome as unknown', async () => {
    global.fetch = jest.fn().mockResolvedValue({ ok: false, status: 503 });
    await expect(live().findLabel({ reference: 'ret_9' })).rejects.toThrow(/503/);
  });
});

describe('ShippoAdapter — parcel tracking (GET /tracks/{carrier}/{number})', () => {
  const live = () => new ShippoAdapter({ credentials: { apiKey: 'shippo_live_x' }, settings: { live: true } });
  const track = (status, extra = {}) => ({
    ok: true,
    json: async () => ({
      carrier: 'hermes_uk', tracking_number: 'H01', eta: '2026-11-02T12:00:00Z',
      tracking_status: { status, status_details: 'Scanned at depot', status_date: '2026-10-30T09:15:00Z', location: { city: 'Birmingham', state: '', zip: 'B1', country: 'GB' }, ...extra },
    }),
  });

  it('asks Shippo with its own carrier token for ours (Evri is still "hermes_uk") and maps the status', async () => {
    global.fetch = jest.fn().mockResolvedValue(track('TRANSIT'));

    const s = await live().getTrackingStatus('H01', 'evri');

    expect(global.fetch.mock.calls[0][0]).toMatch(/\/tracks\/hermes_uk\/H01$/);
    expect(global.fetch.mock.calls[0][1].headers.Authorization).toBe('ShippoToken shippo_live_x');
    expect(s).toEqual({
      status: 'in_transit', detail: 'Scanned at depot', location: 'Birmingham, GB',
      lastUpdate: new Date('2026-10-30T09:15:00Z'), estimatedDelivery: new Date('2026-11-02T12:00:00Z'), trackingUrl: null,
    });
  });

  it.each([
    ['PRE_TRANSIT', 'label_created'], ['TRANSIT', 'in_transit'], ['DELIVERED', 'delivered'],
    ['RETURNED', 'returned_to_sender'], ['FAILURE', 'failed'], ['UNKNOWN', 'unknown'], ['SOMETHING_NEW', 'unknown'],
  ])('maps Shippo %s to %s', async (theirs, ours) => {
    global.fetch = jest.fn().mockResolvedValue(track(theirs));
    expect((await live().getTrackingStatus('H01', 'evri')).status).toBe(ours);
  });

  it('knows the UK carrier tokens and passes unknown codes through', () => {
    expect(ShippoAdapter.trackingCarrierToken('evri')).toBe('hermes_uk');
    expect(ShippoAdapter.trackingCarrierToken('royalmail')).toBe('royal_mail');
    expect(ShippoAdapter.trackingCarrierToken('dpd')).toBe('dpd_uk');
    expect(ShippoAdapter.trackingCarrierToken('DHL')).toBe('dhl_express');
    expect(ShippoAdapter.trackingCarrierToken('parcelforce')).toBe('parcelforce');
    expect(ShippoAdapter.trackingCarrierToken('yodel')).toBe('yodel');
    expect(ShippoAdapter.trackingCarrierToken(null)).toBe('shippo');
  });

  it('a 4xx (not scanned yet, or not trackable from this account) is "unknown" with Shippo\'s reason; a 5xx throws', async () => {
    global.fetch = jest.fn().mockResolvedValue({ ok: false, status: 404, json: async () => ({}) });
    expect((await live().getTrackingStatus('H01', 'evri')).status).toBe('unknown');
    global.fetch = jest.fn().mockResolvedValue({ ok: false, status: 400, json: async () => ({ detail: 'Tracking is only available for shipments created through Shippo' }) });
    expect(await live().getTrackingStatus('H01', 'evri')).toMatchObject({ status: 'unknown', detail: /only available/ });
    global.fetch = jest.fn().mockResolvedValue({ ok: false, status: 503 });
    await expect(live().getTrackingStatus('H01', 'evri')).rejects.toThrow(/503/);
  });

  it('a response with no tracking_status yet is "unknown"', async () => {
    global.fetch = jest.fn().mockResolvedValue({ ok: true, json: async () => ({ carrier: 'hermes_uk', tracking_number: 'H01', tracking_history: [] }) });
    expect((await live().getTrackingStatus('H01', 'evri')).status).toBe('unknown');
  });

  it('in simulation mode never calls the network and says so', async () => {
    global.fetch = jest.fn();
    const s = await new ShippoAdapter({}).getTrackingStatus('SHP1', 'evri');
    expect(global.fetch).not.toHaveBeenCalled();
    expect(s.simulated).toBe(true);
  });
});
