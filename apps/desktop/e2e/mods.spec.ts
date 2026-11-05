/**
 * E2E этапа 4 (существующие моды) на временной «папке игры»: ванильные файлы — жёсткие
 * ссылки на файлы настоящей игры (только чтение, место не тратится), два своих мода
 * (один в `mods/`, другой в «мастерской»), свой `mods.cfg`. Настоящий `mods.cfg` и папки
 * игры не трогаются: приложению передаётся KENSHI_DIR / KENSHI_WORKSHOP_DIR.
 */
import { copyFileSync, existsSync, linkSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
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

    // mods.cfg не менялся.
    expect(readFileSync(game.cfg, 'utf-8')).toBe('Sharp Katana.mod\r\nKatana Rebalance.mod\r\n');
  } finally {
    await closeApp(app);
    rmSync(dirname(dirname(dirname(game.kenshi))), { recursive: true, force: true });
  }
});
