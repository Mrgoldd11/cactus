/**
 * E2E: town borders in the «Мир» panel — a checkbox turns on rings around The Hub. Screenshot: `out/screenshots/58-*`.
 */
import { mkdirSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { _electron as electron, expect, test } from '@playwright/test';

const appDir = resolve(import.meta.dirname, '..');
const shots = join(resolve(appDir, '../..'), 'out', 'screenshots');
mkdirSync(shots, { recursive: true });

test('World panel: town borders are turned on by a checkbox', async () => {
  test.setTimeout(240_000);
  const userData = mkdtempSync(join(tmpdir(), 'kedit-e2e-'));
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) if (v !== undefined && k !== 'ELECTRON_RENDERER_URL') env[k] = v;
  env['KEDIT_USER_DATA'] = userData;
  env['KEDIT_LIVE_FILE'] = join(userData, 'live.json');
  const app = await electron.launch({ args: ['.'], cwd: appDir, env });
  try {
    const page = await app.firstWindow();
    await page.setViewportSize({ width: 1600, height: 950 }).catch(() => undefined);
    await expect(page.getByTestId('open-vanilla')).toBeVisible({ timeout: 60_000 });
    await page.getByTestId('open-vanilla').click();
    await expect(page.getByTestId('editor')).toBeVisible({ timeout: 120_000 });
    await page.getByTestId('window-menu').click();
    await page.getByTestId('window-preset-scene').click();
    await expect(page.getByTestId('world-view')).toHaveAttribute('data-ready', 'yes', { timeout: 90_000 });

    const box = page.getByTestId('world-borders');
    await expect(box).not.toBeChecked();
    await page.getByTestId('world-search').fill('Хаб');
    await page.getByTestId('world-search').press('Enter');
    await page.waitForTimeout(3000);
    await page.screenshot({ path: join(shots, '58-borders-off.png') });
    await box.check();
    await page.waitForTimeout(2500);
    await page.screenshot({ path: join(shots, '58-borders-on.png') });
    await expect(box).toBeChecked();
  } finally {
    await app.close();
  }
});
