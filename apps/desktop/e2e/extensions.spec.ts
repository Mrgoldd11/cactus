/**
 * E2E of schema extensions (FCS Extended files in a mod folder) in the window, on a temporary
 * "game folder": vanilla files are hard links to the real game (read only), the mods are our own.
 * The window applies the extensions of the opened mod by itself: the new record type has a name,
 * its fields and the fields added to vanilla types are shown, saving keeps the file as it was.
 *
 * The second test runs on the WorldStates example of FCS Extended when it lies next to the
 * repository (it is somebody else's mod: read at run time, never copied into the repository).
 */
import { copyFileSync, existsSync, linkSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { _electron as electron, expect, test, type ElectronApplication, type Page } from '@playwright/test';
import { emptyRecord, encodeText, FileType, itemTypeId, joinModList, readDataFile, writeDataFile, type DataFile, type GameRecord } from '@kenshi-editor/core';
import { resolveGamePaths } from '@kenshi-editor/core/node';

const appDir = resolve(import.meta.dirname, '..');
const editorRoot = resolve(appDir, '../..');
const outDir = join(editorRoot, 'out');
const shots = join(outDir, 'screenshots');
mkdirSync(shots, { recursive: true });

/** The example mod of FCS Extended, when it is on this machine. */
const WORLD_STATES = resolve(editorRoot, '../kenshi-bridge/_downloads/examples/WorldStates/WorldStates');

/** Game files the editor needs: vanilla, schema, translation. */
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

const EXT_TYPE = 901;
const EXT_MOD = 'Ext Mod.mod';
const COUNTER = `1-${EXT_MOD}`;
const LINE = `2-${EXT_MOD}`;
const REF = 'e2e counter equals';

const EXT_DEF = [
  '// enum itemType { E2E_COUNTER=901 }',
  '[E2E_COUNTER]',
  'value: 0 "starting value of the counter"',
  '',
  '[FCS_LAYOUT]',
  'E2E Counters: E2E_COUNTER',
  '',
  '[DIALOGUE,DIALOGUE_LINE]',
  `${REF}: E2E_COUNTER(0) "the line is chosen when the counter has this value"`,
  '',
].join('\r\n');

function modFile(records: GameRecord[], deps: string[] = []): Uint8Array {
  const f: DataFile = {
    fileType: FileType.Mod,
    header: { version: 1, author: encodeText('e2e'), description: encodeText(''), dependencies: joinModList(deps), references: encodeText('') },
    lastId: records.length,
    records,
    tail: new Uint8Array(),
  };
  return writeDataFile(f);
}

/** A record the mod adds itself. */
function added(type: number, n: number, name: string, fill: (r: GameRecord) => void = () => undefined): GameRecord {
  const r = emptyRecord(type, `${String(n)}-${EXT_MOD}`, encodeText(name));
  r.id = n;
  r.changeFlags = 0x80000003;
  fill(r);
  return r;
}

interface FakeGame {
  root: string;
  kenshi: string;
  workshop: string;
}

function put(path: string, bytes: Uint8Array | string): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, bytes);
}

function makeGame(): FakeGame {
  const real = resolveGamePaths(editorRoot);
  // Same drive as the game: hard links only work inside one volume.
  const base = join(outDir, 'tmp-game');
  mkdirSync(base, { recursive: true });
  const root = mkdtempSync(join(base, 'x-'));
  const kenshi = join(root, 'steamapps', 'common', 'Kenshi');
  const workshop = join(root, 'steamapps', 'workshop', 'content', '233860');
  mkdirSync(workshop, { recursive: true });
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
  writeFileSync(join(kenshi, 'data', 'mods.cfg'), '');
  return { root, kenshi, workshop };
}

async function launch(game: FakeGame): Promise<{ app: ElectronApplication; page: Page }> {
  const userData = mkdtempSync(join(tmpdir(), 'kedit-e2e-'));
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
  await app.close();
}

/** Answer the "save as" dialog of main with `path`. */
async function stubSaveDialog(app: ElectronApplication, path: string): Promise<void> {
  await app.evaluate(({ dialog }, p) => {
    dialog.showSaveDialog = () => Promise.resolve({ canceled: false, filePath: p });
  }, path);
}

async function openMod(page: Page, fileName: string): Promise<void> {
  const row = page.getByTestId('mods-table').locator('tr', { hasText: fileName });
  await expect(row).toBeVisible({ timeout: 60_000 });
  await row.getByRole('button').click();
  await expect(page.getByTestId('editor')).toBeVisible({ timeout: 120_000 });
}

