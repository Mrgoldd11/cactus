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
    // Шапка списка записей не съезжает: заголовок «id» над id первой строки (полоса прокрутки учтена).
    const headId = await page.locator('.list-header span').nth(2).boundingBox();
    const rowId = await page.locator('.list-row .sid').first().boundingBox();
    expect(Math.abs(headId!.x - rowId!.x)).toBeLessThanOrEqual(1);
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

    // Пара — вводом названий (рус.) с быстрым списком, без клика по таблице.
    await page.getByTestId('fac-value').press('Escape');
    await expect(page.getByTestId('fac-set')).toBeDisabled();
    await page.getByTestId('fac-from').fill('святая');
    await page.getByTestId('fac-from-list').getByRole('option').first().click();
    await expect(page.getByTestId('fac-from')).toHaveValue(/Святая Нация/);
    await page.getByTestId('fac-to').fill('союзн');
    await page.getByTestId('fac-to').press('Enter');
    await expect(page.getByTestId('fac-to')).toHaveValue(/Союзные Города/);
    await expect(page.getByTestId('fac-value')).toHaveValue('20');
    await expect(cell(HOLY_NATION, UNITED_CITIES)).toHaveClass(/fac-sel/);

    // Справка «?»: при наведении — таблица «значение → что значит».
    await expect(panel.locator('.fac-help-pop')).toBeHidden();
    await page.getByTestId('fac-help').getByRole('button').hover();
    await expect(panel.locator('.fac-help-pop')).toBeVisible();
    await expect(panel.locator('.fac-help-pop tbody tr')).toHaveCount(6);
    await page.screenshot({ path: join(shots, '33b-factions-help.png') });
    await page.mouse.move(0, 0);

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
    await page.getByTestId('bulk-field').selectOption('value');
    // Пока значение не введено — объяснение, чего не хватает, и сколько записей подходит.
    await expect(page.getByTestId('bulk-need-what')).toContainText('Заполните «Значение»');
    await expect(page.getByTestId('bulk-need')).toContainText('подходит записей');
    await expect(page.getByTestId('bulk-help')).toBeVisible();
    // Поиск по русскому имени работает, и подходящие записи видны ещё до ввода значения.
    await page.getByTestId('bulk-search').fill('катана');
    await expect(page.getByTestId('bulk-sample')).toBeVisible();
    await page.getByTestId('bulk-search').fill('');
    // Пример одним кликом заполняет форму: катаны × 2 по cut damage multiplier.
    await page.getByTestId('bulk-examples').getByRole('button').first().click();
    await expect(page.getByTestId('bulk-filter')).toHaveValue('skill category=0');
    await expect(page.getByTestId('bulk-row').first()).toBeVisible();
    await page.screenshot({ path: join(shots, '35c-bulk-example.png') });
    // Конструктор условия: поле из списка → сравнение → значение из списка → в фильтр.
    await page.getByTestId('bulk-filter').fill('');
    await page.getByTestId('bulk-cond-field').selectOption('skill category');
    await page.getByTestId('bulk-cond-value').selectOption('0');
    await page.getByTestId('bulk-cond-add').click();
    await expect(page.getByTestId('bulk-filter')).toHaveValue('skill category=0');
    await expect(page.getByTestId('bulk-sentence')).toContainText('Изменится');
    await page.screenshot({ path: join(shots, '35d-bulk-builder.png') });
    await page.getByTestId('bulk-filter').fill('value>=300');
    await page.getByTestId('bulk-field').selectOption('value');
    await page.getByTestId('bulk-value').fill('');
    await page.getByTestId('bulk-filter-help').getByRole('button').hover();
    await expect(page.getByTestId('bulk-filter-help').getByRole('tooltip')).toBeVisible();
    await page.screenshot({ path: join(shots, '35b-bulk-filter-help.png') });
    await page.getByTestId('bulk-help').getByRole('button').hover();
    await page.screenshot({ path: join(shots, '35a-bulk-help.png') });
    await page.getByTestId('bulk-type').hover();
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
    await page.getByTestId('bulk-field').selectOption('name');
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

