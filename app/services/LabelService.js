const prisma = require('../config/database');
const eventBus = require('../events/eventBus');
const { LABEL_GENERATED, LABEL_FAILED } = require('../events/emitters');
const { decrypt } = require('../utils/encryption');
const StorageService = require('./StorageService');
const ShopToken = require('./ShopToken');
const logger = require('../utils/logger');
const { claim, release } = require('../utils/idempotency');

// Same guard RefundService uses: only real Shopify order gids can be looked
// up on the API. Demo/legacy returns skip the order fetch.
const REAL_ORDER_GID = /^gid:\/\/shopify\/Order\/\d+$/;

// Shown to the merchant when a managed label can't be charged back to them.
const MANAGED_LABEL_BLOCKED_MESSAGE = 'No label was bought: managed labels need billing set up on your plan. '
  + 'Connect your own carrier account in Settings, or upgrade your plan.';
const LABEL_NO_RETURNS_ADDRESS_MESSAGE = 'No label was bought: add your returns address in Settings '
  + '(Warehouse address), or set your store address in Shopify.';
const LABEL_NO_CUSTOMER_ADDRESS_MESSAGE = 'No label was bought: this order has no shipping address to collect the return from.';
// Shopify variant weights come in several units; labels are booked in kg.
const KG_PER_UNIT = { KILOGRAMS: 1, GRAMS: 0.001, POUNDS: 0.45359237, OUNCES: 0.028349523 };
function toKg(weight) {
  if (!weight || !Number.isFinite(Number(weight.value)) || Number(weight.value) <= 0) return null;
  const factor = KG_PER_UNIT[weight.unit];
  return factor ? Number(weight.value) * factor : null;
}
function positive(v) {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? n : null;
}

// A lock row older than this is from a crashed attempt, not a live one.
// How long one attempt holds the right to send a label's email.
const EMAIL_CLAIM_SECONDS = 5 * 60;

// Timeline events that record how far a label's follow-up steps got.
const LABEL_LEDGER_TYPES = ['label.charge_due', 'label.charged', 'label.charge_failed', 'label.emailed'];

const LOCK_STALE_MS = 10 * 60 * 1000;
// Pause between retries of the database writes that follow a purchase.
const RETRY_DELAY_MS = 500;
const LABEL_UNCERTAIN_MESSAGE = 'A label for this return may already have been bought but could not be saved. '
  + 'Check the carrier account for this return before generating another label.';
// Shown to the merchant when they try to approve a return with nowhere to send it.
const RETURNS_ADDRESS_REQUIRED_MESSAGE = 'Set your returns address before approving returns: Settings → Warehouse address.';

// Aggregators (Shippo) report the carrier they actually booked, e.g. "Evri" or
// "Royal Mail". Store it the way the rest of the app names carriers.
// Aggregators use their own names for some carriers.
const CARRIER_ALIASES = { hermesuk: 'evri', hermes: 'evri', royalmailuk: 'royalmail' };

