/**
 * Автопоиск установленной игры: Steam (реестр → библиотеки из `libraryfolders.vdf`), GOG
 * (реестр GOG.com\Games, стандартные папки), плюс то, что даёт `resolveGamePaths`
 * (KENSHI_DIR, kenshi-paths.json). Реестр читается через `reg query` (только Windows).
 */
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { defaultWorkshopDir, KENSHI_APP_ID, resolveGamePaths, type GamePaths } from './paths.ts';

export type GameSource = 'config' | 'steam' | 'gog' | 'manual';

export interface GameInstall extends GamePaths {
  source: GameSource;
}

/** Есть ли в папке игра: `data/gamedata.base`. */
export function isKenshiDir(dir: string): boolean {
  return existsSync(join(dir, 'data', 'gamedata.base'));
}

/** Пути библиотек Steam из `libraryfolders.vdf` (KeyValues: `"path"  "D:\\SteamLibrary"`). */
export function parseSteamLibraryFolders(text: string): string[] {
  const out: string[] = [];
  for (const m of text.matchAll(/"path"\s+"((?:[^"\\]|\\.)*)"/g)) out.push(m[1]!.replace(/\\\\/g, '\\'));
  return out;
}

function regQuery(args: string[]): string {
  if (process.platform !== 'win32') return '';
  try {
    return execFileSync('reg', ['query', ...args], { encoding: 'utf8', windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] });
  } catch {
    return '';
  }
}

/** Значения `reg query` по ключам: ключ → (имя → значение). */
export function parseRegOutput(text: string): Map<string, Map<string, string>> {
  const out = new Map<string, Map<string, string>>();
  let current: Map<string, string> | undefined;
  for (const line of text.split(/\r?\n/)) {
    if (/^HKEY_/.test(line)) {
      current = new Map();
      out.set(line.trim(), current);
      continue;
    }
    const m = /^\s+(.+?)\s{4}REG_\w+\s{4}(.*)$/.exec(line);
    if (m && current) current.set(m[1]!, m[2]!);
  }
  return out;
}

function steamRoots(): string[] {
  const roots = new Set<string>();
  for (const [key, value] of [
    ['HKCU\\Software\\Valve\\Steam', 'SteamPath'],
    ['HKLM\\SOFTWARE\\WOW6432Node\\Valve\\Steam', 'InstallPath'],
  ] as const) {
    for (const vals of parseRegOutput(regQuery([key, '/v', value])).values()) {
      const v = vals.get(value);
      if (v) roots.add(resolve(v));
    }
  }
  roots.add(resolve('C:/Program Files (x86)/Steam'));
  return [...roots];
}

/** Kenshi во всех библиотеках Steam. */
export function findSteamInstalls(): GameInstall[] {
  const libs = new Set<string>();
  for (const root of steamRoots()) {
    libs.add(root);
    const vdf = join(root, 'steamapps', 'libraryfolders.vdf');
    if (existsSync(vdf)) for (const p of parseSteamLibraryFolders(readFileSync(vdf, 'utf8'))) libs.add(resolve(p));
  }
  const out: GameInstall[] = [];
  for (const lib of libs) {
    const kenshi = join(lib, 'steamapps', 'common', 'Kenshi');
    if (isKenshiDir(kenshi)) out.push({ kenshi, workshop: join(lib, 'steamapps', 'workshop', 'content', KENSHI_APP_ID), source: 'steam' });
  }
  return out;
}

/** Kenshi из GOG: реестр GOG.com\Games (gameName = Kenshi) и стандартные папки. */
export function findGogInstalls(): GameInstall[] {
  const dirs = new Set<string>();
  for (const vals of parseRegOutput(regQuery(['HKLM\\SOFTWARE\\WOW6432Node\\GOG.com\\Games', '/s'])).values()) {
    const name = vals.get('gameName') ?? vals.get('GAMENAME') ?? '';
    const path = vals.get('path') ?? vals.get('PATH');
    if (/kenshi/i.test(name) && path) dirs.add(resolve(path));
  }
  for (const d of ['C:/GOG Games/Kenshi', 'C:/Program Files (x86)/GOG Galaxy/Games/Kenshi', 'D:/GOG Games/Kenshi']) dirs.add(resolve(d));
  // У GOG нет мастерской: моды только в `mods/`.
  return [...dirs].filter(isKenshiDir).map((kenshi) => ({ kenshi, workshop: join(kenshi, 'workshop'), source: 'gog' as const }));
}

/**
 * Все найденные установки без повторов: сначала заданная настройками (KENSHI_DIR,
 * kenshi-paths.json, если там есть игра), потом Steam, потом GOG.
 */
export function detectGameInstalls(cwd: string = process.cwd()): GameInstall[] {
  const out: GameInstall[] = [];
  const seen = new Set<string>();
  const add = (g: GameInstall): void => {
    const k = resolve(g.kenshi).toLowerCase();
    if (seen.has(k)) return;
    seen.add(k);
    out.push(g);
  };
  const cfg = resolveGamePaths(cwd);
  if (isKenshiDir(cfg.kenshi)) add({ ...cfg, source: 'config' });
  for (const g of findSteamInstalls()) add(g);
  for (const g of findGogInstalls()) add(g);
  return out;
}

/** Установка по папке, выбранной вручную: мастерская Steam рядом, если папка в steamapps. */
export function manualInstall(kenshi: string): GameInstall {
  const steamWorkshop = defaultWorkshopDir(kenshi);
  return { kenshi, workshop: existsSync(steamWorkshop) ? steamWorkshop : join(kenshi, 'workshop'), source: 'manual' };
}
