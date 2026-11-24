/**
 * UX inventory screenshots (Russian UI, 1400×850): the paths a modder takes through the app,
 * including the recent race tools. Uses the build in `out/` like the e2e tests; works on a new
 * mod, nothing is saved.
 *
 *   node apps/desktop/scripts/ux-shots.ts [out-dir]
 */
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { _electron as electron } from '@playwright/test';

const appDir = resolve(import.meta.dirname, '..');
const outDir = resolve(process.argv[2] ?? join(appDir, '../../out/screenshots/ux'));
mkdirSync(outDir, { recursive: true });

const userData = mkdtempSync(join(tmpdir(), 'kedit-ux-'));
const env: Record<string, string> = {};
for (const [k, v] of Object.entries(process.env)) if (v !== undefined && k !== 'ELECTRON_RENDERER_URL' && k !== 'ELECTRON_RUN_AS_NODE') env[k] = v;
env['KEDIT_USER_DATA'] = userData;
env['KEDIT_LIVE_FILE'] = join(userData, 'live.json');

const KATANA = '476-gamedata.base';
const GREENLANDER = '17-gamedata.quack';
const BEEP = '57390-rebirth.mod';

const app = await electron.launch({ args: ['.'], cwd: appDir, env });
const page = await app.firstWindow();
await page.waitForLoadState('domcontentloaded');
const cdp = await page.context().newCDPSession(page);
await cdp.send('Emulation.setDeviceMetricsOverride', { width: 1400, height: 850, deviceScaleFactor: 1, mobile: false });

const notes: Record<string, unknown> = {};

async function shot(name: string, fn: () => Promise<void> = () => Promise.resolve(), wait = 600): Promise<void> {
  try {
    await fn();
    await page.waitForTimeout(wait);
    await page.screenshot({ path: join(outDir, `${name}.png`) });
    // What a user sees as entry points: toolbar buttons and open panel tabs.
    notes[name] = await page.evaluate(() => ({
      tabs: [...document.querySelectorAll('.dv-tab')].map((e) => e.textContent.trim()),
      listButtons: [...document.querySelectorAll('.list-toolbar button, .list-actions button')].map((e) => e.textContent.trim()),
    }));
    console.log(`ok ${name}`);
  } catch (e) {
    console.log(`FAIL ${name}: ${(e as Error).message.split('\n')[0]}`);
    await page.screenshot({ path: join(outDir, `${name}-FAIL.png`) }).catch(() => undefined);
  }
}

const esc = (): Promise<void> => page.keyboard.press('Escape');
const preset = async (p: string): Promise<void> => {
  await page.getByTestId('window-menu').click();
  await page.getByTestId(`window-preset-${p}`).click();
  await page.waitForTimeout(700);
};
const select = async (query: string, sid: string): Promise<void> => {
  await page.getByTestId('search').first().fill(query);
  await page.getByTestId('record-list').first().locator(`[data-sid="${sid}"]`).click();
};
const openPanel = async (id: string): Promise<void> => {
  await page.getByTestId('window-menu').click();
  const item = page.getByTestId(`window-panel-${id}`);
  if ((await item.getAttribute('aria-checked')) === 'true') await esc();
  else await item.click();
};

