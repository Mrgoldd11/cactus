/**
 * Smoke test of the PACKAGED beta (an unzipped `Cactus.exe`), not of the sources:
 *
 *   CACTUS_EXE=<folder>\Cactus\Cactus.exe pnpm --filter @kenshi-editor/desktop exec playwright test -c playwright.smoke.config.ts
 *
 * Every run gets an empty data folder (`KEDIT_USER_DATA`). The real game is only read; mods that
 * need a `mods/` folder (publishing) live in a temp «game folder» of hard links, like `e2e/publish.spec.ts`.
 * Steam: the real uploader is never started; the dialog is opened without `KEDIT_FAKE_STEAM`
 * (nothing is confirmed), a full upload runs only against the fake Steam.
 */
import { spawnSync } from 'node:child_process';
import { copyFileSync, existsSync, linkSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { _electron as electron, expect, test, type ElectronApplication, type Page } from '@playwright/test';
import { emptyRecord, encodeText, FileType, itemTypeId, joinModList, writeDataFile, type DataFile } from '@kenshi-editor/core';
import { resolveGamePaths } from '@kenshi-editor/core/node';

const EXE = process.env['CACTUS_EXE'] ?? '';
const appDir = resolve(import.meta.dirname, '..');
const editorRoot = resolve(appDir, '../..');
const shots = join(editorRoot, 'out', 'smoke');
mkdirSync(shots, { recursive: true });

test.beforeAll(() => {
  expect(EXE, 'CACTUS_EXE must point to an unzipped Cactus.exe').not.toBe('');
  expect(existsSync(EXE)).toBe(true);
  expect(resolve(EXE).toLowerCase().startsWith(editorRoot.toLowerCase()), 'run the unzipped copy, not out/beta').toBe(false);
});

function baseEnv(userData: string): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) if (v !== undefined && !['ELECTRON_RUN_AS_NODE', 'ELECTRON_RENDERER_URL', 'KEDIT_FAKE_STEAM'].includes(k)) env[k] = v;
  env['KEDIT_USER_DATA'] = userData;
  env['KEDIT_LIVE_FILE'] = join(userData, 'live.json');
  return env;
}

async function launch(env: Record<string, string>): Promise<{ app: ElectronApplication; page: Page }> {
  const app = await electron.launch({ executablePath: EXE, args: [], env });
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
  await app.close().catch(() => undefined);
}

async function openPanel(page: Page, id: string): Promise<void> {
  await page.getByTestId('window-menu').click();
  await page.getByTestId(`window-panel-${id}`).click();
}

async function setLang(page: Page, lang: 'en' | 'ru' | 'zh'): Promise<void> {
  await page.getByTestId('lang-current').click();
  await page.getByTestId(`lang-${lang}`).click();
  await expect(page.getByTestId('lang-menu')).toHaveCount(0);
}

// --- MCP client from packages/mcp (the SDK is only installed there) ---------------------------
interface McpClient {
  connect(t: unknown): Promise<void>;
  listTools(): Promise<{ tools: { name: string }[] }>;
  callTool(r: { name: string; arguments: Record<string, unknown> }): Promise<{ content: { type: string; text?: string }[] }>;
  close(): Promise<void>;
}
async function mcpClient(command: string, args: string[], env: Record<string, string>): Promise<McpClient> {
  const sdk = createRequire(join(editorRoot, 'packages/mcp/package.json'));
  const clientMod = (await import(pathToFileURL(sdk.resolve('@modelcontextprotocol/sdk/client/index.js')).href)) as { Client: new (i: { name: string; version: string }) => McpClient };
  const stdioMod = (await import(pathToFileURL(sdk.resolve('@modelcontextprotocol/sdk/client/stdio.js')).href)) as {
    StdioClientTransport: new (o: { command: string; args: string[]; env: Record<string, string> }) => unknown;
  };
  const client = new clientMod.Client({ name: 'smoke', version: '1.0.0' });
  await client.connect(new stdioMod.StdioClientTransport({ command, args, env }));
  return client;
}

// --- temp game folder with a mod in mods/ (for publishing) -------------------------------------
const GAME_FILES = ['data/gamedata.base', 'data/Newwworld.mod', 'data/Dialogue.mod', 'data/rebirth.mod', 'fcs.def', 'fcs_enums.def', 'fcs_layout.def', 'locale/ru_RU/gamedata.po', 'locale/ru_RU/ru_RU.translation'];
const MOD_NAME = 'Smoke Katana.mod';
// 1×1 PNG.
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');

