/**
 * E2E: «Create ▾ → Own creature…» on the real game data. The vanilla goat's mesh and skeleton, copied
 * out of the game, play the modder's «own model»: a mesh without its skeleton next to it is flagged →
 * the right folder: the skeleton is found by the link in the mesh, every clip the goat's records ask
 * for is there, a click on a clip plays it in the preview → the texture is picked by hand → «Create»
 * copies the files into `<game>/mods/<mod>/creatures/<model>/` and makes race, animal, sale and start.
 *
 * With `KEDIT_ANIMAL_TEST=1` a second test builds the «Custom Animal Test» mod for the in-game check
 * with the converted Quaternius donkey (`KEDIT_ANIMAL_SRC`, default `D:/Kenshiproject/tools/creatures/donkey`)
 * and saves it into the mods folder (it is left there).
 */
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { _electron as electron, expect, test, type ElectronApplication, type Page } from '@playwright/test';
import { resolveGamePaths } from '@kenshi-editor/core/node';

const appDir = resolve(import.meta.dirname, '..');
const editorRoot = resolve(appDir, '../..');
const shots = join(editorRoot, 'out', 'screenshots');
mkdirSync(shots, { recursive: true });

const MOD = 'KeditE2E Creature';
const FARM_SHOP = '53642-rebirth.mod';
const GUY_WITH_DOG = '47924-rebirth.mod';

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

async function stubOpen(app: ElectronApplication, p: string): Promise<void> {
  await app.evaluate(({ dialog }, q) => {
    dialog.showOpenDialog = () => Promise.resolve({ canceled: false, filePaths: [q] });
  }, p);
}

async function openWizard(page: Page, mod: string): Promise<ReturnType<Page['getByTestId']>> {
  await page.getByTestId('new-mod-name').fill(mod);
  await page.getByTestId('create-mod').click();
  await expect(page.getByTestId('editor')).toBeVisible({ timeout: 120_000 });
  await page.getByTestId('create-menu').click();
  await page.getByTestId('create-menu-list').getByTestId('new-creature').click();
  const panel = page.getByTestId('creature-panel');
  await expect(panel).toBeVisible();
  return panel;
}

test('own creature: files checked, clips played, copied into the mod, race + animal + sale + start', async () => {
  const game = resolveGamePaths();
  const modDir = join(game.kenshi, 'mods', MOD);
  const meshes = join(game.kenshi, 'data/animal/meshes');
  const dir = mkdtempSync(join(tmpdir(), 'kedit-e2e-creature-'));
  const lonely = join(dir, 'lonely', 'goat.mesh');
  const own = join(dir, 'own', 'goat.mesh');
  const tex = join(dir, 'own', 'skin.dds');
  mkdirSync(join(dir, 'lonely'));
  mkdirSync(join(dir, 'own'));
  copyFileSync(join(meshes, 'goat.mesh'), lonely);
  copyFileSync(join(meshes, 'goat.mesh'), own);
  copyFileSync(join(meshes, 'goat.skeleton'), join(dir, 'own', 'goat.skeleton'));
  copyFileSync(join(game.kenshi, 'data/animal/textures/goat_diffuse_HI.dds'), tex);
  rmSync(modDir, { recursive: true, force: true });

  const { app, page } = await launch();
  try {
    const panel = await openWizard(page, MOD);
    const create = panel.getByTestId('cw-create');
    await expect(create).toBeDisabled();
    // Until a model is picked the preview shows the sample (the goat by default).
    await expect(panel.getByTestId('cw-preview')).toHaveAttribute('data-state', 'ready', { timeout: 60_000 });
    await panel.getByTestId('cw-name').fill('E2E Goatling');

    // A mesh whose skeleton is not next to it: named, and a button to pick it.
    await stubOpen(app, lonely);
    await panel.getByTestId('cw-pick-mesh').click();
    await expect(panel.getByTestId('cw-file-problem')).toContainText('goat.skeleton');
    await expect(panel.getByTestId('cw-pick-skeleton')).toBeVisible();
    await expect(create).toBeDisabled();

    // The right folder: the skeleton comes with the mesh, every clip is there, a click plays it.
    await stubOpen(app, own);
    await panel.getByTestId('cw-pick-mesh').click();
    await expect(panel.getByTestId('cw-file-problem')).toHaveCount(0);
    await expect(panel.getByTestId('cw-step-2')).toHaveAttribute('data-mark', 'ok');
    await expect(panel.locator('[data-testid="cw-clip"][data-present="false"]')).toHaveCount(0);
    expect(await panel.locator('[data-testid="cw-clip"]').count()).toBeGreaterThan(5);
    await expect(panel.getByTestId('cw-ragdoll')).toHaveValue(/goat\.phs$/i);
    const preview = panel.getByTestId('cw-preview');
    await expect(preview).toHaveAttribute('data-state', 'ready', { timeout: 60_000 });
    await panel.locator('[data-testid="cw-clip"][data-clip="walk"]').click();
    await expect(preview).toHaveAttribute('data-clip', 'walk');
    await expect(preview).toHaveAttribute('data-playing', 'true');
    await expect(panel.getByTestId('cw-scale')).toHaveValue('1');

    // No `goat.dds` next to it: the texture is picked by hand.
    await expect(panel.getByTestId('cw-texture').locator('.warn')).toBeVisible();
    await stubOpen(app, tex);
    await panel.getByTestId('cw-texture').getByRole('button').click();
    await expect(panel.getByTestId('cw-texture')).toContainText('skin.dds');

    // Sold at the farm shop, plus a start.
    const shop = panel.locator(`[data-testid="cw-trader"][data-sid="${FARM_SHOP}"]`);
    if (!(await shop.isChecked())) await shop.check();
    await expect(panel.getByTestId('cw-start-on')).toBeChecked();
    await panel.getByTestId('cw-start-from').selectOption(GUY_WITH_DOG);
    await expect(panel.getByTestId('cw-copy-to')).toContainText(`mods/${MOD}/creatures/goat/`);
    await expect(create).toBeEnabled();
    await page.screenshot({ path: join(shots, '95-creature-wizard.png') });

    await create.click();
    const done = panel.getByTestId('cw-done');
    await expect(done).toBeVisible();
    for (const f of ['goat.mesh', 'goat.skeleton', 'skin.dds']) expect(existsSync(join(modDir, 'creatures', 'goat', f))).toBe(true);
    expect(await done.getAttribute('data-start')).not.toBe('');
    // The preview now shows the new animal from the copied files.
    await expect(preview).toHaveAttribute('data-state', 'ready', { timeout: 60_000 });
    await expect(page.getByTestId('save')).toHaveClass(/primary/);
    await page.screenshot({ path: join(shots, '96-creature-done.png') });

    // The new animal opens as a record.
    await done.getByRole('button', { name: 'E2E Goatling', exact: true }).first().click();
    await expect(page.getByTestId('record-status')).toBeVisible();
  } finally {
    await closeApp(app);
    rmSync(modDir, { recursive: true, force: true });
    rmSync(dir, { recursive: true, force: true });
  }
});

