/**
 * E2E: the «Model» panel — the 3D model of a record from the game files (katana, house), window screenshots and
 * saving the icon (the save dialog is stubbed); races and animals skinned to their skeletons, playing clips.
 */
import { existsSync, mkdirSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { _electron as electron, expect, test } from '@playwright/test';

const appDir = resolve(import.meta.dirname, '..');
const shots = join(resolve(appDir, '../..'), 'out', 'screenshots');
mkdirSync(shots, { recursive: true });

const KATANA = '476-gamedata.base';
const HOUSE = '620-gamedata.base';

test('Model panel: katana and house from the game files, icon', async () => {
  const userData = mkdtempSync(join(tmpdir(), 'kedit-e2e-'));
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) if (v !== undefined && k !== 'ELECTRON_RENDERER_URL') env[k] = v;
  env['KEDIT_USER_DATA'] = userData;
  env['KEDIT_LIVE_FILE'] = join(userData, 'live.json');
  const app = await electron.launch({ args: ['.'], cwd: appDir, env });
  const iconPath = join(userData, 'katana.png');
  try {
    await app.evaluate(({ dialog }, path) => {
      dialog.showSaveDialog = () => Promise.resolve({ canceled: false, filePath: path });
    }, iconPath);
    const page = await app.firstWindow();
    await expect(page.getByTestId('open-vanilla')).toBeVisible({ timeout: 60_000 });
    await page.getByTestId('open-vanilla').click();
    await expect(page.getByTestId('editor')).toBeVisible({ timeout: 120_000 });

    // «Scene» layout: «Model» is a tab in the centre next to «World».
    await page.getByTestId('window-menu').click();
    await page.getByTestId('window-preset-scene').click();
    await page.locator('.dv-tab', { hasText: '◈ Модель' }).click();
    const view = page.getByTestId('model-view');
    await expect(view).toBeVisible();
    await expect(view).toHaveAttribute('data-state', 'empty');

    await page.getByTestId('search').fill('katana');
    await page.getByTestId('record-list').locator(`[data-sid="${KATANA}"]`).click();
    await expect(view).toHaveAttribute('data-sid', KATANA);
    await expect(view).toHaveAttribute('data-state', 'ready', { timeout: 60_000 });
    expect(Number(await view.getAttribute('data-triangles'))).toBeGreaterThan(100);
    await page.screenshot({ path: join(shots, '50-model-katana.png') });

    // Icon: PNG with a format caption.
    await view.getByTestId('model-icon').click();
    await expect(view.getByTestId('model-icon-saved')).toBeVisible();
    expect(existsSync(iconPath)).toBe(true);
    expect([...readFileSync(iconPath).subarray(1, 4)].map((c) => String.fromCharCode(c)).join('')).toBe('PNG');

    // A building made of parts with material textures.
    await page.getByTestId('search').fill('Raised House');
    await page.getByTestId('record-list').locator(`[data-sid="${HOUSE}"]`).click();
    await expect(view).toHaveAttribute('data-sid', HOUSE);
    await expect(view).toHaveAttribute('data-state', 'ready', { timeout: 60_000 });
    await expect(view.getByTestId('model-stats')).toContainText('частей');
    await page.screenshot({ path: join(shots, '51-model-house.png') });

    // Click on the house: a part is highlighted, next to it a «What is inside» card with jumps to records.
    const canvas = view.getByTestId('model-canvas');
    const box = (await canvas.boundingBox())!;
    await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
    const picked = await canvas.getAttribute('data-picked');
    expect(picked).toMatch(/-gamedata\.base$/);
    const card = view.getByTestId('inside-card');
    await expect(card).toHaveAttribute('data-sid', picked!);
    await expect(card).toContainText('BUILDING_PART');
    await page.screenshot({ path: join(shots, '52-model-inside.png') });
    // Clicking outside the model clears the selection.
    await page.mouse.click(box.x + 8, box.y + 8);
    await expect(card).toBeHidden();
  } finally {
    await app
      .evaluate(({ BrowserWindow }) => {
        for (const w of BrowserWindow.getAllWindows()) w.destroy();
      })
      .catch(() => undefined);
    await app.close();
  }
});

const GREENLANDER = '17-gamedata.quack';
const SHEK = '5276-chareditor.mod';
const HIVE_PRINCE = '5346-stick_people.mod';
const GOAT = '3992-gamedata.base';

