/**
 * «Before» screenshots for the dialogue trigger review: how a modder sees when a dialogue is spoken.
 * Example: Beep (57390-rebirth.mod) → package «beep (player)» (57330) → event 20 → «beep healing other»
 * (57331) → line 57332. Russian UI, 1400×850, a new empty mod.
 *
 *   node apps/desktop/scripts/ux-shots-dialogue.ts [out-dir]
 */
import { mkdirSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { _electron as electron } from '@playwright/test';

const appDir = resolve(import.meta.dirname, '..');
const outDir = resolve(process.argv[2] ?? join(appDir, '../../out/screenshots/ux-dialogue'));
mkdirSync(outDir, { recursive: true });
const userData = mkdtempSync(join(tmpdir(), 'kedit-ux-'));
const env: Record<string, string> = {};
for (const [k, v] of Object.entries(process.env)) if (v !== undefined && k !== 'ELECTRON_RENDERER_URL' && k !== 'ELECTRON_RUN_AS_NODE') env[k] = v;
env['KEDIT_USER_DATA'] = userData;
env['KEDIT_LIVE_FILE'] = join(userData, 'live.json');

const app = await electron.launch({ args: ['.'], cwd: appDir, env });
const page = await app.firstWindow();
await page.waitForLoadState('domcontentloaded');
const cdp = await page.context().newCDPSession(page);
await cdp.send('Emulation.setDeviceMetricsOverride', { width: 1400, height: 850, deviceScaleFactor: 1, mobile: false });
const shot = async (name: string, wait = 800): Promise<void> => {
  await page.waitForTimeout(wait);
  await page.screenshot({ path: join(outDir, `${name}.png`) });
  console.log(`ok ${name}`);
};
const select = async (sid: string): Promise<void> => {
  await page.getByTestId('search').first().fill(sid);
  await page.getByTestId('record-list').first().locator(`[data-sid="${sid}"]`).click();
  await page.waitForTimeout(600);
};
const tab = async (id: string): Promise<boolean> => {
  const b = page.getByTestId(`tab-${id}`);
  if ((await b.count()) === 0) return false;
  await b.click();
  return true;
};
try {
  await page.getByTestId('open-vanilla').waitFor({ timeout: 60_000 });
  await page.getByTestId('lang-current').click();
  await page.getByTestId('lang-ru').click();
  await page.waitForTimeout(1500);
  await page.getByTestId('new-mod-name').fill('Мой мод');
  await page.getByTestId('create-mod').click();
  await page.getByTestId('editor').waitFor({ timeout: 120_000 });
  await page.getByTestId('window-menu').click();
  await page.getByTestId('window-preset-data').click();
  await page.waitForTimeout(700);
  await page.getByTestId('category-tree').getByText('Всё', { exact: true }).click();

  // The dialogue itself: nothing in its header says when it is spoken.
  await select('57331-rebirth.mod');
  await shot('60-dlg-fields', 1200);
  if (await tab('graph')) await shot('61-dlg-graph', 1500);
  if (await tab('back')) await shot('62-dlg-back');
  if (await tab('where')) await shot('63-dlg-where', 2000);

  // The line: «Where spoken» lists the package, the event is not shown.
  await select('57332-rebirth.mod');
  await tab('fields');
  await shot('64-line-fields', 1200);
  if (await tab('graph')) await shot('65-line-graph', 1500);

  // The package: the event is a bare number in the reference list.
  await select('57330-rebirth.mod');
  await tab('fields');
  await shot('66-package-fields', 1200);
  if (await tab('graph')) await shot('67-package-graph', 1500);

  // The character: the «Talk» tab.
  await select('57390-rebirth.mod');
  if (await tab('talk')) await shot('68-beep-talk', 2000);

  // The «Dialogues» layout with the same character selected.
  await page.getByTestId('window-menu').click();
  await page.getByTestId('window-preset-dialogue').click();
  await shot('69-dialogue-layout', 2500);
} finally {
  await app.evaluate(({ BrowserWindow }) => { for (const w of BrowserWindow.getAllWindows()) w.destroy(); }).catch(() => undefined);
  await app.close().catch(() => undefined);
}
