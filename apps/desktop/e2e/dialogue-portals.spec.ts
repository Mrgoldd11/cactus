/**
 * E2E (G3): transitions between dialogues on «Healed (Recruit)».
 * - 8950-Dialogue.mod (Drifter squad, EV_PLAYER_TALK_TO_ME) is locked; in the package list it shows
 *   «🔒» and «← unlocked by «Healed (Recruit)»» — 8940-D-Dialogue.mod (event 21, also «Healed (Recruit)»).
 * - In the graph of 8950 an entry portal from 8940-D: three thank-you lines, each «takes over» (interrupt);
 *   «I owe you one» unlocks (unlocks), the other two unlock and keep 8940 (unlock but keep me).
 * - A click on the portal opens 8940-D; there an exit portal leads back to 8950, a click opens 8950 again.
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

test('dialogue portals: entry from 8940, «← unlocked by» in the list, a click opens the other dialogue', async () => {
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

    // The package list: 8950 is locked, 8940-D unlocks it.
    const row = panel.locator(`[data-testid="pk-dialog"][data-sid="${HEALED}"]`);
    await expect(row.getByTestId('pk-locked')).toBeVisible();
    await expect(row.getByTestId('pk-unlocked-by')).toContainText('← отпирают');
    await expect(row.getByTestId('pk-unlocked-by')).toContainText('«Healed (Recruit)»');
    await expect(row.locator(`[data-testid="pk-link"][data-sid="${HEALED_FROM}"]`)).toBeVisible();
    await expect(row.getByTestId('pk-nobody-unlocks')).toHaveCount(0);
    await row.click();

    const graph = page.locator('[data-panel="graph"]').getByTestId('dialogue-graph');
    await expect(graph).toHaveAttribute('data-sid', HEALED, { timeout: 60_000 });
    await expect(graph.getByTestId('dg-stats')).toContainText('узлов 24', { timeout: 60_000 });
    await expect(graph.getByTestId('dg-stats')).not.toContainText('читаю перевод');
    await panel.screenshot({ path: join(shots, '104-package-unlocked-by.png') });

    // The entry portal: three lines of 8940-D, all interrupt; one unlocks, two unlock and keep 8940.
    const entry = graph.locator(`[data-testid="dg-portal"][data-dir="in"][data-sid="${HEALED_FROM}"]`);
    await expect(entry).toBeVisible();
    await expect(entry).toContainText('ВХОД');
    await expect(entry).toContainText('из другого диалога');
    await expect(entry.getByTestId('dg-portal-name')).toHaveText('«Healed (Recruit)»');
    await expect(entry).toContainText('EV_BEING_HEALED_FINISHED (21)');
    await expect(entry.getByTestId('dg-portal-line')).toHaveCount(3);
    const kinds = entry.getByTestId('dg-portal-kind');
    await expect(kinds.filter({ hasText: 'перехватывает interrupt' })).toHaveCount(3);
    await expect(kinds.filter({ hasText: /^отпирает unlocks$/ })).toHaveCount(1);
    await expect(kinds.filter({ hasText: 'отпирает, сам остаётся unlock but keep me' })).toHaveCount(2);
    // The arrow from the portal to the dialogue head, with the transition words on it.
    const arrow = graph.locator('.react-flow__edge.dg-edge-portal');
    await expect(arrow).toHaveCount(1);
    // Short label: both unlock kinds read as one «отпирает»; the chips on the portal list them all.
    await expect(arrow).toHaveText('перехватывает · отпирает');
    // No exits: no line of 8950 leads into another dialogue.
    await expect(graph.locator('[data-testid="dg-portal"][data-dir="out"]')).toHaveCount(0);
    await graph.screenshot({ path: join(shots, '105-dialogue-portal-entry.png') });

    // «FCS codes» off: the verbs stay, the codes hide.
    await graph.getByTestId('dg-codes').click();
    await expect(kinds.first().locator('.dg-code')).toBeHidden();
    await graph.getByTestId('dg-codes').click();
    await expect(kinds.first().locator('.dg-code')).toBeVisible();

    // A click on the portal opens 8940-D; it has an exit portal back to 8950.
    await entry.click();
    await expect(graph).toHaveAttribute('data-sid', HEALED_FROM, { timeout: 60_000 });
    const exit = graph.locator(`[data-testid="dg-portal"][data-dir="out"][data-sid="${HEALED}"]`);
    await expect(exit).toBeVisible();
    await expect(exit).toContainText('ВЫХОД');
    await expect(exit).toContainText('в другой диалог');
    await expect(exit).toContainText('EV_PLAYER_TALK_TO_ME (1)');
    await expect(exit.getByTestId('dg-portal-line')).toHaveCount(3);
    // Three lines lead out, three arrows into the exit portal; no entries into 8940-D.
    await expect(graph.locator('.react-flow__edge.dg-edge-portal')).toHaveCount(3);
    await expect(graph.locator('[data-testid="dg-portal"][data-dir="in"]')).toHaveCount(0);
    // The exit portal stands right of the whole graph: «Show all» brings it into view.
    await graph.getByRole('button', { name: /Показать всё/ }).click();
    await expect(exit).toBeInViewport();
    await graph.screenshot({ path: join(shots, '106-dialogue-portal-exit.png') });

    // In the list 8940-D (event 21) says what it unlocks.
    await panel.getByTestId('pk-search').fill('EV_BEING_HEALED_FINISHED');
    const fromRow = panel.locator(`[data-testid="pk-dialog"][data-sid="${HEALED_FROM}"]`);
    await expect(fromRow.getByTestId('pk-unlocks')).toContainText('→ отпирает');
    await expect(fromRow.locator(`[data-testid="pk-link"][data-sid="${HEALED}"]`)).toBeVisible();
    await expect(fromRow.getByTestId('pk-locked')).toHaveCount(0);

    // The exit portal opens 8950 again.
    await exit.click();
    await expect(graph).toHaveAttribute('data-sid', HEALED, { timeout: 60_000 });
    await expect(entry).toBeVisible();
  } finally {
    await closeApp(app);
  }
});
