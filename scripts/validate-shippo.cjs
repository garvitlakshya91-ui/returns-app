/*
 * Validate the Shippo live label path end-to-end against the real API.
 *
 * Usage:
 *   1. Get a free TEST token from Shippo (Settings → API → it starts "shippo_test_").
 *   2. SHIPPO_API_KEY=shippo_test_xxx node scripts/validate-shippo.cjs
 *      (or put SHIPPO_API_KEY in .env)
 *
 * Test mode buys a watermarked label at no cost. A real PDF URL in the output
 * proves the ShippoAdapter's live path works — production UK carriers
 * (Royal Mail/Evri) are the same code with a live token + funded balance.
 */
require('dotenv').config();
const ShippoAdapter = require('../app/services/carriers/ShippoAdapter');

const KEY = process.env.SHIPPO_API_KEY;

async function main() {
  if (!KEY) {
    console.error('✗ Set SHIPPO_API_KEY first (a shippo_test_ token from Shippo).');
    process.exit(1);
  }
  console.log(`Using ${KEY.startsWith('shippo_test_') ? 'TEST' : 'LIVE'} Shippo token.\n`);

  const adapter = new ShippoAdapter({ credentials: { apiKey: KEY }, settings: { live: true } });

  // Shippo test mode returns USPS test rates, so use US test addresses.
  const label = await adapter.generateLabel({
    senderAddress: { name: 'Jane Customer', line1: '215 Clayton St', city: 'San Francisco', state: 'CA', postcode: '94117', country: 'US', phone: '5551234567', email: 'jane@example.com' },
    recipientAddress: { name: 'ReturnFlow Returns', line1: '965 Mission St', city: 'San Francisco', state: 'CA', postcode: '94103', country: 'US', phone: '5559876543', email: 'returns@example.com' },
    weight: 0.5,
  });

  console.log('✅ Label bought via Shippo:');
  console.log('   carrier:        ', label.carrier, label.service ? `(${label.service})` : '');
  console.log('   tracking number:', label.trackingCode);
  console.log('   label PDF:      ', label.labelUrl);
  console.log('   cost:           ', label.cost);
  console.log('\nA PDF URL above = the live Shippo path works end-to-end. 🎉');
}

main().catch((err) => {
  console.error('✗ Validation failed:', err.message);
  process.exit(1);
});
