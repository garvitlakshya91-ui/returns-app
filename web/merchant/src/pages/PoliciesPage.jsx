import { useState, useEffect } from 'react';
import {
  Page,
  Layout,
  Card,
  Text,
  BlockStack,
  InlineStack,
  Button,
  TextField,
  Select,
  Checkbox,
  Banner,
  Spinner,
  ResourceList,
  ResourceItem,
  Badge,
  Modal,
} from '@shopify/polaris';
import { policiesApi } from '../api';

export default function PoliciesPage() {
  const [loading, setLoading] = useState(true);
  const [policies, setPolicies] = useState([]);
  const [modalOpen, setModalOpen] = useState(false);
  const [saving, setSaving] = useState(false);
  const [banner, setBanner] = useState(null);

  // New policy form
  const [form, setForm] = useState({
    name: '',
    windowDays: '30',
    allowRefund: true,
    allowStoreCredit: true,
    allowExchange: false,
    isDefault: false,
  });

  useEffect(() => {
    loadPolicies();
  }, []);

  async function loadPolicies() {
    try {
      const data = await policiesApi.list();
      setPolicies(data);
    } catch (err) {
      console.error('Load policies error:', err);
    } finally {
      setLoading(false);
    }
  }

  async function handleCreate() {
    setSaving(true);
    try {
      await policiesApi.create({
        name: form.name,
        windowDays: parseInt(form.windowDays, 10),
        resolutions: {
          allowRefund: form.allowRefund,
          allowStoreCredit: form.allowStoreCredit,
          allowExchange: form.allowExchange,
        },
        isDefault: form.isDefault,
      });
      setModalOpen(false);
      setBanner({ title: 'Policy created', tone: 'success' });
      setForm({ name: '', windowDays: '30', allowRefund: true, allowStoreCredit: true, allowExchange: false, isDefault: false });
      loadPolicies();
    } catch (err) {
      setBanner({ title: `Failed: ${err.message}`, tone: 'critical' });
    } finally {
      setSaving(false);
    }
  }

  if (loading) {
    return (
      <Page title="Return Policies">
        <div style={{ display: 'flex', justifyContent: 'center', padding: '60px' }}>
          <Spinner size="large" />
        </div>
      </Page>
    );
  }

  return (
    <Page
      title="Return Policies"
      primaryAction={{ content: 'Create policy', onAction: () => setModalOpen(true) }}
    >
      <Layout>
        {banner && (
          <Layout.Section>
            <Banner tone={banner.tone} title={banner.title} onDismiss={() => setBanner(null)} />
          </Layout.Section>
        )}

        <Layout.Section>
          <Card>
            {policies.length === 0 ? (
              <BlockStack gap="300" inlineAlign="center">
                <Text tone="subdued">No policies configured yet. Create your first return policy.</Text>
                <Button onClick={() => setModalOpen(true)}>Create policy</Button>
              </BlockStack>
            ) : (
              <ResourceList
                resourceName={{ singular: 'policy', plural: 'policies' }}
                items={policies}
                renderItem={(policy) => (
                  <ResourceItem id={policy.id}>
                    <InlineStack align="space-between">
                      <BlockStack gap="100">
                        <InlineStack gap="200">
                          <Text variant="bodyMd" fontWeight="semibold">{policy.name}</Text>
                          {policy.isDefault && <Badge tone="info">Default</Badge>}
                          <Badge>{policy.isActive ? 'Active' : 'Inactive'}</Badge>
                        </InlineStack>
                        <Text variant="bodySm" tone="subdued">
                          {policy.windowDays}-day return window
                        </Text>
                      </BlockStack>
                    </InlineStack>
                  </ResourceItem>
                )}
              />
            )}
          </Card>
        </Layout.Section>
      </Layout>

      {/* Create policy modal */}
      <Modal
        open={modalOpen}
        onClose={() => setModalOpen(false)}
        title="Create Return Policy"
        primaryAction={{ content: 'Create', onAction: handleCreate, loading: saving }}
        secondaryActions={[{ content: 'Cancel', onAction: () => setModalOpen(false) }]}
      >
        <Modal.Section>
          <BlockStack gap="400">
            <TextField
              label="Policy name"
              value={form.name}
              onChange={(v) => setForm((f) => ({ ...f, name: v }))}
              placeholder="e.g. Standard 30-day returns"
              autoComplete="off"
            />
            <TextField
              label="Return window (days)"
              type="number"
              value={form.windowDays}
              onChange={(v) => setForm((f) => ({ ...f, windowDays: v }))}
              autoComplete="off"
            />
            <Text variant="headingSm">Allowed resolutions</Text>
            <Checkbox
              label="Refund to original payment"
              checked={form.allowRefund}
              onChange={(v) => setForm((f) => ({ ...f, allowRefund: v }))}
            />
            <Checkbox
              label="Store credit (gift card)"
              checked={form.allowStoreCredit}
              onChange={(v) => setForm((f) => ({ ...f, allowStoreCredit: v }))}
            />
            <Checkbox
              label="Exchange for another item"
              checked={form.allowExchange}
              onChange={(v) => setForm((f) => ({ ...f, allowExchange: v }))}
            />
            <Checkbox
              label="Set as default policy"
              checked={form.isDefault}
              onChange={(v) => setForm((f) => ({ ...f, isDefault: v }))}
            />
          </BlockStack>
        </Modal.Section>
      </Modal>
    </Page>
  );
}
