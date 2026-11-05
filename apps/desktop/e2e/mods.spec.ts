/**
 * E2E этапа 4 (существующие моды) на временной «папке игры»: ванильные файлы — жёсткие
 * ссылки на файлы настоящей игры (только чтение, место не тратится), два своих мода
 * (один в `mods/`, другой в «мастерской»), свой `mods.cfg`. Настоящий `mods.cfg` и папки
 * игры не трогаются: приложению передаётся KENSHI_DIR / KENSHI_WORKSHOP_DIR.
 */
import { copyFileSync, existsSync, linkSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { _electron as electron, expect, test, type ElectronApplication, type Page } from '@playwright/test';
import { emptyRecord, encodeText, FileType, itemTypeId, joinModList, writeDataFile, type DataFile, type GameRecord } from '@kenshi-editor/core';
import { resolveGamePaths } from '@kenshi-editor/core/node';

const appDir = resolve(import.meta.dirname, '..');
const editorRoot = resolve(appDir, '../..');
const outDir = join(editorRoot, 'out');
const shots = join(outDir, 'screenshots');
mkdirSync(shots, { recursive: true });

const KATANA = '476-gamedata.base';
const CUT = 'cut damage multiplier';
const WEAPON = itemTypeId('WEAPON')!;

interface FakeGame {
  kenshi: string;
  workshop: string;
  cfg: string;
}

/** Файлы игры, которые нужны редактору: ваниль, схема, перевод. */
const GAME_FILES = [
  'data/gamedata.base',
  'data/Newwworld.mod',
  'data/Dialogue.mod',
  'data/rebirth.mod',
  'fcs.def',
  'fcs_enums.def',
  'fcs_layout.def',
  'locale/ru_RU/gamedata.po',
  'locale/ru_RU/ru_RU.translation',
];

function modFile(records: GameRecord[], deps: string[] = []): Uint8Array {
  const f: DataFile = {
    fileType: FileType.Mod,
    header: { version: 1, author: encodeText('e2e'), description: encodeText(''), dependencies: joinModList(deps), references: encodeText('') },
    lastId: 0,
    records,
    tail: new Uint8Array(),
  };
  return writeDataFile(f);
}

/** Катана с другим уроном: «изменённая» запись мода. */
function katana(cut: number, extra: (r: GameRecord) => void = () => undefined): GameRecord {
  const r = emptyRecord(WEAPON, KATANA, encodeText('Katana'));
  r.changeFlags = 0x80000001;
  r.floats.set(CUT, cut);
  extra(r);
  return r;
}

function makeGame(): FakeGame {
  const real = resolveGamePaths(editorRoot);
  // На том же диске, что игра: жёсткие ссылки работают только в пределах одного тома.
  const base = join(outDir, 'tmp-game');
  mkdirSync(base, { recursive: true });
  const root = mkdtempSync(join(base, 'g-'));
  const kenshi = join(root, 'steamapps', 'common', 'Kenshi');
  const workshop = join(root, 'steamapps', 'workshop', 'content', '233860');
  for (const rel of GAME_FILES) {
    const from = join(real.kenshi, rel);
    if (!existsSync(from)) continue;
    const to = join(kenshi, rel);
    mkdirSync(dirname(to), { recursive: true });
    try {
      linkSync(from, to);
    } catch {
      copyFileSync(from, to);
    }
  }
  const put = (path: string, bytes: Uint8Array): void => {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, bytes);
  };
  put(join(kenshi, 'mods', 'Sharp Katana', 'Sharp Katana.mod'), modFile([katana(1.5)]));
  put(
    join(workshop, '900001', 'Katana Rebalance.mod'),
    modFile([
      katana(2, (r) => {
        r.floats.set('weight mult', 0.8);
      }),
    ]),
  );
  // Свой mods.cfg — обычный файл (не ссылка на настоящий).
  const cfg = join(kenshi, 'data', 'mods.cfg');
  writeFileSync(cfg, 'Sharp Katana.mod\r\nKatana Rebalance.mod\r\n');
  return { kenshi, workshop, cfg };
}

