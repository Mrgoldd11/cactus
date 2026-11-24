/**
 * Auto-detection of the installed game: Steam (registry → libraries from `libraryfolders.vdf`), GOG
 * (registry GOG.com\Games, standard folders), plus what is set explicitly (`configuredGamePaths`:
 * KENSHI_DIR, kenshi-paths.json). The registry is read with `reg query` (Windows only).
 */
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { configuredGamePaths, defaultWorkshopDir, KENSHI_APP_ID, type GamePaths } from './paths.ts';

export type GameSource = 'config' | 'steam' | 'gog' | 'manual';

export interface GameInstall extends GamePaths {
  source: GameSource;
}

/** Whether the folder contains the game: `data/gamedata.base`. */
export function isKenshiDir(dir: string): boolean {
  return existsSync(join(dir, 'data', 'gamedata.base'));
}

/** Steam library paths from `libraryfolders.vdf` (KeyValues: `"path"  "E:\\Games\\SteamLibrary"`). */
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

/** `reg query` values by key: key → (name → value). */
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

/** Kenshi in all Steam libraries. */
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

/** Kenshi from GOG: registry GOG.com\Games (gameName = Kenshi) and standard folders. */
export function findGogInstalls(): GameInstall[] {
  const dirs = new Set<string>();
  for (const vals of parseRegOutput(regQuery(['HKLM\\SOFTWARE\\WOW6432Node\\GOG.com\\Games', '/s'])).values()) {
    const name = vals.get('gameName') ?? vals.get('GAMENAME') ?? '';
    const path = vals.get('path') ?? vals.get('PATH');
    if (/kenshi/i.test(name) && path) dirs.add(resolve(path));
  }
  for (const d of ['C:/GOG Games/Kenshi', 'C:/Program Files (x86)/GOG Galaxy/Games/Kenshi', 'D:/GOG Games/Kenshi']) dirs.add(resolve(d));
  // GOG has no Workshop: mods are only in `mods/`.
  return [...dirs].filter(isKenshiDir).map((kenshi) => ({ kenshi, workshop: join(kenshi, 'workshop'), source: 'gog' as const }));
}

/**
 * All found installs without repeats: first the one set in settings (KENSHI_DIR,
 * kenshi-paths.json, if the game is there), then Steam, then GOG.
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
  const cfg = configuredGamePaths(cwd);
  if (cfg.kenshi && isKenshiDir(cfg.kenshi)) add({ kenshi: cfg.kenshi, workshop: cfg.workshop ?? defaultWorkshopDir(cfg.kenshi), source: 'config' });
  for (const g of findSteamInstalls()) add(g);
  for (const g of findGogInstalls()) add(g);
  return out;
}

/** Install from a manually chosen folder: the Steam Workshop next to it, if the folder is in steamapps. */
export function manualInstall(kenshi: string): GameInstall {
  const steamWorkshop = defaultWorkshopDir(kenshi);
  return { kenshi, workshop: existsSync(steamWorkshop) ? steamWorkshop : join(kenshi, 'workshop'), source: 'manual' };
}
