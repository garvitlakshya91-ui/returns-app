import { useState, useEffect } from 'react';
import { Modal, BlockStack, InlineStack, Text, Icon } from '@shopify/polaris';
import { CheckCircleIcon } from '@shopify/polaris-icons';
import { settingsApi } from '../api';

// First-run welcome shown once per shop (flag stored in settings JSON, same
// pattern as the Setup Guide). Plays the onboarding tour and points the
// merchant at the setup checklist below it on the Dashboard.
const POINTS = [
  { t: 'A branded returns portal', d: 'Customers self-serve a return in under a minute — on a portal that looks like your store.' },
  { t: 'One-click managed labels', d: 'Real Royal Mail & Evri labels with no carrier accounts or API keys — billed per label on your Shopify invoice.' },
  { t: 'Manage it all in Shopify', d: 'Approve in bulk, see why items come back, and set smart policy rules.' },
];

export default function WelcomeModal() {
  const [open, setOpen] = useState(false);
  const [settings, setSettings] = useState({});
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    let active = true;
    settingsApi.get()
      .then((data) => {
        if (!active) return;
        const s = data.settings || {};
        setSettings(s);
        if (!s.welcomeDismissed) setOpen(true);
      })
      .catch(() => {});
    return () => { active = false; };
  }, []);

  async function dismiss() {
    setSaving(true);
    setOpen(false);
    try {
      await settingsApi.update({ ...settings, welcomeDismissed: true });
    } catch (err) {
      console.error('Welcome dismiss error:', err);
    } finally {
      setSaving(false);
    }
  }

  if (!open) return null;

  // A YouTube/Vimeo embed URL can override the bundled clip once it's hosted.
  const embedUrl = settings.onboardingVideoUrl;

  return (
    <Modal
      open={open}
      onClose={dismiss}
      title="Welcome to ReturnFlow 👋"
      primaryAction={{ content: 'Get started', onAction: dismiss, loading: saving }}
      secondaryActions={[{ content: 'Skip for now', onAction: dismiss }]}
      large
    >
      <Modal.Section>
        <BlockStack gap="400">
          <Text tone="subdued">Returns made effortless — here's a quick 30-second tour.</Text>

          {embedUrl ? (
            <div style={{ position: 'relative', paddingTop: '56.25%', borderRadius: 8, overflow: 'hidden', background: '#0F1020' }}>
              <iframe
                src={embedUrl}
                title="ReturnFlow tour"
                allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture"
                allowFullScreen
                style={{ position: 'absolute', inset: 0, width: '100%', height: '100%', border: 0 }}
              />
            </div>
          ) : (
            <video
              src="/admin/onboarding.webm"
              controls
              playsInline
              style={{ width: '100%', borderRadius: 8, display: 'block', background: '#0F1020' }}
            />
          )}

          <BlockStack gap="300">
            {POINTS.map((p) => (
              <InlineStack key={p.t} gap="300" blockAlign="start" wrap={false}>
                <span style={{ flexShrink: 0 }}><Icon source={CheckCircleIcon} tone="success" /></span>
                <BlockStack gap="050">
                  <Text variant="headingSm" as="h3">{p.t}</Text>
                  <Text tone="subdued" variant="bodySm">{p.d}</Text>
                </BlockStack>
              </InlineStack>
            ))}
          </BlockStack>

          <Text tone="subdued" variant="bodySm">
            Click <b>Get started</b> and follow the setup checklist below to go live.
          </Text>
        </BlockStack>
      </Modal.Section>
    </Modal>
  );
}
