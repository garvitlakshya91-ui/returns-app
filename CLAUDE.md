# ReturnFlow — UK Returns & Reverse Logistics Platform for Shopify

## What You Are Building

You are building **ReturnFlow**, a Shopify app that helps UK e-commerce merchants manage product returns. It is a self-serve, affordable alternative to Loop Returns ($155/mo+) and ZigZag Global (enterprise-only), targeting UK SMB retailers on Shopify who currently have no dedicated returns management tool.

The app has two user-facing surfaces:
1. **Customer Returns Portal** — a standalone React SPA where end-customers initiate returns, upload photos, get carrier labels, and track refund status.
2. **Merchant Admin Dashboard** — embedded inside Shopify Admin using React + Shopify Polaris, where merchants view/manage returns, configure policies, and see analytics.

And one system surface:
3. **Shopify Webhook Handler** — receives order events from Shopify to keep data in sync.

---

## Architecture

### Principles
- **Modular monolith**: Single Node.js deployable. Internal modules communicate via an in-process event bus (EventEmitter). Split into microservices only at 2000+ merchants.
- **Multi-tenant**: Every database table has `shopId`. Every API call is scoped to the authenticated shop. One codebase, one database, all merchants.
- **Event-driven**: Every return action emits an event (`return.created`, `label.generated`, `refund.processed`). Handlers react to events. Today in-process, later swap to Redis pub/sub.
- **Carrier abstraction**: A `CarrierAdapter` interface defines `generateLabel()`, `getTrackingStatus()`, `getDropoffLocations()`. Each carrier (Evri, Royal Mail, InPost) is a separate adapter implementing this interface. Adding a new carrier = new adapter file, zero core changes.

### Tech Stack
- **Runtime**: Node.js 20 LTS
- **Framework**: Express.js (Shopify CLI scaffolds this)
- **Frontend (Merchant)**: React + Shopify Polaris (embedded in Shopify Admin via App Bridge)
- **Frontend (Customer Portal)**: React SPA with Tailwind CSS, hosted at `returns.returnflow.co.uk/{shop-slug}`
- **Database**: PostgreSQL via Prisma ORM, hosted on Supabase (free tier)
- **Cache / Job Queue**: Upstash Redis (free tier) + BullMQ for async jobs (label generation, email sending, refund processing)
- **File Storage**: Cloudflare R2 (S3-compatible, 10GB free) for return photos and label PDFs
- **Email**: Resend (3K emails/mo free) with React Email templates
- **Hosting**: Railway.app (auto-deploy from GitHub)
- **Monitoring**: Sentry free tier for error tracking
- **CI/CD**: GitHub Actions

### Project Structure

