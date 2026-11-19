/**
 * E2E (G7): the «▶ Play» strip under the graph on «acid rain» (62) of «player character default».
 * - Opened on PCD's own «acid rain» (55630): the candidates in the game's order with their keys —
 *   the inherited «Acid rain tough reaction» (55661, 6) first, 55630 (0) second; the game picks 55661.
 * - A dialogue made in the G6 window «only race Shek» gets key 7 (+7 bonus: 6 to reach 55661, 1 for the
 *   race condition) and stands first.
 * - Step by step: the said line and then the chosen answer are highlighted in the graph and the tree.
 * - «Make one like it…» opens the G6 window filled from the sample.
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
const OWN_RAIN = '55630-rebirth.mod';
const TOUGH_RAIN = '55661-Dialogue.mod';
const NPC_TEXT = 'Кислота разъедает панцирь. Ищем укрытие.';
const ANSWER_TEXT = 'Бежим под навес!';

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

async function pickRecord(page: Page, sid: string): Promise<void> {
  await page.getByTestId('picker-search').fill(sid);
  await page.getByTestId('picker-list').locator(`[data-sid="${sid}"]`).dblclick();
}

test('play strip: acid rain candidates by key, a new Shek dialogue first, the played line lit', async () => {
  const { app, page } = await launch();
  try {
    await app.evaluate(({ BrowserWindow }) => { BrowserWindow.getAllWindows()[0]?.setSize(1500, 1000); });
    await page.getByTestId('new-mod-name').fill('KeditE2E PlayStrip');
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
    await rain.click();
    await panel.locator(`[data-testid="pk-dialog"][data-sid="${OWN_RAIN}"]`).click();

    const area = page.locator('[data-panel="graph"]');
    await expect(area.getByTestId('dialogue-graph')).toHaveAttribute('data-sid', OWN_RAIN, { timeout: 60_000 });
    // The strip opens only by the button.
    await expect(area.getByTestId('play-strip')).toHaveCount(0);
    await area.getByTestId('dg-play').click();
    await expect(area.getByTestId('dg-play')).toHaveAttribute('aria-pressed', 'true');
    const strip = area.getByTestId('play-strip');
    await expect(strip).toHaveAttribute('data-mode', 'package');
    await expect(strip).toHaveAttribute('data-event', '62');
    await expect(strip.getByTestId('ps-spot')).toContainText('player character default');
    await expect(strip.getByTestId('ps-speaker')).toHaveValue('');

    // Every candidate in the game's order with its key; the inherited one (6) beats the own one (0).
    const first = strip.locator('[data-testid="pl-step"][data-index="0"]');
    // The dialogue choice (rows with a key); the line choices inside the dialogue follow it.
    const options = first.locator('[data-testid="pl-option"][data-key]');
    await expect(options).toHaveCount(2, { timeout: 60_000 });
    await expect(options.nth(0)).toHaveAttribute('data-sid', TOUGH_RAIN);
    await expect(options.nth(0)).toHaveAttribute('data-key', '6');
    await expect(options.nth(0)).toHaveAttribute('data-place', '1');
    await expect(options.nth(0)).toHaveAttribute('data-why', 'chosen');
    await expect(options.nth(1)).toHaveAttribute('data-sid', OWN_RAIN);
    await expect(options.nth(1)).toHaveAttribute('data-key', '0');
    await expect(options.nth(1).getByTestId('pl-key')).toHaveAttribute('title', /2-й в порядке игры/);
    await expect(strip.getByTestId('ps-summary')).toHaveAttribute('data-chosen', TOUGH_RAIN);
    await expect(strip.getByTestId('ps-chosen')).toContainText('Игра берёт «Acid rain tough reaction»');
    await expect(strip.getByTestId('ps-chosen')).toContainText('очков: 6');
    await expect(strip.getByTestId('ps-tie')).toHaveCount(0);
    await page.screenshot({ path: join(shots, '113-play-strip-candidates.png') });

    // A Shek-only dialogue from the G6 window: an NPC line and a player answer.
    await rain.getByTestId('pk-add').click();
    const modal = page.getByTestId('event-dialogue-modal');
    await expect(modal).toBeVisible();
    await modal.getByTestId('ed-race-on').check();
    await modal.getByTestId('ed-race').click();
    await pickRecord(page, SHEK);
    // The plan said +1; the bonus is +7: 6 to reach the inherited rival, 1 for the race condition.
    await expect(modal.getByTestId('ed-bonus')).toHaveValue('7');
    await modal.getByTestId('ed-text').first().fill(NPC_TEXT);
    await modal.getByTestId('ed-add-line').click();
    await expect(modal.getByTestId('ed-speaker').nth(1)).toHaveValue('1');
    await modal.getByTestId('ed-text').nth(1).fill(ANSWER_TEXT);
    await modal.getByTestId('ed-create').click();
    await expect(modal).toHaveCount(0);

    // The graph goes to the new dialogue; the strip is reopened on it.
    const graph = area.getByTestId('dialogue-graph');
    await expect(graph).not.toHaveAttribute('data-sid', OWN_RAIN, { timeout: 60_000 });
    const made = (await graph.getAttribute('data-sid'))!;
    if ((await area.getByTestId('dg-play').getAttribute('aria-pressed')) === 'true') await area.getByTestId('dg-play').click();
    await area.getByTestId('dg-play').click();
    await expect(strip).toHaveAttribute('data-event', '62');
    await expect(options).toHaveCount(3, { timeout: 60_000 });
    await expect(options.nth(0)).toHaveAttribute('data-sid', made);
    await expect(options.nth(0)).toHaveAttribute('data-key', '7');
    await expect(options.nth(1)).toHaveAttribute('data-sid', TOUGH_RAIN);
    await expect(options.nth(2)).toHaveAttribute('data-sid', OWN_RAIN);
    await expect(strip.getByTestId('ps-summary')).toHaveAttribute('data-chosen', made);

    // Step by step: the NPC line is said and lit in the graph; the answer moves the light.
    await expect(first.getByTestId('pl-said')).toContainText(NPC_TEXT);
    const npcLine = (await first.getByTestId('pl-said').getAttribute('data-sid'))!;
    await expect(graph.locator(`[data-testid="dg-node"][data-id="${npcLine}"]`)).toHaveAttribute('data-playing', 'true');
    const answer = first.getByTestId('pl-answer');
    await expect(answer).toHaveCount(1);
    const answerLine = (await answer.getAttribute('data-sid'))!;
    await answer.click();
    await expect(graph.locator(`[data-testid="dg-node"][data-id="${answerLine}"]`)).toHaveAttribute('data-playing', 'true');
    await expect(graph.locator(`[data-testid="dg-node"][data-id="${npcLine}"]`)).not.toHaveAttribute('data-playing', 'true');
    await expect(graph.locator('[data-testid="dg-node"][data-playing="true"]')).toHaveCount(1);

    // The tree lights the same line; the strip stays open across the switch.
    await area.getByTestId('dg-view-tree').click();
    const tree = area.getByTestId('dialogue-tree');
    await expect(tree).toHaveAttribute('data-sid', made);
    await expect(strip).toBeVisible();
    await expect(tree.locator('[data-testid="dt-row"][data-playing="true"]')).toHaveAttribute('data-id', answerLine);
    await page.screenshot({ path: join(shots, '114-play-strip-step-tree.png') });
    await area.getByTestId('dg-view-graph').click();

    // «Make one like it…»: the G6 window with the sample's race and lines.
    await expect(strip.getByTestId('ps-like')).toHaveAttribute('data-sample', made);
    await strip.getByTestId('ps-like').click();
    await expect(modal).toBeVisible();
    await expect(modal.getByTestId('ed-like')).toHaveAttribute('data-sid', made);
    await expect(modal.getByTestId('ed-event')).toContainText('EV_ACID_RAIN');
    await expect(modal.getByTestId('ed-who')).toContainText('player character default');
    await expect(modal.getByTestId('ed-race-on')).toBeChecked();
    await expect(modal.getByTestId('ed-race')).toContainText('Шек');
    await expect(modal.getByTestId('ed-text').nth(0)).toHaveValue(NPC_TEXT);
    await expect(modal.getByTestId('ed-text').nth(1)).toHaveValue(ANSWER_TEXT);
    await expect(modal.getByTestId('ed-speaker').nth(1)).toHaveValue('1');
    // Equal to the sample: the bonus keeps it one above (7 + 1).
    await expect(modal.getByTestId('ed-bonus')).toHaveValue('8');
    await page.screenshot({ path: join(shots, '115-play-strip-like.png') });
    await modal.getByRole('button', { name: 'Отмена' }).click();
    await expect(modal).toHaveCount(0);

    // ✕ closes the strip, the light goes out.
    await strip.getByTestId('ps-close').click();
    await expect(strip).toHaveCount(0);
    await expect(graph.locator('[data-testid="dg-node"][data-playing="true"]')).toHaveCount(0);
  } finally {
    await closeApp(app);
  }
});