function makeGame(): { root: string; kenshi: string; workshop: string; modDir: string } {
  const real = resolveGamePaths(editorRoot);
  const base = join(editorRoot, 'out', 'tmp-game');
  mkdirSync(base, { recursive: true });
  const root = mkdtempSync(join(base, 'smoke-'));
  const kenshi = join(root, 'steamapps', 'common', 'Kenshi');
  const workshop = join(root, 'steamapps', 'workshop', 'content', '233860');
  for (const rel of GAME_FILES) {
    const from = join(real.kenshi, rel);
    if (!existsSync(from)) continue;
    const to = join(kenshi, rel);
    mkdirSync(dirname(to), { recursive: true });
    try {
      linkSync(from, to);
    } catch {
      copyFileSync(from, to);
    }
  }
  mkdirSync(workshop, { recursive: true });
  const r = emptyRecord(itemTypeId('WEAPON')!, '476-gamedata.base', encodeText('Katana'));
  r.changeFlags = 0x80000001;
  r.floats.set('cut damage multiplier', 1.5);
  const f: DataFile = {
    fileType: FileType.Mod,
    header: { version: 1, author: encodeText('smoke'), description: encodeText('A sharper katana.'), dependencies: joinModList([]), references: encodeText('') },
    lastId: 0,
    records: [r],
    tail: new Uint8Array(),
  };
  const modDir = join(kenshi, 'mods', 'Smoke Katana');
  mkdirSync(modDir, { recursive: true });
  writeFileSync(join(modDir, MOD_NAME), writeDataFile(f));
  writeFileSync(join(modDir, '_Smoke Katana.img'), PNG);
  writeFileSync(join(kenshi, 'data', 'mods.cfg'), `${MOD_NAME}\r\n`);
  return { root, kenshi, workshop, modDir };
}

function rmQuiet(dir: string): void {
  try {
    rmSync(dir, { recursive: true, force: true });
  } catch {
    // best-effort
  }
}

// ------------------------------------------------------------------------------------------------