async function selectRecord(page: Page, query: string, sid: string): Promise<void> {
  await page.getByTestId('search').fill(query);
  await page.getByTestId('record-list').locator(`[data-sid="${sid}"]`).click();
  await expect(page.getByTestId('record-sid')).toHaveText(sid);
}

async function createRecord(page: Page, type: string, name: string): Promise<void> {
  await page.getByTestId('new-record').click();
  await page.getByTestId('new-record-type').selectOption(type);
  await page.getByTestId('new-record-name').fill(name);
  await page.getByTestId('new-record-create').click();
  await expect(page.getByTestId('record-name')).toHaveValue(name);
}

async function typeOptions(page: Page): Promise<string[]> {
  await page.getByTestId('new-record').click();
  const options = await page.getByTestId('new-record-type').locator('option').allTextContents();
  await page.getByTestId('new-record-modal').locator('.modal-title button').click();
  return options;
}

async function saveAs(app: ElectronApplication, page: Page, path: string): Promise<void> {
  await stubSaveDialog(app, path);
  await page.getByTestId('save-as').click();
  await expect.poll(() => existsSync(path), { timeout: 60_000 }).toBe(true);
  await expect(page.getByTestId('save')).not.toHaveClass(/primary/);
}

test('schema extension of the opened mod: type name, fields, note in "Mod info", save', async () => {
  const game = makeGame();
  const extDir = join(game.kenshi, 'mods', 'Ext Mod');
  const original = modFile([
    added(EXT_TYPE, 1, 'Day counter', (r) => {
      r.ints.set('value', 5);
    }),
    added(itemTypeId('DIALOGUE_LINE')!, 2, 'Counter line', (r) => {
      r.refs.set(REF, [{ target: COUNTER, v0: 3, v1: 0, v2: 0 }]);
    }),
  ]);
  put(join(extDir, EXT_MOD), original);
  put(join(extDir, 'fcs.def'), EXT_DEF);
  put(join(extDir, 'FCS_extended.json'), JSON.stringify({ FCS_Plugins: ['E2E_FCS.dll'] }));
  put(join(game.kenshi, 'mods', 'Plain Mod', 'Plain Mod.mod'), modFile([]));
  const saved = mkdtempSync(join(tmpdir(), 'kedit-ext-'));

  const { app, page } = await launch(game);
  try {
    // A mod without extensions opens as before: no badge, no note, no extension type.
    await openMod(page, 'Plain Mod.mod');
    await expect(page.getByTestId('ext-badge')).toHaveCount(0);
    expect(await typeOptions(page)).not.toContain('E2E_COUNTER');
    await page.getByTestId('mod-menu').click();
    await page.getByTestId('mod-info').click();
    await expect(page.locator('.modal')).toBeVisible();
    await expect(page.getByTestId('ext-note')).toHaveCount(0);
    await page.locator('.modal-title button').click();
    await page.getByTestId('home').click();

    // The mod with fcs.def: the schema is rebuilt with its extension.
    await openMod(page, EXT_MOD);
    await expect(page.getByTestId('ext-badge')).toContainText('1');
    await page.getByTestId('mod-menu').click();
    await page.getByTestId('mod-info').click();
    const note = page.getByTestId('ext-note');
    await expect(note.getByTestId('ext-item')).toHaveCount(1);
    await expect(note).toContainText('Ext Mod');
    await expect(note).toContainText('E2E_COUNTER=901');
    await expect(note).toContainText(`DIALOGUE_LINE.${REF}`);
    // DLL plugins of FCS Extended are named and marked as not run.
    await expect(note).toContainText('E2E_FCS.dll');
    await expect(note).toContainText('Cactus');
    await expect(note.getByTestId('ext-warnings')).toHaveCount(0);
    await page.locator('.modal-title button').click();

    // The category of [FCS_LAYOUT] and the record of the new type: a name, not TYPE_901.
    await expect(page.getByTestId('category-tree')).toContainText('E2E Counters');
    await selectRecord(page, 'Day counter', COUNTER);
    await expect(page.locator('.record-meta .badge', { hasText: 'E2E_COUNTER' })).toBeVisible();
    await expect(page.getByTestId('record-editor')).not.toContainText('TYPE_901');
    await expect(page.getByTestId('field-value')).toHaveValue('5');
    await expect(page.locator('[data-field="value"] .field-name')).toHaveAttribute('title', /starting value of the counter/);
    // The field is known to the schema: no "guessed" mark on it.
    await expect(page.locator('[data-field="value"] .field-name .badge')).toHaveCount(0);

    // The field the extension adds to dialogue lines: a reference list with a description.
    await selectRecord(page, 'Counter line', LINE);
    await page.getByTestId('tab-refs').click();
    const group = page.getByTestId('refs').locator(`[data-category="${REF}"]`);
    await expect(group).toContainText('E2E_COUNTER');
    await expect(group).toContainText('Day counter');
    await expect(group.locator('.group-title')).toHaveAttribute('title', /the line is chosen when the counter has this value/);

    // Saving without edits writes the same bytes.
    const same = join(saved, 'same.mod');
    await saveAs(app, page, same);
    expect(readFileSync(same).equals(Buffer.from(original))).toBe(true);

    // A new record of the extension type gets its fields and its number in the file.
    await createRecord(page, 'E2E_COUNTER', 'Night counter');
    await expect(page.locator('.record-meta .badge', { hasText: 'E2E_COUNTER' })).toBeVisible();
    await page.getByTestId('tab-fields').click();
    await expect(page.getByTestId('field-value')).toHaveValue('0');
    const more = join(saved, 'more.mod');
    await saveAs(app, page, more);
    const records = readDataFile(readFileSync(more)).records;
    expect(records.map((r) => r.type).sort()).toEqual([itemTypeId('DIALOGUE_LINE')!, EXT_TYPE, EXT_TYPE].sort());
    expect(records.find((r) => r.stringId === COUNTER)?.ints.get('value')).toBe(5);
    expect(records.find((r) => r.stringId === LINE)?.refs.get(REF)).toEqual([{ target: COUNTER, v0: 3, v1: 0, v2: 0 }]);

    // Back to a mod without extensions: the type is gone again.
    await page.getByTestId('home').click();
    await openMod(page, 'Plain Mod.mod');
    await expect(page.getByTestId('ext-badge')).toHaveCount(0);
    expect(await typeOptions(page)).not.toContain('E2E_COUNTER');
  } finally {
    await closeApp(app);
    rmSync(game.root, { recursive: true, force: true });
    rmSync(saved, { recursive: true, force: true });
  }
});

