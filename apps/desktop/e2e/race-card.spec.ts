/**
 * E2E: the «Create ▾» menu and the race card of the inspector on the real game data.
 * - «Create ▾» holds everything that makes records; «Mod ▾» no longer has «New race»; Ctrl+N is
 *   «New record»; the record list and «Bulk edits» have no race buttons.
 * - A game race shows a short card (own animations, a new race based on it); the mod's own race
 *   shows its steps computed from the data: sample, compatibility (before and after the wizard),
 *   own animations, the «not in the game folder» warning.
 * - The card folds into one line, stays folded for other races, and its buttons open the wizards.
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

test('Create menu and the race card: steps from the data, fold remembered, buttons open the wizards', async () => {
  const { app, page } = await launch();
  try {
    await page.getByTestId('new-mod-name').fill('KeditE2E RaceCard');
    await page.getByTestId('create-mod').click();
    await expect(page.getByTestId('editor')).toBeVisible({ timeout: 120_000 });

    // «Create ▾»: new record, new race, two items coming later (disabled with a hint).
    await page.getByTestId('create-menu').click();
    const list = page.getByTestId('create-menu-list');
    await expect(list.getByTestId('create-new-record')).toBeEnabled();
    await expect(list.getByTestId('new-race-btn')).toBeEnabled();
    await expect(list.getByTestId('new-item-soon')).toBeDisabled();
    await expect(list.getByTestId('new-creature-soon')).toBeDisabled();
    await page.screenshot({ path: join(shots, '90-create-menu.png') });
    await list.getByTestId('create-new-record').click();
    await expect(page.getByTestId('new-record-modal')).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(page.getByTestId('new-record-modal')).toHaveCount(0);
    // «Mod ▾» keeps only mod properties.
    await page.getByTestId('mod-menu').click();
    await expect(page.getByTestId('mod-menu-list')).toBeVisible();
    await expect(page.getByTestId('mod-menu-list').getByTestId('new-race-btn')).toHaveCount(0);
    await page.keyboard.press('Escape');
    // Ctrl+N — «New record».
    await page.evaluate(() => { if (document.activeElement instanceof HTMLElement) document.activeElement.blur(); });
    await page.keyboard.press('Control+n');
    await expect(page.getByTestId('new-record-modal')).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(page.getByTestId('validate')).toBeVisible();

    // No race buttons in the record list or in «Bulk edits».
    await page.getByTestId('cat-Races').click();
    await expect(page.getByTestId('list-new-race')).toHaveCount(0);
    await expect(page.getByTestId('list-add-anims')).toHaveCount(0);
    await page.getByTestId('window-menu').click();
    await page.getByTestId('window-panel-bulk').click();
    await expect(page.getByTestId('bulk-mod-only')).toBeVisible();
    await expect(page.getByTestId('bulk-race-compat')).toHaveCount(0);

    // A game race: a short card, no steps of its own.
    await page.locator(`[data-testid="record-list"] [data-sid="${GREENLANDER}"]`).click();
    await page.locator('.dv-tab', { hasText: /Inspector|Инспектор/ }).first().click();
    const card = page.getByTestId('race-card');
    await expect(card).toHaveAttribute('data-own', '0');
    await expect(card).toHaveAttribute('data-folded', '0');
    await expect(card.getByTestId('race-card-anims')).toBeVisible();
    await expect(card.getByTestId('race-card-sample')).toHaveCount(0);
    await expect(card.getByTestId('race-card-save')).toHaveCount(0);
    // A picture of the model is drawn (and actually loads), a click on it opens «Model».
    const img = card.locator('.race-card-thumb img');
    await expect(img).toHaveCount(1, { timeout: 60_000 });
    await expect.poll(() => img.evaluate((e: HTMLImageElement) => e.naturalWidth)).toBeGreaterThan(0);
    await card.getByTestId('race-card-model').click();
    await expect(page.getByTestId('model-view')).toBeVisible();

    // A new race on the card's button, with compatibility: the wizard opens with the pair.
    await page.locator('.dv-tab', { hasText: /Inspector|Инспектор/ }).first().click();
    await card.getByTestId('race-card-new-from').click();
    const modal = page.getByTestId('new-race-modal');
    await expect(modal.getByTestId('new-race-sample')).toHaveValue(GREENLANDER);
    await modal.getByTestId('new-race-name').fill('E2E Cardfolk');
    await modal.getByTestId('new-race-create').click();
    const wizard = page.getByTestId('race-compat-panel');
    await expect(wizard).toBeVisible();
    const race = (await page.locator('[data-testid="record-list"] .list-row.selected').getAttribute('data-sid'))!;
    await expect(wizard.getByTestId('rc-race')).toHaveValue(race);

    // Before the wizard is applied: sample found, compatibility to do, no own animations, not in the game folder.
    await page.locator('.dv-tab', { hasText: /Inspector|Инспектор/ }).first().click();
    await expect(card).toHaveAttribute('data-own', '1');
    await expect(card.getByTestId('race-card-sample')).toHaveAttribute('data-done', '1');
    await expect(card.getByTestId('race-card-sample-link')).toContainText(/Greenlander|Зеленоземец/);
    await expect(card.getByTestId('race-card-compat')).toHaveAttribute('data-done', '0');
    await expect(card.getByTestId('race-card-anims')).toHaveAttribute('data-done', '0');
    await expect(card.getByTestId('race-card-save')).toBeVisible();
    await page.screenshot({ path: join(shots, '91-race-card.png') });

    // The card's «Set up…» opens the wizard with the same pair; applying it marks the step done.
    await card.getByTestId('race-card-compat-btn').click();
    await expect(wizard).toBeVisible();
    await expect(wizard.getByTestId('rc-race')).toHaveValue(race);
    await expect(wizard.getByTestId('rc-like')).toHaveValue(GREENLANDER);
    await wizard.getByTestId('rc-apply').click();
    await page.locator('.dv-tab', { hasText: /Inspector|Инспектор/ }).first().click();
    await expect(card.getByTestId('race-card-compat')).toHaveAttribute('data-done', '1');
    // Still found after the wizard: the race now stands next to the sample in the lists.
    await expect(card.getByTestId('race-card-sample')).toHaveAttribute('data-done', '1');

    // Fold: one line with the next step; remembered for other races.
    await card.getByTestId('race-card-fold').click();
    await expect(card).toHaveAttribute('data-folded', '1');
    await expect(card.locator('.race-card-marks')).toHaveText('✓✓○');
    await expect(card.locator('.race-card-steps')).toHaveCount(0);
    await page.screenshot({ path: join(shots, '92-race-card-folded.png') });
    await page.locator(`[data-testid="record-list"] [data-sid="${GREENLANDER}"]`).click();
    await expect(card).toHaveAttribute('data-own', '0');
    await expect(card).toHaveAttribute('data-folded', '1');
    expect(await page.evaluate(() => localStorage.getItem('cactus.card.RACE'))).toBe('1');
    await page.locator(`[data-testid="record-list"] [data-sid="${race}"]`).click();
    // The next step's button: own animations, for this race.
    await card.getByTestId('race-card-next').click();
    const anims = page.getByTestId('add-anims-panel');
    await expect(anims).toBeVisible();
    await expect(anims.getByTestId('aa-race')).toHaveValue(race);

    // Unfold again.
    await page.locator('.dv-tab', { hasText: /Inspector|Инспектор/ }).first().click();
    await card.getByTestId('race-card-fold').click();
    await expect(card).toHaveAttribute('data-folded', '0');
    expect(await page.evaluate(() => localStorage.getItem('cactus.card.RACE'))).toBe('0');
  } finally {
    await closeApp(app);
  }
});
