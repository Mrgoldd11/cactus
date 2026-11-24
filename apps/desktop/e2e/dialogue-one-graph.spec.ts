/**
 * E2E: the dialogue graph is shown once.
 * - In the «Dialogues» layout the central «Dialogue graph» shows the selected dialogue, and the
 *   inspector has no «Graph» tab for it (nor for a line of that dialogue).
 * - The tab comes back when the central graph shows another record (pinned to it) or is closed.
 * - In the «Data» layout, with no central graph, the tab is in place.
 */
import { mkdirSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { _electron as electron, expect, test, type ElectronApplication, type Page } from '@playwright/test';

const appDir = resolve(import.meta.dirname, '..');
const editorRoot = resolve(appDir, '../..');
const shots = join(editorRoot, 'out', 'screenshots', 'ux');
mkdirSync(shots, { recursive: true });

/** «acid rain» — a dialogue of the base game. */
const ACID_RAIN = '55630-rebirth.mod';
/** «Grim talks to new ally»: 5 nodes. */
const GRIM = '61857-Dialogue.mod';

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

function tab(page: Page, title: string | RegExp) {
  return page.locator('.dv-tab', { hasText: title });
}

function groupOfTab(page: Page, title: string | RegExp) {
  return page.locator('.dv-groupview').filter({ has: tab(page, title) });
}

async function pick(page: Page, sid: string): Promise<void> {
  // In the «Dialogues» layout the records are a tab behind «Package» (G1).
  await tab(page, 'Записи').first().click();
  await page.getByTestId('search').fill(sid);
  await page.getByTestId('record-list').locator(`[data-sid="${sid}"]`).click();
}

/** Bring the inspector tab forward and wait until it shows the record. */
async function inspector(page: Page, sid: string): Promise<void> {
  await tab(page, 'Инспектор').first().click();
  await expect(page.getByTestId('record-sid')).toHaveText(sid);
}

test('dialogue graph once: no «Graph» tab in the inspector while the central graph shows the record', async () => {
  const { app, page } = await launch();
  try {
    await app.evaluate(({ BrowserWindow }) => { BrowserWindow.getAllWindows()[0]?.setSize(1400, 900); });
    await expect(page.getByTestId('open-vanilla')).toBeVisible({ timeout: 60_000 });
    await page.getByTestId('open-vanilla').click();
    await expect(page.getByTestId('editor')).toBeVisible({ timeout: 120_000 });

    // «Data» layout: no central graph, the inspector keeps its «Graph» tab.
    await pick(page, ACID_RAIN);
    await expect(page.getByTestId('record-sid')).toHaveText(ACID_RAIN);
    await expect(page.getByTestId('tab-graph')).toHaveCount(1);
    await page.getByTestId('tab-graph').click();
    await expect(page.getByTestId('dialogue-graph')).toHaveCount(1);
    // The user stands on «Graph» and opens the central graph: the inspector falls back to «Fields».
    await page.getByTestId('window-menu').click();
    await page.getByTestId('window-panel-graph').click();
    await expect(page.locator('[data-panel="graph"]').getByTestId('dialogue-graph')).toBeVisible({ timeout: 60_000 });
    await inspector(page, ACID_RAIN);
    await expect(page.getByTestId('tab-graph')).toHaveCount(0);
    await expect(page.getByTestId('fields')).toBeVisible();
    // (the new graph tab shares the center group with the inspector)
    await expect(tab(page, 'Граф диалога')).toHaveCount(1);

    // «Dialogues» layout: the graph is in the center only.
    await page.getByTestId('window-menu').click();
    await page.getByTestId('window-preset-dialogue').click();
    const center = page.locator('[data-panel="graph"]');
    await expect(center.getByTestId('dialogue-graph')).toBeVisible({ timeout: 60_000 });
    await inspector(page, ACID_RAIN);
    await expect(page.getByTestId('tab-graph')).toHaveCount(0);
    await expect(page.getByTestId('fields')).toBeVisible();
    await expect(page.getByTestId('dialogue-graph')).toHaveCount(1);
    await page.screenshot({ path: join(shots, '43-dialogue-layout-after.png') });

    // A line of the shown dialogue: still no second graph.
    const graph = center.getByTestId('dialogue-graph');
    const line = graph.locator('[data-testid="dg-node"]').filter({ hasNot: page.locator(`[data-id="${ACID_RAIN}"]`) }).nth(1);
    const lineSid = (await line.getAttribute('data-id'))!;
    expect(lineSid).not.toBe(ACID_RAIN);
    await line.locator('.dg-text').first().click();
    await inspector(page, lineSid);
    await expect(page.getByTestId('tab-graph')).toHaveCount(0);

    // The central graph pinned to «acid rain», another dialogue selected: the tab comes back.
    await pick(page, ACID_RAIN);
    await groupOfTab(page, 'Граф диалога').getByTestId('panel-pin').click();
    // Pinning opens a second graph tab; the one that follows the selection is closed.
    const following = tab(page, 'Граф диалога');
    await following.hover();
    await following.locator('.dv-default-tab-action').click();
    await expect(following).toHaveCount(0);
    await expect(page.locator('[data-panel="graph"]')).toHaveCount(1);
    await pick(page, GRIM);
    await inspector(page, GRIM);
    await expect(page.getByTestId('tab-graph')).toHaveCount(1);
    // Back to «acid rain»: the pinned graph shows it — no tab.
    await pick(page, ACID_RAIN);
    await inspector(page, ACID_RAIN);
    await expect(page.getByTestId('tab-graph')).toHaveCount(0);

    // The central graph closed: the tab is back.
    await page.getByTestId('window-menu').click();
    await page.getByTestId('window-panel-graph').click();
    await expect(page.locator('[data-panel="graph"]')).toHaveCount(0);
    await inspector(page, ACID_RAIN);
    await expect(page.getByTestId('tab-graph')).toHaveCount(1);
  } finally {
    await closeApp(app);
  }
});
