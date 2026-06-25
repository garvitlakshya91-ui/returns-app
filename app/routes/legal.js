const { Router } = require('express');

const router = Router();

const COMPANY = 'ReturnFlow';
const DOMAIN = 'returnsflow.uk';
const SUPPORT_EMAIL = 'support@returnsflow.uk';
const EFFECTIVE_DATE = '25 June 2026';

// Shared HTML shell so both pages look consistent without a build step.
function page(title, bodyHtml) {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>${title} — ${COMPANY}</title>
  <meta name="robots" content="index,follow" />
  <style>
    :root { color-scheme: light; }
    * { box-sizing: border-box; }
    body {
      margin: 0;
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
      color: #1f2937;
      background: #f9fafb;
      line-height: 1.65;
    }
    .wrap { max-width: 760px; margin: 0 auto; padding: 48px 24px 96px; }
    header { display: flex; align-items: center; gap: 10px; margin-bottom: 8px; }
    .brand { font-size: 20px; font-weight: 700; color: #4F46E5; }
    h1 { font-size: 28px; margin: 24px 0 4px; }
    .meta { color: #6b7280; font-size: 14px; margin-bottom: 32px; }
    h2 { font-size: 19px; margin: 32px 0 8px; }
    h3 { font-size: 16px; margin: 20px 0 4px; }
    p, li { font-size: 15px; }
    ul { padding-left: 22px; }
    a { color: #4F46E5; }
    .card {
      background: #fff; border: 1px solid #e5e7eb; border-radius: 10px;
      padding: 16px 20px; margin: 16px 0;
    }
    code { background: #f3f4f6; padding: 1px 5px; border-radius: 4px; font-size: 13px; }
    footer { margin-top: 56px; padding-top: 20px; border-top: 1px solid #e5e7eb; color: #9ca3af; font-size: 13px; }
    nav.links a { margin-right: 16px; }
  </style>
</head>
<body>
  <div class="wrap">
    <header><span class="brand">${COMPANY}</span></header>
    ${bodyHtml}
    <footer>
      <nav class="links">
        <a href="/privacy">Privacy Policy</a>
        <a href="/terms">Terms of Service</a>
        <a href="https://${DOMAIN}">${DOMAIN}</a>
      </nav>
      <p>© ${new Date().getFullYear()} ${COMPANY}. All rights reserved.</p>
    </footer>
  </div>
</body>
</html>`;
}

const PRIVACY = page('Privacy Policy', `
  <h1>Privacy Policy</h1>
  <div class="meta">Effective ${EFFECTIVE_DATE}</div>

  <p>${COMPANY} ("we", "us", "our") provides a returns-management application for
  Shopify merchants. This policy explains what data we process, why, and your
  rights. We act as a <strong>data processor</strong> on behalf of the merchant
  (the data controller) whose store has installed ${COMPANY}.</p>

  <h2>1. Information we process</h2>
  <p>When a merchant installs ${COMPANY} and their customers initiate returns, we
  process:</p>
  <ul>
    <li><strong>Merchant/store data</strong> — store domain, store name, contact
    email, and an encrypted Shopify access token used to call the Shopify API on
    the store's behalf.</li>
    <li><strong>Order data</strong> — order numbers, line items, SKUs, prices and
    fulfillment status, retrieved from Shopify when a customer looks up an order.</li>
    <li><strong>Customer data</strong> — the customer's name, email address and (for
    label generation) shipping/return address, plus any return reason and photos
    they upload.</li>
    <li><strong>Return records</strong> — items returned, reasons, resolution
    (refund / store credit / exchange), status, and shipping label details.</li>
  </ul>

  <h2>2. How we use it</h2>
  <ul>
    <li>To look up a customer's order and determine return eligibility against the
    merchant's policy.</li>
    <li>To create return requests, generate carrier shipping labels, and process
    refunds, store credit or exchanges through Shopify.</li>
    <li>To send transactional emails (return confirmation, approval, label, refund)
    to the customer.</li>
    <li>To produce aggregate analytics for the merchant (return rates, reasons, top
    returned SKUs).</li>
  </ul>
  <p>We do <strong>not</strong> sell personal data or use it for advertising.</p>

  <h2>3. Sub-processors</h2>
  <p>We share data only with infrastructure providers necessary to operate the
  service:</p>
  <div class="card">
    <ul>
      <li><strong>Supabase</strong> (PostgreSQL database hosting)</li>
      <li><strong>Railway</strong> (application hosting)</li>
      <li><strong>Upstash</strong> (Redis — job queue &amp; rate limiting)</li>
      <li><strong>Cloudflare R2</strong> (storage for return photos and labels)</li>
      <li><strong>Resend</strong> (transactional email delivery)</li>
      <li><strong>Sentry</strong> (error monitoring)</li>
      <li><strong>Shopify</strong> (the merchant's e-commerce platform)</li>
    </ul>
  </div>

  <h2>4. Data retention</h2>
  <p>Return records are retained for as long as the merchant keeps ${COMPANY}
  installed, so they can manage and report on returns. When a merchant uninstalls
  the app, or upon a valid deletion request, we delete or anonymise the relevant
  records and remove associated files from storage.</p>

  <h2>5. Security</h2>
  <p>Shopify access tokens are encrypted at rest using AES-256-GCM. All data in
  transit is protected with TLS. Access to production systems is restricted.</p>

  <h2>6. Your rights (GDPR / UK GDPR)</h2>
  <p>Customers may request access to, correction of, or deletion of their personal
  data. Because we process on behalf of the merchant, please direct requests to the
  store you purchased from; the merchant can action them through ${COMPANY}, and we
  honour Shopify's mandatory <code>customers/redact</code>,
  <code>customers/data_request</code> and <code>shop/redact</code> webhooks.</p>

  <h2>7. International transfers</h2>
  <p>Our infrastructure is hosted primarily in the EU/UK and US. Where data is
  transferred internationally, it is protected by appropriate safeguards.</p>

  <h2>8. Changes</h2>
  <p>We may update this policy from time to time. Material changes will be reflected
  by an updated effective date on this page.</p>

  <h2>9. Contact</h2>
  <p>Questions about this policy: <a href="mailto:${SUPPORT_EMAIL}">${SUPPORT_EMAIL}</a>.</p>
`);

const TERMS = page('Terms of Service', `
  <h1>Terms of Service</h1>
  <div class="meta">Effective ${EFFECTIVE_DATE}</div>

  <p>These Terms govern your use of ${COMPANY} (the "Service"), a returns-management
  application for Shopify merchants operated at ${DOMAIN}. By installing or using the
  Service you agree to these Terms.</p>

  <h2>1. The Service</h2>
  <p>${COMPANY} lets merchants offer a self-serve returns portal to their customers,
  generate carrier return labels, and process refunds, store credit and exchanges via
  the Shopify API. Features available depend on the merchant's selected plan.</p>

  <h2>2. Accounts &amp; eligibility</h2>
  <p>You must have a valid Shopify store and authority to install applications on it.
  You are responsible for activity that occurs under your store's installation.</p>

  <h2>3. Plans &amp; billing</h2>
  <p>Paid plans are billed through Shopify's Billing API according to the pricing
  shown in the app. Charges recur every 30 days until cancelled. Uninstalling the app
  cancels the subscription. Usage limits (e.g. monthly returns) apply per plan.</p>

  <h2>4. Acceptable use</h2>
  <ul>
    <li>Do not use the Service for unlawful purposes or to process data you have no
    right to process.</li>
    <li>Do not attempt to disrupt, reverse-engineer, or gain unauthorised access to
    the Service or its infrastructure.</li>
    <li>Do not use the Service to send unsolicited or abusive communications.</li>
  </ul>

  <h2>5. Carrier labels &amp; refunds</h2>
  <p>Shipping labels are generated through third-party carriers and are subject to
  those carriers' terms, availability and pricing. Refunds, gift cards and exchanges
  are executed through Shopify; ${COMPANY} initiates them at the merchant's direction
  but does not hold merchant funds.</p>

  <h2>6. Third-party services</h2>
  <p>The Service relies on Shopify and other providers listed in our
  <a href="/privacy">Privacy Policy</a>. We are not responsible for outages or changes
  in those third-party services, though we work to minimise their impact.</p>

  <h2>7. Availability</h2>
  <p>We aim for high availability but do not guarantee uninterrupted service. The
  Service is provided on an "as is" and "as available" basis.</p>

  <h2>8. Disclaimer &amp; limitation of liability</h2>
  <p>To the maximum extent permitted by law, ${COMPANY} disclaims all warranties,
  express or implied. ${COMPANY} shall not be liable for any indirect, incidental, or
  consequential damages, or for lost profits or data, arising from use of the Service.
  Our total liability for any claim is limited to the fees you paid for the Service in
  the 3 months preceding the claim.</p>

  <h2>9. Termination</h2>
  <p>You may stop using the Service at any time by uninstalling it. We may suspend or
  terminate access for breach of these Terms.</p>

  <h2>10. Changes</h2>
  <p>We may update these Terms; continued use after changes constitutes acceptance.
  The effective date above reflects the latest version.</p>

  <h2>11. Governing law</h2>
  <p>These Terms are governed by the laws of England and Wales.</p>

  <h2>12. Contact</h2>
  <p>Questions about these Terms: <a href="mailto:${SUPPORT_EMAIL}">${SUPPORT_EMAIL}</a>.</p>
`);

router.get('/privacy', (req, res) => res.type('html').send(PRIVACY));
router.get('/terms', (req, res) => res.type('html').send(TERMS));

module.exports = router;
