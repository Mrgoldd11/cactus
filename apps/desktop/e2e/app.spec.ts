/**
 * E2E: собранное приложение в Electron с настоящей игрой (только чтение). Сохранение — во
 * временную папку и в `editor/out/` (диалоги выбора файла подменяются в main).
 * Скриншоты — в `editor/out/screenshots/`.
 */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { _electron as electron, expect, test, type ElectronApplication, type Page } from '@playwright/test';
import { decodeText, itemTypeName, readDataFile, type GameRecord } from '@kenshi-editor/core';

const appDir = resolve(import.meta.dirname, '..');
const editorRoot = resolve(appDir, '../..');
const outDir = join(editorRoot, 'out');
const shots = join(outDir, 'screenshots');
mkdirSync(shots, { recursive: true });

const KATANA = '476-gamedata.base';
const WEAPON_VENDOR = '2235-gamedata.base';
const CUT = 'cut damage multiplier';

async function launch(): Promise<{ app: ElectronApplication; page: Page }> {
  const userData = mkdtempSync(join(tmpdir(), 'kedit-e2e-'));
  const env: Record<string, string> = { KEDIT_USER_DATA: userData };
  for (const [k, v] of Object.entries(process.env)) if (v !== undefined && k !== 'ELECTRON_RENDERER_URL') env[k] = v;
  const app = await electron.launch({ args: ['.'], cwd: appDir, env });
  const page = await app.firstWindow();
  await page.waitForLoadState('domcontentloaded');
  return { app, page };
}

/** Подменить диалог «Сохранить как» в main: вернуть заданный путь. */
async function stubSaveDialog(app: ElectronApplication, path: string): Promise<void> {
  await app.evaluate(({ dialog }, p) => {
    dialog.showSaveDialog = () => Promise.resolve({ canceled: false, filePath: p });
  }, path);
}

/** Подменить окно подтверждения в main: нажать кнопку `response`, запомнить вызов. */
async function stubMessageBox(app: ElectronApplication, response: number): Promise<void> {
  await app.evaluate(({ dialog }, r) => {
    const g = globalThis as unknown as { messageBoxCalls: number };
    g.messageBoxCalls = 0;
    dialog.showMessageBox = () => {
      g.messageBoxCalls++;
      return Promise.resolve({ response: r, checkboxChecked: false });
    };
  }, response);
}

async function waitEditor(page: Page): Promise<void> {
  await expect(page.getByTestId('editor')).toBeVisible({ timeout: 120_000 });
}

async function selectRecord(page: Page, query: string, sid: string): Promise<void> {
  await page.getByTestId('search').fill(query);
  const row = page.getByTestId('record-list').locator(`[data-sid="${sid}"]`);
  await row.click();
  await expect(page.getByTestId('record-sid')).toHaveText(sid);
}

function fieldRow(page: Page, key: string) {
  return page.getByTestId('fields').locator(`[data-field="${key}"]`);
}

function recordsOf(path: string): GameRecord[] {
  return readDataFile(readFileSync(path)).records;
}

test('ваниль: поиск, правка поля, отмена, сохранение во временную папку', async () => {
  const { app, page } = await launch();
  try {
    await expect(page.getByTestId('open-vanilla')).toBeVisible({ timeout: 60_000 });
    await expect(page.getByTestId('mods-table')).toBeVisible();
    await page.screenshot({ path: join(shots, '01-start.png') });

    await page.getByTestId('open-vanilla').click();
    await waitEditor(page);
    await page.screenshot({ path: join(shots, '02-vanilla.png') });

    // Поиск по-русски тоже работает: «Катана».
    await page.getByTestId('search').fill('катана');
    await expect(page.getByTestId('record-list').locator(`[data-sid="${KATANA}"]`)).toBeVisible();
    await selectRecord(page, 'katana', KATANA);

    await page.getByTestId('field-filter').fill('cut damage');
    const input = page.getByTestId(`field-${CUT}`);
    const original = await input.inputValue();
    await input.fill('1.7');
    await input.press('Enter');
    await expect(fieldRow(page, CUT)).toHaveClass(/fs-changed/);
    await expect(page.getByTestId('record-status')).toContainText('изменена');
    await expect(page.getByTestId('save')).toHaveClass(/primary/);
    await page.screenshot({ path: join(shots, '03-field-changed.png') });

    await page.getByTestId('undo').click();
    await expect(input).toHaveValue(original);
    await expect(fieldRow(page, CUT)).toHaveClass(/fs-base/);
    await expect(page.getByTestId('record-status')).toContainText('ваниль');

    await page.getByTestId('redo').click();
    await expect(input).toHaveValue('1.7');

    const dir = mkdtempSync(join(tmpdir(), 'kedit-save-'));
    const out = join(dir, 'e2e-edit.mod');
    await stubSaveDialog(app, out);
    await page.getByTestId('save').click();
    await expect(page.getByTestId('status-msg')).toContainText('Сохранено');
    await expect(page.getByTestId('save')).not.toHaveClass(/primary/);
    const recs = recordsOf(out);
    expect(recs).toHaveLength(1);
    expect(recs[0]!.stringId).toBe(KATANA);
    expect(recs[0]!.floats.get(CUT)).toBeCloseTo(1.7, 5);

    // Запись в папку игры — только после подтверждения; «Отмена» ничего не пишет.
    const games = await page.evaluate(() => window.kedit.detectGames());
    const kenshi = games[0]!.kenshi;
    const gamePath = join(kenshi, 'mods', '__kedit_e2e_never_written__', 'x.mod');
    await stubMessageBox(app, 1);
    await stubSaveDialog(app, gamePath);
    await page.getByTestId('save-as').click();
    await expect(page.getByTestId('status-msg')).toContainText('отменено');
    expect(await app.evaluate(() => (globalThis as unknown as { messageBoxCalls: number }).messageBoxCalls)).toBe(1);
    expect(existsSync(gamePath)).toBe(false);
    rmSync(dir, { recursive: true, force: true });
  } finally {
    await app.close();
  }
});

