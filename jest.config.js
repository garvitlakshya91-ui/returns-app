/** @type {import('jest').Config} */
module.exports = {
  testEnvironment: 'node',
  testMatch: ['**/tests/**/*.test.js'],
  setupFiles: ['<rootDir>/tests/setupEnv.js'],
  clearMocks: true,
  resetModules: true,
  collectCoverageFrom: [
    'app/**/*.js',
    '!app/index.js',
    '!app/jobs/**',
  ],
  testPathIgnorePatterns: ['/node_modules/', '/web/', '/emails/'],
  moduleFileExtensions: ['js', 'json'],
  verbose: false,
};
