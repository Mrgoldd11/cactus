/**
 * E2E: dialogue conditions and effects in plain words (step 7f).
 * - A line shows each condition as a phrase with its code: «Сказать, только если у меня есть черта «честный»».
 * - Condition and effect pickers read «translation · CODE» and find a value by translation, English and code.
 * - The Conversation tab shows the same phrases for the dialogues of a character.
 */
import { mkdirSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { _electron as electron, expect, test, type ElectronApplication, type Page } from '@playwright/test';

const appDir = resolve(import.meta.dirname, '..');
const editorRoot = resolve(appDir, '../..');
const shots = join(editorRoot, 'out', 'screenshots', 'ux');
mkdirSync(shots, { recursive: true });

/** Escapes: a guard line «only if I am honorable» → arrest the target, sound the alarm. */
const HONEST_LINE = '13644-Escapes.mod';
/** Swampers barman (the Conversation tab test in app.spec.ts). */
const BARMAN = '50638-rebirth.mod';

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

async function pick(page: Page, sid: string): Promise<void> {
  await page.getByTestId('search').fill(sid);
  await page.getByTestId('record-list').locator(`[data-sid="${sid}"]`).click();
  await expect(page.getByTestId('record-sid')).toHaveText(sid);
}

test('conditions: phrases with codes, «translation · CODE» pickers, search by translation, English and code', async () => {
  const { app, page } = await launch();
  try {
    await app.evaluate(({ BrowserWindow }) => {
      BrowserWindow.getAllWindows()[0]?.setSize(1400, 900);
    });
    await expect(page.getByTestId('open-vanilla')).toBeVisible({ timeout: 60_000 });
    await page.getByTestId('open-vanilla').click();
    await expect(page.getByTestId('editor')).toBeVisible({ timeout: 120_000 });

    // A line: the condition reads as a sentence, the code stays next to it.
    await page.getByTestId('window-menu').click();
    await page.getByTestId('window-preset-dialogue').click();
    await page.locator('.dv-tab', { hasText: 'Записи' }).click();
    await page.getByTestId('search').fill(HONEST_LINE);
    await page.getByTestId('record-list').locator(`[data-sid="${HONEST_LINE}"]`).click();
    await expect(page.getByTestId('line-inspector')).toHaveAttribute('data-sid', HONEST_LINE, { timeout: 30_000 });
    const cond = page.getByTestId('ln-cond').first();
    const phrase = cond.getByTestId('ln-cond-phrase');
    await expect(phrase).toContainText('Сказать, только если у меня есть черта «честный»');
    await expect(phrase.locator('.dh-code')).toHaveText('DC_PERSONALITY_TAG PT_HONORABLE = 1');
    await expect(cond.getByTestId('ln-cond-name').locator('option:checked')).toHaveText(/ · DC_PERSONALITY_TAG$/);
    // The trait picker reads «translation · CODE» too.
    await expect(cond.locator('select option:checked').filter({ hasText: 'PT_HONORABLE' })).toHaveText(/^[^A-Z]+ · PT_HONORABLE$/);
    const effect = page.getByTestId('ln-effect-phrase').first();
    await expect(effect).toContainText(/^Затем: /);
    await expect(page.getByTestId('ln-effect-name').first().locator('option:checked')).toHaveText(/ · DA_[A-Z_]+$/);
    await page.locator('.ln-section').filter({ has: cond }).screenshot({ path: join(shots, '80-line-conditions.png') });

    // Search in the condition picker: Russian translation, English name, code prefix.
    const search = cond.getByTestId('ln-cond-name-search');
    const options = cond.getByTestId('ln-cond-name').locator('optgroup option');
    for (const q of ['голод', 'starv', 'DC_STARV']) {
      await search.fill(q);
      await expect(options.filter({ hasText: 'Голодает · DC_STARVING' }), q).toHaveCount(1);
    }
    await cond.getByTestId('ln-cond-name-box').screenshot({ path: join(shots, '81-condition-search.png') });
    // Enter picks the first match and the phrase follows.
    await search.fill('DC_STARV');
    await search.press('Enter');
    await expect(search).toHaveValue('');
    await expect(page.getByTestId('ln-cond-phrase').first()).toContainText('Сказать, только если я голодаю');
    await page.screenshot({ path: join(shots, '82-line-window.png') });

    // The Conversation tab: dialogue conditions as phrases.
    await page.getByTestId('window-menu').click();
    await page.getByTestId('window-preset-data').click();
    await pick(page, BARMAN);
    await page.getByTestId('tab-talk').click();
    const talk = page.getByTestId('talk');
    await expect(talk.getByTestId('talk-candidate')).toHaveCount(5);
    const condPhrase = talk.getByTestId('talk-cond-phrase').first();
    await expect(condPhrase).toContainText(/^\? Диалог начнётся, только если /);
    await expect(condPhrase.locator('.dh-code')).not.toBeEmpty();
    await page.screenshot({ path: join(shots, '83-talk-phrases.png') });
  } finally {
    await closeApp(app);
  }
});
