/**
 * Screenshots of what is new in 0.2 (docs/release/screenshots/<lang>/09-…), from the built beta, 1920x1080.
 *   SHOTS_LANG=en|ru node apps/desktop/scripts/release-shots-v02.ts <path to Cactus.exe> [shot numbers: 09 10 ...]
 *
 * Part 1 runs on a temp «game folder» under out/tmp-game (hard links to the real game data files) with a
 * showcase mod that has a few planted problems, a Workshop mod to merge from and the fake Steam
 * (KEDIT_FAKE_STEAM=1): nothing is uploaded and nothing is written into the real game folder.
 * Part 2 runs on the real game (World view with the Kenshi Bridge dump; with SHOTS_LANG=en also one
 * Chinese-UI shot into screenshots/zh) with a mod kept in memory.
 * The editor data folder is under out/ too, so no Windows user name can appear on screen.
 */
import { copyFileSync, existsSync, linkSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { _electron as electron, type ElectronApplication, type Page } from '@playwright/test';
import { emptyRecord, encodeText, FileType, itemTypeId, readDataFile, writeDataFile, type DataFile, type GameRecord } from '@kenshi-editor/core';
import { resolveGamePaths } from '@kenshi-editor/core/node';

const app = resolve(import.meta.dirname, '..');
const root = resolve(app, '../..');
const exe = process.argv[2];
if (!exe || !existsSync(exe)) throw new Error('usage: release-shots-v02.ts <Cactus.exe> [09 10 …]');
const only = new Set(process.argv.slice(3));
const LANG = process.env['SHOTS_LANG'] === 'en' ? 'en' : 'ru';
const EN = LANG === 'en';
const shots = join(root, 'docs/release/screenshots', LANG);
mkdirSync(shots, { recursive: true });
const zhShots = join(root, 'docs/release/screenshots', 'zh');
const want = (n: string): boolean => !only.size || only.has(n);

const KATANA = '476-gamedata.base';
const MOD = 'Desert Arsenal';
const SOURCE = 'Sharp Blades.mod';
const GHOST = '999999-nowhere.mod';
const GENERIC = 'C:\\Program Files (x86)\\Steam\\steamapps\\common\\Kenshi';
const GAME_FILES = ['data/gamedata.base', 'data/Newwworld.mod', 'data/Dialogue.mod', 'data/rebirth.mod', 'fcs.def', 'fcs_enums.def', 'fcs_layout.def', 'locale/ru_RU/gamedata.po', 'locale/ru_RU/ru_RU.translation'];

const real = resolveGamePaths(root);
const WEAPON = itemTypeId('WEAPON')!;
const CHARACTER = itemTypeId('CHARACTER')!;
const vanillaKatana = readDataFile(readFileSync(join(real.kenshi, 'data/gamedata.base'))).records.find((r) => r.stringId === KATANA)!;

function modFile(records: GameRecord[], description = ''): Uint8Array {
  const f: DataFile = {
    fileType: FileType.Mod,
    header: { version: 1, author: encodeText('Cactus'), description: encodeText(description), dependencies: encodeText(''), references: encodeText('') },
    lastId: 10,
    records,
    tail: new Uint8Array(),
  };
  return writeDataFile(f);
}

/** The showcase mod: a real change, a no-op change, a field not in the schema, a broken reference. */
function showcaseMod(): Uint8Array {
  const katana = emptyRecord(WEAPON, KATANA, vanillaKatana.name);
  katana.changeFlags = 0x80000001;
  katana.floats.set('cut damage multiplier', 1.6);
  const weight = vanillaKatana.floats.get('weight kg');
  if (weight !== undefined) katana.floats.set('weight kg', weight);
  katana.floats.set('old balance factor', 3);
  const smith = emptyRecord(CHARACTER, `1-${MOD}.mod`, encodeText('Wandering Smith'));
  smith.changeFlags = 0x80000002;
  smith.refs.set('unique replacement spawn', [{ target: GHOST, v0: 0, v1: 0, v2: 0 }]);
  const blade = emptyRecord(WEAPON, `2-${MOD}.mod`, encodeText('Dune Cleaver'));
  blade.changeFlags = 0x80000002;
  blade.ints.set('value', 2400);
  blade.floats.set('cut damage multiplier', 1.3);
  return modFile([katana, smith, blade], 'Sturdier blades for the desert, and a smith who sells them.');
}

function sourceMod(): Uint8Array {
  const katana = emptyRecord(WEAPON, KATANA, vanillaKatana.name);
  katana.changeFlags = 0x80000001;
  katana.floats.set('cut damage multiplier', 2.5);
  const w = (sid: string, name: string, value: number): GameRecord => {
    const r = emptyRecord(WEAPON, sid, encodeText(name));
    r.changeFlags = 0x80000002;
    r.ints.set('value', value);
    return r;
  };
  return modFile([katana, w('9001-Sharp Blades.mod', 'Razor Katana', 7700), w('9002-Sharp Blades.mod', 'Thin Dagger', 550)]);
}

function makeGame(): { kenshi: string; workshop: string; root: string } {
  const base = join(root, 'out', 'tmp-game');
  mkdirSync(base, { recursive: true });
  const top = mkdtempSync(join(base, 's-'));
  const kenshi = join(top, 'steamapps', 'common', 'Kenshi');
  const workshop = join(top, 'steamapps', 'workshop', 'content', '233860');
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
  mkdirSync(join(kenshi, 'mods', MOD), { recursive: true });
  writeFileSync(join(kenshi, 'mods', MOD, `${MOD}.mod`), showcaseMod());
  mkdirSync(join(workshop, '900002'), { recursive: true });
  writeFileSync(join(workshop, '900002', SOURCE), sourceMod());
  writeFileSync(join(kenshi, 'data', 'mods.cfg'), '');
  return { kenshi, workshop, root: top };
}

const log = (s: string): void => { console.log(s); };

async function start(extra: Record<string, string>): Promise<{ eapp: ElectronApplication; page: Page; userData: string }> {
  const userData = mkdtempSync(join(root, 'out', 'shots-data-'));
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) if (v !== undefined && k !== 'ELECTRON_RUN_AS_NODE') env[k] = v;
  Object.assign(env, { KEDIT_USER_DATA: userData, KEDIT_LIVE_FILE: join(userData, 'live.json') }, extra);
  const eapp = await electron.launch({ executablePath: exe, args: [], env });
  const page = await eapp.firstWindow();
  await eapp.evaluate(({ BrowserWindow }) => {
    const w = BrowserWindow.getAllWindows()[0]!;
    w.setContentSize(1920, 1080);
    w.center();
  });
  const cdp = await page.context().newCDPSession(page);
  await cdp.send('Emulation.setDeviceMetricsOverride', { width: 1920, height: 1080, deviceScaleFactor: 1, mobile: false });
  await page.getByTestId('open-vanilla').waitFor({ timeout: 60_000 });
  await page.getByTestId('mods-table').waitFor();
  await setLang(page, LANG);
  return { eapp, page, userData };
}

