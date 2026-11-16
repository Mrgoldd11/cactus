/**
 * E2E: the built app in Electron with the real game (read-only). Saving goes to a
 * temp folder and to `editor/out/` (file-picker dialogs are stubbed in main).
 * Screenshots go to `editor/out/screenshots/`.
 */
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { _electron as electron, expect, test, type CDPSession, type ElectronApplication, type Page } from '@playwright/test';
import { decodeText, itemTypeName, readDataFile, type GameRecord } from '@kenshi-editor/core';
import { Session } from '@kenshi-editor/mcp';

const appDir = resolve(import.meta.dirname, '..');
const editorRoot = resolve(appDir, '../..');
const outDir = join(editorRoot, 'out');
const shots = join(outDir, 'screenshots');
mkdirSync(shots, { recursive: true });

const KATANA = '476-gamedata.base';
const WEAPON_VENDOR = '2235-gamedata.base';
const CUT = 'cut damage multiplier';

/** Launch the app; `userData` continues with the settings of the previous run. */
async function launch(userData = mkdtempSync(join(tmpdir(), 'kedit-e2e-'))): Promise<{ app: ElectronApplication; page: Page; liveFile: string; userData: string }> {
  const env: Record<string, string> = { KEDIT_USER_DATA: userData };
  for (const [k, v] of Object.entries(process.env)) if (v !== undefined && k !== 'ELECTRON_RENDERER_URL') env[k] = v;
  // Own live-link discovery file: do not touch the file of the editor the user has open.
  const liveFile = join(userData, 'live.json');
  env['KEDIT_LIVE_FILE'] = liveFile;
  const app = await electron.launch({ args: ['.'], cwd: appDir, env });
  const page = await app.firstWindow();
  await page.waitForLoadState('domcontentloaded');
  return { app, page, liveFile, userData };
}

/**
 * Close the test app. Windows are destroyed without a close event: otherwise an unsaved mod
 * pops up «Закрыть без сохранения?» right on screen and the test waits until Playwright kills the process.
 */
async function closeApp(app: ElectronApplication): Promise<void> {
  await app
    .evaluate(({ BrowserWindow }) => {
      for (const w of BrowserWindow.getAllWindows()) w.destroy();
    })
    .catch(() => undefined);
  await app.close();
}

interface Stubs {
  messageBoxCalls: number;
  messageBoxDetail?: string;
  saveDefaultPath?: string;
}

/** Stub the «Save as» dialog in main: return the given path, remember the suggested one. */
async function stubSaveDialog(app: ElectronApplication, path: string): Promise<void> {
  await app.evaluate(({ dialog }, p) => {
    const g = globalThis as unknown as Stubs;
    dialog.showSaveDialog = (...args: unknown[]) => {
      g.saveDefaultPath = (args.at(-1) as { defaultPath?: string }).defaultPath;
      return Promise.resolve({ canceled: false, filePath: p });
    };
  }, path);
}

/** Stub the confirmation box in main: press button `response`, remember the call. */
async function stubMessageBox(app: ElectronApplication, response: number): Promise<void> {
  await app.evaluate(({ dialog }, r) => {
    const g = globalThis as unknown as Stubs;
    g.messageBoxCalls = 0;
    dialog.showMessageBox = (...args: unknown[]) => {
      g.messageBoxCalls++;
      g.messageBoxDetail = (args.at(-1) as { detail?: string }).detail;
      return Promise.resolve({ response: r, checkboxChecked: false });
    };
  }, response);
}

async function stubs(app: ElectronApplication): Promise<Stubs> {
  return app.evaluate(() => {
    const g = globalThis as unknown as Stubs;
    return { messageBoxCalls: g.messageBoxCalls, messageBoxDetail: g.messageBoxDetail, saveDefaultPath: g.saveDefaultPath };
  });
}

async function waitEditor(page: Page): Promise<void> {
  await expect(page.getByTestId('editor')).toBeVisible({ timeout: 120_000 });
}

async function selectRecord(page: Page, query: string, sid: string): Promise<void> {
  await page.getByTestId('search').fill(query);
  const row = page.getByTestId('record-list').locator(`[data-sid="${sid}"]`);
  await row.click();
  await expect(page.getByTestId('record-sid')).toHaveText(sid);
}

function fieldRow(page: Page, key: string) {
  return page.getByTestId('fields').locator(`[data-field="${key}"]`);
}

function recordsOf(path: string): GameRecord[] {
  return readDataFile(readFileSync(path)).records;
}

test('vanilla: search, field edit, undo, save to a temp folder', async () => {
  const { app, page } = await launch();
  try {
    await expect(page.getByTestId('open-vanilla')).toBeVisible({ timeout: 60_000 });
    await expect(page.getByTestId('mods-table')).toBeVisible();
    await page.screenshot({ path: join(shots, '01-start.png') });

    await page.getByTestId('open-vanilla').click();
    await waitEditor(page);
    await page.screenshot({ path: join(shots, '02-vanilla.png') });

    // Search in Russian works too: «Катана».
    await page.getByTestId('search').fill('катана');
    await expect(page.getByTestId('record-list').locator(`[data-sid="${KATANA}"]`)).toBeVisible();
    await selectRecord(page, 'katana', KATANA);

    await page.getByTestId('field-filter').fill('cut damage');
    const input = page.getByTestId(`field-${CUT}`);
    const original = await input.inputValue();
    await input.fill('1.7');
    await input.press('Enter');
    await expect(fieldRow(page, CUT)).toHaveClass(/fs-changed/);
    await expect(page.getByTestId('record-status')).toContainText('изменена');
    await expect(page.getByTestId('save')).toHaveClass(/primary/);
    await page.screenshot({ path: join(shots, '03-field-changed.png') });

    await page.getByTestId('undo').click();
    await expect(input).toHaveValue(original);
    await expect(fieldRow(page, CUT)).toHaveClass(/fs-base/);
    await expect(page.getByTestId('record-status')).toContainText('ваниль');

    await page.getByTestId('redo').click();
    await expect(input).toHaveValue('1.7');

    const dir = mkdtempSync(join(tmpdir(), 'kedit-save-'));
    const out = join(dir, 'e2e-edit.mod');
    await stubSaveDialog(app, out);
    await page.getByTestId('save').click();
    await expect(page.getByTestId('status-msg')).toContainText('Сохранено');
    await expect(page.getByTestId('save')).not.toHaveClass(/primary/);
    const recs = recordsOf(out);
    expect(recs).toHaveLength(1);
    expect(recs[0]!.stringId).toBe(KATANA);
    expect(recs[0]!.floats.get(CUT)).toBeCloseTo(1.7, 5);

    // Writing to the game folder only after confirmation; «Отмена» writes nothing.
    const games = await page.evaluate(() => window.kedit.detectGames());
    const kenshi = games[0]!.kenshi;
    const gamePath = join(kenshi, 'mods', '__kedit_e2e_never_written__', 'x.mod');
    await stubMessageBox(app, 1);
    await stubSaveDialog(app, gamePath);
    await page.getByTestId('save-as').click();
    await expect(page.getByTestId('status-msg')).toContainText('отменено');
    expect((await stubs(app)).messageBoxCalls).toBe(1);
    expect(existsSync(gamePath)).toBe(false);

    // The launcher does not see a file directly in `mods/`: the editor puts it into `mods/<name>/<name>.mod`.
    const flat = join(kenshi, 'mods', '__kedit_e2e_flat__.mod');
    const nested = join(kenshi, 'mods', '__kedit_e2e_flat__', '__kedit_e2e_flat__.mod');
    await stubMessageBox(app, 1);
    await stubSaveDialog(app, flat);
    await page.getByTestId('save-as').click();
    await expect(page.getByTestId('status-msg')).toContainText('отменено');
    expect((await stubs(app)).messageBoxDetail).toBe(nested);
    expect(existsSync(flat) || existsSync(nested)).toBe(false);
    rmSync(dir, { recursive: true, force: true });
  } finally {
    await closeApp(app);
  }
});

