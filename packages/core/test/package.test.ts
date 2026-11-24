/**
 * The `@kedit/core` package: build it into a temp folder, put it into the `node_modules` of a project outside
 * the workspace and check that it loads from a plain .mjs and from .ts (Node strips the
 * types itself), and that TypeScript sees its types.
 */
import { execFileSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { buildPackage, fixDeclarationImports } from '../scripts/package.ts';

const root = mkdtempSync(join(tmpdir(), 'kedit-core-pkg-'));
afterAll(() => {
  rmSync(root, { recursive: true, force: true });
});

describe('@kedit/core package', () => {
  it('.ts imports in .d.ts → .js', () => {
    expect(fixDeclarationImports("export * from './text.ts';\nimport type { X } from '../a/b.ts';\ntype Y = import('./c.ts').Y;")).toBe(
      "export * from './text.js';\nimport type { X } from '../a/b.js';\ntype Y = import('./c.js').Y;",
    );
    expect(fixDeclarationImports("import { a } from 'node:fs';")).toBe("import { a } from 'node:fs';");
  });

  it('builds and works from a folder outside the workspace (.mjs, .ts, types)', () => {
    const pkg = buildPackage(join(root, 'pkg'));
    const manifest = JSON.parse(readFileSync(join(pkg.dir, 'package.json'), 'utf8')) as { name: string; private: boolean; exports: Record<string, unknown> };
    expect(manifest.name).toBe('@kedit/core');
    expect(manifest.private).toBe(true);
    expect(Object.keys(manifest.exports)).toEqual(['.', './node', './package.json']);
    expect(existsSync(join(pkg.dir, 'dist', 'index.d.ts'))).toBe(true);
    expect(readFileSync(join(pkg.dir, 'dist', 'index.d.ts'), 'utf8')).not.toMatch(/from '\.[^']*\.ts'/);

    const proj = join(root, 'proj');
    mkdirSync(join(proj, 'node_modules', '@kedit'), { recursive: true });
    cpSync(pkg.dir, join(proj, 'node_modules', '@kedit', 'core'), { recursive: true });
    writeFileSync(join(proj, 'package.json'), JSON.stringify({ name: 'my-mod-scripts', type: 'module', private: true }));
    writeFileSync(
      join(proj, 'a.mjs'),
      [
        "import { decodeText, encodeText, placeMod, findConflicts } from '@kedit/core';",
        "import { resolveGamePaths, readDataFileSync } from '@kedit/core/node';",
        "console.log(decodeText(encodeText('Катана')), placeMod(['A.mod', 'B.mod'], 'B.mod', { top: true }).join(','), typeof findConflicts, typeof resolveGamePaths, typeof readDataFileSync);",
      ].join('\n'),
    );
    const outA = execFileSync(process.execPath, ['a.mjs'], { cwd: proj, encoding: 'utf8' }).trim();
    expect(outA).toBe('Катана B.mod,A.mod function function function');

    writeFileSync(
      join(proj, 'b.ts'),
      [
        "import { emptyRecord, encodeText, itemTypeId, type GameRecord } from '@kedit/core';",
        "const r: GameRecord = emptyRecord(itemTypeId('WEAPON')!, '1-my.mod', encodeText('Sword'));",
        "r.floats.set('weight mult', 0.5);",
        'const n: number = r.floats.get(\'weight mult\') ?? 0;',
        'console.log(r.stringId, n);',
      ].join('\n'),
    );
    expect(execFileSync(process.execPath, ['b.ts'], { cwd: proj, encoding: 'utf8' }).trim()).toBe('1-my.mod 0.5');

    // Types: strict tsc over the project script; a type error must be caught.
    const typesNode = resolve(import.meta.dirname, '../../../node_modules/@types');
    writeFileSync(
      join(proj, 'tsconfig.json'),
      JSON.stringify({
        compilerOptions: { target: 'es2023', module: 'nodenext', moduleResolution: 'nodenext', strict: true, noEmit: true, allowImportingTsExtensions: true, typeRoots: [typesNode], types: ['node'] },
        files: ['b.ts', 'c.ts'],
      }),
    );
    writeFileSync(join(proj, 'c.ts'), "import { loadModContext, type GamePaths } from '@kedit/core/node';\nexport const f = (p: GamePaths) => loadModContext({ paths: p, modName: 'x.mod' }).ctx.modName;\n");
    const tsc = createRequire(import.meta.url).resolve('typescript/bin/tsc');
    const typecheck = (): string => execFileSync(process.execPath, [tsc, '-p', 'tsconfig.json'], { cwd: proj, encoding: 'utf8', stdio: 'pipe' });
    try {
      typecheck();
    } catch (e) {
      throw new Error(String((e as { stdout?: string }).stdout ?? e), { cause: e });
    }
    writeFileSync(join(proj, 'c.ts'), "import { loadModContext } from '@kedit/core/node';\nexport const f = () => loadModContext(42);\n");
    expect(typecheck).toThrow();
  });
});
