/**
 * Abstract carrier adapter interface.
 * Each carrier (Evri, Royal Mail, InPost) implements this interface.
 * Adding a new carrier = new adapter file, zero core changes.
 */
class CarrierAdapter {
  constructor(config) {
    this.config = config; // CarrierConfig credentials + settings
  }

  /**
   * Generate a return shipping label.
   * @returns {{ trackingCode: string, labelUrl: string, qrCodeUrl: string, cost: number }}
   */
  async generateLabel({ senderAddress, recipientAddress, weight, dimensions }) {
    throw new Error('Not implemented');
  }

  /**
   * Get current tracking status.
   * @returns {{ status: string, lastUpdate: Date, location: string, estimatedDelivery: Date }}
   */
  async getTrackingStatus(trackingCode) {
    throw new Error('Not implemented');
  }

  /**
   * Find nearest drop-off locations.
   * @returns {Array<{ id, name, address, lat, lng, distance, openingHours, type }>}
   */
  async getDropoffLocations({ postcode, limit = 5 }) {
    throw new Error('Not implemented');
  }

  /** @returns {string} Carrier name identifier */
  get carrierName() {
    throw new Error('Not implemented');
  }
}

module.exports = CarrierAdapter;
