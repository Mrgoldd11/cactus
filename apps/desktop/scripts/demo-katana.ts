/**
 * Демо для владельца: открыть собранное приложение, найти катану, поменять цену (value),
 * снять скриншот и оставить окно открытым, пока его не закроют.
 *
 *   node apps/desktop/scripts/demo-katana.ts
 *
 * Настройки — временные (KEDIT_USER_DATA), реальные settings.json не трогаются.
 * Ничего не сохраняется на диск: правка живёт в окне, пока её не сохранят сами.
 */
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { _electron as electron, expect, type ElectronApplication } from '@playwright/test';

const appDir = resolve(import.meta.dirname, '..');
const outDir = resolve(appDir, '../../out');
const shots = join(outDir, 'screenshots');
const statusFile = join(outDir, 'demo-katana-status.txt');
const KATANA = '476-gamedata.base';
const NEW_PRICE = '777';

async function main(): Promise<void> {
  mkdirSync(shots, { recursive: true });
  writeFileSync(statusFile, 'starting');

  const userData = mkdtempSync(join(tmpdir(), 'kedit-demo-'));
  const env: Record<string, string> = { KEDIT_USER_DATA: userData };
  for (const [k, v] of Object.entries(process.env)) if (v !== undefined && k !== 'ELECTRON_RENDERER_URL') env[k] = v;
  // Свой файл живого подключения: не трогать файл чужого (пользовательского) редактора.
  env['KEDIT_LIVE_FILE'] = join(userData, 'live.json');

  console.log('▶ Запускаю Cactus…');
  const app: ElectronApplication = await electron.launch({ args: ['.'], cwd: appDir, env });
  const page = await app.firstWindow();
  await page.waitForLoadState('domcontentloaded');

  // Пауза, чтобы хозяин окна успел посмотреть на каждый шаг.
  const pause = (ms: number) => page.waitForTimeout(ms);

  let ok = false;
  try {
    await expect(page.getByTestId('open-vanilla')).toBeVisible({ timeout: 60_000 });
    await pause(800);
    console.log('▶ Стартовый экран — открываю «Ваниль»…');
    await page.getByTestId('open-vanilla').click();
    await expect(page.getByTestId('editor')).toBeVisible({ timeout: 120_000 });
    await app.evaluate(({ BrowserWindow }) => {
      BrowserWindow.getAllWindows()[0]?.setSize(1600, 1000);
    });
    await pause(700);
    await page.screenshot({ path: join(shots, 'demo-1-editor.png') });

    console.log('▶ Ищу катану…');
    await page.getByTestId('search').fill('katana');
    await pause(700);
    const row = page.getByTestId('record-list').locator(`[data-sid="${KATANA}"]`);
    await expect(row).toBeVisible({ timeout: 30_000 });
    await row.click();
    await expect(page.getByTestId('record-sid')).toHaveText(KATANA);
    console.log(`  найдена запись: ${await page.getByTestId('record-name').inputValue()} (${KATANA})`);
    await pause(600);
    await page.screenshot({ path: join(shots, 'demo-2-katana.png') });

    console.log('▶ Меняю цену (поле value)…');
    await page.getByTestId('field-filter').fill('value');
    await pause(500);
    const input = page.getByTestId('field-value');
    await expect(input).toBeVisible();
    const original = await input.inputValue();
    await input.fill(NEW_PRICE);
    await input.press('Enter');
    await expect(input).toHaveValue(NEW_PRICE);
    await pause(700);

    const status = (await page.getByTestId('record-status').textContent()) ?? '';
    const saveHot = await page.getByTestId('save').evaluate((el) => el.classList.contains('primary'));
    console.log(`  цена: ${original} → ${NEW_PRICE}; статус записи: «${status.trim()}»; кнопка сохранения: ${saveHot ? 'горит' : 'нет'}`);

    const shot = join(shots, 'demo-katana-price.png');
    await page.screenshot({ path: shot });
    console.log(`✔ Скриншот: ${shot}`);
    writeFileSync(statusFile, `ok ${original}->${NEW_PRICE}`);
    ok = true;
  } catch (e) {
    console.error('✖ Ошибка сценария:', e);
    writeFileSync(statusFile, `fail ${String(e)}`);
    try {
      await page.screenshot({ path: join(shots, 'demo-katana-fail.png') });
    } catch {
      /* окно могло не открыться */
    }
  }

  console.log(ok ? '✔ Готово. Окно оставляю открытым — закрой его, когда посмотришь.' : '✖ Не получилось. Окно оставляю открытым для разбора.');
  // Держим процесс, пока окно не закроют: приложение живёт, пока жив скрипт.
  await new Promise<void>((resolve) => {
    app.on('close', () => {
      resolve();
    });
  });
  console.log('■ Окно закрыто, выхожу.');
}

main().catch((e: unknown) => {
  console.error(e);
  process.exit(1);
});