test('scenario: katana copy, name and damage, into the trader stock, save to out/', async () => {
  const { app, page } = await launch();
  const modName = 'KeditE2E Trader Katana';
  const out = join(outDir, `${modName}.mod`);
  rmSync(out, { force: true });
  try {
    await page.getByTestId('new-mod-name').fill(modName);
    await page.getByTestId('create-mod').click();
    await waitEditor(page);

    await selectRecord(page, 'katana', KATANA);
    await page.getByTestId('duplicate').click();
    await expect(page.getByTestId('record-status')).toContainText('новая');
    const sid = (await page.getByTestId('record-sid').textContent())!;
    expect(sid).toMatch(new RegExp(`^\\d+-${modName}\\.mod$`));

    const name = page.getByTestId('record-name');
    await name.fill('Tester Katana');
    await name.press('Enter');
    await expect(name).toHaveValue('Tester Katana');

    await page.getByTestId('field-filter').fill('cut damage');
    const cut = page.getByTestId(`field-${CUT}`);
    await cut.fill('1.6');
    await cut.press('Enter');
    await expect(cut).toHaveValue('1.6');
    await page.screenshot({ path: join(shots, '04-new-weapon.png') });

    await selectRecord(page, 'weapon vendor', WEAPON_VENDOR);
    await page.getByTestId('tab-refs').click();
    await page.getByTestId('ref-add-weapons').first().click();
    await expect(page.getByTestId('record-picker')).toBeVisible();
    await page.getByTestId('picker-search').fill('tester katana');
    await expect(page.getByTestId('picker-list').locator(`[data-sid="${sid}"]`)).toBeVisible();
    await page.screenshot({ path: join(shots, '05-picker.png') });
    await page.getByTestId('picker-search').press('Enter');
    await expect(page.getByTestId('record-picker')).toBeHidden();
    const refRow = page.getByTestId('refs').locator(`[data-category="weapons"] [data-target="${sid}"]`);
    await expect(refRow).toHaveClass(/rs-added/);
    await refRow.scrollIntoViewIfNeeded();
    await page.screenshot({ path: join(shots, '06-vendor-refs.png') });

    await page.getByTestId('tab-diff').click();
    await expect(page.getByTestId('diff')).toContainText('Tester Katana');
    await page.screenshot({ path: join(shots, '07-vendor-diff.png') });

    await page.getByTestId('cat-mod').click();
    await page.getByTestId('search').fill('');
    await expect(page.getByTestId('list-count')).toContainText('2');
    await page.screenshot({ path: join(shots, '08-mod-changes.png') });

    await stubSaveDialog(app, out);
    await page.getByTestId('save').click();
    await expect(page.getByTestId('status-msg')).toContainText('Сохранено');
    // The new mod folder does not exist yet: the save dialog opens in `Kenshi/mods`, not in «Documents».
    const games = await page.evaluate(() => window.kedit.detectGames());
    expect((await stubs(app)).saveDefaultPath).toBe(join(games[0]!.kenshi, 'mods', `${modName}.mod`));

    const recs = recordsOf(out);
    expect(recs).toHaveLength(2);
    const weapon = recs.find((r) => r.stringId === sid)!;
    expect(itemTypeName(weapon.type)).toBe('WEAPON');
    expect(decodeText(weapon.name)).toBe('Tester Katana');
    expect(weapon.floats.get(CUT)).toBeCloseTo(1.6, 5);
    const vendor = recs.find((r) => r.stringId === WEAPON_VENDOR)!;
    expect(vendor.refs.get('weapons')?.some((r) => r.target === sid)).toBe(true);

    await page.getByTestId('lang-current').click();
    await page.getByTestId('lang-en').click();
    await expect(page.getByTestId('save')).toHaveText('Save');
    await page.getByTestId('cat-mod').click();
    await page.getByTestId('record-list').locator(`[data-sid="${sid}"]`).click();
    await page.getByTestId('tab-fields').click();
    await page.getByTestId('field-filter').fill('');
    await page.screenshot({ path: join(shots, '09-english-fields.png') });
    // Chinese: the dropdown shows the current language, the list opens under the button.
    await page.getByTestId('lang-current').click();
    await expect(page.getByTestId('lang-menu')).toBeVisible();
    await page.getByTestId('lang-zh').click();
    await expect(page.getByTestId('lang-menu')).toHaveCount(0);
    await expect(page.getByTestId('lang-current')).toContainText('简体中文');
    await expect(page.getByTestId('save')).toHaveText('保存');
    // Panel titles «Игра», «Модель», «Мир», «Внутри» in the «Окно» menu are in Chinese too.
    await page.getByTestId('window-menu').click();
    await expect(page.getByTestId('window-panel-game')).toContainText('游戏');
    await expect(page.getByTestId('window-panel-model')).toContainText('模型');
    await expect(page.getByTestId('window-panel-world')).toContainText('世界');
    await expect(page.getByTestId('window-panel-interior')).toContainText('建筑内部');
    await page.screenshot({ path: join(shots, '10-chinese.png') });
    await page.getByTestId('window-menu').click();
    await page.getByTestId('lang-current').click();
    await page.getByTestId('lang-ru').click();
  } finally {
    await closeApp(app);
  }
});

test('where in game: katana → weaponsmith → Heft and Heng; item icon', async () => {
  const { app, page } = await launch();
  try {
    await expect(page.getByTestId('open-vanilla')).toBeVisible({ timeout: 60_000 });
    await page.getByTestId('open-vanilla').click();
    await waitEditor(page);
    await selectRecord(page, 'katana', KATANA);
    await page.getByTestId('tab-where').click();
    const where = page.getByTestId('where');
    await expect(where).toBeVisible();
    // The world is read when the tab is first opened.
    await expect(where).toContainText('Мир: городов', { timeout: 60_000 });
    const fact = where.locator('[data-testid="where-fact"][data-holder="56131-rebirth.mod"]');
    await expect(fact).toContainText('Продаётся у');
    await expect(fact).toContainText('Груз');
    await expect(fact).toContainText('Хэн');
    await expect(fact).toContainText('(weapons)');
    await expect(fact).toContainText('(vendors)');
    await expect(fact.locator('[data-place="1078-gamedata.base"]')).toContainText('68773');
    await expect(fact.locator('[data-place="1074-gamedata.base"]')).toContainText('зона 42.22');
    await fact.scrollIntoViewIfNeeded();
    await page.screenshot({ path: join(shots, '10-where-katana.png') });

    // Clicking a path step opens the record.
    await fact.getByRole('button', { name: 'weapon vendor UC big city' }).click();
    await expect(page.getByTestId('record-sid')).toHaveText('52318-rebirth.mod');

    await selectRecord(page, 'steel bars', '579-gamedata.base');
    await page.getByTestId('tab-where').click();
    await expect(page.getByTestId('where-icon')).toBeVisible();
    await expect(page.getByTestId('where-fact').first()).toBeVisible();
    await page.screenshot({ path: join(shots, '11-where-icon.png') });
  } finally {
    await closeApp(app);
  }
});