```
returnflow/
├── shopify.app.toml              # Shopify app config
├── extensions/
│   └── returns-portal/           # Shopify Theme App Extension (optional storefront block)
├── app/
│   ├── index.js                  # Express server entry point
│   ├── config/
│   │   ├── database.js
│   │   ├── redis.js
│   │   └── shopify.js            # Shopify API client setup
│   ├── middleware/
│   │   ├── auth.js               # Shopify session verification
│   │   ├── rateLimiter.js        # Rate limiting for portal API
│   │   └── planGating.js         # Check merchant plan limits
│   ├── routes/
│   │   ├── auth.js               # OAuth install/callback
│   │   ├── webhooks.js           # Shopify webhook receivers
│   │   ├── api/
│   │   │   ├── portal.js         # Customer-facing returns API
│   │   │   ├── returns.js        # Merchant returns management API
│   │   │   ├── analytics.js      # Analytics endpoints
│   │   │   ├── policies.js       # Return policy CRUD
│   │   │   ├── carriers.js       # Carrier config + drop-off lookup
│   │   │   ├── settings.js       # Shop settings
│   │   │   └── billing.js        # Shopify subscription billing
│   ├── services/
│   │   ├── ReturnService.js      # Core return lifecycle logic
│   │   ├── RefundService.js      # Shopify refund + gift card API
│   │   ├── ExchangeService.js    # Variant swap via Draft Orders
│   │   ├── PolicyEngine.js       # Evaluate return eligibility against rules
│   │   ├── AnalyticsService.js   # Aggregate + snapshot metrics
│   │   ├── NotificationService.js # Email dispatch
│   │   ├── BillingService.js     # Plan management + usage tracking
│   │   └── carriers/
│   │       ├── CarrierAdapter.js     # Abstract interface
│   │       ├── EvriAdapter.js        # Evri API: labels, tracking, ParcelShops
│   │       ├── RoyalMailAdapter.js   # Royal Mail Click & Drop
│   │       └── InPostAdapter.js      # InPost locker returns
│   ├── events/
│   │   ├── eventBus.js           # EventEmitter singleton
│   │   ├── emitters.js           # Named event constants
│   │   └── handlers/
│   │       ├── onReturnCreated.js
│   │       ├── onReturnApproved.js
│   │       ├── onLabelGenerated.js
│   │       └── onRefundProcessed.js
│   ├── jobs/
│   │   ├── queue.js              # BullMQ queue setup
│   │   ├── generateLabel.worker.js
│   │   ├── sendEmail.worker.js
│   │   ├── processRefund.worker.js
│   │   └── aggregateAnalytics.worker.js  # Nightly cron
│   └── utils/
│       ├── encryption.js         # Encrypt/decrypt Shopify tokens
│       ├── hmac.js               # Verify Shopify webhook HMAC
│       └── currency.js           # Format GBP amounts
├── web/
│   ├── merchant/                 # React app for Shopify Admin embed
│   │   ├── App.jsx
│   │   ├── pages/
│   │   │   ├── DashboardPage.jsx
│   │   │   ├── ReturnsListPage.jsx
│   │   │   ├── ReturnDetailPage.jsx
│   │   │   ├── AnalyticsPage.jsx
│   │   │   ├── PoliciesPage.jsx
│   │   │   └── SettingsPage.jsx
│   │   └── components/
│   │       ├── ReturnStatusBadge.jsx
│   │       ├── ReasonBreakdownChart.jsx
│   │       ├── MetricCard.jsx
│   │       └── PolicyRuleBuilder.jsx
│   └── portal/                   # Standalone customer returns portal
│       ├── App.jsx
│       ├── pages/
│       │   ├── LookupPage.jsx        # Enter email + order number
│       │   ├── SelectItemsPage.jsx   # Choose items to return
│       │   ├── ReturnReasonPage.jsx  # Reason + photo upload
│       │   ├── ResolutionPage.jsx    # Refund vs store credit vs exchange
│       │   ├── DropoffPage.jsx       # Choose carrier + nearest location
│       │   └── ConfirmationPage.jsx  # Summary + label delivery
│       └── components/
│           ├── OrderItemCard.jsx
│           ├── PhotoUploader.jsx
│           ├── DropoffMap.jsx
│           └── ProgressStepper.jsx
├── prisma/
│   └── schema.prisma
├── emails/                       # React Email templates
│   ├── ReturnConfirmed.jsx
│   ├── LabelReady.jsx
│   ├── RefundProcessed.jsx
│   └── ExchangeShipped.jsx
└── tests/
    ├── services/
    ├── routes/
    └── fixtures/
```

---

## Database Schema (Prisma)

