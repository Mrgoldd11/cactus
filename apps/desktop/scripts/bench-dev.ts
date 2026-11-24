/**
 * Startup benchmark the way the shortcut worked before the speed-up: `pnpm desktop` (dev mode,
 * Vite dev server). The window is attached via CDP. Run: node scripts/bench-dev.ts [command]
 */
import { spawn, execSync } from 'node:child_process';
import { resolve } from 'node:path';
import { chromium, type Page } from '@playwright/test';

const root = resolve(import.meta.dirname, '../../..');
const port = 9333;
const cmd = process.argv[2] ?? `pnpm desktop --remoteDebuggingPort ${port}`;
const t0 = performance.now();
const child = spawn(cmd, { cwd: root, shell: true, stdio: 'ignore', env: { ...process.env, KEDIT_LIVE: '0' } });
let page: Page | undefined;
for (;;) {
  try {
    const browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`, { timeout: 2000 });
    page = browser.contexts().flatMap((c) => c.pages())[0];
    if (page) break;
  } catch {
    // not up yet
  }
  await new Promise((r) => setTimeout(r, 100));
  if (performance.now() - t0 > 120_000) throw new Error('окно не появилось');
}
await page.waitForSelector('[data-testid="open-vanilla"]', { timeout: 120_000 });
const tStart = performance.now() - t0;
let t = performance.now();
await page.click('[data-testid="open-vanilla"]');
await page.waitForSelector('[data-testid="editor"]', { timeout: 120_000 });
const tVan = performance.now() - t;
await page.click('[data-testid="home"]');
await page.waitForSelector('[data-testid="open-vanilla"]');
t = performance.now();
await page.click('[data-testid="open-vanilla"]');
await page.waitForSelector('[data-testid="editor"]', { timeout: 120_000 });
const tVan2 = performance.now() - t;
console.log(`от команды до кнопки «Ваниль»  ${tStart.toFixed(0)} мс`);
console.log(`«Ваниль» 1-й раз               ${tVan.toFixed(0)} мс`);
console.log(`«Ваниль» 2-й раз               ${tVan2.toFixed(0)} мс`);
// Close what was started: both the command tree and the window that may have detached (the shortcut starts
// Electron separately) — it is found by the debug port.
const pids = new Set([String(child.pid)]);
try {
  const m = execSync('netstat -ano', { encoding: 'utf8' }).match(new RegExp(String.raw`127\.0\.0\.1:${port}\s+\S+\s+LISTENING\s+(\d+)`));
  if (m) pids.add(m[1]!);
} catch {
  // no netstat
}
for (const pid of pids) {
  try {
    execSync(`taskkill /pid ${pid} /T /F`, { stdio: 'ignore' });
  } catch {
    // already closed
  }
}
process.exit(0);