async function setLang(page: Page, lang: 'en' | 'ru' | 'zh'): Promise<void> {
  await page.getByTestId('lang-current').click();
  await page.getByTestId(`lang-${lang}`).click();
  await page.waitForTimeout(500);
}

async function stop(eapp: ElectronApplication): Promise<void> {
  await eapp.evaluate(({ BrowserWindow }) => { for (const w of BrowserWindow.getAllWindows()) w.destroy(); }).catch(() => undefined);
  await eapp.close().catch(() => undefined);
}

/** Replaces the temp or real game paths on screen with a generic Steam path. */
async function hidePaths(page: Page, paths: string[]): Promise<void> {
  await page.evaluate(
    ({ paths, generic }) => {
      const fix = (s: string): string => {
        let out = s;
        for (const p of paths) out = out.split(p).join(generic).split(p.replaceAll('\\', '/')).join(generic.replaceAll('\\', '/'));
        return out;
      };
      const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
      for (let n = walker.nextNode(); n; n = walker.nextNode()) if (n.textContent) n.textContent = fix(n.textContent);
      for (const el of Array.from(document.querySelectorAll<HTMLInputElement>('input, textarea'))) el.value = fix(el.value);
      for (const el of Array.from(document.querySelectorAll('[title]'))) el.setAttribute('title', fix(el.getAttribute('title') ?? ''));
    },
    { paths, generic: GENERIC },
  );
}

