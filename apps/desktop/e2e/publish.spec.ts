/**
 * E2E: «Publish to Steam Workshop» against the fake uploader (`KEDIT_FAKE_STEAM`). Steam is never
 * touched: the uploader child process runs `fakeSteam()` and writes its calls into a log file.
 * Like `backup.spec.ts`: a temp «game folder» with the mod in `mods/`, an own `userData`.
 */
import { copyFileSync, existsSync, linkSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { _electron as electron, expect, test, type ElectronApplication, type Page } from '@playwright/test';
import { emptyRecord, encodeText, FileType, itemTypeId, joinModList, writeDataFile, type DataFile } from '@kenshi-editor/core';
import { resolveGamePaths } from '@kenshi-editor/core/node';

const appDir = resolve(import.meta.dirname, '..');
const editorRoot = resolve(appDir, '../..');
const outDir = join(editorRoot, 'out');
const shots = join(outDir, 'screenshots');
mkdirSync(shots, { recursive: true });

const MOD_NAME = 'Sharp Katana.mod';
const FAKE_ID = '4000000001';
// 1×1 PNG.
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');

const GAME_FILES = ['data/gamedata.base', 'data/Newwworld.mod', 'data/Dialogue.mod', 'data/rebirth.mod', 'fcs.def', 'fcs_enums.def', 'fcs_layout.def', 'locale/ru_RU/gamedata.po', 'locale/ru_RU/ru_RU.translation'];

interface FakeGame {
  kenshi: string;
  workshop: string;
  root: string;
  modPath: string;
  modDir: string;
}

function modFile(description: string): Uint8Array {
  const r = emptyRecord(itemTypeId('WEAPON')!, '476-gamedata.base', encodeText('Katana'));
  r.changeFlags = 0x80000001;
  r.floats.set('cut damage multiplier', 1.5);
  const f: DataFile = {
    fileType: FileType.Mod,
    header: { version: 1, author: encodeText('e2e'), description: encodeText(description), dependencies: joinModList([]), references: encodeText('') },
    lastId: 0,
    records: [r],
    tail: new Uint8Array(),
  };
  return writeDataFile(f);
}

function makeGame(opts: { description?: string; preview?: boolean } = {}): FakeGame {
  const real = resolveGamePaths(editorRoot);
  const base = join(outDir, 'tmp-game');
  mkdirSync(base, { recursive: true });
  const root = mkdtempSync(join(base, 'p-'));
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
  const modDir = join(kenshi, 'mods', 'Sharp Katana');
  const modPath = join(modDir, MOD_NAME);
  mkdirSync(modDir, { recursive: true });
  writeFileSync(modPath, modFile(opts.description ?? ''));
  if (opts.preview === true) writeFileSync(join(modDir, '_Sharp Katana.img'), PNG);
  // Editor leftovers that must not be uploaded.
  writeFileSync(join(modDir, 'Sharp Katana.mod.bak'), 'old');
  writeFileSync(join(modDir, 'Thumbs.db'), 'x');
  writeFileSync(join(kenshi, 'data', 'mods.cfg'), `${MOD_NAME}\r\n`);
  return { kenshi, workshop, root, modPath, modDir };
}

function makeUserData(): string {
  const dir = mkdtempSync(join(tmpdir(), 'kedit-e2e-pub-'));
  writeFileSync(join(dir, 'settings.json'), JSON.stringify({ lang: 'ru', recent: [], autosaveMinutes: 0 }));
  return dir;
}

async function launch(game: FakeGame, userData: string, scenario = '1'): Promise<{ app: ElectronApplication; page: Page }> {
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) if (v !== undefined && k !== 'ELECTRON_RENDERER_URL') env[k] = v;
  env['KEDIT_USER_DATA'] = userData;
  env['KEDIT_LIVE_FILE'] = join(userData, 'live.json');
  env['KENSHI_DIR'] = game.kenshi;
  env['KENSHI_WORKSHOP_DIR'] = game.workshop;
  env['KEDIT_SKIP_GAME_CHECK'] = '1';
  env['KEDIT_FAKE_STEAM'] = scenario;
  env['KEDIT_FAKE_STEAM_TICK_MS'] = '40';
  env['KEDIT_FAKE_STEAM_LOG'] = join(userData, 'fake-steam.log');
  const app = await electron.launch({ args: ['.'], cwd: appDir, env });
  const page = await app.firstWindow();
  await page.waitForLoadState('domcontentloaded');
  // Nothing may leave the test: links, the clipboard and the file dialog are stubbed.
  await app.evaluate(({ dialog, shell }) => {
    // «Write into the game folder?» on save → «Write».
    dialog.showMessageBox = () => Promise.resolve({ response: 0, checkboxChecked: false });
    const g = globalThis as unknown as { opened: string[] };
    g.opened = [];
    shell.openExternal = (url: string) => {
      g.opened.push(url);
      return Promise.resolve();
    };
    shell.showItemInFolder = (p: string) => {
      g.opened.push(`file:${p}`);
    };
  });
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

function cleanup(game: FakeGame, userData: string): void {
  for (const dir of [game.root, userData]) {
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      // best-effort
    }
  }
}

