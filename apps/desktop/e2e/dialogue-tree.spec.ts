/**
 * E2E (G5): «Tree (as in FCS)» view of «Healed (Recruit)» (8950-Dialogue.mod, Drifter squad, EV_PLAYER_TALK_TO_ME).
 * - The «Graph | Tree» switch is remembered: another dialogue opened from the tree opens as a tree too.
 * - The tree reads the 24 nodes of the graph top to bottom; «conversation ends» on 8959, 8988, 8989;
 *   at the bottom the entry from 8940-D-Dialogue.mod (G3).
 * - Selection is shared: a row picked in the tree is selected in the graph and in the line panel, and back.
 * - A text edited in the line panel shows in both views; double-click edits a row in place; «+ player answer»
 *   adds a new answer under the selected NPC line.
 */
import { mkdirSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { _electron as electron, expect, test, type ElectronApplication, type Page } from '@playwright/test';

const appDir = resolve(import.meta.dirname, '..');
const editorRoot = resolve(appDir, '../..');
const shots = join(editorRoot, 'out', 'screenshots', 'ux');
mkdirSync(shots, { recursive: true });

const DRIFTER_SQUAD = '3951-gamedata.base';
const HEALED = '8950-Dialogue.mod';
const HEALED_FROM = '8940-D-Dialogue.mod';
const FIRST = '8956-Dialogue.mod';
const HONOURABLE = '8951-Dialogue.mod';
const ENDS = ['8959-Dialogue.mod', '8988-Dialogue.mod', '8989-Dialogue.mod'];

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

test('dialogue tree: FCS rows, shared selection with the graph, edits seen in both views', async () => {
  const { app, page } = await launch();
  try {
    await app.evaluate(({ BrowserWindow }) => { BrowserWindow.getAllWindows()[0]?.setSize(1600, 1000); });
    await expect(page.getByTestId('open-vanilla')).toBeVisible({ timeout: 60_000 });
    await page.getByTestId('open-vanilla').click();
    await expect(page.getByTestId('editor')).toBeVisible({ timeout: 120_000 });
    await page.getByTestId('window-menu').click();
    await page.getByTestId('window-preset-dialogue').click();

    const panel = page.getByTestId('package-panel');
    await panel.getByTestId('pk-pick').click();
    await page.getByTestId('picker-search').fill(DRIFTER_SQUAD);
    await page.getByTestId('picker-list').locator(`[data-sid="${DRIFTER_SQUAD}"]`).dblclick();
    await panel.getByTestId('pk-search').fill('EV_PLAYER_TALK_TO_ME');
    await panel.locator(`[data-testid="pk-dialog"][data-sid="${HEALED}"]`).click();

    const area = page.locator('[data-panel="graph"]');
    const graph = area.getByTestId('dialogue-graph');
    await expect(graph).toHaveAttribute('data-sid', HEALED, { timeout: 60_000 });
    await expect(graph.getByTestId('dg-stats')).toContainText('узлов 24', { timeout: 60_000 });
    await expect(graph.getByTestId('dg-stats')).not.toContainText('читаю перевод');

    // Switch to the tree: the choice goes to localStorage.
    await area.getByTestId('dg-view-tree').click();
    const tree = area.getByTestId('dialogue-tree');
    await expect(tree).toHaveAttribute('data-sid', HEALED);
    await expect(area.getByTestId('dialogue-graph')).toHaveCount(0);
    expect(await page.evaluate(() => localStorage.getItem('kedit.graph.view'))).toBe('tree');

    // Column heads, and the big dialogue opens folded like the graph; «Unfold all» shows all 24 nodes once.
    await expect(tree.locator('.dt-th')).toContainText('Реплика');
    await expect(tree.locator('.dt-th')).toContainText('Условия');
    await expect(tree.locator('.dt-th')).toContainText('Эффекты');
    await expect(tree.locator('.dt-th')).toContainText('Свойства');
    const whole = tree.locator('[data-testid="dt-row"]:not([data-link])');
    await tree.getByTestId('dt-expand-all').click();
    await expect(whole).toHaveCount(24);
    const row = (sid: string) => tree.locator(`[data-testid="dt-row"][data-id="${sid}"]:not([data-link])`);
    await expect(row(HEALED)).toHaveAttribute('data-depth', '0');
    await expect(row(FIRST)).toHaveAttribute('data-depth', '1');
    await expect(row(FIRST).getByTestId('dt-order')).toHaveText('1');
    await expect(row(HONOURABLE).getByTestId('dt-order')).toHaveText('2');
    await expect(row(HONOURABLE)).toHaveAttribute('data-kind', 'npc');
    // The honourable line: its condition and its effect in the columns, codes next to the words.
    await expect(row(HONOURABLE).getByTestId('dt-conds')).toContainText('DC_PERSONALITY_TAG');
    await expect(row(HONOURABLE).getByTestId('dt-effects')).toContainText('DA_LOCK_THIS_DIALOG');
    await expect(row(HONOURABLE).getByTestId('dt-variants')).toHaveText('+1 вариант');
    await row(HONOURABLE).getByTestId('dt-variants').click();
    await expect(row(HONOURABLE).getByTestId('dt-variant')).toHaveCount(1);
    for (const sid of ENDS) await expect(row(sid).getByTestId('dt-end')).toContainText('конец разговора');
    await expect(row(HONOURABLE).getByTestId('dt-end')).toHaveCount(0);

    // At the bottom: the entry from 8940-D (G3).
    const entry = tree.locator(`[data-testid="dt-transition"][data-dir="in"][data-sid="${HEALED_FROM}"]`);
    await expect(entry).toContainText('← Вход из «Healed (Recruit)»');
    await expect(tree.locator('[data-testid="dt-transition"][data-dir="out"]')).toHaveCount(0);
    await row(HONOURABLE).click();
    await expect(row(HONOURABLE)).toHaveClass(/dt-sel/);
    await tree.screenshot({ path: join(shots, '107-dialogue-tree.png') });
    await entry.scrollIntoViewIfNeeded();
    await tree.screenshot({ path: join(shots, '108-dialogue-tree-transitions.png') });

    // Shared selection: the line panel and the graph show the row picked in the tree…
    const insp = page.getByTestId('line-inspector');
    await expect(insp).toHaveAttribute('data-sid', HONOURABLE, { timeout: 30_000 });
    await area.getByTestId('dg-view-graph').click();
    const node = (sid: string) => area.locator(`[data-testid="dg-node"][data-id="${sid}"]`);
    await expect(node(HONOURABLE)).toHaveClass(/dg-selected/, { timeout: 30_000 });
    // …and the tree shows the node picked in the graph.
    await node(FIRST).click();
    await expect(insp).toHaveAttribute('data-sid', FIRST);
    await area.getByTestId('dg-view-tree').click();
    await expect(row(FIRST)).toHaveClass(/dt-sel/);
    await expect(row(HONOURABLE)).not.toHaveClass(/dt-sel/);

    // A text edited in the line panel shows in the tree and in the graph.
    await insp.getByTestId('ln-text-0').fill('Ну что, живой? Тогда слушай.');
    await insp.getByTestId('ln-text-0').blur();
    await expect(row(FIRST).getByTestId('dt-text')).toHaveText('«Ну что, живой? Тогда слушай.»');
    await expect(row(FIRST)).toHaveAttribute('data-status', 'changed');
    await area.getByTestId('dg-view-graph').click();
    await expect(node(FIRST).locator('.dg-text')).toContainText('Ну что, живой? Тогда слушай.');
    await area.getByTestId('dg-view-tree').click();

    // Double-click edits the row in place; the panel follows.
    await row(FIRST).getByTestId('dt-text').dblclick();
    const edit = tree.getByTestId('dg-edit');
    await expect(edit).toBeVisible();
    await edit.fill('Живой? Хорошо.');
    await edit.press('Enter');
    await expect(row(FIRST).getByTestId('dt-text')).toHaveText('«Живой? Хорошо.»');
    await expect(insp.getByTestId('ln-text-0')).toHaveValue('Живой? Хорошо.');

    // «+ player answer» under the selected NPC line: a new row, text typed in place.
    const before = await whole.count();
    await row(FIRST).click();
    await tree.getByTestId('dt-add-answer').click();
    await expect(tree.getByTestId('dg-edit')).toBeVisible();
    await tree.getByTestId('dg-edit').fill('Спасибо, что подняли.');
    await tree.getByTestId('dg-edit').press('Enter');
    await expect(whole).toHaveCount(before + 1);
    const added = tree.locator('[data-testid="dt-row"][data-status="new"]');
    await expect(added).toHaveCount(1);
    await expect(added).toHaveAttribute('data-kind', 'player');
    await expect(added).toHaveAttribute('data-depth', '2');
    await expect(added.getByTestId('dt-text')).toHaveText('«Спасибо, что подняли.»');
    await expect(added).toHaveClass(/dt-sel/);
    await expect(added.getByTestId('dt-end')).toBeVisible();
    await tree.screenshot({ path: join(shots, '109-dialogue-tree-edited.png') });

    // The search finds the new answer.
    await tree.getByTestId('dt-search').fill('подняли');
    await expect(tree.getByTestId('dt-search-count')).toHaveText('1/1');

    // The choice is remembered: the dialogue opened from the transition row opens as a tree too.
    await entry.getByTestId('dt-transition-open').click();
    await expect(area.getByTestId('dialogue-tree')).toHaveAttribute('data-sid', HEALED_FROM, { timeout: 30_000 });
    await expect(area.getByTestId('dialogue-graph')).toHaveCount(0);
    await expect(area.locator(`[data-testid="dt-transition"][data-dir="out"][data-sid="${HEALED}"]`)).toBeVisible();
  } finally {
    await closeApp(app);
  }
});
