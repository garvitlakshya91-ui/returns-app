import { Heading, Section, Text } from '@react-email/components';
import BaseLayout from './_BaseLayout';

const heading = { color: '#DC2626', fontSize: '22px', fontWeight: '700', marginBottom: '12px' };
const para = { color: '#374151', fontSize: '15px', lineHeight: '22px' };
const muted = { color: '#6b7280', fontSize: '13px' };
const reasonBox = {
  backgroundColor: '#fef2f2',
  border: '1px solid #fecaca',
  borderRadius: '6px',
  padding: '12px 16px',
  margin: '16px 0',
};

export default function ReturnRejected({ customerName, orderName, returnId, reason }) {
  return (
    <BaseLayout preview={`Update on your return for ${orderName}`}>
      <Heading style={heading}>Return request update</Heading>
      <Text style={para}>Hi {customerName || 'there'},</Text>
      <Text style={para}>
        Unfortunately, your return for order <strong>{orderName}</strong> could
        not be approved.
      </Text>

      {reason ? (
        <Section style={reasonBox}>
          <Text style={{ ...para, margin: 0 }}>
            <strong>Reason:</strong> {reason}
          </Text>
        </Section>
      ) : null}

      <Text style={para}>
        If you have questions or believe this was an error, please contact the
        store directly.
      </Text>
      <Text style={muted}>Return ID: {returnId}</Text>
    </BaseLayout>
  );
}
