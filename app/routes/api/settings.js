const { Router } = require('express');
const { verifyShopifySession } = require('../../middleware/auth');
const prisma = require('../../config/database');
const logger = require('../../utils/logger');

const router = Router();
router.use(verifyShopifySession);

router.get('/', async (req, res) => {
  try {
  const shop = await prisma.shop.findUnique({
    where: { id: req.shopId },
    select: { name: true, email: true, plan: true, currency: true, settings: true, shopifyDomain: true },
  });

  // Surface the public customer-portal URL so the dashboard setup guide can
  // show / share it. The portal is served at /portal/:shopSlug, where the slug
  // is the first label of the myshopify domain (matched in the lookup route).
  const slug = shop?.shopifyDomain ? shop.shopifyDomain.split('.')[0] : '';
  const base = (process.env.PORTAL_URL || process.env.HOST || '').replace(/\/$/, '');
  const portalUrl = base && slug ? `${base}/portal/${slug}` : '';

  res.json({ ...shop, portalUrl });
  } catch (err) {
    logger.error({ err }, 'Load settings error');
    res.status(500).json({ error: 'Failed to load settings' });
  }
});

// Keys the app itself maintains inside Shop.settings. A dashboard save must
// never overwrite them — e.g. `fulfillments` holds the per-order fulfilment
// dates the return-window check depends on.
const SYSTEM_KEYS = ['fulfillments', 'uninstalledAt'];

router.put('/', async (req, res) => {
  try {
    const incoming = req.body?.settings;
    if (!incoming || typeof incoming !== 'object' || Array.isArray(incoming)) {
      return res.status(400).json({ error: 'settings must be an object' });
    }

    // Merge into what's stored instead of replacing it wholesale, so a stale
    // dashboard snapshot can't wipe keys written since the page loaded.
    const current = await prisma.shop.findUnique({ where: { id: req.shopId }, select: { settings: true } });
    const merged = { ...(current?.settings || {}), ...incoming };

    // The warehouse address is where every return label is sent. As it will
    // be stored it must be either empty or a real street line plus a valid
    // UK postcode; a half-filled address would produce unusable labels.
    const touchesWarehouse = ['warehouseLine1', 'warehouseCity', 'warehousePostcode'].some((k) => k in incoming);
    if (touchesWarehouse) {
      const line1 = String(merged.warehouseLine1 || '').trim();
      const postcode = String(merged.warehousePostcode || '').trim().toUpperCase();
      const city = String(merged.warehouseCity || '').trim();
      // Nothing set (or being cleared) is allowed; approvals are gated on it
      // separately. Anything set must be complete and valid.
      if (line1 || postcode) {
        if (line1.length < 3) {
          return res.status(400).json({ error: 'Warehouse address needs a street address (e.g. "188 Chester Road North")', field: 'warehouseLine1' });
        }
        if (!/^[A-Z]{1,2}\d[A-Z\d]?\s?\d[A-Z]{2}$/.test(postcode)) {
          return res.status(400).json({ error: 'Warehouse postcode must be a valid UK postcode (e.g. "B73 6SH")', field: 'warehousePostcode' });
        }
        merged.warehouseLine1 = line1;
        merged.warehouseCity = city;
        merged.warehousePostcode = postcode.replace(/^(.+?)(\d[A-Z]{2})$/, '$1 $2').replace(/\s+/, ' ');
      }
    }
    // Parcel defaults: how heavy a unit is when Shopify has no weight for it,
    // and the box size the label is booked for.
    const PARCEL_LIMITS = {
      parcelDefaultWeightKg: { max: 30, label: 'Default weight per item (kg)' },
      parcelLengthCm: { max: 150, label: 'Parcel length (cm)' },
      parcelWidthCm: { max: 150, label: 'Parcel width (cm)' },
      parcelHeightCm: { max: 150, label: 'Parcel height (cm)' },
    };
    for (const [key, { max, label }] of Object.entries(PARCEL_LIMITS)) {
      if (!(key in incoming)) continue;
      const raw = incoming[key];
      if (raw === '' || raw === null || raw === undefined) { merged[key] = null; continue; }
      const n = Number(raw);
      if (!Number.isFinite(n) || n <= 0 || n > max) {
        return res.status(400).json({ error: `${label} must be a number between 0 and ${max}`, field: key });
      }
      merged[key] = Math.round(n * 100) / 100;
    }

    for (const key of SYSTEM_KEYS) {
      if (current?.settings && current.settings[key] !== undefined) merged[key] = current.settings[key];
      else delete merged[key];
    }

    const shop = await prisma.shop.update({
      where: { id: req.shopId },
      data: { settings: merged },
    });
    res.json({ settings: shop.settings });
  } catch (err) {
    logger.error({ err }, 'Update settings error');
    res.status(500).json({ error: 'Failed to save settings' });
  }
});

module.exports = router;
