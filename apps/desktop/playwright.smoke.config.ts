import { defineConfig } from '@playwright/test';

// Smoke test of the packaged beta: CACTUS_EXE = an unzipped Cactus.exe (see smoke/packaged.spec.ts).
export default defineConfig({
  testDir: 'smoke',
  timeout: 420_000,
  expect: { timeout: 30_000 },
  workers: 1,
  reporter: 'list',
});
