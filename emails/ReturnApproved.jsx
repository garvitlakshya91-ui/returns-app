import { Heading, Text } from '@react-email/components';
import BaseLayout from './_BaseLayout';

const heading = { color: '#059669', fontSize: '22px', fontWeight: '700', marginBottom: '12px' };
const para = { color: '#374151', fontSize: '15px', lineHeight: '22px' };
const muted = { color: '#6b7280', fontSize: '13px' };

export default function ReturnApproved({ customerName, orderName, returnId }) {
  return (
    <BaseLayout preview={`Return approved for ${orderName}`}>
      <Heading style={heading}>Return approved</Heading>
      <Text style={para}>Hi {customerName || 'there'},</Text>
      <Text style={para}>
        Good news — your return for order <strong>{orderName}</strong> has been
        approved.
      </Text>
      <Text style={para}>
        You'll receive your shipping label by email shortly. Once you've dropped
        off your parcel, your refund will be processed automatically when we
        receive it.
      </Text>
      <Text style={muted}>Return ID: {returnId}</Text>
    </BaseLayout>
  );
}
