/**
 * Beta for Windows x64: an «unpack and run» folder and a zip archive.
 *
 *   pnpm beta            (= node apps/desktop/scripts/beta.ts)
 *
 * What is inside `out/beta/Cactus-<version>-win-x64.zip` (a single Cactus folder):
 * - Electron from node_modules, `electron.exe` renamed to `Cactus.exe`; of the Chromium
 *   locales only English and Russian are kept;
 * - `resources/app` — the built app (`out/` of electron-vite) and package.json named
 *   «Cactus» (data folder: `%APPDATA%\Cactus`);
 * - `resources/mcp/kenshi-mcp.mjs` — the MCP server as a single file (core, SDK and zod inside).
 *   It runs with the same exe and `ELECTRON_RUN_AS_NODE=1`: no separate Node needed;
 * - `_ИНСТРУКЦИЯ.txt` — a short guide for friends (from `beta/README_RU.txt`; «_» so that in
 *   Explorer it comes first among the files) and LICENSE.txt.
 *
 * No game files, mods, caches or sources in the archive. Before packing, text files
 * are checked for personal paths and the user name — if anything is found the build stops.
 */
import { spawnSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { homedir, userInfo } from 'node:os';
import { basename, dirname, extname, join, relative, resolve } from 'node:path';
import { rcedit } from 'rcedit';
import { build } from 'vite';
import { zipDir } from './zip.ts';

const app = resolve(import.meta.dirname, '..');
const root = resolve(app, '../..');
const pkg = JSON.parse(readFileSync(join(app, 'package.json'), 'utf8')) as { version: string };
const VERSION = pkg.version;
const NAME = 'Cactus';
const outDir = join(root, 'out', 'beta');
const stage = join(outDir, NAME);
const zipPath = join(outDir, `${NAME}-${VERSION}-win-x64.zip`);

function step(text: string): void {
  console.log(`\n▶ ${text}`);
}

function fail(text: string): never {
  console.error(`\n✖ ${text}`);
  process.exit(1);
}

if (process.platform !== 'win32' || process.arch !== 'x64') fail('Бета собирается на Windows x64 (берётся Electron из node_modules).');

step('Сборка приложения (electron-vite)');
{
  const bin = join(app, 'node_modules/.bin/electron-vite.cmd');
  const r = spawnSync(`"${bin}" build`, { cwd: app, stdio: 'inherit', shell: true });
  if (r.status !== 0) fail('electron-vite build не удался');
}

step('MCP-сервер одним файлом');
const mcpOut = join(outDir, 'mcp-build');
rmSync(mcpOut, { recursive: true, force: true });
await build({
  configFile: false,
  logLevel: 'warn',
  root: join(root, 'packages/mcp'),
  ssr: { noExternal: true, target: 'node' },
  build: {
    ssr: join(root, 'packages/mcp/bin/kenshi-mcp.js'),
    outDir: mcpOut,
    emptyOutDir: true,
    target: 'node22',
    minify: false,
    sourcemap: false,
    rollupOptions: { output: { format: 'es', entryFileNames: 'kenshi-mcp.mjs', codeSplitting: false } },
  },
});
const mcpFile = join(mcpOut, 'kenshi-mcp.mjs');
if (!existsSync(mcpFile)) fail('нет kenshi-mcp.mjs после сборки');

step('Папка программы');
rmSync(stage, { recursive: true, force: true });
mkdirSync(stage, { recursive: true });
const electronExe = createRequire(join(app, 'package.json'))('electron') as unknown as string;
const dist = dirname(electronExe);
const KEEP_LOCALES = new Set(['en-US.pak', 'ru.pak']);
cpSync(dist, stage, {
  recursive: true,
  filter: (src) => {
    const rel = relative(dist, src);
    if (rel === join('resources', 'default_app.asar')) return false;
    if (dirname(rel) === 'locales' && !KEEP_LOCALES.has(basename(rel))) return false;
    return true;
  },
});
renameSync(join(stage, 'electron.exe'), join(stage, `${NAME}.exe`));
await rcedit(join(stage, `${NAME}.exe`), {
  icon: join(app, 'beta', 'cactus.ico'),
  'version-string': {
    ProductName: 'Cactus',
    FileDescription: 'Cactus: mod editor for Kenshi',
    CompanyName: 'Mrgoldd11',
    LegalCopyright: 'Copyright (c) 2026 Mrgoldd11',
    OriginalFilename: `${NAME}.exe`,
    InternalFilename: NAME,
  },
  'file-version': `${VERSION.split('-')[0]}.0`,
  'product-version': VERSION,
});

const appDir = join(stage, 'resources', 'app');
mkdirSync(appDir, { recursive: true });
for (const part of ['main', 'preload', 'renderer']) cpSync(join(app, 'out', part), join(appDir, 'out', part), { recursive: true });
writeFileSync(
  join(appDir, 'package.json'),
  `${JSON.stringify(
    {
      name: 'kenshi-mod-editor',
      productName: 'Cactus',
      version: VERSION,
      description: 'Cactus: mod editor for Kenshi',
      license: 'SEE LICENSE IN LICENSE.txt',
      type: 'module',
      main: './out/main/index.js',
    },
    null,
    2,
  )}\n`,
);
mkdirSync(join(stage, 'resources', 'mcp'), { recursive: true });
cpSync(mcpFile, join(stage, 'resources', 'mcp', 'kenshi-mcp.mjs'));
rmSync(mcpOut, { recursive: true, force: true });

const crlf = (s: string): string => s.replace(/\r\n/g, '\n').replace(/\n/g, '\r\n');
const DOCS: Readonly<Record<string, string>> = { 'README_EN.txt': '_README.txt', 'README_RU.txt': '_ИНСТРУКЦИЯ.txt', 'LICENSE.txt': 'LICENSE.txt' };
for (const [from, to] of Object.entries(DOCS)) {
  writeFileSync(join(stage, to), crlf(readFileSync(join(app, 'beta', from), 'utf8').replaceAll('{VERSION}', VERSION)));
}

step('Проверка: нет личных данных и игровых файлов');
{
  const user = userInfo().username;
  const forbidden = ['Kenshiproject', 'dulkinn', user, homedir(), homedir().replaceAll('\\', '/'), homedir().replaceAll('\\', '\\\\')].filter((s) => s.length >= 4);
  const textExt = new Set(['.js', '.mjs', '.cjs', '.json', '.html', '.css', '.txt', '.md', '.map']);
  const gameExt = new Set(['.mod', '.base', '.po', '.def']);
  const problems: string[] = [];
  const walk = (d: string): void => {
    for (const name of readdirSync(d)) {
      const p = join(d, name);
      if (statSync(p).isDirectory()) {
        if (['node_modules', '.git', 'src', 'test'].includes(name)) problems.push(`лишняя папка ${relative(stage, p)}`);
        walk(p);
        continue;
      }
      const ext = extname(name).toLowerCase();
      if (gameExt.has(ext) || name === 'gamedata.base') problems.push(`игровой файл ${relative(stage, p)}`);
      if (!textExt.has(ext)) continue;
      const text = readFileSync(p, 'utf8');
      for (const f of forbidden) if (text.toLowerCase().includes(f.toLowerCase())) problems.push(`${relative(stage, p)}: «${f}»`);
    }
  };
  walk(stage);
  if (problems.length) fail(`В сборке найдено лишнее:\n  ${problems.join('\n  ')}`);
  console.log('  чисто');
}

step('Архив');
rmSync(zipPath, { force: true });
const z = zipDir(stage, zipPath, NAME);
const mb = (n: number): string => `${(n / 1024 / 1024).toFixed(1)} МБ`;
console.log(`  ${zipPath}`);
console.log(`  файлов ${String(z.files)}, ${mb(z.bytes)}`);
