describe('jest harness smoke', () => {
  it('env vars from setupEnv are loaded', () => {
    expect(process.env.NODE_ENV).toBe('test');
    expect(process.env.ENCRYPTION_KEY).toHaveLength(64);
    expect(process.env.SHOPIFY_API_SECRET).toBe('test_api_secret_for_hmac');
  });
});