async function snap(page: Page, name: string, hide: string[], fn: () => Promise<void>, dir = shots): Promise<void> {
  if (!want(name.split('-')[0]!)) return;
  try {
    await fn();
    await page.waitForTimeout(400);
    await hidePaths(page, hide);
    await page.screenshot({ path: join(dir, `${name}.png`) });
    log(`ok ${name}`);
  } catch (e) {
    log(`FAIL ${name}: ${(e as Error).message.split('\n')[0]}`);
    await page.screenshot({ path: join(root, 'out', `fail-${LANG}-${name}.png`) }).catch(() => undefined);
  }
  await page.keyboard.press('Escape').catch(() => undefined);
}

async function openPanel(page: Page, id: string): Promise<void> {
  await page.getByTestId('window-menu').click();
  await page.getByTestId(`window-panel-${id}`).click();
}

// ---- Part 1: temp game with the showcase mod ----
if (['09', '10', '11', '12', '13', '14', '15'].some(want)) {
  const game = makeGame();
  const hide = [game.kenshi, game.root, real.kenshi];
  const { eapp, page, userData } = await start({
    KENSHI_DIR: game.kenshi,
    KENSHI_WORKSHOP_DIR: game.workshop,
    KEDIT_SKIP_GAME_CHECK: '1',
    KEDIT_FAKE_STEAM: '1',
    KEDIT_FAKE_STEAM_TICK_MS: '40',
  });
  try {
    const row = page.getByTestId('mods-table').locator('tr', { hasText: `${MOD}.mod` });
    await row.waitFor({ timeout: 60_000 });
    await row.getByRole('button').first().click();
    await page.getByTestId('editor').waitFor({ timeout: 120_000 });
    await page.waitForTimeout(1000);

    await snap(page, '09-search', hide, async () => {
      await page.getByTestId('category-tree').getByText(EN ? 'Everything' : 'Всё', { exact: true }).click();
      await page.getByTestId('search').fill('type=WEAPON; blunt damage multiplier>=0.5');
      await page.waitForTimeout(800);
      await page.getByTestId('record-list').locator('[data-sid="477-gamedata.base"]').click();
      await page.getByTestId('search-help').click();
      await page.getByTestId('search-help-popover').waitFor();
    });
    if (await page.getByTestId('search-help-popover').isVisible()) await page.getByTestId('search-help').click();
    await page.getByTestId('search').fill('');
    await page.getByTestId('cat-mod').click();
    await page.getByTestId('record-list').locator(`[data-sid="1-${MOD}.mod"]`).click();

    await snap(page, '10-diagnostics', hide, async () => {
      await page.getByTestId('validate').click();
      await page.getByTestId('issue-fixer').waitFor();
      await page.locator('[data-testid="fix-issue"]').first().waitFor({ timeout: 30_000 });
      await page.waitForTimeout(600);
    });

    await snap(page, '11-cleanup', hide, async () => {
      await openPanel(page, 'cleanup');
      await page.getByTestId('cleanup-panel').waitFor();
      for (const b of await page.getByTestId('cleanup-expand').all()) await b.click();
      await page.waitForTimeout(500);
    });

    await snap(page, '12-merge', hide, async () => {
      await openPanel(page, 'merge');
      await page.getByTestId('merge-panel').waitFor();
      const src = page.getByTestId('merge-source');
      await page.waitForFunction(() => (document.querySelector<HTMLSelectElement>('[data-testid="merge-source"]')?.options.length ?? 0) > 1, null, { timeout: 30_000 });
      const label = await src.locator('option', { hasText: 'Sharp Blades' }).first().textContent();
      await src.selectOption({ label: label ?? '' });
      await page.getByTestId('merge-row').first().waitFor({ timeout: 30_000 });
      await page.locator(`[data-testid="merge-row"][data-sid="${KATANA}"]`).getByTestId('merge-expand').click();
      await page.waitForTimeout(500);
    });

    await snap(page, '13-mod-menu', hide, async () => {
      await page.getByTestId('mod-menu').click();
      await page.getByTestId('mod-menu-list').waitFor();
    });

    await snap(page, '14-window-menu', hide, async () => {
      await page.getByTestId('window-menu').click();
      await page.getByTestId('window-group-mod').waitFor();
    });

    await snap(page, '15-publish', hide, async () => {
      await page.getByTestId('mod-menu').click();
      await page.getByTestId('publish-btn').click();
      await page.getByTestId('publish-modal').waitFor();
      await page.getByTestId('pub-fake').waitFor();
      const preview = join(userData, 'preview.png');
      copyFileSync(join(root, 'docs/release/cover/cover-updated-a-classic.png'), preview);
      await eapp.evaluate(({ dialog }, p) => {
        dialog.showOpenDialog = () => Promise.resolve({ canceled: false, filePaths: [p] });
      }, preview);
      await page.getByTestId('pub-choose-preview').click();
      await page.getByTestId('pub-thumb').waitFor();
      await page.getByTestId('pub-tag-Gameplay').check();
      await page.getByTestId('pub-change-note').fill(EN ? 'First version: sturdier katana, the Dune Cleaver and a wandering smith.' : 'Первая версия: крепкая катана, Дюнный тесак и странствующий кузнец.');
      // The fake-Steam notice is for testers; hide it so the shot shows the window as users see it.
      await page.getByTestId('pub-fake').evaluate((el) => { (el as HTMLElement).style.display = 'none'; });
      await page.waitForTimeout(500);
    });
  } finally {
    await stop(eapp);
    rmSync(game.root, { recursive: true, force: true });
    rmSync(userData, { recursive: true, force: true });
  }
}

