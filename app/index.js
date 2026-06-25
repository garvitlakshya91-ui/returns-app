require('dotenv').config();

const express = require('express');
const http = require('http');
const path = require('path');
const crypto = require('crypto');
const cookieParser = require('cookie-parser');
const helmet = require('helmet');
const cors = require('cors');
const compression = require('compression');
const pinoHttp = require('pino-http');

const logger = require('./utils/logger');

// ─── Sentry ───
// Must be initialized BEFORE express() so SDK can patch http to capture
// request spans. No-op when SENTRY_DSN is unset.
let Sentry = null;
if (process.env.SENTRY_DSN) {
  Sentry = require('@sentry/node');
  Sentry.init({
    dsn: process.env.SENTRY_DSN,
    environment: process.env.NODE_ENV || 'development',
    tracesSampleRate: 0.1,
    integrations: [
      Sentry.httpIntegration(),
      Sentry.expressIntegration(),
    ],
  });
  logger.info('Sentry initialized');
}

const app = express();
const PORT = process.env.PORT || 3000;

// Trust Railway / Cloudflare proxy for correct req.ip
app.set('trust proxy', 1);

// ─── Security middleware ───
// Shopify Admin embeds the app in an iframe, so X-Frame-Options:SAMEORIGIN
// (Helmet's default via frameguard) blocks it. CSP/COEP also interfere with
// the embed; we set our own frame-ancestors CSP below when a shop query
// param is present.
app.use(helmet({
  contentSecurityPolicy: false,
  crossOriginEmbedderPolicy: false,
  frameguard: false,
}));

// Per-request CSP:
//  - /admin (Shopify embed): scope frame-ancestors to the requesting shop +
//    admin.shopify.com so the embed works but no other origin can frame us.
//  - /portal and everywhere else: deny framing entirely, lock script-src to
//    self + the R2 public host (for hosted QR images / labels), restrict
//    img-src to self, data:, and R2. This shuts clickjacking + script
//    injection paths on the public customer portal.
const R2_PUBLIC = process.env.R2_PUBLIC_URL || '';
app.use((req, res, next) => {
  const shop = req.query.shop;
  if (shop && /^[a-z0-9][a-z0-9-]*\.myshopify\.com$/i.test(String(shop))) {
    res.setHeader(
      'Content-Security-Policy',
      `frame-ancestors https://${shop} https://admin.shopify.com;`,
    );
  } else if (req.path.startsWith('/portal') || req.path === '/') {
    const imgSrc = ["'self'", 'data:', 'blob:', 'https://cdn.shopify.com', R2_PUBLIC].filter(Boolean).join(' ');
    res.setHeader(
      'Content-Security-Policy',
      [
        "default-src 'self'",
        "script-src 'self'",
        "style-src 'self' 'unsafe-inline'", // Tailwind injects inline styles
        `img-src ${imgSrc}`,
        "connect-src 'self'",
        "font-src 'self' data:",
        "frame-ancestors 'none'",
        "base-uri 'self'",
        "form-action 'self'",
      ].join('; '),
    );
  }
  next();
});
app.use(compression());
app.use(pinoHttp({
  logger,
  // Per-request UUID — propagated to every log line tied to the request and
  // returned in the X-Request-Id response header for client-side tracing.
  // Honors an inbound X-Request-Id so callers can correlate across services.
  genReqId: (req, res) => {
    const incoming = req.headers['x-request-id'];
    const id = (incoming && /^[a-zA-Z0-9-]{1,128}$/.test(incoming))
      ? incoming
      : crypto.randomUUID();
    res.setHeader('X-Request-Id', id);
    return id;
  },
  serializers: {
    req: (req) => ({ id: req.id, method: req.method, url: req.url }),
    res: (res) => ({ statusCode: res.statusCode }),
  },
  autoLogging: {
    ignore: (req) => req.url === '/health',
  },
}));

// CORS — allow portal + Shopify Admin + local dev
app.use(cors({
  origin: (origin, cb) => {
    if (!origin) return cb(null, true); // Non-browser requests
    const allowed = [
      /\.myshopify\.com$/,
      /^https:\/\/admin\.shopify\.com$/,
      /^http:\/\/localhost:\d+$/,
      process.env.HOST,
      process.env.PORTAL_URL,
    ].filter(Boolean);
    const ok = allowed.some((a) => a instanceof RegExp ? a.test(origin) : a === origin);
    cb(ok ? null : new Error('Not allowed by CORS'), ok);
  },
  credentials: true,
}));

// ─── Raw body capture for webhook signature verification ───
// MUST be registered BEFORE express.json. Used by both Shopify HMAC and
// Stripe webhook signature checks.
app.use('/webhooks', (req, res, next) => {
  let data = '';
  req.setEncoding('utf8');
  req.on('data', (chunk) => { data += chunk; });
  req.on('end', () => {
    req.rawBody = data;
    try {
      req.body = JSON.parse(data);
    } catch {
      req.body = {};
    }
    next();
  });
});

// ─── Body parsers ───
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true, limit: '10mb' }));
app.use(cookieParser());

// ─── Health check ───
// Deep check used by Railway/Cloudflare uptime monitors. Returns 503 if
// any required dependency (DB, Redis) is unreachable so the platform stops
// routing traffic to a half-broken instance.
app.get('/health', async (req, res) => {
  const checks = { app: 'ok', db: 'unknown', redis: 'unknown' };
  let status = 200;

  try {
    const prisma = require('./config/database');
    await prisma.$queryRaw`SELECT 1`;
    checks.db = 'ok';
  } catch (err) {
    checks.db = `error: ${err.message}`;
    status = 503;
  }

  if (process.env.REDIS_URL) {
    try {
      const { getRedis } = require('./config/redis');
      const redis = getRedis();
      await redis.ping();
      checks.redis = 'ok';
    } catch (err) {
      checks.redis = `error: ${err.message}`;
      status = 503;
    }
  } else {
    checks.redis = 'not_configured';
  }

  res.status(status).json({
    status: status === 200 ? 'ok' : 'degraded',
    app: 'ReturnFlow',
    version: '1.0.0',
    env: process.env.NODE_ENV,
    checks,
    uptimeSeconds: Math.round(process.uptime()),
  });
});

