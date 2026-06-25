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
} from '@shopify/polaris';
import { carriersApi } from '../api';

// Carrier catalogue. Adding a carrier here surfaces it in the UI; the backend
// adapter (app/services/...) is what makes the labels real. Credential fields
// map 1:1 to the JSON stored (encrypted) in CarrierConfig.credentials.
const CARRIERS = [
  {
    id: 'evri',
    name: 'Evri',
    blurb: 'ParcelShop drop-off and QR-code labels across the UK.',
    fields: [
      { key: 'apiKey', label: 'API key', sensitive: true },
      { key: 'accountNumber', label: 'Account number' },
    ],
    helpUrl: 'https://www.evri.com/business',
  },
  {
    id: 'royalmail',
    name: 'Royal Mail',
    blurb: 'Click & Drop returns via Post Office branches and parcel postboxes.',
    fields: [{ key: 'apiKey', label: 'Click & Drop API key', sensitive: true }],
    helpUrl: 'https://www.royalmail.com/business/shipping/click-and-drop',
  },
  {
    id: 'inpost',
    name: 'InPost',
    blurb: '24/7 self-service locker returns.',
    fields: [
      { key: 'apiKey', label: 'API key', sensitive: true },
      { key: 'organisationId', label: 'Organisation ID' },
    ],
    helpUrl: 'https://www.inpost.co.uk/business',
  },
];

const PLAN_CARRIER_LIMIT = { FREE: 1, STARTER: 3, GROWTH: 10, PRO: 10 };

export default function CarrierConnectCard({ plan = 'FREE', onChange }) {
  const [configs, setConfigs] = useState([]);
  const [loading, setLoading] = useState(true);
  const [banner, setBanner] = useState(null);

  // Modal state
  const [active, setActive] = useState(null); // carrier definition being edited
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

  useEffect(() => {
    load();
  }, [load]);

  const configFor = (id) => configs.find((c) => c.carrier === id);
  const activeCount = configs.filter((c) => c.isActive && c.hasCredentials).length;

  function openModal(carrier) {
    setActive(carrier);
    setForm({});
    const existing = configFor(carrier.id);
    setMakeActive(existing ? existing.isActive : true);
    setBanner(null);
  }

  function closeModal() {
    setActive(null);
    setForm({});
  }

  async function handleSave() {
    if (!active) return;
    setSaving(true);
    try {
      // Only send credentials the merchant actually typed; the backend keeps
      // existing keys when none are provided (e.g. toggling active state).
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
          <Text variant="headingMd" as="h2">Carriers</Text>
          <Text tone="subdued">
            Connect your own carrier account to generate real return labels.
            Your {plan} plan allows {limit} active carrier{limit > 1 ? 's' : ''} ({activeCount} connected).
          </Text>
        </BlockStack>

        {banner && (
          <Banner tone={banner.tone} onDismiss={() => setBanner(null)}>
            {banner.title}
          </Banner>
        )}

        {loading ? (
          <Text tone="subdued">Loading carriers…</Text>
        ) : (
          <BlockStack gap="300">
            {CARRIERS.map((carrier) => {
              const existing = configFor(carrier.id);
              const connected = !!existing?.hasCredentials;
              const isActive = !!existing?.isActive && connected;
              const atLimit = !connected && activeCount >= limit;
              return (
                <InlineStack key={carrier.id} align="space-between" blockAlign="center" wrap={false} gap="400">
                  <BlockStack gap="050">
                    <InlineStack gap="200" blockAlign="center">
                      <Text variant="headingSm" as="h3">{carrier.name}</Text>
                      {connected
                        ? <Badge tone={isActive ? 'success' : 'attention'}>{isActive ? 'Active' : 'Inactive'}</Badge>
                        : <Badge>Not connected</Badge>}
                    </InlineStack>
                    <Text tone="subdued" variant="bodySm">{carrier.blurb}</Text>
                    {atLimit && (
                      <Text tone="caution" variant="bodySm">
                        Upgrade your plan to connect more carriers.
                      </Text>
                    )}
                  </BlockStack>
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
                </InlineStack>
              );
            })}
          </BlockStack>
        )}
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
                  This carrier is already connected. Leave fields blank to keep the
                  saved credentials, or enter new values to replace them.
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
