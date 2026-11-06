/**
 * Бета для Windows x64: папка «распаковал — запустил» и zip-архив.
 *
 *   pnpm beta            (= node apps/desktop/scripts/beta.ts)
 *
 * Что внутри `out/beta/KenshiModEditor-<версия>-win-x64.zip` (одна папка KenshiModEditor):
 * - Electron из node_modules, `electron.exe` переименован в `KenshiModEditor.exe`; из языков
 *   Chromium оставлены английский и русский;
 * - `resources/app` — собранное приложение (`out/` electron-vite) и package.json с именем
 *   «Kenshi Mod Editor» (папка данных: `%APPDATA%\Kenshi Mod Editor`);
 * - `resources/mcp/kenshi-mcp.mjs` — MCP-сервер одним файлом (ядро, SDK и zod внутри).
 *   Запускается тем же exe с `ELECTRON_RUN_AS_NODE=1`: отдельный Node не нужен;
 * - `_ИНСТРУКЦИЯ.txt` — короткая инструкция для друзей (из `beta/README_RU.txt`; «_» — чтобы в
 *   проводнике она стояла первой среди файлов) и LICENSE.txt.
 *
 * Игровых файлов, модов, кэшей и исходников в архиве нет. Перед упаковкой текстовые файлы
 * проверяются на личные пути и имя пользователя — найдено что-то — сборка останавливается.
 */
import { spawnSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { homedir, userInfo } from 'node:os';
import { basename, dirname, extname, join, relative, resolve } from 'node:path';
import { build } from 'vite';
import { zipDir } from './zip.ts';

const app = resolve(import.meta.dirname, '..');
const root = resolve(app, '../..');
const pkg = JSON.parse(readFileSync(join(app, 'package.json'), 'utf8')) as { version: string };
const VERSION = pkg.version;
const NAME = 'KenshiModEditor';
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

const appDir = join(stage, 'resources', 'app');
mkdirSync(appDir, { recursive: true });
for (const part of ['main', 'preload', 'renderer']) cpSync(join(app, 'out', part), join(appDir, 'out', part), { recursive: true });
writeFileSync(
  join(appDir, 'package.json'),
  `${JSON.stringify(
    {
      name: 'kenshi-mod-editor',
      productName: 'Kenshi Mod Editor',
      version: VERSION,
      description: 'Kenshi mod editor',
      license: 'MIT',
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
const DOCS: Readonly<Record<string, string>> = { 'README_RU.txt': '_ИНСТРУКЦИЯ.txt', 'LICENSE.txt': 'LICENSE.txt' };
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
