/**
 * UI audit screenshots: every panel, layout, the Window menu and the toolbar modals in every
 * interface language at two window sizes, plus an automatic text report per shot (wrong-script
 * strings, clipped or overflowing elements). Uses the build in `out/` like the e2e tests; works on
 * a new in-memory mod, nothing is written to the game folder.
 *
 *   node apps/desktop/scripts/ui-audit-shots.ts [out-dir] [lang,lang] [size,size] [shot-filter]
 */
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { _electron as electron, type Page } from '@playwright/test';

const appDir = resolve(import.meta.dirname, '..');
const outDir = resolve(process.argv[2] ?? join(appDir, '../../out/screenshots/audit'));
const langs = (process.argv[3] ?? 'en,ru,zh').split(',');
const SIZES: Record<string, [number, number]> = { n: [1400, 850], s: [1100, 700] };
const sizes = (process.argv[4] ?? 'n,s').split(',');
const filter = process.argv[5];
mkdirSync(outDir, { recursive: true });

const userData = mkdtempSync(join(tmpdir(), 'kedit-audit-'));
const env: Record<string, string> = {};
for (const [k, v] of Object.entries(process.env)) if (v !== undefined && k !== 'ELECTRON_RENDERER_URL' && k !== 'ELECTRON_RUN_AS_NODE') env[k] = v;
env['KEDIT_USER_DATA'] = userData;
env['KEDIT_LIVE_FILE'] = join(userData, 'live.json');

const KATANA = '476-gamedata.base';
const BEEP = '57390-rebirth.mod';
const SLOW = new Set(['world', 'model', 'interior', 'census', 'graphs', 'factions', 'conflicts', 'translate']);

interface Finding {
  kind: 'script' | 'clip' | 'offscreen';
  text: string;
  where: string;
}

/** Scan the visible DOM for wrong-script text and clipped/overflowing elements. */
async function scan(page: Page, lang: string): Promise<Finding[]> {
  return page.evaluate((lang) => {
    const out: { kind: 'script' | 'clip' | 'offscreen'; text: string; where: string }[] = [];
    const path = (el: Element | null): string => {
      const parts: string[] = [];
      for (let e = el; e && parts.length < 4; e = e.parentElement) {
        const id = e.getAttribute('data-testid') ?? e.getAttribute('data-panel');
        parts.unshift(id ? `[${id}]` : e.className && typeof e.className === 'string' ? `.${e.className.split(' ')[0]}` : e.tagName.toLowerCase());
      }
      return parts.join(' > ');
    };
    const visible = (el: Element): boolean => {
      const r = el.getBoundingClientRect();
      if (r.width === 0 || r.height === 0) return false;
      if (r.bottom < 0 || r.right < 0 || r.top > innerHeight || r.left > innerWidth) return false;
      const s = getComputedStyle(el);
      return s.visibility !== 'hidden' && s.display !== 'none';
    };
    const cyr = /[Ѐ-ӿ]/;
    const cjk = /[㐀-鿿]/;
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    const seen = new Set<string>();
    for (let n = walker.nextNode(); n; n = walker.nextNode()) {
      const text = n.textContent?.trim() ?? '';
      if (!text || !n.parentElement || !visible(n.parentElement)) continue;
      const bad = (lang !== 'ru' && cyr.test(text)) || (lang !== 'zh' && cjk.test(text));
      if (bad && !seen.has(text)) {
        seen.add(text);
        out.push({ kind: 'script', text: text.slice(0, 120), where: path(n.parentElement) });
      }
    }
    // Attributes users read too: tooltips and placeholders.
    for (const el of document.querySelectorAll('[title],[placeholder]')) {
      if (!visible(el)) continue;
      for (const a of ['title', 'placeholder']) {
        const text = el.getAttribute(a) ?? '';
        const bad = (lang !== 'ru' && cyr.test(text)) || (lang !== 'zh' && cjk.test(text));
        if (bad && !seen.has(text)) {
          seen.add(text);
          out.push({ kind: 'script', text: `@${a}: ${text.slice(0, 120)}`, where: path(el) });
        }
      }
    }
    for (const el of document.querySelectorAll('button, label, th, .tab, .badge, span, .menu-item, h1, h2, h3, h4, summary, td, .dv-default-tab-content')) {
      if (!visible(el)) continue;
      const s = getComputedStyle(el);
      const text = (el as HTMLElement).innerText.trim();
      if (!text) continue;
      const clipsX = el.scrollWidth > el.clientWidth + 2 && (s.overflowX === 'hidden' || s.overflowX === 'clip' || s.textOverflow === 'ellipsis');
      if (clipsX && el.clientWidth > 0) out.push({ kind: 'clip', text: text.slice(0, 80), where: `${path(el)} (${el.clientWidth}/${el.scrollWidth})` });
      const r = el.getBoundingClientRect();
      if (r.right > innerWidth + 1 && r.left < innerWidth) out.push({ kind: 'offscreen', text: text.slice(0, 80), where: `${path(el)} (right ${Math.round(r.right)})` });
    }
    return out;
  }, lang);
}

const report: Record<string, Finding[]> = {};
const app = await electron.launch({ args: ['.'], cwd: appDir, env });
const page = await app.firstWindow();
const cdp = await page.context().newCDPSession(page);
let cur = '';

