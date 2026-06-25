// Screenshot/demo seed — ONLY used when the URL has ?demo=1.
// Lets the portal render every step with realistic mock data, no backend
// or Shopify call needed. Never affects production: App.jsx only reads this
// when the demo flag is present.

export function isDemo() {
  if (typeof window === 'undefined') return false;
  return new URLSearchParams(window.location.search).get('demo') === '1';
}

const ITEMS = [
  {
    id: 'li-1', lineItemId: 'li-1', productId: 'p1', variantId: 'v1',
    title: 'Merino Wool Jumper', variantTitle: 'Medium / Forest Green',
    price: 68.0, quantity: 1, sku: 'MWJ-M-GRN',
    imageUrl: 'https://images.unsplash.com/photo-1620799140408-edc6dcb6d633?w=200&h=200&fit=crop',
  },
  {
    id: 'li-2', lineItemId: 'li-2', productId: 'p2', variantId: 'v2',
    title: 'Canvas Tote Bag', variantTitle: 'Natural',
    price: 24.0, quantity: 1, sku: 'CTB-NAT',
    imageUrl: 'https://images.unsplash.com/photo-1597484661643-2f5fef640dd1?w=200&h=200&fit=crop',
  },
];

export const DEMO_DATA = {
  shopId: 'demo-shop',
  shopName: 'Wildgrove & Co.',
  shopSlug: 'demoshop',
  order: {
    shopId: 'demo-shop',
    shopName: 'Wildgrove & Co.',
    orderId: 'gid://shopify/Order/demo',
    orderName: '#1042',
    email: 'jamie@example.com',
    fulfillmentStatus: 'FULFILLED',
    eligibleItems: ITEMS,
  },
  selectedItems: [ITEMS[0]],
  reasons: { 'li-1': { reason: 'doesnt_fit', detail: 'Slightly too tight on the shoulders.' } },
  photos: {},
  resolution: 'STORE_CREDIT',
  carrier: 'evri',
  dropoff: {
    id: 'evri-1', name: 'Tesco Express', address: '45 High Street, GL1 1DQ',
    distance: '0.2 miles', openingHours: '6am–11pm daily', type: 'ParcelShop',
  },
  returnResult: null,
};
