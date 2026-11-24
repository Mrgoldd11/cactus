/**
 * E2E: the «Inside» panel — a building interior from the game files (Outpost, layout «Noble House»):
 * objects, card, exact coordinates, gizmo, undo, a new object from the record list,
 * deletion, writing `leveldata/interiors.level` on save. Screenshots: `out/screenshots/60-*`…
 */
import { mkdirSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { _electron as electron, expect, test } from '@playwright/test';
import { readDataFile } from '@kenshi-editor/core';

const appDir = resolve(import.meta.dirname, '..');
const shots = join(resolve(appDir, '../..'), 'out', 'screenshots');
mkdirSync(shots, { recursive: true });

const BUILDING = '727-gamedata.base';
const LAYOUT = '727-gamedata.base-Noble House';

test('Inside panel: layout, move, new object, delete, write', async () => {
  test.setTimeout(240_000);
  const userData = mkdtempSync(join(tmpdir(), 'kedit-e2e-'));
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) if (v !== undefined && k !== 'ELECTRON_RENDERER_URL') env[k] = v;
  env['KEDIT_USER_DATA'] = userData;
  env['KEDIT_LIVE_FILE'] = join(userData, 'live.json');
  const app = await electron.launch({ args: ['.'], cwd: appDir, env });
  try {
    const page = await app.firstWindow();
    await page.setViewportSize({ width: 1600, height: 950 }).catch(() => undefined);
    await expect(page.getByTestId('open-vanilla')).toBeVisible({ timeout: 60_000 });
    await page.getByTestId('open-vanilla').click();
    await expect(page.getByTestId('editor')).toBeVisible({ timeout: 120_000 });

    await page.getByTestId('window-menu').click();
    await page.getByTestId('window-panel-interior').click();
    const panel = page.getByTestId('interior-panel');
    await expect(panel).toBeVisible();
    await expect(page.getByTestId('interior-note')).toBeVisible();

    await page.getByTestId('search').fill(BUILDING);
    await page.getByTestId('record-list').locator(`[data-sid="${BUILDING}"]`).click();
    await expect(panel).toHaveAttribute('data-building', BUILDING);
    await expect(page.getByTestId('interior-layout')).toBeVisible({ timeout: 60_000 });
    await page.getByTestId('interior-layout').selectOption(LAYOUT);
    await expect(panel).toHaveAttribute('data-layout', LAYOUT);
    await expect.poll(async () => Number(await panel.getAttribute('data-objects'))).toBeGreaterThan(5);
    await expect(page.getByTestId('interior-usage')).toContainText('игра выбирает раскладку сама');
    await expect.poll(async () => Number(await panel.getAttribute('data-loading')), { timeout: 60_000 }).toBe(0);
    await page.waitForTimeout(500);
    await page.screenshot({ path: join(shots, '60-interior.png') });

    // Picking from the list: a card with floor and key.
    const first = page.getByTestId('interior-list').locator('[data-key]').first();
    const key = (await first.getAttribute('data-key'))!;
    await first.click();
    const card = page.getByTestId('interior-card');
    await expect(card).toHaveAttribute('data-key', key);
    await page.screenshot({ path: join(shots, '61-interior-card.png') });

    // Exact coordinate: x + 10 — step «Move inside», mark «edited in the mod».
    const lastStep = page.getByTestId('interior-last-step');
    const xField = page.getByTestId('interior-pos-x');
    const x0 = Number(await xField.inputValue());
    await xField.fill(String(x0 + 10));
    await xField.press('Enter');
    await expect(lastStep).toContainText('Сдвиг в интерьере');
    await expect(page.getByTestId('interior-card-edited')).toBeVisible();
    await expect(xField).toHaveValue(String(Math.round((x0 + 10) * 10) / 10));

    // Gizmo: dragging by the centre moves the object; Ctrl+Z on the window undoes.
    const view = page.getByTestId('interior-view');
    const box = (await view.boundingBox())!;
    await expect.poll(async () => (await view.getAttribute('data-gizmo')) ?? '').not.toBe('');
    const [gx, gy] = (await view.getAttribute('data-gizmo'))!.split(',').map(Number) as [number, number];
    const before = await xField.inputValue();
    await page.mouse.move(box.x + gx, box.y + gy);
    await page.mouse.move(box.x + gx + 1, box.y + gy);
    await page.mouse.down();
    await page.mouse.move(box.x + gx + 80, box.y + gy + 10, { steps: 10 });
    await page.mouse.up();
    await expect.poll(() => xField.inputValue()).not.toBe(before);
    await page.screenshot({ path: join(shots, '62-interior-move.png') });
    await view.locator('canvas').focus();
    await page.keyboard.press('Control+z');
    await expect(xField).toHaveValue(before);

    // A new object from the record list (Russian name), then deletion with Del and undo.
    await page.getByTestId('interior-place').fill('кровать');
    const hits = page.getByTestId('interior-place-hits');
    await expect(hits).toBeVisible();
    await hits.locator('[data-sid]').first().click();
    await expect(lastStep).toContainText('В интерьер');
    await expect(page.getByTestId('interior-place-note')).toBeVisible();
    await expect(card).toHaveAttribute('data-key', /-INGAME$/);
    const placed = (await card.getAttribute('data-key'))!;
    const placedTarget = (await card.getAttribute('data-target'))!;
    await page.screenshot({ path: join(shots, '63-interior-place.png') });
    await view.locator('canvas').focus();
    await page.keyboard.press('Delete');
    await expect(lastStep).toContainText('Из интерьера');
    await expect(card).toBeHidden();
    await page.getByTestId('interior-undo').click();
    await expect(lastStep).toContainText('В интерьер');

    // Save: `leveldata/interiors.level` next to the mod — the move and the new object with its state.
    const saveDir = mkdtempSync(join(tmpdir(), 'kedit-interior-save-'));
    await app.evaluate(({ dialog }, p) => {
      dialog.showSaveDialog = () => Promise.resolve({ canceled: false, filePath: p });
    }, join(saveDir, 'e2e-interior.mod'));
    await page.getByTestId('save').click();
    await expect(page.getByTestId('save')).not.toHaveClass(/primary/, { timeout: 30_000 });
    const file = readDataFile(readFileSync(join(saveDir, 'leveldata', 'interiors.level')));
    const holder = file.records.find((r) => r.stringId === LAYOUT)!;
    expect(Math.abs(holder.instances.get(key)!.position[0] - (x0 + 10))).toBeLessThan(0.01);
    expect(holder.instances.get(placed)!.target).toBe(placedTarget);
    expect(file.records.some((r) => r.stringId.startsWith(placed))).toBe(true);
  } finally {
    await app
      .evaluate(({ BrowserWindow }) => {
        for (const w of BrowserWindow.getAllWindows()) w.destroy();
      })
      .catch(() => undefined);
    await app.close().catch(() => undefined);
  }
});