async function setScenario(app: ElectronApplication, scenario: string): Promise<void> {
  await app.evaluate((_e, s) => {
    process.env['KEDIT_FAKE_STEAM'] = s;
  }, scenario);
}

async function openMod(page: Page): Promise<void> {
  const row = page.getByTestId('mods-table').locator('tr', { hasText: MOD_NAME });
  await expect(row).toBeVisible({ timeout: 60_000 });
  await row.getByRole('button').click();
  await expect(page.getByTestId('mod-menu')).toBeVisible({ timeout: 60_000 });
  await page.getByTestId('mod-menu').click();
  await expect(page.getByTestId('publish-btn')).toBeEnabled({ timeout: 60_000 });
  await page.keyboard.press('Escape');
  await expect(page.getByTestId('mod-menu-list')).toHaveCount(0);
}

const fakeCalls = (userData: string): { call: string }[] => {
  const p = join(userData, 'fake-steam.log');
  return existsSync(p)
    ? readFileSync(p, 'utf8')
        .split('\n')
        .filter(Boolean)
        .map((l) => JSON.parse(l) as { call: string })
    : [];
};

const codes = async (page: Page): Promise<string[]> => page.getByTestId('pub-checks').locator('li').evaluateAll((els) => els.map((e) => `${e.getAttribute('class') ?? ''}:${e.getAttribute('data-code') ?? ''}`));

test('publish: new item, then update, with the fake Steam', async () => {
  test.setTimeout(240_000);
  const game = makeGame();
  const userData = makeUserData();
  const pngPath = join(userData, 'preview.png');
  writeFileSync(pngPath, PNG);
  const { app, page } = await launch(game, userData);
  try {
    await openMod(page);
    await page.getByTestId('mod-menu').click();
    await page.getByTestId('publish-btn').click();
    const modal = page.getByTestId('publish-modal');
    await expect(modal).toBeVisible();
    await expect(page.getByTestId('pub-fake')).toBeVisible();
    await expect(page.getByTestId('pub-mode')).toContainText('НОВАЯ');
    await expect(page.getByTestId('pub-title')).toHaveValue('Sharp Katana');
    await expect(page.getByTestId('pub-visibility')).toHaveValue('2');
    // Leftovers are not uploaded.
    await expect(page.getByTestId('pub-files')).toContainText(MOD_NAME);
    await expect(page.getByTestId('pub-files')).not.toContainText('Thumbs.db');
    await expect(page.getByTestId('pub-excluded')).toBeVisible();
    let c = await codes(page);
    expect(c).toContain('error:description-empty');
    expect(c).toContain('error:preview-missing');
    await expect(page.getByTestId('pub-next')).toBeDisabled();

    // Description: typed here → written into the header → saved.
    await page.getByTestId('pub-desc').fill('[b]Sharper[/b] katana.');
    c = await codes(page);
    expect(c).toContain('error:description-pending');
    await page.getByTestId('pub-write-desc').click();
    c = await codes(page);
    expect(c).toContain('error:unsaved');
    expect(c).not.toContain('error:description-pending');
    await page.getByTestId('pub-save').click();
    await expect.poll(async () => codes(page)).not.toContain('error:unsaved');

    // Preview from the file dialog.
    await app.evaluate(({ dialog }, p) => {
      dialog.showOpenDialog = () => Promise.resolve({ canceled: false, filePaths: [p] });
    }, pngPath);
    await page.getByTestId('pub-choose-preview').click();
    await expect(page.getByTestId('pub-thumb')).toBeVisible();
    await page.getByTestId('pub-tag-Gameplay').check();
    await page.getByTestId('pub-change-note').fill('First version.');
    await expect(page.getByTestId('pub-next')).toBeEnabled();
    await modal.screenshot({ path: join(shots, 'publish-form.png') });

    await page.getByTestId('pub-next').click();
    await expect(page.getByTestId('pub-confirm-text')).toContainText('новую запись');
    await modal.screenshot({ path: join(shots, 'publish-confirm.png') });
    await page.getByTestId('pub-confirm').click();
    await expect(page.getByTestId('pub-progress')).toBeVisible();
    const result = page.getByTestId('pub-result');
    await expect(result).toHaveAttribute('data-result', 'done', { timeout: 30_000 });
    await expect(result).toHaveAttribute('data-id', FAKE_ID);
    await modal.screenshot({ path: join(shots, 'publish-done.png') });

    // `.info` with the new id, the preview copied as `_<mod>.img`.
    const info = readFileSync(join(game.modDir, '_Sharp Katana.info'), 'utf8');
    expect(info).toContain(`<id>${FAKE_ID}</id>`);
    expect(info).toContain('<visibility>2</visibility>');
    expect(info).toContain('Gameplay');
    expect(readFileSync(join(game.modDir, '_Sharp Katana.img'))).toEqual(PNG);
    const calls = fakeCalls(userData).map((x) => x.call);
    expect(calls.filter((x) => x === 'createItem')).toHaveLength(1);
    expect(calls).toContain('updateItem');
    const upload = fakeCalls(userData).find((x) => x.call === 'updateItem') as unknown as { files: string[] };
    expect(upload.files.some((f) => f.startsWith('Thumbs.db') || f.includes('.bak'))).toBe(false);

    // Links: the Steam page and the copied web link.
    await page.getByTestId('pub-open-page').click();
    await page.getByTestId('pub-copy-link').click();
    await expect(page.getByTestId('pub-copy-link')).toHaveText('Ссылка скопирована');
    const opened = await app.evaluate(() => (globalThis as unknown as { opened: string[] }).opened);
    expect(opened).toContain(`steam://url/CommunityFilePage/${FAKE_ID}`);
    const clip = await app.evaluate(({ clipboard }) => clipboard.readText());
    expect(clip).toBe(`https://steamcommunity.com/sharedfiles/filedetails/?id=${FAKE_ID}`);
    await page.getByTestId('pub-close').click();
    await expect(modal).toBeHidden();

    // Second publish updates the same item.
    await page.getByTestId('mod-menu').click();
    await page.getByTestId('publish-btn').click();
    await expect(page.getByTestId('pub-mode')).toContainText(FAKE_ID);
    await expect(page.getByTestId('pub-thumb')).toBeVisible();
    await page.getByTestId('pub-next').click();
    await expect(page.getByTestId('pub-confirm-text')).toContainText(FAKE_ID);
    await page.getByTestId('pub-confirm').click();
    await expect(result).toHaveAttribute('data-result', 'done', { timeout: 30_000 });
    await expect(result).toContainText('обновлена');
    expect(fakeCalls(userData).filter((x) => x.call === 'createItem')).toHaveLength(1);
    await page.getByTestId('pub-close').click();
  } finally {
    await closeApp(app);
    cleanup(game, userData);
  }
});

