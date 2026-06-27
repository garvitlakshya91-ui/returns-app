const CarrierAdapter = require('./CarrierAdapter');
const crypto = require('crypto');
const logger = require('../../utils/logger');

// Shippo: one API that fronts Royal Mail, Evri, DPD, etc. Cheapest aggregator
// for a UK launch — pay-as-you-go (~5¢/label, no monthly floor) and a free
// test environment (tokens start with `shippo_test_`).
const BASE = 'https://api.goshippo.com';

/**
 * Shippo adapter (dual-mode, same shape as the Royal Mail / ShipEngine ones).
 *
 *  • **Simulation** (default) — realistic test label so the whole flow works
 *    without any Shippo account.
 *  • **Live** — `settings.live === true` + a Shippo API token. Buys a real
 *    return label: create a shipment (customer → warehouse), pick the cheapest
 *    rate (or a configured service level), then buy the label.
 *
 * config.credentials = { apiKey }                 // Shippo API token
 * config.settings    = { live, servicelevelToken, carrierLabel, baseUrl }
 */
class ShippoAdapter extends CarrierAdapter {
  get carrierName() {
    return this.config?.settings?.carrierLabel || 'shippo';
  }

  get _token() { return this.config?.credentials?.apiKey || null; }
  get _settings() { return this.config?.settings || {}; }
  get _isLive() { return this._settings.live === true && Boolean(this._token); }
  get _baseUrl() { return String(this._settings.baseUrl || BASE).replace(/\/$/, ''); }

  _headers() {
    return { 'Content-Type': 'application/json', Authorization: `ShippoToken ${this._token}` };
  }

  _address(a = {}) {
    return {
      name: a.name || 'Customer',
      street1: a.line1 || 'N/A',
      city: a.city || 'N/A',
      state: a.state || a.stateProvince || '',
      zip: a.postcode || '',
      country: a.country || 'GB',
      phone: a.phone || '',
      email: a.email || '',
    };
  }

  async generateLabel(args) {
    return this._isLive ? this._liveLabel(args) : this._simulateLabel();
  }

  async getTrackingStatus() {
    return {
      status: 'in_transit',
      lastUpdate: new Date(),
      location: 'Carrier network',
      estimatedDelivery: new Date(Date.now() + 2 * 24 * 60 * 60 * 1000),
      trackingUrl: null,
    };
  }

  async getDropoffLocations({ postcode, limit = 5 }) {
    return Array.from({ length: Math.min(limit, 1) }, (_, i) => ({
      id: `shp-${postcode}-${i + 1}`,
      name: 'Drop-off point',
      address: `${i + 1} High Street, ${postcode}`,
      lat: 51.5074, lng: -0.1278,
      distance: '0.3 miles',
      openingHours: 'Varies by location',
      type: 'Drop-off',
    }));
  }

  // ─── Simulation ───
  _simulateLabel() {
    return {
      trackingCode: `SHP${crypto.randomBytes(7).toString('hex').toUpperCase()}`,
      labelUrl: null,
      qrCodeUrl: null,
      cost: 4.25,
      simulated: true,
      service: 'Shippo (simulated)',
    };
  }

  // ─── Live (Shippo: shipment → rate → transaction) ───
  async _liveLabel({ senderAddress, recipientAddress, weight }) {
    // 1) Create the shipment and fetch rates. For a return the parcel travels
    //    from the customer (address_from) back to the warehouse (address_to).
    const shipRes = await fetch(`${this._baseUrl}/shipments/`, {
      method: 'POST',
      headers: this._headers(),
      body: JSON.stringify({
        address_from: this._address(senderAddress),
        address_to: this._address(recipientAddress),
        parcels: [{
          length: '30', width: '20', height: '10', distance_unit: 'cm',
          weight: String(Math.max(0.1, weight || 0.5)), mass_unit: 'kg',
        }],
        extra: { is_return: true },
        async: false,
      }),
    });
    if (!shipRes.ok) {
      const detail = await shipRes.text().catch(() => '');
      logger.error({ status: shipRes.status, detail: detail.slice(0, 300) }, 'Shippo shipment create failed');
      throw new Error(`Shippo shipment create failed (${shipRes.status})`);
    }
    const shipment = await shipRes.json();
    const rates = shipment.rates || [];
    if (rates.length === 0) {
      throw new Error('Shippo returned no rates for this shipment');
    }

    // Prefer a configured service level; otherwise pick the cheapest rate.
    const rate = (this._settings.servicelevelToken
      && rates.find((r) => r.servicelevel?.token === this._settings.servicelevelToken))
      || rates.slice().sort((a, b) => Number(a.amount) - Number(b.amount))[0];

    // 2) Buy the label.
    const txRes = await fetch(`${this._baseUrl}/transactions/`, {
      method: 'POST',
      headers: this._headers(),
      body: JSON.stringify({ rate: rate.object_id, label_file_type: 'PDF', async: false }),
    });
    if (!txRes.ok) {
      const detail = await txRes.text().catch(() => '');
      logger.error({ status: txRes.status, detail: detail.slice(0, 300) }, 'Shippo transaction failed');
      throw new Error(`Shippo transaction failed (${txRes.status})`);
    }
    const tx = await txRes.json();
    if (tx.status !== 'SUCCESS') {
      const msg = (tx.messages || []).map((m) => m.text).join(', ') || tx.status;
      throw new Error(`Shippo label not created: ${msg}`);
    }

    return {
      trackingCode: tx.tracking_number,
      labelUrl: tx.label_url,
      qrCodeUrl: tx.qr_code_url || null,
      cost: Number(rate.amount) || null,
      carrier: rate.provider,
      service: rate.servicelevel?.name,
    };
  }
}

module.exports = ShippoAdapter;