try {
  await app.evaluate(({ BrowserWindow }) => {
    BrowserWindow.getAllWindows()[0]?.setSize(1500, 900);
  });
  await page.getByTestId('open-vanilla').waitFor({ timeout: 60_000 });
  await page.getByTestId('lang-current').click();
  await page.getByTestId('lang-ru').click();
  await page.waitForTimeout(1500);
  await shot('01-start');

  await page.getByTestId('new-mod-name').fill('Мой мод');
  await page.getByTestId('create-mod').click();
  await page.getByTestId('editor').waitFor({ timeout: 120_000 });
  await preset('data');
  await shot('02-new-mod-empty');
  await shot('03-katana-fields', () => select('katana', KATANA));
  for (const tab of ['back', 'where', 'diff']) await shot(`04-tab-${tab}`, () => page.getByTestId(`tab-${tab}`).click(), tab === 'where' ? 2500 : 600);
  await page.getByTestId('tab-fields').click();
  await shot('05-mod-menu', () => page.getByTestId('mod-menu').click());
  await esc();
  await shot('05b-create-menu', () => page.getByTestId('create-menu').click());
  await esc();
  await shot('06-window-menu', () => page.getByTestId('window-menu').click());
  await esc();

  // Races: race actions live on the race card of the inspector.
  await page.getByTestId('search').first().fill('');
  await page.getByTestId('cat-Races').click();
  await shot('10-races-list', () => page.locator(`[data-testid="record-list"] [data-sid="${GREENLANDER}"]`).click());
  await shot('11-race-model', () => openPanel('model'), 4000);
  await shot('12-new-race-modal', async () => {
    await page.locator('.dv-tab', { hasText: 'Инспектор' }).first().click();
    await page.getByTestId('race-card-new-from').click();
    await page.getByTestId('new-race-name').fill('Мохолюды');
  });
  await shot('13-race-compat', async () => {
    await page.getByTestId('new-race-create').click();
    await page.getByTestId('race-compat-panel').waitFor();
  }, 2500);
  await shot('14-race-compat-scrolled', async () => {
    await page.getByTestId('race-compat-panel').evaluate((e) => {
      const s = e.querySelector('.panel-scroll, .rc-groups') ?? e;
      s.scrollTop = 600;
    });
  });
  await shot('15-race-compat-applied', async () => {
    await page.getByTestId('rc-apply').click();
  }, 1500);
  await shot('16-add-anims', async () => {
    await page.locator('[data-testid="record-list"] .list-row.selected').first().click();
    await page.locator('.dv-tab', { hasText: 'Инспектор' }).first().click();
    await page.getByTestId('race-card-anims-btn').click();
    await page.getByTestId('add-anims-panel').waitFor();
  }, 1500);
  await shot('17-tabs-piled');
  await shot('18-history', () => openPanel('history'), 1000);
  await shot('19-race-inspector', async () => {
    await page.locator('.dv-tab', { hasText: 'Инспектор' }).first().click();
  });
  await shot('19b-race-card-folded', () => page.getByTestId('race-card-fold').click());
  await page.getByTestId('race-card-fold').click();

  // Multi-selection and bulk edit.
  await preset('data');
  await page.getByTestId('category-tree').getByText('Всё', { exact: true }).click();
  await page.getByTestId('search').first().fill('katana; type=WEAPON');
  await page.waitForTimeout(500);
  const rows = page.getByTestId('record-list').first().locator('.list-row');
  await rows.nth(0).click();
  await rows.nth(1).click({ modifiers: ['Control'] });
  await shot('20-multiselect', () => rows.nth(2).click({ modifiers: ['Control'] }));
  await shot('21-bulk-from-selection', () => page.getByTestId('list-bulk').click(), 1500);
  await shot('22-diagnostics', () => page.getByTestId('validate').click(), 2500);

  await shot('30-layout-dialogue', async () => {
    await preset('dialogue');
    await select('Beep', BEEP);
  }, 2000);
  await shot('31-layout-scene', async () => {
    await preset('scene');
    await page.getByTestId('world-view').waitFor();
    await page.waitForFunction(() => document.querySelector('[data-testid="world-view"]')?.getAttribute('data-ready') === 'yes', null, { timeout: 90_000 });
  }, 4000);
  await preset('data');
  await shot('40-new-record-modal', () => page.getByTestId('new-record').click());
  await esc();
} finally {
  writeFileSync(join(outDir, 'notes.json'), JSON.stringify(notes, null, 1));
  await app.evaluate(({ BrowserWindow }) => {
    for (const w of BrowserWindow.getAllWindows()) w.destroy();
  }).catch(() => undefined);
  await app.close().catch(() => undefined);
}