test('publish: Steam missing, errors and cancel, with the fake Steam', async () => {
  test.setTimeout(240_000);
  const game = makeGame({ description: 'A sharper katana.', preview: true });
  const userData = makeUserData();
  const { app, page } = await launch(game, userData, 'not-running');
  try {
    await openMod(page);
    const modal = page.getByTestId('publish-modal');

    // No Steam: the window opens and says what is missing.
    await page.getByTestId('mod-menu').click();
    await page.getByTestId('publish-btn').click();
    await expect(page.getByTestId('pub-steam-off')).toBeVisible();
    await expect(page.getByTestId('pub-next')).toBeDisabled();
    await modal.screenshot({ path: join(shots, 'publish-no-steam.png') });
    await setScenario(app, 'timeout');
    await page.getByTestId('pub-recheck').click();
    await expect(page.getByTestId('pub-steam-off')).toBeHidden();

    // A failure after the item was created: the id is kept in `.info`.
    await page.getByTestId('pub-next').click();
    await page.getByTestId('pub-confirm').click();
    const result = page.getByTestId('pub-result');
    await expect(result).toHaveAttribute('data-result', 'error', { timeout: 30_000 });
    await expect(result).toHaveAttribute('data-code', 'timeout');
    await expect(result).toContainText(FAKE_ID);
    await modal.screenshot({ path: join(shots, 'publish-error.png') });
    expect(readFileSync(join(game.modDir, '_Sharp Katana.info'), 'utf8')).toContain(`<id>${FAKE_ID}</id>`);
    await page.getByTestId('pub-show-log').click();
    await page.getByTestId('pub-try-again').click();
    await expect(page.getByTestId('pub-mode')).toContainText(FAKE_ID);

    // Cancel during a slow upload.
    await setScenario(app, 'slow');
    await page.getByTestId('pub-next').click();
    await page.getByTestId('pub-confirm').click();
    await expect(page.getByTestId('pub-progress').locator('[data-stage="uploading"]')).toBeVisible({ timeout: 30_000 });
    await page.getByTestId('pub-cancel').click();
    await expect(result).toHaveAttribute('data-result', 'cancelled', { timeout: 15_000 });
    await modal.screenshot({ path: join(shots, 'publish-cancelled.png') });
    await page.getByTestId('pub-close').click();

    // Uploader crash is reported, not hung on.
    await setScenario(app, 'crash');
    await page.getByTestId('mod-menu').click();
    await page.getByTestId('publish-btn').click();
    await page.getByTestId('pub-next').click();
    await page.getByTestId('pub-confirm').click();
    await expect(result).toHaveAttribute('data-result', 'error', { timeout: 30_000 });
    await expect(result).toHaveAttribute('data-code', 'crashed');
    await page.getByTestId('pub-close').click();

    const log = readFileSync(join(userData, 'logs', 'steam-upload.log'), 'utf8');
    expect(log).toContain('FAKE(timeout)');
    expect(log).not.toContain('REAL');
  } finally {
    await closeApp(app);
    cleanup(game, userData);
  }
});
