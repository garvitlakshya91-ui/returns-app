import { Heading, Text } from '@react-email/components';
import BaseLayout from './_BaseLayout';

const heading = { color: '#059669', fontSize: '22px', fontWeight: '700', marginBottom: '12px' };
const para = { color: '#374151', fontSize: '15px', lineHeight: '22px' };
const muted = { color: '#6b7280', fontSize: '13px' };

const addressBox = { background: '#f3f4f6', borderRadius: '8px', padding: '14px 16px', color: '#111827', fontSize: '15px', lineHeight: '22px', margin: '12px 0' };

export default function ReturnApproved({ customerName, orderName, returnId, brand, withoutLabel = false, returnsAddress = null }) {
  return (
    <BaseLayout preview={`Return approved for ${orderName}`} brand={brand}>
      <Heading style={heading}>Return approved</Heading>
      <Text style={para}>Hi {customerName || 'there'},</Text>
      <Text style={para}>
        Good news — your return for order <strong>{orderName}</strong> has been
        approved.
      </Text>
      {withoutLabel ? (
        <>
          <Text style={para}>
            Please post the item(s) back to us using a postage service of your
            choice. We recommend a tracked service, and keeping your receipt.
          </Text>
          {returnsAddress && (
            <Text style={addressBox}>
              {returnsAddress.name && <>{returnsAddress.name}<br /></>}
              {returnsAddress.line1}<br />
              {returnsAddress.city && <>{returnsAddress.city}<br /></>}
              {returnsAddress.postcode}
            </Text>
          )}
          <Text style={para}>
            Your refund will be processed once the parcel arrives and has been
            checked.
          </Text>
        </>
      ) : (
        <Text style={para}>
          You'll receive your shipping label by email shortly. Once you've dropped
          off your parcel, your refund will be processed automatically when we
          receive it.
        </Text>
      )}
      <Text style={muted}>Return ID: {returnId}</Text>
    </BaseLayout>
  );
}
