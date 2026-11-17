/**
 * E2E: multi-selection in the record list (Ctrl/Shift/Ctrl+A as in Explorer) and the commands on the
 * selected records: delete with one undo, «Bulk edit (N)» limited to the selection. Real game
 * vanilla (read-only); the mod is saved to a temp folder and checked with `kedit validate`.
 */
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { _electron as electron, expect, test, type ElectronApplication, type Page } from '@playwright/test';
import { readDataFile } from '@kenshi-editor/core';

const appDir = resolve(import.meta.dirname, '..');
const editorRoot = resolve(appDir, '../..');
const shots = join(editorRoot, 'out', 'screenshots');
mkdirSync(shots, { recursive: true });

const KATANA = '476-gamedata.base';

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

test('record list multi-selection: Ctrl, Shift, Ctrl+A, delete and bulk edit of the selection', async () => {
  const { app, page } = await launch();
  const dir = mkdtempSync(join(tmpdir(), 'kedit-multi-'));
  try {
    await page.getByTestId('new-mod-name').fill('KeditE2E Multi');
    await page.getByTestId('create-mod').click();
    await expect(page.getByTestId('editor')).toBeVisible({ timeout: 120_000 });

    const list = page.getByTestId('record-list');
    const picked = list.locator('.list-row.selected');
    await page.getByTestId('search').fill('katana; type=WEAPON');
    await expect(page.getByTestId('list-count')).toHaveText(/: 3$/);
    const sids = await list.locator('.list-row').evaluateAll((els) => els.map((e) => e.getAttribute('data-sid')!));
    expect(sids).toHaveLength(3);
    expect(sids).toContain(KATANA);
    const row = (i: number) => list.locator(`[data-sid="${sids[i]!}"]`);

    // A plain click selects one record, as before.
    await row(0).click();
    await expect(picked).toHaveCount(1);
    await expect(page.getByTestId('list-picked')).toHaveCount(0);
    // Ctrl+click adds a record, the counter appears.
    await row(2).click({ modifiers: ['Control'] });
    await expect(picked).toHaveCount(2);
    await expect(page.getByTestId('list-picked')).toHaveText('Выбрано: 2');
    await expect(row(1)).not.toHaveClass(/selected/);
    // Ctrl+click on a selected record removes it.
    await row(2).click({ modifiers: ['Control'] });
    await expect(picked).toHaveCount(1);
    await expect(row(0)).toHaveClass(/selected/);
    // Shift+click — a range from the anchor (the last click without Shift).
    await row(0).click();
    await row(2).click({ modifiers: ['Shift'] });
    await expect(picked).toHaveCount(3);
    // A plain click drops the multi-selection; arrows move one record as before.
    await row(1).click();
    await expect(picked).toHaveCount(1);
    await page.keyboard.press('ArrowDown');
    await expect(picked).toHaveCount(1);
    await expect(row(2)).toHaveClass(/selected/);
    // Shift+ArrowUp extends the selection.
    await page.keyboard.press('Shift+ArrowUp');
    await expect(picked).toHaveCount(2);
    // Ctrl+A selects all rows, Esc clears back to the focused record.
    await page.keyboard.press('Control+A');
    await expect(picked).toHaveCount(3);
    await expect(page.getByTestId('list-picked')).toHaveText('Выбрано: 3');
    await page.keyboard.press('Escape');
    await expect(picked).toHaveCount(1);
    // In the search box Ctrl+A selects the text, not the records.
    await page.getByTestId('search').press('Control+A');
    await expect(picked).toHaveCount(1);

    // Delete several: one edit, one undo.
    await row(0).click();
    await page.keyboard.press('Control+A');
    await expect(page.getByTestId('delete')).toHaveText('Удалить (3)');
    await page.screenshot({ path: join(shots, '36-multiselect.png') });
    await page.getByTestId('delete').click();
    await expect(list.locator('.list-row.st-deleted')).toHaveCount(3);
    await expect(page.getByTestId('restore')).toHaveText(/\(3\)$/);
    await page.getByTestId('undo').click();
    await expect(list.locator('.list-row.st-deleted')).toHaveCount(0);
    await expect(page.getByTestId('save')).not.toHaveClass(/primary/);

    // «Bulk edit (N)»: the bulk panel works only on the selected records.
    await row(0).click();
    await page.keyboard.press('Control+A');
    await page.getByTestId('list-bulk').click();
    await expect(page.getByTestId('bulk-scope')).toContainText('3');
    await expect(page.getByTestId('bulk-type')).toHaveValue('WEAPON');
    await page.getByTestId('bulk-op').selectOption('mul');
    await page.getByTestId('bulk-field').selectOption('value');
    await page.getByTestId('bulk-value').fill('2');
    const panel = page.getByTestId('bulk-panel');
    await expect(panel.getByTestId('bulk-row')).toHaveCount(3);
    const katana = panel.locator(`[data-testid="bulk-row"][data-sid="${KATANA}"]`);
    await expect(katana).toHaveAttribute('data-before', '500');
    await expect(katana).toHaveAttribute('data-after', '1000');
    await page.screenshot({ path: join(shots, '36b-multiselect-bulk.png') });
    await page.getByTestId('bulk-apply').click();
    await expect(katana).toHaveAttribute('data-before', '1000');
    // One undo for the whole batch.
    await page.getByTestId('undo').click();
    await expect(katana).toHaveAttribute('data-before', '500');
    await page.getByTestId('redo').click();
    await expect(katana).toHaveAttribute('data-before', '1000');
    // Back to all weapons: many more rows than the selection.
    await page.getByTestId('bulk-scope-clear').click();
    await expect(page.getByTestId('bulk-scope')).toHaveCount(0);
    await expect.poll(() => panel.getByTestId('bulk-row').count()).toBeGreaterThan(3);

    const out = join(dir, 'Multi.mod');
    await app.evaluate(({ dialog }, p) => {
      dialog.showSaveDialog = () => Promise.resolve({ canceled: false, filePath: p });
    }, out);
    await page.getByTestId('save').click();
    await expect(page.getByTestId('status-msg')).toContainText('Сохранено');
    const cli = join(editorRoot, 'packages/cli/bin/kedit.js');
    const report = execFileSync(process.execPath, [cli, 'validate', '--mod', out], { cwd: editorRoot, encoding: 'utf8' });
    expect(report).toContain('errors 0');
    const recs = readDataFile(readFileSync(out)).records;
    expect(recs.map((r) => r.stringId).sort()).toEqual([...sids].sort());
    expect(recs.find((r) => r.stringId === KATANA)!.ints.get('value')).toBe(1000);
  } finally {
    await closeApp(app);
    rmSync(dir, { recursive: true, force: true });
  }
});
