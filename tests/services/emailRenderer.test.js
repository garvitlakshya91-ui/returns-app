// emailRenderer: renders the React Email templates in emails/*.jsx and
// dispatches via Resend.
//
// Two things stand between Jest and the real templates:
//  1. The templates are JSX. Jest's default transform can't parse them and
//     esbuild-register's require hook doesn't apply inside Jest's module
//     system, so we compile each template with esbuild ourselves and hand
//     the compiled module to Jest via jest.doMock on the exact file path the
//     renderer requires.
//  2. @react-email/render v2 uses a dynamic import() of react-dom/server,
//     which Jest's CJS sandbox can't execute. We swap in react-dom/server's
//     synchronous renderer. The templates and @react-email/components are
//     the real ones, so the markup assertions below are about real output.

const path = require('path');
const fs = require('fs');
const esbuild = require('esbuild');
const { installResendMock } = require('../helpers');

const EMAILS_DIR = path.resolve(__dirname, '..', '..', 'emails');
const TEMPLATE_NAMES = ['ReturnConfirmed', 'ReturnApproved', 'LabelReady', 'RefundProcessed', 'ReturnRejected'];

const jsxCache = new Map();
function loadJsx(file) {
  if (jsxCache.has(file)) return jsxCache.get(file);
  const src = fs.readFileSync(file, 'utf8');
  const { code } = esbuild.transformSync(src, { loader: 'jsx', jsx: 'automatic', format: 'cjs' });
  const m = { exports: {} };
  const req = (id) => {
    if (id.startsWith('.')) {
      return loadJsx(path.resolve(path.dirname(file), id.endsWith('.jsx') ? id : `${id}.jsx`));
    }
    return require(id); // react/jsx-runtime, @react-email/components — same copies the renderer uses
  };
  new Function('require', 'module', 'exports', code)(req, m, m.exports);
  jsxCache.set(file, m.exports);
  return m.exports;
}

for (const name of TEMPLATE_NAMES) {
  const file = path.join(EMAILS_DIR, `${name}.jsx`);
  loadJsx(file); // compile eagerly so every template binds to the same React copy
  jest.doMock(file, () => loadJsx(file));
}

jest.doMock('@react-email/render', () => {
  const { renderToStaticMarkup } = require('react-dom/server');
  return { render: async (node) => `<!DOCTYPE html>${renderToStaticMarkup(node)}` };
});

// 'resend' is required lazily inside sendEmailNow, so registering the mock
// here (before any call) is enough. The send spy is shared across module
// resets (jest.config has resetModules: true); the Resend constructor must be
// re-required inside each test to observe the instance the renderer used.
const resend = installResendMock();
const ResendCtor = () => require('resend').Resend;

const { renderTemplate, sendEmailNow } = require('../../app/services/emailRenderer');

const BRAND = { name: 'Wildgrove & Co.', color: '#FF8800', supportEmail: 'help@wildgrove.co', logoUrl: 'https://wildgrove.co/logo.png' };

// Strip tags so we can assert on visible text regardless of inline styling.
const text = (html) => html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ');

afterEach(() => {
  delete process.env.RESEND_API_KEY;
  delete process.env.RESEND_FROM;
});

describe('renderTemplate — fallback for unknown templates', () => {
  it('renders a generic notification with the template name and a JSON dump of the data', async () => {
    const html = await renderTemplate('SomethingNew', { orderName: '#77', nested: { a: 1 } });
    expect(html).toContain('<p>Notification: SomethingNew</p>');
    expect(html).toContain('"orderName": "#77"');
    expect(html).toContain('"a": 1');
  });
});

describe('renderTemplate — every template', () => {
  it.each(TEMPLATE_NAMES)('%s renders a full HTML document carrying the order name, return id and brand', async (name) => {
    const html = await renderTemplate(name, {
      customerName: 'Jane', orderName: '#1001', returnId: 'ret_abc', carrier: 'evri', brand: BRAND,
    });
    expect(html.startsWith('<!DOCTYPE html>')).toBe(true);
    expect(html).toContain('<html');
    expect(html).toContain('<strong>#1001</strong>');
    expect(html).toContain('Return ID: ret_abc');
    expect(html).toContain('Hi Jane,');
    // Brand: logo image (alt = merchant name) + support line + ReturnFlow footer
    expect(html).toContain('src="https://wildgrove.co/logo.png"');
    expect(html).toContain('alt="Wildgrove &amp; Co."');
    expect(html).toContain('Questions? Contact help@wildgrove.co');
    expect(html).toContain('Powered by ReturnFlow');
  });

  it.each(TEMPLATE_NAMES)('%s renders with no data at all (missing fields degrade gracefully)', async (name) => {
    const html = await renderTemplate(name, {});
    expect(html).toContain('Hi there,');
    expect(html).toContain('ReturnFlow'); // default brand name in the header
    expect(html).toContain('Powered by ReturnFlow');
  });

  it.each(TEMPLATE_NAMES)('%s HTML-escapes customer-controlled strings', async (name) => {
    const html = await renderTemplate(name, {
      customerName: '<script>alert(1)</script>',
      orderName: '#1 & "two"',
      reason: '<img src=x onerror=alert(1)>',
      brand: { name: 'Shop <b>Bold</b>' },
    });
    expect(html).not.toContain('<script>');
    expect(html).toContain('&lt;script&gt;alert(1)&lt;/script&gt;');
    expect(html).not.toContain('<img src=x');
    expect(html).toContain('#1 &amp; &quot;two&quot;');
    expect(html).not.toContain('<b>Bold</b>');
  });
});

