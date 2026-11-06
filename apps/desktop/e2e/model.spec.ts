/**
 * E2E: панель «Модель» — 3D-модель записи из файлов игры (катана, дом), снимки окна и
 * сохранение иконки (диалог сохранения подменён).
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

test('панель «Модель»: катана и дом из файлов игры, иконка', async () => {
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

    // Раскладка «Сцена»: «Модель» — вкладка в центре рядом с «Миром».
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

    // Иконка: PNG с подписью формата.
    await view.getByTestId('model-icon').click();
    await expect(view.getByTestId('model-icon-saved')).toBeVisible();
    expect(existsSync(iconPath)).toBe(true);
    expect([...readFileSync(iconPath).subarray(1, 4)].map((c) => String.fromCharCode(c)).join('')).toBe('PNG');

    // Здание из частей с текстурами материалов.
    await page.getByTestId('search').fill('Raised House');
    await page.getByTestId('record-list').locator(`[data-sid="${HOUSE}"]`).click();
    await expect(view).toHaveAttribute('data-sid', HOUSE);
    await expect(view).toHaveAttribute('data-state', 'ready', { timeout: 60_000 });
    await expect(view.getByTestId('model-stats')).toContainText('частей');
    await page.screenshot({ path: join(shots, '51-model-house.png') });

    // Клик по дому: часть подсвечивается, рядом — карточка «Что внутри» с переходами к записям.
    const canvas = view.getByTestId('model-canvas');
    const box = (await canvas.boundingBox())!;
    await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
    const picked = await canvas.getAttribute('data-picked');
    expect(picked).toMatch(/-gamedata\.base$/);
    const card = view.getByTestId('inside-card');
    await expect(card).toHaveAttribute('data-sid', picked!);
    await expect(card).toContainText('BUILDING_PART');
    await page.screenshot({ path: join(shots, '52-model-inside.png') });
    // Клик мимо модели снимает выбор.
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
