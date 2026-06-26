const CarrierAdapter = require('./CarrierAdapter');
const crypto = require('crypto');
const logger = require('../../utils/logger');

// Royal Mail Click & Drop API base. Override per-shop via carrier
// settings.baseUrl (e.g. to point at a sandbox/test host).
const PROD_BASE = 'https://api.parcel.royalmail.com';

/**
 * Royal Mail Click & Drop adapter.
 *
 * Runs in one of two modes:
 *
 *  • **Simulation** (default) — produces realistic test labels so the full
 *    return → label → email flow is testable end-to-end WITHOUT a funded
 *    Royal Mail account. This is what's used until a merchant explicitly
 *    enables live mode.
 *
 *  • **Live** — enabled when `settings.live === true` AND a Click & Drop API
 *    key is present. Calls the real Click & Drop Orders API to create the
 *    returns order. Live mode creates real (chargeable) orders, so it is
 *    opt-in. The account-specific bits (serviceCode, packageFormat) come from
 *    carrier `settings`; confirm the exact serviceCode against the merchant's
 *    Click & Drop account, and wire label-PDF retrieval once validated against
 *    a real key (GET /api/v1/orders/{orderIdentifier}/label).
 */
class RoyalMailAdapter extends CarrierAdapter {
  get carrierName() {
    return 'royalmail';
  }

  get _apiKey() {
    return this.config?.credentials?.apiKey || null;
  }

  get _settings() {
    return this.config?.settings || {};
  }

  get _isLive() {
    return this._settings.live === true && Boolean(this._apiKey);
  }

  get _baseUrl() {
    return String(this._settings.baseUrl || PROD_BASE).replace(/\/$/, '');
  }

  async generateLabel(args) {
    return this._isLive ? this._liveLabel(args) : this._simulateLabel(args);
  }

  async getTrackingStatus(trackingCode) {
    // Royal Mail tracking is a separate API; in simulation we return a
    // plausible status plus the public tracking URL the customer can use.
    return {
      status: 'in_transit',
      lastUpdate: new Date(),
      location: 'Royal Mail Distribution Centre',
      estimatedDelivery: new Date(Date.now() + 24 * 60 * 60 * 1000),
      trackingUrl: `https://www.royalmail.com/track-your-item#/tracking-results/${trackingCode}`,
    };
  }

  async getDropoffLocations({ postcode, limit = 5 }) {
    // Royal Mail has a branch-finder / Local Collect API; until that's wired,
    // return representative Post Office + Customer Service Point drop-offs.
    const kinds = [
      { name: 'Post Office', type: 'Post Office', openingHours: 'Mon-Fri 9am-5:30pm, Sat 9am-12:30pm' },
      { name: 'Royal Mail Customer Service Point', type: 'Delivery Office', openingHours: 'Mon-Fri 8am-6pm, Sat 8am-12pm' },
    ];
    return Array.from({ length: Math.min(limit, kinds.length) }, (_, i) => ({
      id: `rm-${postcode}-${i + 1}`,
      name: kinds[i].name,
      address: `${i + 1} High Street, ${postcode}`,
      lat: 51.5074,
      lng: -0.1278,
      distance: `${(0.2 + i * 0.3).toFixed(1)} miles`,
      openingHours: kinds[i].openingHours,
      type: kinds[i].type,
    }));
  }

  // ─── Simulation ───────────────────────────────────────────────────────────
  _simulateLabel() {
    // Royal Mail tracked numbers look like 2 letters + 9 digits + "GB".
    const digits = Array.from({ length: 9 }, () => crypto.randomInt(0, 10)).join('');
    return {
      trackingCode: `RF${digits}GB`,
      labelUrl: null, // LabelService still renders a scannable QR for drop-off
      qrCodeUrl: null,
      cost: 4.25,
      simulated: true,
      service: 'Tracked Returns 48 (simulated)',
    };
  }

  // ─── Live (Click & Drop Orders API) ───────────────────────────────────────
  async _liveLabel({ senderAddress, recipientAddress, weight }) {
    const orderReference = `RF-${Date.now()}-${crypto.randomBytes(3).toString('hex')}`;

    // For a RETURN the parcel travels from the customer (sender) back to the
    // merchant's warehouse (recipient).
    const body = {
      items: [{
        orderReference,
        recipient: {
          address: {
            fullName: recipientAddress.name,
            addressLine1: recipientAddress.line1,
            city: recipientAddress.city,
            postcode: recipientAddress.postcode,
            countryCode: recipientAddress.country || 'GB',
          },
        },
        sender: {
          address: {
            fullName: senderAddress.name,
            addressLine1: senderAddress.line1 || 'N/A',
            city: senderAddress.city || 'N/A',
            postcode: senderAddress.postcode || '',
            countryCode: senderAddress.country || 'GB',
          },
        },
        packages: [{
          weightInGrams: Math.max(100, Math.round((weight || 0.5) * 1000)),
          packageFormatIdentifier: this._settings.packageFormat || 'parcel',
        }],
        // serviceCode is account-specific — supply it via carrier settings.
        ...(this._settings.serviceCode
          ? { postageDetails: { serviceCode: this._settings.serviceCode } }
          : {}),
        orderDate: new Date().toISOString(),
      }],
    };

    const res = await fetch(`${this._baseUrl}/api/v1/orders`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: this._apiKey },
      body: JSON.stringify(body),
    });

    if (!res.ok) {
      const detail = await res.text().catch(() => '');
      logger.error({ status: res.status, detail: detail.slice(0, 300) }, 'Royal Mail order create failed');
      throw new Error(`Royal Mail order create failed (${res.status})`);
    }

    const data = await res.json();
    const order = (data.createdOrders || data.orders || [])[0] || {};
    const trackingCode = order.trackingNumber || order.shipmentId || order.orderIdentifier || orderReference;

    return {
      trackingCode: String(trackingCode),
      // Label PDF retrieval (GET /api/v1/orders/{orderIdentifier}/label) is the
      // next step to wire once validated against a real funded account; until
      // then LabelService renders the QR so the flow still completes.
      labelUrl: null,
      qrCodeUrl: null,
      cost: order.totalCost ?? order.shippingCost ?? null,
      orderIdentifier: order.orderIdentifier,
      service: this._settings.serviceCode || 'Click & Drop',
    };
  }
}

module.exports = RoyalMailAdapter;
