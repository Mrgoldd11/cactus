/**
 * E2E: автосохранение, безопасное сохранение с резервными копиями и восстановление после сбоя.
 * Как `mods.spec.ts`: временная «папка игры» (ванильные файлы — жёсткие ссылки на настоящие, только
 * чтение), свой мод в `mods/`, свой `userData`. Настоящие папки игры и мастерской не трогаются.
 */
import { execFileSync } from 'node:child_process';
import { copyFileSync, existsSync, linkSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { _electron as electron, expect, test, type ElectronApplication, type Page } from '@playwright/test';
import { emptyRecord, encodeText, FileType, itemTypeId, joinModList, writeDataFile, type DataFile, type GameRecord } from '@kenshi-editor/core';
import { resolveGamePaths, writeAutosave } from '@kenshi-editor/core/node';

const appDir = resolve(import.meta.dirname, '..');
const editorRoot = resolve(appDir, '../..');
const outDir = join(editorRoot, 'out');
const shots = join(outDir, 'screenshots');
mkdirSync(shots, { recursive: true });

const KATANA = '476-gamedata.base';
const CUT = 'cut damage multiplier';
const WEAPON = itemTypeId('WEAPON')!;
const MOD_NAME = 'Sharp Katana.mod';

interface FakeGame {
  kenshi: string;
  workshop: string;
  root: string;
  modPath: string;
}

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

function modFile(records: GameRecord[]): Uint8Array {
  const f: DataFile = {
    fileType: FileType.Mod,
    header: { version: 1, author: encodeText('e2e'), description: encodeText(''), dependencies: joinModList([]), references: encodeText('') },
    lastId: 0,
    records,
    tail: new Uint8Array(),
  };
  return writeDataFile(f);
}

function katana(cut: number): GameRecord {
  const r = emptyRecord(WEAPON, KATANA, encodeText('Katana'));
  r.changeFlags = 0x80000001;
  r.floats.set(CUT, cut);
  return r;
}

function makeGame(): FakeGame {
  const real = resolveGamePaths(editorRoot);
  const base = join(outDir, 'tmp-game');
  mkdirSync(base, { recursive: true });
  const root = mkdtempSync(join(base, 'b-'));
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
  mkdirSync(workshop, { recursive: true });
  const modPath = join(kenshi, 'mods', 'Sharp Katana', MOD_NAME);
  mkdirSync(dirname(modPath), { recursive: true });
  writeFileSync(modPath, modFile([katana(1.5)]));
  writeFileSync(join(kenshi, 'data', 'mods.cfg'), `${MOD_NAME}\r\n`);
  return { kenshi, workshop, root, modPath };
}

/** Папка данных приложения; настройки заранее (в e2e автосохранение раз в ~2 с). */
function makeUserData(settings: { autosaveMinutes?: number; backupCount?: number } = {}): string {
  const dir = mkdtempSync(join(tmpdir(), 'kedit-e2e-bk-'));
  writeFileSync(join(dir, 'settings.json'), JSON.stringify({ lang: 'ru', recent: [], autosaveMinutes: 0.03, backupCount: 5, ...settings }));
  return dir;
}

async function launch(game: FakeGame, userData: string): Promise<{ app: ElectronApplication; page: Page }> {
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) if (v !== undefined && k !== 'ELECTRON_RENDERER_URL') env[k] = v;
  env['KEDIT_USER_DATA'] = userData;
  env['KEDIT_LIVE_FILE'] = join(userData, 'live.json');
  env['KENSHI_DIR'] = game.kenshi;
  env['KENSHI_WORKSHOP_DIR'] = game.workshop;
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
  await app.close().catch(() => undefined);
}

/** «Сбой»: процесс убит без закрытия окон — ни вопроса о правках, ни чистки автосохранения. */
async function crash(app: ElectronApplication): Promise<void> {
  const proc = app.process();
  const exited = new Promise<void>((r) => {
    proc.once('exit', () => {
      r();
    });
  });
  // Вместе с дочерними процессами Chromium: иначе они держат каналы, и Playwright не завершает воркер.
  if (process.platform === 'win32' && proc.pid !== undefined) execFileSync('taskkill', ['/PID', String(proc.pid), '/T', '/F'], { stdio: 'ignore' });
  else proc.kill('SIGKILL');
  await exited;
  await new Promise((r) => setTimeout(r, 1500));
}

interface Stubs {
  boxCalls: number;
  boxDetail?: string;
}

async function stubMessageBox(app: ElectronApplication, response: number): Promise<void> {
  await app.evaluate(({ dialog }, r) => {
    const g = globalThis as unknown as Stubs;
    g.boxCalls = 0;
    dialog.showMessageBox = (...args: unknown[]) => {
      g.boxCalls++;
      g.boxDetail = (args.at(-1) as { detail?: string }).detail;
      return Promise.resolve({ response: r, checkboxChecked: false });
    };
  }, response);
}