async function shot(name: string, fn: () => Promise<void>, wait = 500): Promise<void> {
  const full = `${cur}-${name}`;
  if (filter && !full.includes(filter)) return;
  try {
    await fn();
    await page.waitForTimeout(wait);
    await page.screenshot({ path: join(outDir, `${full}.png`) });
    report[full] = await scan(page, cur.split('-')[0]!);
    console.log(`ok ${full} (${report[full].length})`);
  } catch (e) {
    console.log(`FAIL ${full}: ${(e as Error).message.split('\n')[0]}`);
    await page.screenshot({ path: join(outDir, `${full}-FAIL.png`) }).catch(() => undefined);
  }
}

async function setSize(s: string): Promise<void> {
  const [width, height] = SIZES[s]!;
  await cdp.send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile: false });
  await page.waitForTimeout(300);
}

async function setLang(l: string): Promise<void> {
  await page.getByTestId('lang-current').click();
  await page.getByTestId(`lang-${l}`).click();
  await page.waitForTimeout(1500);
}

async function preset(p: string): Promise<void> {
  await page.getByTestId(`window-preset-${p}`).click();
  await page.waitForTimeout(600);
}

async function select(query: string, sid: string): Promise<void> {
  await page.getByTestId('search').first().fill(query);
  await page.getByTestId('record-list').first().locator(`[data-sid="${sid}"]`).click();
}

async function closeModal(): Promise<void> {
  await page.locator('.modal-title button').first().click().catch(() => undefined);
  await page.waitForTimeout(200);
}

try {
  await app.evaluate(({ BrowserWindow }) => {
    BrowserWindow.getAllWindows()[0]?.setSize(1500, 900);
  });
  await page.getByTestId('open-vanilla').waitFor({ timeout: 60_000 });
  await page.getByTestId('mods-table').waitFor();
  for (const l of langs) {
    await setLang(l);
    for (const s of sizes) {
      cur = `${l}-${s}`;
      await setSize(s);
      await shot('00-start', () => Promise.resolve());
    }
  }

  await page.getByTestId('new-mod-name').fill('Audit Test');
  await page.getByTestId('create-mod').click();
  await page.getByTestId('editor').waitFor({ timeout: 120_000 });
  // One edit so history, diff and the dirty state have something to show.
  await select('katana', KATANA);
  await page.getByTestId('tab-fields').click();
  await page.getByTestId('field-filter').fill('cut damage');
  const input = page.getByTestId('field-cut damage multiplier');
  await input.fill('1.7');
  await input.press('Enter');
  await page.getByTestId('field-filter').fill('');

  for (const l of langs) {
    await setLang(l);
    for (const s of sizes) {
      cur = `${l}-${s}`;
      await setSize(s);
      await preset('data');
      await select('katana', KATANA);
      for (const tab of ['fields', 'refs', 'back', 'where', 'diff']) {
        await shot(`10-tab-${tab}`, async () => {
          await page.getByTestId(`tab-${tab}`).click();
        }, tab === 'where' ? 2500 : 500);
      }
      await page.getByTestId('tab-fields').click();
      await shot('20-layout-data', () => Promise.resolve());
      await shot('21-window-menu', async () => {
        await page.getByTestId('window-menu').click();
      });
      const ids = await page.locator('[data-testid^="window-panel-"]').evaluateAll((els) => els.map((e) => e.getAttribute('data-testid')!.slice('window-panel-'.length)));
      await page.keyboard.press('Escape');
      for (const id of ids) {
        await shot(`40-panel-${id}`, async () => {
          await preset('data');
          await page.getByTestId('window-menu').click();
          const item = page.getByTestId(`window-panel-${id}`);
          // Already open in this layout: the click would close it, so just look at it.
          if ((await item.getAttribute('aria-checked')) === 'true') await page.keyboard.press('Escape');
          else await item.click();
        }, SLOW.has(id) ? 4000 : 1200);
      }
      await shot('22-layout-dialogue', async () => {
        await preset('dialogue');
        await select('Beep', BEEP);
        await page.waitForTimeout(1500);
      });
      await shot('23-layout-scene', async () => {
        await preset('scene');
        await page.getByTestId('world-view').waitFor();
        await page.waitForFunction(() => document.querySelector('[data-testid="world-view"]')?.getAttribute('data-ready') === 'yes', null, { timeout: 90_000 });
      }, 4000);
      await preset('data');
      await select('katana', KATANA);
      for (const m of ['deps', 'mod-info', 'validate', 'backups-btn', 'settings-btn']) {
        await shot(`30-modal-${m}`, async () => {
          await page.getByTestId(m).click();
        }, 1000);
        await closeModal();
      }
      await shot('31-ai', async () => {
        await page.getByTestId('live-status').click();
      });
      await page.getByTestId('live-status').click();
    }
  }
} finally {
  writeFileSync(join(outDir, 'report.json'), JSON.stringify(report, null, 1));
  await app.evaluate(({ BrowserWindow }) => {
    for (const w of BrowserWindow.getAllWindows()) w.destroy();
  }).catch(() => undefined);
  await app.close().catch(() => undefined);
}