test('packaged: clean start, game, vanilla, search, World, Diagnostics, Cleanup, Merge, languages, MCP', async () => {
  test.setTimeout(420_000);
  const userData = mkdtempSync(join(tmpdir(), 'cactus-smoke-'));
  expect(readdirSync(userData)).toEqual([]);
  const env = baseEnv(userData);
  const { app, page } = await launch(env);
  try {
    const info = await app.evaluate(({ app: a }) => ({ version: a.getVersion(), packaged: a.isPackaged, name: a.getName(), exe: process.execPath, appPath: a.getAppPath() }));
    expect(info.version).toBe('0.2.0-beta');
    expect(info.packaged).toBe(true);
    expect(resolve(info.exe).toLowerCase()).toBe(resolve(EXE).toLowerCase());
    expect(info.appPath.toLowerCase()).toContain(join('resources', 'app').toLowerCase());

    // The game is found by itself; the start screen lists the installed mods.
    await expect(page.getByTestId('open-vanilla')).toBeEnabled({ timeout: 60_000 });
    await expect(page.getByTestId('mods-table')).toBeVisible();
    await setLang(page, 'en');
    await expect(page.getByTestId('open-vanilla')).toContainText(/vanilla/i);

    // Vanilla and the record list with operator search.
    await page.getByTestId('open-vanilla').click();
    await expect(page.getByTestId('editor')).toBeVisible({ timeout: 180_000 });
    const search = page.getByTestId('search');
    const list = page.getByTestId('record-list');
    await search.fill('katana');
    await expect(list.locator('[data-sid="476-gamedata.base"]')).toBeVisible({ timeout: 30_000 });
    await search.fill('type=WEAPON; weight kg>10');
    await expect(page.getByTestId('list-count')).toHaveText(/: 4$/);
    await search.fill('ronin; type=SQUAD_TEMPLATE; vendors.weapons:katana');
    await expect(list.locator('[data-sid="2239-gamedata.base"]')).toBeVisible();
    await search.fill('type=WEAPON; weight kgg>1');
    await expect(page.getByTestId('search-hint')).toContainText('weight kgg');
    await page.getByTestId('search-help').click();
    await expect(page.getByTestId('search-help-popover')).toBeVisible();
    await page.getByTestId('search-help').click();
    await search.fill('');

    // «Mod» menu on vanilla: Publish is off and says why.
    await page.getByTestId('mod-menu').click();
    await expect(page.getByTestId('publish-btn')).toBeDisabled();
    await page.keyboard.press('Escape');

    // Diagnostics (with its fix buttons) opens and scans.
    await page.getByTestId('validate').click();
    await expect(page.getByTestId('issue-fixer')).toBeVisible({ timeout: 60_000 });

    // World view renders; the Kenshi Bridge dump (if this PC has one) is drawn.
    await page.getByTestId('window-menu').click();
    await page.getByTestId('window-preset-scene').click();
    const view = page.getByTestId('world-view');
    await expect(view).toHaveAttribute('data-ready', 'yes', { timeout: 120_000 });
    await page.getByTestId('world-search').fill('Hub');
    await page.getByTestId('world-search').press('Enter');
    const stat = async (n: string): Promise<number> => Number(await page.getByTestId('world-stats').getAttribute(`data-${n}`));
    await expect.poll(() => stat('models'), { timeout: 90_000 }).toBeGreaterThan(5);
    const dumpDir = join(process.env['LOCALAPPDATA'] ?? '', 'KenshiBridge', 'world');
    if (existsSync(dumpDir) && readdirSync(dumpDir).length > 0) await expect.poll(() => stat('dump-zones'), { timeout: 90_000 }).toBeGreaterThan(0);
    test.info().annotations.push({ type: 'world', description: `models=${String(await stat('models'))} dump-zones=${String(await stat('dump-zones'))} foliage-game=${String(await stat('foliage-game'))}` });
    await page.screenshot({ path: join(shots, 'world.png') });

    // Back to data; a new (unsaved) mod for Cleanup and Merge.
    await page.getByTestId('home').click();
    const leave = page.getByTestId('confirm-discard');
    if (await leave.isVisible().catch(() => false)) await leave.click();
    await expect(page.getByTestId('new-mod-name')).toBeVisible({ timeout: 60_000 });
    await page.getByTestId('new-mod-name').fill('Smoke Test');
    await page.getByTestId('create-mod').click();
    await expect(page.getByTestId('editor')).toBeVisible({ timeout: 180_000 });
    await openPanel(page, 'cleanup');
    await expect(page.getByTestId('cleanup-panel').or(page.getByTestId('cleanup-empty')).first()).toBeVisible({ timeout: 60_000 });
    await openPanel(page, 'merge');
    await expect(page.getByTestId('merge-panel')).toBeVisible();
    await expect.poll(async () => page.getByTestId('merge-source').locator('option').count(), { timeout: 30_000 }).toBeGreaterThan(1);

    // Languages: ru, zh and back to en.
    await setLang(page, 'ru');
    await expect(page.getByTestId('save')).toHaveText('Сохранить');
    await setLang(page, 'zh');
    await expect(page.getByTestId('lang-current')).toContainText('简体中文');
    await expect(page.getByTestId('save')).toHaveText('保存');
    await setLang(page, 'en');
    await expect(page.getByTestId('save')).toHaveText('Save');

    // Help → Connect AI (MCP): the command points to this exe and the bundled server.
    const detail = await app.evaluate(async ({ dialog, Menu }) => {
      const g = globalThis as unknown as { mcpDetail?: string };
      dialog.showMessageBox = ((...a: unknown[]) => {
        const o = (a.length > 1 ? a[1] : a[0]) as { detail?: string };
        g.mcpDetail = o.detail ?? '';
        return Promise.resolve({ response: 2, checkboxChecked: false });
      });
      const find = (items: Electron.MenuItem[]): Electron.MenuItem | undefined => {
        for (const it of items) {
          if (it.label.startsWith('Connect AI')) return it;
          const sub = it.submenu ? find(it.submenu.items) : undefined;
          if (sub) return sub;
        }
        return undefined;
      };
      const item = find(Menu.getApplicationMenu()?.items ?? []);
      if (!item) return null;
      (item.click as () => void)();
      for (let i = 0; i < 50 && g.mcpDetail === undefined; i++) await new Promise((r) => setTimeout(r, 100));
      return g.mcpDetail ?? null;
    });
    expect(detail).not.toBeNull();
    const json = /\{[\s\S]*\n\}/.exec(detail!)?.[0];
    expect(json).toBeDefined();
    const m = (JSON.parse(json!) as { mcpServers: { kenshi: { command: string; args: string[]; env?: Record<string, string> } } }).mcpServers.kenshi;
    expect(resolve(m.command).toLowerCase()).toBe(resolve(EXE).toLowerCase());
    expect(m.args).toHaveLength(1);
    expect(existsSync(m.args[0]!)).toBe(true);
    expect(m.env).toEqual({ ELECTRON_RUN_AS_NODE: '1' });
    expect(detail).toContain('claude mcp add kenshi --scope user -e ELECTRON_RUN_AS_NODE=1 -- ');
    test.info().annotations.push({ type: 'mcp', description: `${m.command} ${m.args.join(' ')}` });

    // The bundled MCP server starts with exactly that command and answers.
    const mcpEnv: Record<string, string> = { ...baseEnv(userData), ...(m.env ?? {}) };
    const client = await mcpClient(m.command, m.args, mcpEnv);
    try {
      const tools = (await client.listTools()).tools.map((t) => t.name);
      expect(tools).toEqual(expect.arrayContaining(['open_mod', 'find', 'show', 'edit', 'validate', 'fix', 'cleanup', 'merge', 'connect_editor']));
      const r = await client.callTool({ name: 'find', arguments: { query: 'type=WEAPON; weight kg>10' } });
      const text = r.content.map((c) => c.text ?? '').join('\n');
      expect(text).toContain('478-gamedata.base');
      test.info().annotations.push({ type: 'mcp-tools', description: String(tools.length) });
    } finally {
      await client.close().catch(() => undefined);
    }

    // Nothing written next to the exe; settings and logs only in the data folder.
    const near = readdirSync(dirname(EXE)).sort();
    expect(near.filter((n) => /\.(log|json)$/i.test(n) && n !== 'vk_swiftshader_icd.json')).toEqual([]);
    expect(existsSync(join(userData, 'settings.json'))).toBe(true);
  } finally {
    await closeApp(app);
    rmQuiet(userData);
  }
});

