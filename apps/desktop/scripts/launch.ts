/**
 * Launch the built editor (for the «Запустить редактор.cmd» shortcut) without the Vite dev server.
 * Rebuilds the app only if the sources are newer than the build in `out/`, then starts
 * Electron detached from the console. Extra arguments are passed to Electron
 * (for example `--remote-debugging-port=9333`).
 *
 *   node apps/desktop/scripts/launch.ts
 */
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, readdirSync, statSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join, resolve } from 'node:path';

const app = resolve(import.meta.dirname, '..');
const root = resolve(app, '../..');

/** The latest modification time among the files (folders recursively). */
function newest(paths: readonly string[]): number {
  let max = 0;
  const walk = (p: string): void => {
    if (!existsSync(p)) return;
    const st = statSync(p);
    if (st.isDirectory()) {
      for (const name of readdirSync(p)) if (name !== 'node_modules') walk(join(p, name));
    } else if (st.mtimeMs > max) max = st.mtimeMs;
  };
  for (const p of paths) walk(p);
  return max;
}

const outputs = [join(app, 'out/main/index.js'), join(app, 'out/preload/index.cjs'), join(app, 'out/renderer/index.html')];
const sources = [
  join(app, 'src'),
  join(app, 'electron.vite.config.ts'),
  join(app, 'package.json'),
  join(root, 'packages/core/src'),
  join(root, 'packages/core/package.json'),
  join(root, 'pnpm-lock.yaml'),
];
const built = outputs.every((p) => existsSync(p)) ? Math.min(...outputs.map((p) => statSync(p).mtimeMs)) : 0;

if (newest(sources) > built) {
  console.log('Исходники изменились — собираю редактор…');
  const bin = join(app, 'node_modules/.bin', process.platform === 'win32' ? 'electron-vite.cmd' : 'electron-vite');
  const r = spawnSync(bin, ['build'], { cwd: app, stdio: 'inherit', shell: process.platform === 'win32' });
  if (r.status !== 0) {
    console.error('Сборка не удалась.');
    process.exit(1);
  }
}

const electron = createRequire(join(app, 'package.json'))('electron') as unknown as string;
const child = spawn(electron, [app, ...process.argv.slice(2)], { cwd: app, detached: true, stdio: 'ignore' });
child.unref();
