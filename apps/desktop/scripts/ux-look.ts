/**
 * Quick look at the built app for UI work: opens vanilla with a new mod in the Russian UI, switches to the
 * «Dialogues» layout and runs steps given on the command line, one screenshot per `shot:`.
 *
 *   node apps/desktop/scripts/ux-look.ts sel:55630-rebirth.mod shot:rain click:55630-rebirth.mod shot:rain-sel
 *
 * Steps: `sel:<sid>` — pick a record in «Records»; `click:<sid>` — click a graph node; `css:<selector>` — click
 * the first element; `wait:<ms>`; `shot:<name>` — window screenshot into out/look/<name>.png;
 * `size:<w>x<h>` — window size (default 1400×850); `eval:<js>` — run in the page and print the result.
 */
import { mkdirSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { _electron as electron } from '@playwright/test';

const appDir = resolve(import.meta.dirname, '..');
const outDir = resolve(appDir, '../../out/look');
mkdirSync(outDir, { recursive: true });
const userData = mkdtempSync(join(tmpdir(), 'kedit-look-'));
const env: Record<string, string> = {};
for (const [k, v] of Object.entries(process.env)) if (v !== undefined && k !== 'ELECTRON_RENDERER_URL' && k !== 'ELECTRON_RUN_AS_NODE') env[k] = v;
env['KEDIT_USER_DATA'] = userData;
env['KEDIT_LIVE_FILE'] = join(userData, 'live.json');

const app = await electron.launch({ args: ['.'], cwd: appDir, env });
const page = await app.firstWindow();
await page.waitForLoadState('domcontentloaded');
page.on('pageerror', (e) => { console.log(`pageerror: ${e.message}`); });
const cdp = await page.context().newCDPSession(page);
const size = async (w: number, h: number): Promise<void> => {
  await cdp.send('Emulation.setDeviceMetricsOverride', { width: w, height: h, deviceScaleFactor: 1, mobile: false });
};
await size(1400, 850);
try {
  await page.getByTestId('open-vanilla').waitFor({ timeout: 60_000 });
  await page.getByTestId('lang-current').click();
  await page.getByTestId('lang-ru').click();
  await page.waitForTimeout(1000);
  await page.getByTestId('new-mod-name').fill('Мой мод');
  await page.getByTestId('create-mod').click();
  await page.getByTestId('editor').waitFor({ timeout: 120_000 });
  await page.getByTestId('window-menu').click();
  await page.getByTestId('window-preset-dialogue').click();
  await page.waitForTimeout(1000);
  for (const step of process.argv.slice(2)) {
    const i = step.indexOf(':');
    const op = step.slice(0, i);
    const arg = step.slice(i + 1);
    if (op === 'sel') {
      await page.locator('.dv-tab', { hasText: 'Записи' }).first().click();
      await page.getByTestId('search').first().fill(arg);
      await page.getByTestId('record-list').first().locator(`[data-sid="${arg}"]`).click();
      await page.waitForTimeout(1200);
    } else if (op === 'click') {
      await page.locator(`[data-testid="dg-node"][data-id="${arg}"]`).first().click();
      await page.waitForTimeout(600);
    } else if (op === 'css') {
      await page.locator(arg).first().click();
      await page.waitForTimeout(500);
    } else if (op === 'hover') {
      await page.locator(arg).first().hover();
      await page.waitForTimeout(300);
    } else if (op === 'type') {
      await page.keyboard.type(arg);
      await page.waitForTimeout(400);
    } else if (op === 'key') {
      await page.keyboard.press(arg);
      await page.waitForTimeout(400);
    } else if (op === 'wait') await page.waitForTimeout(Number(arg));
    else if (op === 'size') {
      const [w, h] = arg.split('x').map(Number);
      await size(w!, h!);
    } else if (op === 'eval') console.log(JSON.stringify(await page.evaluate(arg)));
    else if (op === 'shot') {
      await page.waitForTimeout(500);
      await page.screenshot({ path: join(outDir, `${arg}.png`) });
      console.log(`shot ${arg}`);
    } else console.log(`unknown step ${step}`);
  }
} catch (e) {
  console.log(`failed: ${String(e)}`);
  await page.screenshot({ path: join(outDir, 'failed.png') }).catch(() => undefined);
} finally {
  await app.evaluate(({ BrowserWindow }) => { for (const w of BrowserWindow.getAllWindows()) w.destroy(); }).catch(() => undefined);
  await app.close().catch(() => undefined);
}