test('packaged: autosave folder is created in the data folder', async () => {
  test.setTimeout(240_000);
  const userData = mkdtempSync(join(tmpdir(), 'cactus-smoke-'));
  writeFileSync(join(userData, 'settings.json'), JSON.stringify({ lang: 'en', recent: [], autosaveMinutes: 0.03 }));
  const { app, page } = await launch(baseEnv(userData));
  try {
    await expect(page.getByTestId('new-mod-name')).toBeVisible({ timeout: 60_000 });
    await page.getByTestId('new-mod-name').fill('Smoke Autosave');
    await page.getByTestId('create-mod').click();
    await expect(page.getByTestId('editor')).toBeVisible({ timeout: 180_000 });
    await page.getByTestId('search').fill('katana');
    await page.getByTestId('record-list').locator('[data-sid="476-gamedata.base"]').click();
    await page.getByTestId('tab-fields').click();
    await page.getByTestId('field-filter').fill('cut damage');
    const input = page.getByTestId('field-cut damage multiplier');
    await input.fill('1.7');
    await input.press('Enter');
    const files = (): string[] => {
      const d = join(userData, 'autosave');
      return existsSync(d) ? readdirSync(d).filter((f) => f.endsWith('.mod')) : [];
    };
    await expect.poll(files, { timeout: 60_000 }).toHaveLength(1);
  } finally {
    await closeApp(app);
    rmQuiet(userData);
  }
});

