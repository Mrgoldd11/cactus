/**
 * E2E «Mod merge»: the «Merge mods» panel in the window. A temp «game folder» (see mods.spec.ts):
 * vanilla is hard links to the real game files, a foreign mod is in the «Workshop».
 * Scenario: pick a source → accept all records → merge → undo → redo → save;
 * a companion file appears next to the mod, after a reload merged records are not offered again.
 */
import { copyFileSync, existsSync, linkSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { _electron as electron, expect, test, type ElectronApplication, type Page } from '@playwright/test';
import { decodeText, emptyRecord, encodeText, FileType, itemTypeId, readDataFile, writeDataFile, type DataFile, type GameRecord } from '@kenshi-editor/core';
import { resolveGamePaths } from '@kenshi-editor/core/node';

const appDir = resolve(import.meta.dirname, '..');
const editorRoot = resolve(appDir, '../..');
const outDir = join(editorRoot, 'out');
const shots = join(outDir, 'screenshots');
mkdirSync(shots, { recursive: true });

const KATANA = '476-gamedata.base';
const CUT = 'cut damage multiplier';
const WEAPON = itemTypeId('WEAPON')!;
const SOURCE = 'Merge Source.mod';
const NEW_A = '9001-Merge Source.mod';
const NEW_B = '9002-Merge Source.mod';

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

interface FakeGame {
  kenshi: string;
  workshop: string;
  root: string;
}

function sourceMod(): Uint8Array {
  const katana = emptyRecord(WEAPON, KATANA, encodeText('Katana'));
  katana.changeFlags = 0x80000001;
  katana.floats.set(CUT, 2.5);
  const weapon = (sid: string, name: string, value: number): GameRecord => {
    const r = emptyRecord(WEAPON, sid, encodeText(name));
    r.changeFlags = 0x80000002;
    r.ints.set('value', value);
    return r;
  };
  const f: DataFile = {
    fileType: FileType.Mod,
    header: { version: 1, author: encodeText('e2e'), description: encodeText(''), dependencies: encodeText(''), references: encodeText('') },
    lastId: 0,
    records: [katana, weapon(NEW_A, 'Merged Blade', 777), weapon(NEW_B, 'Merged Dagger', 55)],
    tail: new Uint8Array(),
  };
  return writeDataFile(f);
}

function makeGame(): FakeGame {
  const real = resolveGamePaths(editorRoot);
  const base = join(outDir, 'tmp-game');
  mkdirSync(base, { recursive: true });
  const root = mkdtempSync(join(base, 'm-'));
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
  mkdirSync(join(workshop, '900002'), { recursive: true });
  writeFileSync(join(workshop, '900002', SOURCE), sourceMod());
  writeFileSync(join(kenshi, 'data', 'mods.cfg'), '');
  return { kenshi, workshop, root };
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

async function stubDialogs(app: ElectronApplication, savePath: string): Promise<void> {
  await app.evaluate(({ dialog }, p) => {
    dialog.showSaveDialog = () => Promise.resolve({ canceled: false, filePath: p });
    dialog.showMessageBox = () => Promise.resolve({ response: 0, checkboxChecked: false });
  }, savePath);
}

async function openPanel(page: Page, id: string): Promise<void> {
  await page.getByTestId('window-menu').click();
  await page.getByTestId(`window-panel-${id}`).click();
}

test('merge: pick a mod → merge → undo → redo → save; companion file next to the mod', async () => {
  const game = makeGame();
  const target = join(game.kenshi, 'mods', 'Merge Target', 'Merge Target.mod');
  const { app, page } = await launch(game);
  try {
    await page.getByTestId('new-mod-name').fill('Merge Target');
    await page.getByTestId('create-mod').click();
    await expect(page.getByTestId('editor')).toBeVisible({ timeout: 120_000 });
    await stubDialogs(app, target);

    await openPanel(page, 'merge');
    const panel = page.getByTestId('merge-panel');
    await expect(panel).toBeVisible();
    await expect.poll(async () => page.getByTestId('merge-source').locator('option').count(), { timeout: 30_000 }).toBeGreaterThan(1);
    await page.getByTestId('merge-source').selectOption({ label: `${SOURCE} (workshop)` });

    const rows = page.getByTestId('merge-row');
    await expect(rows).toHaveCount(3, { timeout: 30_000 });
    // Everything is «ignore» by default; the katana is changed, the two others are new.
    await expect(page.locator('[data-testid="merge-row"][data-state="ignore"]')).toHaveCount(3);
    await expect(page.locator(`[data-testid="merge-row"][data-sid="${KATANA}"]`)).toHaveAttribute('data-kind', 'changed');
    await expect(page.locator(`[data-testid="merge-row"][data-sid="${NEW_A}"]`)).toHaveAttribute('data-kind', 'new');
    await expect(page.getByTestId('merge-apply')).toBeDisabled();

    // Details of the changed record: was → will be per field.
    await page.locator(`[data-testid="merge-row"][data-sid="${KATANA}"]`).getByTestId('merge-expand').click();
    await expect(page.getByTestId('merge-detail')).toContainText(CUT);
    await page.screenshot({ path: join(shots, '40-merge-list.png') });

    // Accept all shown and merge.
    await page.getByTestId('merge-select-shown').click();
    await expect(page.locator('[data-testid="merge-row"][data-state="accept"]')).toHaveCount(3);
    await expect(page.getByTestId('merge-apply')).toBeEnabled();
    await page.getByTestId('merge-apply').click();
    await expect(page.getByTestId('merge-result')).toBeVisible();
    await expect(rows).toHaveCount(0);
    await expect(page.getByTestId('save')).toHaveClass(/primary/);
    await page.screenshot({ path: join(shots, '41-merge-done.png') });

    // Undo brings everything back in one step; redo merges again.
    await page.getByTestId('undo').click();
    await expect(rows).toHaveCount(3);
    await page.getByTestId('redo').click();
    await expect(rows).toHaveCount(0);

    // Save: the mod file and the companion file next to it.
    await page.getByTestId('save').click();
    await expect(page.getByTestId('status-msg')).toContainText('Сохранено', { timeout: 30_000 });
    await expect(page.getByTestId('save')).not.toHaveClass(/primary/);

    const recs = readDataFile(readFileSync(target)).records;
    expect(recs.map((r) => r.stringId).sort()).toEqual([KATANA, NEW_A, NEW_B].sort());
    expect(recs.find((r) => r.stringId === KATANA)!.floats.get(CUT)).toBeCloseTo(2.5, 5);
    expect(decodeText(recs.find((r) => r.stringId === NEW_A)!.name)).toBe('Merged Blade');
    const store = join(dirname(target), 'Merge Target.kedit-merge.json');
    expect(existsSync(store)).toBe(true);
    const text = readFileSync(store, 'utf8');
    expect(text).toContain(SOURCE);
    const parsed = JSON.parse(text) as { version: number; log: { source: string; accepted: number }[] };
    expect(parsed.version).toBe(1);
    expect(parsed.log).toHaveLength(1);
    expect(parsed.log[0]).toMatchObject({ source: SOURCE, accepted: 3 });
  } finally {
    await closeApp(app);
  }

  // New launch: the mod is opened from disk — merged records are not offered again.
  const second = await launch(game);
  try {
    const row = second.page.getByTestId('mods-table').locator('tr', { hasText: 'Merge Target.mod' });
    await expect(row).toBeVisible({ timeout: 60_000 });
    await row.getByRole('button').click();
    await expect(second.page.getByTestId('editor')).toBeVisible({ timeout: 120_000 });
    await openPanel(second.page, 'merge');
    await second.page.getByTestId('merge-source').selectOption({ label: `${SOURCE} (workshop)` });
    await expect(second.page.getByTestId('merge-counts')).toBeVisible({ timeout: 30_000 });
    await expect(second.page.getByTestId('merge-row')).toHaveCount(0);
    await second.page.screenshot({ path: join(shots, '42-merge-again.png') });
  } finally {
    await closeApp(second.app);
    rmSync(game.root, { recursive: true, force: true });
  }
});
