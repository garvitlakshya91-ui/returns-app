import { useState, useEffect, useCallback } from 'react';
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
import { formatMoney } from '../money';

// Stored carrier codes → display names.
// What each label state means to a merchant.
const LABEL_STATUS_TEXT = {
  pending: 'Being generated',
  buying: 'Being bought from the carrier',
  saved: 'Bought — customer not yet emailed',
  created: 'Sent to the customer',
};

const CARRIER_NAMES = { royalmail: 'Royal Mail', evri: 'Evri', inpost: 'InPost', dpd: 'DPD', dpduk: 'DPD', ups: 'UPS', dhl: 'DHL', yodel: 'Yodel', parcelforce: 'Parcelforce', shippo: 'Shippo', shipengine: 'ShipEngine' };

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
  STORE_CREDIT: 'Store credit',
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

  const loadReturn = useCallback(async () => {
    await fetchReturn();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id]);

  useEffect(() => {
    loadReturn();
  }, [loadReturn]);

  async function fetchReturn() {
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
      // No returns address yet: send the merchant straight to where it is set.
      const needsAddress = /returns address/i.test(err.message || '');
      setBanner({
        title: needsAddress ? err.message : `Approval failed: ${err.message}`,
        tone: needsAddress ? 'warning' : 'critical',
        action: needsAddress ? { content: 'Set returns address', onAction: () => navigate('/settings') } : undefined,
      });
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

  async function handleGenerateLabel() {
    setActionLoading('label');
    try {
      const label = await returnsApi.generateLabel(id);
      const tracking = label?.trackingCode ? ` (tracking ${label.trackingCode})` : '';
      // 'created' means every step ran, including the customer's email.
      // Anything else: the label exists but the email did not go out yet.
      if (label?.status === 'created') {
        setBanner({ title: `Label ready${tracking}. The customer has been emailed.`, tone: 'success' });
      } else {
        setBanner({ title: `Label bought${tracking}, but the customer could not be emailed yet. Use "Finish label" to try again.`, tone: 'warning' });
      }
      loadReturn();
    } catch (err) {
      setBanner({ title: `Label failed: ${err.message}`, tone: 'critical' });
      loadReturn();
    } finally {
      setActionLoading('');
    }
  }

  async function handleProcess() {
    setActionLoading('process');
    try {
      const result = await returnsApi.process(id);
      // Say what Shopify actually did, not what was asked for.
      const money = (n) => new Intl.NumberFormat('en-GB', { style: 'currency', currency: ret?.currency || 'GBP' }).format(Number(n || 0));
      const what = result?.type === 'STORE_CREDIT'
        ? `${money(result.amount)} issued as store credit`
        : result?.type === 'EXCHANGE'
          ? 'Exchange order created'
          : `${money(result.amount)} refunded to the original payment`;
      const shortfall = result?.requestedAmount != null && Number(result.amount) < Number(result.requestedAmount)
        ? ` (Shopify allowed less than the ${money(result.requestedAmount)} expected)`
        : '';
      const note = result?.reconciled ? ' — matched to a refund Shopify already had' : '';
      setBanner({ title: `${what}${shortfall}${note}`, tone: 'success' });
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

  // A test return ("Create test return") has no real Shopify order behind
  // it, so it can't get a carrier label and the server refuses to approve it.
  const isTest = !String(ret.shopifyOrderId || '').startsWith('gid://shopify/Order/');
  const canApprove = ret.status === 'REQUESTED' && !isTest;
  // The label is not finished: none yet, an attempt that failed or crashed
  // ('pending'/'buying' left behind — stale after 10 minutes), or bought but
  // a follow-up step (customer email, postage charge) did not finish
  // ('saved'). All of these can be retried; LabelService resumes safely and
  // never buys twice. Only a label from the last few minutes is left alone.
  const labelStatus = ret.label?.status;
  const labelAgeMin = ret.label?.createdAt ? (Date.now() - new Date(ret.label.createdAt).getTime()) / 60000 : Infinity;
  const labelInProgress = ['pending', 'buying'].includes(labelStatus) && labelAgeMin < 10;
  const needsLabel = ['APPROVED', 'LABEL_SENT'].includes(ret.status) && labelStatus !== 'created' && !labelInProgress;
  const labelAction = !ret.label ? 'Generate label' : labelStatus === 'saved' ? 'Finish label' : 'Retry label';
  const lastLabelFailure = (ret.events || []).find((e) => e.type === 'label.failed')?.data?.error;
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
      }] : needsLabel ? [{
        content: labelAction,
        onAction: handleGenerateLabel,
        loading: actionLoading === 'label',
      }] : []}
    >
      <Layout>
        {banner && (
          <Layout.Section>
            <Banner tone={banner.tone} title={banner.title} action={banner.action} onDismiss={() => setBanner(null)} />
          </Layout.Section>
        )}
        {isTest && !banner && (
          <Layout.Section>
            <Banner tone="info" title="This is a test return">
              <p>It shows how a return looks in ReturnFlow. It can't be approved, because approving books a real carrier label, which needs a real order and customer address. To try the full flow, place an order in your store and start a return from your returns portal.</p>
            </Banner>
          </Layout.Section>
        )}
        {needsLabel && !banner && labelStatus === 'saved' && (
          <Layout.Section>
            <Banner tone="warning" title="The label was bought but not sent to the customer">
              <p>A step after the purchase did not finish (the customer's email, or the postage charge). Nothing is lost: use "Finish label" to complete it. It is also retried automatically every 30 minutes.</p>
            </Banner>
          </Layout.Section>
        )}
        {needsLabel && !banner && labelStatus !== 'saved' && (
          <Layout.Section>
            <Banner tone="warning" title="No label has been sent for this return">
              <p>{lastLabelFailure || (ret.label ? 'The last attempt did not finish.' : 'The label has not been generated yet.')} Fix the cause, then use "{labelAction}".</p>
            </Banner>
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
                  <Text>{formatMoney(ret.totalValue, ret.currency)}</Text>
                </BlockStack>
                <BlockStack gap="100">
                  <Text tone="subdued" variant="bodySm">Refund Amount</Text>
                  <Text>{ret.refundAmount ? formatMoney(ret.refundAmount, ret.currency) : '—'}</Text>
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
                  <List.Item>Carrier: {CARRIER_NAMES[ret.label.carrier] || ret.label.carrier}</List.Item>
                  <List.Item>Tracking: {ret.label.trackingCode || '—'}</List.Item>
                  <List.Item>Status: {LABEL_STATUS_TEXT[ret.label.status] || ret.label.status}</List.Item>
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
                      {event.data?.error && (
                        <Text variant="bodySm" tone="critical">{event.data.error}</Text>
                      )}
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
