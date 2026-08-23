# ReturnFlow — Merchant User Guide

ReturnFlow is a returns & exchanges app for Shopify stores in the UK. Your customers start their own returns on a branded portal, get a carrier label instantly, and you approve, track and refund everything from inside Shopify admin.

This guide walks through everything from first install to your first refund, in the order you'll actually do it.

---

## 1. Install and first launch

1. Install **Returns** from the Shopify App Store (or your install link). Shopify will ask you to approve the permissions the app needs — orders, products, gift cards and shipping.
2. Open the app from **Shopify admin → Apps → Returns**. It runs inside your admin; there's no separate login.
3. On first launch you'll see a short welcome and a **Setup Guide** on the Dashboard with four steps. You can do them in any order, but this order is quickest:

| Step | What it does | Where |
|---|---|---|
| Connect a carrier | Lets the app create real return labels | Dashboard → Setup Guide, or Settings |
| Set your return address | Where customers post parcels back to | Settings → Return Warehouse Address |
| Customise your portal | Heading, brand colour, support email on the customer portal | Settings → Portal Branding |
| Share your returns portal | Your portal link to put in emails / your site | Dashboard → Setup Guide |

You can start on the **Free** plan — no card needed — and upgrade later from inside the app.

---

## 2. Labels: connect a carrier

Open **Settings** (or the carrier card on the Dashboard). There are two options:

### Managed labels (recommended — zero setup)
Click **Enable managed labels**. The app generates real Royal Mail / Evri return labels through its own carrier account — no carrier contract, no API keys. Postage is passed through to you at cost plus a small per-label service fee, billed on your Shopify invoice.

### Bring your own carrier (advanced)
If you already have a Royal Mail Click & Drop account, choose **Royal Mail**, paste your API credentials, and labels will be bought on your own account. (Evri and InPost own-account options are listed but not yet live.)

Either way, once connected, every approved return automatically gets a label and a QR code that's emailed to the customer.

> **Tip:** the **"How managed labels work"** link on the carrier card opens a short explainer if you want the detail.

---

## 3. Settings

**Settings** has four sections. Click **Save settings** at the bottom when you're done.

- **Shop Info** — your store name and contact email as the app knows them (synced from Shopify).
- **Portal Branding** — the heading customers see on the portal, your brand colour, your logo URL, and the support email shown to customers if they get stuck.
- **Notifications** — which emails the app sends to customers (return received, approved, label ready, refund processed) and whether you get a copy of new return requests.
- **Return Warehouse Address** — where parcels are sent. **Leave it blank to use your store's address from Shopify**; fill it in only if returns go somewhere different (a 3PL, a separate warehouse).

---

## 4. Your customer's journey (what the portal does)

Your portal lives at **`https://app.returnsflow.uk/portal/<your-store>`** — copy the exact link from Dashboard → Setup Guide → *Share your returns portal*. Put it in your order-confirmation emails, your site footer, and your returns policy page.

A customer:

1. **Looks up their order** — enters their email and order number.
2. **Selects the items** to return (only items inside the return window and allowed by your policy appear).
3. **Gives a reason** — *Changed mind*, *Doesn't fit*, *Damaged*, *Wrong item received* — with optional notes and photos (up to 5).
4. **Chooses a resolution** — refund to the original payment, store credit (a gift card), or an exchange for another item (Starter plan and up).
5. **Picks a drop-off** — the nearest ParcelShop / drop-off points are listed for their postcode.
6. **Gets confirmation** — and, once you approve, an email with their label and QR code. They can check progress any time on the return-status page linked from that email.

Everything is mobile-first; most customers will do this on their phone.

---

## 5. Handling returns

### The Returns list
**Returns** shows every request with status, customer, order, value and date. Filter by status, search by order number or email, and select several returns to **approve, reject or process in bulk**.

### A return's lifecycle
| Status | Meaning | What you do |
|---|---|---|
| **Requested** | Customer has submitted the return | Review → **Approve** or **Reject** |
| **Approved** | You approved; label is being generated | Nothing — it's automatic |
| **Label sent** | Label + QR emailed to the customer | Wait for the parcel |
| **In transit** | Carrier has scanned it | Wait |
| **Received** | Parcel arrived (you can mark this) | Inspect the item |
| **Inspecting** | You're checking condition | Decide |
| **Processed** | Refund / credit / exchange completed | Done ✅ |
| **Rejected** | You declined the request (customer is emailed your reason) | — |

### Approving, rejecting, processing
Open a return to see the items, reason, photos, customer, label and a full event timeline.

