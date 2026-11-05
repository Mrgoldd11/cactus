/**
 * E2E: собранное приложение в Electron с настоящей игрой (только чтение). Сохранение — во
 * временную папку и в `editor/out/` (диалоги выбора файла подменяются в main).
 * Скриншоты — в `editor/out/screenshots/`.
 */
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { _electron as electron, expect, test, type ElectronApplication, type Page } from '@playwright/test';
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

/** Запустить приложение; `userData` — продолжить с настройками прошлого запуска. */
async function launch(userData = mkdtempSync(join(tmpdir(), 'kedit-e2e-'))): Promise<{ app: ElectronApplication; page: Page; liveFile: string; userData: string }> {
  const env: Record<string, string> = { KEDIT_USER_DATA: userData };
  for (const [k, v] of Object.entries(process.env)) if (v !== undefined && k !== 'ELECTRON_RENDERER_URL') env[k] = v;
  // Свой файл обнаружения живой связи: не трогать файл открытого у пользователя редактора.
  const liveFile = join(userData, 'live.json');
  env['KEDIT_LIVE_FILE'] = liveFile;
  const app = await electron.launch({ args: ['.'], cwd: appDir, env });
  const page = await app.firstWindow();
  await page.waitForLoadState('domcontentloaded');
  return { app, page, liveFile, userData };
}

/**
 * Закрыть приложение теста. Окна уничтожаются без события close: иначе у несохранённого мода
 * всплывает «Закрыть без сохранения?» прямо на экране и тест ждёт, пока Playwright убьёт процесс.
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

/** Подменить диалог «Сохранить как» в main: вернуть заданный путь, запомнить предложенный. */
async function stubSaveDialog(app: ElectronApplication, path: string): Promise<void> {
  await app.evaluate(({ dialog }, p) => {
    const g = globalThis as unknown as Stubs;
    dialog.showSaveDialog = (...args: unknown[]) => {
      g.saveDefaultPath = (args.at(-1) as { defaultPath?: string }).defaultPath;
      return Promise.resolve({ canceled: false, filePath: p });
    };
  }, path);
}

/** Подменить окно подтверждения в main: нажать кнопку `response`, запомнить вызов. */
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