test('сценарий: копия катаны, имя и урон, в ассортимент торговца, сохранение в out/', async () => {
  const { app, page } = await launch();
  const modName = 'KeditE2E Trader Katana';
  const out = join(outDir, `${modName}.mod`);
  rmSync(out, { force: true });
  try {
    await page.getByTestId('new-mod-name').fill(modName);
    await page.getByTestId('create-mod').click();
    await waitEditor(page);

    await selectRecord(page, 'katana', KATANA);
    await page.getByTestId('duplicate').click();
    await expect(page.getByTestId('record-status')).toContainText('новая');
    const sid = (await page.getByTestId('record-sid').textContent())!;
    expect(sid).toMatch(new RegExp(`^\\d+-${modName}\\.mod$`));

    const name = page.getByTestId('record-name');
    await name.fill('Tester Katana');
    await name.press('Enter');
    await expect(name).toHaveValue('Tester Katana');

    await page.getByTestId('field-filter').fill('cut damage');
    const cut = page.getByTestId(`field-${CUT}`);
    await cut.fill('1.6');
    await cut.press('Enter');
    await expect(cut).toHaveValue('1.6');
    await page.screenshot({ path: join(shots, '04-new-weapon.png') });

    await selectRecord(page, 'weapon vendor', WEAPON_VENDOR);
    await page.getByTestId('tab-refs').click();
    await page.getByTestId('ref-add-weapons').first().click();
    await expect(page.getByTestId('record-picker')).toBeVisible();
    await page.getByTestId('picker-search').fill('tester katana');
    await expect(page.getByTestId('picker-list').locator(`[data-sid="${sid}"]`)).toBeVisible();
    await page.screenshot({ path: join(shots, '05-picker.png') });
    await page.getByTestId('picker-search').press('Enter');
    await expect(page.getByTestId('record-picker')).toBeHidden();
    const refRow = page.getByTestId('refs').locator(`[data-category="weapons"] [data-target="${sid}"]`);
    await expect(refRow).toHaveClass(/rs-added/);
    await refRow.scrollIntoViewIfNeeded();
    await page.screenshot({ path: join(shots, '06-vendor-refs.png') });

    await page.getByTestId('tab-diff').click();
    await expect(page.getByTestId('diff')).toContainText('Tester Katana');
    await page.screenshot({ path: join(shots, '07-vendor-diff.png') });

    await page.getByTestId('cat-mod').click();
    await page.getByTestId('search').fill('');
    await expect(page.getByTestId('list-count')).toContainText('2');
    await page.screenshot({ path: join(shots, '08-mod-changes.png') });

    await stubSaveDialog(app, out);
    await page.getByTestId('save').click();
    await expect(page.getByTestId('status-msg')).toContainText('Сохранено');

    const recs = recordsOf(out);
    expect(recs).toHaveLength(2);
    const weapon = recs.find((r) => r.stringId === sid)!;
    expect(itemTypeName(weapon.type)).toBe('WEAPON');
    expect(decodeText(weapon.name)).toBe('Tester Katana');
    expect(weapon.floats.get(CUT)).toBeCloseTo(1.6, 5);
    const vendor = recs.find((r) => r.stringId === WEAPON_VENDOR)!;
    expect(vendor.refs.get('weapons')?.some((r) => r.target === sid)).toBe(true);

    await page.getByTestId('lang-en').click();
    await expect(page.getByTestId('save')).toHaveText('Save');
    await page.getByTestId('cat-mod').click();
    await page.getByTestId('record-list').locator(`[data-sid="${sid}"]`).click();
    await page.getByTestId('tab-fields').click();
    await page.getByTestId('field-filter').fill('');
    await page.screenshot({ path: join(shots, '09-english-fields.png') });
    await page.getByTestId('lang-ru').click();
  } finally {
    await app.close();
  }
});