test('массовые правки: галочки строк, сортировка, ссылки в списках, новые операторы', async () => {
  const { app, page } = await launch();
  const dir = mkdtempSync(join(tmpdir(), 'kedit-special-'));
  const KATANA = '476-gamedata.base';
  try {
    await newMod(page, 'KeditE2E Bulk2');
    await openPanel(page, 'bulk');
    const panel = page.getByTestId('bulk-panel');
    await page.getByTestId('bulk-type').selectOption('WEAPON');
    await page.getByTestId('bulk-filter').fill('value>=300');
    await page.getByTestId('bulk-field').selectOption('value');
    // До ввода значения таблица подходящих записей уже с колонкой цены и сортировкой по клику.
    await expect(page.getByTestId('bulk-sample')).toBeVisible();
    await page.getByTestId('bulk-sort-value').click();
    const first = panel.getByTestId('bulk-sample-row').first();
    const last = panel.getByTestId('bulk-sample-row').last();
    const num = async (loc: typeof first): Promise<number> => Number((await loc.locator('td').nth(1).innerText()).replace(/\s/g, ''));
    expect(await num(first)).toBeLessThanOrEqual(await num(last));
    await page.getByTestId('bulk-sort-value').click();
    expect(await num(first)).toBeGreaterThanOrEqual(await num(last));
    await page.screenshot({ path: join(shots, '35e-bulk-sample-columns.png') });

    // Галочки: снимаем катану — она не попадёт в применение.
    await page.getByTestId('bulk-op').selectOption('mul');
    await page.getByTestId('bulk-value').fill('2');
    const rows = await panel.getByTestId('bulk-row').count();
    expect(rows).toBeGreaterThan(5);
    await expect(page.getByTestId('bulk-chosen')).toContainText(`${rows} из ${rows}`);
    const katanaRow = panel.locator(`[data-testid="bulk-row"][data-sid="${KATANA}"]`);
    await katanaRow.getByTestId('bulk-pick').uncheck();
    await expect(page.getByTestId('bulk-chosen')).toContainText(`${rows - 1} из ${rows}`);
    await expect(page.getByTestId('bulk-apply')).toContainText(String(rows - 1));
    await page.screenshot({ path: join(shots, '35f-bulk-unticked.png') });
    // Сортировка по «станет»: первая строка не больше последней.
    await page.getByTestId('bulk-sort-after').click();
    const a1 = Number(await panel.getByTestId('bulk-row').first().getAttribute('data-after'));
    const a2 = Number(await panel.getByTestId('bulk-row').last().getAttribute('data-after'));
    expect(a1).toBeLessThanOrEqual(a2);
    // Выбрать все / снять все.
    await page.getByTestId('bulk-pick-all').click();
    await expect(page.getByTestId('bulk-chosen')).toContainText(`0 из ${rows}`);
    await expect(page.getByTestId('bulk-apply')).toBeDisabled();
    await page.getByTestId('bulk-pick-all').click();
    await expect(page.getByTestId('bulk-chosen')).toContainText(`${rows} из ${rows}`);
    await katanaRow.getByTestId('bulk-pick').uncheck();
    await page.getByTestId('bulk-apply').click();
    await expect(page.getByTestId('save')).toHaveClass(/primary/);

    // Ссылки: «продавать катану в каждом магазине».
    await page.getByTestId('bulk-type').selectOption('VENDOR_LIST');
    await page.getByTestId('bulk-filter').fill('');
    await page.getByTestId('bulk-op').selectOption('refAdd');
    await page.getByTestId('bulk-field').selectOption('weapons');
    await page.getByTestId('bulk-value').fill(KATANA);
    await expect(page.getByTestId('bulk-sentence')).toContainText('Добавлю ссылку');
    await expect(page.getByTestId('bulk-ref-values')).toBeVisible();
    const shops = await panel.getByTestId('bulk-row').count();
    expect(shops).toBeGreaterThan(5);
    await page.screenshot({ path: join(shots, '35g-bulk-refs.png') });
    await page.getByTestId('bulk-apply').click();
    // Повторно ничего не добавится: ссылка уже есть.
    await expect(page.getByTestId('bulk-row')).toHaveCount(0);
    // Убрать ссылку тем же способом: те же магазины.
    await page.getByTestId('bulk-op').selectOption('refRemove');
    await page.getByTestId('bulk-field').selectOption('weapons');
    await expect(panel.getByTestId('bulk-row').first()).toBeVisible();
    expect(await panel.getByTestId('bulk-row').count()).toBeGreaterThanOrEqual(shops);
    await page.getByTestId('bulk-op').selectOption('refAdd');
    await page.getByTestId('bulk-field').selectOption('weapons');

    // Конструктор: Ref (входящие ссылки) и новые операторы.
    await page.getByTestId('bulk-type').selectOption('WEAPON');
    await page.getByTestId('bulk-cond-field').selectOption('Ref');
    await page.getByTestId('bulk-cond-op').selectOption('>');
    await page.getByTestId('bulk-cond-value').fill('0');
    await page.getByTestId('bulk-cond-add').click();
    await expect(page.getByTestId('bulk-filter')).toHaveValue('Ref>0');
    await page.getByTestId('bulk-filter').fill('name?^kat; description!:zzzzqq');
    await page.getByTestId('bulk-op').selectOption('set');
    await page.getByTestId('bulk-field').selectOption('value');
    await page.getByTestId('bulk-value').fill('1');
    await expect(page.getByTestId('bulk-error')).toHaveCount(0);
    await expect(page.getByTestId('bulk-summary')).toBeVisible();

    const recs = await saveAndValidate(app, page, join(dir, 'Bulk2.mod'));
    expect(recs.some((r) => r.stringId === KATANA)).toBe(false);
    const sold = recs.filter((r) => (r.refs.get('weapons') ?? []).some((x) => x.target === KATANA));
    expect(sold).toHaveLength(shops);
    expect(recs).toHaveLength(rows - 1 + shops);
  } finally {
    await closeApp(app);
    rmSync(dir, { recursive: true, force: true });
  }
});

