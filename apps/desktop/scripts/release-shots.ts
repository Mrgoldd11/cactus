/**
 * Скриншоты для релиза (docs/release/screenshots) с собранной беты, 1920x1080, русский интерфейс.
 *   node apps/desktop/scripts/release-shots.ts [путь к Cactus.exe] [номера шотов: 01 02 ...]
 * В папку игры ничего не пишет: временная папка данных, правки только в памяти.
 */
import { mkdirSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { _electron as electron, type Page } from '@playwright/test';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';

const app = resolve(import.meta.dirname, '..');
const root = resolve(app, '../..');
const exe = process.argv[2] ?? join(root, 'out/beta/Cactus/Cactus.exe');
const only = new Set(process.argv.slice(3));
const LANG = process.env['SHOTS_LANG'] === 'en' ? 'en' : 'ru';
const EN = LANG === 'en';
const shots = join(root, 'docs/release/screenshots', LANG);
mkdirSync(shots, { recursive: true });

const userData = mkdtempSync(join(tmpdir(), 'cactus-shots-'));
const env: Record<string, string> = {};
for (const [k, v] of Object.entries(process.env)) if (v !== undefined && k !== 'ELECTRON_RUN_AS_NODE') env[k] = v;
env['KEDIT_USER_DATA'] = userData;
env['KEDIT_LIVE_FILE'] = join(userData, 'live.json');

const GENERIC = 'C:\\Program Files (x86)\\Steam\\steamapps\\common\\Kenshi';
async function hidePaths(page: Page): Promise<void> {
  await page.evaluate((generic) => {
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    for (let n = walker.nextNode(); n; n = walker.nextNode()) {
      if (n.textContent && /^[A-Za-z]:\\.*kenshi$/i.test(n.textContent.trim())) n.textContent = generic;
    }
  }, GENERIC);
}

// SDK лежит только в packages/mcp — подключаем по абсолютному пути.
const sdk = createRequire(join(root, 'packages/mcp/package.json'));
const { Client } = await import(pathToFileURL(sdk.resolve('@modelcontextprotocol/sdk/client/index.js')).href);
const { StdioClientTransport } = await import(pathToFileURL(sdk.resolve('@modelcontextprotocol/sdk/client/stdio.js')).href);

let aiClient: { close(): Promise<void> } | undefined;
const KATANA = '476-gamedata.base';
const electronApp = await electron.launch({ executablePath: exe, args: [], env });
const page = await electronApp.firstWindow();
const log = (s: string): void => console.log(s);
async function snap(name: string, fn: () => Promise<void>): Promise<void> {
  if (only.size && !only.has(name.split('-')[0]!)) return;
  try {
    await fn();
    await page.waitForTimeout(400);
    await page.screenshot({ path: join(shots, `${name}.png`) });
    log(`ok ${name}`);
  } catch (e) {
    log(`FAIL ${name}: ${(e as Error).message.split('\n')[0]}`);
    await page.screenshot({ path: join(root, 'out', `fail-${name}.png`) }).catch(() => undefined);
  }
}
async function menu(id: string): Promise<void> {
  await page.getByTestId('window-menu').click();
  await page.getByTestId(id).click();
}

try {
  await electronApp.evaluate(({ BrowserWindow }) => {
    const w = BrowserWindow.getAllWindows()[0]!;
    w.setContentSize(1920, 1080);
    w.center();
  });
  // Окно упирается в высоту экрана — задаём ровно 1920x1080 через эмуляцию размера страницы.
  const cdp = await page.context().newCDPSession(page);
  await cdp.send('Emulation.setDeviceMetricsOverride', { width: 1920, height: 1080, deviceScaleFactor: 1, mobile: false });
  await page.getByTestId('open-vanilla').waitFor({ timeout: 60_000 });
  await page.getByTestId('mods-table').waitFor();
  if (EN) await page.getByTestId('lang-switch').getByText('EN', { exact: true }).click();
  await page.waitForTimeout(500);
  log(`viewport ${JSON.stringify(await page.evaluate(() => [innerWidth, innerHeight]))}`);

  // Новый временный мод: правки остаются в памяти, не сохраняются.
  await page.getByTestId('new-mod-name').fill('Katana Demo');
  await page.getByTestId('create-mod').click();
  await page.getByTestId('editor').waitFor({ timeout: 120_000 });
  await page.getByTestId('search').fill('katana');
  await page.getByTestId('record-list').locator(`[data-sid="${KATANA}"]`).click();

  await snap('01-main', async () => {
    await page.waitForTimeout(800);
  });
  await snap('02-where', async () => {
    await page.getByTestId('tab-where').click();
    await page.getByTestId('where').waitFor({ timeout: 60_000 });
    await page.waitForTimeout(2500);
  });
  await snap('03-fields', async () => {
    await page.getByTestId('tab-fields').click();
    await page.getByTestId('field-filter').fill('cut damage');
    const input = page.getByTestId('field-cut damage multiplier');
    await input.fill('1.7');
    await input.press('Enter');
    await page.waitForTimeout(400);
  });
  await snap('04-history', async () => {
    await page.getByTestId('field-filter').fill('');
    await menu('window-panel-history');
  });
  await snap('05-bulk', async () => {
    await menu('window-panel-bulk');
    await page.getByTestId('bulk-panel').waitFor();
  });
  await snap('06-dialogue', async () => {
    await page.getByTestId('window-menu').click();
    await page.getByTestId('window-preset-dialogue').click();
    await page.waitForTimeout(1500);
    await page.getByTestId('search').fill(EN ? 'Beep' : 'Бип');
    await page.getByTestId('record-list').locator('[data-sid="57390-rebirth.mod"]').click();
    const said = page.getByTestId('player').getByTestId('pl-step').first().getByTestId('pl-said');
    await said.waitFor({ timeout: 60_000 });
    await said.getByRole('button').click();
    await page.getByTestId('dialogue-graph').locator('[data-testid="dg-node"] .dg-text').first().waitFor({ timeout: 60_000 });
    await page.waitForTimeout(1200);
  });
  await snap('07-world', async () => {
    await page.getByTestId('window-menu').click();
    await page.getByTestId('window-preset-scene').click();
    await page.getByTestId('world-view').waitFor();
    await page.waitForFunction(() => document.querySelector('[data-testid="world-view"]')?.getAttribute('data-ready') === 'yes', null, { timeout: 90_000 });
    await page.waitForTimeout(8000);
    await page.getByTestId('world-search').fill(EN ? 'Hub' : 'Хаб');
    await page.getByTestId('world-search').press('Enter');
    await page.waitForTimeout(9000);
  });
  await snap('08-ai', async () => {
    await page.getByTestId('window-menu').click();
    await page.getByTestId('window-preset-data').click();
    await menu('window-panel-ai');
    await page.getByTestId('search').fill('katana');
    await page.getByTestId('record-list').locator(`[data-sid="${KATANA}"]`).click();
    const client = new Client({ name: 'shots', version: '1.0.0' });
    await client.connect(
      new StdioClientTransport({ command: process.execPath, args: [join(exe, '..', 'resources/mcp/kenshi-mcp.mjs')], env }),
    );
    log(JSON.stringify(await client.callTool({ name: 'connect_editor', arguments: {} })).slice(0, 300));
    const r = await client.callTool({
      name: 'edit',
      arguments: {
        label: EN ? 'Make the katana lighter and rename it' : 'Облегчить катану и переименовать',
        ops: [
          { op: 'set', id: KATANA, field: 'weight kg', value: 1 },
          { op: 'rename', id: KATANA, name: EN ? 'Light Katana' : 'Лёгкая катана' },
        ],
      },
    });
    log(JSON.stringify(r).slice(0, 400));
    await page.getByTestId('ai-changeset').waitFor({ timeout: 30_000 });
    aiClient = client;
    await page.waitForTimeout(2500);
  });
} finally {
  await aiClient?.close().catch(() => undefined);
  await electronApp.evaluate(({ BrowserWindow }) => { for (const w of BrowserWindow.getAllWindows()) w.destroy(); }).catch(() => undefined);
  await electronApp.close().catch(() => undefined);
}
