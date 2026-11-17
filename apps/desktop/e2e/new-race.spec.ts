/**
 * E2E: «New race based on…» on the real game data. Races category → the Greenlander is the
 * suggested sample → the name is required and must differ from the sample → «Create» makes a copy
 * (one undo step) and opens the «Race compatibility» wizard with the new race and the sample.
 * The «Mod» menu opens the same window.
 */
import { mkdirSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { _electron as electron, expect, test, type ElectronApplication, type Page } from '@playwright/test';

const appDir = resolve(import.meta.dirname, '..');
const editorRoot = resolve(appDir, '../..');
const shots = join(editorRoot, 'out', 'screenshots');
mkdirSync(shots, { recursive: true });

const GREENLANDER = '17-gamedata.quack';

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

test('new race based on a sample: name checks, copy, wizard opened with the pair, one undo', async () => {
  const { app, page } = await launch();
  try {
    await page.getByTestId('new-mod-name').fill('KeditE2E NewRace');
    await page.getByTestId('create-mod').click();
    await expect(page.getByTestId('editor')).toBeVisible({ timeout: 120_000 });

    // The button is offered only in the races category.
    await expect(page.getByTestId('list-new-race')).toHaveCount(0);
    await page.getByTestId('cat-Races').click();
    await page.locator(`[data-testid="record-list"] [data-sid="${GREENLANDER}"]`).click();
    await page.getByTestId('list-new-race').click();

    const modal = page.getByTestId('new-race-modal');
    await expect(modal).toBeVisible();
    // The selected race is the sample, shown with its translated name.
    await expect(modal.getByTestId('new-race-sample')).toHaveValue(GREENLANDER);
    await expect(modal.getByTestId('new-race-sample').locator('option:checked')).toContainText('Greenlander');
    await expect(modal.getByTestId('new-race-compat')).toBeChecked();
    // No name, the sample's name (English or translated), another race's name — no «Create».
    const create = modal.getByTestId('new-race-create');
    await expect(create).toBeDisabled();
    for (const bad of ['Greenlander', ' greenlander ', 'Зеленоземец', 'Shek']) {
      await modal.getByTestId('new-race-name').fill(bad);
      await expect(create).toBeDisabled();
      await expect(modal.getByTestId('new-race-problem')).not.toBeEmpty();
    }
    await modal.getByTestId('new-race-name').fill('E2E Mossfolk');
    await expect(create).toBeEnabled();
    await expect(modal.getByTestId('new-race-problem')).toBeEmpty();
    await page.screenshot({ path: join(shots, '38-new-race.png') });
    await create.click();
    await expect(modal).toHaveCount(0);

    // The copy is selected and the wizard shows the pair «E2E Mossfolk works like Greenlander».
    // (the wizard opens in the centre, in front of the inspector: the record list shows the selection).
    const picked = page.locator('[data-testid="record-list"] .list-row.selected');
    await expect(picked).toHaveCount(1);
    await expect(picked.locator('.name')).toHaveText('● E2E Mossfolk');
    const race = (await picked.getAttribute('data-sid'))!;
    expect(race).not.toBe(GREENLANDER);
    const panel = page.getByTestId('race-compat-panel');
    await expect(panel).toBeVisible();
    await expect(panel.getByTestId('rc-race')).toHaveValue(race);
    await expect(panel.getByTestId('rc-like')).toHaveValue(GREENLANDER);
    const armour = panel.locator('[data-testid="rc-group"][data-group="armour"]');
    await expect(armour).toHaveCount(1);
    await expect(armour.getByTestId('rc-row').first().locator('.bulk-after')).toContainText('E2E Mossfolk');
    await page.screenshot({ path: join(shots, '39-new-race-compat.png') });

    // Swapped pair: the fresh copy is used nowhere, so the wizard says why the list is empty and
    // that Greenlander (used in many places) is probably meant to be «my race» the other way round.
    await expect(panel.getByTestId('rc-why')).toHaveCount(0);
    await panel.getByTestId('rc-swap').click();
    await expect(panel.getByTestId('rc-race')).toHaveValue(GREENLANDER);
    await expect(panel.getByTestId('rc-like')).toHaveValue(race);
    await expect(panel.getByTestId('rc-why')).toContainText('E2E Mossfolk');
    await expect(panel.getByTestId('rc-swap-hint')).toBeVisible();
    await page.screenshot({ path: join(shots, '40-race-compat-swapped.png') });
    await panel.getByTestId('rc-swap').click();
    await expect(panel.getByTestId('rc-race')).toHaveValue(race);
    await expect(armour).toHaveCount(1);

    // Creating the race is one undo step (Ctrl+Z): the copy is gone.
    await page.evaluate(() => { if (document.activeElement instanceof HTMLElement) document.activeElement.blur(); });
    await page.keyboard.press('Control+z');
    await expect(page.locator(`[data-testid="record-list"] [data-sid="${race}"]`)).toHaveCount(0);
    await expect(page.getByTestId('redo')).toBeEnabled();

    // The «Mod» menu opens the same window (the Greenlander is the default sample there).
    await page.getByTestId('mod-menu').click();
    await page.getByTestId('new-race-btn').click();
    await expect(modal).toBeVisible();
    await expect(modal.getByTestId('new-race-sample')).toHaveValue(GREENLANDER);
    await modal.getByTestId('new-race-compat').uncheck();
    await modal.getByTestId('new-race-name').fill('E2E Mossfolk 2');
    await modal.getByTestId('new-race-create').click();
    await expect(picked.locator('.name')).toHaveText('● E2E Mossfolk 2');
  } finally {
    await closeApp(app);
  }
});
