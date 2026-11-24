/**
 * Screenshots of the record list in every interface language (the Translation column follows the
 * data language). Uses the build in `out/` like the e2e tests:
 *
 *   node apps/desktop/scripts/lang-shots.ts [out-dir]
 */
import { mkdirSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { _electron as electron } from '@playwright/test';
import { LANGS } from '../src/shared/api.ts';

const appDir = resolve(import.meta.dirname, '..');
const outDir = resolve(process.argv[2] ?? join(appDir, '../../out/screenshots'));
mkdirSync(outDir, { recursive: true });

const userData = mkdtempSync(join(tmpdir(), 'kedit-lang-shots-'));
const env: Record<string, string> = {};
for (const [k, v] of Object.entries(process.env)) if (v !== undefined && k !== 'ELECTRON_RENDERER_URL' && k !== 'ELECTRON_RUN_AS_NODE') env[k] = v;
env['KEDIT_USER_DATA'] = userData;
env['KEDIT_LIVE_FILE'] = join(userData, 'live.json');

const app = await electron.launch({ args: ['.'], cwd: appDir, env });
try {
  const page = await app.firstWindow();
  await app.evaluate(({ BrowserWindow }) => {
    BrowserWindow.getAllWindows()[0]?.setSize(1500, 860);
  });
  await page.getByTestId('open-vanilla').waitFor({ timeout: 60_000 });
  await page.getByTestId('open-vanilla').click();
  await page.getByTestId('editor').waitFor({ timeout: 120_000 });
  await page.getByTestId('search').fill('katana');
  await page.waitForTimeout(300);
  for (const l of LANGS) {
    await page.getByTestId('lang-current').click();
    await page.getByTestId(`lang-${l.code}`).click();
    // Switching the data language re-reads gamedata.po and re-indexes the list.
    await page.waitForTimeout(1500);
    const file = join(outDir, `record-list-${l.code}.png`);
    await page.screenshot({ path: file });
    const header = await page.getByTestId('list-header').innerText();
    console.log(`${file}  [${header.replace(/\s+/g, ' | ')}]`);
  }
} finally {
  await app
    .evaluate(({ BrowserWindow }) => {
      for (const w of BrowserWindow.getAllWindows()) w.destroy();
    })
    .catch(() => undefined);
  await app.close().catch(() => undefined);
}
