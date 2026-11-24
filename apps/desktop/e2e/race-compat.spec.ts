/**
 * E2E: the «Race compatibility» wizard on the real game data. A new race is made to work like the
 * Greenlander: the bulk panel opens the wizard, groups show «was → will be», unticking a group
 * leaves it out, «Apply» is one undo step; the saved mod holds only the diff and passes `kedit validate`.
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

const GREENLANDER = '17-gamedata.quack';

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

test('race compatibility wizard: new race like Greenlander, one undo, saved diff validates', async () => {
  const { app, page } = await launch();
  const dir = mkdtempSync(join(tmpdir(), 'kedit-race-'));
  try {
    await page.getByTestId('new-mod-name').fill('KeditE2E Race');
    await page.getByTestId('create-mod').click();
    await expect(page.getByTestId('editor')).toBeVisible({ timeout: 120_000 });

    await page.getByTestId('new-record').click();
    await page.getByTestId('new-record-type').selectOption('RACE');
    await page.getByTestId('new-record-name').fill('E2E Lizardfolk');
    await page.getByTestId('new-record-create').click();
    await expect(page.getByTestId('record-name')).toHaveValue('E2E Lizardfolk');
    const race = (await page.getByTestId('record-sid').textContent())!.trim();

    // The wizard is opened from the race card: the empty race has no sample yet.
    await expect(page.getByTestId('race-card-sample')).toHaveAttribute('data-done', '0');
    await page.getByTestId('race-card-compat-btn').click();
    const panel = page.getByTestId('race-compat-panel');
    await expect(panel).toBeVisible();
    // Defaults: the mod's own race works like the Greenlander.
    await expect(panel.getByTestId('rc-race')).toHaveValue(race);
    await expect(panel.getByTestId('rc-like')).toHaveValue(GREENLANDER);
    const groupOf = (g: string) => panel.locator(`[data-testid="rc-group"][data-group="${g}"]`);
    for (const g of ['armour', 'dialogue', 'raceGroups', 'starts', 'body']) await expect(groupOf(g)).toHaveCount(1);
    await expect(panel.getByTestId('rc-summary')).toBeVisible();
    // Armour rows show «was → will be» with the new race added.
    const armourRow = groupOf('armour').getByTestId('rc-row').first();
    await expect(armourRow.locator('.bulk-after')).toContainText('E2E Lizardfolk');
    await page.screenshot({ path: join(shots, '37-race-compat.png') });

    // Unticking the dialogue group leaves it out of «Apply».
    const before = Number(/\d+/.exec((await panel.getByTestId('rc-apply').textContent())!)![0]);
    // The group title says «N of M»; the table itself shows at most 300 rows.
    const dialogue = Number(/из (\d+)/.exec((await groupOf('dialogue').locator('summary').textContent())!)![1]);
    await groupOf('dialogue').getByTestId('rc-group-pick').uncheck();
    await expect(panel.getByTestId('rc-apply')).toContainText(`(${before - dialogue})`);
    await panel.getByTestId('rc-apply').click();
    await expect(page.getByTestId('status-msg')).toContainText(String(before - dialogue));

    // Only the unticked dialogue group is left; one undo brings everything back.
    await expect(groupOf('armour')).toHaveCount(0);
    await expect(groupOf('dialogue')).toHaveCount(1);
    await page.getByTestId('undo').click();
    await expect(groupOf('armour')).toHaveCount(1);
    await page.getByTestId('redo').click();
    await expect(groupOf('armour')).toHaveCount(0);

    const out = join(dir, 'Race.mod');
    await app.evaluate(({ dialog }, p) => {
      dialog.showSaveDialog = () => Promise.resolve({ canceled: false, filePath: p });
    }, out);
    await page.getByTestId('save').click();
    await expect(page.getByTestId('status-msg')).toContainText('Сохранено');
    const cli = join(editorRoot, 'packages/cli/bin/kedit.js');
    const report = execFileSync(process.execPath, [cli, 'validate', '--mod', out], { cwd: editorRoot, encoding: 'utf8' });
    expect(report).toContain('errors 0');
    const recs = readDataFile(readFileSync(out)).records;
    const own = recs.find((r) => r.stringId === race)!;
    expect(own.refs.get('combat anatomy')?.length ?? 0).toBeGreaterThan(0);
    const changed = recs.filter((r) => r.stringId !== race);
    expect(changed.length).toBeGreaterThanOrEqual(5);
    // Each changed record holds only the new race in its race lists (the diff), never the sample.
    for (const r of changed)
      for (const [, list] of r.refs) expect(list.some((x) => x.target === GREENLANDER)).toBe(false);
  } finally {
    await closeApp(app);
    rmSync(dir, { recursive: true, force: true });
  }
});
