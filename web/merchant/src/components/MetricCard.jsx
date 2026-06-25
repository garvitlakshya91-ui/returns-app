import { Card, Text, BlockStack, InlineStack, Icon } from '@shopify/polaris';

// Optional icon shown in a tinted square. tone maps to a Polaris-ish accent.
const TONE_BG = {
  default: '#EEF2FF',
  success: '#E7F5EC',
  warning: '#FFF4E4',
  critical: '#FDEBEC',
};
const TONE_FG = {
  default: '#4F46E5',
  success: '#0E8A4F',
  warning: '#B45309',
  critical: '#D72C0D',
};

export default function MetricCard({ title, value, trend, trendUp, icon, tone = 'default' }) {
  return (
    <Card>
      <BlockStack gap="200">
        <InlineStack align="space-between" blockAlign="center">
          <Text variant="bodyMd" as="p" tone="subdued">{title}</Text>
          {icon && (
            <span
              style={{
                display: 'inline-flex',
                width: 32,
                height: 32,
                borderRadius: 8,
                alignItems: 'center',
                justifyContent: 'center',
                background: TONE_BG[tone] || TONE_BG.default,
                color: TONE_FG[tone] || TONE_FG.default,
              }}
            >
              <Icon source={icon} />
            </span>
          )}
        </InlineStack>
        <InlineStack align="space-between" blockAlign="end">
          <Text variant="headingXl" as="h3">{value}</Text>
          {trend !== undefined && (
            <Text
              variant="bodySm"
              as="span"
              tone={trendUp ? 'success' : 'critical'}
            >
              {trendUp ? '+' : ''}{trend}%
            </Text>
          )}
        </InlineStack>
      </BlockStack>
    </Card>
  );
}
