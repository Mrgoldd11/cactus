/**
 * E2E: панель «Мир» — рельеф всей карты, полёт к городу, движение WASD, замеры скорости,
 * клик по зданию — подсветка и карточка, растительность вблизи. Снимки — `out/screenshots/53-*`…`57-*`.
 */
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { _electron as electron, expect, test, type Page } from '@playwright/test';

const appDir = resolve(import.meta.dirname, '..');
const out = join(resolve(appDir, '../..'), 'out');
const shots = join(out, 'screenshots');
mkdirSync(shots, { recursive: true });

async function stat(page: Page, name: string): Promise<number> {
  return Number(await page.getByTestId('world-stats').getAttribute(`data-${name}`));
}

test('панель «Мир»: рельеф, полёт, клик по зданию — карточка', async () => {
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

    // Раскладка «Сцена»: «Мир» — первая вкладка в центре.
    await page.getByTestId('window-menu').click();
    await page.getByTestId('window-preset-scene').click();
    const view = page.getByTestId('world-view');
    await expect(view).toBeVisible();
    await expect(view).toHaveAttribute('data-ready', 'yes', { timeout: 90_000 });
    const firstMs = await stat(page, 'first-ms');
    // Цвет земли догружается — ждём обзор целиком.
    await expect.poll(() => stat(page, 'overview'), { timeout: 120_000 }).toBe(100);
    await page.waitForTimeout(500);
    await page.screenshot({ path: join(shots, '53-world-overview.png') });

    // Полёт к городу через поиск.
    await page.getByTestId('world-search').fill('Хаб');
    await page.getByTestId('world-search').press('Enter');
    await page.waitForTimeout(2500);
    await expect.poll(() => stat(page, 'models'), { timeout: 60_000 }).toBeGreaterThan(5);
    await page.waitForTimeout(3000);
    await page.screenshot({ path: join(shots, '54-world-town.png') });

    // Полёт вперёд с W — замер кадров в движении.
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

    // Назад к городу — кликом по его названию на карте; потом клик по зданию в центре экрана.
    await page.locator('[data-town="Хаб"]').first().click();
    await page.waitForTimeout(3500);
    expect(Math.abs(Number((await page.getByTestId('world-stats').getAttribute('data-camera'))!.split(',')[0]) + 50979)).toBeLessThan(3000);
    const box = (await canvas.boundingBox())!;
    let card = page.getByTestId('world-card');
    // Ищем здание: щёлкаем по сетке точек вокруг центра, пока не появится карточка.
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

    // Esc снимает выбор.
    await canvas.focus();
    await page.keyboard.press('Escape');
    await expect(card).toBeHidden();

    // Растительность вблизи: Адмаг, двойной клик по земле — подлёт, взгляд к горизонту, полёт вбок.
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