// ---- Part 2: real game, a mod kept in memory ----
if (want('16') || (EN && want('17'))) {
  mkdirSync(zhShots, { recursive: true });
  const { eapp, page, userData } = await start({});
  const hide = [real.kenshi];
  try {
    await page.getByTestId('new-mod-name').fill('World Demo');
    await page.getByTestId('create-mod').click();
    await page.getByTestId('editor').waitFor({ timeout: 120_000 });

    await snap(page, '16-world', hide, async () => {
      await page.getByTestId('window-menu').click();
      await page.getByTestId('window-preset-scene').click();
      await page.getByTestId('world-view').waitFor();
      await page.waitForFunction(() => document.querySelector('[data-testid="world-view"]')?.getAttribute('data-ready') === 'yes', null, { timeout: 90_000 });
      await page.waitForTimeout(5000);
      await page.getByTestId('world-search').fill(EN ? 'Hub' : 'Хаб');
      await page.getByTestId('world-search').press('Enter');
      await page
        .waitForFunction(() => Number(document.querySelector('[data-testid="world-stats"]')?.getAttribute('data-foliage-game') ?? 0) > 0, null, { timeout: 120_000 })
        .catch(() => { log('  no foliage from the game dump (no dump here?)'); });
      await page.waitForTimeout(10_000);
      log(`  world stats ${await page.getByTestId('world-stats').evaluate((el) => Array.from(el.attributes).map((a) => `${a.name}=${a.value}`).join(' '))}`);
    });

    if (EN) {
      await snap(page, '17-chinese', hide, async () => {
        await page.getByTestId('window-menu').click();
        await page.getByTestId('window-preset-data').click();
        await setLang(page, 'zh');
        await page.getByTestId('search').fill('katana');
        await page.getByTestId('record-list').locator(`[data-sid="${KATANA}"]`).click();
        await page.waitForTimeout(800);
      }, zhShots);
    }
  } finally {
    await stop(eapp);
    rmSync(userData, { recursive: true, force: true });
  }
}
