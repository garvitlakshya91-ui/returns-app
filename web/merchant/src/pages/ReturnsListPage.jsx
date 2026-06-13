import { useState, useEffect, useCallback } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  Page,
  Card,
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
import { returnsApi } from '../api';

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

  const resourceName = { singular: 'return', plural: 'returns' };
  const { selectedResources, allResourcesSelected, handleSelectionChange } =
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
      <IndexTable.Cell>{'\u00A3'}{Number(ret.totalValue).toFixed(2)}</IndexTable.Cell>
      <IndexTable.Cell>
        {new Date(ret.createdAt).toLocaleDateString('en-GB')}
      </IndexTable.Cell>
    </IndexTable.Row>
  ));

  return (
    <Page title="Returns" fullWidth>
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
          <EmptyState heading="No returns found" image="">
            <p>Returns from your customers will appear here once they submit a request through your returns portal.</p>
          </EmptyState>
        ) : (
          <>
            <IndexTable
              resourceName={resourceName}
              itemCount={returns.length}
              selectedItemsCount={allResourcesSelected ? 'All' : selectedResources.length}
              onSelectionChange={handleSelectionChange}
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
    </Page>
  );
}
