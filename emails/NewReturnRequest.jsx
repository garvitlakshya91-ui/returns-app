import { Button, Heading, Section, Text } from '@react-email/components';
import BaseLayout from './_BaseLayout';

// Merchant-facing: a customer has just asked to return something. Sent to the
// shop's email when "Notify merchant on new return" is set to Email.

const heading = { color: '#111827', fontSize: '22px', fontWeight: '700', marginBottom: '12px' };
const para = { color: '#374151', fontSize: '15px', lineHeight: '22px' };
const muted = { color: '#6b7280', fontSize: '13px' };
const itemRow = { padding: '8px 0', borderBottom: '1px solid #f3f4f6' };
const button = {
  backgroundColor: '#4F46E5',
  color: '#ffffff',
  fontSize: '15px',
  fontWeight: '600',
  padding: '12px 20px',
  borderRadius: '6px',
  textDecoration: 'none',
};

const RESOLUTION_TEXT = {
  REFUND: 'Refund to original payment',
  STORE_CREDIT: 'Store credit',
  EXCHANGE: 'Exchange',
  KEEP_ITEM: 'Keep the item',
};

export default function NewReturnRequest({ shopName, orderName, customerName, customerEmail, items, resolution, totalValue, currency, returnUrl, brand }) {
  const count = items?.reduce((n, i) => n + (Number(i.quantity) || 0), 0) || 0;
  return (
    <BaseLayout preview={`New return request for ${orderName}`} brand={brand}>
      <Heading style={heading}>New return request</Heading>
      <Text style={para}>
        {customerName || customerEmail || 'A customer'} has asked to return {count === 1 ? 'an item' : `${count} items`} from
        {shopName ? ` ${shopName}` : ''} order <strong>{orderName}</strong>. It is waiting for your approval.
      </Text>
      <Text style={muted}>
        Customer: {customerEmail || '—'}
        {resolution ? ` · Wants: ${RESOLUTION_TEXT[resolution] || resolution}` : ''}
        {totalValue != null ? ` · Value: ${currency || 'GBP'} ${Number(totalValue).toFixed(2)}` : ''}
      </Text>

      {items?.length ? (
        <Section style={{ marginTop: '20px' }}>
          <Text style={{ ...para, fontWeight: '600', marginBottom: '8px' }}>Items</Text>
          {items.map((item, i) => (
            <Section key={i} style={itemRow}>
              <Text style={{ ...para, margin: 0 }}>
                {item.title}
                {item.variant ? ` — ${item.variant}` : ''}
              </Text>
              <Text style={{ ...muted, margin: 0 }}>
                Qty {item.quantity} · Reason: {item.reason}
                {item.detail ? ` — "${item.detail}"` : ''}
              </Text>
            </Section>
          ))}
        </Section>
      ) : null}

      {returnUrl ? (
        <Section style={{ marginTop: '24px' }}>
          <Button href={returnUrl} style={button}>Review in ReturnFlow</Button>
        </Section>
      ) : (
        <Text style={{ ...para, marginTop: '24px' }}>Open ReturnFlow in your Shopify admin to approve or reject it.</Text>
      )}

      <Text style={{ ...muted, marginTop: '24px' }}>
        You can switch these emails off under Settings → Notifications in ReturnFlow.
      </Text>
    </BaseLayout>
  );
}
