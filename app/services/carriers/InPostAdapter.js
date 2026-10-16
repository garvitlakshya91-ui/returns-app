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

  // No live InPost location finder is wired up yet. Return nothing rather
  // than invented addresses: the portal then points customers to the
  // carrier's official finder. Plug a real locator API in here.
  // eslint-disable-next-line no-unused-vars
  async getDropoffLocations({ postcode, limit = 5 } = {}) {
    return [];
  }
}

module.exports = InPostAdapter;
