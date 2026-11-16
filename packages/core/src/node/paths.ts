import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { findGogInstalls, findSteamInstalls, isKenshiDir, manualInstall } from './detect.ts';

/**
 * Where the game is. Search order:
 * 1. environment variables `KENSHI_DIR` and `KENSHI_WORKSHOP_DIR`;
 * 2. the file `kenshi-paths.json` (`{ "kenshi": "...", "workshop": "..." }`) in the current folder or above;
 * 3. the folder from the editor settings (`options.preferred`), if the game is there;
 * 4. auto-detection: Steam (all libraries), then GOG;
 * 5. the standard Steam folder — only so the error message names a path.
 */
export interface GamePaths {
  /** Game folder (contains `data/`, `mods/`, `fcs.def`). */
  kenshi: string;
  /** Steam Workshop folder for Kenshi (`.../workshop/content/233860`). */
  workshop: string;
}

/** Standard Steam folder; used only if the game was not found. */
export const DEFAULT_KENSHI_DIR = 'C:/Program Files (x86)/Steam/steamapps/common/Kenshi';
export const KENSHI_APP_ID = '233860';
export const CONFIG_FILE_NAME = 'kenshi-paths.json';

/** Default Workshop: `<steamapps>/workshop/content/233860` next to `<steamapps>/common/Kenshi`. */
export function defaultWorkshopDir(kenshiDir: string): string {
  return resolve(kenshiDir, '..', '..', 'workshop', 'content', KENSHI_APP_ID);
}

function findConfig(from: string): string | undefined {
  let dir = resolve(from);
  for (;;) {
    const candidate = join(dir, CONFIG_FILE_NAME);
    if (existsSync(candidate)) return candidate;
    const parent = dirname(dir);
    if (parent === dir) return undefined;
    dir = parent;
  }
}

/** Explicitly set paths: `KENSHI_DIR` / `KENSHI_WORKSHOP_DIR` and `kenshi-paths.json`. No auto-detection. */
export function configuredGamePaths(cwd: string = process.cwd(), env: NodeJS.ProcessEnv = process.env): Partial<GamePaths> {
  let kenshi = env['KENSHI_DIR'] || undefined;
  let workshop = env['KENSHI_WORKSHOP_DIR'] || undefined;
  const configPath = findConfig(cwd);
  if (configPath && (!kenshi || !workshop)) {
    const cfg = JSON.parse(readFileSync(configPath, 'utf-8')) as Partial<GamePaths>;
    const base = dirname(configPath);
    if (!kenshi && cfg.kenshi) kenshi = resolve(base, cfg.kenshi);
    if (!workshop && cfg.workshop) workshop = resolve(base, cfg.workshop);
  }
  return { ...(kenshi ? { kenshi } : {}), ...(workshop ? { workshop } : {}) };
}

export interface ResolveGamePathsOptions {
  /** Game folder from the editor settings: taken after explicit settings, before auto-detection. */
  preferred?: string | undefined;
}

export function resolveGamePaths(cwd: string = process.cwd(), env: NodeJS.ProcessEnv = process.env, options: ResolveGamePathsOptions = {}): GamePaths {
  const cfg = configuredGamePaths(cwd, env);
  const pick = (kenshi: string, workshop: string): GamePaths => ({ kenshi, workshop: cfg.workshop ?? workshop });
  if (cfg.kenshi) return pick(cfg.kenshi, defaultWorkshopDir(cfg.kenshi));
  if (options.preferred && isKenshiDir(options.preferred)) {
    const m = manualInstall(options.preferred);
    return pick(m.kenshi, m.workshop);
  }
  const found = findSteamInstalls()[0] ?? findGogInstalls()[0];
  if (found) return pick(found.kenshi, found.workshop);
  return pick(DEFAULT_KENSHI_DIR, defaultWorkshopDir(DEFAULT_KENSHI_DIR));
}

/** Vanilla layers in load order. */
import { VANILLA_FILES } from '../vanilla.ts';

export { VANILLA_FILES };

export function vanillaFilePaths(paths: GamePaths): string[] {
  return VANILLA_FILES.map((f) => join(paths.kenshi, 'data', f));
}

export function hasGame(paths: GamePaths): boolean {
  return existsSync(join(paths.kenshi, 'data', 'gamedata.base'));
}

function isDir(p: string): boolean {
  try {
    return statSync(p).isDirectory();
  } catch {
    return false;
  }
}

/** All .mod files from `<game>/mods/*` and from the Workshop `<workshop>/*`. */
export function installedModFiles(paths: GamePaths): { source: 'mods' | 'workshop'; path: string }[] {
  const out: { source: 'mods' | 'workshop'; path: string }[] = [];
  const scan = (root: string, source: 'mods' | 'workshop'): void => {
    if (!isDir(root)) return;
    for (const dir of readdirSync(root).sort()) {
      const full = join(root, dir);
      if (!isDir(full)) continue;
      for (const f of readdirSync(full).sort()) {
        if (f.toLowerCase().endsWith('.mod')) out.push({ source, path: join(full, f) });
      }
    }
  };
  scan(join(paths.kenshi, 'mods'), 'mods');
  scan(paths.workshop, 'workshop');
  return out;
}