async function stubSaveDialog(app: ElectronApplication, path: string): Promise<void> {
  await app.evaluate(({ dialog }, p) => {
    dialog.showSaveDialog = () => Promise.resolve({ canceled: false, filePath: p });
  }, path);
}

function filesIn(dir: string, ext = ''): string[] {
  return existsSync(dir) ? readdirSync(dir).filter((f) => f.endsWith(ext)) : [];
}

const autosaveFiles = (userData: string): string[] => filesIn(join(userData, 'autosave'), '.mod');

/** Файлы всех копий (`backups/<ключ>/*.mod`). */
function backupFiles(userData: string): string[] {
  const root = join(userData, 'backups');
  return existsSync(root) ? readdirSync(root).flatMap((d) => filesIn(join(root, d), '.mod')) : [];
}

async function openSharpKatana(page: Page): Promise<void> {
  const row = page.getByTestId('mods-table').locator('tr', { hasText: MOD_NAME });
  await expect(row).toBeVisible({ timeout: 60_000 });
  await row.getByRole('button').click();
}

async function setCut(page: Page, value: string): Promise<void> {
  await page.locator('.dv-tab', { hasText: 'Инспектор' }).click();
  await page.getByTestId('search').fill('katana');
  await page.getByTestId('record-list').locator(`[data-sid="${KATANA}"]`).click();
  await expect(page.getByTestId('record-sid')).toHaveText(KATANA);
  await page.getByTestId('field-filter').fill('cut damage');
  const input = page.getByTestId(`field-${CUT}`);
  await input.fill(value);
  await input.press('Enter');
  await expect(input).toHaveValue(value);
}

async function cutValue(page: Page): Promise<string> {
  await page.locator('.dv-tab', { hasText: 'Инспектор' }).click();
  await page.getByTestId('search').fill('katana');
  await page.getByTestId('record-list').locator(`[data-sid="${KATANA}"]`).click();
  await page.getByTestId('field-filter').fill('cut damage');
  return page.getByTestId(`field-${CUT}`).inputValue();
}

function cleanup(game: FakeGame, userData: string): void {
  // После «сбоя» остатки убитого процесса могут ещё держать файлы: чистка best-effort.
  for (const dir of [game.root, userData]) {
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      // временная папка останется до очистки системой
    }
  }
}

test('сбой: правка → автосохранение → аварийное закрытие → восстановление → сохранение → kedit validate', async () => {
  const game = makeGame();
  const userData = makeUserData();
  const original = readFileSync(game.modPath);
  let { app, page } = await launch(game, userData);
  try {
    await openSharpKatana(page);
    await expect(page.getByTestId('editor')).toBeVisible({ timeout: 120_000 });
    await setCut(page, '9');

    // Автосохранение: тихое сообщение в строке состояния, отдельный файл в папке данных, мод не тронут.
    await expect(page.getByTestId('status-msg')).toContainText('Автосохранено в', { timeout: 30_000 });
    await expect.poll(() => autosaveFiles(userData).length).toBe(1);
    expect(Buffer.compare(readFileSync(game.modPath), original)).toBe(0);
    await page.screenshot({ path: join(shots, '40-autosaved.png') });

    // «Сбой»: окно не закрывается по-хорошему.
    await crash(app);

    ({ app, page } = await launch(game, userData));
    await openSharpKatana(page);
    const recovery = page.getByTestId('recovery-modal');
    await expect(recovery).toBeVisible({ timeout: 30_000 });
    await expect(recovery).toContainText('Найдена более свежая копия');
    await expect(page.getByTestId('recovery-copy')).toBeVisible();
    await page.screenshot({ path: join(shots, '41-recovery.png') });
    await page.getByTestId('recovery-restore').click();
    await expect(page.getByTestId('editor')).toBeVisible({ timeout: 120_000 });
    await expect(page.getByTestId('save')).toHaveClass(/primary/);
    expect(await cutValue(page)).toBe('9');
    // Восстановление ничего не пишет в сам мод.
    expect(Buffer.compare(readFileSync(game.modPath), original)).toBe(0);

    // Сохранить: файл в папке игры — с подтверждением; прежняя версия уходит в копии, автосохранение удалено.
    await stubMessageBox(app, 0);
    await page.getByTestId('save').click();
    await expect(page.getByTestId('status-msg')).toContainText('Сохранено', { timeout: 30_000 });
    expect(Buffer.compare(readFileSync(game.modPath), original)).not.toBe(0);
    expect(autosaveFiles(userData)).toHaveLength(0);
    expect(backupFiles(userData)).toHaveLength(1);
    expect(filesIn(dirname(game.modPath)).filter((f) => f.includes('.tmp'))).toHaveLength(0);
    const cli = join(editorRoot, 'packages/cli/bin/kedit.js');
    const report = execFileSync(process.execPath, [cli, 'validate', '--mod', game.modPath], { cwd: editorRoot, encoding: 'utf8' });
    expect(report).toContain('ошибок 0');

    // Резервные копии: версия до сохранения (1.5) — восстановить как правку и выгрузить отдельным файлом.
    await page.getByTestId('backups-btn').click();
    const list = page.getByTestId('backup-list');
    await expect(list).toContainText('до сохранения');
    await page.screenshot({ path: join(shots, '42-backups.png') });
    const exported = join(tmpdir(), `kedit-e2e-export-${Date.now()}.mod`);
    await stubSaveDialog(app, exported);
    await page.getByTestId('backup-export').click();
    await expect(page.getByTestId('status-msg')).toContainText('Копия сохранена', { timeout: 30_000 });
    expect(Buffer.compare(readFileSync(exported), original)).toBe(0);
    rmSync(exported, { force: true });

    await page.getByTestId('backup-restore').click();
    await expect(page.getByTestId('status-msg')).toContainText('Восстановлена версия', { timeout: 60_000 });
    await expect(page.getByTestId('save')).toHaveClass(/primary/);
    expect(await cutValue(page)).toBe('1.5');
    // Текущее состояние (9) не потеряно: точка возврата в копиях.
    expect(backupFiles(userData).length).toBe(2);
  } finally {
    await closeApp(app);
    cleanup(game, userData);
  }
});

