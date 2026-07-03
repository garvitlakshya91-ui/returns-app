# ReturnFlow — Go-to-Market Strategy

*Owner: Garvit · Written: July 2026 · Budget assumption: ~£0 cash, founder time only*

---

## 1. Positioning — the one sentence

> **"Returns management that UK Shopify stores can actually afford."**

Every competitor forces a bad choice on a UK SMB merchant:

| Competitor | Why merchants leave / avoid them |
|---|---|
| Loop Returns | $155+/mo minimum — more than most UK SMBs' entire app budget |
| AfterShip Returns | US-centric carriers, per-shipment fees stack up, upsell-heavy |
| ZigZag Global | Enterprise-only, no self-serve |
| Manual (email + spreadsheet) | The real competitor. ~80% of UK SMBs do returns by email. |

**ReturnFlow's wedge:** free to start, £9–£29 when it matters, UK carriers (Royal Mail, Evri) first-class, managed labels with zero carrier accounts. The enemy in all copy is **the returns inbox**, not other apps.

**Tagline candidates** (use consistently across listing, site, emails):
- "Returns off your plate."
- "The UK returns portal your customers expect — at a price that isn't silly."
- "Stop doing returns by email."

## 2. Target customer (be narrow on purpose)

**Primary ICP:** UK Shopify stores, 50–2,000 orders/month, fashion/apparel/footwear/accessories (highest return rates: 20–40%), 1–5 staff, currently handling returns via email.

- They feel returns pain **weekly** but can't justify $155/mo.
- Decision-maker = the founder. One person to convince, no procurement.
- Findable: UK e-commerce Facebook groups, r/shopify, Shopify Community, Twitter/X #ukecommerce, TikTok shop sellers.

**Secondary:** home & garden, gifts, kids' clothing (seasonal return spikes).

**Ignore for now:** enterprise, non-UK, WooCommerce (Phase-3 in roadmap, not GTM).

## 3. The engine: App Store search (this is 70% of the plan)

Merchants find returns apps by searching the Shopify App Store. Ranking inputs you control: install velocity, review count/rating, listing keyword relevance, retention.

### Listing optimisation
- **App name in listing:** "ReturnFlow: Returns & Exchanges" (keywords in the name matter).
- **Keywords to cover naturally in the listing copy:** returns, exchanges, return label, Royal Mail returns, Evri returns, UK returns, refund, store credit, returns portal, return policy.
- **First two lines of description** (visible before "read more") must contain: UK, free plan, Royal Mail/Evri labels.
- **Screenshots:** 6, in this order — (1) customer portal on a phone, (2) merchant dashboard, (3) one-click managed labels card, (4) analytics, (5) policy rules, (6) branded email. Caption each with a benefit, not a feature.
- **Demo video:** 30–60s. You already have the portal walkthrough recordings — cut to: customer starts return → gets QR label → merchant approves in one click → refund done.

### Review flywheel (the #1 ranking lever)
- Target: **15 reviews in the first 60 days.** Nothing else moves ranking as much.
- In-app: after a merchant processes their **3rd return**, show a polite one-time "Enjoying ReturnFlow? A review helps us a lot" card with a direct link. (Build: ~1 hr.)
- Personally email every install (Shopify gives you the store email): "I'm the founder, saw you installed — anything confusing?" Founders reply to founders. Then, once they're live: ask for the review.
- Never incentivise reviews (Shopify prohibits it) — but *asking* at the moment of value is allowed and works.

## 4. Launch sequence

### Phase 0 — while waiting for approval (this week)
1. **Fund Shippo + set the production key** — "managed labels" must be real before real merchants use it.
2. Landing page at **returnsflow.uk** (one page: hero, 3 benefits, pricing, screenshots, install CTA, founder note). Collect emails pre-launch.
3. Prepare the listing assets (screenshots, video, copy) so the listing is strong on day 1.
4. Set up plausible analytics: UTM links for every channel so you know what's working (App Store partner analytics + landing page).
5. Line up 5 "design partners": DM 20 UK store owners you can reach, offer free Growth plan for 6 months in exchange for feedback + (if they like it) a review. These become your first reviews and case study.

### Phase 1 — first 30 days after approval
- **Week 1:** soft launch. Design partners install. Fix whatever confuses them within 24h (speed = reviews).
- **Week 2:** community launch — one well-written post each (not spam, genuinely useful, mention the app once at the end):
  - r/shopify + r/ecommerce_uk: "What handling 500 UK returns taught me" style post
  - Shopify Community forums (Shipping & Returns board — answer existing questions, signature link)
  - 3–5 UK e-commerce Facebook groups (Ecommerce UK, Shopify UK Entrepreneurs, etc.)