async function launch(game: FakeGame): Promise<{ app: ElectronApplication; page: Page }> {
  const userData = mkdtempSync(join(tmpdir(), 'kedit-e2e-'));
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) if (v !== undefined && k !== 'ELECTRON_RENDERER_URL') env[k] = v;
  env['KEDIT_USER_DATA'] = userData;
  env['KEDIT_LIVE_FILE'] = join(userData, 'live.json');
  env['KENSHI_DIR'] = game.kenshi;
  env['KENSHI_WORKSHOP_DIR'] = game.workshop;
  // Папка игры временная: проверка «игра закрыта» перед записью mods.cfg не нужна.
  env['KEDIT_SKIP_GAME_CHECK'] = '1';
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

/** Подменить окно подтверждения в main: нажать кнопку `response`, запомнить вызовы. */
async function stubMessageBox(app: ElectronApplication, response: number): Promise<void> {
  await app.evaluate(({ dialog }, r) => {
    const g = globalThis as unknown as { boxCalls: number; boxDetail?: string };
    g.boxCalls = 0;
    dialog.showMessageBox = (...args: unknown[]) => {
      g.boxCalls++;
      g.boxDetail = (args.at(-1) as { detail?: string }).detail;
      return Promise.resolve({ response: r, checkboxChecked: false });
    };
  }, response);
}

async function messageBox(app: ElectronApplication): Promise<{ calls: number; detail?: string }> {
  return app.evaluate(() => {
    const g = globalThis as unknown as { boxCalls: number; boxDetail?: string };
    return { calls: g.boxCalls, ...(g.boxDetail !== undefined ? { detail: g.boxDetail } : {}) };
  });
}

async function openPanel(page: Page, id: string): Promise<void> {
  await page.getByTestId('window-menu').click();
  await page.getByTestId(`window-panel-${id}`).click();
}

async function selectRecord(page: Page, query: string, sid: string): Promise<void> {
  await page.getByTestId('search').fill(query);
  await page.getByTestId('record-list').locator(`[data-sid="${sid}"]`).click();
  await expect(page.getByTestId('record-sid')).toHaveText(sid);
}