- **Approve** — the label is generated and emailed to the customer automatically. You'll see the tracking code and label on the return once it's ready (usually within seconds).
- **Reject** — give a short reason; the customer is emailed it.
- **Process Refund** — available once the return is approved or received. This issues the refund **through Shopify to the customer's original payment method**, creates the gift card for store credit, or creates the exchange order — whichever the customer chose. Any return fee from your policy is deducted from the refund automatically. The Shopify order updates to *Refunded*.

> **Good practice:** approve quickly (customers are waiting for a label) and process the refund once the parcel is back. Everything is logged on the return's timeline.

---

## 6. Policies (return rules)

**Policies** controls who can return what, and on what terms. Your default policy applies to everything; add more policies to treat specific products differently.

Each policy has:

- **Policy name** and **Active** toggle; **Set as default policy** for the catch-all.
- **Return window (days)** — counted from fulfilment (or order date if unfulfilled). Default 30.
- **Conditions** (Growth plan) — limit the policy to products with certain **tags**, in certain **collections**, or within a **min/max price**.
- **Resolutions allowed** — *Refund to original payment*, *Store credit (gift card)*, *Exchange for another item*.
- **Return fees by reason** — e.g. £2.50 for *Changed mind*, £0 for *Damaged*. Fees are never charged to the customer up-front; they're deducted from the refund, which keeps you compliant with Shopify's rules.

Customers only ever see options that your policy allows.

---

## 7. Analytics

**Analytics** (Growth plan; Free/Starter see a labelled sample) shows, for 7/30/90 days:

- **Return rate**, total returns, processed / pending / rejected
- **Value returned** and **revenue retained** (store credit + exchanges instead of cash refunds)
- **Return trend** over time
- **Top returned products** with a reason breakdown — the fastest way to spot a sizing or quality problem
- **CSV export** for your own reporting

Figures update nightly from your returns; use **Refresh** to pull the latest.

---

## 8. Plans and billing

| Plan | Price | Returns / month | Includes |
|---|---|---|---|
| **Free** | £0 | 30 | Portal, managed labels, refund + store credit, basic dashboard |
| **Starter** | ~£9 / mo | 150 | + exchanges, paid returns, reason charts, CSV export, more carriers |
| **Growth** | ~£29 / mo | Unlimited | + full analytics, SKU insights, policy rules engine |

- Paid plans come with a **14-day free trial** and are billed through Shopify on your normal Shopify invoice — no card details are ever entered in the app.
- **Upgrade:** click **Upgrade** (for example on the Analytics page). You'll be taken to Shopify's plan page for the app; pick a plan and approve. The app unlocks the moment Shopify confirms.
- **Downgrade / cancel:** choose Free on that same Shopify plan page, or uninstall the app — either way the subscription stops and you drop to Free. Reinstalling later asks for approval again.
- Managed-label postage is billed separately per label, as described in section 2.

---

## 9. Emails the app sends

Customers automatically get branded emails (your store name, colour and logo) at each step:

1. **Return request received** — confirmation with a summary
2. **Return approved / Label ready** — label PDF link + QR code + drop-off instructions
3. **Return rejected** — with your reason
4. **Refund processed** — what was refunded / credited / exchanged

Turn individual emails on or off under **Settings → Notifications**.

---

## 10. Troubleshooting

| Symptom | Likely cause | Fix |
|---|---|---|
| Customer can't find their order on the portal | Email or order number doesn't match the Shopify order exactly | Ask them to use the email on the order; order number with or without `#` both work. Very new orders can take a minute to become searchable. |
| No items appear after lookup | Items are outside the return window or excluded by a policy | Check **Policies** — window, tags/collections/price conditions |
| Return approved but no label yet | Carrier not connected, or label still generating | Check the carrier card in Settings; wait a few seconds and refresh. The return's timeline shows any label error. |
| "Upgrade" opens Shopify's plan page | That's expected — billing is handled by Shopify | Pick a plan there |
| Refund didn't appear in Shopify | Return not yet **Processed** | Open the return and click **Process Refund** |
| App says "Please reinstall" | Your store's access expired (for example after a long uninstall) | Reinstall from the App Store — your data is kept |

Still stuck? Use the support link in the app footer — it opens a pre-filled email to support with your store details.

---

## Appendix — quick start checklist

- [ ] Install and open the app
- [ ] Enable **managed labels** (or connect Royal Mail)
- [ ] Check **Return Warehouse Address** (blank = your store address)
- [ ] Set portal heading, colour, logo and support email
- [ ] Review the default **policy** (window, resolutions, fees)
- [ ] Copy your **portal link** into order emails and your site
- [ ] Make a test return on a real order → approve → check the label email → process the refund
- [ ] Upgrade when you need exchanges (Starter) or analytics (Growth)