```prisma
datasource db {
  provider = "postgresql"
  url      = env("DATABASE_URL")
}

generator client {
  provider = "prisma-client-js"
}

model Shop {
  id            String    @id @default(cuid())
  shopifyDomain String    @unique
  shopifyToken  String               // Encrypted
  name          String
  email         String
  plan          Plan      @default(FREE)
  currency      String    @default("GBP")
  settings      Json      @default("{}")
  returnCount   Int       @default(0)  // Current billing cycle count
  billingCycleStart DateTime?
  createdAt     DateTime  @default(now())
  updatedAt     DateTime  @updatedAt

  returns        Return[]
  policies       ReturnPolicy[]
  carrierConfigs CarrierConfig[]
  analytics      AnalyticsSnapshot[]
}

enum Plan { FREE STARTER GROWTH PRO }

model ReturnPolicy {
  id          String   @id @default(cuid())
  shopId      String
  shop        Shop     @relation(fields: [shopId], references: [id], onDelete: Cascade)
  name        String
  windowDays  Int      @default(30)
  conditions  Json     // { productTags: [], collections: [], minPrice: null, maxPrice: null }
  resolutions Json     // { allowRefund: true, allowStoreCredit: true, allowExchange: false }
  fees        Json?    // { changedMind: 2.50, doesntFit: 0, damaged: 0 }
  isDefault   Boolean  @default(false)
  isActive    Boolean  @default(true)
  createdAt   DateTime @default(now())
  updatedAt   DateTime @updatedAt

  @@index([shopId])
}

model Return {
  id              String       @id @default(cuid())
  shopId          String
  shop            Shop         @relation(fields: [shopId], references: [id], onDelete: Cascade)
  shopifyOrderId  String
  shopifyOrderName String
  customerEmail   String
  customerName    String
  status          ReturnStatus @default(REQUESTED)
  resolution      Resolution?
  totalValue      Decimal      @db.Decimal(10,2)
  currency        String       @default("GBP")
  returnFee       Decimal?     @db.Decimal(10,2)
  refundAmount    Decimal?     @db.Decimal(10,2)
  notes           String?
  createdAt       DateTime     @default(now())
  updatedAt       DateTime     @updatedAt
  processedAt     DateTime?

  items  ReturnItem[]
  label  ReturnLabel?
  events ReturnEvent[]

  @@index([shopId, status])
  @@index([shopId, createdAt])
  @@index([customerEmail])
}

enum ReturnStatus {
  REQUESTED
  APPROVED
  LABEL_SENT
  IN_TRANSIT
  RECEIVED
  INSPECTING
  PROCESSED
  REJECTED
  CANCELLED
}

enum Resolution { REFUND STORE_CREDIT EXCHANGE KEEP_ITEM }

model ReturnItem {
  id                String   @id @default(cuid())
  returnId          String
  return            Return   @relation(fields: [returnId], references: [id], onDelete: Cascade)
  shopifyLineItemId String
  shopifyProductId  String
  shopifyVariantId  String?
  productTitle      String
  variantTitle      String?
  sku               String?
  quantity          Int
  unitPrice         Decimal  @db.Decimal(10,2)
  reason            String
  reasonDetail      String?
  photoUrls         String[]
  condition         ItemCondition?
  disposition       Disposition?
  exchangeVariantId String?
  exchangeOrderId   String?

  @@index([returnId])
}

enum ItemCondition { NEW LIKE_NEW GOOD FAIR DAMAGED UNSELLABLE }
enum Disposition { RESTOCK DISCOUNT RESELL DONATE DISPOSE }

model ReturnLabel {
  id           String   @id @default(cuid())
  returnId     String   @unique
  return       Return   @relation(fields: [returnId], references: [id], onDelete: Cascade)
  carrier      String
  trackingCode String?
  labelUrl     String?
  qrCodeUrl    String?
  dropoffType  String?
  cost         Decimal? @db.Decimal(10,2)
  status       String   @default("created")
  createdAt    DateTime @default(now())
}

model CarrierConfig {
  id          String  @id @default(cuid())
  shopId      String
  shop        Shop    @relation(fields: [shopId], references: [id], onDelete: Cascade)
  carrier     String
  credentials Json
  isActive    Boolean @default(true)
  settings    Json?

  @@unique([shopId, carrier])
}

model ReturnEvent {
  id        String   @id @default(cuid())
  returnId  String
  return    Return   @relation(fields: [returnId], references: [id], onDelete: Cascade)
  type      String
  actor     String
  data      Json?
  createdAt DateTime @default(now())

  @@index([returnId, createdAt])
}

model AnalyticsSnapshot {
  id         String   @id @default(cuid())
  shopId     String
  shop       Shop     @relation(fields: [shopId], references: [id], onDelete: Cascade)
  period     String
  periodType String
  metrics    Json
  createdAt  DateTime @default(now())

  @@unique([shopId, period, periodType])
}
```

---

## API Endpoints

### Customer Portal API (Public, rate-limited, no auth — order lookup by email+order#)

```
POST   /api/portal/lookup              # { email, orderNumber, shopSlug } → eligible items
POST   /api/portal/returns             # Create return request
GET    /api/portal/returns/:id         # Get return status (requires email match)
POST   /api/portal/returns/:id/photos  # Upload item photos (multipart → R2)
GET    /api/portal/carriers/:shopId/dropoff?carrier=evri&postcode=GL1  # Nearest drop-off points
POST   /api/portal/returns/:id/pay     # Stripe Checkout for paid returns
```

### Merchant Admin API (Authenticated via Shopify session token, scoped to shopId)

```
GET    /api/admin/returns              # List returns (filter: status, date, reason)
GET    /api/admin/returns/:id          # Return detail with items, events, label
PUT    /api/admin/returns/:id/approve  # Approve → triggers label generation job
PUT    /api/admin/returns/:id/reject   # Reject with reason
PUT    /api/admin/returns/:id/process  # Process refund/credit/exchange via Shopify API
GET    /api/admin/analytics/summary    # Dashboard metrics
GET    /api/admin/analytics/skus       # Top returned SKUs with reason breakdown
GET    /api/admin/analytics/export     # CSV export
GET    /api/admin/policies             # List policies
POST   /api/admin/policies             # Create policy
PUT    /api/admin/policies/:id         # Update policy
GET    /api/admin/settings             # Shop settings
PUT    /api/admin/settings             # Update settings (branding, carriers, notifications)
```

