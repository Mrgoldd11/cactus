import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';

/**
 * Где лежит игра. Порядок поиска:
 * 1. переменные окружения `KENSHI_DIR` и `KENSHI_WORKSHOP_DIR`;
 * 2. файл `kenshi-paths.json` (`{ "kenshi": "...", "workshop": "..." }`) в текущей папке или выше;
 * 3. значения по умолчанию (Steam-библиотека на D:).
 */
export interface GamePaths {
  /** Папка игры (там `data/`, `mods/`, `fcs.def`). */
  kenshi: string;
  /** Папка мастерской Steam для Kenshi (`.../workshop/content/233860`). */
  workshop: string;
}

export const DEFAULT_KENSHI_DIR = 'D:/SteamLibrary/steamapps/common/Kenshi';
export const KENSHI_APP_ID = '233860';
export const CONFIG_FILE_NAME = 'kenshi-paths.json';

/** Мастерская по умолчанию: `<steamapps>/workshop/content/233860` рядом с `<steamapps>/common/Kenshi`. */
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

export function resolveGamePaths(cwd: string = process.cwd(), env: NodeJS.ProcessEnv = process.env): GamePaths {
  let kenshi = env['KENSHI_DIR'];
  let workshop = env['KENSHI_WORKSHOP_DIR'];
  const configPath = findConfig(cwd);
  if (configPath && (!kenshi || !workshop)) {
    const cfg = JSON.parse(readFileSync(configPath, 'utf-8')) as Partial<GamePaths>;
    const base = dirname(configPath);
    if (!kenshi && cfg.kenshi) kenshi = resolve(base, cfg.kenshi);
    if (!workshop && cfg.workshop) workshop = resolve(base, cfg.workshop);
  }
  kenshi ??= DEFAULT_KENSHI_DIR;
  workshop ??= defaultWorkshopDir(kenshi);
  return { kenshi, workshop };
}

/** Ванильные слои в порядке загрузки. */
export const VANILLA_FILES = ['gamedata.base', 'Newwworld.mod', 'Dialogue.mod', 'rebirth.mod'] as const;

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

/** Все .mod из `<игра>/mods/*` и из мастерской `<workshop>/*`. */
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
