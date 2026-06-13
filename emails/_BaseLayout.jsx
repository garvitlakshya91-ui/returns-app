import { Body, Container, Head, Hr, Html, Preview, Section, Text } from '@react-email/components';

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
};

const brand = {
  color: '#4F46E5',
  fontSize: '20px',
  fontWeight: '700',
  marginBottom: '24px',
};

const hr = {
  borderColor: '#e5e7eb',
  margin: '24px 0',
};

export default function BaseLayout({ preview, children }) {
  return (
    <Html>
      <Head />
      {preview ? <Preview>{preview}</Preview> : null}
      <Body style={main}>
        <Container style={container}>
          <Text style={brand}>ReturnFlow</Text>
          {children}
          <Hr style={hr} />
          <Text style={footer}>
            Powered by ReturnFlow · returnflow.co.uk
          </Text>
        </Container>
      </Body>
    </Html>
  );
}
