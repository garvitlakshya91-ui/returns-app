import { useState, useEffect, useCallback } from 'react';
import { Card, BlockStack, InlineStack, Text, Button, Badge, Banner, Modal } from '@shopify/polaris';
import { carriersApi } from '../api';

// Dashboard highlight that promotes one-click managed return labels. Hides
// itself once managed labels are enabled. Enabling/limits are enforced by the
// backend; a failure surfaces as a banner.
export default function ManagedLabelsCard({ onChange }) {
  const [configs, setConfigs] = useState([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [banner, setBanner] = useState(null);
  const [videoOpen, setVideoOpen] = useState(false);

  const load = useCallback(async () => {
    try {
      const data = await carriersApi.list();
      setConfigs(Array.isArray(data) ? data : []);
    } catch (err) {
      console.error('Managed card load error:', err);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  const managedActive = configs.some(
    (c) => (c.carrier === 'shippo' || c.carrier === 'shipengine') && c.isActive,
  );

  async function enable() {
    setBusy(true);
    setBanner(null);
    try {
      await carriersApi.save({ carrier: 'shippo', isActive: true });
      setBanner({ tone: 'success', title: 'Managed return labels enabled 🎉' });
      await load();
      onChange?.();
    } catch (err) {
      setBanner({ tone: 'critical', title: err.message || 'Could not enable managed labels' });
    } finally {
      setBusy(false);
    }
  }

  // Nothing to promote once it's on (or while loading).
  if (loading || managedActive) return null;

  return (
    <>
      <Card>
        <BlockStack gap="300">
          <InlineStack align="space-between" blockAlign="center" wrap gap="400">
            <BlockStack gap="200">
              <InlineStack gap="200" blockAlign="center">
                <Text variant="headingMd" as="h2">⚡ Turn on managed return labels</Text>
                <Badge tone="success">Recommended</Badge>
              </InlineStack>
              <Text tone="subdued">
                Real Royal Mail &amp; Evri labels with one click — no carrier accounts, no API keys.
                Billed per label on your Shopify invoice.
              </Text>
            </BlockStack>
            <InlineStack gap="300" blockAlign="center">
              <Button variant="plain" onClick={() => setVideoOpen(true)}>▶ How it works</Button>
              <Button variant="primary" onClick={enable} loading={busy}>Enable</Button>
            </InlineStack>
          </InlineStack>
          {banner && (
            <Banner tone={banner.tone} onDismiss={() => setBanner(null)}>{banner.title}</Banner>
          )}
        </BlockStack>
      </Card>

      <Modal
        open={videoOpen}
        onClose={() => setVideoOpen(false)}
        title="How managed return labels work"
        secondaryActions={[{ content: 'Close', onAction: () => setVideoOpen(false) }]}
        large
      >
        {videoOpen && (
          <Modal.Section>
            <div style={{ width: '100%', height: 'calc(100vh - 230px)', borderRadius: 8, overflow: 'hidden', background: '#faf9f5' }}>
              <iframe
                src="/admin/managed-labels.html"
                title="How managed labels work"
                allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture"
                allowFullScreen
                style={{ width: '100%', height: '100%', border: 0, display: 'block' }}
              />
            </div>
          </Modal.Section>
        )}
      </Modal>
    </>
  );
}
