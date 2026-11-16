/**
 * Screenshots for the beta guide (`apps/desktop/beta/screenshots/`), taken from the built
 * beta with empty settings:
 *
 *   pnpm beta && node apps/desktop/scripts/beta-shots.ts [path to Cactus.exe]
 *
 * Nothing personal in the shots: the game path is replaced with the usual Steam path, the list of installed
 * mods stays out of the frame.
 */
import { mkdirSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { _electron as electron, type Page } from '@playwright/test';

const app = resolve(import.meta.dirname, '..');
const exe = process.argv[2] ?? join(app, '../../out/beta/Cactus/Cactus.exe');
const shots = join(app, 'beta', 'screenshots');
mkdirSync(shots, { recursive: true });

const userData = mkdtempSync(join(tmpdir(), 'kedit-shots-'));
const env: Record<string, string> = {};
for (const [k, v] of Object.entries(process.env)) if (v !== undefined && k !== 'ELECTRON_RUN_AS_NODE') env[k] = v;
env['KEDIT_USER_DATA'] = userData;
env['KEDIT_LIVE_FILE'] = join(userData, 'live.json');

const GENERIC_GAME_DIR = 'C:\\Program Files (x86)\\Steam\\steamapps\\common\\Kenshi';

/** Replace the game path on the page with the usual Steam path. */
async function hideGamePath(page: Page): Promise<void> {
  await page.evaluate((generic) => {
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    for (let n = walker.nextNode(); n; n = walker.nextNode()) {
      if (n.textContent && /^[A-Za-z]:\\.*kenshi$/i.test(n.textContent.trim())) n.textContent = generic;
    }
  }, GENERIC_GAME_DIR);
}

const electronApp = await electron.launch({ executablePath: exe, args: [], env });
try {
  const page = await electronApp.firstWindow();
  await electronApp.evaluate(({ BrowserWindow }) => {
    BrowserWindow.getAllWindows()[0]?.setSize(1500, 950);
  });
  await page.getByTestId('open-vanilla').waitFor({ timeout: 60_000 });
  await page.getByTestId('mods-table').waitFor();
  await page.waitForTimeout(300);

  // 1. Start screen: game folder and buttons, without the mod list.
  await hideGamePath(page);
  const mods = await page.getByText('Установленные моды').boundingBox();
  const width = await page.evaluate(() => window.innerWidth);
  await page.screenshot({ path: join(shots, '1-start.png'), clip: { x: 0, y: 0, width, height: Math.round((mods?.y ?? 260) - 18) } });

  // 2. Vanilla, «Катана», the «Где в игре» tab.
  await page.getByTestId('open-vanilla').click();
  await page.getByTestId('editor').waitFor({ timeout: 120_000 });
  await page.getByTestId('search').fill('катана');
  await page.getByTestId('record-list').locator('[data-sid="476-gamedata.base"]').click();
  await page.getByTestId('tab-where').click();
  await page.getByTestId('where').getByText('Мир: городов').waitFor({ timeout: 60_000 });
  await page.waitForTimeout(300);
  await page.screenshot({ path: join(shots, '2-katana-where.png') });

  // 3. «Диалоги» layout: Beep in the player, his dialogue in the graph, the right-click menu.
  await page.getByTestId('window-menu').click();
  await page.getByTestId('window-preset-dialogue').click();
  await page.getByTestId('search').fill('Бип');
  await page.getByTestId('record-list').locator('[data-sid="57390-rebirth.mod"]').click();
  const player = page.getByTestId('player');
  const said = player.getByTestId('pl-step').first().getByTestId('pl-said');
  await said.waitFor({ timeout: 60_000 });
  await said.getByRole('button').click();
  const graph = page.getByTestId('dialogue-graph');
  const text = graph.locator('[data-testid="dg-node"] .dg-text').first();
  await text.waitFor({ timeout: 60_000 });
  await page.waitForTimeout(500);
  await text.click({ button: 'right' });
  await graph.getByTestId('dg-menu').waitFor();
  await page.screenshot({ path: join(shots, '3-dialogues.png') });
  console.log(`скриншоты: ${shots}`);
} finally {
  await electronApp
    .evaluate(({ BrowserWindow }) => {
      for (const w of BrowserWindow.getAllWindows()) w.destroy();
    })
    .catch(() => undefined);
  await electronApp.close();
}