test('dialogue graph: lines in Russian, player choice, loops; a line the game will not pick', async () => {
  const { app, page } = await launch();
  try {
    await expect(page.getByTestId('open-vanilla')).toBeVisible({ timeout: 60_000 });
    await page.getByTestId('open-vanilla').click();
    await waitEditor(page);
    // «mercenary shop»: 18 nodes, 11 player choices, 9 returns to the menu.
    await selectRecord(page, '5464-gamedata.base', '5464-gamedata.base');
    await page.getByTestId('tab-graph').click();
    const graph = page.getByTestId('dialogue-graph');
    await expect(graph.getByTestId('dg-stats')).toContainText('узлов 18, вариантов игрока 11, петель 9', { timeout: 60_000 });
    await expect(graph.getByTestId('dg-stats')).not.toContainText('читаю перевод');
    await expect(graph.locator('.dg-node.dg-choice').first()).toBeVisible();
    // Line texts come from the game translation.
    await expect(graph.locator('.dg-text').first()).toHaveText(/[а-яё]/i);
    await expect(graph.locator('.react-flow__edge.dg-edge-back').first()).toBeAttached();
    await expect(graph.locator('.react-flow__minimap-node')).toHaveCount(18);
    // Initial view: readable zoom, root visible.
    await expect(graph.locator('.react-flow__viewport')).toHaveAttribute('style', /scale\(0\.85\)/);
    await expect(graph.locator('[data-testid="dg-node"][data-id="5464-gamedata.base"]')).toBeInViewport();
    await page.screenshot({ path: join(shots, '12-dialogue-graph.png') });

    // Narrow window: initial view from the root, not the empty middle of a wide tree.
    await app.evaluate(({ BrowserWindow }) => { BrowserWindow.getAllWindows()[0]?.setSize(1100, 640); });
    await selectRecord(page, '53976-Dialogue.mod', '53976-Dialogue.mod');
    await page.getByTestId('tab-graph').click();
    await expect(graph.getByTestId('dg-stats')).toContainText('узлов 25');
    await expect(graph.locator('[data-testid="dg-node"][data-id="53976-Dialogue.mod"]')).toBeInViewport();
    await app.evaluate(({ BrowserWindow }) => { BrowserWindow.getAllWindows()[0]?.setSize(1400, 900); });
    // By the game rule a line with a race condition gets +2, and that is not lost here.
    await expect(graph.locator('[data-kind="shadowed"]')).toHaveCount(0);
    // «Grim talks to new ally»: the line with a condition (score 1) will never be picked —
    // its sibling without conditions is earlier in the list and has score 5.
    await selectRecord(page, '61857-Dialogue.mod', '61857-Dialogue.mod');
    await page.getByTestId('tab-graph').click();
    await expect(graph.getByTestId('dg-stats')).toContainText('узлов 5');
    const issue = graph.locator('[data-kind="shadowed"][data-node="61859-Dialogue.mod"]');
    await expect(issue).toContainText('не будет выбрана');
    await expect(issue).toContainText(/реплика «[^»]*[а-яё]/i);
    await issue.getByRole('button').click();
    // Clicking a problem moves the view to the line.
    await expect(graph.locator('.react-flow__viewport')).toHaveAttribute('style', /scale\(1\)/);
    await expect(graph.locator('[data-testid="dg-node"][data-id="61859-Dialogue.mod"] .dg-warn')).toBeInViewport();
    await page.screenshot({ path: join(shots, '13-dialogue-shadowed.png') });

    // Non-dialogue records have no graph tab: the previous «Поля» tab stays in place.
    await selectRecord(page, 'katana', KATANA);
    await expect(page.getByTestId('tab-graph')).toHaveCount(0);
  } finally {
    await closeApp(app);
  }
});

test('conversation: which dialogue the game picks for a character, conversation start, another event', async () => {
  const { app, page } = await launch();
  try {
    await expect(page.getByTestId('open-vanilla')).toBeVisible({ timeout: 60_000 });
    await page.getByTestId('open-vanilla').click();
    await waitEditor(page);
    // Swampers barman: the trading «Swamp Barman» without conditions wins, the others only under conditions.
    await selectRecord(page, '50638-rebirth.mod', '50638-rebirth.mod');
    await page.getByTestId('tab-talk').click();
    const talk = page.getByTestId('talk');
    await expect(talk.getByTestId('talk-candidate')).toHaveCount(5);
    const win = talk.locator('[data-testid="talk-candidate"][data-verdict="wins"]');
    await expect(win).toHaveAttribute('data-dialog', '48721-Dialogue.mod');
    await expect(win).toContainText('торговля');
    await expect(talk.locator('[data-testid="talk-candidate"][data-verdict="locked"]')).toContainText('найм');
    await expect(talk.getByTestId('talk-summary')).toContainText('Без всяких условий игра выберет');
    await expect(talk.getByTestId('talk-summary')).toContainText('перебивают это');
    await expect(win.getByTestId('talk-why')).toContainText('подходит всегда');
    await expect(talk.locator('[data-testid="talk-candidate"][data-verdict="if-conditions"]').first().getByTestId('talk-why')).toContainText('когда его условия выполнены');
    // Conversation start in Russian from the game translation, with player choices; a line with conditions shows its chance.
    const opening = talk.getByTestId('talk-opening');
    await expect(opening).toContainText('Пляшущий Скелет', { timeout: 60_000 });
    await expect(opening.locator('.talk-choice').first()).toContainText('Давай торговать');
    await expect(opening.getByTestId('talk-line-odds').first()).toContainText('при условиях шанс 100%');
    await page.screenshot({ path: join(shots, '16-talk.png') });

    // «Как игра выбирает»: popup with the rules; closes on a second click, a click outside and Esc.
    const rulesBtn = talk.getByTestId('talk-rules-btn');
    const rules = page.getByTestId('talk-rules');
    await rulesBtn.click();
    await expect(rules).toBeVisible();
    await expect(rules).toContainText('всем поровну');
    await expect(rules).toContainText('не прозвучит');
    await page.screenshot({ path: join(shots, '16b-talk-rules.png') });
    await rules.click();
    await expect(rules).toBeVisible();
    await rulesBtn.click();
    await expect(rules).toHaveCount(0);
    await rulesBtn.click();
    await expect(rules).toBeVisible();
    // Click outside the popup (the left edge of the summary row is not covered by the popup).
    await talk.getByTestId('talk-summary').click({ position: { x: 4, y: 4 } });
    await expect(rules).toHaveCount(0);
    await rulesBtn.click();
    await expect(rules).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(rules).toHaveCount(0);

    // Another event: «announcement» has no dialogues; «see neutral squad» is a fight with an attack.
    await talk.getByTestId('talk-event').selectOption('2');
    await expect(talk.getByTestId('talk-summary')).toContainText('диалогов нет');
    await talk.getByTestId('talk-event').selectOption('3');
    await expect(talk.locator('[data-testid="talk-candidate"][data-dialog="49204-Dialogue.mod"]')).toContainText('атака');

    // Jump to the dialogue from the table.
    await talk.getByTestId('talk-event').selectOption('1');
    await win.locator('td').nth(1).getByRole('button').first().click();
    await expect(page.getByTestId('record-sid')).toHaveText('48721-Dialogue.mod');
    // Non-characters have no tab.
    await expect(page.getByTestId('tab-talk')).toHaveCount(0);
  } finally {
    await closeApp(app);
  }
});

