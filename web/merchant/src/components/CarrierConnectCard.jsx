import { useState, useEffect, useCallback } from 'react';
import {
  Card,
  BlockStack,
  InlineStack,
  Text,
  Badge,
  Button,
  Modal,
  TextField,
  Banner,
  Checkbox,
  Link,
  Box,
} from '@shopify/polaris';
import { carriersApi } from '../api';

// Bring-your-own carriers. `status: 'soon'` renders as Coming soon (we don't
// advertise carriers we can't yet generate real labels for). Royal Mail is the
// live own-account option; Evri/InPost arrive once their adapters are real.
const CARRIERS = [
  {
    id: 'royalmail',
    name: 'Royal Mail',
    status: 'available',
    blurb: 'Click & Drop returns via Post Office branches and parcel postboxes.',
    fields: [{ key: 'apiKey', label: 'Click & Drop API key', sensitive: true }],
    helpUrl: 'https://www.royalmail.com/business/shipping/click-and-drop',
  },
  {
    id: 'evri',
    name: 'Evri',
    status: 'soon',
    blurb: 'ParcelShop drop-off and QR-code labels across the UK.',
    fields: [{ key: 'apiKey', label: 'API key', sensitive: true }],
    helpUrl: 'https://www.evri.com/business',
  },
  {
    id: 'inpost',
    name: 'InPost',
    status: 'soon',
    blurb: '24/7 self-service locker returns.',
    fields: [{ key: 'apiKey', label: 'API key', sensitive: true }],
    helpUrl: 'https://www.inpost.co.uk/business',
  },
];

const PLAN_CARRIER_LIMIT = { FREE: 1, STARTER: 3, GROWTH: 10, PRO: 10 };

