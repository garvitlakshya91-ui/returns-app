import { useState, useEffect } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import {
  Page,
  Layout,
  Card,
  Text,
  BlockStack,
  InlineStack,
  Button,
  Spinner,
  Banner,
  Modal,
  TextField,
  Divider,
  Box,
  List,
  Badge,
} from '@shopify/polaris';
import ReturnStatusBadge from '../components/ReturnStatusBadge';
import { returnsApi } from '../api';

const REASON_LABELS = {
  doesnt_fit: "Doesn't fit",
  changed_mind: 'Changed my mind',
  not_as_described: 'Not as described',
  damaged: 'Arrived damaged',
  wrong_item: 'Wrong item received',
  quality: 'Quality not as expected',
  other: 'Other',
};

const RESOLUTION_LABELS = {
  REFUND: 'Refund to original payment',
  STORE_CREDIT: 'Store credit (gift card)',
  EXCHANGE: 'Exchange',
  KEEP_ITEM: 'Keep item (no return needed)',
};

export default function ReturnDetailPage() {
  const { id } = useParams();
  const navigate = useNavigate();
  const [ret, setReturn] = useState(null);
  const [loading, setLoading] = useState(true);
  const [actionLoading, setActionLoading] = useState('');
  const [rejectModalOpen, setRejectModalOpen] = useState(false);
  const [rejectReason, setRejectReason] = useState('');
  const [banner, setBanner] = useState(null);

  useEffect(() => {
    loadReturn();
  }, [id]);

  async function loadReturn() {
    try {
      const data = await returnsApi.get(id);
      setReturn(data);
    } catch (err) {
      console.error('Load return error:', err);
      setBanner({ title: 'Failed to load return', tone: 'critical' });
    } finally {
      setLoading(false);
    }
  }

  async function handleApprove() {
    setActionLoading('approve');
    try {
      await returnsApi.approve(id);
      setBanner({ title: 'Return approved — label is being generated', tone: 'success' });
      loadReturn();
    } catch (err) {
      setBanner({ title: `Approval failed: ${err.message}`, tone: 'critical' });
    } finally {
      setActionLoading('');
    }
  }

  async function handleReject() {
    setActionLoading('reject');
    try {
      await returnsApi.reject(id, rejectReason);
      setRejectModalOpen(false);
      setBanner({ title: 'Return rejected', tone: 'warning' });
      loadReturn();
    } catch (err) {
      setBanner({ title: `Rejection failed: ${err.message}`, tone: 'critical' });
    } finally {
      setActionLoading('');
    }
  }

  async function handleProcess() {
    setActionLoading('process');
    try {
      await returnsApi.process(id);
      setBanner({ title: 'Refund processed successfully', tone: 'success' });
      loadReturn();
    } catch (err) {
      setBanner({ title: `Processing failed: ${err.message}`, tone: 'critical' });
    } finally {
      setActionLoading('');
    }
  }

  if (loading) {
    return (
      <Page title="Return Details" backAction={{ onAction: () => navigate('/returns') }}>
        <div style={{ display: 'flex', justifyContent: 'center', padding: '60px' }}>
          <Spinner size="large" />
        </div>
      </Page>
    );
  }

  if (!ret) {
    return (
      <Page title="Return Not Found" backAction={{ onAction: () => navigate('/returns') }}>
        <Banner tone="critical" title="Return not found" />
      </Page>
    );
  }

  const canApprove = ret.status === 'REQUESTED';
  const canProcess = ['RECEIVED', 'INSPECTING', 'APPROVED', 'LABEL_SENT', 'IN_TRANSIT'].includes(ret.status);

  return (
    <Page
      title={`Return — ${ret.shopifyOrderName}`}
      subtitle={`${ret.customerName} (${ret.customerEmail})`}
      backAction={{ onAction: () => navigate('/returns') }}
      primaryAction={canApprove ? {
        content: 'Approve',
        onAction: handleApprove,
        loading: actionLoading === 'approve',
      } : canProcess ? {
        content: 'Process Refund',
        onAction: handleProcess,
        loading: actionLoading === 'process',
      } : undefined}
      secondaryActions={canApprove ? [{
        content: 'Reject',
        destructive: true,
        onAction: () => setRejectModalOpen(true),
      }] : []}
    >
      <Layout>
        {banner && (
          <Layout.Section>
            <Banner tone={banner.tone} title={banner.title} onDismiss={() => setBanner(null)} />
          </Layout.Section>
        )}

        {/* Status & summary */}
        <Layout.Section>
          <Card>
            <BlockStack gap="400">
              <InlineStack align="space-between">
                <Text variant="headingMd" as="h2">Status</Text>
                <ReturnStatusBadge status={ret.status} />
              </InlineStack>
              <InlineStack gap="800">
                <BlockStack gap="100">
                  <Text tone="subdued" variant="bodySm">Resolution</Text>
                  <Text>{RESOLUTION_LABELS[ret.resolution] || ret.resolution || 'Pending'}</Text>
                </BlockStack>
                <BlockStack gap="100">
                  <Text tone="subdued" variant="bodySm">Total Value</Text>
                  <Text>{'\u00A3'}{Number(ret.totalValue).toFixed(2)}</Text>
                </BlockStack>
                <BlockStack gap="100">
                  <Text tone="subdued" variant="bodySm">Refund Amount</Text>
                  <Text>{ret.refundAmount ? `£${Number(ret.refundAmount).toFixed(2)}` : '—'}</Text>
                </BlockStack>
                <BlockStack gap="100">
                  <Text tone="subdued" variant="bodySm">Created</Text>
                  <Text>{new Date(ret.createdAt).toLocaleString('en-GB')}</Text>
                </BlockStack>
              </InlineStack>
            </BlockStack>
          </Card>
        </Layout.Section>

        {/* Items */}
        <Layout.Section>
          <Card>
            <BlockStack gap="400">
              <Text variant="headingMd" as="h2">Items ({ret.items?.length || 0})</Text>
              {(ret.items || []).map((item) => (
                <Box key={item.id} padding="300" borderWidth="025" borderColor="border" borderRadius="200">
                  <InlineStack align="space-between" wrap={false}>
                    <BlockStack gap="100">
                      <Text variant="bodyMd" fontWeight="semibold">{item.productTitle}</Text>
                      {item.variantTitle && <Text tone="subdued" variant="bodySm">{item.variantTitle}</Text>}
                      <InlineStack gap="200">
                        <Badge>{REASON_LABELS[item.reason] || item.reason}</Badge>
                        <Text variant="bodySm" tone="subdued">Qty: {item.quantity}</Text>
                      </InlineStack>
                      {item.reasonDetail && (
                        <Text variant="bodySm" tone="subdued">"{item.reasonDetail}"</Text>
                      )}
                    </BlockStack>
                    <Text variant="bodyMd" fontWeight="semibold">
                      {'\u00A3'}{Number(item.unitPrice).toFixed(2)}
                    </Text>
                  </InlineStack>
                </Box>
              ))}
            </BlockStack>
          </Card>
        </Layout.Section>

        {/* Label info */}
        {ret.label && (
          <Layout.Section variant="oneThird">
            <Card>
              <BlockStack gap="300">
                <Text variant="headingMd" as="h2">Shipping Label</Text>
                <List>
                  <List.Item>Carrier: {ret.label.carrier}</List.Item>
                  <List.Item>Tracking: {ret.label.trackingCode || '—'}</List.Item>
                  <List.Item>Status: {ret.label.status}</List.Item>
                </List>

                {ret.label.qrCodeUrl && (
                  <BlockStack gap="200">
                    <Text variant="bodySm" tone="subdued">QR code (show at drop-off)</Text>
                    <Box
                      borderWidth="025"
                      borderColor="border"
                      borderRadius="200"
                      padding="200"
                      background="bg-surface-secondary"
                    >
                      <img
                        src={ret.label.qrCodeUrl}
                        alt="Return QR code"
                        style={{ width: '100%', maxWidth: 240, display: 'block', margin: '0 auto' }}
                      />
                    </Box>
                  </BlockStack>
                )}

                {ret.label.labelUrl && (
                  <Button
                    url={ret.label.labelUrl}
                    target="_blank"
                    variant="primary"
                    fullWidth
                  >
                    Download label PDF
                  </Button>
                )}
              </BlockStack>
            </Card>
          </Layout.Section>
        )}

        {/* Events timeline */}
        <Layout.Section variant="oneThird">
          <Card>
            <BlockStack gap="300">
              <Text variant="headingMd" as="h2">Timeline</Text>
              {(ret.events || []).length === 0 ? (
                <Text tone="subdued">No events yet</Text>
              ) : (
                <BlockStack gap="200">
                  {(ret.events || []).map((event) => (
                    <Box key={event.id}>
                      <InlineStack gap="200">
                        <Text variant="bodySm" tone="subdued">
                          {new Date(event.createdAt).toLocaleString('en-GB', { dateStyle: 'short', timeStyle: 'short' })}
                        </Text>
                        <Text variant="bodySm">{event.type.replace('.', ' — ')}</Text>
                      </InlineStack>
                    </Box>
                  ))}
                </BlockStack>
              )}
            </BlockStack>
          </Card>
        </Layout.Section>
      </Layout>

      {/* Reject modal */}
      <Modal
        open={rejectModalOpen}
        onClose={() => setRejectModalOpen(false)}
        title="Reject Return"
        primaryAction={{
          content: 'Reject',
          destructive: true,
          onAction: handleReject,
          loading: actionLoading === 'reject',
        }}
        secondaryActions={[{ content: 'Cancel', onAction: () => setRejectModalOpen(false) }]}
      >
        <Modal.Section>
          <TextField
            label="Reason for rejection"
            value={rejectReason}
            onChange={setRejectReason}
            multiline={3}
            placeholder="e.g. Item is outside the return window"
            autoComplete="off"
          />
        </Modal.Section>
      </Modal>
    </Page>
  );
}