### Shopify Webhooks (HMAC-verified, async processing via BullMQ)

```
POST   /webhooks/orders/create         # Sync order data
POST   /webhooks/orders/fulfilled      # Start return window countdown
POST   /webhooks/app/uninstalled       # Cleanup: deactivate shop, cancel billing
POST   /webhooks/shop/update           # Sync shop info changes
```

---

## Shopify API Scopes Needed

```
read_orders, write_orders          # Fetch orders, create draft orders for exchanges
read_products                       # Product/variant data for exchange flow
write_payment_terms                 # Not needed initially
read_customers                      # Customer data for fraud scoring later
write_gift_cards                    # Issue store credit as gift cards
read_shipping                       # Fulfillment status
```

---

## Carrier Adapter Interface

```javascript
// app/services/carriers/CarrierAdapter.js
class CarrierAdapter {
  constructor(config) {
    this.config = config; // CarrierConfig credentials + settings
  }

  // Generate a return shipping label
  // Returns: { trackingCode, labelUrl, qrCodeUrl, cost }
  async generateLabel({ senderAddress, recipientAddress, weight, dimensions }) {
    throw new Error('Not implemented');
  }

  // Get current tracking status
  // Returns: { status, lastUpdate, location, estimatedDelivery }
  async getTrackingStatus(trackingCode) {
    throw new Error('Not implemented');
  }

  // Find nearest drop-off locations
  // Returns: [{ id, name, address, lat, lng, distance, openingHours, type }]
  async getDropoffLocations({ postcode, limit = 5 }) {
    throw new Error('Not implemented');
  }

  // Get carrier name identifier
  get carrierName() {
    throw new Error('Not implemented');
  }
}

module.exports = CarrierAdapter;
```

Implement `EvriAdapter` first. Mock the API during development if Evri business account approval is pending. The adapter pattern means you can swap in real API calls later without changing any other code.

---

## Event System

```javascript
// app/events/emitters.js
module.exports = {
  RETURN_CREATED: 'return.created',
  RETURN_APPROVED: 'return.approved',
  RETURN_REJECTED: 'return.rejected',
  LABEL_GENERATED: 'label.generated',
  LABEL_FAILED: 'label.failed',
  RETURN_RECEIVED: 'return.received',
  REFUND_PROCESSED: 'refund.processed',
  EXCHANGE_CREATED: 'exchange.created',
  SHOP_INSTALLED: 'shop.installed',
  SHOP_UNINSTALLED: 'shop.uninstalled',
};
```

Event handlers (in `app/events/handlers/`) react to these events:
- `return.created` → Log ReturnEvent, send confirmation email, check auto-approve rules
- `return.approved` → Queue label generation job, send "approved" email
- `label.generated` → Update return status to LABEL_SENT, email customer with QR/label
- `refund.processed` → Update return status to PROCESSED, email customer confirmation, update analytics

---

## Build Order (What to Build First)

### Phase 1 — MVP (Sprints 1–5, Weeks 1–10)

Build in this exact order:

1. **Sprint 1**: Scaffold Shopify app (`npm init @shopify/app@latest`). Set up Prisma + Supabase. Implement OAuth. Register webhooks. Deploy to Railway.
2. **Sprint 2**: Build customer returns portal (React SPA). Order lookup → item selection → return reason → photo upload → confirmation. Mobile-first.
3. **Sprint 3**: Evri carrier integration. CarrierAdapter interface + EvriAdapter. QR code label generation. Email label to customer via Resend.
4. **Sprint 4**: Merchant dashboard (React + Polaris). Returns list, detail view, approve/reject. RefundService (Shopify Refund API + Gift Card API). Email notifications.
5. **Sprint 5**: Shopify Billing API (Free/Starter/Growth plans). Plan gating middleware. App Store listing. Submit for review.

**MVP deliverable**: Customer initiates return → gets Evri label → merchant approves → refund processed. Listed on Shopify App Store.

### Phase 2 — Growth (Sprints 6–9, Weeks 11–18)

