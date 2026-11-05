import { defineConfig } from '@playwright/test';

// Тесты запускают собранное приложение (out/) через Electron; игра нужна настоящая (только чтение).
export default defineConfig({
  testDir: 'e2e',
  timeout: 180_000,
  expect: { timeout: 30_000 },
  workers: 1,
  reporter: 'list',
});
