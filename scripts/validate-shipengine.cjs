/*
 * Validate the ShipEngine live label path end-to-end against the real API.
 *
 * Usage:
 *   1. Get a free sandbox key from ShipEngine (it starts with "TEST_").
 *   2. SHIPENGINE_API_KEY=TEST_xxx node scripts/validate-shipengine.cjs
 *      (or put SHIPENGINE_API_KEY in .env)
 *
 * The sandbox only supports US carriers, so this creates a watermarked USPS
 * test label (you are NOT charged). A real PDF URL in the output proves the
 * ShipEngineAdapter's live path works — production Royal Mail/Evri is then the
 * same code with a real connected carrier's carrier_id/service_code.
 */
require('dotenv').config();
const ShipEngineAdapter = require('../app/services/carriers/ShipEngineAdapter');

const KEY = process.env.SHIPENGINE_API_KEY;
const BASE = process.env.SHIPENGINE_BASE_URL || 'https://api.shipengine.com';

async function main() {
  if (!KEY) {
    console.error('✗ Set SHIPENGINE_API_KEY first (a TEST_ sandbox key from ShipEngine).');
    process.exit(1);
  }
  console.log(`Using ${KEY.startsWith('TEST_') ? 'SANDBOX' : 'PRODUCTION'} ShipEngine key.\n`);

  // 1) Discover a connected carrier + a service code.
  const cRes = await fetch(`${BASE}/v1/carriers`, { headers: { 'API-Key': KEY } });
  if (!cRes.ok) {
    console.error(`✗ Could not list carriers (${cRes.status}):`, (await cRes.text()).slice(0, 300));
    process.exit(1);
  }
  const carriers = (await cRes.json()).carriers || [];
  if (!carriers.length) {
    console.error('✗ No carriers connected. In the sandbox, connect a USPS/Stamps.com test carrier in the ShipEngine dashboard, then re-run.');
    process.exit(1);
  }
  const carrier = carriers.find((c) => (c.services || []).length) || carriers[0];
  const service = (carrier.services || []).find((s) => /ground|first|priority|tracked/i.test(s.service_code)) || (carrier.services || [])[0];
  console.log(`Carrier:  ${carrier.friendly_name || carrier.carrier_code} (${carrier.carrier_id})`);
  console.log(`Service:  ${service ? service.service_code : '(none found)'}\n`);

  // 2) Create a RETURN label through the actual adapter.
  const adapter = new ShipEngineAdapter({
    credentials: { apiKey: KEY },
    settings: { live: true, carrierId: carrier.carrier_id, serviceCode: service && service.service_code, carrierLabel: carrier.carrier_code },
  });

  // Sandbox carriers are US-only, so use US test addresses.
  const label = await adapter.generateLabel({
    senderAddress:    { name: 'Jane Customer', line1: '525 S Winchester Blvd', city: 'San Jose', state: 'CA', postcode: '95128', country: 'US', phone: '555-555-5555' },
    recipientAddress: { name: 'ReturnFlow Returns', line1: '4009 Marathon Blvd', city: 'Austin', state: 'TX', postcode: '78756', country: 'US', phone: '512-555-5555' },
    weight: 0.5,
  });

  console.log('✅ Label created via ShipEngine:');
  console.log('   tracking number:', label.trackingCode);
  console.log('   label PDF:      ', label.labelUrl);
  console.log('   cost:           ', label.cost, '(test — not charged)');
  console.log('\nA PDF URL above = the live label path works end-to-end. 🎉');
}

main().catch((err) => {
  console.error('✗ Validation failed:', err.message);
  process.exit(1);
});