test('ваниль: поиск, правка поля, отмена, сохранение во временную папку', async () => {
  const { app, page } = await launch();
  try {
    await expect(page.getByTestId('open-vanilla')).toBeVisible({ timeout: 60_000 });
    await expect(page.getByTestId('mods-table')).toBeVisible();
    await page.screenshot({ path: join(shots, '01-start.png') });

    await page.getByTestId('open-vanilla').click();
    await waitEditor(page);
    await page.screenshot({ path: join(shots, '02-vanilla.png') });

    // Поиск по-русски тоже работает: «Катана».
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

    // Запись в папку игры — только после подтверждения; «Отмена» ничего не пишет.
    const games = await page.evaluate(() => window.kedit.detectGames());
    const kenshi = games[0]!.kenshi;
    const gamePath = join(kenshi, 'mods', '__kedit_e2e_never_written__', 'x.mod');
    await stubMessageBox(app, 1);
    await stubSaveDialog(app, gamePath);
    await page.getByTestId('save-as').click();
    await expect(page.getByTestId('status-msg')).toContainText('отменено');
    expect((await stubs(app)).messageBoxCalls).toBe(1);
    expect(existsSync(gamePath)).toBe(false);

    // Файл прямо в `mods/` лаунчер не видит — редактор кладёт его в `mods/<имя>/<имя>.mod`.
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

test('сценарий: копия катаны, имя и урон, в ассортимент торговца, сохранение в out/', async () => {
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
    // Папки нового мода ещё нет — окно сохранения открывается в `Kenshi/mods`, а не в «Документах».
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

    await page.getByTestId('lang-en').click();
    await expect(page.getByTestId('save')).toHaveText('Save');
    await page.getByTestId('cat-mod').click();
    await page.getByTestId('record-list').locator(`[data-sid="${sid}"]`).click();
    await page.getByTestId('tab-fields').click();
    await page.getByTestId('field-filter').fill('');
    await page.screenshot({ path: join(shots, '09-english-fields.png') });
    await page.getByTestId('lang-ru').click();
  } finally {
    await closeApp(app);
  }
});

test('где в игре: катана → торговец оружием → Груз и Хэн; иконка предмета', async () => {
  const { app, page } = await launch();
  try {
    await expect(page.getByTestId('open-vanilla')).toBeVisible({ timeout: 60_000 });
    await page.getByTestId('open-vanilla').click();
    await waitEditor(page);
    await selectRecord(page, 'katana', KATANA);
    await page.getByTestId('tab-where').click();
    const where = page.getByTestId('where');
    await expect(where).toBeVisible();
    // Мир читается при первом открытии вкладки.
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

    // Щелчок по шагу пути открывает запись.
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

test('граф диалога: реплики по-русски, выбор игрока, петли; реплика, которую игра не выберет', async () => {
  const { app, page } = await launch();
  try {
    await expect(page.getByTestId('open-vanilla')).toBeVisible({ timeout: 60_000 });
    await page.getByTestId('open-vanilla').click();
    await waitEditor(page);
    // «mercenary shop»: 18 узлов, 11 вариантов игрока, 9 возвратов к меню.
    await selectRecord(page, '5464-gamedata.base', '5464-gamedata.base');
    await page.getByTestId('tab-graph').click();
    const graph = page.getByTestId('dialogue-graph');
    await expect(graph.getByTestId('dg-stats')).toContainText('узлов 18, вариантов игрока 11, петель 9', { timeout: 60_000 });
    await expect(graph.getByTestId('dg-stats')).not.toContainText('читаю перевод');
    await expect(graph.locator('.dg-node.dg-choice').first()).toBeVisible();
    // Тексты реплик — из перевода игры.
    await expect(graph.locator('.dg-text').first()).toHaveText(/[а-яё]/i);
    await expect(graph.locator('.react-flow__edge.dg-edge-back').first()).toBeAttached();
    await expect(graph.locator('.react-flow__minimap-node')).toHaveCount(18);
    // Стартовый вид — читаемый масштаб, корень виден.
    await expect(graph.locator('.react-flow__viewport')).toHaveAttribute('style', /scale\(0\.85\)/);
    await expect(graph.locator('[data-testid="dg-node"][data-id="5464-gamedata.base"]')).toBeInViewport();
    await page.screenshot({ path: join(shots, '12-dialogue-graph.png') });

    // Узкое окно: стартовый вид от корня, а не пустая середина широкого дерева.
    await app.evaluate(({ BrowserWindow }) => { BrowserWindow.getAllWindows()[0]?.setSize(1100, 640); });
    await selectRecord(page, '53976-Dialogue.mod', '53976-Dialogue.mod');
    await page.getByTestId('tab-graph').click();
    await expect(graph.getByTestId('dg-stats')).toContainText('узлов 25');
    await expect(graph.locator('[data-testid="dg-node"][data-id="53976-Dialogue.mod"]')).toBeInViewport();
    await app.evaluate(({ BrowserWindow }) => { BrowserWindow.getAllWindows()[0]?.setSize(1400, 900); });
    // По правилу игры реплика с условием на расу получает +2 и здесь не теряется.
    await expect(graph.locator('[data-kind="shadowed"]')).toHaveCount(0);
    // «Grim talks to new ally»: реплика с условием (очки 1) никогда не будет выбрана —
    // соседняя без условий раньше в списке и с очками 5.
    await selectRecord(page, '61857-Dialogue.mod', '61857-Dialogue.mod');
    await page.getByTestId('tab-graph').click();
    await expect(graph.getByTestId('dg-stats')).toContainText('узлов 5');
    const issue = graph.locator('[data-kind="shadowed"][data-node="61859-Dialogue.mod"]');
    await expect(issue).toContainText('не будет выбрана');
    await expect(issue).toContainText(/реплика «[^»]*[а-яё]/i);
    await issue.getByRole('button').click();
    // Клик по проблеме — вид переходит к реплике.
    await expect(graph.locator('.react-flow__viewport')).toHaveAttribute('style', /scale\(1\)/);
    await expect(graph.locator('[data-testid="dg-node"][data-id="61859-Dialogue.mod"] .dg-warn')).toBeInViewport();
    await page.screenshot({ path: join(shots, '13-dialogue-shadowed.png') });

    // Вкладки графа нет у записей не-диалогов: остаётся на месте прежняя вкладка «Поля».
    await selectRecord(page, 'katana', KATANA);
    await expect(page.getByTestId('tab-graph')).toHaveCount(0);
  } finally {
    await closeApp(app);
  }
});

test('разговор: какой диалог выберет игра у персонажа, начало разговора, другое событие', async () => {
  const { app, page } = await launch();
  try {
    await expect(page.getByTestId('open-vanilla')).toBeVisible({ timeout: 60_000 });
    await page.getByTestId('open-vanilla').click();
    await waitEditor(page);
    // Трактирщик болотников: торговый «Swamp Barman» без условий побеждает, остальные — при условиях.
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
    // Начало разговора — по-русски из перевода игры, с вариантами игрока; у реплики с условиями — её шанс.
    const opening = talk.getByTestId('talk-opening');
    await expect(opening).toContainText('Пляшущий Скелет', { timeout: 60_000 });
    await expect(opening.locator('.talk-choice').first()).toContainText('Давай торговать');
    await expect(opening.getByTestId('talk-line-odds').first()).toContainText('при условиях шанс 100%');
    await page.screenshot({ path: join(shots, '16-talk.png') });

    // «Как игра выбирает»: окошко с правилами; закрывается повторным кликом, кликом мимо и Esc.
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
    // Клик мимо окошка (левый край строки итога окошко не закрывает собой).
    await talk.getByTestId('talk-summary').click({ position: { x: 4, y: 4 } });
    await expect(rules).toHaveCount(0);
    await rulesBtn.click();
    await expect(rules).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(rules).toHaveCount(0);

    // Другое событие: «объявление» — диалогов нет; «вижу нейтральный отряд» — драка с атакой.
    await talk.getByTestId('talk-event').selectOption('2');
    await expect(talk.getByTestId('talk-summary')).toContainText('диалогов нет');
    await talk.getByTestId('talk-event').selectOption('3');
    await expect(talk.locator('[data-testid="talk-candidate"][data-dialog="49204-Dialogue.mod"]')).toContainText('атака');

    // Переход к диалогу из таблицы.
    await talk.getByTestId('talk-event').selectOption('1');
    await win.locator('td').nth(1).getByRole('button').first().click();
    await expect(page.getByTestId('record-sid')).toHaveText('48721-Dialogue.mod');
    // У не-персонажей вкладки нет.
    await expect(page.getByTestId('tab-talk')).toHaveCount(0);
  } finally {
    await closeApp(app);
  }
});

test('живая связь с ИИ: MCP подключается к окну, правки — набором изменений, принять и откатить', async () => {
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

    // MCP-сервер (его сессия) — по той же игре, что открыта в окне.
    const [game] = await page.evaluate(() => window.kedit.detectGames());
    session = new Session({ kenshi: game!.kenshi, workshop: game!.workshop }, editorRoot);
    const state = await session.connectEditor(liveFile);
    expect(state.modName).toBeTruthy();
    await expect(live).toHaveClass(/connected/);
    expect(decodeText(session.ctx().get(KATANA)!.name)).toBe('Katana');

    // Правка ИИ: сразу в окне, панель открывается сама.
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
    // Ссылка на запись — открывает её в редакторе с новым значением.
    await card.locator(`[data-sid="${KATANA}"]`).click();
    await expect(page.getByTestId('record-sid')).toHaveText(KATANA);
    await page.getByTestId('field-filter').fill('weight kg');
    await expect(page.getByTestId('field-weight kg')).toHaveValue('9');
    await page.screenshot({ path: join(shots, '14-ai-changeset.png') });

    // Вторая правка — переименование; пользователь её откатывает, первую принимает.
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

    // ИИ видит решения пользователя и состояние окна.
    const list = await session.editorChangesets();
    expect(list.map((c) => c.status)).toEqual(['accepted', 'rolled-back']);
    await session.sync();
    expect(decodeText(session.ctx().get(KATANA)!.name)).toBe('Katana');
    expect(session.ctx().get(KATANA)!.floats.get('weight kg')).toBe(9);
    await page.screenshot({ path: join(shots, '15-ai-accept-rollback.png') });

    // Пользователь сам поменял ту же запись — откат принятого набора запрещён с пояснением.
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
  // Окно закрыто — файл обнаружения убран.
  expect(existsSync(liveFile)).toBe(false);
});

/** Группа dockview, в которой стоит вкладка с этим текстом. */
function groupOfTab(page: Page, title: string) {
  return page.locator('.dv-groupview').filter({ has: page.locator('.dv-tab', { hasText: title }) });
}

test('рабочее пространство: перетащил панель, закрыл другую — после перезапуска раскладка та же', async () => {
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

      // Вкладку «Записи» — в середину инспектора: одна группа с двумя вкладками.
      const target = groupOfTab(page, 'Инспектор').locator('.dv-content-container');
      await page.locator('.dv-tab', { hasText: 'Записи' }).dragTo(target);
      await expect(groupOfTab(page, 'Записи').locator('.dv-tab')).toHaveCount(2);

      // «Категории» закрыть через меню «Окно», «Где в игре» открыть.
      await page.getByTestId('window-menu').click();
      await page.getByTestId('window-panel-categories').click();
      await expect(page.locator('.dv-tab', { hasText: 'Категории' })).toHaveCount(0);
      await page.getByTestId('window-menu').click();
      await page.getByTestId('window-panel-where').click();
      await expect(page.locator('.dv-tab', { hasText: 'Где в игре' })).toHaveCount(1);
      await page.screenshot({ path: join(shots, '17-workspace-moved.png') });
      // Раскладка пишется с задержкой.
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

    // «Сбросить раскладку» возвращает готовую раскладку «Данные».
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

test('проигрыватель разговора: какой диалог выбран и почему, ответы, «как будто», пример в «Как игра выбирает»', async () => {
  const { app, page } = await launch();
  try {
    await expect(page.getByTestId('open-vanilla')).toBeVisible({ timeout: 60_000 });
    await page.getByTestId('open-vanilla').click();
    await waitEditor(page);
    await page.getByTestId('window-menu').click();
    await page.getByTestId('window-preset-dialogue').click();
    // Трактирщик болотников.
    await page.getByTestId('search').fill('50638-rebirth.mod');
    await page.getByTestId('record-list').locator('[data-sid="50638-rebirth.mod"]').click();
    const player = page.getByTestId('player');
    await expect(player).toHaveAttribute('data-sid', '50638-rebirth.mod');
    const first = player.getByTestId('pl-step').first();
    const opt = (sid: string) => first.locator(`[data-testid="pl-option"][data-sid="${sid}"]`);
    // «Как будто все условия выполнены»: побеждает реплика беглого бандита (у неё больше очков за условия).
    await expect(opt('14394-Dialogue (4).mod')).toHaveAttribute('data-why', 'chosen');
    await expect(opt('48721-Dialogue.mod')).toHaveAttribute('data-why', 'outscored');
    // Только записи без условий: обычный «Swamp Barman», начало разговора по-русски, три ответа.
    await player.getByTestId('pl-mode').selectOption('none');
    await expect(opt('48721-Dialogue.mod')).toHaveAttribute('data-why', 'chosen');
    await expect(opt('48721-Dialogue.mod').getByTestId('pl-why')).toContainText('больше всех очков');
    await expect(opt('14394-Dialogue (4).mod')).toHaveAttribute('data-why', 'fails');
    await expect(opt('14394-Dialogue (4).mod').getByTestId('pl-why')).toContainText('условия не выполнены');
    await expect(first.getByTestId('pl-said')).toContainText('Пляшущий Скелет', { timeout: 60_000 });
    await expect(first.getByTestId('pl-answer')).toHaveCount(3);
    await page.screenshot({ path: join(shots, '18-player.png') });

    // Ответ игрока → реплика трактирщика и шесть новых ответов; «вернуться» — назад.
    await first.locator('[data-testid="pl-answer"][data-sid="48725-Dialogue.mod"]').click();
    await expect(player.getByTestId('pl-step')).toHaveCount(2);
    const second = player.getByTestId('pl-step').nth(1);
    await expect(second.getByTestId('pl-said')).toHaveAttribute('data-sid', '48726-Dialogue.mod');
    await expect(second.getByTestId('pl-answer')).toHaveCount(6);
    await page.screenshot({ path: join(shots, '18b-player-answer.png') });
    await first.getByTestId('pl-back').click();
    await expect(player.getByTestId('pl-step')).toHaveCount(1);

    // «Как будто условия бандита выполнены»: диалог проходит, но у его реплик свои условия — внутри
    // ничего не подходит, игра его пропускает.
    const bandit = opt('14394-Dialogue (4).mod');
    await bandit.getByTestId('pl-asif').locator('input').check();
    await expect(bandit).toHaveAttribute('data-why', 'empty');
    await expect(bandit.getByTestId('pl-why')).toContainText('внутри ничего не подходит');
    await expect(opt('48721-Dialogue.mod')).toHaveAttribute('data-why', 'chosen');
    // Обратно «как будто выполнены»; снять галочку у бандита — выбор переходит к следующему, сброс возвращает.
    await player.getByTestId('pl-mode').selectOption('met');
    await expect(bandit).toHaveAttribute('data-why', 'chosen');
    await bandit.getByTestId('pl-asif').locator('input').uncheck();
    await expect(bandit).toHaveAttribute('data-why', 'fails');
    await expect(opt('5934-Dialogue.mod')).toHaveAttribute('data-why', 'chosen');
    await player.getByTestId('pl-reset-asif').click();
    await expect(bandit).toHaveAttribute('data-why', 'chosen');
    await player.getByTestId('pl-mode').selectOption('none');
    await expect(opt('48721-Dialogue.mod')).toHaveAttribute('data-why', 'chosen');

    // Клик по реплике — её диалог открывается в графе, сама реплика — в инспекторе реплики.
    await first.getByTestId('pl-said').getByRole('button').click();
    await expect(page.getByTestId('dialogue-graph')).toHaveAttribute('data-sid', '48721-Dialogue.mod');
    await expect(page.getByTestId('line-inspector')).toHaveAttribute('data-sid', '48722-Dialogue.mod');
    await expect(player).toHaveAttribute('data-sid', '50638-rebirth.mod');
    await page.screenshot({ path: join(shots, '18c-player-line.png') });

    // «Как игра выбирает диалог»: правило и пример на этом персонаже.
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

test('ванильный диалог: новый ответ, связь перетаскиванием, отмена/повтор, сохранение, kedit validate без ошибок', async () => {
  const { app, page } = await launch();
  try {
    await app.evaluate(({ BrowserWindow }) => { BrowserWindow.getAllWindows()[0]?.setSize(1600, 1000); });
    await expect(page.getByTestId('open-vanilla')).toBeVisible({ timeout: 60_000 });
    await page.getByTestId('open-vanilla').click();
    await waitEditor(page);
    await page.getByTestId('window-menu').click();
    await page.getByTestId('window-preset-dialogue').click();
    // «Grim talks to new ally»: 5 узлов. Последняя реплика Грима — «Grow me some hemp, got it?».
    await page.getByTestId('search').fill('61857-Dialogue.mod');
    await page.getByTestId('record-list').locator('[data-sid="61857-Dialogue.mod"]').click();
    const graph = page.getByTestId('dialogue-graph');
    await expect(graph.getByTestId('dg-stats')).toContainText('узлов 5', { timeout: 60_000 });
    const node = (sid: string) => graph.locator(`[data-testid="dg-node"][data-id="${sid}"]`);
    await node('61861-Dialogue.mod').locator('.dg-text').first().click();
    const insp = page.getByTestId('line-inspector');
    await expect(insp).toHaveAttribute('data-sid', '61861-Dialogue.mod');

    // Новый ответ игрока под репликой: новая запись с новым id, текст.
    await insp.getByTestId('ln-add-answer').click();
    await expect(insp).not.toHaveAttribute('data-sid', '61861-Dialogue.mod');
    const answer = (await insp.getAttribute('data-sid'))!;
    expect(answer).toMatch(/^\d+-/);
    await insp.getByTestId('ln-text-0').fill('Повтори-ка, где ставить базу?');
    await insp.getByTestId('ln-text-0').blur();
    await expect(graph.getByTestId('dg-stats')).toContainText('узлов 6');
    await expect(node(answer)).toContainText('Повтори-ка');

    // Связь: перетащить с правого края нового ответа на реплику «Set up a base…» (петля назад).
    // «Показать всё», затем уменьшить: у края графа при перетаскивании вид сам прокручивается.
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

    // Отмена снимает связь, повтор возвращает.
    await page.getByTestId('undo').click();
    await expect(insp.getByTestId('ln-next-item')).toHaveCount(0);
    await page.getByTestId('redo').click();
    await expect(insp.getByTestId('ln-next-item')).toHaveCount(1);

    // Сохранение во временную папку; kedit validate по сохранённому моду — без ошибок.
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
      // Ванильные записи, которые не трогали, в мод не попадают.
      expect(recs.some((r) => r.stringId === '61859-Dialogue.mod')).toBe(false);
      const cli = join(editorRoot, 'packages/cli/bin/kedit.js');
      const report = execFileSync(process.execPath, [cli, 'validate', '--mod', out], { cwd: editorRoot, encoding: 'utf8' });
      expect(report).toContain('ошибок 0');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  } finally {
    await closeApp(app);
  }
});

test('граф диалога: меню ПКМ, текст прямо в узле, F2, Ctrl+D, Delete, вставка между, отмена/повтор, сохранение', async () => {
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

    // ПКМ по реплике — меню; «Добавить ответ игрока» — новый узел сразу с полем текста.
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

    // Ctrl+Z снимает текст, Ctrl+Y возвращает.
    await page.keyboard.press('Control+z');
    await expect(node(answer)).not.toContainText('Где ставить базу?');
    await page.keyboard.press('Control+y');
    await expect(node(answer)).toContainText('Где ставить базу?');

    // Двойной клик — правка; Esc — отмена без изменений.
    await node(answer).locator('.dg-text').first().dblclick();
    await expect(edit).toBeFocused();
    await edit.fill('Не то');
    await edit.press('Escape');
    await expect(edit).toHaveCount(0);
    await expect(node(answer)).toContainText('Где ставить базу?');

    // F2 — правка; Enter сохраняет.
    await node(answer).locator('.dg-text').first().click();
    await page.keyboard.press('F2');
    await expect(edit).toBeFocused();
    await edit.fill('Повтори, где ставить базу?');
    await page.screenshot({ path: join(shots, '22-graph-inline-edit.png') });
    await edit.press('Enter');
    await expect(node(answer)).toContainText('Повтори, где ставить базу?');

    // Ctrl+D — копия рядом; Delete — удалить её (новая, без вопроса).
    await page.keyboard.press('Control+d');
    await expect(stats).toContainText('узлов 7');
    const copyId = (await graph.locator('.dg-node.dg-selected').getAttribute('data-id'))!;
    expect(copyId).not.toBe(answer);
    await expect(node(copyId)).toContainText('Повтори, где ставить базу?');
    await page.keyboard.press('Delete');
    await expect(stats).toContainText('узлов 6');
    await expect(node(copyId)).toHaveCount(0);

    // ПКМ по связи — «Вставить реплику между»: новая встаёт посередине, сразу с полем текста.
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
    // Две отмены: текст, затем вставку; два повтора — обратно.
    await page.keyboard.press('Control+z');
    await page.keyboard.press('Control+z');
    await expect(stats).toContainText('узлов 6');
    await expect(node(mid)).toHaveCount(0);
    await page.keyboard.press('Control+y');
    await page.keyboard.press('Control+y');
    await expect(node(mid)).toContainText('Погоди.');

    // Реплика из игры: ПКМ → «Удалить» спрашивает; удаление снимается отменой.
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

    // «Открыть реплику» показывает выбранную реплику в панели «Реплика».
    await node(mid).locator('.dg-text').first().click();
    await graph.getByTestId('dg-open-line').click();
    await expect(page.getByTestId('line-inspector')).toHaveAttribute('data-sid', mid);

    // Сохранение во временную папку; kedit validate — без ошибок.
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
      expect(report).toContain('ошибок 0');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  } finally {
    await closeApp(app);
  }
});
