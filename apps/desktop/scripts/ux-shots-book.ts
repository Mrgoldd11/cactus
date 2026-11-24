/**
 * Screenshots of the record inspector on a new book (ITEM) in a new mod, Russian UI, 1400×850:
 * fields with their Russian names and the description bar, the reference lists among the fields,
 * the «In game» line and «Where in game» with the ways into the game and «Like the sample»
 * (sample: Book of Grace), then the book added to the sample's list.
 *
 *   node apps/desktop/scripts/ux-shots-book.ts [out-dir]
 */
import { mkdirSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { _electron as electron } from '@playwright/test';

const appDir = resolve(import.meta.dirname, '..');
const outDir = resolve(process.argv[2] ?? join(appDir, '../../out/screenshots/ux-book'));
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
  const tree = page.getByTestId('category-tree');
  await tree.locator('.tree-row', { hasText: 'Предметы' }).first().locator('.twisty').click();
  await tree.getByText('Книги', { exact: true }).click();
  await page.waitForTimeout(500);
  await page.getByTestId('new-record').click();
  await shot('50-book-new-modal');
  await page.getByTestId('new-record-sample').click();
  const picker = page.getByTestId('record-picker');
  await picker.getByTestId('picker-search').fill('50383-Dialogue.mod');
  await picker.getByTestId('picker-list').locator('[data-sid="50383-Dialogue.mod"]').dblclick();
  await page.getByTestId('new-record-name').fill('Моя книга');
  await page.getByTestId('new-record-create').click();
  await page.locator('[data-field="icon"] .field-name').click();
  await shot('51-book-fields', 1200);
  await page.getByTestId('refs').scrollIntoViewIfNeeded();
  await page.locator('[data-ref="races"] .field-name').click();
  await shot('52-book-refs');
  await page.locator('[data-testid="in-game"][data-state="nowhere"]').waitFor({ timeout: 120_000 });
  await page.getByTestId('in-game-open').click();
  await shot('54-book-where', 1500);
  await page.getByTestId('where-same').filter({ hasText: 'holy church' }).click();
  await page.locator('[data-testid="in-game"][data-state="in"]').waitFor();
  await shot('55-book-where-added', 1500);
} finally {
  await app.evaluate(({ BrowserWindow }) => { for (const w of BrowserWindow.getAllWindows()) w.destroy(); }).catch(() => undefined);
  await app.close().catch(() => undefined);
}
