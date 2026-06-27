import { useState, useEffect } from 'react';
import { Banner, Modal, BlockStack, InlineStack, Text, Icon } from '@shopify/polaris';
import { CheckCircleIcon } from '@shopify/polaris-icons';
import { settingsApi } from '../api';

// First-run welcome shown once per shop. Rendered as a dismissible banner with
// a "Watch the tour" button that opens the explainer modal ON CLICK — auto-
// opening a Polaris Modal on mount is unreliable in the embedded App Bridge
// context, whereas a user-gesture open is rock solid.
const POINTS = [
  { t: 'A branded returns portal', d: 'Customers self-serve a return in under a minute — on a portal that looks like your store.' },
  { t: 'One-click managed labels', d: 'Real Royal Mail & Evri labels with no carrier accounts or API keys — billed per label on your Shopify invoice.' },
  { t: 'Manage it all in Shopify', d: 'Approve in bulk, see why items come back, and set smart policy rules.' },
];

export default function WelcomeModal() {
  const [settings, setSettings] = useState({});
  const [dismissed, setDismissed] = useState(true); // hidden until loaded
  const [modalOpen, setModalOpen] = useState(false);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    let active = true;
    settingsApi.get()
      .then((data) => {
        if (!active) return;
        const s = data.settings || {};
        setSettings(s);
        setDismissed(!!s.welcomeDismissed);
      })
      .catch(() => setDismissed(true));
    return () => { active = false; };
  }, []);

  async function dismiss() {
    setSaving(true);
    setDismissed(true);
    setModalOpen(false);
    try {
      await settingsApi.update({ ...settings, welcomeDismissed: true });
    } catch (err) {
      console.error('Welcome dismiss error:', err);
    } finally {
      setSaving(false);
    }
  }

  if (dismissed) return null;

  // The animated explainer is served as a standalone page and embedded here.
  // A hosted YouTube/Vimeo embed URL (settings.onboardingVideoUrl) overrides it.
  const embedUrl = settings.onboardingVideoUrl || '/admin/onboarding.html';

  return (
    <>
      <Banner
        tone="info"
        title="Welcome to ReturnFlow 👋"
        onDismiss={dismiss}
        action={{ content: 'Watch the 2-min tour', onAction: () => setModalOpen(true) }}
      >
        <p>Returns made effortless. Take a quick tour, then follow the setup checklist below to go live.</p>
      </Banner>

      <Modal
        open={modalOpen}
        onClose={() => setModalOpen(false)}
        title="ReturnFlow — a quick tour"
        primaryAction={{ content: 'Got it, let’s go', onAction: dismiss, loading: saving }}
        secondaryActions={[{ content: 'Close', onAction: () => setModalOpen(false) }]}
        large
      >
        {modalOpen && (
          <Modal.Section>
            <BlockStack gap="400">
              <div style={{ position: 'relative', paddingTop: '56.25%', borderRadius: 8, overflow: 'hidden', background: '#4F46E5' }}>
                <iframe
                  src={embedUrl}
                  title="ReturnFlow tour"
                  allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture"
                  allowFullScreen
                  style={{ position: 'absolute', inset: 0, width: '100%', height: '100%', border: 0 }}
                />
              </div>
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
            </BlockStack>
          </Modal.Section>
        )}
      </Modal>
    </>
  );
}
