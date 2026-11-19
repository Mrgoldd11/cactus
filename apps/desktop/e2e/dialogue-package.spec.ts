/**
 * E2E (G1): the «Package» panel on the left of the «Dialogues» layout.
 * - Drifter squad (3951-gamedata.base): 18 busy events, 28 own dialogues, inherits 5 packages,
 *   held by characters through the field `dialogue package`; «All» lists 74 events (EV_NONE and EV_MAX are service values).
 * - The search finds the same event by translation, EV_ code and number.
 * - A click on a dialogue opens its graph; the graph opens at 100% without a minimap; the player opens by «▶ Play».
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

async function events(page: Page): Promise<string[]> {
  return page.getByTestId('pk-event').evaluateAll((els) => els.map((e) => e.getAttribute('data-event') ?? ''));
}

test('package panel: events of Drifter squad, search, dialogue → graph, player by button', async () => {
  const { app, page } = await launch();
  try {
    await app.evaluate(({ BrowserWindow }) => { BrowserWindow.getAllWindows()[0]?.setSize(1500, 950); });
    await expect(page.getByTestId('open-vanilla')).toBeVisible({ timeout: 60_000 });
    await page.getByTestId('open-vanilla').click();
    await expect(page.getByTestId('editor')).toBeVisible({ timeout: 120_000 });
    await page.getByTestId('window-menu').click();
    await page.getByTestId('window-preset-dialogue').click();

    // The layout: the package on the left, the graph in the centre, no player below.
    const panel = page.getByTestId('package-panel');
    await expect(panel).toBeVisible();
    await expect(page.getByTestId('player')).toHaveCount(0);

    // Choose the package in the panel itself.
    await panel.getByTestId('pk-pick').click();
    await page.getByTestId('picker-search').fill(DRIFTER_SQUAD);
    await page.getByTestId('picker-list').locator(`[data-sid="${DRIFTER_SQUAD}"]`).dblclick();
    await expect(panel).toHaveAttribute('data-sid', DRIFTER_SQUAD);
    await expect(panel.getByTestId('pk-pick')).toContainText('Drifter');

    await expect(panel.getByTestId('pk-mode-busy')).toHaveText('Занятые 18');
    await expect(panel.getByTestId('pk-mode-all')).toHaveText('Все 74');
    await expect(panel.getByTestId('pk-stats')).toContainText('28 своих диалогов');
    await expect(panel.getByTestId('pk-inherits')).toContainText('наследует 5 пакетов');
    await expect(panel.getByTestId('pk-holders')).toContainText('персонажи:');
    await expect(panel.getByTestId('pk-holders')).toContainText('dialogue package');
    await expect(panel.getByTestId('pk-event')).toHaveCount(18);
    // Events show their translation next to the code; «+» opens the «New dialogue on event» window (G6).
    const talk = panel.locator('[data-testid="pk-event"][data-event="1"]');
    await expect(talk).toContainText('EV_PLAYER_TALK_TO_ME (1)');
    await expect(talk).toContainText('Игрок заговорил');
    await expect(talk.getByTestId('pk-add')).toBeEnabled();
    await page.screenshot({ path: join(shots, '90-package-panel.png') });

    // Search: translation, code and number find the same event.
    const search = panel.getByTestId('pk-search');
    for (const q of ['вылечил', 'EV_BEING_HEALED_FINISHED', '21']) {
      await search.fill(q);
      expect(await events(page), q).toEqual(['21']);
    }
    await search.fill('вылечил');
    // While searching every found event is open.
    const healed = panel.getByTestId('pk-dialog').first();
    await expect(healed).toBeVisible();
    await page.screenshot({ path: join(shots, '91-package-search.png') });

    // A click on a dialogue opens its graph.
    const dialog = (await healed.getAttribute('data-sid'))!;
    await healed.click();
    const graph = page.locator('[data-panel="graph"]').getByTestId('dialogue-graph');
    await expect(graph).toHaveAttribute('data-sid', dialog, { timeout: 60_000 });
    await expect(healed).toHaveClass(/sel/);
    // 100% zoom, no minimap until asked.
    await expect(graph.locator('.react-flow__viewport')).toHaveAttribute('style', /scale\(1\)/);
    await expect(graph.locator('.react-flow__minimap')).toHaveCount(0);
    await page.screenshot({ path: join(shots, '92-package-graph.png') });

    // «+ inherited»: busy events with the dialogues of inherited packages.
    await search.fill('');
    await panel.getByTestId('pk-mode-inherited').click();
    await expect(panel.getByTestId('pk-event')).toHaveCount(44);
    await panel.getByTestId('pk-event').filter({ has: page.locator('.pk-n .muted') }).first().click();
    await expect(panel.locator('.pk-dl.inherited').first()).toBeVisible();

    // A holder: the graph follows the character, the player opens only by the button and plays it.
    const holder = panel.getByTestId('pk-holder').first();
    const character = (await holder.getAttribute('data-sid'))!;
    await holder.click();
    await expect(page.getByTestId('player')).toHaveCount(0);
    await graph.getByTestId('dg-play').click();
    await expect(page.getByTestId('player')).toHaveAttribute('data-sid', character, { timeout: 60_000 });
    await page.screenshot({ path: join(shots, '93-player-by-button.png') });
  } finally {
    await closeApp(app);
  }
});
