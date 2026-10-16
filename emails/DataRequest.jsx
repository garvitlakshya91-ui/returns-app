import { Heading, Section, Text } from '@react-email/components';
import BaseLayout from './_BaseLayout';

const heading = { color: '#111827', fontSize: '22px', fontWeight: '700', marginBottom: '12px' };
const para = { color: '#374151', fontSize: '15px', lineHeight: '22px' };
const muted = { color: '#6b7280', fontSize: '13px' };
const csvBox = {
  backgroundColor: '#f9fafb',
  border: '1px solid #e5e7eb',
  borderRadius: '6px',
  padding: '12px 16px',
  margin: '16px 0',
  fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
  fontSize: '12px',
  whiteSpace: 'pre-wrap',
  wordBreak: 'break-all',
};

// Sent to the merchant when Shopify relays a customer's data request. The
// merchant is the data controller and must pass this on within 30 days.
export default function DataRequest({ shopName, customerEmail, returnCount, csv, requestId }) {
  return (
    <BaseLayout preview={`Customer data request for ${customerEmail}`}>
      <Heading style={heading}>Customer data request</Heading>
      <Text style={para}>
        A customer of {shopName || 'your store'} has asked Shopify for a copy of their personal
        data. Below is everything ReturnFlow holds for <strong>{customerEmail}</strong>:
        {' '}{returnCount} return{returnCount === 1 ? '' : 's'}.
      </Text>
      <Text style={para}>
        Please pass this on to the customer within 30 days, together with any data you hold
        elsewhere. The rows are in CSV form so they can be saved as a spreadsheet.
      </Text>
      <Section style={csvBox}>
        <Text style={{ ...para, margin: 0, fontFamily: 'inherit', fontSize: '12px' }}>{csv}</Text>
      </Section>
      {requestId ? <Text style={muted}>Shopify request ID: {requestId}</Text> : null}
    </BaseLayout>
  );
}
