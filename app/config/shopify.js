require('@shopify/shopify-api/adapters/node');
const { shopifyApi, ApiVersion, LogSeverity } = require('@shopify/shopify-api');
const { restResources } = require('@shopify/shopify-api/rest/admin/2025-04');

const shopify = shopifyApi({
  apiKey: process.env.SHOPIFY_API_KEY,
  apiSecretKey: process.env.SHOPIFY_API_SECRET,
  scopes: (process.env.SCOPES || '').split(',').filter(Boolean),
  hostName: (process.env.HOST || '').replace(/https?:\/\//, ''),
  hostScheme: 'https',
  apiVersion: ApiVersion.April25,
  isEmbeddedApp: true,
  logger: {
    level: process.env.NODE_ENV === 'production' ? LogSeverity.Error : LogSeverity.Info,
  },
  restResources,
});

module.exports = shopify;