describe('renderTemplate — branding (BaseLayout)', () => {
  it('shows the brand name in the brand colour when there is no logo', async () => {
    const html = await renderTemplate('ReturnApproved', { orderName: '#1', brand: { name: 'Wildgrove', color: '#123ABC' } });
    expect(html).toMatch(/<p[^>]*color:#123ABC[^>]*>Wildgrove<\/p>/);
    expect(html).not.toContain('<img');
  });

  it('replaces the brand text with the logo image when a logoUrl is provided', async () => {
    const html = await renderTemplate('ReturnApproved', { orderName: '#1', brand: BRAND });
    expect(html).toMatch(/<img[^>]*alt="Wildgrove &amp; Co\."[^>]*src="https:\/\/wildgrove\.co\/logo\.png"/);
    expect(html).not.toMatch(/>Wildgrove &amp; Co\.<\/p>/);
  });

  it('falls back to ReturnFlow / indigo defaults when brand is missing or empty', async () => {
    for (const brand of [undefined, {}]) {
      const html = await renderTemplate('ReturnApproved', { orderName: '#1', brand });
      expect(html).toMatch(/<p[^>]*color:#4F46E5[^>]*>ReturnFlow<\/p>/);
      expect(html).not.toContain('Questions? Contact');
    }
  });

  it('puts the order name in the inbox preview text', async () => {
    const html = await renderTemplate('ReturnRejected', { orderName: '#555' });
    expect(html).toContain('Update on your return for #555');
  });
});

describe('renderTemplate — ReturnConfirmed', () => {
  it('lists each item with variant, quantity and reason', async () => {
    const html = await renderTemplate('ReturnConfirmed', {
      customerName: 'Jane', orderName: '#1001', returnId: 'r1',
      items: [
        { title: 'Wool jumper', variant: 'M / Navy', quantity: 2, reason: 'doesnt_fit' },
        { title: 'Socks', quantity: 1, reason: 'damaged' },
      ],
    });
    const t = text(html);
    expect(t).toContain('Items');
    expect(t).toContain('Wool jumper — M / Navy');
    expect(t).toContain('Qty 2 · Reason: doesnt_fit');
    expect(t).toContain('Socks'); // no variant → no dash suffix
    expect(t).not.toContain('Socks —');
    expect(t).toContain('Qty 1 · Reason: damaged');
    expect(t).toContain('We received your return request for #1001');
  });

  it('omits the Items section when there are no items', async () => {
    for (const items of [undefined, []]) {
      const html = await renderTemplate('ReturnConfirmed', { orderName: '#1001', returnId: 'r1', items });
      expect(text(html)).not.toMatch(/\bItems\b/);
      expect(html).toContain('Return request received');
    }
  });
});

describe('renderTemplate — LabelReady', () => {
  const data = {
    customerName: 'Jane', orderName: '#1001', returnId: 'r1',
    labelUrl: 'https://cdn.test/label.pdf', qrCodeUrl: 'https://cdn.test/qr.png',
    carrier: 'evri', trackingCode: 'EVR123ABC', brand: BRAND,
  };

  it('shows carrier, tracking code, the QR image and a Download label button linking to the label', async () => {
    const html = await renderTemplate('LabelReady', data);
    const t = text(html);
    expect(t).toContain('Carrier: evri');
    expect(t).toContain('Tracking: EVR123ABC');
    expect(t).toContain('Show this QR code at any evri drop-off point');
    expect(html).toMatch(/<img[^>]*alt="QR code"[^>]*src="https:\/\/cdn\.test\/qr\.png"/);
    expect(html).toMatch(/<a[^>]*href="https:\/\/cdn\.test\/label\.pdf"[^>]*>[\s\S]*?Download label/);
    expect(t).toContain('Your return label for #1001 is ready');
  });

  it('tints the heading and button with the brand colour, defaulting to indigo', async () => {
    const branded = await renderTemplate('LabelReady', data);
    expect(branded).toMatch(/<h1[^>]*color:#FF8800/);
    expect(branded).toMatch(/<a[^>]*background-color:#FF8800/);

    const plain = await renderTemplate('LabelReady', { ...data, brand: undefined });
    expect(plain).toMatch(/<h1[^>]*color:#4F46E5/);
    expect(plain).toMatch(/<a[^>]*background-color:#4F46E5/);
  });

  it('drops the tracking line, QR block and download button when those values are absent', async () => {
    const html = await renderTemplate('LabelReady', { ...data, trackingCode: null, qrCodeUrl: null, labelUrl: null });
    const t = text(html);
    expect(t).toContain('Carrier: evri');
    expect(t).not.toContain('Tracking:');
    expect(html).not.toContain('alt="QR code"');
    expect(t).not.toContain('Download label');
    expect(html).not.toContain('<a '); // no button at all
  });
});

describe('renderTemplate — RefundProcessed', () => {
  const base = { customerName: 'Jane', orderName: '#1001', returnId: 'r1', resolutionText: 'refunded to your original payment method' };

  it('formats GBP amounts with a £ sign and two decimals', async () => {
    const html = await renderTemplate('RefundProcessed', { ...base, refundAmount: 47.5, currency: 'GBP' });
    const t = text(html);
    expect(t).toContain('£47.50');
    expect(t).toContain('Refund amount');
    expect(t).toContain('has been refunded to your original payment method.');
  });

  it.each([
    ['USD', '$12.00'],
    ['EUR', '€12.00'],
    ['CHF', 'CHF 12.00'],
    [undefined, '£12.00'],
    ['gbp', '£12.00'],
  ])('uses the right symbol for %s', async (currency, expected) => {
    const html = await renderTemplate('RefundProcessed', { ...base, refundAmount: 12, currency });
    expect(text(html)).toContain(expected);
  });

  it('falls back to £0.00 and "processed" when amount / resolution text are missing', async () => {
    const html = await renderTemplate('RefundProcessed', { orderName: '#1001', returnId: 'r1' });
    const t = text(html);
    expect(t).toContain('£0.00');
    expect(t).toContain('has been processed.');
  });

  it('coerces numeric strings (e.g. Prisma Decimal serialised through the queue)', async () => {
    const html = await renderTemplate('RefundProcessed', { ...base, refundAmount: '19.9', currency: 'GBP' });
    expect(text(html)).toContain('£19.90');
  });
});

describe('renderTemplate — ReturnRejected / ReturnApproved', () => {
  it('ReturnRejected shows the merchant reason in a callout only when given', async () => {
    const withReason = await renderTemplate('ReturnRejected', { orderName: '#1', returnId: 'r', reason: 'Outside the 30-day window' });
    expect(text(withReason)).toContain('Reason: Outside the 30-day window');
    expect(text(withReason)).toContain('could not be approved');

    const without = await renderTemplate('ReturnRejected', { orderName: '#1', returnId: 'r' });
    expect(text(without)).not.toContain('Reason:');
  });

  it('ReturnApproved tells the customer the label is on its way', async () => {
    const html = await renderTemplate('ReturnApproved', { customerName: 'Jane', orderName: '#1', returnId: 'r' });
    const t = text(html);
    expect(t).toContain('Return approved');
    expect(t).toContain('has been approved');
    expect(t).toContain('shipping label by email shortly');
  });
});

describe('sendEmailNow', () => {
  const msg = { to: 'jane@example.com', subject: 'Your label', template: 'LabelReady', data: { orderName: '#42', carrier: 'evri' } };

  it('skips Resend entirely in dev mode (no RESEND_API_KEY) but still reports the email as sent', async () => {
    delete process.env.RESEND_API_KEY;
    const out = await sendEmailNow(msg);
    expect(out).toEqual({ sent: true, to: 'jane@example.com', subject: 'Your label' });
    expect(ResendCtor()).not.toHaveBeenCalled();
    expect(resend.send).not.toHaveBeenCalled();
  });

  it('renders the template and sends through Resend with the default from-address when a key is set', async () => {
    process.env.RESEND_API_KEY = 're_test_123';
    const out = await sendEmailNow(msg);

    expect(ResendCtor()).toHaveBeenCalledWith('re_test_123');
    expect(resend.send).toHaveBeenCalledTimes(1);
    const payload = resend.send.mock.calls[0][0];
    expect(payload).toMatchObject({ from: 'ReturnFlow <onboarding@resend.dev>', to: 'jane@example.com', subject: 'Your label' });
    expect(payload.html).toContain('<strong>#42</strong>');
    expect(payload.html).toContain('Your return label is ready');
    expect(out).toEqual({ sent: true, to: 'jane@example.com', subject: 'Your label' });
  });

  it('honours RESEND_FROM as the sender', async () => {
    process.env.RESEND_API_KEY = 're_test_123';
    process.env.RESEND_FROM = 'Wildgrove Returns <returns@wildgrove.co>';
    await sendEmailNow(msg);
    expect(resend.send.mock.calls[0][0].from).toBe('Wildgrove Returns <returns@wildgrove.co>');
  });

  it('propagates Resend failures so the queue worker can retry', async () => {
    process.env.RESEND_API_KEY = 're_test_123';
    resend.send.mockRejectedValueOnce(new Error('rate limited'));
    await expect(sendEmailNow(msg)).rejects.toThrow('rate limited');
  });

  it('sends the generic fallback markup for unknown templates rather than failing', async () => {
    process.env.RESEND_API_KEY = 're_test_123';
    await sendEmailNow({ ...msg, template: 'Mystery', data: { x: 1 } });
    expect(resend.send.mock.calls[0][0].html).toContain('Notification: Mystery');
  });
});
