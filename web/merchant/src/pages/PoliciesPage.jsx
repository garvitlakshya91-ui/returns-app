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
  Checkbox,
  Banner,
  ResourceList,
  ResourceItem,
  Badge,
  Modal,
  SkeletonPage,
  SkeletonBodyText,
} from '@shopify/polaris';
import { policiesApi } from '../api';
import AppFooter from '../components/AppFooter';

const EMPTY_FORM = {
  name: '',
  windowDays: '30',
  allowRefund: true,
  allowStoreCredit: true,
  allowExchange: false,
  isDefault: false,
  isActive: true,
  productTags: '',
  collections: '',
  minPrice: '',
  maxPrice: '',
  feeChangedMind: '',
  feeDoesntFit: '',
  feeDamaged: '',
};

const csv = (s) => String(s || '').split(',').map((x) => x.trim()).filter(Boolean);
const num = (s) => (s === '' || s == null ? null : Number(s));

export default function PoliciesPage() {
  const [loading, setLoading] = useState(true);
  const [policies, setPolicies] = useState([]);
  const [modalOpen, setModalOpen] = useState(false);
  const [editingId, setEditingId] = useState(null);
  const [saving, setSaving] = useState(false);
  const [banner, setBanner] = useState(null);
  const [form, setForm] = useState(EMPTY_FORM);

  useEffect(() => { loadPolicies(); }, []);

  async function loadPolicies() {
    try {
      const data = await policiesApi.list();
      setPolicies(Array.isArray(data) ? data : []);
    } catch (err) {
      console.error('Load policies error:', err);
    } finally {
      setLoading(false);
    }
  }

  const set = (key) => (v) => setForm((f) => ({ ...f, [key]: v }));

  function openCreate() {
    setForm(EMPTY_FORM);
    setEditingId(null);
    setModalOpen(true);
  }

  function openEdit(policy) {
    const c = policy.conditions || {};
    const r = policy.resolutions || {};
    const fee = policy.fees || {};
    setForm({
      name: policy.name || '',
      windowDays: String(policy.windowDays ?? 30),
      allowRefund: r.allowRefund ?? true,
      allowStoreCredit: r.allowStoreCredit ?? true,
      allowExchange: r.allowExchange ?? false,
      isDefault: policy.isDefault ?? false,
      isActive: policy.isActive ?? true,
      productTags: (c.productTags || []).join(', '),
      collections: (c.collections || []).join(', '),
      minPrice: c.minPrice != null ? String(c.minPrice) : '',
      maxPrice: c.maxPrice != null ? String(c.maxPrice) : '',
      feeChangedMind: fee.changedMind != null ? String(fee.changedMind) : '',
      feeDoesntFit: fee.doesntFit != null ? String(fee.doesntFit) : '',
      feeDamaged: fee.damaged != null ? String(fee.damaged) : '',
    });
    setEditingId(policy.id);
    setModalOpen(true);
  }

  async function handleSave() {
    setSaving(true);
    try {
      const payload = {
        name: form.name,
        windowDays: parseInt(form.windowDays, 10) || 30,
        conditions: {
          productTags: csv(form.productTags),
          collections: csv(form.collections),
          minPrice: num(form.minPrice),
          maxPrice: num(form.maxPrice),
        },
        resolutions: {
          allowRefund: form.allowRefund,
          allowStoreCredit: form.allowStoreCredit,
          allowExchange: form.allowExchange,
        },
        fees: {
          changedMind: num(form.feeChangedMind) ?? 0,
          doesntFit: num(form.feeDoesntFit) ?? 0,
          damaged: num(form.feeDamaged) ?? 0,
        },
        isDefault: form.isDefault,
        isActive: form.isActive,
      };

      if (editingId) await policiesApi.update(editingId, payload);
      else await policiesApi.create(payload);

      setModalOpen(false);
      setBanner({ title: editingId ? 'Policy updated' : 'Policy created', tone: 'success' });
      loadPolicies();
    } catch (err) {
      setBanner({ title: `Failed: ${err.message}`, tone: 'critical' });
    } finally {
      setSaving(false);
    }
  }

  function conditionSummary(policy) {
    const c = policy.conditions || {};
    const parts = [];
    if (c.productTags?.length) parts.push(`tags: ${c.productTags.join(', ')}`);
    if (c.collections?.length) parts.push(`collections: ${c.collections.join(', ')}`);
    if (c.minPrice != null) parts.push(`min £${c.minPrice}`);
    if (c.maxPrice != null) parts.push(`max £${c.maxPrice}`);
    return parts.length ? parts.join(' · ') : 'Applies to all items';
  }

  if (loading) {
    return (
      <SkeletonPage title="Return Policies">
        <Layout>
          <Layout.Section>
            <Card><SkeletonBodyText lines={4} /></Card>
          </Layout.Section>
        </Layout>
      </SkeletonPage>
    );
  }

  return (
    <Page
      title="Return Policies"
      subtitle="Set rules for what's returnable, how, and any fees — by tag, collection, price or reason."
      primaryAction={{ content: 'Create policy', onAction: openCreate }}
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
                <Text tone="subdued">No policies yet. Create your first return policy.</Text>
                <Button onClick={openCreate}>Create policy</Button>
              </BlockStack>
            ) : (
              <ResourceList
                resourceName={{ singular: 'policy', plural: 'policies' }}
                items={policies}
                renderItem={(policy) => {
                  const r = policy.resolutions || {};
                  return (
                    <ResourceItem id={policy.id} onClick={() => openEdit(policy)}>
                      <BlockStack gap="100">
                        <InlineStack gap="200" blockAlign="center">
                          <Text variant="bodyMd" fontWeight="semibold">{policy.name}</Text>
                          {policy.isDefault && <Badge tone="info">Default</Badge>}
                          <Badge tone={policy.isActive ? 'success' : undefined}>{policy.isActive ? 'Active' : 'Inactive'}</Badge>
                        </InlineStack>
                        <Text variant="bodySm" tone="subdued">
                          {policy.windowDays}-day window · {conditionSummary(policy)}
                        </Text>
                        <InlineStack gap="100">
                          {r.allowRefund && <Badge>Refund</Badge>}
                          {r.allowStoreCredit && <Badge>Store credit</Badge>}
                          {r.allowExchange && <Badge>Exchange</Badge>}
                        </InlineStack>
                      </BlockStack>
                    </ResourceItem>
                  );
                }}
              />
            )}
          </Card>
        </Layout.Section>
      </Layout>

      <Modal
        open={modalOpen}
        onClose={() => setModalOpen(false)}
        title={editingId ? 'Edit return policy' : 'Create return policy'}
        primaryAction={{ content: editingId ? 'Save' : 'Create', onAction: handleSave, loading: saving }}
        secondaryActions={[{ content: 'Cancel', onAction: () => setModalOpen(false) }]}
      >
        <Modal.Section>
          <BlockStack gap="400">
            <TextField
              label="Policy name"
              value={form.name}
              onChange={set('name')}
              placeholder="e.g. Final sale items"
              autoComplete="off"
            />
            <TextField
              label="Return window (days)"
              type="number"
              value={form.windowDays}
              onChange={set('windowDays')}
              autoComplete="off"
            />

            <Text variant="headingSm" as="h3">Conditions (optional)</Text>
            <Text tone="subdued" variant="bodySm">Leave blank to apply to all items. Otherwise this policy applies only to items matching these.</Text>
            <TextField
              label="Product tags (comma-separated)"
              value={form.productTags}
              onChange={set('productTags')}
              placeholder="final-sale, clearance"
              autoComplete="off"
            />
            <TextField
              label="Collections (comma-separated)"
              value={form.collections}
              onChange={set('collections')}
              placeholder="swimwear, underwear"
              autoComplete="off"
            />
            <InlineStack gap="400">
              <div style={{ flex: 1 }}>
                <TextField label="Min price (£)" type="number" value={form.minPrice} onChange={set('minPrice')} autoComplete="off" />
              </div>
              <div style={{ flex: 1 }}>
                <TextField label="Max price (£)" type="number" value={form.maxPrice} onChange={set('maxPrice')} autoComplete="off" />
              </div>
            </InlineStack>

            <Text variant="headingSm" as="h3">Allowed resolutions</Text>
            <Checkbox label="Refund to original payment" checked={form.allowRefund} onChange={set('allowRefund')} />
            <Checkbox label="Store credit (gift card)" checked={form.allowStoreCredit} onChange={set('allowStoreCredit')} />
            <Checkbox label="Exchange for another item" checked={form.allowExchange} onChange={set('allowExchange')} />

            <Text variant="headingSm" as="h3">Return fees (£)</Text>
            <Text tone="subdued" variant="bodySm">Deducted from the refund (or added to an exchange). Faulty/merchant-fault reasons are usually free.</Text>
            <InlineStack gap="400">
              <div style={{ flex: 1 }}>
                <TextField label="Changed mind" type="number" value={form.feeChangedMind} onChange={set('feeChangedMind')} placeholder="0" autoComplete="off" />
              </div>
              <div style={{ flex: 1 }}>
                <TextField label="Doesn't fit" type="number" value={form.feeDoesntFit} onChange={set('feeDoesntFit')} placeholder="0" autoComplete="off" />
              </div>
              <div style={{ flex: 1 }}>
                <TextField label="Damaged" type="number" value={form.feeDamaged} onChange={set('feeDamaged')} placeholder="0" autoComplete="off" />
              </div>
            </InlineStack>

            <Checkbox label="Set as default policy" checked={form.isDefault} onChange={set('isDefault')} />
            <Checkbox label="Active" checked={form.isActive} onChange={set('isActive')} />
          </BlockStack>
        </Modal.Section>
      </Modal>
      <AppFooter />
    </Page>
  );
}