test('live AI link: MCP connects to the window, edits as a change set, accept and revert', async () => {
  const { app, page, liveFile } = await launch();
  let session: Session | undefined;
  try {
    await expect(page.getByTestId('open-vanilla')).toBeVisible({ timeout: 60_000 });
    await page.getByTestId('open-vanilla').click();
    await waitEditor(page);
    const live = page.getByTestId('live-status');
    await expect(live).toBeVisible();
    await expect(live).not.toHaveClass(/connected/);
    await expect.poll(() => existsSync(liveFile), { timeout: 10_000 }).toBe(true);

    // The MCP server (its session) works on the same game that is open in the window.
    const [game] = await page.evaluate(() => window.kedit.detectGames());
    session = new Session({ kenshi: game!.kenshi, workshop: game!.workshop }, editorRoot);
    const state = await session.connectEditor(liveFile);
    expect(state.modName).toBeTruthy();
    await expect(live).toHaveClass(/connected/);
    expect(decodeText(session.ctx().get(KATANA)!.name)).toBe('Katana');

    // AI edit: shows up in the window at once, the panel opens by itself.
    const first = await session.propose('катана тяжелее и острее', [
      { op: 'set', id: KATANA, field: 'weight kg', value: 9 },
      { op: 'set', id: KATANA, field: CUT, value: 1.4 },
    ]);
    expect(first.changeset.status).toBe('pending');
    expect(first.changeset.summary.join(' ')).toContain('weight');
    const panel = page.getByTestId('ai-panel');
    await expect(panel).toBeVisible();
    await expect(panel.getByTestId('ai-conn')).toContainText('kenshi-mcp');
    await expect(panel.getByTestId('ai-changeset')).toHaveCount(1);
    await expect(live.locator('.live-badge')).toHaveText('1');
    const card = panel.locator(`[data-testid="ai-changeset"]`).first();
    await expect(card).toContainText('катана тяжелее и острее');
    await expect(card).toContainText('weight');
    // The record link opens it in the editor with the new value.
    await card.locator(`[data-sid="${KATANA}"]`).click();
    await expect(page.getByTestId('record-sid')).toHaveText(KATANA);
    await page.getByTestId('field-filter').fill('weight kg');
    await expect(page.getByTestId('field-weight kg')).toHaveValue('9');
    await page.screenshot({ path: join(shots, '14-ai-changeset.png') });

    // Second edit is a rename; the user reverts it and accepts the first one.
    const second = await session.propose('новое имя', [{ op: 'rename', id: KATANA, name: 'AI Katana' }]);
    await expect(page.getByTestId('record-name')).toHaveValue('AI Katana');
    await expect(panel.getByTestId('ai-changeset')).toHaveCount(2);
    await expect(live.locator('.live-badge')).toHaveText('2');
    const secondCard = panel.locator(`[data-testid="ai-changeset"]`).first();
    await expect(secondCard).toContainText(`#${second.changeset.id}`);
    await secondCard.getByTestId('ai-rollback').click();
    await expect(secondCard).toHaveAttribute('data-status', 'rolled-back');
    await expect(page.getByTestId('record-name')).toHaveValue('Katana');
    await panel.locator('[data-testid="ai-changeset"][data-status="pending"]').getByTestId('ai-accept').click();
    await expect(panel.locator('[data-testid="ai-changeset"][data-status="accepted"]')).toHaveCount(1);
    await expect(live.locator('.live-badge')).toHaveCount(0);
    await expect(page.getByTestId('field-weight kg')).toHaveValue('9');
    // In the ↶ step list AI edits are marked separately, and a revert is a step too.
    await page.getByTestId('undo-menu').click();
    const steps = page.getByTestId('undo-list').getByTestId('undo-step');
    await expect(steps).toHaveCount(3);
    await expect(steps.nth(0)).toContainText('Откат: ИИ: новое имя');
    await expect(steps.nth(2)).toContainText('ИИ: катана тяжелее и острее');
    await expect(steps.nth(2).locator('.hist-ai')).toBeVisible();
    await page.keyboard.press('Escape');

    // The AI sees the user decisions and the window state.
    const list = await session.editorChangesets();
    expect(list.map((c) => c.status)).toEqual(['accepted', 'rolled-back']);
    await session.sync();
    expect(decodeText(session.ctx().get(KATANA)!.name)).toBe('Katana');
    expect(session.ctx().get(KATANA)!.floats.get('weight kg')).toBe(9);
    await page.screenshot({ path: join(shots, '15-ai-accept-rollback.png') });

    // The user changed the same record themselves: reverting the accepted set is refused with an explanation.
    const weight = page.getByTestId('field-weight kg');
    await weight.fill('11');
    await weight.press('Enter');
    await panel.locator('[data-testid="ai-changeset"][data-status="accepted"]').getByTestId('ai-rollback').click();
    await expect(page.getByTestId('status-msg')).toContainText('Нельзя откатить');
    await expect(weight).toHaveValue('11');
  } finally {
    session?.disconnectEditor();
    await closeApp(app);
  }
  // Window closed: the discovery file is removed.
  expect(existsSync(liveFile)).toBe(false);
});

/** The dockview group that holds the tab with this text. */
function groupOfTab(page: Page, title: string) {
  return page.locator('.dv-groupview').filter({ has: page.locator('.dv-tab', { hasText: title }) });
}

