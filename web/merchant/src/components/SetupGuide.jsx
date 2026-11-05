import { useState, useEffect, useCallback } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  Card,
  BlockStack,
  InlineStack,
  Text,
  Button,
  Icon,
  ProgressBar,
  Badge,
} from '@shopify/polaris';
import { CheckCircleIcon, MinusCircleIcon } from '@shopify/polaris-icons';
import { settingsApi, carriersApi, policiesApi, billingApi } from '../api';

// Managed-label backends (ReturnFlow's own carrier account): active without
// any merchant credentials, so they count as a connected carrier.
const MANAGED_CARRIERS = ['shippo', 'shipengine'];

// First-run onboarding checklist, shown on the Dashboard until the merchant
// finishes setup (or dismisses it). Completion is derived from live data — no
// extra schema — and the dismissal flag rides along in the settings JSON.
export default function SetupGuide() {
  const navigate = useNavigate();
  const [loading, setLoading] = useState(true);
  const [settings, setSettings] = useState({});
  const [hasCarrier, setHasCarrier] = useState(false);
  const [hasPolicy, setHasPolicy] = useState(false);
  const [portalUrl, setPortalUrl] = useState('');
  const [copied, setCopied] = useState(false);
  const [dismissed, setDismissed] = useState(true); // assume hidden until loaded
  // null until known; a failed check must not block the merchant here (the
  // approval itself re-checks and explains).
  const [labelBilling, setLabelBilling] = useState(null);

  const load = useCallback(async () => {
    try {
      const [settingsData, carriers, policies, billing] = await Promise.all([
        settingsApi.get(),
        carriersApi.list().catch(() => []),
        policiesApi.list().catch(() => []),
        billingApi.labels().catch(() => null),
      ]);
      const policyList = Array.isArray(policies) ? policies : (policies?.policies || []);
      setHasPolicy(policyList.some((p) => p.isActive));
      const s = settingsData.settings || {};
      setSettings(s);
      setPortalUrl(settingsData.portalUrl || '');
      setDismissed(!!s.setupGuideDismissed);
      setLabelBilling(billing);
      setHasCarrier(
        Array.isArray(carriers)
          && carriers.some((c) => c.isActive && (c.hasCredentials || MANAGED_CARRIERS.includes(c.carrier))),
      );
    } catch (err) {
      console.error('Setup guide load error:', err);
      setDismissed(true);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  const warehouseSet = !!(settings.warehouseLine1 && settings.warehousePostcode);
  const branded = !!(settings.portalHeading || settings.primaryColor || settings.supportEmail);

  // Shopify does not force a plan choice at install, but return labels are
  // billed per label through the plan, so a store with no plan cannot buy one.
  const needsPlan = labelBilling?.allowed === false && labelBilling?.reason === 'no_active_plan';
  const planDescription = needsPlan
    ? 'Return labels are added to your Shopify bill through your plan, so pick one first. The Free plan has no monthly fee.'
    : labelBilling?.devStore
      ? 'Development stores get every plan free, so labels cost nothing here.'
      : labelBilling?.plan
        ? `You're on the ${labelBilling.plan} plan.`
        : 'Return labels are billed per label through your plan. The Free plan has no monthly fee.';

  const steps = [
    {
      key: 'plan',
      title: 'Choose a plan',
      description: planDescription,
      done: !needsPlan,
      required: true,
      action: labelBilling?.planUrl
        ? { label: needsPlan ? 'Choose a plan' : 'View plans', url: labelBilling.planUrl, external: true }
        : null,
    },
    {
      key: 'carrier',
      title: 'Connect a carrier',
      description: 'Add your Evri, Royal Mail or InPost account so customers get real return labels.',
      done: hasCarrier,
      required: true,
      action: { label: 'Connect carrier', onClick: () => navigate('/settings') },
    },
    {
      key: 'policy',
      title: 'Have an active return policy',
      description: 'Without one, no item on any order is returnable. A 30-day policy is created when you install.',
      done: hasPolicy,
      required: true,
      action: { label: 'Review policies', onClick: () => navigate('/policies') },
    },
    {
      key: 'warehouse',
      title: 'Set your return address',
      description: 'Tell carriers where approved returns should be shipped back to.',
      done: warehouseSet,
      required: true,
      action: { label: 'Add address', onClick: () => navigate('/settings') },
    },
    {
      key: 'branding',
      title: 'Customise your portal',
      description: 'Add your heading, brand colour and support email to the customer portal.',
      done: branded,
      required: false,
      action: { label: 'Customise', onClick: () => navigate('/settings') },
    },
    {
      key: 'storefront',
      title: 'Add a "Start a return" button to your store',
      description: 'A theme block and an order-email link, so customers find the portal without asking you.',
      done: !!settings.storefrontLinkAdded,
      required: false,
      action: { label: 'See how', onClick: () => navigate('/settings') },
    },
    {
      key: 'share',
      title: 'Share your returns portal',
      description: portalUrl || 'Your portal link appears here once your shop domain is set.',
      done: branded && warehouseSet && hasCarrier && hasPolicy,
      required: false,
      action: portalUrl
        ? {
            label: copied ? 'Copied!' : 'Copy link',
            onClick: async () => {
              try {
                await navigator.clipboard.writeText(portalUrl);
                setCopied(true);
                setTimeout(() => setCopied(false), 2000);
              } catch {
                /* clipboard unavailable */
              }
            },
          }
        : null,
    },
  ];

  const requiredSteps = steps.filter((s) => s.required);
  const requiredDone = requiredSteps.filter((s) => s.done).length;
  const readyToSell = requiredDone === requiredSteps.length;
  const completedCount = steps.filter((s) => s.done).length;
  const progress = Math.round((completedCount / steps.length) * 100);

  async function handleDismiss() {
    setDismissed(true);
    try {
      await settingsApi.update({ ...settings, setupGuideDismissed: true });
    } catch (err) {
      console.error('Dismiss setup guide error:', err);
    }
  }

  if (loading || dismissed) return null;

  return (
    <Card>
      <BlockStack gap="400">
        <InlineStack align="space-between" blockAlign="center">
          <BlockStack gap="100">
            <Text variant="headingMd" as="h2">Set up ReturnFlow</Text>
            <Text tone="subdued">
              {readyToSell
                ? "You're ready to accept returns. Finish the optional steps when you like."
                : 'Complete these steps to start accepting returns.'}
            </Text>
          </BlockStack>
          {readyToSell && <Badge tone="success">Ready</Badge>}
        </InlineStack>

        <ProgressBar progress={progress} size="small" tone="primary" />

        <BlockStack gap="300">
          {steps.map((step) => (
            <InlineStack key={step.key} align="space-between" blockAlign="center" wrap={false} gap="400">
              <InlineStack gap="300" blockAlign="start" wrap={false}>
                <span style={{ flexShrink: 0 }}>
                  <Icon source={step.done ? CheckCircleIcon : MinusCircleIcon} tone={step.done ? 'success' : 'subdued'} />
                </span>
                <BlockStack gap="050">
                  <InlineStack gap="200" blockAlign="center">
                    <Text variant="headingSm" as="h3">{step.title}</Text>
                    {!step.required && <Badge tone="info">Optional</Badge>}
                  </InlineStack>
                  <Text tone="subdued" variant="bodySm" breakWord>{step.description}</Text>
                </BlockStack>
              </InlineStack>
              {step.action && (
                <Button
                  onClick={step.action.onClick}
                  url={step.action.url}
                  external={step.action.external}
                  variant={step.done ? 'tertiary' : 'primary'}
                >
                  {step.action.label}
                </Button>
              )}
            </InlineStack>
          ))}
        </BlockStack>

        <InlineStack align="end">
          <Button variant="plain" onClick={handleDismiss}>
            {readyToSell ? 'Dismiss' : 'Skip setup for now'}
          </Button>
        </InlineStack>
      </BlockStack>
    </Card>
  );
}
