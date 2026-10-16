const prisma = require('../config/database');
const eventBus = require('../events/eventBus');
const { LABEL_GENERATED, LABEL_FAILED } = require('../events/emitters');
const { decrypt } = require('../utils/encryption');
const StorageService = require('./StorageService');
const ShopToken = require('./ShopToken');
const logger = require('../utils/logger');

// Same guard RefundService uses: only real Shopify order gids can be looked
// up on the API. Demo/legacy returns skip the order fetch.
const REAL_ORDER_GID = /^gid:\/\/shopify\/Order\/\d+$/;

// Shown to the merchant when a managed label can't be charged back to them.
const MANAGED_LABEL_BLOCKED_MESSAGE = 'No label was bought: managed labels need billing set up on your plan. '
  + 'Connect your own carrier account in Settings, or upgrade your plan.';
const LABEL_NO_RETURNS_ADDRESS_MESSAGE = 'No label was bought: add your returns address in Settings '
  + '(Warehouse address), or set your store address in Shopify.';
const LABEL_NO_CUSTOMER_ADDRESS_MESSAGE = 'No label was bought: this order has no shipping address to collect the return from.';

// Aggregators (Shippo) report the carrier they actually booked, e.g. "Evri" or
// "Royal Mail". Store it the way the rest of the app names carriers.
function normaliseCarrier(provider) {
  if (!provider) return null;
  return String(provider).toLowerCase().replace(/[^a-z0-9]/g, '') || null;
}

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
        label: true,
      },
    });

    if (!returnRecord) throw new Error(`Return ${returnId} not found`);

    // One label per return. A finished label is simply returned; a label
    // another attempt is still buying is left alone. The ReturnLabel row is
    // the lock: it is written BEFORE postage is bought, and its unique
    // returnId means a second concurrent call cannot get past this point.
    if (returnRecord.label && returnRecord.label.status !== 'pending') return returnRecord.label;
    if (returnRecord.label) throw new Error('A label for this return is already being generated');

    const shop = returnRecord.shop;
    const adapter = LabelService.getCarrierAdapter(shop);

    // Managed-platform = an aggregator carrier the merchant did NOT bring their
    // own credentials for (so postage went through ReturnFlow's account). Those
    // get billed back to the merchant per-label; bring-your-own carriers don't.
    const activeConfig = (shop.carrierConfigs || []).find((c) => c.isActive);
    const isManagedPlatform = ['shippo', 'shipengine'].includes(activeConfig?.carrier)
      && !activeConfig?.credentials?.encrypted;

    // A live managed label is paid for from ReturnFlow's account, so it is only
    // bought once we know the merchant can be charged for it. Simulated labels
    // cost nothing and skip the check.
    let managedBilling = null;
    if (isManagedPlatform && adapter._isLive === true) {
      const BillingService = require('./BillingService');
      managedBilling = await BillingService.managedLabelBilling(shop);
      if (!managedBilling.allowed) {
        const err = new Error(MANAGED_LABEL_BLOCKED_MESSAGE);
        err.code = 'MANAGED_LABEL_BILLING';
        err.reason = managedBilling.reason;
        logger.warn({ returnId, reason: managedBilling.reason }, 'Managed label not bought: merchant cannot be charged');
        eventBus.emit(LABEL_FAILED, { returnId, error: err.message, code: err.code });
        throw err;
      }
    }

    const { senderAddress, recipientAddress, missing } = await LabelService.resolveAddresses(shop, returnRecord);

    // A live label is a real parcel booking: never buy one addressed to the
    // placeholder warehouse or from a customer with no address on the order.
    if (adapter._isLive === true && (missing.recipient || missing.sender)) {
      const err = new Error(missing.recipient ? LABEL_NO_RETURNS_ADDRESS_MESSAGE : LABEL_NO_CUSTOMER_ADDRESS_MESSAGE);
      err.code = 'LABEL_ADDRESS_MISSING';
      logger.warn({ returnId, missing }, 'Live label not bought: an address is missing');
      eventBus.emit(LABEL_FAILED, { returnId, error: err.message, code: err.code });
      throw err;
    }

    const weight = returnRecord.items.reduce((sum, item) => sum + item.quantity * 0.5, 0);

    // Take the lock. If another call got here first the unique constraint
    // fires and nothing is bought twice.
    let pendingLabel;
    try {
      pendingLabel = await prisma.returnLabel.create({
        data: { returnId, carrier: adapter.carrierName, status: 'pending' },
      });
    } catch (err) {
      if (err.code === 'P2002') throw new Error('A label for this return is already being generated');
      eventBus.emit(LABEL_FAILED, { returnId, error: err.message });
      throw err;
    }

    try {
      const labelResult = await adapter.generateLabel({
        senderAddress,
        recipientAddress,
        weight,
        dimensions: { length: 30, width: 20, height: 10 },
      });
      // The carrier actually booked (an aggregator picks one per label), so
      // emails and the dashboard send the customer to the right drop-off.
      const carrier = normaliseCarrier(labelResult.carrier) || adapter.carrierName;

      // Only a QR code the carrier issued is any use at a drop-off point.
      // When the carrier gives none, the customer prints the label instead;
      // a home-made QR would only be scanned and refused.
      const qrCodeUrl = labelResult.qrCodeUrl || null;

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

      const label = await prisma.returnLabel.update({
        where: { id: pendingLabel.id },
        data: {
          carrier,
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

      // Bill the merchant for a real managed label (postage + service fee) via
      // a Shopify usage charge. Skipped for simulated labels. Isolated in its
      // own try/catch: the label already exists and the return is LABEL_SENT,
      // so a billing hiccup must never turn a successful label into
      // LABEL_FAILED (which would also suppress the customer's label email).
      if (isManagedPlatform && !labelResult.simulated && Number(labelResult.cost) > 0
        && !managedBilling?.devStore) {
        const BillingService = require('./BillingService');
        const charge = Math.round((Number(labelResult.cost) + BillingService.LABEL_FEE_GBP) * 100) / 100;
        let usageRecordId = null;
        let chargeError = null;
        try {
          usageRecordId = await BillingService.recordLabelCharge(shop, {
            amount: charge,
            description: `Return label ${carrier} ${returnRecord.shopifyOrderName}`,
          });
        } catch (billingErr) {
          chargeError = billingErr.message;
          logger.warn({ err: billingErr.message, returnId }, 'Managed-label billing failed after label creation (non-fatal)');
        }
        // Ledger entry on the return's timeline: every managed label's
        // postage is either charged (with Shopify's usage record id) or
        // recorded as unrecovered, so nothing is silently absorbed.
        await LabelService._recordCharge(returnId, {
          charged: Boolean(usageRecordId),
          amount: charge,
          postage: Number(labelResult.cost),
          usageRecordId,
          error: chargeError || (usageRecordId ? null : 'No usage line item or Shopify refused the charge'),
        });
      }

      eventBus.emit(LABEL_GENERATED, { returnId, labelId: label.id });
      return label;
    } catch (err) {
      // Release the lock so the merchant can retry after fixing the cause.
      await prisma.returnLabel.delete({ where: { id: pendingLabel.id } })
        .catch((delErr) => logger.error({ returnId, err: delErr.message }, 'Could not release label lock'));
      logger.error({ err, returnId }, 'Label generation failed');
      eventBus.emit(LABEL_FAILED, { returnId, error: err.message });
      throw err;
    }
  }

  static async _recordCharge(returnId, data) {
    try {
      await prisma.returnEvent.create({
        data: { returnId, type: data.charged ? 'label.charged' : 'label.charge_failed', actor: 'system', data },
      });
    } catch (err) {
      logger.error({ returnId, err: err.message }, 'Could not record managed-label charge');
    }
  }

  /**
   * Real addresses for the label. The parcel travels customer → warehouse:
   *  - sender: the order's actual shipping address, fetched live from Shopify
   *  - recipient: the merchant's warehouse address from Settings, else the
   *    store's own address on Shopify
   * Falls back to minimal placeholders only when Shopify has nothing to give
   * (demo returns, missing token), so label generation never fails on lookup.
   */
  static async resolveAddresses(shop, returnRecord) {
    const settings = shop.settings || {};
    let orderShipping = null;
    let storeAddress = null;

    const hasRealOrder = REAL_ORDER_GID.test(returnRecord.shopifyOrderId || '');
    if (shop.shopifyToken) {
      try {
        const client = await ShopToken.graphqlClient(shop);
        const resp = await client.request(`
          query LabelAddresses($orderId: ID!, $withOrder: Boolean!) {
            shop {
              billingAddress { address1 address2 city zip provinceCode countryCodeV2 phone }
            }
            order: node(id: $orderId) @include(if: $withOrder) {
              ... on Order {
                shippingAddress { name address1 address2 city zip provinceCode countryCodeV2 phone }
              }
            }
          }
        `, {
          variables: {
            orderId: hasRealOrder ? returnRecord.shopifyOrderId : 'gid://shopify/Order/0',
            withOrder: hasRealOrder,
          },
        });
        orderShipping = resp.data?.order?.shippingAddress || null;
        storeAddress = resp.data?.shop?.billingAddress || null;
      } catch (err) {
        logger.warn({ err: err.message, returnId: returnRecord.id }, 'Address lookup failed — using stored fallbacks');
      }
    }

    const senderAddress = orderShipping?.address1
      ? {
        name: orderShipping.name || returnRecord.customerName,
        line1: orderShipping.address1,
        line2: orderShipping.address2 || '',
        city: orderShipping.city || '',
        postcode: orderShipping.zip || '',
        state: orderShipping.provinceCode || '',
        country: orderShipping.countryCodeV2 || 'GB',
        phone: orderShipping.phone || '',
        email: returnRecord.customerEmail || '',
      }
      : { name: returnRecord.customerName, country: 'GB' };

    // Warehouse settings (merchant-entered) win; otherwise the store's real
    // address; the generic placeholder survives only when neither exists.
    const recipientAddress = settings.warehouseLine1
      ? {
        name: shop.name,
        line1: settings.warehouseLine1,
        city: settings.warehouseCity || '',
        postcode: settings.warehousePostcode || '',
        country: 'GB',
      }
      : storeAddress?.address1
        ? {
          name: shop.name,
          line1: storeAddress.address1,
          line2: storeAddress.address2 || '',
          city: storeAddress.city || '',
          postcode: storeAddress.zip || '',
          state: storeAddress.provinceCode || '',
          country: storeAddress.countryCodeV2 || 'GB',
          phone: storeAddress.phone || '',
        }
        : {
          name: shop.name,
          line1: '1 Returns Centre',
          city: 'London',
          postcode: 'EC1A 1BB',
          country: 'GB',
        };

    // Which side fell back to a placeholder: a live label must not be bought then.
    const missing = {
      sender: !orderShipping?.address1,
      recipient: !settings.warehouseLine1 && !storeAddress?.address1,
    };

    return { senderAddress, recipientAddress, missing };
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
      case 'shippo': {
        // Managed labels via Shippo: fall back to ReturnFlow's platform Shippo
        // account (env) when the merchant hasn't supplied their own token, so
        // they get labels with zero carrier setup. Shippo needs only the token
        // (rates are fetched per-shipment), so it's live whenever a key exists.
        const ShippoAdapter = require('./carriers/ShippoAdapter');
        const sp = config?.settings || {};
        const apiKey = credentials.apiKey || process.env.SHIPPO_API_KEY || null;
        return new ShippoAdapter({
          credentials: { apiKey },
          settings: {
            ...sp,
            servicelevelToken: sp.servicelevelToken || process.env.SHIPPO_SERVICELEVEL_TOKEN || null,
            live: Boolean(apiKey),
            carrierLabel: sp.carrierLabel || 'royalmail',
          },
        });
      }
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