test('packaged: Publish dialog with the real Steam path (nothing confirmed), Steam module loads', async () => {
  test.setTimeout(240_000);
  const game = makeGame();
  const userData = mkdtempSync(join(tmpdir(), 'cactus-smoke-'));
  writeFileSync(join(userData, 'settings.json'), JSON.stringify({ lang: 'en', recent: [], autosaveMinutes: 0 }));
  const env = { ...baseEnv(userData), KENSHI_DIR: game.kenshi, KENSHI_WORKSHOP_DIR: game.workshop, KEDIT_SKIP_GAME_CHECK: '1' };
  // steamworks.js resolves from the uploader's folder and loads its native module (no init).
  const uploader = join(dirname(EXE), 'resources', 'app', 'out', 'main', 'uploader.js');
  expect(existsSync(uploader)).toBe(true);
  const probe = spawnSync(
    EXE,
    ['-e', `const r=require('module').createRequire(${JSON.stringify(uploader)});const p=r.resolve('steamworks.js');const s=r('steamworks.js');console.log(JSON.stringify({p,init:typeof s.init}))`],
    { env: { ...env, ELECTRON_RUN_AS_NODE: '1' }, encoding: 'utf8' },
  );
  expect(probe.status, probe.stderr).toBe(0);
  const loaded = JSON.parse(probe.stdout.trim()) as { p: string; init: string };
  expect(loaded.init).toBe('function');
  expect(loaded.p.toLowerCase().startsWith(dirname(EXE).toLowerCase())).toBe(true);

  const { app, page } = await launch(env);
  try {
    const row = page.getByTestId('mods-table').locator('tr', { hasText: MOD_NAME });
    await expect(row).toBeVisible({ timeout: 60_000 });
    await row.getByRole('button').click();
    await expect(page.getByTestId('editor')).toBeVisible({ timeout: 180_000 });
    await page.getByTestId('mod-menu').click();
    await expect(page.getByTestId('publish-btn')).toBeEnabled({ timeout: 60_000 });
    await page.getByTestId('publish-btn').click();
    await expect(page.getByTestId('publish-modal')).toBeVisible();
    await expect(page.getByTestId('pub-fake')).toHaveCount(0);
    await expect(page.getByTestId('pub-title')).toHaveValue('Smoke Katana');
    await expect(page.getByTestId('pub-files')).toContainText(MOD_NAME);
    const steamOff = await page.getByTestId('pub-steam-off').isVisible();
    test.info().annotations.push({ type: 'steam', description: steamOff ? 'dialog says Steam is not running' : 'Steam running, form ready' });
    // Never pressed: pub-next / pub-confirm.
    expect(readdirSync(game.modDir).sort()).toEqual([MOD_NAME, '_Smoke Katana.img'].sort());
  } finally {
    await closeApp(app);
    rmQuiet(userData);
    rmQuiet(game.root);
  }
});

test('packaged: full publish against the fake Steam (KEDIT_FAKE_STEAM=1)', async () => {
  test.setTimeout(240_000);
  const game = makeGame();
  const userData = mkdtempSync(join(tmpdir(), 'cactus-smoke-'));
  writeFileSync(join(userData, 'settings.json'), JSON.stringify({ lang: 'en', recent: [], autosaveMinutes: 0 }));
  const env = {
    ...baseEnv(userData),
    KENSHI_DIR: game.kenshi,
    KENSHI_WORKSHOP_DIR: game.workshop,
    KEDIT_SKIP_GAME_CHECK: '1',
    KEDIT_FAKE_STEAM: '1',
    KEDIT_FAKE_STEAM_TICK_MS: '40',
    KEDIT_FAKE_STEAM_LOG: join(userData, 'fake-steam.log'),
  };
  const { app, page } = await launch(env);
  try {
    const row = page.getByTestId('mods-table').locator('tr', { hasText: MOD_NAME });
    await expect(row).toBeVisible({ timeout: 60_000 });
    await row.getByRole('button').click();
    await expect(page.getByTestId('editor')).toBeVisible({ timeout: 180_000 });
    await page.getByTestId('mod-menu').click();
    await page.getByTestId('publish-btn').click();
    const modal = page.getByTestId('publish-modal');
    await expect(modal).toBeVisible();
    await expect(page.getByTestId('pub-fake')).toBeVisible();
    await page.getByTestId('pub-tag-Gameplay').check();
    await page.getByTestId('pub-change-note').fill('Smoke test.');
    await expect(page.getByTestId('pub-next')).toBeEnabled();
    await page.getByTestId('pub-next').click();
    await page.getByTestId('pub-confirm').click();
    const result = page.getByTestId('pub-result');
    await expect(result).toHaveAttribute('data-result', 'done', { timeout: 60_000 });
    await expect(result).toHaveAttribute('data-id', '4000000001');
    expect(readFileSync(join(game.modDir, '_Smoke Katana.info'), 'utf8')).toContain('<id>4000000001</id>');
    const calls = readFileSync(join(userData, 'fake-steam.log'), 'utf8')
      .split('\n')
      .filter(Boolean)
      .map((l) => (JSON.parse(l) as { call: string }).call);
    expect(calls).toEqual(expect.arrayContaining(['init', 'createItem', 'updateItem']));
    await modal.screenshot({ path: join(shots, 'publish-fake-done.png') });
  } finally {
    await closeApp(app);
    rmQuiet(userData);
    rmQuiet(game.root);
  }
});
