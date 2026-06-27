import { useState, useEffect, useCallback } from 'react';
import {
  Page,
  Layout,
  Card,
  Text,
  BlockStack,
  InlineStack,
  Button,
  Select,
  DataTable,
  EmptyState,
  Banner,
  Badge,
  Box,
  SkeletonPage,
  SkeletonBodyText,
} from '@shopify/polaris';
import {
  LineChart,
  Line,
  BarChart,
  Bar,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  Legend,
  ResponsiveContainer,
} from 'recharts';
import MetricCard from '../components/MetricCard';
import AppFooter from '../components/AppFooter';
import { analyticsApi, billingApi } from '../api';

// Shown as a blurred teaser when a shop's plan doesn't include analytics, so
// the page demonstrates the feature's value instead of looking like broken
// zeros. Clearly labelled "Sample data" so it's never mistaken for real.
const SAMPLE_SUMMARY = {
  totalReturns: 128, pendingReturns: 9, processedReturns: 102, rejectedReturns: 5,
  totalValue: 4820, refundedValue: 2960, revenueRetained: 1860,
};
const SAMPLE_TREND = Array.from({ length: 14 }, (_, i) => ({
  date: `2026-06-${String(9 + i).padStart(2, '0')}`,
  count: [4, 7, 5, 9, 6, 11, 8, 6, 12, 9, 13, 7, 10, 11][i],
  value: [140, 260, 180, 320, 220, 410, 300, 220, 460, 330, 480, 260, 360, 410][i],
}));
const SAMPLE_SKUS = [
  { sku: 'MWJ-M-GRN', productTitle: 'Merino Wool Jumper', totalReturns: 18, totalQuantity: 20, reasonBreakdown: { doesnt_fit: 11, damaged: 7 } },
  { sku: 'CTB-NAT', productTitle: 'Canvas Tote Bag', totalReturns: 11, totalQuantity: 12, reasonBreakdown: { changed_mind: 7, not_as_described: 4 } },
  { sku: 'DNM-32-IND', productTitle: 'Selvedge Denim', totalReturns: 8, totalQuantity: 8, reasonBreakdown: { doesnt_fit: 8 } },
];

const RANGE_OPTIONS = [
  { label: 'Last 7 days', value: '7' },
  { label: 'Last 30 days', value: '30' },
  { label: 'Last 90 days', value: '90' },
  { label: 'Last 365 days', value: '365' },
];

const REASON_LABELS = {
  doesnt_fit: "Doesn't fit",
  changed_mind: 'Changed mind',
  not_as_described: 'Not as described',
  damaged: 'Damaged',
  wrong_item: 'Wrong item',
  quality: 'Quality',
  other: 'Other',
};

function formatGBP(amount) {
  return `£${Number(amount || 0).toFixed(2)}`;
}

function formatDateShort(iso) {
  const d = new Date(iso);
  return d.toLocaleDateString('en-GB', { day: '2-digit', month: 'short' });
}

