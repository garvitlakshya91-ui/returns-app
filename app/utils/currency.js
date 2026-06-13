/**
 * Format a numeric amount as GBP currency string.
 */
function formatGBP(amount) {
  return new Intl.NumberFormat('en-GB', {
    style: 'currency',
    currency: 'GBP',
  }).format(amount);
}

module.exports = { formatGBP };