test('WorldStates example of FCS Extended: type 900 is VARIABLE, dialogue fields, save keeps the file', async () => {
  test.skip(!existsSync(join(WORLD_STATES, 'WorldStates.mod')), 'the WorldStates example is not on this machine');
  const game = makeGame();
  const dir = join(game.kenshi, 'mods', 'WorldStates');
  for (const f of ['WorldStates.mod', 'FCS.def', 'FCS_extended.json']) put(join(dir, f), readFileSync(join(WORLD_STATES, f)));
  const original = readFileSync(join(WORLD_STATES, 'WorldStates.mod'));
  const saved = mkdtempSync(join(tmpdir(), 'kedit-ext-'));

  const { app, page } = await launch(game);
  try {
    await openMod(page, 'WorldStates.mod');
    await expect(page.getByTestId('ext-badge')).toContainText('1');
    await page.getByTestId('mod-menu').click();
    await page.getByTestId('mod-info').click();
    const note = page.getByTestId('ext-note');
    await expect(note).toContainText('VARIABLE=900');
    await expect(note).toContainText('WorldStates_FCS.dll');
    await page.screenshot({ path: join(shots, 'ext-mod-info.png') });
    await page.locator('.modal-title button').click();
    await expect(page.getByTestId('category-tree')).toContainText('Variables');

    // Saving the untouched mod writes the same bytes.
    const same = join(saved, 'same.mod');
    await saveAs(app, page, same);
    expect(readFileSync(same).equals(original)).toBe(true);

    // Type 900 has a name and its field.
    await createRecord(page, 'VARIABLE', 'Days passed');
    await expect(page.locator('.record-meta .badge', { hasText: 'VARIABLE' })).toBeVisible();
    await expect(page.getByTestId('field-value')).toHaveValue('0');

    // Dialogue lines get the reference lists of the extension, with descriptions.
    await createRecord(page, 'DIALOGUE_LINE', 'Line with a variable');
    await page.getByTestId('tab-refs').click();
    for (const name of ['variable equals', 'variable less than', 'variable greater than', 'set variable', 'add to variable']) {
      await expect(page.getByTestId(`ref-add-${name}`)).toHaveAttribute('title', /VARIABLE/);
    }
    await expect(page.getByTestId('ref-add-set variable')).toHaveAttribute('title', /sets the value of a variable/);
    await page.screenshot({ path: join(shots, 'ext-dialogue-line.png') });

    const more = join(saved, 'more.mod');
    await saveAs(app, page, more);
    const records = readDataFile(readFileSync(more)).records;
    expect(records.map((r) => r.type).sort()).toEqual([itemTypeId('DIALOGUE_LINE')!, 900].sort());
  } finally {
    await closeApp(app);
    rmSync(game.root, { recursive: true, force: true });
    rmSync(saved, { recursive: true, force: true });
  }
});
