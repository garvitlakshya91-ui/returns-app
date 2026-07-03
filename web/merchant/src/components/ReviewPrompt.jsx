import { useState, useEffect } from 'react';
import { Banner } from '@shopify/polaris';
import { settingsApi, returnsApi } from '../api';

// One-time review ask, shown only after the merchant has processed their 3rd
// return — the moment they've felt the value. Never incentivised (Shopify
// policy); dismissing or clicking through both hide it permanently.
const REVIEW_URL = 'https://apps.shopify.com/returns-app-garvit-20260613#modal-show=WriteReviewModal';
const PROCESSED_THRESHOLD = 3;

export default function ReviewPrompt() {
  const [settings, setSettings] = useState({});
  const [visible, setVisible] = useState(false);

  useEffect(() => {
    let active = true;
    Promise.all([
      settingsApi.get(),
      returnsApi.list({ status: 'PROCESSED', limit: 1 }),
    ])
      .then(([settingsData, processed]) => {
        if (!active) return;
        const s = settingsData.settings || {};
        setSettings(s);
        setVisible(!s.reviewPromptDismissed && (processed.total || 0) >= PROCESSED_THRESHOLD);
      })
      .catch(() => {});
    return () => { active = false; };
  }, []);

  async function dismiss() {
    setVisible(false);
    try {
      await settingsApi.update({ ...settings, reviewPromptDismissed: true });
    } catch (err) {
      console.error('Review prompt dismiss error:', err);
    }
  }

  function leaveReview() {
    window.open(REVIEW_URL, '_blank', 'noopener');
    dismiss();
  }

  if (!visible) return null;

  return (
    <Banner
      tone="success"
      title="Enjoying ReturnFlow?"
      onDismiss={dismiss}
      action={{ content: 'Leave a review', onAction: leaveReview }}
    >
      <p>
        You&rsquo;ve processed a few returns now 🎉 A quick review on the App Store
        helps other UK merchants find us — it takes about a minute.
      </p>
    </Banner>
  );
}
