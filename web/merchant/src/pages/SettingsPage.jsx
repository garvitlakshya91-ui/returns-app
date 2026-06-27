import { useState, useEffect } from 'react';
import {
  Page,
  Layout,
  Card,
  Text,
  BlockStack,
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
      setShopInfo({ name: data.name, email: data.email, plan: data.plan });
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
          <Button variant="primary" onClick={handleSave} loading={saving}>
            Save settings
          </Button>
        </Layout.Section>
      </Layout>
      <AppFooter />
    </Page>
  );
}
