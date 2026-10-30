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
// Shippo's tracking states → ours.
const TRACKING_STATES = {
  PRE_TRANSIT: 'label_created',
  TRANSIT: 'in_transit',
  DELIVERED: 'delivered',
  RETURNED: 'returned_to_sender',
  FAILURE: 'failed',
  UNKNOWN: 'unknown',
};

// Our carrier codes → Shippo carrier tokens for the tracking endpoint. Shippo
// still calls Evri "hermes_uk". The test environment tracks the pseudo
// carrier "shippo" (tracking numbers like SHIPPO_TRANSIT).
const TRACKING_CARRIER_TOKENS = {
  evri: 'hermes_uk',
  hermesuk: 'hermes_uk',
  hermes: 'hermes_uk',
  royalmail: 'royal_mail',
  dpd: 'dpd_uk',
  dpduk: 'dpd_uk',
  ups: 'ups',
  dhl: 'dhl_express',
  dhlexpress: 'dhl_express',
  parcelforce: 'parcelforce',
  shippo: 'shippo',
};

// Transaction states in which Shippo has accepted the purchase but not yet
// produced (or refused) the label. Treated as "unknown", never as failed.
const PENDING_STATES = new Set(['QUEUED', 'WAITING']);

// A failure the carrier reported before anything was bought. Anything else
// (timeout, network error, 5xx) may still have bought postage.
function definite(message) {
  const err = new Error(message);
  err.definite = true;
  return err;
}

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

  /**
   * Where the parcel is, from Shippo's tracking API
   * (GET /tracks/{carrier}/{tracking_number}). `carrier` is our carrier code
   * (evri, royalmail…), translated to Shippo's token. Returns
   * { status, detail, location, lastUpdate, estimatedDelivery, trackingUrl }
   * with status one of label_created | in_transit | delivered |
   * returned_to_sender | failed | unknown. Simulation mode (no token) keeps
   * returning a plausible placeholder; callers check `_isLive` first.
   */
  async getTrackingStatus(trackingCode, carrier = null) {
    if (!this._isLive) {
      return {
        status: 'in_transit',
        detail: null,
        lastUpdate: new Date(),
        location: 'Carrier network',
        estimatedDelivery: new Date(Date.now() + 2 * 24 * 60 * 60 * 1000),
        trackingUrl: null,
        simulated: true,
      };
    }
    const token = ShippoAdapter.trackingCarrierToken(carrier || this._settings.carrierLabel);
    const res = await fetch(`${this._baseUrl}/tracks/${encodeURIComponent(token)}/${encodeURIComponent(trackingCode)}`, {
      headers: this._headers(),
    });
    // 4xx: Shippo cannot (yet) say anything about this number: not scanned,
    // or not trackable from this account (Evri/DPD only track labels bought
    // through Shippo). That is "unknown", not a failure to retry loudly.
    // 5xx: Shippo itself is struggling; the caller retries next time.
    if (res.status >= 400 && res.status < 500) {
      const detail = await res.json().then((b) => b?.detail || b?.message || null).catch(() => null);
      return { status: 'unknown', detail: detail || 'Not found by the carrier yet', location: null, lastUpdate: null, estimatedDelivery: null, trackingUrl: null };
    }
    if (!res.ok) throw new Error(`Shippo tracking failed (${res.status})`);
    const track = await res.json();
    const ts = track.tracking_status || null;
    const loc = ts?.location || {};
    const location = [loc.city, loc.state, loc.country].filter(Boolean).join(', ') || null;
    return {
      status: TRACKING_STATES[ts?.status] || 'unknown',
      detail: ts?.status_details || null,
      location,
      lastUpdate: ts?.status_date ? new Date(ts.status_date) : null,
      estimatedDelivery: track.eta ? new Date(track.eta) : null,
      trackingUrl: null,
    };
  }

  /** Our carrier code → the token Shippo's tracking API expects. */
  static trackingCarrierToken(carrier) {
    const key = String(carrier || '').toLowerCase().replace(/[^a-z]/g, '');
    return TRACKING_CARRIER_TOKENS[key] || String(carrier || 'shippo');
  }

  // No live Shippo location finder is wired up yet. Return nothing rather
  // than invented addresses: the portal then points customers to the
  // carrier's official finder. Plug a real locator API in here.
  // eslint-disable-next-line no-unused-vars
  async getDropoffLocations({ postcode, limit = 5 } = {}) {
    return [];
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
  /** The tag every booking carries, so a purchase can be found again. */
  static reference(returnId) { return `returnflow:${returnId}`; }

  async _liveLabel({ senderAddress, recipientAddress, weight, dimensions, reference }) {
    const dims = dimensions || { length: 30, width: 20, height: 10 };
    const metadata = reference ? ShippoAdapter.reference(reference) : undefined;
    // 1) Create the shipment and fetch rates. For a return the parcel travels
    //    from the customer (address_from) back to the warehouse (address_to).
    const shipRes = await fetch(`${this._baseUrl}/shipments/`, {
      method: 'POST',
      headers: this._headers(),
      body: JSON.stringify({
        address_from: this._address(senderAddress),
        address_to: this._address(recipientAddress),
        parcels: [{
          length: String(dims.length), width: String(dims.width), height: String(dims.height), distance_unit: 'cm',
          weight: String(Math.max(0.1, weight || 0.5)), mass_unit: 'kg',
        }],
        extra: { is_return: true },
        metadata,
        async: false,
      }),
    });
    if (!shipRes.ok) {
      const detail = await shipRes.text().catch(() => '');
      logger.error({ status: shipRes.status, detail: detail.slice(0, 300) }, 'Shippo shipment create failed');
      throw definite(`Shippo shipment create failed (${shipRes.status})`);
    }
    const shipment = await shipRes.json();
    const rates = shipment.rates || [];
    if (rates.length === 0) {
      throw definite('Shippo returned no rates for this shipment');
    }

    // Prefer a configured service level; otherwise pick the cheapest rate.
    const rate = (this._settings.servicelevelToken
      && rates.find((r) => r.servicelevel?.token === this._settings.servicelevelToken))
      || rates.slice().sort((a, b) => Number(a.amount) - Number(b.amount))[0];

    // 2) Buy the label.
    const txRes = await fetch(`${this._baseUrl}/transactions/`, {
      method: 'POST',
      headers: this._headers(),
      body: JSON.stringify({ rate: rate.object_id, label_file_type: 'PDF', metadata, async: false }),
    });
    if (!txRes.ok) {
      const detail = await txRes.text().catch(() => '');
      logger.error({ status: txRes.status, detail: detail.slice(0, 300) }, 'Shippo transaction failed');
      // 4xx: refused before purchase. 5xx: unknown; the caller reconciles.
      throw txRes.status < 500 ? definite(`Shippo transaction failed (${txRes.status})`) : new Error(`Shippo transaction failed (${txRes.status})`);
    }
    let tx = await txRes.json();
    if (PENDING_STATES.has(tx.status)) tx = await this._awaitTransaction(tx);
    if (tx.status !== 'SUCCESS') {
      if (PENDING_STATES.has(tx.status)) {
        // Shippo is still working on it. The label may yet be issued, so
        // this is not a failure: the caller keeps its lock and reconciles
        // the transaction (by its metadata tag) before buying anything.
        const err = new Error(`Shippo is still processing this label (${tx.status}); it will be picked up before another is bought`);
        err.pending = true;
        err.transactionId = tx.object_id || null;
        throw err;
      }
      const msg = (tx.messages || []).map((m) => m.text).join(', ') || tx.status;
      throw definite(`Shippo label not created: ${msg}`);
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

  /**
   * Shippo sometimes answers a purchase with QUEUED/WAITING and finishes it
   * moments later. Poll the transaction a few times before giving up on it.
   */
  async _awaitTransaction(tx) {
    const attempts = Number(this._settings.pollAttempts ?? 6);
    const delayMs = Number(this._settings.pollDelayMs ?? 2500);
    let current = tx;
    for (let i = 0; i < attempts && PENDING_STATES.has(current.status) && tx.object_id; i++) {
      if (delayMs > 0) await new Promise((r) => setTimeout(r, delayMs));
      const res = await fetch(`${this._baseUrl}/transactions/${tx.object_id}`, { headers: this._headers() });
      if (!res.ok) break; // still pending as far as we know
      current = await res.json();
    }
    return current;
  }

  /**
   * Find a label already bought for this return, by the metadata tag on the
   * transaction. Used when a purchase may have gone through but was never
   * saved (crash, database outage), so it is not bought twice. Scans the
   * newest transactions first. Returns the label when one succeeded; null
   * when nothing matches or a matching transaction is still pending
   * (outcome unknown); `{ failed: true, message }` when every transaction
   * for this return ended in ERROR, i.e. the carrier confirms nothing was
   * bought.
   */
  async findLabel({ reference, maxPages = 5 } = {}) {
    if (!this._isLive || !reference) return null;
    const tag = ShippoAdapter.reference(reference);
    let url = `${this._baseUrl}/transactions/?results=100&page=1`;
    let failures = [];
    for (let page = 0; page < maxPages && url; page++) {
      const res = await fetch(url, { headers: this._headers() });
      if (!res.ok) throw new Error(`Shippo transaction list failed (${res.status})`);
      const data = await res.json();
      const matches = (data.results || []).filter((t) => t.metadata === tag);
      if (matches.some((t) => PENDING_STATES.has(t.status))) return null;
      failures = failures.concat(matches.filter((t) => t.status === 'ERROR'));
      const match = matches.find((t) => t.status === 'SUCCESS');
      if (match) {
        // The list carries the rate as an id; the amount and carrier are optional extras.
        let rate = null;
        if (match.rate && typeof match.rate === 'object') rate = match.rate;
        else if (match.rate) {
          const rr = await fetch(`${this._baseUrl}/rates/${match.rate}`, { headers: this._headers() }).catch(() => null);
          if (rr && rr.ok) rate = await rr.json().catch(() => null);
        }
        return {
          trackingCode: match.tracking_number,
          labelUrl: match.label_url,
          qrCodeUrl: match.qr_code_url || null,
          cost: rate ? Number(rate.amount) || null : null,
          carrier: rate?.provider || null,
          service: rate?.servicelevel?.name,
          reconciled: true,
        };
      }
      url = data.next || null;
    }
    // Only once every page has been seen can "all of them failed" be said.
    if (!url && failures.length > 0) {
      const message = (failures[0].messages || []).map((m) => m.text).join(', ') || 'ERROR';
      return { failed: true, message };
    }
    return null;
  }
}

module.exports = ShippoAdapter;
