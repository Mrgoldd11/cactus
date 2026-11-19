/**
 * E2E: package dialogue events in plain words.
 * - DIALOGUE and DIALOGUE_LINE show «Plays when: <event> — who: <character> (via package …)».
 * - A package shows each event as «translation · EV_NAME (number)» under the reference.
 * - The event picker finds events by translation, EV name and number.
 */
import { mkdirSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { _electron as electron, expect, test, type ElectronApplication, type Page } from '@playwright/test';

const appDir = resolve(import.meta.dirname, '..');
const editorRoot = resolve(appDir, '../..');
const shots = join(editorRoot, 'out', 'screenshots', 'ux');
mkdirSync(shots, { recursive: true });

/** Beep (character) → «beep (player)» package → event 20 → «beep healing other» → line «Бип.». */
const BEEP = '57390-rebirth.mod';
const BEEP_PKG = '57330-rebirth.mod';
const BEEP_HEAL = '57331-rebirth.mod';
const BEEP_LINE = '57332-rebirth.mod';

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

test('events: «plays when» on a dialogue and a line, the event caption in a package, event search', async () => {
  const { app, page } = await launch();
  try {
    await app.evaluate(({ BrowserWindow }) => {
      BrowserWindow.getAllWindows()[0]?.setSize(1400, 900);
    });
    await expect(page.getByTestId('open-vanilla')).toBeVisible({ timeout: 60_000 });
    await page.getByTestId('open-vanilla').click();
    await expect(page.getByTestId('editor')).toBeVisible({ timeout: 120_000 });

    // Dialogue: the event with its translation, code and number, who says it and through which package.
    await pick(page, BEEP_HEAL);
    const when = page.getByTestId('plays-when');
    await expect(when).toHaveAttribute('data-state', 'in');
    await expect(when).toContainText('Звучит, когда:');
    const row = when.locator(`[data-testid="plays-when-row"][data-pkg="${BEEP_PKG}"]`);
    await expect(row.getByTestId('plays-when-events')).toHaveText('Закончил лечить другого · EV_HEALING_OTHER_FINISHED (20)');
    await expect(row).toContainText('у кого:');
    await expect(row.locator(`button[title="${BEEP}"]`)).toHaveCount(1);
    await expect(row.locator(`button[title="${BEEP_PKG}"]`)).toHaveCount(1);
    await expect(row).toContainText('через пакет');
    await expect(when.getByTestId('plays-when-tip')).not.toBeEmpty();
    await when.screenshot({ path: join(shots, '70-plays-when-dialogue.png') });
    await page.screenshot({ path: join(shots, '74-dialogue-window.png') });
    // The holder link goes to the character.
    await row.locator(`button[title="${BEEP}"]`).click();
    await expect(page.getByTestId('record-sid')).toHaveText(BEEP);

    // A line: the same, prefixed by the dialogue it belongs to.
    await pick(page, BEEP_LINE);
    const lineRow = page.getByTestId('plays-when').getByTestId('plays-when-row').first();
    await expect(lineRow).toContainText('в диалоге');
    await expect(lineRow.locator(`button[title="${BEEP_HEAL}"]`)).toHaveCount(1);
    await expect(lineRow.getByTestId('plays-when-events')).toContainText('EV_HEALING_OTHER_FINISHED (20)');
    await page.getByTestId('plays-when').screenshot({ path: join(shots, '76-plays-when-line.png') });

    // Package: the events of a reference read in words next to the code and number.
    await pick(page, BEEP_PKG);
    const caption = page.getByTestId(`ref-events-${BEEP_HEAL}`);
    await expect(caption).toHaveText(/^Закончил лечить другого · EV_HEALING_OTHER_FINISHED \(20\)/);
    await expect(page.getByTestId(`ref-ev0-${BEEP_HEAL}`)).toHaveValue('20');
    await page.getByTestId(`ref-ev0-${BEEP_HEAL}-box`).screenshot({ path: join(shots, '71-package-event.png') });
    await caption.locator('xpath=..').screenshot({ path: join(shots, '72-package-ref-row.png') });
    await caption.scrollIntoViewIfNeeded();
    await page.screenshot({ path: join(shots, '75-package-window.png') });

    // No bare event numbers in the package: the reference line is not «… 20 0 0».
    await expect(page.getByTestId(`ref-ev0-${BEEP_HEAL}`).locator('option:checked')).toHaveText(/ · EV_HEALING_OTHER_FINISHED \(20\)$/);

    // Event search in the conversation tab of a character: by translation, by number, by EV name.
    await pick(page, BEEP);
    await page.getByTestId('tab-talk').click();
    const search = page.getByTestId('talk-event-search');
    const options = page.getByTestId('talk-event').locator('optgroup option');
    await search.fill('кислот');
    await expect(options).toHaveCount(3);
    await expect(options.filter({ hasText: 'Кислотный дождь · EV_ACID_RAIN (62)' })).toHaveCount(1);
    await page.getByTestId('talk-event-box').screenshot({ path: join(shots, '73-event-search.png') });
    await search.fill('62');
    await expect(options).toHaveText(['Кислотный дождь · EV_ACID_RAIN (62)']);
    await search.fill('EV_HEALING_OTHER_FINISHED');
    await expect(options).toHaveCount(1);
    // Enter picks the first match.
    await search.press('Enter');
    await expect(page.getByTestId('talk-event')).toHaveValue('20');
    await expect(search).toHaveValue('');
  } finally {
    await closeApp(app);
  }
});
