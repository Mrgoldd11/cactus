/**
 * E2E (UI review G9): the path of the mouse test `docs/ux-mouse-test-dialogue.md` once more, as a novice would do it —
 * a barman line for a skeleton, with the default settings (FCS codes off).
 * - The empty «Dialogues» screen has «New dialogue…» (О1); the wizard reads in words, yes / no conditions (О2, О3).
 * - The barman in the picker has a clean name and a hint for records with the same name (О4).
 * - «предмет» finds «give item» (О5); the item picker keeps its size while typing (М7).
 * - «Play» shows the line effects and where the points come from (О6, М9); «Check» opens next to the line panel (М8).
 * Screenshots: out/screenshots/g9/.
 */
import { mkdirSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { _electron as electron, expect, test, type ElectronApplication, type Locator, type Page } from '@playwright/test';

const appDir = resolve(import.meta.dirname, '..');
const editorRoot = resolve(appDir, '../..');
const shots = join(editorRoot, 'out', 'screenshots', 'g9');
mkdirSync(shots, { recursive: true });

const BARMAN = '1187-gamedata.base';
const SKELETON = '17946-stick_people.mod';

async function launch(): Promise<{ app: ElectronApplication; page: Page }> {
  const userData = mkdtempSync(join(tmpdir(), 'kedit-e2e-'));
  const env: Record<string, string> = { KEDIT_USER_DATA: userData, KEDIT_LIVE_FILE: join(userData, 'live.json') };
  for (const [k, v] of Object.entries(process.env)) if (v !== undefined && k !== 'ELECTRON_RENDERER_URL' && !(k in env)) env[k] = v;
  const app = await electron.launch({ args: ['.'], cwd: appDir, env });
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
  await app.close();
}

const shot = (page: Page, name: string): Promise<Buffer> => page.screenshot({ path: join(shots, `${name}.png`) });

/** Selects a node by its text and types a new line from its toolbar button. */
async function addLine(graph: Locator, from: Locator, button: 'dg-add-answer' | 'dg-add-npc', text: string): Promise<Locator> {
  await from.locator('.dg-text').first().click();
  await from.getByTestId('dg-node-tools').getByTestId(button).click();
  const edit = graph.getByTestId('dg-edit');
  await expect(edit).toBeFocused();
  await edit.page().keyboard.type(text);
  await edit.page().keyboard.press('Enter');
  const node = graph.getByTestId('dg-node').filter({ hasText: text });
  await expect(node).toHaveCount(1);
  return node;
}

test('G9: barman line for a skeleton with default settings', async () => {
  test.setTimeout(300_000);
  const { app, page } = await launch();
  try {
    await app.evaluate(({ BrowserWindow }) => { BrowserWindow.getAllWindows()[0]?.setSize(1500, 1000); });
    await page.getByTestId('new-mod-name').fill('G9 Barman Test');
    await page.getByTestId('create-mod').click();
    await expect(page.getByTestId('editor')).toBeVisible({ timeout: 120_000 });
    // М10: where the mod goes is shown before the first save.
    await expect(page.getByTestId('status-unsaved')).toContainText('Ещё не сохранён: будет сохранён в');
    await expect(page.getByTestId('status-unsaved')).toContainText('G9 Barman Test');

    // О1: the «Dialogues» screen starts with «New dialogue…», no raw type codes.
    await page.getByTestId('window-menu').click();
    await page.getByTestId('window-preset-dialogue').click();
    const start = page.getByTestId('dialogue-start').first();
    await expect(start).toBeVisible();
    await expect(page.locator('body')).not.toContainText('DIALOGUE_PACKAGE, DIALOGUE');
    await shot(page, '01-dialogues-empty');

    await start.getByTestId('ds-new').click();
    const modal = page.getByTestId('event-dialogue-modal');
    await expect(modal).toBeVisible();
    // О2: codes are off by default: the wizard reads in words.
    await expect(page.locator('html')).toHaveClass(/no-fcs-codes/);
    await modal.getByTestId('ed-event-search').fill('заговорил');
    await modal.getByTestId('ed-event-search').press('Enter');
    await expect(modal.getByTestId('ed-event').locator('option:checked')).toContainText('Игрок заговорил');
    await shot(page, '02-wizard-event');

    // О4: the barman has a clean name; records with the same name get a hint.
    await modal.getByTestId('ed-kind-character').check();
    await modal.getByTestId('ed-who').click();
    const picker = page.getByTestId('record-picker');
    await picker.getByTestId('picker-search').fill('трактир');
    const barman = picker.getByTestId('picker-list').locator(`[data-sid="${BARMAN}"]`);
    await expect(barman).toBeVisible();
    await expect(picker.getByTestId('picker-list')).not.toContainText('/кца1/');
    await barman.click();
    await shot(page, '03-who-barman');
    await barman.dblclick();
    await expect(picker).toHaveCount(0);
    await expect(modal.getByTestId('ed-who')).toContainText('Трактирщик');
    await modal.getByTestId('ed-own').check();

    // О3: «met before» is a yes / no choice.
    await modal.getByTestId('ed-add-cond').click();
    await modal.getByTestId('ln-pick-search').fill('встречал');
    await modal.getByTestId('ln-pick-search').press('Enter');
    await expect(modal.getByTestId('ed-cond')).toHaveCount(1);
    await modal.getByTestId('ed-cond-yes').selectOption('0');
    // The target race: «скелет» in the record picker.
    await modal.getByTestId('ed-add-cond').click();
    await modal.getByTestId('ln-pick-search').fill('раса собеседника');
    await modal.locator('[data-testid="ln-pick-item"][data-key="ref:target race"]').click();
    await picker.getByTestId('picker-search').fill('Skeleton');
    await picker.getByTestId('picker-list').locator(`[data-sid="${SKELETON}"]`).dblclick();
    await expect(modal.getByTestId('ed-conds')).toContainText('Скелет');
    await modal.getByTestId('ed-text').first().fill('Эй, жестянка! Давно у меня не было гостей без желудка. Чего надо?');
    // М11: one plain sentence above the score explanation.
    await expect(modal.getByTestId('ed-score-lead')).toContainText('Мастер уже поставил нужное число');
    await shot(page, '04-wizard-filled');
    await modal.getByTestId('ed-create').click();
    await expect(modal).toHaveCount(0);

    // М4: the package panel shows the package the wizard made.
    await expect(page.getByTestId('package-panel')).toHaveAttribute('data-sid', /.+/);
    const graph = page.locator('[data-panel="graph"]').getByTestId('dialogue-graph');
    const npc = graph.getByTestId('dg-node').filter({ hasText: 'Эй, жестянка!' });
    await expect(npc).toHaveCount(1);
    await shot(page, '05-created');

    // Answers and the barman's reply, typed in the nodes.
    const answer = await addLine(graph, npc, 'dg-add-answer', 'Масла бы. Суставы скрипят.');
    // М5: the player line says «Игрок».
    await expect(page.getByTestId('line-inspector').getByTestId('ln-speaker-player')).toContainText('Игрок');
    const reply = await addLine(graph, answer, 'dg-add-npc', 'Есть масленка для вашего брата. Держи.');
    await shot(page, '06-lines');

    // М2: zoom buttons work around the selected card.
    const viewport = graph.locator('.react-flow__viewport');
    const before = await viewport.getAttribute('style');
    await graph.getByTestId('dg-zoom-in').click();
    await expect(viewport).not.toHaveAttribute('style', before ?? '');
    await graph.getByTestId('dg-zoom-out').click();

    // О5: «предмет» finds «give item»; М6: peaceful effects come first.
    await reply.locator('.dg-text').first().click();
    const panel = page.getByTestId('line-inspector');
    await page.locator('.dv-tab', { hasText: 'Реплика диалога' }).click();
    await panel.getByTestId('ln-effect-add').click();
    const epick = panel.getByTestId('ln-pick');
    await expect(epick.getByTestId('ln-pick-item').first()).not.toContainText('Напасть');
    await shot(page, '07-effects-list');
    await epick.getByTestId('ln-pick-search').fill('предмет');
    const give = epick.locator('[data-testid="ln-pick-item"][data-key="ref:give item"]');
    await expect(give).toBeVisible();
    await shot(page, '08-effect-search');
    await give.click();

    // М7: the item picker keeps its size while typing.
    const list = picker.getByTestId('picker-list');
    await expect(list).toBeVisible();
    const box1 = await picker.boundingBox();
    await picker.getByTestId('picker-search').fill('ремкомплект');
    const kit = list.locator('[data-sid]', { hasText: 'Ремкомплект скелета' }).first();
    await expect(kit).toBeVisible();
    const box2 = await picker.boundingBox();
    expect(Math.abs((box1?.height ?? 0) - (box2?.height ?? 0))).toBeLessThan(2);
    expect(Math.abs((box1?.y ?? 0) - (box2?.y ?? 0))).toBeLessThan(2);
    await shot(page, '09-item-picker');
    await kit.dblclick();
    await expect(picker).toHaveCount(0);
    await expect(reply).toContainText('Ремкомплект скелета');

    // О6, М9: «Play» shows the effect and where the points come from.
    await page.locator('[data-panel="graph"]').getByTestId('dg-play').click();
    const player = page.getByTestId('player');
    await expect(player).toBeVisible();
    await expect(player.getByTestId('pl-sum').first()).toContainText('=');
    await shot(page, '10-play');
    await player.getByTestId('pl-answer').filter({ hasText: 'Масла бы' }).click();
    await expect(player.getByTestId('pl-effects').first()).toContainText('Затем:');
    await expect(player.getByTestId('pl-effects').first()).toContainText('Ремкомплект скелета');
    await shot(page, '11-play-effect');

    // М8: «Check» opens the diagnostics next to the line panel, not over it.
    await page.getByTestId('validate').click();
    await expect(page.getByTestId('diagnostics')).toBeVisible();
    await expect(panel).toBeVisible();
    await shot(page, '12-check');

    // М9: «How the game picks» takes the character from «Play».
    await page.locator('.dv-tab', { hasText: 'Как игра выбирает' }).click();
    await expect(page.getByTestId('howto-from-play')).toBeVisible();
    await expect(page.getByTestId('howto').getByTestId('howto-example')).toContainText('Трактирщик');
    await shot(page, '13-howto');
  } finally {
    await closeApp(app);
  }
});
