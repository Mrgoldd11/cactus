/**
 * E2E «Problem fixes and mod cleanup»: a mod with a planted broken reference (a temp «game folder»
 * of hard links to the real game files, as in merge.spec.ts). Diagnostics: fix it with the row
 * button → the problem is gone → undo brings it back; ignore persists in the editor data folder.
 * Cleanup: the invalid reference is proposed, removing it is one undo step.
 */
import { copyFileSync, existsSync, linkSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { _electron as electron, expect, test, type ElectronApplication, type Page } from '@playwright/test';
import { emptyRecord, encodeText, FileType, itemTypeId, writeDataFile, type DataFile } from '@kenshi-editor/core';
import { resolveGamePaths } from '@kenshi-editor/core/node';

const appDir = resolve(import.meta.dirname, '..');
const editorRoot = resolve(appDir, '../..');
const outDir = join(editorRoot, 'out');
const shots = join(outDir, 'screenshots');
mkdirSync(shots, { recursive: true });

const MOD = 'Fix Test';
const BROKEN = `1-${MOD}.mod`;
const GHOST = '999999-nowhere.mod';
const CATEGORY = 'unique replacement spawn';

const GAME_FILES = ['data/gamedata.base', 'data/Newwworld.mod', 'data/Dialogue.mod', 'data/rebirth.mod', 'fcs.def', 'fcs_enums.def', 'fcs_layout.def', 'locale/ru_RU/gamedata.po', 'locale/ru_RU/ru_RU.translation'];

interface FakeGame {
  kenshi: string;
  workshop: string;
  root: string;
}

function brokenMod(): Uint8Array {
  const r = emptyRecord(itemTypeId('CHARACTER')!, BROKEN, encodeText('E2E Broken'));
  r.changeFlags = 0x80000002;
  r.refs.set(CATEGORY, [{ target: GHOST, v0: 0, v1: 0, v2: 0 }]);
  const f: DataFile = {
    fileType: FileType.Mod,
    header: { version: 1, author: encodeText('e2e'), description: encodeText(''), dependencies: encodeText(''), references: encodeText('') },
    lastId: 1,
    records: [r],
    tail: new Uint8Array(),
  };
  return writeDataFile(f);
}

function makeGame(): FakeGame {
  const real = resolveGamePaths(editorRoot);
  const base = join(outDir, 'tmp-game');
  mkdirSync(base, { recursive: true });
  const root = mkdtempSync(join(base, 'f-'));
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
  mkdirSync(join(kenshi, 'mods', MOD), { recursive: true });
  writeFileSync(join(kenshi, 'mods', MOD, `${MOD}.mod`), brokenMod());
  writeFileSync(join(kenshi, 'data', 'mods.cfg'), '');
  return { kenshi, workshop, root };
}

async function launch(game: FakeGame): Promise<{ app: ElectronApplication; page: Page; userData: string }> {
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
  return { app, page, userData };
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

test('fixes: broken reference fixed from Diagnostics, undo, ignore persists; cleanup is one step', async () => {
  const game = makeGame();
  const { app, page, userData } = await launch(game);
  try {
    const row = page.getByTestId('mods-table').locator('tr', { hasText: `${MOD}.mod` });
    await expect(row).toBeVisible({ timeout: 60_000 });
    await row.getByRole('button').click();
    await expect(page.getByTestId('editor')).toBeVisible({ timeout: 120_000 });

    await openPanel(page, 'diagnostics');
    const issue = page.locator('[data-testid="fix-issue"]', { hasText: GHOST });
    await expect(issue).toHaveCount(1);
    await expect(page.locator('[data-testid="fix-group"][data-code="broken-ref"]')).toBeVisible();
    await expect(issue.getByTestId('fix-remove-ref')).toBeVisible();
    await expect(issue.getByTestId('fix-remove-record')).toBeVisible();
    await page.screenshot({ path: join(shots, '50-fix-diagnostics.png') });

    // Fix with the row button: the problem is gone, the mod is dirty.
    await issue.getByTestId('fix-remove-ref').click();
    await expect(issue).toHaveCount(0);
    await expect(page.getByTestId('validation-ok')).toBeVisible();
    await expect(page.getByTestId('fix-note')).toBeVisible();
    await expect(page.getByTestId('save')).toHaveClass(/primary/);
    await page.screenshot({ path: join(shots, '51-fix-done.png') });

    // Undo — one step brings the problem back.
    await page.getByTestId('undo').click();
    await expect(issue).toHaveCount(1);

    // Ignore: hidden, shown with the toggle, kept in the editor data folder (not next to the mod).
    await issue.getByTestId('fix-ignore').click();
    await expect(issue).toHaveCount(0);
    await page.getByTestId('fix-show-ignored').check();
    await expect(issue).toHaveCount(1);
    await expect(issue).toHaveClass(/ignored/);
    await expect
      .poll(() => {
        const dir = join(userData, 'validation');
        return existsSync(dir) ? readdirSync(dir).map((f) => readFileSync(join(dir, f), 'utf8')).join('\n') : '';
      })
      .toContain(`broken-ref|${BROKEN}|${CATEGORY}|${GHOST}`);
    expect(readdirSync(join(game.kenshi, 'mods', MOD))).toEqual([`${MOD}.mod`]);
    await issue.getByTestId('fix-ignore').click();
    await expect(issue).not.toHaveClass(/ignored/);

    // Cleanup: the invalid reference is proposed; removing it is one undo step.
    await openPanel(page, 'cleanup');
    const group = page.locator('[data-testid="cleanup-group"][data-group="invalid-refs"]');
    await expect(group).toBeVisible();
    await expect(group.getByTestId('cleanup-group-count')).toHaveText('1 / 1');
    await group.getByTestId('cleanup-expand').click();
    await expect(group.getByTestId('cleanup-item')).toContainText(GHOST);
    await page.screenshot({ path: join(shots, '52-cleanup.png') });
    await page.getByTestId('cleanup-apply').click();
    await expect(page.getByTestId('cleanup-empty')).toBeVisible();
    await page.getByTestId('undo').click();
    await expect(page.locator('[data-testid="cleanup-group"][data-group="invalid-refs"]')).toBeVisible();
  } finally {
    await closeApp(app);
    rmSync(game.root, { recursive: true, force: true });
    rmSync(userData, { recursive: true, force: true });
  }
});
