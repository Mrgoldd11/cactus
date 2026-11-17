/**
 * E2E: «+ New» knows the category. In Items → Books the window is titled «New book», offers the
 * first book as a sample (another one can be picked) and says what the record will be; the created record is a copy of the
 * sample (fields from it), shows up in Books and is one undo step with a clear title.
 * «empty record» drops the sample but keeps the category condition.
 */
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { _electron as electron, expect, test, type ElectronApplication, type Page } from '@playwright/test';

const appDir = resolve(import.meta.dirname, '..');

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

const BOOK_OF_GRACE = '50383-Dialogue.mod';

const countOf = async (page: Page): Promise<number> => Number(/\d+/.exec((await page.getByTestId('list-count').textContent())!)![0]);

test('«+ New» in Books: sample, category condition, record in Books, one undo', async () => {
  const { app, page } = await launch();
  try {
    await page.getByTestId('open-vanilla').waitFor({ timeout: 60_000 });
    await page.getByTestId('lang-current').click();
    await page.getByTestId('lang-ru').click();
    await page.getByTestId('new-mod-name').fill('KeditE2E NewRecord');
    await page.getByTestId('create-mod').click();
    await expect(page.getByTestId('editor')).toBeVisible({ timeout: 120_000 });
    await page.getByTestId('window-menu').click();
    await page.getByTestId('window-preset-data').click();
    await page.getByTestId('cat-Items').locator('.twisty').click();
    await page.getByTestId('cat-Items/Books').click();
    const books = await countOf(page);
    expect(books).toBeGreaterThan(5);

    await page.getByTestId('new-record').click();
    const modal = page.getByTestId('new-record-modal');
    await expect(modal).toContainText('Новая книга');
    await expect(page.getByTestId('new-record-type')).toHaveValue('ITEM');
    const sampleBtn = page.getByTestId('new-record-sample');
    // Templates like «_LETTER TEMPLATE» are not offered by default.
    await expect(sampleBtn).toHaveAttribute('data-sid', /./);
    await expect(sampleBtn).not.toContainText('_');
    await expect(page.getByTestId('new-record-will')).toContainText('в категории «Книги»');
    await expect(page.getByTestId('new-record-will')).toContainText('item function = ITEM_BOOK');
    await expect(page.getByTestId('new-record-unmet')).toHaveCount(0);

    // Another sample from the picker: Book Of Grace.
    await sampleBtn.click();
    const picker = page.getByTestId('record-picker');
    await picker.getByTestId('picker-search').fill(BOOK_OF_GRACE);
    await picker.getByTestId('picker-list').locator(`[data-sid="${BOOK_OF_GRACE}"]`).dblclick();
    await expect(picker).toHaveCount(0);
    await expect(sampleBtn).toHaveAttribute('data-sid', BOOK_OF_GRACE);
    await expect(sampleBtn).toContainText('Книга благодати');
    const sample = BOOK_OF_GRACE;

    await page.getByTestId('new-record-name').fill('E2E Книга');
    await page.getByTestId('new-record-create').click();
    await expect(page.getByTestId('record-name')).toHaveValue('E2E Книга');
    const sid = (await page.getByTestId('record-sid').textContent())!.trim();
    expect(sid).not.toBe(sample);
    // Still in Books, one more record, the new one in the list.
    await expect(page.getByTestId('cat-Items/Books')).toHaveClass(/selected/);
    await expect.poll(() => countOf(page)).toBe(books + 1);
    await expect(page.getByTestId('record-list').locator(`[data-sid="${sid}"]`)).toHaveCount(1);
    // Fields come from the sample.
    const value = await page.getByTestId('field-value').inputValue();
    const icon = await page.getByTestId('field-icon').inputValue();
    expect(value).toBe('150');
    expect(icon).toContain('Book Of Grace');

    // One undo step with the title in the UI language.
    await page.getByTestId('undo-menu').click();
    const steps = page.getByTestId('undo-list').getByTestId('undo-step');
    await expect(steps).toHaveCount(1);
    await expect(steps.nth(0)).toContainText('Новая запись «E2E Книга» по образцу');
    await page.keyboard.press('Escape');

    // The sample has the same fields.
    await page.getByTestId('record-list').locator(`[data-sid="${sample}"]`).click();
    await expect(page.getByTestId('record-sid')).toHaveText(sample);
    await expect(page.getByTestId('field-value')).toHaveValue(value);
    await expect(page.getByTestId('field-icon')).toHaveValue(icon);

    // «empty record»: no sample, the category condition is still set.
    await page.getByTestId('new-record').click();
    await page.getByTestId('new-record-empty').click();
    await expect(page.getByTestId('new-record-sample')).not.toHaveAttribute('data-sid', /./);
    await page.getByTestId('new-record-name').fill('E2E Пустая книга');
    await page.getByTestId('new-record-create').click();
    await expect(page.getByTestId('record-name')).toHaveValue('E2E Пустая книга');
    await expect.poll(() => countOf(page)).toBe(books + 2);
    await expect(page.getByTestId('field-icon')).toHaveValue('');

    // Undo removes it from Books again.
    await page.getByTestId('undo').click();
    await expect.poll(() => countOf(page)).toBe(books + 1);
  } finally {
    await closeApp(app);
  }
});
