const { formatGBP } = require('../../app/utils/currency');

describe('utils/currency', () => {
  it('formats a whole number with £ symbol and 2 decimals', () => {
    expect(formatGBP(50)).toBe('£50.00');
  });

  it('formats decimals correctly', () => {
    expect(formatGBP(47.5)).toBe('£47.50');
    expect(formatGBP(0.99)).toBe('£0.99');
  });

  it('formats zero', () => {
    expect(formatGBP(0)).toBe('£0.00');
  });

  it('formats negative amounts (refund-side display)', () => {
    expect(formatGBP(-12.34)).toBe('-£12.34');
  });

  it('rounds to 2 decimal places', () => {
    expect(formatGBP(10.999)).toBe('£11.00');
    expect(formatGBP(10.001)).toBe('£10.00');
  });

  it('adds thousand separators for large amounts', () => {
    expect(formatGBP(1234567.89)).toBe('£1,234,567.89');
  });
});