// ─── Routes ───
// Public legal pages — required for the Shopify App Store listing.
app.use('/', require('./routes/legal'));
app.use('/', require('./routes/auth'));

// Stripe webhook must be mounted BEFORE the generic /webhooks router so it
// doesn't pick up the Shopify HMAC verification middleware applied there.
app.use('/webhooks/stripe', require('./routes/stripeWebhook'));
app.use('/webhooks', require('./routes/webhooks'));

// BullMQ admin dashboard — gated by basic auth from env. Mounted BEFORE the
// /admin SPA fallback so the queue UI takes precedence over the React router.
app.use('/admin/queues', require('./routes/queuesDashboard')());

const { adminLimiter } = require('./middleware/rateLimiter');
app.use('/api/portal', require('./routes/api/portal'));
app.use('/api/admin', adminLimiter);
app.use('/api/admin/returns', require('./routes/api/returns'));
app.use('/api/admin/analytics', require('./routes/api/analytics'));
app.use('/api/admin/policies', require('./routes/api/policies'));
app.use('/api/admin/carriers', require('./routes/api/carriers'));
app.use('/api/admin/settings', require('./routes/api/settings'));
app.use('/api/admin/billing', require('./routes/api/billing'));

// ─── Static file serving for built frontends ───
// Used by both `shopify app dev` (tunnel → backend) and production. If the
// dist directories don't exist yet, Express will just 404 — run `npm run build`
// or the per-app `npm --prefix web/<name> run build` first.
const portalDist = path.join(__dirname, '../web/portal/dist');
const merchantDist = path.join(__dirname, '../web/merchant/dist');

app.use('/portal', express.static(portalDist));
// `index: false` makes static only serve JS/CSS/assets, NOT auto-serve
// index.html — we want all HTML responses to go through getMerchantHtml()
// so the Shopify API key gets injected.
app.use('/admin', express.static(merchantDist, { index: false }));

// Serve the merchant SPA's index.html with the Shopify API key injected as
// window.__SHOPIFY_API_KEY__ so App Bridge can authenticate without needing a
// VITE_SHOPIFY_API_KEY at build time. Read once, patch on every request.
const fs = require('fs');
let merchantHtml = null;
function getMerchantHtml() {
  if (merchantHtml !== null) return merchantHtml;
  try {
    const raw = fs.readFileSync(path.join(merchantDist, 'index.html'), 'utf8');
    const inject = `<script>window.__SHOPIFY_API_KEY__ = ${JSON.stringify(process.env.SHOPIFY_API_KEY || '')};</script>`;
    merchantHtml = raw.replace('</head>', `${inject}</head>`);
  } catch {
    merchantHtml = ''; // dist not built yet — let Express 404 naturally
  }
  return merchantHtml;
}

function sendMerchantHtml(req, res) {
  const html = getMerchantHtml();
  if (!html) return res.status(404).send('Merchant SPA not built — run `npm run build:merchant`');
  res.type('html').send(html);
}

// SPA fallbacks — Express 5 requires a named splat instead of '*'
app.get('/portal/*splat', (req, res) => res.sendFile(path.join(portalDist, 'index.html')));
app.get(['/admin', '/admin/'], sendMerchantHtml);
app.get('/admin/*splat', sendMerchantHtml);

// Root: send Shopify embeds to /admin, everyone else to /portal
app.get('/', (req, res) => {
  if (req.query.shop) return res.redirect(`/admin?shop=${req.query.shop}&host=${req.query.host || ''}`);
  res.redirect('/portal');
});

// ─── Register event handlers ───
require('./events/handlers/onReturnCreated');
require('./events/handlers/onReturnApproved');
require('./events/handlers/onLabelGenerated');
require('./events/handlers/onRefundProcessed');

// ─── BullMQ workers ───
if (process.env.REDIS_URL) {
  require('./jobs/generateLabel.worker');
  require('./jobs/sendEmail.worker');
  require('./jobs/processRefund.worker');
  require('./jobs/aggregateAnalytics.worker');
  logger.info('BullMQ workers started');

  // Schedule nightly analytics — delay to let DB connect
  setTimeout(() => {
    require('./jobs/scheduler').scheduleNightlyAnalytics().catch((err) => {
      logger.error({ err }, 'Failed to schedule nightly analytics');
    });
  }, 5000);
}

// ─── Error handler ───
app.use((err, req, res, next) => {
  logger.error({ err, reqId: req.id }, 'Unhandled error');
  if (Sentry) {
    Sentry.withScope((scope) => {
      scope.setTag('requestId', req.id);
      scope.setTag('route', req.path);
      Sentry.captureException(err);
    });
  }
  res.status(err.status || 500).json({
    error: err.message || 'Internal server error',
    requestId: req.id,
  });
});

// ─── Start server ───
const server = http.createServer(app);
server.listen(PORT, () => {
  logger.info({ port: PORT, env: process.env.NODE_ENV }, 'ReturnFlow server running');
});

// ─── Graceful shutdown ───
const shutdown = async (signal) => {
  logger.info({ signal }, 'Shutting down gracefully');
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(1), 10000);
};
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));

module.exports = app;
