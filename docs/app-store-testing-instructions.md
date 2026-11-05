# App Store listing — "Instruction notes" (testing instructions)

Paste the block below into the listing's **Instruction notes** field
(App Listing Submission → Testing instructions). Last updated 2026-11-05 after
the 2.1.1 rejection: adds the plan step (Shopify App Pricing does not force a
plan choice at install) and the no-credentials statement for 4.5.4 / 4.5.5.

```
ReturnFlow uses Shopify authentication. No separate login, test account, password, 2FA or external credentials are needed: everything runs inside the store admin, and return labels are bought server-side through our own carrier account, so there is nothing for you to sign in to.

SETUP (required, about 2 minutes)
1. Install the app. If Shopify shows its plan page during install, choose the Free plan (no monthly fee). Development stores get every plan at $0. If you skipped it, the Dashboard setup guide shows a "Choose a plan" step with the link; labels cannot be bought until a plan is selected.
2. Open the app: Apps > ReturnFlow.
3. Dashboard > "Turn on managed return labels" > Enable. Labels are then bought through our Shippo account and billed per label through your plan. Development stores are never charged.
4. Settings > Warehouse address: enter a UK returns address, e.g. 188 Chester Road North, Sutton Coldfield, B73 6SH. Approving a return is blocked until this is set, because labels are posted to it.
5. A default 30-day return policy is created on install (see Policies). No other setup is needed.

CREATE A TEST ORDER
6. In the store admin, create an order for a customer with an email address and a UK shipping address, and mark it as paid. Note the order number and the email.

CUSTOMER FLOW
7. Open the returns portal: https://app.returnsflow.uk/portal/STORE where STORE is the first part of your myshopify.com domain. The Dashboard setup guide also shows this link.
8. Enter the email and order number, choose an item and a reason, pick Refund or Store credit, and submit.

MERCHANT FLOW
9. In the app, open Returns and the new request, then click Approve.
10. A real Evri return label (PDF) is booked to the warehouse address and emailed to the customer. It appears on the return page under Shipping Label within a few seconds.
11. Click Process Refund. The refund is issued through Shopify (refundCreate) in the order's currency, to the original payment method or to the customer's store credit.

BILLING
12. Plans use Shopify App Pricing. Upgrading opens Shopify's hosted plan page. Development stores pay $0 for every plan and every label.

NOTES
- Exchanges are not offered yet; customers can choose a refund or store credit.
- Add ?demo=1 to a portal link to preview the customer flow with sample data.
```
