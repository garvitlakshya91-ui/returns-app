import { Body, Container, Head, Hr, Html, Img, Preview, Section, Text } from '@react-email/components';

const main = {
  backgroundColor: '#f6f9fc',
  fontFamily: '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif',
};

const container = {
  backgroundColor: '#ffffff',
  margin: '0 auto',
  padding: '32px 24px 48px',
  marginBottom: '64px',
  maxWidth: '560px',
  borderRadius: '8px',
};

const footer = {
  color: '#9ca3af',
  fontSize: '12px',
  lineHeight: '20px',
  textAlign: 'center',
  margin: '2px 0',
};

const brandText = {
  fontSize: '20px',
  fontWeight: '700',
  marginBottom: '24px',
};

const hr = {
  borderColor: '#e5e7eb',
  margin: '24px 0',
};

// `brand` carries the merchant's identity: { name, color, supportEmail }.
// Falls back to ReturnFlow defaults so the layout still renders if branding
// can't be resolved.
export default function BaseLayout({ preview, brand = {}, children }) {
  const brandName = brand.name || 'ReturnFlow';
  const brandColor = brand.color || '#4F46E5';
  const supportEmail = brand.supportEmail || null;
  const logoUrl = brand.logoUrl || null;

  return (
    <Html>
      <Head />
      {preview ? <Preview>{preview}</Preview> : null}
      <Body style={main}>
        <Container style={container}>
          {logoUrl ? (
            <Img src={logoUrl} alt={brandName} height={40} style={{ height: '40px', width: 'auto', marginBottom: '24px' }} />
          ) : (
            <Text style={{ ...brandText, color: brandColor }}>{brandName}</Text>
          )}
          {children}
          <Hr style={hr} />
          <Section>
            {supportEmail ? (
              <Text style={footer}>Questions? Contact {supportEmail}</Text>
            ) : null}
            <Text style={footer}>Powered by ReturnFlow</Text>
          </Section>
        </Container>
      </Body>
    </Html>
  );
}
