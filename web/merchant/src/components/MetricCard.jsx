import { Card, Text, BlockStack, InlineStack } from '@shopify/polaris';

export default function MetricCard({ title, value, trend, trendUp }) {
  return (
    <Card>
      <BlockStack gap="200">
        <Text variant="bodyMd" as="p" tone="subdued">{title}</Text>
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
