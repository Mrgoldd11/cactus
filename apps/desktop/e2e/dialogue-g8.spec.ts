/**
 * E2E: the dialogue editor after the live check (UI review G8).
 * - The graph of a DIALOGUE reads left to right: event → who has the package → the dialogue → its lines.
 * - A click on the dialogue shows «Dialogue line» with «When it may play» switches, each with its FCS name.
 * - «+ if» on a node opens the whole condition list next to it («All conditions (N)»), search by Russian,
 *   English and code; the added condition shows on the node and in the panel; «×» removes it; Ctrl+Z brings it back.
 * - A click on a phrase row on the node opens its editor next to it: the list of a reference condition
 *   (races, factions…) — remove one, add another; who / comparison / value of a DC_ condition. One undo step
 *   each, the node and the panel show the change at once.
 * - Dialogues started without a package (biome arrival, faction campaign) and only from another dialogue.
 * Screenshots 116–124 in out/screenshots/ux/.
 */
import { mkdirSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { _electron as electron, expect, test, type ElectronApplication, type Page } from '@playwright/test';

const appDir = resolve(import.meta.dirname, '..');
const editorRoot = resolve(appDir, '../..');
const shots = join(editorRoot, 'out', 'screenshots', 'ux');
mkdirSync(shots, { recursive: true });

/** «acid rain» (rebirth): EV_ACID_RAIN (62) in «player character default». */
const ACID_RAIN = '55630-rebirth.mod';
/** «Acid water»: EV_ACID_WATER (63) in ten packages. */
const ACID_WATER = '55771-Dialogue.mod';
/** «Healed (Recruit)»: with an entry portal. */
const HEALED = '8950-Dialogue.mod';
/** Line «My skin! This water's eating right through me!» of «Acid water»: my race — Greenlander, Scorchlander or Shek. */
const MY_SKIN = '55776-Dialogue.mod';
const SHEK = '5276-chareditor.mod';
const SKELETON = '17946-stick_people.mod';
/** «biome Holy Nation»: said when the player squad enters the biome group (BIOME_GROUP.arrival dialog). */
const BIOME = '47039-Dialogue.mod';
/** «Bounty extortion pay»: in no package, started from «Small bounty». */
const FROM_OTHER = '44152-Dialogue.mod';
/** «in cage - npc»: nothing refers to it. */
const NOWHERE = '2801-gamedata.base';

async function launch(): Promise<{ app: ElectronApplication; page: Page }> {
  const userData = mkdtempSync(join(tmpdir(), 'kedit-e2e-'));
  const env: Record<string, string> = { KEDIT_USER_DATA: userData, KEDIT_LIVE_FILE: join(userData, 'live.json') };
  for (const [k, v] of Object.entries(process.env)) if (v !== undefined && k !== 'ELECTRON_RENDERER_URL' && !(k in env)) env[k] = v;
  const app = await electron.launch({ args: ['.'], cwd: appDir, env });
  const page = await app.firstWindow();
  await page.waitForLoadState('domcontentloaded');
  // These checks read the FCS codes next to the words: turn the «FCS codes» setting on (off by default).
  await page.evaluate(() => {
    localStorage.setItem('kedit.fcsCodes', '1');
  });
  await page.reload();
  await page.waitForLoadState('domcontentloaded');
  return { app, page };
}

async function closeApp(app: ElectronApplication): Promise<void> {
  await app
    .evaluate(({ BrowserWindow }) => {
      for (const w of BrowserWindow.getAllWindows()) w.destroy();
    })
    .catch(() => undefined);
  await app.close();
}

/** Vanilla with a new mod (so edits are allowed), the «Dialogues» layout. */
async function open(app: ElectronApplication, page: Page): Promise<void> {
  await app.evaluate(({ BrowserWindow }) => {
    BrowserWindow.getAllWindows()[0]?.setSize(1400, 900);
  });
  await expect(page.getByTestId('open-vanilla')).toBeVisible({ timeout: 60_000 });
  await page.getByTestId('new-mod-name').fill('G8');
  await page.getByTestId('create-mod').click();
  await expect(page.getByTestId('editor')).toBeVisible({ timeout: 120_000 });
  await page.getByTestId('window-menu').click();
  await page.getByTestId('window-preset-dialogue').click();
}

async function select(page: Page, sid: string): Promise<void> {
  await page.locator('.dv-tab', { hasText: 'Записи' }).first().click();
  await page.getByTestId('search').first().fill(sid);
  await page.getByTestId('record-list').first().locator(`[data-sid="${sid}"]`).click();
  await expect(page.locator(`[data-testid="dg-node"][data-id="${sid}"]`)).toBeVisible({ timeout: 30_000 });
  await page.waitForTimeout(600);
}

const node = (page: Page, sid: string) => page.locator(`[data-testid="dg-node"][data-id="${sid}"]`);

test('G8: event → who → dialogue, the dialogue panel, «+ if» with the whole list, «×» and undo', async () => {
  const { app, page } = await launch();
  try {
    await open(app, page);

    // Acid rain on a full-HD window (the whole test runs at 1920): the graph starts with the event and the «who» card.
    await app.evaluate(({ BrowserWindow }) => { BrowserWindow.getAllWindows()[0]?.setSize(1920, 900); });
    await select(page, ACID_RAIN);
    const ev = page.getByTestId('dg-when-event');
    await expect(ev).toHaveCount(1);
    await expect(ev).toContainText('Кислотный дождь');
    await expect(ev).toContainText('EV_ACID_RAIN (62)');
    const who = page.getByTestId('dg-when-who');
    await expect(who).toHaveCount(1);
    await expect(who).toContainText('player character default');
    // Left to right: event, who, dialogue.
    const x = async (l: ReturnType<Page['locator']>): Promise<number> => (await l.boundingBox())!.x;
    expect(await x(ev)).toBeLessThan(await x(who));
    expect(await x(who)).toBeLessThan(await x(node(page, ACID_RAIN)));
    await expect(ev).toBeInViewport();
    await page.screenshot({ path: join(shots, '116-g8-acid-rain.png') });

    // A click on the dialogue: «Dialogue line» with the switches and their codes.
    await node(page, ACID_RAIN).click();
    const panel = page.getByTestId('line-inspector');
    await expect(panel).toHaveAttribute('data-sid', ACID_RAIN);
    await expect(panel).toBeVisible();
    for (const [slug, code] of [
      ['for_enemies', 'for enemies'],
      ['once_only', 'repetition limit: DR_ONCE_ONLY'],
      ['locked', 'locked'],
      ['one_at_a_time', 'one at a time'],
      ['monologue', 'monologue'],
    ] as const)
      await expect(panel.getByTestId(`dh-flag-${slug}`)).toContainText(code);
    await expect(panel.getByTestId('dh-flag-monologue').locator('input')).toBeChecked();
    await expect(panel.getByTestId('dh-like')).toBeVisible();
    await expect(panel.getByTestId('dh-hang')).toBeVisible();
    await expect(panel.getByTestId('ln-f-score bonus')).toBeVisible();
    await expect(panel.getByTestId('dh-score-tip')).toBeVisible();
    // «Only once» is the repetition limit DR_ONCE_ONLY.
    await panel.getByTestId('dh-flag-once_only').locator('input').check();
    await expect(panel.getByTestId('ln-f-repetition limit')).toHaveValue('5');
    await expect(node(page, ACID_RAIN).getByTestId('dg-badge').filter({ hasText: 'DR_ONCE_ONLY' })).toHaveCount(1);
    await panel.getByTestId('dh-flag-once_only').locator('input').uncheck();
    await expect(panel.getByTestId('ln-f-repetition limit')).toHaveValue('0');
    await page.locator('.line-panel').screenshot({ path: join(shots, '120-g8-dialogue-panel.png') });

    // «+ if» on the node: the whole list next to it.
    await node(page, ACID_RAIN).click();
    await node(page, ACID_RAIN).getByTestId('dg-add-cond').click();
    const pop = page.getByTestId('dg-pick-pop');
    await expect(pop).toBeVisible();
    const all = pop.getByTestId('ln-pick-all');
    await expect(all).toHaveText(/^Все условия \(\d+\)/);
    // DC_ values (without DC_NONE / DC_END) and reference conditions.
    expect(Number(await all.getAttribute('data-count'))).toBeGreaterThanOrEqual(79 + 13);
    await page.screenshot({ path: join(shots, '119-g8-add-if.png') });
    const search = pop.getByTestId('ln-pick-search');
    for (const q of ['раб', 'slave', 'DC_IS_SLAVE']) {
      await search.fill(q);
      await expect(pop.locator('[data-testid="ln-pick-item"][data-key="DC_IS_SLAVE"]'), q).toHaveCount(1);
    }
    await pop.locator('[data-testid="ln-pick-item"][data-key="DC_IS_SLAVE"]').click();
    await expect(pop).toHaveCount(0);
    const phrase = node(page, ACID_RAIN).getByTestId('dg-phrase');
    await expect(phrase).toHaveCount(1);
    await expect(phrase).toContainText('DC_IS_SLAVE');
    await expect(panel.getByTestId('ln-cond')).toHaveCount(1);

    // «×» on the phrase row removes it, Ctrl+Z brings it back.
    await phrase.hover();
    await phrase.getByTestId('dg-phrase-x').click();
    await expect(node(page, ACID_RAIN).getByTestId('dg-phrase')).toHaveCount(0);
    await expect(panel.getByTestId('ln-cond')).toHaveCount(0);
    await page.keyboard.press('Control+z');
    await expect(node(page, ACID_RAIN).getByTestId('dg-phrase')).toHaveCount(1);
    await expect(panel.getByTestId('ln-cond')).toHaveCount(1);

    // Acid water: ten packages — three «who» cards and «and N more».
    await select(page, ACID_WATER);
    await expect(page.getByTestId('dg-when-who')).toHaveCount(3);
    await expect(page.getByTestId('dg-when-more')).toHaveText(/^и ещё \d+ пакет/);
    await page.screenshot({ path: join(shots, '117-g8-acid-water.png') });

    // Healed (Recruit): the chain and the entry portal.
    await select(page, HEALED);
    await expect(page.getByTestId('dg-when-event').first()).toBeVisible();
    await expect(page.getByTestId('dg-when-who').first()).toBeVisible();
    await page.screenshot({ path: join(shots, '118-g8-healed.png') });
  } finally {
    await closeApp(app);
  }
});

test('G8: every condition on the node is editable — the race list of «My skin!…», a DC_ value; undo', async () => {
  const { app, page } = await launch();
  try {
    await open(app, page);
    const panel = page.getByTestId('line-inspector');

    // The line itself: its node with «if my race is Greenlander, Scorchlander or Shek».
    await select(page, MY_SKIN);
    const phrase = node(page, MY_SKIN).getByTestId('dg-phrase');
    await expect(phrase).toHaveCount(1);
    await expect(phrase).toContainText('Зеленоземец, Жженоземец или Шек');
    await phrase.click();
    const pop = page.getByTestId('dg-edit-pop');
    await expect(pop).toBeVisible();
    await expect(pop).toHaveAttribute('data-category', 'my race');
    const targets = pop.getByTestId('ln-ref-target');
    await expect(targets).toHaveCount(3);

    // Remove Shek, add Skeleton.
    await pop.locator(`[data-testid="ln-ref-target"][data-sid="${SHEK}"]`).getByTestId('ln-ref-remove').click();
    await expect(targets).toHaveCount(2);
    await expect(phrase).not.toContainText('Шек');
    await pop.getByTestId('ln-ref-add').click();
    const picker = page.getByTestId('record-picker');
    await picker.getByTestId('picker-search').fill('Skeleton');
    await picker.getByTestId('picker-list').locator(`[data-sid="${SKELETON}"]`).dblclick();
    await expect(picker).toHaveCount(0);
    await expect(targets).toHaveCount(3);
    await expect(phrase).toContainText('Зеленоземец, Жженоземец или Скелет');
    const panelTargets = panel.locator('[data-testid="ln-ref"][data-category="my race"] [data-testid="ln-ref-target"]');
    await expect(panelTargets).toHaveCount(3);
    await expect(panel.locator(`[data-testid="ln-ref-target"][data-sid="${SKELETON}"]`)).toHaveCount(1);
    await expect(panel.locator(`[data-testid="ln-ref-target"][data-sid="${SHEK}"]`)).toHaveCount(0);
    // The panel scrolled to the same condition: node, popup and panel in one picture.
    await panel.locator('[data-testid="ln-ref"][data-category="my race"]').scrollIntoViewIfNeeded();
    await page.screenshot({ path: join(shots, '121-g8-edit-race.png') });

    // Two undo steps: Skeleton goes, Shek comes back.
    await page.locator('.react-flow__pane').click({ position: { x: 20, y: 20 } });
    await expect(pop).toHaveCount(0);
    await page.keyboard.press('Control+z');
    await expect(phrase).toContainText('Зеленоземец, Жженоземец');
    await expect(phrase).not.toContainText('Скелет');
    await page.keyboard.press('Control+z');
    await expect(phrase).toContainText('Зеленоземец, Жженоземец или Шек');
    await expect(panel.locator(`[data-testid="ln-ref-target"][data-sid="${SHEK}"]`)).toHaveCount(1);
    await expect(panelTargets).toHaveCount(3);

    // A DC_ condition of the dialogue: the value changes on the node.
    await select(page, ACID_WATER);
    const cond = node(page, ACID_WATER).getByTestId('dg-phrase').filter({ hasText: 'DC_IS_IMPRISONED' });
    await expect(cond).toContainText('= 0');
    await cond.click();
    await expect(pop).toHaveAttribute('data-category', 'conditions');
    await expect(pop.getByTestId('ln-cond-who')).toBeVisible();
    // A yes / no condition reads «yes / no» (G9), the code shows «= 0» / «= 1».
    await expect(pop.getByTestId('ln-cond-yes')).toHaveValue('0');
    await pop.getByTestId('ln-cond-yes').selectOption('1');
    await expect(cond).toContainText('= 1');
    await page.screenshot({ path: join(shots, '122-g8-edit-dc.png') });
    await page.keyboard.press('Escape');
    await expect(pop).toHaveCount(0);
    await page.keyboard.press('Control+z');
    await expect(cond).toContainText('= 0');
  } finally {
    await closeApp(app);
  }
});

test('G8: dialogues started without a package and from another dialogue read clearly', async () => {
  const { app, page } = await launch();
  try {
    await open(app, page);
    // Narrow canvas: the whole chain does not fit at 100%, so the view keeps 100% and starts at the «who» column.
    await select(page, BIOME);
    const viewport = page.getByTestId('dialogue-graph').locator('.react-flow__viewport');
    await expect(viewport).toHaveAttribute('style', /scale\(1\)/);
    await expect(page.getByTestId('dg-when-who')).toBeInViewport();
    await expect(node(page, BIOME)).toBeInViewport();
    // A full-HD window (1920 wide): the whole chain event → who → dialogue at 100%.
    await app.evaluate(({ BrowserWindow }) => { BrowserWindow.getAllWindows()[0]?.setSize(1920, 900); });
    await select(page, NOWHERE);
    // Biome arrival: the «when» card names the moment and the field, the «who» card the biome groups.
    await select(page, BIOME);
    const ev = page.getByTestId('dg-when-event');
    await expect(viewport).toHaveAttribute('style', /scale\(1\)/);
    await expect(ev).toBeInViewport();
    await expect(ev).toHaveCount(1);
    await expect(ev).toContainText('отряд игрока входит в биом');
    await expect(ev).toContainText('arrival dialog');
    await expect(page.getByTestId('dg-when-who')).toContainText('группа биомов');
    await expect(page.getByTestId('plays-when')).toContainText('отряд игрока входит в биом');
    await page.screenshot({ path: join(shots, '123-g8-biome.png') });

    // Only from another dialogue: «from another dialogue» and the entry portal, not «in no package».
    await select(page, FROM_OTHER);
    await expect(ev).toHaveCount(1);
    await expect(ev).toContainText('из другого диалога');
    await expect(page.locator('[data-testid="dg-portal"][data-dir="in"]').first()).toBeVisible();
    await expect(ev).toBeInViewport();
    await expect(page.getByTestId('plays-when-from')).toBeVisible();
    await expect(page.getByTestId('plays-when-nowhere')).toHaveCount(0);
    await page.screenshot({ path: join(shots, '124-g8-from-dialogue.png') });

    // Nothing refers to it: the honest warning.
    await select(page, NOWHERE);
    await expect(ev).toContainText('ни в одном пакете');
    await expect(page.getByTestId('plays-when-nowhere')).toBeVisible();
  } finally {
    await closeApp(app);
  }
});
