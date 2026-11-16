/**
 * Screenshot of the katana in the «Model» panel for the Steam gallery (from the built beta, empty settings):
 *
 *   node apps/desktop/scripts/katana-shot.ts [out.jpg] [Cactus.exe]
 */
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { _electron as electron } from '@playwright/test';

const app = resolve(import.meta.dirname, '..');
const out = resolve(process.argv[2] ?? 'katana.jpg');
const exe = process.argv[3] ?? join(app, '../../out/beta/Cactus/Cactus.exe');

const userData = mkdtempSync(join(tmpdir(), 'kedit-katana-'));
const env: Record<string, string> = {};
for (const [k, v] of Object.entries(process.env)) if (v !== undefined && k !== 'ELECTRON_RUN_AS_NODE') env[k] = v;
env['KEDIT_USER_DATA'] = userData;
env['KEDIT_LIVE_FILE'] = join(userData, 'live.json');

const electronApp = await electron.launch({ executablePath: exe, args: [], env });
try {
  const page = await electronApp.firstWindow();
  await electronApp.evaluate(({ BrowserWindow }) => {
    BrowserWindow.getAllWindows()[0]?.setSize(1600, 900);
  });
  await page.getByTestId('open-vanilla').waitFor({ timeout: 60_000 });
  await page.getByTestId('open-vanilla').click();
  await page.getByTestId('editor').waitFor({ timeout: 120_000 });
  await page.getByRole('button', { name: 'EN', exact: true }).click();

  await page.getByTestId('window-menu').click();
  await page.getByTestId('window-preset-scene').click();
  await page.locator('.dv-tab', { hasText: '◈' }).click();
  // «Model» sits in the narrow right group — close the «World» tab so the group takes the centre.
  await page.locator('.dv-tab', { hasText: 'World' }).locator('.dv-default-tab-action').click();
  await page.waitForTimeout(400);
  const view = page.getByTestId('model-view');
  await page.getByTestId('search').fill('katana');
  await page.getByTestId('record-list').locator('[data-sid="476-gamedata.base"]').click();
  await page.waitForFunction(() => document.querySelector('[data-testid="model-view"]')?.getAttribute('data-state') === 'ready', undefined, { timeout: 60_000 });

  // Rotate the view a little with the mouse — shows that the model turns.
  const box = (await view.getByTestId('model-canvas').boundingBox())!;
  const cx = box.x + box.width / 2;
  const cy = box.y + box.height / 2;
  await page.mouse.move(cx + 120, cy);
  await page.mouse.down();
  await page.mouse.move(cx + 40, cy - 10, { steps: 12 });
  await page.mouse.up();
  await page.waitForTimeout(600);
  await page.screenshot({ path: out, type: 'jpeg', quality: 88 });
  console.log(out);
} finally {
  await electronApp
    .evaluate(({ BrowserWindow }) => {
      for (const w of BrowserWindow.getAllWindows()) w.destroy();
    })
    .catch(() => undefined);
  await electronApp.close();
}