export default function CarrierConnectCard({ plan = 'FREE', onChange }) {
  const [configs, setConfigs] = useState([]);
  const [loading, setLoading] = useState(true);
  const [banner, setBanner] = useState(null);
  const [busy, setBusy] = useState(false);

  // Bring-your-own modal state
  const [active, setActive] = useState(null);
  const [form, setForm] = useState({});
  const [makeActive, setMakeActive] = useState(true);
  const [saving, setSaving] = useState(false);

  const limit = PLAN_CARRIER_LIMIT[plan] ?? 1;

  const load = useCallback(async () => {
    try {
      const data = await carriersApi.list();
      setConfigs(Array.isArray(data) ? data : []);
    } catch (err) {
      console.error('Load carriers error:', err);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  const configFor = (id) => configs.find((c) => c.carrier === id);
  // Backend counts any active carrier toward the plan limit (credentials or not).
  const activeCount = configs.filter((c) => c.isActive).length;

  const managed = configFor('shipengine');
  const managedActive = !!managed?.isActive;

  async function toggleManaged() {
    setBusy(true);
    setBanner(null);
    try {
      if (managedActive) {
        await carriersApi.delete(managed.id);
        setBanner({ tone: 'success', title: 'Managed labels turned off' });
      } else {
        await carriersApi.save({ carrier: 'shipengine', isActive: true });
        setBanner({ tone: 'success', title: 'Managed return labels enabled' });
      }
      await load();
      onChange?.();
    } catch (err) {
      setBanner({ tone: 'critical', title: err.message || 'Could not update managed labels' });
    } finally {
      setBusy(false);
    }
  }

  function openModal(carrier) {
    setActive(carrier);
    setForm({});
    setMakeActive(configFor(carrier.id)?.isActive ?? true);
    setBanner(null);
  }
  function closeModal() { setActive(null); setForm({}); }

  async function handleSave() {
    if (!active) return;
    setSaving(true);
    try {
      const credentials = {};
      for (const f of active.fields) {
        if (form[f.key]) credentials[f.key] = form[f.key].trim();
      }
      await carriersApi.save({
        carrier: active.id,
        credentials: Object.keys(credentials).length ? credentials : undefined,
        isActive: makeActive,
      });
      setBanner({ tone: 'success', title: `${active.name} saved` });
      closeModal();
      await load();
      onChange?.();
    } catch (err) {
      setBanner({ tone: 'critical', title: err.message || 'Failed to save carrier' });
    } finally {
      setSaving(false);
    }
  }

  async function handleDisconnect(carrier) {
    const existing = configFor(carrier.id);
    if (!existing) return;
    try {
      await carriersApi.delete(existing.id);
      setBanner({ tone: 'success', title: `${carrier.name} disconnected` });
      await load();
      onChange?.();
    } catch (err) {
      setBanner({ tone: 'critical', title: err.message || 'Failed to disconnect' });
    }
  }

  return (
    <Card>
      <BlockStack gap="400">
        <BlockStack gap="100">
          <Text variant="headingMd" as="h2">Return labels</Text>
          <Text tone="subdued">
            Your {plan} plan allows {limit} active carrier{limit > 1 ? 's' : ''} ({activeCount} active).
          </Text>
        </BlockStack>

        {banner && (
          <Banner tone={banner.tone} onDismiss={() => setBanner(null)}>{banner.title}</Banner>
        )}

        {/* ── Managed labels (recommended, zero setup) ── */}
        <Box background="bg-surface-secondary" padding="400" borderRadius="200">
          <InlineStack align="space-between" blockAlign="center" wrap={false} gap="400">
            <BlockStack gap="100">
              <InlineStack gap="200" blockAlign="center">
                <Text variant="headingSm" as="h3">Managed return labels</Text>
                <Badge tone="success">Recommended</Badge>
                {managedActive && <Badge tone="success">On</Badge>}
              </InlineStack>
              <Text tone="subdued" variant="bodySm">
                Generate return labels automatically — no carrier account or API keys needed.
                Powered by ReturnFlow's carrier network.
              </Text>
            </BlockStack>
            <Button
              variant={managedActive ? undefined : 'primary'}
              tone={managedActive ? 'critical' : undefined}
              onClick={toggleManaged}
              loading={busy}
              disabled={!managedActive && activeCount >= limit}
            >
              {managedActive ? 'Turn off' : 'Enable'}
            </Button>
          </InlineStack>
        </Box>

        {/* ── Bring your own carrier (advanced) ── */}
        <BlockStack gap="200">
          <Text variant="headingSm" as="h3">Connect your own carrier (advanced)</Text>
          {loading ? (
            <Text tone="subdued">Loading…</Text>
          ) : (
            <BlockStack gap="300">
              {CARRIERS.map((carrier) => {
                const soon = carrier.status === 'soon';
                const existing = configFor(carrier.id);
                const connected = !!existing?.hasCredentials;
                const isActive = !!existing?.isActive && connected;
                const atLimit = !connected && activeCount >= limit;
                return (
                  <InlineStack key={carrier.id} align="space-between" blockAlign="center" wrap={false} gap="400">
                    <BlockStack gap="050">
                      <InlineStack gap="200" blockAlign="center">
                        <Text variant="headingSm" as="h4">{carrier.name}</Text>
                        {soon
                          ? <Badge>Coming soon</Badge>
                          : connected
                            ? <Badge tone={isActive ? 'success' : 'attention'}>{isActive ? 'Active' : 'Inactive'}</Badge>
                            : <Badge>Not connected</Badge>}
                      </InlineStack>
                      <Text tone="subdued" variant="bodySm">{carrier.blurb}</Text>
                      {!soon && atLimit && (
                        <Text tone="caution" variant="bodySm">Upgrade your plan to connect more carriers.</Text>
                      )}
                    </BlockStack>
                    {soon ? (
                      <Button disabled>Coming soon</Button>
                    ) : (
                      <InlineStack gap="200">
                        <Button onClick={() => openModal(carrier)} disabled={atLimit}>
                          {connected ? 'Edit' : 'Connect'}
                        </Button>
                        {connected && (
                          <Button tone="critical" variant="plain" onClick={() => handleDisconnect(carrier)}>
                            Disconnect
                          </Button>
                        )}
                      </InlineStack>
                    )}
                  </InlineStack>
                );
              })}
            </BlockStack>
          )}
        </BlockStack>
      </BlockStack>

      {active && (
        <Modal
          open
          onClose={closeModal}
          title={`Connect ${active.name}`}
          primaryAction={{ content: 'Save', onAction: handleSave, loading: saving }}
          secondaryActions={[{ content: 'Cancel', onAction: closeModal }]}
        >
          <Modal.Section>
            <BlockStack gap="400">
              {configFor(active.id)?.hasCredentials && (
                <Banner tone="info">
                  This carrier is already connected. Leave fields blank to keep the saved
                  credentials, or enter new values to replace them.
                </Banner>
              )}
              {active.fields.map((f) => (
                <TextField
                  key={f.key}
                  label={f.label}
                  type={f.sensitive ? 'password' : 'text'}
                  value={form[f.key] || ''}
                  onChange={(v) => setForm((prev) => ({ ...prev, [f.key]: v }))}
                  autoComplete="off"
                />
              ))}
              <Checkbox
                label="Use this carrier for new returns"
                checked={makeActive}
                onChange={setMakeActive}
              />
              <Text tone="subdued" variant="bodySm">
                Need credentials? <Link url={active.helpUrl} external>Set up a {active.name} business account</Link>.
              </Text>
            </BlockStack>
          </Modal.Section>
        </Modal>
      )}
    </Card>
  );
}
