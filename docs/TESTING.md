# ReturnFlow — Test Summary (23 Aug 2026)

Pre-resubmission hardening pass. Everything below was run against commit `4137a1d` and the production deploy at https://app.returnsflow.uk.

## Headline numbers

| | Before | After |
|---|---|---|
| Test suites | 24 | **44** |
| Tests | 231 | **737** (all passing) |
| Line coverage | 68% | **94.7%** |
| Statement / branch / function coverage | 67% / 67% / 66% | **94.3% / 89.5% / 92.3%** |
| Production end-to-end (reviewer script) | manual | **`npm run e2e:review` — PASS** |

Run locally:

```bash
npm test                    # unit + route tests (~40s)
npm run test:coverage       # same, with coverage table
npm run e2e:review          # live reviewer rehearsal against production (creates a real order on the dev store)
```

## What the end-to-end rehearsal proves

`scripts/e2e-review-rehearsal.cjs` replays the exact path a Shopify reviewer walks, against production, and was run three times today (orders #1007, #1008, #1009):

1. Creates a real **paid** order on the dev store via the Admin API (real SALE transaction, real UK shipping address)
2. Customer side: portal lookup → return created (public portal API)
3. Merchant side: approve → label generated → **Process Refund** (admin API, authenticated with a session token signed by the app secret — what App Bridge mints)
4. Verifies on Shopify that the order's financial status is **REFUNDED**

Result: **PASS** — refund money moves on Shopify, label is a real carrier PDF hosted on R2, QR code hosted on R2. It also emits a warning when the label came from a Shippo *test* key (generic SAMPLE LABEL PDF) — that is the one remaining item before resubmission and needs a `shippo_live_` key in Railway.

Billing was verified live separately: selecting **Growth** on Shopify's hosted plan page → `app_subscriptions/update` webhook → store plan flipped to GROWTH → Analytics API returns real data.

## Suite map (44 files, 737 tests)

### Reviewer-critical paths

| Area | Files | Tests | What is covered |
|---|---|---|---|
| Billing & plans | `routes/billing.test.js` | 21 | Hosted-plans redirect on both Shopify App Pricing refusal wordings; test-charge for dev stores vs real charge for regular stores in production; fallback on store-type lookup failure; downgrade/cancel; confirm uses Shopify as source of truth; plan-name mapping incl. "Starter — £9/month" |
| Webhooks | `routes/webhooks.test.js`, `routes/webhooks.more.test.js` | 68 | HMAC rejection on every topic (missing/wrong/tampered); duplicate-delivery dedup; `app_subscriptions/update` for ACTIVE/CANCELLED/EXPIRED/DECLINED/FROZEN and managed-pricing plan names; uninstall resets plan to FREE and keeps settings; shop/update; orders/fulfilled window tracking; GDPR data_request / customers/redact / shop/redact |
| Approve → label → email → refund pipeline | `events/handlers.test.js`, `jobs/generateLabel.worker.test.js` | 23 | Each event handler's writes and emails; an email failure never blocks label generation; a label failure is caught (no unhandled rejection); listeners registered exactly once |
| Label generation | `services/LabelService.test.js`, `services/LabelService.generate.test.js` | 36 | Real order shipping address + store address fetched from Shopify and sent to the carrier; warehouse-settings override; graceful fallback; QR to R2 vs data URL; PDF re-host on R2 with fallback; `LABEL_SENT`/`LABEL_GENERATED`/`LABEL_FAILED`; managed-label billing only for real, non-simulated labels; billing failure cannot fail a created label; adapter selection & credential decryption |
| Refunds & exchanges | `services/RefundService*.test.js`, `services/ExchangeService*.test.js` | 78 | Refund against the original SALE/CAPTURE transaction (money actually moves); fee deduction; restock-only when no parent transaction; store credit via gift card; exchange draft orders with availability check (unresolvable variant → clear error); demo/non-real orders processed locally; no partial state on failure |
| Customer portal API | `routes/portal.test.js`, `routes/portal.more.test.js` | 61 | Exact-domain shop resolution from slug (no cross-tenant substring match); quoted/escaped Shopify search; email match; eligibility via PolicyEngine; return creation validation (orderId required, exchange gating by plan); status endpoint; photo upload limits/mimetypes/ownership; presigned uploads; drop-off lookup |
| Merchant admin API | `routes/adminReturns*.test.js`, `adminPolicies.test.js`, `adminSettings.test.js`, `adminAnalytics*.test.js`, `adminCarriers.test.js` | 122 | Tenant scoping on every query; approve/reject/process state rules; bulk actions with partial failure; demo return; policies whitelist (no mass assignment), single default, 404 for other shops; settings merge + protected system keys; analytics plan gating and error paths |
| Auth, install & tokens | `middleware/auth.test.js`, `routes/auth.test.js`, `services/shopInstall.test.js`, `services/ShopToken*.test.js` | 60 | Session-token verification; token-exchange bootstrap for fresh/reinstalled shops; expiring offline tokens (`expiring: true`), encrypted storage, auto-refresh with in-flight dedupe, 403 logging; legacy OAuth begin/callback |
| Plan gating & rate limits | `middleware/planGating.test.js`, `middleware/rateLimiter.test.js` | 33 | Per-plan monthly return limits; 429s on the public limiters with correct headers; Redis-backed prefixes; fail-open on store errors |

### Supporting services

| Area | Files | Tests | What is covered |
|---|---|---|---|
| Carrier adapters | `services/carriers.more.test.js`, `ShippoAdapter`, `ShipEngineAdapter`, `RoyalMailAdapter` tests | 70 | Live paths with mocked HTTP (non-OK responses, no rates, failed transactions, rate selection), simulation paths, address mapping defaults, tracking/drop-off shapes, base-class contract |
| Storage (R2) | `services/StorageService.test.js` | 23 | Not-configured guards (incl. missing public URL), key naming, content types, public URLs, presigned PUT/GET, bulk delete per return/shop |
| Email | `services/emailRenderer.test.js`, `services/NotificationService*.test.js` | 75 | Every template renders with branding and escapes HTML; queue-first with direct-send fallback; no-API-key path; Resend failures swallowed; logo/colour sanitisation |
| Policies & fees | `services/PolicyEngine.test.js`, `utils/fees.test.js` | 18 | Return window, tag/collection/price conditions, per-reason fees |
| Analytics | `services/AnalyticsService.test.js` | 7 | Summary/trend/SKU aggregation and snapshots |
| Utilities | `utils/*.test.js`, `smoke.test.js` | 32 | AES-256-GCM encryption, HMAC, currency, idempotency claims (Redis/in-memory) |

## Bugs found by the new tests and fixed (commit `4137a1d`)

| Severity | Where | Problem → fix |
|---|---|---|
| High | `routes/api/portal.js` lookup | Shop resolved by **substring** of the slug — a short slug could land on another merchant's store. Now exact `slug.myshopify.com` match with slug validation. |
| High | `routes/api/policies.js` | `PUT` passed the raw body to Prisma — a merchant could set `shopId` and re-home a policy to another tenant. Now a field whitelist; also 404 for other shops' policies, name required, one default per shop, JSON errors. |
| High | `routes/api/settings.js` | `PUT` **replaced** the settings blob, which could wipe the per-order fulfilment dates the return-window check relies on. Now merges and protects system keys. |
| Medium | `routes/webhooks.js` uninstall | Wiped all merchant settings (branding, warehouse address) on uninstall. Now keeps them and only stamps `uninstalledAt`. |
| Medium | `routes/webhooks.js` dedup | Missing `X-Shopify-Webhook-Id` produced the key `shopify:undefined`, so every later header-less webhook would be dropped as a duplicate. Now skips dedup when the header is absent. |
| Medium | `services/LabelService.js` | A billing error after a successful label would flip it to `LABEL_FAILED` and suppress the customer's label email. Billing is now isolated. |
| Medium | `services/StorageService.js` | Missing `R2_PUBLIC_URL` persisted `undefined/...` URLs. Now treated as not configured. |
| Low | `services/ExchangeService.js` | Unresolvable exchange variant passed the availability check; a missing draft order stamped `undefined` ids. Both now throw clear errors. |
| Low | `routes/api/portal.js` | Unquoted Shopify search string; `null` order email crashed to 500. Both fixed. |
| Low | `routes/api/returns.js`, `routes/auth.js` | Missing bulk body → 500 (now 400); invalid OAuth shop → 500 (now 400). |

## Known gaps (deliberately not covered)

- `routes/legal.js` (static privacy/terms pages) and `routes/queuesDashboard.js` (BullMQ board, admin-only) — static/dev tooling, 0% by choice.
- `config/*` — thin wrappers around Prisma/Redis/Shopify SDK clients.
- `customers/data_request` GDPR webhook acknowledges and logs but does not yet produce the export automatically — tracked as a follow-up; it is not a review blocker (Shopify requires the endpoint to respond 200 with a valid HMAC, which is tested).
- Browser UI (React) is not unit-tested; it is exercised manually and by the production E2E.

## Pre-resubmission checklist

- [x] 737 unit/route tests green, 94.7% line coverage
- [x] Production E2E rehearsal PASS (#1009): portal → approve → real label → refund → REFUNDED on Shopify
- [x] Upgrade flow verified live on Shopify App Pricing (Growth active, plan synced, Analytics unlocked)
- [x] Uninstall → reinstall re-requests charge approval (plan reset to FREE, settings preserved)
- [ ] **Swap `SHIPPO_API_KEY` in Railway to a `shippo_live_` key** so labels print real addresses instead of Shippo's SAMPLE LABEL — then run `npm run e2e:review` once more (should report no warnings)
- [ ] Resubmit in the Partner Dashboard
