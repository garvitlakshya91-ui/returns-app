import { useState, useEffect, useCallback } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  Page,
  Card,
  Banner,
  IndexTable,
  Text,
  Filters,
  ChoiceList,
  Pagination,
  Spinner,
  EmptyState,
  useIndexResourceState,
} from '@shopify/polaris';
import ReturnStatusBadge from '../components/ReturnStatusBadge';
import AppFooter from '../components/AppFooter';
import { returnsApi } from '../api';
import { formatMoney } from '../money';

const STATUS_OPTIONS = [
  { label: 'Requested', value: 'REQUESTED' },
  { label: 'Approved', value: 'APPROVED' },
  { label: 'Label Sent', value: 'LABEL_SENT' },
  { label: 'In Transit', value: 'IN_TRANSIT' },
  { label: 'Received', value: 'RECEIVED' },
  { label: 'Processed', value: 'PROCESSED' },
  { label: 'Rejected', value: 'REJECTED' },
];

export default function ReturnsListPage() {
  const navigate = useNavigate();
  const [loading, setLoading] = useState(true);
  const [returns, setReturns] = useState([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [statusFilter, setStatusFilter] = useState([]);
  const [queryValue, setQueryValue] = useState('');
  const [bulkLoading, setBulkLoading] = useState(false);
  const [bulkError, setBulkError] = useState(null);
  const [demoLoading, setDemoLoading] = useState(false);

  const resourceName = { singular: 'return', plural: 'returns' };
  const { selectedResources, allResourcesSelected, handleSelectionChange, clearSelection } =
    useIndexResourceState(returns);

  const loadReturns = useCallback(async () => {
    setLoading(true);
    try {
      const params = { page, limit: 20 };
      if (statusFilter.length === 1) params.status = statusFilter[0];
      const data = await returnsApi.list(params);
      setReturns(data.returns || []);
      setTotal(data.total || 0);
    } catch (err) {
      console.error('Load returns error:', err);
    } finally {
      setLoading(false);
    }
  }, [page, statusFilter]);

  useEffect(() => {
    loadReturns();
  }, [loadReturns]);

  async function runBulk(action, reason) {
    if (!selectedResources.length) return;
    setBulkLoading(true);
    setBulkError('');
    try {
      const result = await returnsApi.bulk(action, selectedResources, reason);
      clearSelection();
      await loadReturns();
      // Some returns can be skipped for a reason the merchant must act on
      // (today: an order with no shipping address). Say so, not just a count.
      const noAddress = Object.values(result?.reasons || {}).filter((r) => r === 'ORDER_ADDRESS_MISSING').length;
      if (noAddress > 0) {
        setBulkError({
          message: `${noAddress} return${noAddress === 1 ? ' was' : 's were'} not approved: the order has no shipping address to book a label from. Open each one to approve it without a label.`,
          code: 'ORDER_ADDRESS_MISSING',
          planUrl: null,
        });
      }
    } catch (err) {
      console.error('Bulk action error:', err);
      setBulkError({ message: err.message || 'Bulk action failed', code: err.code || null, planUrl: err.planUrl || null });
    } finally {
      setBulkLoading(false);
    }
  }

  // Where each refusal is fixed.
  function bulkErrorAction(e) {
    if (e.code === 'RETURNS_ADDRESS_MISSING' || /returns address/i.test(e.message)) return { content: 'Set returns address', onAction: () => navigate('/settings') };
    if (e.code === 'LABEL_SOURCE_MISSING') return { content: 'Turn on managed labels', onAction: () => navigate('/') };
    if (e.code === 'LABEL_BILLING' && e.planUrl) return { content: 'Choose a plan', url: e.planUrl, external: true };
    if (e.code === 'ORDER_ADDRESS_MISSING') return { content: 'Show requested returns', onAction: () => setStatusFilter(['REQUESTED']) };
    return undefined;
  }

  async function handleDemo() {
    setDemoLoading(true);
    try {
      await returnsApi.demo();
      setStatusFilter([]);
      setPage(1);
      await loadReturns();
    } catch (err) {
      console.error('Demo return error:', err);
    } finally {
      setDemoLoading(false);
    }
  }

  const promotedBulkActions = [
    { content: 'Approve', onAction: () => runBulk('approve') },
    { content: 'Reject', onAction: () => runBulk('reject', 'Rejected by merchant') },
    { content: 'Process refund', onAction: () => runBulk('process') },
  ];

  const filters = [
    {
      key: 'status',
      label: 'Status',
      filter: (
        <ChoiceList
          title="Status"
          titleHidden
          choices={STATUS_OPTIONS}
          selected={statusFilter}
          onChange={setStatusFilter}
        />
      ),
      shortcut: true,
    },
  ];

  const rowMarkup = returns.map((ret, index) => (
    <IndexTable.Row
      id={ret.id}
      key={ret.id}
      position={index}
      selected={selectedResources.includes(ret.id)}
      onClick={() => navigate(`/returns/${ret.id}`)}
    >
      <IndexTable.Cell>
        <Text variant="bodyMd" fontWeight="bold">{ret.shopifyOrderName}</Text>
      </IndexTable.Cell>
      <IndexTable.Cell>{ret.customerName}</IndexTable.Cell>
      <IndexTable.Cell>{ret.customerEmail}</IndexTable.Cell>
      <IndexTable.Cell>
        <ReturnStatusBadge status={ret.status} />
      </IndexTable.Cell>
      <IndexTable.Cell>
        {ret.items?.length || 0} item{(ret.items?.length || 0) !== 1 ? 's' : ''}
      </IndexTable.Cell>
      <IndexTable.Cell>{formatMoney(ret.totalValue, ret.currency)}</IndexTable.Cell>
      <IndexTable.Cell>
        {new Date(ret.createdAt).toLocaleDateString('en-GB')}
      </IndexTable.Cell>
    </IndexTable.Row>
  ));

  return (
    <Page
      title="Returns"
      fullWidth
      primaryAction={{ content: 'Create test return', onAction: handleDemo, loading: demoLoading }}
    >
      {bulkError && (
        <div style={{ marginBottom: '16px' }}>
          <Banner
            tone={bulkErrorAction(bulkError) ? 'warning' : 'critical'}
            title={bulkError.message}
            action={bulkErrorAction(bulkError)}
            onDismiss={() => setBulkError(null)}
          />
        </div>
      )}
      <Card padding="0">
        <Filters
          queryValue={queryValue}
          queryPlaceholder="Search returns..."
          onQueryChange={setQueryValue}
          onQueryClear={() => setQueryValue('')}
          filters={filters}
          onClearAll={() => setStatusFilter([])}
        />
        {loading ? (
          <div style={{ display: 'flex', justifyContent: 'center', padding: '40px' }}>
            <Spinner size="large" />
          </div>
        ) : returns.length === 0 ? (
          <EmptyState
            heading="No returns found"
            image=""
            action={{ content: 'Create test return', onAction: handleDemo, loading: demoLoading }}
          >
            <p>Returns from your customers will appear here once they submit a request through your returns portal. Want to see how it works? Create a test return.</p>
          </EmptyState>
        ) : (
          <>
            <IndexTable
              resourceName={resourceName}
              itemCount={returns.length}
              selectedItemsCount={allResourcesSelected ? 'All' : selectedResources.length}
              onSelectionChange={handleSelectionChange}
              promotedBulkActions={promotedBulkActions}
              loading={bulkLoading}
              headings={[
                { title: 'Order' },
                { title: 'Customer' },
                { title: 'Email' },
                { title: 'Status' },
                { title: 'Items' },
                { title: 'Value' },
                { title: 'Date' },
              ]}
            >
              {rowMarkup}
            </IndexTable>
            <div style={{ display: 'flex', justifyContent: 'center', padding: '16px' }}>
              <Pagination
                hasPrevious={page > 1}
                hasNext={page * 20 < total}
                onPrevious={() => setPage((p) => p - 1)}
                onNext={() => setPage((p) => p + 1)}
              />
            </div>
          </>
        )}
      </Card>
      <AppFooter />
    </Page>
  );
}
