const QRCode = require('qrcode');
const prisma = require('../config/database');
const eventBus = require('../events/eventBus');
const { LABEL_GENERATED, LABEL_FAILED } = require('../events/emitters');
const { decrypt } = require('../utils/encryption');
const StorageService = require('./StorageService');
const logger = require('../utils/logger');

class LabelService {
  /**
   * Generate a return label using the appropriate carrier adapter.
   */
  static async generateLabel(returnId) {
    const returnRecord = await prisma.return.findUnique({
      where: { id: returnId },
      include: {
        shop: { include: { carrierConfigs: true } },
        items: true,
      },
    });

    if (!returnRecord) throw new Error(`Return ${returnId} not found`);

    const shop = returnRecord.shop;
    const adapter = LabelService.getCarrierAdapter(shop);

    const settings = shop.settings || {};
    const recipientAddress = {
      name: shop.name,
      line1: settings.warehouseLine1 || '1 Returns Centre',
      city: settings.warehouseCity || 'London',
      postcode: settings.warehousePostcode || 'EC1A 1BB',
      country: 'GB',
    };

    const senderAddress = {
      name: returnRecord.customerName,
      country: 'GB',
    };

    const weight = returnRecord.items.reduce((sum, item) => sum + item.quantity * 0.5, 0);

    try {
      const labelResult = await adapter.generateLabel({
        senderAddress,
        recipientAddress,
        weight,
        dimensions: { length: 30, width: 20, height: 10 },
      });

      // Generate QR code. We render as a PNG buffer and upload to R2 so the
      // QR shows up in email clients — Gmail/Outlook strip data: URL images.
      // If R2 isn't configured, fall back to a data URL (works in the
      // merchant admin embed and in browsers, just not in most email clients).
      const qrData = JSON.stringify({
        tracking: labelResult.trackingCode,
        carrier: adapter.carrierName,
        returnId,
        shop: shop.shopifyDomain,
      });
      let qrCodeUrl;
      if (process.env.R2_ACCOUNT_ID) {
        const buffer = await QRCode.toBuffer(qrData, {
          width: 300,
          margin: 2,
          color: { dark: '#000000', light: '#ffffff' },
        });
        const { url } = await StorageService.upload(
          buffer,
          'image/png',
          `returns/${returnId}/qr`,
        );
        qrCodeUrl = url;
      } else {
        qrCodeUrl = await QRCode.toDataURL(qrData, {
          width: 300,
          margin: 2,
          color: { dark: '#000000', light: '#ffffff' },
        });
      }

      // If carrier returned a label URL, re-host on R2 for reliability
      let labelUrl = labelResult.labelUrl;
      if (labelUrl && process.env.R2_ACCOUNT_ID && !labelUrl.includes(process.env.R2_PUBLIC_URL || '')) {
        try {
          const pdfRes = await fetch(labelUrl);
          if (pdfRes.ok) {
            const buffer = Buffer.from(await pdfRes.arrayBuffer());
            const { url } = await StorageService.uploadLabel(buffer, returnId);
            labelUrl = url;
          }
        } catch (err) {
          logger.warn({ err: err.message, returnId }, 'Label R2 upload failed, using carrier URL');
        }
      }

      const label = await prisma.returnLabel.create({
        data: {
          returnId,
          carrier: adapter.carrierName,
          trackingCode: labelResult.trackingCode,
          labelUrl,
          qrCodeUrl,
          dropoffType: 'ParcelShop',
          cost: labelResult.cost,
          status: 'created',
        },
      });

      await prisma.return.update({
        where: { id: returnId },
        data: { status: 'LABEL_SENT' },
      });

      eventBus.emit(LABEL_GENERATED, { returnId, labelId: label.id });
      return label;
    } catch (err) {
      logger.error({ err, returnId }, 'Label generation failed');
      eventBus.emit(LABEL_FAILED, { returnId, error: err.message });
      throw err;
    }
  }

  /**
   * Resolve the correct carrier adapter for a shop.
   * Decrypts stored credentials before instantiating.
   */
  static getCarrierAdapter(shop, preferredCarrier = null) {
    const carrierConfigs = shop.carrierConfigs || [];

    let config;
    if (preferredCarrier) {
      config = carrierConfigs.find((c) => c.carrier === preferredCarrier && c.isActive);
    }
    if (!config) {
      config = carrierConfigs.find((c) => c.isActive);
    }

    const carrierName = config?.carrier || preferredCarrier || 'evri';

    // Decrypt credentials if stored
    let credentials = {};
    if (config?.credentials?.encrypted) {
      try {
        credentials = JSON.parse(decrypt(config.credentials.encrypted));
      } catch (err) {
        logger.warn({ carrier: carrierName }, 'Failed to decrypt carrier credentials');
      }
    }

    const adapterConfig = { credentials, settings: config?.settings || {} };

    switch (carrierName) {
      case 'shipengine': {
        // Managed labels: fall back to ReturnFlow's platform ShipEngine account
        // (env) when the merchant hasn't supplied their own key, so they get
        // labels with zero carrier setup. Goes live automatically once the
        // platform env vars are set; simulates until then.
        const ShipEngineAdapter = require('./carriers/ShipEngineAdapter');
        const seSettings = config?.settings || {};
        const apiKey = credentials.apiKey || process.env.SHIPENGINE_API_KEY || null;
        const seCarrierId = seSettings.carrierId || process.env.SHIPENGINE_CARRIER_ID || null;
        const seServiceCode = seSettings.serviceCode || process.env.SHIPENGINE_SERVICE_CODE || null;
        return new ShipEngineAdapter({
          credentials: { apiKey },
          settings: {
            ...seSettings,
            carrierId: seCarrierId,
            serviceCode: seServiceCode,
            live: Boolean(apiKey && seCarrierId),
            carrierLabel: seSettings.carrierLabel || 'royalmail',
          },
        });
      }
      case 'royalmail': {
        const RoyalMailAdapter = require('./carriers/RoyalMailAdapter');
        return new RoyalMailAdapter(adapterConfig);
      }
      case 'inpost': {
        const InPostAdapter = require('./carriers/InPostAdapter');
        return new InPostAdapter(adapterConfig);
      }
      case 'evri':
      default: {
        const EvriAdapter = require('./EvriAdapter');
        return new EvriAdapter(adapterConfig);
      }
    }
  }
}

module.exports = LabelService;
