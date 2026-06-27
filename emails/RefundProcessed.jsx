import { Heading, Section, Text } from '@react-email/components';
import BaseLayout from './_BaseLayout';

const heading = { color: '#059669', fontSize: '22px', fontWeight: '700', marginBottom: '12px' };
const para = { color: '#374151', fontSize: '15px', lineHeight: '22px' };
const muted = { color: '#6b7280', fontSize: '13px' };
const amountBox = {
  backgroundColor: '#f0fdf4',
  border: '1px solid #bbf7d0',
  borderRadius: '6px',
  padding: '16px',
  textAlign: 'center',
  margin: '20px 0',
};
const amountText = { color: '#065f46', fontSize: '24px', fontWeight: '700', margin: 0 };
const amountLabel = { color: '#047857', fontSize: '13px', margin: '4px 0 0' };

function currencySymbol(code) {
  switch ((code || 'GBP').toUpperCase()) {
    case 'GBP': return '£';
    case 'USD': return '$';
    case 'EUR': return '€';
    default: return `${code} `;
  }
}

export default function RefundProcessed({
  customerName,
  orderName,
  returnId,
  resolutionText,
  refundAmount,
  currency,
  brand,
}) {
  const sym = currencySymbol(currency);
  const amount = Number(refundAmount || 0).toFixed(2);
  return (
    <BaseLayout preview={`Refund processed for ${orderName}`} brand={brand}>
      <Heading style={heading}>Refund processed</Heading>
      <Text style={para}>Hi {customerName || 'there'},</Text>
      <Text style={para}>
        Your return for order <strong>{orderName}</strong> has been{' '}
        {resolutionText || 'processed'}.
      </Text>

      <Section style={amountBox}>
        <Text style={amountText}>{sym}{amount}</Text>
        <Text style={amountLabel}>Refund amount</Text>
      </Section>

      <Text style={para}>
        Refunds usually appear on your statement within 3–5 business days,
        depending on your bank.
      </Text>
      <Text style={muted}>Return ID: {returnId}</Text>
    </BaseLayout>
  );
}
