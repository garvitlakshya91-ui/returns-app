# ReturnFlow

**Self-serve returns, carrier labels & exchanges for UK Shopify stores.**

ReturnFlow is a Shopify app that gives merchants a branded customer returns
portal and a Shopify-Admin dashboard to manage returns — an affordable,
self-serve alternative to enterprise returns platforms.

🌐 Live: **https://app.returnsflow.uk** &nbsp;·&nbsp; [Privacy](https://app.returnsflow.uk/privacy) · [Terms](https://app.returnsflow.uk/terms)

---

## What it does

Three surfaces, one Node deployable:

1. **Customer returns portal** (`/portal/<shop-slug>`) — a mobile-first React SPA.
   Customers look up an order by email + order number, pick items, give a reason
   (with photos), choose a resolution (refund / store credit / exchange), select a
   carrier drop-off, and get a return label.
2. **Merchant dashboard** — a React + Shopify Polaris app embedded in Shopify Admin.
   Returns list, detail, approve/reject/process, analytics, policies, settings.
3. **Webhook handler** — HMAC-verified Shopify webhooks (order sync, app lifecycle,
   billing subscription updates, GDPR).

## Architecture

- **Modular monolith** — single Express app; modules talk over an in-process event
  bus (`return.created`, `return.approved`, `label.generated`, `refund.processed`).
- **Multi-tenant** — every table carries `shopId`; every query is shop-scoped. One
  codebase, one database, all merchants.
- **Carrier abstraction** — a `CarrierAdapter` interface (`generateLabel`,
  `getTrackingStatus`, `getDropoffLocations`); Evri implemented (mocked pending a
  business account), Royal Mail + InPost stubbed. Adding a carrier = one new file.
- **Resilient by design** — rate limiters and idempotency **fail open** on a Redis
  outage; transactional emails fall back to a **direct send** when the queue is
  unavailable, so a Redis hiccup never blocks label generation or drops customer mail.

### Tech stack

| Layer | Tech |
|---|---|
| Runtime / framework | Node 20, Express 5 |
| Database | PostgreSQL (Supabase) via Prisma |
| Cache / queue | Upstash Redis + BullMQ |
| Storage | Cloudflare R2 (photos, labels, QR codes) |
| Email | Resend + React Email templates |
| Billing | Shopify Billing API (subscriptions) |
| Frontend | React 19 — Polaris (merchant) · Tailwind (portal) |
| Monitoring | Sentry |
| Hosting / CI | Railway · GitHub Actions |

## Project layout

```
app/                  Express backend
  config/             db, redis, shopify clients
  middleware/         auth (Shopify session), rate limiting, plan gating
  routes/             auth (OAuth), webhooks, legal, api/*
  services/           ReturnService, RefundService, ExchangeService,
                      PolicyEngine, AnalyticsService, LabelService, BillingService,
                      StorageService, NotificationService, carriers/
  events/             event bus + handlers
  jobs/               BullMQ queue + workers (label, email, refund, analytics)
  utils/              encryption (aes-256-gcm), hmac, currency, idempotency
emails/               React Email templates
web/merchant/         Polaris admin SPA (embedded)
web/portal/           Tailwind customer portal SPA
prisma/               schema + migrations
tests/                Jest + supertest (169 tests)
brand/                app icon + generated App Store screenshots
```

## Local development

```bash
# 1. install
npm install
npm --prefix web/portal install
npm --prefix web/merchant install --legacy-peer-deps

# 2. configure
cp .env.example .env        # then fill in the values

# 3. database
npx prisma migrate dev

# 4a. run the backend + tunnel via the Shopify CLI (embedded testing)
npx shopify app dev

# 4b. or run pieces directly
npm run dev                 # backend (nodemon)
npm --prefix web/portal run dev
npm --prefix web/merchant run dev
```

### Environment variables

See [`.env.example`](.env.example). Key ones: `DATABASE_URL` / `DIRECT_URL`
(Supabase pooler), `REDIS_URL` (Upstash), `SHOPIFY_API_KEY` / `SHOPIFY_API_SECRET`,
`ENCRYPTION_KEY` (32-byte hex), `R2_*`, `RESEND_API_KEY` / `RESEND_FROM`,
`HOST`, `PORTAL_URL`, `SENTRY_DSN`.

## Tests

```bash
npm test                # 169 tests
npm run test:coverage
```

Covers utils (encryption, hmac, currency, fees), services (policy, returns, refunds,
exchanges, billing, labels, notifications, analytics), middleware (auth, plan
gating), and routes (portal, admin, carriers, billing, Shopify webhooks) with all
external services mocked at the module boundary.

## Pricing plans

| Plan | Price | Returns/mo | Highlights |
|---|---|---|---|
| Free | £0 | 30 | Portal, Evri labels, refund + store credit |
| Starter | £9/mo | 150 | + exchanges, paid returns, CSV export |
| Growth | £29/mo | Unlimited | + full analytics, SKU insights, policy rules |
| Pro | £49/mo | Unlimited | + advanced features |

Billing runs through the Shopify Billing API; limits are enforced by `planGate`
middleware.

## Deployment

Hosted on Railway, auto-deploying from `main`. Build runs `prisma generate` + both
SPA builds; start runs `prisma migrate deploy && node app/index.js`. Health check at
`/health` reports app/db/redis status. Custom domain `app.returnsflow.uk` via
Cloudflare (DNS-only).

## App Store assets

Generated screenshots live in [`brand/screenshots/`](brand/screenshots) (captured
with `web/portal/scripts/shots.mjs` against the `?demo=1` seed mode). App icon at
[`brand/app-icon.svg`](brand/app-icon.svg).

---

_Built with [Claude Code](https://claude.com/claude-code)._
