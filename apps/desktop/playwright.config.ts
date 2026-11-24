import { defineConfig } from '@playwright/test';

// Tests run the built app (out/) through Electron; the real game is needed (read-only).
export default defineConfig({
  testDir: 'e2e',
  timeout: 180_000,
  expect: { timeout: 30_000 },
  workers: 1,
  reporter: 'list',
});
