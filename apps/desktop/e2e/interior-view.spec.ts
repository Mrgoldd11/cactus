/**
 * E2E: the «Inside» view as a picture — building shell (walls, floor, roof), floors with the
 * cutaway, the camera framing the building, the grid on the floor, a click in 3D selecting an
 * object in the list. Buildings: Metal Warehouse (layout «Warehouse», objects in world coordinates
 * far away), Outpost s-III («Noble House», two floors), Metal Wallhouse («Iron House», two floors).
 * Screenshots: `out/screenshots/70-*`…
 */
import { mkdirSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { _electron as electron, expect, test, type Page } from '@playwright/test';

const appDir = resolve(import.meta.dirname, '..');
const shots = join(resolve(appDir, '../..'), 'out', 'screenshots');
mkdirSync(shots, { recursive: true });

async function openBuilding(page: Page, sid: string, layoutName: string): Promise<void> {
  const panel = page.getByTestId('interior-panel');
  await page.getByTestId('search').fill(sid);
  await page.getByTestId('record-list').locator(`[data-sid="${sid}"]`).click();
  await expect(panel).toHaveAttribute('data-building', sid);
  const pick = page.getByTestId('interior-layout');
  await expect(pick).toBeVisible({ timeout: 60_000 });
  const value = await pick.evaluate((el, name) => {
    const o = [...(el as HTMLSelectElement).options].find((x) => x.text.startsWith(name));
    return o?.value ?? '';
  }, layoutName);
  expect(value).not.toBe('');
  await pick.selectOption(value);
  await expect(panel).toHaveAttribute('data-layout', value);
  await expect.poll(async () => Number(await panel.getAttribute('data-objects'))).toBeGreaterThan(5);
  await expect.poll(async () => Number(await panel.getAttribute('data-loading')), { timeout: 60_000 }).toBe(0);
  await page.waitForTimeout(700);
}

async function shot(page: Page, name: string): Promise<void> {
  await page.waitForTimeout(300);
  await page.getByTestId('interior-panel').screenshot({ path: join(shots, name) });
}

test('Inside view: shell, floors, framing, click in 3D', async () => {
  test.setTimeout(300_000);
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
    const view = page.getByTestId('interior-view');
    const floorPick = page.getByTestId('interior-floor-pick');

    // Metal Warehouse: one floor, the roof hidden, the far spotlights flagged and not framed.
    await openBuilding(page, '40591-Newwworld.mod', 'Warehouse');
    await expect(panel).toHaveAttribute('data-floors', '0');
    await expect(panel).toHaveAttribute('data-floor', '0');
    expect(Number(await panel.getAttribute('data-stray'))).toBeGreaterThan(10);
    await expect(page.getByTestId('interior-stray').first()).toBeVisible();
    await shot(page, '70-warehouse-floor.png');

    // A click in 3D selects the object; the list follows.
    await expect.poll(async () => (await view.getAttribute('data-probe')) ?? '').not.toBe('');
    const probe = (await view.getAttribute('data-probe'))!;
    const [key, at] = probe.split('@') as [string, string];
    const [px, py] = at.split(',').map(Number) as [number, number];
    const box = (await view.boundingBox())!;
    await page.mouse.click(box.x + px, box.y + py);
    await expect(page.getByTestId('interior-card')).toHaveAttribute('data-key', key);
    await expect(page.getByTestId('interior-list').locator(`[data-key="${key}"]`)).toHaveClass(/active/);
    await shot(page, '71-warehouse-click.png');
    await page.keyboard.press('Escape');

    // Zoomed far out: everything is still drawn (far plane follows the camera).
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    for (let i = 0; i < 12; i++) await page.mouse.wheel(0, 400);
    await shot(page, '72-warehouse-far.png');
    await view.locator('canvas').focus();
    await page.keyboard.press('f');

    await floorPick.selectOption('all');
    await expect(panel).toHaveAttribute('data-floor', 'all');
    await shot(page, '73-warehouse-all.png');

    // Outpost s-III, «Noble House»: two floors; the lower one first, the upper one cut above.
    await openBuilding(page, '727-gamedata.base', 'Noble House');
    await expect(panel).toHaveAttribute('data-floors', '0,1');
    await expect(panel).toHaveAttribute('data-floor', '0');
    await expect(page.getByTestId('interior-list').locator('[data-hidden="1"]').first()).toBeVisible();
    await shot(page, '74-outpost-floor1.png');
    await floorPick.selectOption('1');
    await expect(panel).toHaveAttribute('data-floor', '1');
    await expect(page.getByTestId('interior-list').locator('[data-hidden="1"]')).toHaveCount(0);
    await shot(page, '75-outpost-floor2.png');
    await floorPick.selectOption('all');
    await shot(page, '76-outpost-all.png');
    // A list item of an upper floor switches to that floor.
    await floorPick.selectOption('0');
    const upper = page.getByTestId('interior-list').locator('[data-hidden="1"]').first();
    const upperKey = (await upper.getAttribute('data-key'))!;
    await upper.click();
    await expect(panel).toHaveAttribute('data-floor', '1');
    await expect(page.getByTestId('interior-card')).toHaveAttribute('data-key', upperKey);
    await page.keyboard.press('Escape');

    // Metal Wallhouse, «Iron House».
    await openBuilding(page, '42175-Newwworld.mod', 'Iron House');
    await expect(panel).toHaveAttribute('data-floors', '0,1');
    await shot(page, '77-wallhouse-floor1.png');
    await floorPick.selectOption('1');
    await shot(page, '78-wallhouse-floor2.png');
  } finally {
    await app
      .evaluate(({ BrowserWindow }) => {
        for (const w of BrowserWindow.getAllWindows()) w.destroy();
      })
      .catch(() => undefined);
    await app.close().catch(() => undefined);
  }
});
