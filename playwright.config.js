import { defineConfig } from '@playwright/test';
export default defineConfig({
  testDir: './test/browser',
  fullyParallel: false,
  workers: 1,
  use: { baseURL: 'http://127.0.0.1:4193', channel: process.env.PLAYWRIGHT_CHANNEL },
  webServer: { command: 'node tools/serve.mjs', url: 'http://127.0.0.1:4193', reuseExistingServer: false },
});