test('моды слоями: панель «Моды», два мода под ванилью, побеждает поздний', async () => {
  const game = makeGame();
  const { app, page } = await launch(game);
  try {
    await expect(page.getByTestId('open-vanilla')).toBeVisible({ timeout: 60_000 });
    await page.getByTestId('open-vanilla').click();
    await expect(page.getByTestId('editor')).toBeVisible({ timeout: 120_000 });

    await openPanel(page, 'mods');
    const table = page.getByTestId('mods-panel-table');
    await expect(table).toContainText('Sharp Katana.mod');
    await expect(table).toContainText('Katana Rebalance.mod');
    await expect(table).toContainText('900001');

    await page.getByTestId('mods-all-enabled').click();
    await expect(page.getByTestId('ctx-Sharp Katana.mod')).toBeChecked();
    await expect(page.getByTestId('ctx-Katana Rebalance.mod')).toBeChecked();
    await page.getByTestId('mods-apply').click();
    await expect(page.getByTestId('mods-panel')).toContainText('других модов 2', { timeout: 60_000 });
    await page.screenshot({ path: join(shots, '28-mods-panel.png') });

    // Катана: Katana Rebalance ниже в mods.cfg — его урон.
    await page.locator('.dv-tab', { hasText: 'Инспектор' }).click();
    await selectRecord(page, 'katana', KATANA);
    await page.getByTestId('field-filter').fill('cut damage');
    await expect(page.getByTestId(`field-${CUT}`)).toHaveValue('2');
    // Инспектор: кто ещё меняет запись и сколько полей в конфликте.
    await expect(page.getByTestId('record-others')).toContainText('Sharp Katana.mod, Katana Rebalance.mod');
    await expect(page.getByTestId('record-conflicts')).toContainText('полей в конфликте: 1');

    // Панель «Конфликты»: урон катаны, победит Katana Rebalance (ниже в mods.cfg).
    await openPanel(page, 'conflicts');
    const row = page.getByTestId('conflicts-table').locator(`tr[data-sid="${KATANA}"][data-field="floats:${CUT}"]`);
    await expect(row).toBeVisible();
    await expect(row.getByTestId('conflict-winner')).toHaveText('Katana Rebalance.mod');
    await expect(row).toContainText('1.5 — Sharp Katana.mod');
    await expect(row).toContainText('2 — Katana Rebalance.mod');
    // weight mult меняет только один мод — не конфликт.
    await expect(page.getByTestId('conflicts-table').locator('tr[data-field="floats:weight mult"]')).toHaveCount(0);
    await page.screenshot({ path: join(shots, '29-conflicts.png') });

    // mods.cfg пока не менялся.
    expect(readFileSync(game.cfg, 'utf-8')).toBe('Sharp Katana.mod\r\nKatana Rebalance.mod\r\n');

    // Порядок загрузки: перетащить Katana Rebalance выше Sharp Katana (черновик).
    await page.locator('.dv-tab', { hasText: 'Моды' }).click();
    await expect(page.getByTestId('order-Katana Rebalance.mod')).toContainText('2');
    await page.getByTestId('mod-row-Katana Rebalance.mod').dragTo(page.getByTestId('mod-row-Sharp Katana.mod'));
    await expect(page.getByTestId('order-Katana Rebalance.mod')).toContainText('1');
    await expect(page.getByTestId('order-Sharp Katana.mod')).toContainText('2');
    await expect(page.getByTestId('mods-order-changed')).toContainText('модов 2');
    await page.screenshot({ path: join(shots, '30-load-order.png') });

    // «Отмена» в окне подтверждения — файл не трогается.
    await stubMessageBox(app, 1);
    await page.getByTestId('mods-order-save').click();
    await expect.poll(async () => (await messageBox(app)).calls).toBe(1);
    expect(readFileSync(game.cfg, 'utf-8')).toBe('Sharp Katana.mod\r\nKatana Rebalance.mod\r\n');
    await expect(page.getByTestId('mods-order-save')).toBeEnabled();

    // «Записать»: mods.cfg с CRLF, копия рядом, слои пересобраны — теперь побеждает Sharp Katana.
    await stubMessageBox(app, 0);
    await page.getByTestId('mods-order-save').click();
    await expect(page.getByTestId('mods-order-msg')).toContainText('mods.cfg записан', { timeout: 60_000 });
    const box = await messageBox(app);
    expect(box.detail).toContain('mods.cfg');
    expect(box.detail).toContain('Katana Rebalance.mod: место 2 → 1');
    expect(readFileSync(game.cfg, 'utf-8')).toBe('Katana Rebalance.mod\r\nSharp Katana.mod\r\n');
    const backups = readdirSync(dirname(game.cfg)).filter((f) => f.startsWith('mods.cfg.bak-'));
    expect(backups).toHaveLength(1);
    expect(readFileSync(join(dirname(game.cfg), backups[0]!), 'utf-8')).toBe('Sharp Katana.mod\r\nKatana Rebalance.mod\r\n');
    await expect(page.getByTestId('mods-order-changed')).toHaveCount(0);

    await page.locator('.dv-tab', { hasText: 'Конфликты' }).click();
    const row2 = page.getByTestId('conflicts-table').locator(`tr[data-sid="${KATANA}"][data-field="floats:${CUT}"]`);
    await expect(row2.getByTestId('conflict-winner')).toHaveText('Sharp Katana.mod', { timeout: 60_000 });
    await page.locator('.dv-tab', { hasText: 'Инспектор' }).click();
    await selectRecord(page, 'katana', KATANA);
    await page.getByTestId('field-filter').fill('cut damage');
    await expect(page.getByTestId(`field-${CUT}`)).toHaveValue('1.5');
  } finally {
    await closeApp(app);
    rmSync(dirname(dirname(dirname(game.kenshi))), { recursive: true, force: true });
  }
});

