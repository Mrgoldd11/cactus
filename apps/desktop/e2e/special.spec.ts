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

test('сравнение предметов: сортировка, столбцы, правка в ячейке, отмена, сохранение', async () => {
  const { app, page } = await launch();
  const dir = mkdtempSync(join(tmpdir(), 'kedit-special-'));
  const KATANA = '476-gamedata.base';
  const CUT = 'cut damage multiplier';
  try {
    await newMod(page, 'KeditE2E Compare');
    await openPanel(page, 'compare');
    const panel = page.getByTestId('compare-panel');
    await expect(page.getByTestId('cmp-table')).toBeVisible();
    const cell = (sid: string, key: string) => panel.locator(`[data-testid="cmp-cell"][data-sid="${sid}"][data-field="${key}"]`);
    const original = (await cell(KATANA, CUT).getAttribute('data-value'))!;

    // Сортировка по убыванию: первая строка — наибольшее значение (▲).
    await panel.locator(`[data-testid="cmp-head"][data-field="${CUT}"]`).click();
    await panel.locator(`[data-testid="cmp-head"][data-field="${CUT}"]`).click();
    await expect(panel.locator('tbody tr').first().locator(`[data-field="${CUT}"]`)).toHaveClass(/cmp-max/);

    // Выбор столбцов.
    await page.getByTestId('cmp-columns').click();
    await page.getByTestId('cmp-col-weight mult').check();
    await expect(panel.locator('[data-testid="cmp-head"][data-field="weight mult"]')).toBeVisible();

    // Фильтр по полю и правка в ячейке.
    await page.getByTestId('cmp-filter').fill(`${CUT}>0`);
    await page.getByTestId('cmp-search').fill('katana');
    await cell(KATANA, CUT).click();
    await page.getByTestId('cmp-input').fill('1.9');
    await page.getByTestId('cmp-input').press('Enter');
    await expect(cell(KATANA, CUT)).toHaveAttribute('data-value', '1.9');
    await expect(cell(KATANA, CUT)).toHaveClass(/cmp-mine/);
    await page.screenshot({ path: join(shots, '34-compare.png') });

    await page.getByTestId('undo').click();
    await expect(cell(KATANA, CUT)).toHaveAttribute('data-value', original);
    await expect(cell(KATANA, CUT)).not.toHaveClass(/cmp-mine/);
    await page.getByTestId('redo').click();
    await expect(cell(KATANA, CUT)).toHaveAttribute('data-value', '1.9');

    const recs = await saveAndValidate(app, page, join(dir, 'Compare.mod'));
    expect(recs).toHaveLength(1);
    expect(recs[0]!.floats.get(CUT)).toBeCloseTo(1.9, 5);
  } finally {
    await closeApp(app);
    rmSync(dir, { recursive: true, force: true });
  }
});

test('массовые правки: предпросмотр, применение одной отменой, замена имени, сохранение', async () => {
  const { app, page } = await launch();
  const dir = mkdtempSync(join(tmpdir(), 'kedit-special-'));
  const KATANA = '476-gamedata.base';
  try {
    await newMod(page, 'KeditE2E Bulk');
    await openPanel(page, 'bulk');
    const panel = page.getByTestId('bulk-panel');
    await page.getByTestId('bulk-type').selectOption('WEAPON');
    await page.getByTestId('bulk-filter').fill('value>=300');
    await page.getByTestId('bulk-op').selectOption('mul');
    await page.getByTestId('bulk-field').fill('value');
    await page.getByTestId('bulk-value').fill('2');
    const katana = panel.locator(`[data-testid="bulk-row"][data-sid="${KATANA}"]`);
    await expect(katana).toHaveAttribute('data-before', '500');
    await expect(katana).toHaveAttribute('data-after', '1000');
    const rows = await panel.getByTestId('bulk-row').count();
    expect(rows).toBeGreaterThan(5);
    await expect(page.getByTestId('bulk-summary')).toContainText(`изменится ${rows}`);
    // Предпросмотр ничего не меняет.
    await expect(page.getByTestId('save')).not.toHaveClass(/primary/);
    await page.screenshot({ path: join(shots, '35-bulk.png') });

    await page.getByTestId('bulk-apply').click();
    await expect(page.getByTestId('save')).toHaveClass(/primary/);
    // После применения при тех же условиях — 1000 → 2000 (данные уже новые).
    await expect(katana).toHaveAttribute('data-before', '1000');

    // Одна отмена — вся пачка назад.
    await page.getByTestId('undo').click();
    await expect(katana).toHaveAttribute('data-before', '500');
    await page.getByTestId('redo').click();
    await expect(katana).toHaveAttribute('data-before', '1000');

    // Неверный regex — понятная ошибка, кнопка выключена.
    await page.getByTestId('bulk-op').selectOption('replace');
    await page.getByTestId('bulk-field').fill('name');
    await page.getByTestId('bulk-regex').check();
    await page.getByTestId('bulk-find').fill('(');
    await expect(page.getByTestId('bulk-error')).toBeVisible();
    await expect(page.getByTestId('bulk-apply')).toBeDisabled();

    const recs = await saveAndValidate(app, page, join(dir, 'Bulk.mod'));
    expect(recs).toHaveLength(rows);
    const k = recs.find((r) => r.stringId === KATANA)!;
    expect([...k.ints]).toEqual([['value', 1000]]);
  } finally {
    await closeApp(app);
    rmSync(dir, { recursive: true, force: true });
  }
});
