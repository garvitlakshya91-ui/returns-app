// Format an amount in a given currency (the return's, or the shop's).
export function formatMoney(amount, currency) {
  const value = Number(amount || 0);
  const code = currency || 'GBP';
  try {
    return new Intl.NumberFormat('en-GB', { style: 'currency', currency: code }).format(value);
  } catch {
    return `${value.toFixed(2)} ${code}`;
  }
}
