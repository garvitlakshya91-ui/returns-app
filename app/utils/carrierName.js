// Display names for stored carrier codes ("royalmail" → "Royal Mail").
// Unknown codes are shown as stored so a new carrier never renders blank.
const CARRIER_NAMES = {
  royalmail: 'Royal Mail',
  evri: 'Evri',
  inpost: 'InPost',
  dpd: 'DPD',
  dpduk: 'DPD',
  ups: 'UPS',
  dhl: 'DHL',
  dhlexpress: 'DHL Express',
  parcelforce: 'Parcelforce',
  yodel: 'Yodel',
  shippo: 'Shippo',
  shipengine: 'ShipEngine',
};

function carrierDisplayName(code) {
  if (!code) return '';
  return CARRIER_NAMES[String(code).toLowerCase()] || code;
}

module.exports = { carrierDisplayName, CARRIER_NAMES };