test('графы: исследования, крафт, состав города; правка числа в ссылке, отмена, сохранение', async () => {
  const { app, page } = await launch();
  const dir = mkdtempSync(join(tmpdir(), 'kedit-special-'));
  const BARK = '1076-gamedata.base';
  const ARMOR_SHOP = '1177-gamedata.base';
  try {
    await newMod(page, 'KeditE2E Graphs');
    await openPanel(page, 'graphs');
    const panel = page.getByTestId('graphs-panel');
    const canvas = page.getByTestId('graph-canvas');

    // Исследования: все узлы, требования — связи, поиск подсвечивает.
    expect(Number(await canvas.getAttribute('data-nodes'))).toBeGreaterThan(100);
    expect(Number(await canvas.getAttribute('data-links'))).toBeGreaterThan(50);
    await page.getByTestId('graphs-search').fill('wall');
    await expect(page.getByTestId('graphs-found')).not.toContainText(/: 0$/);
    await page.getByTestId('graphs-category').selectOption('Defence');
    const defence = Number(await canvas.getAttribute('data-nodes'));
    expect(defence).toBeGreaterThan(3);
    expect(defence).toBeLessThan(100);
    await page.screenshot({ path: join(shots, '36-graphs.png') });

    // Крафт: станок → вещи → из чего.
    await page.getByTestId('graphs-mode').selectOption('craft');
    await page.getByTestId('graphs-focus').selectOption('2929-gamedata.base');
    expect(Number(await canvas.getAttribute('data-nodes'))).toBeGreaterThan(50);
    await expect(panel.locator('[data-testid="graph-node"][data-kind="station"]')).toHaveCount(1);

    // Состав города: Bark → отряды (свои и от фракции) → люди.
    await page.getByTestId('graphs-mode').selectOption('squads');
    await page.getByTestId('graphs-kind').selectOption('TOWN');
    await page.getByTestId('graphs-search').fill(BARK);
    await page.getByTestId('graphs-focus').selectOption(BARK);
    expect(Number(await canvas.getAttribute('data-nodes'))).toBeGreaterThan(15);
    await panel.locator(`[data-testid="graph-node"][data-sid="${ARMOR_SHOP}"]`).click();
    await expect(page.getByTestId('graphs-picked')).toBeVisible();
    await expect(page.getByTestId('graphs-where')).toBeEnabled();
    const link = panel.locator('[data-testid="graph-link"][data-category="residents"]');
    await expect(link.getByTestId('graph-link-v0')).toHaveValue('1');
    await link.getByTestId('graph-link-v0').fill('2');
    await link.getByTestId('graph-link-apply').click();
    await expect(page.getByTestId('save')).toHaveClass(/primary/);
    await expect(link.getByTestId('graph-link-v0')).toHaveValue('2');

    await page.getByTestId('undo').click();
    await expect(link.getByTestId('graph-link-v0')).toHaveValue('1');
    await page.getByTestId('redo').click();
    await expect(link.getByTestId('graph-link-v0')).toHaveValue('2');

    const recs = await saveAndValidate(app, page, join(dir, 'Graphs.mod'));
    expect(recs.map((r) => r.stringId)).toEqual([BARK]);
    expect([...recs[0]!.refs.keys()]).toEqual(['residents']);
    expect(recs[0]!.refs.get('residents')!.find((r) => r.target === ARMOR_SHOP)).toMatchObject({ v0: 2, v1: 3 });
  } finally {
    await closeApp(app);
    rmSync(dir, { recursive: true, force: true });
  }
});

