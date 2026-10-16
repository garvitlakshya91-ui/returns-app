import { useState, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  Page,
  Layout,
  Card,
  Text,
  BlockStack,
  InlineStack,
  Button,
  DataTable,
  EmptyState,
  SkeletonPage,
  SkeletonBodyText,
} from '@shopify/polaris';
import { OrderIcon, ClockIcon, CheckCircleIcon, CashDollarIcon } from '@shopify/polaris-icons';
import MetricCard from '../components/MetricCard';
import ReturnStatusBadge from '../components/ReturnStatusBadge';
import SetupGuide from '../components/SetupGuide';
import WelcomeModal from '../components/WelcomeModal';
import ReviewPrompt from '../components/ReviewPrompt';
import ManagedLabelsCard from '../components/ManagedLabelsCard';
import AppFooter from '../components/AppFooter';
import { returnsApi } from '../api';
import { formatMoney } from '../money';

export default function DashboardPage() {
  const navigate = useNavigate();
  const [loading, setLoading] = useState(true);
  const [recentReturns, setRecentReturns] = useState([]);
  const [stats, setStats] = useState({ total: 0, pending: 0, processed: 0, totalValue: 0, currency: 'GBP' });

  useEffect(() => {
    loadData();
  }, []);

  async function loadData() {
    try {
      // Totals come from every return the shop has; the table shows the latest five.
      const [data, totals] = await Promise.all([returnsApi.list({ limit: 5 }), returnsApi.stats()]);
      setRecentReturns(data.returns || []);
      setStats(totals);
    } catch (err) {
      console.error('Dashboard load error:', err);
      // Show empty state in dev
    } finally {
      setLoading(false);
    }
  }

  if (loading) {
    return (
      <SkeletonPage title="Dashboard">
        <Layout>
          <Layout.Section>
            <Card><SkeletonBodyText lines={2} /></Card>
          </Layout.Section>
          <Layout.Section>
            <Card><SkeletonBodyText lines={5} /></Card>
          </Layout.Section>
        </Layout>
      </SkeletonPage>
    );
  }

  return (
    <Page title="Dashboard">
      <Layout>
        {/* First-run welcome banner + tour (shows once) */}
        <Layout.Section>
          <WelcomeModal />
        </Layout.Section>
        {/* One-time review ask after the 3rd processed return */}
        <Layout.Section>
          <ReviewPrompt />
        </Layout.Section>
        {/* First-run onboarding checklist (hides itself once dismissed) */}
        <Layout.Section>
          <SetupGuide />
        </Layout.Section>

        {/* Promote one-click managed labels (hides once enabled) */}
        <Layout.Section>
          <ManagedLabelsCard />
        </Layout.Section>

        {/* Metrics row */}
        <Layout.Section>
          <InlineStack gap="400" wrap={false}>
            <div style={{ flex: 1 }}>
              <MetricCard title="Total Returns" value={stats.total} icon={OrderIcon} tone="default" />
            </div>
            <div style={{ flex: 1 }}>
              <MetricCard title="Pending Review" value={stats.pending} icon={ClockIcon} tone="warning" />
            </div>
            <div style={{ flex: 1 }}>
              <MetricCard title="Processed" value={stats.processed} icon={CheckCircleIcon} tone="success" />
            </div>
            <div style={{ flex: 1 }}>
              <MetricCard title="Return Value" value={formatMoney(stats.totalValue, stats.currency)} icon={CashDollarIcon} tone="default" />
            </div>
          </InlineStack>
        </Layout.Section>

        {/* Recent returns */}
        <Layout.Section>
          <Card>
            <BlockStack gap="400">
              <InlineStack align="space-between">
                <Text variant="headingMd" as="h2">Recent Returns</Text>
                <Button onClick={() => navigate('/returns')}>View all</Button>
              </InlineStack>

              {recentReturns.length === 0 ? (
                <EmptyState
                  heading="No returns yet"
                  image=""
                >
                  <p>Returns from your customers will appear here.</p>
                </EmptyState>
              ) : (
                <DataTable
                  columnContentTypes={['text', 'text', 'text', 'text', 'text']}
                  headings={['Order', 'Customer', 'Status', 'Value', 'Date']}
                  rows={recentReturns.map((r) => [
                    <Button variant="plain" onClick={() => navigate(`/returns/${r.id}`)}>
                      {r.shopifyOrderName}
                    </Button>,
                    r.customerName,
                    <ReturnStatusBadge status={r.status} />,
                    formatMoney(r.totalValue, r.currency),
                    new Date(r.createdAt).toLocaleDateString('en-GB'),
                  ])}
                />
              )}
            </BlockStack>
          </Card>
        </Layout.Section>
      </Layout>
      <AppFooter />
    </Page>
  );
}