const SRC = process.env.KEDIT_ANIMAL_SRC ?? 'D:/Kenshiproject/tools/creatures/donkey';

test('build «Custom Animal Test» with the donkey', async () => {
  test.skip(process.env.KEDIT_ANIMAL_TEST !== '1' || !existsSync(join(SRC, 'donkey.mesh')), 'only on request');
  const game = resolveGamePaths();
  const mod = 'Custom Animal Test';
  const modDir = join(game.kenshi, 'mods', mod);
  rmSync(join(modDir, `${mod}.mod`), { force: true });
  rmSync(join(modDir, 'creatures'), { recursive: true, force: true });

  const { app, page } = await launch();
  try {
    const panel = await openWizard(page, mod);
    await panel.getByTestId('cw-name').fill('Осёл');
    await stubOpen(app, join(SRC, 'donkey.mesh'));
    await panel.getByTestId('cw-pick-mesh').click();
    await expect(panel.getByTestId('cw-step-2')).toHaveAttribute('data-mark', 'ok');
    await expect(panel.getByTestId('cw-texture')).toContainText('donkey.dds');
    await expect(panel.locator('[data-testid="cw-clip"][data-present="false"]')).toHaveCount(0);
    await expect(panel.getByTestId('cw-ragdoll')).toHaveValue(/bull\.phs$/i);
    const preview = panel.getByTestId('cw-preview');
    await expect(preview).toHaveAttribute('data-state', 'ready', { timeout: 60_000 });
    await panel.locator('[data-testid="cw-clip"][data-clip="run"]').click();
    await expect(preview).toHaveAttribute('data-playing', 'true');
    await page.waitForTimeout(700);
    await page.screenshot({ path: join(shots, '97-donkey-wizard.png') });

    for (const sid of [FARM_SHOP, '63750-rebirth.mod']) {
      const box = panel.locator(`[data-testid="cw-trader"][data-sid="${sid}"]`);
      if ((await box.count()) > 0 && !(await box.isChecked())) await box.check();
    }
    await panel.getByTestId('cw-start-from').selectOption(GUY_WITH_DOG);
    await panel.getByTestId('cw-start-name').fill('Парень с ослом');
    await panel.getByTestId('cw-create').click();
    await expect(panel.getByTestId('cw-done')).toBeVisible();
    await expect(preview).toHaveAttribute('data-state', 'ready', { timeout: 60_000 });
    await panel.locator('[data-testid="cw-preview-clip"]').selectOption('attack1');
    await page.waitForTimeout(500);
    await page.screenshot({ path: join(shots, '98-donkey-done.png') });

    // Saved where a new mod goes (`mods/<name>/<name>.mod`); «write into the game folder?» — yes.
    await app.evaluate(({ dialog }, p) => {
      dialog.showSaveDialog = () => Promise.resolve({ canceled: false, filePath: p });
      dialog.showMessageBox = () => Promise.resolve({ response: 0, checkboxChecked: false });
    }, join(modDir, `${mod}.mod`));
    await page.getByTestId('save').click();
    await expect(page.getByTestId('save')).not.toHaveClass(/primary/, { timeout: 30_000 });
    expect(existsSync(join(modDir, `${mod}.mod`))).toBe(true);
  } finally {
    await closeApp(app);
  }
});
