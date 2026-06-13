const CarrierAdapter = require('./CarrierAdapter');
const crypto = require('crypto');

/**
 * InPost locker returns adapter.
 * Stub for Sprint 9 — implements the interface with mock data.
 */
class InPostAdapter extends CarrierAdapter {
  get carrierName() {
    return 'inpost';
  }

  async generateLabel({ senderAddress, recipientAddress, weight, dimensions }) {
    const trackingCode = `IP${crypto.randomBytes(6).toString('hex').toUpperCase()}`;
    return {
      trackingCode,
      labelUrl: null,
      qrCodeUrl: null,
      cost: 2.99,
      carrier: 'inpost',
      estimatedDelivery: new Date(Date.now() + 3 * 24 * 60 * 60 * 1000),
    };
  }

  async getTrackingStatus(trackingCode) {
    return {
      status: 'awaiting_collection',
      lastUpdate: new Date(),
      location: 'InPost Locker',
      estimatedDelivery: new Date(Date.now() + 2 * 24 * 60 * 60 * 1000),
    };
  }

  async getDropoffLocations({ postcode, limit = 5 }) {
    return [
      {
        id: `ip-${postcode}-1`,
        name: 'InPost Locker — Sainsbury\'s',
        address: `Car Park, Sainsbury\'s, ${postcode}`,
        lat: 51.5070, lng: -0.1275,
        distance: '0.5 miles',
        openingHours: '24/7',
        type: 'Locker',
      },
      {
        id: `ip-${postcode}-2`,
        name: 'InPost Locker — Tesco',
        address: `Tesco Superstore, ${postcode}`,
        lat: 51.5060, lng: -0.1260,
        distance: '0.8 miles',
        openingHours: '24/7',
        type: 'Locker',
      },
    ].slice(0, limit);
  }
}

module.exports = InPostAdapter;