test('Model panel: races and animals are skinned and play their clips', async () => {
  const userData = mkdtempSync(join(tmpdir(), 'kedit-e2e-'));
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) if (v !== undefined && k !== 'ELECTRON_RENDERER_URL') env[k] = v;
  env['KEDIT_USER_DATA'] = userData;
  env['KEDIT_LIVE_FILE'] = join(userData, 'live.json');
  const app = await electron.launch({ args: ['.'], cwd: appDir, env });
  try {
    const page = await app.firstWindow();
    await expect(page.getByTestId('open-vanilla')).toBeVisible({ timeout: 60_000 });
    await page.getByTestId('open-vanilla').click();
    await expect(page.getByTestId('editor')).toBeVisible({ timeout: 120_000 });
    await page.getByTestId('window-menu').click();
    await page.getByTestId('window-preset-scene').click();
    await page.locator('.dv-tab', { hasText: '◈ Модель' }).click();
    const view = page.getByTestId('model-view');
    const canvas = view.getByTestId('model-canvas');

    const open = async (search: string, sid: string): Promise<void> => {
      await page.getByTestId('search').fill(search);
      await page.getByTestId('record-list').locator(`[data-sid="${sid}"]`).click();
      await expect(view).toHaveAttribute('data-sid', sid);
      await expect(view).toHaveAttribute('data-state', 'ready', { timeout: 60_000 });
    };

    // Greenlander: the human body on the human skeleton with its 174 clips.
    await open('Greenlander', GREENLANDER);
    await expect(view).toHaveAttribute('data-bones', '30');
    expect(Number(await view.getAttribute('data-clips'))).toBeGreaterThan(150);
    await expect(view.getByTestId('model-rig-note')).toHaveCount(0);
    const still = await canvas.screenshot();
    await page.screenshot({ path: join(shots, '53-model-race-bind.png') });

    // A clip at a fixed time changes the picture; the bones can be drawn over it.
    await view.getByTestId('model-clip').selectOption('walk lower');
    await expect(view).toHaveAttribute('data-clip', 'walk lower');
    await view.getByTestId('model-time').fill('0.4');
    await view.getByTestId('model-bones').check();
    await page.waitForTimeout(300);
    const posed = await canvas.screenshot();
    expect(posed.equals(still)).toBe(false);
    await page.screenshot({ path: join(shots, '54-model-race-walk-bones.png') });

    // Play runs the clock, pause stops it.
    await view.getByTestId('model-play').click();
    await expect(view).toHaveAttribute('data-playing', 'true');
    await page.waitForTimeout(500);
    const a = await canvas.screenshot();
    await page.waitForTimeout(300);
    const b = await canvas.screenshot();
    expect(a.equals(b)).toBe(false);
    await view.getByTestId('model-play').click();
    await expect(view).toHaveAttribute('data-playing', 'false');

    // The female body keeps the chosen clip.
    await view.getByTestId('model-female').check();
    await expect(view).toHaveAttribute('data-state', 'ready', { timeout: 60_000 });
    await expect(view).toHaveAttribute('data-clip', 'walk lower');
    await page.screenshot({ path: join(shots, '55-model-race-female.png') });
    await view.getByTestId('model-female').uncheck();

    // Shek, Hive Prince (other bodies on the human skeleton) and the goat (its own skeleton).
    for (const [search, sid, clip, shot] of [
      [SHEK, SHEK, 'run lower', '56-model-shek.png'],
      [HIVE_PRINCE, HIVE_PRINCE, 'idle_stand_relax', '57-model-hive.png'],
      [GOAT, GOAT, undefined, '58-model-goat.png'],
    ] as const) {
      await open(search, sid);
      expect(Number(await view.getAttribute('data-clips')), sid).toBeGreaterThan(5);
      const pick = clip ?? (await view.getByTestId('model-clip').locator('option').nth(1).getAttribute('value'))!;
      await view.getByTestId('model-clip').selectOption(pick);
      const max = Number(await view.getByTestId('model-time').getAttribute('max'));
      await view.getByTestId('model-time').fill(String(Math.round(max * 50) / 100));
      await page.waitForTimeout(300);
      await page.screenshot({ path: join(shots, shot) });
    }
  } finally {
    await app
      .evaluate(({ BrowserWindow }) => {
        for (const w of BrowserWindow.getAllWindows()) w.destroy();
      })
      .catch(() => undefined);
    await app.close();
  }
});
