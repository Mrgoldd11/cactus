/**
 * E2E: every record says whether it is in the game. A new book made from Book of Grace is
 * «nowhere yet»; «Where in game» lists the ways into the game and the sample's places;
 * «Add to the same list “holy church”» puts it there (the line now names the trader), as one
 * undo step with a clear title; undo makes it «nowhere» again.
 */
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { _electron as electron, expect, test, type ElectronApplication, type Page } from '@playwright/test';

const appDir = resolve(import.meta.dirname, '..');

async function launch(): Promise<{ app: ElectronApplication; page: Page }> {
  const userData = mkdtempSync(join(tmpdir(), 'kedit-e2e-'));
  const env: Record<string, string> = { KEDIT_USER_DATA: userData, KEDIT_LIVE_FILE: join(userData, 'live.json') };
  for (const [k, v] of Object.entries(process.env)) if (v !== undefined && k !== 'ELECTRON_RENDERER_URL' && !(k in env)) env[k] = v;
  const app = await electron.launch({ args: ['.'], cwd: appDir, env });
  const page = await app.firstWindow();
  await page.waitForLoadState('domcontentloaded');
  return { app, page };
}

async function closeApp(app: ElectronApplication): Promise<void> {
  await app
    .evaluate(({ BrowserWindow }) => {
      for (const w of BrowserWindow.getAllWindows()) w.destroy();
    })
    .catch(() => undefined);
  await app.close();
}

const BOOK_OF_GRACE = '50383-Dialogue.mod';

test('«In game» line and ways: new book from a sample → nowhere → same list as the sample → trader → undo', async () => {
  const { app, page } = await launch();
  try {
    await page.getByTestId('open-vanilla').waitFor({ timeout: 60_000 });
    await page.getByTestId('lang-current').click();
    await page.getByTestId('lang-ru').click();
    await page.getByTestId('new-mod-name').fill('KeditE2E Ways');
    await page.getByTestId('create-mod').click();
    await expect(page.getByTestId('editor')).toBeVisible({ timeout: 120_000 });
    await page.getByTestId('window-menu').click();
    await page.getByTestId('window-preset-data').click();
    await page.getByTestId('cat-Items').locator('.twisty').click();
    await page.getByTestId('cat-Items/Books').click();

    // The sample itself: sold by the Priest, Moll has it.
    await page.getByTestId('record-list').locator(`[data-sid="${BOOK_OF_GRACE}"]`).click();
    const line = page.getByTestId('in-game');
    await expect(line).toHaveAttribute('data-state', 'in');
    await expect(page.getByTestId('in-game-brief')).toContainText('продаёт Жрец (holy church)');
    await expect(page.getByTestId('in-game-brief')).toContainText('у Молл');

    // A new book from it is nowhere yet.
    await page.getByTestId('new-record').click();
    await page.getByTestId('new-record-sample').click();
    const picker = page.getByTestId('record-picker');
    await picker.getByTestId('picker-search').fill(BOOK_OF_GRACE);
    await picker.getByTestId('picker-list').locator(`[data-sid="${BOOK_OF_GRACE}"]`).dblclick();
    await page.getByTestId('new-record-name').fill('E2E Книга');
    await page.getByTestId('new-record-create').click();
    await expect(page.getByTestId('record-name')).toHaveValue('E2E Книга');
    await expect(line).toHaveAttribute('data-state', 'nowhere', { timeout: 120_000 });
    await expect(page.getByTestId('in-game-nowhere')).toHaveText('⚠ пока нигде');
    await expect(page.getByTestId('tab-where')).toContainText('⚠');

    // «Where in game ▸»: ways from the schema and the sample's places.
    await page.getByTestId('in-game-open').click();
    await expect(page.getByTestId('tab-where')).toHaveClass(/active/);
    const nowhere = page.getByTestId('where-nowhere');
    await expect(nowhere).toBeVisible();
    const ways = nowhere.getByTestId('way');
    await expect(ways.first()).toHaveAttribute('data-way', 'VENDOR_LIST.items');
    await expect(ways.first()).toContainText('Продаётся у торговца');
    await expect(nowhere.locator('[data-way="SQUAD_TEMPLATE.special items"]')).toContainText('Есть у отряда с начала игры');
    const like = page.getByTestId('where-like');
    await expect(like).toHaveAttribute('data-sample', BOOK_OF_GRACE);
    await expect(like).toContainText('Как у образца «Книга благодати»');
    await expect(like.getByTestId('where-same-all')).toHaveText('Добавить во все (3)');

    // Same list as the sample: the line names the trader.
    await like.getByTestId('where-same').filter({ hasText: 'Добавить в тот же список «holy church»' }).click();
    await expect(line).toHaveAttribute('data-state', 'in');
    await expect(page.getByTestId('in-game-brief')).toHaveText('продаёт Жрец (holy church)');
    await expect(page.getByTestId('tab-where')).not.toContainText('⚠');
    await expect(page.getByTestId('where-fact').first()).toHaveAttribute('data-role', 'sold');

    // One undo step with a clear title; undo makes the book nowhere again.
    await page.getByTestId('undo-menu').click();
    const steps = page.getByTestId('undo-list').getByTestId('undo-step');
    await expect(steps).toHaveCount(2);
    await expect(steps.nth(0)).toContainText('В игру: «E2E Книга» → в «holy church» (items)');
    await page.keyboard.press('Escape');
    await page.getByTestId('undo').click();
    await expect(line).toHaveAttribute('data-state', 'nowhere');
    await expect(page.getByTestId('where-nowhere')).toBeVisible();
    await expect(page.getByTestId('record-name')).toHaveValue('E2E Книга');
  } finally {
    await closeApp(app);
  }
});
