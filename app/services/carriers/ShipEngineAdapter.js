const CarrierAdapter = require('./CarrierAdapter');
const crypto = require('crypto');
const logger = require('../../utils/logger');

// ShipEngine is a carrier aggregator: one API that fronts Royal Mail, Evri,
// USPS, etc. Its sandbox (TEST_ keys) issues real-but-watermarked labels for
// US carriers at no cost, which is enough to validate this whole code path
// before connecting a real (paid) UK carrier account.
const BASE = 'https://api.shipengine.com';

/**
 * ShipEngine adapter (dual-mode, like the Royal Mail one).
 *
 *  • **Simulation** (default) — realistic test label so the return → label →
 *    email flow works without any ShipEngine account.
 *  • **Live** — `settings.live === true` + a ShipEngine API key + a
 *    `settings.carrierId`/`settings.serviceCode`. Creates a real label via
 *    POST /v1/labels (flagged as a return). A TEST_ key hits the sandbox; a
 *    production key + a connected carrier hits production.
 *
 * config.credentials = { apiKey }
 * config.settings    = { live, carrierId, serviceCode, baseUrl?, carrierLabel? }
 */
class ShipEngineAdapter extends CarrierAdapter {
  get carrierName() {
    // The underlying carrier (royalmail/evri/usps) is configurable; default to
    // a generic label so stored records still read sensibly.
    return this.config?.settings?.carrierLabel || 'shipengine';
  }

  get _apiKey() { return this.config?.credentials?.apiKey || null; }
  get _settings() { return this.config?.settings || {}; }
  get _isLive() {
    return this._settings.live === true && Boolean(this._apiKey) && Boolean(this._settings.carrierId);
  }
  get _baseUrl() { return String(this._settings.baseUrl || BASE).replace(/\/$/, ''); }

  _headers() {
    return { 'Content-Type': 'application/json', 'API-Key': this._apiKey };
  }

  _mapAddress(addr = {}, { residential } = {}) {
    return {
      name: addr.name || 'Customer',
      phone: addr.phone || '000-000-0000',
      address_line1: addr.line1 || 'N/A',
      city_locality: addr.city || 'N/A',
      state_province: addr.state || addr.stateProvince || '',
      postal_code: addr.postcode || '',
      country_code: addr.country || 'GB',
      address_residential_indicator: residential ? 'yes' : 'no',
    };
  }

  async generateLabel(args) {
    return this._isLive ? this._liveLabel(args) : this._simulateLabel();
  }

  async getTrackingStatus(trackingCode) {
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
      id: `se-${postcode}-${i + 1}`,
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
      trackingCode: `SE${crypto.randomBytes(7).toString('hex').toUpperCase()}`,
      labelUrl: null,
      qrCodeUrl: null,
      cost: 4.25,
      simulated: true,
      service: 'ShipEngine (simulated)',
    };
  }

  // ─── Live (ShipEngine POST /v1/labels) ───
  async _liveLabel({ senderAddress, recipientAddress, weight }) {
    // For a RETURN the parcel goes from the customer (ship_from) back to the
    // merchant's warehouse (ship_to); is_return_label flags it as such.
    const body = {
      shipment: {
        carrier_id: this._settings.carrierId,
        service_code: this._settings.serviceCode,
        is_return_label: true,
        ship_to: this._mapAddress(recipientAddress, { residential: false }),
        ship_from: this._mapAddress(senderAddress, { residential: true }),
        packages: [{
          weight: { value: Math.max(1, Math.round((weight || 0.5) * 1000)), unit: 'gram' },
        }],
      },
    };

    const res = await fetch(`${this._baseUrl}/v1/labels`, {
      method: 'POST',
      headers: this._headers(),
      body: JSON.stringify(body),
    });

    if (!res.ok) {
      const detail = await res.text().catch(() => '');
      logger.error({ status: res.status, detail: detail.slice(0, 400) }, 'ShipEngine label create failed');
      throw new Error(`ShipEngine label create failed (${res.status})`);
    }

    const data = await res.json();
    return {
      trackingCode: data.tracking_number || data.packages?.[0]?.tracking_number || data.label_id,
      labelUrl: data.label_download?.pdf || data.label_download?.href || null,
      qrCodeUrl: null,
      cost: data.shipment_cost?.amount ?? null,
      labelId: data.label_id,
      service: this._settings.serviceCode,
    };
  }
}

module.exports = ShipEngineAdapter;
