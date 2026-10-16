// Format an amount in the order's currency. Falls back to a plain number
// with the code when the browser does not know the currency.
export function formatMoney(amount, currency) {
  const value = Number(amount || 0);
  const code = currency || 'GBP';
  try {
    return new Intl.NumberFormat(undefined, { style: 'currency', currency: code }).format(value);
  } catch {
    return `${value.toFixed(2)} ${code}`;
  }
}
