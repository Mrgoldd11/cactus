/**
 * E2E: the «Мир» panel — terrain of the whole map, flight to a town, WASD movement, speed measurements,
 * click on a building — highlight and card, foliage up close. Screenshots: `out/screenshots/53-*`…`57-*`.
 */
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { _electron as electron, expect, test, type Page } from '@playwright/test';
import { readDataFile } from '@kenshi-editor/core';

const appDir = resolve(import.meta.dirname, '..');
const out = join(resolve(appDir, '../..'), 'out');
const shots = join(out, 'screenshots');
mkdirSync(shots, { recursive: true });

async function stat(page: Page, name: string): Promise<number> {
  return Number(await page.getByTestId('world-stats').getAttribute(`data-${name}`));
}

test('World panel: terrain, flight, click on a building shows a card', async () => {
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

    // «Сцена» layout: «Мир» is the first tab in the centre.
    await page.getByTestId('window-menu').click();
    await page.getByTestId('window-preset-scene').click();
    const view = page.getByTestId('world-view');
    await expect(view).toBeVisible();
    await expect(view).toHaveAttribute('data-ready', 'yes', { timeout: 90_000 });
    const firstMs = await stat(page, 'first-ms');
    // Ground colour loads later — wait for the whole overview.
    await expect.poll(() => stat(page, 'overview'), { timeout: 120_000 }).toBe(100);
    await page.waitForTimeout(500);
    await page.screenshot({ path: join(shots, '53-world-overview.png') });

    // Flight to a town via search.
    await page.getByTestId('world-search').fill('Хаб');
    await page.getByTestId('world-search').press('Enter');
    await page.waitForTimeout(2500);
    await expect.poll(() => stat(page, 'models'), { timeout: 60_000 }).toBeGreaterThan(5);
    await page.waitForTimeout(3000);
    await page.screenshot({ path: join(shots, '54-world-town.png') });

    // Flying forward with W — frame measurement while moving.
    const canvas = page.getByTestId('world-canvas');
    await canvas.focus();
    await page.keyboard.down('KeyW');
    await page.waitForTimeout(2500);
    const fps = await stat(page, 'fps');
    const frameMs = await stat(page, 'frame-ms');
    await page.keyboard.up('KeyW');
    const perf: Record<string, number> = { firstMs, fps, frameMs };
    for (const k of ['heap-mb', 'models', 'markers', 'tiles', 'detailed', 'protos', 'failed']) perf[k] = await stat(page, k);
    writeFileSync(join(out, 'world-perf.json'), JSON.stringify(perf, null, 2));
    expect(fps).toBeGreaterThan(20);

    // Back to the town by clicking its name on the map; then a click on a building in the screen centre.
    await page.locator('[data-town="Хаб"]').first().click();
    await page.waitForTimeout(3500);
    expect(Math.abs(Number((await page.getByTestId('world-stats').getAttribute('data-camera'))!.split(',')[0]) + 50979)).toBeLessThan(3000);
    const box = (await canvas.boundingBox())!;
    let card = page.getByTestId('world-card');
    // Find a building: click a grid of points around the centre until a card appears.
    outer: for (let r = 0; r < 6; r++)
      for (let a = 0; a < Math.max(1, r * 6); a++) {
        const x = box.x + box.width / 2 + Math.cos((a / Math.max(1, r * 6)) * Math.PI * 2) * r * 40;
        const y = box.y + box.height / 2 + Math.sin((a / Math.max(1, r * 6)) * Math.PI * 2) * r * 40;
        await page.mouse.move(x, y);
        await page.mouse.click(x, y);
        if (await card.isVisible()) break outer;
      }
    card = page.getByTestId('world-card');
    await expect(card).toBeVisible();
    await expect(card.getByTestId('inside-card')).toBeVisible();
    await page.screenshot({ path: join(shots, '55-world-card.png') });

    // World edit: gizmo move along the X arrow, undo and redo (Ctrl+Z / Ctrl+Y), G / R, deletion.
    await expect(page.getByTestId('world-edit-bar')).toBeVisible();
    await page.getByTestId('world-mode-move').click();
    await page.getByTestId('world-grid').selectOption('0');
    const gizmoAttr = async (): Promise<string> => (await page.getByTestId('world-stats').getAttribute('data-gizmo')) ?? '';
    await expect.poll(gizmoAttr, { timeout: 5000 }).not.toBe('');
    const [cx, cy, ax, ay] = (await gizmoAttr()).split(',').map(Number) as [number, number, number, number];
    const len = Math.hypot(ax - cx, ay - cy) || 1;
    const posText = page.getByTestId('world-card-pos');
    const before = await posText.textContent();
    await page.mouse.move(box.x + ax, box.y + ay);
    await page.mouse.move(box.x + ax + 1, box.y + ay);
    await page.mouse.down();
    await page.mouse.move(box.x + ax + ((ax - cx) / len) * 120, box.y + ay + ((ay - cy) / len) * 120, { steps: 12 });
    await page.mouse.up();
    const lastStep = page.getByTestId('world-last-step');
    await expect(lastStep).toContainText('Сдвиг');
    const after = await posText.textContent();
    expect(after).not.toBe(before);
    await expect(page.getByTestId('world-card-edited')).toBeVisible();
    await page.screenshot({ path: join(shots, '58-world-move.png') });
    await canvas.focus();
    await page.keyboard.press('Control+z');
    await expect(posText).toHaveText(before!);
    await expect(lastStep).toHaveText('');
    await page.keyboard.press('Control+y');
    await expect(posText).toHaveText(after!);
    // Save writes the zone file into leveldata next to the mod — lossless, with the new position.
    const saveDir = mkdtempSync(join(tmpdir(), 'kedit-world-save-'));
    const modPath = join(saveDir, 'e2e-world.mod');
    await app.evaluate(({ dialog }, p) => {
      dialog.showSaveDialog = () => Promise.resolve({ canceled: false, filePath: p });
    }, modPath);
    await page.getByTestId('save').click();
    await expect(page.getByTestId('save')).not.toHaveClass(/primary/, { timeout: 30_000 });
    const zones = readdirSync(join(saveDir, 'leveldata')).filter((n) => n.endsWith('.zone'));
    expect(zones).toHaveLength(1);
    const holderId = (await card.getAttribute('data-holder'))!;
    const instKey = (await card.getAttribute('data-key'))!;
    const zone = readDataFile(readFileSync(join(saveDir, 'leveldata', zones[0]!)));
    const holder = zone.records.find((r) => r.stringId === holderId)!;
    const inst = holder.instances.get(instKey)!;
    expect(Math.abs(inst.position[0] - Number(after!.trim().split(/\s+/)[0]))).toBeLessThan(1);
    await canvas.focus();
    await page.keyboard.press('KeyR');
    await expect(page.getByTestId('world-mode-rotate')).toHaveAttribute('aria-pressed', 'true');
    await page.screenshot({ path: join(shots, '59-world-rotate.png') });
    await page.keyboard.press('KeyG');
    await expect(page.getByTestId('world-mode-move')).toHaveAttribute('aria-pressed', 'true');
    await page.keyboard.press('Delete');
    await expect(card).toBeHidden();
    await expect(lastStep).toContainText('Удаление');
    await page.getByTestId('world-undo').click();
    await expect(lastStep).toContainText('Сдвиг');
    await page.getByTestId('world-undo').click();
    await expect(lastStep).toHaveText('');
    await expect(page.getByTestId('world-undo')).toBeDisabled();

    // «Поставить…»: clicking the field opens the whole list (it can be scrolled), text narrows it, Esc closes.
    const placeBox = page.getByTestId('world-place');
    const placeHits = page.getByTestId('world-place-hits');
    await placeBox.click();
    await expect(placeHits).toBeVisible();
    await expect(placeHits.locator('[data-sid]').first()).toBeVisible();
    const allCount = Number((await placeHits.textContent())?.match(/(\d+) \/ (\d+)/)?.[2]);
    expect(allCount).toBeGreaterThan(100);
    await page.screenshot({ path: join(shots, '64-world-place-list.png') });
    await placeBox.fill('Storm House');
    await expect(placeHits.locator('[data-sid]').first()).toContainText(/Storm|Крепк/i);
    await page.keyboard.press('Escape');
    await expect(placeHits).toBeHidden();
    await placeBox.fill('Крепкий дом');
    await placeHits.locator('[data-sid]').first().click();
    await expect(placeHits).toBeHidden();
    await expect(placeBox).toHaveValue('');
    while (await page.getByTestId('world-undo').isEnabled()) await page.getByTestId('world-undo').click();

    // Esc clears the selection.
    await canvas.focus();
    await page.keyboard.press('Escape');
    await expect(card).toBeHidden();

    // Foliage up close: Admag, double-click on the ground — fly in, look at the horizon, fly sideways.
    await page.getByTestId('world-search').fill('Адмаг');
    await page.getByTestId('world-search').press('Enter');
    await page.waitForTimeout(4000);
    await page.mouse.dblclick(box.x + box.width / 2, box.y + box.height * 0.25);
    await page.waitForTimeout(3000);
    await page.keyboard.press('Escape');
    await page.mouse.dblclick(box.x + box.width / 2, box.y + box.height * 0.3);
    await page.waitForTimeout(3000);
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    await page.mouse.down({ button: 'right' });
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2 - 150, { steps: 10 });
    await page.mouse.up({ button: 'right' });
    await expect.poll(() => stat(page, 'foliage-drawn'), { timeout: 60_000 }).toBeGreaterThan(50);
    await page.waitForTimeout(2000);
    await canvas.focus();
    await page.keyboard.press('Escape');
    await page.screenshot({ path: join(shots, '57-world-foliage.png') });
    await canvas.focus();
    await page.keyboard.down('KeyD');
    await page.waitForTimeout(2500);
    perf['foliageFps'] = await stat(page, 'fps');
    await page.keyboard.up('KeyD');
    for (const k of ['foliage', 'foliage-drawn', 'triangles', 'calls']) perf[k] = await stat(page, k);
    writeFileSync(join(out, 'world-perf.json'), JSON.stringify(perf, null, 2));
    expect(perf['foliageFps']).toBeGreaterThan(20);
  } finally {
    await app
      .evaluate(({ BrowserWindow }) => {
        for (const w of BrowserWindow.getAllWindows()) w.destroy();
      })
      .catch(() => undefined);
    await app.close().catch(() => undefined);
  }
});
