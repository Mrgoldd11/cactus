/**
 * E2E (G6): the «New dialogue on event» window on «acid rain» (62) of «player character default».
 * - PCD has its own «acid rain» (55630, score 0) and inherits «Acid rain tough reaction» (55661, score 6).
 * - Without conditions the window proposes +6 (a tie with 55661); «only race Shek» makes it conditional: +7, tried first.
 * - Create is one undo step; reopening the window shows the new dialogue as the strongest rival (7).
 * Which dialogue the game picks first is checked through the core in `event-dialogue.game.test.ts` (chooseRanking).
 */
import { mkdirSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { _electron as electron, expect, test, type ElectronApplication, type Page } from '@playwright/test';

const appDir = resolve(import.meta.dirname, '..');
const editorRoot = resolve(appDir, '../..');
const shots = join(editorRoot, 'out', 'screenshots', 'ux');
mkdirSync(shots, { recursive: true });

const PCD = '5369-gamedata.base';
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

async function pickRecord(page: Page, sid: string): Promise<void> {
  await page.getByTestId('picker-search').fill(sid);
  await page.getByTestId('picker-list').locator(`[data-sid="${sid}"]`).dblclick();
}

test('new dialogue on event: acid rain in player character default, score bonus, one undo', async () => {
  const { app, page } = await launch();
  try {
    await app.evaluate(({ BrowserWindow }) => { BrowserWindow.getAllWindows()[0]?.setSize(1500, 1000); });
    await page.getByTestId('new-mod-name').fill('KeditE2E EventDialogue');
    await page.getByTestId('create-mod').click();
    await expect(page.getByTestId('editor')).toBeVisible({ timeout: 120_000 });
    await page.getByTestId('window-menu').click();
    await page.getByTestId('window-preset-dialogue').click();

    const panel = page.getByTestId('package-panel');
    await expect(panel).toBeVisible();
    await panel.getByTestId('pk-pick').click();
    await pickRecord(page, PCD);
    await expect(panel).toHaveAttribute('data-sid', PCD);
    const rain = panel.locator('[data-testid="pk-event"][data-event="62"]');
    await expect(rain.getByTestId('pk-event-count')).toHaveAttribute('title', 'Своих диалогов: 1, наследуемых: 1');

    // «+» on the event: the event and the package are already chosen.
    await rain.getByTestId('pk-add').click();
    const modal = page.getByTestId('event-dialogue-modal');
    await expect(modal).toBeVisible();
    await expect(modal.getByTestId('ed-event')).toContainText('EV_ACID_RAIN');
    await expect(modal.getByTestId('ed-who')).toContainText('player character default');
    await expect(modal.getByTestId('ed-create')).toBeDisabled();
    // No conditions: the bonus only reaches the strongest rival — a tie.
    const score = modal.getByTestId('ed-score');
    await expect(score).toContainText('Очки 6 против 6');
    await expect(score).toContainText('ничья');
    await expect(modal.getByTestId('ed-bonus')).toHaveValue('6');

    // Only Shek: the dialogue gets a condition, one more point — it is tried first.
    await modal.getByTestId('ed-race-on').check();
    await modal.getByTestId('ed-race').click();
    await pickRecord(page, SHEK);
    await expect(modal.getByTestId('ed-race')).toContainText('Шек');
    await expect(modal.getByTestId('ed-bonus')).toHaveValue('7');
    await expect(score).toContainText('Очки 7 против 6');
    await expect(score).toContainText('пробуется первым');
    await expect(score).toContainText('Без бонуса было бы 0 против 6: не прозвучал бы никогда');
    await expect(modal.getByTestId('ed-conds')).toContainText('Шек');
    await modal.getByTestId('ed-text').first().fill('Кислота разъедает панцирь. Ищем укрытие.');
    await expect(modal.getByTestId('ed-name')).toHaveValue(/^player character default .*acid rain/);
    await expect(modal.getByTestId('ed-will')).toContainText('Одна отмена');
    await expect(modal.getByTestId('ed-create')).toBeEnabled();
    await page.screenshot({ path: join(shots, '110-event-dialogue-window.png') });

    // A bonus set by hand is explained, «auto» brings the computed one back.
    await modal.getByTestId('ed-bonus').fill('2');
    await expect(score).toContainText('Очки 2 против 6');
    await expect(score).toContainText('задан вручную (авто: 7)');
    await modal.getByTestId('ed-bonus-auto').click();
    await expect(modal.getByTestId('ed-bonus')).toHaveValue('7');

    await modal.getByTestId('ed-create').click();
    await expect(modal).toHaveCount(0);
    await expect(rain.getByTestId('pk-event-count')).toHaveAttribute('title', 'Своих диалогов: 2, наследуемых: 1');
    await page.screenshot({ path: join(shots, '111-event-dialogue-created.png') });

    // The new dialogue is now the strongest on the event: its key is 7.
    await rain.getByTestId('pk-add').click();
    await expect(modal).toBeVisible();
    await expect(score).toContainText('Очки 7 против 7 («player character default');
    // A DC_ condition from the picker scores 1: the bonus keeps it one above the rival.
    await modal.getByTestId('ed-add-cond').click();
    await modal.getByTestId('ln-pick-search').fill('DC_STARVING');
    await modal.getByTestId('ln-pick-search').press('Enter');
    await expect(modal.getByTestId('ed-cond')).toHaveCount(1);
    await expect(score).toContainText('Очки 8 против 7');
    await page.screenshot({ path: join(shots, '112-event-dialogue-rival.png') });
    await modal.getByRole('button', { name: 'Отмена' }).click();
    await expect(modal).toHaveCount(0);

    // One undo step removes the dialogue, its line and the package reference.
    await page.evaluate(() => { if (document.activeElement instanceof HTMLElement) document.activeElement.blur(); });
    await page.keyboard.press('Control+z');
    await expect(rain.getByTestId('pk-event-count')).toHaveAttribute('title', 'Своих диалогов: 1, наследуемых: 1');

    // The «Create ▾» entry and «+ New dialogue…» open the same window.
    await page.getByTestId('create-menu').click();
    await page.getByTestId('create-menu-list').getByTestId('new-event-dialogue').click();
    await expect(modal).toBeVisible();
    await modal.getByRole('button', { name: 'Отмена' }).click();
    await panel.getByTestId('pk-new-dialog').click();
    await expect(modal.getByTestId('ed-who')).toContainText('player character default');
    await expect(modal.getByTestId('ed-create')).toBeDisabled();
  } finally {
    await closeApp(app);
  }
});