export default function AnalyticsPage() {
  const [days, setDays] = useState('30');
  const [loading, setLoading] = useState(true);
  const [summary, setSummary] = useState(null);
  const [trend, setTrend] = useState([]);
  const [skus, setSkus] = useState([]);
  const [error, setError] = useState(null);
  const [locked, setLocked] = useState(false);
  const [upgrading, setUpgrading] = useState(false);

  const loadAnalytics = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const [summaryData, trendData, skuData] = await Promise.all([
        analyticsApi.summary(Number(days)),
        analyticsApi.trend(Number(days)),
        analyticsApi.skus(10),
      ]);
      setLocked(false);
      setSummary(summaryData);
      setTrend(trendData.map((d) => ({ ...d, label: formatDateShort(d.date) })));
      setSkus(skuData);
    } catch (err) {
      console.error('Analytics load error:', err);
      if (err.message?.toLowerCase().includes('growth') || err.message?.toLowerCase().includes('upgrade')) {
        // Plan-gated: show the feature as a labelled sample so it reads as a
        // locked feature, not a broken page.
        setLocked(true);
        setSummary(SAMPLE_SUMMARY);
        setTrend(SAMPLE_TREND.map((d) => ({ ...d, label: formatDateShort(d.date) })));
        setSkus(SAMPLE_SKUS);
      } else {
        setError('Failed to load analytics. Please try again.');
      }
    } finally {
      setLoading(false);
    }
  }, [days]);

  async function handleUpgrade() {
    setUpgrading(true);
    try {
      const { confirmationUrl } = await billingApi.subscribe('GROWTH');
      if (confirmationUrl) {
        // Break out of the embedded iframe to Shopify's approval screen.
        if (window.top) window.top.location.href = confirmationUrl;
        else window.location.href = confirmationUrl;
      }
    } catch (err) {
      console.error('Upgrade error:', err);
      setError('Could not start the upgrade. Please try again.');
    } finally {
      setUpgrading(false);
    }
  }

  useEffect(() => {
    loadAnalytics();
  }, [loadAnalytics]);

  function handleExport() {
    window.location.href = analyticsApi.exportUrl();
  }

  if (loading) {
    return (
      <SkeletonPage title="Analytics">
        <Layout>
          <Layout.Section>
            <Card><SkeletonBodyText lines={3} /></Card>
          </Layout.Section>
          <Layout.Section>
            <Card><SkeletonBodyText lines={6} /></Card>
          </Layout.Section>
        </Layout>
      </SkeletonPage>
    );
  }

  const returnRate = summary?.totalReturns
    ? ((summary.processedReturns / summary.totalReturns) * 100).toFixed(1)
    : '0';

  const topReason = (() => {
    const counts = {};
    for (const sku of skus) {
      for (const [reason, count] of Object.entries(sku.reasonBreakdown || {})) {
        counts[reason] = (counts[reason] || 0) + count;
      }
    }
    const sorted = Object.entries(counts).sort((a, b) => b[1] - a[1]);
    return sorted[0]?.[0];
  })();

  const reasonChartData = (() => {
    const counts = {};
    for (const sku of skus) {
      for (const [reason, count] of Object.entries(sku.reasonBreakdown || {})) {
        counts[reason] = (counts[reason] || 0) + count;
      }
    }
    return Object.entries(counts).map(([reason, count]) => ({
      reason: REASON_LABELS[reason] || reason,
      count,
    }));
  })();

  return (
    <Page
      title="Analytics"
      primaryAction={locked ? undefined : { content: 'Export CSV', onAction: handleExport }}
      secondaryActions={[
        {
          content: 'Refresh',
          onAction: loadAnalytics,
        },
      ]}
    >
      <Layout>
        {error && (
          <Layout.Section>
            <Banner tone="critical" title="Error">
              <p>{error}</p>
            </Banner>
          </Layout.Section>
        )}

        {locked && (
          <Layout.Section>
            <Banner
              tone="info"
              title="Unlock analytics with Growth"
              action={{ content: 'Upgrade to Growth — £29/mo', onAction: handleUpgrade, loading: upgrading }}
            >
              <p>See your real return rate, top returned products, reason breakdowns and revenue retained. The figures below are sample data.</p>
            </Banner>
          </Layout.Section>
        )}

        <Layout.Section>
          <Card>
            <InlineStack align="space-between" blockAlign="center">
              <InlineStack gap="200" blockAlign="center">
                <Text variant="headingMd" as="h2">Overview</Text>
                {locked && <Badge tone="info">Sample data</Badge>}
              </InlineStack>
              <div style={{ minWidth: 180 }}>
                <Select
                  label="Time range"
                  labelHidden
                  options={RANGE_OPTIONS}
                  value={days}
                  onChange={setDays}
                />
              </div>
            </InlineStack>
          </Card>
        </Layout.Section>

        <Layout.Section>
          <InlineStack gap="400" wrap>
            <div style={{ flex: '1 1 200px' }}>
              <MetricCard title="Total returns" value={summary?.totalReturns ?? 0} />
            </div>
            <div style={{ flex: '1 1 200px' }}>
              <MetricCard title="Pending" value={summary?.pendingReturns ?? 0} />
            </div>
            <div style={{ flex: '1 1 200px' }}>
              <MetricCard title="Processed" value={summary?.processedReturns ?? 0} />
            </div>
            <div style={{ flex: '1 1 200px' }}>
              <MetricCard title="Completion rate" value={`${returnRate}%`} />
            </div>
          </InlineStack>
        </Layout.Section>

        <Layout.Section>
          <InlineStack gap="400" wrap>
            <div style={{ flex: '1 1 200px' }}>
              <MetricCard title="Total return value" value={formatGBP(summary?.totalValue)} />
            </div>
            <div style={{ flex: '1 1 200px' }}>
              <MetricCard title="Refunded" value={formatGBP(summary?.refundedValue)} />
            </div>
            <div style={{ flex: '1 1 200px' }}>
              <MetricCard title="Revenue retained" value={formatGBP(summary?.revenueRetained)} />
            </div>
            <div style={{ flex: '1 1 200px' }}>
              <MetricCard
                title="Top reason"
                value={topReason ? REASON_LABELS[topReason] || topReason : '—'}
              />
            </div>
          </InlineStack>
        </Layout.Section>

        <Layout.Section>
          <Card>
            <BlockStack gap="400">
              <Text variant="headingMd" as="h2">Returns over time</Text>
              {trend.length === 0 ? (
                <EmptyState heading="No returns in this range" image="">
                  <p>Try a wider time range to see trends.</p>
                </EmptyState>
              ) : (
                <Box paddingBlockStart="200">
                  <div style={{ width: '100%', height: 280 }}>
                    <ResponsiveContainer>
                      <LineChart data={trend} margin={{ top: 8, right: 16, bottom: 8, left: 0 }}>
                        <CartesianGrid strokeDasharray="3 3" stroke="#e1e3e5" />
                        <XAxis dataKey="label" tick={{ fontSize: 12 }} />
                        <YAxis tick={{ fontSize: 12 }} allowDecimals={false} />
                        <Tooltip
                          formatter={(value, name) => (name === 'value' ? formatGBP(value) : value)}
                          labelFormatter={(label) => `Date: ${label}`}
                        />
                        <Legend />
                        <Line
                          type="monotone"
                          dataKey="count"
                          name="Returns"
                          stroke="#5C6AC4"
                          strokeWidth={2}
                          dot={{ r: 3 }}
                          activeDot={{ r: 5 }}
                        />
                        <Line
                          type="monotone"
                          dataKey="value"
                          name="Value (£)"
                          stroke="#50B83C"
                          strokeWidth={2}
                          dot={{ r: 3 }}
                        />
                      </LineChart>
                    </ResponsiveContainer>
                  </div>
                </Box>
              )}
            </BlockStack>
          </Card>
        </Layout.Section>

        <Layout.Section>
          <InlineStack gap="400" wrap>
            <div style={{ flex: '1 1 360px' }}>
              <Card>
                <BlockStack gap="400">
                  <Text variant="headingMd" as="h2">Reasons breakdown</Text>
                  {reasonChartData.length === 0 ? (
                    <EmptyState heading="No reasons yet" image="">
                      <p>Reason data will appear once returns are submitted.</p>
                    </EmptyState>
                  ) : (
                    <div style={{ width: '100%', height: 280 }}>
                      <ResponsiveContainer>
                        <BarChart
                          data={reasonChartData}
                          layout="vertical"
                          margin={{ top: 8, right: 16, bottom: 8, left: 16 }}
                        >
                          <CartesianGrid strokeDasharray="3 3" stroke="#e1e3e5" />
                          <XAxis type="number" tick={{ fontSize: 12 }} allowDecimals={false} />
                          <YAxis dataKey="reason" type="category" tick={{ fontSize: 12 }} width={120} />
                          <Tooltip />
                          <Bar dataKey="count" fill="#5C6AC4" radius={[0, 4, 4, 0]} />
                        </BarChart>
                      </ResponsiveContainer>
                    </div>
                  )}
                </BlockStack>
              </Card>
            </div>

            <div style={{ flex: '1 1 360px' }}>
              <Card>
                <BlockStack gap="400">
                  <Text variant="headingMd" as="h2">Top returned products</Text>
                  {skus.length === 0 ? (
                    <EmptyState heading="No data yet" image="">
                      <p>Top returned items will appear here.</p>
                    </EmptyState>
                  ) : (
                    <DataTable
                      columnContentTypes={['text', 'numeric', 'numeric', 'text']}
                      headings={['Product', 'Returns', 'Qty', 'Top reason']}
                      rows={skus.map((s) => {
                        const top = Object.entries(s.reasonBreakdown || {})
                          .sort((a, b) => b[1] - a[1])[0];
                        return [
                          <Text as="span" fontWeight="medium">
                            {s.productTitle || s.sku || '—'}
                          </Text>,
                          s.totalReturns,
                          s.totalQuantity,
                          top ? (
                            <Badge>{REASON_LABELS[top[0]] || top[0]}</Badge>
                          ) : '—',
                        ];
                      })}
                    />
                  )}
                </BlockStack>
              </Card>
            </div>
          </InlineStack>
        </Layout.Section>
      </Layout>
      <AppFooter />
    </Page>
  );
}
