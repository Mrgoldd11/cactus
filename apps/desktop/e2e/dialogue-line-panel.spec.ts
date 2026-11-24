/**
 * E2E: the line panel of the Dialogues layout (UI review G4).
 * - FCS-style condition rows (who → condition, then tag / comparison / value) with the phrase under them.
 * - One «+ условие» list: DC_ values and reference conditions together, found in Russian, English and by code.
 * - A picked reference condition («моя раса» → Шек) lands in the `my race` field of the line.
 * - The description of the clicked field at the bottom, as in FCS.
 */
import { mkdirSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { _electron as electron, expect, test, type ElectronApplication, type Page } from '@playwright/test';

const appDir = resolve(import.meta.dirname, '..');
const editorRoot = resolve(appDir, '../..');
const shots = join(editorRoot, 'out', 'screenshots', 'ux');
mkdirSync(shots, { recursive: true });

/** «Healed (Recruit)»: «It's rare to meet good folks like you…» — two variants, «only if I am honorable», locks the dialogue. */
const LINE = '8951-Dialogue.mod';
/** RACE «Shek» (Шек). */
const SHEK = '5276-chareditor.mod';

async function launch(): Promise<{ app: ElectronApplication; page: Page }> {
  const userData = mkdtempSync(join(tmpdir(), 'kedit-e2e-'));
  const env: Record<string, string> = { KEDIT_USER_DATA: userData, KEDIT_LIVE_FILE: join(userData, 'live.json') };
  for (const [k, v] of Object.entries(process.env)) if (v !== undefined && k !== 'ELECTRON_RENDERER_URL' && !(k in env)) env[k] = v;
  const app = await electron.launch({ args: ['.'], cwd: appDir, env });
  const page = await app.firstWindow();
  await page.waitForLoadState('domcontentloaded');
  // These checks read the FCS codes next to the words: turn the «FCS codes» setting on (off by default).
  await page.evaluate(() => {
    localStorage.setItem('kedit.fcsCodes', '1');
  });
  await page.reload();
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

test('line panel: FCS rows, one condition list with search, reference condition into its field, field description', async () => {
  const { app, page } = await launch();
  try {
    await app.evaluate(({ BrowserWindow }) => {
      BrowserWindow.getAllWindows()[0]?.setSize(1500, 1000);
    });
    await expect(page.getByTestId('open-vanilla')).toBeVisible({ timeout: 60_000 });
    await page.getByTestId('open-vanilla').click();
    await expect(page.getByTestId('editor')).toBeVisible({ timeout: 120_000 });
    await page.getByTestId('window-menu').click();
    await page.getByTestId('window-preset-dialogue').click();
    await page.locator('.dv-tab', { hasText: 'Записи' }).click();
    await page.getByTestId('search').fill(LINE);
    await page.getByTestId('record-list').locator(`[data-sid="${LINE}"]`).click();
    const panel = page.getByTestId('line-inspector');
    await expect(panel).toHaveAttribute('data-sid', LINE, { timeout: 30_000 });

    // Top to bottom: kind, «Кто говорит», texts with variants, conditions, effects.
    await expect(panel.getByTestId('ln-kind')).toHaveText('Реплика NPC');
    await expect(panel.getByTestId('ln-variants')).toHaveText('вариантов: 2 · игра говорит один наугад');
    await expect(panel.getByTestId('ln-text-1')).toHaveValue(/^It's rare to find good people/);
    const titles = panel.locator('.ln-section-title > span:first-child');
    await expect(titles.nth(0)).toHaveText('Кто говорит');
    await expect(titles.nth(1)).toHaveText('Текст');
    await expect(titles.nth(2)).toHaveText('Условия (1)');
    await expect(titles.nth(3)).toHaveText('Эффекты (1)');

    // The condition as an FCS row: who → condition, then trait / comparison / value, the phrase under it.
    const cond = panel.getByTestId('ln-cond').first();
    await expect(cond.getByTestId('ln-cond-who').locator('option:checked')).toContainText('T_ME');
    await expect(cond.getByTestId('ln-cond-name').locator('option:checked')).toHaveText(/ · DC_PERSONALITY_TAG$/);
    await expect(cond.getByTestId('ln-cond-tag').locator('option:checked')).toContainText('PT_HONORABLE');
    // A yes / no condition reads as «да» (= 1) rather than a comparison and a number.
    await expect(cond.getByTestId('ln-cond-yes')).toHaveValue('1');
    await expect(cond.getByTestId('ln-cond-phrase')).toContainText('Сказать, только если у меня есть черта «честный»');
    await expect(panel.getByTestId('ln-effect-phrase').first()).toContainText(/^Затем: /);

    // The description pane: a hint at first, the meaning of the clicked field after.
    const desc = panel.getByTestId('ln-desc');
    await expect(desc).toContainText('Нажмите на поле');
    await cond.getByTestId('ln-cond-yes').click();
    await expect(desc).toContainText('Условие:');
    await expect(desc).toContainText('DC_PERSONALITY_TAG');
    await panel.getByTestId('ln-f-chance temporary').click();
    await expect(desc).toContainText('chance temporary');
    await expect(desc).toContainText('СКАЖЕТ');
    await cond.getByTestId('ln-cond-yes').click();
    await page.screenshot({ path: join(shots, '99-line-panel.png') });

    // «+ условие»: one list; Russian, English and the code prefix all find DC_STARVING.
    await panel.getByTestId('ln-cond-add').click();
    const pick = panel.getByTestId('ln-pick');
    await expect(pick).toBeVisible();
    await expect(pick.getByTestId('ln-pick-group').first()).toHaveAttribute('data-group', 'common');
    // Reference conditions sit in the same list as DC_ values.
    await expect(pick.locator('[data-testid="ln-pick-item"][data-key="ref:my race"]')).toHaveCount(1);
    const search = pick.getByTestId('ln-pick-search');
    const starving = pick.locator('[data-testid="ln-pick-item"][data-key="DC_STARVING"]');
    for (const q of ['голод', 'starv', 'DC_STARV']) {
      await search.fill(q);
      await expect(starving, q).toHaveCount(1);
      await expect(starving, q).toContainText('Голодает');
    }
    await search.fill('голод');
    await starving.hover();
    await expect(pick.getByTestId('ln-pick-desc')).toContainText('DC_STARVING');
    await panel.screenshot({ path: join(shots, '100-line-condition-picker.png') });

    // Enter adds the first match with plain defaults: «я», «= 1».
    await search.fill('DC_STARV');
    await search.press('Enter');
    await expect(pick).toHaveCount(0);
    await expect(panel.getByTestId('ln-cond')).toHaveCount(2);
    await expect(panel.getByTestId('ln-cond').nth(1).getByTestId('ln-cond-phrase')).toContainText('Сказать, только если я голодаю');

    // A reference condition: «моя раса» → the record picker offers races → Шек lands in `my race`.
    await panel.getByTestId('ln-cond-add').click();
    await search.fill('моя раса');
    const myRace = pick.locator('[data-testid="ln-pick-item"][data-key="ref:my race"]');
    await expect(myRace).toContainText('ссылка → раса');
    await myRace.click();
    const picker = page.getByTestId('record-picker');
    await expect(picker).toBeVisible();
    await expect(picker).toContainText('Моя раса: выберите RACE');
    await picker.getByTestId('picker-search').fill('Shek');
    await picker.getByTestId('picker-list').locator(`[data-sid="${SHEK}"]`).dblclick();
    await expect(picker).toHaveCount(0);
    const ref = panel.locator('[data-testid="ln-ref"][data-category="my race"]');
    await expect(ref.locator(`[data-testid="ln-ref-target"][data-sid="${SHEK}"]`)).toHaveCount(1);
    await expect(ref.getByTestId('ln-ref-phrase')).toContainText('Сказать, только если');
    await expect(ref.getByTestId('ln-ref-phrase')).toContainText('Шек');
    await expect(titles.nth(2)).toHaveText('Условия (3)');
    // The DC_ condition list itself is unchanged by the reference.
    await expect(panel.getByTestId('ln-cond')).toHaveCount(2);
    await ref.click();
    await expect(desc).toContainText('my race');
    await panel.screenshot({ path: join(shots, '101-line-reference-condition.png') });

    // The same field in the record inspector: `my race` → Shek.
    // In this layout the inspector is an inactive tab beside the line panel: open it explicitly.
    await panel.getByRole('button', { name: /Инспектор/ }).first().click();
    await page.locator('.dv-tab', { hasText: 'Инспектор' }).first().click();
    const inspectorRef = page.locator(`.ref-group[data-category="my race"] .ref-row[data-target="${SHEK}"]`);
    await expect(inspectorRef).toHaveCount(1, { timeout: 15_000 });
    await inspectorRef.scrollIntoViewIfNeeded();
    await page.screenshot({ path: join(shots, '102-line-reference-in-inspector.png') });

    // «+ эффект»: DA_ values and reference effects in one list.
    await page.locator('.dv-tab', { hasText: 'Реплика диалога' }).click();
    await expect(panel).toHaveAttribute('data-sid', LINE);
    await panel.getByTestId('ln-effect-add').click();
    const epick = panel.getByTestId('ln-pick');
    await expect(epick).toHaveAttribute('data-kind', 'effect');
    await epick.getByTestId('ln-pick-search').fill('give item');
    await expect(epick.locator('[data-testid="ln-pick-item"][data-key="ref:give item"]')).toContainText('ссылка → предмет');
    await epick.getByTestId('ln-pick-search').fill('DA_LOCK');
    await expect(epick.locator('[data-testid="ln-pick-item"][data-key="DA_LOCK_THIS_DIALOG"]')).toHaveCount(1);
    await panel.screenshot({ path: join(shots, '103-line-effect-picker.png') });
    await epick.getByTestId('ln-pick-search').press('Escape');
    await expect(epick).toHaveCount(0);
  } finally {
    await closeApp(app);
  }
});