- **Week 3:** cold outreach v1 — 10/day personal emails to UK fashion Shopify stores (find via UK store directories, Instagram shops). Template below.
- **Week 4:** first content pieces live (see §5).

### Phase 2 — days 30–90 (compound)
- Keep outreach at 10/day (300 total → expect ~5–8% install rate ≈ 20 installs).
- 1 SEO post/week.
- **Agency channel:** email 20 UK Shopify agencies (they choose apps for dozens of clients). Offer: free Growth for their clients' first 3 months + you do the setup. One agency = 5–20 installs.
- Apply for **"Built for Shopify"** status once eligible — big ranking boost.
- Iterate pricing/onboarding from real funnel data (see §7).

## 5. Content/SEO (slow but free and compounding)

Target long-tail UK queries where big competitors don't bother. One post/week, publish on returnsflow.uk/blog:

1. "Shopify returns UK: the complete setup guide (2026)"
2. "Royal Mail returns for Shopify — every option compared"
3. "Evri vs Royal Mail vs InPost for e-commerce returns"
4. "Free returns policy template for UK stores (copy-paste)"
5. "Loop Returns alternatives for small UK stores"  ← comparison pages convert best
6. "AfterShip Returns vs ReturnFlow"
7. "How much do returns actually cost a UK Shopify store?"

Each ends with the same CTA: free plan, 2-minute setup.

## 6. Pricing & packaging in GTM terms

- **Free (30 returns/mo)** is the growth engine — a small store may never pay, and that's fine: they leave reviews and refer. Cost to serve ≈ £0.
- **Trial:** 14 days on paid tiers (already built) — push upgrades in-app at the moment of hitting a limit (already built: teaser analytics, plan gates).
- **Anchor against Loop in all copy:** "From £0. Loop starts at $155/mo."
- Managed labels billed per-label via Shopify usage billing = revenue that scales with merchant success, no card friction.

## 7. Funnel metrics — check weekly, one dashboard

| Stage | Metric | Healthy target |
|---|---|---|
| Discover | App Store page views | growing w/w |
| Install | Views → installs | ≥ 20% |
| Activate | Installs that process 1st return in 7 days | ≥ 40% |
| Convert | Free → paid after 60 days | ≥ 10% |
| Advocate | Installs → review | ≥ 15% |
| Retain | 90-day uninstall rate | ≤ 30% |

The roadmap's own targets (50 installs / 5 paying by month 3) need ~2 installs/day by month 3 — achievable from search + outreach + one good community post.

**Activation is the silent killer** — a merchant who installs but never processes a return will uninstall. The setup guide + demo return + managed-labels one-click (all built) exist exactly for this. Watch the "Activate" row hardest.

## 8. Outreach templates

**Cold email to store founder (keep under 90 words):**
> Subject: returns at {{store name}}
>
> Hi {{first name}} — found {{store}} via {{where}}; the {{product}} looks great.
>
> Quick question: how are you handling returns right now? Most UK stores your size do it over email, which eats hours and annoys customers.
>
> I built ReturnFlow — a returns portal for UK Shopify stores. Customers self-serve, Royal Mail/Evri labels are automatic, and it's free up to 30 returns/month.
>
> Worth a look? 2-minute setup: {{app store link}}
>
> — Garvit (founder, reply anytime)

**Agency pitch:** same shape, but the offer is "free Growth plan for your clients for 3 months, I'll do the setup on a call."

## 9. What NOT to do (yet)

- ❌ Paid ads (App Store ads/Google) — unit economics don't work at £9–29/mo until conversion data exists.
- ❌ Influencer/affiliate programs — needs volume first.
- ❌ WooCommerce port, US expansion — focus is the moat.
- ❌ More features before 20 active merchants — sell what's built; the roadmap is already ahead of the market at this price point.

## 10. This week's checklist

- [ ] Fund Shippo, set `SHIPPO_API_KEY` in Railway (makes managed labels real)
- [ ] Landing page live at returnsflow.uk
- [ ] Listing assets final: 6 screenshots, 60s video, keyword-optimised copy
- [ ] In-app review prompt after 3rd processed return
- [ ] List of 20 design-partner candidates + send first 10 DMs
- [ ] UTM/analytics wiring so every channel is measurable