test('workspace: dragged a panel, closed another — same layout after restart', async () => {
  let userData: string;
  {
    const run = await launch();
    userData = run.userData;
    const { app, page } = run;
    try {
      await expect(page.getByTestId('open-vanilla')).toBeVisible({ timeout: 60_000 });
      await page.getByTestId('open-vanilla').click();
      await waitEditor(page);
      await expect(page.locator('.dv-tab')).toHaveCount(3);
      await expect(groupOfTab(page, 'Записи').locator('.dv-tab')).toHaveCount(1);

      // Move the «Записи» tab into the middle of the inspector: one group with two tabs.
      const target = groupOfTab(page, 'Инспектор').locator('.dv-content-container');
      await page.locator('.dv-tab', { hasText: 'Записи' }).dragTo(target);
      await expect(groupOfTab(page, 'Записи').locator('.dv-tab')).toHaveCount(2);

      // Close «Категории» via the «Окно» menu, open «Где в игре».
      await page.getByTestId('window-menu').click();
      await page.getByTestId('window-panel-categories').click();
      await expect(page.locator('.dv-tab', { hasText: 'Категории' })).toHaveCount(0);
      await page.getByTestId('window-menu').click();
      await page.getByTestId('window-panel-where').click();
      await expect(page.locator('.dv-tab', { hasText: 'Где в игре' })).toHaveCount(1);
      await page.screenshot({ path: join(shots, '17-workspace-moved.png') });
      // The layout is written with a delay.
      await page.waitForTimeout(800);
    } finally {
      await closeApp(app);
    }
  }
  const { app, page } = await launch(userData);
  try {
    await expect(page.getByTestId('open-vanilla')).toBeVisible({ timeout: 60_000 });
    await page.getByTestId('open-vanilla').click();
    await waitEditor(page);
    await expect(groupOfTab(page, 'Записи').locator('.dv-tab')).toHaveCount(2);
    await expect(groupOfTab(page, 'Записи').locator('.dv-tab', { hasText: 'Инспектор' })).toHaveCount(1);
    await expect(page.locator('.dv-tab', { hasText: 'Категории' })).toHaveCount(0);
    await expect(page.locator('.dv-tab', { hasText: 'Где в игре' })).toHaveCount(1);

    // «Сбросить раскладку» brings back the preset «Данные» layout.
    await page.getByTestId('window-menu').click();
    await page.getByTestId('window-reset').click();
    await expect(page.locator('.dv-tab')).toHaveCount(3);
    await expect(page.locator('.dv-tab', { hasText: 'Категории' })).toHaveCount(1);
    await expect(groupOfTab(page, 'Записи').locator('.dv-tab')).toHaveCount(1);
  } finally {
    await closeApp(app);
    rmSync(userData, { recursive: true, force: true });
  }
});

test('conversation player: which dialogue is picked and why, answers, as if, example in How the game picks', async () => {
  const { app, page } = await launch();
  try {
    await expect(page.getByTestId('open-vanilla')).toBeVisible({ timeout: 60_000 });
    await page.getByTestId('open-vanilla').click();
    await waitEditor(page);
    await page.getByTestId('window-menu').click();
    await page.getByTestId('window-preset-dialogue').click();
    // Swampers barman.
    await page.getByTestId('search').fill('50638-rebirth.mod');
    await page.getByTestId('record-list').locator('[data-sid="50638-rebirth.mod"]').click();
    const player = page.getByTestId('player');
    await expect(player).toHaveAttribute('data-sid', '50638-rebirth.mod');
    const first = player.getByTestId('pl-step').first();
    const opt = (sid: string) => first.locator(`[data-testid="pl-option"][data-sid="${sid}"]`);
    // «As if all conditions are met»: the runaway bandit line wins (it gets more points for conditions).
    await expect(opt('14394-Dialogue (4).mod')).toHaveAttribute('data-why', 'chosen');
    await expect(opt('48721-Dialogue.mod')).toHaveAttribute('data-why', 'outscored');
    // Only records without conditions: the plain «Swamp Barman», conversation start in Russian, three answers.
    await player.getByTestId('pl-mode').selectOption('none');
    await expect(opt('48721-Dialogue.mod')).toHaveAttribute('data-why', 'chosen');
    await expect(opt('48721-Dialogue.mod').getByTestId('pl-why')).toContainText('больше всех очков');
    await expect(opt('14394-Dialogue (4).mod')).toHaveAttribute('data-why', 'fails');
    await expect(opt('14394-Dialogue (4).mod').getByTestId('pl-why')).toContainText('условия не выполнены');
    await expect(first.getByTestId('pl-said')).toContainText('Пляшущий Скелет', { timeout: 60_000 });
    await expect(first.getByTestId('pl-answer')).toHaveCount(3);
    await page.screenshot({ path: join(shots, '18-player.png') });

    // Player answer → barman line and six new answers; «go back» returns.
    await first.locator('[data-testid="pl-answer"][data-sid="48725-Dialogue.mod"]').click();
    await expect(player.getByTestId('pl-step')).toHaveCount(2);
    const second = player.getByTestId('pl-step').nth(1);
    await expect(second.getByTestId('pl-said')).toHaveAttribute('data-sid', '48726-Dialogue.mod');
    await expect(second.getByTestId('pl-answer')).toHaveCount(6);
    await page.screenshot({ path: join(shots, '18b-player-answer.png') });
    await first.getByTestId('pl-back').click();
    await expect(player.getByTestId('pl-step')).toHaveCount(1);

    // «As if the bandit conditions are met»: the dialogue passes, but its lines have their own conditions — nothing
    // inside matches, so the game skips it.
    const bandit = opt('14394-Dialogue (4).mod');
    await bandit.getByTestId('pl-asif').locator('input').check();
    await expect(bandit).toHaveAttribute('data-why', 'empty');
    await expect(bandit.getByTestId('pl-why')).toContainText('внутри ничего не подходит');
    await expect(opt('48721-Dialogue.mod')).toHaveAttribute('data-why', 'chosen');
    // Back to «as if met»; unticking the bandit moves the pick to the next one, reset brings it back.
    await player.getByTestId('pl-mode').selectOption('met');
    await expect(bandit).toHaveAttribute('data-why', 'chosen');
    await bandit.getByTestId('pl-asif').locator('input').uncheck();
    await expect(bandit).toHaveAttribute('data-why', 'fails');
    await expect(opt('5934-Dialogue.mod')).toHaveAttribute('data-why', 'chosen');
    await player.getByTestId('pl-reset-asif').click();
    await expect(bandit).toHaveAttribute('data-why', 'chosen');
    await player.getByTestId('pl-mode').selectOption('none');
    await expect(opt('48721-Dialogue.mod')).toHaveAttribute('data-why', 'chosen');

    // Clicking a line opens its dialogue in the graph and the line itself in the line inspector.
    await first.getByTestId('pl-said').getByRole('button').click();
    await expect(page.getByTestId('dialogue-graph')).toHaveAttribute('data-sid', '48721-Dialogue.mod');
    await expect(page.getByTestId('line-inspector')).toHaveAttribute('data-sid', '48722-Dialogue.mod');
    await expect(player).toHaveAttribute('data-sid', '50638-rebirth.mod');
    await page.screenshot({ path: join(shots, '18c-player-line.png') });

    // «Как игра выбирает диалог»: the rule and an example on this character.
    await page.locator('.dv-tab', { hasText: 'Как игра выбирает' }).click();
    const howto = page.getByTestId('howto');
    await expect(howto.getByTestId('howto-example')).toContainText('Трактирщик — диалогов на «разговор»: 5');
    await expect(howto.getByTestId('howto-example')).toContainText('Если ни одно условие не выполнено');
    await expect(howto).toContainText('всем поровну');
    await page.screenshot({ path: join(shots, '19-howto.png') });
  } finally {
    await closeApp(app);
  }
});