function normaliseCarrier(provider) {
  if (!provider) return null;
  const code = String(provider).toLowerCase().replace(/[^a-z0-9]/g, '');
  return CARRIER_ALIASES[code] || code || null;
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

    const shop = returnRecord.shop;
    const adapter = LabelService.getCarrierAdapter(shop);

    // Managed-platform = an aggregator carrier the merchant did NOT bring their
    // own credentials for (so postage went through ReturnFlow's account). Those
    // get billed back to the merchant per-label; bring-your-own carriers don't.
    const activeConfig = (shop.carrierConfigs || []).find((c) => c.isActive);
    const isManagedPlatform = ['shippo', 'shipengine'].includes(activeConfig?.carrier)
      && !activeConfig?.credentials?.encrypted;
    const billing = { isManagedPlatform, managedBilling: null };

    // One label per return. The ReturnLabel row is the lock and records how
    // far a purchase got: 'pending' = lock taken, carrier not yet called;
    // 'buying' = carrier called, result not yet saved; 'created' = done.
    // A finished label is returned as-is. A fresh pending/buying row belongs
    // to another attempt. A stale one is from a crash: pending can simply be
    // taken over; buying may have bought postage, so the carrier is asked
    // first and a found label is saved instead of buying again.
    if (returnRecord.label) {
      const existing = returnRecord.label;
      if (existing.status === 'created') {
        // The label exists; make sure the return moved on too (a retry after
        // the status write failed must finish the job, not just hand the
        // label back).
        await LabelService._advanceToLabelSent(returnId);
        return existing;
      }
      if (existing.status === 'saved') {
        // Bought and saved, but the follow-up steps (status, charge, email)
        // did not all finish: pick them up where they stopped.
        return LabelService._completeLabel(existing, { returnId, shop, returnRecord, billing });
      }
      const ageMs = Date.now() - new Date(existing.createdAt).getTime();
      if (ageMs < LOCK_STALE_MS) throw new Error('A label for this return is already being generated');
      if (existing.status === 'buying') {
        const found = await LabelService._reconcilePurchase(adapter, returnId);
        if (found && !found.failed) return LabelService._finishLabel(existing.id, returnId, found, adapter, shop, returnRecord, billing);
        if (!found) {
          const err = new Error(LABEL_UNCERTAIN_MESSAGE);
          err.code = 'LABEL_UNCERTAIN';
          logger.error({ returnId, labelId: existing.id }, 'Label purchase outcome unknown and carrier could not confirm; not buying again');
          eventBus.emit(LABEL_FAILED, { returnId, error: err.message, code: err.code });
          throw err;
        }
        // The carrier confirms that purchase failed: nothing was bought, so
        // the lock can go and a new label be bought below.
        logger.warn({ returnId, labelId: existing.id, reason: found.message }, 'Carrier confirms the earlier purchase failed; buying again');
      }
      await prisma.returnLabel.delete({ where: { id: existing.id } });
    }

    // A live managed label is paid for from ReturnFlow's account, so it is only
    // bought once we know the merchant can be charged for it. Simulated labels
    // cost nothing and skip the check.
    if (isManagedPlatform && adapter._isLive === true) {
      const BillingService = require('./BillingService');
      billing.managedBilling = await BillingService.managedLabelBilling(shop);
      if (!billing.managedBilling.allowed) {
        const err = new Error(MANAGED_LABEL_BLOCKED_MESSAGE);
        err.code = 'MANAGED_LABEL_BILLING';
        err.reason = billing.managedBilling.reason;
        logger.warn({ returnId, reason: billing.managedBilling.reason }, 'Managed label not bought: merchant cannot be charged');
        eventBus.emit(LABEL_FAILED, { returnId, error: err.message, code: err.code });
        throw err;
      }
    }

    const { senderAddress, recipientAddress, missing, lineItemWeightsKg } = await LabelService.resolveAddresses(shop, returnRecord);

    // A live label is a real parcel booking: never buy one addressed to the
    // placeholder warehouse or from a customer with no address on the order.
    if (adapter._isLive === true && (missing.recipient || missing.sender)) {
      const err = new Error(missing.recipient ? LABEL_NO_RETURNS_ADDRESS_MESSAGE : LABEL_NO_CUSTOMER_ADDRESS_MESSAGE);
      err.code = 'LABEL_ADDRESS_MISSING';
      logger.warn({ returnId, missing }, 'Live label not bought: an address is missing');
      eventBus.emit(LABEL_FAILED, { returnId, error: err.message, code: err.code });
      throw err;
    }

    const { weight, dimensions } = LabelService.parcelFor(shop, returnRecord, lineItemWeightsKg);

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

    // From here a purchase may happen. Say so on the lock row first, so a
    // crash between the carrier call and the save leaves a 'buying' row
    // (reconciled above), never a lost purchase that gets bought again.
    let bought = false;
    try {
      await prisma.returnLabel.update({ where: { id: pendingLabel.id }, data: { status: 'buying' } });
      let labelResult;
      try {
        labelResult = await adapter.generateLabel({
          senderAddress,
          recipientAddress,
          weight,
          dimensions,
          reference: returnId,
        });
      } catch (carrierErr) {
        // A timeout may still have bought the label: ask before giving up.
        const found = await LabelService._reconcilePurchase(adapter, returnId);
        if (found && !found.failed) {
          logger.warn({ returnId, err: carrierErr.message }, 'Carrier call failed but the label exists; using it');
          labelResult = found;
        } else if (found?.failed || carrierErr.definite === true) {
          // The carrier said no before anything was bought: safe to retry later.
          throw carrierErr;
        } else {
          // Unknown outcome (timeout, network error, carrier 5xx) and the
          // carrier cannot confirm: treat it as possibly bought. The row
          // stays 'buying' and is reconciled before any later purchase.
          bought = true;
          const err = new Error(LABEL_UNCERTAIN_MESSAGE);
          err.code = 'LABEL_UNCERTAIN';
          err.cause = carrierErr;
          throw err;
        }
      }
      bought = true;
      return await LabelService._finishLabel(pendingLabel.id, returnId, labelResult, adapter, shop, returnRecord, billing);
    } catch (err) {
      if (bought) {
        // Postage is bought; the row stays 'buying' so a retry reconciles
        // instead of buying again. Never delete it.
        logger.error({ err: err.message, returnId, labelId: pendingLabel.id }, 'Label bought but not saved; row kept as buying for reconciliation');
      } else {
        // Nothing was bought: release the lock so the merchant can retry.
        await prisma.returnLabel.delete({ where: { id: pendingLabel.id } })
          .catch((delErr) => logger.error({ returnId, err: delErr.message }, 'Could not release label lock'));
      }
      logger.error({ err, returnId }, 'Label generation failed');
      eventBus.emit(LABEL_FAILED, { returnId, error: err.message });
      throw err;
    }
  }

  /** Ask the carrier whether a label for this return already exists. */
  static async _reconcilePurchase(adapter, returnId) {
    if (typeof adapter.findLabel !== 'function') return null;
    try {
      return await adapter.findLabel({ reference: returnId });
    } catch (err) {
      logger.warn({ returnId, err: err.message }, 'Could not ask the carrier about an existing label');
      return null;
    }
  }

  /**
   * Save a bought label, move the return on, bill a managed label, and emit.
   * The saves are retried a few times: a database blip right after a
   * purchase must not lose the booking.
   */
  static async _finishLabel(labelRowId, returnId, labelResult, adapter, shop, returnRecord, { isManagedPlatform, managedBilling }) {
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

    const label = await LabelService._withRetries(
      () => prisma.returnLabel.update({
        where: { id: labelRowId },
        data: {
          carrier,
          trackingCode: labelResult.trackingCode,
          labelUrl,
          qrCodeUrl,
          dropoffType: 'ParcelShop',
          cost: labelResult.cost,
          // 'saved': the purchase is safe. 'created' only once every
          // follow-up step below has run, so a crash in between resumes.
          status: 'saved',
        },
      }),
      { returnId, step: 'save label' },
    );

    return LabelService._completeLabel(label, { returnId, shop, returnRecord, billing: { isManagedPlatform, managedBilling }, labelResult });
  }

  /**
   * Everything that follows a saved label: move the return on, charge the
   * merchant for a managed label, email the customer, then mark the label
   * 'created'. Each step leaves a durable trace (the return status, ledger
   * events, label.emailed), so running this again after a crash or a failed
   * write does only what is still missing and never charges or emails twice.
   */
  static async _completeLabel(label, { returnId, shop, returnRecord, billing, labelResult = null }) {
    await LabelService._withRetries(
      () => LabelService._advanceToLabelSent(returnId),
      { returnId, step: 'mark LABEL_SENT' },
    );

    const ledger = await prisma.returnEvent.findMany({
      where: { returnId, type: { in: LABEL_LEDGER_TYPES } },
      orderBy: { createdAt: 'asc' },
    });
    const has = (type) => ledger.some((e) => e.type === type);

    // Charge: the ledger gets a 'label.charge_due' entry BEFORE Shopify is
    // asked, so a charge that never reached an outcome is still visible to
    // the retry worker. 'charged' or 'charge_failed' means this step is done
    // (a failed charge belongs to the retry worker from then on).
    if (!has('label.charged') && !has('label.charge_failed')) {
      const dueEvent = ledger.filter((e) => e.type === 'label.charge_due').pop();
      const due = dueEvent ? dueEvent.data : await LabelService._chargeDue(label, { shop, billing, labelResult });
      if (due && Number(due.amount) > 0) {
        if (!dueEvent) {
          await prisma.returnEvent.create({
            data: { returnId, type: 'label.charge_due', actor: 'system', data: { amount: due.amount, postage: due.postage } },
          });
        }
        await LabelService._chargeLabel(returnId, shop, label.carrier, returnRecord, due);
      }
    }

    // Email the customer their label, once. Two recoveries running at the
    // same time (merchant click + scheduled job) both see no 'label.emailed'
    // yet, so the send is behind an atomic claim and the ledger is re-read
    // after winning it; the loser leaves the label 'saved' for the winner.
    let emailed = has('label.emailed');
    if (!emailed) {
      const emailClaim = `label-email:${returnId}`;
      if (!(await claim(emailClaim, EMAIL_CLAIM_SECONDS))) {
        logger.info({ returnId }, 'Another attempt is emailing this label; leaving it to that one');
        return label;
      }
      try {
        const already = await prisma.returnEvent.findFirst({ where: { returnId, type: 'label.emailed' } });
        if (already) {
          emailed = true;
        } else {
          const NotificationService = require('./NotificationService');
          let sent = null;
          try {
            sent = await NotificationService.sendLabelReady(returnRecord, label);
          } catch (err) {
            logger.warn({ returnId, err: err.message }, 'Label email failed');
          }
          if (sent) {
            await prisma.returnEvent.create({
              data: { returnId, type: 'label.emailed', actor: 'system', data: { to: returnRecord.customerEmail } },
            }).catch((err) => logger.warn({ returnId, err: err.message }, 'Could not record label email'));
            emailed = true;
          } else {
            // Stay 'saved': the next attempt (approve retry, merchant's
            // "Finish label", the recovery job) sends the email instead of
            // skipping it.
            logger.warn({ returnId }, 'Label email not sent; label kept as saved so it is sent on the next attempt');
          }
        }
      } finally {
        await release(emailClaim);
      }
    }
    if (!emailed) return label;

    await LabelService._withRetries(
      () => prisma.returnLabel.update({ where: { id: label.id }, data: { status: 'created' } }),
      { returnId, step: 'mark label created' },
    );
    eventBus.emit(LABEL_GENERATED, { returnId, labelId: label.id });
    return { ...label, status: 'created' };
  }

  /**
   * What a managed label costs the merchant, or null when nothing is owed:
   * bring-your-own carriers, simulated labels and development stores are
   * never charged. On a resume (no labelResult) the saved row stands in: a
   * live label has a PDF, a simulated one does not.
   */
  static async _chargeDue(label, { shop, billing, labelResult }) {
    if (!billing?.isManagedPlatform) return null;
    const cost = Number(labelResult ? labelResult.cost : label.cost);
    const simulated = labelResult ? Boolean(labelResult.simulated) : !label.labelUrl;
    if (simulated || !(cost > 0)) return null;
    const BillingService = require('./BillingService');
    let managed = billing.managedBilling;
    if (!managed) managed = await BillingService.managedLabelBilling(shop);
    if (managed?.devStore) return null;
    return { amount: Math.round((cost + BillingService.LABEL_FEE_GBP) * 100) / 100, postage: cost };
  }

  /**
   * Bill the merchant for a real managed label (postage + service fee) via
   * a Shopify usage charge. Isolated in its own try/catch: the label already
   * exists and the return is LABEL_SENT, so a billing hiccup must never turn
   * a successful label into LABEL_FAILED. Writes the outcome to the ledger.
   */
  static async _chargeLabel(returnId, shop, carrier, returnRecord, { amount, postage }) {
    const BillingService = require('./BillingService');
    let usageRecordId = null;
    let chargeError = null;
    try {
      usageRecordId = await BillingService.recordLabelCharge(shop, {
        amount,
        description: `Return label ${carrier} ${returnRecord.shopifyOrderName}`,
        // Shopify refuses a second charge with the same key, so a retry
        // (ours or a parallel worker's) can never bill the label twice.
        idempotencyKey: BillingService.labelChargeKey(returnId),
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
      amount,
      postage: Number(postage),
      usageRecordId,
      error: chargeError || (usageRecordId ? null : 'No usage line item or Shopify refused the charge'),
    });
    return usageRecordId;
  }

  /**
   * Move an approved return to LABEL_SENT. Conditional, so a label that
   * finishes after the merchant has already processed the refund (or
   * rejected the return) cannot drag the status backwards.
   */
  static async _advanceToLabelSent(returnId) {
    return prisma.return.updateMany({
      where: { id: returnId, status: 'APPROVED' },
      data: { status: 'LABEL_SENT' },
    });
  }

  /** Run a database write up to 3 times with a short pause between tries. */
  static async _withRetries(fn, { returnId, step }) {
    let lastErr;
    for (let attempt = 1; attempt <= 3; attempt++) {
      try {
        return await fn();
      } catch (err) {
        lastErr = err;
        logger.warn({ returnId, step, attempt, err: err.message }, 'Database write failed after label purchase; retrying');
        if (attempt < 3) await new Promise((r) => setTimeout(r, RETRY_DELAY_MS * attempt));
      }
    }
    throw lastErr;
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
   * Does the shop have somewhere for returns to go? The warehouse address in
   * Settings, or failing that the store's own address on Shopify. Checked
   * before a return is approved, so no return is approved that can never
   * get a label.
   */
  static async hasReturnsAddress(shop) {
    const settings = shop.settings || {};
    if (settings.warehouseLine1 && settings.warehousePostcode) return true;
    if (!shop.shopifyToken) return false;
    try {
      const client = await ShopToken.graphqlClient(shop);
      const resp = await client.request('{ shop { billingAddress { address1 zip } } }');
      const addr = resp.data?.shop?.billingAddress;
      return Boolean(addr?.address1 && addr?.zip);
    } catch (err) {
      logger.warn({ shop: shop.shopifyDomain, err: err.message }, 'Could not check the store address');
      return false;
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
    // Per-unit weight in kg by Shopify line item id, when the variant has one.
    const lineItemWeightsKg = {};

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
                lineItems(first: 100) {
                  edges { node { id variant { inventoryItem { measurement { weight { value unit } } } } } }
                }
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
        for (const edge of resp.data?.order?.lineItems?.edges || []) {
          const kg = toKg(edge.node?.variant?.inventoryItem?.measurement?.weight);
          if (kg != null) lineItemWeightsKg[edge.node.id] = kg;
        }
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

    return { senderAddress, recipientAddress, missing, lineItemWeightsKg };
  }

  /**
   * The parcel to book: each unit's weight from its Shopify variant when
   * known, else the merchant's default per-unit weight, else 0.5 kg; the
   * box size from the merchant's settings, else 30 x 20 x 10 cm.
   */
  static parcelFor(shop, returnRecord, lineItemWeightsKg = {}) {
    const settings = shop.settings || {};
    const defaultUnitKg = positive(settings.parcelDefaultWeightKg) || 0.5;
    const weight = returnRecord.items.reduce((sum, item) => {
      const unit = lineItemWeightsKg[item.shopifyLineItemId];
      return sum + item.quantity * (unit != null && unit > 0 ? unit : defaultUnitKg);
    }, 0);
    const dimensions = {
      length: positive(settings.parcelLengthCm) || 30,
      width: positive(settings.parcelWidthCm) || 20,
      height: positive(settings.parcelHeightCm) || 10,
    };
    return { weight: Math.round(Math.max(0.1, weight) * 1000) / 1000, dimensions };
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

LabelService.RETURNS_ADDRESS_REQUIRED_MESSAGE = RETURNS_ADDRESS_REQUIRED_MESSAGE;

module.exports = LabelService;
