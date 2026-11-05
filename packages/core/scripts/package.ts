/**
 * Пакет `@kedit/core` для скриптов внешних модов: ядро, собранное в обычный JavaScript
 * с типами (.d.ts), — его можно подключить из любой папки, без исходников редактора.
 *
 *   pnpm core:package                     → editor/out/kedit-core/
 *   node packages/core/scripts/package.ts --out <папка> [--tgz]
 *
 * В своём проекте: `npm install <путь>/out/kedit-core` (или .tgz из `--tgz`), затем
 * `import { … } from '@kedit/core'` и `import { … } from '@kedit/core/node'`.
 *
 * Внутри рабочей области пакет по-прежнему называется `@kenshi-editor/core` и берётся из
 * исходников; относительный импорт `editor/packages/core/src/index.ts` тоже работает.
 * Пакет помечен `private`: случайно опубликовать его в npm нельзя.
 */
import { execFileSync } from 'node:child_process';
import { mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join, resolve } from 'node:path';
import { parseArgs } from 'node:util';

const coreDir = resolve(import.meta.dirname, '..');
const editorRoot = resolve(coreDir, '../..');

/** Относительные импорты `./x.ts` в .d.ts → `./x.js`: так их понимает любой TypeScript. */
export function fixDeclarationImports(text: string): string {
  return text.replace(/((?:from|import)\s*\(?\s*['"])(\.{1,2}\/[^'"]+?)\.ts(['"])/g, '$1$2.js$3');
}

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p, out);
    else out.push(p);
  }
  return out;
}

export interface PackageResult {
  dir: string;
  version: string;
  tgz?: string;
}

export function buildPackage(outDir: string, options: { tgz?: boolean } = {}): PackageResult {
  const dir = resolve(outDir);
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  const tsc = createRequire(join(coreDir, 'package.json')).resolve('typescript/bin/tsc');
  execFileSync(process.execPath, [tsc, '-p', join(coreDir, 'tsconfig.build.json'), '--outDir', join(dir, 'dist'), '--sourceMap', 'false', '--declarationMap', 'false'], {
    stdio: 'inherit',
  });
  for (const f of walk(join(dir, 'dist'))) {
    if (f.endsWith('.d.ts')) writeFileSync(f, fixDeclarationImports(readFileSync(f, 'utf8')));
  }
  const core = JSON.parse(readFileSync(join(coreDir, 'package.json'), 'utf8')) as { version: string; description?: string };
  const pkg = {
    name: '@kedit/core',
    version: core.version,
    private: true,
    description: core.description ?? 'Kenshi data format (.base/.mod), FCS schema and locale parsers',
    type: 'module',
    engines: { node: '>=22.18' },
    exports: {
      '.': { types: './dist/index.d.ts', default: './dist/index.js' },
      './node': { types: './dist/node/index.d.ts', default: './dist/node/index.js' },
      './package.json': './package.json',
    },
    types: './dist/index.d.ts',
    files: ['dist', 'README.md'],
  };
  writeFileSync(join(dir, 'package.json'), `${JSON.stringify(pkg, null, 2)}\n`);
  writeFileSync(
    join(dir, 'README.md'),
    [
      '# @kedit/core',
      '',
      'Ядро Kenshi Mod Editor для своих скриптов: чтение и запись `.base`/`.mod` байт в байт,',
      'схема `fcs.def`, слои модов (`ModContext`), диалоги, порядок загрузки, конфликты модов.',
      '',
      '```sh',
      'npm install <путь к editor>/out/kedit-core',
      '```',
      '',
      '```ts',
      "import { ModContext, encodeText } from '@kedit/core';",
      "import { loadModContext, resolveGamePaths } from '@kedit/core/node';",
      '',
      'const paths = resolveGamePaths(process.cwd()); // папка игры: kenshi-paths.json, KENSHI_DIR или Steam',
      "const { ctx } = loadModContext(paths, { modName: 'My mod.mod' });",
      '```',
      '',
      '`@kedit/core` — без зависимостей, только Node ≥ 22.18. `@kedit/core/node` — файлы и папка игры;',
      '`@kedit/core` — всё остальное (работает и в браузере).',
      '',
    ].join('\n'),
  );
  const result: PackageResult = { dir, version: core.version };
  if (options.tgz) {
    const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';
    const name = execFileSync(npm, ['pack', '--silent'], { cwd: dir, encoding: 'utf8', shell: process.platform === 'win32' }).trim().split(/\r?\n/).at(-1)!;
    result.tgz = join(dir, name);
  }
  return result;
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(import.meta.filename)) {
  const { values } = parseArgs({ options: { out: { type: 'string' }, tgz: { type: 'boolean' } } });
  const r = buildPackage(values.out ?? join(editorRoot, 'out', 'kedit-core'), { tgz: values.tgz ?? false });
  console.log(`@kedit/core ${r.version}: ${r.dir}${r.tgz ? `\n${r.tgz}` : ''}`);
}
