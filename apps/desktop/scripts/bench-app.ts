/**
 * Замер запуска собранного приложения (out/): окно, стартовый экран, «Ваниль» первый
 * и второй раз (через «⌂» на стартовый экран). Запуск: node scripts/bench-app.ts [раз=3]
 * Нужна сборка: pnpm --filter @kenshi-editor/desktop build.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { _electron as electron } from '@playwright/test';

const appDir = resolve(import.meta.dirname, '..');
const runs = Number(process.argv[2] ?? 3);
const rows: Record<string, number[]> = {};
const note = (k: string, v: number): void => {
  (rows[k] ??= []).push(v);
};

for (let i = 0; i < runs; i++) {
  const userData = mkdtempSync(join(tmpdir(), 'kedit-bench-'));
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) if (v !== undefined && k !== 'ELECTRON_RENDERER_URL') env[k] = v;
  env['KEDIT_USER_DATA'] = userData;
  env['KEDIT_LIVE'] = '0';
  const t0 = performance.now();
  const app = await electron.launch({ args: ['.'], cwd: appDir, env });
  const page = await app.firstWindow();
  await page.waitForSelector('[data-testid="start-screen"]', { timeout: 60_000 });
  note('окно и стартовый экран', performance.now() - t0);
  await page.waitForSelector('[data-testid="open-vanilla"]', { timeout: 60_000 });
  note('кнопка «Ваниль» готова', performance.now() - t0);
  let t = performance.now();
  await page.click('[data-testid="open-vanilla"]');
  await page.waitForSelector('[data-testid="editor"]', { timeout: 120_000 });
  note('«Ваниль» (1-й раз)', performance.now() - t);
  await page.click('[data-testid="home"]');
  await page.waitForSelector('[data-testid="open-vanilla"]', { timeout: 60_000 });
  t = performance.now();
  await page.click('[data-testid="open-vanilla"]');
  await page.waitForSelector('[data-testid="editor"]', { timeout: 120_000 });
  note('«Ваниль» (2-й раз)', performance.now() - t);
  await app.evaluate(({ BrowserWindow }) => {
    for (const w of BrowserWindow.getAllWindows()) w.destroy();
  });
  await app.close();
  // Второй запуск с тем же userData — как у пользователя (кэш, настройки).
  const t1 = performance.now();
  const app2 = await electron.launch({ args: ['.'], cwd: appDir, env });
  const page2 = await app2.firstWindow();
  await page2.waitForSelector('[data-testid="open-vanilla"]', { timeout: 60_000 });
  t = performance.now();
  note('повторный запуск: стартовый экран', t - t1);
  await page2.click('[data-testid="open-vanilla"]');
  await page2.waitForSelector('[data-testid="editor"]', { timeout: 120_000 });
  note('повторный запуск: «Ваниль»', performance.now() - t);
  await app2.evaluate(({ BrowserWindow }) => {
    for (const w of BrowserWindow.getAllWindows()) w.destroy();
  });
  await app2.close();
  rmSync(userData, { recursive: true, force: true });
}
for (const [k, v] of Object.entries(rows)) {
  const s = [...v].sort((a, b) => a - b);
  console.log(`${k.padEnd(36)} медиана ${s[Math.floor(s.length / 2)]!.toFixed(0).padStart(5)} мс   (${v.map((x) => x.toFixed(0)).join(', ')})`);
}
