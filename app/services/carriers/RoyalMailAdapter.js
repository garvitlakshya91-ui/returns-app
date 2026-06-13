const CarrierAdapter = require('./CarrierAdapter');
const crypto = require('crypto');

/**
 * Royal Mail Click & Drop adapter.
 * Stub for Sprint 9 — implements the interface with mock data.
 */
class RoyalMailAdapter extends CarrierAdapter {
  get carrierName() {
    return 'royalmail';
  }

  async generateLabel({ senderAddress, recipientAddress, weight, dimensions }) {
    const trackingCode = `RM${crypto.randomBytes(6).toString('hex').toUpperCase()}`;
    return {
      trackingCode,
      labelUrl: null,
      qrCodeUrl: null,
      cost: 4.25,
      carrier: 'royalmail',
      estimatedDelivery: new Date(Date.now() + 2 * 24 * 60 * 60 * 1000),
    };
  }

  async getTrackingStatus(trackingCode) {
    return {
      status: 'in_transit',
      lastUpdate: new Date(),
      location: 'Royal Mail Distribution Centre',
      estimatedDelivery: new Date(Date.now() + 1 * 24 * 60 * 60 * 1000),
    };
  }

  async getDropoffLocations({ postcode, limit = 5 }) {
    return [
      {
        id: `rm-${postcode}-1`,
        name: 'Post Office',
        address: `1 High Street, ${postcode}`,
        lat: 51.5074, lng: -0.1278,
        distance: '0.3 miles',
        openingHours: 'Mon-Fri 9am-5:30pm, Sat 9am-12:30pm',
        type: 'Post Office',
      },
    ].slice(0, limit);
  }
}

module.exports = RoyalMailAdapter;
