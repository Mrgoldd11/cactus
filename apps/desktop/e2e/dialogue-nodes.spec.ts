/**
 * E2E (G2): «line = node» dialogue graph nodes on «Healed (Recruit)» (8950-Dialogue.mod, Drifter squad,
 * EV_PLAYER_TALK_TO_ME — the healed one of event 21 is 8940).
 * - 24 nodes; who speaks by the stripe (NPC / player / interjection), ①② — the order the game tries NPC lines:
 *   «I owe you» (8956, three conditions) first, the honest one (8951) second.
 * - «if …» / «→ …» phrases with FCS codes, badges only for non-default properties, the «FCS codes» toggle.
 * - «Да не за что» ends the conversation (red plate); «Конечно, пойдём вместе!» goes on to «Веди» (no plate).
 * - Deep branches are folded at first («▸ ещё …»), «Unfold all» shows everything.
 * - Toolbar above the selected node: «+ interjection» adds a T_INTERJECTOR1 line.
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
const s = (n: number): string => `${n}-Dialogue.mod`;

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

test('dialogue nodes: speakers, checking order, phrases, end plates, folding, toolbar', async () => {
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
    const graph = page.locator('[data-panel="graph"]').getByTestId('dialogue-graph');
    await expect(graph).toHaveAttribute('data-sid', HEALED, { timeout: 60_000 });
    await expect(graph.getByTestId('dg-stats')).toContainText('узлов 24', { timeout: 60_000 });
    await expect(graph.getByTestId('dg-stats')).not.toContainText('читаю перевод');
    const node = (sid: string) => graph.locator(`[data-testid="dg-node"][data-id="${sid}"]`);

    // The dialogue: «Диалог» with its code, badges only for what differs from the defaults.
    const head = node(HEALED);
    await expect(head).toHaveAttribute('data-kind', 'head');
    await expect(head.locator('.dg-chip')).toHaveText('Диалог');
    await expect(head.getByTestId('dg-badge')).toHaveText(['заперт locked=true', 'шанс 30% chance temporary=30', 'не чаще: 6 ч repetition limit=DR_MEDIUM_6']);
    await expect(head.locator('.dg-cond')).toHaveCount(3);
    await expect(head.locator('.dg-cond').first()).toContainText('если');
    await expect(head.locator('.dg-cond').first()).toContainText('DC_IS_IMPRISONED');

    // ①②: «I owe you» (three conditions) is tried first, the honest answer second; no tie.
    await expect(node(s(8956)).getByTestId('dg-order')).toHaveText('1');
    await expect(node(s(8951)).getByTestId('dg-order')).toHaveText('2');
    await expect(graph.getByTestId('dg-tie')).toHaveCount(0);
    await expect(node(s(8951))).toHaveAttribute('data-kind', 'npc');
    await expect(node(s(8951)).locator('.dg-effect')).toContainText('DA_LOCK_THIS_DIALOG');
    // A player answer: blue, «Игрок» with T_TARGET, no order.
    await expect(node(s(8952))).toHaveAttribute('data-kind', 'player');
    await expect(node(s(8952)).locator('.dg-chip')).toHaveText('Игрок');
    await expect(node(s(8952))).toContainText('T_TARGET');
    await expect(node(s(8952)).getByTestId('dg-order')).toHaveCount(0);
    // «Конечно, пойдём вместе!» goes on to «Веди»: an arrow, no end plate.
    await expect(node(s(8952))).toContainText('пойдём вместе');
    await expect(node(s(8952)).getByTestId('dg-end')).toHaveCount(0);
    await expect(graph.locator(`[data-testid^="rf__edge-${s(8952)}>${s(8954)}#"]`)).toHaveCount(1);
    await expect(node(s(8954))).toContainText('Веди');
    // Line properties at their defaults: no badges.
    await expect(node(s(8954)).getByTestId('dg-badge')).toHaveCount(0);

    // Deep branches are folded at first.
    const folds = graph.getByTestId('dg-fold');
    await expect(folds.first()).toBeVisible();
    await expect(folds.first()).toHaveText(/▸ ещё \d+ (ответ|ответа|ответов)/);
    await page.screenshot({ path: join(shots, '94-dialogue-nodes.png') });

    // «Unfold all»: every line is shown, the player answers without a continuation end the talk.
    await graph.getByTestId('dg-expand-all').click();
    await expect(graph.getByTestId('dg-node')).toHaveCount(24);
    await expect(folds).toHaveCount(0);
    await expect(node(s(8959))).toContainText('Да не за что');
    await expect(node(s(8959)).getByTestId('dg-end')).toHaveText('⏹ конец разговора');
    for (const end of [8988, 8989]) await expect(node(s(end)).getByTestId('dg-end')).toBeVisible();
    await graph.getByRole('button', { name: /Показать всё/ }).click();
    await page.waitForTimeout(400);
    await page.screenshot({ path: join(shots, '95-dialogue-nodes-unfolded.png') });
    await graph.getByTestId('dg-fold-deep').click();
    await expect(folds.first()).toBeVisible();

    // The toolbar above the selected node. The line is opened from «What next» of the dialogue in the
    // right panel: the graph comes back to 100% around it.
    await head.locator('.dg-ln').first().click();
    await page.locator('[data-testid="ln-next-item"][data-sid="' + s(8951) + '"] button.link').click();
    await expect(graph.locator('.react-flow__viewport')).toHaveAttribute('style', /scale\(1\)/);
    await expect(node(s(8951))).toHaveClass(/selected/);
    const tools = node(s(8951)).getByTestId('dg-node-tools');
    await expect(tools).toBeVisible();
    await expect(tools.locator('button')).toHaveText(['+ ответ игрока', '+ реплика NPC', '+ вставка', '+ если', '+ →', '…']);
    await expect(graph.getByTestId('dg-node-tools')).toHaveCount(1);
    await page.screenshot({ path: join(shots, '96-dialogue-node-tools.png') });

    // «FCS codes» off (the setting is turned on in launch()): only the plain words stay.
    await graph.getByTestId('dg-codes').click();
    await expect(graph.getByTestId('dg-codes')).toHaveAttribute('aria-pressed', 'false');
    await expect(head.locator('.dg-code').first()).toBeHidden();
    await expect(head.getByTestId('dg-badge').first()).toHaveText('заперт', { useInnerText: true });
    await page.screenshot({ path: join(shots, '97-dialogue-nodes-no-codes.png') });
    await graph.getByTestId('dg-codes').click();
    await expect(head.locator('.dg-code').first()).toBeVisible();

    // «+ interjection»: a new green line under the NPC line, its text is typed at once.
    await tools.getByTestId('dg-add-inter').click();
    await expect(graph.getByTestId('dg-stats')).toContainText('узлов 25');
    const edit = graph.getByTestId('dg-edit');
    await expect(edit).toBeFocused();
    const added = (await graph.locator('.dg-node.dg-editing').getAttribute('data-id'))!;
    await page.keyboard.type('Эй, я тоже тут!');
    await page.keyboard.press('Enter');
    await expect(node(added)).toHaveAttribute('data-kind', 'inter');
    await expect(node(added)).toContainText('Эй, я тоже тут!');
    await expect(node(added)).toContainText('T_INTERJECTOR1');
    await expect(graph.locator(`[data-testid^="rf__edge-${s(8951)}>${added}#"]`)).toHaveCount(1);
    await page.screenshot({ path: join(shots, '98-dialogue-node-interjection.png') });

    // «…» opens the node menu.
    await node(added).locator('.dg-text').first().click();
    await node(added).getByTestId('dg-more').click();
    await expect(graph.getByTestId('dg-menu')).toHaveAttribute('data-kind', 'node');
    await expect(graph.getByTestId('dg-menu-add-inter')).toBeVisible();
  } finally {
    await closeApp(app);
  }
});
