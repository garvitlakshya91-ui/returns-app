import { Heading, Text, Section } from '@react-email/components';
import BaseLayout from './_BaseLayout';

const heading = { color: '#111827', fontSize: '22px', fontWeight: '700', marginBottom: '12px' };
const para = { color: '#374151', fontSize: '15px', lineHeight: '22px' };
const muted = { color: '#6b7280', fontSize: '13px' };
const itemRow = { padding: '8px 0', borderBottom: '1px solid #f3f4f6' };

export default function ReturnConfirmed({ customerName, orderName, returnId, items, brand }) {
  return (
    <BaseLayout preview={`We received your return request for ${orderName}`} brand={brand}>
      <Heading style={heading}>Return request received</Heading>
      <Text style={para}>Hi {customerName || 'there'},</Text>
      <Text style={para}>
        We've received your return request for order <strong>{orderName}</strong>.
      </Text>
      <Text style={muted}>Return ID: {returnId}</Text>

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
              </Text>
            </Section>
          ))}
        </Section>
      ) : null}

      <Text style={{ ...para, marginTop: '24px' }}>
        We'll review your request and email you again as soon as it's approved.
      </Text>
    </BaseLayout>
  );
}