test('автосохранение 0 — выключено; настройки пишутся в settings.json', async () => {
  const game = makeGame();
  const userData = makeUserData({ autosaveMinutes: 5 });
  const { app, page } = await launch(game, userData);
  try {
    await expect(page.getByTestId('settings-btn')).toBeVisible({ timeout: 60_000 });
    await page.getByTestId('settings-btn').click();
    await expect(page.getByTestId('settings-modal')).toBeVisible();
    await page.getByTestId('autosave-minutes').fill('0');
    await page.getByTestId('backup-count').fill('3');
    await page.screenshot({ path: join(shots, '43-settings.png') });
    await expect
      .poll(() => (JSON.parse(readFileSync(join(userData, 'settings.json'), 'utf8')) as { autosaveMinutes: number; backupCount: number }))
      .toMatchObject({ autosaveMinutes: 0, backupCount: 3 });
    await page.getByTestId('settings-close').click();

    await openSharpKatana(page);
    await expect(page.getByTestId('editor')).toBeVisible({ timeout: 120_000 });
    await setCut(page, '4');
    await expect(page.getByTestId('save')).toHaveClass(/primary/);
    await new Promise((r) => setTimeout(r, 4000));
    expect(autosaveFiles(userData)).toHaveLength(0);
    expect((await page.getByTestId('status-msg').allTextContents()).join(' ')).not.toContain('Автосохранено');
  } finally {
    await closeApp(app);
    cleanup(game, userData);
  }
});

test('найдена копия: «Открыть как есть» оставляет её в копиях, «Удалить копию» стирает', async () => {
  const game = makeGame();
  const userData = makeUserData({ autosaveMinutes: 0 });
  const original = readFileSync(game.modPath);
  const ref = { path: game.modPath, modName: MOD_NAME };
  await new Promise((r) => setTimeout(r, 50));
  writeAutosave(userData, ref, modFile([katana(7)]));
  const { app, page } = await launch(game, userData);
  try {
    await openSharpKatana(page);
    await expect(page.getByTestId('recovery-modal')).toBeVisible({ timeout: 30_000 });
    await page.getByTestId('recovery-as-is').click();
    await expect(page.getByTestId('editor')).toBeVisible({ timeout: 120_000 });
    // Мод как есть: без правок, копия лежит в резервных.
    await expect(page.getByTestId('save')).not.toHaveClass(/primary/);
    expect(await cutValue(page)).toBe('1.5');
    expect(autosaveFiles(userData)).toHaveLength(0);
    expect(backupFiles(userData)).toHaveLength(1);
    await page.getByTestId('backups-btn').click();
    await expect(page.getByTestId('backup-list')).toContainText('автосохранение');
    await page.getByTestId('backups-modal').getByText('✕').click();

    // Заново — окна уже нет.
    await page.getByTestId('home').click();
    await openSharpKatana(page);
    await expect(page.getByTestId('editor')).toBeVisible({ timeout: 120_000 });
    await expect(page.getByTestId('recovery-modal')).toHaveCount(0);
    await page.getByTestId('home').click();

    // Новая копия; «Удалить» — ни копии, ни окна.
    await new Promise((r) => setTimeout(r, 50));
    writeAutosave(userData, ref, modFile([katana(8)]));
    await openSharpKatana(page);
    await expect(page.getByTestId('recovery-modal')).toBeVisible({ timeout: 30_000 });
    await page.getByTestId('recovery-delete').click();
    await expect(page.getByTestId('editor')).toBeVisible({ timeout: 120_000 });
    expect(autosaveFiles(userData)).toHaveLength(0);
    expect(backupFiles(userData)).toHaveLength(1);
    expect(Buffer.compare(readFileSync(game.modPath), original)).toBe(0);
  } finally {
    await closeApp(app);
    cleanup(game, userData);
  }
});
