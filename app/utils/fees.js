// Return-fee computation.
//
// Fees are configured per-policy as a flat amount per return reason:
//   fees: { changedMind: 2.50, doesntFit: 0, damaged: 0 }
//
// A return is shipped as a single parcel (one carrier label), so the fee is
// charged per-return, not per-item. When a return mixes reasons we take the
// MAX applicable fee across its items — the customer is never charged more
// than one (the highest) shipping fee.
//
// Faulty / merchant-fault reasons (damaged, wrong item, not as described,
// quality) map to the `damaged` bucket, which merchants normally leave at £0.

const REASON_FEE_KEY = {
  changed_mind: 'changedMind',
  doesnt_fit: 'doesntFit',
  damaged: 'damaged',
  wrong_item: 'damaged',
  not_as_described: 'damaged',
  quality: 'damaged',
  other: 'changedMind',
};

/**
 * @param {object|null} policyFees  The policy's `fees` JSON (or null).
 * @param {Array<{reason?: string}>} items  Return items with reason codes.
 * @returns {number} The return-level fee in the shop currency (>= 0).
 */
function computeReturnFee(policyFees, items) {
  if (!policyFees || !Array.isArray(items) || items.length === 0) return 0;

  let max = 0;
  for (const item of items) {
    const key = REASON_FEE_KEY[item.reason] || 'changedMind';
    const fee = Number(policyFees[key] || 0);
    if (Number.isFinite(fee) && fee > max) max = fee;
  }
  // Guard against float drift (e.g. 2.5 → 2.50).
  return Math.round(max * 100) / 100;
}

module.exports = { computeReturnFee, REASON_FEE_KEY };
