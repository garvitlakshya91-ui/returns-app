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
import AppFooter from '../components/AppFooter';
import { returnsApi } from '../api';

export default function DashboardPage() {
  const navigate = useNavigate();
  const [loading, setLoading] = useState(true);
  const [recentReturns, setRecentReturns] = useState([]);
  const [stats, setStats] = useState({ total: 0, pending: 0, processed: 0, value: 0 });

  useEffect(() => {
    loadData();
  }, []);

  async function loadData() {
    try {
      const data = await returnsApi.list({ limit: 5 });
      setRecentReturns(data.returns || []);

      // Calculate stats from returns
      const all = data.returns || [];
      setStats({
        total: data.total || all.length,
        pending: all.filter((r) => r.status === 'REQUESTED').length,
        processed: all.filter((r) => r.status === 'PROCESSED').length,
        value: all.reduce((sum, r) => sum + Number(r.totalValue || 0), 0),
      });
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
      {/* First-run welcome (plays the tour, shows once) */}
      <WelcomeModal />
      <Layout>
        {/* First-run onboarding checklist (hides itself once dismissed) */}
        <Layout.Section>
          <SetupGuide />
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
              <MetricCard title="Return Value" value={`£${stats.value.toFixed(2)}`} icon={CashDollarIcon} tone="default" />
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
                    `£${Number(r.totalValue).toFixed(2)}`,
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