6. **Sprint 6**: Exchanges (variant swap via Shopify Draft Orders) + Paid returns (Stripe Checkout for "changed mind" returns).
7. **Sprint 7**: Policy rules engine. Visual rule builder in merchant dashboard. Rules by product tag, collection, price, reason.
8. **Sprint 8**: Analytics dashboard. Pre-aggregated snapshots. Return rate trends, top returned SKUs, reason breakdowns, revenue retained. CSV export. **This is the competitive moat.**
9. **Sprint 9**: Royal Mail + InPost carrier adapters. Multi-carrier selection. Drop-off location finder with map.

### Phase 3 — Intelligence (Sprints 10–12, Weeks 19–24)

10. **Sprints 10-12**: Fraud scoring (serial returners, wardrobing). Bracketing detection. AI return prediction (rules first, ML later). WooCommerce plugin expansion.

---

## Pricing Plans (Implement via Shopify Billing API)

| Plan | Price | Returns/mo | Features |
|------|-------|-----------|----------|
| Free | £0 | 30 | Portal, 1 carrier (Evri), refund + store credit, basic dashboard |
| Starter | £9/mo | 150 | + 3 carriers, exchanges, paid returns, reason charts, CSV export |
| Growth | £29/mo | Unlimited | + full analytics, SKU insights, policy rules engine, A/B testing |
| Pro | £49/mo | Unlimited | + AI prediction, fraud detection, resale routing, API access |

---

## Key Technical Notes

1. **Shopify requires GraphQL Admin API** for all new apps as of April 2025. Do NOT use REST Admin API.
2. **HMAC verify every webhook** — Shopify signs webhooks with your app secret. Verify before processing.
3. **Encrypt Shopify access tokens** at rest in the database using `aes-256-gcm`. Never store plaintext.
4. **Rate limit the portal API** — it's public-facing. Use `express-rate-limit` with Upstash Redis store.
5. **Use Shopify Polaris components** for the merchant dashboard — it makes your app look native and passes App Store review faster.
6. **Process webhooks async** — respond 200 immediately, queue the actual processing via BullMQ. Shopify retries on timeout.
7. **Multi-tenant queries** — every Prisma query must include `where: { shopId }`. Create a helper: `prisma.return.findMany({ where: { shopId: session.shopId, ...filters } })`.
8. **Analytics snapshots** — don't query raw returns for dashboards. Pre-aggregate nightly into `AnalyticsSnapshot` table. Merchant dashboard reads snapshots.

---

## Environment Variables

```env
DATABASE_URL=postgresql://...                 # Supabase connection string
REDIS_URL=redis://...                         # Upstash Redis
SHOPIFY_API_KEY=...                           # From Shopify Partners Dashboard
SHOPIFY_API_SECRET=...                        # From Shopify Partners Dashboard
SCOPES=read_orders,write_orders,read_products,write_gift_cards,read_customers,read_shipping
HOST=https://returnflow.co.uk                 # Your app URL
ENCRYPTION_KEY=...                            # 32-byte hex for token encryption
RESEND_API_KEY=...                            # Resend email
R2_ACCOUNT_ID=...                             # Cloudflare R2
R2_ACCESS_KEY=...
R2_SECRET_KEY=...
R2_BUCKET=returnflow-uploads
STRIPE_SECRET_KEY=...                         # For paid returns (Growth tier)
SENTRY_DSN=...                                # Error tracking
```

---

## First Commands to Run

```bash
# 1. Create the Shopify app
npm init @shopify/app@latest
# Choose: Node.js + React template
# App name: returnflow

# 2. Enter the project
cd returnflow

# 3. Install additional dependencies
npm install prisma @prisma/client bullmq ioredis resend @aws-sdk/client-s3 stripe sentry/node express-rate-limit

# 4. Initialize Prisma
npx prisma init
# Paste the schema above into prisma/schema.prisma
# Set DATABASE_URL in .env

# 5. Run first migration
npx prisma migrate dev --name init

# 6. Start development
npm run shopify app dev
# This starts your app + creates a tunnel + opens it in your dev store
```

---

## Success Metrics

- **Month 3**: 50 installs, 5 paying merchants, £85 MRR
- **Month 6**: 200 installs, 30 paying, £680 MRR
- **Month 9**: 500 installs, 80 paying, £2,060 MRR
- **Month 12**: 1000 installs, 150 paying, £3,950 MRR

The app is live on the Shopify App Store as a free distribution channel. Shopify takes 0% commission on the first $1M USD in annual revenue. Merchants find you by searching "returns app UK". Zero sales team, zero BD cost, pure product-led growth.
