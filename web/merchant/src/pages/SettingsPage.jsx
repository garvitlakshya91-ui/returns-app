import { useState, useEffect } from 'react';
import {
  Page,
  Layout,
  Card,
  Text,
  BlockStack,
  InlineStack,
  TextField,
  Button,
  Banner,
  Select,
  SkeletonPage,
  SkeletonBodyText,
} from '@shopify/polaris';
import { settingsApi } from '../api';
import CarrierConnectCard from '../components/CarrierConnectCard';
import AppFooter from '../components/AppFooter';

export default function SettingsPage() {
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [banner, setBanner] = useState(null);
  const [settings, setSettings] = useState({});
  const [shopInfo, setShopInfo] = useState({});

  useEffect(() => {
    loadSettings();
  }, []);

  async function loadSettings() {
    try {
      const data = await settingsApi.get();
      setShopInfo({ name: data.name, email: data.email, plan: data.plan, portalUrl: data.portalUrl || '', themeEditorUrl: data.themeEditorUrl || '' });
      setSettings(data.settings || {});
    } catch (err) {
      console.error('Load settings error:', err);
    } finally {
      setLoading(false);
    }
  }

  async function handleSave() {
    setSaving(true);
    try {
      await settingsApi.update(settings);
      setBanner({ title: 'Settings saved', tone: 'success' });
    } catch (err) {
      setBanner({ title: `Failed: ${err.message}`, tone: 'critical' });
    } finally {
      setSaving(false);
    }
  }

  function updateSetting(key, value) {
    setSettings((prev) => ({ ...prev, [key]: value }));
  }

  // Liquid for Shopify's order notification templates: `order_name` and
  // `customer.email` are available there, so the portal opens prefilled.
  const emailSnippet = shopInfo.portalUrl
    ? `<a href="${shopInfo.portalUrl}?order={{ order_name | remove: '#' }}&email={{ customer.email | url_encode }}">Start a return</a>`
    : '';
  const [snippetCopied, setSnippetCopied] = useState(false);
  // Opening the theme editor or copying the snippet ticks the setup guide's
  // "add a Start a return button" step.
  function markStorefrontLinkAdded() {
    if (settings.storefrontLinkAdded) return;
    const next = { ...settings, storefrontLinkAdded: true };
    setSettings(next);
    settingsApi.update(next).catch(() => {});
  }
  async function copySnippet() {
    try {
      await navigator.clipboard.writeText(emailSnippet);
      setSnippetCopied(true);
      setTimeout(() => setSnippetCopied(false), 2000);
      markStorefrontLinkAdded();
    } catch {
      /* clipboard unavailable */
    }
  }

  if (loading) {
    return (
      <SkeletonPage title="Settings">
        <Layout>
          <Layout.Section>
            <Card><SkeletonBodyText lines={4} /></Card>
          </Layout.Section>
          <Layout.Section>
            <Card><SkeletonBodyText lines={4} /></Card>
          </Layout.Section>
        </Layout>
      </SkeletonPage>
    );
  }

  return (
    <Page title="Settings">
      <Layout>
        {banner && (
          <Layout.Section>
            <Banner tone={banner.tone} title={banner.title} onDismiss={() => setBanner(null)} />
          </Layout.Section>
        )}

        {/* Shop info */}
        <Layout.Section variant="oneThird">
          <Card>
            <BlockStack gap="300">
              <Text variant="headingMd">Shop Info</Text>
              <Text>Name: {shopInfo.name || '—'}</Text>
              <Text>Email: {shopInfo.email || '—'}</Text>
              <Text>Plan: {shopInfo.plan || 'FREE'}</Text>
            </BlockStack>
          </Card>
        </Layout.Section>

        {/* Where customers find the portal */}
        <Layout.Section>
          <Card>
            <BlockStack gap="300">
              <Text variant="headingMd" as="h2">Let customers find your portal</Text>
              <Text tone="subdued">
                Your returns portal is at {shopInfo.portalUrl ? <strong>{shopInfo.portalUrl}</strong> : 'the address shown on your dashboard'}. Put a link to it where customers look for it:
              </Text>

              <BlockStack gap="150">
                <Text fontWeight="semibold">1. A "Start a return" button on your store</Text>
                <Text tone="subdued">
                  ReturnFlow adds a block to your theme editor. {shopInfo.themeEditorUrl
                    ? 'Open the editor with the block ready to place, then drag it where you want it (the footer or your returns page work well) and save.'
                    : 'Open Online Store → Themes → Customize, pick a page, click Add block → Apps → Start a return, place it (the footer or your returns page work well) and save.'}
                </Text>
                <InlineStack gap="200">
                  {shopInfo.themeEditorUrl ? (
                    <Button url={shopInfo.themeEditorUrl} target="_blank" variant="primary" onClick={markStorefrontLinkAdded}>Add the button in the theme editor</Button>
                  ) : (
                    <Button url="shopify://admin/themes/current/editor" target="_top" onClick={markStorefrontLinkAdded}>Open the theme editor</Button>
                  )}
                </InlineStack>
              </BlockStack>

              <BlockStack gap="150">
                <Text fontWeight="semibold">2. A link in your order emails</Text>
                <Text tone="subdued">
                  Paste this into your order confirmation or shipping confirmation email (Settings → Notifications in Shopify). It opens the portal with the customer's order already filled in.
                </Text>
                <TextField
                  label="Email snippet"
                  labelHidden
                  value={emailSnippet}
                  readOnly
                  multiline={2}
                  autoComplete="off"
                  connectedRight={<Button onClick={copySnippet}>{snippetCopied ? 'Copied' : 'Copy'}</Button>}
                />
              </BlockStack>
            </BlockStack>
          </Card>
        </Layout.Section>

        {/* Portal branding */}
        <Layout.Section>
          <Card>
            <BlockStack gap="400">
              <Text variant="headingMd">Portal Branding</Text>
              <TextField
                label="Logo image URL"
                helpText="Shown at the top of customer emails. Paste a public image URL (PNG/JPG)."
                value={settings.logoUrl || ''}
                onChange={(v) => updateSetting('logoUrl', v)}
                placeholder="https://yourshop.co.uk/logo.png"
                autoComplete="off"
              />
              <TextField
                label="Portal heading"
                value={settings.portalHeading || ''}
                onChange={(v) => updateSetting('portalHeading', v)}
                placeholder="Start a Return"
                autoComplete="off"
              />
              <TextField
                label="Primary colour (hex)"
                value={settings.primaryColor || ''}
                onChange={(v) => updateSetting('primaryColor', v)}
                placeholder="#4F46E5"
                autoComplete="off"
              />
              <TextField
                label="Support email"
                value={settings.supportEmail || ''}
                onChange={(v) => updateSetting('supportEmail', v)}
                placeholder="returns@yourshop.co.uk"
                autoComplete="off"
              />
            </BlockStack>
          </Card>
        </Layout.Section>

        {/* Carriers */}
        <Layout.Section>
          <CarrierConnectCard plan={shopInfo.plan || 'FREE'} />
        </Layout.Section>

        {/* Notifications */}
        <Layout.Section>
          <Card>
            <BlockStack gap="400">
              <Text variant="headingMd">Notifications</Text>
              <Select
                label="Notify merchant on new return"
                options={[
                  { label: 'Email notification', value: 'email' },
                  { label: 'No notification', value: 'none' },
                ]}
                value={settings.merchantNotify || 'email'}
                onChange={(v) => updateSetting('merchantNotify', v)}
              />
            </BlockStack>
          </Card>
        </Layout.Section>

        {/* Warehouse address */}
        <Layout.Section>
          <Card>
            <BlockStack gap="400">
              <Text variant="headingMd">Return Warehouse Address</Text>
              <Text as="p" tone="subdued">
                Where customers post their returns. Leave blank to use your
                store&apos;s address from Shopify — set this only if returns go
                somewhere different.
              </Text>
              <TextField
                label="Address line 1"
                value={settings.warehouseLine1 || ''}
                onChange={(v) => updateSetting('warehouseLine1', v)}
                autoComplete="off"
              />
              <TextField
                label="City"
                value={settings.warehouseCity || ''}
                onChange={(v) => updateSetting('warehouseCity', v)}
                autoComplete="off"
              />
              <TextField
                label="Postcode"
                value={settings.warehousePostcode || ''}
                onChange={(v) => updateSetting('warehousePostcode', v)}
                autoComplete="off"
              />
            </BlockStack>
          </Card>
        </Layout.Section>

        <Layout.Section>
          <Card>
            <BlockStack gap="300">
              <Text variant="headingMd" as="h2">Parcel defaults</Text>
              <Text as="p" tone="subdued">
                Labels are priced by weight and size. Each item&apos;s weight comes
                from its Shopify variant when set; otherwise the default below is
                used per item. Postage can be refused or surcharged if a parcel
                is heavier or larger than declared.
              </Text>
              <TextField
                label="Default weight per item (kg)"
                type="number"
                value={settings.parcelDefaultWeightKg ?? ''}
                onChange={(v) => updateSetting('parcelDefaultWeightKg', v)}
                placeholder="0.5"
                autoComplete="off"
              />
              <InlineStack gap="300">
                <div style={{ flex: 1 }}>
                  <TextField label="Length (cm)" type="number" value={settings.parcelLengthCm ?? ''} onChange={(v) => updateSetting('parcelLengthCm', v)} placeholder="30" autoComplete="off" />
                </div>
                <div style={{ flex: 1 }}>
                  <TextField label="Width (cm)" type="number" value={settings.parcelWidthCm ?? ''} onChange={(v) => updateSetting('parcelWidthCm', v)} placeholder="20" autoComplete="off" />
                </div>
                <div style={{ flex: 1 }}>
                  <TextField label="Height (cm)" type="number" value={settings.parcelHeightCm ?? ''} onChange={(v) => updateSetting('parcelHeightCm', v)} placeholder="10" autoComplete="off" />
                </div>
              </InlineStack>
            </BlockStack>
          </Card>
        </Layout.Section>

        <Layout.Section>
          <Button variant="primary" onClick={handleSave} loading={saving}>
            Save settings
          </Button>
        </Layout.Section>
      </Layout>
      <AppFooter />
    </Page>
  );
}