test('чужой мод из мастерской: сохранить в оригинал нельзя, копия для правки в mods/', async () => {
  const game = makeGame();
  const original = join(game.workshop, '900001', 'Katana Rebalance.mod');
  const before = readFileSync(original);
  const copy = join(game.kenshi, 'mods', 'Katana Rebalance', 'Katana Rebalance.mod');
  const { app, page } = await launch(game);
  try {
    const row = page.getByTestId('mods-table').locator('tr', { hasText: 'Katana Rebalance.mod' });
    await expect(row).toBeVisible({ timeout: 60_000 });
    await row.getByRole('button').click();
    await expect(page.getByTestId('editor')).toBeVisible({ timeout: 120_000 });
    await expect(page.getByTestId('workshop-banner')).toContainText('900001');

    await page.locator('.dv-tab', { hasText: 'Инспектор' }).click();
    await selectRecord(page, 'katana', KATANA);
    await page.getByTestId('field-filter').fill('cut damage');
    const input = page.getByTestId(`field-${CUT}`);
    await expect(input).toHaveValue('2');
    await input.fill('3');
    await input.press('Enter');
    await expect(page.getByTestId('save')).toHaveClass(/primary/);
    await expect(input).toHaveValue('3');
    await page.screenshot({ path: join(shots, '31-workshop-copy.png') });

    // Ctrl+S в файл мастерской — отказ без окна подтверждения, файл не тронут.
    await stubMessageBox(app, 0);
    await page.getByTestId('save').click();
    await expect(page.getByTestId('status-msg')).toContainText('мастерской Steam');
    expect((await messageBox(app)).calls).toBe(0);
    expect(Buffer.compare(readFileSync(original), before)).toBe(0);

    // «Отмена» в окне копии — ничего не создаётся.
    await stubMessageBox(app, 1);
    await page.getByTestId('copy-for-editing').click();
    await expect.poll(async () => (await messageBox(app)).calls).toBe(1);
    expect(existsSync(copy)).toBe(false);

    // «Скопировать»: копия байт в байт + файл происхождения; правки остаются, сохраняются в копию.
    await stubMessageBox(app, 0);
    await page.getByTestId('copy-for-editing').click();
    await expect(page.getByTestId('copy-banner')).toContainText('900001', { timeout: 30_000 });
    await expect(page.getByTestId('workshop-banner')).toHaveCount(0);
    const box = await messageBox(app);
    expect(box.detail).toContain(copy);
    expect(box.detail).toContain('закроет оригинал');
    expect(Buffer.compare(readFileSync(copy), before)).toBe(0);
    const origin = JSON.parse(readFileSync(join(dirname(copy), 'Katana Rebalance.kedit-origin.json'), 'utf8')) as { source: string; workshopId: string };
    expect(origin).toMatchObject({ source: original, workshopId: '900001' });
    await expect(page.getByTestId('save')).toHaveClass(/primary/);

    await stubMessageBox(app, 0);
    await page.getByTestId('save').click();
    await expect(page.getByTestId('status-msg')).toContainText('Сохранено', { timeout: 30_000 });
    expect((await messageBox(app)).detail).toBe(copy);
    expect(Buffer.compare(readFileSync(copy), before)).not.toBe(0);
    expect(Buffer.compare(readFileSync(original), before)).toBe(0);
    await expect(page.getByTestId('copy-banner')).toBeVisible();
  } finally {
    await closeApp(app);
    rmSync(dirname(dirname(dirname(game.kenshi))), { recursive: true, force: true });
  }
});
