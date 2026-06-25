const { computeReturnFee } = require('../../app/utils/fees');

const FEES = { changedMind: 2.5, doesntFit: 1, damaged: 0 };

describe('computeReturnFee', () => {
  it('returns 0 when the policy has no fees', () => {
    expect(computeReturnFee(null, [{ reason: 'changed_mind' }])).toBe(0);
    expect(computeReturnFee(undefined, [{ reason: 'changed_mind' }])).toBe(0);
  });

  it('returns 0 when there are no items', () => {
    expect(computeReturnFee(FEES, [])).toBe(0);
    expect(computeReturnFee(FEES, null)).toBe(0);
  });

  it('charges the configured fee for a single reason', () => {
    expect(computeReturnFee(FEES, [{ reason: 'changed_mind' }])).toBe(2.5);
    expect(computeReturnFee(FEES, [{ reason: 'doesnt_fit' }])).toBe(1);
  });

  it('treats faulty / merchant-fault reasons as the damaged bucket (£0 by default)', () => {
    expect(computeReturnFee(FEES, [{ reason: 'damaged' }])).toBe(0);
    expect(computeReturnFee(FEES, [{ reason: 'wrong_item' }])).toBe(0);
    expect(computeReturnFee(FEES, [{ reason: 'not_as_described' }])).toBe(0);
  });

  it('takes the MAX fee across a mixed-reason return (one fee per parcel)', () => {
    expect(computeReturnFee(FEES, [
      { reason: 'damaged' },      // 0
      { reason: 'doesnt_fit' },   // 1
      { reason: 'changed_mind' }, // 2.5
    ])).toBe(2.5);
  });

  it('defaults an unknown reason to the changed-mind bucket', () => {
    expect(computeReturnFee(FEES, [{ reason: 'other' }])).toBe(2.5);
    expect(computeReturnFee(FEES, [{ reason: 'nonsense' }])).toBe(2.5);
  });

  it('rounds to 2 decimal places', () => {
    expect(computeReturnFee({ changedMind: 2.005 }, [{ reason: 'changed_mind' }])).toBe(2.01);
  });
});
