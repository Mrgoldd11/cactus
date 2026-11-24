/**
 * «Before» screenshots for the dialogue editor redesign (screen G of the UI mockup): how the
 * «Dialogues» layout shows a package, a dialogue and a line today.
 * Examples: «acid rain» (55630-rebirth.mod, event 62 in «player character default»), the
 * «Drifter squad» package (3951-gamedata.base) with «Healed (Recruit)» (8940-D-Dialogue.mod, event 21)
 * that hands over to the locked recruitment dialogue «Healed (Recruit)» (8950-Dialogue.mod, event 1)
 * through `interrupt` / `unlocks`. Russian UI, 1400×850, a new empty mod.
 *
 *   node apps/desktop/scripts/ux-shots-dialogue-editor.ts [out-dir]
 */
import { mkdirSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { _electron as electron } from '@playwright/test';

const appDir = resolve(import.meta.dirname, '..');
const outDir = resolve(process.argv[2] ?? join(appDir, '../../out/screenshots/ux-dlg-editor'));
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
  await page.waitForTimeout(800);
};
const clickNode = async (sid: string): Promise<boolean> => {
  const n = page.locator(`[data-testid="dg-node"][data-id="${sid}"]`).first();
  if ((await n.count()) === 0) return false;
  await n.click();
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
  await page.getByTestId('window-preset-dialogue').click();
  await page.waitForTimeout(1200);

  // The package of the drifters: which dialogue for which event.
  await select('3951-gamedata.base');
  await shot('80-package-graph', 2000);

  // «Acid rain»: one line, three texts, «conditions 0».
  await select('55630-rebirth.mod');
  await shot('81-acid-rain-graph', 1500);
  if (await clickNode('55631-rebirth.mod')) await shot('82-acid-rain-line', 1200);

  // The healed drifter thanks the player and hands over to the recruitment dialogue.
  await select('8940-D-Dialogue.mod');
  await shot('83-healed-graph', 1500);
  if (await clickNode('8942-D-Dialogue.mod')) await shot('84-healed-line-interrupt', 1200);

  // The recruitment dialogue itself: conditions, effects, player answers.
  await select('8950-Dialogue.mod');
  await shot('85-recruit-graph', 1800);
  if (await clickNode('8951-Dialogue.mod')) await shot('86-recruit-line', 1200);
  if (await clickNode('8954-Dialogue.mod')) await shot('87-recruit-join-line', 1200);
} finally {
  await app.evaluate(({ BrowserWindow }) => { for (const w of BrowserWindow.getAllWindows()) w.destroy(); }).catch(() => undefined);
  await app.close().catch(() => undefined);
}