test('перепись NPC: группы с весом, фильтры, пакет диалогов выбранным, отмена, проигрыватель, сохранение', async () => {
  const { app, page } = await launch();
  const dir = mkdtempSync(join(tmpdir(), 'kedit-special-'));
  const PACKAGE = '5463-gamedata.base';
  try {
    await newMod(page, 'KeditE2E Census');
    await openPanel(page, 'census');
    const panel = page.getByTestId('census-panel');
    await expect(page.getByTestId('census-table')).toBeVisible({ timeout: 30_000 });
    const all = Number(await page.getByTestId('census-summary').getAttribute('data-rows'));
    expect(all).toBeGreaterThan(300);

    // Группы по фракциям отсортированы по весу; Объединённые города — среди них.
    const weights = await panel.locator('[data-testid="census-group"][data-weight]').evaluateAll((els) => els.map((e) => Number(e.getAttribute('data-weight'))));
    expect(weights.length).toBeGreaterThan(20);
    expect([...weights].sort((a, b) => b - a)).toEqual(weights);
    await panel.locator(`[data-testid="census-group"][data-key="${UNITED_CITIES}"]`).click();
    const inFaction = Number(await page.getByTestId('census-summary').getAttribute('data-rows'));
    expect(inFaction).toBeGreaterThan(10);
    expect(inFaction).toBeLessThan(all);

    // Шаблоны без пакета диалогов.
    await page.getByTestId('census-filter').selectOption('nopkg');
    const rows = panel.getByTestId('census-row');
    await expect(rows.first()).toHaveAttribute('data-packages', '0');
    const sids = [await rows.nth(0).getAttribute('data-sid'), await rows.nth(1).getAttribute('data-sid')] as string[];
    await rows.nth(0).getByTestId('census-pick').check();
    await rows.nth(1).getByTestId('census-pick').check();
    await expect(page.getByTestId('census-selected')).toContainText('2');
    await page.screenshot({ path: join(shots, '37-census.png') });

    await page.getByTestId('census-package').selectOption(PACKAGE);
    await page.getByTestId('census-give').click();
    await expect(page.getByTestId('save')).toHaveClass(/primary/);
    await page.getByTestId('census-filter').selectOption('inmod');
    await expect(rows).toHaveCount(2);
    await expect(rows.first()).toHaveAttribute('data-status', 'changed');
    await expect(rows.first()).toHaveAttribute('data-packages', '1');

    await page.getByTestId('undo').click();
    await expect(rows).toHaveCount(0);
    await page.getByTestId('redo').click();
    await expect(rows).toHaveCount(2);

    // Переход в проигрыватель разговора.
    await rows.first().getByTestId('census-player').click();
    await expect(page.locator('[data-testid="player"]').first()).toBeVisible();

    const recs = await saveAndValidate(app, page, join(dir, 'Census.mod'));
    expect(recs.map((r) => r.stringId).sort()).toEqual([...sids].sort());
    for (const r of recs) {
      expect([...r.refs.keys()]).toEqual(['dialogue package']);
      expect(r.refs.get('dialogue package')!.map((x) => x.target)).toEqual([PACKAGE]);
    }
  } finally {
    await closeApp(app);
    rmSync(dir, { recursive: true, force: true });
  }
});
