import { Heading, Text } from '@react-email/components';
import BaseLayout from './_BaseLayout';

const heading = { color: '#059669', fontSize: '22px', fontWeight: '700', marginBottom: '12px' };
const para = { color: '#374151', fontSize: '15px', lineHeight: '22px' };
const muted = { color: '#6b7280', fontSize: '13px' };

export default function ReturnReceived({ customerName, orderName, returnId, brand }) {
  return (
    <BaseLayout preview={`We've received your return for ${orderName}`} brand={brand}>
      <Heading style={heading}>Your parcel has arrived</Heading>
      <Text style={para}>Hi {customerName || 'there'},</Text>
      <Text style={para}>
        Your return for order <strong>{orderName}</strong> has reached us.
      </Text>
      <Text style={para}>
        We'll check the items and process your refund or store credit. You'll
        get another email as soon as that's done.
      </Text>
      <Text style={muted}>Return ID: {returnId}</Text>
    </BaseLayout>
  );
}
