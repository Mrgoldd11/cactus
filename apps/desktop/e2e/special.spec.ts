/**
 * E2E специальных редакторов (этап 5) на ванили настоящей игры (только чтение): правка →
 * отмена → повтор → сохранение во временную папку → `kedit validate` без ошибок.
 * Скриншоты — в `editor/out/screenshots/` (33 и дальше).
 */
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { _electron as electron, expect, test, type ElectronApplication, type Page } from '@playwright/test';
import { readDataFile, type GameRecord } from '@kenshi-editor/core';

const appDir = resolve(import.meta.dirname, '..');
const editorRoot = resolve(appDir, '../..');
const shots = join(editorRoot, 'out', 'screenshots');
mkdirSync(shots, { recursive: true });

const HOLY_NATION = '1083-gamedata.base';
const UNITED_CITIES = 'defaultEmpireFactionSID';

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

async function stubSaveDialog(app: ElectronApplication, path: string): Promise<void> {
  await app.evaluate(({ dialog }, p) => {
    dialog.showSaveDialog = () => Promise.resolve({ canceled: false, filePath: p });
  }, path);
}

async function newMod(page: Page, name: string): Promise<void> {
  await page.getByTestId('new-mod-name').fill(name);
  await page.getByTestId('create-mod').click();
  await expect(page.getByTestId('editor')).toBeVisible({ timeout: 120_000 });
}

async function openPanel(page: Page, id: string): Promise<void> {
  await page.getByTestId('window-menu').click();
  await page.getByTestId(`window-panel-${id}`).click();
}

/** Сохранить мод в `dir/<file>`, проверить `kedit validate`, вернуть записи. */
async function saveAndValidate(app: ElectronApplication, page: Page, out: string): Promise<GameRecord[]> {
  await stubSaveDialog(app, out);
  await page.getByTestId('save').click();
  await expect(page.getByTestId('status-msg')).toContainText('Сохранено');
  const cli = join(editorRoot, 'packages/cli/bin/kedit.js');
  const report = execFileSync(process.execPath, [cli, 'validate', '--mod', out], { cwd: editorRoot, encoding: 'utf8' });
  expect(report).toContain('ошибок 0');
  return readDataFile(readFileSync(out)).records;
}

test('матрица отношений фракций: правка в обе стороны, отмена, сохранение', async () => {
  const { app, page } = await launch();
  const dir = mkdtempSync(join(tmpdir(), 'kedit-special-'));
  try {
    await newMod(page, 'KeditE2E Factions');
    await openPanel(page, 'factions');
    const panel = page.getByTestId('factions-panel');
    await expect(page.getByTestId('fac-matrix')).toBeVisible();
    const cell = (from: string, to: string) => panel.locator(`[data-testid="fac-cell"][data-from="${from}"][data-to="${to}"]`);
    await expect(cell(HOLY_NATION, UNITED_CITIES)).toHaveAttribute('data-value', '-100');
    const back = await cell(UNITED_CITIES, HOLY_NATION).getAttribute('data-value');

    // Фильтр по имени (и по-русски).
    await page.getByTestId('fac-search').fill('нация');
    await expect(cell(HOLY_NATION, HOLY_NATION)).toBeVisible();
    await expect(cell(UNITED_CITIES, UNITED_CITIES)).toHaveCount(0);
    await page.getByTestId('fac-search').fill('');

    await cell(HOLY_NATION, UNITED_CITIES).click();
    await page.getByTestId('fac-value').fill('20');
    await page.getByTestId('fac-both').check();
    await page.getByTestId('fac-set').click();
    await expect(cell(HOLY_NATION, UNITED_CITIES)).toHaveAttribute('data-value', '20');
    await expect(cell(UNITED_CITIES, HOLY_NATION)).toHaveAttribute('data-value', '20');
    await expect(cell(HOLY_NATION, UNITED_CITIES).getByTestId('fac-touched')).toBeVisible();
    await expect(page.getByTestId('save')).toHaveClass(/primary/);
    await page.screenshot({ path: join(shots, '33-factions.png') });

    // Одна отмена — обе стороны назад.
    await page.getByTestId('undo').click();
    await expect(cell(HOLY_NATION, UNITED_CITIES)).toHaveAttribute('data-value', '-100');
    await expect(cell(UNITED_CITIES, HOLY_NATION)).toHaveAttribute('data-value', back!);
    await page.getByTestId('redo').click();
    await expect(cell(UNITED_CITIES, HOLY_NATION)).toHaveAttribute('data-value', '20');

    const recs = await saveAndValidate(app, page, join(dir, 'Factions.mod'));
    expect(recs.map((r) => r.stringId).sort()).toEqual([HOLY_NATION, UNITED_CITIES].sort());
    const hn = recs.find((r) => r.stringId === HOLY_NATION)!;
    expect(hn.refs.get('relations')).toEqual([{ target: UNITED_CITIES, v0: 20, v1: 0, v2: 0 }]);
  } finally {
    await closeApp(app);
    rmSync(dir, { recursive: true, force: true });
  }
});