test('vanilla dialogue: new answer, link by dragging, undo/redo, save, kedit validate without errors', async () => {
  const { app, page } = await launch();
  try {
    await app.evaluate(({ BrowserWindow }) => { BrowserWindow.getAllWindows()[0]?.setSize(1600, 1000); });
    await expect(page.getByTestId('open-vanilla')).toBeVisible({ timeout: 60_000 });
    await page.getByTestId('open-vanilla').click();
    await waitEditor(page);
    await page.getByTestId('window-menu').click();
    await page.getByTestId('window-preset-dialogue').click();
    // «Grim talks to new ally»: 5 nodes. Grim last line is «Grow me some hemp, got it?».
    await page.getByTestId('search').fill('61857-Dialogue.mod');
    await page.getByTestId('record-list').locator('[data-sid="61857-Dialogue.mod"]').click();
    const graph = page.getByTestId('dialogue-graph');
    await expect(graph.getByTestId('dg-stats')).toContainText('узлов 5', { timeout: 60_000 });
    const node = (sid: string) => graph.locator(`[data-testid="dg-node"][data-id="${sid}"]`);
    await node('61861-Dialogue.mod').locator('.dg-text').first().click();
    const insp = page.getByTestId('line-inspector');
    await expect(insp).toHaveAttribute('data-sid', '61861-Dialogue.mod');

    // New player answer under a line: a new record with a new id, text.
    await insp.getByTestId('ln-add-answer').click();
    await expect(insp).not.toHaveAttribute('data-sid', '61861-Dialogue.mod');
    const answer = (await insp.getAttribute('data-sid'))!;
    expect(answer).toMatch(/^\d+-/);
    await insp.getByTestId('ln-text-0').fill('Повтори-ка, где ставить базу?');
    await insp.getByTestId('ln-text-0').blur();
    await expect(graph.getByTestId('dg-stats')).toContainText('узлов 6');
    await expect(node(answer)).toContainText('Повтори-ка');

    // Link: drag from the right edge of the new answer onto the «Set up a base…» line (loop back).
    // «Show all», then zoom out: near the graph edge the view scrolls by itself while dragging.
    await graph.getByRole('button', { name: /Показать всё/ }).click();
    await page.waitForTimeout(400);
    await graph.locator('.react-flow__controls-zoomout').click();
    await page.waitForTimeout(400);
    const from = (await node(answer).locator('.react-flow__handle.source').boundingBox())!;
    const to = (await node('61860-Dialogue.mod').locator('.react-flow__handle.target').boundingBox())!;
    await page.mouse.move(from.x + from.width / 2, from.y + from.height / 2);
    await page.mouse.down();
    await page.mouse.move(to.x + to.width / 2, to.y + to.height / 2, { steps: 12 });
    await page.mouse.up();
    await node(answer).locator('.dg-text').first().click();
    await expect(insp).toHaveAttribute('data-sid', answer);
    await expect(insp.getByTestId('ln-next-item')).toHaveCount(1);
    await expect(insp.locator('[data-testid="ln-next-item"][data-sid="61860-Dialogue.mod"]')).toHaveCount(1);
    await page.screenshot({ path: join(shots, '20-dialog-edit.png') });

    // Undo removes the link, redo brings it back.
    await page.getByTestId('undo').click();
    await expect(insp.getByTestId('ln-next-item')).toHaveCount(0);
    await page.getByTestId('redo').click();
    await expect(insp.getByTestId('ln-next-item')).toHaveCount(1);

    // Save to a temp folder; kedit validate on the saved mod — no errors.
    const dir = mkdtempSync(join(tmpdir(), 'kedit-dlg-'));
    const out = join(dir, 'GrimAnswer.mod');
    try {
      await stubSaveDialog(app, out);
      await page.getByTestId('save').click();
      await expect(page.getByTestId('save')).not.toHaveClass(/primary/);
      const recs = recordsOf(out);
      const added = recs.find((r) => r.stringId === answer)!;
      expect(itemTypeName(added.type)).toBe('DIALOGUE_LINE');
      expect(added.ints.get('speaker')).toBe(1);
      expect(decodeText(added.strings.get('text0')!)).toBe('Повтори-ка, где ставить базу?');
      expect(added.refs.get('lines')?.map((r) => r.target)).toEqual(['61860-Dialogue.mod']);
      const parent = recs.find((r) => r.stringId === '61861-Dialogue.mod')!;
      expect(parent.refs.get('lines')?.map((r) => r.target)).toContain(answer);
      // Untouched vanilla records do not end up in the mod.
      expect(recs.some((r) => r.stringId === '61859-Dialogue.mod')).toBe(false);
      const cli = join(editorRoot, 'packages/cli/bin/kedit.js');
      const report = execFileSync(process.execPath, [cli, 'validate', '--mod', out], { cwd: editorRoot, encoding: 'utf8' });
      expect(report).toContain('errors 0');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  } finally {
    await closeApp(app);
  }
});

test('dialogue graph: right-click menu, text right in the node, F2, Ctrl+D, Delete, insert between, undo/redo, save', async () => {
  const { app, page } = await launch();
  try {
    await app.evaluate(({ BrowserWindow }) => { BrowserWindow.getAllWindows()[0]?.setSize(1600, 1000); });
    await expect(page.getByTestId('open-vanilla')).toBeVisible({ timeout: 60_000 });
    await page.getByTestId('open-vanilla').click();
    await waitEditor(page);
    await page.getByTestId('window-menu').click();
    await page.getByTestId('window-preset-dialogue').click();
    await page.getByTestId('search').fill('61857-Dialogue.mod');
    await page.getByTestId('record-list').locator('[data-sid="61857-Dialogue.mod"]').click();
    const graph = page.getByTestId('dialogue-graph');
    const stats = graph.getByTestId('dg-stats');
    await expect(stats).toContainText('узлов 5', { timeout: 60_000 });
    await expect(graph.getByTestId('dg-hint')).toContainText('ПКМ — меню');
    const node = (sid: string) => graph.locator(`[data-testid="dg-node"][data-id="${sid}"]`);
    const edge = (from: string, to: string) => graph.locator(`[data-testid^="rf__edge-${from}>${to}#"]`);
    const menu = graph.getByTestId('dg-menu');
    const edit = graph.getByTestId('dg-edit');
    const editingId = async (): Promise<string> => (await graph.locator('.dg-node.dg-editing').getAttribute('data-id'))!;

    // Right-click on a line opens the menu; «Добавить ответ игрока» makes a new node with a text field at once.
    await node('61861-Dialogue.mod').locator('.dg-text').first().click({ button: 'right' });
    await expect(menu).toBeVisible();
    await expect(menu.getByTestId('dg-menu-delete')).toBeVisible();
    await expect(menu.getByTestId('dg-menu-edit')).toBeVisible();
    await page.screenshot({ path: join(shots, '21-graph-menu.png') });
    await menu.getByTestId('dg-menu-add-answer').click();
    await expect(menu).toHaveCount(0);
    await expect(stats).toContainText('узлов 6');
    await expect(edit).toBeFocused();
    const answer = await editingId();
    expect(answer).toMatch(/^\d+-/);
    await page.keyboard.type('Где ставить базу?');
    await page.keyboard.press('Enter');
    await expect(edit).toHaveCount(0);
    await expect(node(answer)).toContainText('Где ставить базу?');
    await expect(node(answer)).toHaveAttribute('data-status', 'new');

    // Ctrl+Z removes the text, Ctrl+Y brings it back.
    await page.keyboard.press('Control+z');
    await expect(node(answer)).not.toContainText('Где ставить базу?');
    await page.keyboard.press('Control+y');
    await expect(node(answer)).toContainText('Где ставить базу?');

    // Double-click edits; Esc cancels without changes.
    await node(answer).locator('.dg-text').first().dblclick();
    await expect(edit).toBeFocused();
    await edit.fill('Не то');
    await edit.press('Escape');
    await expect(edit).toHaveCount(0);
    await expect(node(answer)).toContainText('Где ставить базу?');

    // F2 edits; Enter saves.
    await node(answer).locator('.dg-text').first().click();
    await page.keyboard.press('F2');
    await expect(edit).toBeFocused();
    await edit.fill('Повтори, где ставить базу?');
    await page.screenshot({ path: join(shots, '22-graph-inline-edit.png') });
    await edit.press('Enter');
    await expect(node(answer)).toContainText('Повтори, где ставить базу?');

    // Ctrl+D makes a copy next to it; Delete removes it (new, no prompt).
    await page.keyboard.press('Control+d');
    await expect(stats).toContainText('узлов 7');
    const copyId = (await graph.locator('.dg-node.dg-selected').getAttribute('data-id'))!;
    expect(copyId).not.toBe(answer);
    await expect(node(copyId)).toContainText('Повтори, где ставить базу?');
    await page.keyboard.press('Delete');
    await expect(stats).toContainText('узлов 6');
    await expect(node(copyId)).toHaveCount(0);

    // Right-click on a link — «Вставить реплику между»: the new line goes in the middle, with a text field at once.
    await edge('61861-Dialogue.mod', answer).dispatchEvent('contextmenu');
    await expect(menu).toHaveAttribute('data-kind', 'edge');
    await menu.getByTestId('dg-menu-insert').click();
    await expect(stats).toContainText('узлов 7');
    await expect(edit).toBeFocused();
    const mid = await editingId();
    await page.keyboard.type('Погоди.');
    await page.keyboard.press('Enter');
    await expect(node(mid)).toContainText('Погоди.');
    await expect(edge(mid, answer)).toHaveCount(1);
    await expect(edge('61861-Dialogue.mod', answer)).toHaveCount(0);
    // Two undos: text, then the insert; two redos bring them back.
    await page.keyboard.press('Control+z');
    await page.keyboard.press('Control+z');
    await expect(stats).toContainText('узлов 6');
    await expect(node(mid)).toHaveCount(0);
    await page.keyboard.press('Control+y');
    await page.keyboard.press('Control+y');
    await expect(node(mid)).toContainText('Погоди.');

    // A line from the game: right-click → «Удалить» asks; undo reverts the deletion.
    await graph.getByRole('button', { name: /Показать всё/ }).click();
    await page.waitForTimeout(400);
    await node('61860-Dialogue.mod').locator('.dg-text').first().click({ button: 'right' });
    await menu.getByTestId('dg-menu-delete').click();
    const ask = graph.getByTestId('dg-ask');
    await expect(ask).toContainText('из игры: 1');
    await page.screenshot({ path: join(shots, '23-graph-delete-ask.png') });
    await ask.getByTestId('dg-ask-yes').click();
    await expect(ask).toHaveCount(0);
    await expect(node('61860-Dialogue.mod')).toHaveCount(0);
    await page.keyboard.press('Control+z');
    await expect(node('61860-Dialogue.mod')).toBeVisible();

    // «Открыть реплику» shows the selected line in the «Реплика» panel.
    await node(mid).locator('.dg-text').first().click();
    await graph.getByTestId('dg-open-line').click();
    await expect(page.getByTestId('line-inspector')).toHaveAttribute('data-sid', mid);

    // Save to a temp folder; kedit validate — no errors.
    const dir = mkdtempSync(join(tmpdir(), 'kedit-dg-'));
    const out = join(dir, 'GraphEdit.mod');
    try {
      await stubSaveDialog(app, out);
      await page.getByTestId('save').click();
      await expect(page.getByTestId('save')).not.toHaveClass(/primary/);
      const recs = recordsOf(out);
      const a = recs.find((r) => r.stringId === answer)!;
      expect(decodeText(a.strings.get('text0')!)).toBe('Повтори, где ставить базу?');
      const m = recs.find((r) => r.stringId === mid)!;
      expect(decodeText(m.strings.get('text0')!)).toBe('Погоди.');
      expect(m.refs.get('lines')?.map((r) => r.target)).toEqual([answer]);
      const parentLines = recs.find((r) => r.stringId === '61861-Dialogue.mod')!.refs.get('lines')?.map((r) => r.target) ?? [];
      expect(parentLines).toContain(mid);
      expect(parentLines).not.toContain(answer);
      expect(recs.some((r) => r.stringId === copyId)).toBe(false);
      expect(recs.some((r) => r.stringId === '61860-Dialogue.mod')).toBe(false);
      const cli = join(editorRoot, 'packages/cli/bin/kedit.js');
      const report = execFileSync(process.execPath, [cli, 'validate', '--mod', out], { cwd: editorRoot, encoding: 'utf8' });
      expect(report).toContain('errors 0');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  } finally {
    await closeApp(app);
  }
});

test('edit history: ↶ ↷ circles with step list, History panel, jump to a step and back', async () => {
  const { app, page } = await launch();
  try {
    await expect(page.getByTestId('open-vanilla')).toBeVisible({ timeout: 60_000 });
    await page.getByTestId('open-vanilla').click();
    await waitEditor(page);
    await selectRecord(page, 'katana', KATANA);
    await page.getByTestId('field-filter').fill('cut damage');
    const input = page.getByTestId(`field-${CUT}`);
    const original = await input.inputValue();
    // Three edits, three steps.
    for (const v of ['1.1', '1.2', '1.3']) {
      await input.fill(v);
      await input.press('Enter');
      await expect(input).toHaveValue(v);
    }
    await expect(page.getByTestId('undo')).toHaveAttribute('title', /Ctrl\+Z/);
    await expect(page.getByTestId('undo')).toHaveAttribute('title', new RegExp(`Изменено «${CUT}»`));

    // ▾ on the back circle: recent steps, newest on top, with readable names.
    await page.getByTestId('undo-menu').click();
    const undoSteps = page.getByTestId('undo-list').getByTestId('undo-step');
    await expect(undoSteps).toHaveCount(3);
    await expect(undoSteps.first()).toContainText(`Изменено «${CUT}» у`);
    await undoSteps.nth(1).hover();
    await expect(page.getByTestId('undo-list')).toContainText('Отменить 2 шага');
    await page.screenshot({ path: join(shots, '24-history-menu.png') });
    // Clicking the second from the top undoes the last two steps.
    await undoSteps.nth(1).click();
    await expect(page.getByTestId('undo-list')).toHaveCount(0);
    await expect(input).toHaveValue('1.1');
    // ↷ one step at a time and by right-click: the redo list.
    await page.getByTestId('redo').click();
    await expect(input).toHaveValue('1.2');
    await page.getByTestId('redo').click({ button: 'right' });
    await expect(page.getByTestId('redo-list').getByTestId('redo-step')).toHaveCount(1);
    await page.keyboard.press('Escape');
    await expect(page.getByTestId('redo-list')).toHaveCount(0);
    await page.getByTestId('redo').click();
    await expect(input).toHaveValue('1.3');

    // «История» panel (from the «Вся история…» list): all steps, where you are now.
    await page.getByTestId('undo-menu').click();
    await page.getByTestId('history-all').click();
    const panel = page.getByTestId('history-panel');
    await expect(panel).toBeVisible();
    const rows = panel.getByTestId('history-step');
    await expect(rows).toHaveCount(4); // «Мод как при открытии» + 3 steps
    await expect(rows.nth(3)).toHaveAttribute('data-state', 'current');
    await expect(rows.nth(1)).toContainText(`Изменено «${CUT}»`);
    // Clicking the first step: the last two are undone and greyed out.
    await rows.nth(1).click();
    await expect(input).toHaveValue('1.1');
    await expect(rows.nth(1)).toHaveAttribute('data-state', 'current');
    await expect(panel.locator('[data-state="future"]')).toHaveCount(2);
    await page.screenshot({ path: join(shots, '25-history-panel.png') });
    // ↷ brings back: redo list, last step, everything is back.
    await page.getByTestId('redo-menu').click();
    const redoSteps = page.getByTestId('redo-list').getByTestId('redo-step');
    await expect(redoSteps).toHaveCount(2);
    await redoSteps.last().click();
    await expect(input).toHaveValue('1.3');
    await expect(panel.locator('[data-state="future"]')).toHaveCount(0);
    await expect(rows.nth(3)).toHaveAttribute('data-state', 'current');
    // «Мод как при открытии» undoes everything.
    await rows.first().click();
    await expect(input).toHaveValue(original);
    await expect(page.getByTestId('undo')).toBeDisabled();
    // Ctrl+Y outside an input field is redo.
    await panel.click({ position: { x: 5, y: 5 } });
    await page.keyboard.press('Control+y');
    await expect(input).toHaveValue('1.1');
  } finally {
    await closeApp(app);
  }
});

/** Russian layout letters in place of Latin ones (ЙЦУКЕН): what arrives in `e.key`. */
const RU: Record<string, string> = { z: 'я', y: 'н', d: 'в', s: 'ы', c: 'с', v: 'м', f: 'а' };

/**
 * Press Ctrl(+Shift)+letter the way Windows does on the Russian layout: `key` is the Russian
 * letter, `code` and the key code are Latin. Through CDP the event takes the real input path
 * (page → window menu), so it also shows that the menu does not fire a second time.
 */
async function pressRu(cdp: CDPSession, letter: string, shift = false): Promise<void> {
  const key = shift ? RU[letter]!.toUpperCase() : RU[letter]!;
  const code = `Key${letter.toUpperCase()}`;
  const vk = letter.toUpperCase().charCodeAt(0);
  const modifiers = 2 | (shift ? 8 : 0);
  await cdp.send('Input.dispatchKeyEvent', { type: 'rawKeyDown', modifiers, key, code, windowsVirtualKeyCode: vk, nativeVirtualKeyCode: vk });
  await cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', modifiers, key, code, windowsVirtualKeyCode: vk, nativeVirtualKeyCode: vk });
}

test('keys on the Russian layout: Ctrl+Z/Y/Shift+Z/D/S by physical key, field edit inside an input', async () => {
  const { app, page } = await launch();
  try {
    await app.evaluate(({ BrowserWindow }) => { BrowserWindow.getAllWindows()[0]?.setSize(1600, 1000); });
    const cdp = await page.context().newCDPSession(page);
    await expect(page.getByTestId('open-vanilla')).toBeVisible({ timeout: 60_000 });
    await page.getByTestId('open-vanilla').click();
    await waitEditor(page);
    await page.getByTestId('window-menu').click();
    await page.getByTestId('window-preset-dialogue').click();
    await page.getByTestId('search').fill('61857-Dialogue.mod');
    await page.getByTestId('record-list').locator('[data-sid="61857-Dialogue.mod"]').click();
    const graph = page.getByTestId('dialogue-graph');
    const stats = graph.getByTestId('dg-stats');
    await expect(stats).toContainText('узлов 5', { timeout: 60_000 });
    const node = (sid: string) => graph.locator(`[data-testid="dg-node"][data-id="${sid}"]`);
    const menu = graph.getByTestId('dg-menu');
    const edit = graph.getByTestId('dg-edit');

    // Two text edits: «Раз», then «Два».
    await node('61861-Dialogue.mod').locator('.dg-text').first().click({ button: 'right' });
    await menu.getByTestId('dg-menu-add-answer').click();
    await expect(edit).toBeFocused();
    const answer = (await graph.locator('.dg-node.dg-editing').getAttribute('data-id'))!;
    await page.keyboard.type('Раз');
    await page.keyboard.press('Enter');
    await node(answer).locator('.dg-text').first().click();
    await page.keyboard.press('F2');
    await edit.fill('Два');
    await edit.press('Enter');
    await expect(node(answer)).toContainText('Два');

    // Ctrl+Я is exactly one undo (not two: the window menu does not fire after it), Ctrl+Н is redo.
    await pressRu(cdp, 'z');
    await expect(node(answer)).toContainText('Раз');
    await page.waitForTimeout(200);
    await expect(node(answer)).toContainText('Раз');
    await pressRu(cdp, 'y');
    await expect(node(answer)).toContainText('Два');
    await pressRu(cdp, 'z');
    await expect(node(answer)).toContainText('Раз');
    await pressRu(cdp, 'z', true); // Ctrl+Shift+Я is redo too
    await expect(node(answer)).toContainText('Два');

    // Ctrl+В copies the selected line; Ctrl+Я removes it.
    await node(answer).locator('.dg-text').first().click();
    await pressRu(cdp, 'd');
    await expect(stats).toContainText('узлов 7');
    await pressRu(cdp, 'z');
    await expect(stats).toContainText('узлов 6');

    // In an input field Ctrl+Я undoes typing in the field, not the mod edit.
    const search = page.getByTestId('search');
    await search.fill('');
    await search.click();
    await page.keyboard.type('abc');
    await pressRu(cdp, 'z');
    await expect(search).not.toHaveValue('abc');
    await expect(stats).toContainText('узлов 6');
    await expect(node(answer)).toContainText('Два');

    // Ctrl+Ы saves.
    const dir = mkdtempSync(join(tmpdir(), 'kedit-ru-keys-'));
    const out = join(dir, 'RuKeys.mod');
    try {
      await stubSaveDialog(app, out);
      await node(answer).locator('.dg-text').first().click();
      await pressRu(cdp, 's');
      await expect(page.getByTestId('status-msg')).toContainText('Сохранено');
      const a = recordsOf(out).find((r) => r.stringId === answer)!;
      expect(decodeText(a.strings.get('text0')!)).toBe('Два');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  } finally {
    await closeApp(app);
  }
});
