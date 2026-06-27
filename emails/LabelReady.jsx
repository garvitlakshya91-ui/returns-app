import { Button, Heading, Img, Section, Text } from '@react-email/components';
import BaseLayout from './_BaseLayout';

const heading = { color: '#4F46E5', fontSize: '22px', fontWeight: '700', marginBottom: '12px' };
const para = { color: '#374151', fontSize: '15px', lineHeight: '22px' };
const muted = { color: '#6b7280', fontSize: '13px' };
const detail = { color: '#111827', fontSize: '14px', margin: '4px 0' };
const button = {
  backgroundColor: '#4F46E5',
  borderRadius: '6px',
  color: '#ffffff',
  fontSize: '14px',
  fontWeight: '600',
  padding: '12px 24px',
  textDecoration: 'none',
  textAlign: 'center',
};
const qrWrap = { textAlign: 'center', margin: '24px 0' };

export default function LabelReady({
  customerName,
  orderName,
  returnId,
  labelUrl,
  qrCodeUrl,
  carrier,
  trackingCode,
  brand,
}) {
  const accent = brand?.color || '#4F46E5';
  return (
    <BaseLayout preview={`Your return label for ${orderName} is ready`} brand={brand}>
      <Heading style={{ ...heading, color: accent }}>Your return label is ready</Heading>
      <Text style={para}>Hi {customerName || 'there'},</Text>
      <Text style={para}>
        Your return label for order <strong>{orderName}</strong> is ready.
      </Text>

      <Section style={{ marginTop: '16px' }}>
        <Text style={detail}>
          <strong>Carrier:</strong> {carrier}
        </Text>
        {trackingCode ? (
          <Text style={detail}>
            <strong>Tracking:</strong> {trackingCode}
          </Text>
        ) : null}
      </Section>

      {qrCodeUrl ? (
        <Section style={qrWrap}>
          <Text style={{ ...para, marginBottom: '8px' }}>
            Show this QR code at any {carrier} drop-off point:
          </Text>
          <Img src={qrCodeUrl} alt="QR code" width={200} height={200} />
        </Section>
      ) : null}

      {labelUrl ? (
        <Section style={{ textAlign: 'center', margin: '24px 0' }}>
          <Button href={labelUrl} style={{ ...button, backgroundColor: accent }}>
            Download label
          </Button>
        </Section>
      ) : null}

      <Text style={muted}>Return ID: {returnId}</Text>
    </BaseLayout>
  );
}
