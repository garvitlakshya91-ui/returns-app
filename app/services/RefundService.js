const crypto = require('crypto');
const prisma = require('../config/database');
const shopify = require('../config/shopify');
const ShopToken = require('./ShopToken');
const eventBus = require('../events/eventBus');
const { REFUND_PROCESSED } = require('../events/emitters');
const { EXCHANGES_ENABLED } = require('../config/features');
const logger = require('../utils/logger');

// A refund claim older than this is treated as abandoned and can be retaken.
const CLAIM_STALE_MS = 5 * 60 * 1000;

// Only real Shopify order gids can be refunded through the API. Demo and
// legacy returns are processed locally.
const REAL_ORDER_GID = /^gid:\/\/shopify\/Order\/\d+$/;

/** The note every refund we create carries; reconciliation finds it by this. */
function refundNote(returnId) {
  return `ReturnFlow return #${returnId}`;
}

/**
 * The idempotency key for a return's refund. Deterministic, so a retry after
 * a timeout or crash sends the same key and Shopify returns the refund it
 * already made instead of making another.
 */
function idempotencyKey(returnId) {
  const hex = crypto.createHash('sha256').update(`returnflow:refund:${returnId}`).digest('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`;
}

const round2 = (n) => Math.round(Number(n) * 100) / 100;

class RefundService {
  /**
   * Process a refund for a return via Shopify GraphQL API.
   */
  static async processRefund(returnId) {
    const returnRecord = await prisma.return.findUnique({
      where: { id: returnId },
      include: { items: true, shop: true },
    });

    if (!returnRecord) throw new Error(`Return ${returnId} not found`);
    if (returnRecord.status === 'PROCESSED') throw new Error('Return already processed');

    // Claim the return before any money moves, so a double-click, a retried
    // request or a queued job running alongside can't refund it twice. The
    // claim is processedAt being set on a not-yet-processed row; a claim
    // older than CLAIM_STALE_MS is treated as abandoned (a crashed attempt).
    // A retaken claim is still safe: _processClaimed reconciles against
    // Shopify and uses an idempotency key, so a refund that already went
    // through is found, never repeated.
    const claimed = await prisma.return.updateMany({
      where: {
        id: returnId,
        status: { not: 'PROCESSED' },
        OR: [
          { processedAt: null },
          { processedAt: { lt: new Date(Date.now() - CLAIM_STALE_MS) } },
        ],
      },
      data: { processedAt: new Date() },
    });
    if (claimed.count === 0) throw new Error('Return is already being processed');

    let moneyMoved = false;
    try {
      return await RefundService._processClaimed(returnId, returnRecord, () => { moneyMoved = true; });
    } catch (err) {
      // Release the claim only if Shopify never acted, so the merchant can
      // retry. Once money has moved, keep the claim: a retry would refund twice.
      if (!moneyMoved) {
        await prisma.return.updateMany({
          where: { id: returnId, status: { not: 'PROCESSED' } },
          data: { processedAt: null },
        }).catch((releaseErr) => logger.error({ returnId, err: releaseErr.message }, 'Could not release refund claim'));
      } else {
        logger.error({ returnId, err: err.message }, 'Refund sent to Shopify but saving it failed; claim kept to block a second refund');
      }
      throw err;
    }
  }

  static async _processClaimed(returnId, returnRecord, markMoneyMoved) {
    const shop = returnRecord.shop;
    const resolution = returnRecord.resolution;
    const totalValue = Number(returnRecord.totalValue);
    const fee = Number(returnRecord.returnFee || 0);
    // What we would refund if Shopify agreed with our own item values. The
    // amount actually sent is recalculated from Shopify below.
    const requestedAmount = Math.max(0, round2(totalValue - fee));

    // Returns without a real order (the admin demo return, the portal demo
    // seed, legacy rows) are processed locally instead of calling Shopify.
    if (!REAL_ORDER_GID.test(returnRecord.shopifyOrderId)) {
      await RefundService._persist(returnId, { amount: requestedAmount, method: 'local' });
      eventBus.emit(REFUND_PROCESSED, { returnId, refundAmount: requestedAmount, resolution });
      logger.info(
        { returnId, resolution, refundAmount: requestedAmount, shopifyOrderId: returnRecord.shopifyOrderId },
        'Return without a real Shopify order processed locally (no Shopify call)',
      );
      return { success: true, type: resolution, demo: true, amount: requestedAmount };
    }

    if (resolution === 'EXCHANGE') {
      if (!EXCHANGES_ENABLED) throw new Error('Exchanges are not enabled yet');
      const ExchangeService = require('./ExchangeService');
      const result = await ExchangeService.createExchange(returnRecord.id);
      markMoneyMoved();
      await RefundService._persist(returnId, { amount: requestedAmount, method: 'exchange', externalId: result?.draftOrderId });
      eventBus.emit(REFUND_PROCESSED, { returnId, refundAmount: requestedAmount, resolution });
      return { ...result, amount: requestedAmount };
    }
    if (resolution !== 'REFUND' && resolution !== 'STORE_CREDIT') {
      throw new Error(`Unknown resolution: ${resolution}`);
    }

    const accessToken = await ShopToken.getAccessToken(shop);
    const session = { shop: shop.shopifyDomain, accessToken };
    const client = new shopify.clients.Graphql({ session });

    // 1. Reconcile: if an earlier attempt already created this refund on
    //    Shopify (saved failed, process crashed, claim went stale), finish
    //    the paperwork instead of refunding again.
    let outcome = await RefundService._findExistingRefund(client, returnRecord);
    if (outcome) {
      logger.warn({ returnId, shopifyRefundId: outcome.shopifyRefundId }, 'Refund already exists on Shopify; reconciling instead of refunding again');
    } else {
      // 2. Let Shopify work out what these items are worth now: discounts,
      //    taxes, and anything already refunded. Our fee comes off that.
      const suggested = await RefundService._suggestedRefund(client, returnRecord);
      const amount = Math.min(Math.max(0, round2(suggested.gross - fee)), suggested.maximumRefundable);

      outcome = resolution === 'REFUND'
        ? await RefundService._refundToOriginalPayment(client, returnRecord, amount, suggested)
        : await RefundService._refundToStoreCredit(client, returnRecord, amount, suggested.currency);
      markMoneyMoved();
    }

    await RefundService._persist(returnId, outcome);
    eventBus.emit(REFUND_PROCESSED, { returnId, refundAmount: outcome.amount, resolution });
    logger.info({ returnId, resolution, refundAmount: outcome.amount, requestedAmount, shopifyRefundId: outcome.shopifyRefundId }, 'Refund processed');
    return {
      success: true,
      type: resolution,
      shopifyRefundId: outcome.shopifyRefundId,
      // The amount Shopify actually refunded, not the amount we asked for.
      amount: outcome.amount,
      requestedAmount,
      reconciled: Boolean(outcome.reconciled),
    };
  }

  /**
   * Mark the return processed and record the external refund id on its
   * timeline, so what Shopify did is on file even if later steps fail.
   */
  static async _persist(returnId, outcome) {
    await prisma.return.update({
      where: { id: returnId },
      data: { status: 'PROCESSED', refundAmount: outcome.amount, processedAt: new Date() },
    });
    try {
      await prisma.returnEvent.create({
        data: {
          returnId,
          // onRefundProcessed writes the generic refund.processed entry; this
          // one carries what Shopify did.
          type: 'refund.recorded',
          actor: 'system',
          data: {
            method: outcome.method,
            amount: outcome.amount,
            shopifyRefundId: outcome.shopifyRefundId || outcome.externalId || null,
            reconciled: Boolean(outcome.reconciled),
          },
        },
      });
    } catch (err) {
      logger.error({ returnId, err: err.message }, 'Refund processed but its timeline event could not be written');
    }
  }

  /** A refund we already created for this return, found by its note. */
  static async _findExistingRefund(client, returnRecord) {
    const resp = await client.request(`
      query existingRefunds($id: ID!) {
        order(id: $id) {
          refunds(first: 50) {
            id
            note
            totalRefundedSet { shopMoney { amount } }
            refundLineItems(first: 50) {
              edges { node { subtotalSet { shopMoney { amount } } totalTaxSet { shopMoney { amount } } } }
            }
          }
        }
      }
    `, { variables: { id: returnRecord.shopifyOrderId } });

    const note = refundNote(returnRecord.id);
    const match = (resp.data?.order?.refunds || []).find((r) => r.note === note);
    if (!match) return null;
    const amount = round2(match.totalRefundedSet?.shopMoney?.amount || 0);
    // A money refund that moved nothing is not "done": the retry below sends
    // the same idempotency key, so Shopify hands back the same refund rather
    // than making a second one, and the zero-amount check reports it.
    if (returnRecord.resolution === 'REFUND' && amount <= 0) return null;

    // Store credit may not show in totalRefundedSet. The credit we issued
    // was the refunded line items' value minus our fee, so rebuild it from
    // the refund's own line items rather than trusting a saved amount.
    let credited = amount;
    if (returnRecord.resolution !== 'REFUND' && credited <= 0) {
      const lineValue = (match.refundLineItems?.edges || []).reduce((sum, e) => {
        const n = e.node || {};
        return sum + Number(n.subtotalSet?.shopMoney?.amount || 0) + Number(n.totalTaxSet?.shopMoney?.amount || 0);
      }, 0);
      credited = Math.max(0, round2(lineValue - Number(returnRecord.returnFee || 0)));
    }
    return {
      shopifyRefundId: match.id,
      amount: returnRecord.resolution === 'REFUND' ? amount : credited,
      method: returnRecord.resolution === 'REFUND' ? 'original_payment' : 'store_credit',
      reconciled: true,
    };
  }

  /** Shopify's own calculation of what refunding these items is worth. */
  static async _suggestedRefund(client, returnRecord) {
    const refundLineItems = returnRecord.items.map((item) => ({
      lineItemId: item.shopifyLineItemId,
      quantity: item.quantity,
    }));
    const resp = await client.request(`
      query suggestedRefund($id: ID!, $refundLineItems: [RefundLineItemInput!]!) {
        order(id: $id) {
          currencyCode
          suggestedRefund(refundLineItems: $refundLineItems, refundShipping: false) {
            maximumRefundableSet { shopMoney { amount } }
            subtotalSet { shopMoney { amount } }
            totalTaxSet { shopMoney { amount } }
            suggestedTransactions {
              kind
              gateway
              amountSet { shopMoney { amount } }
              parentTransaction { id }
            }
          }
        }
      }
    `, { variables: { id: returnRecord.shopifyOrderId, refundLineItems } });

    const order = resp.data?.order;
    const s = order?.suggestedRefund;
    if (!s) throw new Error('Shopify could not calculate a refund for this order');
    const money = (set) => round2(set?.shopMoney?.amount || 0);
    return {
      currency: order.currencyCode || returnRecord.currency || 'GBP',
      gross: round2(money(s.subtotalSet) + money(s.totalTaxSet)),
      maximumRefundable: money(s.maximumRefundableSet),
      transactions: (s.suggestedTransactions || [])
        .filter((t) => t.parentTransaction?.id && money(t.amountSet) > 0)
        .map((t) => ({ parentId: t.parentTransaction.id, gateway: t.gateway, amount: money(t.amountSet) })),
      refundLineItems,
    };
  }

  /**
   * Split the amount across the payments Shopify suggests, in proportion,
   * never above what each can refund. The last one absorbs the rounding.
   */
  static _allocate(amount, transactions) {
    const total = transactions.reduce((sum, t) => sum + t.amount, 0);
    if (total <= 0) return [];
    const out = [];
    let left = amount;
    transactions.forEach((t, i) => {
      const share = i === transactions.length - 1
        ? round2(left)
        : Math.min(round2((amount * t.amount) / total), t.amount);
      const capped = Math.min(share, t.amount);
      if (capped > 0) out.push({ ...t, amount: capped });
      left = round2(left - capped);
    });
    return out;
  }

  static async _refundToOriginalPayment(client, returnRecord, amount, suggested) {
    const transactions = RefundService._allocate(amount, suggested.transactions);
    if (amount > 0 && transactions.length === 0) {
      throw new Error('No refundable payment found on this order — refund it in Shopify directly');
    }

    const input = {
      orderId: returnRecord.shopifyOrderId,
      note: refundNote(returnRecord.id),
      shipping: { fullRefund: false },
      refundLineItems: suggested.refundLineItems,
      transactions: transactions.map((t) => ({
        orderId: returnRecord.shopifyOrderId,
        parentId: t.parentId,
        kind: 'REFUND',
        gateway: t.gateway,
        amount: String(t.amount),
      })),
    };

    const refund = await RefundService._refundCreate(client, returnRecord.id, input);
    const refunded = round2(refund.totalRefundedSet?.shopMoney?.amount || 0);
    if (amount > 0 && refunded <= 0) {
      throw new Error(`Shopify created refund ${refund.id} but moved no money. Check the order in Shopify before retrying.`);
    }
    return { shopifyRefundId: refund.id, amount: refunded, method: 'original_payment' };
  }

  /**
   * Store credit through refundCreate, as Shopify requires for credit issued
   * during a refund. The credit lands on the customer's account at the store.
   */
  static async _refundToStoreCredit(client, returnRecord, amount, currency) {
    const input = {
      orderId: returnRecord.shopifyOrderId,
      note: refundNote(returnRecord.id),
      shipping: { fullRefund: false },
      refundLineItems: returnRecord.items.map((item) => ({
        lineItemId: item.shopifyLineItemId,
        quantity: item.quantity,
      })),
      refundMethods: [{
        storeCreditRefund: { amount: { amount: String(amount), currencyCode: currency } },
      }],
    };

    const refund = await RefundService._refundCreate(client, returnRecord.id, input);
    return { shopifyRefundId: refund.id, amount, method: 'store_credit' };
  }

  static async _refundCreate(client, returnId, input) {
    const response = await client.request(`
      mutation refundCreate($input: RefundInput!) {
        refundCreate(input: $input) @idempotent(key: "${idempotencyKey(returnId)}") {
          refund {
            id
            totalRefundedSet { shopMoney { amount currencyCode } }
          }
          userErrors { field message }
        }
      }
    `, { variables: { input } });

    const errors = response.data?.refundCreate?.userErrors || [];
    if (errors.length > 0) {
      throw new Error(`Shopify refund error: ${errors.map((e) => e.message).join(', ')}`);
    }
    const refund = response.data?.refundCreate?.refund;
    if (!refund?.id) throw new Error('Shopify refund error: no refund was returned');
    return refund;
  }
}

RefundService.refundNote = refundNote;
RefundService.idempotencyKey = idempotencyKey;

module.exports = RefundService;
