// Test environment variables. Loaded before any test file via jest.config.setupFiles.
// Override real .env values so tests never touch production resources by accident.

process.env.NODE_ENV = 'test';
process.env.LOG_LEVEL = 'silent';

// Encryption key — fixed 32-byte hex so encrypt/decrypt round-trips are deterministic
process.env.ENCRYPTION_KEY = 'a'.repeat(64);

// Shopify
process.env.SHOPIFY_API_KEY = 'test_api_key';
process.env.SHOPIFY_API_SECRET = 'test_api_secret_for_hmac';
process.env.SCOPES = 'read_orders,write_orders';
process.env.HOST = 'https://test.local';

// Portal
process.env.PORTAL_URL = 'https://portal.test.local';

// No Redis in tests — middleware falls back to in-memory
delete process.env.REDIS_URL;

// No Resend in tests — worker logs instead of sending
delete process.env.RESEND_API_KEY;

// No Sentry
delete process.env.SENTRY_DSN;

// No R2 — StorageService refuses to upload
delete process.env.R2_ACCOUNT_ID;
delete process.env.R2_ACCESS_KEY;
delete process.env.R2_SECRET_KEY;
