require('dotenv').config();

const express = require('express');
const http = require('http');
const path = require('path');
const cookieParser = require('cookie-parser');
const helmet = require('helmet');
const cors = require('cors');
const compression = require('compression');
const pinoHttp = require('pino-http');

const logger = require('./utils/logger');

// ─── Sentry ───
if (process.env.SENTRY_DSN) {
  const Sentry = require('@sentry/node');
  Sentry.init({ dsn: process.env.SENTRY_DSN, environment: process.env.NODE_ENV });
}

const app = express();
const PORT = process.env.PORT || 3000;

// Trust Railway / Cloudflare proxy for correct req.ip
app.set('trust proxy', 1);

// ─── Security middleware ───
app.use(helmet({
  contentSecurityPolicy: false, // Shopify Admin embedding needs this disabled
  crossOriginEmbedderPolicy: false,
}));
app.use(compression());
app.use(pinoHttp({
  logger,
  serializers: {
    req: (req) => ({ method: req.method, url: req.url }),
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
app.get('/health', (req, res) => {
  res.json({ status: 'ok', app: 'ReturnFlow', version: '1.0.0', env: process.env.NODE_ENV });
});

// ─── Routes ───
app.use('/', require('./routes/auth'));

// Stripe webhook must be mounted BEFORE the generic /webhooks router so it
// doesn't pick up the Shopify HMAC verification middleware applied there.
app.use('/webhooks/stripe', require('./routes/stripeWebhook'));
app.use('/webhooks', require('./routes/webhooks'));

app.use('/api/portal', require('./routes/api/portal'));
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
app.use('/admin', express.static(merchantDist));

// SPA fallbacks — Express 5 requires a named splat instead of '*'
app.get('/portal/*splat', (req, res) => res.sendFile(path.join(portalDist, 'index.html')));
app.get('/admin/*splat', (req, res) => res.sendFile(path.join(merchantDist, 'index.html')));

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
  logger.error({ err }, 'Unhandled error');
  if (process.env.SENTRY_DSN) {
    const Sentry = require('@sentry/node');
    Sentry.captureException(err);
  }
  res.status(err.status || 500).json({ error: err.message || 'Internal server error' });
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
